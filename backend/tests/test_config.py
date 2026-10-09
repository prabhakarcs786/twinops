"""Local .env loading and LLM provider selection (Gemini, Vertex, Ollama, OpenAI-compatible)."""

import pytest

from twinops.config import OLLAMA_DEFAULT_URL, Settings, load_env_file
from twinops.planner.factory import build_client, build_planner
from twinops.planner.llm_client import OpenAICompatClient

PROVIDER_VARS = ["TWINOPS_PLANNER", "TWINOPS_LLM_PROVIDER", "TWINOPS_LLM_MODEL", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI",
                 "GOOGLE_CLOUD_PROJECT", "TWINOPS_OPENAI_BASE_URL", "TWINOPS_OPENAI_API_KEY", "TWINOPS_OLLAMA_BASE_URL", "TWINOPS_LLM_REPLAY_DIR",
                 "TWINOPS_LLM_RECORD_DIR", "TWINOPS_ENV_FILE"]


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for name in PROVIDER_VARS:
        monkeypatch.delenv(name, raising=False)


def test_env_file_fills_gaps_but_never_overrides_the_shell(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text(
        "# comment\n"
        "TWINOPS_LLM_PROVIDER=ollama\n"
        "export TWINOPS_LLM_MODEL='llama3.1:8b'\n"
        "TWINOPS_OLLAMA_BASE_URL=\"http://gpu-box:11434/v1\"  \n"
        "TWINOPS_LLM_TIMEOUT_S=120 # local models are slow\n"
        "GEMINI_API_KEY=\n"
        "TWINOPS_PLANNER=llm\n"
        "not a variable line\n"
    )
    monkeypatch.setenv("TWINOPS_PLANNER", "runbook")
    monkeypatch.delenv("TWINOPS_LLM_TIMEOUT_S", raising=False)

    assert load_env_file(env) == env
    s = Settings()
    assert s.planner == "runbook", "a variable exported in the shell must win over .env"
    assert s.resolved_provider() == "ollama"
    assert s.model_for("ollama") == "llama3.1:8b"
    assert s.ollama_base_url == "http://gpu-box:11434/v1"
    assert s.llm_timeout_s == 120
    assert s.gemini_api_key is None, "blank values mean unset"


def test_missing_env_file_is_fine(tmp_path, monkeypatch):
    monkeypatch.setenv("TWINOPS_ENV_FILE", str(tmp_path / "absent.env"))
    assert load_env_file() is None


def test_ollama_needs_no_key_and_has_defaults(monkeypatch):
    monkeypatch.setenv("TWINOPS_LLM_PROVIDER", "ollama")
    client = build_client(Settings())
    assert isinstance(client, OpenAICompatClient)
    assert (client.provider, client.model, client._url) == ("ollama", "qwen2.5:7b", f"{OLLAMA_DEFAULT_URL}/chat/completions")
    assert client._headers == {}
    planner = build_planner(settings=Settings())
    assert (planner.kind, planner.provider) == ("llm", "ollama")


def test_auto_prefers_an_explicit_gemini_key_over_local_endpoints(monkeypatch):
    monkeypatch.setenv("TWINOPS_OLLAMA_BASE_URL", OLLAMA_DEFAULT_URL)
    monkeypatch.setenv("GEMINI_API_KEY", "test-key-not-real")
    s = Settings()
    assert s.resolved_provider() == "gemini"
    assert s.model_for("gemini") == "gemini-2.5-flash"


def test_openai_compatible_endpoint_requires_a_model_name(monkeypatch):
    monkeypatch.setenv("TWINOPS_OPENAI_BASE_URL", "http://127.0.0.1:1234/v1")
    with pytest.raises(RuntimeError, match="TWINOPS_LLM_MODEL"):
        build_client(Settings())
    monkeypatch.setenv("TWINOPS_LLM_MODEL", "local-model")
    client = build_client(Settings())
    assert (client.provider, client.model) == ("openai", "local-model")


def test_without_any_provider_the_runbook_is_used():
    assert Settings().resolved_planner() == "runbook"
