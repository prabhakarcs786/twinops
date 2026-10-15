#!/usr/bin/env bash
# Boot script for the lab VM (runs as root on every boot); installs the toolchain once.
set -euo pipefail
# Swap guards the 2 GB machine against brief memory spikes; the stack itself uses about 1.3 GB.
if [[ ! -f /swapfile ]]; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
swapon -a
[[ -f /var/lib/twinops-ready ]] && exit 0
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q docker.io python3-venv tmux ca-certificates curl
# Ubuntu's own nodejs is too old for Vite; NodeSource ships the current LTS.
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y -q nodejs
systemctl enable --now docker
touch /var/lib/twinops-ready
