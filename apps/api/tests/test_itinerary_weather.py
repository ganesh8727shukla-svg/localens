from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from src.adapters.events import SeedEventAdapter
from src.adapters.weather import WeatherContext, WeatherSource
from src.core.config import Settings
from src.models.experience import Experience
from src.models.itinerary import Itinerary
from src.models.itinerary_item import ItineraryItem
from src.services.context_monitor import ContextMonitor
from src.services.itinerary_weather import get_itinerary_weather_advisories

_IST = ZoneInfo("Asia/Kolkata")


def _weather(at: datetime, *, probability: float, amount: float = 0.0) -> WeatherContext:
    fetched = datetime.now(UTC)
    return WeatherContext(
        latitude=18.93,
        longitude=72.83,
        observed_at=at,
        timezone="Asia/Kolkata",
        temperature_c=27,
        feels_like_c=29,
        humidity=70,
        wind_speed=3,
        precipitation_probability=probability,
        precipitation_amount=amount,
        weather_code=500 if probability > 60 else 800,
        condition="Rain" if probability > 60 else "Clear",
        visibility_km=8,
        severe_alert=False,
        source=WeatherSource.LIVE,
        source_timestamp=at,
        fetched_at=fetched,
        expires_at=fetched + timedelta(minutes=15),
    )


class FakeWeatherAdapter:
    def __init__(self, current: WeatherContext, forecasts: list[WeatherContext]) -> None:
        self.current = current
        self.forecasts = forecasts
        self.current_calls = 0
        self.forecast_calls = 0

    async def get_current(self, lat: float, lng: float) -> WeatherContext:
        self.current_calls += 1
        return self.current

    async def refresh_current(self, lat: float, lng: float) -> WeatherContext:
        return await self.get_current(lat, lng)

    async def get_forecast(self, lat: float, lng: float) -> list[WeatherContext]:
        self.forecast_calls += 1
        return self.forecasts

    async def refresh_forecast(self, lat: float, lng: float) -> list[WeatherContext]:
        return await self.get_forecast(lat, lng)


def _itinerary(experience_id: str, planned_start: datetime) -> Itinerary:
    item = ItineraryItem(
        id="weather-item-1",
        itinerary_id="weather-itinerary-1",
        experience_id=experience_id,
        sequence_order=1,
        planned_start=planned_start,
        planned_end=planned_start + timedelta(hours=1),
        duration_minutes=60,
        buffer_before_minutes=0,
        buffer_after_minutes=0,
        is_locked=False,
        item_state="ACTIVE",
    )
    return Itinerary(
        id="weather-itinerary-1",
        traveler_id="traveler-1",
        title="Weather test",
        itinerary_date=planned_start.date(),
        start_time=planned_start.timetz().replace(tzinfo=None),
        end_time=(planned_start + timedelta(hours=1)).timetz().replace(tzinfo=None),
        status="VALIDATED",
        source="COMPOSER",
        currency="INR",
        items=[item],
        custom_activities=[],
    )


def _mark_experience_weather_sensitive(session_factory, experience_id: str) -> None:
    async def _update() -> None:
        async with session_factory() as session:
            experience = await session.get(Experience, experience_id)
            assert experience is not None
            experience.environmental_type = "OUTDOOR"
            experience.weather_sensitivity = "HIGH"
            experience.weather_policy = "SEVERE_WEATHER_EXCLUDE"
            await session.commit()

    asyncio.run(_update())


