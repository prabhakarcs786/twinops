"""Prepare counterbalanced review assignments from saved incidents; never invent human results."""

from __future__ import annotations

import argparse
import json
import random
import secrets
from pathlib import Path
from urllib.parse import urlencode, urlsplit

from .store import IncidentStore


def assignments(tasks: list[dict], participants: int, seed: int, base_url: str) -> dict:
    if participants < 2 or participants % 2 or participants > 100:
        raise ValueError("Use an even participant count between 2 and 100")
    if len(tasks) < 2 or len({task["incidentId"] for task in tasks}) != len(tasks):
        raise ValueError("Use at least two tasks, each from a different incident to avoid prior exposure")
    url = urlsplit(base_url)
    if url.scheme not in {"https", "http"} or not url.netloc or url.query or url.fragment:
        raise ValueError("Use an HTTP(S) application base URL")
    tasks = list(tasks)
    random.Random(seed).shuffle(tasks)  # noqa: S311 — repeatable task order, assignment keys use secrets
    study = "study-" + secrets.token_hex(8)
    rows = []
    for participant in range(participants):
        # Participant pairs share task order but receive opposite conditions at each
        # position. Rotate across pairs; both task and position are condition-balanced.
        order = list(range(len(tasks)))
        offset = (participant // 2) % len(tasks)
        order = order[offset:] + order[:offset]
        for position, index in enumerate(order, 1):
            task = tasks[index]
            mode = "proof" if (participant + position - 1) % 2 else "raw"
            key = secrets.token_urlsafe(24)
            row = {**task, "id": key, "studyId": study, "participantId": f"P{participant + 1:03}", "order": position, "mode": mode}
            row["url"] = base_url.rstrip("/") + "/review?" + urlencode({"incident": task["incidentId"], "candidate": task["candidateId"],
                                                                          "mode": mode, "assignment": key})
            rows.append(row)
    return {"schemaVersion": "review-study-1", "studyId": study, "seed": seed, "participants": participants, "assignments": rows,
            "instructions": "Give each engineer only their ordered links. Use a viewer account. Do not preview incident evidence. "
                            "Assignments allow one timed trial and must be completed in order. Participant IDs are pseudonyms, not verified identities. "
                            "Recruit separate engineers; prior exposure outside this tool cannot be controlled. No human results exist until reviews are completed."}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True, help="Persistent data directory used by the API")
    parser.add_argument("--tasks", type=Path, required=True, help='JSON list of {"incidentId": "...", "candidateId": "..."}')
    parser.add_argument("--participants", type=int, default=4)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    store = IncidentStore(args.data_dir)
    plan = assignments(json.loads(args.tasks.read_text()), args.participants, args.seed, args.base_url)
    store.save_study(plan)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(plan, indent=2) + "\n")
    print(f"Prepared {len(plan['assignments'])} assignments in {args.out}; no trial measurements generated.")


if __name__ == "__main__":
    main()
