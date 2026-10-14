"""Incident loop: break → observe → diagnose → reproduce → experiment → challenge → gate → approve → apply."""

from __future__ import annotations

import asyncio
import copy
import secrets
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol

from .approvals import refusal, sign
from .catalogue import CATALOGUE_VERSION, POLICY_VERSION, describe_step
from .coverage import adequacy
from .evidence import capture_snapshot, provenance
from .hashing import short_hash
from .investigation import investigate
from .lifecycle import transition
from .lifecycle import view as lifecycle_view
from .model import healthy_state, sample_journey
from .planner.base import Planner, guard_untrusted
from .planner.runbook import evaluation_case
from .topology import Topology, pops
from .twin import Twin, create_context, evaluate_gates, regression_text, reproduce, run_experiment

ENGINE_VERSION = "twinops-backend-0.3.0"
MAX_CANDIDATES = 4
MAX_REVISIONS = 2

VERDICT_LABEL = {
    "PASS_UNDER_DEFINED_TESTS": "PASS UNDER DEFINED TESTS",
    "PASS_WITH_WARNINGS": "PASS WITH WARNINGS",
    "REJECTED": "REJECTED",
    "INCONCLUSIVE": "INCONCLUSIVE",
    "ESCALATE": "ESCALATE",
}

Emit = Callable[[dict[str, Any]], Awaitable[None]]


class DemoNetwork(Protocol):
    backend: str
    topo: Topology
    writes: list[dict[str, Any]]

    async def inject_fault(self, fault: str) -> None: ...
    async def observe(self) -> dict[str, Any]: ...
    async def state_hash(self) -> str: ...
    async def capture_supported(self) -> dict[str, Any]: ...
    async def probe(self, journey_id: str, family: str) -> dict[str, Any]: ...
    async def simulate_drift(self) -> None: ...
    async def apply_approved(self, cs: dict[str, Any], token: str) -> dict[str, Any]: ...
    async def restore(self, previous: dict[str, Any], token: str) -> None: ...
    async def close(self) -> None: ...


def idle_frame(topo: Topology) -> dict[str, Any]:
    healthy = healthy_state(topo)
    return {
        "phase": "idle",
        "prod": {"probes": {j["id"]: sample_journey(healthy, topo, j) for j in topo["journeys"]}, "alarmNodes": [], "status": "healthy"},
        "twin": None,
        "hypotheses": [],
        "candidates": [],
        "counters": {"experiments": 0, "revisions": 0, "unsafeRejected": 0, "probesRun": 0, "challengesRun": 0, "productionWritesDuringDiagnosis": 0},
    }


class Recorder:
    """Builds events with full UI frames. With pace > 0, events are spaced for human viewing (never faster than real work)."""

    def __init__(self, frame: dict[str, Any], demo: DemoNetwork, emit: Emit | None, pace: float, t0: float, sink: list[dict[str, Any]], seq: int = 0, session: Any = None) -> None:
        self.frame = copy.deepcopy(frame)
        self.demo = demo
        self.emit = emit
        self.pace = pace
        self.t0 = t0
        self.pace_base = time.monotonic()
        self.seq = seq
        self.nominal = 0.0
        self.sink = sink
        self.session = session

    async def push(self, delay: float, kind: str, phase: str, actor: str, tone: str, title: str, summary: str, raw: Any,
                   mutate: Callable[[dict[str, Any]], None] | None = None) -> dict[str, Any]:
        self.nominal += delay
        if self.pace > 0:
            wait = self.pace_base + self.nominal / 1000 / self.pace - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
        if mutate:
            mutate(self.frame)
        self.frame["phase"] = phase
        self.frame["counters"]["productionWritesDuringDiagnosis"] = sum(1 for w in self.demo.writes if w["actor"] != "harness" and not w.get("approvalToken"))
        self.seq += 1
        event = {"seq": self.seq, "at": round((time.monotonic() - self.t0) * 1000), "kind": kind, "phase": phase, "actor": actor, "tone": tone,
                 "title": title, "summary": summary, "raw": raw, "frame": copy.deepcopy(self.frame)}
        self.sink.append(event)
        if self.session:
            event["lifecycle"] = lifecycle_view(self.session)
        if self.emit:
            await self.emit(event)
        return event


def _by_id(probes: list[dict[str, Any]]) -> dict[str, Any]:
    return {p["id"]: p for p in probes}


def _upsert(frame: dict[str, Any], summary: dict[str, Any]) -> None:
    for i, c in enumerate(frame["candidates"]):
        if c["id"] == summary["id"]:
            frame["candidates"][i] = summary
            return
    frame["candidates"].append(summary)


