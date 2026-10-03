import { cn } from "@/lib/utils/cn";

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      role="presentation"
      aria-hidden="true"
      className={cn(
        "skeleton-shimmer rounded-2xl border border-line/40 motion-reduce:animate-none",
        className,
      )}
    />
  );
}
