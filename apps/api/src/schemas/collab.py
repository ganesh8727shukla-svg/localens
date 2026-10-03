from __future__ import annotations

from datetime import date, time
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from src.schemas.experience import ExperienceSummary


class CollabGroupCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=2, max_length=160)
    destination: str | None = Field(default=None, max_length=120)
    itinerary_date: date | None = None
    start_time: time | None = None
    end_time: time | None = None
    origin_latitude: float | None = Field(default=None, ge=-90, le=90)
    origin_longitude: float | None = Field(default=None, ge=-180, le=180)
    travel_mode: Literal["driving", "walking", "cycling"] = "walking"
    objectives: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_schedule(self) -> CollabGroupCreate:
        if (self.start_time is None) != (self.end_time is None):
            raise ValueError("start_time and end_time must be provided together")
        if self.start_time is not None and self.end_time is not None and self.end_time <= self.start_time:
            raise ValueError("end_time must be after start_time")
        if (self.origin_latitude is None) != (self.origin_longitude is None):
            raise ValueError("origin latitude and longitude must be provided together")
        return self


class CollabGroupUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=2, max_length=160)
    destination: str | None = Field(default=None, max_length=120)
    itinerary_date: date | None = None
    start_time: time | None = None
    end_time: time | None = None
    origin_latitude: float | None = Field(default=None, ge=-90, le=90)
    origin_longitude: float | None = Field(default=None, ge=-180, le=180)
    travel_mode: Literal["driving", "walking", "cycling"] | None = None
    objectives: dict[str, Any] | None = None


class CollabJoinRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    invite_code: str = Field(min_length=8, max_length=48)


class CollabPreferencesUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    interests: list[str] = Field(default_factory=list, max_length=30)
    food_preferences: list[str] = Field(default_factory=list, max_length=20)
    activities: list[str] = Field(default_factory=list, max_length=30)
    dislikes: list[str] = Field(default_factory=list, max_length=30)
    pace: Literal["relaxed", "balanced", "packed"] | None = None
    crowd_preference: Literal["low", "medium", "high"] | None = None
    walking_tolerance_km: float | None = Field(default=None, ge=0, le=100)
    age: int | None = Field(default=None, ge=0, le=120)
    budget_max: float | None = Field(default=None, ge=0)
    max_distance_km: float | None = Field(default=None, gt=0, le=1000)
    accessibility_requirements: list[Literal["wheelchair_accessible", "step_free"]] = Field(
        default_factory=list, max_length=2
    )


class CollabMemberResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    user_id: str
    email: str
    role: Literal["owner", "member"]
    soft_preferences: dict[str, Any]
    hard_constraints: dict[str, Any]


class CollabGroupResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    owner_user_id: str
    title: str
    destination: str | None
    itinerary_date: date | None
    start_time: time | None
    end_time: time | None
    origin_latitude: float | None
    origin_longitude: float | None
    travel_mode: str
    invite_code: str
    objectives: dict[str, Any]
    status: str
    my_member_id: str
    members: list[CollabMemberResponse]


class PreferenceAnalysisResponse(BaseModel):
    common: dict[str, list[str]]
    flexible: dict[str, list[str]]
    conflicts: dict[str, dict[str, int]]
    group_direction: dict[str, str] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)


class CollabRecommendation(BaseModel):
    experience: ExperienceSummary
    compatibility_score: float
    group_objective_score: float
    member_satisfaction: dict[str, float]
    matched_preferences: list[str]
    # UNKNOWN options can still help a group shortlist a place, but the UI
    # must not present them as a confirmed bookable stop.
    hard_constraint_status: Literal["FEASIBLE", "UNKNOWN"] = "FEASIBLE"
    schedule_status: Literal["VERIFIED", "NEEDS_CONFIRMATION"] = "NEEDS_CONFIRMATION"


class CollabRecommendationResponse(BaseModel):
    items: list[CollabRecommendation]
    excluded_count: int
    candidate_count: int
    warnings: list[str] = Field(default_factory=list)


class CollabReactionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reaction: Literal["like", "maybe", "dislike"]


class CollabWishlistAddRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    experience_id: str


class DecisionOptionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    experience_id: str | None = None
    label: str = Field(min_length=1, max_length=200)


class CollabDecisionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=3, max_length=200)
    options: list[DecisionOptionInput] = Field(min_length=2, max_length=12)


class CollabVoteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    option_id: str


class CollabItineraryItemInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    experience_id: str
    is_optional: bool = False


class CollabItineraryUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=2, max_length=200)
    items: list[CollabItineraryItemInput] = Field(min_length=1, max_length=20)


class CollabItineraryApprovalUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Literal["APPROVED", "REVISION_REQUESTED"]
    note: str | None = Field(default=None, max_length=500)


__all__ = [
    "CollabDecisionCreate", "CollabGroupCreate", "CollabGroupResponse", "CollabGroupUpdate",
    "CollabItineraryApprovalUpdate", "CollabItineraryUpdate", "CollabJoinRequest",
    "CollabMemberResponse", "CollabPreferencesUpdate", "CollabReactionRequest",
    "CollabRecommendation", "CollabRecommendationResponse", "CollabVoteRequest",
    "CollabWishlistAddRequest", "DecisionOptionInput", "PreferenceAnalysisResponse",
]