def test_itinerary_weather_uses_the_forecast_closest_to_the_stop(session_factory, seeded_ids) -> None:
    _mark_experience_weather_sensitive(session_factory, seeded_ids["experience_id"])
    planned_start = datetime(2026, 10, 4, 17, 0, tzinfo=_IST)
    scheduled_forecast = _weather(planned_start.astimezone(UTC), probability=90, amount=4)
    adapter = FakeWeatherAdapter(
        current=_weather(datetime(2026, 10, 4, 8, 0, tzinfo=UTC), probability=0),
        forecasts=[scheduled_forecast],
    )
    itinerary = _itinerary(seeded_ids["experience_id"], planned_start)

    async def _run():
        async with session_factory() as session:
            return await get_itinerary_weather_advisories(
                itinerary=itinerary,
                session=session,
                settings=Settings(),
                weather_adapter=adapter,
                now=datetime(2026, 10, 3, 12, 0, tzinfo=UTC),
            )

    result = asyncio.run(_run())
    advisory = result.advisories[0]
    assert advisory.status == "UNSUITABLE"
    assert advisory.check_basis == "PLANNED_FORECAST"
    assert advisory.forecast_at == scheduled_forecast.observed_at
    assert adapter.forecast_calls == 1
    assert adapter.current_calls == 0
    assert itinerary.status == "VALIDATED"
    assert itinerary.items[0].item_state == "ACTIVE"


def test_known_forecast_is_not_described_as_missing_when_venue_profile_is_unknown(
    session_factory, seeded_ids
) -> None:
    planned_start = datetime(2026, 10, 4, 9, 10, tzinfo=_IST)
    forecast = _weather(planned_start.astimezone(UTC), probability=0)
    adapter = FakeWeatherAdapter(current=forecast, forecasts=[forecast])
    itinerary = _itinerary(seeded_ids["experience_id"], planned_start)

    async def _run():
        async with session_factory() as session:
            return await get_itinerary_weather_advisories(
                itinerary=itinerary,
                session=session,
                settings=Settings(),
                weather_adapter=adapter,
                now=datetime(2026, 10, 3, 12, 0, tzinfo=UTC),
            )

    advisory = asyncio.run(_run()).advisories[0]
    assert advisory.status == "UNKNOWN"  # venue sensitivity is unverified
    assert advisory.source == "LIVE"
    assert advisory.condition == "Clear"
    assert advisory.temperature_c == 27
    assert "Forecast data is available" in advisory.message
    assert "weather-sensitivity profile" in advisory.message


def test_itinerary_weather_switches_to_current_inside_fifteen_minute_window(session_factory, seeded_ids) -> None:
    _mark_experience_weather_sensitive(session_factory, seeded_ids["experience_id"])
    planned_start = datetime(2026, 10, 4, 17, 0, tzinfo=_IST)
    adapter = FakeWeatherAdapter(
        current=_weather(planned_start.replace(minute=45).astimezone(UTC), probability=90, amount=4),
        forecasts=[_weather(planned_start.astimezone(UTC), probability=0)],
    )
    itinerary = _itinerary(seeded_ids["experience_id"], planned_start)

    async def _run():
        async with session_factory() as session:
            return await get_itinerary_weather_advisories(
                itinerary=itinerary,
                session=session,
                settings=Settings(),
                weather_adapter=adapter,
                now=planned_start - timedelta(minutes=15),
            )

    result = asyncio.run(_run())
    advisory = result.advisories[0]
    assert advisory.status == "UNSUITABLE"
    assert advisory.check_basis == "NEAR_TIME_CURRENT"
    assert adapter.current_calls == 1
    assert adapter.forecast_calls == 0


def test_itinerary_weather_marks_mock_data_unknown(session_factory, seeded_ids) -> None:
    planned_start = datetime(2026, 10, 4, 17, 0, tzinfo=_IST)
    mock = WeatherContext(**{
        **_weather(planned_start.astimezone(UTC), probability=95).__dict__,
        "source": WeatherSource.MOCK,
    })
    adapter = FakeWeatherAdapter(current=mock, forecasts=[mock])
    itinerary = _itinerary(seeded_ids["experience_id"], planned_start)

    async def _run():
        async with session_factory() as session:
            return await get_itinerary_weather_advisories(
                itinerary=itinerary,
                session=session,
                settings=Settings(),
                weather_adapter=adapter,
                now=datetime(2026, 10, 3, 12, 0, tzinfo=UTC),
            )

    result = asyncio.run(_run())
    assert result.advisories[0].status == "UNKNOWN"
    assert result.advisories[0].source == "MOCK"
    assert "not a live forecast" in result.advisories[0].message


