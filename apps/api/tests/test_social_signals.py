from __future__ import annotations

import asyncio
from datetime import UTC, datetime, time, timedelta

import httpx
from sqlalchemy import select

from src.adapters import social_signals as social_adapter_module
from src.adapters.geocoding import LocationResult
from src.adapters.social_signals import (
    BlueskySocialSignalAdapter,
    KeywordSocialSignalInterpreter,
    NormalizedSocialSignal,
    SocialSeverity,
    SocialSignalUnavailableError,
    SocialTopic,
)
from src.core.config import Settings
from src.core.social_signals import get_social_signal_service
from src.models.experience import Experience
from src.models.itinerary import Itinerary
from src.models.itinerary_item import ItineraryItem
from src.models.location import Location
from src.schemas.social_signals import SocialSignalsResponse
from src.services.social_signal_aggregation import aggregate_social_signals
from src.services.social_signals import SocialSignalService
from tests.conftest import auth_header, register_traveler


def signal(
    index: int,
    *,
    topic: SocialTopic = SocialTopic.FLOODING,
    minutes_ago: int = 20,
    author: str | None = None,
) -> NormalizedSocialSignal:
    return NormalizedSocialSignal(
        deduplication_key=f"post-{index:016d}",
        source_fingerprint=author or f"author-{index:016d}",
        topic=topic,
        severity=SocialSeverity.HIGH if index % 2 else SocialSeverity.MODERATE,
        occurred_at=datetime.now(UTC) - timedelta(minutes=minutes_ago),
        classification_confidence=0.68,
    )


def test_keyword_interpreter_uses_small_deterministic_taxonomy() -> None:
    interpreter = KeywordSocialSignalInterpreter()
    flood = interpreter.interpret("Mumbai waterlogging has stranded commuters")
    assert flood is not None
    assert flood.topic is SocialTopic.FLOODING
    assert flood.severity is SocialSeverity.HIGH
    assert interpreter.interpret("Theatre tickets are on sale") is None


def test_bluesky_adapter_normalizes_and_discards_raw_post_fields(monkeypatch) -> None:
    now = datetime.now(UTC).isoformat()

    class FakeClient:
        async def get(self, url, *, params, timeout, headers):
            assert url == BlueskySocialSignalAdapter.BASE_URL
            assert params == {"q": "Mumbai", "sort": "latest", "limit": 100}
            posts = [
                {
                    "uri": "at://did:plc:secret/app.bsky.feed.post/first",
                    "record": {"text": "Mumbai roads waterlogged after rain", "createdAt": now},
                    "author": {"did": "did:plc:secret", "handle": "private.example"},
                    "indexedAt": now,
                },
                {
                    "uri": "at://did:plc:another/app.bsky.feed.post/second",
                    "record": {"text": "Mumbai roads waterlogged after rain", "createdAt": now},
                    "author": {"did": "did:plc:another", "handle": "other.example"},
                    "indexedAt": now,
                },
                {
                    "uri": "at://did:plc:other/app.bsky.feed.post/third",
                    "record": {"text": "Mumbai concert postponed", "createdAt": now},
                    "author": {"did": "did:plc:other", "handle": "third.example"},
                    "indexedAt": now,
                },
            ]
            return httpx.Response(
                200,
                json={"posts": posts},
                request=httpx.Request("GET", url),
            )

    monkeypatch.setattr(social_adapter_module, "get_http_client", lambda: FakeClient())
    adapter = BlueskySocialSignalAdapter(Settings(social_signal_min_interval_seconds=0))
    normalized = asyncio.run(
        adapter.search(
            "Mumbai",
            ["Mumbai"],
            center_latitude=19.0,
            center_longitude=72.0,
            since=datetime.now(UTC) - timedelta(hours=2),
        )
    )
    # Duplicate text is retained as independent observations for aggregation;
    # only provider identity within each row is represented as a salted hash.
    assert len(normalized) == 3
    assert normalized[0].topic is SocialTopic.FLOODING
    assert normalized[1].source_fingerprint != normalized[0].source_fingerprint
    assert all("text" not in item.model_dump() and "handle" not in item.model_dump() for item in normalized)


