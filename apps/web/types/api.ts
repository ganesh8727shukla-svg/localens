/** Shapes returned by the FastAPI experience endpoints. Mirrors
 * apps/api/src/schemas/experience.py — keep in sync. */

export interface ApiCategorySummary {
  id: string;
  slug: string;
  name: string;
  icon: string | null;
}

export interface ApiLocationSummary {
  id: string;
  latitude: number;
  longitude: number;
  place_name: string | null;
  address: string | null;
  locality: string | null;
  city: string;
  state: string | null;
  country: string | null;
}

export interface ApiProviderSummary {
  id: string;
  business_name: string;
  provider_type: string | null;
  verification_status: string;
  is_synthetic: boolean;
}

export interface ApiOpeningHourWindow {
  day_of_week: number;
  open_time: string | null;
  close_time: string | null;
  is_closed: boolean;
  is_synthetic?: boolean;
}

export interface ApiAvailabilitySlotSummary {
  id: string;
  start_time: string;
  end_time: string;
  capacity: number;
  booked_count: number;
  is_available: boolean;
  is_synthetic: boolean;
}

export interface ApiExperienceReviewSummary {
  id: string;
  rating_value: number;
  title: string | null;
  body: string | null;
  author_display_name: string;
  reviewed_at: string;
  is_synthetic: boolean;
}

export interface ApiRatingSummary {
  average_rating: number;
  review_count: number;
  rating_distribution: Record<string, number>;
  is_synthetic: boolean;
}

export interface ApiExperienceReviewListResponse {
  items: ApiExperienceReviewSummary[];
  total: number;
  limit: number;
  offset: number;
}

/** Normalized image metadata (see apps/api/src/services/experience_images.py).
 * `url` is null when no suitable image has been resolved — the frontend
 * falls back to its own generic category art, never a fabricated photo. */
export interface ApiExperienceImage {
  url: string | null;
  thumbnail_url: string | null;
  source: string | null;
  source_url: string | null;
  license: string | null;
  license_url: string | null;
  author: string | null;
  attribution_text: string | null;
  is_place_specific: boolean | null;
  is_synthetic: boolean | null;
  match_method: string | null;
}

export interface ApiExperienceSummary {
  id: string;
  title: string;
  short_description: string;
  category: ApiCategorySummary;
  location: ApiLocationSummary;
  provider: ApiProviderSummary;
  currency: string;
  price: number | null;
  minimum_price: number | null;
  maximum_price: number | null;
  price_type: string;
  is_price_estimated: boolean;
  duration_minutes: number | null;
  duration_is_estimated: boolean;
  rating: number | null;
  rating_source?: string | null;
  review_count: number | null;
  status: string;
  verification_status: string;
  is_synthetic: boolean;
  is_enriched: boolean;
  image: ApiExperienceImage | null;
  /** Straight-line distance from the query's lat/lng — null unless a
   * location-aware search was made. Never travel time. */
  distance_km: number | null;
  /** Only populated for the current result page when travel-time
   * enrichment succeeded (see apps/api/src/api/v1/experiences.py). */
  travel_time_minutes: number | null;
  travel_time_source: "osrm" | "haversine_estimate" | null;
}

export interface ApiOvertureSourceRecord {
  source_record_id: string;
  source_place_record_id: string | null;
  source_name: string;
  source_license: string;
  source_version: string;
  source_url: string;
  source_confidence: number | null;
  name: string;
  overture_category: string | null;
  operating_status: string | null;
  latitude: number;
  longitude: number;
  address: string | null;
  locality: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
}

export interface ApiOverturePlaceDatasetRecord {
  source_record: ApiOvertureSourceRecord;
  localens_enrichment: {
    normalized_name: string;
    category_slug: string;
    estimated_duration_minutes: number | null;
    estimated_price_low: number | null;
    estimated_price_high: number | null;
  };
}

