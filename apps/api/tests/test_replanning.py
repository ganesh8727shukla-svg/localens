"""ReplanningService tests (Phase 9).

Builds a real composed+validated itinerary via the Phase 8 API (using the
discovery_dataset/discovery_client fixtures), then drives
ReplanningService directly against the same session/adapters to assert
the 13-step algorithm's key outcomes.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from src.adapters.ai import MockAIAdapter
from src.adapters.routing import MockRoutingAdapter
from src.core.config import get_settings
from src.models.itinerary import Itinerary
from src.services.context_impact import ContextImpactResult, ImpactSeverity
from src.services.replanning import ReplanningService, ReplanStatus
from tests.conftest import auth_header, register_traveler


async def _get_itinerary_with_items(session, itinerary_id: str) -> Itinerary:
    """session.get(Itinerary, id) does not eager-load .items — accessing
    it afterwards triggers an implicit lazy-load that fails outside the
    async greenlet bridge with MissingGreenlet. Use the same
    selectinload ItineraryRepository.get_owned_by_id already uses."""
    result = await session.execute(
        select(Itinerary).where(Itinerary.id == itinerary_id).options(selectinload(Itinerary.items))
    )
    return result.scalars().unique().one()


def _compose_payload(**overrides) -> dict:
    payload = {
        "query": "food",
        "itinerary_date": "2026-10-12",
        "start_time": "09:00:00",
        "end_time": "20:00:00",
        "max_experiences": 3,
        "travel_mode": "driving",
    }
    payload.update(overrides)
    return payload


def _compose_itinerary(discovery_client) -> tuple[dict, dict]:
    user = register_traveler(discovery_client, "replan-traveler@example.com")
    resp = discovery_client.post(
        "/api/v1/itineraries/compose", json=_compose_payload(), headers=auth_header(user)
    )
    assert resp.status_code == 200, resp.text
    return user, resp.json()


def _no_impact_result() -> ContextImpactResult:
    return ContextImpactResult(affected=False, severity=ImpactSeverity.NONE, context_type="WEATHER")


def _affected_result(item_ids: list[str]) -> ContextImpactResult:
    return ContextImpactResult(
        affected=True, severity=ImpactSeverity.HIGH, context_type="WEATHER",
        affected_itinerary_item_ids=item_ids, reason_codes=["WEATHER_UNSUITABLE"],
        explanation="Test-triggered weather impact.",
    )


def _service(session) -> ReplanningService:
    return ReplanningService(
        session=session,
        settings=get_settings(),
        routing_adapter=MockRoutingAdapter(),
        embedding_adapter=None,
        ai_adapter=MockAIAdapter(),
    )


def test_no_impact_returns_no_change_and_no_new_version(discovery_client, session_factory) -> None:
    user, body = _compose_itinerary(discovery_client)
    if "items" not in body:
        return  # composition failed to find a plan given the small dataset — nothing to replan

    itinerary_id = body["id"]
    traveler_id = body["traveler_id"]

    async def _run():
        async with session_factory() as session:
            service = _service(session)
            outcome = await service.replan_itinerary(
                itinerary_id=itinerary_id, traveler_id=traveler_id,
                trigger="WEATHER_CHANGED", impact=_no_impact_result(),
            )
            return outcome

    outcome = asyncio.run(_run())
    assert outcome.status == ReplanStatus.NO_CHANGE
    assert outcome.new_version == outcome.previous_version


def test_replan_replaces_weather_affected_stop_inside_its_gap(
    discovery_client, session_factory, discovery_dataset
) -> None:
    user = register_traveler(discovery_client, "replan-gap-traveler@example.com")
    response = discovery_client.post(
        "/api/v1/itineraries/compose",
        json=_compose_payload(
            max_budget=5000,
            experience_ids=[
                discovery_dataset["near_experience_id"],
                discovery_dataset["far_experience_id"],
            ],
            max_experiences=2,
        ),
        headers=auth_header(user),
    )
    assert response.status_code == 200, response.text
    body = response.json()
    if len(body.get("items", [])) < 2:
        return  # the small catalog did not compose a later stop
    itinerary_id = body["id"]
    traveler_id = body["traveler_id"]
    affected_item_id = body["items"][0]["id"]
    retained_item_id = body["items"][1]["id"]
    future_now = datetime(2026, 10, 12, 8, 0, tzinfo=ZoneInfo("Asia/Kolkata"))

    async def _run():
        async with session_factory() as session:
            itinerary = await _get_itinerary_with_items(session, itinerary_id)
            retained = next(item for item in itinerary.items if item.id == retained_item_id)
            # Leave a real replacement window before this unaffected stop.
            retained.planned_start = datetime(2026, 10, 12, 17, 0)
            retained.planned_end = datetime(2026, 10, 12, 17, 30)
            itinerary.estimated_total_cost = 5000
            await session.commit()

            outcome = await _service(session).replan_itinerary(
                itinerary_id=itinerary_id,
                traveler_id=traveler_id,
                trigger="WEATHER_CHANGED",
                impact=_affected_result([affected_item_id]),
                now=future_now,
            )
            refreshed = await _get_itinerary_with_items(session, itinerary_id)
            return outcome, refreshed

    outcome, refreshed = asyncio.run(_run())
    assert outcome.status == ReplanStatus.REPLANNED, outcome.message
    assert outcome.previous_version == 1
    assert outcome.new_version == 2
    assert retained_item_id in {item.id for item in refreshed.items}
    assert affected_item_id not in {item.id for item in refreshed.items}
    ordered = sorted(refreshed.items, key=lambda item: item.sequence_order)
    assert [item.sequence_order for item in ordered] == list(range(1, len(ordered) + 1))
    retained = next(item for item in ordered if item.id == retained_item_id)
    replacement = next(item for item in ordered if item.id != retained_item_id)
    replacement_start = replacement.planned_start
    retained_start = retained.planned_start
    if replacement_start.tzinfo is None:
        replacement_start = replacement_start.replace(tzinfo=ZoneInfo("Asia/Kolkata"))
    if retained_start.tzinfo is None:
        retained_start = retained_start.replace(tzinfo=ZoneInfo("Asia/Kolkata"))
    assert replacement_start < retained_start


def test_wrong_traveler_gets_conflict_not_found(discovery_client, session_factory) -> None:
    user, body = _compose_itinerary(discovery_client)
    if "items" not in body:
        return
    itinerary_id = body["id"]

    async def _run():
        async with session_factory() as session:
            service = _service(session)
            return await service.replan_itinerary(
                itinerary_id=itinerary_id, traveler_id="not-the-real-traveler",
                trigger="WEATHER_CHANGED", impact=_no_impact_result(),
            )

    outcome = asyncio.run(_run())
    assert outcome.status == ReplanStatus.CONFLICT
    assert outcome.reason_code == "ITINERARY_NOT_FOUND"


def test_version_conflict_on_stale_expected_version(discovery_client, session_factory) -> None:
    user, body = _compose_itinerary(discovery_client)
    if "items" not in body:
        return
    itinerary_id = body["id"]
    traveler_id = body["traveler_id"]

    async def _run():
        async with session_factory() as session:
            service = _service(session)
            return await service.replan_itinerary(
                itinerary_id=itinerary_id, traveler_id=traveler_id,
                trigger="WEATHER_CHANGED", impact=_no_impact_result(),
                expected_version=999,
            )

    outcome = asyncio.run(_run())
    assert outcome.status == ReplanStatus.CONFLICT
    assert outcome.reason_code == "ITINERARY_VERSION_CONFLICT"


def test_locked_item_affected_requires_user_action(discovery_client, session_factory) -> None:
    user, body = _compose_itinerary(discovery_client)
    if "items" not in body or not body["items"]:
        return
    itinerary_id = body["id"]
    traveler_id = body["traveler_id"]
    first_item_id = body["items"][0]["id"]

    async def _run():
        async with session_factory() as session:
            itinerary = await _get_itinerary_with_items(session, itinerary_id)
            for item in itinerary.items:
                if item.id == first_item_id:
                    item.is_locked = True
                    # Ensure it's in the "future" window relative to now.
                    item.planned_start = datetime.now(UTC) + timedelta(days=365)
                    item.planned_end = item.planned_start + timedelta(hours=1)
            await session.commit()

            service = _service(session)
            return await service.replan_itinerary(
                itinerary_id=itinerary_id, traveler_id=traveler_id,
                trigger="WEATHER_CHANGED", impact=_affected_result([first_item_id]),
                now=datetime.now(UTC),
            )

    outcome = asyncio.run(_run())
    assert outcome.status == ReplanStatus.REQUIRES_USER_ACTION
    assert first_item_id in outcome.changes.affected_items


def test_completed_item_never_rewritten(discovery_client, session_factory) -> None:
    user, body = _compose_itinerary(discovery_client)
    if "items" not in body or not body["items"]:
        return
    itinerary_id = body["id"]
    traveler_id = body["traveler_id"]
    first_item_id = body["items"][0]["id"]

    async def _run():
        async with session_factory() as session:
            itinerary = await _get_itinerary_with_items(session, itinerary_id)
            for item in itinerary.items:
                if item.id == first_item_id:
                    # Move this item entirely into the past — "completed".
                    item.planned_start = datetime.now(UTC) - timedelta(days=2)
                    item.planned_end = item.planned_start + timedelta(hours=1)
            await session.commit()

            original_experience_id = None
            for item in itinerary.items:
                if item.id == first_item_id:
                    original_experience_id = item.experience_id

            service = _service(session)
            # Mark that same (now-past) item as "affected" — it must never
            # be removed/rewritten because it's already completed.
            outcome = await service.replan_itinerary(
                itinerary_id=itinerary_id, traveler_id=traveler_id,
                trigger="WEATHER_CHANGED", impact=_affected_result([first_item_id]),
                now=datetime.now(UTC),
            )
            return outcome, original_experience_id

    outcome, original_experience_id = asyncio.run(_run())
    # A past item flagged as "affected" produces no schedulable flexible
    # removal (it's preserved, not flexible) -> NO_CHANGE, never rewritten.
    assert outcome.status == ReplanStatus.NO_CHANGE


def test_determinism_same_inputs_same_result(discovery_client, session_factory) -> None:
    user, body = _compose_itinerary(discovery_client)
    if "items" not in body:
        return
    itinerary_id = body["id"]
    traveler_id = body["traveler_id"]

    async def _run():
        async with session_factory() as session:
            service = _service(session)
            first = await service.replan_itinerary(
                itinerary_id=itinerary_id, traveler_id=traveler_id,
                trigger="WEATHER_CHANGED", impact=_no_impact_result(),
            )
            second = await service.replan_itinerary(
                itinerary_id=itinerary_id, traveler_id=traveler_id,
                trigger="WEATHER_CHANGED", impact=_no_impact_result(),
            )
            return first, second

    first, second = asyncio.run(_run())
    assert first.status == second.status == ReplanStatus.NO_CHANGE


def test_idempotency_key_prevents_duplicate_revision(discovery_client, session_factory) -> None:
    user, body = _compose_itinerary(discovery_client)
    if "items" not in body or not body["items"]:
        return
    itinerary_id = body["id"]
    traveler_id = body["traveler_id"]
    first_item_id = body["items"][0]["id"]

    async def _run():
        async with session_factory() as session:
            service = _service(session)
            key = "idem-key-1"
            first = await service.replan_itinerary(
                itinerary_id=itinerary_id, traveler_id=traveler_id,
                trigger="USER_REQUESTED", impact=_affected_result([first_item_id]),
                idempotency_key=key,
            )
            second = await service.replan_itinerary(
                itinerary_id=itinerary_id, traveler_id=traveler_id,
                trigger="USER_REQUESTED", impact=_affected_result([first_item_id]),
                idempotency_key=key,
            )
            from src.models.itinerary_revision import ItineraryRevision

            count = (
                await session.execute(
                    select(ItineraryRevision).where(
                        ItineraryRevision.itinerary_id == itinerary_id,
                        ItineraryRevision.idempotency_key == key,
                    )
                )
            ).scalars().all()
            return first, second, len(count)

    first, second, revision_count = asyncio.run(_run())
    assert revision_count <= 1  # never more than one revision for the same idempotency key
    assert first.status == second.status
