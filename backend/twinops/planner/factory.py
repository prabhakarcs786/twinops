"""Builds the configured planner. Without credentials the deterministic runbook is used and labelled as such."""

from __future__ import annotations

from typing import Any

from ..config import OLLAMA_DEFAULT_URL, Settings
from .llm import LLMPlanner
from .llm_client import GeminiClient, LLMClient, OpenAICompatClient, RecordingClient, ReplayClient
from .runbook import RunbookPlanner


def build_client(settings: Settings) -> LLMClient | None:
    provider = settings.resolved_provider()
    client: LLMClient | None
    if provider == "gemini":
        if not settings.gemini_api_key:
            raise RuntimeError("TWINOPS_LLM_PROVIDER=gemini requires GEMINI_API_KEY")
        client = GeminiClient(settings.model_for(provider), api_key=settings.gemini_api_key, timeout_s=settings.llm_timeout_s, thinking_budget=settings.llm_thinking_budget)
    elif provider == "vertex":
        client = GeminiClient(settings.model_for(provider), vertex=True, project=settings.google_project, location=settings.google_location,
                              timeout_s=settings.llm_timeout_s, thinking_budget=settings.llm_thinking_budget)
    elif provider == "openai":
        if not settings.openai_base_url:
            raise RuntimeError("TWINOPS_LLM_PROVIDER=openai requires TWINOPS_OPENAI_BASE_URL")
        client = OpenAICompatClient(settings.model_for(provider), settings.openai_base_url, settings.openai_api_key, settings.llm_timeout_s)
    elif provider == "ollama":
        # Ollama serves an OpenAI-compatible API (with JSON-schema structured output) and needs no key.
        client = OpenAICompatClient(settings.model_for(provider), settings.ollama_base_url or OLLAMA_DEFAULT_URL, None, settings.llm_timeout_s, provider="ollama")
    elif provider == "replay":
        if not settings.llm_replay_dir:
            raise RuntimeError("TWINOPS_LLM_PROVIDER=replay requires TWINOPS_LLM_REPLAY_DIR")
        return ReplayClient(settings.llm_replay_dir, settings.llm_model or "recorded")
    else:
        return None
    if settings.llm_record_dir:
        client = RecordingClient(client, settings.llm_record_dir)
    return client


def build_planner(kind: str | None = None, settings: Settings | None = None, client: LLMClient | None = None) -> Any:
    settings = settings or Settings()
    kind = kind or settings.resolved_planner()
    if kind == "runbook":
        return RunbookPlanner()
    client = client or build_client(settings)
    if client is None:
        raise RuntimeError("LLM planner requested but no provider is configured (set GEMINI_API_KEY, Vertex AI, TWINOPS_OPENAI_BASE_URL or TWINOPS_LLM_PROVIDER=ollama)")
    return LLMPlanner(client, settings.llm_max_calls)
