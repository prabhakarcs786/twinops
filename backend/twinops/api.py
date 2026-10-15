"""FastAPI application: incident API with SSE streaming, Proof Pack export and the built frontend."""

from __future__ import annotations

import asyncio
import contextlib
import hmac
import json
import time
from collections import defaultdict, deque
from collections.abc import AsyncIterator
from typing import Any, Literal

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from . import __version__
from .access import AccessPolicy
from .config import Settings
from .harness import ALL_FAULTS, FAULT_INFO, SUPPORTED_FAULTS, VARIANTS, ScenarioVariant
from .planner.llm_client import LLMError
from .proofpack import build_proof_pack, proof_pack_html
from .service import BusyError, LiveIncident, Registry
from .topology import PACKS

FaultChoice = Literal["random", "route_misconfig", "dns_failure", "cert_expiry", "unsupported_link_flap"]

CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; "
       "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'")


class IncidentRequest(BaseModel):
    pack: Literal["core", "enterprise", "branch"] = "core"
    fault: FaultChoice = "random"
    seed: int | None = Field(default=None, ge=0, le=1_000_000)
    pace: float = Field(default=1.0, ge=0, le=8)
    includeEvaluationCase: bool = True
    variant: ScenarioVariant = "standard"
    useMemory: bool = True
    simulateOutage: bool = False


class DecisionRequest(BaseModel):
    decision: Literal["approve", "reject"]
    operator: str = Field(min_length=2, max_length=64, pattern=r"^[A-Za-z0-9._@-]+$")
    comment: str = Field(default="", max_length=500)


class NetworkFaultRequest(BaseModel):
    fault: Literal['route_misconfig', 'dns_failure', 'cert_expiry', 'unsupported_link_flap']


class AskRequest(BaseModel):
    question: str = Field(min_length=3, max_length=400)


class LoginRequest(BaseModel):
    token: str = Field(min_length=1, max_length=1024)


class ReviewRequest(BaseModel):
    candidateId: str = Field(min_length=1, max_length=64)
    mode: Literal["raw", "proof"]
    assignmentId: str | None = Field(default=None, min_length=1, max_length=128)


class ReviewDecision(BaseModel):
    decision: Literal["accept", "reject", "more_evidence"]


