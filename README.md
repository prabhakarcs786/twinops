# twinops
TwinOps is an interactive proof-of-concept for safer autonomous network operations. When a simulated network incident occurs, TwinOps analyses topology, telemetry, alarms and recent changes, forms possible root-cause hypotheses, and reproduces the affected scenario inside an isolated digital twin.

## Frontend

Product site (`/`) and live workbench (`/workbench`), running a deterministic in-browser model twin until the backend exists. Requires Node 23.6+.

```sh
cd frontend
npm ci
npm run dev          # http://localhost:5173
npm test             # engine unit tests + Playwright E2E/axe (desktop + mobile)
```

Workbench URL options: `?fault=route_misconfig|dns_failure|cert_expiry|unsupported_link_flap`, `?speed=instant`, `?autostart=1`, `?pack=enterprise`.
