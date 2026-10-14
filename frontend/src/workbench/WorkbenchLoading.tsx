/** Reserve the dashboard layout without inventing a network or incident state. */
export function WorkbenchLoading({ incident = false }: { incident?: boolean }) {
  return <section className="wb-loading" aria-label="Loading workspace">
    <p className="workspace-loading-status" role="status">{incident ? 'Loading incident evidence…' : 'Loading workbench…'}</p>
    <div className="wb-loading-content" aria-hidden="true">
      <div className="loading-pipeline">{Array.from({ length: 8 }, (_, i) => <span className="loading-line" key={i} />)}</div>
      <div className="loading-counters">{Array.from({ length: 5 }, (_, i) => <div className="loading-counter" key={i}><span className="loading-line" /><span className="loading-line short" /></div>)}</div>
      <div className="loading-panels">{['Network', 'Isolated twin', 'Workspace'].map((label) => <div className="loading-panel" key={label}>
        <span className="stage-kicker">{label}</span><span className="loading-line" /><div className="loading-canvas" /><span className="loading-line short" />
      </div>)}</div>
    </div>
  </section>;
}