def untested_conditions(topo: Topology, repro: dict[str, Any], unsupported_challenges: list[str], twin_backend: str) -> list[str]:
    outside = [p for p in pops(topo) if p["id"] not in repro["slice"]]
    fidelity = ("Vendor OS behaviour beyond the modelled routing, DNS and TLS functions (model twin)." if twin_backend == "model"
                else "Behaviour beyond the emulated lab images (FRR, CoreDNS, nginx on Linux containers) — not production vendor hardware.")
    return [
        fidelity,
        "Routing convergence timing and transient packet loss during the change.",
        ("Load above the model's ×3 surge assumption." if twin_backend == "model" else
         "Production traffic volume and long-lived session continuity; the lab tests tripled probe concurrency and derives session impact from configuration."),
        "Concurrent faults other than the tested secondary failure.",
        "Physical layer: optics, CRC errors and link flaps are outside twin fidelity.",
        *([f"Journeys from {', '.join(p['short'] for p in outside)} were outside the twin slice and not individually tested."] if outside else []),
        *([f"Challenges not executable on this twin backend: {', '.join(unsupported_challenges)}."] if unsupported_challenges else []),
    ]


@dataclass
class IncidentSession:
    incident_id: str
    sealed_fault: str
    demo: DemoNetwork
    twin: Twin
    planner: Planner
    pace: float
    external: bool = False
    run: dict[str, Any] = field(default_factory=dict)
    events: list[dict[str, Any]] = field(default_factory=list)
    approval: dict[str, Any] | None = None
    outcome: dict[str, Any] | None = None
    narrative: dict[str, Any] | None = None
    status: str = "running"
    t0: float = field(default_factory=time.monotonic)
    recall: Callable[[dict[str, Any]], list[dict[str, Any]]] | None = None
    exercise: str = "none"
    approval_key: bytes = field(default_factory=lambda: secrets.token_bytes(32), repr=False)
    approval_ttl_s: float = 900
    apply_enabled: bool = True
    apply_policy: Callable[[], bool] | None = None
    postcheck_samples: int = 1
    postcheck_interval_s: float = 0


async def _planner_notes(rec: Recorder, planner: Planner, actor: str) -> None:
    for note in planner.drain_notes():
        await rec.push(300, "planner_note", rec.frame["phase"], actor, note.get("tone", "ai"), note["title"], note["summary"], note.get("raw"))


MODEL_ROLES = {"diagnose": "ranking root-cause hypotheses", "propose": "proposing typed fixes", "challenge": "choosing adverse challenges",
               "revise": "revising a fix after a failed challenge", "narrate": "drafting the approver briefing"}


def _announce_model_calls(rec: Recorder, planner: Planner) -> None:
    """Live status while a model call is in flight; local models can take tens of seconds per call."""
    if not hasattr(planner, "on_call"):
        return

    async def announce(role: str) -> None:
        model = getattr(planner, "model", "model")
        await rec.push(0, "model_call", rec.frame["phase"], "challenge" if role == "challenge" else "diagnosis", "ai", f"{model} is reasoning",
                       f"{MODEL_ROLES.get(role, role)} · {getattr(planner, 'provider', 'llm')}:{model}",
                       {"role": role, "provider": getattr(planner, "provider", None), "model": model})

    planner.on_call = announce  # type: ignore[attr-defined]


