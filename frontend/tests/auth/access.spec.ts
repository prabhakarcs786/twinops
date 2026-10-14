import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('viewer sign-in protects evidence and withholds approval', async ({ page }) => {
  const created = await page.request.post('/api/incidents', {
    headers: { Authorization: 'Bearer test-approver' },
    data: { fault: 'dns_failure', seed: 7, pace: 0 },
  });
  const { incidentId } = await created.json();
  await page.goto(`/workbench?incident=${incidentId}`);
  await expect(page.getByRole('heading', { name: 'TwinOps access' })).toBeVisible();
  const loginAccessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(loginAccessibility.violations.map((v) => v.id)).toEqual([]);
  await expect(page.getByRole('region', { name: 'What supports this decision?' })).toHaveCount(0);
  await page.getByLabel('Access token').fill('test-viewer');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('region', { name: 'What supports this decision?' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review & approve' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Break it again' })).toBeDisabled();
  const denied = await page.request.post(`/api/incidents/${incidentId}/decision`, { data: { operator: 'viewer', decision: 'approve' } });
  expect(denied.status()).toBe(403);
  const cookies = await page.context().cookies();
  expect(cookies.find((cookie) => cookie.name === 'twinops_session')?.httpOnly).toBe(true);
  await page.reload();
  await expect(page.getByRole('region', { name: 'What supports this decision?' })).toBeVisible();
});

test('approver cookie authorizes the reviewed change without a second passcode', async ({ page }) => {
  await page.goto('/workbench?speed=instant&fault=dns_failure');
  await page.getByLabel('Access token').fill('test-approver');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Break the network' }).click();
  await page.getByRole('button', { name: 'Review & approve' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Operator passcode')).toHaveCount(0);
  await dialog.getByLabel('Operator ID').fill('pilot-reviewer');
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: /Approve & apply/ }).click();
  await expect(page.getByText('Applied · post-checks passed')).toBeVisible();
  const incidentId = new URL(page.url()).searchParams.get('incident');
  const detail = await (await page.request.get(`/api/incidents/${incidentId}`)).json();
  expect(detail.lifecycle.status).toBe('closed');
  expect(detail.outcome.observationWindows).toHaveLength(3);
  const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(accessibility.violations.map((v) => v.id)).toEqual([]);
});
