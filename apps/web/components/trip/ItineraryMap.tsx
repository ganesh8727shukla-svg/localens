"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CloudSun, Download, LocateFixed, MapPin, MapPinned, MessageCircle, RefreshCw, Route, Search, X } from "lucide-react";
import { MapSurface } from "@/components/common/MapSurface";
import { WeatherCard } from "@/components/context/WeatherCard";
import { Button } from "@/components/ui/Button";
import { getNearbyPois, getRoute } from "@/lib/api/location";
import { getSocialSignals } from "@/lib/api/social";
import { downloadJsonFile } from "@/lib/utils/downloadJson";
import { buildConsecutiveRouteLegs, buildItineraryMapStops, itineraryFitBounds } from "@/lib/map/itineraryMap";
import { orderedTimelineEntries } from "@/lib/itinerary/itineraryDisplay";
import type { ApiItinerary } from "@/types/api";
import type { MapAnnotationCollection, MapRouteLeg, MapRouteSegment, MapStop } from "@/types/map";
import type { NearbyPOI } from "@/types/location";
import type { SocialSignalCluster, SocialSignalTopic, SocialSignalsResponse } from "@/types/social";

interface ItineraryMapProps {
  itinerary: ApiItinerary;
  selectedItemId: string | null;
  onSelectItem: (id: string) => void;
  scenarioAffectedItemIds?: string[];
  scenarioRouteAlternativeGeometries?: GeoJSON.LineString[];
  showWeatherCard?: boolean;
  initialSocialVisible?: boolean;
  initialNearbyVisible?: boolean;
  socialHeading?: string;
  useOwnedStopContext?: boolean;
}

interface RouteState {
  key: string;
  segments: MapRouteSegment[];
  unavailable: number;
  loading: boolean;
}

interface NearbyState {
  key: string;
  items: NearbyPOI[];
  loading: boolean;
  error: boolean;
}

interface SocialState {
  key: string;
  loading: boolean;
  response: SocialSignalsResponse | null;
  error: boolean;
}

const NEARBY_CATEGORIES = [
  "restaurant", "cafe", "museum", "gallery", "attraction", "market",
  "park", "theatre", "library", "viewpoint", "arts_center",
];
const MAX_ROUTE_CACHE_ENTRIES = 100;
const EMPTY_ROUTE_SEGMENTS: MapRouteSegment[] = [];
const EMPTY_NEARBY: NearbyPOI[] = [];
const SOCIAL_TOPIC_LABELS: Record<SocialSignalCluster["topic"], string> = {
  weather: "Weather",
  flooding: "Flooding or waterlogging",
  road_disruption: "Road or traffic disruption",
  crowding: "Crowding",
  event_disruption: "Event disruption",
  heat: "Heat",
  wind: "Wind",
};
const SOCIAL_TOPICS: SocialSignalTopic[] = ["weather", "flooding", "road_disruption", "crowding", "event_disruption", "heat", "wind"];

function confidenceBand(value: number): "low" | "medium" | "high" {
  if (value >= 0.67) return "high";
  if (value >= 0.34) return "medium";
  return "low";
}

function updatedAge(value: string) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "Update time unavailable";
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `Updated ${hours} hr${hours === 1 ? "" : "s"} ago`;
}

function routeLegKey(leg: MapRouteLeg) {
  return [
    leg.origin.lat.toFixed(6), leg.origin.lng.toFixed(6),
    leg.destination.lat.toFixed(6), leg.destination.lng.toFixed(6), "driving",
  ].join(":");
}

function routeSetKey(itinerary: ApiItinerary, legs: MapRouteLeg[]) {
  return `${itinerary.id}:${itinerary.version}:${legs.map(routeLegKey).join("|")}`;
}

function timeRange(start: string, end: string) {
  const format = (value: string) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? "Time unavailable"
      : date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  };
  return `${format(start)}–${format(end)}`;
}

