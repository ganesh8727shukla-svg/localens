import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiItinerary, ItineraryWeatherResponse } from "@/types/api";

const { getItineraryWeatherMock } = vi.hoisted(() => ({ getItineraryWeatherMock: vi.fn() }));

vi.mock("@/lib/api/context", () => ({ getItineraryWeather: getItineraryWeatherMock }));
vi.mock("@/components/trip/TripAddOnsPanel", () => ({
  TripAddOnsPanel: ({ heading, intro, origin, radiusKm, onItineraryUpdated }: {
    heading: string;
    intro: string;
    origin: { latitude: number; longitude: number };
    radiusKm: number;
    onItineraryUpdated: (itinerary: ApiItinerary) => void;
  }) => (
    <div>
      <p>{heading}</p>
      <p>{intro}</p>
      <p>{origin.latitude},{origin.longitude} · {radiusKm} km</p>
      <button type="button" onClick={() => onItineraryUpdated({ ...itinerary, version: 2 })}>Add selected place</button>
    </div>
  ),
}));

import { ItineraryWeatherPanel } from "@/components/trip/ItineraryWeatherPanel";

const itinerary = {
  id: "trip-1",
  status: "VALIDATED",
  itinerary_date: "2026-10-04",
} as unknown as ApiItinerary;

const makeResponse = (status: "CAUTION" | "UNSUITABLE" | "GOOD" | "UNKNOWN", plannedStart = "2026-10-04T10:00:00+05:30"): ItineraryWeatherResponse => ({
  itinerary_id: "trip-1",
  generated_at: "2026-10-03T12:00:00Z",
  advisories: [{
    item_id: "item-1",
    title: "Outdoor walk",
    planned_start: plannedStart,
    planned_end: "2026-10-04T11:00:00+05:30",
    latitude: 19.05,
    longitude: 72.89,
    forecast_at: "2026-10-04T10:00:00+05:30",
    checked_at: "2026-10-03T12:00:00+05:30",
    check_basis: "PLANNED_FORECAST",
    status,
    source: "LIVE",
    condition: "Rain",
    temperature_c: 26,
    precipitation_probability: 80,
    precipitation_amount: 5,
    wind_speed: 2,
    severe_alert: false,
    reasons: ["Heavy rain expected"],
    message: "Weather may affect this stop. Consider an indoor option or a time change.",
  }],
});

let root: Root | null = null;
let container: HTMLDivElement;

async function renderPanel(response: ItineraryWeatherResponse, onItineraryUpdated = vi.fn()) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  getItineraryWeatherMock.mockResolvedValue(response);
  await act(async () => root?.render(<ItineraryWeatherPanel itinerary={itinerary} onItineraryUpdated={onItineraryUpdated} />));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  return onItineraryUpdated;
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  getItineraryWeatherMock.mockReset();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
});

describe("ItineraryWeatherPanel weather alternatives", () => {
  it("opens nearby places at the affected stop and reports a saved itinerary", async () => {
    getItineraryWeatherMock.mockResolvedValue(makeResponse("UNSUITABLE"));
    const onItineraryUpdated = vi.fn();
    await renderPanel(makeResponse("UNSUITABLE"), onItineraryUpdated);

    const findButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Find nearby places"));
    expect(findButton).toBeDefined();
    expect(container.textContent).toContain("Review plan changes");

    await act(async () => {
      findButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).toContain("Nearby places");
    expect(container.textContent).toContain("19.05,72.89 · 3 km");
    expect(container.textContent).toContain("within 3 km");

    const addButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Add selected place"));
    await act(async () => {
      addButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onItineraryUpdated).toHaveBeenCalledWith(expect.objectContaining({ version: 2 }));
  });

  it("does not show change actions for a suitable forecast", async () => {
    getItineraryWeatherMock.mockResolvedValue(makeResponse("GOOD"));
    await renderPanel(makeResponse("GOOD"));
    expect(container.textContent).not.toContain("Find nearby places");
    expect(container.textContent).not.toContain("Review plan changes");
  });

  it("distinguishes known forecast data from unknown venue suitability", async () => {
    const response = makeResponse("UNKNOWN");
    response.advisories[0].condition = "Clear";
    response.advisories[0].message = "Forecast data is available, but this venue has no verified weather-sensitivity profile.";
    await renderPanel(response);
    expect(container.textContent).toContain("Forecast available · impact unknown");
    expect(container.textContent).toContain("Clear · 26°C");
    expect(container.textContent).not.toContain("Weather unknown");
  });

  it("shows a ready-to-explore notification shortly before a suitable stop", async () => {
    const startsSoon = new Date(Date.now() + 10 * 60_000).toISOString();
    await renderPanel(makeResponse("GOOD", startsSoon));
    expect(container.textContent).toContain("Ready to explore Outdoor walk?");
    expect(container.textContent).toContain("Weather looks suitable.");
  });
});
