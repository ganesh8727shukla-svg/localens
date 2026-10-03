import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils/cn";
import { ScrollReveal } from "@/components/common/ScrollReveal";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <ScrollReveal>
      <div
        className={cn(
          "porcelain-card rounded-2xl border border-line bg-surface-raised shadow-soft",
          className,
        )}
        {...props}
      />
    </ScrollReveal>
  );
}

export function CardHeader({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("p-4 pb-0 sm:p-5 sm:pb-0", className)}
      {...props}
    />
  );
}

export function CardBody({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("p-4 sm:p-5", className)} {...props} />
  );
}

export function CardFooter({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("p-4 pt-0 sm:p-5 sm:pt-0", className)}
      {...props}
    />
  );
}
