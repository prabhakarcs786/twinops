"""Containerlab without Docker: every lab node is its own network, mount and PID namespace inside one container.

Used where privileged Docker is unavailable (Cloud Run). The process running the lab must own a user namespace
(`unshare --user --map-root-user`); the node namespaces belong to it. Nodes run the same FRR, CoreDNS and nginx
daemons with the same rendered configs, links and allow-listed commands as the Containerlab topology.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import time
from pathlib import Path
from typing import Any

from .plan import IMAGES, INSTANCES, container
from .render import topology
from .runner import ALLOWED, DockerRunner, LabError, Result

# FRR 10 applies interface and static configuration through mgmtd, so it starts first (as frrinit.sh does).
FRR_DAEMONS = (("mgmtd", []), ("zebra", ["-s", "90000000"]), ("staticd", []), ("bgpd", []))


def registry_path(runtime: Path) -> Path:
    return runtime / "netns.json"


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _members(holder: int) -> list[int]:
    """Processes inside a node's PID namespace, except its init (the holder)."""
    ns = os.readlink(f"/proc/{holder}/ns/pid")
    out = []
    for entry in os.listdir("/proc"):
        if entry.isdigit() and int(entry) != holder:
            try:
                if os.readlink(f"/proc/{entry}/ns/pid") == ns:
                    out.append(int(entry))
            except OSError:
                continue
    return out


class NamespaceRunner(DockerRunner):
    """`docker exec`, `pause` and `ps` for namespace nodes."""

    def __init__(self, runtime: Path, concurrency: int = 6) -> None:
        super().__init__("nsenter", concurrency)
        self.registry = registry_path(runtime)
        self.paused_dir = runtime / "netns-paused"

    def nodes(self) -> dict[str, int]:
        try:
            saved = json.loads(self.registry.read_text())
        except (OSError, ValueError):
            return {}
        return {name: pid for name, pid in saved.items() if _alive(pid)}

    def _paused(self, name: str) -> bool:
        return (self.paused_dir / name).exists()

    async def exec(self, container: str, argv: list[str], timeout: float = 10) -> Result:
        if not argv or argv[0] not in ALLOWED:
            raise LabError(f"command {argv[:1]} is not allow-listed for lab containers")
        pid = self.nodes().get(container)
        if pid is None:
            return Result(1, "", f"No such container: {container}")
        if self._paused(container):
            return Result(1, "", f"Container {container} is paused")
        return await self._run(["nsenter", "-t", str(pid), "-n", "-m", "-p", "--", *argv], timeout)

    async def control(self, verb: str, *containers: str, timeout: float = 30) -> Result:
        if verb not in ("pause", "unpause"):
            raise LabError(f"docker verb {verb} not allowed (restarts would destroy lab links)")
        nodes = self.nodes()
        self.paused_dir.mkdir(parents=True, exist_ok=True)
        for name in containers:
            if name not in nodes:
                return Result(1, "", f"No such container: {name}")
            # Like the cgroup freezer behind `docker pause`: daemons stop, the node's kernel state stays.
            for pid in _members(nodes[name]):
                os.kill(pid, signal.SIGSTOP if verb == "pause" else signal.SIGCONT)
            marker = self.paused_dir / name
            if verb == "pause":
                marker.touch()
            else:
                marker.unlink(missing_ok=True)
        return Result(0, "", "")

    async def inspect_states(self, prefix: str) -> dict[str, str]:
        return {name: "paused" if self._paused(name) else "running" for name in self.nodes() if name.startswith(prefix)}


# ---------- deploy / destroy ----------

def _run(argv: list[str], log: Path | None = None) -> None:
    # Daemons keep inherited pipes open after forking, so their output goes to a file, never a pipe.
    with (log.open("ab") if log else open(os.devnull, "wb")) as out:
        res = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT if log else subprocess.PIPE, timeout=30)
    if res.returncode != 0:
        detail = log.read_text(errors="replace")[-300:] if log else (res.stderr or b"").decode(errors="replace")
        raise LabError(f"{' '.join(argv[-6:])} failed: {detail.strip()}")


def _enter(pid: int, *namespaces: str) -> list[str]:
    return ["nsenter", "-t", str(pid), *namespaces, "--"]


def _child_of(parent: int) -> int | None:
    for entry in os.listdir("/proc"):
        if entry.isdigit():
            try:
                status = Path(f"/proc/{entry}/status").read_text()
            except OSError:
                continue
            if f"\nPPid:\t{parent}\n" in status:
                return int(entry)
    return None


