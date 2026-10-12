"""Contract tests use a deterministic device double; live Containerlab rehearsal is separate."""
import asyncio
import copy
from unittest.mock import AsyncMock

import httpx

from twinops.catalogue import apply_change_set, change_set
from twinops.config import Settings
from twinops.lab.backend import LabDemoNetwork, stable_hash
from twinops.model import fixed_suite, modelled_alarms, probe_journey
from twinops.network_app import NetworkState, create_network_app
from twinops.network_connector import NetworkMonitor
from twinops.service import Registry
from twinops.topology import build_topology
from twinops.twin import ModelTwin


class DeviceDouble(LabDemoNetwork):
    def __init__(self):
        super().__init__(None, build_topology('core'), 7)
        self.applies = 0
        self.fail_apply = False

    async def prepare(self):
        pass

    async def inject_fault(self, fault):
        from twinops.harness import fault_records
        changes, logs, hardware = fault_records(self.topo, fault, self._rng, self._declared)
        self._changes += changes
        self._logs += logs
        self._hardware += hardware
        self._record('harness', 'injected')

    async def capture_supported(self):
        return copy.deepcopy(self._declared)

    async def observe(self):
        probes = fixed_suite(self._declared, self.topo, self.topo['journeys'])
        alarms = modelled_alarms(self._declared, self.topo, probes)
        return dict(capturedAt=self._declared['now'], stateHash=await self.state_hash(), probes=probes, alarms=alarms,
                    changes=self._changes, logs=self._logs, rawEventCount=len(alarms), baselines=self._baselines)

    async def probe(self, journey_id, family):
        j = next(j for j in self.topo['journeys'] if j['id'] == journey_id)
        return probe_journey(self._declared, self.topo, j, family=family)

    async def apply_approved(self, change, token):
        previous = copy.deepcopy(self._declared)
        self._declared = apply_change_set(previous, change, self.topo)
        self.applies += 1
        self._record('apply_gateway', 'applied', token)
        if self.fail_apply:
            raise RuntimeError('device connection lost after partial apply')
        return previous

    async def restore(self, previous, token):
        self._declared = copy.deepcopy(previous)
        self._record('apply_gateway', 'restored', token)


def fixture(tmp_path):
    settings = Settings(planner='runbook', twin='emulated', network_url='http://127.0.0.1:8010', network_token='test-connector', data_dir=tmp_path / 'evidence')
    network = DeviceDouble()
    state = NetworkState(settings, tmp_path / 'network.json', network)
    app = create_network_app(settings, state)
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://127.0.0.1:8010', headers={'Authorization': 'Bearer test-connector'})
    return settings, network, state, client


def test_network_auth_origin_and_detection(tmp_path):
    async def run():
        _, network, state, client = fixture(tmp_path)
        async with client:
            await state.refresh()
            assert state.issue is None
            assert (await client.get('/api/snapshot', headers={'Authorization': 'wrong'})).status_code == 401
            assert (await client.post('/api/faults', json={'fault': 'dns_failure'}, headers={'Origin': 'https://attacker.example'})).status_code == 403
            assert (await client.post('/api/faults', json={'fault': 'dns_failure'})).status_code == 200
            issue = state.issue['id']
            await state.refresh()
            assert state.issue['id'] == issue
            assert (await client.post('/api/faults', json={'fault': 'cert_expiry'})).status_code == 409
            payload = (await client.get('/api/connector')).json()
            assert 'fault' not in payload['issue']
            assert not all(p['ok'] for p in payload['observation']['probes'])
            assert network.applies == 0
    asyncio.run(run())


async def prepare_apply(state, client):
    await state.refresh()
    await client.post('/api/faults', json={'fault': 'dns_failure'})
    iid = 'inc-test'
    issue = state.issue['id']
    assert (await client.post(f'/api/issues/{issue}/claim', json={'incidentId': iid})).status_code == 200
    change = change_set('fix', 'DNS repair', [
        {'action': 'restore_record', 'target': 'DNS-1', 'params': {'host': 'svc.demo', 'value': '10.40.0.10'}},
        {'action': 'flush_cache', 'target': 'DNS-1', 'params': {'names': ['svc.demo']}},
    ], 'planner', 'Restore the DNS record and flush stale caches')
    return dict(issueId=issue, incidentId=iid, expectedHash=await state.network.state_hash(), approvalToken='approved-token-123456', change=change)


def test_atomic_drift_check_idempotency_and_rollback(tmp_path):
    async def run():
        _, network, state, client = fixture(tmp_path)
        async with client:
            body = await prepare_apply(state, client)
            assert (await client.post('/api/reset', json={})).status_code == 409
            assert (await client.post('/api/apply', json={**body, 'expectedHash': 'stale'})).status_code == 409
            assert network.applies == 0
            before = await network.capture_supported()
            first = await client.post('/api/apply', json=body)
            assert first.status_code == 200, first.text
            assert (await client.post('/api/apply', json=body)).status_code == 200
            assert network.applies == 1
            assert (await client.post('/api/restore', json={'incidentId':'inc-wrong', 'approvalToken':body['approvalToken']})).status_code == 409
            restore = {'incidentId':body['incidentId'], 'approvalToken':body['approvalToken']}
            assert (await client.post('/api/restore', json=restore)).status_code == 200
            assert (await client.post('/api/restore', json=restore)).status_code == 200
            assert await network.state_hash() == stable_hash(before)
    asyncio.run(run())


