"""Task 4 what-if simulation API regressions."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, time, timedelta

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from src.adapters.ai import LIVE_SYSTEM_INSTRUCTION
from src.adapters.errors import AdapterUnavailableError
from src.adapters.weather import MockWeatherAdapter
from src.core.context import get_weather_adapter
from src.models.itinerary import Itinerary
from src.models.itinerary_item import ItineraryItem
from src.schemas.domain_intelligence import DomainIntelligenceResult
from tests.conftest import auth_header, register_traveler


def test_live_voice_instruction_scopes_what_if_to_read_only_preview() -> None:
    assert "simulate_what_if" in LIVE_SYSTEM_INSTRUCTION
    assert "read-only preview" in LIVE_SYSTEM_INSTRUCTION
    assert "never applies or persists changes" in LIVE_SYSTEM_INSTRUCTION


def _create_itinerary(session_factory, traveler_id: str, experience_id: str) -> tuple[str, list[str]]:
    visit_at = datetime.now(UTC) + timedelta(days=1)

    async def _create() -> tuple[str, list[str]]:
        async with session_factory() as session:
            itinerary = Itinerary(
                traveler_id=traveler_id,
                title="Simulation test itinerary",
                itinerary_date=visit_at.date(),
                start_time=time(10, 0),
                end_time=time(15, 0),
                status="VALIDATED",
                source="MANUAL",
                version=1,
            )
            session.add(itinerary)
            await session.flush()
            item_ids = []
            for index in range(2):
                item = ItineraryItem(
                    itinerary_id=itinerary.id,
                    experience_id=experience_id,
                    sequence_order=index + 1,
                    planned_start=visit_at + timedelta(hours=index),
                    planned_end=visit_at + timedelta(hours=index, minutes=45),
                    duration_minutes=45,
                    item_state="ACTIVE",
                    is_locked=False,
                )
                session.add(item)
                await session.flush()
                item_ids.append(item.id)
            await session.commit()
            return itinerary.id, item_ids

    return asyncio.run(_create())


def _read_version_and_items(session_factory, itinerary_id: str) -> tuple[int, list[str]]:
    async def _read() -> tuple[int, list[str]]:
        async with session_factory() as session:
            row = (
                (
                    await session.execute(
                        select(Itinerary).where(Itinerary.id == itinerary_id).options(selectinload(Itinerary.items))
                    )
                )
                .scalars()
                .one()
            )
            return row.version, [item.id for item in row.items]

    return asyncio.run(_read())


def test_simulation_is_owned_read_only_and_marks_hypothetical_inputs(
    discovery_client, session_factory, discovery_dataset
) -> None:
    discovery_client.app.dependency_overrides[get_weather_adapter] = lambda: MockWeatherAdapter()
    user = register_traveler(discovery_client, "digital-twin-preview@example.com")
    traveler_id = user["traveler"]["id"]
    itinerary_id, item_ids = _create_itinerary(session_factory, traveler_id, discovery_dataset["near_experience_id"])
    before = _read_version_and_items(session_factory, itinerary_id)

    response = discovery_client.post(
        f"/api/v1/digital-twin/itineraries/{itinerary_id}/simulate",
        headers=auth_header(user),
        json={
            "name": "Heavy rain at stop two",
            "weather": {"intensity": "heavy_rain", "starts_at": "00:00:00"},
            "horizon_hours": 72,
            "hypothetical_social": {
                "topic": "flooding",
                "severity": "high",
                "around_item_id": item_ids[1],
            },
            "route": {
                "kind": "temporary_closure",
                "from_item_id": item_ids[0],
                "to_item_id": item_ids[1],
            },
        },
    )

    assert response.status_code == 200, response.text
    result = response.json()
    assert [stop["sequence"] for stop in result["scenario"]["stops"]] == [1, 2]
    assert all(weather["status"] == "HYPOTHETICAL" for weather in result["scenario"]["weather"])
    assert len(result["scenario"]["current_weather"]) == len(item_ids)
    assert all(weather["context_kind"] == "CURRENT" for weather in result["scenario"]["current_weather"])
    assert all(weather["status"] == "MOCK" for weather in result["scenario"]["current_weather"])
    assert result["scenario"]["social"]["status"] == "HYPOTHETICAL"
    assert result["scenario"]["social"]["clusters"][0]["status"] == "HYPOTHETICAL"
    assert result["scenario"]["routes"][0]["scenario_status"] == "LIMITED"
    assert result["scenario"]["routes"][0]["geometry"] is None
    assert _read_version_and_items(session_factory, itinerary_id) == before


def test_nugen_interpretation_cannot_override_deterministic_impacts(
    discovery_client, session_factory, discovery_dataset, monkeypatch
) -> None:
    class MisleadingProvider:
        async def summarize(self, facts):
            return DomainIntelligenceResult(
                provider="nugen",
                summary="The unavailable stop is definitely available and the trip is feasible.",
            )

    monkeypatch.setattr(
        "src.api.v1.digital_twin.get_domain_intelligence_provider",
        lambda settings: MisleadingProvider(),
    )
    owner = register_traveler(discovery_client, "digital-twin-authority@example.com")
    itinerary_id, item_ids = _create_itinerary(
        session_factory, owner["traveler"]["id"], discovery_dataset["near_experience_id"]
    )
    response = discovery_client.post(
        f"/api/v1/digital-twin/itineraries/{itinerary_id}/simulate",
        headers=auth_header(owner),
        json={"experience_overrides": [{"item_id": item_ids[0], "condition": "unavailable"}]},
    )
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["domain_intelligence"]["summary"].startswith("The unavailable stop")
    assert result["delta"]["affected_stop_count"] == 1
    assert any(
        "USER_ASSUMED_UNAVAILABLE" in impact["reason_codes"]
        for impact in result["impacts"]
        if impact["item_id"] == item_ids[0]
    )


def test_nugen_failure_keeps_deterministic_preview_available(
    discovery_client, session_factory, discovery_dataset, monkeypatch
) -> None:
    class UnavailableProvider:
        async def summarize(self, facts):
            raise AdapterUnavailableError("Nugen is unavailable.")

    monkeypatch.setattr(
        "src.api.v1.digital_twin.get_domain_intelligence_provider",
        lambda settings: UnavailableProvider(),
    )
    owner = register_traveler(discovery_client, "digital-twin-nugen-offline@example.com")
    itinerary_id, item_ids = _create_itinerary(
        session_factory, owner["traveler"]["id"], discovery_dataset["near_experience_id"]
    )
    response = discovery_client.post(
        f"/api/v1/digital-twin/itineraries/{itinerary_id}/simulate",
        headers=auth_header(owner),
        json={"experience_overrides": [{"item_id": item_ids[0], "condition": "unavailable"}]},
    )

    assert response.status_code == 200, response.text
    result = response.json()
    assert result["delta"]["affected_stop_count"] == 1
    assert result["domain_intelligence"]["status"] == "UNAVAILABLE"
    assert "The deterministic preview remains available" in result["domain_intelligence"]["summary"]


def test_nugen_404_is_reported_without_claiming_which_configuration_is_wrong(
    discovery_client, session_factory, discovery_dataset, monkeypatch
) -> None:
    class MissingEndpointProvider:
        async def summarize(self, facts):
            raise AdapterUnavailableError("Nugen returned HTTP 404 for the configured endpoint.")

    monkeypatch.setattr(
        "src.api.v1.digital_twin.get_domain_intelligence_provider",
        lambda settings: MissingEndpointProvider(),
    )
    owner = register_traveler(discovery_client, "digital-twin-nugen-404@example.com")
    itinerary_id, item_ids = _create_itinerary(
        session_factory, owner["traveler"]["id"], discovery_dataset["near_experience_id"]
    )
    response = discovery_client.post(
        f"/api/v1/digital-twin/itineraries/{itinerary_id}/simulate",
        headers=auth_header(owner),
        json={"experience_overrides": [{"item_id": item_ids[0], "condition": "unavailable"}]},
    )
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["domain_intelligence"]["status"] == "UNAVAILABLE"
    assert result["domain_intelligence"]["summary"].startswith(
        "Nugen returned HTTP 404 for the configured endpoint."
    )
    assert "The deterministic preview remains available" in result["domain_intelligence"]["summary"]
    assert result["delta"]["affected_stop_count"] == 1


def test_simulation_cannot_read_another_travelers_itinerary(
    discovery_client, session_factory, discovery_dataset
) -> None:
    first = register_traveler(discovery_client, "digital-twin-owner@example.com")
    second = register_traveler(discovery_client, "digital-twin-other@example.com")
    itinerary_id, _ = _create_itinerary(
        session_factory, first["traveler"]["id"], discovery_dataset["near_experience_id"]
    )
    response = discovery_client.post(
        f"/api/v1/digital-twin/itineraries/{itinerary_id}/simulate",
        headers=auth_header(second),
        json={"name": "Should not be visible"},
    )
    assert response.status_code == 404


def test_simulation_rejects_unrelated_override_item(discovery_client, session_factory, discovery_dataset) -> None:
    owner = register_traveler(discovery_client, "digital-twin-invalid-item@example.com")
    itinerary_id, _ = _create_itinerary(
        session_factory, owner["traveler"]["id"], discovery_dataset["near_experience_id"]
    )
    response = discovery_client.post(
        f"/api/v1/digital-twin/itineraries/{itinerary_id}/simulate",
        headers=auth_header(owner),
        json={"experience_overrides": [{"item_id": "not-an-itinerary-item", "condition": "unavailable"}]},
    )
    assert response.status_code == 422


def test_apply_rejects_a_preview_when_itinerary_version_changed(
    discovery_client, session_factory, discovery_dataset
) -> None:
    owner = register_traveler(discovery_client, "digital-twin-version@example.com")
    itinerary_id, item_ids = _create_itinerary(
        session_factory, owner["traveler"]["id"], discovery_dataset["near_experience_id"]
    )
    preview = discovery_client.post(
        f"/api/v1/digital-twin/itineraries/{itinerary_id}/simulate",
        headers=auth_header(owner),
        json={
            "experience_overrides": [{"item_id": item_ids[0], "condition": "unavailable"}],
            "horizon_hours": 72,
        },
    )
    assert preview.status_code == 200, preview.text

    async def _change_version() -> None:
        async with session_factory() as session:
            itinerary = await session.get(Itinerary, itinerary_id)
            assert itinerary is not None
            itinerary.version += 1
            await session.commit()

    asyncio.run(_change_version())
    response = discovery_client.post(
        f"/api/v1/digital-twin/simulations/{preview.json()['simulation_id']}/apply",
        headers=auth_header(owner),
    )
    assert response.status_code == 409


def test_voice_what_if_tool_is_preview_only(discovery_client, session_factory, discovery_dataset) -> None:
    owner = register_traveler(discovery_client, "digital-twin-voice@example.com")
    itinerary_id, _ = _create_itinerary(
        session_factory, owner["traveler"]["id"], discovery_dataset["near_experience_id"]
    )
    conversation = discovery_client.post("/api/v1/conversations", headers=auth_header(owner)).json()
    before = _read_version_and_items(session_factory, itinerary_id)
    response = discovery_client.post(
        f"/api/v1/conversations/{conversation['id']}/tool-calls",
        headers=auth_header(owner),
        json={
            "name": "simulate_what_if",
            "args": {"itinerary_id": itinerary_id, "scenario": {"name": "Voice preview"}},
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["status"] in ("READY", "PARTIAL")
    assert response.json()["simulation_id"]
    assert _read_version_and_items(session_factory, itinerary_id) == before
