'use strict';
// Isolated HTTP smoke test: launches the real server with a temporary DATA_DIR.
// It never reads, writes, or mutates the project's production data directory.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve, reject) => srv.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = srv.address().port;
  await new Promise(resolve => srv.close(resolve));
  return port;
}
async function waitForServer(base, child, getOutput) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Server exited before becoming ready: ' + getOutput());
    try { const r = await fetch(base + '/'); if (r.status === 200) return; } catch {}
    await new Promise(r => setTimeout(r, 120));
  }
  throw new Error('Server did not become ready: ' + getOutput());
}
(async () => {
  const root = path.resolve(__dirname, '..');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kejun-smoke-data-'));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, NODE_ENV: 'test', DATABASE_URL: '', POSTGRES_RUNTIME_COLLECTIONS: '',
      PAYPAL_CLIENT_ID: '', PAYPAL_CLIENT_SECRET: '', TRANSLATION_API_URL: '', TRANSLATION_API_KEY: '', TRANSLATION_MODEL: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', x => { output += x.toString(); });
  child.stderr.on('data', x => { output += x.toString(); });
  const base = `http://127.0.0.1:${port}`;
  const checked = [];
  try {
    await waitForServer(base, child, () => output);
    const health = await fetch(base + '/healthz');
    assert.equal(health.status, 200, 'health endpoint should return 200');
    assert.equal(health.headers.get('cache-control'), 'no-store', 'health endpoint should not be cached');
    assert.deepEqual(await health.json(), { ok: true }, 'health endpoint should expose only minimal status');
    checked.push('health endpoint');
    const pages = ['/', '/index.html', '/products.html', '/product.html', '/cart.html', '/checkout.html', '/account.html', '/quote-request.html', '/quote-view.html', '/contact.html', '/admin.html'];
    for (const p of pages) {
      const r = await fetch(base + p);
      assert.equal(r.status, 200, `${p} should return 200`);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff', `${p} should set nosniff`);
      assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN', `${p} should prevent cross-origin framing while allowing admin preview`);
      assert.equal(r.headers.get('referrer-policy'), 'strict-origin-when-cross-origin', `${p} should set a referrer policy`);
      const text = await r.text();
      assert.ok(text.length > 100, `${p} should not be empty`);
      checked.push('page ' + p);
    }
    // Exercise every supported storefront language through the real HTTP server.
    // This checks route stability, not translation quality or completeness.
    const languages = ['en', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'ar', 'ko', 'ja'];
    for (const lang of languages) {
      const r = await fetch(base + '/index.html?lang=' + lang);
      assert.equal(r.status, 200, `storefront language ${lang} should load`);
      assert.match(r.headers.get('content-type') || '', /text\/html/i, `language ${lang} must return HTML`);
      assert.ok((await r.text()).length > 100, `language ${lang} must not be empty`);
      checked.push('storefront route ' + lang);
    }
    for (const p of ['/server.js', '/package.json', '/.env', '/data/products.json']) {
      const r = await fetch(base + p);
      assert.equal(r.status, 404, `private file ${p} must not be exposed`);
      checked.push('private path blocked ' + p);
    }
    for (const p of ['/api/products', '/api/categories', '/api/settings']) {
      const r = await fetch(base + p);
      assert.equal(r.status, 200, `${p} should be public and return 200`);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff', `${p} should set nosniff`);
      assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN', `${p} should prevent cross-origin framing while allowing admin preview`);
      const payload = await r.json();
      if (p !== '/api/settings') assert.ok(Array.isArray(payload), `${p} should return an array`);
      else assert.equal(typeof payload, 'object');
      checked.push('public API ' + p);
    }
    for (const p of ['/api/admin/translation-provider-check', '/api/admin/translation-drafts', '/api/email-outbox']) {
      const r = await fetch(base + p, { method: p.endsWith('translation-provider-check') || p.endsWith('translation-drafts') ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: p.endsWith('translation-provider-check') || p.endsWith('translation-drafts') ? '{}' : undefined });
      assert.equal(r.status, 401, `${p} must require admin session`);
      checked.push('admin auth gate ' + p);
    }
    const inquiryResponse = await fetch(base + '/api/inquiries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      name: 'QA Buyer', email: 'qa@example.com', company: 'QA Company', type: 'Cart Order Request',
      createdFrom: 'website-checkout', sourceUrl: 'https://example.test/checkout.html', category: 'Pressure Transmitter',
      model: 'PT-TEST', productId: 'test-product', productName: 'Test Product', quantity: 4,
      orderNotes: 'Please quote this configuration.', items: [{ id: 'test-product', skuId: 'sku-rs485', skuName: 'RS485 / G1/2', model: 'PT-TEST', qty: 2, unitPrice: 32, currency: 'USD' }]
    }) });
    assert.equal(inquiryResponse.status, 201, 'valid inquiry should be accepted');
    const savedInquiries = JSON.parse(fs.readFileSync(path.join(dataDir, 'inquiries.json'), 'utf8'));
    assert.equal(savedInquiries[0].source, 'website-checkout', 'inquiry source should be preserved');
    assert.equal(savedInquiries[0].sourceUrl, 'https://example.test/checkout.html', 'inquiry source URL should be preserved');
    assert.equal(savedInquiries[0].items[0].skuId, 'sku-rs485', 'SKU selection should be preserved');
    assert.equal(savedInquiries[0].items[0].unitPrice, 32, 'selected price should be preserved for inquiry context');
    assert.equal(savedInquiries[0].quantity, 4, 'requested quantity should be preserved');
    checked.push('inquiry source/product/SKU/quantity persistence');
    const bad = await fetch(base + '/data-seed/products.json');
    assert.equal(bad.status, 404, 'seed data must not be served publicly');
    const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    assert.ok(serverSource.includes("p==='/api/admin/translation-drafts'"), 'translation draft endpoint should be wired');
    assert.ok(serverSource.includes("p==='/api/admin/translation-provider-check'"), 'provider check endpoint should be wired');
    checked.push('sensitive seed data blocked', 'translation endpoint wiring', 'baseline security headers on public pages and APIs');
    process.stdout.write(`PASS: isolated HTTP smoke test (${checked.length} checks)\n${checked.map(x => ' - ' + x).join('\n')}\n`);
  } catch (e) {
    process.stderr.write('FAIL: isolated HTTP smoke test: ' + (e.stack || e.message) + '\nServer output:\n' + output + '\n');
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => { if (child.exitCode !== null) resolve(); else { const t = setTimeout(resolve, 1500); child.once('exit', () => { clearTimeout(t); resolve(); }); } });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(e => { process.stderr.write(String(e.stack || e)); process.exitCode = 1; });
