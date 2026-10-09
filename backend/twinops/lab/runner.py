"""Async docker CLI wrapper. Only allow-listed binaries can be executed inside lab containers; no shell strings."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass

ALLOWED = {"vtysh", "curl", "dig", "wget", "nginx", "tc", "ip", "pkill", "cat"}


class LabError(RuntimeError):
    pass


@dataclass
class Result:
    rc: int
    out: str
    err: str


class DockerRunner:
    def __init__(self, docker: str = "docker", concurrency: int = 6) -> None:
        self.docker = docker
        self._sem = asyncio.Semaphore(concurrency)

    async def _run(self, argv: list[str], timeout: float) -> Result:
        async with self._sem:
            proc = await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            try:
                out, err = await asyncio.wait_for(proc.communicate(), timeout)
            except TimeoutError:
                proc.kill()
                await proc.wait()
                return Result(124, "", f"timeout after {timeout}s")
            return Result(proc.returncode or 0, out.decode(errors="replace"), err.decode(errors="replace"))

    async def exec(self, container: str, argv: list[str], timeout: float = 10) -> Result:
        if not argv or argv[0] not in ALLOWED:
            raise LabError(f"command {argv[:1]} is not allow-listed for lab containers")
        return await self._run([self.docker, "exec", container, *argv], timeout)

    async def control(self, verb: str, *containers: str, timeout: float = 30) -> Result:
        if verb not in ("pause", "unpause"):
            raise LabError(f"docker verb {verb} not allowed (restarts would destroy lab links)")
        return await self._run([self.docker, verb, *containers], timeout)

    async def inspect_states(self, prefix: str) -> dict[str, str]:
        res = await self._run([self.docker, "ps", "-a", "--filter", f"name={prefix}", "--format", "{{.Names}} {{.State}}"], 15)
        states = {}
        for line in res.out.splitlines():
            if " " in line:
                name, state = line.split(" ", 1)
                states[name] = state.strip()
        return states
