"""Hashing and JS-compatible formatting so Python and the TypeScript engine produce identical evidence."""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any


def canonical(value: Any) -> str:
    """Canonical JSON with sorted keys; None-valued dict entries are kept (JS `undefined` never reaches here)."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def hash_of(value: Any) -> str:
    return sha256(canonical(value))


def short_hash(h: str) -> str:
    return h[:12]


def js_round(x: float) -> int:
    """Math.round semantics (half rounds towards +infinity)."""
    return math.floor(x + 0.5)


def round1(x: float) -> float:
    return math.floor(x * 10 + 0.5) / 10


def js_str(value: Any) -> str:
    """String(value) as JavaScript would render it in a template literal."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if value is None:
        return "null"
    if isinstance(value, float):
        return str(int(value)) if value.is_integer() else repr(value)
    if isinstance(value, list):
        return ",".join(js_str(v) for v in value)
    return str(value)


def js_stringify(value: Any) -> str:
    """JSON.stringify for plain data (insertion order, no spaces)."""
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)