function annotationForStop(stop: MapStop, selectedId: string | null, scenarioAffectedIds: ReadonlySet<string>) {
  const status = stop.itemState === "AFFECTED"
    ? "Needs your review · affected"
    : stop.itemState === "ACTIVE"
      ? "Planned stop"
      : `Itinerary status: ${stop.itemState.toLowerCase()}`;
  const lockedText = stop.isLocked ? " · Locked; will not be automatically replaced" : "";
  const scenarioAffected = scenarioAffectedIds.has(stop.id);
  return {
    type: "Feature" as const,
    geometry: { type: "Point" as const, coordinates: [stop.longitude, stop.latitude] as [number, number] },
    properties: {
      id: stop.id,
      label: String(stop.sequence),
      title: stop.title,
      description: `${scenarioAffected ? "Hypothetical what-if impact · " : ""}${status}${lockedText} · ${stop.category} · ${timeRange(stop.plannedStart, stop.plannedEnd)}${stop.locationLabel ? ` · ${stop.locationLabel}` : ""}`,
      kind: "stop" as const,
      tone: stop.id === selectedId ? "selected" as const : stop.itemState === "AFFECTED" ? "affected" as const : "normal" as const,
      locked: stop.isLocked,
      affected: stop.itemState === "AFFECTED",
      scenarioAffected,
    },
  };
}

function annotationForPoi(poi: NearbyPOI) {
  return {
    type: "Feature" as const,
    geometry: { type: "Point" as const, coordinates: [poi.lng, poi.lat] as [number, number] },
    properties: {
      id: `poi:${poi.osm_type}:${poi.osm_id}`,
      label: "",
      title: poi.name,
      description: `Nearby ${poi.category} · ${poi.distance_km.toFixed(1)} km away`,
      kind: "poi" as const,
      tone: "normal" as const,
    },
  };
}

function annotationForSocial(clusters: SocialSignalCluster[]) {
  if (!clusters.length) return null;
  const first = clusters[0];
  const total = clusters.reduce((sum, cluster) => sum + cluster.signal_count, 0);
  const confidence = clusters.reduce((sum, cluster) => sum + cluster.confidence * cluster.signal_count, 0) / total;
  const severity: SocialSignalCluster["severity"] = clusters.some((cluster) => cluster.severity === "high")
    ? "high"
    : clusters.some((cluster) => cluster.severity === "moderate") ? "moderate" : "low";
  const topics = clusters.map((cluster) => `${SOCIAL_TOPIC_LABELS[cluster.topic]} (${cluster.signal_count})`).join(" · ");
  return {
    type: "Feature" as const,
    geometry: { type: "Point" as const, coordinates: [first.longitude, first.latitude] as [number, number] },
    properties: {
      id: `social:${first.location_name.toLowerCase()}`,
      label: String(total),
      title: `Public social context · ${first.location_name}`,
      description: `${topics}. Aggregated area mentions; posts are not geotagged to this point.`,
      kind: "social" as const,
      tone: "social" as const,
      signalCount: total,
      confidenceLabel: confidenceBand(confidence),
      severity,
    },
  };
}

function mapBoundsFromStops(stops: MapStop[], segments: MapRouteSegment[]) {
  return itineraryFitBounds(
    stops.map((stop) => ({ lat: stop.latitude, lng: stop.longitude })),
    segments.map((segment) => segment.geometry),
  );
}

