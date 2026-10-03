"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Compass, LogOut, Menu, User, X } from "lucide-react";
import { primaryNav } from "@/lib/constants/nav";
import { NavLink } from "@/components/navigation/NavLink";
import { IconButton } from "@/components/ui/IconButton";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils/cn";
import { useAuth } from "@/lib/auth/AuthContext";
import { useActiveTripProgress } from "@/hooks/useActiveTripProgress";

function useVisibleNav() {
  const { user } = useAuth();

  return useMemo(() => {
    if (!user) return primaryNav;

    if (user.role === "provider") {
      return primaryNav.filter((item) => !["/trip", "/saved", "/collab", "/showcase"].includes(item.href));
    }

    return primaryNav.filter((item) => item.href !== "/provider");
  }, [user]);
}

export function SiteHeader() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { user, isLoading, logout } = useAuth();
  const router = useRouter();
  const visibleNav = useVisibleNav();
  const activeTripProgress = useActiveTripProgress(user?.id);

  async function handleLogout() {
    await logout();
    setMobileOpen(false);
    router.push("/");
  }

  return (
    <header className="sticky top-0 z-50 lg:static">
      {/* Mobile and tablet header */}
      <div className="flex h-16 items-center justify-between border-b border-line bg-surface/95 px-4 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-surface/85 lg:hidden">
        <Link href="/" className="flex items-center gap-2.5 font-semibold text-ink">
          <span className="flex size-9 items-center justify-center rounded-xl border border-pastel-lemon/80 bg-pastel-lemon text-ink shadow-sm">
            <Compass className="size-4.5" aria-hidden="true" />
          </span>
          <span className="text-[17px] tracking-tight">LocaLens</span>
        </Link>

        <IconButton
          label={mobileOpen ? "Close menu" : "Open menu"}
          aria-expanded={mobileOpen}
          aria-controls="mobile-nav-panel"
          onClick={() => setMobileOpen((open) => !open)}
        >
          {mobileOpen ? <X className="size-5" /> : <Menu className="size-5" />}
        </IconButton>
      </div>

      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-50 hidden w-60 flex-col border-r border-primary-ink/10 bg-primary px-4 py-6 text-primary-ink lg:flex">
        <Link href="/" className="group flex items-center gap-3 px-2 font-semibold">
          <span className="flex size-10 items-center justify-center rounded-xl border border-pastel-lemon/80 bg-pastel-lemon text-ink shadow-sm transition-transform duration-200 group-hover:scale-105">
            <Compass className="size-5" aria-hidden="true" />
          </span>
          <span className="text-lg tracking-tight">LocaLens</span>
        </Link>

        <nav aria-label="Primary" className="mt-10 flex flex-col gap-1.5">
          {visibleNav.map((item) => (
            <NavLink
              key={item.href}
              {...item}
              activeIndicator={item.href === "/trip" && activeTripProgress?.status === "ACTIVE"}
              className="w-full justify-start rounded-xl px-3 py-3 text-primary-ink/75 hover:bg-primary-ink/10 hover:text-primary-ink aria-[current=page]:bg-primary-ink/15 aria-[current=page]:text-primary-ink"
            />
          ))}
        </nav>

        <div className="mt-auto border-t border-primary-ink/15 pt-4">
          {isLoading ? null : user ? (
            <div className="space-y-2">
              <span
                className="block truncate px-3 text-sm text-primary-ink/70"
                title={user.email}
              >
                {user.email}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start text-primary-ink/85 hover:bg-primary-ink/10 hover:text-primary-ink"
                onClick={handleLogout}
              >
                <LogOut className="size-4" aria-hidden="true" />
                Log out
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <Link href="/login" className="block">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start text-primary-ink/85 hover:bg-primary-ink/10 hover:text-primary-ink"
                >
                  Log in
                </Button>
              </Link>
              <Link href="/register" className="block">
                <Button
                  variant="primary"
                  size="sm"
                  className="w-full bg-pastel-lemon text-ink hover:brightness-105"
                >
                  <User className="size-4" aria-hidden="true" />
                  Get started
                </Button>
              </Link>
            </div>
          )}
        </div>
      </aside>

      {/* Mobile and tablet navigation panel */}
      <div
        id="mobile-nav-panel"
        className={cn(
          "border-b border-line bg-surface/95 shadow-xl backdrop-blur-lg lg:hidden",
          mobileOpen ? "block" : "hidden",
        )}
      >
        <nav aria-label="Mobile primary" className="flex flex-col gap-1 px-4 py-3">
          {visibleNav.map((item) => (
            <NavLink
              key={item.href}
              {...item}
              activeIndicator={item.href === "/trip" && activeTripProgress?.status === "ACTIVE"}
              className="w-full justify-start"
              onClick={() => setMobileOpen(false)}
            />
          ))}

          <div className="mt-2 flex gap-2 border-t border-line pt-3">
            {isLoading ? null : user ? (
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={handleLogout}
              >
                <LogOut className="size-4" aria-hidden="true" />
                Log out ({user.email})
              </Button>
            ) : (
              <>
                <Link
                  href="/login"
                  className="flex-1"
                  onClick={() => setMobileOpen(false)}
                >
                  <Button variant="outline" size="sm" className="w-full">
                    Log in
                  </Button>
                </Link>
                <Link
                  href="/register"
                  className="flex-1"
                  onClick={() => setMobileOpen(false)}
                >
                  <Button variant="primary" size="sm" className="w-full">
                    <User className="size-4" aria-hidden="true" />
                    Get started
                  </Button>
                </Link>
              </>
            )}
          </div>
        </nav>
      </div>
    </header>
  );
}
