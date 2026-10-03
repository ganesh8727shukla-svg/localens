import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils/cn";

type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "highlight";

const toneClasses: Record<Tone, string> = {
  neutral: "border border-line bg-surface-sunken/80 text-ink-muted",
  accent: "border border-pastel-lavender/80 bg-pastel-lavender/40 text-ink font-medium",
  success: "border border-success/25 bg-success-soft text-success font-medium",
  warning: "border border-warning/25 bg-warning-soft text-warning font-medium",
  danger: "border border-danger/25 bg-danger-soft text-danger font-medium",
  highlight: "border border-pastel-lemon/80 bg-pastel-lemon/45 text-ink font-medium",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
}

export function Badge({ className, tone = "neutral", ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium leading-none",
        toneClasses[tone],
        className,
      )}
      {...props}
    />
  );
}
