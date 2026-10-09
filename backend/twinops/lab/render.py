"""Renders device configuration (FRR, CoreDNS, nginx, certificates, Containerlab topology) from the shared state model.

All values that reach a config file are validated first: typed actions can only ever produce well-formed configuration.
"""

from __future__ import annotations

import ipaddress
import json
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from ..model import State, parse_iso
from .plan import ADMIN, B17_AS, DNS, GW_VIPS, GW_VIPS_V6, IMAGES, MGMT_SUBNETS, POPS

HOSTNAME = re.compile(r"^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$")
SERIAL = re.compile(r"^c-[0-9a-f]{3,12}$")


class RenderError(ValueError):
    pass


def check_v4(value: str) -> str:
    try:
        return str(ipaddress.IPv4Address(value))
    except ValueError as exc:
        raise RenderError(f"not an IPv4 address: {value!r}") from exc


def check_net(value: str, v6: bool = False) -> str:
    try:
        net = ipaddress.IPv6Network(value) if v6 else ipaddress.IPv4Network(value)
    except ValueError as exc:
        raise RenderError(f"not a network: {value!r}") from exc
    return str(net)


def check_host(value: str) -> str:
    if not HOSTNAME.match(value):
        raise RenderError(f"not a hostname: {value!r}")
    return value


# ---------- FRR ----------

def prefix_line(rule: dict[str, Any]) -> str:
    action = rule["action"]
    if action not in ("permit", "deny"):
        raise RenderError(f"bad prefix-list action {action!r}")
    return f"ip prefix-list EDGE-IN seq {int(rule['seq'])} {action} {check_net(rule['prefix'])} le 32"


def v6_seq(prefix: str) -> int:
    octet = int(prefix.split(":")[2])
    return 100 + octet


def v6_line(prefix: str) -> str:
    return f"ipv6 prefix-list EDGE-IN6 seq {v6_seq(prefix)} permit {check_net(prefix, v6=True)}"


def b17_frr_conf(state: State) -> str:
    lines = ["frr defaults traditional", "hostname b17", "log stdout informational", "service integrated-vtysh-config", "!"]
    for p in POPS:
        lines += [f"interface {p.b17_if}", f" ip address {p.p2p_b17}/31", f" ipv6 address {p.p2p6_b17}/64", "!"]
    lines += ["interface eth5", " ip address 10.40.0.1/24", " ipv6 address 2001:db8:40::1/64", "!",
              "interface eth6", " ip address 10.30.0.1/24", "!", "interface eth7", " ip address 10.30.1.1/24", "!",
              "interface eth8", " ip address 10.99.0.1/24", "!",
              "ip route 10.0.0.0/8 Null0 250", "ipv6 route 2001:db8::/32 Null0 250", "!"]
    lines += [prefix_line(r) for r in sorted(state["b17"]["prefixList"], key=lambda r: r["seq"])]
    lines += [v6_line(p) for p in state["b17"]["v6Prefixes"]]
    lines += ["!", f"router bgp {B17_AS}", " bgp router-id 10.255.0.17", " no bgp ebgp-requires-policy", " no bgp network import-check",
              " timers bgp 3 9"]
    for p in POPS:
        lines += [f" neighbor {p.p2p_pop} remote-as {p.asn}", f" neighbor {p.p2p_pop} advertisement-interval 0", f" neighbor {p.p2p_pop} timers connect 5",
                  f" neighbor {p.p2p6_pop} remote-as {p.asn}", f" neighbor {p.p2p6_pop} advertisement-interval 0", f" neighbor {p.p2p6_pop} timers connect 5"]
    lines += [" address-family ipv4 unicast", "  redistribute connected"]
    for p in POPS:
        lines.append(f"  no neighbor {p.p2p6_pop} activate")
        if state["b17"]["filterEnabled"]:
            lines += [f"  neighbor {p.p2p_pop} prefix-list EDGE-IN in", f"  neighbor {p.p2p_pop} prefix-list EDGE-IN out"]
    lines += [" exit-address-family", " address-family ipv6 unicast", "  redistribute connected"]
    for p in POPS:
        lines += [f"  neighbor {p.p2p6_pop} activate", f"  neighbor {p.p2p6_pop} prefix-list EDGE-IN6 in"]
    lines += [" exit-address-family", "!", "line vty", "!"]
    return "\n".join(lines) + "\n"


