import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/** End-to-end against the real backend: incidents run server-side and stream to the UI over SSE. */

const cspViolations: string[] = [];

test.beforeEach(async ({ page }) => {
  cspViolations.length = 0;
  page.on('console', (msg) => {
    if (msg.type() === 'error' && /Content Security Policy/i.test(msg.text())) cspViolations.push(msg.text());
  });
});

test.afterEach(() => {
  expect(cspViolations).toEqual([]);
});

async function breakAndWaitForVerdict(page: Page, fault: string, verdict: string) {
  await page.goto(`/workbench?speed=instant&fault=${fault}`);
  await expect(page.locator('.mode-line')).toContainText('Live backend');
  await page.getByRole('button', { name: 'Break the network' }).click();
  const region = page.getByRole('region', { name: verdict });
  await expect(region).toBeVisible({ timeout: 60_000 });
  return region;
}

test('live run streams over SSE and requires the operator passcode', async ({ page }) => {
  const verdict = await breakAndWaitForVerdict(page, 'route_misconfig', 'PASS UNDER DEFINED TESTS');
  await expect(verdict).toContainText(/Remove EDGE-IN seq \d+ only/);
  await expect(verdict).toContainText('Server compute');
  await expect(page.locator('.timeline-count')).not.toHaveText('0 events');
  await expect(page.locator('.counter-ok .counter-value')).toHaveText('0');

  // Server-side seal: the fault label comes from the backend only after the verdict.
  await page.getByRole('button', { name: 'Reveal the sealed fault' }).click();
  await expect(verdict).toContainText('Sealed fault: F1');

  await page.getByRole('button', { name: 'Review & approve' }).click();
  const dialog = page.getByRole('dialog', { name: 'Approve the exact tested change' });
  await dialog.getByLabel('Operator ID').fill('e2e-operator');
  await dialog.getByRole('checkbox').check();
  await expect(dialog.getByRole('button', { name: /Approve & apply/ })).toBeDisabled();

  await dialog.getByLabel('Operator passcode').fill('wrong-passcode');
  await dialog.getByRole('button', { name: /Approve & apply/ }).click();
  await expect(dialog.getByRole('alert')).toContainText('401');

  await dialog.getByLabel('Operator passcode').fill('e2e-passcode');
  await dialog.getByRole('button', { name: /Approve & apply/ }).click();
  await expect(page.getByText('Applied · post-checks passed')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('region', { name: 'Demo network' })).toContainText('Restored · verified');

  await page.getByRole('tab', { name: 'Proof Pack' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download JSON' }).click();
  expect((await download).suggestedFilename()).toMatch(/proof-pack\.json$/);

  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
});

test('live unsupported fault stops as INCONCLUSIVE server-side', async ({ page }) => {
  const verdict = await breakAndWaitForVerdict(page, 'unsupported_link_flap', 'INCONCLUSIVE');
  await expect(verdict).toContainText('no change proposed');
  await expect(page.getByRole('button', { name: 'Review & approve' })).toHaveCount(0);
});

test('the in-browser engine stays available next to the backend', async ({ page }) => {
  await page.goto('/workbench?speed=instant&fault=dns_failure');
  await page.getByRole('button', { name: 'In-browser' }).click();
  await expect(page.locator('.mode-line')).toContainText('In-browser model twin');
  await page.getByRole('button', { name: 'Break the network' }).click();
  await expect(page.getByRole('region', { name: 'PASS UNDER DEFINED TESTS' })).toContainText('Restore record and purge cached answer');
});
