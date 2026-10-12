"""Local Network Operations app. Owns prod containers; TwinOps reaches it only over HTTP."""
from __future__ import annotations

import asyncio
import contextlib
import copy
import hmac
import json
import os
import time
import uuid
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .catalogue import CATALOGUE, forbidden_reasons, validate_change_set
from .config import REPO_ROOT, Settings, load_env_file
from .hashing import hash_of
from .lab.backend import LabDemoNetwork, lab_status, runtime_dir, stable_hash
from .lab.device import LabInstance
from .lab.runner import DockerRunner
from .topology import build_topology


class FaultRequest(BaseModel):
    fault: Literal['route_misconfig', 'dns_failure', 'cert_expiry', 'unsupported_link_flap']


class ClaimRequest(BaseModel):
    incidentId: str = Field(pattern=r'^inc-[a-zA-Z0-9-]+$', max_length=80)


class ApplyRequest(ClaimRequest):
    issueId: str
    expectedHash: str
    approvalToken: str = Field(min_length=16, max_length=200)
    change: dict[str, Any]


class FinishRequest(ClaimRequest):
    status: str = Field(max_length=40)


class RestoreRequest(ClaimRequest):
    approvalToken: str = Field(min_length=16, max_length=200)


class NetworkState:
    def __init__(self, settings: Settings, path: Path, network: Any = None):
        self.settings = settings
        self.path = path
        self.topo = build_topology('core')
        self.network = network or LabDemoNetwork(LabInstance('prod', runtime_dir(settings), self.topo, DockerRunner()), self.topo, 7)
        self.lock = asyncio.Lock()
        self.ready = False
        self.error: str | None = None
        self.observation: dict[str, Any] | None = None
        self.checked_at: float | None = None
        self.issue: dict[str, Any] | None = None
        self.history: list[dict[str, Any]] = []
        self.operation: dict[str, Any] | None = None
        self.recovery = False
        self.initialized = False
        if path.exists():
            saved = json.loads(path.read_text())
            self.initialized = True
            for name in ('issue', 'history', 'operation', 'recovery'):
                setattr(self, name, saved.get(name, getattr(self, name)))
            for attr, value in saved['network'].items():
                setattr(self.network, attr, value)
            if self.operation and self.operation['status'] in ('applying', 'restoring'):
                self.recovery = True
                self.save()

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        data = {name: getattr(self, name) for name in ('issue', 'history', 'operation', 'recovery')}
        data['network'] = {name: getattr(self.network, name) for name in
                           ('_declared', '_changes', '_logs', '_hardware', '_baselines', 'writes')}
        temp = self.path.with_suffix('.tmp')
        temp.write_text(json.dumps(data))
        temp.replace(self.path)
        self.initialized = True

    async def refresh(self):
        obs = await self.network.observe()
        self.observation = obs
        self.checked_at = time.time()
        failed = [p for p in obs['probes'] if p['kind'] == 'journey' and not p['ok']]
        if failed and not self.issue:
            self.issue = {'id': uuid.uuid4().hex, 'detectedAt': self.checked_at, 'status': 'open', 'incidentId': None,
                          'title': f"Service disruption · {len(failed)} journeys failing", 'failedJourneys': [p['id'] for p in failed]}
            self.save()
        elif failed and self.issue and self.issue['status'] == 'resolved':
            self.issue['status'] = 'open'
            self.issue.pop('resolvedAt', None)
            self.save()
        elif self.issue and not failed and self.issue['status'] != 'resolved':
            self.issue['status'] = 'resolved'
            self.issue['resolvedAt'] = self.checked_at
            self.save()
        self.ready = True
        self.error = None

    async def poll(self):
        while True:
            try:
                async with self.lock:
                    if not self.initialized:
                        status = await lab_status(self.settings)
                        if not status['ready']:
                            raise RuntimeError(status['detail'])
                        await self.network.prepare()
                        self.save()
                    await self.refresh()
            except Exception as exc:
                self.ready = False
                self.error = f'{type(exc).__name__}: {exc}'[:250]
            await asyncio.sleep(5)

    def dashboard(self):
        return {'name': 'Metro Network', 'ready': self.ready, 'error': self.error, 'checkedAt': self.checked_at,
                'backend': 'Containerlab · FRR / CoreDNS / nginx', 'observation': self.observation,
                'topology': self.topo, 'issue': self.issue, 'history': self.history[-20:], 'recoveryRequired': self.recovery,
                'busy': self.lock.locked(), 'operation': self.operation['status'] if self.operation else None,
                'twinopsUrl': os.environ.get('TWINOPS_UI_URL', 'http://localhost:5173')}

    def require_claim(self, incident_id: str):
        if not self.issue or self.issue.get('incidentId') != incident_id or self.issue.get('investigationStatus') in ('finished', 'recovery_required'):
            raise HTTPException(409, 'This investigation does not own the current issue')

    def can_replace_issue(self) -> bool:
        issue = self.issue
        return bool(issue) and issue['status'] == 'resolved' and (not issue.get('incidentId') or issue.get('investigationStatus') == 'finished')

    async def restore_baseline(self):
        """Archive the current issue and return the devices to the healthy baseline. Caller holds the lock."""
        if self.issue:
            archived = copy.deepcopy(self.issue)
            if archived['status'] != 'resolved':
                archived.update(status='reset', resetAt=time.time())
            self.history.append(archived)
        self.recovery = True
        self.save()
        self.network = LabDemoNetwork(self.network.inst, self.topo, 7)
        await self.network.prepare()
        self.issue = None
        self.operation = None
        self.recovery = False
        self.save()


