const $ = (id) => document.getElementById(id);
let pending = false;
let localActivity = null;
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
const recoveryReason = (data) => data.recoveryReason || 'A lab write did not finish.';
const STEPS = ['Detected', 'TwinOps investigating', 'Approved change applied', 'Recovery verified'];
const HISTORY_STATUS = {resolved: ['Recovered', 'ok'], reset: ['Reset by operator', 'muted'], open: ['Unresolved', 'bad']};
// Mirrors NetworkState.can_replace_issue: a new fault restores the baseline and archives this scenario.
const replaceable = (issue) => issue?.status === 'resolved' && (!issue.incidentId || issue.investigationStatus === 'finished');
const affectedPops = (data, issue) => (issue.failedJourneys ?? []).map((id) => {
  const from = data.topology?.journeys.find((j) => j.id === id)?.from;
  return data.topology?.nodes.find((n) => n.id === from)?.label.replace(' PoP', '') ?? id;
}).join(', ');

function lifecycle(issue, operation, recoveryReason) {
  if (recoveryReason) return {current: 2, blocked: true, note: 'Interrupted', tone: 'bad', badge: 'RECOVERY REQUIRED', text: `${recoveryReason} An operator must restore and verify the healthy baseline.`};
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

// Where a probe failure points in the topology, as a monitoring system would localise it.
const LOCATE = {no_route: 'B17', wrong_address: 'DNS-1', tls_expired: 'GW-1', tls_name: 'GW-1', slo_breach: 'SVC-1'};
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

function faultPoint(probe, journey) {
  if (probe.failure === 'intermittent') return {node: journey.from, uplink: true};
  return {node: LOCATE[probe.failure] ?? probe.failedAt ?? 'B17'};
}

function renderMap(data, journeys) {
  const topo = data.topology;
  if (!topo) return;
  const at = Object.fromEntries(topo.nodes.map((n) => [n.id, n]));
  const meta = Object.fromEntries(topo.journeys.map((j) => [j.id, j]));
  const failingPops = new Set();
  const servedPops = new Set();
  const brokenLinks = new Set();
  const faults = new Map();
  const linkKey = (a, b) => [a, b].sort().join('|');
  let flows = '';
  journeys.forEach((probe, index) => {
    const journey = meta[probe.id];
    if (!journey) return;
    const route = [journey.from, 'B17', 'GW-1', 'SVC-1'];
    let reach = route;
    if (probe.ok) servedPops.add(journey.from);
    else {
      failingPops.add(journey.from);
      const point = faultPoint(probe, journey);
      faults.set(point.node, FAILURE[probe.failure] ?? 'Failing');
      // DNS sits beside the data path: customers are stopped at the core before ever reaching the gateway.
      reach = point.uplink ? route.slice(0, 2) : point.node === 'DNS-1' ? [journey.from, 'B17', 'DNS-1'] : route.slice(0, Math.max(2, route.indexOf(point.node) + 1));
      reach.slice(1).forEach((node, i) => brokenLinks.add(linkKey(reach[i], node)));
    }
    const d = `M${reach.map((id) => `${at[id].x} ${at[id].y}`).join(' L')}`;
    const duration = probe.ok ? 3.2 : 2;
    for (const offset of [0, duration / 2]) {
      const begin = `${(offset + index * 0.3).toFixed(1)}s`;
      const fade = probe.ok ? '' : `<animate attributeName="opacity" values="1;1;0" keyTimes="0;0.75;1" dur="${duration}s" begin="${begin}" repeatCount="indefinite"/>`;
      flows += reduceMotion ? '' : `<circle class="packet ${probe.ok ? 'ok' : 'bad'}" r="3.2"><animateMotion dur="${duration}s" begin="${begin}" repeatCount="indefinite" path="${d}"/>${fade}</circle>`;
    }
  });
  const links = topo.links.map((l) => `<line class="link${l.backup ? ' backup' : ''}${brokenLinks.has(linkKey(l.a, l.b)) ? ' broken' : ''}" x1="${at[l.a].x}" y1="${at[l.a].y}" x2="${at[l.b].x}" y2="${at[l.b].y}"/>`).join('');
  const nodes = topo.nodes.map((n) => {
    const state = failingPops.has(n.id) ? ' bad' : servedPops.has(n.id) ? ' ok' : faults.has(n.id) ? ' fault' : '';
    return `<g class="node ${escape(n.role)}${state}"><rect x="${n.x - 27}" y="${n.y - 14}" width="54" height="28" rx="8"/><text x="${n.x}" y="${n.y + 4}">${escape(n.short)}</text></g>`;
  }).join('');
  const marks = [...faults].map(([id, label]) => {
    const n = at[id];
    const pulse = reduceMotion ? '' : '<animate attributeName="r" values="20;30;20" dur="1.8s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.7;0;0.7" dur="1.8s" repeatCount="indefinite"/>';
    const y = n.y > 70 ? n.y - 24 : n.y + 34;
    return `<g class="fault-mark"><circle class="pulse" cx="${n.x}" cy="${n.y}" r="22">${pulse}</circle><text class="fault-label" x="${n.x}" y="${y}">${escape(label)}</text></g>`;
  }).join('');
  paint('map', links + flows + nodes + marks);
  const names = [...failingPops].map((id) => at[id]?.label ?? id);
  const where = [...faults].map(([id, label]) => `${label} at ${at[id]?.label ?? id}`);
  $('map').setAttribute('aria-label', names.length ? `Network map: customers disrupted at ${names.join(', ')}. ${where.join('; ')}.` : 'Network map: traffic flowing to every location');
}

function headline(data, issue, ok, total) {
  if (data.recoveryRequired) return ['bad', 'Operator recovery required', `${recoveryReason(data)} Faults and changes are blocked until the healthy baseline is restored and verified.`];
  if (!data.ready) return ['warn', data.checkedAt ? 'Lab unavailable' : 'Connecting to the lab\u2026', data.checkedAt ? 'Showing the last measurement. Retrying automatically.' : 'Waiting for the first service measurement.'];
  if (issue && issue.status !== 'resolved') return ['bad', total > ok ? `Service disruption \u00b7 ${total - ok} of ${total} journeys failing` : issue.title, `Customers affected at ${affectedPops(data, issue)}. Follow the recovery in the incident desk.`];
  if (issue) return ['ok', 'Service restored', `${issue.resolvedAt ? `Recovered in ${duration(issue.resolvedAt - issue.detectedAt)}. ` : ''}All ${total} customer journeys reachable again.`];
  return ['ok', 'All services operational', `${ok} of ${total} customer journeys reachable across Berlin, Hamburg, Munich and Frankfurt.`];
}

function faultHint(data, issue) {
  if (data.recoveryRequired) return ['bad', data.ready ? 'Faults are blocked until the lab is recovered. Use Operator recovery below.' : 'Faults are blocked until the lab is reachable again and recovered.'];
  if (!data.ready) return ['warn', 'Waiting for the lab to report healthy measurements.'];
  if (replaceable(issue)) return ['ok', 'Last scenario recovered. Choose a fault to start the next exercise; the lab returns to its healthy baseline first.'];
  if (issue?.status === 'resolved') return ['warn', 'Service recovered. TwinOps is closing its investigation\u2026'];
  if (issue?.incidentId && issue.investigationStatus !== 'finished') return ['warn', 'An investigation is in progress. Follow it in TwinOps.'];
  if (issue) return ['bad', 'This scenario ended without a verified recovery. Review the evidence, then reset the scenario.'];
  return ['ok', 'Lab healthy. Choose one fault to introduce.'];
}

const WHY = {
  route: 'Core router B17 only forwards traffic to customer ranges its filter accepts. Without a return route, replies never reach those customers, so connections time out.',
  dns: 'DNS turns a name such as svc.demo into an address. A wrong answer sends customers to an address where the service is not running.',
  tls: 'Apps check the server certificate before sending anything. An expired certificate makes them refuse the secure connection.',
  clients: 'Customer apps changed how strictly they check certificates.',
  mgmt: 'Reachability of the operator admin console changed.',
  nodes: 'A device stopped responding.',
};
const WRITER = {harness: 'Exercise harness (your fault)', apply_gateway: 'Apply gateway (approved change)'};
const CAUSE = {route: 'Route filter changed', dns: 'DNS answer changed', tls: 'Certificate expired', clients: 'Client security changed', mgmt: 'Admin access changed', nodes: 'Device stopped'};
const FAILURE = {no_route: 'No return route', wrong_address: 'Wrong address', tls_expired: 'Certificate expired', tls_name: 'TLS check failed', node_down: 'No answer', intermittent: 'Packets lost', slo_breach: 'Too slow'};
const ACTIVITY = {fault: ['PREPARING', 'Starting the exercise'], reset: ['RESTORING', 'Restoring the healthy lab'], rollback: ['ROLLING BACK', 'Rolling back the approved change']};
const median = (values) => values.length ? values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)] : null;
const latencies = (snap) => (snap?.journeys ?? []).filter((j) => j.ok && j.latencyMs != null).map((j) => j.latencyMs);
const factValue = (facts, key) => facts ? (facts[key]?.value ?? 'not present') : null;

