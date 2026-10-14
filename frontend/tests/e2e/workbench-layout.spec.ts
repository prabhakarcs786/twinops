import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { decide, idleFrame, startIncident } from '../../src/engine/orchestrator.ts';
import { buildTopology } from '../../src/engine/topology.ts';
import type { NetworkConnection } from '../../src/api/contracts.ts';

test.use({ reducedMotion: 'reduce' });
test.beforeEach(async ({ page }, info) => {
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1366, height: 768 });
});

const connectedConfig = {
  version: 'test', planner: { kind: 'runbook', provider: 'runbook', model: 'runbook' },
  twin: { backend: 'emulated', ready: true, detail: 'Containerlab' }, harness: false,
  connectedApplication: true, networkUrl: 'http://127.0.0.1:8010',
};

const topology = buildTopology('core');
const healthyProbes = Object.values(idleFrame(topology).prod.probes);
const measuredConnection: NetworkConnection = { configured: true, connected: true, ready: true, name: 'Metro Network',
  checkedAt: Date.now() / 1000, topology, probes: healthyProbes, journeys: healthyProbes, issues: [],
  exercise: { canInject: true, canReset: false } };

test('refresh waits for the workspace without flashing a demo dashboard', async ({ page }) => {
  let releaseConfig!: () => void;
  const configReady = new Promise<void>((resolve) => { releaseConfig = resolve; });
  let releaseConnection!: () => void;
  const connectionReady = new Promise<void>((resolve) => { releaseConnection = resolve; });
  await page.route('**/api/config', async (route) => { await configReady; await route.fulfill({ json: connectedConfig }); });
  await page.route('**/api/connections', async (route) => { await connectionReady; await route.fulfill({ json: measuredConnection }); });
  await page.goto('/workbench');
  await expect(page.getByRole('heading', { name: 'Workbench', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Demo network', exact: true })).toHaveCount(0);
  await expect(page.getByText('Waiting for an incident', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Loading workbench' })).toBeVisible();
  releaseConfig();
  await expect(page.getByText('Live backend', { exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Loading workbench' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Inject fault', exact: true })).toHaveCount(0);
  releaseConnection();
  await expect(page.getByRole('button', { name: 'Inject fault', exact: true })).toBeEnabled();
  await expect(page.getByRole('region', { name: 'Metro Network', exact: true })).toContainText('Healthy');
});

test('automatic incident resume keeps loading until events arrive and hides exercise controls', async ({ page }) => {
  const id = 'inc-net-running';
  const { run } = startIncident({ pack: 'core', fault: 'dns_failure', seed: 7 });
  let releaseEvents!: () => void;
  const eventsReady = new Promise<void>((resolve) => { releaseEvents = resolve; });
  await page.route('**/api/config', (route) => route.fulfill({ json: connectedConfig }));
  await page.route('**/api/connections', (route) => route.fulfill({ json: { ...measuredConnection,
    issues: [{ id: 'running', incidentId: id, status: 'open', investigationStatus: 'investigating' }],
    exercise: { canInject: false, canReset: false },
  } }));
  await page.route(`**/api/incidents/${id}`, (route) => route.fulfill({ json: {
    incidentId: id, run: null, status: 'running', seed: 7, pack: 'core', recovered: false,
    outcome: null, approval: null, narrative: null, createdAt: Date.now() / 1000,
  } }));
  await page.route(`**/api/incidents/${id}/events`, async (route) => {
    await eventsReady;
    await route.fulfill({ contentType: 'text/event-stream', body: run.events.filter((event) => event.seq <= run.events.find((e) => e.phase === 'challenge')!.seq)
      .map((event) => `event: run\ndata: ${JSON.stringify(event)}\n\n`).join('') });
  });
  await page.goto('/workbench');
  await expect(page).toHaveURL(new RegExp(`incident=${id}`));
  await expect(page.getByRole('status').filter({ hasText: 'Loading incident evidence' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Inject fault', exact: true })).toHaveCount(0);
  await expect(page.getByText('Waiting for an incident', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: `test-results/workbench-loading-${test.info().project.name}.png` });
  releaseEvents();
  await expect(page.getByRole('heading', { name: 'Investigating — challenge' })).toBeVisible();
  const context = page.getByRole('region', { name: 'Connected application status' });
  await context.getByText('Application status', { exact: true }).click();
  await expect(context).toContainText('Live network: 4 of 4 journeys operational');
  await expect(context.getByRole('link', { name: 'Open Metro Network' })).toBeVisible();
  await context.getByText('Application status', { exact: true }).click();
  await expect(page.getByRole('region', { name: 'Metro Network controls' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reset lab', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Run timeline' })).toBeVisible();
  await page.screenshot({ path: `test-results/workbench-running-${test.info().project.name}.png` });
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations.map((v) => v.id)).toEqual([]);
});

test('an incident link loads its recorded state before stream replay', async ({ page }) => {
  const id = 'inc-net-refresh';
  const { run } = startIncident({ pack: 'core', fault: 'dns_failure', seed: 7 });
  let releaseIncident!: () => void;
  const incidentReady = new Promise<void>((resolve) => { releaseIncident = resolve; });
  await page.route('**/api/config', (route) => route.fulfill({ json: connectedConfig }));
  await page.route('**/api/connections', (route) => route.fulfill({ json: measuredConnection }));
  await page.route(`**/api/incidents/${id}`, async (route) => {
    await incidentReady;
    await route.fulfill({ json: { incidentId: id,
      run: { ...run, source: { kind: 'connected_application', name: 'Metro Network' } },
      status: 'awaiting_approval', seed: 7, pack: 'core', recovered: false,
      outcome: null, approval: null, narrative: null, createdAt: Date.now() / 1000,
    } });
  });
  await page.route(`**/api/incidents/${id}/events`, (route) => route.abort());
  await page.goto(`/workbench?incident=${id}`);
  await expect(page.getByRole('status').filter({ hasText: 'Loading incident evidence' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Demo network', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Inject fault', exact: true })).toHaveCount(0);
  releaseIncident();
  await expect(page.getByRole('region', { name: 'PASS UNDER DEFINED TESTS' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review & approve' })).toBeEnabled();
  await expect(page.getByRole('status').filter({ hasText: 'Loading incident evidence' })).toHaveCount(0);
  await expect(page.locator('.counter').filter({ hasText: 'Experiments in twin' }).locator('.counter-value')).toHaveText(String(run.events.at(-1)!.frame.counters.experiments));
  await expect(page.getByRole('region', { name: 'Metro Network controls' })).toHaveCount(0);
});

test('slow device readiness checks keep the workbench in connected mode', async ({ page }) => {
  await page.route('**/api/config', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await route.fulfill({ json: connectedConfig });
  });
  await page.route('**/api/connections', (route) => route.fulfill({ json: measuredConnection }));
  await page.route('**/api/incidents', (route) => route.fulfill({ json: [] }));
  await page.goto('/workbench');
  await expect(page.getByRole('region', { name: 'Metro Network controls' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Inject fault', exact: true })).toBeEnabled();
  await expect(page.getByText('In-browser model twin', { exact: true })).toHaveCount(0);
});

test('idle connected workbench shows measured network, top pipeline and working exercise controls', async ({ page }) => {
  await page.route('**/api/config', (route) => route.fulfill({ json: connectedConfig }));
  await page.route('**/api/connections', (route) => route.fulfill({ json: measuredConnection }));
  await page.route('**/api/incidents', (route) => route.fulfill({ json: [] }));
  await page.goto('/workbench');
  const network = page.getByRole('region', { name: 'Metro Network', exact: true });
  const metrics = page.getByRole('region', { name: 'Investigation metrics' });
  await expect(network).toContainText('Healthy');
  await expect(page.getByRole('link', { name: 'Open Metro Network' })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Inject fault', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Recent incidents' })).toBeInViewport();
  await expect(page.locator('.counters .counter')).toHaveCount(5);
  await expect(page.getByRole('list', { name: 'Incident pipeline' })).toBeInViewport();
  expect((await metrics.boundingBox())!.y).toBeLessThan((await network.boundingBox())!.y);
  await expect(metrics).toContainText('No diagnosis running');
  await expect(page.locator('#evidence')).toHaveCount(0);
  await page.getByRole('button', { name: 'Recent incidents' }).click();
  await expect(page.getByText('No saved incidents yet.', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await page.screenshot({ path: `test-results/workbench-empty-${test.info().project.name}.png` });
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(result.violations.map((v) => v.id)).toEqual([]);
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  await expect(metrics).toBeInViewport();
  const light = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(light.violations.map((v) => v.id)).toEqual([]);
});

for (const configAvailable of [true, false]) {
  test(`saved connected incident leads with its decision when config is ${configAvailable ? 'available' : 'unavailable'}`, async ({ page }) => {
    // Use deterministic evidence to exercise the saved-record UI without mutating a live lab.
    const session = startIncident({ pack: 'core', fault: 'dns_failure', seed: 7 });
    const postEvents = decide(session, 'layout-test', 'fixture', 'approve');
    const id = 'inc-net-layout';
    const run = { ...session.run, source: { kind: 'connected_application', name: 'Metro Network', issueId: 'source-layout' },
      versions: { ...session.run.versions, twin: 'emulated' }, events: [...session.run.events, ...postEvents] };
    await page.route('**/api/config', (route) => configAvailable ? route.fulfill({ json: connectedConfig }) : route.abort());
    await page.route('**/api/connections', (route) => route.fulfill({ json: { issues: [] } }));
    await page.route(`**/api/incidents/${id}`, (route) => route.fulfill({ json: {
      incidentId: id, run, status: 'applied', seed: 7, pack: 'core', recovered: true,
      outcome: session.outcome, approval: session.approval, narrative: null, createdAt: Date.now() / 1000,
    } }));
    await page.route(`**/api/incidents/${id}/events`, (route) => route.abort());
    await page.goto(`/workbench?incident=${id}`);
    const verdict = page.getByRole('region', { name: 'PASS UNDER DEFINED TESTS' });
    await expect(verdict).toBeVisible();
    await expect(verdict.getByRole('heading')).toBeInViewport();
    await expect(page.getByText('Applied · post-checks passed')).toBeInViewport();
    await expect(page.locator('.mode-line')).toContainText('Saved backend evidence');
    await expect(page.locator('.mode-line')).not.toContainText('In-browser');
    await expect(page.getByRole('button', { name: /Break it again|Reveal the sealed fault|Scenario settings/ })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Metro Network controls' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Connected application status' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to workbench' })).toBeVisible();
    const metricBox = await page.getByRole('region', { name: 'Investigation metrics' }).boundingBox();
    const reviewBox = await page.getByRole('region', { name: 'What supports this decision?' }).boundingBox();
    expect(metricBox!.y).toBeLessThan(reviewBox!.y);
    expect(metricBox!.y).toBeLessThan((await verdict.boundingBox())!.y);
    await page.screenshot({ path: `test-results/workbench-saved-${configAvailable}-${test.info().project.name}.png` });
    await page.getByText('Runtime details', { exact: true }).click();
    await expect(page.locator('.runtime-content')).toContainText('Containerlab emulated twin');
    await page.getByText('Runtime details', { exact: true }).click();
    await page.getByRole('button', { name: 'Investigation detail', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Metro Network', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });
}

test('scenario controls remain keyboard accessible behind a compact disclosure', async ({ page }) => {
  await page.goto('/workbench?engine=local&speed=instant');
  const settings = page.getByRole('button', { name: 'Scenario settings', exact: true });
  await expect(page.getByRole('combobox', { name: 'Fault', exact: true })).toHaveCount(0);
  await settings.focus();
  await page.keyboard.press('Enter');
  await expect(settings).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('combobox', { name: 'Fault', exact: true }).selectOption('dns_failure');
  await settings.click();
  await page.getByRole('button', { name: 'Break the network' }).click();
  await expect(page.getByRole('region', { name: 'PASS UNDER DEFINED TESTS' })).toContainText('Restore record and purge cached answer');
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ready to investigate' })).toBeVisible();
});


test('connected fault injection follows the resulting investigation and blocks duplicate clicks', async ({ page }) => {
  let connection = measuredConnection;
  let injections = 0;
  const id = 'inc-net-injected';
  const { run } = startIncident({ pack: 'core', fault: 'dns_failure', seed: 7 });
  await page.route('**/api/config', (route) => route.fulfill({ json: connectedConfig }));
  await page.route('**/api/connections', (route) => route.fulfill({ json: connection }));
  await page.route('**/api/connections/network/fault', async (route) => {
    injections++;
    expect(route.request().postDataJSON()).toEqual({ fault: 'dns_failure' });
    connection = { ...measuredConnection, exercise: { canInject: false, canReset: false },
      issues: [{ id: 'injected', title: 'Service disruption', status: 'open', incidentId: id, detectedAt: Date.now() / 1000, investigationStatus: 'investigating' }] };
    await route.fulfill({ status: 202, json: connection });
  });
  await page.route(`**/api/incidents/${id}`, (route) => route.fulfill({ json: {
    incidentId: id, run: { ...run, source: { kind: 'connected_application', name: 'Metro Network', issueId: 'injected' } },
    status: 'awaiting_approval', seed: 7, pack: 'core', recovered: false, outcome: null, approval: null, narrative: null, createdAt: Date.now() / 1000,
  } }));
  await page.route(`**/api/incidents/${id}/events`, (route) => route.fulfill({ contentType: 'text/event-stream', body:
    run.events.map((event) => `event: run\ndata: ${JSON.stringify(event)}\n\n`).join('') + 'event: end\ndata: {"status":"awaiting_approval"}\n\n' }));
  await page.goto('/workbench');
  await page.getByRole('combobox', { name: 'Inject fault' }).selectOption('dns_failure');
  await page.getByRole('button', { name: 'Inject fault', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`incident=${id}`));
  await expect(page.getByRole('region', { name: 'PASS UNDER DEFINED TESTS' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Inject fault', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reset lab', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Connected application status' })).toBeVisible();
  expect(injections).toBe(1);
});

test('unavailable connection retains the topology without claiming healthy measurements or allowing writes', async ({ page }) => {
  await page.route('**/api/config', (route) => route.fulfill({ json: connectedConfig }));
  await page.route('**/api/connections', (route) => route.fulfill({ json: { ...measuredConnection, connected: false, ready: false, detail: 'Lab unavailable' } }));
  await page.goto('/workbench');
  const network = page.getByRole('region', { name: 'Metro Network', exact: true });
  await expect(network).toContainText('Awaiting measurements');
  await expect(network).not.toContainText('Healthy');
  await expect(network.getByRole('img', { name: 'Metro Network: Awaiting measurements' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Inject fault', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Reset lab', exact: true })).toBeDisabled();
});

test('connected exercise errors retain the dashboard and a reset refreshes measurements', async ({ page }) => {
  const issue = { id: 'closed', title: 'Unresolved service issue', status: 'open', incidentId: null, investigationStatus: 'finished', detectedAt: Date.now() / 1000 };
  const connection = { ...measuredConnection, issues: [issue], exercise: { canInject: true, canReset: true } };
  await page.route('**/api/config', (route) => route.fulfill({ json: connectedConfig }));
  await page.route('**/api/connections', (route) => route.fulfill({ json: connection }));
  await page.route('**/api/connections/network/fault', (route) => route.fulfill({ status: 409, json: { detail: 'Reset the current scenario before starting another fault' } }));
  await page.route('**/api/connections/network/reset', (route) => route.fulfill({ json: measuredConnection }));
  await page.goto('/workbench');
  await page.getByRole('button', { name: 'Inject fault', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Reset the current scenario');
  await expect(page.getByRole('region', { name: 'Metro Network', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reset lab', exact: true }).click();
  await expect(page.getByText('Lab reset. Baseline measurements refreshed.')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('finished investigations leave the live dashboard open and remain available for review', async ({ page }) => {
  const { run } = startIncident({ pack: 'core', fault: 'dns_failure', seed: 7 });
  const probes = run.observation.probes.filter((p) => p.kind === 'journey');
  const connection = { ...measuredConnection, probes, journeys: probes, exercise: { canInject: false, canReset: true },
    issues: [{ id: 'finished', title: 'Service disruption', status: 'open', incidentId: 'inc-finished', investigationStatus: 'finished', detectedAt: Date.now() / 1000 }] };
  await page.route('**/api/config', (route) => route.fulfill({ json: connectedConfig }));
  await page.route('**/api/connections', (route) => route.fulfill({ json: connection }));
  let resumed = 0;
  await page.route('**/api/incidents/inc-finished', (route) => { resumed++; return route.abort(); });
  await page.goto('/workbench');
  await expect(page.getByRole('region', { name: 'Metro Network', exact: true })).toContainText('Incident');
  await expect(page.getByRole('link', { name: 'Review latest investigation' })).toHaveAttribute('href', '/workbench?incident=inc-finished');
  await expect(page.getByRole('button', { name: 'Reset lab', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Inject fault', exact: true })).toBeDisabled();
  await expect(page).not.toHaveURL(/incident=/);
  expect(resumed).toBe(0);
});
