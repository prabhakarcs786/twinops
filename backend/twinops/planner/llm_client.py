"""Provider-neutral LLM clients. Every call returns parsed JSON plus usage; the planner validates everything."""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, Protocol

import httpx

from ..hashing import canonical, sha256


class LLMError(RuntimeError):
    pass


class LLMClient(Protocol):
    provider: str
    model: str

    async def generate_json(self, role: str, system: str, payload: dict[str, Any], schema: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]: ...


def _payload_text(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=1)


class GeminiClient:
    """Gemini via the Google Gen AI SDK — API key (AI Studio) or Vertex AI with Application Default Credentials."""

    provider = "gemini"

    def __init__(self, model: str, *, api_key: str | None = None, vertex: bool = False, project: str | None = None, location: str | None = None,
                 timeout_s: float = 30, thinking_budget: int = 0) -> None:
        from google import genai

        self.model = model
        self.provider = "vertex" if vertex else "gemini"
        self._timeout = timeout_s
        self._thinking = thinking_budget
        self._client = genai.Client(vertexai=True, project=project, location=location) if vertex else genai.Client(api_key=api_key)

    async def generate_json(self, role: str, system: str, payload: dict[str, Any], schema: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        from google.genai import types

        config = types.GenerateContentConfig(
            system_instruction=system,
            response_mime_type="application/json",
            response_json_schema=schema,
            temperature=0.0,
            max_output_tokens=4096,
            thinking_config=types.ThinkingConfig(thinking_budget=self._thinking),
        )
        try:
            resp = await asyncio.wait_for(self._client.aio.models.generate_content(model=self.model, contents=_payload_text(payload), config=config), self._timeout)
        except TimeoutError as exc:
            raise LLMError(f"{self.provider} timed out after {self._timeout:.0f} s") from exc
        except Exception as exc:  # noqa: BLE001 — SDK raises many types; surface them uniformly
            raise LLMError(f"{self.provider} error: {type(exc).__name__}: {str(exc)[:200]}") from exc
        text = resp.text or ""
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise LLMError("model returned non-JSON output") from exc
        usage = resp.usage_metadata
        return data, {"tokens": getattr(usage, "total_token_count", 0) or 0}


class OpenAICompatClient:
    """Any OpenAI-compatible chat endpoint (approved enterprise gateway, Ollama, LM Studio, llama.cpp server, vLLM)."""

    def __init__(self, model: str, base_url: str, api_key: str | None, timeout_s: float = 30, provider: str = "openai") -> None:
        self.provider = provider
        self.model = model
        self._url = base_url.rstrip("/") + "/chat/completions"
        self._headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        self._timeout = timeout_s

    async def generate_json(self, role: str, system: str, payload: dict[str, Any], schema: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        body = {
            "model": self.model,
            "temperature": 0,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": _payload_text(payload)}],
            "response_format": {"type": "json_schema", "json_schema": {"name": f"twinops_{role}", "schema": schema}},
        }
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                resp = await client.post(self._url, json=body, headers=self._headers)
                resp.raise_for_status()
                data = resp.json()
            content = data["choices"][0]["message"]["content"]
            return json.loads(content), {"tokens": (data.get("usage") or {}).get("total_tokens", 0)}
        except (httpx.HTTPError, KeyError, IndexError, json.JSONDecodeError) as exc:
            raise LLMError(f"{self.provider} endpoint error: {type(exc).__name__}") from exc


def fixture_key(role: str, payload: dict[str, Any]) -> str:
    return f"{role}-{sha256(canonical(payload))[:16]}"


class ReplayClient:
    """Serves recorded responses so CI and offline stall demos are deterministic. Visibly labelled as replay."""

    provider = "replay"

    def __init__(self, directory: str | Path, model: str = "recorded") -> None:
        self._dir = Path(directory)
        self.model = model

    async def generate_json(self, role: str, system: str, payload: dict[str, Any], schema: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        path = self._dir / f"{fixture_key(role, payload)}.json"
        if not path.exists():
            raise LLMError(f"no recorded response for {role}")
        record = json.loads(path.read_text())
        return record["response"], {"tokens": record.get("tokens", 0), "replay": True}


class RecordingClient:
    """Wraps a live client and stores each response as a replay fixture."""

    def __init__(self, inner: LLMClient, directory: str | Path) -> None:
        self._inner = inner
        self._dir = Path(directory)
        self._dir.mkdir(parents=True, exist_ok=True)
        self.provider = inner.provider
        self.model = inner.model

    async def generate_json(self, role: str, system: str, payload: dict[str, Any], schema: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        data, usage = await self._inner.generate_json(role, system, payload, schema)
        record = {"role": role, "model": self.model, "recordedAt": time.time(), "response": data, "tokens": usage.get("tokens", 0)}
        (self._dir / f"{fixture_key(role, payload)}.json").write_text(json.dumps(record, indent=1, ensure_ascii=False))
        return data, usage


class ScriptedClient:
    """Test double: role → function(payload) → response (or exception)."""

    provider = "scripted"

    def __init__(self, script: dict[str, Callable[[dict[str, Any]], dict[str, Any]]], model: str = "scripted-model") -> None:
        self._script = script
        self.model = model
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def generate_json(self, role: str, system: str, payload: dict[str, Any], schema: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        self.calls.append((role, payload))
        fn = self._script.get(role)
        if fn is None:
            raise LLMError(f"no script for {role}")
        return fn(payload), {"tokens": 100}
