#!/usr/bin/env bash
# Runs on the lab VM after each `deploy/vm.sh sync`: installs dependencies, builds the UI and
# (re)starts the public site. Caddy terminates HTTPS; both apps stay bound to 127.0.0.1.
# Usage: deploy/vm-host.sh <host suffix, e.g. 34-62-223-103.sslip.io> <gcp project>
set -euo pipefail
SUFFIX="$1"
PROJECT="$2"
cd "$HOME/twinops"

sudo usermod -aG docker "$USER"
touch .env && chmod 600 .env
set_env() { if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi; }
grep -q '^GOOGLE_CLOUD_PROJECT=' .env || printf '%s\n' TWINOPS_PLANNER=auto GOOGLE_GENAI_USE_VERTEXAI=true "GOOGLE_CLOUD_PROJECT=${PROJECT}" GOOGLE_CLOUD_LOCATION=europe-west1 >> .env
set_env TWINOPS_PUBLIC_URL "https://twinops.${SUFFIX}"
set_env TWINOPS_NETWORK_PUBLIC_URL "https://metro.${SUFFIX}"
# Same approval passcode as the Cloud Run deployment: a public site must not let anyone approve changes.
if ! grep -q '^TWINOPS_OPERATOR_TOKEN=' .env; then
  token="$(gcloud secrets versions access latest --secret twinops-operator-token --project "${PROJECT}")"
  echo "TWINOPS_OPERATOR_TOKEN=${token}" >> .env
fi

[ -x .venv/bin/python ] || python3 -m venv .venv
.venv/bin/pip install -q -e backend
[ frontend/node_modules/.package-lock.json -nt frontend/package-lock.json ] || npm --prefix frontend ci --no-audit --no-fund
npm --prefix frontend run build --silent

command -v caddy >/dev/null || { sudo apt-get update -q && sudo apt-get install -y -q caddy; }
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
twinops.${SUFFIX} {
	reverse_proxy 127.0.0.1:8000
}
metro.${SUFFIX} {
	reverse_proxy 127.0.0.1:8010
}
EOF

sudo tee /etc/systemd/system/twinops.service >/dev/null <<EOF
[Unit]
Description=TwinOps connected demo (Metro Network, TwinOps, Containerlab)
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
User=${USER}
WorkingDirectory=${HOME}/twinops
ExecStart=/usr/bin/node scripts/dev.mjs --connected --hosted
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

tmux kill-session -t twinops 2>/dev/null || true
sudo systemctl daemon-reload
sudo systemctl enable --quiet caddy twinops
sudo systemctl reload-or-restart caddy
sudo systemctl restart twinops
