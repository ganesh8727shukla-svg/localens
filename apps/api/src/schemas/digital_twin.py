"""Typed, serializable contracts for read-only what-if simulation.

Scenario values describe assumptions supplied by a traveler. They are never
provider observations and are not written to canonical itinerary/catalog rows.
"""

from __future__ import annotations

from datetime import date, datetime, time
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from src.schemas.domain_intelligence import DomainIntelligenceResult

ScenarioWeatherIntensity = Literal[
    "clear",
    "light_rain",
    "moderate_rain",
    "heavy_rain",
    "severe_rain",
    "high_temperature",
    "extreme_heat",
    "strong_wind",
    "poor_visibility",
]
ScenarioImpactLevel = Literal["NONE", "LOW", "MEDIUM", "HIGH", "CRITICAL", "UNKNOWN"]
SimulationConfidence = Literal["LOW", "MEDIUM", "HIGH"]
SimulationStatus = Literal["READY", "PARTIAL", "STALE", "CONFLICT", "UNAVAILABLE"]
SimulationChangeLevel = Literal["NO_CHANGE", "MINOR", "MODERATE", "MAJOR", "CRITICAL", "UNKNOWN"]
RouteSource = Literal["osrm", "haversine_estimate", "unavailable"]
WeatherEvidenceStatus = Literal["LIVE", "CACHED", "STALE", "MOCK", "UNAVAILABLE", "HYPOTHETICAL"]
WeatherSuitability = Literal["WEATHER_GOOD", "WEATHER_CAUTION", "WEATHER_UNSUITABLE", "WEATHER_UNKNOWN"]


