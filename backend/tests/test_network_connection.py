"""Contract tests use a deterministic device double; live Containerlab rehearsal is separate."""
import asyncio
import copy
from unittest.mock import AsyncMock

import httpx

from twinops.catalogue import apply_change_set, change_set
from twinops.config import Settings
from twinops.lab.backend import LabDemoNetwork, stable_hash
from twinops.lab.runner import LabError, Result
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

    async def diagnostic(self, kind, journey_id):
        from twinops.harness import ModelDemoNetwork
        model = ModelDemoNetwork(self.topo, 7)
        model._state = copy.deepcopy(self._declared)
        return await model.diagnostic(kind, journey_id)

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


def test_exercise_availability_stays_stable_during_read_only_monitoring(tmp_path):
    async def run():
        _, _, state, client = fixture(tmp_path)
        async with client:
            await state.refresh()
            idle = {'canInject': True, 'canReset': False}
            assert state.dashboard()['exercise'] == idle
            # Monitoring holds the same device lock as writes, but is not an operator operation.
            async with state.lock:
                assert (await client.get('/api/dashboard')).json()['exercise'] == idle
            state.issue = {'id': 'previous', 'status': 'resolved', 'incidentId': 'inc-previous', 'investigationStatus': 'finished'}
            async with state.lock:
                assert (await client.get('/api/connector')).json()['exercise'] == {'canInject': True, 'canReset': True}
                with state.busy('reset', 'Restoring and verifying the healthy baseline'):
                    assert state.dashboard()['exercise'] == {'canInject': False, 'canReset': False}
            state.issue['investigationStatus'] = 'investigating'
            assert state.dashboard()['exercise'] == {'canInject': False, 'canReset': False}
            state.issue['investigationStatus'] = 'finished'
            for status in ('applying', 'restoring'):
                state.operation = {'status': status}
                assert state.dashboard()['exercise'] == {'canInject': False, 'canReset': False}
            state.operation = None
            state.recovery = True
            assert state.dashboard()['exercise'] == {'canInject': False, 'canReset': False}
    asyncio.run(run())


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


def test_referee_evidence_is_withheld_from_twinops_and_revealed_after_close(tmp_path):
    async def run():
        _, _, state, client = fixture(tmp_path)
        async with client:
            body = await prepare_apply(state, client)
            assert 'proof' not in (await client.get('/api/connector')).json()
            proof = (await client.get('/api/dashboard')).json()['proof']
            assert proof['sealed'] and proof['fault'] is None
            before, during = proof['before']['facts'], proof['during']['facts']
            assert {k for k, fact in during.items() if before.get(k) != fact} == {'DNS-1 answer for svc.demo', 'DNS-1 cached answer for svc.demo'}
            assert all(j['ok'] for j in proof['before']['journeys']) and not all(j['ok'] for j in proof['during']['journeys'])
            assert (await client.post('/api/apply', json=body)).status_code == 200
            await state.refresh()
            finish = {'incidentId': body['incidentId'], 'status': 'finished'}
            assert (await client.post(f"/api/issues/{body['issueId']}/finish", json=finish)).status_code == 200
            proof = (await client.get('/api/dashboard')).json()['proof']
            assert not proof['sealed'] and proof['fault']['id'] == 'dns_failure'
            assert all(j['ok'] for j in proof['after']['journeys'])
            assert {k: f['value'] for k, f in proof['after']['facts'].items()} == {k: f['value'] for k, f in before.items()}
            assert [s['target'] for s in proof['applied']['steps']] == ['DNS-1', 'DNS-1']
            assert [e['actor'] for e in proof['timeline']] == ['You (exercise panel)', 'Metro monitoring', 'TwinOps', 'Apply gateway', 'Metro monitoring', 'TwinOps']
            assert [w['actor'] for w in proof['writes']] == ['harness', 'apply_gateway']
            assert 'approvalToken' not in proof['writes'][1]
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
        monkeypatch.setattr('twinops.network_connector.twin_status', AsyncMock(return_value={'ready': True, 'detail': 'test twin'}))
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
        monkeypatch.setattr('twinops.network_connector.twin_status', AsyncMock(return_value={'ready': True, 'detail': 'test twin'}))
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


