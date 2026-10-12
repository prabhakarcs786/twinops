# TwinOps

TwinOps is a proof of concept for safer autonomous network operations. When a network incident occurs, TwinOps:

1. observes it read-only;
2. ranks root-cause hypotheses;
3. reproduces the affected slice in an isolated digital twin;
4. tests competing fixes there;
5. attacks its own best fix;
6. hands a human only the change that survived an eight-gate **Proof Gate**.

Writes to the demo network go through an apply gateway after a human approves a change bound to its hash and to the target-state hash. Failed apply or post-check operations attempt a verified rollback; an interrupted apply or unverifiable rollback requires operator recovery.

| Component | What it is |
|---|---|
| `frontend/` | Product site (`/`), live workbench (`/workbench`), pitch deck (`/deck`). React 19 + Vite. Also contains a deterministic in-browser engine used when no backend is reachable. |
| `backend/` | FastAPI service: incident orchestration, planners (Gemini / runbook), twin backends, Proof Gate, approval-bound apply, SSE streaming, Proof Pack export, evaluation harness. |
| `lab/` | Containerlab emulated network: FRR (BGP, IPv4 + IPv6), CoreDNS (cold + warm-cache resolvers), nginx TLS gateway, service + admin console. Two isolated instances: `prod` (demo network) and `twin`. |
| `deploy/` | Cloud Run deployment script. |
| `docs/` | Proposal, roadmap, deck PDF (`TwinOps_Deck.pdf`). |

For how it works internally, what is real versus simulated, and the path to production, see the [Technical & Functional Guide](docs/TwinOps_Technical_and_Functional_Guide.md).

## Quick start

### Two-application demo with real network faults

Start Docker Desktop, then run from the repository root:

```sh
npm run dev:connected
```

This starts **Metro Network** at **http://localhost:8010**, TwinOps at **http://localhost:5173/connections**,
and its API at port 8000. The first run builds and deploys the existing 18-container lab; subsequent
runs reuse it. The Python environment and frontend requirements below still apply.
The router image now pins FRR 10.5.5; the older 9.1.3 image crashed during startup on this Apple Silicon lab.

1. Wait for Metro Network to show live service measurements.
2. Introduce a routing, DNS, certificate, or unsupported link-flap fault there.
3. TwinOps polls the application's API every five seconds and automatically creates an investigation.
4. Open the investigation from either app. TwinOps reads the live network over HTTP and tests fixes
   on the separate Containerlab twin. No fault label is sent to the planner.
5. Review and approve a passing candidate in TwinOps. Its apply gateway calls Metro Network's API;
   Metro Network changes the real lab devices. Fresh probes verify recovery in both screens.
6. After a verified recovery, choose the next fault directly: Metro Network moves the scenario to Recent issues
   and restores the healthy baseline before injecting. A scenario that ended without recovery needs **Reset scenario**.
   Reset is blocked during an investigation or uncertain recovery. Reject a pending approval first if you want to abandon it.

Gemini can use a local key file without copying the credential into configuration:

```dotenv
GEMINI_API_KEY_FILE=google-key
TWINOPS_LLM_PROVIDER=gemini
TWINOPS_LLM_MODEL=gemini-3.1-flash-lite
TWINOPS_LLM_TIMEOUT_S=60
```

Save these settings in `.env`; `google-key` is a plain key file at the repository root. Both are
git-ignored and excluded from the Docker build context. Explicit key environment variables take
precedence. Gemini 3 uses low thinking effort; the existing budget setting continues to apply to
Gemini 2 models. Model failures remain visible as runbook fallbacks.

The connected launcher creates a shared connector secret for its two backend processes. It is never
sent to either browser. The applications communicate over authenticated HTTP on loopback; the browser
apps do not share state. The network app owns `prod`, while TwinOps owns `twin`. This is a local,
single-operator prototype with one active issue, not an internet-facing multi-tenant connector.

Network state, issue ownership and pending rollback snapshots are retained in `local-app/.data/`;
TwinOps evidence is retained separately in `backend/.data/connected/`. An interrupted apply is blocked
for operator recovery. A restarted TwinOps process expires unfinished investigations rather than
reapplying old approvals. Retain both data directories when diagnosing an interrupted run; do not
delete them to clear a recovery block. `npm run dev:stop` stops the apps and retains containers and
evidence. The existing `python -m twinops.lab down` command removes only the TwinOps lab containers.

If Docker reports an address overlap, choose unused IPv4 management subnets in `.env`, for example
`TWINOPS_LAB_PROD_SUBNET=10.253.10.0/24` and `TWINOPS_LAB_TWIN_SUBNET=10.253.11.0/24`.
The launcher refuses to redeploy a missing lab when saved network state exists. Restore the lab
and inspect its state before continuing. Do not run the old standalone emulated demo against the
same containers while the connected application is running.

