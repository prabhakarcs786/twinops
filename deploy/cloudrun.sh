#!/usr/bin/env bash
# Deploys TwinOps (API + SSE + frontend) to Cloud Run with the model twin.
# Containerlab needs privileged Docker, which Cloud Run does not offer; run the emulated twin on a lab host instead.
#
# Prerequisites (run once, yourself):
#   gcloud auth login && gcloud config set project <PROJECT_ID>
#   gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com
#   LLM via API key: printf '%s' "$GEMINI_API_KEY" | gcloud secrets create twinops-gemini-key --data-file=-
#   Operator passcode: printf '%s' "<passcode>" | gcloud secrets create twinops-operator-token --data-file=-
#   (grant the runtime service account roles/secretmanager.secretAccessor on both secrets)
#
# Usage: deploy/cloudrun.sh [--vertex]
#   --vertex  use Vertex AI with the service account's identity instead of an API key secret
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-europe-west1}"
SERVICE="${SERVICE:-twinops}"
MODEL="${TWINOPS_LLM_MODEL:-gemini-2.5-flash}"

if [[ -z "${PROJECT_ID}" ]]; then
  echo "Set PROJECT_ID or run: gcloud config set project <PROJECT_ID>" >&2
  exit 1
fi

ENV_VARS="TWINOPS_TWIN=model,TWINOPS_PLANNER=auto,TWINOPS_LLM_MODEL=${MODEL},TWINOPS_MAX_ACTIVE_RUNS=4,TWINOPS_RATE_LIMIT_PER_MIN=10"
SECRETS="TWINOPS_OPERATOR_TOKEN=twinops-operator-token:latest"

if [[ "${1:-}" == "--vertex" ]]; then
  ENV_VARS="${ENV_VARS},GOOGLE_GENAI_USE_VERTEXAI=true,GOOGLE_CLOUD_PROJECT=${PROJECT_ID},GOOGLE_CLOUD_LOCATION=${REGION}"
else
  SECRETS="${SECRETS},GEMINI_API_KEY=twinops-gemini-key:latest"
fi

# Active tasks live in memory, SQLite evidence is local/ephemeral, and SSE streams are long-lived:
# one instance (no cross-instance state), session affinity, request timeout above the approval window.
gcloud run deploy "${SERVICE}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --source . \
  --port 8080 \
  --cpu 1 --memory 1Gi \
  --min-instances 1 --max-instances 1 \
  --concurrency 80 \
  --timeout 900 \
  --session-affinity \
  --no-cpu-throttling \
  --set-env-vars "${ENV_VARS}" \
  --set-secrets "${SECRETS}" \
  --allow-unauthenticated

URL="$(gcloud run services describe "${SERVICE}" --project "${PROJECT_ID}" --region "${REGION}" --format 'value(status.url)')"
echo "Deployed: ${URL}"
curl -fsS "${URL}/api/config" && echo
