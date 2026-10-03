"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, CloudSun, ExternalLink, GitCompare, MapPin, MapPinned, MessageCircle, Navigation, Play } from "lucide-react";
import { PageContainer } from "@/components/layout/PageContainer";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/Skeleton";
import { ItineraryMap } from "@/components/trip/ItineraryMap";
import { RealItineraryTimeline } from "@/components/trip/RealItineraryTimeline";
import { WhatIfSimulationPanel } from "@/components/trip/WhatIfSimulationPanel";
import { useActiveTripProgress } from "@/hooks/useActiveTripProgress";
import { useAuth } from "@/lib/auth/AuthContext";
import { ApiError } from "@/lib/api/client";
import { getItinerary } from "@/lib/api/itineraries";
import {
  buildGoogleMapsDirectionsUrl,
  completeActiveTripStop,
  countStopsBeyondMapsRouteLimit,
  countStopsWithoutCoordinates,
  clearActiveTripProgress,
  getNextUncompletedStop,
  startActiveTrip,
} from "@/lib/itinerary/activeTripProgress";
import { orderedItems, orderedTimelineEntries } from "@/lib/itinerary/itineraryDisplay";
import { buildItineraryMapStops } from "@/lib/map/itineraryMap";
import type { ApiItinerary } from "@/types/api";
import type { SimulationResult } from "@/types/digitalTwin";

