import Link from "next/link";
import { Compass } from "lucide-react";
import { PageContainer } from "@/components/layout/PageContainer";

const footerLinks = [
  { label: "Discover", href: "/discover" },
  { label: "Trips", href: "/trip" },
  { label: "Provider", href: "/provider" },
  { label: "Safety", href: "/safety" },
];

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-line bg-surface/85 backdrop-blur-sm">
      <PageContainer className="flex flex-col gap-5 py-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2.5 text-ink-muted">
          <span className="flex size-8 items-center justify-center rounded-lg bg-pastel-rose text-ink">
            <Compass className="size-4" aria-hidden="true" />
          </span>
          <span className="text-sm">
            <span className="font-semibold text-ink">LocaLens</span>
            {" — HackCelestial 3.0, PS-6"}
          </span>
        </div>

        <nav aria-label="Footer" className="flex flex-wrap gap-x-5 gap-y-2">
          {footerLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-sm text-ink-muted transition-colors hover:text-ink"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <p className="text-xs text-ink-subtle">
          Prototype build — not for public distribution.
        </p>
      </PageContainer>
    </footer>
  );
}
