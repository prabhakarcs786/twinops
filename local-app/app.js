const $ = (id) => document.getElementById(id);
let pending = false;
let latest;
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clock = (ts) => new Date(ts * 1000).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'});
const duration = (seconds) => {
  const s = Math.max(0, Math.round(seconds));
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
};
const painted = new Map();
// Re-rendering identical markup every poll would drop keyboard focus on links inside it.
const paint = (id, markup) => {
  if (painted.get(id) === markup) return;
  painted.set(id, markup);
  $(id).innerHTML = markup;
};
const investigationUrl = (data, incidentId) => `${data.twinopsUrl}/workbench?incident=${encodeURIComponent(incidentId)}`;
const STEPS = ['Detected', 'TwinOps investigating', 'Approved change applied', 'Recovery verified'];
const HISTORY_STATUS = {resolved: ['Recovered', 'ok'], reset: ['Reset by operator', 'muted'], open: ['Unresolved', 'bad']};
// Mirrors NetworkState.can_replace_issue: a new fault restores the baseline and archives this scenario.
const replaceable = (issue) => issue?.status === 'resolved' && (!issue.incidentId || issue.investigationStatus === 'finished');
const affectedPops = (data, issue) => (issue.failedJourneys ?? []).map((id) => {
  const from = data.topology?.journeys.find((j) => j.id === id)?.from;
  return data.topology?.nodes.find((n) => n.id === from)?.label.replace(' PoP', '') ?? id;
}).join(', ');

function lifecycle(issue, operation, recoveryRequired) {
  if (recoveryRequired) return {current: 2, blocked: true, note: 'Interrupted', tone: 'bad', badge: 'RECOVERY REQUIRED', text: 'A change was interrupted or rollback could not be verified. An operator must inspect the lab.'};
  if (issue.status === 'resolved') {
    const applied = operation === 'applied';
    const skipped = new Set([...(issue.incidentId ? [] : [1]), ...(applied ? [] : [2])]);
    return {current: 4, skipped, tone: 'ok', badge: 'RECOVERED', text: applied ? 'The change approved in TwinOps restored service. Fresh probes confirm recovery.' : 'Service recovered without a TwinOps change. Fresh probes confirm recovery.'};
  }
  if (operation === 'applying') return {current: 2, tone: 'warn', badge: 'APPLYING', text: 'Applying the change approved in TwinOps\u2026'};
  if (operation === 'applied') return {current: 3, tone: 'warn', badge: 'VERIFYING', text: 'Approved change applied. Confirming recovery with fresh service probes\u2026'};
  if (issue.investigationStatus === 'finished') return {current: 2, blocked: true, note: 'No change applied', tone: 'bad', badge: 'NEEDS ATTENTION', text: 'Investigation finished without a verified recovery. Review the evidence in TwinOps, then reset the scenario.'};
  if (issue.incidentId) return {current: 1, tone: 'warn', badge: 'INVESTIGATING', text: 'TwinOps is reproducing the fault in its isolated twin and testing fixes. Approval happens in TwinOps.'};
  return {current: 0, tone: 'bad', badge: 'DETECTED', text: 'Waiting for TwinOps to pick up the issue. It checks every 5 seconds.'};
}

function tracker(state) {
  return `<ol class="tracker">${STEPS.map((label, i) => {
    const status = state.skipped?.has(i) ? 'skipped' : i < state.current ? 'done' : i === state.current ? (state.blocked ? 'blocked' : 'current') : 'todo';
    const mark = {done: '\u2713', skipped: '\u2013', blocked: '!', current: String(i + 1), todo: String(i + 1)}[status];
    return `<li class="step ${status}"${status === 'current' ? ' aria-current="step"' : ''}><span class="step-mark" aria-hidden="true">${mark}</span>${label}${status === 'skipped' ? '<small>Not needed</small>' : status === 'blocked' ? `<small>${state.note}</small>` : ''}</li>`;
  }).join('')}</ol>`;
}

function renderMap(data, journeys) {
  const topo = data.topology;
  if (!topo) return;
  const failingPops = new Set(journeys.filter((p) => !p.ok).map((p) => topo.journeys.find((j) => j.id === p.id)?.from).filter(Boolean));
  const servedPops = new Set(journeys.filter((p) => p.ok).map((p) => topo.journeys.find((j) => j.id === p.id)?.from).filter(Boolean));
  const at = Object.fromEntries(topo.nodes.map((n) => [n.id, n]));
  const links = topo.links.map((l) => `<line class="link${l.backup ? ' backup' : ''}" x1="${at[l.a].x}" y1="${at[l.a].y}" x2="${at[l.b].x}" y2="${at[l.b].y}"/>`).join('');
  const nodes = topo.nodes.map((n) => {
    const state = failingPops.has(n.id) ? ' bad' : servedPops.has(n.id) ? ' ok' : '';
    return `<g class="node ${escape(n.role)}${state}"><rect x="${n.x - 27}" y="${n.y - 14}" width="54" height="28" rx="8"/><text x="${n.x}" y="${n.y + 4}">${escape(n.short)}</text></g>`;
  }).join('');
  paint('map', links + nodes);
  const names = [...failingPops].map((id) => at[id]?.label ?? id);
  $('map').setAttribute('aria-label', names.length ? `Network map: customers disrupted at ${names.join(', ')}` : 'Network map: all measured locations served');
}

