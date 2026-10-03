"""Bluesky public-post adapter for privacy-preserving social context.

The provider payload is consumed only in this module. Individual post text,
author handles, DIDs, and record URIs are never returned from the adapter.
Only normalized, short-lived signals are passed to the aggregation service.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, Protocol

import httpx
from pydantic import BaseModel, ConfigDict, Field

from src.core.config import Settings
from src.core.http_client import get_http_client
from src.core.rate_limit import IntervalRateLimiter


class SocialTopic(StrEnum):
    WEATHER = "weather"
    FLOODING = "flooding"
    ROAD_DISRUPTION = "road_disruption"
    CROWDING = "crowding"
    EVENT_DISRUPTION = "event_disruption"
    HEAT = "heat"
    WIND = "wind"


class SocialSeverity(StrEnum):
    LOW = "low"
    MODERATE = "moderate"
    HIGH = "high"


class NormalizedSocialSignal(BaseModel):
    """Internal normalized record; deliberately contains no source text or URL."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    deduplication_key: str = Field(min_length=16, max_length=64)
    source_fingerprint: str = Field(min_length=16, max_length=64)
    source_platform: str = "bluesky"
    topic: SocialTopic
    severity: SocialSeverity
    occurred_at: datetime
    classification_confidence: float = Field(ge=0, le=1)


@dataclass(frozen=True)
class SocialClassification:
    topic: SocialTopic
    severity: SocialSeverity
    confidence: float


class SocialSignalInterpreter(Protocol):
    def interpret(self, text: str) -> SocialClassification | None: ...


class KeywordSocialSignalInterpreter:
    """Deterministic baseline classifier; output is advisory, never a decision."""

    _RULES: tuple[tuple[SocialTopic, tuple[str, ...], tuple[str, ...]], ...] = (
        (
            SocialTopic.FLOODING,
            ("flooded", "flooding", "waterlogged", "waterlogging", "inundated"),
            ("flood", "water log"),
        ),
        (
            SocialTopic.ROAD_DISRUPTION,
            ("road closed", "road closure", "road blocked", "bridge closed", "traffic jam"),
            ("traffic", "diversion", "accident", "blocked road"),
        ),
        (
            SocialTopic.CROWDING,
            ("overcrowded", "crush", "stampede", "packed venue"),
            ("crowded", "crowd", "long queue", "long line"),
        ),
        (
            SocialTopic.EVENT_DISRUPTION,
            ("event cancelled", "event canceled", "show cancelled", "show canceled", "event postponed"),
            ("cancelled", "canceled", "postponed", "strike", "protest", "disruption"),
        ),
        (SocialTopic.HEAT, ("heatwave", "heat wave", "extreme heat"), ("very hot", "too hot", "heat")),
        (
            SocialTopic.WIND,
            ("cyclone", "hurricane", "tornado", "storm surge"),
            ("strong winds", "high wind", "windstorm", "storm"),
        ),
        (
            SocialTopic.WEATHER,
            ("heavy rain", "thunderstorm", "hailstorm", "severe weather"),
            ("rain", "rainfall", "showers", "weather"),
        ),
    )
    _HIGH_SEVERITY = ("stranded", "evacuate", "evacuation", "road closed", "flooded", "stampede", "injured")

    def interpret(self, text: str) -> SocialClassification | None:
        normalized = " ".join(text.casefold().split())
        candidates: list[tuple[int, int, int, SocialTopic, tuple[str, ...]]] = []
        for index, (topic, strong_terms, regular_terms) in enumerate(self._RULES):
            matched = tuple(term for term in strong_terms + regular_terms if self._contains_term(normalized, term))
            if matched:
                candidates.append((len(matched), max(map(len, matched)), -index, topic, matched))
        if not candidates:
            return None

        count, _, _, topic, matched_terms = max(candidates, key=lambda candidate: candidate[:3])
        severity = (
            SocialSeverity.HIGH
            if any(self._contains_term(normalized, term) for term in self._HIGH_SEVERITY)
            else SocialSeverity.MODERATE
            if count > 1 or any(len(term) > 8 for term in matched_terms)
            else SocialSeverity.LOW
        )
        # A transparent heuristic based on keyword agreement only. This is
        # intentionally not presented as a calibrated probability.
        confidence = min(0.82, 0.52 + (0.08 * min(count - 1, 3)))
        return SocialClassification(topic=topic, severity=severity, confidence=confidence)

    @staticmethod
    def _contains_term(text: str, term: str) -> bool:
        return re.search(rf"\b{re.escape(term)}\b", text) is not None


class NugenSocialSignalInterpreter:
    """Future bridge contract; no Nugen runtime or data pipeline is required."""

    def __init__(self, bridge: SocialSignalInterpreter | None = None) -> None:
        self._bridge = bridge

    def interpret(self, text: str) -> SocialClassification | None:
        if self._bridge is None:
            return None
        return self._bridge.interpret(text)


