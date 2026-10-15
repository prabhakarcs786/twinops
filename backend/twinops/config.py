"""Runtime configuration from environment variables. Secrets are read from the environment (or a local, git-ignored .env) only."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MODELS = {"gemini": "gemini-2.5-flash", "vertex": "gemini-2.5-flash", "ollama": "qwen2.5:7b"}
OLLAMA_DEFAULT_URL = "http://127.0.0.1:11434/v1"


def load_env_file(path: str | Path | None = None) -> Path | None:
    """Loads KEY=VALUE lines from a .env file for local runs (TWINOPS_ENV_FILE, ./.env, then <repo>/.env).
    Variables already set in the environment win, and blank values are skipped so `KEY=` means "unset"."""
    explicit = path or os.environ.get("TWINOPS_ENV_FILE")
    candidates = [Path(explicit)] if explicit else [Path.cwd() / ".env", REPO_ROOT / ".env"]
    for candidate in candidates:
        if not candidate.is_file():
            continue
        for raw in candidate.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.removeprefix("export ").partition("=")
            key, value = key.strip(), value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
                value = value[1:-1]
            else:
                value = value.split(" #", 1)[0].strip()
            if key.isidentifier() and value and key not in os.environ:
                os.environ[key] = value
        return candidate
    return None


def _bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    return default if value is None else value.strip().lower() in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class Settings:
    planner: str = field(default_factory=lambda: os.environ.get("TWINOPS_PLANNER", "auto"))
    llm_provider: str = field(default_factory=lambda: os.environ.get("TWINOPS_LLM_PROVIDER", "auto"))
    llm_model: str | None = field(default_factory=lambda: os.environ.get("TWINOPS_LLM_MODEL") or None)
    llm_timeout_s: float = field(default_factory=lambda: float(os.environ.get("TWINOPS_LLM_TIMEOUT_S", "30")))
    llm_max_calls: int = field(default_factory=lambda: int(os.environ.get("TWINOPS_LLM_MAX_CALLS", "14")))
    llm_thinking_budget: int = field(default_factory=lambda: int(os.environ.get("TWINOPS_LLM_THINKING_BUDGET", "0")))
    llm_record_dir: str | None = field(default_factory=lambda: os.environ.get("TWINOPS_LLM_RECORD_DIR"))
    llm_replay_dir: str | None = field(default_factory=lambda: os.environ.get("TWINOPS_LLM_REPLAY_DIR"))
    openai_base_url: str | None = field(default_factory=lambda: os.environ.get("TWINOPS_OPENAI_BASE_URL"))
    ollama_base_url: str | None = field(default_factory=lambda: os.environ.get("TWINOPS_OLLAMA_BASE_URL"))
    google_project: str | None = field(default_factory=lambda: os.environ.get("GOOGLE_CLOUD_PROJECT"))
    google_location: str = field(default_factory=lambda: os.environ.get("GOOGLE_CLOUD_LOCATION", "europe-west1"))
    twin: str = field(default_factory=lambda: os.environ.get("TWINOPS_TWIN", "model"))
    network_url: str | None = field(default_factory=lambda: os.environ.get("TWINOPS_NETWORK_URL") or None)
    network_token: str = field(default_factory=lambda: os.environ.get("TWINOPS_NETWORK_TOKEN", ""))
    # Browser-facing Metro address behind a public HTTPS proxy; the connector itself stays on network_url.
    network_public_url: str | None = field(default_factory=lambda: os.environ.get("TWINOPS_NETWORK_PUBLIC_URL") or None)
    # Serve Metro's public pages under this path of the TwinOps site (one public URL, e.g. "/metro" on Cloud Run).
    network_proxy_prefix: str = field(default_factory=lambda: os.environ.get("TWINOPS_NETWORK_PROXY_PREFIX", "").rstrip("/"))
    lab_dir: Path = field(default_factory=lambda: Path(os.environ.get("TWINOPS_LAB_DIR", Path(__file__).resolve().parents[2] / "lab")))
    # "containerlab" (Docker) or "netns" (Linux namespaces in one container, for Cloud Run).
    lab_runtime: str = field(default_factory=lambda: os.environ.get("TWINOPS_LAB_RUNTIME", "containerlab"))
    # Parallel lab commands. Bursts above a CPU quota (Cloud Run) stall every process and inflate measured latency.
    lab_concurrency: int = field(default_factory=lambda: int(os.environ.get("TWINOPS_LAB_CONCURRENCY", "6")))
    harness_enabled: bool = field(default_factory=lambda: _bool("TWINOPS_HARNESS", True))
    data_dir: Path = field(default_factory=lambda: Path(os.environ.get("TWINOPS_DATA_DIR", Path(__file__).resolve().parents[1] / ".data")))
    static_dir: Path | None = field(default_factory=lambda: Path(p) if (p := os.environ.get("TWINOPS_STATIC_DIR")) else None)
    cors_origins: tuple[str, ...] = field(default_factory=lambda: tuple(o for o in os.environ.get("TWINOPS_CORS_ORIGINS", "http://localhost:5173").split(",") if o))
    max_active_runs: int = field(default_factory=lambda: int(os.environ.get("TWINOPS_MAX_ACTIVE_RUNS", "4")))
    apply_enabled: bool | None = field(default_factory=lambda: _bool("TWINOPS_APPLY_ENABLED", False) if "TWINOPS_APPLY_ENABLED" in os.environ else None)
    require_auth: bool = field(default_factory=lambda: _bool("TWINOPS_REQUIRE_AUTH", False))
    secure_cookies: bool = field(default_factory=lambda: _bool("TWINOPS_SECURE_COOKIES", False))
    postcheck_samples: int = field(default_factory=lambda: max(1, min(10, int(os.environ.get("TWINOPS_POSTCHECK_SAMPLES", "3")))))
    postcheck_interval_s: float = field(default_factory=lambda: max(0, min(60, float(os.environ.get("TWINOPS_POSTCHECK_INTERVAL_S", "2")))))
    rate_limit_per_min: int = field(default_factory=lambda: int(os.environ.get("TWINOPS_RATE_LIMIT_PER_MIN", "10")))

    def __post_init__(self) -> None:
        if self.apply_enabled is None:
            object.__setattr__(self, "apply_enabled", self.harness_enabled)

    def allows_apply(self) -> bool:
        """An operator can halt new writes without restarting or expiring evidence."""
        return bool(self.apply_enabled) and not (self.data_dir / "apply-disabled").exists()

    @property
    def gemini_api_key(self) -> str | None:
        key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
        if key:
            return key
        path = os.environ.get("GEMINI_API_KEY_FILE")
        return (REPO_ROOT / path).read_text(encoding="utf-8").strip() if path else None

    @property
    def openai_api_key(self) -> str | None:
        return os.environ.get("TWINOPS_OPENAI_API_KEY")

    @property
    def operator_token(self) -> str | None:
        return os.environ.get("TWINOPS_OPERATOR_TOKEN") or None

    def resolved_provider(self) -> str | None:
        if self.llm_provider != "auto":
            return self.llm_provider
        if self.llm_replay_dir:
            return "replay"
        if self.gemini_api_key:
            return "gemini"
        if self.google_project and _bool("GOOGLE_GENAI_USE_VERTEXAI", False):
            return "vertex"
        if self.openai_base_url:
            return "openai"
        if self.ollama_base_url:
            return "ollama"
        return None

    def model_for(self, provider: str) -> str:
        model = self.llm_model or DEFAULT_MODELS.get(provider)
        if not model:
            raise RuntimeError(f"TWINOPS_LLM_MODEL is required for provider {provider!r}")
        return model

    def resolved_planner(self) -> str:
        if self.planner != "auto":
            return self.planner
        return "llm" if self.resolved_provider() else "runbook"
