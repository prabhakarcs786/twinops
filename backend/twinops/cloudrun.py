"""Cloud Run entrypoint for the connected demo: TwinOps, Metro Network and both lab networks in one container.

Run inside a user namespace (`unshare --user --map-root-user python -m twinops.cloudrun`): the lab nodes are
Linux namespaces it owns, so no Docker or privileged mode is needed. TwinOps serves the public port and Metro's
pages under /metro; Metro and the connector stay on 127.0.0.1. Everything is rebuilt healthy when an instance starts.
"""

from __future__ import annotations

import os
import secrets
import signal
import subprocess
import sys
import time

from .config import _bool


def main() -> int:
    public = os.environ["TWINOPS_PUBLIC_URL"].rstrip("/")
    base = {
        **os.environ,
        "PYTHONUNBUFFERED": "1",
        "TWINOPS_LAB_RUNTIME": "netns",
        "TWINOPS_TWIN": "emulated",
        "TWINOPS_HARNESS": "false",
        "TWINOPS_APPLY_ENABLED": os.environ.get("TWINOPS_APPLY_ENABLED", "true"),
        "TWINOPS_NETWORK_URL": "http://127.0.0.1:8010",
        "TWINOPS_NETWORK_PROXY_PREFIX": "/metro",
        "TWINOPS_NETWORK_TOKEN": secrets.token_hex(32),
        "TWINOPS_NETWORK_PUBLIC_URL": f"{public}/metro/",
        "TWINOPS_LAB_DIR": os.environ.get("TWINOPS_LAB_DIR", "/var/lib/twinops/lab"),
        "TWINOPS_DATA_DIR": os.environ.get("TWINOPS_DATA_DIR", "/var/lib/twinops/data"),
        "TWINOPS_NETWORK_DATA": "/var/lib/twinops/metro/state.json",
    }
    demo_approval = _bool("TWINOPS_DEMO_APPROVAL", False)
    if demo_approval and _bool("TWINOPS_REQUIRE_AUTH", False):
        print("Demo approval cannot be combined with role authentication", file=sys.stderr)
        return 1
    if not base.get("TWINOPS_OPERATOR_TOKEN") and not demo_approval:
        print("TWINOPS_OPERATOR_TOKEN is required unless synthetic demo approval is explicitly enabled", file=sys.stderr)
        return 1
    python = sys.executable
    api = subprocess.Popen([python, "-m", "twinops"], env={**base, "HOST": "0.0.0.0", "PORT": os.environ.get("PORT", "8080"),  # noqa: S104
                                                           "TWINOPS_CORS_ORIGINS": public})
    children = [api]

    def stop(*_args: object) -> None:
        for child in children:
            if child.poll() is None:
                child.terminate()

    signal.signal(signal.SIGTERM, stop)
    started = time.monotonic()
    if subprocess.call([python, "-m", "twinops.lab", "up"], env=base) != 0:
        stop()
        return 1
    print(f"lab networks ready in {time.monotonic() - started:.1f}s", flush=True)
    children.append(subprocess.Popen([python, "-m", "twinops.network_app"], env={**base, "TWINOPS_UI_URL": public}))
    while all(child.poll() is None for child in children):
        time.sleep(1)
    stop()
    return next((child.returncode for child in children if child.returncode), 0)


if __name__ == "__main__":
    raise SystemExit(main())
