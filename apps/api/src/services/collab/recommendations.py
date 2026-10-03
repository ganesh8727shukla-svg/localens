from __future__ import annotations

from datetime import UTC, datetime, time
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy.ext.asyncio import AsyncSession

from src.adapters.routing import RoutingAdapter
from src.core.config import Settings
from src.models.collab import CollabGroup
from src.repositories.experience_repository import ExperienceFilters, ExperienceRepository
from src.schemas.collab import CollabRecommendation, CollabRecommendationResponse
from src.schemas.experience import ExperienceSummary
from src.schemas.feasibility import TravelerConstraints
from src.services.collab.groups import group_response
from src.services.collab_preferences import score_group_experience
from src.services.feasibility import FeasibilityService

_GROUP_TZ = ZoneInfo("Asia/Kolkata")


def member_constraints(group: CollabGroup, members: list[Any]) -> TravelerConstraints:
    hard = [member.hard_constraints for member in members]
    budgets = [item["budget_max"] for item in hard if item.get("budget_max") is not None]
    distances = [item["max_distance_km"] for item in hard if item.get("max_distance_km") is not None]
    accessibility = sorted(
        {
            requirement
            for item in hard
            for requirement in item.get("accessibility_requirements", [])
        }
    )
    return TravelerConstraints(
        budget_max=min(budgets) if budgets else None,
        max_distance_km=min(distances) if distances else None,
        origin_lat=group.origin_latitude,
        origin_lng=group.origin_longitude,
        available_date=group.itinerary_date,
        # Discovery checks whether a candidate is available on that date.
        # The composer later chooses a stop time and the itinerary validator
        # checks the exact slot before any trip is persisted.
        available_start=None,
        available_end=None,
        party_size=len(members),
        accessibility_requirements=accessibility,
        travel_mode=group.travel_mode,
    )


def real_schedule_evidence(
    group: CollabGroup,
    experience: Any,
    party_size: int,
    *,
    visit_start: datetime | None = None,
    visit_end: datetime | None = None,
) -> bool:
    """When a group has a date, accept only explicitly real hours and
    concrete real availability. Synthetic seed rows are not evidence for
    a hard scheduling or capacity decision."""
    if group.itinerary_date is None:
        return True

    precise_visit = visit_start is not None and visit_end is not None
    check_start = visit_start or (
        datetime.combine(group.itinerary_date, group.start_time, _GROUP_TZ)
        if group.start_time is not None else None
    )
    check_end = visit_end or (
        datetime.combine(group.itinerary_date, group.end_time, _GROUP_TZ)
        if group.end_time is not None else None
    )
    weekday = group.itinerary_date.weekday()
    windows = [
        row
        for row in experience.opening_hours
        if row.day_of_week == weekday and not row.is_synthetic
    ]
    if not windows:
        return False
    if check_start is not None and check_end is not None:
        if check_start.tzinfo is not None:
            check_start = check_start.astimezone(_GROUP_TZ)
        if check_end.tzinfo is not None:
            check_end = check_end.astimezone(_GROUP_TZ)
        start_time = check_start.strftime("%H:%M")
        end_time = check_end.strftime("%H:%M")
        matches_hours = any(
            not row.is_closed
            and row.open_time is not None
            and row.close_time is not None
            and (row.open_time <= start_time if precise_visit else row.open_time < end_time)
            and (row.close_time >= end_time if precise_visit else row.close_time > start_time)
            for row in windows
        )
        if not matches_hours:
            return False
    elif not any(not row.is_closed and row.open_time is not None and row.close_time is not None for row in windows):
        return False

    slots = [
        row for row in experience.availability_slots
        if row.status == "active" and not row.is_synthetic and row.available_slots is not None
        and row.available_slots >= party_size
    ]
    if check_start is None or check_end is None:
        try:
            local_tz = ZoneInfo(experience.location.timezone or str(_GROUP_TZ))
        except (ZoneInfoNotFoundError, AttributeError):
            local_tz = _GROUP_TZ
        for window in windows:
            if window.is_closed or window.open_time is None or window.close_time is None:
                continue
            try:
                opening = datetime.combine(
                    group.itinerary_date, time.fromisoformat(window.open_time), local_tz
                ).astimezone(UTC)
                closing = datetime.combine(
                    group.itinerary_date, time.fromisoformat(window.close_time), local_tz
                ).astimezone(UTC)
            except ValueError:
                continue
            if closing <= opening:
                continue
            if any(
                _as_utc(slot.starts_at) < closing and _as_utc(slot.ends_at) > opening
                for slot in slots
            ):
                return True
        return False
    else:
        if check_start.tzinfo is None:
            check_start = check_start.replace(tzinfo=_GROUP_TZ)
        if check_end.tzinfo is None:
            check_end = check_end.replace(tzinfo=_GROUP_TZ)
        requested_start = check_start.astimezone(UTC)
        requested_end = check_end.astimezone(UTC)
    if precise_visit:
        return any(
            _as_utc(row.starts_at) <= requested_start and _as_utc(row.ends_at) >= requested_end
            for row in slots
        )
    return any(
        _as_utc(row.starts_at) < requested_end and _as_utc(row.ends_at) > requested_start
        for row in slots
    )


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


