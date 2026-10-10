"""One lab instance (prod or twin): push state to devices, capture state from devices, run real probes."""

from __future__ import annotations

import asyncio
import copy
import json
import re
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from ..model import State, filter_decision, minutes_between
from ..topology import SERVICE_IPS, Topology, node_by_id, pop_by_index
from .plan import ADMIN, B17_AS, DNS, DNS_COLD_PORT, DNS_WARM_PORT, EXPIRED_TEST, GW_VIPS, GW_VIPS_V6, POPS, Pop, container
from .render import COREFILE, check_host, check_v4, prefix_line, read_leaf, v6_line, write_leaf, zone_file
from .runner import DockerRunner, LabError

PREFIX_RE = re.compile(r"^ip prefix-list EDGE-IN seq (\d+) (permit|deny) (\S+)")
PREFIX6_RE = re.compile(r"^ipv6 prefix-list EDGE-IN6 seq \d+ permit (\S+)")
SAMPLES = 3


def now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.") + f"{datetime.now(UTC).microsecond // 1000:03d}Z"


class LabInstance:
    def __init__(self, instance: str, runtime: Path, topo: Topology, runner: DockerRunner | None = None, settle_s: float = 0.8) -> None:
        self.instance = instance
        self.runtime = runtime
        self.base = runtime / instance
        self.topo = topo
        self.runner = runner or DockerRunner()
        self.settle_s = settle_s
        self.zone_serial = int(time.time())
        self.paused: set[str] = set()

    # ---------- helpers ----------

    def c(self, name: str) -> str:
        return container(self.instance, name)

    def pop_for(self, node_id: str) -> Pop:
        for i in range(4):
            if pop_by_index(self.topo, i)["id"] == node_id:
                return POPS[i]
        raise LabError(f"unknown PoP {node_id}")

    def node_for_container(self, name: str) -> str:
        for i, p in enumerate(POPS):
            if p.container == name:
                return pop_by_index(self.topo, i)["id"]
        return {"b17": "B17", "dns1": "DNS-1", "gw1": "GW-1", "svc1": "SVC-1"}.get(name, name)

    async def vtysh(self, *commands: str) -> str:
        argv = ["vtysh"]
        for cmd in commands:
            argv += ["-c", cmd]
        res = await self.runner.exec(self.c("b17"), argv, timeout=20)
        if res.rc != 0:
            raise LabError(f"vtysh failed: {res.err.strip() or res.out.strip()}")
        return res.out

    # ---------- push ----------

    async def push(self, state: State, prev: State | None, *, restart: list[str] | None = None) -> None:
        """Brings devices to `state` with minimal changes from `prev` (full push when prev is None)."""
        jobs = [self._push_routing(state, prev), self._push_dns(state, prev), self._push_tls(state, prev)]
        results = await asyncio.gather(*jobs, return_exceptions=True)
        for result in results:
            if isinstance(result, BaseException):
                raise result
        for target in restart or []:
            if target == "B17":
                await self.vtysh("clear bgp *")
            elif target == "GW-1":
                await self.runner.exec(self.c("gw1"), ["nginx", "-s", "reload"])
        if prev is None or self._routing_key(state) != self._routing_key(prev) or restart:
            await self.wait_converged()

    async def wait_converged(self, timeout: float = 20) -> None:
        """BGP is converged when all sessions to running PoPs are established and the table versions stop moving.
        Paused PoPs (outside the twin slice, or a deliberate secondary failure) can never establish and are ignored."""
        await asyncio.sleep(self.settle_s)
        live = {addr for p in POPS if self.c(p.container) not in self.paused for addr in (p.p2p_pop, p.p2p6_pop)}
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            v4 = json.loads(await self.vtysh("show bgp ipv4 unicast summary json") or "{}")
            v6 = json.loads(await self.vtysh("show bgp ipv6 unicast summary json") or "{}")
            peers = [p for af in (v4, v6) for addr, p in af.get("peers", {}).items() if addr in live]
            snapshot = (v4.get("tableVersion"), v6.get("tableVersion"), tuple((p.get("pfxRcd"), p.get("pfxSnt"), p.get("connectionsEstablished")) for p in peers))
            settled = all(p.get("state") == "Established" and not p.get("outq") and not p.get("inq") for p in peers)
            if peers and settled and snapshot == last:
                return
            last = snapshot
            await asyncio.sleep(0.5)

    @staticmethod
    def _routing_key(state: State) -> tuple[Any, ...]:
        b = state["b17"]
        return (tuple(sorted((r["seq"], r["action"], r["prefix"]) for r in b["prefixList"])), b["filterEnabled"], tuple(sorted(b["v6Prefixes"])))

    async def _push_routing(self, state: State, prev: State | None) -> None:
        if prev is not None and self._routing_key(state) == self._routing_key(prev):
            return
        current = await self.capture_routing()
        want = {(r["seq"], r["action"], r["prefix"]) for r in state["b17"]["prefixList"]}
        have = {(r["seq"], r["action"], r["prefix"]) for r in current["prefixList"]}
        cmds = ["configure terminal"]
        cmds += [f"no {prefix_line({'seq': s, 'action': a, 'prefix': p})}" for s, a, p in sorted(have - want)]
        cmds += [prefix_line({"seq": s, "action": a, "prefix": p}) for s, a, p in sorted(want - have)]
        cmds += [f"no {v6_line(p)}" for p in sorted(set(current["v6Prefixes"]) - set(state["b17"]["v6Prefixes"]))]
        cmds += [v6_line(p) for p in sorted(set(state["b17"]["v6Prefixes"]) - set(current["v6Prefixes"]))]
        if current["filterEnabled"] != state["b17"]["filterEnabled"]:
            neg = "" if state["b17"]["filterEnabled"] else "no "
            cmds += [f"router bgp {B17_AS}", "address-family ipv4 unicast"]
            for p in POPS:
                cmds += [f"{neg}neighbor {p.p2p_pop} prefix-list EDGE-IN in", f"{neg}neighbor {p.p2p_pop} prefix-list EDGE-IN out"]
            cmds += ["exit-address-family", "exit"]
        cmds += ["end", "clear bgp ipv4 unicast * soft", "clear bgp ipv6 unicast * soft"]
        await self.vtysh(*cmds)

    async def _push_dns(self, state: State, prev: State | None) -> None:
        dns, before = state["dns"], (prev or {}).get("dns")
        if before is None or dns["standby"] != before["standby"]:
            self._write_zone("dns2", dns["standby"], DNS["standby"])
            await asyncio.sleep(1.2)
        cache_ok = before is not None and dns["cache"] == before["cache"]
        if before is not None and cache_ok and dns["primary"] == before["primary"]:
            return
        if before is not None and cache_ok:
            self._write_zone("dns1", dns["primary"], DNS["primary"])
            await asyncio.sleep(1.5)
            return
        # Flush and rebuild the cache: stale entries are warmed from a temporary zone, then the real zone is written.
        stale = {h: v for h, v in dns["cache"].items() if dns["primary"].get(h) != v}
        self._write_zone("dns1", {**dns["primary"], **stale}, DNS["primary"])
        await self._flush_dns()
        await asyncio.gather(*(self._dig(POPS[0], DNS["primary"], DNS_WARM_PORT, h, "A") for h in dns["cache"]))
        if stale:
            self._write_zone("dns1", dns["primary"], DNS["primary"])
            await asyncio.sleep(1.5)

    async def _flush_dns(self) -> None:
        """In-process CoreDNS reload empties the cache. A container restart would destroy the lab's veth links."""
        self.zone_serial += 1
        (self.base / "dns1" / "Corefile").write_text(f"# generation {self.zone_serial}\n{COREFILE}")
        await self.runner.exec(self.c("dns1"), ["pkill", "-USR1", "coredns"], timeout=5)
        await asyncio.sleep(1.0)
        await self._wait_dns()

    async def _wait_dns(self) -> None:
        for _ in range(20):
            if await self._dig(POPS[0], DNS["primary"], DNS_COLD_PORT, "svc.demo", "A") is not None:
                return
            await asyncio.sleep(0.3)

    def _write_zone(self, name: str, records: dict[str, str], ns_ip: str) -> None:
        self.zone_serial += 1
        (self.base / name / "db.demo").write_text(zone_file(records, self.zone_serial, ns_ip))

    async def _push_tls(self, state: State, prev: State | None) -> None:
        gw, before = state["gw"], (prev or {}).get("gw")
        changed = False
        for family in ("v4", "v6"):
            cert = gw["certs"][gw["bindings"][family]]
            old = before["certs"][before["bindings"][family]] if before else None
            if old != cert or (before and before["bindings"][family] != gw["bindings"][family]):
                write_leaf(self.runtime / "ca", self.base / "gw1" / "certs", family, cert["serial"], cert["notAfter"], cert["san"])
                changed = True
        if changed:
            await self.runner.exec(self.c("gw1"), ["nginx", "-s", "reload"])
            await asyncio.sleep(0.5)

    async def set_paused(self, wanted: set[str]) -> None:
        to_pause, to_resume = wanted - self.paused, self.paused - wanted
        if to_pause:
            await self.runner.control("pause", *sorted(to_pause))
        if to_resume:
            await self.runner.control("unpause", *sorted(to_resume))
        self.paused = set(wanted)

    async def set_flap(self, pop_index: int | None) -> None:
        """Harness-only physical fault: real packet loss on a PoP uplink (not part of supported state)."""
        for p in POPS:
            await self.runner.exec(self.c(p.container), ["tc", "qdisc", "del", "dev", "eth1", "root"], timeout=5)
        if pop_index is not None:
            await self.runner.exec(self.c(POPS[pop_index].container), ["tc", "qdisc", "add", "dev", "eth1", "root", "netem", "loss", "45%"], timeout=5)

    async def drift(self) -> None:
        await self.vtysh("configure terminal", "interface eth1", "description edited during incident", "end")

    async def clear_drift(self) -> None:
        await self.vtysh("configure terminal", "interface eth1", "no description", "end")

    # ---------- capture ----------

    async def capture_routing(self) -> dict[str, Any]:
        cfg = await self.vtysh("show running-config")
        prefix_list, v6, filtered, description = [], [], False, ""
        in_eth1 = False
        for raw in cfg.splitlines():
            line = raw.strip()
            if m := PREFIX_RE.match(line):
                prefix_list.append({"seq": int(m[1]), "action": m[2], "prefix": m[3]})
            elif m := PREFIX6_RE.match(line):
                v6.append(m[1])
            elif re.match(r"^neighbor \S+ prefix-list EDGE-IN in$", line):
                filtered = True
            if raw.startswith("interface "):
                in_eth1 = raw.strip() == "interface eth1"
            elif in_eth1 and line.startswith("description "):
                description = line[len("description "):]
        return {"prefixList": sorted(prefix_list, key=lambda r: r["seq"]), "v6Prefixes": v6, "filterEnabled": filtered, "description": description}

    async def capture(self, declared: State) -> State:
        """Supported state read back from devices; config-management metadata (revision, archive, notes on rules) comes from `declared`."""
        routing, answers, gw = await asyncio.gather(self.capture_routing(), self._capture_dns(), asyncio.to_thread(self._capture_tls))
        notes = {(r["seq"], r["prefix"]): r.get("note", "") for r in declared["b17"]["prefixList"]}
        state = copy.deepcopy(declared)
        state["b17"].update({
            "prefixList": [{**r, "note": notes.get((r["seq"], r["prefix"]), "")} for r in routing["prefixList"]],
            "v6Prefixes": [p for p in declared["b17"]["v6Prefixes"] if p in routing["v6Prefixes"]] + [p for p in routing["v6Prefixes"] if p not in declared["b17"]["v6Prefixes"]],
            "filterEnabled": routing["filterEnabled"],
        })
        state["notes"] = {**declared["notes"], "B17.description": routing["description"] or declared["notes"].get("B17.description", "")}
        state["dns"].update(answers)
        state["gw"] = gw
        state["mgmt"] = {"adminServiceUp": await self._admin_up()}
        state["physical"] = {"flappingLink": None}
        state["failedNodes"] = sorted(self.node_for_container(c.rsplit("-", 1)[-1]) for c in self.paused)
        return state

    async def _capture_dns(self) -> dict[str, Any]:
        hosts = list(SERVICE_IPS)

        async def answer(server: str, port: int, host: str) -> str | None:
            return await self._dig(POPS[0], server, port, host, "A")

        primary = await asyncio.gather(*(answer(DNS["primary"], DNS_COLD_PORT, h) for h in hosts))
        standby = await asyncio.gather(*(answer(DNS["standby"], DNS_COLD_PORT, h) for h in hosts))
        cached = await asyncio.gather(*(answer(DNS["primary"], DNS_WARM_PORT, h) for h in hosts))
        return {"primary": {h: v for h, v in zip(hosts, primary, strict=True) if v},
                "standby": {h: v for h, v in zip(hosts, standby, strict=True) if v},
                "cache": {h: v for h, v in zip(hosts, cached, strict=True) if v}}

    def _capture_tls(self) -> dict[str, Any]:
        certs, bindings = {}, {}
        for family in ("v4", "v6"):
            leaf = read_leaf(self.base / "gw1" / "certs" / f"{family}.crt")
            certs[leaf["serial"]] = {"serial": leaf["serial"], "notAfter": leaf["notAfter"], "san": leaf["san"]}
            bindings[family] = leaf["serial"]
        return {"bindings": bindings, "certs": certs, "up": True}

    async def _admin_up(self) -> bool:
        res = await self.runner.exec(self.c("b17"), ["wget", "-q", "-O", "/dev/null", "-T", "2", f"http://{ADMIN[0]}:{ADMIN[1]}/"], timeout=6)
        return res.rc == 0

    # ---------- probes ----------

    async def _dig(self, pop: Pop, server: str, port: int, host: str, rr: str) -> str | None:
        res = await self.runner.exec(self.c(pop.container), ["dig", "+short", "+time=1", "+tries=1", "-b", pop.p2p_pop, f"@{server}", "-p", str(port),
                                                               check_host(host), rr], timeout=6)
        lines = [ln.strip() for ln in res.out.splitlines() if ln.strip() and not ln.startswith(";")]
        return lines[0] if res.rc == 0 and lines else None

    async def _curl(self, pop: Pop, family: str, host: str, ip: str, port: int, insecure: bool, source: str | None = None) -> tuple[int, str, str]:
        resolve_ip = f"[{ip}]" if family == "v6" else ip
        argv = ["curl", "-sS", "-o", "/dev/null", "-w", "%{http_code} %{time_total}", "--connect-timeout", "1", "--max-time", "3", "-6" if family == "v6" else "-4",
                "--interface", source or (pop.customer6 if family == "v6" else pop.customer), "--cacert", "/lab/ca.crt",
                "--resolve", f"{host}:{port}:{resolve_ip}", f"https://{host}:{port}/"]
        if insecure:
            argv.insert(1, "-k")
        res = await self.runner.exec(self.c(pop.container), argv, timeout=8)
        return res.rc, res.out.strip(), res.err.strip()

    async def probe_once(self, state: State, journey: dict[str, Any], *, family: str = "v4", warm_cache: bool = False, kind: str = "journey",
                         probe_id: str | None = None, label: str | None = None) -> dict[str, Any]:
        node = node_by_id(self.topo, journey["from"])
        assert node
        pop = self.pop_for(node["id"])
        host = journey["host"]
        base = {"id": probe_id or (f"{journey['id']}-v6" if family == "v6" else journey["id"]), "kind": kind,
                "label": label or (f"{node['short']} IPv6 → {host}" if family == "v6" else journey["label"])}
        path = [node["id"], "B17", "GW-1", "SVC-1"]

        def fail(at: str, failure: str, detail: str, upto: int = 3) -> dict[str, Any]:
            return {**base, "ok": False, "path": path[:upto], "failedAt": at, "failure": failure, "detail": detail}

        if node["id"] in state["failedNodes"]:
            return {**base, "ok": False, "path": [node["id"]], "failedAt": node["id"], "failure": "node_down", "detail": f"{node['short']} is down (container paused)"}
        expected = (GW_VIPS_V6 if family == "v6" else GW_VIPS)[host]
        override = state["clients"]["hosts"].get(host)
        if override:
            ip = check_v4(override) if family == "v4" else expected
        else:
            server = DNS["primary"] if state["dns"]["active"] == "primary" else DNS["standby"]
            ip = await self._dig(pop, server, DNS_WARM_PORT if warm_cache else DNS_COLD_PORT, host, "AAAA" if family == "v6" else "A")
            if ip is None:
                return fail("DNS-1", "node_down", f"no answer resolving {host} (dig timeout/SERVFAIL)", 2)
        if ip != expected:
            return fail("GW-1", "wrong_address", f"{host} → {ip}: not the service VIP — connection would land on the wrong address")
        rc, out, err = await self._curl(pop, family, host, ip, 443, insecure=not state["clients"]["validateTls"])
        if rc == 0 and out.startswith("200"):
            ms = round(float(out.split()[1]) * 1000, 1)
            return {**base, "ok": True, "path": path, "latencyMs": ms, "detail": f"HTTP 200 in {ms} ms via real lab path ({pop.container} → b17 → gw1 → svc1)"}
        if rc == 60 and "expired" in err.lower():
            cert = state["gw"]["certs"][state["gw"]["bindings"][family]]
            mins = round(minutes_between(now_iso(), cert["notAfter"]))
            return fail("GW-1", "tls_expired", f"x509: certificate {cert['serial']} expired {mins} min ago ({family} listener) — curl exit 60")
        if rc in (51, 60):
            return fail("GW-1", "tls_name", f"TLS validation failed (curl exit {rc}): {err[:120]}")
        if rc in (7, 28):
            return fail("B17", "no_route", f"no return path for {pop.customer6 if family == 'v6' else pop.customer} — TCP {'timeout' if rc == 28 else 'unreachable'} (curl exit {rc})", 2)
        return fail("SVC-1", "node_down", f"HTTP {out[:3] or '—'} (curl exit {rc}) {err[:80]}", 4)

    async def sample(self, state: State, journey: dict[str, Any], **opts: Any) -> dict[str, Any]:
        samples = list(await asyncio.gather(*(self.probe_once(state, journey, **opts) for _ in range(SAMPLES))))
        failed = [s for s in samples if not s["ok"]]
        if not failed:
            ok = sorted(samples, key=lambda s: s["latencyMs"])
            return ok[len(ok) // 2]
        if len(failed) == len(samples):
            return failed[0]
        return {**failed[0], "failure": "intermittent", "detail": f"{len(failed)} of {len(samples)} samples failed — {failed[0]['detail']}"}

    async def negatives(self, state: State, edge_id: str, baseline: State | None = None) -> list[dict[str, Any]]:
        edge = self.pop_for(edge_id)
        admin = await self.runner.exec(self.c(edge.container), ["curl", "-s", "-o", "/dev/null", "--max-time", "2", "--interface", edge.customer,
                                                                f"http://{ADMIN[0]}:{ADMIN[1]}/"], timeout=6)
        exposed = admin.rc == 0
        rc, _out, err = await self._curl(edge, "v4", "expired.demo", EXPIRED_TEST[0], EXPIRED_TEST[1], insecure=not state["clients"]["validateTls"], source=edge.p2p_pop)
        validation = rc == 60
        mgmt = filter_decision(state["b17"], "10.99.0.0/16")
        probes = [
            _drop_none({"id": "NEG-1", "kind": "negative", "label": "Untrusted edge → admin port stays blocked", "ok": not exposed, "path": [edge_id, "B17"],
                        "failedAt": "B17" if exposed else None, "failure": "exposed" if exposed else None,
                        "detail": f"admin console {ADMIN[0]}:{ADMIN[1]} answered HTTP from untrusted {edge.customer} — management prefix leaked" if exposed
                        else f"no route from {edge.customer} (EDGE-IN seq {mgmt['rule']['seq'] if mgmt.get('rule') else 'implicit'}) — connection failed as required"}),
            _drop_none({"id": "NEG-2", "kind": "negative", "label": "Clients reject an expired test certificate", "ok": validation, "path": [edge_id, "GW-1"],
                        "failedAt": None if validation else "GW-1", "failure": None if validation else "validation_off",
                        "detail": "handshake refused as expected (curl exit 60)" if validation else f"expired test certificate was ACCEPTED (curl exit {rc}) {err[:60]}"}),
            _drop_none({"id": "CTRL-1", "kind": "control", "label": "Positive control: admin service exists for trusted operators",
                        "ok": state["mgmt"]["adminServiceUp"], "path": ["B17"], "failure": None if state["mgmt"]["adminServiceUp"] else "control_missing",
                        "detail": "reachable from the trusted management side (b17)" if state["mgmt"]["adminServiceUp"] else "protected service missing — negative test would be vacuous"}),
        ]
        if baseline is not None:
            changed = []
            for host in SERVICE_IPS:
                before = baseline["clients"]["hosts"].get(host) or (baseline["dns"]["primary"] if baseline["dns"]["active"] == "primary" else baseline["dns"]["standby"]).get(host)
                if before != SERVICE_IPS[host]:
                    continue
                if state["clients"]["hosts"].get(host):
                    after = state["clients"]["hosts"][host]
                else:
                    server = DNS["primary"] if state["dns"]["active"] == "primary" else DNS["standby"]
                    after = await self._dig(edge, server, DNS_COLD_PORT, host, "A")
                if after != before:
                    changed.append(f"{host}: {before} → {after or 'no answer'}")
            probes.insert(2, _drop_none({"id": "NEG-3", "kind": "negative", "label": "Unaffected DNS answers unchanged", "ok": not changed, "path": ["DNS-1"],
                                         "failedAt": "DNS-1" if changed else None, "failure": "record_changed" if changed else None,
                                         "detail": "; ".join(changed) if changed else "all previously correct answers identical (dig)"}))
        return probes

    async def fixed_suite(self, state: State, journeys: list[dict[str, Any]], edge_id: str, baseline: State | None = None) -> list[dict[str, Any]]:
        results = await asyncio.gather(*(self.sample(state, j) for j in journeys), self.negatives(state, edge_id, baseline))
        return [*results[:-1], *results[-1]]


def _drop_none(d: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in d.items() if v is not None}
