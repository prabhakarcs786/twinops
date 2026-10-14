"""Consistent captures and traceable evidence shared by model, lab and HTTP adapters."""

from __future__ import annotations

import asyncio
import copy
import time
from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

from .hashing import hash_of

CONTRACT_VERSION = "evidence-1"
DiagnosticKind = Literal["direct_ip", "dns_lookup", "route_lookup", "tls_probe"]
DIAGNOSTICS = {"direct_ip", "dns_lookup", "route_lookup", "tls_probe"}


def utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


class Provenance(BaseModel):
    model_config = ConfigDict(extra="forbid")
    classification: Literal["measured", "model-derived", "synthetic", "interpreted", "unavailable"]
    source: str
    observedAt: str
    snapshotId: str
    stateHash: str


class Snapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schemaVersion: Literal["evidence-1"] = CONTRACT_VERSION
    id: str
    stateHash: str
    capturedStateHash: str
    collectedAt: str
    collectedAtEpoch: float
    durationMs: float
    consistent: bool
    source: str


def provenance(classification: str, source: str, snapshot: dict[str, Any]) -> dict[str, Any]:
    return Provenance(classification=classification, source=source, observedAt=utc_now(),
                      snapshotId=snapshot["id"], stateHash=snapshot["stateHash"]).model_dump()


async def capture_snapshot(network: Any) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    """Bracket every capture with state hashes; changing targets never become approval evidence."""
    if hasattr(network, "capture_evidence"):
        bundle = await network.capture_evidence()
        snapshot = Snapshot.model_validate(bundle["snapshot"]).model_dump()
        if not snapshot["consistent"] or bundle["observation"]["stateHash"] != snapshot["stateHash"]:
            raise ValueError("Connector returned inconsistent evidence")
        if hash_of(bundle["state"]) != snapshot["capturedStateHash"]:
            raise ValueError("Connector snapshot content does not match its hash")
        return bundle["observation"], bundle["state"], snapshot
    started = time.monotonic()
    for _ in range(2):
        before = await network.state_hash()
        observation = copy.deepcopy(await network.observe())
        captured = await network.capture_supported()
        after = await network.state_hash()
        if before == observation["stateHash"] == after:
            break
    else:
        raise ValueError("Target changed during evidence collection; investigate again")
    at = utc_now()
    snapshot = Snapshot(id=hash_of({"state": after, "at": at}), stateHash=after, capturedStateHash=hash_of(captured),
                        collectedAt=at, collectedAtEpoch=time.time(), durationMs=round((time.monotonic() - started) * 1000, 1),
                        consistent=True, source=f"{network.backend} network observation").model_dump()
    for key in ("probes", "alarms", "logs", "changes"):
        for item in observation.get(key, []):
            # The lab measures traffic; its alarm summaries are derived and its scenario logs/history are synthetic.
            classification = ("measured" if network.backend == "emulated" else "model-derived") if key == "probes" else (
                "model-derived" if key == "alarms" and item.get("modelled") else "synthetic")
            item["provenance"] = provenance(classification, f"{network.backend}:{key}", snapshot)
    observation["snapshot"] = snapshot
    return observation, captured, snapshot


async def collect_diagnostic(network: Any, kind: DiagnosticKind, journey_id: str, snapshot: dict[str, Any]) -> dict[str, Any]:
    if kind not in DIAGNOSTICS:
        raise ValueError("Unsupported diagnostic")
    before = await network.state_hash()
    if before != snapshot["stateHash"]:
        raise ValueError("Target changed during investigation; evidence must be collected again")
    try:
        async with asyncio.timeout(25):
            result = await network.diagnostic(kind, journey_id)
        if await network.state_hash() != before:
            raise ValueError("Target changed while a diagnostic was running")
    except (TimeoutError, NotImplementedError, AttributeError) as exc:
        result = {"ok": False, "available": False, "failure": "unavailable", "path": [],
                  "detail": f"Diagnostic unavailable ({type(exc).__name__}); this is not evidence of a network failure."}
    result = {**result, "id": f"DIAG-{journey_id}" if kind == "direct_ip" else f"DIAG-{kind}-{journey_id}",
              "kind": "diagnostic", "diagnostic": kind, "journeyId": journey_id,
              "label": f"{journey_id} {kind.replace('_', ' ')}", "available": result.get("available", True)}
    result.setdefault("provenance", provenance("unavailable" if not result["available"] else
                      "measured" if network.backend == "emulated" else "model-derived", f"{network.backend}:{kind}", snapshot))
    return result


class DiagnosticEvidence:
    """Planners can read only collected evidence. They cannot execute diagnostic commands."""

    def __init__(self) -> None:
        self.items: list[dict[str, Any]] = []

    def direct_ip(self, journey_id: str) -> dict[str, Any]:
        return next((x for x in self.items if x["journeyId"] == journey_id and x["diagnostic"] == "direct_ip"),
                    {"id": f"DIAG-{journey_id}", "ok": False, "available": False, "kind": "diagnostic", "path": [],
                     "detail": "Direct-IP diagnostic not collected", "failure": "unavailable"})

    def results(self) -> list[dict[str, Any]]:
        return copy.deepcopy(self.items)
