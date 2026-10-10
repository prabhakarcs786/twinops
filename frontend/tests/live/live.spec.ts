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

test('AI trace explains a runbook run, and Ask needs an LLM planner', async ({ page }) => {
  await breakAndWaitForVerdict(page, 'dns_failure', 'PASS UNDER DEFINED TESTS');
  await page.getByRole('tab', { name: 'AI trace' }).click();
  await expect(page.getByRole('tabpanel')).toContainText('deterministic runbook planner');
  await expect(page.getByRole('tab', { name: 'Ask TwinOps' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Ask TwinOps about this run' })).toHaveCount(0);
});

test('the in-browser engine stays available next to the backend', async ({ page }) => {
  await page.goto('/workbench?speed=instant&fault=dns_failure');
  await page.getByRole('button', { name: 'In-browser' }).click();
  await expect(page.locator('.mode-line')).toContainText('In-browser model twin');
  await page.getByRole('button', { name: 'Break the network' }).click();
  await expect(page.getByRole('region', { name: 'PASS UNDER DEFINED TESTS' })).toContainText('Restore record and purge cached answer');
});

test('refresh resumes the same incident and history reopens its evidence', async ({ page }) => {
  let creates = 0;
  page.on('request', (request) => { if (request.method() === 'POST' && request.url().endsWith('/api/incidents')) creates++; });
  await breakAndWaitForVerdict(page, 'dns_failure', 'PASS UNDER DEFINED TESTS');
  const incident = new URL(page.url()).searchParams.get('incident');
  expect(incident).toBeTruthy();
  const count = await page.locator('.timeline-count').innerText();
  await page.reload();
  await expect(page.getByRole('region', { name: 'PASS UNDER DEFINED TESTS' })).toBeVisible();
  await expect(page.locator('.timeline-count')).toHaveText(count);
  expect(new URL(page.url()).searchParams.get('incident')).toBe(incident);
  expect(creates).toBe(1);
  await expect(page.getByRole('button', { name: 'Review & approve' })).toBeEnabled();
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.getByRole('button', { name: 'Recent incidents' }).click();
  await page.getByRole('region', { name: 'Saved incidents' }).getByRole('button').filter({ hasText: incident! }).click();
  await expect(page.getByRole('region', { name: 'PASS UNDER DEFINED TESTS' })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('incident')).toBe(incident);
  expect(creates).toBe(1);
});

test('elapsed time advances while the event stream is quiet', async ({ page }) => {
  await page.clock.install();
  // Hold the stream before its first event, as with a quiet model call or reconnect.
  await page.route('**/api/incidents/*/events', () => {});
  await page.goto('/workbench?speed=instant&fault=dns_failure');
  await expect(page.locator('.mode-line')).toContainText('Live backend');
  await page.getByRole('button', { name: 'Break the network' }).click();
  await expect(page).toHaveURL(/incident=inc-/, { timeout: 30_000 });
  const elapsed = page.locator('.counter').filter({ hasText: 'Elapsed' }).locator('.counter-value');
  const before = await elapsed.innerText();
  await page.clock.fastForward(3000);
  await expect(elapsed).not.toHaveText(before);
  await expect(page.locator('.timeline-count')).toHaveText('0 events');
});

test('review trial separates raw evidence from the gate and never applies a change', async ({ page }) => {
  await breakAndWaitForVerdict(page, 'dns_failure', 'PASS UNDER DEFINED TESTS');
  const incidentId = new URL(page.url()).searchParams.get('incident')!;
  const before = await (await page.request.get(`/api/incidents/${incidentId}`)).json();
  const candidateId = before.run.selected.change.id;
  await page.goto(`/review?incident=${incidentId}&candidate=${candidateId}&mode=raw`);
  await page.getByRole('button', { name: 'Start timed review' }).click();
  await expect(page.getByRole('region', { name: 'Review evidence' })).toContainText('Observed probes');
  await expect(page.locator('.trial-gates')).toHaveCount(0);
  await page.getByLabel('Accept proposal').check();
  await page.getByRole('button', { name: 'Record review' }).click();
  await expect(page.getByRole('heading', { name: 'Review recorded' })).toBeVisible();
  const after = await (await page.request.get(`/api/incidents/${incidentId}`)).json();
  expect(after.approval).toBeNull();
  expect(after.outcome).toBeNull();
  const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(accessibility.violations.map((violation) => violation.id)).toEqual([]);
  await page.goto(`/review?incident=${incidentId}&candidate=${candidateId}&mode=proof`);
  await page.getByRole('button', { name: 'Start timed review' }).click();
  await expect(page.locator('.trial-gates')).toContainText('G1');
  await expect(page.locator('.trial-raw')).toHaveCount(0);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: `test-results/review-${test.info().project.name}.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByLabel('Accept proposal').check();
  await page.getByRole('button', { name: 'Record review' }).click();
  await expect(page.getByRole('heading', { name: 'Review recorded' })).toBeVisible();
  await page.getByText('Operator review measurements', { exact: true }).click();
  await expect(page.getByRole('region', { name: 'Matched review measurements' })).toContainText('Raw observations');
  const exportResponse = await page.request.get('/api/review-trials');
  expect((await exportResponse.json()).filter((trial: { incidentId: string }) => trial.incidentId === incidentId)).toHaveLength(2);
});

test('memory retests a stale historical fix against changed rule ordering', async ({ page }) => {
  await page.goto('/workbench?speed=instant&fault=route_misconfig');
  await expect(page.locator('.mode-line')).toContainText('Live backend');
  await page.locator('.challenge-controls > summary').click();
  await page.getByLabel('Seed (optional)').fill('2007');
  await page.getByRole('button', { name: 'Break the network' }).click();
  await page.getByRole('button', { name: 'Review & approve' }).click();
  const sourceId = new URL(page.url()).searchParams.get('incident')!;
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Operator ID').fill('memory-review');
  await dialog.getByLabel('Operator passcode').fill('e2e-passcode');
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: /Approve & apply/ }).click();
  await expect(page.getByText('Applied · post-checks passed')).toBeVisible();
  await page.getByRole('combobox', { name: 'Challenge conditions', exact: true }).selectOption('changed_config');
  await page.getByRole('button', { name: 'Break it again' }).click();
  await expect(page).not.toHaveURL(new RegExp(sourceId));
  await expect(page.getByRole('region', { name: 'PASS UNDER DEFINED TESTS' })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('tab', { name: 'Memory', exact: true }).click();
  const evidence = page.getByRole('region', { name: 'Evidence', exact: true });
  await expect(evidence).toContainText(sourceId);
  await expect(evidence).toContainText('Target state has changed');
  await expect(evidence).toContainText('Past fix rejected');
  await expect(evidence).toContainText('Historical approval not reused');
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  await evidence.screenshot({ path: `test-results/memory-${test.info().project.name}.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(accessibility.violations.map((violation) => violation.id)).toEqual([]);
  await page.getByRole('button', { name: 'Inspect fresh gates' }).click();
  await expect(page.getByRole('tab', { name: 'Proof Gate' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toContainText('G2');
  await page.getByRole('tab', { name: 'Proof Gate' }).focus();
  await page.keyboard.press('Home');
  await expect(page.getByRole('tab', { name: 'Facts & scope' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'Proof Pack' })).toBeFocused();
});

test('missing data and interpretations stay distinct from verified outcomes', async ({ page }) => {
  await page.goto('/workbench?speed=instant&fault=route_misconfig');
  await expect(page.locator('.mode-line')).toContainText('Live backend');
  await page.locator('.challenge-controls > summary').click();
  await page.getByRole('combobox', { name: 'Challenge conditions', exact: true }).selectOption('missing_history');
  await page.getByRole('button', { name: 'Break the network' }).click();
  await expect(page.locator('.stamp')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('tab', { name: 'Facts & scope' }).click();
  const category = page.getByRole('group', { name: 'Evidence category' });
  await category.getByRole('button', { name: 'Hypotheses', exact: true }).click();
  await expect(page.getByRole('tabpanel')).toContainText('Interpretation, not confirmed');
  await category.getByRole('button', { name: 'Limits', exact: true }).click();
  await expect(page.getByRole('tabpanel')).toContainText('Change-history collector unavailable');
  const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(accessibility.violations.map((violation) => violation.id)).toEqual([]);
});

test('provider outage is explicitly simulated and fallback remains inspectable', async ({ page }) => {
  await page.goto('/workbench?speed=instant&fault=dns_failure');
  await expect(page.locator('.mode-line')).toContainText('Live backend');
  await page.locator('.challenge-controls > summary').click();
  await page.getByRole('combobox', { name: 'Challenge conditions', exact: true }).selectOption('provider_outage');
  await page.getByLabel('Retest compatible historical fixes').uncheck();
  await page.getByRole('button', { name: 'Break the network' }).click();
  await expect(page.getByRole('region', { name: 'PASS UNDER DEFINED TESTS' })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.recovery-notice')).toContainText('No model request was sent');
  await page.getByRole('tab', { name: 'AI trace' }).click();
  await expect(page.getByRole('tabpanel')).toContainText('Simulated provider outage');
  await expect(page.getByRole('tab', { name: 'Ask TwinOps' })).toHaveCount(0);
  await expect(page.locator('.counter-ok .counter-value')).toHaveText('0');
  await page.getByRole('region', { name: 'Evidence', exact: true }).screenshot({ path: `test-results/outage-${test.info().project.name}.png` });
});