class WeatherScenarioOverride(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    intensity: ScenarioWeatherIntensity
    starts_at: time = time(17, 0)
    ends_at: time | None = None

    @model_validator(mode="after")
    def check_time_range(self) -> WeatherScenarioOverride:
        if self.ends_at is not None and self.ends_at <= self.starts_at:
            raise ValueError("weather override end time must be later than its start time")
        return self


class RouteScenarioOverride(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: Literal["road_disruption", "temporary_closure", "congestion", "walking_condition"]
    to_item_id: str = Field(min_length=1, max_length=36, description="Destination itinerary item for the affected leg.")
    from_item_id: str | None = Field(default=None, min_length=1, max_length=36)
    assumed_delay_minutes: int | None = Field(default=None, ge=0, le=240)


class ExperienceScenarioOverride(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    item_id: str = Field(min_length=1, max_length=36)
    condition: Literal["unavailable", "reduced_suitability", "increased_crowding", "contextual_risk"]


class HypotheticalSocialOverride(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    topic: Literal["flooding", "road_disruption", "crowding", "event_disruption", "weather", "heat", "wind"]
    severity: Literal["low", "moderate", "high"] = "moderate"
    around_item_id: str = Field(min_length=1, max_length=36)


class WhatIfScenario(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    name: str = Field(default="What-if scenario", min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=500)
    weather: WeatherScenarioOverride | None = None
    include_recent_social_context: bool = False
    social_context_item_id: str | None = Field(default=None, min_length=1, max_length=36)
    hypothetical_social: HypotheticalSocialOverride | None = None
    route: RouteScenarioOverride | None = None
    experience_overrides: list[ExperienceScenarioOverride] = Field(default_factory=list, max_length=10)
    horizon_hours: int = Field(default=24, ge=1, le=72)

    @model_validator(mode="after")
    def check_social_context_location(self) -> WhatIfScenario:
        if self.include_recent_social_context and not self.social_context_item_id:
            raise ValueError("social_context_item_id is required when recent social context is enabled")
        item_ids = [override.item_id for override in self.experience_overrides]
        if len(item_ids) != len(set(item_ids)):
            raise ValueError("experience override item ids must be unique")
        return self


class TwinStop(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    item_id: str
    experience_id: str | None = None
    sequence: int
    title: str
    planned_start: datetime
    planned_end: datetime
    state: str
    locked: bool
    latitude: float | None = None
    longitude: float | None = None
    environmental_type: str | None = None
    weather_sensitivity: str | None = None
    weather_policy: str | None = None
    provider_verification_status: str | None = None
    is_synthetic: bool | None = None


class TwinWeatherEvidence(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    item_id: str
    condition: str | None = None
    temperature_c: float | None = None
    precipitation_probability: float | None = None
    precipitation_amount: float | None = None
    wind_speed: float | None = None
    visibility_km: float | None = None
    severe_alert: bool | None = None
    status: WeatherEvidenceStatus
    context_kind: Literal["FORECAST", "CURRENT", "HYPOTHETICAL", "UNKNOWN"] = "FORECAST"
    observed_at: datetime | None = None
    expires_at: datetime | None = None


class TwinSocialCluster(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    topic: str
    severity: str
    signal_count: int | None = None
    independent_source_count: int | None = None
    newest_signal_at: datetime | None = None
    source_platforms: list[str] = Field(default_factory=list)
    confidence: float | None = Field(default=None, ge=0, le=1)
    confidence_note: str | None = None
    status: Literal["REAL_AGGREGATE", "HYPOTHETICAL"]
    location_name: str | None = None


class TwinSocialEvidence(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    status: Literal["NOT_REQUESTED", "AVAILABLE", "NO_SIGNALS", "UNAVAILABLE", "RATE_LIMITED", "STALE", "HYPOTHETICAL"]
    queried_location: str | None = None
    location_source: Literal["reverse_geocoder", "catalog_record", "unavailable"] | None = None
    generated_at: datetime | None = None
    clusters: list[TwinSocialCluster] = Field(default_factory=list)
    message: str | None = None


class TwinRouteOption(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    distance_km: float
    duration_minutes: float
    geometry: dict[str, Any]
    source: Literal["osrm"] = "osrm"


class TwinRouteEvidence(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    from_item_id: str
    to_item_id: str
    distance_km: float | None = None
    duration_minutes: float | None = None
    source: RouteSource
    geometry: dict[str, Any] | None = None
    scenario_status: Literal["UNCHANGED", "DELAY_ASSUMPTION", "DISRUPTED", "LIMITED", "UNAVAILABLE"] = "UNCHANGED"
    scenario_duration_minutes: float | None = None
    delta_minutes: float | None = None
    explanation: str | None = None
    alternatives: list[TwinRouteOption] = Field(default_factory=list, max_length=3)


class TwinPlanState(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    stops: list[TwinStop] = Field(default_factory=list)
    weather: list[TwinWeatherEvidence] = Field(default_factory=list)
    current_weather: list[TwinWeatherEvidence] = Field(default_factory=list)
    social: TwinSocialEvidence
    routes: list[TwinRouteEvidence] = Field(default_factory=list)


class DigitalTwinSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    snapshot_id: str
    generated_at: datetime
    timezone: str
    itinerary_id: str
    itinerary_version: int
    itinerary_date: date
    itinerary_status: str
    traveler_context_available: bool
    plan: TwinPlanState


class SimulationImpact(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    category: Literal["weather", "social", "experience", "route", "schedule", "provider", "accessibility", "context"]
    level: ScenarioImpactLevel
    affected: bool
    item_id: str | None = None
    reason_codes: list[str] = Field(default_factory=list)
    explanation: str
    confidence: SimulationConfidence
    evidence: list[str] = Field(default_factory=list)
    recommended_action: str | None = None


class SimulationAlternative(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    for_item_id: str
    experience_id: str
    title: str
    category: str
    environmental_type: str
    weather_suitability: WeatherSuitability
    weather_status: WeatherEvidenceStatus = "UNAVAILABLE"
    weather_condition: str | None = None
    weather_temperature_c: float | None = None
    weather_precipitation_probability: float | None = None
    weather_precipitation_amount: float | None = None
    weather_wind_speed: float | None = None
    weather_at: datetime | None = None
    ranking_score: float
    is_synthetic: bool


class SimulationDelta(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    affected_stop_count: int
    unchanged_stop_count: int
    affected_route_count: int
    additional_travel_minutes: float | None = None
    change_level: SimulationChangeLevel
    summary: str


class SimulationResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    simulation_id: str
    status: SimulationStatus
    created_at: datetime
    expires_at: datetime
    scenario_name: str
    baseline: DigitalTwinSnapshot
    scenario: TwinPlanState
    delta: SimulationDelta
    impacts: list[SimulationImpact] = Field(default_factory=list)
    alternatives: list[SimulationAlternative] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    domain_intelligence: DomainIntelligenceResult | None = None
    simulation_confidence_note: str = "Evidence-completeness label, not a calibrated probability."


__all__ = [
    "DigitalTwinSnapshot",
    "ExperienceScenarioOverride",
    "HypotheticalSocialOverride",
    "RouteScenarioOverride",
    "RouteSource",
    "SimulationAlternative",
    "SimulationChangeLevel",
    "SimulationDelta",
    "SimulationImpact",
    "SimulationResult",
    "SimulationStatus",
    "TwinPlanState",
    "TwinRouteEvidence",
    "TwinRouteOption",
    "TwinSocialCluster",
    "TwinSocialEvidence",
    "TwinStop",
    "TwinWeatherEvidence",
    "WeatherEvidenceStatus",
    "WeatherSuitability",
    "WhatIfScenario",
    "WeatherScenarioOverride",
]
