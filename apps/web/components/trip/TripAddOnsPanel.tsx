"use client";

import { useEffect, useState } from "react";
import { Clock3, MapPin, Minus, Plus } from "lucide-react";
import { addItineraryItem } from "@/lib/api/itineraries";
import { listExperiences } from "@/lib/api/experiences";
import { isCompositionFailure } from "@/types/api";
import type { ApiExperienceSummary, ApiItinerary } from "@/types/api";

type FocusPoint = { latitude: number; longitude: number } | null;

function scheduleTail(itinerary: ApiItinerary): string | undefined {
  const ends = [
    ...itinerary.items.map((item) => item.planned_end),
    ...(itinerary.custom_activities ?? []).map((activity) => activity.planned_end),
  ].filter((value) => Number.isFinite(Date.parse(value)));
  return ends.sort((first, second) => Date.parse(first) - Date.parse(second)).at(-1);
}

export function TripAddOnsPanel({
  mode,
  heading = "Local add-ons",
  intro,
  radiusKm = 10,
  city = null,
  locality = null,
  origin = null,
  selectedExperienceIds = [],
  onToggleExperience,
  itinerary,
  onItineraryUpdated,
}: {
  mode: "draft" | "saved";
  heading?: string;
  intro?: string;
  radiusKm?: number;
  city?: string | null;
  locality?: string | null;
  origin?: FocusPoint;
  selectedExperienceIds?: string[];
  onToggleExperience?: (experience: ApiExperienceSummary) => void;
  itinerary?: ApiItinerary;
  onItineraryUpdated?: (itinerary: ApiItinerary) => void;
}) {
  const firstSavedStop = itinerary?.items
    .slice()
    .sort((first, second) => first.sequence_order - second.sequence_order)
    .find((item) => item.location_latitude != null && item.location_longitude != null);
  const focus = origin ?? (firstSavedStop?.location_latitude != null && firstSavedStop.location_longitude != null
    ? { latitude: firstSavedStop.location_latitude, longitude: firstSavedStop.location_longitude }
    : null);
  const existingIds = mode === "saved" ? itinerary?.items.map((item) => item.experience_id) ?? [] : [];
  const existingIdKey = existingIds.join("\u0000");
  const focusLatitude = focus?.latitude ?? null;
  const focusLongitude = focus?.longitude ?? null;
  const hasSearchArea = focusLatitude != null && focusLongitude != null || Boolean(city);
  const [result, setResult] = useState<{
    key: string;
    status: "ready" | "error";
    items: ApiExperienceSummary[];
  } | null>(null);
  const [selectedAddOnIds, setSelectedAddOnIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const areaName = locality ?? city;
  const searchKey = JSON.stringify({ focusLatitude, focusLongitude, city, locality, itineraryId: itinerary?.id, existingIdKey, radiusKm });
  const status = !hasSearchArea ? "idle" : result?.key === searchKey ? result.status : "loading";
  const experiences = result?.key === searchKey ? result.items : [];

  useEffect(() => {
    if (!hasSearchArea) return;
    const controller = new AbortController();
    const filters = focusLatitude != null && focusLongitude != null
      ? { lat: focusLatitude, lng: focusLongitude, radius_km: radiusKm, sort: "distance" as const }
      : { city: city ?? undefined, locality: locality ?? undefined, sort: "relevance" as const };
    listExperiences({ ...filters, is_synthetic: false, limit: 24, offset: 0 }, controller.signal)
      .then((response) => {
        if (!controller.signal.aborted) {
          const alreadyInPlan = new Set(existingIdKey ? existingIdKey.split("\u0000") : []);
          setResult({
            key: searchKey,
            status: "ready",
            items: response.items.filter((experience) => !alreadyInPlan.has(experience.id)),
          });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setResult({ key: searchKey, status: "error", items: [] });
      });
    return () => controller.abort();
  }, [hasSearchArea, focusLatitude, focusLongitude, city, locality, itinerary?.id, existingIdKey, radiusKm, searchKey]);

  function toggle(experience: ApiExperienceSummary) {
    setMessage(null);
    if (mode === "draft") {
      onToggleExperience?.(experience);
      return;
    }
    setSelectedAddOnIds((current) => current.includes(experience.id)
      ? current.filter((id) => id !== experience.id)
      : [...current, experience.id]);
  }

  async function addSelectedToSavedPlan() {
    if (!itinerary || !selectedAddOnIds.length || saving) return;
    setSaving(true);
    setMessage(null);
    let currentItinerary = itinerary;
    let addedCount = 0;
    try {
      for (const experienceId of selectedAddOnIds) {
        const result = await addItineraryItem(currentItinerary.id, {
          experience_id: experienceId,
          planned_start: scheduleTail(currentItinerary),
        });
        if (isCompositionFailure(result)) {
          setMessage(addedCount
            ? `Added ${addedCount} stop${addedCount === 1 ? "" : "s"}. The next stop did not fit: ${result.message}`
            : result.message);
          break;
        }
        currentItinerary = result;
        addedCount += 1;
        onItineraryUpdated?.(result);
        setSelectedAddOnIds((current) => current.filter((id) => id !== experienceId));
      }
      if (addedCount && !selectedAddOnIds.some((id) => !currentItinerary.items.some((item) => item.experience_id === id))) {
        setMessage(`Added ${addedCount} stop${addedCount === 1 ? "" : "s"} to your itinerary.`);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not add these stops. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  const stagedIds = mode === "draft" ? selectedExperienceIds : selectedAddOnIds;
  const canEditSavedPlan = itinerary && !["CANCELLED", "COMPLETED"].includes(itinerary.status);

  return (
    <section className="space-y-3 rounded-2xl border border-line bg-surface-raised p-4" aria-label={heading}>
      <div>
        <h3 className="font-semibold text-ink">{heading}</h3>
        <p className="mt-1 text-xs leading-5 text-ink-muted">
          {intro ?? (focus
            ? `Nearby catalog highlights within about ${radiusKm} km of ${origin ? "this stop" : "your first stop"}.`
            : areaName ? `Compact catalog highlights for ${areaName}.` : "Compact area highlights with a short local USP.")}
        </p>
      </div>

      {!hasSearchArea ? <p className="rounded-xl bg-surface px-3 py-4 text-xs text-ink-muted">Choose an area or add a stop to your plan to see nearby highlights.</p> : null}
      {hasSearchArea && status === "loading" ? <p className="rounded-xl bg-surface px-3 py-4 text-xs text-ink-muted" role="status">Finding nearby catalog stops…</p> : null}
      {hasSearchArea && status === "error" ? <p className="rounded-xl bg-warning-soft px-3 py-3 text-xs text-warning">Nearby add-ons are unavailable right now. You can still use the main catalog search.</p> : null}
      {hasSearchArea && status === "ready" && !experiences.length ? <p className="rounded-xl bg-surface px-3 py-4 text-xs text-ink-muted">No additional catalog stops were found nearby.</p> : null}

      {hasSearchArea && experiences.length ? (
        <ul className="space-y-2">
          {experiences.slice(0, 6).map((experience) => {
            const selected = stagedIds.includes(experience.id);
            const price = experience.price ?? experience.maximum_price ?? experience.minimum_price;
            const alreadyInPlan = existingIds.includes(experience.id);
            return (
              <li key={experience.id} className="flex items-start gap-2 rounded-xl border border-line bg-surface p-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink" title={experience.title}>{experience.title}</p>
                  <p className="mt-0.5 text-[11px] text-ink-subtle">{experience.category.name} · {experience.location.locality ?? experience.location.city}</p>
                  <p className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">Local highlight</p>
                  <p className="line-clamp-2 text-xs leading-4 text-ink-muted">
                    {experience.short_description || `${experience.category.name} in ${experience.location.locality ?? experience.location.city}.`}
                  </p>
                  <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-ink-subtle">
                    {experience.distance_km != null ? <span className="inline-flex items-center gap-1"><MapPin className="size-3" aria-hidden="true" />{experience.distance_km.toFixed(1)} km away</span> : null}
                    {experience.duration_minutes != null ? <span className="inline-flex items-center gap-1"><Clock3 className="size-3" aria-hidden="true" />{experience.duration_is_estimated ? "~" : ""}{experience.duration_minutes} min</span> : null}
                    <span>{price == null ? "Price unavailable" : `${experience.is_price_estimated ? "Est. " : ""}₹${Math.round(price)}`}</span>
                  </p>
                </div>
                <button
                  type="button"
                  aria-pressed={selected}
                  aria-label={alreadyInPlan ? `${experience.title} is already in the itinerary` : `${selected ? "Remove" : "Add"} ${experience.title} ${mode === "draft" ? "to draft" : "as an add-on"}`}
                  disabled={alreadyInPlan || (mode === "saved" && !canEditSavedPlan)}
                  onClick={() => toggle(experience)}
                  className={`inline-flex size-8 shrink-0 items-center justify-center rounded-full transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40 ${selected ? "bg-pastel-rose text-ink" : "bg-ink text-white hover:scale-105"}`}
                >
                  {selected ? <Minus className="size-4" aria-hidden="true" /> : <Plus className="size-4" aria-hidden="true" />}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {mode === "saved" && canEditSavedPlan && selectedAddOnIds.length ? (
        <button
          type="button"
          disabled={saving}
          onClick={() => void addSelectedToSavedPlan()}
          className="inline-flex min-h-10 w-full items-center justify-center rounded-full bg-ink px-4 py-2 text-sm font-medium text-white transition hover:bg-ink/90 disabled:opacity-50"
        >
          {saving ? "Checking and adding…" : `Add ${selectedAddOnIds.length} selected to itinerary`}
        </button>
      ) : null}
      {message ? <p className="rounded-xl bg-surface px-3 py-2 text-xs text-ink-muted" role="status">{message}</p> : null}
    </section>
  );
}