// Compares settings read from the devices; rows identical in every snapshot are only counted.
function factRows(proof) {
  const snaps = [proof.before, proof.during, proof.after].map((s) => s?.facts ?? null);
  const keys = [...new Set(snaps.flatMap((f) => f ? Object.keys(f) : []))];
  const rows = [];
  let unchanged = 0;
  for (const key of keys) {
    const [b, d, a] = snaps.map((f) => factValue(f, key));
    if (new Set([b, d, a].filter((v) => v !== null)).size <= 1) { unchanged += 1; continue; }
    const byFault = b !== null && d !== null && b !== d;
    let verdict;
    if (b === null) verdict = ['Changed during recovery', 'warn'];
    else if (a === null) verdict = byFault ? ['Changed by the fault', 'bad'] : ['Changed', 'warn'];
    else if (byFault) verdict = a === b ? ['Back to its original value', 'ok'] : ['Still differs from before', 'bad'];
    else verdict = ['Changed by the fix', 'warn'];
    const topic = snaps.find((f) => f?.[key])?.[key].topic;
    rows.push({key, topic, byFault, restored: byFault && a === b, verdict, snaps});
  }
  return {rows, unchanged};
}

function factCell(facts, key) {
  if (!facts) return '<td class="cell-na">not measured</td>';
  const fact = facts[key];
  return fact ? `<td><strong>${escape(fact.value)}</strong>${fact.detail ? `<small>${escape(fact.detail)}</small>` : ''}</td>` : '<td class="cell-na">not present</td>';
}