def test_same_day_past_stop_shows_current_weather_without_claiming_history(session_factory, seeded_ids) -> None:
    planned_start = datetime(2026, 10, 4, 9, 10, tzinfo=_IST)
    now = datetime(2026, 10, 4, 13, 0, tzinfo=_IST)
    current = _weather(now.astimezone(UTC), probability=35)
    adapter = FakeWeatherAdapter(current=current, forecasts=[])
    itinerary = _itinerary(seeded_ids["experience_id"], planned_start)

    async def _run():
        async with session_factory() as session:
            return await get_itinerary_weather_advisories(
                itinerary=itinerary,
                session=session,
                settings=Settings(),
                weather_adapter=adapter,
                now=now,
            )

    result = asyncio.run(_run())
    advisory = result.advisories[0]
    assert advisory.status == "CURRENT"
    assert advisory.source == "LIVE"
    assert advisory.check_basis == "CURRENT_AT_LOCATION"
    assert advisory.condition == current.condition
    assert "not historical" in advisory.message
    assert adapter.current_calls == 1
    assert adapter.forecast_calls == 0


def test_earlier_date_does_not_mislabel_current_weather_as_historical(session_factory, seeded_ids) -> None:
    planned_start = datetime(2026, 10, 3, 9, 10, tzinfo=_IST)
    adapter = FakeWeatherAdapter(
        current=_weather(datetime(2026, 10, 4, 8, 0, tzinfo=UTC), probability=0),
        forecasts=[],
    )
    itinerary = _itinerary(seeded_ids["experience_id"], planned_start)

    async def _run():
        async with session_factory() as session:
            return await get_itinerary_weather_advisories(
                itinerary=itinerary,
                session=session,
                settings=Settings(),
                weather_adapter=adapter,
                now=datetime(2026, 10, 4, 13, 0, tzinfo=_IST),
            )

    result = asyncio.run(_run())
    advisory = result.advisories[0]
    assert advisory.status == "UNKNOWN"
    assert advisory.source == "UNAVAILABLE"
    assert "Historical weather" in advisory.message
    assert adapter.current_calls == 0


def test_background_monitor_checks_each_stop_at_its_own_fifteen_minute_window(session_factory, seeded_ids) -> None:
    first_start = datetime(2026, 10, 4, 17, 0, tzinfo=_IST)
    second_start = datetime(2026, 10, 4, 19, 0, tzinfo=_IST)
    first = _itinerary(seeded_ids["experience_id"], first_start).items[0]
    first.id = "weather-item-first"
    second = ItineraryItem(
        id="weather-item-second",
        itinerary_id="weather-itinerary-1",
        experience_id=seeded_ids["experience_id"],
        sequence_order=2,
        planned_start=second_start,
        planned_end=second_start + timedelta(hours=1),
        duration_minutes=60,
        buffer_before_minutes=0,
        buffer_after_minutes=0,
        is_locked=False,
        item_state="ACTIVE",
    )
    itinerary = _itinerary(seeded_ids["experience_id"], first_start)
    itinerary.items = [first, second]
    now = [datetime(2026, 10, 4, 16, 44, tzinfo=_IST)]
    adapter = FakeWeatherAdapter(
        current=_weather(first_start.astimezone(UTC), probability=0),
        forecasts=[],
    )
    monitor = ContextMonitor(
        settings=Settings(weather_monitor_interval_seconds=600),
        session_factory=session_factory,
        weather_adapter=adapter,
        event_adapter=SeedEventAdapter(),
        clock=lambda: now[0],
    )

    async def _run() -> None:
        async with session_factory() as session:
            await monitor.check_itinerary_weather(session, itinerary)
            assert adapter.current_calls == 0
            now[0] = datetime(2026, 10, 4, 16, 45, tzinfo=_IST)
            await monitor.check_itinerary_weather(session, itinerary)
            assert adapter.current_calls == 1
            now[0] = datetime(2026, 10, 4, 16, 50, tzinfo=_IST)
            await monitor.check_itinerary_weather(session, itinerary)
            assert adapter.current_calls == 1
            now[0] = datetime(2026, 10, 4, 18, 45, tzinfo=_IST)
            await monitor.check_itinerary_weather(session, itinerary)
            assert adapter.current_calls == 2

    asyncio.run(_run())
