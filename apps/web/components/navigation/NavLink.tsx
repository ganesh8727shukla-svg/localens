"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils/cn";

export function NavLink({
  href,
  label,
  icon: Icon,
  className,
  onClick,
  activeIndicator = false,
}: {
  href: string;
  label: string;
  icon?: LucideIcon;
  className?: string;
  onClick?: () => void;
  activeIndicator?: boolean;
}) {
  const pathname = usePathname();
  const isActive = pathname === href || (href !== "/" && pathname.startsWith(href));

  return (
    <Link
      href={href}
      onClick={onClick}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "inline-flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200",
        "text-ink-muted hover:bg-surface-raised hover:text-ink",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        isActive && "border border-accent/30 bg-accent-soft font-semibold text-accent shadow-sm",
        className,
      )}
    >
      {Icon ? <Icon className="size-4 shrink-0" aria-hidden="true" /> : null}
      {label}
      {activeIndicator ? <>
        <span className="ml-auto size-2 shrink-0 rounded-full bg-success" aria-hidden="true" />
        <span className="sr-only">Active trip</span>
      </> : null}
    </Link>
  );
}
