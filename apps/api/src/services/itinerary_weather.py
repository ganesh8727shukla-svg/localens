"""Read-only forecast matching for each scheduled itinerary stop.

No itinerary or catalog rows are changed by these checks. Forecasts are
matched to the scheduled visit time; once a stop is within 15 minutes (or
already in progress), current weather replaces the long-range forecast.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import cast
from zoneinfo import ZoneInfo

from sqlalchemy.ext.asyncio import AsyncSession

from src.adapters.errors import AdapterError
from src.adapters.weather import WeatherAdapter, WeatherContext, WeatherSource
from src.core.config import Settings
from src.models.experience import Experience
from src.models.itinerary import Itinerary
from src.repositories.experience_repository import ExperienceRepository
from src.schemas.itinerary_weather import (
    ItineraryWeatherAdvisory,
    ItineraryWeatherResponse,
    WeatherAdvisoryStatus,
    WeatherCheckBasis,
    WeatherSourceLiteral,
)
from src.services.weather_impact import WeatherImpactService

_ITINERARY_TIMEZONE = ZoneInfo("Asia/Kolkata")
_NEAR_TIME_WINDOW = timedelta(minutes=15)
_MAX_FORECAST_OFFSET = timedelta(hours=2)


def _as_local(value: datetime) -> datetime:
    if value.tzinfo is None:
        # SQLite drops timezone information from DateTime(timezone=True).
        # Composer inputs use the itinerary's configured local timezone.
        return value.replace(tzinfo=_ITINERARY_TIMEZONE)
    return value.astimezone(_ITINERARY_TIMEZONE)


def _forecast_for_time(
    forecasts: list[WeatherContext], *, planned_start: datetime, planned_end: datetime
) -> WeatherContext | None:
    usable = [
        forecast for forecast in forecasts
        if forecast.source in (WeatherSource.LIVE, WeatherSource.CACHED) and forecast.observed_at is not None
    ]
    if not usable:
        # Preserve mock provenance so callers can explain that a live
        # scheduled forecast is missing without treating the mock snapshot
        # as data for a future event.
        return next((forecast for forecast in forecasts if forecast.source == WeatherSource.MOCK), None)

    start_utc = planned_start.astimezone(UTC)
    end_utc = planned_end.astimezone(UTC)

    def distance_to_visit(forecast: WeatherContext) -> timedelta:
        assert forecast.observed_at is not None
        forecast_at = forecast.observed_at.astimezone(UTC)
        if forecast_at < start_utc:
            return start_utc - forecast_at
        if forecast_at > end_utc:
            return forecast_at - end_utc
        return timedelta(0)

    closest = min(usable, key=distance_to_visit)
    return closest if distance_to_visit(closest) <= _MAX_FORECAST_OFFSET else None


def _message(
    status: str, *, source: WeatherSource, custom: bool = False, past_stop: bool = False
) -> str:
    if past_stop:
        if source == WeatherSource.MOCK:
            return "This stop has passed. Only mock weather is configured; historical weather is unavailable."
        if source == WeatherSource.UNAVAILABLE:
            return "This stop has passed. Current weather could not be fetched, and historical weather is unavailable."
        return "Showing current conditions near this stop. These are not historical conditions from the visit time."
    if source == WeatherSource.MOCK:
        return "Only mock weather is configured, so this is not a live forecast."
    if source == WeatherSource.UNAVAILABLE:
        return "Weather could not be checked. Review local conditions before this stop."
    if status == "UNKNOWN" and custom:
        return "Weather data is available, but this personal stop has no known weather-sensitivity profile."
    if status == "UNKNOWN":
        return (
            "Forecast data is available, but this venue has no verified weather-sensitivity profile, "
            "so its suitability cannot be confirmed."
        )
    if status == "UNSUITABLE":
        return "Weather may make this stop unsuitable. Review alternatives or change the plan."
    if status == "CAUTION":
        return "Weather may affect this stop. Consider an indoor option or a time change."
    if status == "GOOD":
        return "No material weather concern is present in the available data."
    return "A scheduled-time forecast is not available for this stop yet."


async def get_itinerary_weather_advisories(
    *,
    itinerary: Itinerary,
    session: AsyncSession,
    settings: Settings,
    weather_adapter: WeatherAdapter,
    now: datetime | None = None,
) -> ItineraryWeatherResponse:
    """Build an advisory response without writing to itinerary state."""
    now_local = _as_local(now or datetime.now(UTC))
    impact_service = WeatherImpactService(settings)
    experience_repository = ExperienceRepository(session)
    experience_cache: dict[str, Experience | None] = {}
    context_cache: dict[tuple[float, float, str], WeatherContext | None] = {}
    advisories: list[ItineraryWeatherAdvisory] = []

    slots: list[tuple[str, str, datetime, datetime, float | None, float | None, Experience | None, bool]] = []
    for item in itinerary.items:
        if item.item_state in ("CANCELLED", "INVALIDATED"):
            continue
        experience = experience_cache.get(item.experience_id)
        if item.experience_id not in experience_cache:
            experience = await experience_repository.get_by_id(item.experience_id)
            experience_cache[item.experience_id] = experience
        if experience is None:
            continue
        slots.append((
            item.id,
            experience.title,
            _as_local(item.planned_start),
            _as_local(item.planned_end),
            experience.location.latitude,
            experience.location.longitude,
            experience,
            False,
        ))

    for activity in itinerary.custom_activities:
        if activity.kind == "note":
            continue
        slots.append((
            activity.id,
            activity.title,
            _as_local(activity.planned_start),
            _as_local(activity.planned_end),
            activity.latitude,
            activity.longitude,
            None,
            True,
        ))

    slots.sort(key=lambda slot: slot[2])
    for item_id, title, planned_start, planned_end, lat, lng, experience, custom in slots:
        past_stop_today = planned_end < now_local and planned_start.date() == now_local.date()
        if planned_end < now_local and not past_stop_today:
            advisories.append(ItineraryWeatherAdvisory(
                item_id=item_id, title=title, planned_start=planned_start, planned_end=planned_end,
                latitude=lat, longitude=lng, checked_at=now_local, check_basis="UNAVAILABLE",
                status="UNKNOWN", source="UNAVAILABLE",
                message="This stop has passed. Historical weather for its scheduled time is unavailable.",
            ))
            continue
        if lat is None or lng is None:
            advisories.append(ItineraryWeatherAdvisory(
                item_id=item_id, title=title, planned_start=planned_start, planned_end=planned_end,
                checked_at=now_local, check_basis="UNAVAILABLE", status="UNKNOWN", source="UNAVAILABLE",
                message="A verified location is needed to check weather for this stop.",
            ))
            continue

        in_near_time_window = planned_start - _NEAR_TIME_WINDOW <= now_local <= planned_end
        is_current_check = in_near_time_window or past_stop_today
        basis: WeatherCheckBasis = (
            "CURRENT_AT_LOCATION" if past_stop_today
            else "NEAR_TIME_CURRENT" if in_near_time_window
            else "PLANNED_FORECAST"
        )
        cache_key = (round(lat, 2), round(lng, 2), "current" if is_current_check else "forecast")
        try:
            if cache_key not in context_cache:
                if is_current_check:
                    context_cache[cache_key] = await weather_adapter.get_current(lat, lng)
                else:
                    forecasts = await weather_adapter.get_forecast(lat, lng)
                    context_cache[cache_key] = _forecast_for_time(
                        forecasts, planned_start=planned_start, planned_end=planned_end
                    )
            weather = context_cache[cache_key]
        except AdapterError:
            weather = None

        status: WeatherAdvisoryStatus
        source: WeatherSourceLiteral
        check_basis: WeatherCheckBasis
        if weather is None:
            status = "UNKNOWN"
            source = "UNAVAILABLE"
            forecast_at = None
            reasons = ["No provider forecast covers this scheduled time." if basis == "PLANNED_FORECAST"
                       else "The current weather provider is unavailable."]
            condition = None
            temperature = precip_probability = precip_amount = wind_speed = None
            severe_alert = None
            check_basis = "UNAVAILABLE" if is_current_check else basis
        elif weather.source == WeatherSource.MOCK:
            status = "UNKNOWN"
            source = cast(WeatherSourceLiteral, weather.source.value)
            forecast_at = weather.observed_at
            reasons = []
            condition = weather.condition
            temperature = weather.temperature_c
            precip_probability = weather.precipitation_probability
            precip_amount = weather.precipitation_amount
            wind_speed = weather.wind_speed
            severe_alert = weather.severe_alert
            check_basis = basis
        elif past_stop_today:
            # Current weather is useful area context, but it must not be
            # presented as the conditions that occurred during a past visit.
            status = "CURRENT"
            source = cast(WeatherSourceLiteral, weather.source.value)
            forecast_at = weather.observed_at
            reasons = []
            condition = weather.condition
            temperature = weather.temperature_c
            precip_probability = weather.precipitation_probability
            precip_amount = weather.precipitation_amount
            wind_speed = weather.wind_speed
            severe_alert = weather.severe_alert
            check_basis = basis
        elif experience is None:
            status = "UNKNOWN"
            source = cast(WeatherSourceLiteral, weather.source.value)
            forecast_at = weather.observed_at
            reasons = []
            condition = weather.condition
            temperature = weather.temperature_c
            precip_probability = weather.precipitation_probability
            precip_amount = weather.precipitation_amount
            wind_speed = weather.wind_speed
            severe_alert = weather.severe_alert
            check_basis = basis
        else:
            verdict = impact_service.evaluate(experience, weather)
            status = cast(WeatherAdvisoryStatus, verdict.status.value.removeprefix("WEATHER_"))
            source = cast(WeatherSourceLiteral, weather.source.value)
            forecast_at = weather.observed_at
            reasons = verdict.reasons
            condition = weather.condition
            temperature = weather.temperature_c
            precip_probability = weather.precipitation_probability
            precip_amount = weather.precipitation_amount
            wind_speed = weather.wind_speed
            severe_alert = weather.severe_alert
            check_basis = basis

        advisories.append(ItineraryWeatherAdvisory(
            item_id=item_id,
            title=title,
            planned_start=planned_start,
            planned_end=planned_end,
            latitude=lat,
            longitude=lng,
            forecast_at=forecast_at,
            checked_at=now_local,
            check_basis=check_basis,
            status=status,
            source=source,
            condition=condition,
            temperature_c=temperature,
            precipitation_probability=precip_probability,
            precipitation_amount=precip_amount,
            wind_speed=wind_speed,
            severe_alert=severe_alert,
            reasons=reasons,
            message=_message(
                status,
                source=weather.source if weather else WeatherSource.UNAVAILABLE,
                custom=custom,
                past_stop=past_stop_today,
            ),
        ))

    return ItineraryWeatherResponse(
        itinerary_id=itinerary.id,
        generated_at=now_local,
        advisories=advisories,
    )


__all__ = ["get_itinerary_weather_advisories"]