function headline(data, issue, ok, total) {
  if (data.recoveryRequired) return ['bad', 'Operator recovery required', 'A change was interrupted or rollback could not be verified. Further changes are blocked.'];
  if (!data.ready) return ['warn', data.checkedAt ? 'Lab unavailable' : 'Connecting to the lab\u2026', data.checkedAt ? 'Showing the last measurement. Retrying automatically.' : 'Waiting for the first service measurement.'];
  if (issue && issue.status !== 'resolved') return ['bad', total > ok ? `Service disruption \u00b7 ${total - ok} of ${total} journeys failing` : issue.title, `Customers affected at ${affectedPops(data, issue)}. Follow the recovery in the incident desk.`];
  if (issue) return ['ok', 'Service restored', `${issue.resolvedAt ? `Recovered in ${duration(issue.resolvedAt - issue.detectedAt)}. ` : ''}All ${total} customer journeys reachable again.`];
  return ['ok', 'All services operational', `${ok} of ${total} customer journeys reachable across Berlin, Hamburg, Munich and Frankfurt.`];
}

function faultHint(data, issue) {
  if (data.recoveryRequired) return ['bad', 'Faults are blocked until an operator restores the lab.'];
  if (!data.ready) return ['warn', 'Waiting for the lab to report healthy measurements.'];
  if (replaceable(issue)) return ['ok', 'Last scenario recovered. Choose a fault to start the next exercise; the lab returns to its healthy baseline first.'];
  if (issue?.status === 'resolved') return ['warn', 'Service recovered. TwinOps is closing its investigation\u2026'];
  if (issue?.incidentId && issue.investigationStatus !== 'finished') return ['warn', 'An investigation is in progress. Follow it in TwinOps.'];
  if (issue) return ['bad', 'This scenario ended without a verified recovery. Review the evidence, then reset the scenario.'];
  return ['ok', 'Lab healthy. Choose one fault to introduce.'];
}