async def run_incident(session: IncidentSession, pack_topo: Topology, seed: int, emit: Emit | None = None, include_evaluation_case: bool = True) -> dict[str, Any]:
    """Runs the investigation up to the human gate. Never writes to the demo network."""
    started = time.monotonic()
    topo = pack_topo
    demo, twin, planner = session.demo, session.twin, session.planner
    rec = Recorder(idle_frame(topo), demo, emit, session.pace, session.t0, session.events, session=session)
    push = rec.push
    _announce_model_calls(rec, planner)
    versions = {"engine": ENGINE_VERSION, "topology": topo["version"], "catalogue": CATALOGUE_VERSION, "policy": POLICY_VERSION, "planner": planner.version,
                "twin": twin.backend}

    if not session.external:
        await demo.inject_fault(session.sealed_fault)
    obs, captured, snapshot = await capture_snapshot(demo)
    failing = [p for p in obs["probes"] if p["kind"] == "journey" and not p["ok"]]

    def prod_frame(f: dict[str, Any]) -> None:
        f["prod"] = {"probes": _by_id([p for p in obs["probes"] if p["kind"] == "journey"]), "alarmNodes": list(dict.fromkeys(a["node"] for a in obs["alarms"])), "status": "incident"}

    await push(0, "incident_detected" if session.external else "fault_injected", "observe" if session.external else "break",
               "observer" if session.external else "harness", "fail", "Connected application incident detected" if session.external else "Network broken — fault label sealed",
               f"{len(failing)} of {len(topo['journeys'])} customer journeys failing. TwinOps receives observations only, never the fault label.",
               {"harness": demo.writes[0] if demo.writes else None, "sealed": True, "network": demo.backend}, prod_frame)
    await push(2200, "observed", "observe", "observer", "prod", "Read-only snapshot captured",
               f"{obs['rawEventCount']} raw events aggregated into {len(obs['alarms'])} alarms · {len(obs['changes'])} change records · state {short_hash(obs['stateHash'])}", obs)

    guarded = guard_untrusted(obs["logs"])
    flagged = [g for g in guarded if g["flagged"]]
    await push(2600, "guard", "observe", "guard", "warn" if flagged else "info",
               "Instruction-like text quarantined" if flagged else "Untrusted text scanned",
               f"{len(flagged)} log line tried to instruct the agent. It is kept as evidence data and cannot select tools, skip tests or change policy." if flagged
               else "No instruction-like content in logs.",
               {"flagged": flagged, "policy": "logs are data; tool selection is restricted to the typed catalogue"})

    memory = session.recall(obs) if session.recall else []
    if session.recall:
        await push(0, "memory_recalled", "observe", "observer", "info", "Past evidence checked",
                   f"{len(memory)} matching, successfully applied fix found. Any historical fix must pass today's gates." if memory
                   else "No compatible, successfully applied fix matches these observed symptoms.",
                   {"matches": memory, "basis": "Observed failure signals, not the sealed fault label. Similarity is not confidence."})

    async def diagnostic_event(step: dict) -> None:
        await push(0, "diagnostic_collected", "diagnose", "observer", "info", step["question"], step["evidence"]["detail"], step)

    hypotheses, diagnostics, investigation = await investigate(demo, planner, obs, topo, guarded, snapshot, diagnostic_event)
    await _planner_notes(rec, planner, "diagnosis")

    def set_hyps(f: dict[str, Any]) -> None:
        f["hypotheses"] = hypotheses

    top = hypotheses[0]
    await push(1400, "hypotheses", "diagnose", "diagnosis", "ai", f"{len(hypotheses)} ranked hypotheses", f"H1 · {top['title']}. {top['rationale']}.",
               {"hypotheses": hypotheses, "diagnostics": diagnostics, "planner": planner.mode}, set_hyps)

    ctx = create_context(obs, topo, captured)
    coverage = adequacy(obs, topo, ctx.slice, twin.backend)
    if coverage["adequate"]:
        await twin.load(ctx)

    def twin_building(f: dict[str, Any]) -> None:
        f["twin"] = {"slice": ctx.slice, "probes": {}, "failedNodes": [], "focus": [], "caption": "Loading captured state…", "state": "building"}

    await push(3000, "twin_ready", "reproduce", "twin", "twin", "Twin slice created",
               f"{len(ctx.slice)} of {len(topo['nodes'])} nodes · {topo['version']} · {twin.backend} twin · captured state {short_hash(obs['stateHash'])}. Production stays read-only.",
               {"slice": ctx.slice, "journeys": [j["id"] for j in ctx.journeys], "capturedHash": obs["stateHash"], "backend": twin.backend}, twin_building)

    repro = await reproduce(ctx, twin)
    if not investigation["sufficient"]:
        repro["passed"] = False
        repro["mismatches"].append(investigation["stopReason"])

    def twin_repro(f: dict[str, Any]) -> None:
        f["twin"] = {**f["twin"], "probes": _by_id([p for p in repro["twinProbes"] if p["kind"] == "journey"]),
                     "caption": "Fault reproduced" if repro["passed"] else "Reproduction failed", "state": "reproduced" if repro["passed"] else "not_reproduced"}

    await push(2600, "reproduced" if repro["passed"] else "not_reproduced", "reproduce", "twin", "ok" if repro["passed"] else "fail",
               "Fault reproduced in twin" if repro["passed"] else "Fault NOT reproduced in twin",
               f"{repro['matched']}/{repro['total']} symptoms match, including every affected journey. {len(repro['outOfScope'])} hardware alarms are outside twin fidelity."
               if repro["passed"] else f"{repro['matched']}/{repro['total']} symptoms match. {repro['mismatches'][0] if repro['mismatches'] else ''}. Without reproduction no fix can be verified.",
               repro, twin_repro)

    records: list[dict[str, Any]] = []
    unsupported_challenges = sorted(set(["dual_stack", "secondary_failure", "surge_x3", "warm_cache", "session_continuity"]) - twin.supported_challenges)
    if repro["passed"]:
        proposals = await planner.propose(top, captured, obs, topo, twin.supported_actions)
        await _planner_notes(rec, planner, "diagnosis")
        queue: list[dict[str, Any]] = [*[match["candidate"] for match in memory],
                          *proposals[: MAX_CANDIDATES - (1 if include_evaluation_case else 0)]]
        if include_evaluation_case:
            unsafe = evaluation_case(top, obs, topo)
            if unsafe and all(s["action"] in twin.supported_actions for s in unsafe["steps"]):
                queue.append(unsafe)
        revisions = 0
        while queue:
            change = queue.pop(0)
            exp = await run_experiment(ctx, twin, change)
            forbidden = bool(exp.forbidden)
            base = {"id": change["id"], "label": change["label"], "origin": change["origin"], "forbidden": forbidden}
            restored_count = sum(1 for jid in ctx.affected_ids if next((p for p in exp.fixed if p["id"] == jid), {}).get("ok"))

            def exp_frame(f: dict[str, Any], exp=exp, base=base, change=change) -> None:
                f["counters"]["experiments"] += 1
                f["counters"]["probesRun"] += len(exp.fixed)
                f["twin"] = {**f["twin"], "probes": _by_id([p for p in exp.fixed if p["kind"] == "journey"]), "failedNodes": [], "focus": exp.touched,
                             "caption": change["label"], "state": "experiment"}
                _upsert(f, {**base, "status": "testing", "note": "restores affected journeys" if exp.restored else "does not restore"})

            summary = (f"Rejected before execution: {'; '.join(exp.errors)}" if exp.errors else
                       f"{' + '.join(describe_step(s) for s in change['steps'])} → restored {restored_count}/{len(ctx.affected_ids)} affected journeys"
                       + (f" · {', '.join(p['id'] + ' failed' for p in exp.regressions)}" if exp.regressions else "")
                       + (f" · +{exp.latency_delta_ms} ms" if exp.latency_delta_ms > 0 else "") + ".")
            await push(2600, "experiment_result", "experiment", "experiment",
                       "ok" if exp.restored and not exp.regressions else "warn" if exp.restored else "fail",
                       f"{change['label']}{' (evaluation case)' if change['origin'] == 'evaluation_case' else ''}", summary,
                       {"change": change, "diff": exp.diff, "fixed": exp.fixed, "errors": exp.errors}, exp_frame)

            challenges: list[dict[str, Any]] | None = None
            revision: dict[str, Any] | None = None
            hard: list[dict[str, Any]] = []
            if exp.restored and not exp.regressions and not forbidden:
                challenges = []
                kinds = await planner.select_challenges(change, twin.supported_challenges)
                await _planner_notes(rec, planner, "challenge")
                for kind in kinds:
                    result = await twin.challenge(kind, exp.after, change, exp.fixed)
                    result["provenance"] = provenance("measured" if twin.backend == "emulated" and kind != "session_continuity" else "model-derived",
                                                      f"twin:{twin.backend}:{kind}", snapshot)
                    challenges.append(result)

                    def ch_frame(f: dict[str, Any], result=result, base=base) -> None:
                        f["counters"]["challengesRun"] += 1
                        f["counters"]["probesRun"] += len(result["probes"])
                        probes = dict(f["twin"]["probes"])
                        for p in result["probes"]:
                            base_id = p["id"].rsplit("-", 1)[0] if p["id"].rsplit("-", 1)[-1] in ("v6", "sf", "surge", "warm") else p["id"]
                            probes[base_id] = {**p, "id": base_id}
                        f["twin"] = {**f["twin"], "probes": probes, "failedNodes": [result["target"]] if result.get("target") else [],
                                     "caption": f"Challenge: {result['label']}", "state": "challenge"}
                        _upsert(f, {**base, "status": "challenging", "note": f"{result['label']} survived" if result["ok"] else f"{result['label']}: weakness found"})

                    await push(1500, "challenge_probe", "challenge", "challenge", "ok" if result["ok"] else "warn" if result["soft"] else "fail",
                               f"Challenge · {result['label']}", result["detail"], result, ch_frame)
                hard = [c for c in challenges if not c["ok"] and not c["soft"]]

            if planner.kind == "llm" and not exp.errors and not forbidden and (not exp.restored or exp.regressions):
                failed_checks = [{**probe, "ok": False, "detail": regression_text(probe) if probe["ok"] else probe["detail"]}
                                 for probe in exp.fixed if not probe["ok"] or probe in exp.regressions]
                hard = [{"id": "CHECK-fixed", "kind": "fixed_suite", "label": "Restoration and regression checks", "ok": False, "soft": False,
                         "detail": "; ".join(f"{probe['id']}: {probe['detail']}" for probe in failed_checks), "probes": failed_checks}]

            if hard and revisions < MAX_REVISIONS:
                revision = await planner.revise(change, hard, captured, obs, topo, twin.supported_actions)
                await _planner_notes(rec, planner, "diagnosis")
                if revision:
                    revisions += 1
                    if change.get("sourceRunId"):
                        revision["sourceRunId"] = change["sourceRunId"]
                    queue.insert(0, revision)

                    def rev_frame(f: dict[str, Any]) -> None:
                        f["counters"]["revisions"] += 1

                    await push(1800, "revised", "challenge", "diagnosis", "ai", f"Revised → {revision['label']}", revision["rationale"],
                               {"parent": change["id"], "revision": revision}, rev_frame)

            if not exp.errors:
                # Rehearsed after the challenges so the twin is only reconfigured once per candidate.
                exp.rollback = await twin.rehearse_rollback(exp.after, exp.diff)
            gate = evaluate_gates(repro, exp, challenges)
            decision = "superseded" if revision else gate["decision"]
            letter = change["label"].split(" · ")[0]
            record = {
                "change": change, "diff": exp.diff, "touched": exp.touched, "fixed": exp.fixed, "challenges": challenges or [], "rollback": exp.rollback,
                "gates": gate["gates"], "decision": decision,
                "reasons": [f"superseded by {revision['label'].split(' · ')[0]}: {'; '.join(gate['reasons'])}"] if revision
                else [*gate["reasons"], *(f"G7: {w}" for w in gate["warnings"])],
                "restored": exp.restored, "latencyDeltaMs": exp.latency_delta_ms, "forbidden": forbidden,
            }
            records.append(record)
            unsafe_flag = decision == "rejected" and any(g["id"] in ("G3", "G4", "G5") and g["status"] == "fail" for g in gate["gates"])
            label = {"pass": "PASS", "pass_with_warnings": "PASS WITH WARNINGS", "superseded": "SUPERSEDED"}.get(decision, "REJECTED")
            passed_ids = " ".join(g["id"] for g in gate["gates"] if g["status"] == "pass")

            def dec_frame(f: dict[str, Any], record=record, base=base, revision=revision, decision=decision, letter=letter, label=label, unsafe_flag=unsafe_flag) -> None:
                if unsafe_flag:
                    f["counters"]["unsafeRejected"] += 1
                status = {"pass": "pass", "pass_with_warnings": "warn", "superseded": "superseded"}.get(decision, "rejected")
                note = (f"superseded by {revision['label'].split(' · ')[0]}" if decision == "superseded"
                        else (record["reasons"][0].split(": ", 1)[1] if record["reasons"] and ": " in record["reasons"][0] else "all gates passed"))
                _upsert(f, {**base, "status": status, "note": note})
                f["twin"] = {**f["twin"], "failedNodes": [], "state": "idle", "caption": f"{letter} → {label}"}

            await push(1200, "candidate_decision", "gate", "gate",
                       "ok" if decision == "pass" else "warn" if decision in ("pass_with_warnings", "superseded") else "fail",
                       f"{letter} → {label}", record["reasons"][0] if record["reasons"] else f"{passed_ids} passed",
                       {"gates": gate["gates"], "decision": decision, "hash": change["hash"]}, dec_frame)

    passing = [r for r in records if r["decision"] in ("pass", "pass_with_warnings")]
    passing.sort(key=lambda r: (r["decision"] != "pass", len(r["touched"]), r["latencyDeltaMs"]))
    selected = passing[0] if passing else None
    verdict = ("PASS_UNDER_DEFINED_TESTS" if selected["decision"] == "pass" else "PASS_WITH_WARNINGS") if selected else ("ESCALATE" if repro["passed"] else "INCONCLUSIVE")

    if selected:
        def sel_frame(f: dict[str, Any]) -> None:
            f["verdict"] = verdict
            f["selectedId"] = selected["change"]["id"]
            f["twin"] = {**f["twin"], "probes": _by_id([p for p in selected["fixed"] if p["kind"] == "journey"]), "focus": selected["touched"],
                         "caption": f"Selected: {selected['change']['label']}", "state": "idle"}

        await push(2000, "gate_verdict", "gate", "gate", "ok" if verdict == "PASS_UNDER_DEFINED_TESTS" else "warn",
                   f"{VERDICT_LABEL[verdict]} · {selected['change']['label']}",
                   f"{sum(1 for g in selected['gates'] if g['status'] == 'pass')}/7 automated gates passed{' with warnings' if any(g['status'] == 'warn' for g in selected['gates']) else ''}. "
                   f"{len(records) - 1} alternatives rejected or superseded.",
                   {"verdict": verdict, "selected": selected["change"], "gates": selected["gates"]}, sel_frame)
    else:
        def v_frame(f: dict[str, Any]) -> None:
            f["verdict"] = verdict

        await push(2000, "gate_verdict", "gate", "gate", "fail", VERDICT_LABEL[verdict],
                   "No candidate survived the evidence gate. TwinOps stops instead of forcing a repair." if repro["passed"]
                   else "Not reproduced: the twin cannot represent this fault. TwinOps stops instead of guessing.",
                   {"verdict": verdict, "records": [{"id": r["change"]["id"], "decision": r["decision"], "reasons": r["reasons"]} for r in records]}, v_frame)

    run = {
        "schemaVersion": "run-1", "runId": session.incident_id, "seed": seed, "pack": topo["pack"], "versions": versions,
        "snapshot": snapshot, "investigation": investigation,
        "source": {"kind": "connected_application", "name": "Metro Network", "issueId": demo.issue_id} if session.external else {"kind": "demo_harness"},
        "variant": getattr(demo, "variant", "standard"),
        "exercise": session.exercise,
        "mode": f"{planner.mode} · {twin.backend} twin", "planner": {"kind": planner.kind, "provider": getattr(planner, "provider", "none"), "model": getattr(planner, "model", "none")},
        "topology": topo, "observation": obs, "guardedLogs": guarded, "hypotheses": hypotheses, "diagnostics": diagnostics, "reproduction": repro,
        "candidates": records, "selected": selected, "verdict": verdict, "memory": memory,
        "untested": untested_conditions(topo, repro, unsupported_challenges, twin.backend),
        "computeMs": round((time.monotonic() - started) * 1000, 1), "snapshotHash": obs["stateHash"],
        "v6Pops": [p["id"] for p in pops(topo) if p["v6Prefix"] in captured["b17"]["v6Prefixes"]],
        "writesDuringDiagnosis": sum(1 for w in demo.writes if w["actor"] != "harness"),
    }
    session.run = run

    narrative = await planner.narrate(proof_summary(run))
    await _planner_notes(rec, planner, "diagnosis")
    session.narrative = narrative
    if narrative:
        await push(600, "narrative", "gate", "diagnosis", "ai", "Approver briefing drafted", narrative["summary"], narrative)

    if selected:
        transition(session, "awaiting_approval")
        await push(800, "awaiting_approval", "approve", "operator", "info", "Awaiting human approval",
                   f"Approval binds to change {short_hash(selected['change']['hash'])} and target state {short_hash(obs['stateHash'])}. Nothing has touched the demo network.",
                   {"changeHash": selected["change"]["hash"], "targetStateHash": obs["stateHash"]})
    else:
        transition(session, "escalated")
        await push(800, "escalated", "approve", "operator", "warn", "Escalated to on-call engineer", f"Evidence bundle handed over: {top['title']}. No change is proposed.",
                   {"hypothesis": top})
    return run


