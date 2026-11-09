'use strict';
// Read-only release acceptance probe. Network checks run only with --live.
// Never prints credential values, sends email, creates orders, or captures payments.
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const live = process.argv.includes('--live');
const env = process.env;
const root = path.resolve(__dirname, '..');
const results = [];
const add = (area, status, message) => results.push({ area, status, message });
const has = key => String(env[key] || '').trim().length > 0;
const selected = String(env.POSTGRES_RUNTIME_COLLECTIONS || '').split(',').map(s => s.trim()).filter(Boolean);
const requiredCollections = ['products','categories','settings','customers','customer-sessions','quotes','bank-transfers','payments','inquiries','crm','admin-sessions','email-outbox'];
const missingCollections = requiredCollections.filter(x => !selected.includes(x));

async function checkPostgres() {
  if (!has('DATABASE_URL')) { add('2. PostgreSQL', 'BLOCKED', 'DATABASE_URL 未配置，生产持久化无法验证。'); return; }
  if (missingCollections.length) { add('2. PostgreSQL', 'BLOCKED', `POSTGRES_RUNTIME_COLLECTIONS 缺少：${missingCollections.join(', ')}。`); return; }
  if (!live) { add('2. PostgreSQL', 'CONFIGURED', '数据库与关键集合已配置；尚未建立真实连接。运行 --live 才会检查。'); return; }
  let client;
  try {
    const { Client } = require('pg');
    client = new Client({ connectionString: env.DATABASE_URL, ssl: env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }, connectionTimeoutMillis: 8000 });
    await client.connect();
    const ping = await client.query('SELECT 1 AS ok');
    if (ping.rows?.[0]?.ok !== 1) throw new Error('SELECT 1 returned unexpected result');
    const table = await client.query("SELECT to_regclass('public.kejun_json_records') AS name");
    if (!table.rows?.[0]?.name) throw new Error('kejun_json_records table is missing; apply migration before runtime cutover');
    const found = await client.query('SELECT DISTINCT collection FROM kejun_json_records');
    const existing = new Set(found.rows.map(r => r.collection));
    const absent = requiredCollections.filter(c => !existing.has(c));
    if (absent.length) add('2. PostgreSQL', 'WARN', `数据库可连接，但没有记录的集合：${absent.join(', ')}。空集合也可能是合法状态，请与迁移清单核对。`);
    else add('2. PostgreSQL', 'PASS', '真实连接、SELECT 1、运行时表和关键集合记录均可见；尚未证明数据完全一致，需单独执行快照校验。');
  } catch (e) { add('2. PostgreSQL', 'FAIL', `数据库真实连接/结构检查失败：${safeError(e)}`); }
  finally { if (client) await client.end().catch(() => {}); }
}
function safeError(e) {
  // Strip URL-like credentials and never print the error object/connection string.
  return String(e?.message || 'unknown error').replace(/(postgres(?:ql)?:\/\/)[^\s@]+@/ig, '$1[redacted]@').slice(0, 220);
}
async function checkSmtp() {
  const keys = ['SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_PASS','SMTP_FROM','SMTP_ADMIN_EMAIL'];
  const missing = keys.filter(k => !has(k));
  if (missing.length) { add('3. SMTP 邮件', 'BLOCKED', `缺少环境变量：${missing.join(', ')}。`); return; }
  if (!live) { add('3. SMTP 邮件', 'CONFIGURED', '配置项齐全；尚未验证 SMTP 握手。运行 --live 才会检查。'); return; }
  let transporter;
  try {
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({ host: env.SMTP_HOST, port: Number(env.SMTP_PORT || 587), secure: String(env.SMTP_SECURE || 'false').toLowerCase() === 'true', auth: { user: env.SMTP_USER, pass: env.SMTP_PASS }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000 });
    await transporter.verify();
    add('3. SMTP 邮件', 'PASS', 'SMTP 服务器验证成功；未发送邮件，实际送达仍需收件箱测试。');
  } catch (e) { add('3. SMTP 邮件', 'FAIL', `SMTP 验证失败：${safeError(e)}`); }
  finally { if (transporter) transporter.close(); }
}
async function checkPayPal() {
  if (!has('PAYPAL_CLIENT_ID') || !has('PAYPAL_CLIENT_SECRET')) { add('3. PayPal', 'BLOCKED', 'PayPal 客户端凭证未配置；未进行真实交易。'); return; }
  const mode = String(env.PAYPAL_MODE || 'sandbox').toLowerCase();
  const base = ['live','production'].includes(mode) ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  if (!live) { add('3. PayPal', 'CONFIGURED', `已配置 ${['live','production'].includes(mode) ? 'LIVE' : 'SANDBOX'} 凭证；尚未请求 OAuth token。运行 --live 才会检查。`); return; }
  try {
    const response = await fetch(base + '/v1/oauth2/token', { method: 'POST', redirect: 'error', headers: { Authorization: 'Basic ' + Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials', signal: AbortSignal.timeout(15000) });
    if (!response.ok) { await response.text().catch(() => ''); throw new Error(`PayPal OAuth returned HTTP ${response.status}`); }
    const body = await response.json();
    if (!body.access_token) throw new Error('PayPal OAuth response did not include access token');
    add('3. PayPal', 'PASS', `PayPal ${['live','production'].includes(mode) ? 'LIVE' : 'SANDBOX'} OAuth 成功；未创建订单、未扣款。`);
  } catch (e) { add('3. PayPal', 'FAIL', `PayPal OAuth 验证失败：${safeError(e)}`); }
}
async function checkTranslation() {
  const keys = ['TRANSLATION_API_URL','TRANSLATION_API_KEY','TRANSLATION_MODEL'];
  const missing = keys.filter(k => !has(k));
  if (missing.length) { add('4. 多语言自动翻译', 'BLOCKED', `缺少环境变量：${missing.join(', ')}。`); return; }
  let u;
  try { u = new URL(env.TRANSLATION_API_URL); } catch { add('4. 多语言自动翻译', 'FAIL', 'TRANSLATION_API_URL 不是有效 URL。'); return; }
  if (u.protocol !== 'https:' || u.username || u.password) { add('4. 多语言自动翻译', 'FAIL', '翻译接口必须使用 HTTPS，且 URL 不能包含用户凭证。'); return; }
  if (!live) { add('4. 多语言自动翻译', 'CONFIGURED', '配置项与 HTTPS 校验通过；尚未调用服务商。运行 --live 才会发送固定测试文本。'); return; }
  try {
    const { generateTranslationDrafts } = require('../lib/translation-service');
    const result = await generateTranslationDrafts({ name: 'Pressure Transmitter', description: 'Fixed connection test. Keep model PT-100, range 0-10 bar, accuracy ±0.5% FS unchanged.', parameters: [{ label: 'Measurement range', value: '0-10 bar' }] }, { timeoutMs: 20000 });
    if (result.status !== 200) throw new Error(`Translation provider returned status ${result.status}`);
    add('4. 多语言自动翻译', 'PASS', '服务商返回可解析且通过基础技术数据校验的草稿；测试文本为固定样例，草稿未保存。仍需人工审校。');
  } catch (e) { add('4. 多语言自动翻译', 'FAIL', `翻译服务真实调用失败：${safeError(e)}`); }
}
function checkBackupAndStorage() {
  const scripts = ['scripts/backup-json-data.js','scripts/secure-backup-container.js','scripts/test_backup_recovery_drill.js'];
  const missing = scripts.filter(f => !fs.existsSync(path.join(root, f)));
  if (missing.length) add('1. 备份与恢复', 'FAIL', `缺少脚本：${missing.join(', ')}`);
  else add('1. 备份与恢复', 'PASS', '备份、加密容器和隔离恢复演练脚本存在；本地恢复演练由 npm test 单独执行。');
  const uploads = path.resolve(env.UPLOAD_DIR || path.join(root, 'assets', 'uploads'));
  if (!fs.existsSync(uploads)) add('2. 文件持久化', 'WARN', '本地上传目录不存在；需确认生产环境的持久磁盘或对象存储挂载。');
  else add('2. 文件持久化', 'WARN', `本地上传目录存在（${path.relative(root, uploads) || '.'}）；这不能证明 Render 重启后文件仍存在，需确认持久磁盘/对象存储。`);
}
function checkLanguageAndRemote() {
  const tests = ['test_site_language_acceptance.js','test_product_parameter_localization.js','test_translation_bulk_import.js'];
  const missing = tests.filter(f => !fs.existsSync(path.join(root, f)));
  if (missing.length) add('4. 多语言购物流程', 'FAIL', `缺少专项测试：${missing.join(', ')}`);
  else add('4. 多语言购物流程', 'PASS', '八种语言、产品参数回退和翻译导入专项测试文件存在；请执行 npm test。');
  if (!has('SMOKE_BASE_URL')) add('5. 部署验收', 'BLOCKED', '未配置 SMOKE_BASE_URL，无法执行线上只读冒烟测试。');
  else if (!live) add('5. 部署验收', 'CONFIGURED', '线上冒烟测试 URL 已配置；运行 --live 才会请求线上页面。');
}
async function checkRemote() {
  if (!live || !has('SMOKE_BASE_URL')) return;
  try {
    const { execFileSync } = require('node:child_process');
    execFileSync(process.execPath, [path.join(root, 'scripts', 'remote-smoke-test.js')], { env: { ...env, SMOKE_BASE_URL: env.SMOKE_BASE_URL }, stdio: 'pipe', timeout: 120000 });
    add('5. 部署验收', 'PASS', '线上只读冒烟测试通过；未登录、未下单、未修改线上数据。');
  } catch (e) { add('5. 部署验收', 'FAIL', '线上只读冒烟测试失败。请查看本地命令输出；为保护信息，脚本不转发响应内容或凭证。'); }
}
(async () => {
  checkBackupAndStorage();
  await checkPostgres();
  await checkSmtp();
  await checkPayPal();
  await checkTranslation();
  checkLanguageAndRemote();
  await checkRemote();
  console.log(`Qingke V18 launch acceptance (${live ? 'LIVE READ-ONLY PROBES' : 'CONFIGURATION ONLY'}; no emails, orders, captures, or data writes)`);
  for (const r of results) console.log(`[${r.status}] ${r.area}: ${r.message}`);
  const fails = results.filter(r => r.status === 'FAIL').length;
  const blocked = results.filter(r => r.status === 'BLOCKED').length;
  console.log(`Summary: ${results.filter(r=>r.status==='PASS').length} PASS, ${results.filter(r=>r.status==='WARN').length} WARN, ${results.filter(r=>r.status==='CONFIGURED').length} CONFIGURED, ${blocked} BLOCKED, ${fails} FAIL.`);
  if (fails || blocked) process.exitCode = 1;
})().catch(e => { console.error(`Launch acceptance failed: ${safeError(e)}`); process.exitCode = 1; });
