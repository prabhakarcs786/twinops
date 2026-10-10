import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateOne, runControls } from '../../src/engine/evaluation.ts';
import { SUPPORTED_FAULTS } from '../../src/engine/harness.ts';
import { buildProofPack, decide, startIncident } from '../../src/engine/orchestrator.ts';
import { selectChallenges } from '../../src/engine/planner.ts';
import { sha256 } from '../../src/engine/sha256.ts';
import { createContext, evaluateGates, runChallenge, runExperiment } from '../../src/engine/twin.ts';
import type { ChangeSet, FaultId } from '../../src/engine/types.ts';

describe('sha256', () => {
  it('matches the reference digest', () => {
    assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

const EXPECTED_SELECTED: Record<Exclude<FaultId, 'unsupported_link_flap'>, { action: string; verdict: string }> = {
  route_misconfig: { action: 'remove_rule', verdict: 'PASS_UNDER_DEFINED_TESTS' },
  dns_failure: { action: 'restore_record', verdict: 'PASS_UNDER_DEFINED_TESTS' },
  cert_expiry: { action: 'renew_cert', verdict: 'PASS_WITH_WARNINGS' },
};

describe('incident loop', () => {
  it('mixed actions cannot hide missing or failed DNS cache evidence', () => {
    const session = startIncident({ pack: 'core', fault: 'dns_failure', seed: 1 });
    const ctx = createContext(session.run.observation, session.run.topology, session.demo.captureSupported());
    const change: ChangeSet = { id: 'mixed', label: 'Mixed routing and DNS fix', hash: 'test', origin: 'llm', rationale: 'Mixed catalogue actions', steps: [
      { action: 'restart_service', target: 'B17', params: { service: 'bgp' } },
      { action: 'restore_record', target: 'DNS-1', params: { host: 'svc.demo', value: '10.40.0.10' } },
    ] };
    const exp = runExperiment(ctx, change);
    const kinds = selectChallenges(change);
    assert.ok(kinds.includes('warm_cache'));
    assert.ok(kinds.includes('session_continuity'));
    const challenges = kinds.map((kind) => runChallenge(ctx, exp, kind));
    for (const evidence of [challenges, [], null, challenges.filter((c) => c.kind !== 'warm_cache')]) {
      const result = evaluateGates(session.run.reproduction, exp, evidence);
      assert.equal(result.decision, 'rejected');
      assert.equal(result.gates.find((g) => g.id === 'G4')?.status, 'fail');
    }
  });
  for (const fault of SUPPORTED_FAULTS) {
    it(`${fault}: diagnoses, rejects unsafe options and verifies a bounded fix`, () => {
      const session = startIncident({ pack: 'core', fault, seed: 7 });
      const { run } = session;
      const expected = EXPECTED_SELECTED[fault as keyof typeof EXPECTED_SELECTED];
      assert.ok(run.reproduction.passed, 'fault reproduced');
      assert.equal(run.verdict, expected.verdict);
      assert.equal(run.selected?.change.steps[0].action, expected.action);
      assert.equal(run.selected?.change.origin, 'revision', 'a challenge forced a revision');
      assert.equal(run.writesDuringDiagnosis, 0);
      const unsafe = run.candidates.find((c) => c.change.origin === 'evaluation_case');
      assert.equal(unsafe?.decision, 'rejected');
      assert.ok(unsafe?.restored, 'the unsafe case is tempting: it does restore connectivity');

      const events = decide(session, 'test-operator', 'evidence reviewed', 'approve');
      assert.equal(session.outcome?.status, 'applied', events.map((e) => e.summary).join('\n'));
      assert.ok(session.outcome?.postChecks.every((p) => p.ok));
      const pack = buildProofPack(session);
      assert.equal(pack.production_writes_during_diagnosis, 0);
      assert.equal(pack.approval?.operator, 'test-operator');
    });
  }

  it('unsupported fault stops as INCONCLUSIVE without experiments', () => {
    const { run } = startIncident({ pack: 'core', fault: 'unsupported_link_flap', seed: 3 });
    assert.equal(run.verdict, 'INCONCLUSIVE');
    assert.equal(run.candidates.length, 0);
    assert.equal(run.hypotheses[0].type, 'physical_link_degradation');
  });

  it('planner never sees the fault label', () => {
    const { run } = startIncident({ pack: 'core', fault: 'dns_failure', seed: 11 });
    assert.doesNotMatch(JSON.stringify(run.observation), /dns_failure|route_misconfig|cert_expiry/);
  });
});

describe('evaluation harness', () => {
  it('meets the roadmap targets over 3 faults × 10 seeds', () => {
    const scores = SUPPORTED_FAULTS.flatMap((fault) => Array.from({ length: 10 }, (_, i) => evaluateOne(fault, i + 1)));
    assert.equal(scores.filter((s) => s.top3).length, scores.length);
    assert.equal(scores.reduce((n, s) => n + s.unsafePassed, 0), 0);
    assert.equal(scores.reduce((n, s) => n + s.prodWrites, 0), 0);
    assert.ok(scores.filter((s) => s.verdictOk).length >= 27);
  });

  it('every adverse control behaves as expected', () => {
    for (const control of runControls()) assert.ok(control.ok, `${control.id} ${control.name}: ${control.observed}`);
  });
});