def proof_summary(run: dict[str, Any]) -> dict[str, Any]:
    """Compact, evidence-referenced input for the narrator role."""
    return {
        "verdict": run["verdict"],
        "hypotheses": [{"id": h["id"], "title": h["title"], "supporting": h["supporting"], "status": "interpretation, not a confirmed fact"}
                   for h in run["hypotheses"]],
        "observations": [{"id": probe["id"], "ok": probe["ok"], "detail": probe["detail"]} for probe in run["observation"]["probes"]],
        "evidence_gaps": run["observation"].get("evidenceGaps", []),
        "reproduction": {"matched": run["reproduction"]["matched"], "total": run["reproduction"]["total"]},
        "candidates": [{"id": c["change"]["id"], "label": c["change"]["label"], "decision": c["decision"], "reasons": c["reasons"][:2],
                        "challenges": [{"label": ch["label"], "ok": ch["ok"]} for ch in c["challenges"]]} for c in run["candidates"]],
        "selected": run["selected"]["change"]["id"] if run["selected"] else None,
        "untested": run["untested"],
    }


def qa_context(run: dict[str, Any], outcome: dict[str, Any] | None) -> dict[str, Any]:
    """Everything an operator may ask about, with the IDs an answer is allowed to cite."""
    obs = run["observation"]
    probes = [{k: p.get(k) for k in ("id", "label", "ok", "failure", "detail")} for p in obs["probes"]]
    candidates = [{
        "id": c["change"]["id"], "label": c["change"]["label"], "origin": c["change"]["origin"], "rationale": c["change"].get("rationale", ""),
        "steps": [describe_step(s) for s in c["change"]["steps"]], "decision": c["decision"], "reasons": c["reasons"],
        "gates": [{"id": g["id"], "status": g["status"], "reason": g["reason"]} for g in c["gates"]],
        "challenges": [{"id": ch["id"], "label": ch["label"], "ok": ch["ok"], "detail": ch["detail"]} for ch in c["challenges"]],
        "latencyDeltaMs": c.get("latencyDeltaMs"),
    } for c in run["candidates"]]
    hypotheses = [{k: h.get(k) for k in ("id", "title", "rationale", "supporting", "contradicting")} for h in run["hypotheses"]]
    citable = {*(p["id"] for p in probes), *(a["id"] for a in obs["alarms"]), *(h["id"] for h in hypotheses), *(c["id"] for c in candidates),
               *(g["id"] for c in candidates for g in c["gates"]), *(ch["id"] for c in candidates for ch in c["challenges"])}
    return {
        "run": {"verdict": run["verdict"], "selected": run["selected"]["change"]["id"] if run["selected"] else None,
                "reproduction": {k: run["reproduction"][k] for k in ("matched", "total", "slice")}, "untested": run["untested"],
                "outcome": {k: outcome[k] for k in ("status", "reason")} if outcome else None},
        "observation": {"probes": probes, "alarms": [{k: a[k] for k in ("id", "node", "text")} for a in obs["alarms"]]},
        "hypotheses": hypotheses,
        "candidates": candidates,
        "gate_names": {"G1": "reproduced in twin", "G2": "restores affected journeys", "G3": "no regression / negative tests", "G4": "survives challenges",
                       "G5": "policy and blast radius", "G6": "rollback rehearsed", "G7": "soft checks", "G8": "human approval"},
        "citable_ids": sorted(citable),
    }


