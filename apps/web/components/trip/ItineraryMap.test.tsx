import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiItinerary, ApiItineraryItem, ItineraryCustomActivity } from "@/types/api";
import type { MapAnnotationCollection } from "@/types/map";
import type { NearbyPOI, RouteResponse } from "@/types/location";

const { getRouteMock, getNearbyPoisMock, getSocialSignalsMock } = vi.hoisted(() => ({
  getRouteMock: vi.fn(),
  getNearbyPoisMock: vi.fn(),
  getSocialSignalsMock: vi.fn(),
}));

vi.mock("@/components/common/MapSurface", () => ({
  MapSurface: (props: {
    annotations?: MapAnnotationCollection;
    routeGeometries?: GeoJSON.LineString[];
    fitBounds?: [[number, number], [number, number]] | null;
    fitBoundsRequestId?: number;
    focusRequestId?: number;
    label?: string;
    onSelectAnnotation?: (id: string) => void;
  }) => (
    <div role="img" aria-label={props.label}>
      <output data-testid="fit-request">{props.fitBoundsRequestId}</output>
      <output data-testid="focus-request">{props.focusRequestId}</output>
      <output data-testid="fit-bounds">{JSON.stringify(props.fitBounds)}</output>
      <output data-testid="route-count">{props.routeGeometries?.length ?? 0}</output>
      {props.annotations?.features.map((feature) => (
        <button
          type="button"
          key={feature.properties.id}
          aria-label={`Map marker ${feature.properties.title}`}
          onClick={() => props.onSelectAnnotation?.(feature.properties.id)}
        >
          {feature.properties.label}|{feature.properties.title}|{feature.properties.tone}|{String(feature.properties.affected)}|{feature.properties.description}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("@/components/context/WeatherCard", () => ({
  WeatherCard: ({ latitude, longitude, locationLabel }: { latitude: number | null; longitude: number | null; locationLabel: string }) => (
    <output data-testid="weather-target">{latitude ?? "none"},{longitude ?? "none"}:{locationLabel}</output>
  ),
}));

vi.mock("@/lib/api/location", () => ({
  getRoute: getRouteMock,
  getNearbyPois: getNearbyPoisMock,
}));

vi.mock("@/lib/api/social", () => ({ getSocialSignals: getSocialSignalsMock }));

import { ItineraryMap } from "@/components/trip/ItineraryMap";

const line: GeoJSON.LineString = {
  type: "LineString",
  coordinates: [[72.83, 18.93], [72.84, 18.94]],
};

function item(
  id: string,
  sequence_order: number,
  planned_start: string,
  latitude: number | null,
  longitude: number | null,
  item_state: string = "ACTIVE",
): ApiItineraryItem {
  return {
    id,
    experience_id: `experience-${id}`,
    sequence_order,
    planned_start,
    planned_end: new Date(Date.parse(planned_start) + 30 * 60_000).toISOString(),
    duration_minutes: 30,
    travel_from_previous_minutes: 12,
    travel_from_previous_distance_km: 2.3,
    travel_mode: "driving",
    buffer_before_minutes: 0,
    buffer_after_minutes: 0,
    estimated_cost: 100,
    source_rank_position: null,
    source_ranking_score: null,
    narrative_text: null,
    title: `Stop ${id}`,
    short_description: null,
    category_name: "Museum",
    location_place_name: `Place ${id}`,
    location_latitude: latitude,
    location_longitude: longitude,
    is_locked: id === "two",
    item_state,
  };
}

function personal(id: string, sequence_order: number, planned_start: string, latitude: number | null, longitude: number | null): ItineraryCustomActivity {
  return {
    id,
    sequence_order,
    title: `Personal ${id}`,
    kind: "place",
    note: null,
    location_text: `Personal location ${id}`,
    latitude,
    longitude,
    planned_start,
    planned_end: new Date(Date.parse(planned_start) + 30 * 60_000).toISOString(),
    duration_minutes: 30,
    estimated_cost: null,
  };
}

function makeItinerary(id = "trip-1", includeCustom = true): ApiItinerary {
  return {
    id,
    traveler_id: "traveler-1",
    title: "Fort afternoon",
    itinerary_date: "2026-09-27",
    start_time: "09:00:00",
    end_time: "14:00:00",
    status: "VALIDATED",
    source: "MANUAL",
    total_duration_minutes: 90,
    total_travel_minutes: 12,
    estimated_total_cost: 200,
    max_budget: null,
    currency: "INR",
    narrative_title: null,
    narrative_summary: null,
    narrative_closing_message: null,
    ranking_model_version: null,
    narrative_model_version: null,
    generated_at: null,
    created_at: "2026-09-27T00:00:00Z",
    updated_at: "2026-09-27T00:00:00Z",
    items: [
      item("one", 1, "2026-09-27T09:00:00Z", 18.93, 72.83),
      item("two", 2, "2026-09-27T10:00:00Z", 18.94, 72.84, "AFFECTED"),
    ],
    custom_activities: includeCustom
      ? [personal("three", 3, "2026-09-27T11:00:00Z", 18.95, 72.85)]
      : [],
    version: 1,
    replanning_status: "STABLE",
    context_last_updated_at: null,
  };
}

let root: Root | null = null;
let container: HTMLDivElement;

function renderMap(
  itinerary: ApiItinerary,
  selectedItemId: string | null,
  onSelectItem = vi.fn(),
  scenarioAffectedItemIds: string[] = [],
) {
  if (!root) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  act(() => root?.render(
    <ItineraryMap
      itinerary={itinerary}
      selectedItemId={selectedItemId}
      onSelectItem={onSelectItem}
      scenarioAffectedItemIds={scenarioAffectedItemIds}
    />,
  ));
  return { container, onSelectItem };
}

function clickButton(text: string) {
  const button = Array.from(container.querySelectorAll("button"))
    .find((candidate) => candidate.textContent?.includes(text));
  if (!button) throw new Error(`Button not found: ${text}`);
  button.click();
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  getRouteMock.mockReset();
  getNearbyPoisMock.mockReset();
  getSocialSignalsMock.mockReset();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
});

describe("ItineraryMap", () => {
  it("marks scenario impacts as hypothetical without changing backend affected state", () => {
    const { container: rendered } = renderMap(makeItinerary(), "one", vi.fn(), ["two"]);
    const markerTwo = rendered.querySelector('[aria-label="Map marker Stop two"]');
    expect(markerTwo?.textContent).toContain("Hypothetical what-if impact");
    expect(markerTwo?.textContent).toContain("Needs your review · affected");
  });

  it("numbers verified experience and personal stops, shows affected/locked state, and syncs selection", () => {
    const onSelectItem = vi.fn();
    const { container: rendered } = renderMap(makeItinerary(), "one", onSelectItem);

    const markerOne = rendered.querySelector('[aria-label="Map marker Stop one"]');
    const markerTwo = rendered.querySelector('[aria-label="Map marker Stop two"]');
    const markerThree = rendered.querySelector('[aria-label="Map marker Personal three"]');
    expect(markerOne?.textContent).toContain("1|Stop one|selected");
    expect(markerTwo?.textContent).toContain("2|Stop two|affected|true");
    expect(markerTwo?.textContent).toContain("Needs your review · affected");
    expect(markerThree?.textContent).toContain("3|Personal three");

    act(() => markerTwo?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSelectItem).toHaveBeenCalledWith("two");

    renderMap(makeItinerary(), "two", onSelectItem);
    expect(rendered.querySelector('[aria-label="Map marker Stop two"]')?.textContent).toContain("2|Stop two|selected|true");
    expect(rendered.querySelector('[data-testid="focus-request"]')?.textContent).toBe("1");
    expect(rendered.querySelector('[data-testid="weather-target"]')?.textContent).toContain("18.94,72.84:Place two");
  });

  it("lets the traveler hide and restore selected-stop weather context", () => {
    const { container: rendered } = renderMap(makeItinerary("trip-1", false), "one");
    expect(rendered.querySelector('[data-testid="weather-target"]')).not.toBeNull();
    act(() => clickButton("Weather"));
    expect(rendered.querySelector('[data-testid="weather-target"]')).toBeNull();
    act(() => clickButton("Weather"));
    expect(rendered.querySelector('[data-testid="weather-target"]')).not.toBeNull();
  });

  it("fits on open and when requested, and only loads route geometry after the route action", async () => {
    const routeResponse: RouteResponse = {
      distance_km: 1.4,
      duration_minutes: 8,
      geometry: line,
      source: "osrm",
    };
    getRouteMock.mockResolvedValue(routeResponse);
    const { container: rendered } = renderMap(makeItinerary("trip-1", false), "one");

    expect(rendered.querySelector('[data-testid="fit-request"]')?.textContent).toBe("1");
    expect(getRouteMock).not.toHaveBeenCalled();
    await act(async () => {
      clickButton("Show route");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getRouteMock).toHaveBeenCalledTimes(1);
    expect(getRouteMock).toHaveBeenCalledWith(
      { lat: 18.93, lng: 72.83 },
      { lat: 18.94, lng: 72.84 },
      { profile: "driving", includeGeometry: true },
      expect.any(AbortSignal),
    );
    expect(rendered.querySelector('[data-testid="route-count"]')?.textContent).toBe("1");
    expect(rendered.textContent).toContain("OSRM route · 1.4 km · 8 min");

    act(() => clickButton("Fit trip"));
    expect(rendered.querySelector('[data-testid="fit-request"]')?.textContent).toBe("2");
  });

  it("does not draw a route when the backend only returns an estimate", async () => {
    getRouteMock.mockResolvedValue({
      distance_km: 1.2,
      duration_minutes: 5,
      geometry: null,
      source: "haversine_estimate",
    } satisfies RouteResponse);
    const { container: rendered } = renderMap(makeItinerary("trip-1", false), "one");

    await act(async () => {
      clickButton("Show route");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(rendered.querySelector('[data-testid="route-count"]')?.textContent).toBe("0");
    expect(rendered.textContent).toContain("Route geometry unavailable for 1 consecutive leg");
  });

  it("aborts stale route requests when the itinerary changes", async () => {
    const signals: AbortSignal[] = [];
    getRouteMock.mockImplementation((_origin: unknown, _destination: unknown, _options: unknown, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<RouteResponse>(() => {});
    });
    const { container: rendered } = renderMap(makeItinerary("first-trip", false), "one");
    await act(async () => {
      clickButton("Show route");
      await Promise.resolve();
    });
    expect(signals).toHaveLength(1);

    await act(async () => {
      renderMap(makeItinerary("second-trip", false), "one");
      await Promise.resolve();
    });
    expect(signals[0]?.aborted).toBe(true);
    expect(signals).toHaveLength(2);
    expect(rendered.querySelector('[role="img"]')?.getAttribute("aria-label")).toContain("Fort afternoon");
  });

  it("loads nearby OpenStreetMap points when Explore nearby is clicked", async () => {
    const poi: NearbyPOI = {
      osm_type: "node",
      osm_id: 42,
      name: "Nearby Cafe",
      category: "cafe",
      lat: 18.931,
      lng: 72.832,
      tags: {},
      distance_km: 0.2,
    };
    getNearbyPoisMock.mockResolvedValue({ items: [poi], categories_available: ["cafe"] });
    const { container: rendered } = renderMap(makeItinerary("trip-1", false), "one");

    expect(getNearbyPoisMock).not.toHaveBeenCalled();
    await act(async () => {
      clickButton("Nearby places · 2 km");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getNearbyPoisMock).toHaveBeenCalledTimes(1);
    expect(getNearbyPoisMock).toHaveBeenCalledWith(
      { lat: 18.93, lng: 72.83 },
      2000,
      ["restaurant", "cafe", "museum", "gallery", "attraction", "market", "park", "theatre", "library", "viewpoint", "arts_center"],
      expect.any(AbortSignal),
    );
    expect(rendered.textContent).toContain("Nearby Cafe");
  });

  it("loads only area-level social aggregates after Social Pulse is enabled", async () => {
    getSocialSignalsMock.mockResolvedValue({
      status: "AVAILABLE",
      queried_location: "Fort",
      radius_km: 10,
      generated_at: "2026-09-27T00:00:00Z",
      message: "Area-level public social signals.",
      clusters: [{
        id: "cluster-1",
        topic: "flooding",
        location_name: "Fort",
        location_precision: "area",
        latitude: 18.93,
        longitude: 72.83,
        signal_count: 4,
        independent_source_count: 3,
        confidence: 0.42,
        severity: "moderate",
        trend: "insufficient_data",
        newest_signal_at: "2026-09-27T00:00:00Z",
        source_platforms: ["bluesky"],
        confidence_note: "Heuristic estimate.",
      }],
    });
    const { container: rendered } = renderMap(makeItinerary("trip-1", false), "one");

    expect(getSocialSignalsMock).not.toHaveBeenCalled();
    await act(async () => {
      clickButton("Social pulse");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getSocialSignalsMock).toHaveBeenCalledWith(18.93, 72.83, 10, undefined, 24, expect.any(AbortSignal));
    expect(rendered.textContent).toContain("Public social signal · Fort");
    expect(rendered.textContent).toContain("Aggregated public area mentions");
    expect(rendered.textContent).toContain("4 matching posts");
    expect(rendered.textContent).toContain("42% heuristic confidence (medium)");
    expect(rendered.textContent).toContain("Newest signal");
    expect(rendered.querySelector('[aria-label="Map marker Public social context · Fort"]')?.textContent).toContain("4|Public social context");
  });

  it("passes the selected topic and time window to the typed social API", async () => {
    getSocialSignalsMock.mockResolvedValue({
      status: "NO_SIGNALS",
      queried_location: "Fort",
      radius_km: 10,
      generated_at: "2026-09-27T00:00:00Z",
      message: "No matching public posts.",
      clusters: [],
    });
    renderMap(makeItinerary("trip-1", false), "one");
    await act(async () => {
      clickButton("Social pulse");
      await Promise.resolve();
    });
    const selects = container.querySelectorAll("select");
    await act(async () => {
      (selects[0] as HTMLSelectElement).value = "flooding";
      selects[0]?.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      (selects[1] as HTMLSelectElement).value = "6";
      selects[1]?.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    expect(getSocialSignalsMock).toHaveBeenLastCalledWith(18.93, 72.83, 10, ["flooding"], 6, expect.any(AbortSignal));
    expect(container.textContent).toContain("Updated");
  });

  it("shows a non-blocking unavailable state when social context fails", async () => {
    getSocialSignalsMock.mockRejectedValue(new Error("provider unavailable"));
    const { container: rendered } = renderMap(makeItinerary("trip-1", false), "one");
    await act(async () => {
      clickButton("Social pulse");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(rendered.textContent).toContain("Public social context is unavailable right now");
    expect(rendered.querySelector('[data-testid="weather-target"]')).not.toBeNull();
  });

  it("shows the honest empty state when no itinerary coordinates are verified", () => {
    const trip = makeItinerary("trip-1", false);
    trip.items = trip.items.map((entry) => ({ ...entry, location_latitude: null, location_longitude: null }));
    const { container: rendered } = renderMap(trip, "one");
    expect(rendered.textContent).toContain("Your itinerary does not have enough verified locations to show a route.");
    expect(rendered.querySelector('[data-testid="weather-target"]')?.textContent).toContain("none,none");
  });
});
