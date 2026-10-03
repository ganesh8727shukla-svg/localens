"""Read-only real-time context endpoints (Phase 9).

GET /api/v1/context/weather, GET /api/v1/context/events — authenticated
(any logged-in role; anonymous cannot access traveler context per the
Phase 9 spec). Normalized data only: never leak the OpenWeather/
Ticketmaster API key or raw provider payloads — only the same
WeatherContext/ExternalEvent fields the adapters already normalize.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from src.adapters.errors import AdapterError
from src.adapters.events import EventAdapter
from src.adapters.weather import WeatherAdapter, WeatherContext, WeatherSource, unavailable_context
from src.adapters.weather_scenarios import WeatherScenario, build_weather_scenario
from src.core.config import Settings, get_settings
from src.core.context import get_event_adapter, get_weather_adapter
from src.core.deps import CurrentUser
from src.core.errors import ApiError
from src.schemas.context import (
    ContextStatusLiteral,
    WeatherContextResponse,
    WeatherForecastEntry,
)
from src.schemas.events import EventResponse

router = APIRouter(prefix="/context", tags=["context"])

_SOURCE_TO_STATUS: dict[WeatherSource, ContextStatusLiteral] = {
    WeatherSource.LIVE: "LIVE",
    WeatherSource.CACHED: "CACHED",
    WeatherSource.MOCK: "MOCK",
    WeatherSource.UNAVAILABLE: "UNAVAILABLE",
}


def _status_for(context: WeatherContext) -> ContextStatusLiteral:
    status = _SOURCE_TO_STATUS.get(context.source, "UNAVAILABLE")
    if status in ("LIVE", "CACHED") and context.expires_at <= datetime.now(UTC):
        return "STALE"
    return status


@router.get("/weather", response_model=WeatherContextResponse)
async def get_weather_context(
    _user: CurrentUser,
    settings: Annotated[Settings, Depends(get_settings)],
    weather_adapter: Annotated[WeatherAdapter, Depends(get_weather_adapter)],
    lat: float = Query(..., ge=-90, le=90),
    lng: float = Query(..., ge=-180, le=180),
    scenario: WeatherScenario | None = None,
    refresh: bool = Query(default=False, description="Bypass the live provider cache after an explicit refresh."),
) -> WeatherContextResponse:
    if scenario is not None:
        if settings.app_env != "development":
            raise ApiError("Weather test scenarios are available only in development.", status_code=404)
        context = build_weather_scenario(scenario, lat, lng)
    else:
        try:
            context = await weather_adapter.refresh_current(lat, lng) if refresh else await weather_adapter.get_current(lat, lng)
        except AdapterError:
            # Return the stable normalized unavailable shape. Provider error
            # details are deliberately not exposed in JSON or logs here.
            context = unavailable_context(lat, lng)

    status_label = _status_for(context)

    return WeatherContextResponse(
        latitude=context.latitude,
        longitude=context.longitude,
        observed_at=context.observed_at,
        timezone=context.timezone,
        timezone_offset_seconds=context.timezone_offset_seconds,
        temperature_c=context.temperature_c,
        feels_like_c=context.feels_like_c,
        humidity=context.humidity,
        wind_speed=context.wind_speed,
        precipitation_probability=context.precipitation_probability,
        precipitation_amount=context.precipitation_amount,
        weather_code=context.weather_code,
        condition=context.condition,
        visibility_km=context.visibility_km,
        severe_alert=context.severe_alert,
        source=context.source.value,
        context_status=status_label,
        last_updated_at=context.fetched_at,
        fetched_at=context.fetched_at,
        expires_at=context.expires_at,
    )


@router.get("/weather/forecast", response_model=list[WeatherForecastEntry])
async def get_weather_forecast(
    _user: CurrentUser,
    settings: Annotated[Settings, Depends(get_settings)],
    weather_adapter: Annotated[WeatherAdapter, Depends(get_weather_adapter)],
    lat: float = Query(..., ge=-90, le=90),
    lng: float = Query(..., ge=-180, le=180),
    max_entries: int = Query(default=8, ge=1, le=40),
    scenario: WeatherScenario | None = None,
    refresh: bool = Query(default=False, description="Bypass the live provider cache after an explicit refresh."),
) -> list[WeatherForecastEntry]:
    """Return a bounded list of adapter-normalized forecast entries."""
    if scenario is not None:
        if settings.app_env != "development":
            raise ApiError("Weather test scenarios are available only in development.", status_code=404)
        forecasts = [build_weather_scenario(scenario, lat, lng)]
    else:
        try:
            forecasts = await weather_adapter.refresh_forecast(lat, lng) if refresh else await weather_adapter.get_forecast(lat, lng)
        except AdapterError:
            # Keep provider diagnostics and credentials out of client responses.
            raise ApiError("Weather forecast is temporarily unavailable.", status_code=503) from None

    entries: list[WeatherForecastEntry] = []
    for context in forecasts[:max_entries]:
        entries.append(
            WeatherForecastEntry(
                # Forecast adapter entries omit coordinates because the
                # provider payload is for the request point. Return the
                # validated request coordinates rather than serializing
                # their internal NaN sentinels.
                latitude=lat,
                longitude=lng,
                forecast_at=context.observed_at,
                timezone=context.timezone,
                timezone_offset_seconds=context.timezone_offset_seconds,
                temperature_c=context.temperature_c,
                feels_like_c=context.feels_like_c,
                humidity=context.humidity,
                wind_speed=context.wind_speed,
                precipitation_probability=context.precipitation_probability,
                precipitation_amount=context.precipitation_amount,
                weather_code=context.weather_code,
                condition=context.condition,
                visibility_km=context.visibility_km,
                severe_alert=context.severe_alert,
                source=context.source.value,
                context_status=_status_for(context),
                fetched_at=context.fetched_at,
                expires_at=context.expires_at,
            )
        )
    return entries


@router.get("/events", response_model=list[EventResponse])
async def get_events_context(
    _user: CurrentUser,
    settings: Annotated[Settings, Depends(get_settings)],
    event_adapter: Annotated[EventAdapter, Depends(get_event_adapter)],
    lat: float = Query(..., ge=-90, le=90),
    lng: float = Query(..., ge=-180, le=180),
    radius_m: int = Query(default=5000, ge=100, le=50000),
) -> list[EventResponse]:
    try:
        events = await event_adapter.search_events(lat, lng, radius_m)
    except AdapterError as exc:
        raise ApiError(f"Event context unavailable: {exc}", status_code=503) from exc

    return [
        EventResponse(
            id=e.id,
            source=e.source,
            name=e.name,
            description=e.description,
            starts_at=e.starts_at,
            ends_at=e.ends_at,
            status=e.status.value,
            venue_name=e.venue_name,
            venue_address=e.venue_address,
            latitude=e.latitude,
            longitude=e.longitude,
            category=e.category,
            image_url=e.image_url,
            purchase_url=e.purchase_url,
            is_synthetic=e.is_synthetic,
            fetched_at=e.fetched_at,
        )
        for e in events
    ]


__all__ = ["router"]
