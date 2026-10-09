import type { ProofPack } from '../engine/orchestrator.ts';

const esc = (value: unknown) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Self-contained, printable Proof Pack. Every interpolated value is escaped. */
export function proofPackHtml(pack: ProofPack): string {
  const rows = pack.experiments
    .map(
      (e) => `<tr><td>${esc(e.label)}</td><td>${esc(e.origin)}</td><td>${e.restored ? 'yes' : 'no'}</td><td>${esc(e.decision)}</td><td><code>${esc(e.change_hash.slice(0, 12))}</code></td><td>${Object.entries(e.gates)
        .map(([g, v]) => `<div><b>${esc(g)}</b> ${esc(v)}</div>`)
        .join('')}</td></tr>`,
    )
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>TwinOps Proof Pack ${esc(pack.incident_id)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;margin:32px;color:#0b1020}h1{margin:0 0 4px}code,pre{font-family:ui-monospace,monospace;font-size:12px}
.v{display:inline-block;padding:4px 10px;border:2px solid #0b1020;border-radius:6px;font-weight:700;letter-spacing:.04em}
table{border-collapse:collapse;width:100%;margin:12px 0}td,th{border:1px solid #ccd;padding:6px;vertical-align:top;text-align:left}
.note{background:#fff7e0;border-left:4px solid #946000;padding:8px 12px}section{margin:20px 0}</style></head><body>
<h1>TwinOps Proof Pack</h1><p>${esc(pack.incident_id)} · generated ${esc(pack.generated_at)} · seed ${esc(pack.seed)}</p>
<p class="v">${esc(pack.verdict)}</p><p class="note">${esc(pack.scope_note)}</p>
<section><h2>Mode and versions</h2><p>${esc(pack.mode)}</p><pre>${esc(JSON.stringify(pack.versions, null, 2))}</pre><p>Captured state hash <code>${esc(pack.captured_state_hash)}</code></p></section>
<section><h2>Observation</h2><pre>${esc(JSON.stringify(pack.observation, null, 2))}</pre></section>
<section><h2>Hypotheses</h2><ol>${pack.hypotheses.map((h) => `<li>${esc(h.title)} — supporting: ${esc(h.supporting.join(', '))}; contradicting: ${esc(h.contradicting.join(', ') || 'none')}</li>`).join('')}</ol></section>
<section><h2>Reproduction</h2><pre>${esc(JSON.stringify(pack.reproduction, null, 2))}</pre></section>
<section><h2>Experiments</h2><table><thead><tr><th>Candidate</th><th>Origin</th><th>Restored</th><th>Decision</th><th>Hash</th><th>Gates</th></tr></thead><tbody>${rows}</tbody></table></section>
<section><h2>Selected change</h2><pre>${esc(JSON.stringify(pack.selected, null, 2))}</pre></section>
<section><h2>Approval and apply</h2><pre>${esc(JSON.stringify({ approval: pack.approval, apply: pack.apply, production_writes_during_diagnosis: pack.production_writes_during_diagnosis }, null, 2))}</pre></section>
<section><h2>Untested conditions</h2><ul>${pack.untested_conditions.map((u) => `<li>${esc(u)}</li>`).join('')}</ul></section>
</body></html>`;
}

export function download(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