def create_approval(session: IncidentSession, operator: str, comment: str, decision: str) -> dict[str, Any]:
    run = session.run
    if not run.get("selected"):
        raise ValueError("nothing to approve: no candidate passed the gate")
    decided_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    change_hash = run["selected"]["change"]["hash"]
    approval = {"schemaVersion": "approval-1", "runId": run["runId"], "candidateId": run["selected"]["change"]["id"], "changeHash": change_hash, "targetStateHash": run["snapshotHash"],
            "operator": operator, "comment": comment, "decision": decision, "decidedAt": decided_at,
            "operationId": secrets.token_hex(16),
            "expiresAt": min(time.time() + session.approval_ttl_s, run.get("snapshot", {}).get("collectedAtEpoch", time.time()) + session.approval_ttl_s)}
    approval["token"] = sign(approval, session.approval_key)
    return approval


async def apply_with_approval(session: IncidentSession, approval: dict[str, Any], emit: Emit | None = None) -> list[dict[str, Any]]:
    """Lab-only apply gateway: the only write path, and only with an approval bound to hash and state."""
    if session.status in {"closed", "recovery_required"}:
        if session.approval and session.approval.get("operationId") == approval.get("operationId"):
            return []
        raise ValueError("Incident is already finished; a fresh investigation is required")
    if session.status == "awaiting_approval":
        transition(session, "applying")
    run, demo = session.run, session.demo
    prior = session.events[-1]
    rec = Recorder(prior["frame"], demo, emit, session.pace, time.monotonic() - prior["at"] / 1000, session.events, prior["seq"], session=session)
    selected = run.get("selected")
    session.approval = approval

    async def refuse(reason: str, kind: str = "drift_detected") -> None:
        session.outcome = {"status": "refused", "reason": reason, "postChecks": []}
        await rec.push(900, kind, "apply", "apply", "fail", "Apply refused — approval invalidated", reason, {"approval": approval, "reason": reason})

    if approval["decision"] == "reject":
        session.outcome = {"status": "rejected_by_operator", "reason": approval["comment"] or "operator rejected the change", "postChecks": []}
        await rec.push(600, "approval_rejected", "approve", "operator", "warn", f"Rejected by {approval['operator']}",
                       "No change applied. The evidence bundle is retained for review.", approval)
    elif not selected:
        await refuse("No candidate passed the evidence gate.", "approval_rejected")
    elif reason := refusal(session, approval):
        await refuse(reason, "approval_rejected")
    elif approval["changeHash"] != selected["change"]["hash"] or approval["candidateId"] != selected["change"]["id"]:
        await refuse(f"Approval hash {short_hash(approval['changeHash'])} does not match tested change {short_hash(selected['change']['hash'])}.")
    elif approval["runId"] != run["runId"]:
        await refuse("Approval belongs to a different run.")
    else:
        await rec.push(600, "approval_recorded", "approve", "operator", "ok", f"Approved by {approval['operator']}",
                       f"Token {short_hash(approval['token'])} bound to change {short_hash(approval['changeHash'])} and state {short_hash(approval['targetStateHash'])}.", approval)
        try:
            current = await demo.state_hash()
        except Exception as exc:
            await refuse(f"Could not read target state ({type(exc).__name__}); nothing applied.")
            transition(session, "closed")
            return session.events[prior["seq"]:]
        if current != approval["targetStateHash"]:
            await refuse(f"Target state drifted ({short_hash(approval['targetStateHash'])} → {short_hash(current)}) since the snapshot. Re-observe and re-verify before any change.")
        else:
            previous = None
            attempted = False
            post: list[dict[str, Any]] = []
            windows: list[dict[str, Any]] = []
            try:
                # Capture recovery state before any write: apply may fail after changing one device.
                previous = await demo.capture_supported()
                if reason := refusal(session, approval):
                    await refuse(reason, "approval_rejected")
                elif await demo.state_hash() != current:
                    await refuse("Target changed while preparing apply. Re-observe and re-verify.")
                else:
                    total = session.postcheck_samples
                    await rec.push(300, "apply_progress", "apply", "apply", "info", "Writing the approved change",
                                   f"{' + '.join(describe_step(s) for s in selected['change']['steps'])}. Pre-apply state captured for automatic rollback.",
                                   {"step": "write", "changeHash": approval["changeHash"]})
                    attempted = True
                    await demo.apply_approved(selected["change"], approval["token"])
                    await rec.push(300, "apply_progress", "apply", "apply", "info", "Change written · verifying recovery",
                                   f"Re-measuring customer journeys {total}×{f', {session.postcheck_interval_s:g} s apart' if total > 1 else ''}. Any failed check rolls the change back.",
                                   {"step": "verify", "windows": total})
                    for sample in range(total):
                        if sample:
                            await asyncio.sleep(session.postcheck_interval_s)
                        after = await demo.observe()
                        v6 = [{**(await demo.probe(j["id"], "v6")), "kind": "challenge"}
                              for j in run["topology"]["journeys"] if j["from"] in run["v6Pops"]]
                        post = [*after["probes"], *v6]
                        windows.append({"sample": sample + 1, "observedAt": datetime.now(UTC).isoformat(), "checks": post})
                        failed = [p["id"] for p in post if not p["ok"]]
                        if failed:
                            await rec.push(0, "apply_progress", "apply", "apply", "fail", f"Check {sample + 1}/{total} failed · rolling back",
                                           f"{', '.join(failed)} failed after the change. Restoring the pre-apply state.", {"step": "window", "sample": sample + 1, "of": total, "failed": failed})
                            raise RuntimeError("A post-change observation window failed")

                        def verifying(f: dict[str, Any], after=after) -> None:
                            f["prod"] = {"probes": _by_id([p for p in after["probes"] if p["kind"] == "journey"]), "alarmNodes": [], "status": "verifying"}

                        await rec.push(300, "apply_progress", "apply", "apply", "ok", f"Check {sample + 1}/{total} passed",
                                       f"{len(post)} checks passed: customer journeys, negative tests and IPv6 parity.",
                                       {"step": "window", "sample": sample + 1, "of": total}, verifying)
                    await rec.push(1400, "applied", "apply", "apply", "prod", f"Applied to demo network: {selected['change']['label']}",
                                   "The exact approved change was applied and checked on the demo network.",
                                   {"change": selected["change"], "token": approval["token"], "network": demo.backend})
                    session.outcome = {"status": "applied", "reason": f"post-change checks passed across {len(windows)} observation window(s)",
                                       "postChecks": post, "observationWindows": windows, "operationId": approval["operationId"]}

                    def restored(f: dict[str, Any]) -> None:
                        f["prod"] = {"probes": _by_id([p for p in after["probes"] if p["kind"] == "journey"]), "alarmNodes": [], "status": "restored"}

                    await rec.push(1600, "post_check", "apply", "apply", "ok", "Post-change verification passed",
                                   f"{len(post)} checks: customer journeys, negative tests and IPv6 parity succeed.", {"postChecks": post}, restored)
            except Exception as exc:
                if not attempted:
                    await refuse(f"Could not prepare apply ({type(exc).__name__}); nothing applied.")
                else:
                    reason = f"Apply or verification failed ({type(exc).__name__})."
                    try:
                        await demo.restore(previous, approval["token"])
                        if await demo.state_hash() != current:
                            raise RuntimeError("restored state does not match the pre-apply hash")
                    except Exception as recovery_error:
                        session.outcome = {"status": "recovery_required", "reason": f"{reason} Rollback could not be verified ({type(recovery_error).__name__}). Operator recovery required.", "postChecks": post,
                                           "observationWindows": windows, "operationId": approval["operationId"]}
                        transition(session, "recovery_required")
                        await rec.push(0, "recovery_required", "apply", "apply", "fail", "Operator recovery required", session.outcome["reason"], {"postChecks": post})
                        return session.events[prior["seq"]:]
                    session.outcome = {"status": "rolled_back", "reason": f"{reason} Pre-apply state restored and hash verified.", "postChecks": post,
                                       "observationWindows": windows, "operationId": approval["operationId"]}
                    await rec.push(0, "rolled_back", "apply", "apply", "fail", "Change rolled back — restoration verified", session.outcome["reason"], {"postChecks": post})

    transition(session, "closed")
    return session.events[len(session.events) - rec.seq + prior["seq"]:]


async def decide(session: IncidentSession, operator: str, comment: str, decision: str, emit: Emit | None = None) -> list[dict[str, Any]]:
    return await apply_with_approval(session, create_approval(session, operator, comment, decision), emit)