export function ItineraryMap({ itinerary, selectedItemId, onSelectItem, scenarioAffectedItemIds = [], scenarioRouteAlternativeGeometries = [], showWeatherCard = true, initialSocialVisible = false, initialNearbyVisible = false, socialHeading, useOwnedStopContext = false }: ItineraryMapProps) {
  const stops = useMemo(() => buildItineraryMapStops(itinerary), [itinerary]);
  const routeLegs = useMemo(() => buildConsecutiveRouteLegs(itinerary), [itinerary]);
  const entries = useMemo(() => orderedTimelineEntries(itinerary), [itinerary]);
  const scenarioAffectedIdSet = useMemo(() => new Set(scenarioAffectedItemIds), [scenarioAffectedItemIds]);
  const entryIds = useMemo(() => new Set(entries.map((entry) => entry.kind === "experience" ? entry.item.id : entry.activity.id)), [entries]);
  const activeSelectedId = selectedItemId && entryIds.has(selectedItemId)
    ? selectedItemId
    : stops[0]?.id ?? null;
  const selectedStop = stops.find((stop) => stop.id === activeSelectedId) ?? null;
  const selectedEntry = entries.find((entry) => (entry.kind === "experience" ? entry.item.id : entry.activity.id) === activeSelectedId);
  const weatherLabel = selectedEntry?.kind === "experience"
    ? selectedEntry.item.location_place_name ?? selectedEntry.item.title ?? "selected stop"
    : selectedEntry?.kind === "custom"
      ? selectedEntry.activity.location_text ?? selectedEntry.activity.title
      : "selected stop";

  const [routeVisible, setRouteVisible] = useState(false);
  const [weatherVisible, setWeatherVisible] = useState(true);
  const [routeState, setRouteState] = useState<RouteState>({ key: "", segments: [], unavailable: 0, loading: false });
  const [fitRequestId, setFitRequestId] = useState(stops.length ? 1 : 0);
  const [focusRequestId, setFocusRequestId] = useState(0);
  const [nearbyVisible, setNearbyVisible] = useState(initialNearbyVisible);
  const [nearbyState, setNearbyState] = useState<NearbyState | null>(null);
  const [socialVisible, setSocialVisible] = useState(initialSocialVisible);
  const [socialTopicFilter, setSocialTopicFilter] = useState<SocialSignalTopic | "all">("all");
  const [socialSinceHours, setSocialSinceHours] = useState(24);
  const [socialRefreshKey, setSocialRefreshKey] = useState(0);
  const [socialSeverityFilter, setSocialSeverityFilter] = useState<"all" | "moderate" | "high">("all");
  const [socialState, setSocialState] = useState<SocialState | null>(null);
  const routeCacheRef = useRef(new Map<string, MapRouteSegment | null>());
  const nearbyControllerRef = useRef<AbortController | null>(null);
  const socialControllerRef = useRef<AbortController | null>(null);
  const previousSelectionRef = useRef(selectedItemId);

  const currentRouteKey = useMemo(() => routeSetKey(itinerary, routeLegs), [itinerary, routeLegs]);
  const currentRouteState = routeState.key === currentRouteKey ? routeState : null;
  const routeSegments = currentRouteState?.segments ?? EMPTY_ROUTE_SEGMENTS;
  const routeGeometries = useMemo(
    () => routeVisible ? routeSegments.flatMap((segment) => segment.geometry ? [segment.geometry] : []) : [],
    [routeSegments, routeVisible],
  );
  const nearbyKey = selectedStop
    ? `${selectedStop.latitude.toFixed(4)}:${selectedStop.longitude.toFixed(4)}`
    : "";
  const socialKey = selectedStop
    ? `${selectedStop.id}:${selectedStop.latitude.toFixed(4)}:${selectedStop.longitude.toFixed(4)}`
    : "";
  const selectedLatitude = selectedStop?.latitude ?? null;
  const selectedLongitude = selectedStop?.longitude ?? null;
  const nearbyLoading = nearbyVisible && Boolean(selectedStop)
    && (nearbyState?.key !== nearbyKey || nearbyState.loading);
  const nearbyResults = nearbyState?.key === nearbyKey ? nearbyState.items : EMPTY_NEARBY;
  const socialRequestKey = `${socialKey}:${socialTopicFilter}:${socialSinceHours}:${socialRefreshKey}`;
  const socialResponse = socialState?.key === socialRequestKey ? socialState.response : null;
  const socialLoading = Boolean(socialVisible && socialKey && (socialState?.key !== socialRequestKey || socialState.loading));
  const visibleSocialClusters = useMemo(() => {
    const minimumSeverity = socialSeverityFilter === "high" ? 2 : socialSeverityFilter === "moderate" ? 1 : 0;
    const severityRank = { low: 0, moderate: 1, high: 2 };
    return (socialResponse?.clusters ?? []).filter((cluster) => severityRank[cluster.severity] >= minimumSeverity);
  }, [socialResponse, socialSeverityFilter]);
  const nearbyAnnotations = useMemo(
    () => nearbyVisible ? nearbyResults.map(annotationForPoi) : [],
    [nearbyVisible, nearbyResults],
  );
  const socialAnnotation = useMemo(
    () => socialVisible && socialResponse ? annotationForSocial(visibleSocialClusters) : null,
    [socialVisible, socialResponse, visibleSocialClusters],
  );

  const annotations = useMemo<MapAnnotationCollection>(() => ({
    type: "FeatureCollection",
    features: [
      ...stops.map((stop) => annotationForStop(stop, activeSelectedId, scenarioAffectedIdSet)),
      ...nearbyAnnotations,
      ...(socialAnnotation ? [socialAnnotation] : []),
    ],
  }), [stops, activeSelectedId, nearbyAnnotations, socialAnnotation, scenarioAffectedIdSet]);

  useEffect(() => {
    if (!routeVisible) return;
    const controller = new AbortController();

    async function loadRouteLegs() {
      setRouteState({ key: currentRouteKey, segments: [], unavailable: 0, loading: true });
      const segments: MapRouteSegment[] = [];
      let unavailable = 0;

      // Sequential requests respect the public OSRM demo's one-request-per-second
      // policy enforced by the existing backend adapter.
      for (const leg of routeLegs) {
        if (controller.signal.aborted) return;
        const key = routeLegKey(leg);
        if (routeCacheRef.current.has(key)) {
          const cached = routeCacheRef.current.get(key);
          if (cached) {
            segments.push({ ...cached, ...leg });
            if (!cached.geometry) unavailable += 1;
          } else unavailable += 1;
          continue;
        }

        try {
          const result = await getRoute(leg.origin, leg.destination, {
            profile: "driving",
            includeGeometry: true,
          }, controller.signal);
          if (controller.signal.aborted) return;
          const geometry = result.source === "osrm"
            && result.geometry?.type === "LineString"
            && result.geometry.coordinates.length >= 2
            ? result.geometry
            : null;
          const segment: MapRouteSegment = {
            ...leg,
            geometry,
            distanceKm: result.distance_km,
            durationMinutes: result.duration_minutes,
            source: result.source,
          };
          routeCacheRef.current.set(key, segment);
          if (routeCacheRef.current.size > MAX_ROUTE_CACHE_ENTRIES) {
            const oldestKey = routeCacheRef.current.keys().next().value;
            if (oldestKey) routeCacheRef.current.delete(oldestKey);
          }
          segments.push(segment);
          if (!geometry) unavailable += 1;
        } catch {
          if (controller.signal.aborted) return;
          unavailable += 1;
        }
      }

      if (!controller.signal.aborted) {
        setRouteState({ key: currentRouteKey, segments, unavailable, loading: false });
      }
    }

    if (routeLegs.length) void loadRouteLegs();
    return () => controller.abort();
  }, [routeVisible, currentRouteKey, routeLegs]);

  useEffect(() => {
    if (selectedItemId && previousSelectionRef.current !== selectedItemId) {
      setFocusRequestId((requestId) => requestId + 1);
    }
    previousSelectionRef.current = selectedItemId;
  }, [selectedItemId]);

  useEffect(() => () => nearbyControllerRef.current?.abort(), [nearbyKey]);

  useEffect(() => {
    if (!socialVisible || !socialKey || selectedLatitude === null || selectedLongitude === null) return;
    const controller = new AbortController();
    socialControllerRef.current?.abort();
    socialControllerRef.current = controller;
    const topics = socialTopicFilter === "all" ? undefined : [socialTopicFilter];
    const request = useOwnedStopContext && selectedStop?.kind === "experience"
      ? getSocialSignals(selectedLatitude, selectedLongitude, 10, topics, socialSinceHours, controller.signal, selectedStop.id)
      : getSocialSignals(selectedLatitude, selectedLongitude, 10, topics, socialSinceHours, controller.signal);
    void request
      .then((response) => {
        if (!controller.signal.aborted) setSocialState({ key: socialRequestKey, loading: false, response, error: false });
      })
      .catch(() => {
        if (!controller.signal.aborted) setSocialState({ key: socialRequestKey, loading: false, response: null, error: true });
      });
    return () => controller.abort();
  }, [socialVisible, socialKey, socialRequestKey, selectedLatitude, selectedLongitude, selectedStop?.id, selectedStop?.kind, socialTopicFilter, socialSinceHours, useOwnedStopContext]);

  useEffect(() => {
    if (!nearbyVisible || !nearbyKey || selectedLatitude === null || selectedLongitude === null) return;
    nearbyControllerRef.current?.abort();
    const controller = new AbortController();
    nearbyControllerRef.current = controller;
    void getNearbyPois(
      { lat: selectedLatitude, lng: selectedLongitude },
      2000,
      NEARBY_CATEGORIES,
      controller.signal,
    )
      .then((response) => {
        if (!controller.signal.aborted) {
          setNearbyState({ key: nearbyKey, items: response.items, loading: false, error: false });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setNearbyState({ key: nearbyKey, items: [], loading: false, error: true });
        }
      });
    return () => controller.abort();
  }, [nearbyKey, nearbyVisible, selectedLatitude, selectedLongitude]);

  function handleExploreNearby() {
    if (selectedStop) setNearbyVisible((visible) => !visible);
  }

  function handleSelectAnnotation(id: string) {
    if (stops.some((stop) => stop.id === id)) onSelectItem(id);
  }

  function handleFitTrip() {
    if (!stops.length) return;
    setFitRequestId((requestId) => requestId + 1);
  }

  function handleFocusSelected() {
    if (selectedStop) setFocusRequestId((requestId) => requestId + 1);
  }

  const fitBounds = useMemo(() => mapBoundsFromStops(stops, routeSegments), [stops, routeSegments]);
  const focusCoordinate = useMemo(
    () => selectedStop ? { lat: selectedStop.latitude, lng: selectedStop.longitude } : null,
    [selectedStop],
  );
  const routeLoading = routeVisible && (currentRouteState?.loading ?? routeLegs.length > 0);
  const routeUnavailableCount = currentRouteState?.unavailable ?? 0;
  const selectedWeatherLatitude = selectedStop?.latitude ?? null;
  const selectedWeatherLongitude = selectedStop?.longitude ?? null;

  return (
    <section id="trip-map" className="space-y-3 rounded-3xl border border-line bg-surface-raised p-4 shadow-soft sm:p-5" aria-label="Trip map and context">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">Trip map</p>
          <p className="mt-1 text-sm text-ink-muted">Numbered stops follow the itinerary order. Map and list selections stay in sync.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2" aria-label="Trip map controls">
          <Button type="button" size="sm" variant="outline" onClick={handleFitTrip} disabled={!stops.length}>
            <MapPinned className="size-4" aria-hidden="true" />Fit trip
          </Button>
          <Button type="button" size="sm" variant={routeVisible ? "secondary" : "outline"} onClick={() => setRouteVisible((visible) => !visible)} disabled={!routeLegs.length} aria-pressed={routeVisible}>
            <Route className="size-4" aria-hidden="true" />{routeVisible ? "Hide route" : "Show route"}
          </Button>
          {showWeatherCard ? <Button type="button" size="sm" variant={weatherVisible ? "secondary" : "outline"} onClick={() => setWeatherVisible((visible) => !visible)} aria-pressed={weatherVisible}>
            <CloudSun className="size-4" aria-hidden="true" />Weather
          </Button> : null}
          <Button id="trip-social-toggle" type="button" size="sm" variant={socialVisible ? "secondary" : "outline"} onClick={() => setSocialVisible((visible) => !visible)} disabled={!selectedStop} aria-pressed={socialVisible}>
            <MessageCircle className="size-4" aria-hidden="true" />{socialVisible ? "Hide social pulse" : "Social pulse"}
          </Button>
          <Button type="button" size="sm" variant={nearbyVisible ? "secondary" : "outline"} onClick={handleExploreNearby} disabled={!selectedStop} aria-pressed={nearbyVisible}>
            {nearbyVisible ? <X className="size-4" aria-hidden="true" /> : <Search className="size-4" aria-hidden="true" />}
            {nearbyVisible ? "Hide nearby places" : "Nearby places · 2 km"}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={handleFocusSelected} disabled={!selectedStop}>
            <LocateFixed className="size-4" aria-hidden="true" />Selected stop
          </Button>
        </div>
      </div>

      {stops.length ? (
        <MapSurface
          annotations={annotations}
          onSelectAnnotation={handleSelectAnnotation}
          routeGeometries={routeGeometries}
          routeAlternativeGeometries={scenarioRouteAlternativeGeometries}
          fitBounds={fitBounds}
          fitBoundsRequestId={fitRequestId}
          focusCoordinate={focusCoordinate}
          focusRequestId={focusRequestId}
          className="h-[48vh] min-h-[320px] rounded-2xl sm:h-[460px]"
          label={`Trip map for ${itinerary.title}. Numbered markers match itinerary order. Select a stop marker to select that itinerary item.`}
        />
      ) : (
        <div className="flex min-h-64 items-center justify-center rounded-2xl border border-dashed border-line-strong bg-surface-sunken px-5 py-8 text-center">
          <div className="max-w-md">
            <MapPin className="mx-auto size-7 text-ink-subtle" aria-hidden="true" />
            <p className="mt-3 font-medium text-ink">Your itinerary does not have enough verified locations to show a route.</p>
            <p className="mt-1 text-sm text-ink-muted">Stops remain available in the itinerary below. Personal activities appear on the map only when coordinates were provided.</p>
          </div>
        </div>
      )}

      {stops.length > 0 && routeLegs.length === 0 ? (
        <p className="rounded-xl bg-surface-sunken px-3.5 py-3 text-sm text-ink-muted" role="status">
          Route geometry unavailable. At least two consecutive stops need verified coordinates.
        </p>
      ) : null}
      {routeLoading ? (
        <p className="rounded-xl bg-surface-sunken px-3.5 py-3 text-sm text-ink-muted" role="status" aria-live="polite">
          Loading planned route geometry…
        </p>
      ) : null}
      {routeVisible && currentRouteState && !currentRouteState.loading && routeUnavailableCount > 0 ? (
        <p className="rounded-xl bg-surface-sunken px-3.5 py-3 text-sm text-ink-muted" role="status">
          Route geometry unavailable for {routeUnavailableCount} consecutive leg{routeUnavailableCount === 1 ? "" : "s"}. Existing itinerary travel estimates remain listed with each stop.
        </p>
      ) : null}
      {routeVisible && routeSegments.length > 0 ? (
        <ol className="grid gap-2 sm:grid-cols-2" aria-label="Planned route leg details">
          {routeSegments.map((segment) => {
            const from = stops.find((stop) => stop.id === segment.fromId)?.title ?? "Previous stop";
            const to = stops.find((stop) => stop.id === segment.toId)?.title ?? "Next stop";
            return (
              <li key={`${segment.fromId}:${segment.toId}`} className="rounded-xl bg-surface-sunken px-3 py-2 text-xs text-ink-muted">
                <span className="font-medium text-ink">{from} → {to}</span>
                <span className="block mt-1">{segment.source === "osrm" ? "OSRM route" : "Straight-line travel estimate"} · {segment.distanceKm.toFixed(1)} km · {Math.round(segment.durationMinutes)} min</span>
                <span className="mt-1 block text-ink-subtle">{segment.geometry ? "Verified route geometry shown on map" : "No route geometry returned; this line is not drawn on the map"}</span>
                <span className="mt-1 block text-[11px] text-ink-subtle">From {segment.origin.lat.toFixed(5)}, {segment.origin.lng.toFixed(5)} to {segment.destination.lat.toFixed(5)}, {segment.destination.lng.toFixed(5)}</span>
              </li>
            );
          })}
        </ol>
      ) : null}

      <details className="rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm text-ink-muted">
        <summary className="cursor-pointer font-medium text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">Map legend</summary>
        <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-2 text-xs">
          {routeGeometries.length ? <li className="inline-flex items-center gap-2"><span className="h-0.5 w-5 bg-accent" aria-hidden="true" />Planned route · OSRM</li> : null}
          {scenarioRouteAlternativeGeometries.length ? <li className="inline-flex items-center gap-2"><span className="h-0.5 w-5 border-t-2 border-dashed border-highlight" aria-hidden="true" />OSRM option · disruption not verified</li> : null}
          <li className="inline-flex items-center gap-2"><span className="flex size-5 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-ink" aria-hidden="true">1</span>Itinerary stop</li>
          <li className="inline-flex items-center gap-2"><span className="size-3 rounded-full bg-accent" aria-hidden="true" />Selected stop</li>
          {stops.some((stop) => stop.itemState === "AFFECTED") ? <li className="inline-flex items-center gap-2"><span className="size-3 rounded-full bg-highlight" aria-hidden="true" />Affected stop · needs review</li> : null}
          {scenarioAffectedItemIds.length ? <li className="inline-flex items-center gap-2"><span className="size-3 rounded-full border-2 border-highlight bg-primary" aria-hidden="true" />What-if impact · hypothetical</li> : null}
          {stops.some((stop) => stop.isLocked) ? <li className="inline-flex items-center gap-2"><span className="size-3 rounded-full border-2 border-highlight bg-primary" aria-hidden="true" />Locked stop</li> : null}
          {nearbyVisible && nearbyResults.length ? <li className="inline-flex items-center gap-2"><span className="size-3 rounded-full bg-ink-muted" aria-hidden="true" />Nearby point</li> : null}
          {socialVisible && visibleSocialClusters.length ? <>
            <li className="inline-flex items-center gap-2"><span className="size-3 rounded-full bg-primary" aria-hidden="true" />Low severity</li>
            <li className="inline-flex items-center gap-2"><span className="size-3 rounded-full bg-accent" aria-hidden="true" />Moderate severity</li>
            <li className="inline-flex items-center gap-2"><span className="size-3 rounded-full bg-highlight" aria-hidden="true" />High severity</li>
          </> : null}
        </ul>
      </details>

      {socialVisible ? (
        <section id="trip-social-context" className="scroll-mt-6 rounded-2xl border border-line bg-surface p-4" aria-label="Public social signal context" aria-live="polite">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-ink">{socialHeading ?? "Public social signal"} · {socialResponse?.queried_location ?? selectedStop?.title}</h3>
              <p className="mt-1 text-xs text-ink-muted">Aggregated public area mentions. They are unverified context, not a confirmed incident report.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {socialResponse ? <span className="rounded-full bg-surface-sunken px-2.5 py-1 text-xs font-medium text-ink-muted">{socialResponse.status.replaceAll("_", " ")}{socialResponse.location_source === "catalog_record" ? " · catalog area" : ""}</span> : null}
              {socialVisible ? <Button type="button" size="sm" variant="outline" onClick={() => setSocialRefreshKey((key) => key + 1)} disabled={socialLoading} aria-label="Retry public social signals"><RefreshCw className="size-4" aria-hidden="true" />Refresh signals</Button> : null}
              {socialResponse ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => downloadJsonFile("localens-social-signal-aggregates.json", {
                    schema: "localens.social-aggregates.v1",
                    privacy_note: "Normalized area aggregates only; individual posts and author details are not exposed.",
                    data: socialResponse,
                  })}
                >
                  <Download className="size-4" aria-hidden="true" />Aggregate JSON
                </Button>
              ) : null}
            </div>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-ink-muted">Topic
              <select className="h-10 rounded-xl border border-line-strong bg-surface-raised px-3 text-sm text-ink" value={socialTopicFilter} onChange={(event) => setSocialTopicFilter(event.target.value as SocialSignalTopic | "all")}>
                <option value="all">All topics</option>
                {SOCIAL_TOPICS.map((topic) => <option key={topic} value={topic}>{SOCIAL_TOPIC_LABELS[topic]}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-ink-muted">Time window
              <select className="h-10 rounded-xl border border-line-strong bg-surface-raised px-3 text-sm text-ink" value={socialSinceHours} onChange={(event) => setSocialSinceHours(Number(event.target.value))}>
                <option value={6}>Past 6 hours</option><option value={12}>Past 12 hours</option><option value={24}>Past 24 hours</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-ink-muted">Severity
              <select className="h-10 rounded-xl border border-line-strong bg-surface-raised px-3 text-sm text-ink" value={socialSeverityFilter} onChange={(event) => setSocialSeverityFilter(event.target.value as "all" | "moderate" | "high")}>
                <option value="all">Any severity</option><option value="moderate">Moderate or high</option><option value="high">High only</option>
              </select>
            </label>
          </div>
          {socialLoading ? <p className="mt-3 text-sm text-ink-muted" role="status">Checking public area mentions…</p> : null}
          {socialState?.key === socialRequestKey && socialState.error ? <p className="mt-3 text-sm text-ink-muted" role="status">Public social context is unavailable right now. The trip map, weather, and itinerary remain usable.</p> : null}
          {socialResponse ? <p className="mt-3 text-sm text-ink-muted" role="status">{socialResponse.message}</p> : null}
          {socialResponse?.location_source === "catalog_record" ? <p className="mt-1 text-xs text-ink-subtle">Area label comes from the selected saved experience’s backend location record; individual public posts are not geolocated.</p> : null}
          {socialResponse ? <p className="mt-1 text-xs text-ink-subtle">Search radius {socialResponse.radius_km} km · Generated {socialResponse.generated_at ? updatedAge(socialResponse.generated_at) : "time unavailable"}</p> : null}
          {socialResponse?.clusters.length && visibleSocialClusters.length === 0 ? <p className="mt-2 text-sm text-ink-muted">No returned clusters match this severity filter.</p> : null}
          {visibleSocialClusters.length ? (
            <ul className="mt-3 grid gap-2 sm:grid-cols-2">
              {visibleSocialClusters.map((cluster) => (
                <li key={cluster.id} className="rounded-xl bg-surface-sunken px-3 py-2.5 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-ink">{SOCIAL_TOPIC_LABELS[cluster.topic]}</span>
                    <span className="rounded-full border border-line px-2 py-0.5 text-xs capitalize text-ink-muted">{cluster.severity}</span>
                  </div>
                  <p className="mt-1 text-xs text-ink-muted">{cluster.signal_count} matching posts · {cluster.independent_source_count} distinct public accounts · {cluster.trend.replaceAll("_", " ")}</p>
                  <p className="mt-1 text-xs text-ink-muted">{cluster.location_precision} area · {cluster.source_platforms.join(", ") || "Platform unavailable"} · {Math.round(cluster.confidence * 100)}% heuristic confidence ({confidenceBand(cluster.confidence)})</p>
                  <p className="mt-1 text-xs text-ink-muted">Newest signal {updatedAge(cluster.newest_signal_at)}</p>
                  <p className="mt-1 text-xs text-ink-subtle">{cluster.confidence_note}</p>
                </li>
              ))}
            </ul>
          ) : null}
          {socialResponse ? <p className="mt-3 text-xs text-ink-subtle">The marker shows the selected search center. Bluesky posts do not supply verified coordinates here, so no individual post locations are inferred. Radius is not a per-post distance filter.</p> : null}
        </section>
      ) : null}

      {nearbyVisible ? (
        <section className="rounded-2xl border border-line bg-surface p-4" aria-label="Nearby places">
          <h3 className="text-sm font-semibold text-ink">OpenStreetMap places {selectedStop?.title ? `· near ${selectedStop.title}` : "near selected stop"}</h3>
          <p className="mt-1 text-xs text-ink-subtle">Verified map features within 2 km. These are points of interest, not social reports or itinerary bookings.</p>
          {nearbyLoading ? <p className="mt-2 text-sm text-ink-muted" role="status">Searching OpenStreetMap for nearby places…</p> : null}
          {nearbyState?.key === nearbyKey && nearbyState.error ? <p className="mt-2 text-sm text-ink-muted" role="status">OpenStreetMap nearby-place data is unavailable right now. Try again later.</p> : null}
          {nearbyState?.key === nearbyKey && !nearbyState.loading && !nearbyState.error && nearbyState.items.length === 0 ? <p className="mt-2 text-sm text-ink-muted">No nearby places were returned for the selected categories.</p> : null}
          {nearbyState?.key === nearbyKey && nearbyState.items.length ? (
            <ul className="mt-2 grid gap-2 sm:grid-cols-2">
              {nearbyState.items.map((poi) => (
                <li key={`${poi.osm_type}:${poi.osm_id}`} className="rounded-xl bg-surface-sunken px-3 py-2 text-sm">
                  <span className="font-medium text-ink">{poi.name}</span>
                  <span className="text-ink-muted"> · {poi.category} · {poi.distance_km.toFixed(1)} km away</span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {showWeatherCard && weatherVisible ? (
        <WeatherCard
          latitude={selectedWeatherLatitude}
          longitude={selectedWeatherLongitude}
          locationLabel={weatherLabel}
        />
      ) : null}
    </section>
  );
}
