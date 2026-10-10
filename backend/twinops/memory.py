from __future__ import annotations

import copy
from typing import Any

from .catalogue import CATALOGUE_VERSION, POLICY_VERSION, change_set, validate_change_set


def failure_signals(observation: dict[str, Any], topology: dict[str, Any]) -> set[str]:
    hosts = {journey["id"]: journey["host"] for journey in topology["journeys"]}
    return {f"{probe.get('failure', 'unknown')} at {probe.get('failedAt', 'unknown')} for {hosts.get(probe['id'], 'unknown')}"
            for probe in observation["probes"] if probe["kind"] == "journey" and not probe["ok"]}


def recall_candidates(records: list[dict[str, Any]], observation: dict[str, Any], topology: dict[str, Any],
                      backend: str, supported: set[str]) -> list[dict[str, Any]]:
    current_signals = failure_signals(observation, topology)
    matches = []
    for record in records:
        run, outcome = record.get("run") or {}, record.get("outcome") or {}
        selected = run.get("selected")
        versions = run.get("versions", {})
        if (record.get("status") != "closed" or outcome.get("status") != "applied" or not selected
                or not outcome.get("postChecks") or not all(probe["ok"] for probe in outcome["postChecks"])
                or record.get("backend") != backend or run.get("pack") != topology["pack"]
                or versions.get("catalogue") != CATALOGUE_VERSION or versions.get("policy") != POLICY_VERSION
                or versions.get("topology") != topology["version"]):
            continue
        previous_signals = failure_signals(run["observation"], run["topology"])
        shared, total = current_signals & previous_signals, current_signals | previous_signals
        if not shared or len(shared) / len(total) < 0.5:
            continue
        steps = copy.deepcopy(selected["change"]["steps"])
        if validate_change_set({"steps": steps}, supported):
            continue
        matches.append({
            "sourceRunId": record["id"], "sourceCreatedAt": record["created"], "sourceBackend": backend,
            "sourceLabel": selected["change"]["label"], "sourceChangeHash": selected["change"]["hash"],
            "sameSnapshot": run["snapshotHash"] == observation["stateHash"],
            "matchedSignals": sorted(shared), "signalCount": len(total), "steps": steps,
        })
    matches.sort(key=lambda match: (-len(match["matchedSignals"]) / match["signalCount"], -match["sourceCreatedAt"]))
    for match in matches[:1]:
        label = match["sourceLabel"].partition(" \u00b7 ")[2] or match["sourceLabel"]
        label = label.removeprefix("Retest ")
        candidate = change_set("cand-M1", f"M1 \u00b7 Retest {label[:65]}", match.pop("steps"), "memory",
                               f"Previously applied in {match['sourceRunId']}. Matching observed symptoms only; approval and test results must be new.")
        candidate["sourceRunId"] = match["sourceRunId"]
        match["candidate"] = candidate
    return matches[:1]