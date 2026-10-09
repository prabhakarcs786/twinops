import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

test.use({ reducedMotion: 'reduce' });

async function expectNoA11yViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

test('landing page tells the story and passes automated accessibility checks', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('proves');
  await expect(page.getByRole('heading', { name: /judge of the AI/ })).toBeVisible();
  await expectNoA11yViolations(page);
});

test('evaluation harness runs in the browser and meets its safety targets', async ({ page }) => {
  await page.goto('/#evaluation');
  await page.getByRole('button', { name: /Run 40 seeded incidents/ }).click();
  const controls = page.getByRole('list', { name: 'Adverse controls' });
  await expect(controls.getByRole('listitem')).toHaveCount(6, { timeout: 20_000 });
  await expect(page.locator('.eval-tiles')).toContainText('Unsafe fixes that passed0');
  await expect(page.locator('.eval-tiles')).toContainText('Writes during diagnosis0');
});

const FAULTS = [
  { id: 'route_misconfig', verdict: 'PASS UNDER DEFINED TESTS', change: /Remove EDGE-IN seq \d+ only/ },
  { id: 'dns_failure', verdict: 'PASS UNDER DEFINED TESTS', change: /Restore record and purge cached answer/ },
  { id: 'cert_expiry', verdict: 'PASS WITH WARNINGS', change: /Renew certificate on v4 \+ v6 listeners/ },
];

for (const fault of FAULTS) {
  test(`${fault.id}: break → verify → approve → applied in the demo lab`, async ({ page }) => {
    await page.goto(`/workbench?speed=instant&fault=${fault.id}`);
    await page.getByRole('button', { name: 'Break the network' }).click();
    const verdict = page.getByRole('region', { name: fault.verdict });
    await expect(verdict).toBeVisible();
    await expect(verdict).toContainText(fault.change);
    await expect(page.locator('.counter-ok .counter-value')).toHaveText('0');

    await page.getByRole('button', { name: 'Review & approve' }).click();
    const dialog = page.getByRole('dialog', { name: 'Approve the exact tested change' });
    await expect(dialog.getByRole('button', { name: /Approve & apply/ })).toBeDisabled();
    await dialog.getByLabel('Operator ID').fill('e2e-operator');
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: /Approve & apply/ }).click();

    await expect(page.getByText('Applied · post-checks passed')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Demo network' })).toContainText('Restored · verified');
    await expectNoA11yViolations(page);
  });
}

test('drift after the snapshot invalidates the approval', async ({ page }) => {
  await page.goto('/workbench?speed=instant&fault=route_misconfig');
  await page.getByRole('button', { name: 'Break the network' }).click();
  await page.getByRole('button', { name: 'Simulate drift' }).click();
  await page.getByRole('button', { name: 'Review & approve' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Operator ID').fill('e2e-operator');
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: /Approve & apply/ }).click();
  await expect(page.getByText('Apply refused', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Demo network' })).toContainText('Incident');
});

test('unsupported fault stops as INCONCLUSIVE without proposing a change', async ({ page }) => {
  await page.goto('/workbench?speed=instant&fault=unsupported_link_flap');
  await page.getByRole('button', { name: 'Break the network' }).click();
  await expect(page.getByRole('region', { name: 'INCONCLUSIVE' })).toContainText('no change proposed');
  await expect(page.getByRole('button', { name: 'Review & approve' })).toHaveCount(0);
});

test('keyboard users can operate the evidence tabs', async ({ page }) => {
  await page.goto('/workbench?speed=instant&fault=dns_failure');
  await page.getByRole('button', { name: 'Break the network' }).click();
  await page.getByRole('tab', { name: 'Hypotheses' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Proof Gate' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toContainText('G5');
});

test('pitch deck navigates by keyboard and every slide passes accessibility checks', async ({ page }) => {
  await page.goto('/deck');
  await expect(page.getByRole('region', { name: /^1 of 10/ })).toBeVisible();
  for (let i = 1; i <= 10; i++) {
    await expect(page.getByRole('region', { name: new RegExp(`^${i} of 10`) })).toBeVisible();
    await expect(page.getByRole('region', { name: / of 10: / })).toHaveCount(1);
    await expectNoA11yViolations(page);
    await page.keyboard.press('ArrowRight');
  }
  await expect(page).toHaveURL(/#10$/);
  await page.keyboard.press('Home');
  await expect(page.getByRole('region', { name: /^1 of 10/ })).toBeVisible();
});
