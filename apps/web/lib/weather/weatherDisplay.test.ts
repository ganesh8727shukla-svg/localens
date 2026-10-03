import { describe, expect, it } from "vitest";
import { formatWeatherOffset, formatWeatherTime, formatWeatherValue, weatherConditionLabel, weatherStatusLabel, weatherStatusTone } from "@/lib/weather/weatherDisplay";

describe("weather display helpers", () => {
  it.each([
    ["LIVE", "OpenWeather · live", "success"],
    ["CACHED", "OpenWeather · cached", "neutral"],
    ["STALE", "Weather may be out of date", "warning"],
    ["MOCK", "Development mock", "highlight"],
    ["UNAVAILABLE", "Weather unavailable", "danger"],
  ] as const)("labels %s context explicitly", (status, label, tone) => {
    expect(weatherStatusLabel(status)).toBe(label);
    expect(weatherStatusTone(status)).toBe(tone);
  });

  it("formats only finite measurements and valid timestamps", () => {
    expect(formatWeatherValue(27, "°C")).toBe("27°C");
    expect(formatWeatherValue(27.25, "%")).toBe("27.3%");
    expect(formatWeatherValue(null, "°C")).toBeNull();
    expect(formatWeatherValue(Number.NaN, "°C")).toBeNull();
    expect(formatWeatherTime(null)).toBeNull();
    expect(formatWeatherTime("invalid")).toBeNull();
    expect(formatWeatherTime("2026-09-27T09:00:00Z")).not.toBeNull();
    expect(formatWeatherTime("2026-09-27T09:00:00Z", 19_800)).toContain("2:30 PM");
    expect(formatWeatherOffset(19_800)).toBe("UTC+05:30");
    expect(weatherConditionLabel("Clouds")).toBe("Cloudy");
  });
});
