"""ReplanningService — dynamic itinerary replanning engine (Phase 9).

Implements the exact 13-step algorithm from the Phase 9 spec:
  1. Load current itinerary, verify ownership, lock revision (via
     Itinerary.version optimistic-locking check).
  2. Determine current time; separate items into completed/in_progress/
     past/future_locked/future_flexible.
  3. Preserve completed and explicitly-locked-future items.
  4. Evaluate context against remaining items (ContextImpactService).
  5. If no material impact -> NO_CHANGE.
  6. Remove/reject only invalid future_flexible items.
  7. Derive remaining time window/budget/constraints.
  8. Run ONE Phase 6 retrieval/feasibility pass (DiscoveryPipelineService).
  9. Run Phase 7 ranking (PersonalizedRankingService, via
     DiscoveryPipelineService.run_with_ranking — never a second ranking
     engine).
  10. Run Phase 8 composition (ExperienceComposerService) for the
      remaining segment.
  11. Merge preserved + newly composed items.
  12. Run full itinerary validation (ItineraryValidatorService); on
      invalid, REPLAN_FAILED, preserving the previous valid revision.
  13. On valid -> new revision/version, Gemini narrative (facts-only,
      template fallback), persist, return.

Never creates a second ranking engine, discovery pipeline, or Gemini
client — reuses the exact Phase 6/7/8 services via
compose_itinerary.py's helpers and DiscoveryPipelineService directly.
traveler_id is always server-derived by the caller (the API route),
never accepted from Gemini or the request body.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, time
from typing import Literal, cast
from zoneinfo import ZoneInfo

from sqlalchemy.ext.asyncio import AsyncSession

from src.adapters.ai import AIAdapter
from src.adapters.embedding import EmbeddingAdapter
from src.adapters.routing import RoutingAdapter
from src.core.config import Settings
from src.models.experience import Experience
from src.models.itinerary import Itinerary
from src.models.itinerary_item import ItineraryItem
from src.models.itinerary_revision import ItineraryRevision
from src.repositories.experience_repository import ExperienceRepository
from src.repositories.itinerary_repository import ItineraryRepository
from src.schemas.feasibility import TravelerConstraints
from src.schemas.ranking import RankedExperienceItem
from src.services.context_impact import ContextImpactResult
from src.services.discovery_pipeline import DiscoveryPipelineService
from src.services.experience_composer import ComposedItem, ExperienceComposerService
from src.services.itinerary_narrator import ItineraryNarratorService
from src.services.itinerary_validator import ItineraryValidatorService
from src.services.sse import publish_itinerary_event

_DEFAULT_TZ = "Asia/Kolkata"


ReplanStatusLiteral = Literal["NO_CHANGE", "REPLANNED", "REPLAN_FAILED", "REQUIRES_USER_ACTION", "CONFLICT"]


class ReplanStatus:
    NO_CHANGE: ReplanStatusLiteral = "NO_CHANGE"
    REPLANNED: ReplanStatusLiteral = "REPLANNED"
    REPLAN_FAILED: ReplanStatusLiteral = "REPLAN_FAILED"
    REQUIRES_USER_ACTION: ReplanStatusLiteral = "REQUIRES_USER_ACTION"
    CONFLICT: ReplanStatusLiteral = "CONFLICT"


@dataclass
class ReplanChangeSet:
    added_items: list[str] = field(default_factory=list)
    removed_items: list[str] = field(default_factory=list)
    moved_items: list[str] = field(default_factory=list)
    unchanged_items: list[str] = field(default_factory=list)
    affected_items: list[str] = field(default_factory=list)


@dataclass
class ReplanOutcome:
    status: ReplanStatusLiteral
    itinerary: Itinerary | None = None
    previous_version: int | None = None
    new_version: int | None = None
    trigger: str | None = None
    changes: ReplanChangeSet = field(default_factory=ReplanChangeSet)
    context_summary: str = ""
    validation_issues: list[str] = field(default_factory=list)
    reason_code: str | None = None
    message: str | None = None
    generated_at: datetime | None = None


class ReplanningService:
    def __init__(
        self,
        *,
        session: AsyncSession,
        settings: Settings,
        routing_adapter: RoutingAdapter,
        embedding_adapter: EmbeddingAdapter | None,
        ai_adapter: AIAdapter,
    ) -> None:
        self._session = session
        self._settings = settings
        self._routing = routing_adapter
        self._embedding = embedding_adapter
        self._ai = ai_adapter

    async def replan_itinerary(
        self,
        *,
        itinerary_id: str,
        traveler_id: str,
        trigger: str,
        impact: ContextImpactResult | None = None,
        expected_version: int | None = None,
        idempotency_key: str | None = None,
        reason: str | None = None,
        now: datetime | None = None,
    ) -> ReplanOutcome:
        # Step 1: load + verify ownership + lock revision (optimistic).
        repo = ItineraryRepository(self._session)
        itinerary = await repo.get_owned_by_id(itinerary_id, traveler_id)
        if itinerary is None:
            return ReplanOutcome(status=ReplanStatus.CONFLICT, reason_code="ITINERARY_NOT_FOUND")

        if idempotency_key:
            existing = await self._find_by_idempotency_key(itinerary_id, idempotency_key)
            if existing is not None:
                return await self._outcome_from_existing_revision(itinerary, existing)

        if expected_version is not None and expected_version != itinerary.version:
            return ReplanOutcome(
                status=ReplanStatus.CONFLICT,
                reason_code="ITINERARY_VERSION_CONFLICT",
                message=f"Expected version {expected_version}, current version is {itinerary.version}.",
                previous_version=itinerary.version,
            )

        tz = ZoneInfo(_DEFAULT_TZ)
        if now is None:
            now = datetime.now(tz)

        # ItineraryItem.planned_start/planned_end are DateTime(timezone=True)
        # columns, but SQLite drops tzinfo on write regardless of what was
        # originally stored — the composer writes them as local-Kolkata
        # wall-clock values (see ExperienceComposerService), so what
        # actually round-trips from the DB is a naive datetime that
        # represents local time (NOT UTC — unlike ExperienceAvailability's
        # documented "naive means UTC" convention; the two models
        # disagree, a known inconsistency documented in docs/DECISIONS.md).
        # Compare using local-tz-aware readings of these fields (never
        # mutate the ORM attributes themselves — that would mark them
        # dirty and risk an unnecessary UPDATE on the next commit for a
        # value that round-trips to the same bytes anyway) so every
        # comparison below, and everything this feeds into
        # ItineraryValidatorService/ExperienceComposerService (which both
        # work in aware datetimes), stays consistent.
        def _planned_start(i: ItineraryItem) -> datetime:
            return i.planned_start if i.planned_start.tzinfo is not None else i.planned_start.replace(tzinfo=tz)

        def _planned_end(i: ItineraryItem) -> datetime:
            return i.planned_end if i.planned_end.tzinfo is not None else i.planned_end.replace(tzinfo=tz)

        # Step 2/3: partition items.
        items = sorted(itinerary.items, key=lambda i: i.sequence_order)

        exp_repo = ExperienceRepository(self._session)
        experiences_by_id = {}
        for item in items:
            exp = await exp_repo.get_by_id(item.experience_id)
            if exp is not None:
                experiences_by_id[item.experience_id] = exp

        preserved: list[ItineraryItem] = []
        flexible: list[ItineraryItem] = []
        for item in items:
            if _planned_end(item) <= now:
                preserved.append(item)  # completed/past — immutable
            elif _planned_start(item) <= now < _planned_end(item):
                preserved.append(item)  # in progress — immutable
            elif item.is_locked:
                preserved.append(item)  # future, locked
            else:
                flexible.append(item)

        # Step 4/5: impact assessment.
        if impact is None or not impact.affected:
            return ReplanOutcome(
                status=ReplanStatus.NO_CHANGE,
                itinerary=itinerary,
                previous_version=itinerary.version,
                new_version=itinerary.version,
                trigger=trigger,
                context_summary=(impact.explanation if impact else "No context change supplied."),
                reason_code="NO_FUTURE_FLEXIBLE_STOP_AFFECTED",
                message=(
                    "No upcoming flexible stops were affected. Completed, in-progress, and locked "
                    "stops are preserved."
                ),
                generated_at=now,
            )

        # A locked item flagged as affected requires manual traveler
        # action — never silently replaced.
        locked_affected = [
            item for item in preserved
            if item.is_locked and item.id in impact.affected_itinerary_item_ids and _planned_start(item) > now
        ]
        if locked_affected:
            for item in locked_affected:
                item.item_state = "AFFECTED"
            itinerary.replanning_status = "REQUIRES_USER_ACTION"
            await self._session.commit()
            await publish_itinerary_event(
                itinerary_id, "requires_action",
                {"affected_items": [i.id for i in locked_affected], "reason": impact.explanation},
            )
            return ReplanOutcome(
                status=ReplanStatus.REQUIRES_USER_ACTION,
                itinerary=itinerary,
                previous_version=itinerary.version,
                new_version=itinerary.version,
                trigger=trigger,
                changes=ReplanChangeSet(affected_items=[i.id for i in locked_affected]),
                context_summary=impact.explanation,
                generated_at=now,
            )

        # Step 6: remove/reject only invalid future_flexible items.
        affected_flexible_ids = {
            item.id for item in flexible if item.id in impact.affected_itinerary_item_ids
        }
        kept_flexible = [item for item in flexible if item.id not in affected_flexible_ids]
        removed_ids = list(affected_flexible_ids)

        if not removed_ids:
            # Impact affected only preserved/locked items already handled
            # above, or nothing schedulable — nothing further to replan.
            return ReplanOutcome(
                status=ReplanStatus.NO_CHANGE,
                itinerary=itinerary,
                previous_version=itinerary.version,
                new_version=itinerary.version,
                trigger=trigger,
                context_summary=impact.explanation,
                reason_code="NO_FUTURE_FLEXIBLE_STOP_AFFECTED",
                message=(
                    "The affected item is completed, in progress, or locked. It was preserved "
                    "without changing the itinerary."
                ),
                generated_at=now,
            )

        # Step 7: derive replacement windows from the affected gaps. A
        # replacement belongs where the disrupted stop was; placing it
        # after the last unaffected stop (the old behavior) made every
        # partial replan run out of time and could never preserve a useful
        # afternoon/evening plan.
        window_end = tz_combine(itinerary.itinerary_date, itinerary.end_time, tz)
        affected_runs: list[list[ItineraryItem]] = []
        current_run: list[ItineraryItem] = []
        for item in items:
            if item.id in affected_flexible_ids:
                current_run.append(item)
            elif current_run:
                affected_runs.append(current_run)
                current_run = []
        if current_run:
            affected_runs.append(current_run)

        remaining_budget = None
        if itinerary.estimated_total_cost is not None:
            spent = sum((i.estimated_cost or 0.0) for i in preserved + kept_flexible)
            remaining_budget = max(0.0, itinerary.estimated_total_cost - spent)

        exclude_ids = {i.experience_id for i in items}
        first_affected = affected_runs[0][0]
        first_experience = experiences_by_id.get(first_affected.experience_id)
        search_center = first_experience.location if first_experience is not None else None
        first_predecessor = next(
            (item for item in reversed(items) if item.sequence_order < first_affected.sequence_order),
            None,
        )
        first_predecessor_end = (
            _planned_end(first_predecessor) if first_predecessor is not None else
            tz_combine(itinerary.itinerary_date, itinerary.start_time, tz)
        )
        discovery_start = max(now, first_predecessor_end)

        itinerary.replanning_status = "REPLANNING"
        await self._session.commit()
        await publish_itinerary_event(
            itinerary_id, "replan_started", {"trigger": trigger, "reason": impact.explanation}
        )

        # Step 8+9: ONE Phase 6+7 pass for replacement candidates.
        pipeline = DiscoveryPipelineService(self._session, self._settings, self._embedding, self._routing)
        constraints = TravelerConstraints(
            budget_max=remaining_budget,
            available_date=itinerary.itinerary_date,
            available_start=discovery_start.time(),
            available_end=itinerary.end_time,
            origin_lat=search_center.latitude if search_center is not None else None,
            origin_lng=search_center.longitude if search_center is not None else None,
            max_distance_km=10.0 if search_center is not None else None,
        )
        _, ranked_items = await pipeline.run_with_ranking(
            traveler_id=traveler_id,
            raw_query=None,
            city=search_center.city if search_center is not None else None,
            constraints=constraints,
            limit=self._settings.composer_max_candidates,
        )
        ranked_items = [c for c in ranked_items if c.id not in exclude_ids]

        # Step 10: compose independently inside each disrupted gap. Stops
        # before/after each gap remain at their existing times. The next
        # unaffected stop is a hard boundary so replacements cannot push
        # it out of order.
        composer = ExperienceComposerService(self._settings, self._routing)
        replacement_items: list[ComposedItem] = []
        selected_ids: set[str] = set()
        for run in affected_runs:
            first = run[0]
            last = run[-1]
            predecessor = next(
                (item for item in reversed(items) if item.sequence_order < first.sequence_order),
                None,
            )
            successor = next(
                (
                    item for item in items
                    if item.sequence_order > last.sequence_order
                    and item.id not in affected_flexible_ids
                    and _planned_start(item) > now
                ),
                None,
            )
            slot_start = max(
                now,
                _planned_end(predecessor) if predecessor is not None
                else tz_combine(itinerary.itinerary_date, itinerary.start_time, tz),
            )
            slot_end = min(_planned_start(successor), window_end) if successor is not None else window_end
            if slot_start >= slot_end:
                composition_items: list[ComposedItem] = []
            else:
                origin_lat = origin_lng = None
                if predecessor is not None:
                    previous_experience = experiences_by_id.get(predecessor.experience_id)
                    if previous_experience is not None:
                        origin_lat = previous_experience.location.latitude
                        origin_lng = previous_experience.location.longitude
                candidates = [candidate for candidate in ranked_items if candidate.id not in selected_ids]
                composition = await composer.compose(
                    candidates=candidates,
                    itinerary_date=slot_start.date(),
                    start_time_of_day=slot_start.time(),
                    end_time_of_day=slot_end.time(),
                    max_experiences=len(run),
                    max_budget=remaining_budget,
                    travel_mode=self._settings.composer_default_travel_mode,
                    origin_lat=origin_lat,
                    origin_lng=origin_lng,
                )
                composition_items = composition.items
            if not composition_items:
                itinerary.replanning_status = "STABLE"
                await self._session.commit()
                await publish_itinerary_event(
                    itinerary_id, "replan_failed",
                    {"reason_code": "NO_FEASIBLE_REPLACEMENT", "trigger": trigger,
                     "affected_items": removed_ids},
                )
                next_title = (
                    experiences_by_id.get(successor.experience_id).title
                    if successor is not None and experiences_by_id.get(successor.experience_id) is not None
                    else "the end of the itinerary"
                )
                return ReplanOutcome(
                    status=ReplanStatus.REPLAN_FAILED,
                    itinerary=itinerary,
                    previous_version=itinerary.version,
                    new_version=itinerary.version,
                    trigger=trigger,
                    changes=ReplanChangeSet(affected_items=removed_ids),
                    reason_code="NO_FEASIBLE_REPLACEMENT",
                    message=(
                        f"No nearby experience fits the affected time gap before {next_title}. "
                        "Your existing stops were kept. Expand the radius, change the time window, "
                        "or add a place manually."
                    ),
                    context_summary=impact.explanation,
                    generated_at=now,
                )
            replacement_items.extend(composition_items)
            selected_ids.update(item.experience.id for item in composition_items)
            if remaining_budget is not None:
                remaining_budget = max(
                    0.0,
                    remaining_budget - sum(item.estimated_cost or 0.0 for item in composition_items),
                )

        if not replacement_items:
            itinerary.replanning_status = "STABLE"
            await self._session.commit()
            await publish_itinerary_event(
                itinerary_id, "replan_failed",
                {"reason_code": "NO_FEASIBLE_REPLACEMENT", "trigger": trigger,
                 "affected_items": removed_ids},
            )
            return ReplanOutcome(
                status=ReplanStatus.REPLAN_FAILED,
                itinerary=itinerary,
                previous_version=itinerary.version,
                new_version=itinerary.version,
                trigger=trigger,
                changes=ReplanChangeSet(affected_items=removed_ids),
                reason_code="NO_FEASIBLE_REPLACEMENT",
                message="No nearby experience fits the affected time window. Your existing stops were kept.",
                context_summary=impact.explanation,
                generated_at=now,
            )

        # Step 11: merge all retained stops and replacements chronologically.
        merged_composed: list[ComposedItem] = []
        for item in preserved + kept_flexible:
            exp = experiences_by_id.get(item.experience_id)
            if exp is None:
                continue
            merged_composed.append(_item_to_composed(item, exp, 0))
        merged_composed.extend(replacement_items)
        merged_composed.sort(key=lambda item: item.planned_start)
        for sequence, composed_item in enumerate(merged_composed, start=1):
            composed_item.sequence_order = sequence

        # Step 12: full validation.
        validator = ItineraryValidatorService(self._routing)
        all_exp_by_id = {**experiences_by_id}
        for c in replacement_items:
            exp = await exp_repo.get_by_id(c.experience.id)
            if exp is not None:
                all_exp_by_id[c.experience.id] = exp

        requested_start = tz_combine(itinerary.itinerary_date, itinerary.start_time, tz)
        validation = await validator.validate(
            items=merged_composed,
            experiences_by_id=all_exp_by_id,
            requested_start=requested_start,
            requested_end=window_end,
            max_budget=itinerary.estimated_total_cost,
            max_experiences=None,
            party_size=None,
            travel_mode=self._settings.composer_default_travel_mode,
        )

        if not validation.valid:
            # Preserve the previous valid revision — never replace a
            # valid itinerary with a broken one.
            itinerary.replanning_status = "STABLE"
            await self._session.commit()
            await publish_itinerary_event(
                itinerary_id, "replan_failed",
                {"reason_code": "REPLAN_VALIDATION_FAILED", "trigger": trigger},
            )
            return ReplanOutcome(
                status=ReplanStatus.REPLAN_FAILED,
                itinerary=itinerary,
                previous_version=itinerary.version,
                new_version=itinerary.version,
                trigger=trigger,
                changes=ReplanChangeSet(affected_items=removed_ids),
                reason_code="REPLAN_VALIDATION_FAILED",
                message="The replanned itinerary failed post-composition validation.",
                validation_issues=[i.message for i in validation.issues],
                context_summary=impact.explanation,
                generated_at=now,
            )

        # Step 13: persist new revision, narrative, emit event.
        added_ids = [c.experience.id for c in replacement_items]
        unchanged_ids = [i.experience_id for i in preserved + kept_flexible]

        narrator = ItineraryNarratorService(self._ai, self._settings)
        narration = await narrator.narrate(
            items=merged_composed,
            itinerary_date_str=itinerary.itinerary_date.isoformat(),
            currency=itinerary.currency,
            total_cost=sum(c.estimated_cost or 0.0 for c in merged_composed),
        )

        # Replace itinerary_items: delete removed flexible items, keep
        # preserved/kept, add newly composed ones.
        for item in items:
            if item.id in removed_ids:
                await self._session.delete(item)
        # Flush the deletions before renumbering: SQLite checks the
        # (itinerary_id, sequence_order) UNIQUE constraint immediately per
        # statement (not deferred like PostgreSQL can), so renumbering
        # preserved/kept items straight to 1..N while their *old* values
        # still occupy those same slots in the DB (even transiently,
        # across a batch of UPDATEs whose execution order SQLAlchemy
        # doesn't guarantee matches the loop below) can collide. A
        # two-phase renumber — first to negative placeholders, which can
        # never collide with a real positive sequence_order, then to
        # final values — avoids that regardless of flush/statement order.
        await self._session.flush()
        kept_items = preserved + kept_flexible
        for i, item in enumerate(kept_items, start=1):
            item.sequence_order = -i
        await self._session.flush()
        kept_by_slot = {
            (item.experience_id, _planned_start(item)): item
            for item in kept_items
        }
        for sequence, c in enumerate(merged_composed, start=1):
            original = kept_by_slot.get((c.experience.id, c.planned_start))
            if original is not None:
                original.sequence_order = sequence
                continue
            new_item = ItineraryItem(
                itinerary_id=itinerary.id,
                experience_id=c.experience.id,
                sequence_order=sequence,
                planned_start=c.planned_start,
                planned_end=c.planned_end,
                duration_minutes=c.duration_minutes,
                travel_from_previous_minutes=c.travel_from_previous_minutes,
                travel_from_previous_distance_km=c.travel_from_previous_distance_km,
                travel_mode=c.travel_mode,
                buffer_before_minutes=c.buffer_before_minutes,
                buffer_after_minutes=c.buffer_after_minutes,
                estimated_cost=c.estimated_cost,
                source_rank_position=c.source_rank_position,
                source_ranking_score=c.source_ranking_score,
                item_state="ACTIVE",
            )
            self._session.add(new_item)

        previous_version = itinerary.version
        itinerary.version = previous_version + 1
        itinerary.replanning_status = "STABLE"
        itinerary.context_last_updated_at = now
        itinerary.narrative_title = narration.narrative.title
        itinerary.narrative_summary = narration.narrative.summary
        itinerary.narrative_closing_message = narration.narrative.closing_message
        itinerary.narrative_model_version = narration.model_version
        itinerary.estimated_total_cost = sum(c.estimated_cost or 0.0 for c in merged_composed)
        itinerary.total_duration_minutes = sum(c.duration_minutes for c in merged_composed)
        itinerary.total_travel_minutes = sum(c.travel_from_previous_minutes or 0.0 for c in merged_composed)
        itinerary.generated_at = now

        revision = ItineraryRevision(
            itinerary_id=itinerary.id,
            version=itinerary.version,
            previous_revision_id=itinerary.current_revision_id,
            trigger=trigger,
            status=ReplanStatus.REPLANNED,
            changes={
                "added_items": added_ids,
                "removed_items": removed_ids,
                "moved_items": [],
                "unchanged_items": unchanged_ids,
                "affected_items": impact.affected_itinerary_item_ids,
            },
            reason=reason,
            idempotency_key=idempotency_key,
            generated_at=now,
        )
        self._session.add(revision)
        await self._session.flush()
        itinerary.current_revision_id = revision.id

        await self._session.commit()
        await self._session.refresh(itinerary, attribute_names=["items"])

        await publish_itinerary_event(
            itinerary_id, "replan_completed",
            {
                "trigger": trigger,
                "new_version": itinerary.version,
                "added_items": added_ids,
                "removed_items": removed_ids,
            },
        )

        return ReplanOutcome(
            status=ReplanStatus.REPLANNED,
            itinerary=itinerary,
            previous_version=previous_version,
            new_version=itinerary.version,
            trigger=trigger,
            changes=ReplanChangeSet(
                added_items=added_ids,
                removed_items=removed_ids,
                unchanged_items=unchanged_ids,
                affected_items=impact.affected_itinerary_item_ids,
            ),
            context_summary=impact.explanation,
            generated_at=now,
        )

    async def _find_by_idempotency_key(self, itinerary_id: str, key: str) -> ItineraryRevision | None:
        from sqlalchemy import select

        result = await self._session.execute(
            select(ItineraryRevision).where(
                ItineraryRevision.itinerary_id == itinerary_id,
                ItineraryRevision.idempotency_key == key,
            )
        )
        return result.scalars().one_or_none()

    async def _outcome_from_existing_revision(
        self, itinerary: Itinerary, revision: ItineraryRevision
    ) -> ReplanOutcome:
        changes = revision.changes or {}

        def _str_list(key: str) -> list[str]:
            # revision.changes is persisted JSON we wrote ourselves via
            # ReplanChangeSet -> dict at creation time (see the other
            # ReplanChangeSet(...) call sites in this file) — always a
            # list of experience id strings.
            value = changes.get(key, [])
            return [str(v) for v in value] if isinstance(value, list) else []

        return ReplanOutcome(
            # revision.status is a DB-persisted value from RevisionStatus
            # (models/itinerary_revision.py), always one of the same
            # literal values ReplanOutcome.status expects.
            status=cast(ReplanStatusLiteral, revision.status),
            itinerary=itinerary,
            previous_version=revision.version - 1 if revision.version > 1 else revision.version,
            new_version=revision.version,
            trigger=revision.trigger,
            changes=ReplanChangeSet(
                added_items=_str_list("added_items"),
                removed_items=_str_list("removed_items"),
                moved_items=_str_list("moved_items"),
                unchanged_items=_str_list("unchanged_items"),
                affected_items=_str_list("affected_items"),
            ),
            context_summary="Idempotent replay of a previous replan request.",
            generated_at=revision.generated_at,
        )


def tz_combine(date_: date, time_: time, tz: ZoneInfo) -> datetime:
    return datetime.combine(date_, time_, tzinfo=tz)


def _item_to_composed(item: ItineraryItem, experience: Experience, sequence_order: int) -> ComposedItem:
    ranked_stub = RankedExperienceItem.model_validate(
        {
            "id": experience.id,
            "title": experience.title,
            "short_description": experience.short_description,
            "category": experience.category,
            "location": experience.location,
            "provider": experience.provider,
            "currency": experience.currency,
            "price": experience.price,
            "minimum_price": experience.minimum_price,
            "maximum_price": experience.maximum_price,
            "price_type": experience.price_type,
            "is_price_estimated": experience.is_price_estimated,
            "duration_minutes": experience.duration_minutes,
            "duration_is_estimated": experience.duration_is_estimated,
            "status": experience.status,
            "verification_status": experience.verification_status,
            "is_synthetic": experience.is_synthetic,
            "is_enriched": experience.is_enriched,
            "rank": sequence_order,
            "ranking_score": item.source_ranking_score or 0.0,
            "ranking_model_version": "weighted-v1",
            "semantic_relevance": 0.0,
            "personalized": False,
        },
        from_attributes=True,
    )
    # item.planned_start/planned_end are DB-read and therefore naive
    # local-wall-clock values (see the module-level note in
    # replan_itinerary); re-attach the local tz so this ComposedItem
    # compares correctly against the aware requested_start/requested_end
    # ItineraryValidatorService.validate() uses.
    local_tz = ZoneInfo(_DEFAULT_TZ)
    planned_start = (
        item.planned_start
        if item.planned_start.tzinfo is not None
        else item.planned_start.replace(tzinfo=local_tz)
    )
    planned_end = (
        item.planned_end
        if item.planned_end.tzinfo is not None
        else item.planned_end.replace(tzinfo=local_tz)
    )
    return ComposedItem(
        experience=ranked_stub,
        sequence_order=sequence_order,
        planned_start=planned_start,
        planned_end=planned_end,
        duration_minutes=item.duration_minutes,
        travel_from_previous_minutes=item.travel_from_previous_minutes,
        travel_from_previous_distance_km=item.travel_from_previous_distance_km,
        travel_mode=item.travel_mode,
        buffer_before_minutes=item.buffer_before_minutes,
        buffer_after_minutes=item.buffer_after_minutes,
        estimated_cost=item.estimated_cost,
        source_rank_position=item.source_rank_position or 0,
        source_ranking_score=item.source_ranking_score or 0.0,
    )


__all__ = ["ReplanChangeSet", "ReplanOutcome", "ReplanStatus", "ReplanningService"]
