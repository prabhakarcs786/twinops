"""mulberry32 — bit-identical to the TypeScript engine so a seed reproduces the same incident on both sides."""

from __future__ import annotations

import math
from collections.abc import Sequence
from typing import TypeVar

T = TypeVar("T")
_M = 0xFFFFFFFF


def _imul(a: int, b: int) -> int:
    return (a * b) & _M


class Rng:
    def __init__(self, seed: int) -> None:
        self._s = seed & _M

    def next(self) -> float:
        self._s = (self._s + 0x6D2B79F5) & _M
        t = self._s
        t = _imul(t ^ (t >> 15), t | 1)
        t = (t ^ ((t + _imul(t ^ (t >> 7), t | 61)) & _M)) & _M
        return ((t ^ (t >> 14)) & _M) / 4294967296

    def int(self, lo: int, hi: int) -> int:
        return lo + math.floor(self.next() * (hi - lo + 1))

    def pick(self, items: Sequence[T]) -> T:
        return items[math.floor(self.next() * len(items))]

    def shuffle(self, items: Sequence[T]) -> list[T]:
        out = list(items)
        for i in range(len(out) - 1, 0, -1):
            j = math.floor(self.next() * (i + 1))
            out[i], out[j] = out[j], out[i]
        return out