function columnHeads(proof) {
  const head = (label, snap, pending) => `<th scope="col">${label}<small>${snap?.at ? clock(snap.at) : pending}</small></th>`;
  return head('Before', proof.before, 'not measured') + head('During', proof.during, 'waiting for probes') + head('After', proof.after, 'not recovered yet');
}

function verdictBanner(proof, facts, recovered) {
  if (!proof.fromExercise) return proof.during ? '<p class="verdict">This issue was not started from the exercise panel, so there is no sealed answer to reveal.</p>' : '';
  if (proof.sealed) return '<p class="verdict"><strong>Blind test running.</strong>TwinOps doesn\u2019t know which fault you chose. The answer is revealed here when it closes the investigation.</p>';
  const chose = `You chose: ${escape(proof.fault.label)}.`;
  if (proof.fault.id === 'unsupported_link_flap') {
    return proof.applied ? `<p class="verdict tone-bad"><strong>${chose}</strong>TwinOps changed the network for a fault its twin cannot reproduce. Review the evidence in TwinOps.</p>`
      : `<p class="verdict tone-ok"><strong>${chose} TwinOps changed nothing and handed it to a person.</strong>Correct: its twin can\u2019t reproduce a physical link fault, so it doesn\u2019t guess.</p>`;
  }
  const broken = facts.rows.filter((r) => r.byFault);
  const sideChanges = facts.rows.filter((r) => !r.byFault && r.snaps[2]).length;
  if (recovered && proof.applied && broken.length && broken.every((r) => r.restored)) {
    if (sideChanges) return `<p class="verdict tone-warn"><strong>${chose} TwinOps found and fixed it without being told, with side effects.</strong>Service is back, but the fix also changed ${sideChanges} setting${sideChanges === 1 ? '' : 's'} your fault never touched. See Device changes.</p>`;
    return `<p class="verdict tone-ok"><strong>${chose} TwinOps found and fixed it without being told.</strong>Every setting your fault changed is back, nothing else changed, and every journey passes fresh probes.</p>`;
  }
  return `<p class="verdict tone-bad"><strong>${chose}</strong>${recovered ? 'Service is back, but not every setting your fault changed is back to its original value. See Device changes.' : 'TwinOps did not restore service. Review its evidence, then reset the scenario.'}</p>`;
}

