"""Bounded, normalized contracts for non-authoritative domain explanations."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class DomainIntelligenceStop(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    item_id: str = Field(max_length=36)
    title: str = Field(max_length=160)
    start: str = Field(max_length=40)
    end: str = Field(max_length=40)
    state: str = Field(max_length=40)
    locked: bool
    provider_verification_status: str | None = Field(default=None, max_length=60)


class DomainIntelligenceWeather(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    item_id: str = Field(max_length=36)
    status: str = Field(max_length=40)
    context_kind: str = Field(default="FORECAST", max_length=20)
    condition: str | None = Field(default=None, max_length=100)
    temperature_c: float | None = None
    precipitation_probability: float | None = None
    precipitation_amount: float | None = None
    wind_speed: float | None = None
    severe_alert: bool | None = None


class DomainIntelligenceRoute(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    from_item_id: str = Field(max_length=36)
    to_item_id: str = Field(max_length=36)
    source: str = Field(max_length=40)
    duration_minutes: float | None = None
    scenario_status: str = Field(max_length=40)
    delta_minutes: float | None = None
    explanation: str | None = Field(default=None, max_length=240)


class DomainIntelligenceImpact(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    category: str = Field(max_length=40)
    level: str = Field(max_length=20)
    affected: bool
    item_id: str | None = Field(default=None, max_length=36)
    reason_codes: list[str] = Field(default_factory=list, max_length=10)
    explanation: str = Field(max_length=300)


class DomainIntelligenceInput(BaseModel):
    """Small, explicitly selected facts; never a database or ORM dump."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    scenario_name: str = Field(max_length=120)
    scenario_description: str | None = Field(default=None, max_length=500)
    impact_categories: list[str] = Field(default_factory=list, max_length=30)
    affected_item_ids: list[str] = Field(default_factory=list, max_length=30)
    weather_statuses: list[str] = Field(default_factory=list, max_length=20)
    route_statuses: list[str] = Field(default_factory=list, max_length=12)
    stops: list[DomainIntelligenceStop] = Field(default_factory=list, max_length=20)
    weather: list[DomainIntelligenceWeather] = Field(default_factory=list, max_length=20)
    routes: list[DomainIntelligenceRoute] = Field(default_factory=list, max_length=12)
    deterministic_impacts: list[DomainIntelligenceImpact] = Field(default_factory=list, max_length=30)
    social_status: str = Field(default="NOT_REQUESTED", max_length=40)
    social_topics: list[str] = Field(default_factory=list, max_length=20)
    itinerary_date: str | None = Field(default=None, max_length=20)
    timezone: str = Field(default="Asia/Kolkata", max_length=50)
    deterministic_summary: str = Field(default="", max_length=500)


class DomainIntelligenceResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    provider: Literal["mock", "nugen"] = "mock"
    status: Literal["LOCAL_PREVIEW", "AVAILABLE", "UNAVAILABLE"] = "LOCAL_PREVIEW"
    summary: str
    notes: list[str] = Field(default_factory=list)
    # These are model-reported explanatory metadata only, never decisions.
    impacts: list[str] = Field(default_factory=list, max_length=12)
    suitability_assessment: str | None = Field(default=None, max_length=800)
    disruption_assessment: str | None = Field(default=None, max_length=800)
    recommendation: str | None = Field(default=None, max_length=800)
    uncertainty: str | None = None
    reason_codes: list[str] = Field(default_factory=list, max_length=20)
    model_id: str | None = None
    usage: dict[str, int | float | str] | None = None
    confidence_score: float | None = Field(default=None, allow_inf_nan=False)
    finish_reason: str | None = None
    confidence: Literal["LOW", "MEDIUM", "HIGH"] = "LOW"


__all__ = [
    "DomainIntelligenceImpact",
    "DomainIntelligenceInput",
    "DomainIntelligenceResult",
    "DomainIntelligenceRoute",
    "DomainIntelligenceStop",
    "DomainIntelligenceWeather",
]
