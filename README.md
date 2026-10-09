# TwinOps

TwinOps is a proof of concept for safer autonomous network operations. When a network incident occurs, TwinOps:

1. observes it read-only;
2. ranks root-cause hypotheses;
3. reproduces the affected slice in an isolated digital twin;
4. tests competing fixes there;
5. attacks its own best fix;
6. hands a human only the change that survived an eight-gate **Proof Gate**.

Production is written exactly once, through an apply gateway, after a human approves a change bound to its hash and to the target-state hash.

| Component | What it is |
|---|---|
| `frontend/` | Product site (`/`), live workbench (`/workbench`), pitch deck (`/deck`). React 19 + Vite. Also contains a deterministic in-browser engine used when no backend is reachable. |
| `backend/` | FastAPI service: incident orchestration, planners (Gemini / runbook), twin backends, Proof Gate, approval-bound apply, SSE streaming, Proof Pack export, evaluation harness. |
| `lab/` | Containerlab emulated network: FRR (BGP, IPv4 + IPv6), CoreDNS (cold + warm-cache resolvers), nginx TLS gateway, service + admin console. Two isolated instances: `prod` (demo network) and `twin`. |
| `deploy/` | Cloud Run deployment script. |
| `docs/` | Proposal, roadmap, deck PDF (`TwinOps_Deck.pdf`). |

## Quick start

Requires Python 3.12+, Node 23.6+ and, for the lab only, Docker.

```sh
python3 -m venv .venv && .venv/bin/pip install -e 'backend[dev]'   # once
cp .env.example .env        # optional: LLM provider, operator passcode, lab mode (git-ignored)

npm run dev                 # backend (auto-reload) + frontend (HMR): UI http://localhost:5173, API http://127.0.0.1:8000
npm run dev:stop            # stop both
```

`npm run dev` restarts cleanly. It first stops any TwinOps backend or frontend already running on ports 8000 and 5173, including one started from another terminal, then starts both with prefixed logs. On the first run it installs frontend dependencies.

- It only stops processes that belong to TwinOps (twinops, uvicorn, vite). If another program holds a port, it stops and says so instead of killing it. Pick other ports with `PORT=8100 TWINOPS_WEB_PORT=5180 npm run dev`.
- Vite proxies `/api` to the backend, so dev needs no CORS setup and no `VITE_API_BASE`.
- Ctrl+C stops both.

Production-style single process (built UI served by the API):

```sh
npm --prefix frontend ci && npm --prefix frontend run build
PYTHONPATH=backend TWINOPS_STATIC_DIR=frontend/dist .venv/bin/python -m twinops   # http://127.0.0.1:8000
```

Without a backend, the workbench runs its in-browser engine automatically. `?engine=local` forces it.

## Configuration (`.env`)

Every setting is an environment variable, listed with defaults in [.env.example](.env.example). For local runs, copy it to `.env` at the repo root, or point `TWINOPS_ENV_FILE` at another file. The server, `twinops.evaluation` and `twinops.lab` all load it.

- Variables exported in your shell always win over the file.
- Blank values mean "use the default".
- `.env` is git-ignored and excluded from the Docker image. On Cloud Run, secrets come from Secret Manager (see [deploy/cloudrun.sh](deploy/cloudrun.sh)).

## Planners: Gemini, Ollama, any OpenAI-compatible endpoint, or runbook

The planner proposes; deterministic code judges. A model never executes anything:

- Every model output is schema-validated.
- Cited evidence IDs must exist in the snapshot.
- Actions must come from the typed catalogue.
- Device logs are fenced as untrusted data.
- Calls are budgeted.
- Any failure falls back to the runbook and is recorded as a `planner_note` event.

| Variable | Meaning |
|---|---|
| `TWINOPS_PLANNER` | `auto` (default: LLM if a provider is configured, otherwise runbook), `llm`, `runbook` |
| `TWINOPS_LLM_PROVIDER` | `auto` (default), `gemini`, `vertex`, `ollama`, `openai`, `replay` |
| `GEMINI_API_KEY` | Gemini API key. Put it in `.env` or your shell; never commit it or paste it into chat. |
| `GOOGLE_GENAI_USE_VERTEXAI=true` + `GOOGLE_CLOUD_PROJECT` | Vertex AI with Application Default Credentials (no key) |
| `TWINOPS_LLM_PROVIDER=ollama` (+ optional `TWINOPS_OLLAMA_BASE_URL`) | Local Ollama, no key. Default URL `http://127.0.0.1:11434/v1` |
| `TWINOPS_OPENAI_BASE_URL` / `TWINOPS_OPENAI_API_KEY` | Any OpenAI-compatible endpoint: an approved internal gateway, LM Studio (`http://127.0.0.1:1234/v1`), vLLM or llama.cpp |
| `TWINOPS_LLM_MODEL` | Defaults: `gemini-2.5-flash` (Gemini/Vertex), `qwen2.5:7b` (Ollama). Required for `openai` |
| `TWINOPS_LLM_RECORD_DIR` / `TWINOPS_LLM_REPLAY_DIR` | Record live model responses, then replay them offline (deterministic demos, audits) |
| `TWINOPS_LLM_MAX_CALLS`, `TWINOPS_LLM_TIMEOUT_S` | Call budget and timeout per incident (raise the timeout to 120+ for local models on CPU) |

To run fully local with Ollama:

