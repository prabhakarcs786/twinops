"""Lab layer without Docker: renderers reject injection, pushes are minimal diffs, probes classify real tool exit codes."""

import asyncio
import json
import time
from pathlib import Path

import pytest

from twinops.lab.device import LabInstance
from twinops.lab.plan import GW_VIPS, POPS, container
from twinops.lab.render import (
    RenderError,
    b17_frr_conf,
    check_host,
    check_net,
    prefix_line,
    read_leaf,
    topology,
    write_leaf,
    zone_file,
)
from twinops.lab.runner import DockerRunner, LabError, Result
from twinops.model import healthy_state
from twinops.topology import build_topology


class FakeRunner:
    """Answers `docker exec` calls from a handler; records every argv for assertions."""

    def __init__(self, handler):
        self.handler = handler
        self.calls: list[tuple[str, list[str]]] = []

    async def exec(self, name: str, argv: list[str], timeout: float = 10) -> Result:
        self.calls.append((name, argv))
        return self.handler(name, argv)

    async def control(self, verb: str, *names: str, timeout: float = 30) -> Result:
        return Result(0, "", "")


def lab(handler, tmp_path: Path) -> tuple[LabInstance, FakeRunner, dict]:
    topo = build_topology("core")
    runner = FakeRunner(handler)
    return LabInstance("twin", tmp_path, topo, runner, settle_s=0), runner, topo  # type: ignore[arg-type]


# ---------- renderers ----------

@pytest.mark.parametrize("bad", ["10.0.0.0/8; rm -rf /", "10.0.0.0/8\nline vty", "any", ""])
def test_prefix_renderer_rejects_injection(bad):
    with pytest.raises(RenderError):
        prefix_line({"seq": 30, "action": "permit", "prefix": bad})
    with pytest.raises(RenderError):
        check_net(bad)


def test_prefix_renderer_rejects_unknown_action():
    with pytest.raises(RenderError):
        prefix_line({"seq": 30, "action": "permit any", "prefix": "10.0.0.0/8"})


@pytest.mark.parametrize("bad", ["svc.demo;reboot", "svc demo", "$(id).demo", "../etc"])
def test_hostname_validation(bad):
    with pytest.raises(RenderError):
        check_host(bad)


def test_b17_config_carries_policy_and_all_sessions():
    conf = b17_frr_conf(healthy_state(build_topology("core")))
    assert "ip prefix-list EDGE-IN seq 10 deny 10.99.0.0/16 le 32" in conf
    for p in POPS:
        assert f" neighbor {p.p2p_pop} timers connect 5" in conf
        assert f"  neighbor {p.p2p_pop} prefix-list EDGE-IN in" in conf
        assert f"  neighbor {p.p2p6_pop} activate" in conf


def test_zone_file_has_v4_and_v6_records():
    zone = zone_file({"svc.demo": GW_VIPS["svc.demo"]}, 7, "10.30.0.53")
    assert "svc IN A 10.40.0.10" in zone and "svc IN AAAA 2001:db8:40::10" in zone
    with pytest.raises(RenderError):
        zone_file({"svc.demo": "10.40.0.10\n@ IN NS evil."}, 7, "10.30.0.53")


def test_certificate_roundtrip_keeps_serial_and_expiry(tmp_path):
    write_leaf(tmp_path / "ca", tmp_path / "certs", "v4", "c-5a1", "2026-12-01T10:00:00.000Z", ["svc.demo", "api.demo"])
    leaf = read_leaf(tmp_path / "certs" / "v4.crt")
    assert leaf == {"serial": "c-5a1", "notAfter": "2026-12-01T10:00:00.000Z", "san": ["svc.demo", "api.demo"]}
    assert oct((tmp_path / "ca" / "ca.key").stat().st_mode & 0o777) == "0o600"
    with pytest.raises(RenderError):
        write_leaf(tmp_path / "ca", tmp_path / "certs", "v4", "c-5a1; rm", "2026-12-01T10:00:00.000Z", ["svc.demo"])


def test_topology_isolates_instances():
    prod, twin = topology("prod"), topology("twin")
    assert prod["mgmt"]["ipv4-subnet"] != twin["mgmt"]["ipv4-subnet"]
    assert len(twin["topology"]["nodes"]) == 9 and len(twin["topology"]["links"]) == 9


# ---------- runner guard rails ----------

def test_runner_only_executes_allow_listed_binaries():
    runner = DockerRunner(docker="/nonexistent-docker")
    with pytest.raises(LabError):
        asyncio.run(runner.exec("clab-twinops-twin-b17", ["sh", "-c", "id"]))
    with pytest.raises(LabError):
        asyncio.run(runner.control("restart", "clab-twinops-twin-dns1"))


