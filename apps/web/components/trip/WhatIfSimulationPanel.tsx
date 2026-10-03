"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CloudRain, Download, GitCompare, LoaderCircle } from "lucide-react";
import { ApiError } from "@/lib/api/client";
import { applyItineraryWhatIf, simulateItineraryWhatIf } from "@/lib/api/digitalTwin";
import { downloadJsonFile } from "@/lib/utils/downloadJson";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import type { ApiItinerary } from "@/types/api";
import type { ReplanApplyResult, SimulationResult, WhatIfScenarioRequest } from "@/types/digitalTwin";

interface WhatIfSimulationPanelProps {
  itinerary: ApiItinerary;
  onApplied: (result: ReplanApplyResult) => void;
  onResult: (result: SimulationResult | null) => void;
  initialWeatherIntensity?: "none" | NonNullable<WhatIfScenarioRequest["weather"]>["intensity"];
  initialSocialMode?: "none" | "recent" | "hypothetical";
}

type StopOption = {
  id: string;
  title: string;
  sequence: number;
  plannedStart: string;
  latitude: number | null;
  longitude: number | null;
};

const WEATHER_OPTIONS: { value: NonNullable<WhatIfScenarioRequest["weather"]>["intensity"]; label: string }[] = [
  { value: "light_rain", label: "Light rain" },
  { value: "moderate_rain", label: "Moderate rain" },
  { value: "heavy_rain", label: "Heavy rain" },
  { value: "severe_rain", label: "Severe rain" },
  { value: "high_temperature", label: "High temperature" },
  { value: "extreme_heat", label: "Extreme heat" },
  { value: "strong_wind", label: "Strong wind" },
  { value: "poor_visibility", label: "Poor visibility" },
];

function stopOptions(itinerary: ApiItinerary): StopOption[] {
  const experiences = itinerary.items.map((item) => ({
    id: item.id,
    title: item.title ?? "Itinerary stop",
    sequence: item.sequence_order,
    plannedStart: item.planned_start,
    latitude: item.location_latitude,
    longitude: item.location_longitude,
  }));
  const custom = (itinerary.custom_activities ?? []).map((activity) => ({
    id: activity.id,
    title: activity.title,
    sequence: activity.sequence_order,
    plannedStart: activity.planned_start,
    latitude: activity.latitude,
    longitude: activity.longitude,
  }));
  return [...experiences, ...custom].sort(
    (left, right) => left.sequence - right.sequence || left.plannedStart.localeCompare(right.plannedStart),
  );
}

function weatherStatusLabel(status: SimulationResult["scenario"]["weather"][number]["status"]) {
  switch (status) {
    case "LIVE": return "Live weather";
    case "CACHED": return "Cached weather";
    case "STALE": return "Weather may be out of date";
    case "MOCK": return "Development weather";
    case "HYPOTHETICAL": return "Hypothetical weather";
    default: return "Weather unavailable";
  }
}

function expiryLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Preview expires soon" : `Preview valid until ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function timestampLabel(value: string | null | undefined) {
  if (!value) return "Not provided";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not provided" : date.toLocaleString();
}

function evidenceValue(value: number | null, suffix = "") {
  return value === null || !Number.isFinite(value) ? "Not provided" : `${value}${suffix}`;
}