def test_bluesky_forbidden_is_reported_without_fabricating_signals() -> None:
    class ForbiddenAdapter:
        async def search(self, area_name, aliases, *, center_latitude, center_longitude, since):
            raise SocialSignalUnavailableError("provider denied request", status_code=403)

    service = SocialSignalService(Settings(social_signal_cache_ttl_seconds=0), FakeGeocoder(), ForbiddenAdapter())
    response = asyncio.run(service.get_social_signals(18.93, 72.83, 10))
    assert response.status == "UNAVAILABLE"
    assert response.clusters == []
    assert "HTTP 403" in response.message
    assert "No social signals were verified" in response.message


def test_aggregation_is_bounded_and_reports_sparse_trend_honestly() -> None:
    now = datetime.now(UTC)
    clusters = aggregate_social_signals(
        [signal(1), signal(2), signal(3, minutes_ago=220)],
        area_name="Fort",
        latitude=18.93,
        longitude=72.83,
        half_life_hours=6,
        now=now,
    )
    assert len(clusters) == 1
    assert clusters[0].location_precision == "area"
    assert clusters[0].signal_count == 3
    assert clusters[0].independent_source_count == 3
    assert clusters[0].trend == "insufficient_data"
    assert 0 <= clusters[0].confidence <= 1


class FakeGeocoder:
    def __init__(self):
        self.calls = 0

    async def reverse(self, lat: float, lng: float):
        self.calls += 1
        return LocationResult("Fort, Mumbai", lat, lng, "Mumbai", "Fort", "Maharashtra", "India")

    async def search(self, query: str, *, limit: int = 5):
        return []


class FakeAdapter:
    def __init__(self):
        self.calls = 0
        self.queries = []

    async def search(self, area_name, aliases, *, center_latitude, center_longitude, since):
        self.calls += 1
        self.queries.append((area_name, aliases))
        return [signal(1)]


def test_service_uses_verified_area_and_caches_aggregate_only() -> None:
    geocoder = FakeGeocoder()
    adapter = FakeAdapter()
    service = SocialSignalService(Settings(social_signal_cache_ttl_seconds=60), geocoder, adapter)

    async def load_twice():
        first = await service.get_social_signals(18.93, 72.83, 10)
        second = await service.get_social_signals(18.93, 72.83, 10)
        return first, second

    first, second = asyncio.run(load_twice())
    assert first.status == "AVAILABLE"
    assert first.queried_location == "Fort"
    response_json = first.model_dump_json()
    assert "source_fingerprint" not in response_json
    assert "deduplication_key" not in response_json
    assert adapter.calls == 1
    assert geocoder.calls == 1
    assert second == first

    async def load_many_centers():
        for index in range(70):
            await service.get_social_signals(18.93 + (index / 100_000), 72.83, 10)

    asyncio.run(load_many_centers())
    assert len(service._cache) == 64


def test_service_uses_catalog_area_when_reverse_geocoder_is_unavailable() -> None:
    class MissingGeocoder:
        async def reverse(self, lat: float, lng: float):
            return None

    adapter = FakeAdapter()
    service = SocialSignalService(Settings(social_signal_cache_ttl_seconds=60), MissingGeocoder(), adapter)
    response = asyncio.run(
        service.get_social_signals(
            19.0495064,
            72.90854323,
            10,
            fallback_locality="Matunga",
            fallback_city="Mumbai",
        )
    )
    assert response.status == "AVAILABLE"
    assert response.queried_location == "Matunga"
    assert response.location_source == "catalog_record"
    assert adapter.queries == [("Matunga", ["Matunga", "Mumbai"])]
    assert "catalog location" in response.message


