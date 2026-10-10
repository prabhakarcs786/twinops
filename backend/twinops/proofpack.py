"""Proof Pack: the evidence bundle is the product output. HTML rendering escapes every value."""

from __future__ import annotations

import html
import json
from datetime import UTC, datetime
from typing import Any

from .catalogue import describe_step
from .orchestrator import VERDICT_LABEL, IncidentSession


def build_proof_pack(session: IncidentSession) -> dict[str, Any]:
    run, demo = session.run, session.demo
    failing = [p for p in run["observation"]["probes"] if p["kind"] == "journey" and not p["ok"]]
    return {
        "incident_id": run["runId"],
        "generated_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "verdict": VERDICT_LABEL[run["verdict"]],
        "scope_note": "Verified under tested scenarios only. Twin evidence is not a guarantee of production safety.",
        "mode": run["mode"],
        "planner": run["planner"],
        "versions": run["versions"],
        "seed": run["seed"],
        "scenario_variant": run.get("variant", "standard"),
        "exercise": run.get("exercise", "none"),
        "incident_memory": run.get("memory", []),
        "captured_state_hash": run["snapshotHash"],
        "observation": {
            "failing_journeys": [{"id": p["id"], "detail": p["detail"]} for p in failing],
            "alarms": len(run["observation"]["alarms"]),
            "raw_events": run["observation"]["rawEventCount"],
            "recent_changes": [f"{c['id']} {c['node']}: {c['summary']}" for c in run["observation"]["changes"] if c["minutesAgo"] <= 60],
            "quarantined_untrusted_text": [f"{lg['node']}: {lg['text']}" for lg in run["guardedLogs"] if lg["flagged"]],
            "evidence_gaps": run["observation"].get("evidenceGaps", []),
        },
        "hypotheses": [{"rank": h["rank"], "title": h["title"], "supporting": h["supporting"], "contradicting": h["contradicting"]} for h in run["hypotheses"]],
        "reproduction": {
            "symptoms_matched": f"{run['reproduction']['matched']}/{run['reproduction']['total']}",
            "passed": run["reproduction"]["passed"],
            "slice": run["reproduction"]["slice"],
            "mismatches": run["reproduction"]["mismatches"],
            "outside_twin_fidelity": run["reproduction"]["outOfScope"],
        },
        "experiments": [{
            "id": c["change"]["id"], "label": c["change"]["label"], "origin": c["change"]["origin"],
            "source_run_id": c["change"].get("sourceRunId"),
            "steps": [describe_step(s) for s in c["change"]["steps"]], "change_hash": c["change"]["hash"], "restored": c["restored"],
            "latency_delta_ms": c["latencyDeltaMs"], "decision": c["decision"],
            "gates": {g["id"]: f"{g['status']}: {g['reason']}" for g in c["gates"]},
            "challenges": [{"challenge": ch["label"], "ok": ch["ok"], "soft": ch["soft"], "detail": ch["detail"]} for ch in c["challenges"]],
            "diff": c["diff"],
        } for c in run["candidates"]],
        "selected": {"id": run["selected"]["change"]["id"], "label": run["selected"]["change"]["label"], "change_hash": run["selected"]["change"]["hash"],
                     "steps": [describe_step(s) for s in run["selected"]["change"]["steps"]], "rollback": run["selected"]["rollback"]} if run["selected"] else None,
        "rejected_unsafe": [c["change"]["label"] for c in run["candidates"]
                            if c["decision"] == "rejected" and any(g["id"] in ("G3", "G4", "G5") and g["status"] == "fail" for g in c["gates"])],
        "production_writes_during_diagnosis": run["writesDuringDiagnosis"],
        "write_log": demo.writes,
        "approval": session.approval,
        "apply": session.outcome,
        "narrative": session.narrative,
        "untested_conditions": run["untested"],
        "event_count": len(session.events),
    }


def proof_pack_html(pack: dict[str, Any]) -> str:
    e = html.escape

    def pre(value: Any) -> str:
        return f"<pre>{e(json.dumps(value, indent=2, ensure_ascii=False))}</pre>"

    rows = "".join(
        f"<tr><td>{e(x['label'])}</td><td>{e(x['origin'])}</td><td>{'yes' if x['restored'] else 'no'}</td><td>{e(x['decision'])}</td>"
        f"<td><code>{e(x['change_hash'][:12])}</code></td><td>{''.join(f'<div><b>{e(g)}</b> {e(v)}</div>' for g, v in x['gates'].items())}</td></tr>"
        for x in pack["experiments"]
    )
    narrative = pack.get("narrative") or {}
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><title>TwinOps Proof Pack {e(pack['incident_id'])}</title>
<style>body{{font:14px/1.5 system-ui,sans-serif;margin:32px;color:#0b1020}}code,pre{{font-family:ui-monospace,monospace;font-size:12px}}
.v{{display:inline-block;padding:4px 10px;border:2px solid #0b1020;border-radius:6px;font-weight:700}}table{{border-collapse:collapse;width:100%}}
td,th{{border:1px solid #ccd;padding:6px;vertical-align:top;text-align:left}}.note{{background:#fff7e0;border-left:4px solid #946000;padding:8px 12px}}</style></head><body>
<h1>TwinOps Proof Pack</h1><p>{e(pack['incident_id'])} · generated {e(pack['generated_at'])} · seed {e(str(pack['seed']))}</p>
<p class="v">{e(pack['verdict'])}</p><p class="note">{e(pack['scope_note'])}</p>
<h2>Mode</h2><p>{e(pack['mode'])}</p>{pre(pack['versions'])}<p>Captured state <code>{e(pack['captured_state_hash'])}</code></p>
<p>Scenario: {e(pack.get('scenario_variant', 'standard'))} · exercise: {e(pack.get('exercise', 'none'))}</p>
{f"<h2>Historical fix provenance (fresh tests required)</h2>{pre(pack['incident_memory'])}" if pack.get('incident_memory') else ''}
{f"<h2>Approver briefing (AI-drafted, non-authoritative)</h2><p>{e(narrative.get('summary', ''))}</p>" if narrative else ''}
<h2>Observation</h2>{pre(pack['observation'])}<h2>Hypotheses</h2>{pre(pack['hypotheses'])}<h2>Reproduction</h2>{pre(pack['reproduction'])}
<h2>Experiments</h2><table><thead><tr><th>Candidate</th><th>Origin</th><th>Restored</th><th>Decision</th><th>Hash</th><th>Gates</th></tr></thead><tbody>{rows}</tbody></table>
<h2>Selected change</h2>{pre(pack['selected'])}<h2>Approval and apply</h2>{pre({'approval': pack['approval'], 'apply': pack['apply'], 'production_writes_during_diagnosis': pack['production_writes_during_diagnosis']})}
<h2>Untested conditions</h2><ul>{''.join(f'<li>{e(u)}</li>' for u in pack['untested_conditions'])}</ul></body></html>"""