export function WhatIfSimulationPanel({ itinerary, onApplied, onResult, initialWeatherIntensity = "none", initialSocialMode = "none" }: WhatIfSimulationPanelProps) {
  const stops = useMemo(() => stopOptions(itinerary), [itinerary]);
  const locatedStops = useMemo(
    () => stops.filter((stop) => stop.latitude !== null && stop.longitude !== null),
    [stops],
  );
  const [weatherIntensity, setWeatherIntensity] = useState<"none" | NonNullable<WhatIfScenarioRequest["weather"]>["intensity"]>(initialWeatherIntensity);
  const [weatherStart, setWeatherStart] = useState(() => (typeof itinerary.start_time === "string" ? itinerary.start_time.slice(0, 5) : "") || "00:00");
  const [socialMode, setSocialMode] = useState<"none" | "recent" | "hypothetical">(initialSocialMode);
  const [socialTargetId, setSocialTargetId] = useState(() => locatedStops[0]?.id ?? "");
  const [socialTopic, setSocialTopic] = useState<NonNullable<WhatIfScenarioRequest["hypothetical_social"]>["topic"]>("flooding");
  const [routeKind, setRouteKind] = useState<"none" | "congestion" | "road_disruption" | "temporary_closure" | "walking_condition">("none");
  const [routeTargetId, setRouteTargetId] = useState(() => locatedStops[1]?.id ?? locatedStops[0]?.id ?? "");
  const [delayMinutes, setDelayMinutes] = useState(30);
  const [unavailableTargetId, setUnavailableTargetId] = useState("");
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [applyResult, setApplyResult] = useState<ReplanApplyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmApply, setConfirmApply] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const targetStop = locatedStops.find((stop) => stop.id === socialTargetId);
  const routeTarget = locatedStops.find((stop) => stop.id === routeTargetId);
  const actionableImpact = (result?.delta.affected_stop_count ?? 0) > 0 && (result?.impacts.some(
    (impact) => impact.affected && (impact.category === "weather" || impact.category === "experience"),
  ) ?? false);
  const requestedUnavailableStop = result?.impacts.some((impact) => impact.reason_codes.includes("USER_ASSUMED_UNAVAILABLE")) ?? false;
  const scenarioAffectedIds = useMemo(() => result?.impacts
    .filter((impact) => impact.item_id && (impact.affected || impact.reason_codes.includes("HYPOTHETICAL_SOCIAL_CONTEXT")))
    .map((impact) => impact.item_id as string) ?? [], [result]);

  async function runSimulation() {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy(true);
    setError(null);
    setNotice(null);
    setConfirmApply(false);
    setResult(null);
    setApplyResult(null);
    onResult(null);

    const request: WhatIfScenarioRequest = {
      name: "Trip what-if preview",
      include_recent_social_context: socialMode === "recent",
      horizon_hours: 72,
      experience_overrides: unavailableTargetId
        ? [{ item_id: unavailableTargetId, condition: "unavailable" }]
        : [],
    };
    if (weatherIntensity !== "none") {
      request.weather = { intensity: weatherIntensity, starts_at: `${weatherStart}:00` };
    }
    if (socialMode === "recent" && targetStop) request.social_context_item_id = targetStop.id;
    if (socialMode === "hypothetical" && targetStop) {
      request.hypothetical_social = { topic: socialTopic, severity: "moderate", around_item_id: targetStop.id };
    }
    if (routeKind !== "none" && routeTarget) {
      request.route = {
        kind: routeKind,
        to_item_id: routeTarget.id,
        ...(routeKind === "congestion" ? { assumed_delay_minutes: delayMinutes } : {}),
      };
    }

    try {
      const simulation = await simulateItineraryWhatIf(itinerary.id, request, controller.signal);
      if (!controller.signal.aborted) {
        setResult(simulation);
        onResult(simulation);
      }
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(cause instanceof ApiError ? cause.message : "Couldn't run this scenario. Try again.");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  async function confirmApplySimulation() {
    if (!result || !actionableImpact) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const applied = await applyItineraryWhatIf(result.simulation_id);
      setApplyResult(applied);
      setConfirmApply(false);
      if (applied.status === "CONFLICT") {
        setNotice("The itinerary changed since this preview. Run the scenario again.");
        setResult(null);
        onResult(null);
      } else {
        setNotice(applied.message ?? applied.context_summary ?? "The replanning service handled the confirmed scenario.");
        setResult(null);
        onResult(null);
        onApplied(applied);
      }
    } catch (cause) {
      if (cause instanceof ApiError && (cause.status === 409 || cause.status === 410)) {
        setNotice("This preview expired or the itinerary changed. Run the scenario again.");
        setResult(null);
        onResult(null);
      } else {
        setError(cause instanceof ApiError ? cause.message : "Couldn't apply this scenario.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="trip-what-if" className="space-y-4 rounded-3xl border border-line bg-surface-raised p-4 shadow-soft sm:p-5" aria-labelledby="what-if-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-pastel-lavender text-accent" aria-hidden="true"><GitCompare className="size-4" /></span>
          <div>
            <h2 id="what-if-heading" className="text-lg font-semibold tracking-tight text-ink">What if?</h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-ink-muted">Preview weather, route, and experience assumptions against this itinerary. A preview never changes your trip.</p>
          </div>
        </div>
        <Badge tone="neutral">Backend evaluated</Badge>
      </div>

      <div className="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <fieldset className="min-w-0 space-y-2 rounded-2xl border border-line bg-surface p-3.5">
          <legend className="px-1 text-sm font-semibold text-ink">Weather assumption</legend>
          <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-ink-muted">Condition
            <select className="h-10 w-full min-w-0 rounded-xl border border-line-strong bg-surface-raised px-3 text-sm text-ink" value={weatherIntensity} onChange={(event) => setWeatherIntensity(event.target.value as typeof weatherIntensity)}>
              <option value="none">No weather change</option>
              {WEATHER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          {weatherIntensity !== "none" ? <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-ink-muted">Starting at
            <input className="h-10 w-full min-w-0 rounded-xl border border-line-strong bg-surface-raised px-3 text-sm text-ink" type="time" value={weatherStart} onChange={(event) => setWeatherStart(event.target.value)} />
          </label> : null}
          <p className="text-xs leading-5 text-ink-subtle">Weather inputs are shown as hypothetical and are not forecasts.</p>
        </fieldset>

        <fieldset className="min-w-0 space-y-2 rounded-2xl border border-line bg-surface p-3.5">
          <legend className="px-1 text-sm font-semibold text-ink">Area context</legend>
          <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-ink-muted">Context type
            <select className="h-10 w-full min-w-0 rounded-xl border border-line-strong bg-surface-raised px-3 text-sm text-ink" value={socialMode} onChange={(event) => setSocialMode(event.target.value as typeof socialMode)}>
              <option value="none">No social context</option>
              <option value="recent">Fetch recent public signals</option>
              <option value="hypothetical">Assume a social disruption</option>
            </select>
          </label>
          {socialMode !== "none" ? <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-ink-muted">Around stop
            <select className="h-10 w-full min-w-0 rounded-xl border border-line-strong bg-surface-raised px-3 text-sm text-ink" value={socialTargetId} onChange={(event) => setSocialTargetId(event.target.value)}>
              {locatedStops.map((stop) => <option key={stop.id} value={stop.id}>{stop.sequence}. {stop.title}</option>)}
            </select>
          </label> : null}
          {socialMode === "hypothetical" ? <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-ink-muted">Assumed topic
            <select className="h-10 w-full min-w-0 rounded-xl border border-line-strong bg-surface-raised px-3 text-sm text-ink" value={socialTopic} onChange={(event) => setSocialTopic(event.target.value as typeof socialTopic)}>
              <option value="flooding">Flooding / waterlogging</option><option value="road_disruption">Road disruption</option><option value="crowding">Crowding</option><option value="event_disruption">Event disruption</option><option value="weather">Weather</option><option value="heat">Heat</option><option value="wind">Wind</option>
            </select>
          </label> : null}
          <p className="text-xs leading-5 text-ink-subtle">Recent signals are opt-in, area-level and advisory. No post content is shown.</p>
        </fieldset>

        <fieldset className="min-w-0 space-y-2 rounded-2xl border border-line bg-surface p-3.5">
          <legend className="px-1 text-sm font-semibold text-ink">Route assumption</legend>
          <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-ink-muted">Route condition
            <select className="h-10 w-full min-w-0 rounded-xl border border-line-strong bg-surface-raised px-3 text-sm text-ink" value={routeKind} onChange={(event) => setRouteKind(event.target.value as typeof routeKind)}>
              <option value="none">No route change</option><option value="congestion">Assume a delay</option><option value="road_disruption">Road disruption</option><option value="temporary_closure">Temporary closure</option><option value="walking_condition">Walking condition</option>
            </select>
          </label>
          {routeKind !== "none" ? <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-ink-muted">To stop
            <select className="h-10 w-full min-w-0 rounded-xl border border-line-strong bg-surface-raised px-3 text-sm text-ink" value={routeTargetId} onChange={(event) => setRouteTargetId(event.target.value)}>
              {locatedStops.map((stop) => <option key={stop.id} value={stop.id}>{stop.sequence}. {stop.title}</option>)}
            </select>
          </label> : null}
          {routeKind === "congestion" ? <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-ink-muted">Assumed delay (minutes)
            <input className="h-10 w-full min-w-0 rounded-xl border border-line-strong bg-surface-raised px-3 text-sm text-ink" type="number" min={0} max={240} value={delayMinutes} onChange={(event) => setDelayMinutes(Number(event.target.value))} />
          </label> : null}
          <p className="text-xs leading-5 text-ink-subtle">For disruption assumptions, the preview can show actual OSRM route options when available. OSRM does not receive the assumed closure, so an option is not verified to avoid it.</p>
        </fieldset>

        <fieldset className="min-w-0 space-y-2 rounded-2xl border border-line bg-surface p-3.5">
          <legend className="px-1 text-sm font-semibold text-ink">Experience assumption</legend>
          <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-ink-muted">Stop status
            <select className="h-10 w-full min-w-0 rounded-xl border border-line-strong bg-surface-raised px-3 text-sm text-ink" value={unavailableTargetId} onChange={(event) => setUnavailableTargetId(event.target.value)}>
              <option value="">No experience change</option>
              {stops.map((stop) => <option key={stop.id} value={stop.id}>{stop.sequence}. {stop.title} · assume unavailable</option>)}
            </select>
          </label>
          <p className="text-xs leading-5 text-ink-subtle">This is your scenario input, not a provider-confirmed availability update.</p>
        </fieldset>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={runSimulation} loading={busy} disabled={busy || (socialMode !== "none" && !locatedStops.length) || (routeKind !== "none" && !routeTarget)}>
          <CloudRain className="size-4" aria-hidden="true" />Run what-if preview
        </Button>
        {result ? <span className="text-xs text-ink-subtle">{expiryLabel(result.expires_at)}</span> : null}
      </div>

      {error ? <p className="rounded-xl bg-danger-soft px-3.5 py-3 text-sm text-danger" role="alert">{error}</p> : null}
      {notice ? <p className="rounded-xl bg-surface-sunken px-3.5 py-3 text-sm text-ink-muted" role="status">{notice}</p> : null}
      {applyResult ? <section className="rounded-2xl border border-line bg-surface p-4" aria-label="Replanning result">
        <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold text-ink">Replanning result</h3><Badge tone={applyResult.status === "REPLANNED" ? "success" : applyResult.status === "REQUIRES_USER_ACTION" ? "warning" : "neutral"}>{applyResult.status.replaceAll("_", " ")}</Badge></div>
        {applyResult.message ? <p className="mt-2 text-sm text-ink-muted">{applyResult.message}</p> : null}
        <p className="mt-1 text-sm text-ink-muted">{applyResult.context_summary}</p>
        <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <div><dt className="font-medium text-ink">Itinerary version</dt><dd className="mt-0.5 text-ink-muted">{applyResult.previous_version ?? "—"} → {applyResult.new_version ?? "—"}</dd></div>
          <div><dt className="font-medium text-ink">Trigger</dt><dd className="mt-0.5 text-ink-muted">{applyResult.trigger ?? "Not provided"}</dd></div>
          <div><dt className="font-medium text-ink">Reason code</dt><dd className="mt-0.5 text-ink-muted">{applyResult.reason_code ?? "None"}</dd></div>
          <div><dt className="font-medium text-ink">Generated</dt><dd className="mt-0.5 text-ink-muted">{timestampLabel(applyResult.generated_at)}</dd></div>
        </dl>
        <ul className="mt-3 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-5" aria-label="Replanning changes">
          {(["added_items", "removed_items", "moved_items", "unchanged_items", "affected_items"] as const).map((change) => (
            <li key={change} className="rounded-xl bg-surface-sunken px-3 py-2"><p className="font-medium capitalize text-ink">{change.replaceAll("_", " ")} ({applyResult.changes[change].length})</p>{applyResult.changes[change].length ? <p className="mt-1 text-ink-muted">{applyResult.changes[change].join(", ")}</p> : <p className="mt-1 text-ink-subtle">None</p>}</li>
          ))}
        </ul>
        {applyResult.validation_issues.length ? <ul className="mt-3 space-y-1 rounded-xl bg-warning-soft p-3 text-xs text-warning" aria-label="Replanning validation issues">{applyResult.validation_issues.map((issue, index) => <li key={`${index}:${issue}`}>{issue}</li>)}</ul> : null}
      </section> : null}

      {result ? <div className="space-y-4 border-t border-line pt-4" aria-live="polite">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold text-ink">{result.scenario_name}</h3><Badge tone={result.status === "PARTIAL" ? "warning" : "accent"}>{result.status}</Badge></div><p className="mt-1 text-sm text-ink-muted">{result.delta.summary}</p></div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral">{result.delta.change_level.replaceAll("_", " ")}</Badge>
            <Badge tone="neutral">{result.delta.affected_stop_count} stop{result.delta.affected_stop_count === 1 ? "" : "s"} affected</Badge>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => downloadJsonFile("localens-what-if-preview.json", {
                schema: "localens.what-if-preview.v1",
                data: result,
              })}
            >
              <Download className="size-4" aria-hidden="true" />Preview JSON
            </Button>
          </div>
        </div>
        {weatherIntensity !== "none" && result.scenario.stops.length > 0 && result.scenario.stops.every((stop) => !stop.weather_sensitivity || stop.weather_sensitivity === "UNKNOWN" || !stop.weather_policy || stop.weather_policy === "NONE") ? <p className="rounded-xl bg-warning-soft px-3.5 py-3 text-sm leading-6 text-ink" role="status">This itinerary has no recorded weather-sensitivity rules for its stops. The preview keeps feasibility unchanged until verified stop metadata supports a weather impact.</p> : null}

        <section className="rounded-2xl border border-line bg-surface p-4" aria-label="Simulation metadata and change summary">
          <h4 className="text-sm font-semibold text-ink">Simulation details</h4>
          <dl className="mt-3 grid gap-x-5 gap-y-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
            <div><dt className="font-medium text-ink">Trip date and timezone</dt><dd className="mt-0.5 text-ink-muted">{result.baseline.itinerary_date} · {result.baseline.timezone}</dd></div>
            <div><dt className="font-medium text-ink">Itinerary version</dt><dd className="mt-0.5 text-ink-muted">{result.baseline.itinerary_version} · {result.baseline.itinerary_status}</dd></div>
            <div><dt className="font-medium text-ink">Baseline snapshot</dt><dd className="mt-0.5 break-all text-ink-muted">{result.baseline.snapshot_id} · {timestampLabel(result.baseline.generated_at)}</dd></div>
            <div><dt className="font-medium text-ink">Simulation ID</dt><dd className="mt-0.5 break-all text-ink-muted">{result.simulation_id}</dd></div>
            <div><dt className="font-medium text-ink">Simulation created</dt><dd className="mt-0.5 text-ink-muted">{timestampLabel(result.created_at)} · {expiryLabel(result.expires_at)}</dd></div>
            <div><dt className="font-medium text-ink">Stops</dt><dd className="mt-0.5 text-ink-muted">{result.delta.affected_stop_count} affected · {result.delta.unchanged_stop_count} unchanged</dd></div>
            <div><dt className="font-medium text-ink">Routes</dt><dd className="mt-0.5 text-ink-muted">{result.delta.affected_route_count} affected</dd></div>
            <div><dt className="font-medium text-ink">Additional travel</dt><dd className="mt-0.5 text-ink-muted">{evidenceValue(result.delta.additional_travel_minutes, " min")}</dd></div>
            <div><dt className="font-medium text-ink">Traveler context</dt><dd className="mt-0.5 text-ink-muted">{result.baseline.traveler_context_available ? "Available" : "Unavailable"}</dd></div>
          </dl>
          <p className="mt-3 border-t border-line pt-3 text-xs leading-5 text-ink-muted">{result.simulation_confidence_note}</p>
        </section>

        {result.domain_intelligence ? <section className="rounded-2xl border border-line bg-surface p-4" aria-label="Domain intelligence interpretation">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-semibold text-ink">Domain intelligence</h4>
            <Badge tone={result.domain_intelligence.status === "UNAVAILABLE" ? "warning" : "neutral"}>{result.domain_intelligence.status === "UNAVAILABLE" ? "Nugen unavailable · preview preserved" : result.domain_intelligence.provider === "nugen" ? `Nugen · ${result.domain_intelligence.model_id ?? "model"}` : "Local preview"}</Badge>
          </div>
          <p className="mt-2 text-sm leading-6 text-ink">{result.domain_intelligence.summary}</p>
          <dl className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl bg-surface-sunken p-3"><dt className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Suitability</dt><dd className="mt-1 text-sm leading-6 text-ink">{result.domain_intelligence.suitability_assessment ?? "Not returned"}</dd></div>
            <div className="rounded-xl bg-surface-sunken p-3"><dt className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Disruption</dt><dd className="mt-1 text-sm leading-6 text-ink">{result.domain_intelligence.disruption_assessment ?? "Not returned"}</dd></div>
            <div className="rounded-xl bg-surface-sunken p-3 sm:col-span-2"><dt className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Recommendation</dt><dd className="mt-1 text-sm leading-6 text-ink">{result.domain_intelligence.recommendation ?? "Not returned"}</dd></div>
          </dl>
          {result.domain_intelligence.impacts.length > 0 ? <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-ink-muted">
            {result.domain_intelligence.impacts.map((impact, index) => <li key={`${index}-${impact}`}>{impact}</li>)}
          </ul> : null}
          {result.domain_intelligence.uncertainty ? <p className="mt-3 text-xs leading-5 text-ink-muted"><span className="font-medium text-ink">Uncertainty: </span>{result.domain_intelligence.uncertainty}</p> : null}
          {result.domain_intelligence.confidence_score !== null ? <p className="mt-2 text-xs text-ink-muted">Model-reported confidence score: {result.domain_intelligence.confidence_score} (advisory metadata, not a feasibility score)</p> : null}
          {result.domain_intelligence.finish_reason || result.domain_intelligence.usage ? <p className="mt-2 text-xs text-ink-muted">
            {result.domain_intelligence.finish_reason ? `Finish reason: ${result.domain_intelligence.finish_reason}` : null}
            {result.domain_intelligence.finish_reason && result.domain_intelligence.usage ? " · " : null}
            {result.domain_intelligence.usage ? `Usage: ${Object.entries(result.domain_intelligence.usage).map(([key, value]) => `${key} ${value}`).join(" · ")}` : null}
          </p> : null}
          <p className="mt-3 border-t border-line pt-3 text-xs leading-5 text-ink-muted">Interpretation only. LocaLens deterministic feasibility and trip state remain authoritative; this analysis does not change the itinerary.</p>
        </section> : null}

        <div className="grid gap-3 lg:grid-cols-2">
          <section className="rounded-2xl border border-line bg-surface p-4" aria-label="Weather comparison">
            <h4 className="text-sm font-semibold text-ink">Weather by stop</h4>
            <p className="mt-1 text-xs leading-5 text-ink-muted">The hypothetical values are the shared scenario input. Current observations are fetched separately at each stop location and are not historical weather for the planned visit.</p>
            <ul className="mt-2 space-y-2">{result.scenario.weather.map((weather) => {
              const stop = stops.find((entry) => entry.id === weather.item_id);
              const baselineWeather = result.baseline.plan.weather.find((entry) => entry.item_id === weather.item_id);
              const currentWeather = result.scenario.current_weather.find((entry) => entry.item_id === weather.item_id);
              return <li key={weather.item_id} className="rounded-xl bg-surface-sunken px-3 py-2.5 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium text-ink">{stop?.title ?? "Itinerary stop"}</span><span className="text-xs text-ink-muted">{weather.condition ?? "Condition unavailable"} · {weatherStatusLabel(weather.status)}</span></div>
                <dl className="mt-2 grid gap-x-3 gap-y-1 text-xs text-ink-muted sm:grid-cols-2">
                  <div><dt className="inline font-medium text-ink">Temperature: </dt><dd className="inline">{evidenceValue(weather.temperature_c, "°C")}{baselineWeather ? ` (planned forecast ${evidenceValue(baselineWeather.temperature_c, "°C")})` : ""}</dd></div>
                  <div><dt className="inline font-medium text-ink">Rain chance: </dt><dd className="inline">{evidenceValue(weather.precipitation_probability, "%")}</dd></div>
                  <div><dt className="inline font-medium text-ink">Precipitation: </dt><dd className="inline">{evidenceValue(weather.precipitation_amount, " mm")}</dd></div>
                  <div><dt className="inline font-medium text-ink">Wind: </dt><dd className="inline">{evidenceValue(weather.wind_speed, " m/s")}</dd></div>
                  <div><dt className="inline font-medium text-ink">Visibility: </dt><dd className="inline">{evidenceValue(weather.visibility_km, " km")}</dd></div>
                  <div><dt className="inline font-medium text-ink">Severe alert: </dt><dd className="inline">{weather.severe_alert === null ? "Unknown" : weather.severe_alert ? "Yes" : "No"}</dd></div>
                  <div><dt className="inline font-medium text-ink">Observed: </dt><dd className="inline">{timestampLabel(weather.observed_at)}</dd></div>
                  <div><dt className="inline font-medium text-ink">Evidence expires: </dt><dd className="inline">{timestampLabel(weather.expires_at)}</dd></div>
                  {currentWeather ? <div className="sm:col-span-2 border-t border-line pt-2"><dt className="inline font-medium text-ink">Current at location: </dt><dd className="inline">{currentWeather.condition ?? "Condition unavailable"} · {weatherStatusLabel(currentWeather.status)} · {evidenceValue(currentWeather.temperature_c, "°C")} · rain {evidenceValue(currentWeather.precipitation_probability, "%")} · wind {evidenceValue(currentWeather.wind_speed, " m/s")} · visibility {evidenceValue(currentWeather.visibility_km, " km")} · observed {timestampLabel(currentWeather.observed_at)}</dd></div> : null}
                  {baselineWeather ? <div className="sm:col-span-2"><dt className="inline font-medium text-ink">Planned-time forecast: </dt><dd className="inline">{baselineWeather.condition ?? "Condition unavailable"} · {weatherStatusLabel(baselineWeather.status)} · {evidenceValue(baselineWeather.temperature_c, "°C")} · rain {evidenceValue(baselineWeather.precipitation_probability, "%")} · precipitation {evidenceValue(baselineWeather.precipitation_amount, " mm")} · wind {evidenceValue(baselineWeather.wind_speed, " m/s")} · visibility {evidenceValue(baselineWeather.visibility_km, " km")} · severe alert {baselineWeather.severe_alert === null ? "unknown" : baselineWeather.severe_alert ? "yes" : "no"} · observed {timestampLabel(baselineWeather.observed_at)} · expires {timestampLabel(baselineWeather.expires_at)}</dd></div> : null}
                </dl>
              </li>;
            })}</ul>
          </section>
          <section className="rounded-2xl border border-line bg-surface p-4" aria-label="Route comparison">
            <h4 className="text-sm font-semibold text-ink">Route comparison</h4>
            {result.scenario.routes.length ? <ul className="mt-2 space-y-2">{result.scenario.routes.map((route) => {
              const from = stops.find((entry) => entry.id === route.from_item_id)?.title ?? "Previous stop";
              const to = stops.find((entry) => entry.id === route.to_item_id)?.title ?? "Next stop";
              const routeLabel = route.source === "osrm" ? "OSRM" : route.source === "haversine_estimate" ? "Travel estimate" : "Route geometry unavailable";
              const baselineRoute = result.baseline.plan.routes.find((entry) => entry.from_item_id === route.from_item_id && entry.to_item_id === route.to_item_id);
              return <li key={`${route.from_item_id}:${route.to_item_id}`} className="rounded-xl bg-surface-sunken px-3 py-2 text-sm">
                <p className="font-medium text-ink">{from} → {to}</p>
                <p className="mt-1 text-xs text-ink-muted">{routeLabel} · {route.scenario_status.replaceAll("_", " ")}</p>
                <p className="mt-1 text-xs text-ink-muted">{evidenceValue(route.distance_km, " km")} · planned {evidenceValue(route.duration_minutes, " min")} · scenario {evidenceValue(route.scenario_duration_minutes, " min")} · delta {evidenceValue(route.delta_minutes, " min")} · {route.geometry ? "geometry included" : "geometry unavailable"}</p>
                {baselineRoute ? <p className="mt-1 text-xs text-ink-subtle">Baseline {baselineRoute.source} · {evidenceValue(baselineRoute.distance_km, " km")} · {evidenceValue(baselineRoute.duration_minutes, " min")} · {baselineRoute.scenario_status.replaceAll("_", " ")}{baselineRoute.explanation ? ` · ${baselineRoute.explanation}` : ""}</p> : <p className="mt-1 text-xs text-ink-subtle">No baseline route evidence for this leg.</p>}
                {route.explanation ? <p className="mt-1 text-xs text-ink-subtle">{route.explanation}</p> : null}
                {route.alternatives.length ? <div className="mt-3 space-y-2 border-t border-line pt-3">
                  <p className="text-xs font-semibold text-ink">OSRM route options</p>
                  {route.alternatives.map((option, index) => <p key={`${index}:${option.distance_km}:${option.duration_minutes}`} className="rounded-lg border border-highlight/20 bg-surface px-2.5 py-2 text-xs text-ink-muted">
                    Option {index + 1} · {option.distance_km.toFixed(1)} km · {Math.round(option.duration_minutes)} min · real OSRM geometry
                  </p>)}
                  <p className="text-xs leading-5 text-warning">These options do not account for the assumed closure or disruption. Confirm local conditions before selecting one.</p>
                </div> : null}
              </li>;
            })}</ul> : <p className="mt-2 text-sm text-ink-muted">No consecutive verified route legs are available.</p>}
          </section>
        </div>

        {result.scenario.social.status !== "NOT_REQUESTED" ? <section className="rounded-2xl border border-line bg-surface p-4" aria-label="Social context result">
          <h4 className="text-sm font-semibold text-ink">Area context · {result.scenario.social.status.replaceAll("_", " ")}</h4>
          <p className="mt-1 text-xs text-ink-muted">Scenario: {result.scenario.social.queried_location ?? "Location unavailable"} · {timestampLabel(result.scenario.social.generated_at)}</p>
          {result.scenario.social.message ? <p className="mt-1 text-sm text-ink-muted">{result.scenario.social.message}</p> : null}
          {result.scenario.social.clusters.length ? <ul className="mt-2 grid gap-2 sm:grid-cols-2">{result.scenario.social.clusters.map((cluster, index) => <li key={`${cluster.topic}:${index}`} className="rounded-xl bg-surface-sunken px-3 py-2 text-sm">
            <p className="font-medium text-ink">{cluster.topic.replaceAll("_", " ")} · {cluster.severity}</p>
            <p className="mt-1 text-xs text-ink-muted">{cluster.status === "HYPOTHETICAL" ? "Hypothetical scenario input · no observed posts or counts" : `${cluster.signal_count ?? "—"} area-level signals · ${cluster.independent_source_count ?? "—"} independent sources`}</p>
            <p className="mt-1 text-xs text-ink-muted">Location: {cluster.location_name ?? result.scenario.social.queried_location ?? "Not provided"} · Platforms: {cluster.source_platforms.join(", ") || "Not provided"}</p>
            <p className="mt-1 text-xs text-ink-muted">Newest signal: {timestampLabel(cluster.newest_signal_at)} · Confidence: {cluster.confidence === null ? "Not provided" : `${Math.round(cluster.confidence * 100)}%`}</p>
            {cluster.confidence_note ? <p className="mt-1 text-xs text-ink-subtle">{cluster.confidence_note}</p> : null}
          </li>)}</ul> : null}
          {result.baseline.plan.social.status !== "NOT_REQUESTED" ? <div className="mt-3 border-t border-line pt-3">
            <p className="text-xs font-medium text-ink">Baseline context · {result.baseline.plan.social.status.replaceAll("_", " ")} · {result.baseline.plan.social.queried_location ?? "Location unavailable"} · {timestampLabel(result.baseline.plan.social.generated_at)}</p>
            {result.baseline.plan.social.message ? <p className="mt-1 text-xs text-ink-muted">{result.baseline.plan.social.message}</p> : null}
            {result.baseline.plan.social.clusters.length ? <ul className="mt-2 grid gap-2 sm:grid-cols-2">{result.baseline.plan.social.clusters.map((cluster, index) => <li key={`baseline:${cluster.topic}:${index}`} className="rounded-xl bg-surface-sunken px-3 py-2 text-xs">
              <p className="font-medium text-ink">{cluster.topic.replaceAll("_", " ")} · {cluster.severity} · {cluster.status.replaceAll("_", " ")}</p>
              <p className="mt-1 text-ink-muted">{cluster.location_name ?? "Location unavailable"} · {cluster.source_platforms.join(", ") || "Platform unavailable"} · {cluster.signal_count ?? "—"} signals · {cluster.independent_source_count ?? "—"} independent sources</p>
              <p className="mt-1 text-ink-subtle">Newest {timestampLabel(cluster.newest_signal_at)} · {cluster.confidence === null ? "Confidence unavailable" : `${Math.round(cluster.confidence * 100)}% confidence`}{cluster.confidence_note ? ` · ${cluster.confidence_note}` : ""}</p>
            </li>)}</ul> : <p className="mt-1 text-xs text-ink-muted">No baseline clusters were returned.</p>}
          </div> : null}
        </section> : null}

        <section className="rounded-2xl border border-line bg-surface p-4" aria-label="Stop-by-stop plan comparison">
          <h4 className="text-sm font-semibold text-ink">Stop-by-stop plan</h4>
          {result.scenario.stops.length ? <ol className="mt-2 grid gap-2 md:grid-cols-2">
            {result.scenario.stops.map((stop) => {
              const baselineStop = result.baseline.plan.stops.find((entry) => entry.item_id === stop.item_id);
              return <li key={stop.item_id} className="rounded-xl bg-surface-sunken px-3 py-2.5 text-sm">
                <p className="font-medium text-ink">{stop.sequence}. {stop.title}</p>
                <p className="mt-1 text-xs text-ink-muted">Baseline {baselineStop ? `${timestampLabel(baselineStop.planned_start)} – ${timestampLabel(baselineStop.planned_end)} · ${baselineStop.state} · ${baselineStop.locked ? "locked" : "flexible"}` : "not in baseline"}</p>
                <p className="mt-1 text-xs text-ink-muted">Scenario {timestampLabel(stop.planned_start)} – {timestampLabel(stop.planned_end)} · {stop.state}{stop.locked ? " · locked" : " · flexible"}</p>
                {baselineStop ? <p className="mt-1 text-xs text-ink-subtle">Baseline location {baselineStop.latitude === null || baselineStop.longitude === null ? "not verified" : `${baselineStop.latitude.toFixed(5)}, ${baselineStop.longitude.toFixed(5)}`} · {baselineStop.environmental_type ?? "environment type unavailable"} · weather {baselineStop.weather_sensitivity ?? "not specified"}/{baselineStop.weather_policy ?? "not specified"} · provider {baselineStop.provider_verification_status ?? "not provided"}{baselineStop.is_synthetic === null ? "" : baselineStop.is_synthetic ? " · demo record" : " · non-synthetic record"}</p> : null}
                <p className="mt-1 text-xs text-ink-muted">Location {stop.latitude === null || stop.longitude === null ? "not verified" : `${stop.latitude.toFixed(5)}, ${stop.longitude.toFixed(5)}`} · {stop.environmental_type ?? "environment type unavailable"}</p>
                <p className="mt-1 text-xs text-ink-subtle">Weather sensitivity {stop.weather_sensitivity ?? "not specified"} · policy {stop.weather_policy ?? "not specified"} · provider {stop.provider_verification_status ?? "not provided"}{stop.is_synthetic === null ? "" : stop.is_synthetic ? " · demo record" : " · non-synthetic record"}</p>
              </li>;
            })}
          </ol> : <p className="mt-2 text-sm text-ink-muted">No stop-level scenario details were returned.</p>}
        </section>

        {result.alternatives.length ? <section className="rounded-2xl border border-line bg-surface p-4" aria-label="Ranked itinerary alternatives">
          <h4 className="text-sm font-semibold text-ink">Feasible alternatives from discovery</h4>
          <ul className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{result.alternatives.map((alternative) => <li key={`${alternative.for_item_id}:${alternative.experience_id}`} className="rounded-xl bg-surface-sunken px-3 py-2 text-sm">
            <p className="font-medium text-ink">{alternative.title}</p>
            <p className="mt-1 text-xs text-ink-muted">{alternative.category} · {alternative.environmental_type} · local forecast suitability {alternative.weather_suitability.replaceAll("WEATHER_", "").toLowerCase().replaceAll("_", " ")}</p>
            <p className="mt-1 text-xs text-ink-muted">Weather at this alternative · {alternative.weather_condition ?? "condition unavailable"} · {weatherStatusLabel(alternative.weather_status)} · {evidenceValue(alternative.weather_temperature_c, "°C")} · rain {evidenceValue(alternative.weather_precipitation_probability, "%")} · {evidenceValue(alternative.weather_precipitation_amount, " mm")} precipitation · wind {evidenceValue(alternative.weather_wind_speed, " m/s")}</p>
            <p className="mt-1 text-xs text-ink-subtle">Forecast time {timestampLabel(alternative.weather_at)}. Local weather is evidence for this candidate location and does not confirm provider availability.</p>
            <p className="mt-1 text-xs text-ink-subtle">Ranking score {alternative.ranking_score.toFixed(3)} · for stop {stops.find((stop) => stop.id === alternative.for_item_id)?.title ?? alternative.for_item_id}</p>
            {alternative.is_synthetic ? <Badge className="mt-2" tone="warning">Development catalog entry</Badge> : null}
          </li>)}</ul>
        </section> : <div className="rounded-xl bg-surface-sunken px-3.5 py-3 text-sm text-ink-muted" role="status">
          {requestedUnavailableStop && result.delta.affected_stop_count === 0 ? <>
            <p>The unavailable assumption targets a completed or in-progress stop, so the backend correctly kept the saved itinerary unchanged. Select an upcoming itinerary to get feasible replacements ranked from the existing catalog.</p>
            <Link href="/trip" className="mt-2 inline-flex font-semibold text-accent hover:underline">Compose an upcoming itinerary from existing experiences</Link>
          </> : <p>No feasible alternatives were returned for the affected future stops. The backend will not relax opening hours, availability, budget, or travel constraints to invent a replacement.</p>}
        </div>}

        <section className="rounded-2xl border border-line bg-surface p-4" aria-label="Scenario impact details">
          <h4 className="text-sm font-semibold text-ink">Impact details</h4>
          {result.impacts.length ? <ul className="mt-2 space-y-2">{result.impacts.map((impact, index) => <li key={`${impact.category}:${impact.item_id ?? index}`} className="rounded-xl bg-surface-sunken px-3 py-2 text-sm">
            <p className="font-medium text-ink">{impact.category.replaceAll("_", " ")} · {impact.level} · {impact.confidence.toLowerCase()} confidence{impact.affected ? " · affected" : " · no material effect"}</p>
            <p className="mt-1 text-xs text-ink-muted">{impact.explanation}{impact.item_id ? ` · Stop ${stops.find((entry) => entry.id === impact.item_id)?.title ?? impact.item_id}` : ""}</p>
            {impact.reason_codes.length ? <p className="mt-1 text-xs text-ink-subtle">Reasons: {impact.reason_codes.join(", ")}</p> : null}
            {impact.evidence.length ? <ul className="mt-1 list-disc pl-5 text-xs text-ink-subtle">{impact.evidence.map((evidence, evidenceIndex) => <li key={`${evidenceIndex}:${evidence}`}>{evidence}</li>)}</ul> : null}
            {impact.recommended_action ? <p className="mt-1 text-xs text-ink-muted">Suggested action: {impact.recommended_action}</p> : null}
          </li>)}</ul> : <p className="mt-2 text-sm text-ink-muted">The backend returned no per-category impact records.</p>}
        </section>

        {result.warnings.length ? <ul className="space-y-1 rounded-xl bg-surface-sunken px-3.5 py-3 text-xs text-ink-muted" aria-label="Preview notes">{result.warnings.map((warning, index) => <li key={`${index}:${warning}`} className="flex gap-2"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />{warning}</li>)}</ul> : null}
        {confirmApply ? <div className="rounded-2xl border border-warning/30 bg-warning-soft p-4" role="group" aria-label="Confirm scenario apply">
          <p className="text-sm font-semibold text-ink">Apply this scenario through itinerary replanning?</p><p className="mt-1 text-xs text-ink-muted">The backend will revalidate flexible stops. Locked stops stay protected, and the scenario itself does not override feasibility.</p>
          <div className="mt-3 flex flex-wrap gap-2"><Button type="button" size="sm" onClick={confirmApplySimulation} loading={busy}>Confirm apply</Button><Button type="button" size="sm" variant="outline" onClick={() => setConfirmApply(false)} disabled={busy}>Keep preview</Button></div>
        </div> : result.impacts.length ? <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="secondary" onClick={() => setConfirmApply(true)} disabled={!actionableImpact || busy}>Apply through replanning</Button>
          {!actionableImpact ? <p className="text-xs text-ink-subtle">{requestedUnavailableStop ? "There are no future flexible stops to replace. Past and in-progress stops cannot be replanned." : "Route and social assumptions are advisory; they cannot directly change itinerary stops."}</p> : <p className="text-xs text-ink-subtle">Review the changes before applying. The preview is temporary.</p>}
        </div> : null}
        {busy ? <span className="sr-only" role="status"><LoaderCircle className="size-4 animate-spin" aria-hidden="true" />Processing simulation</span> : null}
        {scenarioAffectedIds.length ? <p className="sr-only">Scenario-affected map stops are highlighted: {scenarioAffectedIds.map((id) => stops.find((stop) => stop.id === id)?.title ?? id).join(", ")}.</p> : null}
      </div> : null}
    </section>
  );
}
