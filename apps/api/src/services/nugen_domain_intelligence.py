"""Uncertainty-aware LocaLens explanation service backed by Nugen."""

from __future__ import annotations

import json
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from src.adapters.errors import AdapterUnavailableError
from src.integrations.nugen.client import NugenClient
from src.integrations.nugen.schemas import NugenMessage
from src.schemas.domain_intelligence import DomainIntelligenceInput, DomainIntelligenceResult

SYSTEM_INSTRUCTIONS = """You are Nugen, LocaLens domain intelligence.
Interpret only the bounded LocaLens domain context in the user message. You may reason about travelers, providers,
experiences, routes, Digital Twin scenarios, weather, and social/public signals. Distinguish observed facts from
inference, forecast, prediction, simulation, and unknown. Social/public signals are evidence, not ground truth.
Do not fabricate facts, invent availability, invent provider state, invent route conditions, or declare cancellations
without authoritative evidence. Do not override deterministic feasibility or hard constraints. Do not mutate actual
database or itinerary state. Do not treat simulated state as actual state. Deterministic impacts and feasibility are
authoritative inputs; your response is explanation only. Return one JSON object with exactly these keys: analysis
(string), impacts (array of concise strings), suitability_assessment (string), disruption_assessment (string),
recommendation (string), uncertainty (string), and reason_codes (array of strings). Keep the analysis
concise. Suitability and recommendation are advisory interpretations, not feasibility decisions. If evidence is missing,
say so. Never return a feasibility decision or claim to have changed state."""


class _NugenAnalysis(BaseModel):
    model_config = ConfigDict(extra="ignore", frozen=True)
    analysis: str = Field(min_length=1, max_length=2000)
    impacts: list[str] = Field(default_factory=list, max_length=12)
    suitability_assessment: str = Field(min_length=1, max_length=800)
    disruption_assessment: str = Field(min_length=1, max_length=800)
    recommendation: str = Field(min_length=1, max_length=800)
    uncertainty: str = Field(default="Evidence is incomplete.", max_length=800)
    reason_codes: list[str] = Field(default_factory=list, max_length=20)


class NugenDomainIntelligenceService:
    def __init__(self, client: NugenClient) -> None:
        self._client = client

    async def analyze(self, context: DomainIntelligenceInput) -> DomainIntelligenceResult:
        # Pydantic has already bounded each list/string. model_dump excludes no
        # uncontrolled objects: this is intentionally not an ORM/database dump.
        request_content = json.dumps(context.model_dump(mode="json"), ensure_ascii=False, separators=(",", ":"))
        response = await self._client.complete(
            [
                NugenMessage(role="system", content=SYSTEM_INSTRUCTIONS),
                NugenMessage(role="user", content=request_content),
            ]
        )
        try:
            payload: Any = json.loads(response.content)
            analysis = _NugenAnalysis.model_validate(payload)
        except (json.JSONDecodeError, ValidationError, TypeError):
            raise AdapterUnavailableError("Nugen returned a malformed domain analysis.") from None

        usage = response.usage
        safe_usage: dict[str, int | float | str] | None = None
        if isinstance(usage, dict):
            safe_usage = {
                str(key)[:60]: value
                for key, value in usage.items()
                if isinstance(value, (int, float, str)) and not isinstance(value, bool)
            }
        return DomainIntelligenceResult(
            provider="nugen",
            status="AVAILABLE",
            summary=analysis.analysis,
            impacts=analysis.impacts,
            suitability_assessment=analysis.suitability_assessment,
            disruption_assessment=analysis.disruption_assessment,
            recommendation=analysis.recommendation,
            uncertainty=analysis.uncertainty,
            reason_codes=analysis.reason_codes,
            model_id=response.model or self._client.model_id,
            usage=safe_usage,
            confidence_score=response.confidence_score,
            finish_reason=response.finish_reason,
            notes=[
                "Nugen interpretation is advisory; deterministic LocaLens feasibility and state remain authoritative."
            ],
        )

    async def summarize(self, facts: DomainIntelligenceInput) -> DomainIntelligenceResult:
        """Protocol-compatible name retained for the existing Digital Twin seam."""
        return await self.analyze(facts)


__all__ = ["NugenDomainIntelligenceService", "SYSTEM_INSTRUCTIONS"]