def _holder() -> int:
    """A sleeping init process that keeps one node's namespaces alive."""
    proc = subprocess.Popen(["unshare", "--net", "--mount", "--pid", "--fork", "--mount-proc", "sleep", "infinity"],
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    for _ in range(250):
        if (pid := _child_of(proc.pid)) is not None:
            return pid
        if proc.poll() is not None:
            raise LabError("could not create lab namespaces: run the lab inside `unshare --user --map-root-user`")
        time.sleep(0.02)
    raise LabError("lab namespace holder did not start")


def _prepare_mounts(pid: int, runtime: Path, node: dict[str, Any]) -> None:
    mnt = _enter(pid, "-m")
    # Private /run per node: FRR sockets and nginx pid files must not collide between nodes.
    _run([*mnt, "mount", "-t", "tmpfs", "tmpfs", "/run"])
    _run([*mnt, "mkdir", "-p", "/run/frr", "/run/nginx"])
    for bind in node.get("binds", []):
        source, target = runtime / bind.split(":")[0], Path(bind.split(":")[1])
        # Mount points live in the shared container filesystem; each node mounts its own file over them.
        if source.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        elif not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            target.touch()
        _run([*mnt, "mount", "--bind", str(source), str(target)])


def _start_daemons(pid: int, node: dict[str, Any], log: Path) -> None:
    inside = _enter(pid, "-n", "-m", "-p")
    image = node["image"]
    if image == IMAGES["frr"]:
        for daemon, extra in FRR_DAEMONS:
            _run([*inside, f"/usr/lib/frr/{daemon}", "-d", "-u", "root", "-g", "root", "-A", "127.0.0.1", *extra], log)
        for attempt in range(20):
            try:
                _run([*inside, "vtysh", "-b"], log)
                return
            except LabError:
                if attempt == 19:
                    raise
                time.sleep(0.25)
    elif image == IMAGES["dns"]:
        with log.open("ab") as out:
            subprocess.Popen([*inside, "coredns", "-conf", "/etc/coredns/Corefile"], stdin=subprocess.DEVNULL, stdout=out, stderr=out,
                             start_new_session=True)
    elif image == IMAGES["web"]:
        # Only root is mapped in the lab's user namespace, so nginx workers cannot switch to the nginx user.
        _run([*inside, "nginx", "-g", "user root root;"], log)
    else:
        raise LabError(f"unknown lab image {image}")


def destroy(runtime: Path) -> None:
    for pid in NamespaceRunner(runtime).nodes().values():
        # Killing a PID namespace's init ends every daemon inside it.
        os.kill(pid, signal.SIGKILL)
    registry_path(runtime).unlink(missing_ok=True)
    for marker in (runtime / "netns-paused").glob("*"):
        marker.unlink()


def deploy(runtime: Path) -> dict[str, int]:
    """Builds both lab instances from the rendered Containerlab topology. Configs must already be written."""
    destroy(runtime)
    logs = runtime / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    nodes: dict[str, int] = {}
    for instance in INSTANCES:
        topo = topology(instance)["topology"]
        pids = {}
        for name, node in topo["nodes"].items():
            pid = pids[name] = nodes[container(instance, name)] = _holder()
            _prepare_mounts(pid, runtime, node)
            net = _enter(pid, "-n")
            _run([*net, "ip", "link", "set", "lo", "up"])
            for key, value in node.get("sysctls", {}).items():
                _run([*net, "sysctl", "-qw", f"{key}={value}"])
        for link in topo["links"]:
            (a, a_if), (b, b_if) = (endpoint.split(":") for endpoint in link["endpoints"])
            _run([*_enter(pids[a], "-n"), "ip", "link", "add", a_if, "type", "veth", "peer", "name", b_if, "netns", str(pids[b])])
            _run([*_enter(pids[a], "-n"), "ip", "link", "set", a_if, "up"])
            _run([*_enter(pids[b], "-n"), "ip", "link", "set", b_if, "up"])
        for name, node in topo["nodes"].items():
            for command in node.get("exec", []):
                _run([*_enter(pids[name], "-n"), *command.split()])
            _start_daemons(pids[name], node, logs / f"{container(instance, name)}.log")
    registry_path(runtime).write_text(json.dumps(nodes))
    return nodes
