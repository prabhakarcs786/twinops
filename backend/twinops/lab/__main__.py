"""Lab lifecycle: python -m twinops.lab build | up | down | status | smoke [fault]

On Linux with containerlab installed it is used directly; elsewhere (macOS + Docker Desktop) containerlab runs in its
official container with access to the Docker socket. The Docker socket is only ever used by this lab runner — never by a model.
"""

from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
import sys
from pathlib import Path

from ..config import Settings, load_env_file
from ..topology import build_topology
from .backend import lab_healthy, lab_status, runtime_dir
from .plan import IMAGES, INSTANCES
from .render import write_runtime

CLAB_IMAGE = "ghcr.io/srl-labs/clab:0.60.1"


def _run(argv: list[str]) -> int:
    print("$", " ".join(argv), flush=True)
    return subprocess.call(argv)


def clab(args: list[str], workdir: Path) -> int:
    if shutil.which("containerlab"):
        return _run(["sudo", "-n", "containerlab", *args] if sys.platform.startswith("linux") else ["containerlab", *args])
    d = str(workdir)
    return _run(["docker", "run", "--rm", "--privileged", "--network", "host", "--pid", "host", "-v", "/var/run/docker.sock:/var/run/docker.sock",
                 "-v", "/var/run/netns:/var/run/netns", "-v", f"{d}:{d}", "-w", d, CLAB_IMAGE, "containerlab", *args])


def build(settings: Settings) -> int:
    if settings.lab_runtime == "netns":
        return 0  # daemons are part of the TwinOps image
    images = settings.lab_dir / "images"
    for key, folder in (("frr", "frr-node"), ("dns", "dns"), ("web", "web")):
        if _run(["docker", "build", "-t", IMAGES[key], str(images / folder)]) != 0:
            return 1
    return 0


def up(settings: Settings) -> int:
    runtime = runtime_dir(settings)
    write_runtime(runtime, lab_healthy(build_topology("core")))
    if settings.lab_runtime == "netns":
        from .netns import deploy

        deploy(runtime)
        return 0
    for instance in INSTANCES:
        if clab(["deploy", "-t", f"twinops-{instance}.clab.yml", "--reconfigure"], runtime) != 0:
            return 1
    return 0


def down(settings: Settings) -> int:
    runtime = runtime_dir(settings)
    if settings.lab_runtime == "netns":
        from .netns import destroy

        destroy(runtime)
        return 0
    code = 0
    for instance in INSTANCES:
        code |= clab(["destroy", "-t", f"twinops-{instance}.clab.yml", "--cleanup"], runtime)
    for instance in INSTANCES:
        subprocess.call(["docker", "network", "rm", f"twinops-{instance}-mgmt"], stderr=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
    return code


async def smoke(settings: Settings, fault: str) -> int:
    """One full incident on the emulated lab: break → twin → candidates → gate → approve → post-check."""
    from ..orchestrator import IncidentSession, decide, run_incident
    from ..planner.factory import build_planner
    from .backend import lab_backends

    topo = build_topology("core")
    demo, twin = await lab_backends(settings, topo, 7)

    async def show(e: dict) -> None:
        print(f"{e['at'] / 1000:7.1f}s [{e['tone']:>4}] {e['title']} :: {e['summary'][:150]}", flush=True)

    session = IncidentSession("inc-lab-smoke", fault, demo, twin, build_planner(settings=settings), pace=0)
    try:
        run = await run_incident(session, topo, 7, emit=show)
        if run["selected"]:
            await decide(session, "lab-smoke", "smoke test", "approve", emit=show)
        print(json.dumps({"verdict": run["verdict"], "selected": run["selected"]["change"]["label"] if run["selected"] else None,
                          "outcome": (session.outcome or {}).get("status"), "computeS": round(run["computeMs"] / 1000, 1)}))
        return 0
    finally:
        await twin.close()
        await demo.close()


def main() -> int:
    load_env_file()
    settings = Settings()
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd == "build":
        return build(settings)
    if cmd == "up":
        return up(settings)
    if cmd == "down":
        return down(settings)
    if cmd == "status":
        print(json.dumps(asyncio.run(lab_status(settings)), indent=2))
        return 0
    if cmd == "smoke":
        return asyncio.run(smoke(settings, sys.argv[2] if len(sys.argv) > 2 else "route_misconfig"))
    print(__doc__)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
