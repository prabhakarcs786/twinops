const $ = (id) => document.getElementById(id);
let pending = false;
let latest;
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clock = (ts) => new Date(ts * 1000).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'});
function render(data) {
  latest = data;
  const obs = data.observation;
  const journeys = (obs?.probes ?? []).filter((p) => p.kind === 'journey');
  const ok = journeys.filter((p) => p.ok).length;
  $('connection').textContent = data.ready ? 'Lab connected · live measurements' : 'Lab unavailable';
  $('checked').textContent = data.checkedAt ? `Last measured ${clock(data.checkedAt)}${data.ready ? '' : ' · stale'}` : 'Waiting for first measurement';
  $('error').hidden = !data.error && !data.recoveryRequired;
  $('error').textContent = data.recoveryRequired ? 'A change was interrupted or recovery could not be verified. Operator recovery is required; further changes are blocked.' : data.error || '';
  $('availability').textContent = journeys.length ? `${Math.round(ok / journeys.length * 100)}%` : '—';
  $('availability').className = ok < journeys.length ? 'bad' : '';
  $('issues-count').textContent = data.issue && data.issue.status !== 'resolved' ? '01' : '00';
  $('twinops').href = `${data.twinopsUrl}/connections`;
  if (journeys.length) $('journeys').innerHTML = journeys.map((p) => `<article class="journey ${p.ok ? '' : 'failing'}"><span class="state-icon">${p.ok ? '✓' : '!'}</span><div><h3>${escape(p.label)}</h3><p>${escape(p.detail)}</p></div><div class="probe-result"><strong>${p.ok ? 'Operational' : 'Disrupted'}</strong><small>${p.latencyMs != null ? `${escape(p.latencyMs)} ms` : 'Probe failed'}</small></div></article>`).join('');
  const issue = data.issue;
  $('issue-badge').textContent = issue ? issue.status.toUpperCase() : 'MONITORING';
  if (issue) {
    const assigned = issue.incidentId;
    $('incident').innerHTML = `<div class="incident-icon ${issue.status === 'resolved' ? 'recovered' : ''}">${issue.status === 'resolved' ? '✓' : '!'}</div><h3>${escape(issue.title)}</h3><p class="muted">Detected at ${clock(issue.detectedAt)} · ${escape(issue.failedJourneys.join(', '))}</p><div class="incident-status">${issue.status === 'resolved' ? 'Recovery verified by service probes' : assigned ? issue.investigationStatus === 'finished' ? 'Investigation finished · service still needs attention' : 'TwinOps is handling this incident' : 'Waiting for TwinOps to detect this issue'}</div>${assigned ? `<a class="button primary" href="${escape(data.twinopsUrl)}/workbench?incident=${encodeURIComponent(assigned)}" target="_blank" rel="noreferrer">View investigation ↗</a>` : '<p class="muted">Automatic detection runs in the TwinOps backend.</p>'}`;
  } else $('incident').innerHTML = '<div class="empty-symbol">◎</div><h3>No active service issues</h3><p class="muted">New failures will appear here and be picked up automatically by TwinOps.</p>';
  document.querySelectorAll('[data-fault]').forEach((b) => { b.disabled = pending || !data.ready || !!issue || data.recoveryRequired; });
  $('reset').disabled = pending || !data.ready || !issue || data.recoveryRequired || (!!issue.incidentId && issue.investigationStatus !== 'finished');
  $('history').innerHTML = data.history.length ? data.history.slice().reverse().map((i) => `<div class="history-row"><span>${escape(i.title)}</span><span>${escape(i.status)} · ${clock(i.detectedAt)}</span></div>`).join('') : 'No completed scenarios yet.';
}
async function action(path, body = {}) {
  pending = true;
  if (latest) render(latest);
  $('action-status').textContent = path.endsWith('reset') ? 'Restoring the healthy lab…' : 'Applying fault and measuring service impact…';
  try {
    const response = await fetch(path, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail || 'The operation failed');
    render(result);
    $('action-status').textContent = path.endsWith('reset') ? 'Lab restored. Ready for another scenario.' : 'Fault applied. TwinOps will detect the incident automatically.';
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
