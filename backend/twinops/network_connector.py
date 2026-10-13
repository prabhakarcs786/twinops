"""HTTP adapter for the independently running Metro Network app."""
from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Any
from urllib.parse import urlsplit

import httpx

from .config import Settings

log = logging.getLogger('twinops.connector')


async def twin_status(settings: Settings) -> dict[str, Any]:
    from .lab.backend import lab_status

    return await lab_status(settings, ('twin',))


class NetworkClient:
    def __init__(self, settings: Settings):
        url = settings.network_url or ''
        parts = urlsplit(url)
        if parts.scheme != 'http' or parts.hostname not in ('localhost', '127.0.0.1') or parts.username or parts.password or parts.query or parts.fragment:
            raise ValueError('The local network connector requires an http://localhost or http://127.0.0.1 URL')
        if not settings.network_token:
            raise ValueError('TWINOPS_NETWORK_TOKEN is required for the network connector')
        self.client = httpx.AsyncClient(base_url=url, headers={'Authorization': f'Bearer {settings.network_token}'}, timeout=120, trust_env=False)

    async def call(self, path: str, body: dict | None = None):
        response = await self.client.get(path) if body is None else await self.client.post(path, json=body)
        response.raise_for_status()
        return response.json()

    async def close(self):
        await self.client.aclose()


class RemoteNetwork:
    backend = 'emulated'

    def __init__(self, client: NetworkClient, issue_id: str, incident_id: str):
        self.client = client
        self.issue_id = issue_id
        self.incident_id = incident_id
        self.writes: list[dict[str, Any]] = []
        self.expected_hash = ''
        self.finish_status = 'finished'

    async def inject_fault(self, fault: str):
        raise RuntimeError('TwinOps cannot inject faults into the connected application')

    async def observe(self):
        result = await self.client.call('/api/observation')
        self.writes = result['writes']
        return result['observation']

    async def capture_supported(self):
        result = await self.client.call('/api/snapshot')
        self.writes = result['writes']
        return result['state']

    async def state_hash(self):
        result = await self.client.call('/api/snapshot')
        self.expected_hash = result['stateHash']
        return self.expected_hash

    async def probe(self, journey_id: str, family: str):
        from urllib.parse import quote
        return await self.client.call(f'/api/probes/{quote(journey_id, safe="")}?family={family}')

    async def simulate_drift(self):
        raise ValueError('Drift injection is unavailable on a connected application')

    async def apply_approved(self, cs: dict, token: str):
        result = await self.client.call('/api/apply', {'issueId': self.issue_id, 'incidentId': self.incident_id,
                                                     'expectedHash': self.expected_hash, 'approvalToken': token, 'change': cs})
        self.writes = result['writes']
        return result['previous']

    async def restore(self, previous: dict, token: str):
        result = await self.client.call('/api/restore', {'incidentId': self.incident_id, 'approvalToken': token})
        self.writes = result['writes']

    async def close(self):
        await self.client.call(f'/api/issues/{self.issue_id}/finish', {'incidentId': self.incident_id, 'status': self.finish_status})


class NetworkMonitor:
    def __init__(self, registry):
        self.registry = registry
        self.client = NetworkClient(registry.settings)
        self.task: asyncio.Task | None = None
        self.status: dict[str, Any] = {'configured': True, 'connected': False, 'name': 'Metro Network', 'detail': 'Connecting to local application', 'issues': []}

    async def tick(self):
        remote = await self.client.call('/api/connector')
        issue = remote.get('issue')
        probes = (remote.get('observation') or {}).get('probes', [])
        self.status.update(connected=True, ready=remote['ready'], detail=remote.get('error') or 'Automatic detection active · checked every 5 seconds',
                           url=self.registry.settings.network_url, checkedAt=remote.get('checkedAt'),
                           recoveryRequired=remote['recoveryRequired'] and not remote.get('activity'),
                           operation=remote.get('operation'),
                           journeys=[{'id': p['id'], 'label': p['label'], 'ok': p['ok']} for p in probes if p.get('kind') == 'journey'],
                           issues=([issue] if issue else []) + list(reversed(remote.get('history', []))))
        if not issue or not remote['ready'] or remote['recoveryRequired'] or issue['status'] == 'resolved':
            return
        iid = issue.get('incidentId') or f"inc-net-{issue['id']}"
        existing = self.registry.get(iid)
        if existing:
            if existing.recovered or existing.finished:
                status = 'recovery_required' if existing.session.status == 'recovery_required' else 'finished'
                if issue.get('investigationStatus') != status:
                    await self.client.call(f"/api/issues/{issue['id']}/finish", {'incidentId': iid, 'status': status})
            return
        if issue.get('incidentId'):
            # Evidence is missing or another TwinOps instance owns the issue. Never automatically rerun it.
            self.status['detail'] = 'Issue already assigned; retained investigation evidence is required'
            return
        if self.registry._lab_lock.locked():
            return
        # A twin without its links fails every experiment and would escalate a fixable issue.
        twin = await twin_status(self.registry.settings)
        if not twin['ready']:
            self.status['detail'] = f"Not investigating yet: the twin lab is unavailable ({twin['detail']})"
            return
        await self.registry.create_external(self.client, issue, remote['topology'], iid)

    async def run(self):
        while True:
            try:
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.status.update(connected=False, detail=f'Connection unavailable ({type(exc).__name__}); retrying automatically')
                log.warning('Network connector: %s', type(exc).__name__)
            await asyncio.sleep(5)

    def start(self):
        self.task = asyncio.create_task(self.run())

    async def stop(self):
        if self.task:
            self.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.task

    async def close(self):
        await self.client.close()