def pop_frr_conf(index: int) -> str:
    p = POPS[index]
    return "\n".join([
        "frr defaults traditional", f"hostname {p.container}", "log stdout informational", "service integrated-vtysh-config", "!",
        "interface lo", f" ip address {p.customer}/16", f" ipv6 address {p.customer6}/48", "!",
        "interface eth1", f" ip address {p.p2p_pop}/31", f" ipv6 address {p.p2p6_pop}/64", "!",
        "ip route 10.0.0.0/8 Null0 250", "ipv6 route 2001:db8::/32 Null0 250", "!",
        f"router bgp {p.asn}", f" bgp router-id {p.p2p_pop}", " no bgp ebgp-requires-policy", " no bgp network import-check", " timers bgp 3 9",
        f" neighbor {p.p2p_b17} remote-as {B17_AS}", f" neighbor {p.p2p_b17} advertisement-interval 0", f" neighbor {p.p2p_b17} timers connect 5",
        f" neighbor {p.p2p6_b17} remote-as {B17_AS}", f" neighbor {p.p2p6_b17} advertisement-interval 0", f" neighbor {p.p2p6_b17} timers connect 5",
        " address-family ipv4 unicast", f"  network 10.{p.octet}.0.0/16", f"  no neighbor {p.p2p6_b17} activate", " exit-address-family",
        " address-family ipv6 unicast", f"  network 2001:db8:{p.octet}::/48", f"  neighbor {p.p2p6_b17} activate", " exit-address-family", "!",
        "line vty", "!",
    ]) + "\n"


DAEMONS = """zebra=yes
bgpd=yes
staticd=yes
ospfd=no
ospf6d=no
ripd=no
ripngd=no
isisd=no
pimd=no
ldpd=no
nhrpd=no
eigrpd=no
babeld=no
sharpd=no
pbrd=no
bfdd=no
fabricd=no
vrrpd=no
pathd=no
vtysh_enable=yes
zebra_options="  -A 127.0.0.1 -s 90000000"
bgpd_options="   -A 127.0.0.1"
staticd_options="-A 127.0.0.1"
"""


# ---------- DNS ----------

COREFILE = """demo:53 {
    cache 3600
    file /etc/coredns/db.demo {
        reload 1s
    }
}
demo:5353 {
    file /etc/coredns/db.demo {
        reload 1s
    }
}
"""


def zone_file(records: dict[str, str], serial: int, ns_ip: str) -> str:
    lines = ["$ORIGIN demo.", "$TTL 3600", f"@ IN SOA ns.demo. hostmaster.demo. {int(serial)} 7200 3600 1209600 3600", "@ IN NS ns.demo.",
             f"ns IN A {check_v4(ns_ip)}"]
    for host, ip in sorted(records.items()):
        label = check_host(host).removesuffix(".demo")
        lines.append(f"{label} IN A {check_v4(ip)}")
        if host in GW_VIPS_V6:
            lines.append(f"{label} IN AAAA {GW_VIPS_V6[host]}")
    lines.append(f"expired IN A {GW_VIPS['svc.demo']}")
    return "\n".join(lines) + "\n"


# ---------- nginx ----------

GW_NGINX = """worker_processes 1;
events { worker_connections 256; }
http {
  access_log off;
  error_log /dev/stderr warn;
  upstream svc { server 10.50.0.2:80; }
  server {
    listen 443 ssl;
    server_name svc.demo api.demo;
    ssl_certificate /certs/v4.crt;
    ssl_certificate_key /certs/v4.key;
    location / { proxy_pass http://svc; }
  }
  server {
    listen [::]:443 ssl ipv6only=on;
    server_name svc.demo api.demo;
    ssl_certificate /certs/v6.crt;
    ssl_certificate_key /certs/v6.key;
    location / { proxy_pass http://svc; }
  }
  server {
    listen 9443 ssl;
    server_name expired.demo;
    ssl_certificate /certs/expired.crt;
    ssl_certificate_key /certs/expired.key;
    location / { return 200 "expired-test\\n"; }
  }
}
"""