export function RealTripDetail({ itineraryId }: { itineraryId: string }) {
  const [itinerary, setItinerary] = useState<ApiItinerary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retryKey, setRetryKey] = useState(0);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [scenarioResult, setScenarioResult] = useState<SimulationResult | null>(null);
  const { user } = useAuth();
  const progress = useActiveTripProgress(user?.id);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await getItinerary(itineraryId, signal);
      if (!signal?.aborted) {
        if (user?.id && (result.status === "CANCELLED" || result.status === "COMPLETED")) {
          clearActiveTripProgress(user.id, result.id);
        }
        setItinerary(result);
        setSelectedItemId((currentId) => {
          const entries = orderedTimelineEntries(result);
          const entryIds = new Set(entries.map((entry) => entry.kind === "experience" ? entry.item.id : entry.activity.id));
          if (currentId && entryIds.has(currentId)) return currentId;
          const firstEntry = buildItineraryMapStops(result)[0]
            ?? (entries[0]?.kind === "experience"
              ? { id: entries[0].item.id }
              : entries[0]?.kind === "custom"
                ? { id: entries[0].activity.id }
                : null);
          return firstEntry?.id ?? null;
        });
        setError(null);
        setLoading(false);
      }
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      if (!signal?.aborted) {
        setError(cause instanceof ApiError ? cause.message : "Couldn't load this trip.");
        setLoading(false);
      }
    }
  }, [itineraryId, user]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => load(controller.signal));
    return () => controller.abort();
  }, [load, retryKey]);

  const items = itinerary ? orderedItems(itinerary) : [];
  const scenarioAffectedItemIds = useMemo(() => scenarioResult?.impacts
    .filter((impact) => impact.item_id && (impact.affected || impact.reason_codes.includes("HYPOTHETICAL_SOCIAL_CONTEXT")))
    .map((impact) => impact.item_id as string) ?? [], [scenarioResult]);
  const tripProgress = progress?.itineraryId === itineraryId && itinerary?.status !== "CANCELLED" ? progress : null;
  const canStartTrip = itinerary != null && ["VALIDATED", "BOOKING_REQUESTED"].includes(itinerary.status);
  const nextStop = getNextUncompletedStop(items, tripProgress);
  const nextStopIndex = nextStop ? items.findIndex((item) => item.id === nextStop.id) : -1;
  const remainingStops = nextStopIndex >= 0 ? items.slice(nextStopIndex) : items;
  const mapsUrl = buildGoogleMapsDirectionsUrl(remainingStops);
  const missingCoordinates = countStopsWithoutCoordinates(remainingStops);
  const additionalMapsStops = countStopsBeyondMapsRouteLimit(remainingStops);
  const completedStopCount = items.filter((item) => tripProgress?.completedItemIds.includes(item.id)).length;
  const followingStop = nextStopIndex >= 0 ? items[nextStopIndex + 1] ?? null : null;

  function beginTrip() {
    if (!user?.id || !itinerary || !canStartTrip || !items.length) return;
    if (progress?.status === "ACTIVE" && progress.itineraryId !== itinerary.id) {
      const accepted = window.confirm("Another trip is active. Switch trip progress to this itinerary?");
      if (!accepted) return;
    }
    startActiveTrip(user.id, itinerary.id);
  }

  function completeCurrentStop() {
    if (!user?.id || !itinerary || !nextStop) return;
    completeActiveTripStop(user.id, itinerary.id, nextStop.id, items.map((item) => item.id));
  }

  const displayDistance = (distance: number | null) => {
    if (distance == null || !Number.isFinite(distance)) return "Distance unavailable";
    return distance < 1 ? `${Math.round(distance * 1000)} m` : `${distance.toFixed(1)} km`;
  };
  const displayEta = (minutes: number | null) =>
    minutes == null || !Number.isFinite(minutes) ? "Travel time unavailable" : `${Math.round(minutes)} min planned travel`;

  return (
    <PageContainer className="space-y-6 py-6 sm:space-y-8 sm:py-8">
      <Link href="/trip" className="inline-flex items-center gap-2 text-sm font-medium text-ink-muted transition hover:text-ink">
        <ArrowLeft className="size-4" aria-hidden="true" />Back to Trips
      </Link>
      {loading ? <div className="space-y-4" aria-busy="true"><Skeleton className="h-8 w-64" /><Skeleton className="h-80 rounded-3xl" /></div> : null}
      {!loading && error ? <ErrorState title="Couldn't open this trip" description={error} onRetry={() => { setLoading(true); setRetryKey((key) => key + 1); }} /> : null}
      {!loading && !error && itinerary ? <>
        {tripProgress?.status === "ACTIVE" ? (
          <section className="space-y-4 rounded-3xl border border-line bg-surface-raised p-5 shadow-soft sm:p-6" aria-labelledby="active-trip-heading">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">Trip in progress</p>
                <h1 id="active-trip-heading" className="mt-1 text-xl font-semibold tracking-tight text-ink">{itinerary.title}</h1>
              </div>
              <Badge tone="success">{completedStopCount} of {items.length} stops complete</Badge>
            </div>
            {nextStop ? <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-2xl bg-surface-sunken p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Up next</p>
                <p className="mt-1 flex items-start gap-2 font-semibold text-ink"><MapPin className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />{nextStop.title ?? "Experience"}</p>
                <p className="mt-1 text-sm text-ink-muted">{nextStop.location_place_name ?? "Location unavailable"}</p>
                <Button className="mt-4" size="sm" variant="secondary" onClick={completeCurrentStop}><Check className="size-4" aria-hidden="true" />Mark stop complete</Button>
              </div>
              <div className="rounded-2xl bg-surface-sunken p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Following stop</p>
                {followingStop ? <>
                  <p className="mt-1 flex items-start gap-2 font-semibold text-ink"><MapPin className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />{followingStop.title ?? "Experience"}</p>
                  <p className="mt-1 text-sm text-ink-muted">{followingStop.location_place_name ?? "Location unavailable"}</p>
                  <p className="mt-3 text-xs text-ink-subtle">{displayDistance(followingStop.travel_from_previous_distance_km)} · {displayEta(followingStop.travel_from_previous_minutes)}</p>
                </> : <p className="mt-1 text-sm text-ink-muted">This is the final planned stop.</p>}
              </div>
            </div> : <p className="rounded-2xl bg-success-soft px-4 py-3 text-sm text-ink" role="status">All planned stops are complete.</p>}
            <p className="text-xs leading-5 text-ink-subtle">Progress is updated manually; LocaLens does not track your location.</p>
          </section>
        ) : tripProgress?.status === "COMPLETED" ? (
          <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-success/20 bg-success-soft p-4" role="status">
            <div><p className="font-semibold text-ink">Trip completed</p><p className="text-sm text-ink-muted">All {items.length} planned stops are marked complete.</p></div>
            <Badge tone="success">Complete</Badge>
          </section>
        ) : null}

        <section className="flex flex-wrap items-center gap-3" aria-label="Trip actions">
          {!tripProgress ? (
            <Button onClick={beginTrip} disabled={!user?.id || !canStartTrip || !items.length}><Play className="size-4" aria-hidden="true" />Start trip</Button>
          ) : null}
          {mapsUrl ? <a href={mapsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-line-strong bg-surface px-5 text-sm font-medium text-ink transition hover:bg-surface-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
            <Navigation className="size-4" aria-hidden="true" />{tripProgress?.status === "ACTIVE" ? "Open remaining route in Google Maps" : "Open route in Google Maps"}<ExternalLink className="size-3.5" aria-hidden="true" />
          </a> : <p className="text-sm text-ink-muted">Google Maps navigation is unavailable because this itinerary has no verified stop coordinates.</p>}
          {mapsUrl ? <p className="basis-full text-xs text-ink-subtle">{remainingStops.length - missingCoordinates === 1 ? "Google Maps opens this verified stop. LocaLens does not know your live starting point." : "Google Maps uses verified stop coordinates in itinerary order, anchored at the first verified stop. LocaLens does not know your live starting point."}</p> : null}
          {mapsUrl && missingCoordinates > 0 ? <p className="basis-full text-xs text-ink-subtle">Maps omits {missingCoordinates} stop{missingCoordinates === 1 ? "" : "s"} without verified coordinates; they remain in the LocaLens itinerary.</p> : null}
          {mapsUrl && additionalMapsStops > 0 ? <p className="basis-full text-xs text-ink-subtle">Google Maps opens up to the next five verified stops in itinerary order. Continue from LocaLens after marking them complete.</p> : null}
          {progress?.status === "ACTIVE" && progress.itineraryId !== itinerary.id ? <p className="basis-full text-xs text-ink-subtle">Another trip is active. Starting this one asks before switching its progress.</p> : null}
        </section>

        <section className="space-y-3" aria-labelledby="trip-intelligence-heading">
          <div>
            <h2 id="trip-intelligence-heading" className="text-lg font-semibold tracking-tight text-ink">Trip intelligence</h2>
            <p className="mt-1 text-sm text-ink-muted">Open live conditions, route details, area signals, or a backend-evaluated what-if preview for this itinerary.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Link href="#trip-weather" className="rounded-2xl border border-line bg-surface p-4 transition hover:border-accent/40 hover:shadow-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
              <CloudSun className="size-5 text-accent" aria-hidden="true" />
              <p className="mt-3 font-semibold text-ink">Live Weather</p>
              <p className="mt-1 text-xs leading-5 text-ink-muted">Current measurements, forecast, freshness, and source details.</p>
            </Link>
            <Link href="#trip-map" className="rounded-2xl border border-line bg-surface p-4 transition hover:border-accent/40 hover:shadow-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
              <MapPinned className="size-5 text-accent" aria-hidden="true" />
              <p className="mt-3 font-semibold text-ink">Map Visualization</p>
              <p className="mt-1 text-xs leading-5 text-ink-muted">Numbered stops, route legs, distances, times, and geometry source.</p>
            </Link>
            <Link href="#trip-social-toggle" className="rounded-2xl border border-line bg-surface p-4 transition hover:border-accent/40 hover:shadow-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
              <MessageCircle className="size-5 text-accent" aria-hidden="true" />
              <p className="mt-3 font-semibold text-ink">Social Signals</p>
              <p className="mt-1 text-xs leading-5 text-ink-muted">Load area-level topic counts, severity, trend, and confidence.</p>
            </Link>
            <Link href="#trip-what-if" className="rounded-2xl border border-line bg-surface p-4 transition hover:border-accent/40 hover:shadow-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
              <GitCompare className="size-5 text-accent" aria-hidden="true" />
              <p className="mt-3 font-semibold text-ink">Digital Twin / What-If</p>
              <p className="mt-1 text-xs leading-5 text-ink-muted">Compare baseline and scenario evidence before applying replanning.</p>
            </Link>
          </div>
        </section>

        <ItineraryMap
          itinerary={itinerary}
          selectedItemId={selectedItemId}
          onSelectItem={setSelectedItemId}
          scenarioAffectedItemIds={scenarioAffectedItemIds}
        />

        <WhatIfSimulationPanel
          itinerary={itinerary}
          onResult={setScenarioResult}
          onApplied={() => { void load(); }}
        />

        <RealItineraryTimeline
          itinerary={itinerary}
          onItineraryUpdated={setItinerary}
          selectedItemId={selectedItemId}
          onSelectItem={setSelectedItemId}
          displayStatus={tripProgress?.status === "ACTIVE"
            ? { label: "In progress", tone: "success" }
            : tripProgress?.status === "COMPLETED"
              ? { label: "Trip complete", tone: "success" }
              : undefined}
        />
      </> : null}
    </PageContainer>
  );
}