// Four short cards; the detail lives in the tabs below so the summary stays scannable.
function flow(data, proof, facts, recovered) {
  const broken = facts.rows.filter((r) => r.byFault);
  const failing = (proof.during?.journeys ?? []).filter((j) => !j.ok);
  const issue = data.issue;
  let cause;
  if (!proof.during) cause = ['pending', 'Measuring\u2026', 'Waiting for live probes to confirm impact'];
  else if (!proof.before?.facts) cause = ['muted', 'Not recorded', 'This issue was not started from the exercise panel'];
  else if (!broken.length) cause = ['warn', 'No setting changed', 'The cause is outside device configuration, for example a physical link'];
  else cause = ['bad', CAUSE[broken[0].topic] ?? 'Setting changed', `${broken[0].key}: ${factValue(broken[0].snaps[0], broken[0].key)} \u2192 ${factValue(broken[0].snaps[1], broken[0].key)}${broken.length > 1 ? ` (+${broken.length - 1} more)` : ''}`];
  const impact = !proof.during ? ['pending', 'Not known yet', 'Live probes run every 5 seconds']
    : ['bad', `${failing.length} of ${proof.during.journeys.length} journeys failing`, failing.map((j) => j.label).join(' \u00b7 ')];
  let fix;
  if (proof.applied) fix = [proof.applied.rolledBack ? 'warn' : 'ok', proof.applied.label, `Approved by a person at ${clock(proof.applied.at)} \u00b7 ${proof.applied.steps.length} step${proof.applied.steps.length === 1 ? '' : 's'}${proof.applied.rolledBack ? ' \u00b7 rolled back' : ''}`];
  else if (issue?.investigationStatus === 'finished') fix = ['warn', 'No change made', 'TwinOps handed it to a person instead of guessing'];
  else if (issue?.incidentId) fix = ['pending', 'Testing fixes in the twin', 'Nothing changes here until a person approves'];
  else fix = ['pending', 'Waiting for TwinOps', 'It checks for new issues every 5 seconds'];
  let result;
  if (recovered) {
    const after = median(latencies(proof.after));
    const before = median(latencies(proof.before));
    result = ['ok', `${proof.after.journeys.length} of ${proof.after.journeys.length} journeys back`, `Typical response ${after ?? '\u2014'} ms${before != null ? ` \u00b7 before the fault ${before} ms` : ''}`];
  } else if (issue?.investigationStatus === 'finished') result = ['bad', 'Not recovered', 'A person must repair the cause, then reset the scenario'];
  else result = ['pending', 'Pending', 'Counts only when fresh probes from every location pass'];
  const card = (label, [tone, head, sub]) => `<li class="flow-step tone-${tone}"><span class="flow-label">${label}</span><strong>${escape(head)}</strong><span class="flow-sub" title="${escape(sub)}">${escape(sub)}</span></li>`;
  return `<ol class="flow" aria-label="What happened, step by step">${card('1 \u00b7 CAUSE', cause)}${card('2 \u00b7 IMPACT', impact)}${card('3 \u00b7 FIX', fix)}${card('4 \u00b7 PROOF', result)}</ol>`;
}

const chip = (journey) => !journey ? '<span class="chip chip-na">not measured</span>'
  : journey.ok ? `<span class="chip chip-ok">\u2713 ${escape(journey.latencyMs)} ms</span>`
  : `<span class="chip chip-bad">\u2717 ${escape(FAILURE[journey.failure] ?? 'Failed')}</span>`;

function impactPanel(proof) {
  const snaps = [proof.before, proof.during, proof.after];
  const ids = [...new Set(snaps.flatMap((s) => (s?.journeys ?? []).map((j) => j.id)))];
  const find = (snap, id) => snap?.journeys.find((j) => j.id === id);
  const rows = ids.map((id) => {
    const label = snaps.map((s) => find(s, id)?.label).find(Boolean) ?? id;
    return `<tr><th scope="row">${escape(label)}</th>${snaps.map((s) => `<td>${s ? chip(find(s, id)) : '<span class="cell-na" aria-label="not measured yet">\u2014</span>'}</td>`).join('')}</tr>`;
  }).join('');
  const failing = (proof.during?.journeys ?? []).filter((j) => !j.ok);
  return `<div class="table-wrap" tabindex="0" role="region" aria-label="Customer journeys before, during and after"><table class="compare compact"><caption class="sr-only">The same live probe for each customer journey at three moments</caption><thead><tr><th scope="col">Customer journey</th>${columnHeads(proof)}</tr></thead><tbody>${rows}</tbody></table></div>`
    + (failing.length ? `<details class="raw"><summary>What the failing probes reported</summary><ul class="raw-list">${failing.map((j) => `<li><strong>${escape(j.label)}</strong>: ${escape(j.detail)}</li>`).join('')}</ul></details>` : '');
}

function devicesPanel(proof, facts) {
  const broken = facts.rows.filter((r) => r.byFault);
  const why = broken.length && WHY[broken[0].topic] ? `<p class="why-box"><strong>Why this breaks service.</strong> ${escape(WHY[broken[0].topic])}</p>` : '';
  const table = facts.rows.length ? `<div class="table-wrap" tabindex="0" role="region" aria-label="Device settings before, during and after"><table class="compare"><caption class="sr-only">Settings read from the devices at three moments</caption><thead><tr><th scope="col">Setting read from the device</th>${columnHeads(proof)}<th scope="col">Verdict</th></tr></thead><tbody>${facts.rows.map((r) => `<tr><th scope="row">${escape(r.key)}</th>${r.snaps.map((f) => factCell(f, r.key)).join('')}<td><span class="tag tone-${r.verdict[1]}">${escape(r.verdict[0])}</span></td></tr>`).join('')}</tbody></table></div>`
    : `<p class="muted">${proof.before?.facts ? 'No device setting differs between the snapshots.' : 'Device settings were not recorded before this issue.'}</p>`;
  return why + table + (facts.unchanged ? `<p class="unchanged muted">${facts.unchanged} other settings were read from the devices each time and did not change.</p>` : '');
}

