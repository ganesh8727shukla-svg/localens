import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WeatherContextResponse, WeatherForecastEntry, WeatherTestScenario } from "@/types/api";

const { getWeatherContextMock, getWeatherForecastMock } = vi.hoisted(() => ({
  getWeatherContextMock: vi.fn(),
  getWeatherForecastMock: vi.fn(),
}));

vi.mock("@/lib/api/context", () => ({
  getWeatherContext: getWeatherContextMock,
  getWeatherForecast: getWeatherForecastMock,
}));

import { WeatherCard } from "@/components/context/WeatherCard";

const stamp = "2026-09-27T09:00:00Z";
const weather: WeatherContextResponse = {
  latitude: 18.93,
  longitude: 72.83,
  observed_at: stamp,
  timezone: null,
  timezone_offset_seconds: null,
  temperature_c: 27,
  feels_like_c: null,
  humidity: 60,
  wind_speed: 3,
  precipitation_probability: null,
  precipitation_amount: null,
  weather_code: 800,
  condition: "Clear",
  visibility_km: 10,
  severe_alert: false,
  source: "MOCK",
  context_status: "MOCK",
  last_updated_at: stamp,
  fetched_at: stamp,
  expires_at: stamp,
};
const forecast: WeatherForecastEntry = {
  ...weather,
  forecast_at: stamp,
};

let root: Root | null = null;
let container: HTMLDivElement;

async function renderCard(latitude: number | null = 18.93, longitude: number | null = 72.83) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<WeatherCard latitude={latitude} longitude={longitude} locationLabel="Fort" />);
  });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  getWeatherContextMock.mockReset();
  getWeatherForecastMock.mockReset();
  getWeatherContextMock.mockResolvedValue(weather);
  getWeatherForecastMock.mockResolvedValue([forecast]);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
});

describe("WeatherCard", () => {
  it("shows explicitly labelled demo conditions and forecast values", async () => {
    await renderCard();
    expect(container.textContent).toContain("Development mock");
    expect(container.textContent).toContain("Weather near Fort");
    expect(container.textContent).toContain("27°C");
    expect(container.textContent).toContain("Upcoming 3-hour forecast");
    expect(getWeatherContextMock).toHaveBeenCalledWith(18.93, 72.83, expect.any(AbortSignal), undefined, false);
  });

  it("refetches and visibly changes for each development scenario returned by the API client", async () => {
    const scenarios: { name: WeatherTestScenario; temperature: number; condition: string }[] = [
      { name: "SCENARIO_CLEAR", temperature: 28, condition: "Clear" },
      { name: "SCENARIO_RAIN", temperature: 26, condition: "Rain" },
      { name: "SCENARIO_STORM", temperature: 24, condition: "Thunderstorm" },
      { name: "SCENARIO_HEAT", temperature: 40, condition: "Clear" },
    ];
    getWeatherContextMock.mockImplementation((_lat, _lng, _signal, scenario: WeatherTestScenario | undefined) => {
      const selected = scenarios.find((entry) => entry.name === scenario);
      return Promise.resolve(selected
        ? { ...weather, temperature_c: selected.temperature, condition: selected.condition, source: "MOCK", context_status: "MOCK" }
        : weather);
    });
    getWeatherForecastMock.mockResolvedValue([forecast]);

    await renderCard();
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Weather test scenario"]');
    expect(select).not.toBeNull();

    for (const scenario of scenarios) {
      await act(async () => {
        select!.value = scenario.name;
        select!.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(container.textContent).toContain(`${scenario.temperature}°C`);
      expect(container.textContent).toContain(scenario.condition);
      expect(container.textContent).toContain(`${scenario.name} is a temporary test input returned as MOCK`);
      expect(getWeatherContextMock).toHaveBeenLastCalledWith(
        18.93,
        72.83,
        expect.any(AbortSignal),
        scenario.name,
      );
    }
  });

  it("does not call weather APIs when verified coordinates are missing", async () => {
    await renderCard(null, null);
    expect(container.textContent).toContain("no verified stop coordinates");
    expect(getWeatherContextMock).not.toHaveBeenCalled();
    expect(getWeatherForecastMock).not.toHaveBeenCalled();
  });

  it("shows a graceful unavailable state when the current weather request fails", async () => {
    getWeatherContextMock.mockRejectedValue(new Error("network"));
    await renderCard();
    expect(container.textContent).toContain("Current weather is unavailable right now");
    expect(container.textContent).toContain("Weather unavailable");
  });
});
