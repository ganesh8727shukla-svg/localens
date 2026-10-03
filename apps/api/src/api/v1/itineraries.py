"""Itinerary composer + retrieval endpoints (Phase 8).

Pipeline order (never varies): RETRIEVAL -> FEASIBILITY -> RANKING ->
COMPOSITION -> POST-COMPOSITION VALIDATION -> NARRATIVE -> persist.

traveler_id is always server-derived from require_traveler — POST
/compose's request body (ComposeItineraryRequest) has no traveler_id
field. Anonymous callers get 401 via require_traveler. Ownership is
enforced on every read/write via ItineraryRepository.get_owned_by_id
(never-disclose-existence pattern, matching conversation.py/providers.py).
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends
from fastapi.responses import Response, StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from src.adapters.ai import AIAdapter
from src.adapters.embedding import EmbeddingAdapter
from src.adapters.routing import RoutingAdapter
from src.adapters.weather import WeatherAdapter
from src.core.ai import get_ai_adapter
from src.core.config import Settings, get_settings
from src.core.context import get_weather_adapter
from src.core.db import get_session
from src.core.deps import require_traveler
from src.core.embedding import get_embedding_adapter
from src.core.errors import ApiError
from src.core.location import get_routing_adapter
from src.models.itinerary import Itinerary
from src.models.itinerary_item import ItineraryItem
from src.models.user import User
from src.repositories.experience_repository import ExperienceRepository
from src.repositories.itinerary_repository import ItineraryRepository
from src.schemas.itinerary import (
    AddItineraryItemRequest,
    ComposeItineraryRequest,
    CompositionValidationIssue,
    CompositionValidationResponse,
    ItineraryCustomActivityResponse,
    ItineraryItemResponse,
    ItineraryListResponse,
    ItineraryOpeningHour,
    ItineraryPreviewResponse,
    ItineraryResponse,
    NearbyOpenAlternative,
    PreviewIdeasRequest,
)
from src.schemas.itinerary_weather import ItineraryWeatherResponse
from src.schemas.replanning import ReplanChangeSetResponse, ReplanRequest, ReplanResponse
from src.services.compose_itinerary import ComposeOutcome, compose_and_persist_itinerary
from src.services.itinerary_hours import check_itinerary_stop_opening_hours
from src.services.itinerary_preview import preview_itinerary_plans
from src.services.itinerary_weather import get_itinerary_weather_advisories
from src.services.replanning import ReplanningService, ReplanOutcome
from src.services.sse import sse_updates_stream

router = APIRouter(tags=["itineraries"])


def _to_item_response(item: ItineraryItem, title_by_id: dict[str, str] | None = None) -> ItineraryItemResponse:
    return ItineraryItemResponse.model_validate(item)


async def _to_itinerary_response(
    itinerary: Itinerary, session: AsyncSession
) -> ItineraryResponse:
    exp_repo = ExperienceRepository(session)
    item_responses: list[ItineraryItemResponse] = []
    itinerary_experience_ids = {item.experience_id for item in itinerary.items}
    for item in itinerary.items:
        experience = await exp_repo.get_by_id(item.experience_id)
        resp = ItineraryItemResponse.model_validate(item)
        if experience is not None:
            resp.title = experience.title
            resp.short_description = experience.short_description
            resp.category_name = experience.category.name
            resp.location_place_name = experience.location.place_name
            resp.location_locality = experience.location.locality
            resp.location_city = experience.location.city
            resp.location_latitude = experience.location.latitude
            resp.location_longitude = experience.location.longitude
            resp.availability_data_is_synthetic = any(
                slot.is_synthetic and slot.status == "active"
                for slot in experience.availability_slots
            )
            opening_status = await check_itinerary_stop_opening_hours(
                experience,
                planned_start=item.planned_start,
                planned_end=item.planned_end,
                session=session,
                excluded_experience_ids=itinerary_experience_ids,
            )
            resp.opening_hours_status_at_visit = opening_status.status
            resp.opening_hours_for_visit = [
                ItineraryOpeningHour.model_validate(hour)
                for hour in opening_status.opening_hours_for_visit
            ]
            resp.nearby_open_alternatives = [
                NearbyOpenAlternative(
                    experience_id=place.experience.id,
                    title=place.experience.title,
                    category_name=place.experience.category.name,
                    locality=place.experience.location.locality,
                    city=place.experience.location.city,
                    distance_km=round(place.distance_km, 1),
                    opening_hours_for_visit=[
                        ItineraryOpeningHour.model_validate(hour)
                        for hour in place.opening_hours_for_visit
                    ],
                    is_synthetic=place.experience.is_synthetic,
                )
                for place in opening_status.nearby_open_alternatives
            ]
        item_responses.append(resp)

    base = ItineraryResponse.model_validate(itinerary)
    base.items = item_responses
    base.custom_activities = [
        ItineraryCustomActivityResponse.model_validate(activity)
        for activity in itinerary.custom_activities
    ]
    base.version = itinerary.version
    base.replanning_status = itinerary.replanning_status
    base.context_last_updated_at = itinerary.context_last_updated_at
    return base


@router.post("/itineraries/preview", response_model=ItineraryPreviewResponse)
async def preview_itinerary(
    payload: ComposeItineraryRequest,
    _user: Annotated[User, Depends(require_traveler)],
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
    routing_adapter: Annotated[RoutingAdapter, Depends(get_routing_adapter)],
) -> ItineraryPreviewResponse:
    """Check a draft schedule live without writing an itinerary row."""
    results = await preview_itinerary_plans(
        session=session,
        settings=settings,
        routing_adapter=routing_adapter,
        base=payload,
        plans=[payload.experience_ids],
    )
    return results[0]


@router.post("/itineraries/preview-ideas", response_model=list[ItineraryPreviewResponse])
async def preview_itinerary_ideas(
    payload: PreviewIdeasRequest,
    _user: Annotated[User, Depends(require_traveler)],
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
    routing_adapter: Annotated[RoutingAdapter, Depends(get_routing_adapter)],
) -> list[ItineraryPreviewResponse]:
    """Date-check loaded catalog combinations in one non-persisting call."""
    return await preview_itinerary_plans(
        session=session,
        settings=settings,
        routing_adapter=routing_adapter,
        base=payload.base,
        plans=payload.plans,
    )


async def _get_owned_or_404(session: AsyncSession, itinerary_id: str, traveler_id: str) -> Itinerary:
    itinerary = await ItineraryRepository(session).get_owned_by_id(itinerary_id, traveler_id)
    if itinerary is None:
        # Never disclose existence of another traveler's itinerary.
        raise ApiError("Itinerary not found", status_code=404)
    return itinerary


@router.post(
    "/itineraries/compose",
    response_model=ItineraryResponse | CompositionValidationResponse,
)
async def compose_itinerary(
    payload: ComposeItineraryRequest,
    user: Annotated[User, Depends(require_traveler)],
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
    routing_adapter: Annotated[RoutingAdapter, Depends(get_routing_adapter)],
    embedding_adapter: Annotated[EmbeddingAdapter, Depends(get_embedding_adapter)],
    ai_adapter: Annotated[AIAdapter, Depends(get_ai_adapter)],
) -> ItineraryResponse | CompositionValidationResponse:
    traveler_id = user.traveler.id

    outcome: ComposeOutcome = await compose_and_persist_itinerary(
        session=session,
        settings=settings,
        routing_adapter=routing_adapter,
        embedding_adapter=embedding_adapter,
        ai_adapter=ai_adapter,
        traveler_id=traveler_id,
        request=payload,
    )

    if not outcome.valid or outcome.itinerary is None:
        return CompositionValidationResponse(
            valid=False,
            reason_code=outcome.reason_code or "COMPOSITION_NO_VALID_PLAN",
            message=outcome.message or "No valid itinerary could be composed for the given constraints.",
            issues=[
                CompositionValidationIssue(
                    code=i.code.value, constraint=i.constraint, message=i.message, evidence=i.evidence
                )
                for i in outcome.issues
            ],
            candidate_count=outcome.candidate_count,
            feasible_count=outcome.feasible_count,
        )

    return await _to_itinerary_response(outcome.itinerary, session)


@router.get("/itineraries", response_model=ItineraryListResponse)
async def list_my_itineraries(
    user: Annotated[User, Depends(require_traveler)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ItineraryListResponse:
    rows, total = await ItineraryRepository(session).list_by_traveler(user.traveler.id)
    items = [await _to_itinerary_response(row, session) for row in rows]
    return ItineraryListResponse(items=items, total=total)


@router.get("/itineraries/{itinerary_id}", response_model=ItineraryResponse)
async def get_itinerary(
    itinerary_id: str,
    user: Annotated[User, Depends(require_traveler)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ItineraryResponse:
    itinerary = await _get_owned_or_404(session, itinerary_id, user.traveler.id)
    return await _to_itinerary_response(itinerary, session)


@router.get("/itineraries/{itinerary_id}/weather", response_model=ItineraryWeatherResponse)
async def get_itinerary_weather(
    itinerary_id: str,
    user: Annotated[User, Depends(require_traveler)],
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
    weather_adapter: Annotated[WeatherAdapter, Depends(get_weather_adapter)],
) -> ItineraryWeatherResponse:
    """Return scheduled-time weather advisories without changing trip data."""
    if user.traveler is None:
        raise ApiError("Traveler profile not found", status_code=403)
    itinerary = await _get_owned_or_404(session, itinerary_id, user.traveler.id)
    return await get_itinerary_weather_advisories(
        itinerary=itinerary,
        session=session,
        settings=settings,
        weather_adapter=weather_adapter,
    )


@router.post("/itineraries/{itinerary_id}/items", response_model=ItineraryResponse | CompositionValidationResponse)
async def add_itinerary_item(
    itinerary_id: str,
    payload: AddItineraryItemRequest,
    user: Annotated[User, Depends(require_traveler)],
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
    routing_adapter: Annotated[RoutingAdapter, Depends(get_routing_adapter)],
) -> ItineraryResponse | CompositionValidationResponse:
    from src.services.compose_itinerary import add_item_to_itinerary

    itinerary = await _get_owned_or_404(session, itinerary_id, user.traveler.id)
    outcome = await add_item_to_itinerary(
        session=session,
        settings=settings,
        routing_adapter=routing_adapter,
        itinerary=itinerary,
        experience_id=payload.experience_id,
        planned_start=payload.planned_start,
        travel_mode=payload.travel_mode,
    )
    if not outcome.valid or outcome.itinerary is None:
        return CompositionValidationResponse(
            valid=False,
            reason_code=outcome.reason_code or "COMPOSITION_TIME_CONFLICT",
            message=outcome.message or "This experience could not be added to the itinerary.",
            issues=[
                CompositionValidationIssue(
                    code=i.code.value, constraint=i.constraint, message=i.message, evidence=i.evidence
                )
                for i in outcome.issues
            ],
        )
    return await _to_itinerary_response(outcome.itinerary, session)


@router.delete("/itineraries/{itinerary_id}", status_code=204, response_class=Response)
async def cancel_itinerary(
    itinerary_id: str,
    user: Annotated[User, Depends(require_traveler)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> None:
    itinerary = await _get_owned_or_404(session, itinerary_id, user.traveler.id)
    itinerary.status = "CANCELLED"
    await session.commit()


# ─── Phase 9: manual replan + SSE live updates ──────────────────────────


def _outcome_to_response(outcome: ReplanOutcome, itinerary_id: str) -> ReplanResponse:
    return ReplanResponse(
        status=outcome.status,
        itinerary_id=itinerary_id,
        previous_version=outcome.previous_version,
        new_version=outcome.new_version,
        trigger=outcome.trigger,
        changes=ReplanChangeSetResponse(
            added_items=outcome.changes.added_items,
            removed_items=outcome.changes.removed_items,
            moved_items=outcome.changes.moved_items,
            unchanged_items=outcome.changes.unchanged_items,
            affected_items=outcome.changes.affected_items,
        ),
        context_summary=outcome.context_summary,
        validation_issues=outcome.validation_issues,
        reason_code=outcome.reason_code,
        message=outcome.message,
        generated_at=outcome.generated_at,
    )


@router.post("/itineraries/{itinerary_id}/replan", response_model=ReplanResponse)
async def replan_itinerary(
    itinerary_id: str,
    payload: ReplanRequest,
    user: Annotated[User, Depends(require_traveler)],
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
    routing_adapter: Annotated[RoutingAdapter, Depends(get_routing_adapter)],
    embedding_adapter: Annotated[EmbeddingAdapter, Depends(get_embedding_adapter)],
    ai_adapter: Annotated[AIAdapter, Depends(get_ai_adapter)],
) -> ReplanResponse:
    """Manual (traveler-initiated) replan. Calls the exact same
    ReplanningService as automatic/context-driven replanning — no
    separate logic path. For a purely USER_REQUESTED trigger with no
    context impact supplied, this builds a synthetic "affected" impact
    covering every remaining flexible item so the traveler's explicit
    request is honored even without an external context change."""
    await _get_owned_or_404(session, itinerary_id, user.traveler.id)

    from src.services.context_impact import ContextImpactResult, ImpactSeverity

    itinerary = await _get_owned_or_404(session, itinerary_id, user.traveler.id)
    local_tz = ZoneInfo("Asia/Kolkata")
    now = datetime.now(local_tz)

    def local_time(value: datetime) -> datetime:
        return value if value.tzinfo is not None else value.replace(tzinfo=local_tz)

    flexible_ids = [
        i.id for i in itinerary.items
        if local_time(i.planned_end) > now and not i.is_locked
    ]
    impact = ContextImpactResult(
        affected=bool(flexible_ids),
        severity=ImpactSeverity.MEDIUM if flexible_ids else ImpactSeverity.NONE,
        context_type="USER",
        affected_itinerary_item_ids=flexible_ids,
        reason_codes=["USER_REQUESTED"],
        explanation=payload.reason or "Traveler requested a manual replan.",
    )

    service = ReplanningService(
        session=session,
        settings=settings,
        routing_adapter=routing_adapter,
        embedding_adapter=embedding_adapter,
        ai_adapter=ai_adapter,
    )
    outcome = await service.replan_itinerary(
        itinerary_id=itinerary_id,
        traveler_id=user.traveler.id,
        trigger=payload.trigger,
        impact=impact,
        expected_version=payload.expected_version,
        idempotency_key=payload.idempotency_key,
        reason=payload.reason,
    )
    if outcome.status == "CONFLICT":
        raise ApiError(
            outcome.message or "Itinerary version conflict.",
            status_code=409 if outcome.reason_code == "ITINERARY_VERSION_CONFLICT" else 404,
        )
    return _outcome_to_response(outcome, itinerary_id)


@router.get("/itineraries/{itinerary_id}/updates")
async def itinerary_updates_stream(
    itinerary_id: str,
    user: Annotated[User, Depends(require_traveler)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> StreamingResponse:
    """SSE live-update stream. require_traveler-gated, ownership-checked:
    a wrong-owner request gets 404 (never-disclose-existence, matching
    the Phase 8 pattern) rather than 403. Only normalized application
    events are ever streamed — never raw external API responses or API
    keys (docs/AI_CONTEXT.md hard invariant)."""
    await _get_owned_or_404(session, itinerary_id, user.traveler.id)

    return StreamingResponse(
        sse_updates_stream(itinerary_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