def test_failed_reset_is_reported_and_operator_recovery_restores_once(tmp_path, monkeypatch):
    async def run():
        _, _, state, client = fixture(tmp_path)
        attempts = []

        class FlakyDouble(DeviceDouble):
            async def prepare(self):
                attempts.append(1)
                if len(attempts) == 1:
                    raise LabError('demo network not healthy after reset: J1 no answer')

        monkeypatch.setattr('twinops.network_app.LabDemoNetwork', lambda *_: FlakyDouble())
        async with client:
            await state.refresh()
            await client.post('/api/faults', json={'fault': 'dns_failure'})
            failed = await client.post('/api/reset', json={})
            assert failed.status_code == 503 and 'not healthy' in failed.json()['detail']
            assert state.recovery and 'baseline' in state.recovery_reason and state.history == []
            assert (await client.get('/api/dashboard')).json()['recoveryReason'] == state.recovery_reason
            assert (await client.post('/api/reset', json={})).status_code == 409
            assert (await client.post('/api/faults', json={'fault': 'cert_expiry'})).status_code == 409
            recovered = await client.post('/api/reset', json={'operatorRecovery': True})
            assert recovered.status_code == 200, recovered.text
            assert not state.recovery and state.recovery_reason is None and state.issue is None
            assert [h['status'] for h in state.history] == ['reset']
            assert (await client.post('/api/faults', json={'fault': 'cert_expiry'})).status_code == 200
    asyncio.run(run())


def test_monitor_waits_for_a_working_twin(tmp_path, monkeypatch):
    async def run():
        settings, _, state, client = fixture(tmp_path)
        monkeypatch.setattr('twinops.network_connector.twin_status', AsyncMock(return_value={'ready': False, 'detail': 'lab network links lost in twin'}))
        await state.refresh()
        await client.post('/api/faults', json={'fault': 'dns_failure'})
        registry = Registry(settings)
        monitor = NetworkMonitor(registry)
        await monitor.client.client.aclose()
        monitor.client.client = client
        try:
            await monitor.tick()
            assert not registry.incidents and state.issue.get('incidentId') is None
            assert 'twin lab is unavailable' in monitor.status['detail']
        finally:
            await registry.shutdown()
            await monitor.close()
    asyncio.run(run())


def test_lab_status_detects_links_lost_after_a_docker_restart(monkeypatch):
    from twinops.lab import backend

    class Runner:
        async def inspect_states(self, prefix):
            return {f'clab-twinops-{i}-{n}': 'running' for i in ('prod', 'twin') for n in ('b17', 'gw1', 'svc1', 'dns1', 'dns2', 'p0', 'p1', 'p2', 'p3')}

        async def exec(self, name, argv, timeout=10):
            links = '' if name.endswith('prod-b17') else ''.join(f'{n + 1}: eth{n}@if9: <UP> mtu 1500\n' for n in range(1, 9))
            return Result(0, '1: lo: <LOOPBACK,UP> mtu 65536\n' + links, '')

    monkeypatch.setattr(backend, 'DockerRunner', Runner)
    lost = asyncio.run(backend.lab_status(Settings(), ('prod',)))
    assert not lost['ready'] and lost['linksLost'] == ['prod'] and 'twinops.lab up' in lost['detail']
    assert asyncio.run(backend.lab_status(Settings(), ('twin',)))['ready']


def test_in_flight_fault_shows_progress_not_recovery(tmp_path):
    async def run():
        _, network, state, client = fixture(tmp_path)
        seen = {}
        inject = network.inject_fault

        async def observed_inject(fault):
            seen['public'], seen['connector'] = state.dashboard(), state.dashboard(public=False)
            await inject(fault)

        network.inject_fault = observed_inject
        async with client:
            await state.refresh()
            assert (await client.post('/api/faults', json={'fault': 'dns_failure'})).status_code == 200
        assert seen['public']['activity']['text'] == 'Introducing the fault on the live devices'
        assert not seen['public']['recoveryRequired'] and seen['public']['recoveryReason'] is None
        # TwinOps still sees the raw quarantine and will not claim the issue mid-write.
        assert seen['connector']['recoveryRequired']
        assert state.dashboard()['activity'] is None and not state.recovery
        assert [p['failure'] for p in state.dashboard()['proof']['during']['journeys'] if not p['ok']]
    asyncio.run(run())


