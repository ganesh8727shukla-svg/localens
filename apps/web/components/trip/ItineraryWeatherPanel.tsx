"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CloudSun, GitCompare, MapPinPlus, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { TripAddOnsPanel } from "@/components/trip/TripAddOnsPanel";
import { getItineraryWeather } from "@/lib/api/context";
import type { ApiItinerary, ItineraryWeatherResponse } from "@/types/api";

function statusTone(status: string): "success" | "warning" | "danger" | "accent" | "neutral" {
  if (status === "GOOD") return "success";
  if (status === "CAUTION") return "warning";
  if (status === "UNSUITABLE") return "danger";
  if (status === "CURRENT") return "accent";
  return "neutral";
}

function statusLabel(entry: ItineraryWeatherResponse["advisories"][number]) {
  if (entry.status === "GOOD") return "Looks suitable";
  if (entry.status === "CAUTION") return "Weather caution";
  if (entry.status === "UNSUITABLE") return "Weather risk";
  if (entry.status === "CURRENT") return "Current conditions";
  if (entry.source === "MOCK") return "Mock weather";
  if (entry.source === "LIVE" || entry.source === "CACHED") {
    return entry.condition || entry.temperature_c != null ? "Forecast available · impact unknown" : "Weather impact unknown";
  }
  return "Weather unavailable";
}

function localTime(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function indiaDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}