SVC_NGINX = f"""worker_processes 1;
events {{ worker_connections 256; }}
http {{
  access_log off;
  server {{ listen 80; location / {{ return 200 "svc ok\\n"; }} }}
  server {{ listen {ADMIN[1]}; location / {{ return 200 "admin console (restricted)\\n"; }} }}
}}
"""


# ---------- certificates ----------

def _crypto():
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    return x509, hashes, serialization, ec, NameOID


def ensure_ca(ca_dir: Path) -> tuple[Any, Any]:
    x509, hashes, serialization, ec, NameOID = _crypto()
    ca_dir.mkdir(parents=True, exist_ok=True)
    key_path, crt_path = ca_dir / "ca.key", ca_dir / "ca.crt"
    if key_path.exists() and crt_path.exists():
        key = serialization.load_pem_private_key(key_path.read_bytes(), None)
        return key, x509.load_pem_x509_certificate(crt_path.read_bytes())
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "TwinOps Demo Internal CA")])
    now = datetime.now(UTC)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(days=1)).not_valid_after(now + timedelta(days=3650))
            .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True).sign(key, hashes.SHA256()))
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    key_path.chmod(0o600)
    crt_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    return key, cert


def write_leaf(ca_dir: Path, out_dir: Path, name: str, serial: str, not_after: str, san: list[str]) -> None:
    x509, hashes, serialization, ec, NameOID = _crypto()
    if not SERIAL.match(serial):
        raise RenderError(f"bad certificate serial label {serial!r}")
    names = [check_host(s) for s in san]
    ca_key, ca_cert = ensure_ca(ca_dir)
    key = ec.generate_private_key(ec.SECP256R1())
    end = parse_iso(not_after)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, names[0] if names else "gw1.demo"),
                         x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, f"twinops-serial:{serial}")])
    cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(ca_cert.subject).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(end - timedelta(days=398)).not_valid_after(end)
            .add_extension(x509.SubjectAlternativeName([x509.DNSName(n) for n in names]), critical=False).sign(ca_key, hashes.SHA256()))
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"{name}.key").write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    (out_dir / f"{name}.key").chmod(0o644)
    (out_dir / f"{name}.crt").write_bytes(cert.public_bytes(serialization.Encoding.PEM))


def read_leaf(path: Path) -> dict[str, Any]:
    x509, *_rest, NameOID = _crypto()
    cert = x509.load_pem_x509_certificate(path.read_bytes())
    ou = cert.subject.get_attributes_for_oid(NameOID.ORGANIZATIONAL_UNIT_NAME)
    serial = ou[0].value.split(":", 1)[1] if ou else "unknown"
    san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value.get_values_for_type(x509.DNSName)
    end = cert.not_valid_after_utc
    return {"serial": serial, "notAfter": end.strftime("%Y-%m-%dT%H:%M:%S.000Z"), "san": list(san)}


# ---------- Containerlab topology ----------

