"use client";

import { useState } from "react";
import {
  Bookmark,
  CalendarDays,
  CheckCircle2,
  Clock,
  Crosshair,
  MapPin,
  Route as RouteIcon,
  ShieldCheck,
  Star,
  User,
} from "lucide-react";
import type { Experience } from "@/types/experience";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody } from "@/components/ui/Card";
import { MapSurface } from "@/components/common/MapSurface";
import { DemoDataBadge } from "@/components/ui/DemoDataBadge";
import { FeedbackControls } from "@/components/experience/FeedbackControls";
import { ImageAttribution } from "@/components/experience/ImageAttribution";
import { ExperienceImageView } from "@/components/experience/ExperienceImageView";
import { PersonalizationBadge } from "@/components/ui/PersonalizationBadge";
import { useUserLocation } from "@/hooks/useUserLocation";
import { getRoute } from "@/lib/api/location";
import { haversineKm } from "@/lib/geo/haversine";
import { experiencesToFeatureCollection } from "@/lib/geo/geojson";
import { ApiError } from "@/lib/api/client";
import type { RouteResponse } from "@/types/location";

function formatReviewDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return dateStr;
  }
}

function formatSlotDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  } catch {
    return dateStr;
  }
}

function formatSlotTime(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  } catch {
    return dateStr;
  }
}