def test_monitoring_tracks_impact_and_exports_metrics(tmp_path):
    async def run():
        _, _, state, client = fixture(tmp_path)
        async with client:
            body = await prepare_apply(state, client)
            data = (await client.get('/api/dashboard')).json()
            assert 'alarms' not in data
            assert data['impact']['customers'] == 1840 + 940
            assert state.issue['peakCustomers'] == 2780
            assert len(data['telemetry']) >= 2 and None in data['telemetry'][-1]['j'].values()
            kinds = [e['kind'] for e in data['proof']['timeline']]
            assert kinds == ['fault', 'detected', 'claimed']
            metrics = (await client.get('/metrics')).text
            assert 'metro_journey_up{journey="J1",pop="BER",host="svc.demo"} 0' in metrics
            assert 'metro_customers_affected 2780' in metrics and 'metro_incident_open 1' in metrics
            assert 'metro_alarms' not in metrics
            assert (await client.post('/api/apply', json=body)).status_code == 200
            await state.refresh()
            data = (await client.get('/api/dashboard')).json()
            assert data['impact']['customers'] == 0
            assert 'metro_incident_open 0' in (await client.get('/metrics')).text
    asyncio.run(run())


def test_workbench_exercises_preserve_network_guards_and_observation_boundary(tmp_path, monkeypatch):
    from dataclasses import replace

    from twinops.api import create_app

    async def run():
        settings, network, state, remote = fixture(tmp_path)
        settings = replace(settings, require_auth=True, postcheck_interval_s=0)
        monkeypatch.setenv('TWINOPS_VIEWER_TOKEN', 'viewer-test')
        monkeypatch.setenv('TWINOPS_INVESTIGATOR_TOKEN', 'investigator-test')
        monkeypatch.setenv('TWINOPS_OPERATOR_TOKEN', 'approver-test')
        monkeypatch.setattr('twinops.lab.backend.EmulatedTwin', lambda _: ModelTwin())
        monkeypatch.setattr('twinops.network_app.LabDemoNetwork', lambda *_: DeviceDouble())
        monkeypatch.setattr('twinops.network_connector.twin_status', AsyncMock(return_value={'ready': True, 'detail': 'test twin'}))
        app = create_app(settings)
        monitor, registry = app.state.monitor, app.state.registry
        await monitor.client.client.aclose()
        monitor.client.client = remote
        try:
            await state.refresh()
            await monitor.tick()
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://testserver') as api:
                viewer = {'Authorization': 'Bearer viewer-test'}
                investigator = {'Authorization': 'Bearer investigator-test'}
                payload = (await api.get('/api/connections', headers=viewer)).json()
                assert payload['topology'] == state.topo
                assert len(payload['probes']) == len(state.topo['journeys'])
                assert all(p['ok'] for p in payload['probes'])
                assert payload['exercise']['canInject']
                assert not payload['exercise']['canReset']
                assert not {'proof', 'verify', 'fault'} & payload.keys()
                endpoint = '/api/connections/network/fault'
                assert (await api.post(endpoint, json={'fault': 'dns_failure'})).status_code == 401
                assert (await api.post(endpoint, json={'fault': 'dns_failure'}, headers=viewer)).status_code == 403
                assert not network.writes
                assert (await api.post(endpoint, json={'fault': 'unknown'}, headers=investigator)).status_code == 422
                created = await api.post(endpoint, json={'fault': 'dns_failure'}, headers=investigator)
                assert created.status_code == 202, created.text
                assert not created.json()['exercise']['canInject']
                assert len([w for w in network.writes if w['actor'] == 'harness']) == 1
                assert not {'proof', 'verify', 'fault'} & created.json().keys()
                await monitor.tick()
                live = next(iter(registry.incidents.values()))
                assert live.session.sealed_fault == 'external'
                assert monitor.status['issues'][0]['incidentId'] == live.session.incident_id
                await live.task
                assert live.session.status == 'awaiting_approval', live.error
                assert network.applies == 0
                assert (await api.post(endpoint, json={'fault': 'cert_expiry'}, headers=investigator)).status_code == 409
                reset = '/api/connections/network/reset'
                assert (await api.post(reset, json={}, headers=viewer)).status_code == 403
                assert (await api.post(reset, json={}, headers=investigator)).status_code == 409
                await registry.decide(live, 'reviewer', 'Reject before reset', 'reject')
                response = await api.post(reset, json={}, headers=investigator)
                assert response.status_code == 200, response.text
                assert all(p['ok'] for p in response.json()['probes'])
                assert response.json()['exercise']['canInject']
                state.quarantine('Test interrupted operation')
                assert (await api.post(endpoint, json={'fault': 'dns_failure'}, headers=investigator)).status_code == 409
                assert (await api.post(reset, json={}, headers=investigator)).status_code == 409
        finally:
            await registry.shutdown()
            await monitor.close()
    asyncio.run(run())
