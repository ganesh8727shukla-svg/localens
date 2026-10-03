"use client";

import { useEffect, useState } from "react";
import {
    Bus,
    Camera,
    Coffee,
    Compass,
    House,
    Luggage,
    MapPin,
    Mountain,
    Plane,
    TrainFront,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils/cn";

type Variant = "hero" | "auth";

type DoodleItem = {
    icon: LucideIcon;
    label: string;
    tone: string;
    size: number;
    tilt: number;
};

type StartPosition = { x: number; y: number } | null;

const doodles: DoodleItem[] = [
    // Left Flank circles
    { icon: Compass, label: "compass", tone: "lemon", size: 72, tilt: 10 },
    { icon: Camera, label: "camera", tone: "lavender", size: 66, tilt: -8 },
    { icon: Luggage, label: "suitcase", tone: "teal", size: 60, tilt: 9 },
    { icon: Coffee, label: "coffee cup", tone: "rose", size: 56, tilt: -12 },
    // Right Flank circles
    { icon: Plane, label: "airplane", tone: "sky", size: 74, tilt: 8 },
    { icon: House, label: "guest house", tone: "mint", size: 68, tilt: -6 },
    { icon: MapPin, label: "map marker", tone: "tang", size: 56, tilt: 10 },
    { icon: Mountain, label: "mountain", tone: "guava", size: 64, tilt: -8 },
    { icon: TrainFront, label: "train", tone: "sky", size: 62, tilt: -6 },
    { icon: Bus, label: "bus", tone: "teal", size: 66, tilt: 7 },
];

export function TravelDoodles({ variant }: { variant: Variant }) {
    const [starts, setStarts] = useState<StartPosition[] | null>(null);

    useEffect(() => {
        function updatePositions() {
            setStarts(calculateFlankPositions(variant));
        }

        const frameId = requestAnimationFrame(updatePositions);
        const timer = setTimeout(updatePositions, 150);

        window.addEventListener("resize", updatePositions, { passive: true });
        return () => {
            cancelAnimationFrame(frameId);
            clearTimeout(timer);
            window.removeEventListener("resize", updatePositions);
        };
    }, [variant]);

    return (
        <div className={cn("travel-doodles", `travel-doodles--${variant}`)} aria-hidden="true">
            {starts?.map((start, index) => {
                if (!start) return null;
                return (
                    <Doodle
                        key={doodles[index].label}
                        item={doodles[index]}
                        start={start}
                        index={index}
                    />
                );
            })}
        </div>
    );
}

/**
 * Arranges circular doodle chips strictly in the left and right margin corridors (flanks).
 * Guarantees zero overlap with the central content (title, input, cards, text).
 */
function calculateFlankPositions(variant: Variant): StartPosition[] {
    if (typeof window === "undefined") return [];

    const container =
        variant === "hero"
            ? document.querySelector<HTMLElement>(".landing-hero")
            : document.querySelector<HTMLElement>(".auth-container") ?? document.body;

    if (!container) return doodles.map(() => null);

    const containerBounds = container.getBoundingClientRect();
    const originX = containerBounds.left;
    const containerWidth = containerBounds.width;
    const containerHeight =
        variant === "hero"
            ? containerBounds.height
            : Math.min(window.innerHeight, containerBounds.height);

    const contentSelector = variant === "hero" ? ".landing-hero-content" : ".auth-content";
    const contentElement = document.querySelector<HTMLElement>(contentSelector);

    // If no content element is found, keep them clear of the center 60%
    let contentLeft = containerWidth * 0.2;
    let contentRight = containerWidth * 0.8;

    if (contentElement) {
        const cBounds = contentElement.getBoundingClientRect();
        contentLeft = cBounds.left - originX;
        contentRight = cBounds.right - originX;
    }

    // Safety buffer around content: at least 32px of blank breathing room
    const buffer = 32;
    const leftCorridorMaxX = contentLeft - buffer;
    const rightCorridorMinX = contentRight + buffer;

    const leftWidth = leftCorridorMaxX - 16;
    const rightWidth = containerWidth - 16 - rightCorridorMinX;

    // Minimum margin width needed to cleanly fit a circle without cramming
    const minNeededWidth = 72;

    const hasLeftFlank = leftWidth >= minNeededWidth;
    const hasRightFlank = rightWidth >= minNeededWidth;

    // Split doodle items into left and right groups
    const leftIndices = [0, 1, 2, 3];
    const rightIndices = [4, 5, 6, 7];

    const results: StartPosition[] = doodles.map(() => null);

    // Position Left Flank circles
    if (hasLeftFlank) {
        const count = leftIndices.length;
        const availableHeight = containerHeight - 80;
        const verticalStep = availableHeight / count;

        leftIndices.forEach((doodleIdx, i) => {
            const item = doodles[doodleIdx];
            const maxAllowedX = Math.max(16, leftCorridorMaxX - item.size);
            // Stagger slightly horizontally for an organic editorial look
            const horizontalOffset = (i % 2 === 0 ? 0.35 : 0.65) * (maxAllowedX - 16);
            const x = Math.round(16 + horizontalOffset);
            const y = Math.round(40 + i * verticalStep + (i % 2 === 0 ? 0 : 12));

            // Strict bounds check: never exceed corridor and never spill below container
            if (x + item.size < contentLeft - 16 && y + item.size < containerHeight - 20) {
                results[doodleIdx] = { x, y };
            }
        });
    }

    // Position Right Flank circles
    if (hasRightFlank) {
        const count = rightIndices.length;
        const availableHeight = containerHeight - 80;
        const verticalStep = availableHeight / count;

        rightIndices.forEach((doodleIdx, i) => {
            const item = doodles[doodleIdx];
            const minAllowedX = rightCorridorMinX;
            const maxAllowedX = Math.max(minAllowedX, containerWidth - item.size - 20);
            // Stagger slightly horizontally
            const horizontalOffset = (i % 2 === 0 ? 0.25 : 0.6) * (maxAllowedX - minAllowedX);
            const x = Math.round(minAllowedX + horizontalOffset);
            const y = Math.round(50 + i * verticalStep + (i % 2 === 0 ? 10 : 0));

            // Strict bounds check: never touch content and never spill below container
            if (x > contentRight + 16 && x + item.size <= containerWidth - 10 && y + item.size < containerHeight - 20) {
                results[doodleIdx] = { x, y };
            }
        });
    }

    return results;
}

function Doodle({ item, start, index }: { item: DoodleItem; start: StartPosition; index: number }) {
    if (!start) return null;
    const Icon = item.icon;

    return (
        <span
            className={cn("travel-doodle__float doodle-drift", `travel-doodle__art--${item.tone}`)}
            style={{
                left: start.x,
                top: start.y,
                width: item.size,
                height: item.size,
                animationDelay: `${index * -0.7}s`,
            }}
            data-ready="true"
        >
            <span className="travel-doodle__art" style={{ rotate: `${item.tilt}deg` }}>
                <Icon className="travel-doodle__icon doodle-breathe" style={{ animationDelay: `${index * -0.39}s` }} strokeWidth={1.7} />
                <span className="travel-doodle__spark" />
            </span>
        </span>
    );
}
