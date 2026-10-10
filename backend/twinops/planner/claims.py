"""Reject directly contradictory numeric comparisons; this is not semantic fact checking."""

import re

# Deliberately narrow: positive statements comparing two explicit, same-unit values.
_COMPARISON = re.compile(
    r"(?P<left>-?\d+(?:\.\d+)?)\s*(?P<unit>°C|ms|%)"
    r"(?:\s*,?\s*(?:which\s+)?)\s*(?:is|was)\s+"
    r"(?P<relation>above|below|greater than|less than)\s+(?:the\s+)?(?:threshold\s+(?:of\s+)?)?"
    r"(?P<right>-?\d+(?:\.\d+)?)\s*(?P=unit)", re.IGNORECASE,
)


def contradictory_comparisons(text: str) -> list[str]:
    errors = []
    for match in _COMPARISON.finditer(text):
        left, right = float(match["left"]), float(match["right"])
        above = match["relation"].lower() in ("above", "greater than")
        if not (left > right if above else left < right):
            errors.append(f"contradictory numeric comparison: {match[0]}")
    return errors