function timelinePanel(proof) {
  const start = proof.timeline[0]?.at ?? proof.before?.at ?? 0;
  const items = proof.timeline.map((e) => `<li><time>${clock(e.at)}</time><span class="offset">+${duration(e.at - start)}</span><strong>${escape(e.actor)}</strong><p>${escape(e.text)}</p></li>`).join('');
  const writes = proof.writes.length ? `<ol>${proof.writes.map((w) => `<li><strong>${escape(WRITER[w.actor] ?? w.actor)}</strong>: ${escape(w.summary)}</li>`).join('')}</ol>` : '<p>None.</p>';
  return `<ol class="timeline">${items}</ol><div class="writes"><h3>Every write to the devices since the fault</h3>${writes}</div>`;
}

function renderProof(data) {
  const proof = data.proof;
  const seal = proof?.fromExercise ? (proof.sealed ? ['BLIND TEST \u00b7 SEALED', 'warn'] : ['BLIND TEST \u00b7 REVEALED', 'ok']) : ['BLIND TEST', 'ok'];
  $('seal').textContent = seal[0];
  $('seal').className = `pill tone-${seal[1]}`;
  let focus = [];
  let topics = [];
  if (!proof) {
    paint('proof-summary', '<p class="muted">Introduce a fault and this panel compares live customer probes and device settings before the fault, during the outage and after the fix. TwinOps never sees this panel.</p>');
    for (const id of ['panel-impact', 'panel-devices', 'panel-timeline']) paint(id, '<p class="muted">Shown after you introduce a fault.</p>');
    $('count-devices').textContent = '';
    $('count-timeline').textContent = '';
  } else {
    const facts = factRows(proof);
    const recovered = !!proof.after && proof.after.journeys.every((j) => j.ok);
    paint('proof-summary', verdictBanner(proof, facts, recovered) + flow(data, proof, facts, recovered));
    paint('panel-impact', impactPanel(proof));
    paint('panel-devices', devicesPanel(proof, facts));
    paint('panel-timeline', timelinePanel(proof));
    $('count-devices').textContent = facts.rows.length || '';
    $('count-timeline').textContent = proof.timeline.length || '';
    focus = (proof.during?.journeys ?? []).filter((j) => !j.ok).map((j) => j.id);
    topics = facts.rows.filter((r) => r.byFault).map((r) => r.topic);
  }
  const verify = data.verify;
  if (!verify) return;
  const label = (id) => data.topology?.journeys.find((j) => j.id === id)?.label ?? id;
  const journeyIds = (focus.length ? focus : Object.keys(verify.journeys).slice(0, 1)).filter((id) => verify.journeys[id]);
  const devices = verify.devices.slice().sort((a, b) => Number(topics.includes(b.topic)) - Number(topics.includes(a.topic)));
  const items = [...journeyIds.map((id) => ({label: `${label(id)}: the same request the live probe makes`, command: verify.journeys[id]})), ...devices];
  paint('verify', items.map((c, i) => `<div class="command"><p>${escape(c.label)}</p><div class="command-line"><code id="cmd-${i}">${escape(c.command)}</code><button type="button" class="button secondary copy" data-copy="cmd-${i}" aria-label="Copy command: ${escape(c.label)}">Copy</button></div></div>`).join(''));
}

const MARKER = {fault: 'Fault', detected: 'Detected', claimed: 'TwinOps on it', applied: 'Fix applied', recovered: 'Recovered', rolledback: 'Rolled back', reopened: 'Failing again'};

function laneSummary(data) {
  const issue = data.issue;
  if (!issue) return 'All journeys healthy. Live probes run every 5 seconds.';
  const faultAt = data.proof?.timeline.find((e) => e.kind === 'fault')?.at;
  const detected = faultAt ? `detected ${duration(issue.detectedAt - faultAt)} after the fault` : null;
  const lost = `${Math.round(issue.customerMinutes ?? 0).toLocaleString()} customer-minutes lost`;
  if (issue.status !== 'resolved') return [`Incident open for ${duration(Date.now() / 1000 - issue.detectedAt)}`, detected, lost].filter(Boolean).join(' \u00b7 ');
  return [`Restored in ${duration(issue.resolvedAt - issue.detectedAt)}`, detected, lost].filter(Boolean).join(' \u00b7 ');
}

