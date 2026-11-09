'use strict';
// Read-only deployment readiness check. Does not connect to external services or modify data.
const fs = require('node:fs');
const path = require('node:path');
const env = process.env;
const root = path.resolve(__dirname, '..');
const errors = [], warnings = [], ok = [];
const yes = (condition, message) => (condition ? ok : warnings).push(message);
const required = (name) => !!String(env[name] || '').trim();
const dataDir = path.resolve(env.DATA_DIR || path.join(root, 'data'));
const dbCollections = String(env.POSTGRES_RUNTIME_COLLECTIONS || '').split(',').map(x => x.trim()).filter(Boolean);
const smtpVars = ['SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_PASS','SMTP_FROM','SMTP_ADMIN_EMAIL'];
const smtpCount = smtpVars.filter(required).length;
const paypalMode = String(env.PAYPAL_MODE || 'sandbox').toLowerCase();
const baseUrl = String(env.PUBLIC_BASE_URL || '').trim();

if (!required('PUBLIC_BASE_URL')) warnings.push('PUBLIC_BASE_URL is not configured; quote links and absolute URLs may be incorrect.');
else if (!/^https:\/\/[^/]+/i.test(baseUrl)) errors.push('PUBLIC_BASE_URL must be an HTTPS URL in production.');
else ok.push('PUBLIC_BASE_URL is HTTPS.');

if (env.NODE_ENV !== 'production') warnings.push('NODE_ENV is not production; verify Render service environment before launch.');
else ok.push('NODE_ENV=production.');

if (smtpCount === 0) warnings.push('SMTP is not configured; email notifications will not be delivered.');
else if (smtpCount !== smtpVars.length) errors.push(`SMTP configuration is incomplete (${smtpCount}/${smtpVars.length} variables present).`);
else if (!['465','587','25','2525'].includes(String(env.SMTP_PORT))) warnings.push('SMTP_PORT is unusual; confirm it with your email provider.');
else ok.push('SMTP environment variables are present (credentials are not displayed).');

if (paypalMode === 'live' || paypalMode === 'production') {
  if (!required('PAYPAL_CLIENT_ID') || !required('PAYPAL_CLIENT_SECRET')) errors.push('PayPal live mode is selected but credentials are missing.');
  else warnings.push('PayPal live mode is configured; a real low-value transaction and refund/reconciliation procedure still need manual verification.');
} else {
  warnings.push('PayPal is not in live mode; live checkout will not collect real customer payments.');
}
if (!required('DATABASE_URL')) {
  warnings.push('DATABASE_URL is absent; JSON storage is active. On ephemeral hosting disks, changes may be lost after restart/redeploy.');
} else if (!dbCollections.length) {
  warnings.push('DATABASE_URL is present but POSTGRES_RUNTIME_COLLECTIONS is empty; PostgreSQL runtime collections are not enabled.');
} else {
  ok.push(`PostgreSQL runtime selected collections: ${dbCollections.join(', ')} (existence/data parity not checked).`);
}
if (!fs.existsSync(dataDir)) warnings.push(`DATA_DIR does not exist at ${dataDir}; confirm startup initializes data or set DATA_DIR.`);
else ok.push('Configured data directory exists.');
for (const f of ['products.json','categories.json','settings.json']) {
  const p = path.join(dataDir, f);
  if (!fs.existsSync(p)) warnings.push(`Core data file missing: ${f}.`);
  else {
    try { const parsed = JSON.parse(fs.readFileSync(p, 'utf8')); if (f === 'settings.json' ? (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) : !Array.isArray(parsed)) errors.push(`${f} has an unexpected JSON shape.`);
      else ok.push(`${f} parses and has expected top-level shape.`);
    } catch { errors.push(`${f} is invalid JSON.`); }
  }
}
// Administrator credentials are deliberately stored outside PostgreSQL in DATA_DIR.
// A fresh production instance must not offer unauthenticated password setup.
const adminAuthPath = path.join(dataDir, 'auth.json');
if (!fs.existsSync(adminAuthPath)) {
  if (String(env.ADMIN_SETUP_TOKEN || '').length < 24) errors.push('Admin has not been initialized: configure a 24+ character ADMIN_SETUP_TOKEN before first production setup.');
  else warnings.push('Admin initialization is pending. The one-time ADMIN_SETUP_TOKEN is configured; rotate/remove it after setup.');
} else {
  ok.push('Administrator credential file exists (persistent disk and backup are still unverified).');
}
if (required('SMTP_PASS') && /^(your_|change_me|example)/i.test(env.SMTP_PASS)) warnings.push('SMTP_PASS resembles a placeholder; replace it in the hosting secret store.');
if (required('PAYPAL_CLIENT_SECRET') && /^(your_|change_me|example)/i.test(env.PAYPAL_CLIENT_SECRET)) warnings.push('PAYPAL_CLIENT_SECRET resembles a placeholder; replace it in the hosting secret store.');

console.log('Qingke V18 production preflight (read-only; no network calls)');
console.log('\nPASS');
for (const x of ok) console.log(`  [OK] ${x}`);
console.log('\nWARNINGS');
if (!warnings.length) console.log('  None');
for (const x of warnings) console.log(`  [WARN] ${x}`);
console.log('\nERRORS');
if (!errors.length) console.log('  None');
for (const x of errors) console.log(`  [ERROR] ${x}`);
console.log(`\nSummary: ${ok.length} passed, ${warnings.length} warning(s), ${errors.length} error(s).`);
if (errors.length) process.exitCode = 1;