Metro Network's API documentation is at `/api/docs`. Connector endpoints are `GET /api/connector`,
`GET /api/observation`, `GET /api/snapshot`, `GET /api/probes/{id}`, `POST /api/issues/{id}/claim`,
`POST /api/issues/{id}/finish`, `POST /api/apply`, and `POST /api/restore`. Applies check the expected
state hash under the device lock and reject changed targets or repeated different operations.
Rollback uses the server's retained pre-change snapshot. `/api/faults` and `/api/reset` are local
demo controls used by Metro Network, not tools exposed to the TwinOps planner.

### Original self-contained demo

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

The workbench includes a presentation view, measured service impact with tested-slice coverage, a candidate comparison, an evidence replay, and source observations behind hypotheses. Live incident URLs retain the incident ID so refresh resumes the same investigation. **Recent incidents** opens saved evidence; **Planner benchmark** compares reports for matching topology packs and seed ranges. The elapsed timer keeps running while a model call or event stream is quiet.

**Facts & scope** separates observed probes, interpreted hypotheses, deterministic test results and untested conditions. Source IDs identify evidence; they do not prove every sentence an AI writes. The planner now receives failed restoration and regression probes as revision feedback, not only failed challenges. At most two revisions run through the full tests again.

**Memory** retrieves at most one compatible, successfully applied historical fix using matching observed failure signals. It never uses the sealed fault label. Pack, backend, topology, catalogue and policy versions must match. The fix is tested as a new candidate, with current rollback checks and a new approval decision. A matching symptom does not establish that yesterday's fix works today. Memory provenance is included in the Proof Pack.

**Challenge conditions & memory** offers repeatable seeds, memory on/off, changed rule ordering, noisy instruction-like logs, missing change history and a simulated provider outage. Extra challenge conditions are restricted to the enabled model demo harness. The outage exercise sends no request to the LLM and labels the runbook fallback explicitly. Target drift remains available while awaiting approval.

For the memory demonstration: run and approve an F1 incident with a fixed seed, select **Changed rule ordering**, then run the same seed again. The Memory view shows why the previous fix no longer restores service; today's alternatives still need fresh tests and approval.

Evidence is committed to `TWINOPS_DATA_DIR/incidents.sqlite3` before events are published. Completed runs, approvals, write logs and Proof Packs survive a process restart on the same disk. Unfinished investigations become read-only on restart: outstanding approvals expire, and an interrupted apply is marked `recovery_required`. Archived runs must be investigated again before any new approval.

### Operator review trials

After a verdict, **Review trial** opens a separate, read-only task. A participant reviews the same candidate using raw observations or its Proof Pack, then records **Accept**, **Reject** or **Need more evidence**. Server-measured duration and agreement with the recorded gate are saved without names, comments, approval tokens or network writes.

The measurement panel compares only incident/candidate tasks reviewed in both conditions and exports the individual trials. These are exploratory, anonymous measurements: repeat participation, prior exposure and order effects are not controlled. Gate agreement is not production safety. Automated tests do not count as human-study evidence, and no time savings are claimed before real participants complete trials. Arrange counterbalanced tasks with different engineers for a pilot; do not reuse a task a participant has already seen as a blind comparison.

## Configuration (`.env`)

Every setting is an environment variable, listed with defaults in [.env.example](.env.example). For local runs, copy it to `.env` at the repo root, or point `TWINOPS_ENV_FILE` at another file. The server, `twinops.evaluation` and `twinops.lab` all load it.

- Variables exported in your shell always win over the file.
- Blank values mean "use the default".
- `.env` is git-ignored and excluded from the Docker image. On Cloud Run, secrets come from Secret Manager (see [deploy/cloudrun.sh](deploy/cloudrun.sh)).

## Planners: Gemini, Ollama, any OpenAI-compatible endpoint, or runbook

The planner proposes; deterministic code judges. A model never executes anything:

