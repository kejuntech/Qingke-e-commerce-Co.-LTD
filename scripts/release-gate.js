'use strict';
// Strict pre-release gate. Read-only; never prints secret values or calls external services.
const fs = require('node:fs');
const path = require('node:path');
const env = process.env;
const root = path.resolve(__dirname, '..');
const errors = [], warnings = [], passed = [];
const has = k => String(env[k] || '').trim().length > 0;
const add = (arr, message) => arr.push(message);
const requiredCollections = [
  'products.json','categories.json','settings.json','customers.json','customer-sessions.json',
  'quotes.json','bank-transfers.json','payments.json','inquiries.json','crm.json',
  'admin-sessions.json','email-outbox.json'
];

if (env.NODE_ENV !== 'production') add(errors, 'NODE_ENV must be production for a release candidate.');
else add(passed, 'NODE_ENV is production.');
if (!has('PUBLIC_BASE_URL') || !/^https:\/\/[^/]+/i.test(String(env.PUBLIC_BASE_URL).trim())) add(errors, 'PUBLIC_BASE_URL must be a valid HTTPS base URL.');
else add(passed, 'PUBLIC_BASE_URL uses HTTPS.');

if (!has('DATABASE_URL')) add(errors, 'DATABASE_URL is missing; production data would rely on local JSON storage.');
else add(passed, 'DATABASE_URL is configured (connection and schema are not tested by this read-only gate).');
const configuredCollections = new Set(String(env.POSTGRES_RUNTIME_COLLECTIONS || '').split(',').map(s => s.trim()).filter(Boolean));
const missingCollections = requiredCollections.filter(name => !configuredCollections.has(name));
if (!configuredCollections.size) add(errors, 'POSTGRES_RUNTIME_COLLECTIONS is empty; PostgreSQL runtime persistence is not enabled.');
else if (missingCollections.length) add(errors, `POSTGRES_RUNTIME_COLLECTIONS is missing required collections: ${missingCollections.join(', ')}.`);
else add(passed, `All ${requiredCollections.length} critical collections are selected for PostgreSQL runtime.`);

// auth.json is a file in DATA_DIR even when all listed collections are in PostgreSQL.
// A brand new public instance must require a one-time bootstrap secret.
const adminAuthPath = path.join(path.resolve(env.DATA_DIR || path.join(root,'data')), 'auth.json');
if (!fs.existsSync(adminAuthPath)) {
  if (String(env.ADMIN_SETUP_TOKEN || '').length < 24) add(errors,'Uninitialized production admin requires ADMIN_SETUP_TOKEN (at least 24 characters).');
  else add(warnings,'Production admin initialization still required. Rotate/remove ADMIN_SETUP_TOKEN after setup.');
} else add(passed,'Administrator auth.json exists (verify disk persistence and backup separately).');
const smtp = ['SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_PASS','SMTP_FROM','SMTP_ADMIN_EMAIL'];
const missingSmtp = smtp.filter(k => !has(k));
if (missingSmtp.length) add(errors, `SMTP configuration is incomplete; missing: ${missingSmtp.join(', ')}.`);
else add(passed, 'SMTP variables are present (values hidden; delivery still requires a live test).');

const paypalMode = String(env.PAYPAL_MODE || 'sandbox').toLowerCase();
if (!['live','production'].includes(paypalMode)) add(errors, 'PAYPAL_MODE is not live; real customer payments are not enabled. Use sandbox only for staging.');
if (!has('PAYPAL_CLIENT_ID') || !has('PAYPAL_CLIENT_SECRET')) add(errors, 'PayPal live credentials are incomplete.');
if (['live','production'].includes(paypalMode) && has('PAYPAL_CLIENT_ID') && has('PAYPAL_CLIENT_SECRET')) add(passed, 'PayPal live mode and credential variables are present (transaction not tested).');

const translationVars = ['TRANSLATION_API_URL','TRANSLATION_API_KEY','TRANSLATION_MODEL'];
const missingTranslation = translationVars.filter(k => !has(k));
if (missingTranslation.length) add(errors, `Automatic translation is not fully configured; missing: ${missingTranslation.join(', ')}.`);
else if (!/^https:\/\//i.test(String(env.TRANSLATION_API_URL))) add(errors, 'TRANSLATION_API_URL must use HTTPS.');
else add(passed, 'Translation API variables are present (provider compatibility and translations not tested).');

if (!has('KEJUN_BACKUP_PASSPHRASE') || String(env.KEJUN_BACKUP_PASSPHRASE).length < 16) add(errors, 'KEJUN_BACKUP_PASSPHRASE must be configured with at least 16 characters for encrypted backups.');
else add(passed, 'Encrypted-backup passphrase is present (value hidden).');

const dataDir = path.resolve(env.DATA_DIR || path.join(root, 'data'));
if (!fs.existsSync(dataDir)) add(warnings, `DATA_DIR does not exist locally (${dataDir}); confirm production data initialization and storage mount.`);
else add(passed, 'Configured DATA_DIR exists locally; this does not prove production disk persistence.');
add(warnings, 'Verify a persistent disk/object-storage arrangement for product uploads and remittance proofs; this script cannot confirm provider-side persistence.');
add(warnings, 'This gate does not contact PostgreSQL, PayPal, SMTP, or the translation provider. Complete live integration tests before opening checkout.');

console.log('Qingke V18 strict release gate (read-only; no network calls; secrets are never printed)');
console.log('\nPASS');
for (const item of passed) console.log(`  [OK] ${item}`);
console.log('\nWARNINGS');
for (const item of warnings) console.log(`  [WARN] ${item}`);
console.log('\nBLOCKERS');
if (!errors.length) console.log('  None');
for (const item of errors) console.log(`  [BLOCK] ${item}`);
console.log(`\nSummary: ${passed.length} passed, ${warnings.length} warning(s), ${errors.length} blocker(s).`);
if (errors.length) process.exitCode = 1;
