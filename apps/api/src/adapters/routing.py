"""RoutingAdapter interface — OSRM.

OSRM's public demo server (router.project-osrm.org) fair-use policy:
reasonable non-commercial use, ~1 req/sec, no uptime/freshness guarantee
— self-enforced via IntervalRateLimiter, see docs/DECISIONS.md ADR-022.

Coordinates are passed to OSRM as "lng,lat" (OSRM's own convention,
opposite of the lat/lng order used everywhere else in this codebase) —
that swap happens only inside this adapter.

Only `OSRM_ALLOWED_PROFILES` may be requested; an unsupported profile is
a typed error, not a silent fallback to a different profile.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

import httpx

from src.adapters.errors import AdapterNoResultError, AdapterUnavailableError
from src.core.cache import TTLCache
from src.core.config import Settings
from src.core.geo import haversine_km
from src.core.http_client import get_http_client
from src.core.rate_limit import IntervalRateLimiter


@dataclass(frozen=True)
class RouteResult:
    distance_km: float
    duration_minutes: float
    geometry: dict[str, Any] | None  # GeoJSON LineString, when requested
    source: str  # "osrm" | "haversine_estimate"


@dataclass(frozen=True)
class MatrixEntry:
    id: str
    distance_km: float | None
    duration_minutes: float | None
    source: str = "unknown"


class RoutingAdapter(Protocol):
    async def get_route(
        self,
        origin: tuple[float, float],
        destination: tuple[float, float],
        *,
        profile: str,
        include_geometry: bool = False,
    ) -> RouteResult: ...

    async def get_route_alternatives(
        self,
        origin: tuple[float, float],
        destination: tuple[float, float],
        *,
        profile: str,
    ) -> list[RouteResult]: ...

    async def get_travel_time_matrix(
        self, origin: tuple[float, float], destinations: list[tuple[str, float, float]], *, profile: str
    ) -> list[MatrixEntry]: ...


class MockRoutingAdapter:
    """Used when OSRM is disabled/unreachable. Falls back to an explicitly
    labelled Haversine estimate rather than pretending to have a route."""

    async def get_route(
        self,
        origin: tuple[float, float],
        destination: tuple[float, float],
        *,
        profile: str,
        include_geometry: bool = False,
    ) -> RouteResult:
        distance = haversine_km(origin[0], origin[1], destination[0], destination[1])
        # ~25 km/h blended local-travel assumption for a labelled estimate only.
        duration = (distance / 25) * 60
        return RouteResult(distance_km=distance, duration_minutes=duration, geometry=None, source="haversine_estimate")

    async def get_route_alternatives(
        self,
        origin: tuple[float, float],
        destination: tuple[float, float],
        *,
        profile: str,
    ) -> list[RouteResult]:
        # Estimates have no road geometry and must not be presented as route options.
        return []

    async def get_travel_time_matrix(
        self, origin: tuple[float, float], destinations: list[tuple[str, float, float]], *, profile: str
    ) -> list[MatrixEntry]:
        entries = []
        for dest_id, lat, lng in destinations:
            distance = haversine_km(origin[0], origin[1], lat, lng)
            duration = (distance / 25) * 60
            entries.append(MatrixEntry(
                id=dest_id,
                distance_km=round(distance, 2),
                duration_minutes=round(duration, 1),
                source="haversine_estimate",
            ))
        return entries


class OSRMRoutingAdapter:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._limiter = IntervalRateLimiter(settings.osrm_min_interval_seconds)
        self._route_cache: TTLCache[RouteResult] = TTLCache(settings.osrm_cache_ttl_seconds)
        self._matrix_cache: TTLCache[list[MatrixEntry]] = TTLCache(settings.osrm_cache_ttl_seconds)

    def _check_profile(self, profile: str) -> None:
        if profile not in self._settings.osrm_allowed_profiles:
            raise ValueError(
                f"Routing profile '{profile}' is not in the configured allowlist "
                f"{self._settings.osrm_allowed_profiles}"
            )

    async def _request(self, path: str, params: dict[str, Any]) -> dict[str, Any]:
        await self._limiter.wait()
        client = get_http_client()
        try:
            response = await client.get(f"{self._settings.osrm_base_url}{path}", params=params)
        except httpx.TimeoutException as exc:
            raise AdapterUnavailableError("OSRM request timed out") from exc
        except httpx.HTTPError as exc:
            raise AdapterUnavailableError(f"OSRM request failed: {exc}") from exc

        if response.status_code >= 400:
            raise AdapterUnavailableError(f"OSRM returned HTTP {response.status_code}")
        try:
            body: dict[str, Any] = response.json()
        except ValueError as exc:
            raise AdapterUnavailableError("OSRM returned malformed JSON") from exc

        if body.get("code") not in ("Ok", None):
            raise AdapterNoResultError(f"OSRM: {body.get('code')} — {body.get('message', '')}")
        return body

    async def get_route(
        self,
        origin: tuple[float, float],
        destination: tuple[float, float],
        *,
        profile: str,
        include_geometry: bool = False,
    ) -> RouteResult:
        self._check_profile(profile)
        cache_key = f"route:{origin}:{destination}:{profile}:{include_geometry}"
        cached = self._route_cache.get(cache_key)
        if cached is not None:
            return cached

        # OSRM coordinate order is lng,lat.
        coords = f"{origin[1]},{origin[0]};{destination[1]},{destination[0]}"
        params = {
            "overview": "full" if include_geometry else "false",
            "geometries": "geojson",
        }
        body = await self._request(f"/route/v1/{profile}/{coords}", params)

        routes = body.get("routes") or []
        if not routes:
            raise AdapterNoResultError("OSRM found no route between the given points")

        route = routes[0]
        result = RouteResult(
            distance_km=round(route["distance"] / 1000, 3),
            duration_minutes=round(route["duration"] / 60, 2),
            geometry=route.get("geometry") if include_geometry else None,
            source="osrm",
        )
        self._route_cache.set(cache_key, result)
        return result

    async def get_route_alternatives(
        self,
        origin: tuple[float, float],
        destination: tuple[float, float],
        *,
        profile: str,
    ) -> list[RouteResult]:
        """Return additional real OSRM routes; they do not encode assumed closures."""
        self._check_profile(profile)
        coords = f"{origin[1]},{origin[0]};{destination[1]},{destination[0]}"
        body = await self._request(
            f"/route/v1/{profile}/{coords}",
            {"alternatives": "true", "overview": "full", "geometries": "geojson"},
        )
        routes = body.get("routes") or []
        # OSRM returns the fastest route first. The primary route is already
        # represented by the itinerary; only return additional route options.
        return [
            RouteResult(
                distance_km=round(route["distance"] / 1000, 3),
                duration_minutes=round(route["duration"] / 60, 2),
                geometry=route.get("geometry"),
                source="osrm",
            )
            for route in routes[1:4]
            if isinstance(route, dict)
            and isinstance(route.get("distance"), (int, float))
            and isinstance(route.get("duration"), (int, float))
            and isinstance(route.get("geometry"), dict)
            and route["geometry"].get("type") == "LineString"
        ]

    async def get_travel_time_matrix(
        self, origin: tuple[float, float], destinations: list[tuple[str, float, float]], *, profile: str
    ) -> list[MatrixEntry]:
        self._check_profile(profile)
        if not destinations:
            return []

        cache_key = f"matrix:{origin}:{tuple(destinations)}:{profile}"
        cached = self._matrix_cache.get(cache_key)
        if cached is not None:
            return cached

        # Origin is coordinate index 0; destinations follow. OSRM Table
        # service computes the whole matrix in one call instead of N
        # individual /route requests.
        all_coords = [origin] + [(lat, lng) for _, lat, lng in destinations]
        coords_str = ";".join(f"{lng},{lat}" for lat, lng in all_coords)
        params = {
            "sources": "0",
            "destinations": ";".join(str(i) for i in range(1, len(all_coords))),
            "annotations": "duration,distance",
        }
        body = await self._request(f"/table/v1/{profile}/{coords_str}", params)

        durations = (body.get("durations") or [[]])[0]
        distances = (body.get("distances") or [[]])[0]

        entries = []
        for index, (dest_id, _lat, _lng) in enumerate(destinations):
            duration_s = durations[index] if index < len(durations) else None
            distance_m = distances[index] if index < len(distances) else None
            entries.append(
                MatrixEntry(
                    id=dest_id,
                    distance_km=round(distance_m / 1000, 3) if distance_m is not None else None,
                    duration_minutes=round(duration_s / 60, 2) if duration_s is not None else None,
                    source="osrm",
                )
            )

        self._matrix_cache.set(cache_key, entries)
        return entries


__all__ = [
    "MatrixEntry",
    "MockRoutingAdapter",
    "OSRMRoutingAdapter",
    "RouteResult",
    "RoutingAdapter",
]
