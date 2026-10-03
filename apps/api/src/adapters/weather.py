"""WeatherAdapter — real implementation using OpenWeather (Phase 9).

Uses OpenWeather's "Current Weather Data" and "5 Day / 3 Hour Forecast"
REST endpoints (api.openweathermap.org/data/2.5/weather and /forecast) —
the free/standard-tier product this codebase can plausibly rely on
without a paid One Call 3.0 subscription. Only fields those two endpoints
actually return are ever populated on WeatherContext; anything the
provider doesn't give is left None rather than fabricated (see
docs/DECISIONS.md Phase 9 ADRs).

Same adapter pattern as src/adapters/routing.py (OSRM) and
src/adapters/geocoding.py (Nominatim): shared httpx client
(src/core/http_client.py), IntervalRateLimiter, TTLCache keyed on
lat/lng/time-bucket, typed error hierarchy (src/adapters/errors.py).

Server-side key only — OPENWEATHER_API_KEY is read from Settings and
never sent to the frontend or embedded in any client-facing response.

Live provider availability depends on server configuration and is not
asserted by the automated unit suite. Tests use a fake HTTP client for
deterministic coverage (tests/test_weather_adapter.py), following the
same mocked-response pattern as test_geocoding_adapter.py and
test_routing_adapter.py.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, Protocol

import httpx

from src.adapters.errors import AdapterRateLimitedError, AdapterUnavailableError
from src.core.cache import TTLCache
from src.core.config import Settings
from src.core.http_client import get_http_client
from src.core.rate_limit import IntervalRateLimiter


class WeatherSource(StrEnum):
    LIVE = "LIVE"
    CACHED = "CACHED"
    MOCK = "MOCK"
    UNAVAILABLE = "UNAVAILABLE"


@dataclass(frozen=True)
class WeatherContext:
    """Normalized weather snapshot. Only fields OpenWeather's Current
    Weather Data / Forecast endpoints actually provide — never a
    fabricated field. `source` distinguishes LIVE/CACHED/MOCK/UNAVAILABLE
    explicitly so nothing downstream can present stale/mock data as live.
    """

    latitude: float
    longitude: float
    observed_at: datetime | None
    timezone: str | None
    temperature_c: float | None
    feels_like_c: float | None
    humidity: float | None
    wind_speed: float | None
    precipitation_probability: float | None
    precipitation_amount: float | None
    weather_code: int | None
    condition: str | None
    visibility_km: float | None
    severe_alert: bool
    source: WeatherSource
    source_timestamp: datetime | None
    fetched_at: datetime
    expires_at: datetime
    # OpenWeather provides a numeric UTC offset rather than an IANA timezone.
    # Preserve it so clients can render the provider's local forecast times.
    timezone_offset_seconds: int | None = None


class WeatherAdapter(Protocol):
    async def get_current(self, lat: float, lng: float) -> WeatherContext: ...

    async def get_forecast(self, lat: float, lng: float) -> list[WeatherContext]: ...

    async def refresh_current(self, lat: float, lng: float) -> WeatherContext: ...

    async def refresh_forecast(self, lat: float, lng: float) -> list[WeatherContext]: ...


def _time_bucket(seconds_since_epoch: float, bucket_seconds: int) -> int:
    return int(seconds_since_epoch // bucket_seconds)


# Weather codes >= this threshold in OpenWeather's "id" grouping are
# thunderstorm (2xx) or extreme (9xx codes like 900-906, 958-962, 771,
# 781); OpenWeather's own condition-code table groups severe weather as
# ids in [200,299] (thunderstorm) or [900,906] / [957,962] (extreme/
# tornado/hurricane). We flag severe conservatively from documented
# ranges only, never guessed thresholds.
_SEVERE_CODE_RANGES = [(200, 299), (900, 906), (957, 962)]


def _is_severe_code(code: int | None) -> bool:
    if code is None:
        return False
    return any(lo <= code <= hi for lo, hi in _SEVERE_CODE_RANGES)


def _parse_current(payload: dict[str, Any], *, fetched_at: datetime, ttl_seconds: float) -> WeatherContext:
    coord = payload.get("coord") or {}
    main = payload.get("main") or {}
    wind = payload.get("wind") or {}
    weather_list = payload.get("weather") or []
    weather0 = weather_list[0] if weather_list else {}
    rain = payload.get("rain") or {}
    snow = payload.get("snow") or {}
    precip_amount = None
    if isinstance(rain, dict) and rain.get("1h") is not None:
        precip_amount = float(rain["1h"])
    elif isinstance(snow, dict) and snow.get("1h") is not None:
        precip_amount = float(snow["1h"])

    dt_raw = payload.get("dt")
    observed_at = datetime.fromtimestamp(dt_raw, tz=UTC) if isinstance(dt_raw, (int, float)) else None
    visibility_m = payload.get("visibility")
    weather_code = weather0.get("id")

    return WeatherContext(
        latitude=float(coord.get("lat")) if coord.get("lat") is not None else float("nan"),
        longitude=float(coord.get("lon")) if coord.get("lon") is not None else float("nan"),
        observed_at=observed_at,
        timezone=None,  # Current Weather Data returns a UTC offset in seconds
        # under "timezone", not an IANA name — deliberately not mapped to
        # avoid fabricating a timezone name OpenWeather doesn't give us.
        temperature_c=float(main["temp"]) if main.get("temp") is not None else None,
        feels_like_c=float(main["feels_like"]) if main.get("feels_like") is not None else None,
        humidity=float(main["humidity"]) if main.get("humidity") is not None else None,
        wind_speed=float(wind["speed"]) if wind.get("speed") is not None else None,
        precipitation_probability=None,  # not provided by Current Weather Data
        precipitation_amount=precip_amount,
        weather_code=weather_code,
        condition=weather0.get("main"),
        visibility_km=(visibility_m / 1000.0) if isinstance(visibility_m, (int, float)) else None,
        severe_alert=_is_severe_code(weather_code),
        source=WeatherSource.LIVE,
        source_timestamp=observed_at,
        fetched_at=fetched_at,
        expires_at=datetime.fromtimestamp(fetched_at.timestamp() + ttl_seconds, tz=UTC),
        timezone_offset_seconds=(int(payload["timezone"]) if isinstance(payload.get("timezone"), (int, float)) else None),
    )


def _parse_forecast_entry(
    entry: dict[str, Any], *, fetched_at: datetime, ttl_seconds: float, timezone_offset_seconds: int | None = None
) -> WeatherContext:
    main = entry.get("main") or {}
    wind = entry.get("wind") or {}
    weather_list = entry.get("weather") or []
    weather0 = weather_list[0] if weather_list else {}
    rain = entry.get("rain") or {}
    snow = entry.get("snow") or {}
    precip_amount = None
    if isinstance(rain, dict) and rain.get("3h") is not None:
        precip_amount = float(rain["3h"])
    elif isinstance(snow, dict) and snow.get("3h") is not None:
        precip_amount = float(snow["3h"])

    dt_raw = entry.get("dt")
    observed_at = datetime.fromtimestamp(dt_raw, tz=UTC) if isinstance(dt_raw, (int, float)) else None
    pop = entry.get("pop")  # "probability of precipitation" 0..1, forecast-only field
    weather_code = weather0.get("id")

    return WeatherContext(
        latitude=float("nan"),
        longitude=float("nan"),
        observed_at=observed_at,
        timezone=None,
        temperature_c=float(main["temp"]) if main.get("temp") is not None else None,
        feels_like_c=float(main["feels_like"]) if main.get("feels_like") is not None else None,
        humidity=float(main["humidity"]) if main.get("humidity") is not None else None,
        wind_speed=float(wind["speed"]) if wind.get("speed") is not None else None,
        precipitation_probability=float(pop) * 100 if isinstance(pop, (int, float)) else None,
        precipitation_amount=precip_amount,
        weather_code=weather_code,
        condition=weather0.get("main"),
        visibility_km=(entry["visibility"] / 1000.0) if isinstance(entry.get("visibility"), (int, float)) else None,
        severe_alert=_is_severe_code(weather_code),
        source=WeatherSource.LIVE,
        source_timestamp=observed_at,
        fetched_at=fetched_at,
        expires_at=datetime.fromtimestamp(fetched_at.timestamp() + ttl_seconds, tz=UTC),
        timezone_offset_seconds=timezone_offset_seconds,
    )


class MockWeatherAdapter:
    """Deterministic, no-network fallback for tests/dev. Never returns a
    LIVE-labelled context — always MOCK, so no caller can mistake it for
    real data (docs/AI_CONTEXT.md adapter fallback contract)."""

    async def get_current(self, lat: float, lng: float) -> WeatherContext:
        now = datetime.now(UTC)
        return WeatherContext(
            latitude=lat,
            longitude=lng,
            observed_at=now,
            timezone=None,
            temperature_c=27.0,
            feels_like_c=29.0,
            humidity=60.0,
            wind_speed=3.0,
            precipitation_probability=10.0,
            precipitation_amount=0.0,
            weather_code=800,
            condition="Clear",
            visibility_km=10.0,
            severe_alert=False,
            source=WeatherSource.MOCK,
            source_timestamp=now,
            fetched_at=now,
            expires_at=now,
        )

    async def get_forecast(self, lat: float, lng: float) -> list[WeatherContext]:
        current = await self.get_current(lat, lng)
        return [current]

    async def refresh_current(self, lat: float, lng: float) -> WeatherContext:
        return await self.get_current(lat, lng)

    async def refresh_forecast(self, lat: float, lng: float) -> list[WeatherContext]:
        return await self.get_forecast(lat, lng)


class OpenWeatherAdapter:
    """Real OpenWeather adapter. Current Weather Data:
    GET /data/2.5/weather?lat={lat}&lon={lng}&appid={key}&units=metric
    5 Day / 3 Hour Forecast:
    GET /data/2.5/forecast?lat={lat}&lon={lng}&appid={key}&units=metric

    401 -> invalid/missing key (AdapterUnavailableError, never silently
    downgraded to a fabricated forecast). 429 -> AdapterRateLimitedError.
    5xx/timeout/malformed JSON -> AdapterUnavailableError. Never raises for
    a genuinely empty successful response — that case does not exist for
    these two endpoints (a coordinate always has *some* current weather),
    but any unexpected empty/malformed body is still treated as
    unavailable rather than guessed at.
    """

    _BASE_URL = "https://api.openweathermap.org/data/2.5"

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._limiter = IntervalRateLimiter(settings.weather_min_interval_seconds)
        self._cache: TTLCache[WeatherContext] = TTLCache(settings.weather_cache_ttl_seconds)
        self._forecast_cache: TTLCache[list[WeatherContext]] = TTLCache(settings.weather_cache_ttl_seconds)

    def _cache_key(self, prefix: str, lat: float, lng: float) -> str:
        bucket = _time_bucket(time.time(), max(1, int(self._settings.weather_cache_ttl_seconds)))
        # Round coordinates to ~1.1km precision (2 decimal places) so
        # nearby lookups within the same time bucket share a cache entry.
        return f"{prefix}:{round(lat, 2)}:{round(lng, 2)}:{bucket}"

    async def _request(self, path: str, lat: float, lng: float) -> dict[str, Any]:
        if not self._settings.openweather_api_key:
            raise AdapterUnavailableError("OPENWEATHER_API_KEY is not configured.")
        await self._limiter.wait()
        client = get_http_client()
        params = {
            "lat": lat,
            "lon": lng,
            "appid": self._settings.openweather_api_key,
            "units": "metric",
        }
        try:
            response = await client.get(
                f"{self._BASE_URL}{path}",
                params=params,
                timeout=httpx.Timeout(self._settings.weather_request_timeout_seconds),
            )
        except httpx.TimeoutException as exc:
            raise AdapterUnavailableError("OpenWeather request timed out") from exc
        except httpx.HTTPError as exc:
            raise AdapterUnavailableError(f"OpenWeather request failed: {exc}") from exc

        if response.status_code == 429:
            retry_after = response.headers.get("Retry-After")
            raise AdapterRateLimitedError(
                "OpenWeather rate limit exceeded",
                retry_after_seconds=float(retry_after) if retry_after else None,
            )
        if response.status_code in (401, 403):
            raise AdapterUnavailableError(f"OpenWeather authorization failed (HTTP {response.status_code})")
        if response.status_code >= 500:
            raise AdapterUnavailableError(f"OpenWeather returned HTTP {response.status_code}")
        if response.status_code >= 400:
            raise AdapterUnavailableError(f"OpenWeather returned HTTP {response.status_code}")

        try:
            body: dict[str, Any] = response.json()
        except ValueError as exc:
            raise AdapterUnavailableError("OpenWeather returned malformed JSON") from exc
        if not isinstance(body, dict):
            raise AdapterUnavailableError("OpenWeather returned an unexpected payload shape")
        return body

    async def get_current(self, lat: float, lng: float) -> WeatherContext:
        key = self._cache_key("current", lat, lng)
        cached = self._cache.get(key)
        if cached is not None:
            return WeatherContext(**{**cached.__dict__, "source": WeatherSource.CACHED})

        return await self._fetch_current(lat, lng, key)

    async def refresh_current(self, lat: float, lng: float) -> WeatherContext:
        """Bypass the TTL cache after an explicit user refresh request."""
        return await self._fetch_current(lat, lng, self._cache_key("current", lat, lng))

    async def _fetch_current(self, lat: float, lng: float, key: str) -> WeatherContext:
        body = await self._request("/weather", lat, lng)
        fetched_at = datetime.now(UTC)
        context = _parse_current(body, fetched_at=fetched_at, ttl_seconds=self._settings.weather_cache_ttl_seconds)
        # Store coordinates as requested (OpenWeather echoes rounded
        # coords in `coord`, which can differ slightly from the request).
        context = WeatherContext(**{**context.__dict__, "latitude": lat, "longitude": lng})
        self._cache.set(key, context)
        return context

    async def get_forecast(self, lat: float, lng: float) -> list[WeatherContext]:
        key = self._cache_key("forecast", lat, lng)
        cached = self._forecast_cache.get(key)
        if cached is not None:
            return [WeatherContext(**{**c.__dict__, "source": WeatherSource.CACHED}) for c in cached]

        return await self._fetch_forecast(lat, lng, key)

    async def refresh_forecast(self, lat: float, lng: float) -> list[WeatherContext]:
        """Bypass the TTL cache after an explicit user refresh request."""
        return await self._fetch_forecast(lat, lng, self._cache_key("forecast", lat, lng))

    async def _fetch_forecast(self, lat: float, lng: float, key: str) -> list[WeatherContext]:
        body = await self._request("/forecast", lat, lng)
        fetched_at = datetime.now(UTC)
        entries = body.get("list") or []
        city = body.get("city") if isinstance(body.get("city"), dict) else {}
        timezone_offset = city.get("timezone") if isinstance(city, dict) else None
        timezone_offset_seconds = int(timezone_offset) if isinstance(timezone_offset, (int, float)) else None
        contexts = [
            WeatherContext(
                **{
                    **_parse_forecast_entry(
                        e,
                        fetched_at=fetched_at,
                        ttl_seconds=self._settings.weather_cache_ttl_seconds,
                        timezone_offset_seconds=timezone_offset_seconds,
                    ).__dict__,
                    "latitude": lat,
                    "longitude": lng,
                }
            )
            for e in entries
            if isinstance(e, dict)
        ]
        self._forecast_cache.set(key, contexts)
        return contexts


def unavailable_context(lat: float, lng: float) -> WeatherContext:
    """Explicit UNAVAILABLE marker — used when live fetch fails and no
    fresh cache entry exists. Never fabricates live data; downstream
    logic (WeatherImpactService) must treat this as WEATHER_UNKNOWN, not
    as evidence of good or bad conditions."""
    now = datetime.now(UTC)
    return WeatherContext(
        latitude=lat,
        longitude=lng,
        observed_at=None,
        timezone=None,
        temperature_c=None,
        feels_like_c=None,
        humidity=None,
        wind_speed=None,
        precipitation_probability=None,
        precipitation_amount=None,
        weather_code=None,
        condition=None,
        visibility_km=None,
        severe_alert=False,
        source=WeatherSource.UNAVAILABLE,
        source_timestamp=None,
        fetched_at=now,
        expires_at=now,
    )


__all__ = [
    "MockWeatherAdapter",
    "OpenWeatherAdapter",
    "WeatherAdapter",
    "WeatherContext",
    "WeatherSource",
    "unavailable_context",
]
