# TwinOps connected demo for Cloud Run: TwinOps, Metro Network and both lab networks in ONE container.
# Lab nodes are Linux namespaces owned by a user namespace (no Docker, no privileged mode), so the service
# must use the second-generation execution environment. Routers are the same FRR 10.5.5 as the Containerlab lab.

# ---------- frontend ----------
FROM node:23-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM coredns/coredns:1.11.3 AS coredns

# ---------- runtime ----------
FROM quay.io/frrouting/frr:10.5.5
RUN apk add --no-cache python3 nginx curl bind-tools iproute2 util-linux tini \
 && addgroup root frrvty && addgroup root frr \
 && chown -R root:root /etc/frr /var/lib/nginx /var/log/nginx
COPY --from=coredns /coredns /usr/bin/coredns
WORKDIR /app
COPY backend/pyproject.toml backend/
COPY backend/twinops backend/twinops
COPY local-app local-app
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -q -e backend
COPY --from=web /web/dist /app/static
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080 \
    TWINOPS_STATIC_DIR=/app/static
EXPOSE 8080
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["unshare", "--user", "--map-root-user", "python", "-m", "twinops.cloudrun"]
