"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowRight, CloudSun, GitCompare, MapPinned, RefreshCw, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody } from "@/components/ui/Card";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/Skeleton";
import { WeatherCard } from "@/components/context/WeatherCard";
import { ItineraryMap } from "@/components/trip/ItineraryMap";
import { WhatIfSimulationPanel } from "@/components/trip/WhatIfSimulationPanel";
import { getDomainIntelligenceHealth, type DomainIntelligenceHealth } from "@/lib/api/domainIntelligence";
import { ApiError } from "@/lib/api/client";
import { getItinerary, listMyItineraries } from "@/lib/api/itineraries";
import { buildItineraryMapStops } from "@/lib/map/itineraryMap";
import type { ApiItinerary } from "@/types/api";
import type { ReplanApplyResult, SimulationResult } from "@/types/digitalTwin";

const WALKTHROUGH = [
  { id: "showcase-trips", label: "Trips", detail: "Create or choose a Mumbai itinerary" },
  { id: "showcase-weather", label: "Weather", detail: "Check live source; compare Clear and Rain in dev" },
  { id: "showcase-map", label: "Map", detail: "Inspect stops, routes, and affected locations" },
  { id: "trip-social-context", label: "Social", detail: "Show current area-level public context" },
  { id: "showcase-what-if", label: "What‑If", detail: "Preview heavy rain and alternatives" },
  { id: "showcase-nugen", label: "Nugen", detail: "Review structured domain assessment" },
  { id: "showcase-replan", label: "Apply", detail: "Confirm deterministic replan and updated map" },
];

