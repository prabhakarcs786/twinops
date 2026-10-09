import { defineConfig, devices } from '@playwright/test';

/**
 * Live integration suite: the real FastAPI backend serves the built frontend and runs incidents
 * server-side (model twin, runbook planner), streaming events over SSE. Run: npm run test:live
 */
const PORT = 8077;

export default defineConfig({
  testDir: './tests/live',
  timeout: 90_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    reducedMotion: 'reduce',
  },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: 'npm run build && ../.venv/bin/python -m twinops',
    cwd: '.',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      // Hermetic: never pick up a developer's .env (real API keys, lab mode).
      TWINOPS_ENV_FILE: '/dev/null',
      PYTHONPATH: '../backend',
      HOST: '127.0.0.1',
      PORT: String(PORT),
      TWINOPS_STATIC_DIR: 'dist',
      TWINOPS_TWIN: 'model',
      TWINOPS_PLANNER: 'runbook',
      TWINOPS_OPERATOR_TOKEN: 'e2e-passcode',
      TWINOPS_RATE_LIMIT_PER_MIN: '600',
      TWINOPS_DATA_DIR: 'test-results/live-data',
    },
  },
});
