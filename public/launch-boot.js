// Redeems the one-time launch link (#launch=<nonce>) as soon as the page opens. The nonce expires
// 60 s after the launcher asks for it (src/http/security.ts), and app.js is a module that waits for its
// whole import graph: on a slow load (WSL2 forwarding, a VM) that took longer than the nonce lives.
// A classic script loaded first in <head>, since the CSP forbids inline scripts. It leaves the
// token's promise on window.miradorLaunch for signIn() in public/core.js, and drops the nonce from
// the address bar so a reload or the history never shows it.
(() => {
  const nonce = new URLSearchParams(location.hash.slice(1)).get('launch');
  if (!nonce) return;
  history.replaceState(null, '', '/');
  window.miradorLaunch = fetch('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nonce }),
    priority: 'high',
  })
    .then((response) => (response.ok ? response.json() : null))
    .then((body) => (body && typeof body.token === 'string' ? body.token : null))
    .catch(() => null);
})();