function render(data) {
  latest = data;
  const obs = data.observation;
  const probes = obs?.probes ?? [];
  const journeys = probes.filter((p) => p.kind === 'journey');
  const guards = probes.filter((p) => p.kind !== 'journey');
  const ok = journeys.filter((p) => p.ok).length;
  document.body.classList.toggle('is-offline', !data.ready);
  $('connection').textContent = data.ready ? 'Lab connected \u00b7 live measurements' : 'Lab unavailable';
  $('checked').textContent = data.checkedAt ? `Last measured ${clock(data.checkedAt)}${data.ready ? '' : ' \u00b7 stale'}` : 'Waiting for first measurement';
  $('error').hidden = !data.error && !data.recoveryRequired;
  $('error').textContent = data.recoveryRequired ? 'A change was interrupted or recovery could not be verified. Operator recovery is required; further changes are blocked.' : data.error || '';
  $('availability').textContent = journeys.length ? `${Math.round(ok / journeys.length * 100)}%` : '\u2014';
  $('availability').className = ok < journeys.length ? 'bad' : '';
  $('issues-count').textContent = data.issue && data.issue.status !== 'resolved' ? '1' : '0';
  $('issues-count').className = data.issue && data.issue.status !== 'resolved' ? 'bad' : '';
  const guardsOk = guards.filter((p) => p.ok).length;
  $('guard-count').textContent = guards.length ? `${guardsOk}/${guards.length}` : '\u2014';
  $('guard-count').className = guardsOk < guards.length ? 'bad' : '';
  const recovered = [...data.history, ...(data.issue ? [data.issue] : [])].filter((i) => i.status === 'resolved' && i.resolvedAt).at(-1);
  $('last-recovery').textContent = recovered ? duration(recovered.resolvedAt - recovered.detectedAt) : '\u2014';
  const issue = data.issue;
  const state = issue ? lifecycle(issue, data.operation, data.recoveryRequired) : null;
  const [tone, title, subline] = headline(data, issue, ok, journeys.length);
  $('status-strip').className = `status-strip tone-${tone}`;
  $('headline').textContent = title;
  $('subline').textContent = subline;
  $('twinops').href = `${data.twinopsUrl}/connections`;
  $('journey-badge').textContent = journeys.length ? `${ok} OF ${journeys.length} OPERATIONAL` : 'LIVE PROBES';
  $('journey-badge').className = `pill ${journeys.length && ok < journeys.length ? 'tone-bad' : 'tone-ok'}`;
  renderMap(data, journeys);
  if (journeys.length) paint('journeys', journeys.map((p) => `<article class="journey ${p.ok ? '' : 'failing'}"><span class="state-icon" aria-hidden="true">${p.ok ? '\u2713' : '!'}</span><div><h3>${escape(p.label)}</h3><p>${escape(p.detail)}</p></div><div class="probe-result"><strong>${p.ok ? 'Operational' : 'Disrupted'}</strong><small>${p.latencyMs != null ? `${escape(p.latencyMs)} ms` : 'Probe failed'}</small></div></article>`).join(''));
  if (guards.length) paint('guardrails', guards.map((p) => `<div class="guard ${p.ok ? '' : 'failing'}"><span aria-hidden="true">${p.ok ? '\u2713' : '!'}</span>${escape(p.label)}<small>${p.ok ? 'Holding' : 'Violated'}</small></div>`).join(''));
  let announcement = 'Monitoring. No active service issues.';
  if (issue) {
    const failed = (issue.failedJourneys ?? []).map((id) => data.topology?.journeys.find((j) => j.id === id)?.label ?? id);
    const link = issue.incidentId ? `<a class="button primary" href="${escape(investigationUrl(data, issue.incidentId))}" target="_blank" rel="noreferrer">${state.blocked || state.current >= 4 ? 'Review evidence' : 'Follow investigation'} \u2197</a>` : '';
    $('issue-badge').textContent = state.badge;
    $('issue-badge').className = `pill tone-${state.tone}`;
    paint('incident', `<h3>${escape(issue.title)}</h3><p class="muted">${failed.map(escape).join(' \u00b7 ')}</p>${tracker(state)}<p class="incident-status tone-${state.tone}">${escape(state.text)}</p>${link}`);
    $('elapsed').textContent = issue.status === 'resolved' && issue.resolvedAt ? `Detected ${clock(issue.detectedAt)} \u00b7 recovered in ${duration(issue.resolvedAt - issue.detectedAt)}` : `Detected ${clock(issue.detectedAt)} \u00b7 open for ${duration(Date.now() / 1000 - issue.detectedAt)}`;
    announcement = `${state.badge.toLowerCase()}. ${state.text}`;
  } else {
    $('issue-badge').textContent = 'MONITORING';
    $('issue-badge').className = 'pill tone-ok';
    paint('incident', '<div class="empty-symbol" aria-hidden="true">\u25ce</div><h3>No active service issues</h3><p class="muted">New failures appear here and are picked up automatically by TwinOps.</p>');
    $('elapsed').textContent = '';
  }
  if ($('announce').textContent !== announcement) $('announce').textContent = announcement;
  const faultBlocked = pending || !data.ready || data.recoveryRequired || (!!issue && !replaceable(issue));
  document.querySelectorAll('[data-fault]').forEach((b) => { b.disabled = faultBlocked; });
  const [hintTone, hintText] = faultHint(data, issue);
  $('fault-hint').textContent = hintText;
  $('fault-hint').className = `fault-hint tone-${hintTone}`;
  $('reset').hidden = !issue;
  $('reset').textContent = replaceable(issue) ? 'Clear without a new fault' : 'Reset scenario';
  $('reset').disabled = pending || !data.ready || !issue || data.recoveryRequired || (!!issue.incidentId && issue.investigationStatus !== 'finished');
  paint('history', data.history.length ? data.history.slice().reverse().map((i) => {
    const [label, tone] = HISTORY_STATUS[i.status] ?? [i.status, 'muted'];
    const timing = i.resolvedAt ? `recovered in ${duration(i.resolvedAt - i.detectedAt)}` : `detected ${clock(i.detectedAt)}`;
    const failed = (i.failedJourneys ?? []).join(', ');
    return `<div class="history-row"><div><strong>${escape(i.title)}</strong><small>${escape(new Date(i.detectedAt * 1000).toLocaleString())} \u00b7 ${escape(timing)}${failed ? ` \u00b7 ${escape(failed)}` : ''}</small></div><span class="tag tone-${tone}">${escape(label)}</span>${i.incidentId ? `<a href="${escape(investigationUrl(data, i.incidentId))}" target="_blank" rel="noreferrer">Evidence \u2197</a>` : '<span></span>'}</div>`;
  }).join('') : 'No completed scenarios yet.');
}
async function action(path, body = {}) {
  const replacing = !path.endsWith('reset') && !!latest?.issue;
  pending = true;
  if (latest) render(latest);
  $('action-status').textContent = path.endsWith('reset') ? 'Restoring the healthy lab…' : replacing ? 'Restoring the healthy baseline, then applying the fault…' : 'Applying fault and measuring service impact…';
  try {
    const response = await fetch(path, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail || 'The operation failed');
    render(result);
    $('action-status').textContent = path.endsWith('reset') ? 'Lab restored. Ready for another scenario.' : `${replacing ? 'Previous scenario moved to Recent issues. ' : ''}Fault applied. TwinOps will detect the incident automatically.`;
  } catch (e) { $('action-status').textContent = e.message; }
  finally { pending = false; if (latest) render(latest); }
}
document.querySelectorAll('[data-fault]').forEach((b) => b.addEventListener('click', () => action('/api/faults', {fault:b.dataset.fault})));
$('reset').addEventListener('click', () => action('/api/reset'));
async function poll() {
  try {
    const response = await fetch('/api/dashboard');
    if (!response.ok) throw new Error('Dashboard unavailable');
    render(await response.json());
  } catch {
    $('connection').textContent = 'Connection lost · retrying';
    if (latest) { latest.ready = false; render(latest); }
  }
  setTimeout(poll, 2500);
}
poll();