class RateLimiter:
    def __init__(self, per_minute: int, what: str = "incidents started") -> None:
        self.per_minute = per_minute
        self.what = what
        self.hits: dict[str, deque[float]] = defaultdict(deque)

    def check(self, key: str) -> None:
        now = time.monotonic()
        q = self.hits[key]
        while q and now - q[0] > 60:
            q.popleft()
        if len(q) >= self.per_minute:
            raise HTTPException(429, f"rate limit: too many {self.what} from this client, wait a minute")
        q.append(now)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    registry = Registry(settings)
    access = AccessPolicy(settings.require_auth, settings.cors_origins)
    from .network_connector import NetworkMonitor
    monitor = NetworkMonitor(registry) if settings.network_url else None
    limiter = RateLimiter(settings.rate_limit_per_min)
    ask_limiter = RateLimiter(max(6, settings.rate_limit_per_min), "questions")
    review_limiter = RateLimiter(max(6, settings.rate_limit_per_min), "review trials")

    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        if monitor:
            monitor.start()
        yield
        if monitor:
            await monitor.stop()
        await registry.shutdown()
        if monitor:
            await monitor.close()

    app = FastAPI(title="TwinOps", version=__version__, docs_url="/api/docs", openapi_url="/api/openapi.json", redoc_url=None, lifespan=lifespan)
    app.state.registry = registry
    app.state.monitor = monitor
    app.add_middleware(CORSMiddleware, allow_origins=list(settings.cors_origins), allow_credentials=True,
                       allow_methods=["GET", "POST"], allow_headers=["Authorization", "Content-Type", "Last-Event-ID"])

    @app.middleware("http")
    async def security_headers(request: Request, call_next):  # noqa: ANN001, ANN202
        response: Response = await call_next(request)
        response.headers.setdefault("Content-Security-Policy", CSP)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
        if request.headers.get("x-forwarded-proto") == "https":
            response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        return response

    def get_live(incident_id: str) -> LiveIncident:
        live = registry.get(incident_id)
        if live is None:
            raise HTTPException(404, "unknown incident")
        return live

    @app.middleware("http")
    async def access_control(request: Request, call_next):
        denied = access.authorize(request)
        return denied if denied is not None else await call_next(request)

    @app.post("/api/auth/session")
    async def login(body: LoginRequest, request: Request):
        limiter.check(request.client.host if request.client else "unknown")
        session = access.login(body.token)
        if not session:
            raise HTTPException(401, "Invalid access token")
        sid, role = session
        response = JSONResponse({"role": role})
        response.set_cookie("twinops_session", sid, max_age=3600, httponly=True, secure=settings.secure_cookies, samesite="strict")
        return response

    @app.get("/api/auth/me")
    async def me(request: Request):
        return {"role": access.role(request), "required": settings.require_auth}

    def operator_auth(request: Request, authorization: str | None = Header(default=None)) -> None:
        if settings.require_auth and getattr(request.state, "role", None) == "approver":
            return
        token = settings.operator_token
        if token is None:
            return
        supplied = (authorization or "").removeprefix("Bearer ").strip()
        if not supplied or not hmac.compare_digest(supplied, token):
            raise HTTPException(401, "operator passcode required", headers={"WWW-Authenticate": "Bearer"})

    def planner_info() -> dict[str, Any]:
        from .planner.factory import build_planner

        try:
            p = build_planner(settings=settings)
            return {"kind": p.kind, "provider": getattr(p, "provider", "none"), "model": getattr(p, "model", "none"), "mode": p.mode, "version": p.version}
        except RuntimeError as exc:
            return {"kind": "unavailable", "provider": "none", "model": "none", "mode": str(exc), "version": ""}

    @app.get("/api/health")
    async def health() -> dict[str, Any]:
        return {"status": "ok", "version": __version__}

    @app.get("/api/config")
    async def config(request: Request) -> dict[str, Any]:
        twin: dict[str, Any] = {"backend": settings.twin, "ready": True, "detail": "in-process model twin"}
        if settings.twin == "emulated":
            from .lab.backend import lab_status

            twin = await lab_status(settings)
        return {
            "version": __version__,
            "planner": planner_info(),
            "twin": twin,
            "packs": [{"id": k, "name": v["name"]} for k, v in PACKS.items()],
            "faults": [{"id": f, **FAULT_INFO[f], "supported": f in SUPPORTED_FAULTS} for f in ALL_FAULTS],
            "approvalAuth": settings.operator_token is not None and not settings.require_auth,
            "authenticationRequired": settings.require_auth,
            "role": access.role(request) if settings.require_auth else None,
            "harness": settings.harness_enabled and not settings.network_url,
            "connectedApplication": bool(settings.network_url),
            "networkUrl": settings.network_public_url or settings.network_url or None,
            "activeRuns": registry.active(),
            "contractVersion": "incident-1", "applyEnabled": settings.allows_apply(),
            "variants": [{"id": variant, "label": label} for variant, label in VARIANTS.items()]
            if settings.harness_enabled and settings.twin == "model" else [],
        }

    @app.get('/api/connections')
    async def connections() -> dict[str, Any]:
        return monitor.status if monitor else {'configured': False, 'connected': False, 'issues': []}

    async def network_exercise(path: str, body: dict, request: Request) -> dict[str, Any]:
        # Operator exercise controls use Metro's existing guarded endpoints. The
        # planner still receives only observed symptoms through the connector.
        limiter.check(request.client.host if request.client else 'unknown')
        if not monitor:
            raise HTTPException(409, 'No network application is connected')
        try:
            await monitor.client.call(path, body)
            monitor.update_status(await monitor.client.call('/api/connector'))
        except httpx.HTTPStatusError as exc:
            try:
                detail = exc.response.json().get('detail', 'Network exercise was refused')
            except ValueError:
                detail = 'Network exercise was refused'
            raise HTTPException(exc.response.status_code, detail) from exc
        except httpx.RequestError as exc:
            raise HTTPException(503, 'Network application did not respond. Check its status before retrying the exercise.') from exc
        return monitor.status

    @app.post('/api/connections/network/fault', status_code=202)
    async def network_fault(body: NetworkFaultRequest, request: Request):
        return await network_exercise('/api/faults', {'fault': body.fault}, request)

    @app.post('/api/connections/network/reset')
    async def network_reset(request: Request):
        return await network_exercise('/api/reset', {}, request)

    @app.post("/api/incidents", status_code=202)
    async def create_incident(body: IncidentRequest, request: Request) -> dict[str, Any]:
        limiter.check(request.client.host if request.client else "unknown")
        try:
            live = await registry.create(body.pack, body.fault, body.seed, body.pace, body.includeEvaluationCase, body.variant, body.useMemory, body.simulateOutage)
        except BusyError as exc:
            raise HTTPException(409, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        iid = live.session.incident_id
        return {"incidentId": iid, "seed": live.seed, "eventsUrl": f"/api/incidents/{iid}/events", "createdAt": live.created}

    @app.get("/api/incidents/{incident_id}")
    async def get_incident(incident_id: str) -> dict[str, Any]:
        live = get_live(incident_id)
        s = live.session
        return {"incidentId": s.incident_id, "status": s.status, "seed": live.seed, "run": s.run or None, "approval": s.approval, "outcome": s.outcome,
                "narrative": s.narrative, "events": len(s.events), "error": live.error, "createdAt": live.created, "recovered": live.recovered,
                "pack": live.topo["pack"], "topology": live.topo, "lifecycle": live.lifecycle()}

    @app.get("/api/incidents")
    async def incident_history() -> list[dict[str, Any]]:
        return registry.history()

    @app.get("/api/incidents/{incident_id}/events")
    async def events(incident_id: str, request: Request, follow: bool = True, last_event_id: str | None = Header(default=None)) -> StreamingResponse:
        live = get_live(incident_id)
        start = int(last_event_id) if last_event_id and last_event_id.isdigit() else 0

        async def stream() -> AsyncIterator[str]:
            sent = start
            yield "retry: 3000\n\n"
            while True:
                evs = live.session.events
                while sent < len(evs):
                    event = evs[sent]
                    sent += 1
                    yield f"id: {sent}\nevent: run\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"
                if not follow or (live.finished and sent >= len(live.session.events)):
                    yield f"event: end\ndata: {json.dumps({'status': live.session.status})}\n\n"
                    return
                if await request.is_disconnected():
                    return
                async with live.changed:
                    try:
                        await asyncio.wait_for(live.changed.wait_for(lambda s=sent: len(live.session.events) > s or live.finished), 15)
                    except TimeoutError:
                        yield ": keep-alive\n\n"

        return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @app.post("/api/incidents/{incident_id}/decision", status_code=202, dependencies=[Depends(operator_auth)])
    async def decision(incident_id: str, body: DecisionRequest) -> dict[str, Any]:
        live = get_live(incident_id)
        try:
            await registry.decide(live, body.operator, body.comment, body.decision)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        return {"status": live.session.status, "outcome": live.session.outcome}

    @app.post("/api/incidents/{incident_id}/drift", status_code=202, dependencies=[Depends(operator_auth)])
    async def drift(incident_id: str) -> dict[str, str]:
        if not settings.harness_enabled:
            raise HTTPException(403, "demo harness disabled")
        live = get_live(incident_id)
        try:
            await registry.drift(live)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        return {"status": "drift injected by demo harness"}

    @app.get("/api/incidents/{incident_id}/reveal")
    async def reveal(incident_id: str) -> dict[str, str]:
        try:
            return registry.reveal(get_live(incident_id))
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.post("/api/incidents/{incident_id}/ask")
    async def ask(incident_id: str, body: AskRequest, request: Request) -> dict[str, Any]:
        ask_limiter.check(request.client.host if request.client else "unknown")
        live = get_live(incident_id)
        try:
            return await registry.ask(live, body.question.strip())
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        except LLMError as exc:
            raise HTTPException(502, f"model error: {exc}") from exc

    @app.get("/api/incidents/{incident_id}/proof-pack", response_model=None)
    async def proof_pack(incident_id: str, format: Literal["json", "html"] = "json") -> Response:  # noqa: A002
        live = get_live(incident_id)
        if not live.session.run:
            raise HTTPException(409, "the Proof Pack is available at the verdict")
        pack = build_proof_pack(live.session)
        name = f"{incident_id}-proof-pack.{format}"
        disposition = {"Content-Disposition": f'attachment; filename="{name}"'}
        if format == "html":
            return HTMLResponse(proof_pack_html(pack), headers={**disposition, "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox"})
        return JSONResponse(pack, headers=disposition)

    @app.post("/api/incidents/{incident_id}/review-trials", status_code=201)
    async def start_review(incident_id: str, body: ReviewRequest, request: Request) -> dict[str, Any]:
        if not settings.harness_enabled:
            raise HTTPException(403, "demo review trials disabled")
        review_limiter.check(request.client.host if request.client else "unknown")
        try:
            return registry.start_review(get_live(incident_id), body.candidateId, body.mode, body.assignmentId)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.post("/api/review-trials/{trial_id}/decision")
    async def finish_review(trial_id: str, body: ReviewDecision) -> dict[str, Any]:
        if not settings.harness_enabled:
            raise HTTPException(403, "demo review trials disabled")
        try:
            return registry.store.finish_review(trial_id, body.decision)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.get("/api/review-trials/summary")
    async def review_summary() -> dict[str, Any]:
        return registry.store.review_summary()

    @app.get("/api/review-trials")
    async def review_results() -> Response:
        return JSONResponse(registry.store.review_results(), headers={"Content-Disposition": 'attachment; filename="twinops-review-trials.json"'})

    @app.get("/api/evaluation/reports")
    async def reports() -> list[dict[str, Any]]:
        folder = settings.data_dir / "reports"
        out = []
        for path in sorted(folder.glob("*.json"), reverse=True)[:20] if folder.exists() else []:
            with contextlib.suppress(ValueError, KeyError):
                data = json.loads(path.read_text())
                out.append({"name": path.stem, "generatedAt": data["generatedAt"], "planner": data["planner"], "seeds": data["seeds"],
                            "byFault": data["byFault"], "controls": [{k: v for k, v in c.items() if k != "modelEvidence"} for c in data["controls"]],
                            "pack": data.get("pack", "core"), "startSeed": data.get("startSeed", 1), "suiteVersion": data.get("suiteVersion", "legacy"),
                            "note": data.get("note", ""), "durationS": data.get("durationS"), "variant": data.get("variant", "standard")})
        return out

    prefix = settings.network_proxy_prefix
    if prefix and settings.network_url:
        # Metro's pages and exercise controls only; connector endpoints stay reachable from this host alone.
        metro_public = {"", "app.js", "style.css", "favicon.svg", "favicon.ico", "metrics", "api/health", "api/dashboard", "api/faults", "api/reset"}
        metro = httpx.AsyncClient(base_url=settings.network_url, timeout=120, trust_env=False)

        @app.get(prefix, include_in_schema=False)
        async def metro_root() -> RedirectResponse:
            return RedirectResponse(f"{prefix}/")

        @app.api_route(f"{prefix}/{{path:path}}", methods=["GET", "POST"], include_in_schema=False)
        async def metro_page(path: str, request: Request) -> Response:
            if path not in metro_public:
                raise HTTPException(404)
            if request.method == "POST":
                limiter.check(request.client.host if request.client else "unknown")
            # Metro checks Host and Origin itself, so both are passed through unchanged.
            headers = {k: v for k, v in request.headers.items() if k in ("host", "origin", "content-type", "accept")}
            try:
                upstream = await metro.request(request.method, f"/{path}", content=await request.body(), headers=headers)
            except httpx.RequestError as exc:
                raise HTTPException(503, "Metro Network is starting; try again in a moment") from exc
            passed = {k: v for k, v in upstream.headers.items() if k not in ("content-length", "content-encoding", "transfer-encoding", "connection")}
            return Response(upstream.content, upstream.status_code, passed)

    static_dir = settings.static_dir
    if static_dir and static_dir.is_dir():
        root = static_dir.resolve()
        index = root / "index.html"

        @app.get("/{path:path}", include_in_schema=False)
        async def spa(path: str) -> Response:
            if path.startswith("api/"):
                raise HTTPException(404)
            candidate = (root / path).resolve()
            if path and candidate.is_file() and candidate.is_relative_to(root):
                cache = "public, max-age=31536000, immutable" if path.startswith("assets/") else "no-cache"
                return FileResponse(candidate, headers={"Cache-Control": cache})
            return FileResponse(index, headers={"Cache-Control": "no-cache"})

    return app


app = create_app()


def run() -> None:
    import os
    from pathlib import Path

    import uvicorn

    from .config import load_env_file

    load_env_file()
    options: dict[str, Any] = {"host": os.environ.get("HOST", "127.0.0.1"), "port": int(os.environ.get("PORT", "8000")), "proxy_headers": True,
                               "forwarded_allow_ips": "*", "timeout_graceful_shutdown": 5}
    if os.environ.get("TWINOPS_RELOAD", "").lower() in ("1", "true", "yes"):
        # The reload worker re-imports this module; .env values reach it through the inherited environment.
        uvicorn.run("twinops.api:app", reload=True, reload_dirs=[str(Path(__file__).resolve().parent)], **options)
    else:
        uvicorn.run(create_app(), **options)


if __name__ == "__main__":
    run()
