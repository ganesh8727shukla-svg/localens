import type { ReactNode } from "react";
import { SiteHeader } from "@/components/layout/SiteHeader";
import { SiteFooter } from "@/components/layout/SiteFooter";
import { MobileTabBar } from "@/components/navigation/MobileTabBar";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="ambient-surface min-h-screen bg-bg text-ink">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-ink"
      >
        Skip to main content
      </a>

      <SiteHeader />

      <div className="app-content flex min-h-screen min-w-0 flex-col lg:pl-60">
        <main
          id="main-content"
          className="min-w-0 flex-1 pb-20 md:pb-0"
        >
          {children}
        </main>

        <SiteFooter />
      </div>

      <MobileTabBar />
    </div>
  );
}