```sh
ollama serve & ollama pull qwen2.5:7b
echo 'TWINOPS_LLM_PROVIDER=ollama' >> .env
PYTHONPATH=backend TWINOPS_STATIC_DIR=frontend/dist .venv/bin/python -m twinops   # workbench shows "ollama · qwen2.5:7b"
```

To evaluate the LLM planner against the same seeded harness as the runbook baseline:

```sh
# GEMINI_API_KEY (or another provider) set in .env or your own shell
PYTHONPATH=backend .venv/bin/python -m twinops.evaluation --planner llm --seeds 10 --out backend/.data/reports/llm.json
PYTHONPATH=backend .venv/bin/python -m twinops.evaluation --planner runbook --seeds 10 --out backend/.data/reports/runbook.json
```

Reports are served at `GET /api/evaluation/reports`.

## Emulated lab (Containerlab)

Real routing, DNS and TLS rather than an animation. On macOS, Containerlab runs inside its official container, so no local install is needed.

```sh
cd backend
../.venv/bin/python -m twinops.lab build            # builds twinops/frr-node, twinops/dns, twinops/web images
../.venv/bin/python -m twinops.lab up               # deploys prod + twin (18 containers)
../.venv/bin/python -m twinops.lab smoke route_misconfig   # full incident on the lab, printed as a timeline
../.venv/bin/python -m twinops.lab down
```

To run the UI against the lab:

```sh
PYTHONPATH=backend TWINOPS_TWIN=emulated TWINOPS_STATIC_DIR=frontend/dist .venv/bin/python -m twinops
```

Then open `/workbench`. Only one lab incident runs at a time.

How the lab behaves:

- Faults are injected by a harness the planner cannot see.
- Candidates are applied to the twin instance and measured with real `dig` and `curl` probes over IPv4 and IPv6.
- Challenges include:
  - a paused PoP, for a secondary failure;
  - the warm resolver cache;
  - IPv6 parity.
- Rollback is rehearsed by reading the device state back.
- The approved change is applied to the `prod` instance and verified with 11 real post-checks.
- Lab commands are allow-listed (`vtysh`, `dig`, `curl`, …). Containers are only paused, never restarted. Rendered configs are validated against injection.

Measured on a laptop (Docker Desktop, 8 vCPU), runbook planner:

| Fault | Verdict | Compute to verdict |
|---|---|---|
| F1 route misconfiguration | PASS UNDER DEFINED TESTS (B superseded by B′ after a real IPv6 timeout) | 58.5 s |
| F2 DNS failure | PASS UNDER DEFINED TESTS (C superseded by C′: warm cache still stale) | 41.1 s |
| F3 certificate expiry | PASS WITH WARNINGS (reload drains long-lived sessions) | 34.4 s |
| F0 link flap (unsupported) | INCONCLUSIVE, no fix proposed | 18.3 s |

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/config` | Planner, twin backend, whether approval needs a passcode |
| `POST /api/incidents` | `{pack, fault, seed?, pace}` → 202 with `incidentId`, `eventsUrl` |
| `GET /api/incidents/{id}/events` | Server-Sent Events (`run`, `end`), resumable with `Last-Event-ID` |
| `GET /api/incidents/{id}` | Run record, approval, outcome, AI briefing |
| `POST /api/incidents/{id}/decision` | Approve or reject. Needs `Authorization: Bearer <TWINOPS_OPERATOR_TOKEN>` when set |
| `POST /api/incidents/{id}/drift` | Harness: edit the target after the snapshot (proves approval invalidation) |
| `GET /api/incidents/{id}/reveal` | Sealed fault label, only after the verdict |
| `GET /api/incidents/{id}/proof-pack?format=json\|html` | Proof Pack export (HTML is served sandboxed) |

Hardening:

- CSP with `script-src 'self'`, plus HSTS, `nosniff` and `DENY` framing.
- Per-client rate limit on incident creation.
- Capped concurrent runs.
- Constant-time operator token check.
- Approval windows expire after 15 minutes.

## Deploy to Cloud Run

The root `Dockerfile` builds the UI and serves it with the API as a non-root user. It bakes in a runbook evaluation report. Cloud Run cannot run privileged Containerlab, so the service uses the model twin; keep the emulated lab on a lab host.

```sh
docker build -t twinops:local . && docker run -p 8080:8080 twinops:local   # local check
deploy/cloudrun.sh            # Gemini API key from Secret Manager (see script header for one-time setup)
deploy/cloudrun.sh --vertex   # Vertex AI via the service account, no key
```

Incident state is in memory. The script therefore deploys a single instance with session affinity, which is fine for a demo. Scaling out needs a shared store.

## Tests

```sh
cd backend && ../.venv/bin/python -m pytest && ../.venv/bin/ruff check .   # 80 tests incl. 40 TS↔Python parity cases, lab renderers/probes with a fake runner
cd frontend && npm test             # engine tests + Playwright E2E + axe (desktop + mobile), in-browser engine
cd frontend && npm run test:live    # Playwright against the real FastAPI backend: SSE, passcode-gated approval, Proof Pack download, CSP
```

## Pitch deck

Open `/deck`. Use arrow keys to move between slides and **Save as PDF** to export. To regenerate `docs/TwinOps_Deck.pdf`, run `npm run preview` and then `npm run export:deck` (both in `frontend/`).

Workbench URL options: `?fault=route_misconfig|dns_failure|cert_expiry|unsupported_link_flap`, `?speed=instant`, `?autostart=1`, `?pack=enterprise`, `?engine=local`.
