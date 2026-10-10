# TwinOps: one container serving the API (FastAPI + SSE) and the built frontend.
# Cloud Run runs the model twin; the Containerlab twin needs privileged Docker and runs on a lab host (see README).

# ---------- frontend ----------
FROM node:23-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---------- runtime ----------
FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY backend/pyproject.toml ./
COPY backend/twinops ./twinops
RUN pip install . \
 && python -m twinops.evaluation --planner runbook --seeds 10 --out /app/data/reports/runbook.json \
 && useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin twinops \
 && chown -R 10001:10001 /app/data
COPY --from=web /web/dist /app/static

ENV HOST=0.0.0.0 \
    PORT=8080 \
    TWINOPS_STATIC_DIR=/app/static \
    TWINOPS_DATA_DIR=/app/data \
    TWINOPS_TWIN=model
USER 10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD ["python", "-c", "import os, urllib.request; urllib.request.urlopen(f\"http://127.0.0.1:{os.environ.get('PORT', '8080')}/api/health\", timeout=2)"]
CMD ["python", "-m", "twinops"]