- Every model output is schema-validated.
- Cited evidence IDs must exist in the snapshot.
- Hypothesis and briefing text with directly contradictory numeric comparisons is rejected. This narrow check does not establish that other claims are true; the UI exposes cited observations for review.
- Actions must come from the typed catalogue.
- Required challenges cover every action in a composed change. Missing mandatory supported challenge evidence fails the gate.
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
PYTHONPATH=backend .venv/bin/python -m twinops.evaluation --planner llm --compare --seeds 10 --start-seed 1001 --out backend/.data/reports/comparison.json
```

This writes `comparison-runbook.json` and `comparison-llm.json`. Reports are served at `GET /api/evaluation/reports` and shown in the workbench. They distinguish verdict success from success without fallback, and report abstentions, unsafe passes, tokens, latency and fallback counts. Unsupported-fault and injected-log controls use the chosen planner and include its provenance; approval/schema controls intentionally use the deterministic runbook. Seeds vary a synthetic topology fixture, so these results are not production reliability estimates. A one-seed run is only a smoke check.

To test configuration and evidence changes independently of the seed, repeat with `--variant changed_config`, `--variant noisy_evidence` or `--variant missing_history` and use a distinct output filename. Benchmark rows match pack, variant, seed range and evaluation version; they include median/p95 compute and model-authored revisions. Freeze prompts before a reserved evaluation range. These variants still use a fixed synthetic topology and are not arbitrary-network generalization tests. Memory is disabled in planner evaluations to avoid contamination from earlier incidents.

The backend suite includes a 20-incident synthetic rehearsal across the scenario variants, checking approval, post-checks and safe escalation. This is not a 20-run Containerlab or live-LLM soak result.

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

If an apply is interrupted or rollback cannot be verified, the lab remains blocked with `recovery_required`, including after service restart. Retain the Proof Pack and database and have the lab operator inspect and restore the target before reuse. There is deliberately no browser control to clear this block or approve archived evidence. For a disposable demo reset, stop the service, retain the old data directory as incident evidence, rebuild/reset the lab and start with a fresh `TWINOPS_DATA_DIR`. SQLite and the lab lock currently support one service process, not multiple workers sharing a target.

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
| `GET /api/incidents` | Latest 50 saved incident summaries for history |
| `GET /api/incidents/{id}/events` | Server-Sent Events (`run`, `end`), resumable with `Last-Event-ID` |
| `GET /api/incidents/{id}` | Run record, approval, outcome, AI briefing |
| `POST /api/incidents/{id}/decision` | Approve or reject. Needs `Authorization: Bearer <TWINOPS_OPERATOR_TOKEN>` when set |
| `POST /api/incidents/{id}/drift` | Harness: edit the target after the snapshot (proves approval invalidation) |
| `GET /api/incidents/{id}/reveal` | Sealed fault label, only after the verdict |
| `GET /api/incidents/{id}/proof-pack?format=json\|html` | Proof Pack export (HTML is served sandboxed) |
| `GET /api/evaluation/reports` | Evaluation summaries and control provenance |
| `POST /api/incidents/{id}/review-trials` | Start a read-only timed review: `{candidateId, mode: "raw"\|"proof"}` |
| `POST /api/review-trials/{id}/decision` | Record review choice, not approval: `accept`, `reject`, `more_evidence` |
| `GET /api/review-trials/summary` | Anonymous matched-task review timings and gate agreement |
| `GET /api/review-trials` | Download individual trial measurements |

Incident creation also accepts `variant`, `useMemory` (default true), and `simulateOutage` (default false). Extra variants and outage simulation require the model demo harness.

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

Active tasks and device handles remain in memory; evidence is stored in SQLite. The image gives its non-root user write access to `/app/data`. Cloud Run's default container filesystem is ephemeral: this local storage does **not** preserve history across instance replacement. The deployment script uses one instance with session affinity for the demo. Reliable cloud history and scaling require an external durable store and shared coordination; they are not supplied by this implementation.

## Tests

```sh
cd backend && ../.venv/bin/python -m pytest && ../.venv/bin/ruff check .   # includes TS↔Python parity, safety/recovery, persistence and fake lab adapters
cd frontend && npm test             # engine tests + Playwright E2E + axe (desktop + mobile), in-browser engine
cd frontend && npm run test:live    # real FastAPI: SSE, approval, refresh/history, quiet-stream timer, export, CSP
```

## Pitch deck

Open `/deck`. Use arrow keys to move between slides and **Save as PDF** to export. To regenerate `docs/TwinOps_Deck.pdf`, run `npm run preview` and then `npm run export:deck` (both in `frontend/`).

The deck loads the latest compatible saved planner comparison when connected to the backend. For an evidence-backed PDF from the development server, run `npm --prefix frontend run export:deck -- http://localhost:5173/deck`. Without report access it states that paired evidence is unavailable. Historic lab timings are labelled with their run date; Gemini and Cloud Run deployment remain unverified until actually exercised.

Workbench URL options: `?fault=route_misconfig|dns_failure|cert_expiry|unsupported_link_flap`, `?speed=instant`, `?autostart=1`, `?pack=enterprise`, `?engine=local`, `?view=presentation`, `?incident=<saved-id>`.