export function ItineraryWeatherPanel({
  itinerary,
  onItineraryUpdated,
}: {
  itinerary: ApiItinerary;
  onItineraryUpdated?: (itinerary: ApiItinerary) => void;
}) {
  const [result, setResult] = useState<ItineraryWeatherResponse | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [nearbyForItemId, setNearbyForItemId] = useState<string | null>(null);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const available = ["VALIDATED", "BOOKING_REQUESTED"].includes(itinerary.status);

  const refresh = useCallback(async (signal?: AbortSignal, showSpinner = false) => {
    if (showSpinner) setRefreshing(true);
    try {
      const response = await getItineraryWeather(itinerary.id, signal);
      if (!signal?.aborted) {
        setResult(response);
        setError(false);
        setLoading(false);
      }
    } catch {
      if (!signal?.aborted) {
        setError(true);
        setLoading(false);
      }
    } finally {
      if (showSpinner && !signal?.aborted) setRefreshing(false);
    }
  }, [itinerary.id]);

  useEffect(() => {
    if (!available) return;
    const controller = new AbortController();
    const initialRefresh = window.setTimeout(() => void refresh(controller.signal), 0);
    const cadence = itinerary.itinerary_date === indiaDate() ? 60_000 : 15 * 60_000;
    const timer = window.setInterval(() => void refresh(controller.signal), cadence);
    return () => {
      controller.abort();
      window.clearTimeout(initialRefresh);
      window.clearInterval(timer);
    };
  }, [available, itinerary.itinerary_date, refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  if (!available) return null;
  const alerts = result?.advisories.filter((entry) => entry.status === "CAUTION" || entry.status === "UNSUITABLE") ?? [];
  const imminent = result?.advisories.filter((entry) => {
    const startsAt = new Date(entry.planned_start).getTime();
    const minutesUntil = (startsAt - clockNow) / 60_000;
    return Number.isFinite(startsAt) && minutesUntil >= 0 && minutesUntil <= 15;
  }) ?? [];

  return (
    <section className="rounded-2xl border border-line bg-surface-raised p-4 sm:p-5" aria-labelledby="itinerary-weather-heading" aria-busy={loading || refreshing}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-sm font-semibold text-ink" id="itinerary-weather-heading">
            <CloudSun className="size-4 text-accent" aria-hidden="true" />
            Weather for your stops
          </p>
          <p className="mt-1 text-xs leading-5 text-ink-muted">
            Scheduled-time forecasts are checked when available. Near a stop, this refreshes to current conditions. Trip data is not changed by this check.
          </p>
        </div>
        <Button type="button" size="sm" variant="ghost" onClick={() => void refresh(undefined, true)} disabled={refreshing}>
          <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} aria-hidden="true" />
          Refresh
        </Button>
      </div>

      {error && !result ? (
        <p className="mt-3 rounded-xl bg-warning-soft px-3 py-2 text-sm text-warning" role="status">
          Weather advice is temporarily unavailable. Your itinerary is unchanged.
        </p>
      ) : null}
      {result && alerts.length ? (
        <p className="mt-3 flex items-start gap-2 rounded-xl bg-warning-soft px-3 py-2.5 text-sm text-warning" role="status">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{alerts.length} stop{alerts.length === 1 ? "" : "s"} may need a plan change. Review the advice below or use What‑If to compare alternatives.</span>
        </p>
      ) : null}
      {imminent.length ? (
        <div className="mt-3 space-y-2" aria-live="polite" aria-label="Upcoming weather notifications">
          {imminent.map((entry) => (
            <p
              key={`soon-${entry.item_id}`}
              className={`flex items-start gap-2 rounded-xl px-3 py-2.5 text-sm ${
                entry.status === "UNSUITABLE" ? "bg-danger-soft text-danger"
                  : entry.status === "CAUTION" ? "bg-warning-soft text-warning"
                    : "bg-success-soft text-ink"
              }`}
              role={entry.status === "UNSUITABLE" ? "alert" : "status"}
            >
              <CloudSun className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>
                {entry.status === "GOOD" ? `Ready to explore ${entry.title}? Weather looks suitable.`
                  : entry.status === "CAUTION" ? `Your ${entry.title} stop starts soon. Weather may affect it; check a nearby alternative.`
                    : entry.status === "UNSUITABLE" ? `Weather may make ${entry.title} unsuitable. Choose a nearby alternative or review your plan before you go.`
                      : `Your ${entry.title} stop starts soon, but weather could not be confirmed. Check local conditions before you go.`}
              </span>
            </p>
          ))}
        </div>
      ) : null}
      {result?.advisories.length ? (
        <ol className="mt-3 grid gap-2 sm:grid-cols-2">
          {result.advisories.map((entry) => (
            <li key={entry.item_id} className="rounded-xl border border-line bg-surface p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="min-w-0 text-sm font-medium text-ink">{entry.title}</p>
                <Badge tone={statusTone(entry.status)}>{statusLabel(entry)}</Badge>
              </div>
              <p className="mt-1 text-xs text-ink-muted">
                {localTime(entry.planned_start)} planned
                {entry.condition ? ` · ${entry.condition}` : ""}
                {entry.temperature_c == null ? "" : ` · ${Math.round(entry.temperature_c)}°C`}
                {entry.precipitation_probability == null ? "" : ` · ${Math.round(entry.precipitation_probability)}% rain`}
              </p>
              <p className="mt-1 text-xs leading-5 text-ink-muted">{entry.message}</p>
              <p className="mt-1 text-[11px] text-ink-subtle">
                {entry.check_basis === "NEAR_TIME_CURRENT" ? "Near-time current check"
                  : entry.check_basis === "CURRENT_AT_LOCATION" ? "Current conditions near this stop"
                    : entry.check_basis === "UNAVAILABLE" ? "Historical/current data unavailable"
                      : "Scheduled forecast"}
                {localTime(entry.forecast_at) ? ` · data for ${localTime(entry.forecast_at)}` : ""}
                {` · ${entry.source.toLowerCase()}`}
              </p>
              {entry.status === "CAUTION" || entry.status === "UNSUITABLE" ? (
                <div className="mt-3 space-y-3">
                  <div className="flex flex-wrap gap-2">
                    {entry.latitude != null && entry.longitude != null ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        aria-expanded={nearbyForItemId === entry.item_id}
                        onClick={() => setNearbyForItemId((current) => current === entry.item_id ? null : entry.item_id)}
                      >
                        <MapPinPlus className="size-3.5" aria-hidden="true" />
                        {nearbyForItemId === entry.item_id ? "Hide nearby places" : "Find nearby places"}
                      </Button>
                    ) : null}
                    <a
                      href="#trip-what-if"
                      className="inline-flex min-h-9 items-center gap-2 rounded-full border border-line px-3 text-xs font-medium text-ink transition hover:bg-surface-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    >
                      <GitCompare className="size-3.5" aria-hidden="true" />
                      Review plan changes
                    </a>
                  </div>
                  {nearbyForItemId === entry.item_id && entry.latitude != null && entry.longitude != null ? (
                    <TripAddOnsPanel
                      mode="saved"
                      itinerary={itinerary}
                      origin={{ latitude: entry.latitude, longitude: entry.longitude }}
                      radiusKm={3}
                      heading="Nearby places"
                      intro={`Places within 3 km of ${entry.title}. Select one and the backend checks the route and remaining schedule before adding it; your other stops stay in place.`}
                      onItineraryUpdated={(updated) => {
                        setNearbyForItemId(null);
                        onItineraryUpdated?.(updated);
                      }}
                    />
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      ) : result ? (
        <p className="mt-3 text-sm text-ink-muted">No weather checks are needed for this itinerary.</p>
      ) : loading ? (
        <p className="mt-3 text-sm text-ink-muted" role="status">Checking the available forecast for each stop…</p>
      ) : null}
      {error && result ? <p className="mt-2 text-xs text-ink-subtle" role="status">The latest refresh failed; showing the last successful check.</p> : null}
    </section>
  );
}
