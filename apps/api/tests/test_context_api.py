from __future__ import annotations

from src.adapters.errors import AdapterUnavailableError
from src.core.context import get_weather_adapter
from tests.conftest import auth_header, register_traveler


class BrokenWeatherAdapter:
    async def get_current(self, lat: float, lng: float):
        raise AdapterUnavailableError("appid=weather-secret")

    async def get_forecast(self, lat: float, lng: float):
        raise AdapterUnavailableError("appid=weather-secret")


def test_weather_and_forecast_require_authentication(client) -> None:
    assert client.get("/api/v1/context/weather?lat=18.93&lng=72.83").status_code == 401
    assert client.get("/api/v1/context/weather/forecast?lat=18.93&lng=72.83").status_code == 401


def test_weather_and_forecast_return_normalized_mock_data(client) -> None:
    traveler = register_traveler(client, "weather-context@example.com")
    headers = auth_header(traveler)

    current = client.get("/api/v1/context/weather?lat=18.93&lng=72.83", headers=headers)
    assert current.status_code == 200
    current_body = current.json()
    assert current_body["context_status"] == "MOCK"
    assert current_body["source"] == "MOCK"
    assert current_body["weather_code"] == 800
    assert "fetched_at" in current_body
    assert "appid" not in current.text

    forecast = client.get(
        "/api/v1/context/weather/forecast?lat=18.93&lng=72.83&max_entries=1",
        headers=headers,
    )
    assert forecast.status_code == 200
    assert len(forecast.json()) == 1
    assert forecast.json()[0]["latitude"] == 18.93
    assert forecast.json()[0]["longitude"] == 72.83
    assert forecast.json()[0]["context_status"] == "MOCK"


def test_explicit_weather_refresh_uses_adapter_refresh_method(client) -> None:
    traveler = register_traveler(client, "weather-refresh@example.com")
    headers = auth_header(traveler)
    current = client.get("/api/v1/context/weather?lat=18.93&lng=72.83&refresh=true", headers=headers)
    forecast = client.get("/api/v1/context/weather/forecast?lat=18.93&lng=72.83&refresh=true", headers=headers)
    assert current.status_code == 200
    assert current.json()["context_status"] == "MOCK"
    assert forecast.status_code == 200
    assert forecast.json()[0]["context_status"] == "MOCK"


def test_forecast_limit_is_validated(client) -> None:
    traveler = register_traveler(client, "weather-limit@example.com")
    response = client.get(
        "/api/v1/context/weather/forecast?lat=18.93&lng=72.83&max_entries=41",
        headers=auth_header(traveler),
    )
    assert response.status_code == 422


def test_weather_provider_errors_do_not_leak_provider_details(client) -> None:
    traveler = register_traveler(client, "weather-error@example.com")
    headers = auth_header(traveler)
    client.app.dependency_overrides[get_weather_adapter] = lambda: BrokenWeatherAdapter()

    current = client.get("/api/v1/context/weather?lat=18.93&lng=72.83", headers=headers)
    assert current.status_code == 200
    assert current.json()["context_status"] == "UNAVAILABLE"
    assert "weather-secret" not in current.text

    forecast = client.get("/api/v1/context/weather/forecast?lat=18.93&lng=72.83", headers=headers)
    assert forecast.status_code == 503
    assert "weather-secret" not in forecast.text
