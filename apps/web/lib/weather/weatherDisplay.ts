import type { ContextStatus } from "@/types/api";

export type WeatherBadgeTone = "success" | "neutral" | "warning" | "danger" | "highlight";

const STATUS_LABELS: Record<ContextStatus, string> = {
  LIVE: "OpenWeather · live",
  CACHED: "OpenWeather · cached",
  STALE: "Weather may be out of date",
  MOCK: "Development mock",
  UNAVAILABLE: "Weather unavailable",
};

const STATUS_TONES: Record<ContextStatus, WeatherBadgeTone> = {
  LIVE: "success",
  CACHED: "neutral",
  STALE: "warning",
  MOCK: "highlight",
  UNAVAILABLE: "danger",
};

export function weatherStatusLabel(status: ContextStatus): string {
  return STATUS_LABELS[status];
}

export function weatherStatusTone(status: ContextStatus): WeatherBadgeTone {
  return STATUS_TONES[status];
}

export function formatWeatherValue(value: number | null, unit: string): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  const formatted = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return `${formatted}${unit}`;
}

export function formatWeatherTime(value: string | null, offsetSeconds?: number | null): string | null {
  if (!value) return null;
  const timestamp = new Date(value);
  const parsed = Number.isFinite(offsetSeconds)
    ? new Date(timestamp.getTime() + (offsetSeconds ?? 0) * 1000)
    : timestamp;
  if (Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(Number.isFinite(offsetSeconds) ? { timeZone: "UTC" } : {}),
  }).format(parsed);
}

export function formatWeatherOffset(offsetSeconds: number | null | undefined): string | null {
  if (offsetSeconds === null || offsetSeconds === undefined || !Number.isFinite(offsetSeconds)) return null;
  const sign = offsetSeconds < 0 ? "−" : "+";
  const totalMinutes = Math.floor(Math.abs(offsetSeconds) / 60);
  const hours = Math.floor(totalMinutes / 60).toString().padStart(2, "0");
  const minutes = (totalMinutes % 60).toString().padStart(2, "0");
  return `UTC${sign}${hours}:${minutes}`;
}

export function weatherConditionLabel(condition: string | null | undefined): string | null {
  if (!condition) return null;
  const labels: Record<string, string> = {
    clouds: "Cloudy",
    clear: "Clear",
    rain: "Rain",
    drizzle: "Drizzle",
    thunderstorm: "Thunderstorms",
    snow: "Snow",
    mist: "Mist",
    smoke: "Smoke",
    haze: "Haze",
    dust: "Dust",
    fog: "Fog",
    sand: "Sandstorm",
    ash: "Volcanic ash",
    squall: "Squall",
    tornado: "Tornado",
  };
  return labels[condition.toLowerCase()] ?? condition;
}
