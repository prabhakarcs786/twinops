#!/usr/bin/env bash
# Deploys the connected demo to Cloud Run: TwinOps, Metro Network and both lab networks (FRR, CoreDNS, nginx)
# in ONE container, built from Linux namespaces instead of Docker. One URL: TwinOps at /, Metro Network at /metro/.
# Scales to zero, so it is billed only while someone uses it; every new instance starts a fresh, healthy lab.
#
# Prerequisites: as for deploy/cloudrun.sh (project set, APIs enabled, secret twinops-operator-token,
# runtime service account with Vertex AI User and Secret Manager Secret Accessor).
# Usage: deploy/cloudrun-lab.sh            CPU=4 MEMORY=2Gi deploy/cloudrun-lab.sh
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-europe-west1}"
SERVICE="${SERVICE:-twinops-live}"
CPU="${CPU:-2}"
MEMORY="${MEMORY:-1Gi}"
# Lab probes run as short-lived processes; more parallel ones than CPUs exhaust Cloud Run's CPU quota and skew latency.
LAB_CONCURRENCY="${LAB_CONCURRENCY:-${CPU}}"
MODEL="${TWINOPS_LLM_MODEL:-gemini-2.5-flash}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
URL="https://${SERVICE}-${NUMBER}.${REGION}.run.app"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/cloud-run-source-deploy/${SERVICE}"

CONFIG="$(mktemp)"
trap 'rm -f "${CONFIG}"' EXIT
cat > "${CONFIG}" <<EOF
steps:
- name: gcr.io/cloud-builders/docker
  args: [build, -f, deploy/cloudrun-lab.Dockerfile, -t, '${IMAGE}', .]
images: ['${IMAGE}']
EOF
gcloud builds submit "${ROOT}" --project "${PROJECT_ID}" --config "${CONFIG}"

# One instance holds both lab networks, so it never scales out; idle instances stop after ~15 minutes.
gcloud run deploy "${SERVICE}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --image "${IMAGE}" \
  --execution-environment gen2 \
  --cpu "${CPU}" --memory "${MEMORY}" --cpu-boost \
  --min-instances 0 --max-instances 1 \
  --no-cpu-throttling \
  --concurrency 80 --timeout 900 --session-affinity \
  --set-env-vars "TWINOPS_PUBLIC_URL=${URL},TWINOPS_LAB_CONCURRENCY=${LAB_CONCURRENCY},TWINOPS_PLANNER=auto,TWINOPS_LLM_MODEL=${MODEL},TWINOPS_RATE_LIMIT_PER_MIN=10,GOOGLE_GENAI_USE_VERTEXAI=true,GOOGLE_CLOUD_PROJECT=${PROJECT_ID},GOOGLE_CLOUD_LOCATION=${REGION}" \
  --set-secrets "TWINOPS_OPERATOR_TOKEN=twinops-operator-token:latest" \
  --allow-unauthenticated

for _ in $(seq 1 30); do
  if curl -fsS "${URL}/api/connections" | grep -q '"connected": *true'; then
    echo "✔ Live: TwinOps ${URL}  ·  Metro Network ${URL}/metro/"
    exit 0
  fi
  sleep 5
done
echo "Deployed, but Metro is not connected yet; check: gcloud run services logs read ${SERVICE} --region ${REGION}" >&2
exit 1
