from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from src.adapters.ai import MockAIAdapter
from src.adapters.embedding import MockEmbeddingAdapter
from src.adapters.geocoding import MockGeocodingAdapter
from src.adapters.poi import MockPOIAdapter
from src.adapters.routing import MockRoutingAdapter
from src.adapters.weather import MockWeatherAdapter
from src.core.ai import get_ai_adapter
from src.core.app import create_app
from src.core.context import get_weather_adapter
from src.core.db import Base, get_session
from src.core.embedding import get_embedding_adapter
from src.core.location import get_geocoding_adapter, get_poi_adapter, get_routing_adapter
from src.models import (
    Experience,
    ExperienceAvailability,
    ExperienceCategory,
    ExperienceEmbedding,
    ExperienceOpeningHour,
    Location,
    Provider,
)
from src.services.embedding_text import build_experience_document_text

# Tests never hit real Nominatim/OSRM/Overpass/Gemini — dependency-override
# with mocks by default (real-adapter behavior is covered by
# tests/test_*_adapter.py using an injected fake HTTP client/SDK instead).
# This also sidesteps a real footgun: get_http_client()/get_*_adapter()
# are process-wide lru_cache singletons bound to whichever asyncio event
# loop was live when first created, and pytest's TestClient spins up a
# fresh loop per test — reusing a live httpx.AsyncClient across loops
# raises "Event loop is closed".


def _override_location_adapters(app) -> None:
    app.dependency_overrides[get_geocoding_adapter] = lambda: MockGeocodingAdapter()
    app.dependency_overrides[get_routing_adapter] = lambda: MockRoutingAdapter()
    app.dependency_overrides[get_poi_adapter] = lambda: MockPOIAdapter()


def _override_ai_adapters(app) -> None:
    app.dependency_overrides[get_ai_adapter] = lambda: MockAIAdapter()
    app.dependency_overrides[get_embedding_adapter] = lambda: MockEmbeddingAdapter()


def _override_context_adapters(app) -> None:
    # API contract tests must not depend on a configured OpenWeather key or
    # outbound network availability. Provider parsing is tested separately
    # with fake HTTP clients in test_weather_adapter.py.
    app.dependency_overrides[get_weather_adapter] = lambda: MockWeatherAdapter()


@pytest.fixture()
def test_engine():
    # StaticPool keeps a single shared connection so the in-memory SQLite
    # database persists across the multiple sessions used in a test
    # (seed fixture + API request sessions) instead of each getting its
    # own empty :memory: database.
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )

    async def _create() -> None:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    asyncio.run(_create())
    yield engine
    asyncio.run(engine.dispose())


@pytest.fixture()
def session_factory(test_engine):
    return async_sessionmaker(test_engine, expire_on_commit=False, class_=AsyncSession)


@pytest.fixture()
def seeded_ids(session_factory) -> dict[str, str]:
    async def _seed() -> dict[str, str]:
        async with session_factory() as session:
            category = ExperienceCategory(slug="food-drink", name="Food & Drink", sort_order=1)
            session.add(category)
            await session.flush()

            location = Location(
                latitude=18.93, longitude=72.83, place_name="Test Place", city="Mumbai",
                locality="Fort", source_type="overture_places", is_synthetic=False,
            )
            session.add(location)

            provider = Provider(
                business_name="Test Provider", verification_status="catalog_imported",
                source_type="overture_places", is_synthetic=False,
            )
            session.add(provider)
            await session.flush()

            experience = Experience(
                provider=provider,
                category=category,
                location=location,
                title="Test Experience",
                short_description="A test experience.",
                full_description="A longer description of the test experience.",
                minimum_price=100,
                maximum_price=500,
                price_type="range",
                price_source="estimated",
                is_price_estimated=True,
                duration_minutes=60,
                duration_is_estimated=True,
                status="active",
                verification_status="catalog_imported",
                opening_hours_status="unavailable",
                source_type="overture_places",
                source_record_id="rec-1",
                is_synthetic=False,
                is_enriched=True,
            )
            session.add(experience)
            await session.commit()
            return {
                "category_id": category.id,
                "location_id": location.id,
                "provider_id": provider.id,
                "experience_id": experience.id,
            }

    return asyncio.run(_seed())


