// Dumps TS engine results so the Python backend can prove behavioural parity. Run: node tests/engine/dump-parity.ts > ../backend/tests/fixtures/ts_parity.json
import { startIncident } from '../../src/engine/orchestrator.ts';
import type { FaultId } from '../../src/engine/types.ts';

const faults: FaultId[] = ['route_misconfig', 'dns_failure', 'cert_expiry', 'unsupported_link_flap'];
const out = [];
for (const pack of ['core', 'enterprise'] as const) {
  for (const fault of faults) {
    for (const seed of [1, 2, 3, 7, 42]) {
      const { run } = startIncident({ pack, fault, seed });
      out.push({
        pack,
        fault,
        seed,
        snapshotHash: run.snapshotHash,
        verdict: run.verdict,
        selected: run.selected?.change.label ?? null,
        selectedHash: run.selected?.change.hash ?? null,
        hypotheses: run.hypotheses.map((h) => [h.type, h.score, h.supporting, h.contradicting]),
        candidates: run.candidates.map((c) => [c.change.id, c.decision, c.gates.map((g) => g.status).join(''), c.latencyDeltaMs]),
        reproduction: [run.reproduction.matched, run.reproduction.total, run.reproduction.slice],
        alarms: run.observation.alarms.map((a) => [a.id, a.count]),
        changes: run.observation.changes.map((c) => [c.id, c.minutesAgo]),
        logs: run.observation.logs.map((l) => l.text),
        probes: run.observation.probes.map((p) => [p.id, p.ok, p.failure ?? null, p.detail]),
        kinds: run.events.map((e) => e.kind),
      });
    }
  }
}
console.log(JSON.stringify(out));