def create_network_app(settings: Settings | None = None, state: NetworkState | None = None) -> FastAPI:
    settings = settings or Settings()
    state = state or NetworkState(settings, Path(os.environ.get('TWINOPS_NETWORK_DATA', REPO_ROOT / 'local-app/.data/state.json')))

    @contextlib.asynccontextmanager
    async def lifespan(app):
        task = asyncio.create_task(state.poll())
        yield
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    app = FastAPI(title='Metro Network API', lifespan=lifespan, docs_url='/api/docs')
    app.state.network = state
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=['localhost', '127.0.0.1', 'testserver'])

    @app.middleware('http')
    async def local_boundary(request: Request, call_next):
        origin = request.headers.get('origin')
        if request.method != 'GET' and origin and urlsplit(origin).netloc != request.headers.get('host'):
            from fastapi.responses import JSONResponse
            return JSONResponse({'detail': 'Cross-origin writes are not allowed'}, status_code=403)
        response = await call_next(request)
        response.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; object-src 'none'"
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Cache-Control'] = 'no-store'
        return response

    def connector_auth(authorization: str | None = Header(default=None)):
        if not settings.network_token or not hmac.compare_digest(authorization or '', f'Bearer {settings.network_token}'):
            raise HTTPException(401, 'Connector authentication required')

    @app.get('/api/health')
    async def health():
        return {'status': 'ok', 'ready': state.ready}

    @app.get('/api/dashboard')
    async def dashboard():
        return state.dashboard()

    @app.post('/api/faults')
    async def fault(body: FaultRequest):
        async with state.lock:
            if not state.ready or state.recovery:
                raise HTTPException(409, 'Lab is unavailable or needs operator recovery')
            if state.issue and not state.can_replace_issue():
                raise HTTPException(409, 'Reset the current scenario before starting another fault')
            if state.issue:
                await state.restore_baseline()
            # Persist intent before a device write: an interrupted fault injection is uncertain too.
            state.recovery = True
            state.save()
            await state.network.inject_fault(body.fault)
            await state.refresh()
            state.recovery = False
            state.save()
            return state.dashboard()

    @app.post('/api/reset')
    async def reset():
        async with state.lock:
            if state.recovery:
                raise HTTPException(409, 'Operator recovery required; automatic reset is blocked')
            if state.issue and state.issue.get('incidentId') and state.issue.get('investigationStatus') != 'finished':
                raise HTTPException(409, 'Wait for the investigation or reject its pending approval before resetting')
            await state.restore_baseline()
            await state.refresh()
            return state.dashboard()

    auth = [Depends(connector_auth)]

    @app.get('/api/connector', dependencies=auth)
    async def connector():
        return {**state.dashboard(), 'topology': state.topo}

    @app.post('/api/issues/{issue_id}/claim', dependencies=auth)
    async def claim(issue_id: str, body: ClaimRequest):
        async with state.lock:
            if not state.ready or state.recovery or not state.issue or state.issue['id'] != issue_id or state.issue['status'] == 'resolved':
                raise HTTPException(409, 'Issue unavailable')
            if state.issue.get('incidentId') not in (None, body.incidentId):
                raise HTTPException(409, 'Issue already claimed')
            if state.issue.get('investigationStatus') in ('finished', 'recovery_required'):
                raise HTTPException(409, 'Issue already investigated')
            state.issue.update(incidentId=body.incidentId, investigationStatus='investigating')
            state.save()
            return {'issue': state.issue}

    @app.post('/api/issues/{issue_id}/finish', dependencies=auth)
    async def finish(issue_id: str, body: FinishRequest):
        async with state.lock:
            if not state.issue or state.issue['id'] != issue_id or state.issue.get('incidentId') != body.incidentId:
                raise HTTPException(409, 'Issue mismatch')
            if body.status == 'recovery_required':
                state.recovery = True
            state.issue['investigationStatus'] = 'recovery_required' if state.recovery else 'finished'
            state.save()
            return {'ok': True}

    @app.get('/api/observation', dependencies=auth)
    async def observation():
        async with state.lock:
            await state.refresh()
            return {'observation': state.observation, 'writes': state.network.writes}

    @app.get('/api/snapshot', dependencies=auth)
    async def snapshot():
        async with state.lock:
            captured = await state.network.capture_supported()
            return {'state': captured, 'stateHash': stable_hash(captured), 'writes': state.network.writes}

    @app.get('/api/probes/{journey_id}', dependencies=auth)
    async def probe(journey_id: str, family: Literal['v4', 'v6'] = 'v4'):
        if not any(j['id'] == journey_id for j in state.topo['journeys']):
            raise HTTPException(404, 'Unknown journey')
        async with state.lock:
            return await state.network.probe(journey_id, family)

    @app.post('/api/apply', dependencies=auth)
    async def apply(body: ApplyRequest):
        async with state.lock:
            state.require_claim(body.incidentId)
            op_id = hash_of({'token': body.approvalToken, 'incident': body.incidentId, 'change': body.change, 'state': body.expectedHash})
            if state.operation:
                if state.operation['id'] == op_id and state.operation['status'] == 'applied':
                    return {'previous': state.operation['previous'], 'writes': state.network.writes}
                raise HTTPException(409, 'An apply was already attempted; inspect its outcome')
            if state.recovery or state.issue['id'] != body.issueId:
                raise HTTPException(409, 'Target unavailable')
            if any(not isinstance(body.change.get(key), str) or not body.change[key] for key in ('id', 'label', 'origin', 'rationale')):
                raise HTTPException(400, 'Change metadata is incomplete')
            errors = validate_change_set(body.change, {name for name, spec in CATALOGUE.items() if spec.lab_supported})
            if errors:
                raise HTTPException(400, 'Invalid change')
            errors += forbidden_reasons(body.change)
            expected_change = hash_of({'steps': body.change.get('steps'), 'origin': body.change.get('origin'), 'parentId': body.change.get('parentId')})
            if errors or body.change.get('hash') != expected_change:
                raise HTTPException(400, 'Invalid or forbidden change')
            previous = await state.network.capture_supported()
            if stable_hash(previous) != body.expectedHash:
                raise HTTPException(409, 'Target state changed since approval')
            state.operation = {'id': op_id, 'tokenHash': hash_of(body.approvalToken), 'incidentId': body.incidentId,
                               'status': 'applying', 'previous': previous}
            state.save()
            try:
                await state.network.apply_approved(body.change, body.approvalToken)
                state.operation['status'] = 'applied'
                state.save()
                return {'previous': previous, 'writes': state.network.writes}
            except BaseException:
                state.recovery = True
                state.save()
                raise

    @app.post('/api/restore', dependencies=auth)
    async def restore(body: RestoreRequest):
        async with state.lock:
            state.require_claim(body.incidentId)
            op = state.operation
            if not op:
                # A rejected apply did not write anything.
                return {'writes': state.network.writes}
            if op['incidentId'] != body.incidentId or op['tokenHash'] != hash_of(body.approvalToken):
                raise HTTPException(409, 'Rollback does not match the attempted change')
            if op['status'] != 'restored':
                op['status'] = 'restoring'
                state.recovery = True
                state.save()
                await state.network.restore(op['previous'], body.approvalToken)
                if await state.network.state_hash() != stable_hash(op['previous']):
                    raise HTTPException(409, 'Rollback verification failed')
                op['status'] = 'restored'
                state.recovery = False
                state.save()
            return {'writes': state.network.writes}

    assets = REPO_ROOT / 'local-app'

    @app.get('/')
    async def index():
        return FileResponse(assets / 'index.html')

    @app.get('/{asset}')
    async def asset(asset: Literal['app.js', 'style.css']):
        return FileResponse(assets / asset)

    return app


def main():
    import uvicorn
    load_env_file()
    uvicorn.run(create_network_app(), host='127.0.0.1', port=int(os.environ.get('TWINOPS_NETWORK_PORT', '8010')))


if __name__ == '__main__':
    main()