// One lane per customer journey: the same live probe over time, with the incident steps marked on it.
function renderLanes(data, journeys) {
  const topo = data.topology;
  if (!topo) return;
  const span = data.window ?? 600;
  const now = data.checkedAt ?? Date.now() / 1000;
  const start = now - span;
  const pos = (t) => Math.max(0, Math.min(1000, ((t - start) / span) * 1000));
  const samples = (data.telemetry ?? []).filter((s) => s.t >= start - 15);
  const events = (data.proof?.timeline ?? []).filter((e) => MARKER[e.kind] && e.at >= start);
  const markers = [];
  events.forEach((e, i) => {
    const x = pos(e.at) / 10;
    const last = markers.at(-1);
    // Steps seconds apart (a fault and its detection) share one numbered marker.
    if (last && x - last.x < 2.5) last.nums.push(i + 1);
    else markers.push({x, nums: [i + 1]});
  });
  const lines = markers.map((m) => `<line class="marker" x1="${(m.x * 10).toFixed(1)}" x2="${(m.x * 10).toFixed(1)}" y1="0" y2="10" vector-effect="non-scaling-stroke"/>`).join('');
  const current = Object.fromEntries(journeys.map((p) => [p.id, p]));
  const rows = topo.journeys.map((journey) => {
    const cells = [];
    samples.forEach((s, i) => {
      const value = s.j[journey.id];
      const state = value === undefined ? 'na' : value === null ? 'bad' : 'ok';
      const end = Math.min(samples[i + 1]?.t ?? now, s.t + 15);
      const last = cells.at(-1);
      if (last && last.state === state && s.t - last.end < 1) last.end = end;
      else cells.push({state, start: s.t, end});
    });
    const rects = cells.map((c) => `<rect class="cell ${c.state}" x="${pos(c.start).toFixed(1)}" y="0" width="${Math.max(3, pos(c.end) - pos(c.start)).toFixed(1)}" height="10"/>`).join('');
    const probe = current[journey.id];
    const state = !probe ? '<span class="chip chip-na">no data</span>' : probe.ok ? `<span class="chip chip-ok">\u2713 ${escape(probe.latencyMs)} ms</span>` : `<span class="chip chip-bad">\u2717 ${escape(FAILURE[probe.failure] ?? 'Failed')}</span>`;
    const people = data.impact?.byPop?.[journey.from];
    return `<div class="lane"><div class="lane-label"><strong>${escape(journey.label)}</strong>${people ? `<small>${people.toLocaleString()} customers</small>` : ''}</div><svg class="lane-bar" viewBox="0 0 1000 10" preserveAspectRatio="none" aria-hidden="true">${rects}${lines}</svg>${state}</div>`;
  }).join('');
  const labels = markers.map((m) => `<span class="marker-label${m.x < 3 ? ' start' : m.x > 97 ? ' end' : ''}" data-x="${m.x.toFixed(1)}">${m.nums.length > 1 ? `${m.nums[0]}\u2013${m.nums.at(-1)}` : m.nums[0]}</span>`).join('');
  const legend = events.length ? `<ol class="marker-legend">${events.map((e, i) => `<li><b>${i + 1}</b>${escape(MARKER[e.kind])} <small>${clock(e.at)}</small></li>`).join('')}</ol>` : '';
  paint('lanes', `<div class="lane lane-markers" aria-hidden="true"><span></span><div class="axis">${labels}</div><span></span></div>${rows}<div class="lane lane-ticks" aria-hidden="true"><span></span><div class="axis"><span data-x="0">\u221210 min</span><span data-x="50">\u22125 min</span><span data-x="100">now</span></div><span></span></div>${legend}`);
  // CSP forbids inline style attributes; positioning through the CSSOM is allowed.
  document.querySelectorAll('#lanes [data-x]').forEach((el) => { el.style.left = `${el.dataset.x}%`; });
  $('lanes-summary').textContent = laneSummary(data);
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
  const problems = [data.error, data.recoveryRequired && `Operator recovery required: ${recoveryReason(data)}`].filter(Boolean);
  $('error').hidden = !problems.length;
  $('error').textContent = problems.join(' \u00b7 ');
  $('availability').textContent = journeys.length ? `${Math.round(ok / journeys.length * 100)}%` : '\u2014';
  $('availability').className = ok < journeys.length ? 'bad' : '';
  $('customers').textContent = data.impact ? data.impact.customers.toLocaleString() : '\u2014';
  $('customers').className = data.impact?.customers ? 'bad' : '';
  const recovered = [...data.history, ...(data.issue ? [data.issue] : [])].filter((i) => i.status === 'resolved' && i.resolvedAt).at(-1);
  $('last-recovery').textContent = recovered ? duration(recovered.resolvedAt - recovered.detectedAt) : '\u2014';
  const issue = data.issue;
  const state = issue ? lifecycle(issue, data.operation, data.recoveryRequired && recoveryReason(data)) : null;
  const [tone, title, subline] = headline(data, issue, ok, journeys.length);
  $('status-strip').className = `status-strip tone-${tone}`;
  $('headline').textContent = title;
  $('subline').textContent = subline;
  $('twinops').href = `${data.twinopsUrl}/connections`;
  $('journey-badge').textContent = journeys.length ? `${ok} OF ${journeys.length} OPERATIONAL` : 'LIVE PROBES';
  $('journey-badge').className = `pill ${journeys.length && ok < journeys.length ? 'tone-bad' : 'tone-ok'}`;
  renderMap(data, journeys);
  renderLanes(data, journeys);
  if (guards.length) paint('guardrails', guards.map((p) => `<div class="guard ${p.ok ? '' : 'failing'}"><span aria-hidden="true">${p.ok ? '\u2713' : '!'}</span>${escape(p.label)}<small>${p.ok ? 'Holding' : 'Violated'}</small></div>`).join(''));
  let announcement = 'Monitoring. No active service issues.';
  const activity = data.activity ?? (pending ? localActivity : null);
  if (activity) {
    const [badge, title] = ACTIVITY[activity.kind] ?? ['WORKING', 'Working on the lab'];
    $('issue-badge').textContent = badge;
    $('issue-badge').className = 'pill tone-warn';
    paint('incident', `<div class="activity"><span class="spinner" aria-hidden="true"></span><div><h3>${escape(title)}</h3><p class="incident-status tone-warn">${escape(activity.text)}\u2026</p><p class="muted">Live devices are being changed and measured. This takes a few seconds.</p></div></div>`);
    $('elapsed').textContent = `Started ${clock(activity.startedAt)}`;
    announcement = `${title}. ${activity.text}.`;
  } else if (issue) {
    const failed = (issue.failedJourneys ?? []).map((id) => data.topology?.journeys.find((j) => j.id === id)?.label ?? id);
    const link = issue.incidentId ? `<a class="button primary" href="${escape(investigationUrl(data, issue.incidentId))}" target="_blank" rel="noreferrer">${state.blocked || state.current >= 4 ? 'Review evidence' : 'Follow investigation'} \u2197</a>` : '';
    $('issue-badge').textContent = state.badge;
    $('issue-badge').className = `pill tone-${state.tone}`;
    paint('incident', `<h3>${escape(issue.title)}</h3><p class="muted">${failed.map(escape).join(' \u00b7 ')}</p>${tracker(state)}<p class="incident-status tone-${state.tone}">${escape(state.text)}</p>${link}<a class="proof-link" href="#proof">See what broke, and the before / after proof \u2193</a>`);
    $('elapsed').textContent = issue.status === 'resolved' && issue.resolvedAt ? `Detected ${clock(issue.detectedAt)} \u00b7 recovered in ${duration(issue.resolvedAt - issue.detectedAt)}` : `Detected ${clock(issue.detectedAt)} \u00b7 open for ${duration(Date.now() / 1000 - issue.detectedAt)}`;
    announcement = `${state.badge.toLowerCase()}. ${state.text}`;
  } else {
    $('issue-badge').textContent = 'MONITORING';
    $('issue-badge').className = 'pill tone-ok';
    paint('incident', '<div class="empty-symbol" aria-hidden="true">\u25ce</div><h3>No active service issues</h3><p class="muted">New failures appear here and are picked up automatically by TwinOps.</p>');
    $('elapsed').textContent = '';
  }
  if ($('announce').textContent !== announcement) $('announce').textContent = announcement;
  const faultBlocked = pending || !!activity || !data.ready || data.recoveryRequired || (!!issue && !replaceable(issue));
  document.querySelectorAll('[data-fault]').forEach((b) => { b.disabled = faultBlocked; });
  const [hintTone, hintText] = activity ? ['warn', `${activity.text}\u2026`] : faultHint(data, issue);
  $('fault-hint').textContent = hintText;
  $('fault-hint').className = `fault-hint tone-${hintTone}`;
  const recovering = data.recoveryRequired;
  $('reset').hidden = !issue && !recovering;
  $('reset').textContent = recovering ? 'Operator recovery: restore healthy baseline' : replaceable(issue) ? 'Clear without a new fault' : 'Reset scenario';
  $('reset').disabled = pending || !!activity || !data.ready || issue?.investigationStatus === 'investigating';
  renderHistory(data);
  renderProof(data);
}

