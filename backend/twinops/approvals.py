"""Signed, time-bounded approvals verified at execution, including the exact change content."""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any

from .hashing import hash_of


def sign(approval: dict, key: bytes) -> str:
    body = {k: v for k, v in approval.items() if k != "token"}
    return hmac.new(key, json.dumps(body, sort_keys=True, separators=(",", ":")).encode(), hashlib.sha256).hexdigest()


def refusal(session: Any, approval: dict) -> str | None:
    if not session.apply_enabled or (session.apply_policy and not session.apply_policy()):
        return "Apply is disabled by the operator; investigation evidence is still available."
    if not hmac.compare_digest(str(approval.get("token", "")), sign(approval, session.approval_key)):
        return "Approval signature is invalid."
    if time.time() > approval.get("expiresAt", 0):
        return "Approval or its evidence has expired; collect new evidence."
    selected = session.run.get("selected")
    if selected:
        change = selected["change"]
        actual = hash_of({"steps": change["steps"], "origin": change["origin"], "parentId": change.get("parentId")})
        if actual != approval["changeHash"]:
            return "The tested change content has changed since approval."
    return None
