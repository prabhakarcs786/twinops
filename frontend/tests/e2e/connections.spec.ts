import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('connected applications shows detected issues and links to their saved investigation', async ({ page }) => {
  await page.route('**/api/connections', (route) => route.fulfill({ json: {
    configured: true, connected: true, ready: true, name: 'Metro Network', detail: 'Automatic detection active',
    url: 'http://127.0.0.1:8010', checkedAt: 1791670000,
    issues: [{ id: 'source-1', title: 'Service disruption · 2 journeys failing', status: 'open', incidentId: 'inc-net-123', detectedAt: 1791670000 }],
  } }));
  await page.goto('/connections');
  await expect(page.getByText('Monitoring', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open investigation' })).toHaveAttribute('href', '/workbench?incident=inc-net-123');
  await expect(page.getByRole('link', { name: 'Open application' })).toHaveAttribute('href', 'http://127.0.0.1:8010');
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
});

test('connected workbench does not inject a new fault from an old autostart link', async ({ page }) => {
  let created = 0;
  await page.route('**/api/config', (route) => route.fulfill({ json: {
    version: 'test', planner: { kind: 'llm', provider: 'gemini', model: 'gemini-3.1-flash-lite' },
    twin: { backend: 'emulated', ready: true, detail: 'Containerlab' }, harness: false, connectedApplication: true,
  } }));
  await page.route('**/api/incidents', (route) => {
    if (route.request().method() === 'POST') created++;
    return route.fulfill({ json: [] });
  });
  await page.goto('/workbench?autostart=1');
  await expect(page.getByRole('link', { name: 'Connected applications' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Break the network' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'In-browser', exact: true })).toHaveCount(0);
  expect(created).toBe(0);
});

test('unconfigured connection explains how to start the two-app demo', async ({ page }) => {
  await page.route('**/api/connections', (route) => route.fulfill({ json: { configured: false, connected: false, issues: [] } }));
  await page.goto('/connections');
  await expect(page.getByText('Not configured', { exact: true })).toBeVisible();
  await expect(page.getByText('npm run dev:connected', { exact: true })).toBeVisible();
});
