'use strict';
// Read-only local repository hygiene audit. It never prints secret values.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const findings = { errors: [], warnings: [], passed: [] };
const ignoredDirs = new Set(['node_modules', '.git', '.render', 'coverage']);
const sensitiveDataNames = new Set([
  'auth.json', 'customers.json', 'customer-sessions.json', 'admin-sessions.json',
  'orders.json', 'bank-transfers.json', 'payments.json', 'inquiries.json',
  'quotes.json', 'email-outbox.json', 'remittances.json'
]);
const secretPatterns = [
  { name: 'private key material', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: 'likely API secret assignment', re: /(?:PAYPAL_CLIENT_SECRET|SMTP_PASS|DATABASE_URL|API_SECRET)\s*[:=]\s*["']?(?!\$\{|process\.env|your_|change_me|example)[A-Za-z0-9_./:+-]{12,}/i },
  { name: 'AWS access key identifier', re: /\bAKIA[0-9A-Z]{16}\b/ }
];
function walk(dir, rel = '') {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { findings.warnings.push(`Cannot read directory: ${rel || '.'}`); return; }
  for (const ent of entries) {
    if (ignoredDirs.has(ent.name)) continue;
    const abs = path.join(dir, ent.name), r = path.posix.join(rel, ent.name);
    if (ent.isDirectory()) { if (ent.name === 'backups') findings.warnings.push(`Local backup directory exists and must not be committed: ${r}`); walk(abs, r); continue; }
    if (!ent.isFile()) continue;
    if (/^\.env(?:\..+)?$/.test(ent.name) && ent.name !== '.env.example') findings.errors.push(`Environment/secret file found in project tree: ${r}`);
    if (r.startsWith('data/') && sensitiveDataNames.has(ent.name)) findings.warnings.push(`Runtime/customer-sensitive data file is present in project tree: ${r}; ensure it is not tracked or published.`);
    if (/(?:backup|dump|snapshot).+\.(?:zip|tgz|tar|gz|enc)$/i.test(ent.name)) findings.warnings.push(`Backup artifact found in project tree: ${r}; keep it outside source control.`);
    if (ent.size > 2 * 1024 * 1024) continue;
    const ext = path.extname(ent.name).toLowerCase();
    if (!['.js','.json','.md','.yml','.yaml','.txt','.env','.example','.html','.css'].includes(ext) && !ent.name.startsWith('.env')) continue;
    if (ent.name === '.env.example' || /^test_.*\.js$/i.test(ent.name) || /^test-.*\.js$/i.test(ent.name) || r.startsWith('scripts/test_')) continue;
    let content;
    try { content = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    for (const p of secretPatterns) if (p.re.test(content)) findings.errors.push(`Possible ${p.name} found in ${r}; value intentionally suppressed.`);
  }
}
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error(`Audit root is not a directory: ${root}`); process.exit(2);
}
walk(root);
// A .gitignore rule does not untrack a file already committed. Check the index
// when this script is run inside a real Git worktree; never modify the index.
const gitDir = path.join(root, '.git');
if (fs.existsSync(gitDir)) {
  const git = spawnSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'buffer' });
  if (git.status !== 0) {
    findings.warnings.push('Git metadata exists but `git ls-files` failed; tracked-file safety could not be verified.');
  } else {
    const tracked = git.stdout.toString('utf8').split('\0').filter(Boolean);
    const trackedSensitive = tracked.filter(r => {
      const base = path.posix.basename(r);
      return (/^\.env(?:\..+)?$/.test(base) && base !== '.env.example') ||
        (r.startsWith('data/') && sensitiveDataNames.has(base)) ||
        r.startsWith('backups/') || r.startsWith('assets/uploads/') ||
        /(?:backup|dump|snapshot).+\.(?:zip|tgz|tar|gz|enc)$/i.test(base);
    });
    if (trackedSensitive.length) {
      for (const r of trackedSensitive) findings.errors.push(`Sensitive/runtime/backup file is already tracked by Git: ${r}; remove it from the index and review repository history. File contents are not printed.`);
    } else {
      findings.passed.push('Git index contains no detected environment, runtime-sensitive data, upload, or backup files.');
    }
  }
} else {
  findings.warnings.push('No .git metadata found; tracked-file status cannot be verified from this folder/ZIP. Run the audit inside the actual Git working copy.');
}
const gitignorePath = path.join(root, '.gitignore');
if (!fs.existsSync(gitignorePath)) findings.errors.push('.gitignore is missing.');
else {
  const gi = fs.readFileSync(gitignorePath, 'utf8');
  for (const expected of ['.env', 'backups/', 'assets/uploads/']) {
    if (gi.split(/\r?\n/).some(line => line.trim() === expected)) findings.passed.push(`.gitignore contains ${expected}`);
    else findings.warnings.push(`Consider adding ${expected} to .gitignore.`);
  }
}
console.log('Qingke repository safety audit (read-only; secret values are never printed)');
console.log(`Root: ${root}`);
console.log('\nPASS');
for (const x of findings.passed) console.log(`  [OK] ${x}`);
console.log('\nWARNINGS');
if (!findings.warnings.length) console.log('  None');
for (const x of findings.warnings) console.log(`  [WARN] ${x}`);
console.log('\nERRORS');
if (!findings.errors.length) console.log('  None');
for (const x of findings.errors) console.log(`  [ERROR] ${x}`);
console.log(`\nSummary: ${findings.passed.length} passed, ${findings.warnings.length} warning(s), ${findings.errors.length} error(s).`);
if (findings.errors.length) process.exitCode = 1;
