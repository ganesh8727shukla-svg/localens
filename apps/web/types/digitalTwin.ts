export type ScenarioWeatherIntensity =
  | "clear"
  | "light_rain"
  | "moderate_rain"
  | "heavy_rain"
  | "severe_rain"
  | "high_temperature"
  | "extreme_heat"
  | "strong_wind"
  | "poor_visibility";

export interface WeatherScenarioOverride {
  intensity: ScenarioWeatherIntensity;
  starts_at: string;
  ends_at?: string | null;
}

export interface WhatIfScenarioRequest {
  name: string;
  description?: string | null;
  weather?: WeatherScenarioOverride | null;
  include_recent_social_context: boolean;
  social_context_item_id?: string | null;
  hypothetical_social?: {
    topic: "flooding" | "road_disruption" | "crowding" | "event_disruption" | "weather" | "heat" | "wind";
    severity: "low" | "moderate" | "high";
    around_item_id: string;
  } | null;
  route?: {
    kind: "road_disruption" | "temporary_closure" | "congestion" | "walking_condition";
    to_item_id: string;
    from_item_id?: string | null;
    assumed_delay_minutes?: number | null;
  } | null;
  experience_overrides: {
    item_id: string;
    condition: "unavailable" | "reduced_suitability" | "increased_crowding" | "contextual_risk";
  }[];
  horizon_hours: number;
}

export interface TwinWeatherEvidence {
  item_id: string;
  condition: string | null;
  temperature_c: number | null;
  precipitation_probability: number | null;
  precipitation_amount: number | null;
  wind_speed: number | null;
  visibility_km: number | null;
  severe_alert: boolean | null;
  status: "LIVE" | "CACHED" | "STALE" | "MOCK" | "UNAVAILABLE" | "HYPOTHETICAL";
  context_kind: "FORECAST" | "CURRENT" | "HYPOTHETICAL" | "UNKNOWN";
  observed_at: string | null;
  expires_at: string | null;
}

export interface TwinSocialEvidence {
  status: "NOT_REQUESTED" | "AVAILABLE" | "NO_SIGNALS" | "UNAVAILABLE" | "RATE_LIMITED" | "STALE" | "HYPOTHETICAL";
  queried_location: string | null;
  location_source?: "reverse_geocoder" | "catalog_record" | "unavailable" | null;
  generated_at: string | null;
  clusters: {
    topic: string;
    severity: string;
    signal_count: number | null;
    independent_source_count: number | null;
    newest_signal_at: string | null;
    source_platforms: string[];
    confidence: number | null;
    confidence_note: string | null;
    status: "REAL_AGGREGATE" | "HYPOTHETICAL";
    location_name: string | null;
  }[];
  message: string | null;
}

export interface TwinRouteEvidence {
  from_item_id: string;
  to_item_id: string;
  distance_km: number | null;
  duration_minutes: number | null;
  source: "osrm" | "haversine_estimate" | "unavailable";
  geometry: GeoJSON.LineString | null;
  scenario_status: "UNCHANGED" | "DELAY_ASSUMPTION" | "DISRUPTED" | "LIMITED" | "UNAVAILABLE";
  scenario_duration_minutes: number | null;
  delta_minutes: number | null;
  explanation: string | null;
  alternatives: {
    distance_km: number;
    duration_minutes: number;
    geometry: GeoJSON.LineString;
    source: "osrm";
  }[];
}

export interface TwinStop {
  item_id: string;
  experience_id: string | null;
  sequence: number;
  title: string;
  planned_start: string;
  planned_end: string;
  state: string;
  locked: boolean;
  latitude: number | null;
  longitude: number | null;
  environmental_type: string | null;
  weather_sensitivity: string | null;
  weather_policy: string | null;
  provider_verification_status: string | null;
  is_synthetic: boolean | null;
}

export interface TwinPlanState {
  stops: TwinStop[];
  weather: TwinWeatherEvidence[];
  current_weather: TwinWeatherEvidence[];
  social: TwinSocialEvidence;
  routes: TwinRouteEvidence[];
}

export interface SimulationImpact {
  category: "weather" | "social" | "experience" | "route" | "schedule" | "provider" | "accessibility" | "context";
  level: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "UNKNOWN";
  affected: boolean;
  item_id: string | null;
  reason_codes: string[];
  explanation: string;
  confidence: "LOW" | "MEDIUM" | "HIGH";
  evidence: string[];
  recommended_action: string | null;
}

export interface SimulationResult {
  simulation_id: string;
  status: "READY" | "PARTIAL" | "STALE" | "CONFLICT" | "UNAVAILABLE";
  created_at: string;
  expires_at: string;
  scenario_name: string;
  baseline: {
    snapshot_id: string;
    generated_at: string;
    timezone: string;
    itinerary_id: string;
    itinerary_version: number;
    itinerary_date: string;
    itinerary_status: string;
    traveler_context_available: boolean;
    plan: TwinPlanState;
  };
  scenario: TwinPlanState;
  delta: {
    affected_stop_count: number;
    unchanged_stop_count: number;
    affected_route_count: number;
    additional_travel_minutes: number | null;
    change_level: "NO_CHANGE" | "MINOR" | "MODERATE" | "MAJOR" | "CRITICAL" | "UNKNOWN";
    summary: string;
  };
  impacts: SimulationImpact[];
  alternatives: {
    for_item_id: string;
    experience_id: string;
    title: string;
    category: string;
    environmental_type: string;
    weather_suitability: "WEATHER_GOOD" | "WEATHER_CAUTION" | "WEATHER_UNSUITABLE" | "WEATHER_UNKNOWN";
    weather_status: "LIVE" | "CACHED" | "STALE" | "MOCK" | "UNAVAILABLE" | "HYPOTHETICAL";
    weather_condition: string | null;
    weather_temperature_c: number | null;
    weather_precipitation_probability: number | null;
    weather_precipitation_amount: number | null;
    weather_wind_speed: number | null;
    weather_at: string | null;
    ranking_score: number;
    is_synthetic: boolean;
  }[];
  warnings: string[];
  domain_intelligence: {
    provider: "mock" | "nugen";
    status: "LOCAL_PREVIEW" | "AVAILABLE" | "UNAVAILABLE";
    summary: string;
    notes: string[];
    impacts: string[];
    suitability_assessment: string | null;
    disruption_assessment: string | null;
    recommendation: string | null;
    uncertainty: string | null;
    reason_codes: string[];
    model_id: string | null;
    usage: Record<string, number | string> | null;
    confidence_score: number | null;
    finish_reason: string | null;
    confidence: "LOW" | "MEDIUM" | "HIGH";
  } | null;
  simulation_confidence_note: string;
}

export interface ReplanApplyResult {
  status: "NO_CHANGE" | "REPLANNED" | "REPLAN_FAILED" | "REQUIRES_USER_ACTION" | "CONFLICT";
  itinerary_id: string | null;
  previous_version: number | null;
  new_version: number | null;
  trigger: string | null;
  changes: {
    added_items: string[];
    removed_items: string[];
    moved_items: string[];
    unchanged_items: string[];
    affected_items: string[];
  };
  context_summary: string;
  validation_issues: string[];
  reason_code: string | null;
  message: string | null;
  generated_at: string | null;
}
