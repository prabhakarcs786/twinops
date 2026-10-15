#!/usr/bin/env bash
# Hosts the connected demo (Metro Network + TwinOps + both Containerlab labs) on one small Compute Engine VM.
# Cloud Run cannot run privileged Containerlab, so this VM runs what `npm run dev:connected` runs locally,
# published at https://twinops.<ip>.sslip.io and https://metro.<ip>.sslip.io (Caddy, automatic HTTPS).
#
# Usage: deploy/vm.sh create | sync | start | stop | logs | url | ssh | delete
#   create  reserve a static IP and make the VM (toolchain installs on first boot)
#   sync    upload this working tree (no .env, keys or local evidence), build it and (re)start the public site; rerun after code changes
#   start   start the VM; the site comes back on its own   ·   stop  stop it (disk and reserved IP are still billed)
#   logs    follow the stack's logs   ·   url  print the public URLs   ·   delete  remove the VM and its IP
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
ZONE="${ZONE:-europe-west1-b}"
REGION="${ZONE%-*}"
VM="${VM:-twinops-lab}"
ADDRESS="${VM}-ip"
TAG=twinops-web
# Measured: ~1.3 GB RAM and ~4.4 GB disk. Only CPU matters: the ×3 surge challenge needs dedicated vCPUs (shared-core e2-medium failed it).
MACHINE="${MACHINE:-e2-highcpu-2}"
DISK_GB="${DISK_GB:-10}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

gc() { gcloud --project "${PROJECT_ID}" "$@"; }
ssh_vm() { gc compute ssh "${VM}" --zone "${ZONE}" --quiet "$@"; }

wait_ready() {
  for _ in $(seq 1 60); do
    ssh_vm --command 'test -f /var/lib/twinops-ready' 2>/dev/null && return 0
    echo "• waiting for the VM to finish installing Docker, Python and Node…"
    sleep 10
  done
  echo "VM setup did not finish; inspect it with: deploy/vm.sh ssh, then sudo journalctl -u google-startup-scripts" >&2
  exit 1
}

suffix() { local ip; ip="$(gc compute addresses describe "${ADDRESS}" --region "${REGION}" --format='value(address)')"; echo "${ip//./-}.sslip.io"; }

# A reserved address keeps the public URLs (and their certificates) stable across stop/start.
ensure_public() {
  gc compute addresses describe "${ADDRESS}" --region "${REGION}" >/dev/null 2>&1 || gc compute addresses create "${ADDRESS}" --region "${REGION}" \
    --addresses "$(gc compute instances describe "${VM}" --zone "${ZONE}" --format='value(networkInterfaces[0].accessConfigs[0].natIP)')"
  gc compute firewall-rules describe "${TAG}" >/dev/null 2>&1 || gc compute firewall-rules create "${TAG}" --allow tcp:80,tcp:443 --target-tags "${TAG}" \
    --description 'TwinOps public HTTPS (Caddy); both apps stay bound to 127.0.0.1'
  gc compute instances add-tags "${VM}" --zone "${ZONE}" --tags "${TAG}"
}

wait_live() {
  local s; s="$(suffix)"
  for _ in $(seq 1 40); do
    if curl -sf -o /dev/null "https://twinops.${s}/api/health" && curl -sf -o /dev/null "https://metro.${s}/api/health"; then
      echo "✔ Live: TwinOps https://twinops.${s}  ·  Metro Network https://metro.${s}"
      return 0
    fi
    echo "• waiting for the lab and HTTPS certificates…"
    sleep 10
  done
  echo "Not reachable yet; inspect with: deploy/vm.sh logs" >&2
  return 1
}

case "${1:-}" in
  create)
    gc services enable compute.googleapis.com aiplatform.googleapis.com
    gc compute addresses describe "${ADDRESS}" --region "${REGION}" >/dev/null 2>&1 || gc compute addresses create "${ADDRESS}" --region "${REGION}"
    gc compute instances create "${VM}" --zone "${ZONE}" --machine-type "${MACHINE}" \
      --image-family ubuntu-2404-lts-amd64 --image-project ubuntu-os-cloud \
      --boot-disk-size "${DISK_GB}GB" --boot-disk-type pd-balanced \
      --address "${ADDRESS}" --tags "${TAG}" --scopes cloud-platform \
      --metadata-from-file startup-script="${ROOT}/deploy/vm-setup.sh"
    wait_ready
    echo "✔ VM ready. Next: deploy/vm.sh sync"
    ;;
  sync)
    wait_ready
    ensure_public
    # Tracked and new files only: .gitignore keeps .env, keys, node_modules, lab runtime and evidence on this machine.
    (cd "${ROOT}" && git ls-files -z --cached --others --exclude-standard | COPYFILE_DISABLE=1 tar --no-mac-metadata --null -T - -czf -) \
      | ssh_vm --command 'mkdir -p ~/twinops && tar -xzf - -C ~/twinops'
    ssh_vm --command "bash ~/twinops/deploy/vm-host.sh $(suffix) ${PROJECT_ID}"
    wait_live
    ;;
  start) gc compute instances start "${VM}" --zone "${ZONE}" && wait_live ;;
  stop) gc compute instances stop "${VM}" --zone "${ZONE}" ;;
  logs) ssh_vm --command 'sudo journalctl -u twinops -n 100 -f' ;;
  url) s="$(suffix)"; echo "TwinOps https://twinops.${s}  ·  Metro Network https://metro.${s}" ;;
  ssh) ssh_vm ;;
  delete) gc compute instances delete "${VM}" --zone "${ZONE}" && gc compute addresses delete "${ADDRESS}" --region "${REGION}" ;;
  *) sed -n '2,10p' "$0"; exit 1 ;;
esac