@pytest.fixture()
def client(session_factory, seeded_ids):
    from fastapi.testclient import TestClient

    app = create_app()

    async def override_get_session() -> AsyncIterator[AsyncSession]:
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = override_get_session
    _override_location_adapters(app)
    _override_ai_adapters(app)
    _override_context_adapters(app)
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


# Fort, Mumbai reference point used across discovery/geo tests.
FORT_LAT, FORT_LNG = 18.9346, 72.8356


@pytest.fixture()
def discovery_dataset(session_factory) -> dict[str, str]:
    """A small varied catalog for discovery/filter/sort/geo tests — several
    categories, price points, durations, and locations at known distances
    from FORT_LAT/FORT_LNG (~0.1km, ~2km, ~15km)."""

    async def _seed() -> dict[str, str]:
        async with session_factory() as session:
            food = ExperienceCategory(slug="food-drink", name="Food & Drink", sort_order=1)
            culture = ExperienceCategory(slug="culture-heritage", name="Culture & Heritage", sort_order=2)
            session.add_all([food, culture])
            await session.flush()

            provider = Provider(
                business_name="Discovery Test Co", verification_status="unverified",
                source_type="registered", is_synthetic=False,
            )
            session.add(provider)
            await session.flush()

            # near: ~0.1km from Fort reference point
            loc_near = Location(
                latitude=FORT_LAT + 0.001, longitude=FORT_LNG, city="Mumbai", locality="Fort",
                source_type="synthetic", is_synthetic=True,
            )
            # mid: ~2km away
            loc_mid = Location(
                latitude=FORT_LAT + 0.018, longitude=FORT_LNG, city="Mumbai", locality="Byculla",
                source_type="synthetic", is_synthetic=True,
            )
            # far: ~15km away
            loc_far = Location(
                latitude=FORT_LAT + 0.135, longitude=FORT_LNG, city="Mumbai", locality="Andheri",
                source_type="synthetic", is_synthetic=True,
            )
            session.add_all([loc_near, loc_mid, loc_far])
            await session.flush()

            experiences = [
                Experience(
                    provider=provider, category=food, location=loc_near,
                    title="Fort Heritage Food Trail", short_description="A tasty walk near Fort.",
                    full_description="A longer description of the food trail near Fort.",
                    price=300, price_type="fixed", price_source="estimated", is_price_estimated=True,
                    duration_minutes=45, duration_is_estimated=True, status="active",
                    verification_status="unverified", opening_hours_status="unavailable",
                    source_type="synthetic", is_synthetic=True,
                ),
                Experience(
                    provider=provider, category=culture, location=loc_mid,
                    title="Byculla Museum Walk", short_description="Explore Byculla's museum.",
                    full_description="A longer description of the Byculla museum walk.",
                    price=800, price_type="fixed", price_source="estimated", is_price_estimated=True,
                    duration_minutes=120, duration_is_estimated=True, status="active",
                    verification_status="unverified", opening_hours_status="unavailable",
                    source_type="synthetic", is_synthetic=True,
                ),
                Experience(
                    provider=provider, category=food, location=loc_far,
                    title="Andheri Street Snacks", short_description="Local snacks in Andheri.",
                    full_description="A longer description of Andheri street snacks.",
                    price=150, price_type="fixed", price_source="estimated", is_price_estimated=True,
                    duration_minutes=30, duration_is_estimated=True, status="active",
                    verification_status="unverified", opening_hours_status="unavailable",
                    source_type="synthetic", is_synthetic=True,
                ),
                Experience(
                    provider=provider, category=culture, location=loc_near,
                    title="Inactive Heritage Tour", short_description="Not currently active.",
                    full_description="A longer description of an inactive experience.",
                    price=500, price_type="fixed", price_source="estimated", is_price_estimated=True,
                    duration_minutes=60, duration_is_estimated=True, status="inactive",
                    verification_status="unverified", opening_hours_status="unavailable",
                    source_type="synthetic", is_synthetic=True,
                ),
            ]
            session.add_all(experiences)
            await session.flush()

            # Real opening-hours + availability data — without this, every
            # experience is opening_hours_status="unavailable" with zero
            # ExperienceOpeningHour/ExperienceAvailability rows, so any
            # compose/feasibility test that supplies a date/time window
            # (the normal case) always gets UNKNOWN/infeasible for every
            # candidate and silently produces 0 feasible results. Wide-open
            # hours (every day, effectively all-day) + a generous multi-day
            # availability window keep this fixture from being the
            # constraint under test in tests that are about something else
            # (replanning, versioning, etc.) — tests that specifically want
            # to exercise opening-hours/availability edge cases seed their
            # own narrower rows.
            from datetime import UTC as _UTC
            from datetime import datetime as _datetime
            from datetime import timedelta as _timedelta

            for exp in experiences:
                for day in range(7):
                    session.add(
                        ExperienceOpeningHour(
                            experience_id=exp.id, day_of_week=day,
                            open_time="00:00", close_time="23:59", is_closed=False,
                        )
                    )
                session.add(
                    ExperienceAvailability(
                        experience_id=exp.id,
                        starts_at=_datetime(2026, 1, 1, tzinfo=_UTC),
                        ends_at=_datetime(2026, 1, 1, tzinfo=_UTC) + _timedelta(days=730),
                        capacity=50, available_slots=50, status="active",
                    )
                )
            await session.flush()

            # Phase 6 semantic retrieval requires an ExperienceEmbedding row
            # per experience to be a candidate at all (see
            # SemanticRetrievalService._sqlite_python_search) — seed
            # deterministic mock embeddings so conversation/discovery tests
            # that go through the real semantic path (not the keyword
            # fallback) actually see these experiences as candidates.
            embed_adapter = MockEmbeddingAdapter()
            for exp in experiences:
                doc = build_experience_document_text(exp)
                vector = await embed_adapter.embed_document(doc.title, doc.text)
                session.add(
                    ExperienceEmbedding(
                        experience_id=exp.id, embedding=vector, embedding_model="mock",
                        embedding_dimensions=len(vector), source_content_hash=doc.content_hash,
                    )
                )
            await session.commit()

            return {
                "food_category_id": food.id,
                "culture_category_id": culture.id,
                "provider_id": provider.id,
                "near_experience_id": experiences[0].id,
                "mid_experience_id": experiences[1].id,
                "far_experience_id": experiences[2].id,
                "inactive_experience_id": experiences[3].id,
            }

    return asyncio.run(_seed())


@pytest.fixture()
def discovery_client(session_factory, discovery_dataset):
    from fastapi.testclient import TestClient

    app = create_app()

    async def override_get_session() -> AsyncIterator[AsyncSession]:
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = override_get_session
    _override_location_adapters(app)
    _override_ai_adapters(app)
    _override_context_adapters(app)
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


def register_traveler(client, email: str, password: str = "supersecret123", **extra) -> dict:
    payload = {
        "email": email,
        "password": password,
        "role": "traveler",
        "display_name": "Test Traveler",
        **extra,
    }
    response = client.post("/api/v1/auth/register", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def register_provider(
    client, email: str, business_name: str, password: str = "supersecret123", **extra
) -> dict:
    payload = {
        "email": email,
        "password": password,
        "role": "provider",
        "display_name": "Test Provider Owner",
        "business_name": business_name,
        **extra,
    }
    response = client.post("/api/v1/auth/register", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def auth_header(body: dict) -> dict:
    return {"Authorization": f"Bearer {body['access_token']}"}
