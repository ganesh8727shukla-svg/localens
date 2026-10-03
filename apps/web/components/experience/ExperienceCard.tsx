"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Bookmark, Clock, MapPin, ShieldCheck, Star } from "lucide-react";
import type { Experience } from "@/types/experience";
import { Badge } from "@/components/ui/Badge";
import { PersonalizationBadge } from "@/components/ui/PersonalizationBadge";
import { ExperienceImageView } from "@/components/experience/ExperienceImageView";
import { ScrollReveal } from "@/components/common/ScrollReveal";
import { cn } from "@/lib/utils/cn";

const availabilityTone = {
  available: "success",
  limited: "warning",
  unavailable: "danger",
} as const;

const availabilityLabel = {
  available: "Available",
  limited: "Limited spots",
  unavailable: "Unavailable",
} as const;

export interface ExperienceCardProps {
  experience: Experience;
  variant?: "standard" | "compact" | "featured";
  saved?: boolean;
  onToggleSave?: (id: string, saved: boolean) => void | Promise<void>;
  className?: string;
}

export function ExperienceCard({
  experience,
  variant = "standard",
  saved = false,
  onToggleSave,
  className,
}: ExperienceCardProps) {
  const [isSaved, setIsSaved] = useState(saved);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const isCompact = variant === "compact";
  const isFeatured = variant === "featured";

  useEffect(() => {
    setIsSaved(saved);
  }, [saved]);

  async function handleSaveToggle() {
    if (isSaving) return;
    const nextSaved = !isSaved;
    setIsSaved(nextSaved);
    setIsSaving(true);
    setSaveError(false);
    try {
      await onToggleSave?.(experience.id, nextSaved);
    } catch {
      setIsSaved(!nextSaved);
      setSaveError(true);
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <ScrollReveal>
      <article
        className={cn(
          "group relative flex overflow-hidden rounded-2xl border border-line bg-surface-raised shadow-soft porcelain-card",
          isCompact ? "flex-row items-stretch" : "flex-col",
          isFeatured && "sm:col-span-2",
          className,
        )}
      >
      <div
        className={cn(
          "relative shrink-0 overflow-hidden bg-pastel-sky/20",
          isCompact ? "w-28 sm:w-36" : "aspect-[4/3] w-full",
          isFeatured && "sm:aspect-auto sm:min-h-[220px]",
        )}
      >
        <ExperienceImageView
          src={experience.imageUrl}
          alt=""
          fill
          sizes={isCompact ? "144px" : "(min-width: 640px) 400px, 100vw"}
          className="object-cover transition-transform duration-500 ease-out group-hover:scale-105"
        />

        {!isCompact ? (
          <button
            type="button"
            onClick={() => void handleSaveToggle()}
            disabled={isSaving}
            aria-pressed={isSaved}
            aria-label={isSaved ? "Remove from saved" : "Save experience"}
            className="absolute right-3 top-3 z-20 inline-flex size-10 items-center justify-center rounded-full border border-line/70 bg-surface/95 text-ink shadow-sm backdrop-blur transition-colors hover:bg-pastel-rose hover:text-ink disabled:cursor-wait disabled:opacity-70"
          >
            <Bookmark
              className={cn(
                "size-4.5",
                isSaved && "fill-accent text-accent",
              )}
              aria-hidden="true"
            />
          </button>
        ) : null}

        {!isCompact && !experience.image.isFallback && !experience.image.isPlaceSpecific ? (
          <span className="absolute bottom-2 left-2.5 z-10 rounded bg-surface/80 px-1.5 py-0.5 text-[10px] italic text-ink-subtle backdrop-blur">
            Representative image
          </span>
        ) : null}
      </div>

      <div className={cn("flex flex-1 flex-col gap-3 p-4 sm:p-5", isCompact && "py-3")}>
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <Badge tone="accent">{experience.categoryLabel}</Badge>
            <Badge tone={experience.isSynthetic ? "warning" : "neutral"}>
              {experience.isSynthetic ? "Demo listing" : "Non-demo source"}
            </Badge>
          </div>
          {!isCompact ? (
            <Badge tone={availabilityTone[experience.availability]}>
              {availabilityLabel[experience.availability]}
            </Badge>
          ) : null}
        </div>

        <div>
          <h3
            className={cn(
              "font-semibold leading-snug text-ink",
              isCompact ? "text-sm" : "text-base",
            )}
          >
            <Link href={`/discover/${experience.id}`} className="hover:underline">
              <span className="absolute inset-0 z-10" aria-hidden={isCompact} />
              {experience.title}
            </Link>
          </h3>

          {!isCompact ? (
            <>
              <p className="mt-1.5 line-clamp-2 text-sm leading-6 text-ink-muted">
                {experience.shortDescription}
              </p>

              {experience.matchSignals &&
              experience.matchSignals.length > 0 ? (
                <div className="mt-2">
                  <PersonalizationBadge signals={experience.matchSignals} />
                </div>
              ) : null}
            </>
          ) : null}
        </div>

        <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-ink-subtle">
          <span className="inline-flex items-center gap-1">
            <MapPin className="size-3.5" aria-hidden="true" />
            {experience.location.area}
            {experience.distanceKm != null
              ? ` · ${experience.distanceKm} km`
              : ""}
          </span>

          {experience.travelTimeMinutes != null ? (
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3.5" aria-hidden="true" />
              {Math.round(experience.travelTimeMinutes)} min
              {experience.travelTimeSource === "haversine_estimate"
                ? " (est.)"
                : ""}
            </span>
          ) : null}

          {experience.durationMinutes != null ? (
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3.5" aria-hidden="true" />
              {experience.durationMinutes} min
            </span>
          ) : null}

          {experience.accessibility.wheelchairAccessible ? (
            <span className="inline-flex items-center gap-1">
              <ShieldCheck className="size-3.5" aria-hidden="true" />
              Accessible
            </span>
          ) : null}
        </div>

        <div className="flex items-center justify-between border-t border-line pt-3">
          {experience.rating != null ? (
            <span className="inline-flex items-center gap-1 text-xs text-ink-muted">
              <Star
                className="size-3.5 fill-highlight text-highlight"
                aria-hidden="true"
              />
              <span className="font-medium text-ink">{experience.rating}</span>
              {experience.reviewCount != null ? (
                <span>({experience.reviewCount})</span>
              ) : null}
              {experience.isSynthetic ? (
                <span
                  className="ml-0.5 rounded bg-surface px-1.5 py-0.5 text-[9px] font-medium text-ink-subtle ring-1 ring-inset ring-line"
                  title="Synthetic Demo Rating"
                >
                  Demo
                </span>
              ) : null}
            </span>
          ) : (
            <span className="text-xs text-ink-subtle">No ratings yet</span>
          )}

          <span className="text-sm font-semibold text-ink">
            {experience.priceInr === 0
              ? "Free"
              : `₹${experience.priceInr}`}
            {experience.isPriceEstimated ? (
              <span className="font-normal text-ink-subtle"> est.</span>
            ) : null}
          </span>
        </div>
        {saveError ? (
          <p className="text-xs text-danger" role="alert">
            Couldn&apos;t update your saved list. Try again.
          </p>
        ) : null}
      </div>
      </article>
    </ScrollReveal>
  );
}