const PAGE_SIZE = 5;
let historyPage = 0;
function renderHistory(data) {
  const items = data.history.slice().reverse();
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  historyPage = Math.min(historyPage, pages - 1);
  const first = historyPage * PAGE_SIZE;
  const page = items.slice(first, first + PAGE_SIZE);
  paint('history', page.length ? page.map((i) => {
    const [status, tone] = HISTORY_STATUS[i.status] ?? [i.status, 'muted'];
    const timing = i.resolvedAt ? `recovered in ${duration(i.resolvedAt - i.detectedAt)}` : `detected ${clock(i.detectedAt)}`;
    const affected = i.failedJourneys?.length ?? 0;
    const failed = affected ? `${affected} journey${affected === 1 ? '' : 's'} affected` : '';
    return `<div class="history-row"><div><strong>${escape(i.fault ?? i.title)}</strong><small>${escape(new Date(i.detectedAt * 1000).toLocaleString())} \u00b7 ${escape(timing)}${failed ? ` \u00b7 ${escape(failed)}` : ''}</small></div><span class="tag tone-${tone}">${escape(status)}</span>${i.incidentId ? `<a href="${escape(investigationUrl(data, i.incidentId))}" target="_blank" rel="noreferrer">Evidence \u2197</a>` : '<span></span>'}</div>`;
  }).join('') : 'No completed scenarios yet.');
  $('history-pager').hidden = items.length <= PAGE_SIZE;
  $('history-range').textContent = items.length ? `${first + 1}\u2013${first + page.length} of ${items.length}` : '';
  $('history-newer').disabled = historyPage === 0;
  $('history-older').disabled = historyPage >= pages - 1;
  $('history-total').textContent = items.length ? `${items.length} scenario${items.length === 1 ? '' : 's'} \u00b7 retained across app restarts` : 'Retained across app restarts';
}
$('history-newer').addEventListener('click', () => { historyPage -= 1; if (latest) renderHistory(latest); });
$('history-older').addEventListener('click', () => { historyPage += 1; if (latest) renderHistory(latest); });

