"use client";

import { memo } from "react";
import { cn } from "@/lib/utils/cn";

export interface TravelShapesBackgroundProps {
  variant?: "hero" | "full" | "minimal";
  className?: string;
}

/**
 * Purely decorative ambient background — organic blobs, a slow-spinning
 * compass rose, and a retro "passport stamp" accent. Colors are drawn from
 * this app's own design tokens (var(--color-*)) rather than the reference
 * project's hardcoded Saphinka palette, so it matches this theme instead
 * of clashing with it. Motion respects prefers-reduced-motion via the
 * shape-float and shape-spin-slow utility classes in globals.css.
 */
export const TravelShapesBackground = memo(function TravelShapesBackground({
  className,
}: TravelShapesBackgroundProps) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-0 z-0 overflow-hidden select-none",
        className,
      )}
      aria-hidden="true"
    >
      {/* Organic blob 1 */}
      <div
        className="shape-float-slow absolute -left-16 -top-20 size-72 sm:size-96 rounded-[58%_42%_66%_34%/44%_56%_44%_56%] blur-3xl"
        style={{ backgroundColor: "var(--color-pastel-sky)", opacity: 0.16 }}
      />

      {/* Organic blob 2 */}
      <div
        className="shape-float-reverse absolute -right-16 top-6 size-64 sm:size-88 rounded-[42%_58%_35%_65%/60%_38%_62%_40%] blur-3xl"
        style={{ backgroundColor: "var(--color-pastel-lemon)", opacity: 0.2 }}
      />

      {/* Organic blob 3 */}
      <div
        className="shape-float-subtle absolute -left-16 bottom-0 size-60 sm:size-76 rounded-[65%_35%_45%_55%/40%_65%_35%_60%] blur-3xl"
        style={{ backgroundColor: "var(--color-pastel-lavender)", opacity: 0.16 }}
      />

      {/* Organic blob 4 */}
      <div
        className="shape-float-slow absolute -right-16 bottom-4 size-56 sm:size-72 rounded-[50%_50%_30%_70%/60%_40%_60%_40%] blur-3xl"
        style={{ backgroundColor: "var(--color-pastel-mint)", opacity: 0.18 }}
      />

      {/* Rotating sunburst / compass rose — right margin, wide screens only */}
      <div className="shape-spin-slow absolute right-8 top-14 hidden xl:block opacity-35">
        <svg
          width="120"
          height="120"
          viewBox="0 0 100 100"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className="text-highlight"
        >
          <circle cx="50" cy="50" r="16" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 3" opacity="0.6" />
          <circle className="shape-pulse-gentle" cx="50" cy="50" r="6" fill="currentColor" opacity="0.8" />
          {[0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map((deg) => (
            <line
              key={deg}
              x1="50"
              y1="22"
              x2="50"
              y2="10"
              stroke="currentColor"
              strokeWidth={deg % 90 === 0 ? "2.5" : "1.5"}
              strokeLinecap="round"
              transform={`rotate(${deg} 50 50)`}
            />
          ))}
        </svg>
      </div>

      {/* Retro travel-stamp accent — left margin, wide screens only */}
      <div className="shape-float-reverse absolute left-8 top-24 hidden xl:flex flex-col items-center justify-center opacity-65">
        <div className="relative rounded-xl border border-dashed border-accent/40 bg-surface/60 px-3.5 py-2 shadow-xs backdrop-blur-[2px]">
          <span className="absolute -left-1.5 top-1/2 -translate-y-1/2 size-3 rounded-full bg-bg border-r border-accent/40" />
          <span className="absolute -right-1.5 top-1/2 -translate-y-1/2 size-3 rounded-full bg-bg border-l border-accent/40" />
          <span className="text-[10px] font-bold tracking-[0.2em] text-accent uppercase">
            LOCAL · PASSPORT
          </span>
          <div className="mt-0.5 flex items-center justify-between text-[9px] text-ink-subtle">
            <span>REAL EXP</span>
            <span className="font-mono">★ LOCALENS</span>
          </div>
        </div>
      </div>

      {/* Soft topographic contour lines + an architectural arch outline */}
      <svg
        className="absolute inset-0 h-full w-full opacity-20"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        preserveAspectRatio="none"
      >
        <path
          d="M-50,180 Q320,60 700,200 T1500,120"
          stroke="var(--color-accent)"
          strokeWidth="1.2"
          strokeDasharray="6 6"
          opacity="0.3"
        />
        <path
          d="M-50,220 Q400,90 850,240 T1600,150"
          stroke="var(--color-pastel-sky)"
          strokeWidth="1"
          opacity="0.25"
        />
        <path
          d="M-50,260 Q480,120 950,270 T1700,180"
          stroke="var(--color-pastel-lemon)"
          strokeWidth="1"
          strokeDasharray="4 4"
          opacity="0.35"
        />

        <g transform="translate(1080, 20)" opacity="0.3" className="hidden lg:block">
          <path
            d="M0,260 L0,70 A55,55 0 0,1 110,70 L110,260"
            stroke="var(--color-accent)"
            strokeWidth="1.5"
            fill="none"
          />
          <path
            d="M12,260 L12,74 A43,43 0 0,1 98,74 L98,260"
            stroke="var(--color-pastel-sky)"
            strokeWidth="1"
            strokeDasharray="3 3"
            fill="none"
          />
        </g>
      </svg>
    </div>
  );
});
