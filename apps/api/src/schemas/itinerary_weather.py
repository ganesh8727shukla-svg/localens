"""Read-only scheduled weather advisories for saved itineraries."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

WeatherAdvisoryStatus = Literal["GOOD", "CAUTION", "UNSUITABLE", "UNKNOWN", "CURRENT"]
WeatherCheckBasis = Literal[
    "PLANNED_FORECAST", "NEAR_TIME_CURRENT", "CURRENT_AT_LOCATION", "UNAVAILABLE"
]
WeatherSourceLiteral = Literal["LIVE", "CACHED", "MOCK", "UNAVAILABLE"]


class ItineraryWeatherAdvisory(BaseModel):
    model_config = ConfigDict(extra="forbid")

    item_id: str
    title: str
    planned_start: datetime
    planned_end: datetime
    latitude: float | None = None
    longitude: float | None = None
    forecast_at: datetime | None = None
    checked_at: datetime
    check_basis: WeatherCheckBasis
    status: WeatherAdvisoryStatus
    source: WeatherSourceLiteral
    condition: str | None = None
    temperature_c: float | None = None
    precipitation_probability: float | None = None
    precipitation_amount: float | None = None
    wind_speed: float | None = None
    severe_alert: bool | None = None
    reasons: list[str] = Field(default_factory=list)
    message: str


class ItineraryWeatherResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    itinerary_id: str
    generated_at: datetime
    advisories: list[ItineraryWeatherAdvisory] = Field(default_factory=list)


__all__ = [
    "ItineraryWeatherAdvisory",
    "ItineraryWeatherResponse",
    "WeatherAdvisoryStatus",
    "WeatherCheckBasis",
]