export function ExperienceDetail({ experience }: { experience: Experience }) {
  const { status: geoStatus, coordinate: origin, request: requestLocation } = useUserLocation();
  const [route, setRoute] = useState<RouteResponse | null>(null);
  const [routeStatus, setRouteStatus] = useState<"idle" | "loading" | "error">("idle");

  const distanceKm = origin
    ? Math.round(
        (haversineKm(
          origin.lat,
          origin.lng,
          experience.location.lat,
          experience.location.lng,
        ) +
          Number.EPSILON) *
          10,
      ) / 10
    : null;

  async function handleShowRoute() {
    if (!origin) return;
    setRouteStatus("loading");

    try {
      const result = await getRoute(
        origin,
        { lat: experience.location.lat, lng: experience.location.lng },
        { includeGeometry: true },
      );
      setRoute(result);
      setRouteStatus("idle");
    } catch (error) {
      setRouteStatus("error");
      if (!(error instanceof ApiError)) throw error;
    }
  }

  const mapFeatures = experiencesToFeatureCollection([experience], experience.id);

  return (
    <div className="space-y-6">
      <div className="porcelain-card relative aspect-[16/9] w-full overflow-hidden rounded-3xl bg-surface-sunken shadow-soft sm:aspect-[21/9]">
        <ExperienceImageView
          src={experience.imageUrl}
          alt=""
          fill
          priority
          sizes="(min-width: 1024px) 1024px, 100vw"
          className="object-cover"
        />
        <div
          className="absolute inset-0 bg-gradient-to-t from-black/25 via-transparent to-transparent"
          aria-hidden="true"
        />
        {experience.isSynthetic ? (
          <div className="absolute left-4 top-4">
            <DemoDataBadge label="Demo experience" />
          </div>
        ) : null}
        {!experience.image.isFallback ? (
          <div className="absolute bottom-3 right-3 rounded bg-surface/80 px-2 py-1 backdrop-blur">
            <ImageAttribution image={experience.image} />
          </div>
        ) : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-8">
        <div className="space-y-5">
          <section className="porcelain-card rounded-3xl border border-line bg-surface p-5 shadow-soft sm:p-6">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="accent">{experience.categoryLabel}</Badge>
              <Badge tone={experience.provider.verified ? "success" : "neutral"}>
                {experience.provider.verified ? (
                  <>
                    <ShieldCheck className="size-3" aria-hidden="true" />
                    Verified provider
                  </>
                ) : (
                  "Unverified provider"
                )}
              </Badge>
            </div>

            <h1 className="mt-4 text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
              {experience.title}
            </h1>

            <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-ink-muted">by {experience.provider.name}</p>
              <FeedbackControls experienceId={experience.id} />
            </div>

            {experience.matchSignals && experience.matchSignals.length > 0 ? (
              <div className="mt-4">
                <PersonalizationBadge signals={experience.matchSignals} />
              </div>
            ) : null}
          </section>

          <div className="flex flex-wrap gap-2">
            <span className="inline-flex items-center gap-2 rounded-full bg-accent-soft px-3.5 py-2 text-sm text-ink-muted">
              <MapPin className="size-4 shrink-0 text-accent" aria-hidden="true" />
              {experience.location.area}, {experience.location.city}
              {distanceKm != null ? ` · ${distanceKm} km away` : ""}
            </span>

            {experience.durationMinutes != null ? (
              <span className="inline-flex items-center gap-2 rounded-full bg-highlight-soft px-3.5 py-2 text-sm text-ink-muted">
                <Clock className="size-4 shrink-0 text-highlight" aria-hidden="true" />
                {experience.durationMinutes} minutes
              </span>
            ) : null}

            <span className="inline-flex items-center gap-2 rounded-full bg-surface-raised px-3.5 py-2 text-sm text-ink-muted">
              <Star className="size-4 shrink-0 fill-highlight text-highlight" aria-hidden="true" />
              {experience.rating != null
                ? `${experience.rating} (${experience.reviewCount ?? 0} reviews)`
                : "No ratings yet"}
              {experience.isSynthetic || experience.ratingSummary?.isSynthetic ? (
                <span
                  className="rounded bg-surface px-1.5 py-0.5 text-[10px] font-medium text-ink-subtle ring-1 ring-inset ring-line"
                  title="Synthetic Demo Rating"
                >
                  Demo
                </span>
              ) : null}
            </span>
          </div>

          <Card>
            <CardBody className="space-y-2 p-5 sm:p-6">
              <h2 className="text-lg font-semibold tracking-tight text-ink">
                About this experience
              </h2>
              <p className="text-sm leading-7 text-ink-muted">{experience.description}</p>
            </CardBody>
          </Card>

          {experience.highlights.length > 0 ? (
            <Card>
              <CardBody className="space-y-4 p-5 sm:p-6">
                <h2 className="text-lg font-semibold tracking-tight text-ink">Highlights</h2>
                <ul className="grid gap-3 sm:grid-cols-2">
                  {experience.highlights.map((highlight) => (
                    <li
                      key={highlight}
                      className="flex items-start gap-2.5 rounded-2xl bg-success-soft/60 px-3.5 py-3 text-sm text-ink-muted"
                    >
                      <CheckCircle2
                        className="mt-0.5 size-4 shrink-0 text-success"
                        aria-hidden="true"
                      />
                      {highlight}
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardBody className="space-y-2 p-5 sm:p-6">
              <h2 className="text-lg font-semibold tracking-tight text-ink">Accessibility</h2>
              <p className="text-sm leading-6 text-ink-muted">
                {experience.accessibility.wheelchairAccessible === null
                  ? "Accessibility information is not available for this listing yet."
                  : `${
                      experience.accessibility.wheelchairAccessible
                        ? "Wheelchair accessible."
                        : "Not wheelchair accessible."
                    } ${
                      experience.accessibility.stepFree
                        ? "Step-free route available."
                        : "Includes steps or uneven ground."
                    }`}
                {experience.accessibility.notes
                  ? ` ${experience.accessibility.notes}.`
                  : ""}
              </p>
            </CardBody>
          </Card>

          <Card>
            <CardBody className="space-y-4 p-5 sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-lg font-semibold tracking-tight text-ink">
                  Location &amp; travel
                </h2>

                {!origin ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={requestLocation}
                    loading={geoStatus === "loading"}
                    className="rounded-full"
                  >
                    <Crosshair className="size-4" aria-hidden="true" />
                    Set a starting point
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleShowRoute}
                    loading={routeStatus === "loading"}
                    className="rounded-full"
                  >
                    <RouteIcon className="size-4" aria-hidden="true" />
                    Show route
                  </Button>
                )}
              </div>

              {!origin ? (
                <p className="text-xs text-ink-subtle">
                  Set a starting point to see travel time.
                </p>
              ) : route ? (
                <p className="text-sm text-ink-muted">
                  {route.distance_km} km · about {Math.round(route.duration_minutes)} min by road
                  {route.source === "haversine_estimate"
                    ? " (estimated — routing unavailable)"
                    : ""}
                </p>
              ) : routeStatus === "error" ? (
                <p className="text-sm text-danger">Travel time unavailable right now.</p>
              ) : null}

              <MapSurface
                label={`Map of ${experience.location.area}`}
                features={mapFeatures}
                origin={origin}
                routeGeometry={route?.geometry ?? null}
                center={{ lat: experience.location.lat, lng: experience.location.lng }}
                zoom={14}
                className="overflow-hidden rounded-2xl"
              />
            </CardBody>
          </Card>
          <Card>
            <CardBody className="space-y-4 p-5 sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <Clock className="size-5 text-highlight" aria-hidden="true" />
                  <h2 className="text-lg font-semibold tracking-tight text-ink">
                    Weekly Schedule
                  </h2>
                </div>
                {experience.isOpeningHoursSynthetic ? (
                  <DemoDataBadge label="Simulated Schedule" />
                ) : null}
              </div>

              {experience.openingHoursWeekly && experience.openingHoursWeekly.length > 0 ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  {experience.openingHoursWeekly.map((item) => (
                    <div
                      key={item.dayIndex}
                      className="flex items-center justify-between rounded-xl bg-surface-raised/70 px-3.5 py-2.5 text-sm"
                    >
                      <span className="font-medium text-ink">{item.day}</span>
                      {item.isClosed ? (
                        <span className="rounded-full bg-danger-soft px-2 py-0.5 text-xs font-medium text-danger">
                          Closed
                        </span>
                      ) : (
                        <span className="text-ink-muted">
                          {item.open} – {item.close}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-ink-muted">
                  {experience.openingHours ?? "Schedule details not available."}
                </p>
              )}
            </CardBody>
          </Card>

          {experience.availabilitySlots && experience.availabilitySlots.length > 0 ? (
            <Card>
              <CardBody className="space-y-4 p-5 sm:p-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <CalendarDays className="size-5 text-accent" aria-hidden="true" />
                    <h2 className="text-lg font-semibold tracking-tight text-ink">
                      Upcoming Availability
                    </h2>
                  </div>
                  {experience.isAvailabilitySynthetic ? (
                    <DemoDataBadge label="Demo Availability" />
                  ) : null}
                </div>

                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {experience.availabilitySlots.slice(0, 6).map((slot) => {
                    const spotsRemaining = Math.max(0, slot.capacity - slot.bookedCount);
                    return (
                      <div
                        key={slot.id}
                        className="rounded-2xl border border-line bg-surface-raised/50 p-3.5 space-y-1.5 transition-colors hover:border-accent/40"
                      >
                        <div className="text-xs font-semibold text-ink">
                          {formatSlotDate(slot.startTime)}
                        </div>
                        <div className="text-sm text-ink-muted">
                          {formatSlotTime(slot.startTime)} – {formatSlotTime(slot.endTime)}
                        </div>
                        <div className="flex items-center justify-between pt-1">
                          <span className="text-[11px] font-medium text-success">
                            {spotsRemaining} {spotsRemaining === 1 ? "spot" : "spots"} left
                          </span>
                          <span className="text-[10px] uppercase tracking-wider text-ink-subtle">
                            {slot.capacity} max
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <p className="text-xs text-ink-subtle">
                  Showing next available departures. Real-time calendar booking preview.
                </p>
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardBody className="space-y-6 p-5 sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <Star className="size-5 fill-highlight text-highlight" aria-hidden="true" />
                  <h2 className="text-lg font-semibold tracking-tight text-ink">
                    Ratings &amp; Traveler Reviews
                  </h2>
                </div>
                {experience.isSynthetic || experience.ratingSummary?.isSynthetic ? (
                  <DemoDataBadge label="Synthetic Demo Rating" />
                ) : null}
              </div>

              {experience.ratingSummary ? (
                <div className="grid gap-6 rounded-2xl bg-surface-raised/60 p-5 sm:grid-cols-[200px_minmax(0,1fr)] sm:items-center">
                  <div className="text-center sm:border-r sm:border-line sm:pr-6 sm:text-left">
                    <div className="text-4xl font-extrabold tracking-tight text-ink">
                    {experience.ratingSummary.averageRating != null
  ? experience.ratingSummary.averageRating.toFixed(1)
  : "No ratings"}
                    </div>
                    <div className="mt-1 flex justify-center gap-1 sm:justify-start">
                      {[1, 2, 3, 4, 5].map((star) => (
                        <Star
                          key={star}
                          className={`size-4 ${
                            star <= Math.round(experience.ratingSummary!.averageRating)
                              ? "fill-highlight text-highlight"
                              : "text-line"
                          }`}
                          aria-hidden="true"
                        />
                      ))}
                    </div>
                    <p className="mt-1.5 text-xs text-ink-muted">
                      Based on {experience.ratingSummary.reviewCount} reviews
                    </p>
                    {experience.ratingSummary.isSynthetic ? (
                      <p className="mt-0.5 text-[10px] text-ink-subtle">
                        (Synthetic demonstration data)
                      </p>
                    ) : null}
                  </div>

                  <div className="space-y-1.5">
                    {[5, 4, 3, 2, 1].map((star) => {
                      const count = experience.ratingSummary?.distribution[star] ?? 0;
                      const total = experience.ratingSummary?.reviewCount || 1;
                      const pct = Math.round((count / total) * 100);
                      return (
                        <div key={star} className="flex items-center gap-2 text-xs">
                          <span className="w-7 text-ink-muted">{star} ★</span>
                          <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-sunken">
                            <div
                              className="h-full rounded-full bg-highlight"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="w-12 text-right text-ink-subtle">
                            {pct}% ({count})
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {experience.reviews && experience.reviews.length > 0 ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-ink">Sample Reviews</h3>
                    <span className="text-xs text-ink-subtle">
                      Showing {experience.reviews.length} recent reviews
                    </span>
                  </div>

                  <div className="space-y-3">
                    {experience.reviews.map((rev) => (
                      <div
                        key={rev.id}
                        className="rounded-2xl border border-line bg-surface-raised/40 p-4 space-y-2"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <div className="flex size-7 items-center justify-center rounded-full bg-accent-soft text-accent">
                              <User className="size-3.5" aria-hidden="true" />
                            </div>
                            <span className="text-xs font-medium text-ink">{rev.author}</span>
                            {rev.isSynthetic ? (
                              <span className="rounded bg-surface-sunken px-1.5 py-0.5 text-[9px] font-medium text-ink-subtle">
                                Synthetic
                              </span>
                            ) : null}
                          </div>

                          <div className="flex items-center gap-2">
                            <div className="flex gap-0.5">
                              {[1, 2, 3, 4, 5].map((s) => (
                                <Star
                                  key={s}
                                  className={`size-3 ${
                                    s <= rev.rating
                                      ? "fill-highlight text-highlight"
                                      : "text-line"
                                  }`}
                                  aria-hidden="true"
                                />
                              ))}
                            </div>
                            <span className="text-xs text-ink-subtle">
                              {formatReviewDate(rev.reviewedAt)}
                            </span>
                          </div>
                        </div>

                        {rev.title ? (
                          <h4 className="text-sm font-semibold text-ink">{rev.title}</h4>
                        ) : null}

                        {rev.body ? (
                          <p className="text-xs leading-5 text-ink-muted">{rev.body}</p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-sm text-ink-muted">No reviews available yet.</p>
              )}
            </CardBody>
          </Card>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start">
          <Card className="rounded-3xl">
            <CardBody className="space-y-5 p-5 sm:p-6">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-3xl font-semibold tracking-tight text-ink">
                  {experience.priceInr === 0 ? "Free" : `₹${experience.priceInr}`}
                </span>
                <span className="text-right text-xs text-ink-subtle">
                  {experience.isPriceEstimated ? "estimated · per person" : "per person"}
                </span>
              </div>

              <dl className="space-y-3 rounded-2xl bg-surface-raised p-4 text-sm">
                <div className="flex items-start justify-between gap-4">
                  <dt className="text-ink-subtle">Opening hours</dt>
                  <dd className="text-right text-ink">
                    {experience.openingHours ?? "Not available"}
                  </dd>
                </div>
                <div className="flex items-start justify-between gap-4">
                  <dt className="text-ink-subtle">Availability</dt>
                  <dd className="text-right capitalize text-ink">{experience.availability}</dd>
                </div>
              </dl>

              <div className="space-y-3">
                <Button
                  className="w-full rounded-full"
                  disabled
                  title="Booking arrives in a later phase"
                >
                  Request to book
                </Button>
                <Button variant="outline" className="w-full rounded-full">
                  <Bookmark className="size-4" aria-hidden="true" />
                  Save for later
                </Button>
                <p className="text-center text-xs leading-5 text-ink-subtle">
                  Booking is not yet available &mdash; this is a UI preview.
                </p>
              </div>
            </CardBody>
          </Card>
        </aside>
      </div>
    </div>
  );
}