class SocialSignalUnavailableError(Exception):
    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


class SocialSignalRateLimitedError(SocialSignalUnavailableError):
    pass


class BlueskySocialSignalAdapter:
    """Reads public Bluesky search results through the official AppView API."""

    BASE_URL = "https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts"
    MAX_RESULTS = 100

    def __init__(self, settings: Settings, interpreter: SocialSignalInterpreter | None = None) -> None:
        self._settings = settings
        self._interpreter = interpreter or KeywordSocialSignalInterpreter()
        self._limiter = IntervalRateLimiter(settings.social_signal_min_interval_seconds)
        # A process-local random salt makes source corroboration counts useful
        # within one response without creating a durable cross-request identifier.
        self._fingerprint_salt = secrets.token_bytes(32)

    async def search(
        self,
        area_name: str,
        aliases: list[str],
        *,
        center_latitude: float,
        center_longitude: float,
        since: datetime,
    ) -> list[NormalizedSocialSignal]:
        await self._limiter.wait()
        try:
            response = await get_http_client().get(
                self.BASE_URL,
                params={"q": area_name, "sort": "latest", "limit": self.MAX_RESULTS},
                timeout=self._settings.social_signal_request_timeout_seconds,
                headers={"Accept": "application/json"},
            )
        except httpx.HTTPError as exc:
            raise SocialSignalUnavailableError("Bluesky public search is unavailable") from exc

        if response.status_code == 429:
            raise SocialSignalRateLimitedError("Bluesky public search is rate-limited")
        if response.status_code >= 400:
            raise SocialSignalUnavailableError(
                "Bluesky public search returned an error", status_code=response.status_code
            )
        try:
            payload = response.json()
        except ValueError as exc:
            raise SocialSignalUnavailableError("Bluesky public search returned invalid data") from exc
        posts = payload.get("posts") if isinstance(payload, dict) else None
        if not isinstance(posts, list):
            raise SocialSignalUnavailableError("Bluesky public search returned an unexpected response")

        normalized_aliases = [" ".join(alias.casefold().split()) for alias in aliases if alias.strip()]
        normalized_aliases.append(" ".join(area_name.casefold().split()))
        signals: list[NormalizedSocialSignal] = []
        seen: set[str] = set()
        for item in posts[: self.MAX_RESULTS]:
            if not isinstance(item, dict):
                continue
            record = item.get("record")
            author = item.get("author")
            if not isinstance(record, dict) or not isinstance(author, dict):
                continue
            text = record.get("text")
            if not isinstance(text, str) or not self._mentions_area(text, normalized_aliases):
                continue
            created_at = self._parse_datetime(record.get("createdAt")) or self._parse_datetime(item.get("indexedAt"))
            if created_at is None or created_at < since:
                continue
            classification = self._interpreter.interpret(text)
            if classification is None:
                continue

            did = author.get("did")
            if not isinstance(did, str) or not did:
                continue
            uri = item.get("uri")
            dedupe_input = uri if isinstance(uri, str) else f"{did}:{' '.join(text.casefold().split())}"
            deduplication_key = hashlib.sha256(dedupe_input.encode()).hexdigest()
            if deduplication_key in seen:
                continue
            seen.add(deduplication_key)
            fingerprint = hmac.new(self._fingerprint_salt, did.encode(), hashlib.sha256).hexdigest()
            signals.append(
                NormalizedSocialSignal(
                    deduplication_key=deduplication_key,
                    source_fingerprint=fingerprint,
                    topic=classification.topic,
                    severity=classification.severity,
                    occurred_at=created_at,
                    classification_confidence=classification.confidence,
                )
            )
        # The query center is intentionally not attached to an individual post.
        # It remains request context and the API labels map markers as area-level.
        _ = center_latitude, center_longitude
        return signals

    @staticmethod
    def _mentions_area(text: str, aliases: list[str]) -> bool:
        normalized = " ".join(text.casefold().split())
        return any(alias and alias in normalized for alias in aliases)

    @staticmethod
    def _parse_datetime(value: Any) -> datetime | None:
        if not isinstance(value, str):
            return None
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed.astimezone(UTC) if parsed.tzinfo else parsed.replace(tzinfo=UTC)


__all__ = [
    "BlueskySocialSignalAdapter",
    "KeywordSocialSignalInterpreter",
    "NormalizedSocialSignal",
    "NugenSocialSignalInterpreter",
    "SocialClassification",
    "SocialSeverity",
    "SocialSignalInterpreter",
    "SocialSignalRateLimitedError",
    "SocialTopic",
    "SocialSignalUnavailableError",
]
