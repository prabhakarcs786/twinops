"""Authoritative incident transitions and the operator-facing state projection."""

from __future__ import annotations

from typing import Any

TERMINAL = {"closed", "escalated", "failed", "recovery_required"}
TRANSITIONS = {
    "running": {"awaiting_approval", "escalated", "failed", "closed"},
    "awaiting_approval": {"applying", "closed", "failed"},
    "applying": {"closed", "recovery_required"},
    "closed": set(), "escalated": set(), "failed": set(), "recovery_required": set(),
}


def transition(session: Any, target: str) -> None:
    if session.status == target:
        return
    if target not in TRANSITIONS.get(session.status, set()):
        raise ValueError(f"Invalid incident transition: {session.status} → {target}")
    session.status = target


def view(session: Any, *, archived: bool = False) -> dict[str, Any]:
    import time

    snapshot = session.run.get("snapshot") or {}
    expires = snapshot.get("collectedAtEpoch", 0) + session.approval_ttl_s
    fresh = time.time() <= expires
    enabled = bool(session.apply_enabled and (not session.apply_policy or session.apply_policy()))
    selected = session.run.get("selected")
    can_review = session.status == "awaiting_approval" and not archived and bool(selected)
    return {"schemaVersion": "incident-1", "status": session.status, "revision": len(session.events),
            "phase": session.events[-1]["phase"] if session.events else "observe",
            "terminal": session.status in TERMINAL, "archived": archived,
            "canApprove": bool(can_review and fresh and enabled), "canReject": bool(can_review),
            "evidenceFresh": fresh, "evidenceExpiresAt": expires, "applyEnabled": enabled,
            "outcome": session.outcome, "operationId": (session.approval or {}).get("operationId"),
            "nextAction": "Inspect and recover the target" if session.status == "recovery_required" else
            "Start a fresh investigation" if archived or (can_review and not fresh) else
            "Review the proposed change" if can_review else
            "Review escalation evidence" if session.status in {"failed", "escalated"} else
            "Review the outcome" if session.status == "closed" else "Investigation in progress"}
