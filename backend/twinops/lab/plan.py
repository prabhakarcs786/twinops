"""Addressing plan and naming for the emulated lab. One plan, two isolated instances: `prod` (demo network) and `twin`."""

from __future__ import annotations

import os
from dataclasses import dataclass
from ipaddress import ip_network

INSTANCES = ("prod", "twin")
MGMT_SUBNETS = {"prod": ("172.30.10.0/24", "3fff:172:30:10::/64"), "twin": ("172.30.11.0/24", "3fff:172:30:11::/64")}


def management_subnets(instance: str) -> tuple[str, str]:
    v4, v6 = MGMT_SUBNETS[instance]
    subnet = os.environ.get(f'TWINOPS_LAB_{instance.upper()}_SUBNET', v4)
    network = ip_network(subnet)
    if network.version != 4 or network.prefixlen > 27:
        raise ValueError('Lab management subnet must be IPv4 with at least 32 addresses')
    return str(network), v6

IMAGES = {"frr": "twinops/frr-node:0.1", "dns": "twinops/dns:0.1", "web": "twinops/web:0.1"}

# pop index → customer prefix octet (matches topology.py: pop0 10.20, pop1 10.22, pop2 10.21, pop3 10.23)
POP_OCTETS = (20, 22, 21, 23)
B17_AS = 65017
DNS = {"primary": "10.30.0.53", "standby": "10.30.1.53"}
DNS_COLD_PORT = 5353
DNS_WARM_PORT = 53
GW_VIPS = {"svc.demo": "10.40.0.10", "api.demo": "10.40.0.11"}
GW_VIPS_V6 = {"svc.demo": "2001:db8:40::10", "api.demo": "2001:db8:40::11"}
ADMIN = ("10.99.0.10", 8443)
EXPIRED_TEST = ("10.40.0.10", 9443)

NODE_CONTAINER = {"B17": "b17", "DNS-1": "dns1", "GW-1": "gw1", "SVC-1": "svc1"}


@dataclass(frozen=True)
class Pop:
    index: int
    container: str
    octet: int
    asn: int
    customer: str
    customer6: str
    p2p_b17: str
    p2p_pop: str
    p2p6_b17: str
    p2p6_pop: str
    b17_if: str


def pop(index: int) -> Pop:
    octet = POP_OCTETS[index]
    n = index + 1
    return Pop(index, f"p{index}", octet, 65101 + index, f"10.{octet}.0.1", f"2001:db8:{octet}::1",
               f"10.255.{n}.0", f"10.255.{n}.1", f"2001:db8:ff:{n}::1", f"2001:db8:ff:{n}::2", f"eth{n}")


POPS = tuple(pop(i) for i in range(4))


def container(instance: str, name: str) -> str:
    return f"clab-twinops-{instance}-{name}"
