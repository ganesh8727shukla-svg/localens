"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Cloud, CloudLightning, CloudRain, CloudSun, Download, Droplets, RefreshCw, Sun, Wind } from "lucide-react";
import { getWeatherContext, getWeatherForecast } from "@/lib/api/context";
import { downloadJsonFile } from "@/lib/utils/downloadJson";
import { formatWeatherOffset, formatWeatherTime, formatWeatherValue, weatherConditionLabel, weatherStatusLabel, weatherStatusTone } from "@/lib/weather/weatherDisplay";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody } from "@/components/ui/Card";
import { Skeleton } from "@/components/ui/Skeleton";
import type { WeatherContextResponse, WeatherForecastEntry, WeatherTestScenario } from "@/types/api";

const SHOW_WEATHER_TEST_SCENARIOS = process.env.NODE_ENV !== "production";

interface WeatherCardProps {
  latitude: number | null;
  longitude: number | null;
  locationLabel: string;
}

function WeatherMetric({ icon, label, value }: { icon: ReactNode; label: string; value: string | null }) {
  if (!value) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
      {icon}<span>{label} {value}</span>
    </span>
  );
}

export function WeatherCard({ latitude, longitude, locationLabel }: WeatherCardProps) {
  const [result, setResult] = useState<{
    key: string;
    current: WeatherContextResponse | null;
    forecast: WeatherForecastEntry[];
    currentError: boolean;
    forecastError: boolean;
  } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [testScenario, setTestScenario] = useState<WeatherTestScenario | null>(null);
  const coordinatesAvailable = latitude !== null && longitude !== null
    && Number.isFinite(latitude) && Number.isFinite(longitude);
  const requestKey = `${latitude ?? ""}:${longitude ?? ""}:${refreshKey}:${testScenario ?? ""}`;
  const loading = coordinatesAvailable && result?.key !== requestKey;
  const current = result?.key === requestKey ? result.current : null;
  const forecast = result?.key === requestKey ? result.forecast : [];
  const currentError = result?.key === requestKey && result.currentError;
  const forecastError = result?.key === requestKey && result.forecastError;

  useEffect(() => {
    const controller = new AbortController();
    if (!coordinatesAvailable || latitude === null || longitude === null) {
      return () => controller.abort();
    }

    const currentRequest = testScenario
      ? getWeatherContext(latitude, longitude, controller.signal, testScenario)
      : getWeatherContext(latitude, longitude, controller.signal, undefined, refreshKey > 0);
    const forecastRequest = testScenario
      ? getWeatherForecast(latitude, longitude, 8, controller.signal, testScenario)
      : getWeatherForecast(latitude, longitude, 8, controller.signal, undefined, refreshKey > 0);
    void Promise.allSettled([currentRequest, forecastRequest]).then(([currentResult, forecastResult]) => {
      if (controller.signal.aborted) return;
      setResult({
        key: requestKey,
        current: currentResult.status === "fulfilled" ? currentResult.value : null,
        forecast: forecastResult.status === "fulfilled" ? forecastResult.value : [],
        currentError: currentResult.status === "rejected",
        forecastError: forecastResult.status === "rejected",
      });
    });

    return () => controller.abort();
  }, [coordinatesAvailable, latitude, longitude, refreshKey, requestKey, testScenario]);

  const updatedAt = current
    ? formatWeatherTime(current.fetched_at ?? current.last_updated_at, current.timezone_offset_seconds)
    : null;
  const currentUnavailable = currentError || current?.context_status === "UNAVAILABLE";
  const currentCondition = weatherConditionLabel(current?.condition);
  const WeatherIcon = currentCondition === "Clear" ? Sun
    : currentCondition === "Rain" || currentCondition === "Drizzle" ? CloudRain
      : currentCondition === "Thunderstorms" ? CloudLightning
        : currentCondition === "Cloudy" ? CloudSun : Cloud;
  const localOffset = formatWeatherOffset(current?.timezone_offset_seconds);

  return (
    <Card id="trip-weather" aria-busy={loading}>
      <CardBody className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">Trip weather</p>
            <h2 className="mt-1 text-base font-semibold text-ink">Weather near {locationLabel}</h2>
            <p className="mt-0.5 text-xs text-ink-muted">Based on this itinerary stop. LocaLens does not track your location.</p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {current ? (
              <Badge tone={weatherStatusTone(current.context_status)}>{weatherStatusLabel(current.context_status)}</Badge>
            ) : currentError ? (
              <Badge tone="danger">Weather unavailable</Badge>
            ) : null}
            {current || forecast.length ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => downloadJsonFile("localens-weather-context.json", {
                  schema: "localens.normalized-weather.v1",
                  location: { latitude, longitude, label: locationLabel },
                  current,
                  forecast,
                })}
                aria-label="Download normalized weather data as JSON"
              >
                <Download className="size-4" aria-hidden="true" />JSON
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Refresh weather"
              title="Refresh weather"
              onClick={() => setRefreshKey((key) => key + 1)}
              disabled={loading || !coordinatesAvailable}
            >
              <RefreshCw className="size-4" aria-hidden="true" />
            </Button>
          </div>
          {SHOW_WEATHER_TEST_SCENARIOS ? (
            <label className="flex flex-col gap-1 text-xs text-ink-muted">
              <span className="font-medium">Test inputs · development only</span>
              <select
                aria-label="Weather test scenario"
                className="h-9 rounded-lg border border-line-strong bg-surface px-2 text-xs text-ink"
                value={testScenario ?? ""}
                onChange={(event) => setTestScenario((event.target.value || null) as WeatherTestScenario | null)}
                disabled={!coordinatesAvailable || loading}
              >
                <option value="">Use configured weather source</option>
                <option value="SCENARIO_CLEAR">SCENARIO_CLEAR · Clear</option>
                <option value="SCENARIO_RAIN">SCENARIO_RAIN · Rain</option>
                <option value="SCENARIO_STORM">SCENARIO_STORM · Storm</option>
                <option value="SCENARIO_HEAT">SCENARIO_HEAT · Heat</option>
              </select>
            </label>
          ) : null}
        </div>

        {testScenario ? (
          <p className="rounded-xl bg-surface-sunken px-3.5 py-2.5 text-xs text-ink-muted" role="status">
            {testScenario} is a temporary test input returned as MOCK. It is not OpenWeather data and is not saved.
          </p>
        ) : null}

        {!coordinatesAvailable ? (
          <p className="rounded-xl bg-surface-sunken px-3.5 py-3 text-sm text-ink-muted" role="status">
            Weather is unavailable because this itinerary has no verified stop coordinates.
          </p>
        ) : loading ? (
          <div className="space-y-3" aria-label="Loading weather">
            <Skeleton className="h-12 w-40" />
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : (
          <>
            {currentUnavailable ? (
              <p className="rounded-xl bg-warning-soft px-3.5 py-3 text-sm text-warning" role="status">
                Current weather is unavailable right now. Refresh to try again.
              </p>
            ) : current ? (
              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] sm:items-center">
                <div className="flex items-center gap-3">
                  <WeatherIcon className="size-9 shrink-0 text-accent" aria-hidden="true" />
                  <div>
                    <p className="text-3xl font-semibold tracking-tight text-ink">
                      {formatWeatherValue(current.temperature_c, "°C") ?? "—"}
                    </p>
                    {currentCondition ? <p className="text-sm text-ink-muted">{currentCondition}</p> : null}
                    {current.feels_like_c !== null ? <p className="text-xs text-ink-subtle">Feels like {formatWeatherValue(current.feels_like_c, "°C")}</p> : null}
                  </div>
                </div>
                <div className="flex flex-wrap gap-x-5 gap-y-2">
                  <WeatherMetric icon={<Droplets className="size-3.5" aria-hidden="true" />} label="Humidity" value={formatWeatherValue(current.humidity, "%")} />
                  <WeatherMetric icon={<Wind className="size-3.5" aria-hidden="true" />} label="Wind" value={formatWeatherValue(current.wind_speed, " m/s")} />
                  <WeatherMetric icon={<CloudRain className="size-3.5" aria-hidden="true" />} label="Rain chance" value={formatWeatherValue(current.precipitation_probability, "%")} />
                  <WeatherMetric icon={<CloudRain className="size-3.5" aria-hidden="true" />} label="Precipitation" value={formatWeatherValue(current.precipitation_amount, " mm")} />
                  <WeatherMetric icon={<Cloud className="size-3.5" aria-hidden="true" />} label="Visibility" value={formatWeatherValue(current.visibility_km, " km")} />
                </div>
              </div>
            ) : (
              <p className="text-sm text-ink-muted" role="status">Weather could not be loaded. Refresh to try again.</p>
            )}

            {updatedAt ? (
              <p className="text-xs text-ink-subtle">
                {current?.context_status === "UNAVAILABLE" || currentError ? "Last checked" : "Provider fetched"} {updatedAt}{localOffset ? ` · ${localOffset}` : ""}
              </p>
            ) : null}
            {current?.context_status === "CACHED" ? <p className="text-xs text-ink-subtle">This is a previously fetched OpenWeather response. Use Refresh weather to request a fresh provider response.</p> : null}

            {current?.severe_alert ? (
              <p className="rounded-xl bg-danger-soft px-3.5 py-3 text-sm text-danger" role="alert">
                Severe weather is reported for this area. Review local conditions before travelling.
              </p>
            ) : null}

            <section className="space-y-2 border-t border-line pt-3" aria-label="Weather forecast">
              <h3 className="text-sm font-semibold text-ink">Upcoming 3-hour forecast</h3>
              {forecastError ? (
                <p className="text-xs text-ink-muted" role="status">Forecast is unavailable right now.</p>
              ) : forecast.length ? (
                <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {forecast.map((entry, index) => (
                    <li key={`${entry.forecast_at ?? "forecast"}-${index}`} className="rounded-xl bg-surface-sunken px-3 py-2.5">
                      <p className="text-xs font-medium text-ink-muted">{formatWeatherTime(entry.forecast_at, entry.timezone_offset_seconds) ?? "Forecast time unavailable"}</p>
                      {entry.temperature_c !== null ? <p className="mt-1 text-lg font-semibold text-ink">{formatWeatherValue(entry.temperature_c, "°C")}</p> : null}
                      {entry.condition ? <p className="text-xs text-ink-muted">{weatherConditionLabel(entry.condition)}</p> : null}
                      <p className="mt-1 text-xs leading-5 text-ink-subtle">
                        {[entry.feels_like_c !== null ? `Feels ${formatWeatherValue(entry.feels_like_c, "°C")}` : null,
                          entry.humidity !== null ? `Humidity ${formatWeatherValue(entry.humidity, "%")}` : null,
                          entry.wind_speed !== null ? `Wind ${formatWeatherValue(entry.wind_speed, " m/s")}` : null,
                          entry.precipitation_probability !== null ? `Rain ${formatWeatherValue(entry.precipitation_probability, "%")}` : null,
                          entry.precipitation_amount !== null ? `${formatWeatherValue(entry.precipitation_amount, " mm")} precip.` : null,
                          entry.visibility_km !== null ? `Visibility ${formatWeatherValue(entry.visibility_km, " km")}` : null]
                          .filter(Boolean).join(" · ") || "No additional measurements"}
                      </p>
                      <p className="mt-1 text-[10px] leading-4 text-ink-subtle">{weatherStatusLabel(entry.context_status)}{formatWeatherOffset(entry.timezone_offset_seconds) ? ` · ${formatWeatherOffset(entry.timezone_offset_seconds)}` : ""}</p>
                      {entry.severe_alert ? <p className="mt-1 text-xs font-medium text-danger">Severe alert</p> : null}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-xs text-ink-muted">No forecast entries were returned.</p>
              )}
            </section>
            {current ? (
              <details className="rounded-xl border border-line px-3.5 py-2.5 text-xs text-ink-muted">
                <summary className="cursor-pointer font-medium text-ink">Weather source and location details</summary>
                <dl className="mt-3 grid gap-x-5 gap-y-2 sm:grid-cols-2">
                  <div><dt className="font-medium text-ink">Coordinates</dt><dd>{current.latitude.toFixed(5)}, {current.longitude.toFixed(5)}</dd></div>
                  <div><dt className="font-medium text-ink">Provider timezone</dt><dd>{current.timezone ?? localOffset ?? "Not provided by provider"}</dd></div>
                  <div><dt className="font-medium text-ink">Provider status</dt><dd>{current.source} · {weatherStatusLabel(current.context_status)}</dd></div>
                  <div><dt className="font-medium text-ink">Weather code</dt><dd>{current.weather_code ?? "Not provided"}</dd></div>
                  <div><dt className="font-medium text-ink">Observed</dt><dd>{formatWeatherTime(current.observed_at, current.timezone_offset_seconds) ?? "Not provided"}</dd></div>
                  <div><dt className="font-medium text-ink">Last updated</dt><dd>{formatWeatherTime(current.last_updated_at, current.timezone_offset_seconds) ?? "Not provided"}</dd></div>
                  <div><dt className="font-medium text-ink">Last fetched</dt><dd>{formatWeatherTime(current.fetched_at, current.timezone_offset_seconds) ?? "Not provided"}</dd></div>
                  <div><dt className="font-medium text-ink">Data expires</dt><dd>{formatWeatherTime(current.expires_at, current.timezone_offset_seconds) ?? "Not provided"}</dd></div>
                </dl>
              </details>
            ) : null}
          </>
        )}
      </CardBody>
    </Card>
  );
}
