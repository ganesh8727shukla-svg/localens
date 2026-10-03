"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { primaryNav } from "@/lib/constants/nav";
import { cn } from "@/lib/utils/cn";
import { useAuth } from "@/lib/auth/AuthContext";
import { useActiveTripProgress } from "@/hooks/useActiveTripProgress";

export function MobileTabBar() {
  const pathname = usePathname();
  const { user } = useAuth();
  const activeTripProgress = useActiveTripProgress(user?.id);
  const visibleNav = user?.role === "provider"
    ? primaryNav.filter((item) => !["/trip", "/saved", "/collab", "/showcase"].includes(item.href))
    : user?.role === "traveler"
      ? primaryNav.filter((item) => item.href !== "/provider")
      : primaryNav;

  return (
    <nav
      aria-label="Primary mobile"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/90 px-2 pt-1.5 shadow-xl backdrop-blur-xl md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="mx-auto grid max-w-xl gap-1" style={{ gridTemplateColumns: `repeat(${visibleNav.length}, minmax(0, 1fr))` }}>
        {visibleNav.map(({ href, label, icon: Icon }) => {
          const isActive = pathname === href || pathname.startsWith(href);

          return (
            <li key={href} className="min-w-0">
              <Link
                href={href}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl px-1 py-1.5 text-[10px] font-medium transition-all duration-150",
                  isActive
                    ? "border border-accent/60 bg-accent-soft font-semibold text-ink shadow-sm"
                    : "text-ink-muted hover:bg-surface-sunken/60 hover:text-ink",
                )}
              >
                <Icon className="size-4.5" aria-hidden="true" />
                <span className="inline-flex items-center gap-1 whitespace-nowrap">
                  {label}
                  {href === "/trip" && activeTripProgress?.status === "ACTIVE" ? <>
                    <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
                    <span className="sr-only">Active trip</span>
                  </> : null}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