async def recommend_for_group(
    *,
    session: AsyncSession,
    settings: Settings,
    routing: RoutingAdapter,
    group: CollabGroup,
    requester_user_id: str,
    query: str | None = None,
    category_slug: str | None = None,
    limit: int = 24,
) -> CollabRecommendationResponse:
    snapshot = await group_response(
        session,
        group,
        next(member for member in (await _active_members(session, group.id)) if member.user_id == requester_user_id),
    )
    members = snapshot.members
    profiles = [
        {
            "id": member.id,
            "email": member.email,
            "soft_preferences": member.soft_preferences,
            "hard_constraints": member.hard_constraints,
        }
        for member in members
    ]
    constraints = member_constraints(group, members)
    warnings: list[str] = []
    if any(member.hard_constraints.get("age") is not None for member in members):
        warnings.append(
            "Recommendations are withheld while member ages are set because the catalog has no verified age-limit data."
        )

    objective_terms = [
        str(term).strip()
        for key in ("interests", "must_include", "activities")
        for term in (group.objectives or {}).get(key, [])
        if str(term).strip()
    ]
    preference_terms = [
        str(term).strip()
        for profile in profiles
        for key in ("interests", "food_preferences", "activities")
        for term in profile["soft_preferences"].get(key, [])
        if str(term).strip()
    ]
    effective_query = query or " ".join(dict.fromkeys(objective_terms + preference_terms)) or None
    repo = ExperienceRepository(session)
    candidates = await repo.search(
        ExperienceFilters(
            q=effective_query,
            category_slug=category_slug,
            city=group.destination,
            status="active",
            is_synthetic=False,
        ),
        cap=settings.discovery_candidate_cap,
    )

    # Requiring all three provenance flags avoids presenting imported rows
    # paired with synthetic provider/location records as real venues.
    candidates = [
        experience
        for experience in candidates
        if not experience.is_synthetic
        and not experience.provider.is_synthetic
        and not experience.location.is_synthetic
    ]
    if any(member.hard_constraints.get("age") is not None for member in members):
        return CollabRecommendationResponse(
            items=[], candidate_count=len(candidates), excluded_count=len(candidates), warnings=warnings
        )

    # Keep budget, distance, currency and accessibility as hard checks.
    # The current open-places catalog often has no provider-sourced hours
    # or availability slots. Those unknowns should be surfaced as
    # confirmation work, not silently turn the whole recommendations
    # section empty. They are deliberately removed only from this shortlist
    # pass; a recommendation is not a booking or a confirmed schedule.
    shortlist_constraints = constraints.model_copy(
        update={
            "available_date": None,
            "available_start": None,
            "available_end": None,
            "party_size": None,
        }
    )
    feasibility = FeasibilityService(routing)
    ranked: list[tuple[float, CollabRecommendation]] = []
    for experience in candidates:
        verdict = await feasibility.evaluate(experience, shortlist_constraints, travel_profile=group.travel_mode)
        if verdict.status == "INFEASIBLE":
            continue
        score = score_group_experience(experience, profiles, group.objectives or {})
        schedule_verified = real_schedule_evidence(group, experience, len(members))
        ranked.append(
            (
                score["compatibility_score"],
                CollabRecommendation(
                    experience=ExperienceSummary.model_validate(experience),
                    hard_constraint_status=verdict.status,
                    schedule_status="VERIFIED" if schedule_verified else "NEEDS_CONFIRMATION",
                    **score,
                ),
            )
        )

    ranked.sort(key=lambda row: row[0], reverse=True)
    warnings.append(
        "These are shortlist suggestions. Confirm venue hours, current prices, and group availability "
        "before finalizing; missing catalog data is shown as unverified."
    )
    return CollabRecommendationResponse(
        items=[item for _, item in ranked[:limit]],
        candidate_count=len(candidates),
        excluded_count=len(candidates) - len(ranked),
        warnings=warnings,
    )


async def _active_members(session: AsyncSession, group_id: str) -> list[Any]:
    from sqlalchemy import select

    from src.models.collab import CollabMember

    result = await session.scalars(
        select(CollabMember).where(CollabMember.group_id == group_id, CollabMember.status == "ACTIVE")
    )
    return list(result.all())


__all__ = ["member_constraints", "real_schedule_evidence", "recommend_for_group"]
