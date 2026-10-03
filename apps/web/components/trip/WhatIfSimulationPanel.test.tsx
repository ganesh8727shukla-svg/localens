import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiItinerary } from "@/types/api";
import type { SimulationResult } from "@/types/digitalTwin";

const { applyMock, simulateMock } = vi.hoisted(() => ({
  applyMock: vi.fn(),
  simulateMock: vi.fn(),
}));

vi.mock("@/lib/api/digitalTwin", () => ({
  applyItineraryWhatIf: applyMock,
  simulateItineraryWhatIf: simulateMock,
}));

import { WhatIfSimulationPanel } from "@/components/trip/WhatIfSimulationPanel";

const itinerary = {
  id: "trip-1",
  title: "Mumbai day",
  items: [{
    id: "item-1",
    title: "Museum visit",
    sequence_order: 1,
    planned_start: "2026-10-01T10:00:00+05:30",
    location_latitude: 18.93,
    location_longitude: 72.83,
  }],
  custom_activities: [],
} as unknown as ApiItinerary;

const simulation = {
  simulation_id: "sim-1",
  status: "READY",
  created_at: "2026-09-27T12:00:00Z",
  expires_at: "2026-09-27T12:15:00Z",
  scenario_name: "Trip what-if preview",
  baseline: {
    snapshot_id: "snapshot-1",
    generated_at: "2026-09-27T12:00:00Z",
    timezone: "Asia/Kolkata",
    itinerary_id: "trip-1",
    itinerary_version: 1,
    itinerary_date: "2026-10-01",
    itinerary_status: "VALIDATED",
    traveler_context_available: false,
    plan: {
      stops: [{ item_id: "item-1", experience_id: "exp-1", sequence: 1, title: "Museum visit", planned_start: "2026-10-01T10:00:00+05:30", planned_end: "2026-10-01T11:00:00+05:30", state: "ACTIVE", locked: false, latitude: 18.93, longitude: 72.83, environmental_type: "indoor", weather_sensitivity: "low", weather_policy: "normal", provider_verification_status: "verified", is_synthetic: false }],
      weather: [],
      current_weather: [],
      social: { status: "NOT_REQUESTED", queried_location: null, generated_at: null, clusters: [], message: null },
      routes: [],
    },
  },
  scenario: {
    weather: [{ item_id: "item-1", condition: "Hypothetical heavy rain", temperature_c: 23, precipitation_probability: 85, precipitation_amount: 8, wind_speed: 2, visibility_km: 10, severe_alert: false, status: "HYPOTHETICAL", context_kind: "HYPOTHETICAL", observed_at: "2026-09-27T12:00:00Z", expires_at: null }],
    current_weather: [{ item_id: "item-1", condition: "Clear", temperature_c: 29, precipitation_probability: 0, precipitation_amount: 0, wind_speed: 2.5, visibility_km: 10, severe_alert: false, status: "LIVE", context_kind: "CURRENT", observed_at: "2026-09-27T12:00:00Z", expires_at: "2026-09-27T12:15:00Z" }],
    social: { status: "NOT_REQUESTED", queried_location: null, generated_at: null, clusters: [], message: null },
    routes: [],
    stops: [{ item_id: "item-1", experience_id: "exp-1", sequence: 1, title: "Museum visit", planned_start: "2026-10-01T10:00:00+05:30", planned_end: "2026-10-01T11:00:00+05:30", state: "ACTIVE", locked: false, latitude: 18.93, longitude: 72.83, environmental_type: "indoor", weather_sensitivity: "low", weather_policy: "normal", provider_verification_status: "verified", is_synthetic: false }],
  },
  delta: {
    affected_stop_count: 0,
    unchanged_stop_count: 1,
    affected_route_count: 0,
    additional_travel_minutes: null,
    change_level: "NO_CHANGE",
    summary: "No material change was identified from available evidence.",
  },
  impacts: [],
  alternatives: [],
  warnings: ["Preview only: no itinerary data was changed."],
  simulation_confidence_note: "Evidence completeness only.",
} as unknown as SimulationResult;

let root: Root | null = null;
let container: HTMLDivElement;

async function renderPanel() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<WhatIfSimulationPanel itinerary={itinerary} onApplied={vi.fn()} onResult={vi.fn()} />);
  });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  simulateMock.mockReset();
  applyMock.mockReset();
  simulateMock.mockResolvedValue(simulation);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
});

describe("WhatIfSimulationPanel", () => {
  it("keeps preview read-only until the traveler requests a simulation", async () => {
    await renderPanel();
    expect(container.textContent).toContain("What if?");
    expect(container.textContent).toContain("A preview never changes your trip.");
    expect(simulateMock).not.toHaveBeenCalled();

    const button = Array.from(container.querySelectorAll("button"))
      .find((candidate) => candidate.textContent?.includes("Run what-if preview"));
    expect(button).toBeDefined();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("The hypothetical values are the shared scenario input.");
    expect(container.textContent).toContain("Current at location: Clear");
    expect(simulateMock).toHaveBeenCalledWith("trip-1", expect.objectContaining({
      include_recent_social_context: false,
      horizon_hours: 72,
      experience_overrides: [],
    }), expect.any(AbortSignal));
    expect(container.textContent).toContain("NO CHANGE");
    expect(container.textContent).toContain("Preview only: no itinerary data was changed.");
    expect(container.textContent).toContain("Simulation details");
    expect(container.textContent).toContain("snapshot-1");
    expect(container.textContent).toContain("Stop-by-stop plan");
    expect(container.textContent).toContain("Museum visit");
    expect(container.textContent).toContain("Evidence completeness only.");
    expect(applyMock).not.toHaveBeenCalled();
  });
});