export function ShowcaseWorkspace() {
  const [itineraries, setItineraries] = useState<ApiItinerary[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [scenarioResult, setScenarioResult] = useState<SimulationResult | null>(null);
  const [applyOutcome, setApplyOutcome] = useState<ReplanApplyResult | null>(null);
  const [nugenHealth, setNugenHealth] = useState<DomainIntelligenceHealth | null>(null);
  const [nugenHealthError, setNugenHealthError] = useState(false);
  const [appliedVersion, setAppliedVersion] = useState<number | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);

  const loadItineraries = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await listMyItineraries(signal);
      if (signal?.aborted) return;
      setItineraries(response.items);
      setSelectedId((current) => current && response.items.some((item) => item.id === current)
        ? current
        : response.items.find((item) => item.status !== "CANCELLED")?.id ?? "");
      setListError(null);
    } catch (cause) {
      if (signal?.aborted) return;
      setListError(cause instanceof ApiError ? cause.message : "Couldn't load your trips.");
    } finally {
      if (!signal?.aborted) setListLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => loadItineraries(controller.signal));
    return () => controller.abort();
  }, [loadItineraries]);

  useEffect(() => {
    const controller = new AbortController();
    void getDomainIntelligenceHealth(controller.signal)
      .then((health) => { if (!controller.signal.aborted) setNugenHealth(health); })
      .catch(() => { if (!controller.signal.aborted) setNugenHealthError(true); });
    return () => controller.abort();
  }, []);

  const itinerary = itineraries.find((item) => item.id === selectedId) ?? null;
  const mapStops = useMemo(() => itinerary ? buildItineraryMapStops(itinerary) : [], [itinerary]);
  const selectedMapStop = mapStops.find((stop) => stop.id === selectedItemId) ?? mapStops[0] ?? null;
  const impactedItemIds = useMemo(() => scenarioResult?.impacts
    .filter((impact) => impact.item_id && (impact.affected || impact.reason_codes.includes("HYPOTHETICAL_SOCIAL_CONTEXT")))
    .map((impact) => impact.item_id as string) ?? [], [scenarioResult]);
  const alternativeRouteGeometries = useMemo(
    () => scenarioResult?.scenario.routes.flatMap((route) => route.alternatives.map((alternative) => alternative.geometry)) ?? [],
    [scenarioResult],
  );

  const refreshSelectedItinerary = useCallback(async (outcome: ReplanApplyResult) => {
    setApplyOutcome(outcome);
    if (!selectedId) return;
    try {
      const refreshed = await getItinerary(selectedId);
      setItineraries((current) => current.map((item) => item.id === refreshed.id ? refreshed : item));
      setAppliedVersion(refreshed.version);
    } catch (cause) {
      setListError(cause instanceof ApiError ? cause.message : "The replan finished, but the updated itinerary could not be reloaded.");
    }
  }, [selectedId]);

  return (
    <>
      <header className="space-y-4" id="showcase-trips">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="accent">Evaluator walkthrough</Badge>
          <Badge tone="neutral">Live backend flows</Badge>
        </div>
        <div className="max-w-4xl">
          <h1 className="text-3xl font-semibold tracking-tight text-ink sm:text-4xl">LocaLens end‑to‑end showcase</h1>
          <p className="mt-3 text-sm leading-6 text-ink-muted sm:text-base">
            Follow one itinerary through live weather, map routes, area signals, a heavy‑rain simulation, Nugen interpretation, and an explicit backend replan.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link href="/trip"><Button><MapPinned className="size-4" aria-hidden="true" />Create a Mumbai itinerary</Button></Link>
          <Button type="button" variant="outline" onClick={() => { setListLoading(true); setScenarioResult(null); setAppliedVersion(null); setApplyOutcome(null); void loadItineraries(); }} disabled={listLoading}>
            <RefreshCw className="size-4" aria-hidden="true" />Refresh trips
          </Button>
        </div>
        <p className="text-xs leading-5 text-ink-subtle">Create the trip in Trips, then return here and select it. Showcase reads your saved backend itinerary; it does not seed or alter trip data.</p>
      </header>

      <nav aria-label="Showcase walkthrough" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        {WALKTHROUGH.map((step, index) => (
          <a key={step.id} href={`#${step.id}`} className="group rounded-2xl border border-line bg-surface-raised p-3 transition hover:border-accent/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
            <span className="flex items-center justify-between gap-2"><span className="flex size-7 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-ink">{index + 1}</span><ArrowDown className="size-3.5 text-ink-subtle group-hover:text-accent" aria-hidden="true" /></span>
            <span className="mt-2 block text-sm font-semibold text-ink">{step.label}</span>
            <span className="mt-1 block text-xs leading-5 text-ink-muted">{step.detail}</span>
          </a>
        ))}
      </nav>

      <Card>
        <CardBody className="space-y-4" aria-busy={listLoading}>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div><h2 className="text-lg font-semibold text-ink">1 · Trips</h2><p className="mt-1 text-sm text-ink-muted">Choose the itinerary to use across this walkthrough.</p></div>
            {itineraries.length ? <label className="flex min-w-64 flex-col gap-1 text-xs font-medium text-ink-muted">Saved itineraries
              <select value={selectedId} onChange={(event) => { setSelectedId(event.target.value); setSelectedItemId(null); setScenarioResult(null); setAppliedVersion(null); setApplyOutcome(null); }} className="h-11 rounded-xl border border-line-strong bg-surface px-3 text-sm text-ink">
                {itineraries.filter((item) => item.status !== "CANCELLED").map((item) => <option key={item.id} value={item.id}>{item.title} · {item.itinerary_date}</option>)}
              </select>
            </label> : null}
          </div>
          {listLoading ? <div className="space-y-3"><Skeleton className="h-5 w-72" /><Skeleton className="h-20 w-full rounded-xl" /></div> : null}
          {!listLoading && listError ? <ErrorState title="Trips unavailable" description={listError} onRetry={() => { setListLoading(true); void loadItineraries(); }} /> : null}
          {!listLoading && !listError && !itinerary ? <div className="rounded-2xl border border-dashed border-line-strong bg-surface-sunken p-5">
            <p className="font-medium text-ink">Start by composing a Mumbai itinerary.</p>
            <p className="mt-1 text-sm text-ink-muted">The showcase uses saved stops and their verified coordinates. After composing in Trips, come back and choose it here.</p>
            <Link href="/trip" className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-accent hover:underline">Open Trips <ArrowRight className="size-4" aria-hidden="true" /></Link>
          </div> : null}
          {itinerary ? <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl bg-surface-sunken px-4 py-3 text-sm">
            <span className="font-semibold text-ink">{itinerary.title}</span>
            <span className="text-ink-muted">{itinerary.itinerary_date} · {itinerary.start_time.slice(0, 5)}–{itinerary.end_time.slice(0, 5)}</span>
            <span className="text-ink-muted">{itinerary.items.length} experience stops · version {itinerary.version}</span>
            <Badge tone={itinerary.status === "VALIDATED" || itinerary.status === "BOOKING_REQUESTED" ? "success" : "neutral"}>{itinerary.status.replaceAll("_", " ")}</Badge>
          </div> : null}
        </CardBody>
      </Card>

      {itinerary ? <>
        <section id="showcase-weather" className="scroll-mt-6 space-y-3" aria-labelledby="showcase-weather-heading">
          <div><h2 id="showcase-weather-heading" className="flex items-center gap-2 text-lg font-semibold text-ink"><CloudSun className="size-5 text-accent" aria-hidden="true" />2 · Live Weather</h2><p className="mt-1 text-sm text-ink-muted">Weather is requested by the web client from FastAPI for the selected, verified itinerary stop.</p></div>
          <WeatherCard latitude={selectedMapStop?.latitude ?? null} longitude={selectedMapStop?.longitude ?? null} locationLabel={selectedMapStop?.locationLabel ?? selectedMapStop?.title ?? "selected stop"} />
          <p className="text-xs leading-5 text-ink-subtle">In development, use “Weather test scenario” to compare CLEAR and RAIN test inputs. They are labeled MOCK, temporary, and never replace the configured live source.</p>
        </section>

        <section id="showcase-map" className="scroll-mt-6 space-y-3" aria-labelledby="showcase-map-heading">
          <div><h2 id="showcase-map-heading" className="flex items-center gap-2 text-lg font-semibold text-ink"><MapPinned className="size-5 text-accent" aria-hidden="true" />3 · Map Visualization</h2><p className="mt-1 text-sm text-ink-muted">Map markers, route geometry, and impact highlights come from the selected itinerary and backend route results.</p></div>
          {appliedVersion !== null && applyOutcome ? <p className={`rounded-xl px-4 py-3 text-sm ${applyOutcome.status === "REPLANNED" ? "bg-success-soft text-ink" : "bg-surface-sunken text-ink-muted"}`} role="status">{applyOutcome.status === "REPLANNED" ? `Deterministic replan persisted. Itinerary reloaded at version ${appliedVersion}; the map below reflects the updated plan.` : `Backend returned ${applyOutcome.status.replaceAll("_", " ")}. Itinerary reloaded at version ${appliedVersion}; check the What‑If result for details.`}</p> : null}
          <ItineraryMap key={`${itinerary.id}:${itinerary.version}`} itinerary={itinerary} selectedItemId={selectedItemId} onSelectItem={setSelectedItemId} scenarioAffectedItemIds={impactedItemIds} scenarioRouteAlternativeGeometries={alternativeRouteGeometries} showWeatherCard={false} initialSocialVisible initialNearbyVisible socialHeading="4 · Social signals" useOwnedStopContext />
        </section>

        <section id="showcase-what-if" className="scroll-mt-6 space-y-3" aria-labelledby="showcase-what-if-heading">
          <div><h2 id="showcase-what-if-heading" className="flex items-center gap-2 text-lg font-semibold text-ink"><GitCompare className="size-5 text-accent" aria-hidden="true" />5 · Digital Twin / What‑If</h2><p className="mt-1 text-sm text-ink-muted">The preview begins with heavy rain and recent social context selected. Run it to see affected stops, deterministic feasibility findings, and proposed alternatives.</p></div>
          <WhatIfSimulationPanel key={itinerary.id} itinerary={itinerary} initialWeatherIntensity="heavy_rain" initialSocialMode="recent" onResult={setScenarioResult} onApplied={(result) => { void refreshSelectedItinerary(result); }} />
        </section>

        <Card id="showcase-nugen" className="scroll-mt-6">
          <CardBody className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div><h2 className="flex items-center gap-2 text-lg font-semibold text-ink"><Sparkles className="size-5 text-accent" aria-hidden="true" />6 · Nugen Domain Intelligence</h2><p className="mt-1 text-sm text-ink-muted">Safe server diagnostic plus the structured assessment returned with the What‑If preview.</p></div>
              {nugenHealth ? <Badge tone={nugenHealth.configured ? "success" : "warning"}>{nugenHealth.configured ? `Configuration present · ${nugenHealth.model_id ?? "model ID unavailable"}` : "Not configured"}</Badge> : <Badge tone={nugenHealthError ? "warning" : "neutral"}>{nugenHealthError ? "Status unavailable" : "Checking status"}</Badge>}
            </div>
            {nugenHealth && !nugenHealth.configured ? <p className="rounded-xl bg-warning-soft px-3.5 py-3 text-sm text-ink">To enable live Nugen analysis, set <code className="font-semibold">NUGEN_API_KEY</code> in the repository’s server-side <code>.env</code>, then restart FastAPI. The key is never sent to the browser. Endpoint and model ID are configured on the backend.</p> : null}
            {scenarioResult?.domain_intelligence ? <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-xl bg-surface-sunken p-3"><p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Analysis status</p><p className="mt-1 text-sm font-medium text-ink">{scenarioResult.domain_intelligence.status === "AVAILABLE" ? "Nugen response received" : scenarioResult.domain_intelligence.status === "UNAVAILABLE" ? "Unavailable · no assessment returned" : "Local explanation"}</p></div>
              <div className="rounded-xl bg-surface-sunken p-3"><p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Provider and model</p><p className="mt-1 text-sm font-medium text-ink">{scenarioResult.domain_intelligence.provider === "nugen" ? `Nugen · ${scenarioResult.domain_intelligence.model_id ?? (scenarioResult.domain_intelligence.status === "UNAVAILABLE" ? `configured ${nugenHealth?.model_id ?? "model ID unavailable"}` : "model ID not returned")}` : "Local preview provider"}</p></div>
              <div className="rounded-xl bg-surface-sunken p-3"><p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Model confidence</p><p className="mt-1 text-sm text-ink">{scenarioResult.domain_intelligence.confidence_score === null ? "Not returned" : `${scenarioResult.domain_intelligence.confidence_score} · advisory metadata`}</p></div>
              <div className="rounded-xl bg-surface-sunken p-3"><p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Uncertainty</p><p className="mt-1 text-sm text-ink">{scenarioResult.domain_intelligence.uncertainty ?? "Not returned"}</p></div>
              <div className="rounded-xl bg-surface-sunken p-3 md:col-span-2"><p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{scenarioResult.domain_intelligence.status === "UNAVAILABLE" ? "Failure detail" : "Assessment"}</p><p className="mt-1 text-sm leading-6 text-ink">{scenarioResult.domain_intelligence.summary}</p></div>
              <div className="rounded-xl bg-surface-sunken p-3"><p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Suitability</p><p className="mt-1 text-sm leading-6 text-ink">{scenarioResult.domain_intelligence.suitability_assessment ?? "Not returned"}</p></div>
              <div className="rounded-xl bg-surface-sunken p-3"><p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Disruption</p><p className="mt-1 text-sm leading-6 text-ink">{scenarioResult.domain_intelligence.disruption_assessment ?? "Not returned"}</p></div>
              <div className="rounded-xl bg-surface-sunken p-3 md:col-span-2"><p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Recommendation</p><p className="mt-1 text-sm leading-6 text-ink">{scenarioResult.domain_intelligence.recommendation ?? "Not returned"}</p></div>
              <div className="rounded-xl bg-surface-sunken p-3 md:col-span-2"><p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Nugen impacts and reason codes</p><p className="mt-1 text-sm text-ink">{scenarioResult.domain_intelligence.impacts.join(" · ") || "Not returned"}</p><p className="mt-1 text-xs text-ink-muted">{scenarioResult.domain_intelligence.reason_codes.join(", ") || "Not returned"}</p></div>
            </div> : <p className="rounded-xl bg-surface-sunken px-3.5 py-3 text-sm text-ink-muted">Run the What‑If preview to request domain analysis. If Nugen is unavailable, the backend reports that state; it will not fabricate a Nugen response.</p>}
            <p className="border-t border-line pt-3 text-xs leading-5 text-ink-subtle">Nugen interprets context only. Backend feasibility, actual availability, route computation, and itinerary state remain authoritative.</p>
          </CardBody>
        </Card>

        <section id="showcase-replan" className="scroll-mt-6 rounded-2xl border border-line bg-surface-sunken p-4" aria-labelledby="showcase-replan-heading">
          <h2 id="showcase-replan-heading" className="text-lg font-semibold text-ink">7 · Apply Replan</h2>
          <p className="mt-1 text-sm leading-6 text-ink-muted">Review the preview and explicitly confirm Apply Replan in the What‑If panel. FastAPI runs the deterministic replanner and this page reloads the persisted itinerary and map afterward. Preview alone is non-mutating.</p>
          {appliedVersion !== null && applyOutcome ? <div className="mt-3 flex flex-wrap items-center gap-2"><Badge tone={applyOutcome.status === "REPLANNED" ? "success" : "warning"}>{applyOutcome.status.replaceAll("_", " ")} · version {appliedVersion}</Badge><span className="text-xs text-ink-muted">The map above shows the latest itinerary returned by FastAPI.</span></div> : null}
        </section>
      </> : null}
    </>
  );
}
