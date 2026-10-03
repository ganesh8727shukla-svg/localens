"""Async server-side client for Nugen's chat-completion endpoint."""

from __future__ import annotations

from typing import Any

import httpx
from pydantic import ValidationError

from src.adapters.errors import AdapterRateLimitedError, AdapterTimeoutError, AdapterUnavailableError
from src.core.config import Settings
from src.integrations.nugen.schemas import NugenChatRequest, NugenChatResult, NugenMessage


class NugenClient:
    def __init__(self, settings: Settings, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        if not settings.nugen_enabled:
            raise ValueError("Nugen is not configured")
        self._settings = settings
        self._transport = transport

    @property
    def model_id(self) -> str:
        return self._settings.nugen_model_id

    async def complete(self, messages: list[NugenMessage]) -> NugenChatResult:
        request = NugenChatRequest(model=self._settings.nugen_model_id, messages=messages)
        headers = {
            "Authorization": f"Bearer {self._settings.nugen_api_key.get_secret_value()}",
            "Content-Type": "application/json",
        }
        try:
            async with httpx.AsyncClient(
                timeout=self._settings.nugen_request_timeout_seconds,
                transport=self._transport,
            ) as client:
                response = await client.post(
                    str(self._settings.nugen_model_endpoint),
                    headers=headers,
                    json=request.model_dump(mode="json"),
                )
        except httpx.TimeoutException:
            raise AdapterTimeoutError("Nugen request timed out.") from None
        except httpx.HTTPError:
            raise AdapterUnavailableError("Nugen is unavailable.") from None

        if response.status_code == 429:
            retry_after = response.headers.get("Retry-After")
            try:
                retry_after_seconds = max(0.0, min(float(retry_after), 3600.0)) if retry_after else None
            except (TypeError, ValueError):
                retry_after_seconds = None
            raise AdapterRateLimitedError("Nugen is rate limited.", retry_after_seconds) from None
        if response.status_code in (401, 403):
            raise AdapterUnavailableError("Nugen authentication failed.") from None
        if response.status_code == 404:
            raise AdapterUnavailableError("Nugen returned HTTP 404 for the configured endpoint.") from None
        if response.status_code == 422:
            raise AdapterUnavailableError("Nugen rejected the request format.") from None
        if response.status_code >= 500:
            raise AdapterUnavailableError("Nugen is temporarily unavailable.") from None
        if response.status_code < 200 or response.status_code >= 300:
            raise AdapterUnavailableError("Nugen request failed.") from None

        try:
            payload: Any = response.json()
            choice = payload["choices"][0]
            message = choice["message"]
            content = message["content"]
            if not isinstance(content, str) or not content.strip():
                raise ValueError("Nugen response content is empty")
            usage = payload.get("usage")
            if usage is not None and not isinstance(usage, dict):
                usage = None
            confidence_score = payload.get("confidence_score")
            if isinstance(confidence_score, bool) or not isinstance(confidence_score, (int, float)):
                confidence_score = None
            return NugenChatResult(
                content=content,
                model=payload.get("model") if isinstance(payload.get("model"), str) else None,
                usage=usage,
                confidence_score=confidence_score,
                finish_reason=choice.get("finish_reason") if isinstance(choice.get("finish_reason"), str) else None,
            )
        except (KeyError, IndexError, TypeError, ValueError, ValidationError):
            raise AdapterUnavailableError("Nugen returned a malformed response.") from None


__all__ = ["NugenClient"]
