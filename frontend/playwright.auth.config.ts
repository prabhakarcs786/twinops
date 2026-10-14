import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/auth',
  outputDir: 'test-results/auth',
  timeout: 60_000,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:8078', reducedMotion: 'reduce', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'npm run build && ../.venv/bin/python -m twinops',
    url: 'http://127.0.0.1:8078/api/health',
    timeout: 180_000,
    env: {
      TWINOPS_ENV_FILE: '/dev/null', PYTHONPATH: '../backend', HOST: '127.0.0.1', PORT: '8078',
      TWINOPS_STATIC_DIR: 'dist', TWINOPS_TWIN: 'model', TWINOPS_PLANNER: 'runbook', TWINOPS_REQUIRE_AUTH: 'true',
      TWINOPS_VIEWER_TOKEN: 'test-viewer', TWINOPS_INVESTIGATOR_TOKEN: 'test-investigator', TWINOPS_OPERATOR_TOKEN: 'test-approver',
      TWINOPS_POSTCHECK_INTERVAL_S: '0', TWINOPS_RATE_LIMIT_PER_MIN: '600', TWINOPS_MAX_ACTIVE_RUNS: '100',
      TWINOPS_DATA_DIR: '.playwright-data/auth',
    },
  },
});
