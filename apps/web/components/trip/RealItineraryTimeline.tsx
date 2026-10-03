"use client";

import { Clock, Lock, MapPin, Radio, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { BookingRequestButton } from "@/components/trip/BookingRequestButton";
import { ItineraryWeatherPanel } from "@/components/trip/ItineraryWeatherPanel";
import { useItineraryUpdates } from "@/hooks/useItineraryUpdates";
import {
  formatCost,
  formatCustomTimeRange,
  formatItemTimeRange,
  itinerarySummaryLine,
  itineraryStatusLabel,
  orderedTimelineEntries,
  travelGapLabel,
} from "@/lib/itinerary/itineraryDisplay";
import type { ApiItinerary } from "@/types/api";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function hoursLabel(hours: { open_time: string | null; close_time: string | null; is_closed: boolean }[]) {
  if (!hours.length) return null;
  return hours.map((window) => window.is_closed
    ? "Closed all day"
    : window.open_time && window.close_time
      ? `${window.open_time}–${window.close_time}`
      : "Hours unavailable").join(" · ");
}

export function RealItineraryTimeline({
  itinerary,
  displayStatus,
  selectedItemId = null,
  onSelectItem,
  onItineraryUpdated,
}: {
  itinerary: ApiItinerary;
  displayStatus?: { label: string; tone: "success" | "accent" };
  selectedItemId?: string | null;
  onSelectItem?: (id: string) => void;
  onItineraryUpdated?: (itinerary: ApiItinerary) => void;
}) {
  const entries = orderedTimelineEntries(itinerary);
  const updates = useItineraryUpdates(itinerary.id);

  return (
    <section className="space-y-5">
      <div className="porcelain-card overflow-hidden rounded-3xl border border-line bg-surface shadow-soft">
        <div className="flex flex-col gap-4 border-b border-line bg-surface-raised p-5 sm:flex-row sm:items-start sm:justify-between sm:p-6">
          <div className="min-w-0">
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-accent">
              Your schedule
            </p>
            <h2 className="text-xl font-semibold tracking-tight text-ink">{itinerary.title}</h2>
            <p className="mt-1 text-sm text-ink-muted">{itinerarySummaryLine(itinerary)}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {updates.status === "connected" || updates.status === "replanning" ? (
              <Badge tone="accent">
                <Radio className="mr-1 inline size-3" aria-hidden="true" />
                Live plan
              </Badge>
            ) : null}
            <Badge tone={displayStatus?.tone ?? (itinerary.status === "CANCELLED" ? "danger" : "accent")}>
              {displayStatus?.label ?? itineraryStatusLabel(itinerary.status)}
            </Badge>
          </div>
        </div>

        <div className="space-y-4 p-4 sm:p-6">
          <ItineraryWeatherPanel itinerary={itinerary} onItineraryUpdated={onItineraryUpdated} />

          {updates.replanInProgress ? (
            <p
              className="rounded-2xl border border-accent/20 bg-accent-soft px-4 py-3 text-sm text-ink"
              role="status"
            >
              Updating your itinerary based on changing conditions…
            </p>
          ) : null}

          {updates.requiresAction ? (
            <p
              className="rounded-2xl border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-warning"
              role="alert"
            >
              One of your locked items was affected by a change and needs your review — it was not changed
              automatically.
            </p>
          ) : null}

          {!updates.replanInProgress && updates.lastChangeSummary ? (
            <div className="rounded-2xl border border-line bg-surface-sunken px-4 py-3 text-sm text-ink-muted">
              <p className="font-medium text-ink">
                Your itinerary was updated because conditions changed.
              </p>
              {(updates.lastChangeSummary.removed_items?.length ?? 0) > 0 ||
              (updates.lastChangeSummary.added_items?.length ?? 0) > 0 ? (
                <p className="mt-1 text-xs">
                  {updates.lastChangeSummary.removed_items?.length
                    ? `${updates.lastChangeSummary.removed_items.length} item(s) removed. `
                    : ""}
                  {updates.lastChangeSummary.added_items?.length
                    ? `${updates.lastChangeSummary.added_items.length} item(s) added.`
                    : ""}
                </p>
              ) : null}
            </div>
          ) : null}

          {updates.lastUpdatedAt ? (
            <p className="text-xs text-ink-subtle">
              Last updated {updates.lastUpdatedAt.toLocaleTimeString()}
            </p>
          ) : itinerary.context_last_updated_at ? (
            <p className="text-xs text-ink-subtle">
              Context last checked{" "}
              {new Date(itinerary.context_last_updated_at).toLocaleTimeString()}
            </p>
          ) : null}

          {itinerary.narrative_summary ? (
            <p className="rounded-2xl bg-highlight-soft px-4 py-3 text-sm text-ink-muted">
              {itinerary.narrative_summary}
            </p>
          ) : null}

          <ol
            className="motion-stagger space-y-4"
            aria-label={`Itinerary for ${itinerary.title}`}
          >
            {entries.map((entry, entryIndex) => {
              if (entry.kind === "custom") {
                const activity = entry.activity;
                const kindLabel = activity.kind === "note"
                  ? "Personal note"
                  : activity.kind === "place"
                    ? "Personal place"
                    : "Personal activity";

                return (
                  <li key={activity.id}>
                    <article
                      data-selected={selectedItemId === activity.id || undefined}
                    className={`porcelain-card grid grid-cols-[4.5rem_minmax(0,1fr)] gap-3 rounded-2xl border bg-surface p-3 transition sm:grid-cols-[5rem_minmax(0,1fr)] sm:gap-4 sm:p-4 ${
                        selectedItemId === activity.id ? "border-accent ring-2 ring-accent/20" : "border-accent/20"
                      }`}
                    >
                      <div className="flex min-h-16 flex-col items-center justify-center rounded-xl bg-highlight-soft px-2 py-3 text-center text-sm font-semibold leading-tight text-highlight">
                        <Clock className="mb-1 size-4" aria-hidden="true" />
                        {formatCustomTimeRange(activity)}
                      </div>

                      <div className="min-w-0 space-y-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-semibold text-ink">{activity.title}</p>
                          <Badge tone="accent">{kindLabel}</Badge>
                          {onSelectItem ? <button
                            type="button"
                            aria-pressed={selectedItemId === activity.id}
                            aria-label={`Select ${activity.title} on the trip map`}
                            onClick={() => onSelectItem(activity.id)}
                            className="inline-flex min-h-8 items-center gap-1 rounded-full px-2 text-xs font-medium text-accent transition hover:bg-accent-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                          >
                            <MapPin className="size-3.5" aria-hidden="true" />Select stop
                          </button> : null}
                        </div>
                        {activity.location_text ? (
                          <p className="flex items-start gap-1.5 text-xs text-ink-muted">
                            <MapPin className="mt-0.5 size-3.5 shrink-0 text-accent" aria-hidden="true" />
                            {activity.location_text}
                          </p>
                        ) : null}
                        {activity.note ? (
                          <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-muted">{activity.note}</p>
                        ) : null}
                        <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-ink-muted">
                          {activity.duration_minutes > 0 ? (
                            <span className="inline-flex items-center gap-1.5">
                              <Clock className="size-3.5 shrink-0 text-accent" aria-hidden="true" />
                              {activity.duration_minutes} min
                            </span>
                          ) : null}
                          {activity.estimated_cost != null ? (
                            <span className="inline-flex items-center gap-1.5">
                              <Wallet className="size-3.5 shrink-0 text-accent" aria-hidden="true" />
                              {formatCost(activity.estimated_cost, itinerary.currency)}
                            </span>
                          ) : null}
                        </div>
                        {activity.kind === "place" ? (
                          <p className="text-xs text-ink-subtle">Travel time to this personal place is not verified.</p>
                        ) : null}
                      </div>
                    </article>
                  </li>
                );
              }

              const item = entry.item;
              const previousEntry = entries[entryIndex - 1];
              const gap = previousEntry?.kind === "experience" ? travelGapLabel(item) : null;
              const openingHours = item.opening_hours_for_visit ?? [];
              const nearbyOpenAlternatives = item.nearby_open_alternatives ?? [];

              return (
                <li key={item.id}>
                  {gap ? (
                    <p
                      className="mb-2 ml-[5.5rem] flex items-center gap-2 text-xs text-ink-subtle"
                      data-testid="travel-gap"
                    >
                      <span className="h-px w-5 bg-line-strong" aria-hidden="true" />
                      {gap}
                    </p>
                  ) : null}

                  <article
                    data-selected={selectedItemId === item.id || undefined}
                    className={`porcelain-card grid grid-cols-[4.5rem_minmax(0,1fr)] gap-3 rounded-2xl border bg-surface p-3 sm:grid-cols-[5rem_minmax(0,1fr)] sm:gap-4 sm:p-4 ${
                      item.item_state === "AFFECTED"
                        ? "border-warning/40"
                        : selectedItemId === item.id
                          ? "border-accent ring-2 ring-accent/20"
                          : "border-line"
                    }`}
                  >
                    <div className="flex min-h-16 flex-col items-center justify-center rounded-xl bg-highlight-soft px-2 py-3 text-center text-sm font-semibold leading-tight text-highlight">
                      <Clock className="mb-1 size-4" aria-hidden="true" />
                      {formatItemTimeRange(item)}
                    </div>

                    <div className="min-w-0 space-y-3">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <p className="flex flex-wrap items-center gap-1.5 font-semibold text-ink">
                            {item.title ?? "Experience"}
                            {item.is_locked ? (
                              <Lock
                                className="size-3.5 shrink-0 text-ink-subtle"
                                aria-label="Locked — will not be auto-replaced"
                              />
                            ) : null}
                            {onSelectItem ? <button
                              type="button"
                              aria-pressed={selectedItemId === item.id}
                              aria-label={`Select ${item.title ?? "experience"} on the trip map`}
                              onClick={() => onSelectItem(item.id)}
                              className="inline-flex min-h-8 items-center gap-1 rounded-full px-2 text-xs font-medium text-accent transition hover:bg-accent-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                            >
                              <MapPin className="size-3.5" aria-hidden="true" />Select stop
                            </button> : null}
                          </p>

                          <p className="mt-1 text-xs text-ink-subtle">{item.category_name}</p>

                          {item.item_state === "AFFECTED" ? (
                            <p className="mt-1 text-xs font-medium text-warning">
                              Needs your review
                            </p>
                          ) : null}
                        </div>

                        <div className="shrink-0">
                          <BookingRequestButton
                            itineraryId={itinerary.id}
                            itineraryItemId={item.id}
                          />
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-ink-muted">
                        <span className="inline-flex items-center gap-1.5">
                          <MapPin className="size-3.5 shrink-0 text-accent" aria-hidden="true" />
                          {item.location_place_name ?? "Location unavailable"}
                        </span>
                        <span className="inline-flex items-center gap-1.5">
                          <Clock className="size-3.5 shrink-0 text-accent" aria-hidden="true" />
                          {item.duration_minutes} min
                        </span>
                        <span className="inline-flex items-center gap-1.5">
                          <Wallet className="size-3.5 shrink-0 text-accent" aria-hidden="true" />
                          {formatCost(item.estimated_cost, itinerary.currency)}
                        </span>
                      </div>

                      <div
                        className={`space-y-2 rounded-xl px-3 py-2.5 text-xs ${
                          item.opening_hours_status_at_visit === "open"
                            ? "bg-pastel-mint/50 text-ink"
                            : "bg-warning-soft text-warning"
                        }`}
                        role="status"
                      >
                        <p className="font-medium">
                          {item.opening_hours_status_at_visit === "open"
                            ? "Open during this stop"
                            : item.opening_hours_status_at_visit === "closed"
                              ? "Closed during this stop"
                              : "Opening hours are not recorded for this stop"}
                          {openingHours.some((window) => window.is_synthetic)
                            ? " · Demo hours, not venue-confirmed"
                            : ""}
                          {item.availability_data_is_synthetic
                            ? " · Demo availability, not venue-confirmed"
                            : ""}
                        </p>
                        {openingHours.length ? (
                          <p>
                            {WEEKDAYS[openingHours[0].day_of_week]} hours: {hoursLabel(openingHours)}
                          </p>
                        ) : null}
                        {item.opening_hours_status_at_visit === "closed" ? (
                          <div className="space-y-1.5">
                            <p className="font-semibold">Nearby places open at this time</p>
                            {nearbyOpenAlternatives.length ? (
                              <ul className="space-y-1">
                                {nearbyOpenAlternatives.map((place) => (
                                  <li key={place.experience_id}>
                                    <span className="font-medium">{place.title}</span>
                                    <span> · {[place.locality, place.city].filter(Boolean).join(", ")} · {place.distance_km.toFixed(1)} km away</span>
                                    {place.opening_hours_for_visit.length ? (
                                      <span> · {hoursLabel(place.opening_hours_for_visit)}</span>
                                    ) : null}
                                    {place.opening_hours_for_visit.some((window) => window.is_synthetic) ? (
                                      <span> · demo hours</span>
                                    ) : null}
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <p>No nearby catalog places with recorded hours were found.</p>
                            )}
                          </div>
                        ) : null}
                      </div>

                      {item.narrative_text ? (
                        <p className="text-xs leading-relaxed text-ink-muted">
                          {item.narrative_text}
                        </p>
                      ) : null}
                    </div>
                  </article>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </section>
  );
}
