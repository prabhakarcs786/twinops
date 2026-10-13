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
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from .catalogue import CATALOGUE, describe_step, forbidden_reasons, validate_change_set
from .config import REPO_ROOT, Settings, load_env_file
from .harness import FAULT_INFO
from .hashing import hash_of
from .lab.backend import LabDemoNetwork, lab_status, runtime_dir, stable_hash
from .lab.device import LabInstance
from .lab.plan import DNS, DNS_COLD_PORT, POPS, container
from .lab.runner import DockerRunner, LabError
from .model import parse_iso
from .topology import SERVICE_IPS, build_topology, pop_by_index


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


class ResetRequest(BaseModel):
    operatorRecovery: bool = False


def device_facts(state: dict[str, Any], topo: dict[str, Any]) -> dict[str, dict[str, str]]:
    """Settings read back from the devices in plain words. `value` is compared across snapshots; `detail` is display only."""
    facts: dict[str, dict[str, str]] = {}

    def put(key: str, topic: str, value: str, detail: str = '') -> None:
        facts[key] = {'topic': topic, 'value': value, **({'detail': detail} if detail else {})}

    b17 = state['b17']
    for rule in b17['prefixList']:
        put(f"B17 route filter EDGE-IN, rule {rule['seq']}", 'route', f"{rule['action']} {rule['prefix']}")
    put('B17 route filter applied to PoP sessions', 'route', 'yes' if b17['filterEnabled'] else 'no')
    put('B17 prefixes steered over backup path', 'route', ', '.join(b17.get('steered', [])) or 'none')
    v6_owner = {n['v6Prefix']: n['short'] for n in topo['nodes'] if n.get('v6Prefix')}
    for prefix in b17['v6Prefixes']:
        put(f"B17 advertises IPv6 for {v6_owner.get(prefix, 'customers')} ({prefix})", 'route', 'yes')
    dns = state['dns']
    put('Resolver customers use', 'dns', 'DNS-1 primary' if dns['active'] == 'primary' else 'DNS-2 standby')
    for host in SERVICE_IPS:
        put(f'DNS-1 answer for {host}', 'dns', dns['primary'].get(host, 'no answer'))
        # A cache miss is answered from the zone, exactly like the warm resolver in the lab.
        cached = dns['cache'].get(host)
        put(f'DNS-1 cached answer for {host}', 'dns', cached or dns['primary'].get(host, 'no answer'), '' if cached else 'cache empty, answered fresh')
        put(f'DNS-2 answer for {host}', 'dns', dns['standby'].get(host, 'no answer'))
    now = datetime.now(UTC)
    for family, name in (('v4', 'IPv4'), ('v6', 'IPv6')):
        cert = state['gw']['certs'][state['gw']['bindings'][family]]
        expired = parse_iso(cert['notAfter']) <= now
        until = cert['notAfter'][:16].replace('T', ' ')
        put(f'GW-1 certificate on the {name} listener', 'tls', 'expired' if expired else 'valid',
            f"{cert['serial']} · {'expired' if expired else 'valid until'} {until} UTC")
    clients = state['clients']
    put('Customer apps verify certificates', 'clients', 'yes' if clients['validateTls'] else 'no')
    put('Customer apps accept expired certificates', 'clients', 'yes' if clients.get('acceptExpired') else 'no')
    for host, ip in clients['hosts'].items():
        put(f'Customer hosts files pin {host}', 'clients', ip)
    put('Admin console reachable for operators', 'mgmt', 'yes' if state['mgmt']['adminServiceUp'] else 'no')
    put('Devices down', 'nodes', ', '.join(state['failedNodes']) or 'none')
    return facts


def journey_rows(obs: dict[str, Any] | None) -> list[dict[str, Any]]:
    keys = ('id', 'label', 'ok', 'latencyMs', 'detail', 'failedAt', 'failure')
    return [{k: p[k] for k in keys if k in p} for p in (obs or {}).get('probes', []) if p['kind'] == 'journey']


