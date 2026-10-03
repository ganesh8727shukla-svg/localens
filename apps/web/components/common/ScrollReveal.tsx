import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

export function ScrollReveal({
    children,
    className,
}: {
    children: ReactNode;
    className?: string;
}) {
    return <div className={cn("scroll-reveal", className)}>{children}</div>;
}