# ---------- push / capture ----------

RUNNING_CONFIG = """frr version 9.1
ip prefix-list EDGE-IN seq 10 deny 10.99.0.0/16 le 32
ip prefix-list EDGE-IN seq 30 deny 10.20.0.0/15 le 32
ip prefix-list EDGE-IN seq 100 permit 10.0.0.0/8 le 32
ipv6 prefix-list EDGE-IN6 seq 120 permit 2001:db8:20::/48
!
interface eth1
 description core-b17 edge aggregation
!
router bgp 65017
 address-family ipv4 unicast
  neighbor 10.255.1.1 prefix-list EDGE-IN in
"""


def test_capture_parses_running_config(tmp_path):
    inst, _runner, _topo = lab(lambda _n, argv: Result(0, RUNNING_CONFIG, ""), tmp_path)
    routing = asyncio.run(inst.capture_routing())
    assert [r["seq"] for r in routing["prefixList"]] == [10, 30, 100]
    assert routing["v6Prefixes"] == ["2001:db8:20::/48"]
    assert routing["filterEnabled"] is True
    assert routing["description"] == "core-b17 edge aggregation"


def test_routing_push_is_a_minimal_diff_and_refreshes_both_families(tmp_path):
    inst, runner, topo = lab(lambda _n, argv: Result(0, RUNNING_CONFIG if "show running-config" in argv else "", ""), tmp_path)
    target = healthy_state(topo)
    target["b17"]["v6Prefixes"] = ["2001:db8:20::/48"]
    asyncio.run(inst._push_routing(target, None))
    pushed = runner.calls[-1][1]
    commands = [pushed[i + 1] for i, a in enumerate(pushed) if a == "-c"]
    assert "no ip prefix-list EDGE-IN seq 30 deny 10.20.0.0/15 le 32" in commands
    assert not any("seq 10 " in c or "seq 100 " in c for c in commands), "unchanged rules must not be touched"
    assert commands[-2:] == ["clear bgp ipv4 unicast * soft", "clear bgp ipv6 unicast * soft"]


def summary(states: dict[str, str]) -> str:
    return json.dumps({"tableVersion": 5, "peers": {addr: {"state": s, "pfxRcd": 1, "pfxSnt": 9, "outq": 0, "inq": 0, "connectionsEstablished": 1}
                                                    for addr, s in states.items()}})


def test_convergence_ignores_paused_pops(tmp_path):
    states = {p.p2p_pop: "Established" for p in POPS} | {p.p2p6_pop: "Established" for p in POPS}
    states[POPS[3].p2p_pop] = states[POPS[3].p2p6_pop] = "Active"
    inst, _runner, _topo = lab(lambda _n, argv: Result(0, summary(states), ""), tmp_path)

    inst.paused = {container("twin", POPS[3].container)}
    started = time.monotonic()
    asyncio.run(inst.wait_converged(timeout=5))
    assert time.monotonic() - started < 2

    inst.paused = set()
    started = time.monotonic()
    asyncio.run(inst.wait_converged(timeout=1))
    assert time.monotonic() - started >= 1, "a running PoP that is not Established must block convergence"


# ---------- probes ----------

def probe_lab(tmp_path, dig_answer: str, curl: Result):
    def handler(_name, argv):
        if argv[0] == "dig":
            return Result(0, dig_answer + "\n", "")
        if argv[0] == "curl":
            return curl
        return Result(0, "", "")

    inst, _runner, topo = lab(handler, tmp_path)
    state = healthy_state(topo)
    journey = next(j for j in topo["journeys"] if j["host"] == "svc.demo")
    return asyncio.run(inst.probe_once(state, journey))


def test_probe_success_reports_measured_latency(tmp_path):
    result = probe_lab(tmp_path, GW_VIPS["svc.demo"], Result(0, "200 0.0123", ""))
    assert result["ok"] and result["latencyMs"] == 12.3


def test_probe_classifies_missing_return_path(tmp_path):
    result = probe_lab(tmp_path, GW_VIPS["svc.demo"], Result(28, "000 1.0", "curl: (28) Connection timed out"))
    assert result["failure"] == "no_route" and "curl exit 28" in result["detail"]


def test_probe_classifies_expired_certificate(tmp_path):
    result = probe_lab(tmp_path, GW_VIPS["svc.demo"], Result(60, "000 0.01", "SSL certificate problem: certificate has expired"))
    assert result["failure"] == "tls_expired"


def test_probe_flags_wrong_dns_answer_without_connecting(tmp_path):
    result = probe_lab(tmp_path, "10.40.0.99", Result(0, "200 0.01", ""))
    assert result["failure"] == "wrong_address"