def verify_commands(settings: Settings, topo: dict[str, Any]) -> dict[str, Any]:
    """Read-only commands a sceptic can run against the same prod containers the probes use."""
    def dig(pop: Any, host: str) -> str:
        return f"dig +short +time=1 +tries=1 -b {pop.p2p_pop} @{DNS['primary']} -p {DNS_COLD_PORT} {host}"

    journeys = {}
    for journey in topo['journeys']:
        pop = POPS[next(i for i in range(4) if pop_by_index(topo, i)['id'] == journey['from'])]
        host = journey['host']
        journeys[journey['id']] = (
            f"docker exec {container('prod', pop.container)} sh -c 'curl -sS -o /dev/null -w \"HTTP %{{http_code}} in %{{time_total}}s\\n\" "
            f"--connect-timeout 2 --max-time 4 --cacert /lab/ca.crt --interface {pop.customer} "
            f"--resolve {host}:443:$({dig(pop, host)}) https://{host}/'")
    cert = runtime_dir(settings) / 'prod' / 'gw1' / 'certs' / 'v4.crt'
    with contextlib.suppress(ValueError):
        cert = cert.relative_to(REPO_ROOT)
    devices = [
        {'topic': 'route', 'label': 'Route filter on core router B17', 'command': f"docker exec {container('prod', 'b17')} vtysh -c 'show ip prefix-list EDGE-IN'"},
        {'topic': 'dns', 'label': 'Address DNS-1 returns for svc.demo', 'command': f"docker exec {container('prod', POPS[0].container)} {dig(POPS[0], 'svc.demo')}"},
        {'topic': 'tls', 'label': 'Certificate GW-1 is serving', 'command': f'openssl x509 -noout -subject -enddate -in {cert}'},
    ]
    return {'journeys': journeys, 'devices': devices}