def test_recovered_scenario_is_replaced_by_the_next_fault(tmp_path, monkeypatch):
    async def run():
        _, _, state, client = fixture(tmp_path)
        monkeypatch.setattr('twinops.network_app.LabDemoNetwork', lambda *_: DeviceDouble())
        async with client:
            body = await prepare_apply(state, client)
            assert (await client.post('/api/apply', json=body)).status_code == 200
            await state.refresh()
            assert state.issue['status'] == 'resolved'
            # The investigation still owns the recovered issue until TwinOps finishes it.
            assert (await client.post('/api/faults', json={'fault': 'cert_expiry'})).status_code == 409
            finish = {'incidentId': body['incidentId'], 'status': 'finished'}
            assert (await client.post(f"/api/issues/{body['issueId']}/finish", json=finish)).status_code == 200
            response = await client.post('/api/faults', json={'fault': 'cert_expiry'})
            assert response.status_code == 200, response.text
            assert state.history[-1]['id'] == body['issueId'] and state.history[-1]['status'] == 'resolved'
            assert state.operation is None
            assert state.issue and state.issue['id'] != body['issueId']
    asyncio.run(run())


def test_interrupted_write_is_quarantined_on_restart(tmp_path):
    async def run():
        settings, network, state, client = fixture(tmp_path)
        async with client:
            body = await prepare_apply(state, client)
            network.fail_apply = True
            try:
                await client.post('/api/apply', json=body)
            except RuntimeError:
                pass
            assert state.recovery
            restarted = NetworkState(settings, state.path, DeviceDouble())
            assert restarted.recovery
            assert restarted.operation['status'] == 'applying'
            assert (await client.post('/api/faults', json={'fault':'dns_failure'})).status_code == 409
            assert (await client.post('/api/reset', json={})).status_code == 409
            assert (await client.post('/api/restore', json={'incidentId':body['incidentId'], 'approvalToken':body['approvalToken']})).status_code == 200
            assert not state.recovery
    asyncio.run(run())


def test_external_monitor_deduplicates_and_applies_over_api(tmp_path, monkeypatch):
    async def run():
        settings, network, state, client = fixture(tmp_path)
        monkeypatch.setattr('twinops.lab.backend.EmulatedTwin', lambda _: ModelTwin())
        await state.refresh()
        await client.post('/api/faults', json={'fault':'route_misconfig'})
        registry = Registry(settings)
        monitor = NetworkMonitor(registry)
        await monitor.client.client.aclose()
        monitor.client.client = client
        try:
            await monitor.tick()
            assert len(registry.incidents) == 1
            live = next(iter(registry.incidents.values()))
            assert live.session.external
            assert live.session.sealed_fault == 'external'
            await live.task
            assert live.session.status == 'awaiting_approval', live.error
            assert live.session.events[0]['kind'] == 'incident_detected'
            assert len([w for w in network.writes if w['actor'] == 'harness']) == 1
            assert network.applies == 0
            await monitor.tick()
            assert len(registry.incidents) == 1
            await registry.decide(live, 'tester', 'contract test', 'approve')
            assert live.session.outcome['status'] == 'applied', live.session.outcome
            assert network.applies == 1
            await state.refresh()
            assert state.issue['status'] == 'resolved'
            await monitor.tick()
            assert len(registry.incidents) == 1
        finally:
            await registry.shutdown()
            await monitor.close()
    asyncio.run(run())


def test_lost_connector_is_reported_without_fabricating_incident(tmp_path):
    async def run():
        settings, _, _, client = fixture(tmp_path)
        registry = Registry(settings)
        monitor = NetworkMonitor(registry)
        monitor.client.call = AsyncMock(side_effect=httpx.ConnectError('offline'))
        monitor.start()
        await asyncio.sleep(.02)
        await monitor.stop()
        assert not monitor.status['connected']
        assert not registry.incidents
        await monitor.close()
        await client.aclose()
    asyncio.run(run())


def test_key_file_and_environment_precedence(tmp_path, monkeypatch):
    path = tmp_path / 'key'
    path.write_text('file-credential\n')
    monkeypatch.delenv('GEMINI_API_KEY', raising=False)
    monkeypatch.delenv('GOOGLE_API_KEY', raising=False)
    monkeypatch.setenv('GEMINI_API_KEY_FILE', str(path))
    assert Settings().gemini_api_key == 'file-credential'
    monkeypatch.setenv('GEMINI_API_KEY', 'environment-credential')
    assert Settings().gemini_api_key == 'environment-credential'


def test_saved_incident_is_not_reinvestigated_after_restart(tmp_path, monkeypatch):
    async def run():
        settings, _, state, client = fixture(tmp_path)
        monkeypatch.setattr('twinops.lab.backend.EmulatedTwin', lambda _: ModelTwin())
        await state.refresh()
        await client.post('/api/faults', json={'fault':'route_misconfig'})
        registry = Registry(settings)
        monitor = NetworkMonitor(registry)
        await monitor.client.client.aclose()
        monitor.client.client = client
        await monitor.tick()
        live = next(iter(registry.incidents.values()))
        await live.task
        assert live.session.status == 'awaiting_approval'
        await registry.shutdown()
        restarted = Registry(settings)
        monitor.registry = restarted
        await monitor.tick()
        assert len(restarted.incidents) == 0
        assert state.issue['investigationStatus'] == 'finished'
        assert restarted.get(live.session.incident_id).recovered
        await monitor.close()
    asyncio.run(run())


def test_management_subnet_can_avoid_existing_docker_networks(monkeypatch):
    from twinops.lab.plan import management_subnets
    monkeypatch.setenv('TWINOPS_LAB_PROD_SUBNET', '10.253.10.0/24')
    assert management_subnets('prod')[0] == '10.253.10.0/24'
