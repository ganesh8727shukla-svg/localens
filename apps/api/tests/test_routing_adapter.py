from __future__ import annotations

import asyncio

import httpx
import pytest

from src.adapters.errors import AdapterNoResultError, AdapterUnavailableError
from src.adapters.routing import MockRoutingAdapter, OSRMRoutingAdapter
from src.core.config import Settings
from tests.adapter_fakes import FakeAsyncClient, make_response, sequence_responder

ROUTE_RESPONSE = {
    "code": "Ok",
    "routes": [
        {
            "distance": 1413.0,
            "duration": 121.2,
            "geometry": {"type": "LineString", "coordinates": [[72.8356, 18.9346], [72.8317, 18.9414]]},
        }
    ],
}

TABLE_RESPONSE = {
    # sources=0 & destinations=1;2 -> OSRM's response is a 1x2 matrix
    # (one row for the single source, one column per requested destination
    # — the origin itself is excluded since it's not in `destinations`).
    "code": "Ok",
    "durations": [[121.2, 349.0]],
    "distances": [[1413.0, 4501.0]],
}

ALTERNATIVE_ROUTE_RESPONSE = {
    "code": "Ok",
    "routes": [
        *ROUTE_RESPONSE["routes"],
        {
            "distance": 1850.0,
            "duration": 160.0,
            "geometry": {"type": "LineString", "coordinates": [[72.8356, 18.9346], [72.833, 18.937], [72.8317, 18.9414]]},
        },
    ],
}


def _settings() -> Settings:
    return Settings(osrm_min_interval_seconds=0.0)


def _install_fake_client(monkeypatch, fake: FakeAsyncClient) -> None:
    monkeypatch.setattr("src.adapters.routing.get_http_client", lambda: fake)


def test_route_response_parsed_correctly(monkeypatch) -> None:
    fake = FakeAsyncClient(sequence_responder([make_response(200, ROUTE_RESPONSE)]))
    _install_fake_client(monkeypatch, fake)

    adapter = OSRMRoutingAdapter(_settings())
    result = asyncio.run(
        adapter.get_route((18.9346, 72.8356), (18.9414, 72.8317), profile="driving")
    )

    assert result.distance_km == pytest.approx(1.413)
    assert result.duration_minutes == pytest.approx(2.02)
    assert result.source == "osrm"
    assert result.geometry is None  # include_geometry defaulted to False


def test_route_geometry_returned_when_requested(monkeypatch) -> None:
    fake = FakeAsyncClient(sequence_responder([make_response(200, ROUTE_RESPONSE)]))
    _install_fake_client(monkeypatch, fake)

    adapter = OSRMRoutingAdapter(_settings())
    result = asyncio.run(
        adapter.get_route((18.9346, 72.8356), (18.9414, 72.8317), profile="driving", include_geometry=True)
    )

    assert result.geometry is not None
    assert result.geometry["type"] == "LineString"


def test_osrm_alternative_routes_are_parsed_as_additional_geometry(monkeypatch) -> None:
    fake = FakeAsyncClient(sequence_responder([make_response(200, ALTERNATIVE_ROUTE_RESPONSE)]))
    _install_fake_client(monkeypatch, fake)

    adapter = OSRMRoutingAdapter(_settings())
    options = asyncio.run(
        adapter.get_route_alternatives((18.9346, 72.8356), (18.9414, 72.8317), profile="driving")
    )

    assert len(options) == 1
    assert options[0].source == "osrm"
    assert options[0].distance_km == pytest.approx(1.85)
    assert options[0].geometry["type"] == "LineString"
    assert fake.calls[0]["params"]["alternatives"] == "true"


def test_table_response_parsed_correctly(monkeypatch) -> None:
    fake = FakeAsyncClient(sequence_responder([make_response(200, TABLE_RESPONSE)]))
    _install_fake_client(monkeypatch, fake)

    adapter = OSRMRoutingAdapter(_settings())
    entries = asyncio.run(
        adapter.get_travel_time_matrix(
            (18.9346, 72.8356),
            [("a", 18.9414, 72.8317), ("b", 18.9067, 72.8147)],
            profile="driving",
        )
    )

    assert entries[0].id == "a"
    assert entries[0].distance_km == pytest.approx(1.413)
    assert entries[0].duration_minutes == pytest.approx(2.02)
    assert entries[1].id == "b"


def test_no_route_raises_typed_error(monkeypatch) -> None:
    fake = FakeAsyncClient(sequence_responder([make_response(200, {"code": "NoRoute", "message": "no route"})]))
    _install_fake_client(monkeypatch, fake)

    adapter = OSRMRoutingAdapter(_settings())
    with pytest.raises(AdapterNoResultError):
        asyncio.run(adapter.get_route((18.9346, 72.8356), (18.9414, 72.8317), profile="driving"))


def test_timeout_raises_typed_error(monkeypatch) -> None:
    def _raise(**_kwargs: object) -> None:
        raise httpx.TimeoutException("timed out")

    fake = FakeAsyncClient(_raise)
    _install_fake_client(monkeypatch, fake)

    adapter = OSRMRoutingAdapter(_settings())
    with pytest.raises(AdapterUnavailableError):
        asyncio.run(adapter.get_route((18.9346, 72.8356), (18.9414, 72.8317), profile="driving"))


def test_unsupported_profile_rejected() -> None:
    adapter = OSRMRoutingAdapter(_settings())
    with pytest.raises(ValueError):
        asyncio.run(adapter.get_route((18.9346, 72.8356), (18.9414, 72.8317), profile="teleport"))


def test_route_results_are_cached(monkeypatch) -> None:
    fake = FakeAsyncClient(sequence_responder([make_response(200, ROUTE_RESPONSE)]))
    _install_fake_client(monkeypatch, fake)

    adapter = OSRMRoutingAdapter(_settings())

    async def _twice() -> None:
        await adapter.get_route((18.9346, 72.8356), (18.9414, 72.8317), profile="driving")
        await adapter.get_route((18.9346, 72.8356), (18.9414, 72.8317), profile="driving")

    asyncio.run(_twice())
    assert len(fake.calls) == 1


def test_mock_adapter_fallback_is_labelled_estimate() -> None:
    adapter = MockRoutingAdapter()
    result = asyncio.run(adapter.get_route((18.9346, 72.8356), (18.9414, 72.8317), profile="driving"))

    assert result.source == "haversine_estimate"
    assert result.distance_km > 0
