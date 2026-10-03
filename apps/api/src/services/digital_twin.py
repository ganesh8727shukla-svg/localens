"""Read-only what-if scenario evaluation over an owned itinerary snapshot."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Literal, cast
from uuid import uuid4
from zoneinfo import ZoneInfo

from sqlalchemy.ext.asyncio import AsyncSession

from src.adapters.errors import AdapterError
from src.adapters.domain_intelligence import DomainIntelligenceProvider
from src.adapters.embedding import EmbeddingAdapter
from src.adapters.routing import RoutingAdapter
from src.adapters.weather import WeatherAdapter, WeatherContext, WeatherSource
from src.core.config import Settings
from src.core.digital_twin import SIMULATION_TTL, StoredSimulation, simulation_session_store
from src.models.experience import Experience
from src.models.itinerary import Itinerary
from src.models.itinerary_custom_activity import ItineraryCustomActivity
from src.models.itinerary_item import ItineraryItem
from src.repositories.experience_repository import ExperienceRepository
from src.repositories.itinerary_repository import ItineraryRepository
from src.schemas.conversation import TravelerContext
from src.schemas.digital_twin import (
    DigitalTwinSnapshot,
    RouteSource,
    ScenarioImpactLevel,
    ScenarioWeatherIntensity,
    SimulationAlternative,
    SimulationChangeLevel,
    SimulationDelta,
    SimulationImpact,
    SimulationResult,
    SimulationStatus,
    TwinPlanState,
    TwinRouteEvidence,
    TwinRouteOption,
    TwinSocialCluster,
    TwinSocialEvidence,
    TwinStop,
    TwinWeatherEvidence,
    WeatherEvidenceStatus,
    WeatherScenarioOverride,
    WeatherSuitability,
    WhatIfScenario,
)
from src.schemas.domain_intelligence import (
    DomainIntelligenceImpact,
    DomainIntelligenceInput,
    DomainIntelligenceRoute,
    DomainIntelligenceResult,
    DomainIntelligenceStop,
    DomainIntelligenceWeather,
)
from src.schemas.feasibility import CommittedTimeBlock, TravelerConstraints
from src.services.context_impact import ContextImpactResult, ImpactSeverity
from src.services.discovery_pipeline import DiscoveryPipelineService
from src.services.social_signals import SocialSignalService
from src.services.weather_impact import WeatherImpactService, WeatherImpactStatus

_LOCAL_ZONE = ZoneInfo("Asia/Kolkata")
_MAX_WEATHER_LOOKUPS = 6
_MAX_ROUTE_LEGS = 8


@dataclass(frozen=True)
class _StopRef:
    item_id: str
    experience_id: str | None
    sequence: int
    title: str
    planned_start: datetime
    planned_end: datetime
    state: str
    locked: bool
    latitude: float | None
    longitude: float | None
    locality: str | None
    city: str | None
    experience: Experience | None
    raw_item: ItineraryItem | ItineraryCustomActivity


class DigitalTwinService:
    """Builds bounded simulations; only explicit apply reaches replanning."""

    def __init__(
        self,
        *,
        session: AsyncSession,
        settings: Settings,
        weather: WeatherAdapter,
        routing: RoutingAdapter,
        embedding: EmbeddingAdapter | None = None,
        social: SocialSignalService,
        intelligence: DomainIntelligenceProvider,
    ) -> None:
        self._session = session
        self._settings = settings
        self._weather = weather
        self._routing = routing
        self._embedding = embedding
        self._social = social
        self._intelligence = intelligence
        self._weather_impact = WeatherImpactService(settings)

    async def simulate(self, *, itinerary_id: str, traveler_id: str, scenario: WhatIfScenario) -> SimulationResult:
        itinerary = await ItineraryRepository(self._session).get_owned_by_id(itinerary_id, traveler_id)
        if itinerary is None:
            raise LookupError("Itinerary not found")

        refs, experiences = await self._load_stops(itinerary)
        created_at = datetime.now(UTC)
        snapshot_id = str(uuid4())
        baseline_weather = await self._load_weather(refs, scenario.horizon_hours, created_at)
        current_weather = await self._load_current_weather(refs)
        baseline_routes = await self._load_routes(refs)
        baseline_social = TwinSocialEvidence(status="NOT_REQUESTED", clusters=[])
        warnings: list[str] = []
        if any(ref.latitude is None or ref.longitude is None for ref in refs):
            warnings.append("Some itinerary stops have no verified coordinates and are omitted from map context.")

        baseline_plan = TwinPlanState(
            stops=[self._to_stop(ref) for ref in refs],
            weather=baseline_weather,
            current_weather=current_weather,
            social=baseline_social,
            routes=baseline_routes,
        )
        baseline = DigitalTwinSnapshot(
            snapshot_id=snapshot_id,
            generated_at=created_at,
            timezone="Asia/Kolkata",
            itinerary_id=itinerary.id,
            itinerary_version=itinerary.version,
            itinerary_date=itinerary.itinerary_date,
            itinerary_status=itinerary.status,
            traveler_context_available=True,
            plan=baseline_plan,
        )

        scenario_weather, impacts, affected_ids, weather_statuses = self._evaluate_weather(
            refs, experiences, baseline_weather, scenario, created_at
        )
        for override in scenario.experience_overrides:
            ref = next((entry for entry in refs if entry.item_id == override.item_id), None)
            if ref is None:
                raise ValueError("Experience scenario references an item outside this itinerary")
            impacts.append(
                SimulationImpact(
                    category="experience",
                    level="HIGH" if override.condition == "unavailable" else "MEDIUM",
                    affected=True,
                    item_id=ref.item_id,
                    reason_codes=[f"USER_ASSUMED_{override.condition.upper()}"],
                    explanation=f"Traveler assumption: {ref.title} is {override.condition.replace('_', ' ')}.",
                    confidence="HIGH",
                    evidence=["Explicit scenario input; not a provider-confirmed status."],
                    recommended_action="Review this stop and its alternatives.",
                )
            )
            if self._is_future(ref, created_at):
                affected_ids.append(ref.item_id)
            else:
                warnings.append(
                    f"{ref.title} has already completed or is in progress. The deterministic replanner protects past and active stops."
                )

        scenario_social = baseline_social
        if scenario.include_recent_social_context:
            ref = next((entry for entry in refs if entry.item_id == scenario.social_context_item_id), None)
            if ref is None:
                raise ValueError("Social context location must be an item in this itinerary")
            if ref.latitude is None or ref.longitude is None:
                scenario_social = TwinSocialEvidence(
                    status="UNAVAILABLE", message="This stop has no verified coordinates for an area query."
                )
            else:
                try:
                    social_result = await self._social.get_social_signals(
                        ref.latitude,
                        ref.longitude,
                        10.0,
                        None,
                        min(scenario.horizon_hours, 24),
                        fallback_locality=ref.locality,
                        fallback_city=ref.city,
                    )
                    scenario_social = TwinSocialEvidence(
                        status=social_result.status,
                        queried_location=social_result.queried_location,
                        location_source=social_result.location_source,
                        generated_at=social_result.generated_at,
                        clusters=[
                            TwinSocialCluster(
                                topic=str(cluster.topic),
                                severity=str(cluster.severity),
                                signal_count=cluster.signal_count,
                                independent_source_count=cluster.independent_source_count,
                                newest_signal_at=cluster.newest_signal_at,
                                source_platforms=list(cluster.source_platforms),
                                confidence=cluster.confidence,
                                confidence_note=cluster.confidence_note,
                                status="REAL_AGGREGATE",
                                location_name=cluster.location_name,
                            )
                            for cluster in social_result.clusters
                        ],
                        message=social_result.message,
                    )
                except Exception:
                    scenario_social = TwinSocialEvidence(
                        status="UNAVAILABLE", message="Area-level social context could not be loaded."
                    )
            # Real social aggregates are evidence for the traveler, not a feasibility decision.
            impacts.append(
                SimulationImpact(
                    category="social",
                    level="UNKNOWN",
                    affected=False,
                    item_id=ref.item_id,
                    reason_codes=["SOCIAL_CONTEXT_ADVISORY"],
                    explanation="Recent area-level public signals are advisory and are not verified reports.",
                    confidence="LOW",
                    evidence=[scenario_social.status],
                )
            )

        if scenario.hypothetical_social is not None:
            ref = next((entry for entry in refs if entry.item_id == scenario.hypothetical_social.around_item_id), None)
            if ref is None:
                raise ValueError("Hypothetical social context must reference an item in this itinerary")
            hypothetical = TwinSocialCluster(
                topic=scenario.hypothetical_social.topic,
                severity=scenario.hypothetical_social.severity,
                status="HYPOTHETICAL",
                confidence_note="Traveler-supplied assumption; no reports or sources were observed.",
            )
            if scenario_social.status == "NOT_REQUESTED":
                scenario_social = TwinSocialEvidence(status="HYPOTHETICAL", message="Hypothetical only.")
            scenario_social = scenario_social.model_copy(update={"clusters": [*scenario_social.clusters, hypothetical]})
            impacts.append(
                SimulationImpact(
                    category="social",
                    level="UNKNOWN",
                    affected=False,
                    item_id=ref.item_id,
                    reason_codes=["HYPOTHETICAL_SOCIAL_CONTEXT"],
                    explanation="This social condition is a scenario assumption, not an observed signal.",
                    confidence="LOW",
                    evidence=["HYPOTHETICAL"],
                )
            )

        scenario_routes = self._apply_route_scenario(baseline_routes, refs, scenario)
        scenario_routes, route_options_unavailable = await self._attach_route_alternatives(
            scenario_routes, baseline_routes, refs, scenario
        )
        if route_options_unavailable:
            warnings.append("OSRM did not return an additional route option for this assumed disruption.")
        affected_route_count = sum(
            route.scenario_status not in ("UNCHANGED", "UNAVAILABLE") for route in scenario_routes
        )
        if scenario.route is not None:
            impacts.append(
                SimulationImpact(
                    category="route",
                    level="MEDIUM" if scenario.route.kind == "congestion" else "HIGH",
                    affected=True,
                    item_id=scenario.route.to_item_id,
                    reason_codes=[f"USER_ASSUMED_{scenario.route.kind.upper()}"],
                    explanation=(
                        "Route condition is a traveler assumption. Any OSRM options are real route geometries, "
                        "but OSRM did not receive or verify the assumed disruption."
                        if scenario.route.kind in ("road_disruption", "temporary_closure", "walking_condition")
                        else "An assumed delay was added to the existing route estimate."
                    ),
                    confidence="LOW",
                    evidence=["No closure-aware route geometry is available."],
                    recommended_action="Check local conditions before traveling.",
                )
            )

        unique_affected = list(dict.fromkeys(affected_ids))
        alternatives, alternatives_partial = await self._find_alternatives(
            itinerary=itinerary,
            traveler_id=traveler_id,
            refs=refs,
            impacted_item_ids=unique_affected,
            now=created_at,
        )

        scenario_plan = TwinPlanState(
            stops=[self._to_stop(ref) for ref in refs],
            weather=scenario_weather,
            current_weather=current_weather,
            social=scenario_social,
            routes=scenario_routes,
        )
        additional_minutes = sum(route.delta_minutes or 0 for route in scenario_routes)
        unchanged_stop_count = max(0, len(refs) - len(unique_affected))
        max_level = max((self._level_weight(impact.level) for impact in impacts if impact.affected), default=0)
        change_level: SimulationChangeLevel = (
            "NO_CHANGE"
            if max_level == 0
            else "MINOR"
            if max_level <= 1
            else "MODERATE"
            if max_level == 2
            else "MAJOR"
            if max_level == 3
            else "CRITICAL"
        )
        delta = SimulationDelta(
            affected_stop_count=len(unique_affected),
            unchanged_stop_count=unchanged_stop_count,
            affected_route_count=affected_route_count,
            additional_travel_minutes=additional_minutes
            if scenario.route and scenario.route.assumed_delay_minutes is not None
            else None,
            change_level=change_level,
            summary=(
                f"{len(unique_affected)} stop(s) have deterministic weather or explicit experience assumptions; "
                f"{affected_route_count} route segment(s) have an assumed change."
                if unique_affected or affected_route_count
                else "No material change was identified from available evidence."
            ),
        )
        facts = DomainIntelligenceInput(
            scenario_name=scenario.name,
            scenario_description=scenario.description,
            impact_categories=[impact.category for impact in impacts if impact.affected],
            affected_item_ids=unique_affected,
            weather_statuses=weather_statuses + [entry.status for entry in current_weather],
            route_statuses=[route.scenario_status for route in scenario_routes],
            stops=[
                DomainIntelligenceStop(
                    item_id=stop.item_id,
                    title=stop.title,
                    start=stop.planned_start.isoformat(),
                    end=stop.planned_end.isoformat(),
                    state=stop.state,
                    locked=stop.locked,
                    provider_verification_status=stop.provider_verification_status,
                )
                for stop in scenario_plan.stops[:20]
            ],
            weather=[
                DomainIntelligenceWeather(
                    item_id=weather.item_id,
                    status=weather.status,
                    context_kind=weather.context_kind,
                    condition=weather.condition,
                    temperature_c=weather.temperature_c,
                    precipitation_probability=weather.precipitation_probability,
                    precipitation_amount=weather.precipitation_amount,
                    wind_speed=weather.wind_speed,
                    severe_alert=weather.severe_alert,
                )
                for weather in [*scenario_plan.current_weather, *scenario_plan.weather][:20]
            ],
            routes=[
                DomainIntelligenceRoute(
                    from_item_id=route.from_item_id,
                    to_item_id=route.to_item_id,
                    source=route.source,
                    duration_minutes=route.scenario_duration_minutes or route.duration_minutes,
                    scenario_status=route.scenario_status,
                    delta_minutes=route.delta_minutes,
                    explanation=route.explanation,
                )
                for route in scenario_routes[:12]
            ],
            deterministic_impacts=[
                DomainIntelligenceImpact(
                    category=impact.category,
                    level=impact.level,
                    affected=impact.affected,
                    item_id=impact.item_id,
                    reason_codes=impact.reason_codes[:10],
                    explanation=impact.explanation[:300],
                )
                for impact in impacts[:30]
            ],
            social_status=scenario_social.status,
            social_topics=[cluster.topic for cluster in scenario_social.clusters[:20]],
            itinerary_date=itinerary.itinerary_date.isoformat(),
            timezone="Asia/Kolkata",
            deterministic_summary=delta.summary,
        )
        try:
            intelligence_result = await self._intelligence.summarize(facts)
        except AdapterError as exc:
            # Domain interpretation is optional. Preserve the deterministic
            # simulation when Nugen is unavailable, and report that accurately.
            provider_messages = {
                "Nugen request timed out.",
                "Nugen is unavailable.",
                "Nugen is rate limited.",
                "Nugen authentication failed.",
                "Nugen returned HTTP 404 for the configured endpoint.",
                "Nugen rejected the request format.",
                "Nugen request failed.",
                "Nugen returned a malformed response.",
                "Nugen returned a malformed domain analysis.",
            }
            safe_reason = str(exc) if str(exc) in provider_messages else "Nugen service is unavailable."
            intelligence_result = DomainIntelligenceResult(
                provider="nugen",
                status="UNAVAILABLE",
                summary=f"{safe_reason} The deterministic preview remains available.",
                notes=["No Nugen assessment was returned or fabricated."],
            )
        warnings.extend(
            [
                "Preview only: no itinerary data was changed.",
                *intelligence_result.notes,
            ]
        )
        if len(refs) > _MAX_ROUTE_LEGS + 1:
            warnings.append(f"Route geometry preview is capped at {_MAX_ROUTE_LEGS} consecutive legs.")
        if len(refs) > _MAX_WEATHER_LOOKUPS:
            warnings.append(f"Weather preview is bounded to {_MAX_WEATHER_LOOKUPS} distinct stop locations.")
        if alternatives_partial:
            warnings.append(
                "Alternative discovery is partial; review the original itinerary and use discovery for more options."
            )
        if any(weather.status == "UNAVAILABLE" for weather in scenario_weather):
            warnings.append("Weather evidence is unavailable for one or more stops; unknown conditions remain unknown.")
        status: SimulationStatus = (
            "PARTIAL"
            if warnings
            and any(
                warning.startswith(
                    ("Weather evidence", "Route geometry preview", "Weather preview", "Alternative discovery", "OSRM did not return")
                )
                for warning in warnings
            )
            else "READY"
        )
        result = SimulationResult(
            simulation_id=str(uuid4()),
            status=status,
            created_at=created_at,
            expires_at=created_at + SIMULATION_TTL,
            scenario_name=scenario.name,
            baseline=baseline,
            scenario=scenario_plan,
            delta=delta,
            impacts=impacts,
            alternatives=alternatives,
            warnings=warnings,
            domain_intelligence=intelligence_result,
        )
        context_impact = ContextImpactResult(
            affected=bool(unique_affected),
            severity=self._max_severity(impacts),
            context_type="USER",
            affected_itinerary_item_ids=unique_affected,
            reason_codes=list(
                dict.fromkeys(reason for impact in impacts if impact.affected for reason in impact.reason_codes)
            ),
            explanation=delta.summary,
            previous_context_reference=snapshot_id,
            new_context_reference=result.simulation_id,
        )
        simulation_session_store.put(
            StoredSimulation(
                owner_id=traveler_id,
                itinerary_id=itinerary.id,
                itinerary_version=itinerary.version,
                scenario=scenario,
                result=result,
                impact=context_impact,
            )
        )
        return result

    async def get_owned_simulation(self, *, simulation_id: str, traveler_id: str) -> StoredSimulation | None:
        stored = simulation_session_store.get(simulation_id)
        if stored is None or stored.owner_id != traveler_id:
            return None
        itinerary = await ItineraryRepository(self._session).get_owned_by_id(stored.itinerary_id, traveler_id)
        if itinerary is None or itinerary.version != stored.itinerary_version:
            return None
        return stored

    async def _load_stops(self, itinerary: Itinerary) -> tuple[list[_StopRef], dict[str, Experience]]:
        repo = ExperienceRepository(self._session)
        refs: list[_StopRef] = []
        experiences: dict[str, Experience] = {}
        items = sorted(itinerary.items, key=lambda item: (item.sequence_order, item.planned_start))
        for item in items:
            experience = await repo.get_by_id(item.experience_id)
            if experience is not None:
                experiences[item.experience_id] = experience
            location = experience.location if experience is not None else None
            refs.append(
                _StopRef(
                    item_id=item.id,
                    experience_id=item.experience_id,
                    sequence=item.sequence_order,
                    title=experience.title if experience else "Unavailable experience",
                    planned_start=item.planned_start,
                    planned_end=item.planned_end,
                    state=item.item_state,
                    locked=item.is_locked,
                    latitude=location.latitude if location else None,
                    longitude=location.longitude if location else None,
                    locality=location.locality if location else None,
                    city=location.city if location else None,
                    experience=experience,
                    raw_item=item,
                )
            )
        for activity in itinerary.custom_activities:
            refs.append(
                _StopRef(
                    item_id=activity.id,
                    experience_id=None,
                    sequence=activity.sequence_order,
                    title=activity.title,
                    planned_start=activity.planned_start,
                    planned_end=activity.planned_end,
                    state="ACTIVE",
                    locked=False,
                    latitude=activity.latitude,
                    longitude=activity.longitude,
                    locality=None,
                    city=None,
                    experience=None,
                    raw_item=activity,
                )
            )
        refs.sort(key=lambda ref: (ref.sequence, ref.planned_start))
        return refs, experiences

    async def _find_alternatives(
        self,
        *,
        itinerary: Itinerary,
        traveler_id: str,
        refs: list[_StopRef],
        impacted_item_ids: list[str],
        now: datetime,
    ) -> tuple[list[SimulationAlternative], bool]:
        """Use existing feasibility and personalized ranking for at most two flexible slots."""
        if not impacted_item_ids:
            return [], False
        pipeline = DiscoveryPipelineService(self._session, self._settings, self._embedding, self._routing)
        existing_ids = {ref.experience_id for ref in refs if ref.experience_id}
        alternatives: list[SimulationAlternative] = []
        partial = len(impacted_item_ids) > 2
        candidate_weather_cache: dict[tuple[float, float], WeatherContext | None] = {}
        candidate_weather_lookups = 0
        for item_id in impacted_item_ids[:2]:
            ref = next((entry for entry in refs if entry.item_id == item_id), None)
            experience = ref.experience if ref else None
            if ref is None or experience is None or not self._is_future(ref, now) or ref.locked:
                continue
            start = self._aware(ref.planned_start).astimezone(_LOCAL_ZONE)
            end = self._aware(ref.planned_end).astimezone(_LOCAL_ZONE)
            commitments = [
                CommittedTimeBlock(start=self._aware(other.planned_start), end=self._aware(other.planned_end))
                for other in refs
                if other.item_id != ref.item_id
                and self._aware(other.planned_end) > now
                and self._aware(other.planned_start) < self._aware(ref.planned_end)
            ]
            previous = next((entry for entry in reversed(refs) if entry.sequence < ref.sequence), None)
            travel_mode = ref.raw_item.travel_mode if isinstance(ref.raw_item, ItineraryItem) else None
            typed_travel_mode = cast(Literal["driving", "walking", "cycling"] | None, travel_mode)
            same_day_slot = end.date() == start.date() and end.time() > start.time()
            available_start = start.time().replace(tzinfo=None) if same_day_slot else None
            available_end = end.time().replace(tzinfo=None) if same_day_slot else None
            duration = max(1, int((end - start).total_seconds() / 60))
            constraints = TravelerConstraints(
                currency=itinerary.currency,
                budget_max=ref.raw_item.estimated_cost,
                available_date=start.date(),
                available_start=available_start,
                available_end=available_end,
                available_duration_minutes=duration,
                timezone="Asia/Kolkata",
                origin_lat=previous.latitude if previous else None,
                origin_lng=previous.longitude if previous else None,
                travel_mode=typed_travel_mode,
                existing_commitments=commitments,
            )
            traveler_context = TravelerContext(
                raw_query=experience.title,
                category_slugs=[experience.category.slug] if experience.category else [],
                location_text=experience.location.city if experience.location else None,
                currency=itinerary.currency,
                available_date=start.date(),
                available_start=available_start,
                available_end=available_end,
                available_duration_minutes=duration,
                timezone="Asia/Kolkata",
                origin_lat=previous.latitude if previous else None,
                origin_lng=previous.longitude if previous else None,
                travel_mode=typed_travel_mode,
            )
            try:
                _, ranked = await pipeline.run_with_ranking(
                    traveler_id,
                    raw_query=experience.title,
                    category_slug=experience.category.slug if experience.category else None,
                    city=experience.location.city if experience.location else None,
                    locality=experience.location.locality if experience.location else None,
                    constraints=constraints,
                    limit=8,
                    travel_profile=typed_travel_mode or "driving",
                    context=traveler_context,
                )
            except Exception:
                partial = True
                continue
            added_for_slot = 0
            for candidate in ranked:
                if candidate.id in existing_ids:
                    continue
                candidate_experience = await ExperienceRepository(self._session).get_by_id(candidate.id)
                if candidate_experience is None:
                    continue
                candidate_location = candidate_experience.location
                weather_key = (round(candidate_location.latitude, 3), round(candidate_location.longitude, 3))
                if weather_key not in candidate_weather_cache:
                    if candidate_weather_lookups >= _MAX_WEATHER_LOOKUPS:
                        candidate_weather_cache[weather_key] = None
                        partial = True
                    else:
                        candidate_weather_lookups += 1
                        try:
                            forecasts = await self._weather.get_forecast(
                                candidate_location.latitude, candidate_location.longitude
                            )
                            candidate_weather_cache[weather_key] = self._nearest_forecast(forecasts, ref.planned_start)
                        except Exception:
                            candidate_weather_cache[weather_key] = None
                            partial = True
                candidate_weather = candidate_weather_cache[weather_key]
                if candidate_weather is not None and candidate_weather.source != WeatherSource.UNAVAILABLE:
                    suitability: WeatherSuitability = self._weather_impact.evaluate(
                        candidate_experience, candidate_weather
                    ).status.value
                    weather_status: WeatherEvidenceStatus = cast(WeatherEvidenceStatus, candidate_weather.source.value)
                    if candidate_weather.expires_at <= datetime.now(UTC):
                        weather_status = "STALE"
                else:
                    suitability = "WEATHER_UNKNOWN"
                    weather_status = "UNAVAILABLE"
                alternatives.append(
                    SimulationAlternative(
                        for_item_id=item_id,
                        experience_id=candidate.id,
                        title=candidate.title,
                        category=candidate.category.name,
                        environmental_type=candidate_experience.environmental_type or "UNKNOWN",
                        weather_suitability=suitability,
                        weather_status=weather_status,
                        weather_condition=candidate_weather.condition if candidate_weather else None,
                        weather_temperature_c=candidate_weather.temperature_c if candidate_weather else None,
                        weather_precipitation_probability=(
                            candidate_weather.precipitation_probability if candidate_weather else None
                        ),
                        weather_precipitation_amount=(
                            candidate_weather.precipitation_amount if candidate_weather else None
                        ),
                        weather_wind_speed=candidate_weather.wind_speed if candidate_weather else None,
                        weather_at=candidate_weather.observed_at if candidate_weather else None,
                        ranking_score=candidate.ranking_score,
                        is_synthetic=candidate.is_synthetic,
                    )
                )
                added_for_slot += 1
                if added_for_slot >= 3:
                    break
        return alternatives, partial

    async def _load_weather(self, refs: list[_StopRef], horizon_hours: int, now: datetime) -> list[TwinWeatherEvidence]:
        distinct: dict[tuple[float, float], list[_StopRef]] = {}
        for ref in refs:
            if ref.latitude is None or ref.longitude is None or not self._within_horizon(ref, horizon_hours, now):
                continue
            key = (round(ref.latitude, 3), round(ref.longitude, 3))
            distinct.setdefault(key, []).append(ref)
        result: list[TwinWeatherEvidence] = []
        looked_up = 0
        for (lat, lng), grouped_refs in distinct.items():
            contexts: list[WeatherContext] = []
            if looked_up < _MAX_WEATHER_LOOKUPS:
                looked_up += 1
                try:
                    contexts = await self._weather.get_forecast(lat, lng)
                except Exception:
                    contexts = []
            for ref in grouped_refs:
                context = self._nearest_forecast(contexts, ref.planned_start)
                result.append(self._weather_evidence(ref.item_id, context))
        for ref in refs:
            if not any(entry.item_id == ref.item_id for entry in result):
                result.append(TwinWeatherEvidence(item_id=ref.item_id, status="UNAVAILABLE"))
        result.sort(key=lambda entry: next((r.sequence for r in refs if r.item_id == entry.item_id), 10**9))
        return result

    async def _load_current_weather(self, refs: list[_StopRef]) -> list[TwinWeatherEvidence]:
        """Fetch bounded current observations separately from itinerary forecasts."""
        distinct: dict[tuple[float, float], tuple[float, float, list[_StopRef]]] = {}
        for ref in refs:
            if ref.latitude is None or ref.longitude is None:
                continue
            key = (ref.latitude, ref.longitude)
            if key not in distinct:
                distinct[key] = (ref.latitude, ref.longitude, [])
            distinct[key][2].append(ref)

        selected = list(distinct.items())[:_MAX_WEATHER_LOOKUPS]

        async def fetch_current(lat: float, lng: float) -> WeatherContext | None:
            try:
                return await self._weather.get_current(lat, lng)
            except Exception:
                return None

        contexts = await asyncio.gather(
            *(fetch_current(latitude, longitude) for _, (latitude, longitude, _) in selected)
        )
        result: list[TwinWeatherEvidence] = []
        for ((_, _), (_, _, grouped_refs)), context in zip(selected, contexts, strict=True):
            for ref in grouped_refs:
                result.append(self._weather_evidence(ref.item_id, context, context_kind="CURRENT"))
        for ref in refs:
            if not any(entry.item_id == ref.item_id for entry in result):
                result.append(
                    TwinWeatherEvidence(item_id=ref.item_id, status="UNAVAILABLE", context_kind="UNKNOWN")
                )
        result.sort(key=lambda entry: next((r.sequence for r in refs if r.item_id == entry.item_id), 10**9))
        return result

    async def _load_routes(self, refs: list[_StopRef]) -> list[TwinRouteEvidence]:
        result: list[TwinRouteEvidence] = []
        for previous, following in zip(refs, refs[1:], strict=False):
            if (
                previous.latitude is None
                or previous.longitude is None
                or following.latitude is None
                or following.longitude is None
            ):
                continue
            if len(result) >= _MAX_ROUTE_LEGS:
                break
            try:
                route = await self._routing.get_route(
                    (previous.latitude, previous.longitude),
                    (following.latitude, following.longitude),
                    profile="driving",
                    include_geometry=True,
                )
                result.append(
                    TwinRouteEvidence(
                        from_item_id=previous.item_id,
                        to_item_id=following.item_id,
                        distance_km=route.distance_km,
                        duration_minutes=route.duration_minutes,
                        source=cast(
                            RouteSource,
                            route.source if route.source in ("osrm", "haversine_estimate") else "unavailable",
                        ),
                        geometry=route.geometry if route.source == "osrm" else None,
                    )
                )
            except Exception:
                result.append(
                    TwinRouteEvidence(
                        from_item_id=previous.item_id,
                        to_item_id=following.item_id,
                        source="unavailable",
                        scenario_status="UNAVAILABLE",
                        explanation="Route geometry is unavailable.",
                    )
                )
        return result

    def _evaluate_weather(
        self,
        refs: list[_StopRef],
        experiences: dict[str, Experience],
        baseline: list[TwinWeatherEvidence],
        scenario: WhatIfScenario,
        now: datetime,
    ) -> tuple[list[TwinWeatherEvidence], list[SimulationImpact], list[str], list[str]]:
        by_item = {entry.item_id: entry for entry in baseline}
        scenario_weather: list[TwinWeatherEvidence] = []
        impacts: list[SimulationImpact] = []
        affected_ids: list[str] = []
        statuses: list[str] = []
        for ref in refs:
            original_evidence = by_item[ref.item_id]
            evidence = original_evidence
            override = scenario.weather if self._weather_override_applies(scenario.weather, ref) else None
            if override is not None:
                hypothetical = self._hypothetical_weather(ref, override.intensity, now)
                evidence = hypothetical
                experience = ref.experience
                if experience is not None:
                    verdict = self._weather_impact.evaluate(
                        experience, self._weather_context_for_override(ref, override.intensity, now)
                    )
                    previous_verdict = None
                    # Only report a change when the user's explicit condition is worse than
                    # the observed/forecast backend verdict; unknown stays unknown.
                    existing_context = self._context_from_evidence(ref, original_evidence)
                    if existing_context is not None:
                        previous_verdict = self._weather_impact.evaluate(experience, existing_context)
                    rank = self._weather_rank(verdict.status)
                    previous_rank = self._weather_rank(previous_verdict.status) if previous_verdict else -1
                    worsened = verdict.status != WeatherImpactStatus.WEATHER_UNKNOWN and (
                        previous_verdict is None
                        and verdict.status
                        in (WeatherImpactStatus.WEATHER_CAUTION, WeatherImpactStatus.WEATHER_UNSUITABLE)
                        or previous_verdict is not None
                        and rank > previous_rank
                    )
                    statuses.append(verdict.status.value)
                    if worsened:
                        severity: ScenarioImpactLevel = (
                            "HIGH" if verdict.status == WeatherImpactStatus.WEATHER_UNSUITABLE else "MEDIUM"
                        )
                        impacts.append(
                            SimulationImpact(
                                category="weather",
                                level=severity,
                                affected=True,
                                item_id=ref.item_id,
                                reason_codes=["HYPOTHETICAL_WEATHER_WORSENS_SUITABILITY"],
                                explanation=(
                                    f"Hypothetical {override.intensity.replace('_', ' ')} changes the existing "
                                    f"weather suitability assessment for {ref.title}."
                                ),
                                confidence="MEDIUM",
                                evidence=["WEATHER_HYPOTHETICAL", verdict.status.value],
                                recommended_action="Review timing, exposure, and alternatives.",
                            )
                        )
                        if self._is_future(ref, now):
                            affected_ids.append(ref.item_id)
            scenario_weather.append(evidence)
        return scenario_weather, impacts, affected_ids, statuses

    def _apply_route_scenario(
        self, routes: list[TwinRouteEvidence], refs: list[_StopRef], scenario: WhatIfScenario
    ) -> list[TwinRouteEvidence]:
        if scenario.route is None:
            return routes
        target = scenario.route
        from_id = target.from_item_id
        if from_id is None:
            index = next((i for i, ref in enumerate(refs) if ref.item_id == target.to_item_id), -1)
            from_id = refs[index - 1].item_id if index > 0 else None
        result: list[TwinRouteEvidence] = []
        found = False
        for route in routes:
            if route.to_item_id == target.to_item_id and (from_id is None or route.from_item_id == from_id):
                found = True
                if target.kind in ("road_disruption", "temporary_closure", "walking_condition"):
                    result.append(
                        route.model_copy(
                            update={
                                "geometry": None,
                                "source": "unavailable",
                                "scenario_status": "LIMITED",
                                "scenario_duration_minutes": None,
                                "delta_minutes": None,
                                "explanation": (
                                    "Disruption assumed; OSRM cannot validate it or calculate a closure-aware route."
                                ),
                            }
                        )
                    )
                else:
                    delay = target.assumed_delay_minutes or 0
                    result.append(
                        route.model_copy(
                            update={
                                "scenario_status": "DELAY_ASSUMPTION",
                                "scenario_duration_minutes": (route.duration_minutes + delay)
                                if route.duration_minutes is not None
                                else None,
                                "delta_minutes": float(delay),
                                "explanation": (
                                    "Traveler-supplied delay added; route geometry remains the baseline route."
                                ),
                            }
                        )
                    )
            else:
                result.append(route)
        if not found:
            result.append(
                TwinRouteEvidence(
                    from_item_id=from_id or "unknown",
                    to_item_id=target.to_item_id,
                    source="unavailable",
                    scenario_status="UNAVAILABLE",
                    explanation="The affected consecutive route leg has no verified route geometry.",
                )
            )
        return result

    async def _attach_route_alternatives(
        self,
        scenario_routes: list[TwinRouteEvidence],
        baseline_routes: list[TwinRouteEvidence],
        refs: list[_StopRef],
        scenario: WhatIfScenario,
    ) -> tuple[list[TwinRouteEvidence], bool]:
        """Fetch real OSRM options for a disrupted leg without claiming closure avoidance."""
        target = scenario.route
        if target is None or target.kind not in ("road_disruption", "temporary_closure"):
            return scenario_routes, False

        route = next((item for item in baseline_routes if item.to_item_id == target.to_item_id), None)
        if route is None or route.source != "osrm":
            return scenario_routes, True
        origin = next((item for item in refs if item.item_id == route.from_item_id), None)
        destination = next((item for item in refs if item.item_id == route.to_item_id), None)
        if (
            origin is None
            or destination is None
            or origin.latitude is None
            or origin.longitude is None
            or destination.latitude is None
            or destination.longitude is None
        ):
            return scenario_routes, True

        try:
            options = await self._routing.get_route_alternatives(
                (origin.latitude, origin.longitude),
                (destination.latitude, destination.longitude),
                profile="driving",
            )
        except Exception:
            options = []
        route_options = [
            TwinRouteOption(
                distance_km=option.distance_km,
                duration_minutes=option.duration_minutes,
                geometry=option.geometry,
            )
            for option in options[:3]
            if option.source == "osrm"
            and option.geometry is not None
            and option.geometry.get("type") == "LineString"
        ]
        updated: list[TwinRouteEvidence] = []
        found = False
        for item in scenario_routes:
            if item.from_item_id == route.from_item_id and item.to_item_id == route.to_item_id:
                found = True
                updated.append(
                    item.model_copy(
                        update={
                            "alternatives": route_options,
                            "explanation": (
                                "Additional OSRM route options are shown. OSRM did not receive the hypothetical "
                                "closure or disruption; verify local conditions before choosing one."
                                if route_options
                                else "OSRM returned no additional route option. The assumed disruption is not encoded."
                            ),
                        }
                    )
                )
            else:
                updated.append(item)
        return updated, not found or not route_options

    @staticmethod
    def _to_stop(ref: _StopRef) -> TwinStop:
        exp = ref.experience
        return TwinStop(
            item_id=ref.item_id,
            experience_id=ref.experience_id,
            sequence=ref.sequence,
            title=ref.title,
            planned_start=ref.planned_start,
            planned_end=ref.planned_end,
            state=ref.state,
            locked=ref.locked,
            latitude=ref.latitude,
            longitude=ref.longitude,
            environmental_type=exp.environmental_type if exp else None,
            weather_sensitivity=exp.weather_sensitivity if exp else None,
            weather_policy=exp.weather_policy if exp else None,
            provider_verification_status=exp.provider.verification_status if exp and exp.provider else None,
            is_synthetic=exp.is_synthetic if exp else None,
        )

    @staticmethod
    def _within_horizon(ref: _StopRef, horizon_hours: int, now: datetime) -> bool:
        start = DigitalTwinService._aware(ref.planned_start)
        return now <= start <= now + timedelta(hours=horizon_hours)

    @staticmethod
    def _is_future(ref: _StopRef, now: datetime) -> bool:
        return DigitalTwinService._aware(ref.planned_end) > now

    @staticmethod
    def _aware(value: datetime) -> datetime:
        return value.replace(tzinfo=_LOCAL_ZONE) if value.tzinfo is None else value

    @staticmethod
    def _nearest_forecast(contexts: list[WeatherContext], planned: datetime) -> WeatherContext | None:
        if not contexts:
            return None
        target = DigitalTwinService._aware(planned).astimezone(UTC)
        timed = [(context, context.observed_at) for context in contexts if context.observed_at is not None]
        if not timed:
            return contexts[0]
        return min(
            timed,
            key=lambda entry: abs((entry[1].astimezone(UTC) - target).total_seconds()),
        )[0]

    @staticmethod
    def _weather_evidence(
        item_id: str,
        context: WeatherContext | None,
        *,
        context_kind: Literal["FORECAST", "CURRENT", "HYPOTHETICAL", "UNKNOWN"] = "FORECAST",
    ) -> TwinWeatherEvidence:
        if context is None or context.source == WeatherSource.UNAVAILABLE:
            return TwinWeatherEvidence(item_id=item_id, status="UNAVAILABLE", context_kind=context_kind)
        status = cast(WeatherEvidenceStatus, context.source.value)
        if context.source != WeatherSource.MOCK and context.expires_at <= datetime.now(UTC):
            status = "STALE"
        return TwinWeatherEvidence(
            item_id=item_id,
            condition=context.condition,
            temperature_c=context.temperature_c,
            precipitation_probability=context.precipitation_probability,
            precipitation_amount=context.precipitation_amount,
            wind_speed=context.wind_speed,
            visibility_km=context.visibility_km,
            severe_alert=context.severe_alert,
            status=status,
            context_kind=context_kind,
            observed_at=context.observed_at,
            expires_at=context.expires_at,
        )

    @staticmethod
    def _weather_override_applies(override: WeatherScenarioOverride | None, ref: _StopRef) -> bool:
        if override is None:
            return False
        local_start = DigitalTwinService._aware(ref.planned_start).astimezone(_LOCAL_ZONE).time()
        return local_start >= override.starts_at and (override.ends_at is None or local_start < override.ends_at)

    @staticmethod
    def _hypothetical_weather(ref: _StopRef, intensity: ScenarioWeatherIntensity, now: datetime) -> TwinWeatherEvidence:
        values: dict[str, tuple[float | None, float | None, float | None, bool]] = {
            "clear": (25.0, 0.0, 2.0, False),
            "light_rain": (25.0, 30.0, 0.2, False),
            "moderate_rain": (24.0, 60.0, 3.0, False),
            "heavy_rain": (23.0, 85.0, 8.0, False),
            "severe_rain": (22.0, 95.0, 15.0, True),
            "high_temperature": (36.0, 0.0, 1.0, False),
            "extreme_heat": (42.0, 0.0, 1.0, True),
            "strong_wind": (25.0, 0.0, 18.0, False),
            "poor_visibility": (25.0, 0.0, 3.0, False),
        }
        temp, precipitation, amount, severe = values[intensity]
        return TwinWeatherEvidence(
            item_id=ref.item_id,
            condition=f"Hypothetical {intensity.replace('_', ' ')}",
            temperature_c=temp,
            precipitation_probability=precipitation,
            precipitation_amount=amount,
            wind_speed=18.0 if intensity == "strong_wind" else 2.0,
            visibility_km=1.0 if intensity == "poor_visibility" else 10.0,
            severe_alert=severe,
            status="HYPOTHETICAL",
            observed_at=now,
        )

    @staticmethod
    def _weather_context_for_override(
        ref: _StopRef, intensity: ScenarioWeatherIntensity, now: datetime
    ) -> WeatherContext:
        evidence = DigitalTwinService._hypothetical_weather(ref, intensity, now)
        return WeatherContext(
            latitude=ref.latitude or 0.0,
            longitude=ref.longitude or 0.0,
            observed_at=now,
            timezone="Asia/Kolkata",
            temperature_c=evidence.temperature_c,
            feels_like_c=evidence.temperature_c,
            humidity=None,
            wind_speed=evidence.wind_speed,
            precipitation_probability=evidence.precipitation_probability,
            precipitation_amount=evidence.precipitation_amount,
            weather_code=None,
            condition=evidence.condition,
            visibility_km=evidence.visibility_km,
            severe_alert=bool(evidence.severe_alert),
            source=WeatherSource.MOCK,
            source_timestamp=now,
            fetched_at=now,
            expires_at=now + SIMULATION_TTL,
        )

    @staticmethod
    def _context_from_evidence(ref: _StopRef, evidence: TwinWeatherEvidence) -> WeatherContext | None:
        if evidence.status not in ("LIVE", "CACHED", "STALE", "MOCK"):
            return None
        source = (
            WeatherSource(evidence.status)
            if evidence.status in {entry.value for entry in WeatherSource}
            else WeatherSource.UNAVAILABLE
        )
        now = datetime.now(UTC)
        return WeatherContext(
            latitude=ref.latitude or 0.0,
            longitude=ref.longitude or 0.0,
            observed_at=evidence.observed_at,
            timezone="Asia/Kolkata",
            temperature_c=evidence.temperature_c,
            feels_like_c=evidence.temperature_c,
            humidity=None,
            wind_speed=evidence.wind_speed,
            precipitation_probability=evidence.precipitation_probability,
            precipitation_amount=evidence.precipitation_amount,
            weather_code=None,
            condition=evidence.condition,
            visibility_km=evidence.visibility_km,
            severe_alert=bool(evidence.severe_alert),
            source=source,
            source_timestamp=evidence.observed_at,
            fetched_at=now,
            expires_at=evidence.expires_at or now,
        )

    @staticmethod
    def _weather_rank(status: WeatherImpactStatus) -> int:
        return {
            WeatherImpactStatus.WEATHER_UNKNOWN: -1,
            WeatherImpactStatus.WEATHER_GOOD: 0,
            WeatherImpactStatus.WEATHER_CAUTION: 1,
            WeatherImpactStatus.WEATHER_UNSUITABLE: 2,
        }[status]

    @staticmethod
    def _level_weight(level: str) -> int:
        return {"NONE": 0, "LOW": 1, "MEDIUM": 2, "HIGH": 3, "CRITICAL": 4, "UNKNOWN": 0}.get(level, 0)

    @staticmethod
    def _max_severity(impacts: list[SimulationImpact]) -> ImpactSeverity:
        levels = [impact.level for impact in impacts if impact.affected]
        order = ["NONE", "LOW", "MEDIUM", "HIGH", "CRITICAL", "UNKNOWN"]
        max_level = max(levels, key=lambda value: order.index(value)) if levels else "NONE"
        return ImpactSeverity(max_level)


__all__ = ["DigitalTwinService"]
