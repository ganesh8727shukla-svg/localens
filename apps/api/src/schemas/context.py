"""Real-time context schemas (Phase 9).

WeatherContextResponse/ContextImpactResponse are read-only response
shapes for GET /api/v1/context/weather and internal use by
ReplanningService/ContextMonitor. Never leak API keys or raw provider
payloads — only the normalized fields WeatherContext/ExternalEvent
already expose. `context_status` distinguishes LIVE/CACHED/STALE/
UNAVAILABLE explicitly so the frontend never shows a live badge for
stale/cached data (docs/AI_CONTEXT.md hard invariant).
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

ContextStatusLiteral = Literal["LIVE", "CACHED", "STALE", "UNAVAILABLE", "MOCK"]


class WeatherContextResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    latitude: float
    longitude: float
    observed_at: datetime | None = None
    timezone: str | None = None
    timezone_offset_seconds: int | None = None
    temperature_c: float | None = None
    feels_like_c: float | None = None
    humidity: float | None = None
    wind_speed: float | None = None
    precipitation_probability: float | None = None
    precipitation_amount: float | None = None
    weather_code: int | None = None
    condition: str | None = None
    visibility_km: float | None = None
    severe_alert: bool = False
    source: Literal["LIVE", "CACHED", "MOCK", "UNAVAILABLE"]
    context_status: ContextStatusLiteral
    last_updated_at: datetime
    fetched_at: datetime
    expires_at: datetime


class WeatherForecastEntry(BaseModel):
    """Normalized forecast item; provider payload fields never cross the API."""

    model_config = ConfigDict(extra="forbid")

    latitude: float
    longitude: float
    forecast_at: datetime | None = None
    timezone: str | None = None
    timezone_offset_seconds: int | None = None
    temperature_c: float | None = None
    feels_like_c: float | None = None
    humidity: float | None = None
    wind_speed: float | None = None
    precipitation_probability: float | None = None
    precipitation_amount: float | None = None
    weather_code: int | None = None
    condition: str | None = None
    visibility_km: float | None = None
    severe_alert: bool = False
    source: Literal["LIVE", "CACHED", "MOCK", "UNAVAILABLE"]
    context_status: ContextStatusLiteral
    fetched_at: datetime
    expires_at: datetime


class ContextImpactResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    affected: bool
    severity: Literal["NONE", "LOW", "MEDIUM", "HIGH", "CRITICAL", "UNKNOWN"]
    context_type: str
    affected_itinerary_item_ids: list[str] = Field(default_factory=list)
    reason_codes: list[str] = Field(default_factory=list)
    explanation: str = ""


__all__ = [
    "ContextImpactResponse",
    "ContextStatusLiteral",
    "WeatherContextResponse",
    "WeatherForecastEntry",
]
