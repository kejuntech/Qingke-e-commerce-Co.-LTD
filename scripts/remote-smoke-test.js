'use strict';
// Read-only post-deploy smoke test. Never logs response bodies, cookies, or secrets.
const assert = require('node:assert/strict');
const { URL } = require('node:url');

function parseBase(raw) {
  if (!raw) throw new Error('Set SMOKE_BASE_URL to the deployed site URL, for example https://your-site.onrender.com');
  let u;
  try { u = new URL(raw); } catch { throw new Error('SMOKE_BASE_URL must be a valid absolute URL'); }
  if (u.username || u.password || u.search || u.hash) throw new Error('SMOKE_BASE_URL must not contain credentials, query parameters, or a fragment');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new Error('SMOKE_BASE_URL must use HTTPS (HTTP is allowed only for localhost tests)');
  u.pathname = u.pathname.replace(/\/+$/, '');
  return u.toString().replace(/\/$/, '');
}

async function request(base, pathname, options = {}) {
  const controller = new AbortController();
  const configuredTimeout = Number(process.env.SMOKE_REQUEST_TIMEOUT_MS || 20000);
  const timeoutMs = Number.isFinite(configuredTimeout) ? Math.min(60000, Math.max(5000, configuredTimeout)) : 20000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(base + pathname, { ...options, redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': 'KEJUN-PostDeploy-SmokeTest/1.0', ...(options.headers || {}) } });
  } finally { clearTimeout(timer); }
}

(async () => {
  const base = parseBase(process.env.SMOKE_BASE_URL);
  const checked = [];
  const health = await request(base, '/healthz');
  assert.equal(health.status, 200, `Health endpoint expected HTTP 200, got ${health.status}`);
  assert.equal(health.headers.get('cache-control'), 'no-store', 'Health endpoint should not be cached');
  const healthBody = await health.json();
  assert.deepEqual(healthBody, { ok: true }, 'Health endpoint should expose only a minimal liveness status');
  checked.push('health endpoint');
  const pages = ['/', '/index.html', '/products.html', '/product.html', '/cart.html', '/checkout.html', '/account.html', '/quote-request.html', '/quote-view.html', '/contact.html', '/admin.html'];
  for (const p of pages) {
    const r = await request(base, p);
    assert.equal(r.status, 200, `Page ${p} expected HTTP 200, got ${r.status}`);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', `${p} missing X-Content-Type-Options`);
    assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN', `${p} missing X-Frame-Options`);
    const body = await r.text();
    assert.ok(body.length > 100, `${p} returned an unexpectedly small body`);
    checked.push(`page ${p}`);
  }
  for (const p of ['/api/products', '/api/categories', '/api/settings']) {
    const r = await request(base, p);
    assert.equal(r.status, 200, `Public API ${p} expected HTTP 200, got ${r.status}`);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', `${p} missing security header`);
    const body = await r.json();
    if (p !== '/api/settings') assert.ok(Array.isArray(body), `${p} should return a JSON array`);
    else assert.ok(body && typeof body === 'object' && !Array.isArray(body), `${p} should return a JSON object`);
    checked.push(`public API ${p}`);
  }
  const gated = [
    { path: '/api/admin/translation-provider-check', method: 'POST' },
    { path: '/api/admin/translation-drafts', method: 'POST' },
    { path: '/api/email-outbox', method: 'GET' }
  ];
  for (const item of gated) {
    const r = await request(base, item.path, { method: item.method, headers: { 'Content-Type': 'application/json' }, body: item.method === 'POST' ? '{}' : undefined });
    assert.equal(r.status, 401, `${item.path} must reject unauthenticated access with HTTP 401; got ${r.status}`);
    checked.push(`auth gate ${item.path}`);
  }
  const seed = await request(base, '/data-seed/products.json');
  assert.equal(seed.status, 404, 'Seed data path must not be publicly accessible');
  checked.push('seed data not public');
  process.stdout.write(`PASS: post-deploy read-only smoke test (${checked.length} checks) for ${new URL(base).origin}\n${checked.map(x => ' - ' + x).join('\n')}\n`);
})().catch(err => {
  const msg = err && err.name === 'AbortError' ? 'Request timed out; increase SMOKE_REQUEST_TIMEOUT_MS (allowed 5000–60000 ms) if the host is waking from sleep' : (err && err.message ? err.message : 'Unknown smoke-test failure');
  process.stderr.write(`FAIL: post-deploy smoke test: ${msg}\n`);
  process.exitCode = 1;
});