def topology(instance: str) -> dict[str, Any]:
    v4, v6 = MGMT_SUBNETS[instance]
    fwd = {"net.ipv4.ip_forward": 1, "net.ipv6.conf.all.forwarding": 1, "net.ipv6.conf.all.disable_ipv6": 0, "net.ipv6.conf.default.disable_ipv6": 0}
    v6on = {"net.ipv6.conf.all.disable_ipv6": 0, "net.ipv6.conf.default.disable_ipv6": 0}
    nodes: dict[str, Any] = {
        "b17": {"kind": "linux", "image": IMAGES["frr"], "sysctls": fwd,
                "binds": [f"{instance}/b17/frr.conf:/etc/frr/frr.conf", "shared/daemons:/etc/frr/daemons", "shared/vtysh.conf:/etc/frr/vtysh.conf"]},
        "gw1": {"kind": "linux", "image": IMAGES["web"], "sysctls": v6on,
                "binds": [f"{instance}/gw1/nginx.conf:/etc/nginx/nginx.conf:ro", f"{instance}/gw1/certs:/certs"],
                "exec": ["ip addr add 10.40.0.10/24 dev eth1", "ip addr add 10.40.0.11/24 dev eth1", "ip -6 addr add 2001:db8:40::10/64 dev eth1",
                         "ip -6 addr add 2001:db8:40::11/64 dev eth1", "ip route add 10.0.0.0/8 via 10.40.0.1", "ip -6 route add 2001:db8::/32 via 2001:db8:40::1",
                         "ip addr add 10.50.0.1/30 dev eth2"]},
        "svc1": {"kind": "linux", "image": IMAGES["web"], "binds": [f"{instance}/svc1/nginx.conf:/etc/nginx/nginx.conf:ro"],
                 "exec": ["ip addr add 10.50.0.2/30 dev eth1", f"ip addr add {ADMIN[0]}/24 dev eth2", "ip route add 10.0.0.0/8 via 10.99.0.1"]},
        "dns1": {"kind": "linux", "image": IMAGES["dns"], "binds": [f"{instance}/dns1:/etc/coredns"],
                 "exec": [f"ip addr add {DNS['primary']}/24 dev eth1", "ip route add 10.0.0.0/8 via 10.30.0.1"]},
        "dns2": {"kind": "linux", "image": IMAGES["dns"], "binds": [f"{instance}/dns2:/etc/coredns"],
                 "exec": [f"ip addr add {DNS['standby']}/24 dev eth1", "ip route add 10.0.0.0/8 via 10.30.1.1"]},
    }
    for p in POPS:
        nodes[p.container] = {"kind": "linux", "image": IMAGES["frr"], "sysctls": fwd,
                              "binds": [f"{instance}/{p.container}/frr.conf:/etc/frr/frr.conf", "shared/daemons:/etc/frr/daemons",
                                        "shared/vtysh.conf:/etc/frr/vtysh.conf", "ca/ca.crt:/lab/ca.crt:ro"]}
    links = [{"endpoints": [f"b17:{p.b17_if}", f"{p.container}:eth1"]} for p in POPS]
    links += [{"endpoints": ["b17:eth5", "gw1:eth1"]}, {"endpoints": ["b17:eth6", "dns1:eth1"]}, {"endpoints": ["b17:eth7", "dns2:eth1"]},
              {"endpoints": ["b17:eth8", "svc1:eth2"]}, {"endpoints": ["gw1:eth2", "svc1:eth1"]}]
    return {"name": f"twinops-{instance}", "mgmt": {"network": f"twinops-{instance}-mgmt", "ipv4-subnet": v4, "ipv6-subnet": v6},
            "topology": {"nodes": nodes, "links": links}}


def write_runtime(runtime: Path, state: State) -> None:
    """Writes initial configs for both instances from a healthy state."""
    shared = runtime / "shared"
    shared.mkdir(parents=True, exist_ok=True)
    (shared / "daemons").write_text(DAEMONS)
    (shared / "vtysh.conf").write_text("service integrated-vtysh-config\n")
    ensure_ca(runtime / "ca")
    for instance in ("prod", "twin"):
        base = runtime / instance
        (base / "b17").mkdir(parents=True, exist_ok=True)
        (base / "b17" / "frr.conf").write_text(b17_frr_conf(state))
        for p in POPS:
            (base / p.container).mkdir(parents=True, exist_ok=True)
            (base / p.container / "frr.conf").write_text(pop_frr_conf(p.index))
        for name, zone, ip in (("dns1", state["dns"]["primary"], DNS["primary"]), ("dns2", state["dns"]["standby"], DNS["standby"])):
            (base / name).mkdir(parents=True, exist_ok=True)
            (base / name / "Corefile").write_text(COREFILE)
            (base / name / "db.demo").write_text(zone_file(zone, state["dns"]["serial"], ip))
        (base / "gw1" / "certs").mkdir(parents=True, exist_ok=True)
        (base / "gw1" / "nginx.conf").write_text(GW_NGINX)
        for family in ("v4", "v6"):
            serial = state["gw"]["bindings"][family]
            cert = state["gw"]["certs"][serial]
            write_leaf(runtime / "ca", base / "gw1" / "certs", family, serial, cert["notAfter"], cert["san"])
        write_leaf(runtime / "ca", base / "gw1" / "certs", "expired", "c-0e0", "2025-01-01T00:00:00.000Z", ["expired.demo"])
        (base / "svc1").mkdir(parents=True, exist_ok=True)
        (base / "svc1" / "nginx.conf").write_text(SVC_NGINX)
        (runtime / f"twinops-{instance}.clab.yml").write_text(json.dumps(topology(instance), indent=2))