const TABS = ['impact', 'devices', 'timeline', 'verify'];
let activeTab = 'impact';
function selectTab(name, focus) {
  activeTab = name;
  for (const t of TABS) {
    const on = t === name;
    $(`tab-${t}`).setAttribute('aria-selected', String(on));
    $(`tab-${t}`).tabIndex = on ? 0 : -1;
    $(`panel-${t}`).hidden = !on;
  }
  if (focus) $(`tab-${name}`).focus();
}
const tablist = document.querySelector('[role="tablist"]');
tablist.addEventListener('click', (event) => {
  const tab = event.target.closest('[role="tab"]');
  if (tab) selectTab(tab.id.slice(4));
});
tablist.addEventListener('keydown', (event) => {
  const index = TABS.indexOf(activeTab);
  const next = {ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: TABS.length - 1}[event.key];
  if (next === undefined) return;
  event.preventDefault();
  selectTab(TABS[(next + TABS.length) % TABS.length], true);
});
async function action(path, body = {}) {
  const resetting = path.endsWith('reset');
  const replacing = !resetting && !!latest?.issue;
  pending = true;
  localActivity = {kind: resetting ? 'reset' : 'fault', text: resetting ? 'Restoring the healthy baseline' : 'Sending the fault to the lab', startedAt: Date.now() / 1000};
  if (latest) render(latest);
  $('action-status').textContent = body.operatorRecovery ? 'Re-pushing the healthy baseline and verifying it with live probes\u2026' : resetting ? 'Restoring the healthy lab\u2026' : replacing ? 'Restoring the healthy baseline, then applying the fault\u2026' : 'Applying fault and measuring service impact\u2026';
  try {
    const response = await fetch(path, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
    let result = null;
    try { result = await response.json(); } catch { /* error pages are not JSON */ }
    if (!response.ok || !result) throw new Error(result?.detail || `The operation failed (HTTP ${response.status}). The lab state is retained; check the Metro Network log.`);
    renderSeq += 1;
    render(result);
    $('action-status').textContent = body.operatorRecovery ? 'Lab recovered and verified healthy. Ready for another scenario.' : resetting ? 'Lab restored. Ready for another scenario.' : `${replacing ? 'Previous scenario moved to Recent issues. ' : ''}Fault applied. TwinOps will detect the incident automatically.`;
  } catch (e) { $('action-status').textContent = e.message; }
  finally { pending = false; if (latest) render(latest); }
}
document.querySelectorAll('[data-fault]').forEach((b) => b.addEventListener('click', () => action('/api/faults', {fault:b.dataset.fault})));
$('reset').addEventListener('click', () => {
  if (!latest?.recoveryRequired) return action('/api/reset');
  if (confirm('Operator recovery re-pushes the healthy baseline to every lab device and verifies it with live probes. The current scenario moves to Recent issues. Continue?')) action('/api/reset', {operatorRecovery: true});
});
$('verify').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-copy]');
  if (!button) return;
  try {
    await navigator.clipboard.writeText($(button.dataset.copy).textContent);
    button.textContent = 'Copied';
  } catch {
    getSelection().selectAllChildren($(button.dataset.copy));
    button.textContent = 'Selected';
  }
  setTimeout(() => { button.textContent = 'Copy'; }, 1800);
});
// A poll that started before an action finished carries older state; rendering it would flicker back.
let renderSeq = 0;
async function poll() {
  const seq = renderSeq;
  try {
    const response = await fetch('/api/dashboard');
    if (!response.ok) throw new Error('Dashboard unavailable');
    const data = await response.json();
    if (seq === renderSeq) render(data);
  } catch {
    $('connection').textContent = 'Connection lost · retrying';
    if (latest) { latest.ready = false; render(latest); }
  }
  setTimeout(poll, 2500);
}
poll();
