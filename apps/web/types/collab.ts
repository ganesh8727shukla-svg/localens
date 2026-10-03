import type { ApiExperienceSummary } from "@/types/api";

export interface CollabPreferences {
  category_slugs?: string[];
  budget_sensitivity?: string | null;
  preferred_duration_minutes?: number | null;
  interests: string[];
  food_preferences: string[];
  activities: string[];
  dislikes: string[];
  pace: "relaxed" | "balanced" | "packed" | null;
  crowd_preference: "low" | "medium" | "high" | null;
  walking_tolerance_km: number | null;
  age: number | null;
  budget_max: number | null;
  max_distance_km: number | null;
  accessibility_requirements: ("wheelchair_accessible" | "step_free")[];
}

export interface CollabMember {
  id: string;
  user_id: string;
  email: string;
  role: "owner" | "member";
  soft_preferences: Partial<CollabPreferences>;
  hard_constraints: Partial<CollabPreferences>;
}

export interface CollabGroup {
  id: string;
  owner_user_id: string;
  title: string;
  destination: string | null;
  itinerary_date: string | null;
  start_time: string | null;
  end_time: string | null;
  origin_latitude: number | null;
  origin_longitude: number | null;
  travel_mode: "driving" | "walking" | "cycling";
  invite_code: string;
  objectives: Record<string, unknown>;
  status: string;
  my_member_id: string;
  members: CollabMember[];
}

export interface CollabRecommendation {
  experience: ApiExperienceSummary;
  compatibility_score: number;
  group_objective_score: number;
  member_satisfaction: Record<string, number>;
  matched_preferences: string[];
  hard_constraint_status: "FEASIBLE" | "UNKNOWN";
  schedule_status: "VERIFIED" | "NEEDS_CONFIRMATION";
}

export interface CollabRecommendationResponse {
  items: CollabRecommendation[];
  excluded_count: number;
  candidate_count: number;
  warnings: string[];
}

export interface PreferenceAnalysis {
  common: Record<string, string[]>;
  flexible: Record<string, string[]>;
  conflicts: Record<string, Record<string, number>>;
  group_direction: Record<string, string>;
  warnings: string[];
}

export interface CollabReaction {
  member_id: string;
  email: string;
  reaction: "like" | "maybe" | "dislike";
}

export interface CollabWishlistItem {
  id: string;
  experience: ApiExperienceSummary;
  added_by_member_id: string | null;
  reactions: CollabReaction[];
  my_reaction: "like" | "maybe" | "dislike" | null;
}

export interface CollabDecisionOption {
  id: string;
  label: string;
  experience_id: string | null;
  vote_count: number;
}

export interface CollabDecision {
  id: string;
  title: string;
  status: "OPEN" | "CLOSED";
  options: CollabDecisionOption[];
  votes: { member_id: string; email: string; option_id: string }[];
}

export interface CollabPlanItem {
  id: string;
  experience: ApiExperienceSummary;
  experience_id: string;
  sequence_order: number;
  is_optional: boolean;
}

export interface CollabApproval {
  member_id: string;
  email: string;
  status: "PENDING" | "APPROVED" | "REVISION_REQUESTED";
  note: string | null;
}

export interface CollabPlan {
  id: string;
  title: string;
  status: "DRAFT" | "REVIEW" | "FINALIZED";
  version: number;
  items: CollabPlanItem[];
  approvals: CollabApproval[];
  trip_ids: string[];
  trips: { user_id: string; itinerary_id: string }[];
}

export interface CollabProfilePayload {
  interests: string[];
  food_preferences: string[];
  activities: string[];
  dislikes: string[];
  pace: "relaxed" | "balanced" | "packed" | null;
  crowd_preference: "low" | "medium" | "high" | null;
  walking_tolerance_km: number | null;
  age: number | null;
  budget_max: number | null;
  max_distance_km: number | null;
  accessibility_requirements: ("wheelchair_accessible" | "step_free")[];
}