export interface ApiOverturePlaceDatasetResponse {
  source: string;
  snapshot_version: string;
  is_live: false;
  record_count: number;
  synthetic_records_included: false;
  attribution_note: string;
  records: ApiOverturePlaceDatasetRecord[];
}

export interface ApiExperienceDetail extends ApiExperienceSummary {
  full_description: string;
  minimum_group_size: number | null;
  maximum_group_size: number | null;
  capacity: number | null;
  wheelchair_accessible: boolean | null;
  step_free: boolean | null;
  accessibility_notes: string | null;
  suitability: string[] | null;
  tags: string[] | null;
  opening_hours_status: string;
  opening_hours: ApiOpeningHourWindow[];
  availability_slots?: ApiAvailabilitySlotSummary[];
  rating_summary?: ApiRatingSummary | null;
  reviews?: ApiExperienceReviewSummary[];
  source_type: string;
  source_name: string | null;
  source_license: string | null;
  attribution_required: boolean;
  attribution_text: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApiExperienceListResponse {
  items: ApiExperienceSummary[];
  total: number;
  limit: number;
  offset: number;
}

export type DiscoverySort = "relevance" | "distance" | "price" | "duration" | "newest";

export interface ExperienceListFilters {
  q?: string;
  category?: string;
  city?: string;
  locality?: string;
  provider?: string;
  min_price?: number;
  max_price?: number;
  min_duration_minutes?: number;
  max_duration_minutes?: number;
  source_type?: string;
  is_synthetic?: boolean;
  status?: string;
  lat?: number;
  lng?: number;
  radius_km?: number;
  sort?: DiscoverySort;
  limit?: number;
  offset?: number;
}

/* ─── Phase 6: semantic search + deterministic feasibility ────────────────
 * Mirrors apps/api/src/schemas/feasibility.py and
 * apps/api/src/schemas/semantic_search.py — keep in sync. */

export type FeasibilityStatus = "FEASIBLE" | "INFEASIBLE" | "UNKNOWN";

/** Every reason code FeasibilityService can emit — mirrors
 * apps/api/src/core/feasibility_reasons.py exactly. */
export type FeasibilityReasonCode =
  | "EXPERIENCE_INACTIVE"
  | "MISSING_LOCATION"
  | "BUDGET_EXCEEDED"
  | "PRICE_UNAVAILABLE"
  | "UNSUPPORTED_CURRENCY"
  | "DURATION_EXCEEDED"
  | "DURATION_UNAVAILABLE"
  | "OUTSIDE_AVAILABLE_TIME"
  | "OPENING_HOURS_CONFLICT"
  | "OPENING_HOURS_UNAVAILABLE"
  | "TRAVEL_TIME_EXCEEDED"
  | "TRAVEL_TIME_UNAVAILABLE"
  | "MAX_DISTANCE_EXCEEDED"
  | "GROUP_SIZE_EXCEEDS_CAPACITY"
  | "CAPACITY_UNAVAILABLE"
  | "ACCESSIBILITY_NOT_SUPPORTED"
  | "ACCESSIBILITY_DATA_UNAVAILABLE"
  | "AVAILABILITY_CONFLICT"
  | "AVAILABILITY_UNAVAILABLE"
  | "ITINERARY_CONFLICT"
  | "MISSING_TIME_CONTEXT"
  | "MISSING_ORIGIN"
  | "ROUTE_UNAVAILABLE";

export interface FeasibilityEvidence {
  [key: string]: unknown;
}

export interface FeasibilityReason {
  code: FeasibilityReasonCode;
  constraint: string;
  message: string;
  blocking: boolean;
  evidence: FeasibilityEvidence;
}

export interface FeasibilityVerdict {
  experience_id: string;
  status: FeasibilityStatus;
  reasons: FeasibilityReason[];
  checked_at: string;
  evidence: FeasibilityEvidence;
}

export interface CommittedTimeBlock {
  start: string;
  end: string;
}

export interface TravelerConstraints {
  currency?: string;
  budget_min?: number | null;
  budget_max?: number | null;
  available_date?: string | null;
  available_start?: string | null;
  available_end?: string | null;
  available_duration_minutes?: number | null;
  timezone?: string | null;
  origin_lat?: number | null;
  origin_lng?: number | null;
  travel_mode?: "driving" | "walking" | "cycling" | null;
  max_distance_km?: number | null;
  max_travel_time_minutes?: number | null;
  party_size?: number | null;
  accessibility_requirements?: ("wheelchair_accessible" | "step_free")[];
  existing_commitments?: CommittedTimeBlock[];
}

export interface FeasibilityCheckRequest {
  experience_id: string;
  constraints?: TravelerConstraints;
}

/** Always honestly reported — never claims pgvector/semantic retrieval
 * happened when it fell back to keyword search. */
export type RetrievalMode = "pgvector_semantic" | "sqlite_python_semantic" | "keyword_fallback";

export interface SemanticSearchRequest {
  query?: string;
  interests?: string[];
  category_slug?: string;
  city?: string;
  locality?: string;
  location_text?: string;
  constraints?: TravelerConstraints;
  limit?: number;
}

export interface SemanticSearchItem {
  experience: ApiExperienceSummary;
  semantic_similarity: number | null;
}

export interface ExcludedReasonSummary {
  reason_counts: Record<string, number>;
  sample: { experience_id: string; status: FeasibilityStatus; reasons: string[] }[];
}

export interface SemanticSearchResponse {
  items: SemanticSearchItem[];
  retrieval_mode: RetrievalMode;
  candidate_count: number;
  feasible_count: number;
  excluded_count: number;
  excluded_summary: ExcludedReasonSummary;
}

// === Phase 7 (Ranking & Feedback) ===

export interface ApiRankedExperienceItem extends ApiExperienceSummary {
  rank: number;
  ranking_score: number;
  ranking_model_version: string;
  semantic_relevance: number;
  personalized: boolean;
  match_signals: string[];
}

export interface RecommendationRequest {
  query?: string | null;
  interests?: string[];
  constraints?: TravelerConstraints;
  top_k?: number;
}

export interface RecommendationResponse {
  items: ApiRankedExperienceItem[];
  retrieval_mode: string;
  candidate_count: number;
  feasible_count: number;
  excluded_count: number;
  excluded_summary: ExcludedReasonSummary;
  ranking_model_version: string;
  personalized: boolean;
}

export type InteractionEventType = "IMPRESSION" | "VIEW" | "SAVE" | "UNSAVE" | "COMPLETE" | "SKIP" | "RATING";

export interface RecordInteractionRequest {
  experience_id: string;
  event_type: InteractionEventType;
  rating?: number | null;
  client_event_id: string;
  rank_position?: number | null;
  recommendation_session_id?: string | null;
  occurred_at?: string | null;
  source?: string | null;
}

export interface RecordInteractionResponse {
  interaction_id: string;
  created: boolean;
  idempotent: boolean;
}

export interface TravelerAffinitySummary {
  dimension_type: string;
  dimension_key: string;
  score: number;
  confidence: number;
  interaction_count: number;
}

export interface AffinityProfileResponse {
  traveler_id: string;
  affinities: TravelerAffinitySummary[];
  personalized_since?: string | null;
}

export interface UpdatePreferenceRequest {
  preferred_category_slugs?: string[] | null;
  budget_sensitivity?: string | null;
  preferred_duration_minutes?: number | null;
  preferred_max_distance_km?: number | null;
  accessibility_requirements?: string[] | null;
}

export interface TravelerPreferenceResponse extends UpdatePreferenceRequest {
  id: string;
  traveler_id: string;
}

/** Phase 8 — itinerary composition + booking. Mirrors
 * apps/api/src/schemas/itinerary.py and src/schemas/booking.py. */

export type ItineraryStatus = "DRAFT" | "VALIDATED" | "BOOKING_REQUESTED" | "COMPLETED" | "CANCELLED";
export type ItinerarySource = "COMPOSER" | "MANUAL";
export type CompositionPace = "relaxed" | "balanced" | "packed";
export type TravelMode = "driving" | "walking" | "cycling";

export interface ComposeItineraryRequest {
  query?: string | null;
  /** Optional selected canonical experience IDs; omission preserves search-based composition. */
  experience_ids?: string[];
  custom_activities?: CustomActivityRequest[];
  interests?: string[];
  category_slugs?: string[];
  itinerary_date: string; // YYYY-MM-DD
  start_time: string; // HH:MM:SS
  end_time: string; // HH:MM:SS
  max_experiences?: number | null;
  max_budget?: number | null;
  pace?: CompositionPace;
  origin_lat?: number | null;
  origin_lng?: number | null;
  travel_mode?: TravelMode;
  party_size?: number | null;
  accessibility_requirements?: string[];
  city?: string | null;
  locality?: string | null;
}

export interface CustomActivityRequest {
  client_id?: string | null;
  title: string;
  kind: "place" | "activity" | "note";
  note?: string | null;
  location_text?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  start_time: string;
  duration_minutes: number;
  estimated_cost?: number | null;
}

export interface PreviewItineraryItem {
  experience_id: string | null;
  client_id: string | null;
  title: string;
  kind: "place" | "activity" | "note";
  planned_start: string;
  planned_end: string;
  duration_minutes: number;
  travel_from_previous_minutes: number | null;
  travel_from_previous_distance_km: number | null;
  travel_time_source: "osrm" | "haversine_estimate" | null;
  estimated_cost: number | null;
}

export interface ItineraryPreviewResponse {
  valid: boolean;
  experience_ids: string[];
  items: PreviewItineraryItem[];
  visit_minutes: number;
  travel_minutes: number | null;
  total_minutes: number | null;
  estimated_total_cost: number | null;
  has_estimated_cost: boolean;
  travel_time_source: "osrm" | "haversine_estimate" | null;
  issues: CompositionValidationIssue[];
  demo_schedule_used?: boolean;
}

export interface PreviewIdeasRequest {
  base: ComposeItineraryRequest;
  plans: string[][];
}

export interface ItineraryCustomActivity {
  id: string;
  sequence_order: number;
  title: string;
  kind: "place" | "activity" | "note";
  note: string | null;
  location_text: string | null;
  latitude: number | null;
  longitude: number | null;
  planned_start: string;
  planned_end: string;
  duration_minutes: number;
  estimated_cost: number | null;
}

export interface ApiItineraryItem {
  id: string;
  experience_id: string;
  sequence_order: number;
  planned_start: string;
  planned_end: string;
  duration_minutes: number;
  travel_from_previous_minutes: number | null;
  travel_from_previous_distance_km: number | null;
  travel_mode: string | null;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  estimated_cost: number | null;
  source_rank_position: number | null;
  source_ranking_score: number | null;
  narrative_text: string | null;
  title: string | null;
  short_description: string | null;
  category_name: string | null;
  location_place_name: string | null;
  location_locality?: string | null;
  location_city?: string | null;
  location_latitude: number | null;
  location_longitude: number | null;
  opening_hours_status_at_visit?: "open" | "closed" | "unknown";
  opening_hours_for_visit?: ApiOpeningHourWindow[];
  nearby_open_alternatives?: {
    experience_id: string;
    title: string;
    category_name: string;
    locality: string | null;
    city: string;
    distance_km: number;
    opening_hours_for_visit: ApiOpeningHourWindow[];
    is_synthetic: boolean;
  }[];
  availability_data_is_synthetic?: boolean;
  /** Phase 9 — never auto-replaced by the replanner when true. */
  is_locked: boolean;
  /** Phase 9 — ACTIVE | AFFECTED | INVALIDATED | CANCELLED. */
  item_state: string;
}

export interface ApiItinerary {
  id: string;
  traveler_id: string;
  title: string;
  itinerary_date: string;
  start_time: string;
  end_time: string;
  status: ItineraryStatus;
  source: ItinerarySource;
  total_duration_minutes: number | null;
  total_travel_minutes: number | null;
  estimated_total_cost: number | null;
  max_budget?: number | null;
  currency: string;
  narrative_title: string | null;
  narrative_summary: string | null;
  narrative_closing_message: string | null;
  ranking_model_version: string | null;
  narrative_model_version: string | null;
  generated_at: string | null;
  created_at: string;
  updated_at: string;
  items: ApiItineraryItem[];
  custom_activities?: ItineraryCustomActivity[];
  /** Phase 9 — optimistic-locking counter; supply as expected_version on replan. */
  version: number;
  /** Phase 9 — STABLE | REPLANNING | REQUIRES_USER_ACTION. */
  replanning_status: string;
  /** Phase 9 — last time context (weather/events) was checked for this itinerary. */
  context_last_updated_at: string | null;
}

export interface ItineraryListResponse {
  items: ApiItinerary[];
  total: number;
}

export interface CompositionValidationIssue {
  code: string;
  constraint: string;
  message: string;
  evidence: Record<string, unknown>;
}

export interface CompositionValidationResponse {
  valid: false;
  reason_code: string;
  message: string;
  issues: CompositionValidationIssue[];
  candidate_count: number;
  feasible_count: number;
}

export type ComposeItineraryResult = ApiItinerary | CompositionValidationResponse;

export function isCompositionFailure(result: ComposeItineraryResult): result is CompositionValidationResponse {
  return (result as CompositionValidationResponse).valid === false;
}

export interface AddItineraryItemRequest {
  experience_id: string;
  planned_start?: string | null;
  travel_mode?: TravelMode;
}

export type BookingStatus = "REQUESTED" | "ACCEPTED" | "DECLINED" | "CANCELLED" | "EXPIRED";

export interface BookingRequestCreate {
  itinerary_item_id: string;
  party_size?: number;
  traveler_note?: string | null;
}

export interface ApiBookingRequest {
  id: string;
  traveler_id: string;
  itinerary_id: string;
  itinerary_item_id: string;
  experience_id: string;
  provider_id: string;
  requested_start: string;
  requested_end: string;
  party_size: number;
  traveler_note: string | null;
  status: BookingStatus;
  requested_at: string;
  responded_at: string | null;
  provider_note: string | null;
  created_at: string;
  updated_at: string;
  experience_title: string | null;
}

export interface BookingRequestListResponse {
  items: ApiBookingRequest[];
  total: number;
}

export interface BookingStatusUpdate {
  status: "ACCEPTED" | "DECLINED";
  provider_note?: string | null;
}

// ─── Phase 9: real-time context + dynamic replanning ──────────────────────

export type ReplanTrigger =
  | "USER_REQUESTED"
  | "TIME_CHANGED"
  | "BUDGET_CHANGED"
  | "PARTY_SIZE_CHANGED"
  | "WEATHER_CHANGED"
  | "EVENT_CANCELLED"
  | "EVENT_RESCHEDULED"
  | "EVENT_VENUE_CHANGED"
  | "AVAILABILITY_CHANGED";

export type ReplanStatus = "NO_CHANGE" | "REPLANNED" | "REPLAN_FAILED" | "REQUIRES_USER_ACTION" | "CONFLICT";

export interface ReplanRequest {
  expected_version?: number | null;
  idempotency_key?: string | null;
  reason?: string | null;
  trigger?: ReplanTrigger;
  new_start_time?: string | null;
  new_end_time?: string | null;
  new_max_budget?: number | null;
  new_party_size?: number | null;
}

export interface ReplanChangeSet {
  added_items: string[];
  removed_items: string[];
  moved_items: string[];
  unchanged_items: string[];
  affected_items: string[];
}

export interface ReplanResponse {
  status: ReplanStatus;
  itinerary_id: string | null;
  previous_version: number | null;
  new_version: number | null;
  trigger: string | null;
  changes: ReplanChangeSet;
  context_summary: string;
  validation_issues: string[];
  reason_code: string | null;
  message: string | null;
  generated_at: string | null;
}

export type ContextStatus = "LIVE" | "CACHED" | "STALE" | "UNAVAILABLE" | "MOCK";
export type WeatherSource = "LIVE" | "CACHED" | "MOCK" | "UNAVAILABLE";
export type WeatherTestScenario = "SCENARIO_CLEAR" | "SCENARIO_RAIN" | "SCENARIO_STORM" | "SCENARIO_HEAT";

export interface WeatherContextResponse {
  latitude: number;
  longitude: number;
  observed_at: string | null;
  timezone: string | null;
  timezone_offset_seconds: number | null;
  temperature_c: number | null;
  feels_like_c: number | null;
  humidity: number | null;
  wind_speed: number | null;
  precipitation_probability: number | null;
  precipitation_amount: number | null;
  weather_code: number | null;
  condition: string | null;
  visibility_km: number | null;
  severe_alert: boolean;
  source: WeatherSource;
  context_status: ContextStatus;
  last_updated_at: string;
  fetched_at: string;
  expires_at: string;
}

export interface WeatherForecastEntry {
  latitude: number;
  longitude: number;
  forecast_at: string | null;
  timezone: string | null;
  timezone_offset_seconds: number | null;
  temperature_c: number | null;
  feels_like_c: number | null;
  humidity: number | null;
  wind_speed: number | null;
  precipitation_probability: number | null;
  precipitation_amount: number | null;
  weather_code: number | null;
  condition: string | null;
  visibility_km: number | null;
  severe_alert: boolean;
  source: WeatherSource;
  context_status: ContextStatus;
  fetched_at: string;
  expires_at: string;
}

export interface ItineraryWeatherAdvisory {
  item_id: string;
  title: string;
  planned_start: string;
  planned_end: string;
  latitude: number | null;
  longitude: number | null;
  forecast_at: string | null;
  checked_at: string;
  check_basis: "PLANNED_FORECAST" | "NEAR_TIME_CURRENT" | "CURRENT_AT_LOCATION" | "UNAVAILABLE";
  status: "GOOD" | "CAUTION" | "UNSUITABLE" | "UNKNOWN" | "CURRENT";
  source: WeatherSource;
  condition: string | null;
  temperature_c: number | null;
  precipitation_probability: number | null;
  precipitation_amount: number | null;
  wind_speed: number | null;
  severe_alert: boolean | null;
  reasons: string[];
  message: string;
}

export interface ItineraryWeatherResponse {
  itinerary_id: string;
  generated_at: string;
  advisories: ItineraryWeatherAdvisory[];
}

export type EventStatus = "SCHEDULED" | "RESCHEDULED" | "CANCELLED" | "POSTPONED" | "UNKNOWN";

export interface EventResponse {
  id: string;
  source: string;
  name: string;
  description: string | null;
  starts_at: string | null;
  ends_at: string | null;
  status: EventStatus;
  venue_name: string | null;
  venue_address: string | null;
  latitude: number | null;
  longitude: number | null;
  category: string | null;
  image_url: string | null;
  purchase_url: string | null;
  is_synthetic: boolean;
  fetched_at: string;
}

/** Normalized SSE event types the backend publishes on
 * /api/v1/itineraries/{id}/updates. The frontend only ever renders these
 * — it never computes replanning, weather impact, or reordering itself. */
export type ItineraryUpdateEventType =
  | "connected"
  | "context_update"
  | "replan_started"
  | "replan_completed"
  | "replan_failed"
  | "requires_action"
  | "booking_status_update"
  | "heartbeat";

export interface ItineraryUpdateEvent {
  type: ItineraryUpdateEventType;
  id: number;
  data: Record<string, unknown>;
}
