import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('judges approve a real backend run without a credential after reviewing evidence', async ({ page }) => {
  await page.goto('/workbench?speed=instant&fault=route_misconfig');
  await expect(page.locator('.mode-line')).toContainText('Live backend');
  await page.getByRole('button', { name: 'Break the network' }).click();
  await expect(page.getByRole('region', { name: 'PASS UNDER DEFINED TESTS' })).toBeVisible({ timeout: 60_000 });
  const incident = new URL(page.url()).searchParams.get('incident');
  expect((await (await page.request.get(`/api/incidents/${incident}`)).json()).approval).toBeNull();

  await page.getByRole('button', { name: 'Review & approve' }).click();
  const dialog = page.getByRole('dialog', { name: 'Approve the exact tested change' });
  const passcode = dialog.getByLabel('Operator passcode (not required for demo)');
  await expect(passcode).toBeDisabled();
  await expect(passcode).toHaveValue('');
  await expect(passcode).toHaveAttribute('placeholder', '••••••••');
  await expect(dialog).toContainText('The dots are a placeholder; approval applies only to the synthetic lab.');
  await expect(dialog.getByRole('button', { name: /Approve & apply/ })).toBeDisabled();
  await dialog.getByLabel('Operator ID').fill('judge-demo');
  await expect(dialog.getByRole('button', { name: /Approve & apply/ })).toBeDisabled();
  await dialog.getByRole('checkbox').check();
  await expect(dialog.getByRole('button', { name: /Approve & apply/ })).toBeEnabled();
  const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(accessibility.violations.map((v) => v.id)).toEqual([]);
  await page.screenshot({ path: `test-results/demo-approval/dialog-${test.info().project.name}.png`, fullPage: true });
  const decision = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/decision'));
  await dialog.getByRole('button', { name: /Approve & apply/ }).click();
  const request = await decision;
  expect(request.headers().authorization).toBeUndefined();
  expect(request.postDataJSON()).toEqual({ decision: 'approve', operator: 'judge-demo', comment: '' });
  await expect(page.getByText('Applied · post-checks passed')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Investigation detail', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Demo network' })).toContainText('Restored · verified');
});
