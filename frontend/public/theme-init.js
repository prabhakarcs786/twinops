// Applies the saved theme before first paint. External file so the page works under `script-src 'self'`.
try {
  var t = localStorage.getItem('twinops-theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch (e) {
  /* storage unavailable */
}
