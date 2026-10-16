import { defineConfig } from '@playwright/test';
import liveConfig from './playwright.live.config.ts';

const PORT = 8079;
const server = liveConfig.webServer;
if (!server || Array.isArray(server)) throw new Error('The live suite must define one backend server');

export default defineConfig({
  ...liveConfig,
  testDir: './tests/demo-approval',
  outputDir: 'test-results/demo-approval',
  use: { ...liveConfig.use, baseURL: `http://127.0.0.1:${PORT}` },
  webServer: {
    ...server,
    url: `http://127.0.0.1:${PORT}/api/health`,
    env: {
      ...server.env,
      PORT: String(PORT),
      TWINOPS_DEMO_APPROVAL: 'true',
      TWINOPS_REQUIRE_AUTH: 'false',
      TWINOPS_HARNESS: 'true',
      TWINOPS_NETWORK_URL: '',
      TWINOPS_DATA_DIR: '.playwright-data/demo-approval',
    },
  },
});