def investigation_closed(issue: dict[str, Any] | None) -> bool:
    if not issue:
        return False
    return issue.get('investigationStatus') in ('finished', 'recovery_required') or (issue['status'] == 'resolved' and not issue.get('incidentId'))


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
        # Referee evidence for the current issue. Never sent to TwinOps.
        self.proof: dict[str, Any] | None = None
        self.recovery = False
        self.recovery_reason: str | None = None
        # In-flight lab operation (memory only): a crash leaves just the persisted quarantine.
        self.activity: dict[str, Any] | None = None
        self.initialized = False
        if path.exists():
            saved = json.loads(path.read_text())
            self.initialized = True
            for name in ('issue', 'history', 'operation', 'recovery', 'recovery_reason', 'proof'):
                setattr(self, name, saved.get(name, getattr(self, name)))
            for attr, value in saved['network'].items():
                setattr(self.network, attr, value)
            if self.operation and self.operation['status'] in ('applying', 'restoring'):
                self.quarantine('The app stopped while an approved change or its rollback was being written.')
            elif self.recovery and not self.recovery_reason:
                self.recovery_reason = 'A lab write did not finish.'

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        data = {name: getattr(self, name) for name in ('issue', 'history', 'operation', 'recovery', 'recovery_reason', 'proof')}
        data['network'] = {name: getattr(self.network, name) for name in
                           ('_declared', '_changes', '_logs', '_hardware', '_baselines', 'writes')}
        temp = self.path.with_suffix('.tmp')
        temp.write_text(json.dumps(data))
        temp.replace(self.path)
        self.initialized = True

    def quarantine(self, reason: str):
        """Persist that device state is uncertain before (or after) a write that may not have finished."""
        self.recovery = True
        self.recovery_reason = reason
        self.save()

    def release(self):
        self.recovery = False
        self.recovery_reason = None
        self.save()

    @contextlib.contextmanager
    def busy(self, kind: str, text: str):
        self.activity = {'kind': kind, 'text': text, 'startedAt': time.time()}
        try:
            yield
        finally:
            self.activity = None

    def step(self, text: str):
        if self.activity:
            self.activity['text'] = text

    def event(self, actor: str, text: str):
        if self.proof is not None:
            self.proof['timeline'].append({'at': time.time(), 'actor': actor, 'text': text})

    async def snapshot(self) -> dict[str, Any]:
        return {'at': self.checked_at, 'journeys': journey_rows(self.observation),
                'facts': device_facts(await self.network.capture_supported(), self.topo)}

    def new_proof(self, fault: str | None, before: dict[str, Any] | None) -> dict[str, Any]:
        return {'fault': fault, 'issueId': None, 'before': before, 'during': None, 'after': None, 'applied': None,
                'timeline': [], 'writesFrom': len(self.network.writes)}

    async def refresh(self):
        previous, previous_at = self.observation, self.checked_at
        obs = await self.network.observe()
        self.observation = obs
        self.checked_at = time.time()
        journeys = [p for p in obs['probes'] if p['kind'] == 'journey']
        failed = [p for p in journeys if not p['ok']]
        if failed and not self.issue:
            self.issue = {'id': uuid.uuid4().hex, 'detectedAt': self.checked_at, 'status': 'open', 'incidentId': None,
                          'title': f"Service disruption · {len(failed)} journeys failing", 'failedJourneys': [p['id'] for p in failed]}
            if not self.proof or self.proof['issueId']:
                # Not started from the exercise panel: only the last healthy probe results are known.
                self.proof = self.new_proof(None, {'at': previous_at, 'journeys': journey_rows(previous), 'facts': None} if previous else None)
            self.proof['issueId'] = self.issue['id']
            self.proof['during'] = await self.snapshot()
            self.event('Metro monitoring', f'Live probes: {len(failed)} of {len(journeys)} customer journeys failing. Issue opened; TwinOps checks for new issues every 5 seconds.')
            self.save()
        elif failed and self.issue and self.issue['status'] == 'resolved':
            self.issue['status'] = 'open'
            self.issue.pop('resolvedAt', None)
            if self.proof:
                self.proof['after'] = None
            self.event('Metro monitoring', f'Live probes: {len(failed)} of {len(journeys)} customer journeys failing again.')
            self.save()
        elif self.issue and not failed and self.issue['status'] != 'resolved':
            self.issue['status'] = 'resolved'
            self.issue['resolvedAt'] = self.checked_at
            if self.proof:
                self.proof['after'] = await self.snapshot()
            self.event('Metro monitoring', f'Live probes: all {len(journeys)} customer journeys succeed again.')
            self.save()
        self.ready = True
        self.error = None

    async def poll(self):
        while True:
            try:
                # Probes against a lab without its links would report a fake outage and start a pointless investigation.
                status = await lab_status(self.settings, ('prod',))
                if not status['ready']:
                    raise LabError(status['detail'])
                async with self.lock:
                    if not self.initialized:
                        await self.network.prepare()
                        self.save()
                    await self.refresh()
            except Exception as exc:
                self.ready = False
                self.error = str(exc)[:300] if isinstance(exc, LabError) else f'{type(exc).__name__}: {exc}'[:250]
            await asyncio.sleep(5)

    def dashboard(self, public: bool = True):
        # The connector keeps the raw quarantine flag; people see an in-flight write as progress, not as a failure.
        in_flight = public and self.activity is not None
        data = {'name': 'Metro Network', 'ready': self.ready, 'error': self.error, 'checkedAt': self.checked_at,
                'backend': 'Containerlab · FRR / CoreDNS / nginx', 'observation': self.observation,
                'topology': self.topo, 'issue': self.issue, 'history': self.history[-50:], 'recoveryRequired': self.recovery and not in_flight,
                'recoveryReason': None if in_flight else self.recovery_reason, 'activity': dict(self.activity) if self.activity else None,
                'busy': self.lock.locked(), 'operation': self.operation['status'] if self.operation else None,
                'twinopsUrl': os.environ.get('TWINOPS_UI_URL', 'http://localhost:5173')}
        if public:
            data['proof'] = self.public_proof()
            data['verify'] = verify_commands(self.settings, self.topo)
        return data

    def public_proof(self) -> dict[str, Any] | None:
        if not self.proof:
            return None
        fault = self.proof['fault']
        sealed = bool(fault) and not investigation_closed(self.issue)
        out = {k: v for k, v in self.proof.items() if k not in ('fault', 'writesFrom')}
        out.update(fromExercise=bool(fault), sealed=sealed, fault=None if sealed or not fault else {'id': fault, **FAULT_INFO[fault]},
                   writes=[{'actor': w['actor'], 'summary': w['summary']} for w in self.network.writes[self.proof['writesFrom']:]])
        return out

    def require_claim(self, incident_id: str):
        if not self.issue or self.issue.get('incidentId') != incident_id or self.issue.get('investigationStatus') in ('finished', 'recovery_required'):
            raise HTTPException(409, 'This investigation does not own the current issue')

    def can_replace_issue(self) -> bool:
        issue = self.issue
        return bool(issue) and issue['status'] == 'resolved' and (not issue.get('incidentId') or issue.get('investigationStatus') == 'finished')

    async def restore_baseline(self):
        """Return the devices to the healthy baseline, then archive the current issue. Caller holds the lock."""
        self.quarantine('Restoring the healthy baseline did not finish.')
        network = LabDemoNetwork(self.network.inst, self.topo, 7)
        await network.prepare()
        self.network = network
        # Archive only after success: a retried reset must not duplicate the history entry.
        if self.issue:
            archived = copy.deepcopy(self.issue)
            if archived['status'] != 'resolved':
                archived.update(status='reset', resetAt=time.time())
            if self.proof and self.proof.get('fault'):
                archived['fault'] = FAULT_INFO[self.proof['fault']]['label']
            self.history.append(archived)
        self.issue = None
        self.operation = None
        self.proof = None
        self.release()


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

    @app.exception_handler(LabError)
    async def lab_failure(request: Request, exc: LabError):
        return JSONResponse({'detail': f'The lab did not respond as expected: {str(exc)[:240]}'}, status_code=503)

    @app.exception_handler(Exception)
    async def unexpected_failure(request: Request, exc: Exception):
        return JSONResponse({'detail': f'Unexpected error ({type(exc).__name__}). The lab state is retained for inspection.'}, status_code=500)

    @app.middleware('http')
    async def local_boundary(request: Request, call_next):
        origin = request.headers.get('origin')
        if request.method != 'GET' and origin and urlsplit(origin).netloc != request.headers.get('host'):
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
            replaced = bool(state.issue)
            with state.busy('fault', 'Restoring the healthy baseline' if replaced else 'Measuring the healthy baseline'):
                if replaced:
                    await state.restore_baseline()
                    state.step('Measuring the healthy baseline')
                if replaced or not state.observation or time.time() - (state.checked_at or 0) > 15:
                    await state.refresh()
                if state.issue:
                    raise HTTPException(409, 'Customer journeys are already failing; resolve that issue first')
                # The fault name stays in this app: it is never part of the issue or connector payloads.
                state.proof = state.new_proof(body.fault, await state.snapshot())
                state.event('You (exercise panel)', 'Introduced one fault on the live devices. TwinOps is not told which one.')
                state.step('Introducing the fault on the live devices')
                # Persist intent before a device write: an interrupted fault injection is uncertain too.
                state.quarantine('Introducing the fault did not finish.')
                await state.network.inject_fault(body.fault)
                state.step('Measuring customer impact')
                await state.refresh()
                state.release()
            return state.dashboard()

    @app.post('/api/reset')
    async def reset(body: ResetRequest | None = None):
        async with state.lock:
            if state.issue and state.issue.get('investigationStatus') == 'investigating':
                raise HTTPException(409, 'Wait for the investigation or reject its pending approval before resetting')
            if state.recovery and not (body and body.operatorRecovery):
                raise HTTPException(409, 'Operator recovery required: confirm a recovery reset to re-push and verify the healthy baseline')
            with state.busy('reset', 'Restoring and verifying the healthy baseline'):
                await state.restore_baseline()
                state.step('Measuring customer journeys')
                await state.refresh()
            return state.dashboard()

    auth = [Depends(connector_auth)]

    @app.get('/api/connector', dependencies=auth)
    async def connector():
        return {**state.dashboard(public=False), 'topology': state.topo}

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
            state.event('TwinOps', f'Picked up the issue on its own ({body.incidentId}) and started reproducing it in its separate twin network.')
            state.save()
            return {'issue': state.issue}

    @app.post('/api/issues/{issue_id}/finish', dependencies=auth)
    async def finish(issue_id: str, body: FinishRequest):
        async with state.lock:
            if not state.issue or state.issue['id'] != issue_id or state.issue.get('incidentId') != body.incidentId:
                raise HTTPException(409, 'Issue mismatch')
            if body.status == 'recovery_required':
                state.quarantine('TwinOps could not verify its change or the rollback.')
            if state.issue.get('investigationStatus') == 'investigating':
                state.event('TwinOps', 'Reported that an operator must recover the lab.' if state.recovery
                            else 'Closed its investigation.' if state.operation else 'Closed its investigation without changing the network.')
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
                if state.proof is not None:
                    state.proof['applied'] = {
                        'at': time.time(), 'label': body.change['label'], 'rationale': body.change['rationale'], 'hash': body.change['hash'][:12],
                        'steps': [{'title': CATALOGUE[s['action']].title, 'target': s['target'], 'command': describe_step(s)} for s in body.change['steps']]}
                state.event('Apply gateway', f"A person approved “{body.change['label']}” in TwinOps. The gateway verified the approval and that the devices had not changed since, then applied it.")
                state.save()
                return {'previous': previous, 'writes': state.network.writes}
            except BaseException:
                state.quarantine('An approved change did not finish applying.')
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
                state.quarantine('A rollback did not finish or could not be verified.')
                with state.busy('rollback', 'Rolling back the approved change'):
                    await state.network.restore(op['previous'], body.approvalToken)
                    if await state.network.state_hash() != stable_hash(op['previous']):
                        raise HTTPException(409, 'Rollback verification failed')
                op['status'] = 'restored'
                if state.proof and state.proof['applied']:
                    state.proof['applied']['rolledBack'] = True
                state.event('Apply gateway', 'Rolled the change back. Device state verified identical to the snapshot taken before the change.')
                state.release()
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