def test_owned_itinerary_stop_supplies_catalog_area_to_social_endpoint(
    discovery_client, session_factory, discovery_dataset
) -> None:
    traveler = register_traveler(discovery_client, "social-owned-stop@example.com")
    visit_at = datetime.now(UTC) + timedelta(days=1)

    async def create_stop():
        async with session_factory() as session:
            location = (
                await session.execute(
                    select(Location.latitude, Location.longitude, Location.locality, Location.city)
                    .select_from(Experience)
                    .join(Location, Location.id == Experience.location_id)
                    .where(Experience.id == discovery_dataset["near_experience_id"])
                )
            ).one()
            itinerary = Itinerary(
                traveler_id=traveler["traveler"]["id"],
                title="Owned social context itinerary",
                itinerary_date=visit_at.date(),
                start_time=time(10, 0),
                end_time=time(11, 0),
                status="VALIDATED",
                source="MANUAL",
            )
            session.add(itinerary)
            await session.flush()
            item = ItineraryItem(
                itinerary_id=itinerary.id,
                experience_id=discovery_dataset["near_experience_id"],
                sequence_order=1,
                planned_start=visit_at,
                planned_end=visit_at + timedelta(minutes=45),
                duration_minutes=45,
                item_state="ACTIVE",
                is_locked=False,
            )
            session.add(item)
            await session.commit()
            return item.id, location

    item_id, location = asyncio.run(create_stop())
    captured: dict[str, object] = {}

    class OwnedStopService:
        async def get_social_signals(
            self, lat, lng, radius, topics, since_hours, fallback_locality=None, fallback_city=None
        ):
            captured.update(
                lat=lat,
                lng=lng,
                radius=radius,
                fallback_locality=fallback_locality,
                fallback_city=fallback_city,
            )
            return SocialSignalsResponse(
                status="NO_SIGNALS",
                queried_location=fallback_locality or fallback_city,
                location_source="catalog_record",
                radius_km=radius,
                generated_at=datetime.now(UTC),
                clusters=[],
                message="No recent public signals.",
            )

    discovery_client.app.dependency_overrides[get_social_signal_service] = lambda: OwnedStopService()
    response = discovery_client.get(
        f"/api/v1/twin/social-signals?lat={location.latitude}&lng={location.longitude}&itinerary_item_id={item_id}",
        headers=auth_header(traveler),
    )
    assert response.status_code == 200, response.text
    assert response.json()["location_source"] == "catalog_record"
    assert captured == {
        "lat": location.latitude,
        "lng": location.longitude,
        "radius": 10,
        "fallback_locality": location.locality,
        "fallback_city": location.city,
    }
    discovery_client.app.dependency_overrides.pop(get_social_signal_service, None)


def test_social_signal_endpoint_requires_auth_and_rejects_bad_coordinates(client) -> None:
    assert client.get("/api/v1/twin/social-signals?lat=18.93&lng=72.83").status_code == 401
    traveler = register_traveler(client, "social-signals@example.com")
    response = client.get(
        "/api/v1/twin/social-signals?lat=91&lng=72.83",
        headers=auth_header(traveler),
    )
    assert response.status_code == 422


def test_social_signal_endpoint_returns_aggregates_only(client) -> None:
    traveler = register_traveler(client, "social-aggregate@example.com")
    response_model = SocialSignalsResponse(
        status="NO_SIGNALS",
        radius_km=10,
        generated_at=datetime.now(UTC),
        clusters=[],
        message="No matching posts.",
    )

    captured: dict[str, object] = {}

    class EmptyService:
        async def get_social_signals(self, lat, lng, radius, topics, since_hours):
            captured.update(lat=lat, lng=lng, radius=radius, topics=topics, since_hours=since_hours)
            return response_model

    client.app.dependency_overrides[get_social_signal_service] = lambda: EmptyService()
    response = client.get(
        "/api/v1/twin/social-signals?lat=18.93&lng=72.83&topics=flooding&since_hours=6",
        headers=auth_header(traveler),
    )
    assert response.status_code == 200
    assert response.json()["status"] == "NO_SIGNALS"
    assert captured == {"lat": 18.93, "lng": 72.83, "radius": 10, "topics": ["flooding"], "since_hours": 6}
    assert "post_text" not in response.text
    assert "author_did" not in response.text
    client.app.dependency_overrides.pop(get_social_signal_service, None)


def test_social_signal_endpoint_rejects_unsupported_lookback(client) -> None:
    traveler = register_traveler(client, "social-lookback@example.com")
    response = client.get(
        "/api/v1/twin/social-signals?lat=18.93&lng=72.83&since_hours=25",
        headers=auth_header(traveler),
    )
    assert response.status_code == 422
