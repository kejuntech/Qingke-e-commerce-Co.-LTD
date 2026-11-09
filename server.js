'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
// Validate editable homepage destinations at the API boundary as well as in the browser.
function validHomeDestination(value) {
  if (typeof value !== 'string' || value.length > 500) return false;
  const s = value.trim();
  if (!s) return true;
  if (/[\u0000-\u001f\u007f\\]/.test(s)) return false;
  if (/^https?:\/\/[^\s/?#]+(?:[/?#]|$)/i.test(s)) return true;
  if (/^\/(?!\/)[^\s]*$/.test(s)) return true;
  if (/^(?:assets|uploads)\/[a-z0-9_./%+-]+(?:[?#][^\s]*)?$/i.test(s) && !s.split(/[?#]/)[0].split('/').includes('..')) return true;
  return /^[a-z0-9_-]+\.html(?:[?#][^\s]*)?$/i.test(s);
}
function validHomeVisualDestinations(root) {
  const pending = [root];
  let count = 0;
  while (pending.length) {
    if (++count > 3000) return false;
    const item = pending.pop();
    if (!item || typeof item !== 'object') continue;
    for (const [key, value] of Object.entries(item)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return false;
      if (key === 'href' || key === 'image') {
        if (!validHomeDestination(value)) return false;
      } else if (value && typeof value === 'object') pending.push(value);
    }
  }
  return true;
}
const ROOT = __dirname, DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data')), PORT = Number(process.env.PORT || 3000);
const MEDIA = path.join(DATA, 'uploads');
fs.mkdirSync(MEDIA, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });
for (const f of ['products.json','settings.json','inquiries.json','categories.json','payments.json','bank-transfers.json','crm.json','customers.json','customer-sessions.json','admin-sessions.json','quotes.json','email-outbox.json']) {
  const target = path.join(DATA, f);
  if (!fs.existsSync(target)) {
    const seed = path.join(ROOT, 'data-seed', f);
    if (fs.existsSync(seed)) fs.copyFileSync(seed, target);
    else fs.writeFileSync(target, JSON.stringify(f === 'settings.json' ? {} : [], null, 2));
  }
}
const attempts = new Map();
const { clientIp } = require('./lib/client-ip');
function rateLimited(key, max=10, windowMs=15*60*1000) {
  const now = Date.now(); let a = attempts.get(key);
  if (!a || now-a.start > windowMs) { a = {start:now,count:0}; attempts.set(key,a); }
  a.count++; return a.count > max;
}
function clientKey(req) { return clientIp(req); }
const read = f => JSON.parse(fs.readFileSync(path.join(DATA,f),'utf8'));
const write = (f,v) => atomicWriteText(path.join(DATA,f), JSON.stringify(v,null,2));
const postgresRuntime = require('./db/postgres-runtime');
const readCollection = async f => postgresRuntime.readCollection(f, read);
const writeCollection = async (f,v) => postgresRuntime.writeCollection(f, v, write);
const mutateCollection = async (f, mutator) => postgresRuntime.mutateCollection(f, mutator, read, write);
const mutateCollections = async (names, mutator, jsonCommit) => postgresRuntime.mutateCollections(names, mutator, read, write, jsonCommit);
const readDocument = async f => postgresRuntime.readDocument(f, read);
const writeDocument = async (f,v) => postgresRuntime.writeDocument(f, v, write);
const mutateDocument = async (f,mutator) => postgresRuntime.mutateDocument(f, mutator, read, write);
const postgresCollectionEnabled = f => postgresRuntime.enabled(f);
// Small write-ahead journal for the two-file quote -> order transition.
// It is not a substitute for PostgreSQL transactions, but makes interrupted
// conversions recoverable on the next process start.
const QUOTE_ORDER_JOURNAL = path.join(DATA, '.quote-order-transaction.json');
function atomicWriteText(file, text) {
  const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 });
  fs.renameSync(tmp, file);
}
function commitQuoteOrderTransaction(orders, quotes) {
  const journal = { version: 1, createdAt: new Date().toISOString(), files: {
    'bank-transfers.json': JSON.stringify(orders, null, 2),
    'quotes.json': JSON.stringify(quotes, null, 2)
  }};
  atomicWriteText(QUOTE_ORDER_JOURNAL, JSON.stringify(journal));
  atomicWriteText(path.join(DATA, 'bank-transfers.json'), journal.files['bank-transfers.json']);
  atomicWriteText(path.join(DATA, 'quotes.json'), journal.files['quotes.json']);
  fs.unlinkSync(QUOTE_ORDER_JOURNAL);
}
function recoverQuoteOrderTransaction() {
  if (!fs.existsSync(QUOTE_ORDER_JOURNAL)) return;
  const journal = JSON.parse(fs.readFileSync(QUOTE_ORDER_JOURNAL, 'utf8'));
  if (journal.version !== 1 || !journal.files || typeof journal.files['bank-transfers.json'] !== 'string' || typeof journal.files['quotes.json'] !== 'string') throw new Error('Invalid quote/order transaction journal; do not start with live traffic until it is inspected.');
  JSON.parse(journal.files['bank-transfers.json']); JSON.parse(journal.files['quotes.json']);
  atomicWriteText(path.join(DATA, 'bank-transfers.json'), journal.files['bank-transfers.json']);
  atomicWriteText(path.join(DATA, 'quotes.json'), journal.files['quotes.json']);
  fs.unlinkSync(QUOTE_ORDER_JOURNAL);
  console.warn('Recovered interrupted quotation-to-order transaction from journal.');
}
recoverQuoteOrderTransaction();
const CATALOG_JOURNAL = path.join(DATA,'.catalog-transaction.json');
function commitCatalogueTransaction(collections){
  const files={'products.json':JSON.stringify(collections['products.json'],null,2),'categories.json':JSON.stringify(collections['categories.json'],null,2)};
  atomicWriteText(CATALOG_JOURNAL,JSON.stringify({version:1,files}));
  for(const [name,value] of Object.entries(files))atomicWriteText(path.join(DATA,name),value);
  fs.unlinkSync(CATALOG_JOURNAL);
}
function recoverCatalogueTransaction(){
  if(!fs.existsSync(CATALOG_JOURNAL))return;
  const journal=JSON.parse(fs.readFileSync(CATALOG_JOURNAL,'utf8'));
  if(journal.version!==1||!journal.files||typeof journal.files['products.json']!=='string'||typeof journal.files['categories.json']!=='string')throw new Error('Invalid catalog journal. Manual inspection is required.');
  for(const name of ['products.json','categories.json']){const records=JSON.parse(journal.files[name]);if(!Array.isArray(records))throw new Error('Invalid journal data for '+name);}
  for(const name of ['products.json','categories.json'])atomicWriteText(path.join(DATA,name),journal.files[name]);
  fs.unlinkSync(CATALOG_JOURNAL);
  console.warn('Recovered interrupted catalog/category rename transaction.');
}
recoverCatalogueTransaction();
// Product changes are scoped and compare their original record to prevent stale-tab overwrites.
function productRevision(row) { return '"' + crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex') + '"'; }
function productsRevision(rows) { return productRevision(rows); }
function validAdminProduct(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x) || typeof x.id !== 'string' || !x.id.trim() || x.id.length > 160) return '产品必须包含唯一且有效的 ID。';
  if (!String(x.name || '').trim() || !String(x.category || '').trim() || !String(x.subcategory || '').trim() || !String(x.group || '').trim()) return '产品必须填写型号、一级分类、二级分类和产品分组。';
  if (x.specs !== undefined && (!x.specs || typeof x.specs !== 'object' || Array.isArray(x.specs))) return '技术参数必须是字段对象。';
  if (x.skus !== undefined) {
    if (!Array.isArray(x.skus) || x.skus.length > 20000) return 'SKU 必须是数组且不超过 20000 条。';
    const seen = new Set();
    for (const sku of x.skus) {
      if (!sku || !String(sku.id || '').trim() || !String(sku.name || '').trim() || typeof sku.price !== 'number' || !Number.isFinite(sku.price) || sku.price <= 0 || sku.price > 10000000 || Math.abs(Math.round(sku.price * 100)-sku.price*100)>1e-7 || String(sku.currency || 'USD').toUpperCase() !== 'USD') return 'SKU 需包含唯一编码、名称、两位以内小数的正数 USD 价格。';
      if (seen.has(String(sku.id))) return '同一产品的 SKU 编码不能重复。';
      seen.add(String(sku.id));
      if (sku.attributes !== undefined && (!sku.attributes || typeof sku.attributes !== 'object' || Array.isArray(sku.attributes) || Object.keys(sku.attributes).length > 12 || Object.entries(sku.attributes).some(([k,v])=>!String(k).trim()||!String(v).trim()||String(k).length>80||String(v).length>160))) return 'SKU 规格属性格式不正确。';
      if (sku.inventoryQuantity !== undefined && (!Number.isSafeInteger(sku.inventoryQuantity) || sku.inventoryQuantity < 0)) return 'SKU 库存必须是非负整数。';
    }
  }
  if (x.skuGroups !== undefined && (!Array.isArray(x.skuGroups) || x.skuGroups.length > 30)) return 'SKU 分组列表无效。';
  return '';
}
function mediaSignatureOk(buf, kind) {
  if (!Buffer.isBuffer(buf)) return false;
  if (kind === 'png') return buf.length >= 33 && buf.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) && buf.toString('ascii',12,16)==='IHDR' && buf.readUInt32BE(8)===13 && buf.readUInt32BE(16)>0 && buf.readUInt32BE(20)>0;
  if (kind === 'jpeg') return buf.length >= 6 && buf[0]===0xff && buf[1]===0xd8 && buf[2]===0xff && buf[buf.length-2]===0xff && buf[buf.length-1]===0xd9;
  if (kind === 'webp') return buf.length >= 16 && buf.toString('ascii',0,4)==='RIFF' && buf.toString('ascii',8,12)==='WEBP' && buf.readUInt32LE(4)+8<=buf.length;
  if (kind === 'pdf') return buf.length>=8 && buf.toString('ascii',0,5)==='%PDF-' && buf.includes(Buffer.from('%%EOF'));
  return false;
}
const send = (res,status,obj) => {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(obj));};
const cookie = req => (req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('kj_session='))?.slice(11);
const adminSessionHash = token => crypto.createHash('sha256').update(String(token)).digest('hex');
async function adminSessions(){return readCollection('admin-sessions.json');}
async function issueAdminSession(res){const token=crypto.randomBytes(32).toString('hex'),now=Date.now();await mutateCollection('admin-sessions.json',rows=>{const alive=rows.filter(x=>Date.parse(x.expiresAt)>now);alive.push({tokenHash:adminSessionHash(token),createdAt:new Date(now).toISOString(),expiresAt:new Date(now+8*60*60*1000).toISOString()});return {rows:alive,result:true};});res.setHeader('Set-Cookie',`kj_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${8*60*60}${process.env.NODE_ENV==='production'?'; Secure':''}`);}
const authed = async req => {const token=cookie(req);if(!token||!/^[a-f0-9]{64}$/.test(token))return false;const digest=adminSessionHash(token),now=Date.now();let valid=false;await mutateCollection('admin-sessions.json',rows=>{const alive=rows.filter(x=>Date.parse(x.expiresAt)>now);valid=alive.some(x=>x.tokenHash===digest);return {rows:alive,result:valid};});return valid;};
const customerCookie = req => (req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('kj_customer='))?.slice(12);
const tokenHash = token => crypto.createHash('sha256').update(token).digest('hex');
async function currentCustomer(req){const token=customerCookie(req);if(!token)return null;const digest=tokenHash(token),rows=await readCollection('customer-sessions.json'),session=rows.find(x=>x.tokenHash===digest&&Date.parse(x.expiresAt)>Date.now());if(!session)return null;return (await readCollection('customers.json')).find(x=>x.id===session.customerId)||null;}
function customerSafe(c){return c?{id:c.id,name:c.name,company:c.company,email:c.email,phone:c.phone||'',country:c.country||'',createdAt:c.createdAt}:null;}
function setCustomerCookie(res,token,maxAge=60*60*24*14){res.setHeader('Set-Cookie',`kj_customer=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${process.env.NODE_ENV==='production'?'; Secure':''}`);}
async function issueCustomerSession(res,customerId){const token=crypto.randomBytes(32).toString('hex'),now=Date.now();await mutateCollection('customer-sessions.json',rows=>{const alive=rows.filter(x=>Date.parse(x.expiresAt)>now);alive.push({tokenHash:tokenHash(token),customerId,createdAt:new Date(now).toISOString(),expiresAt:new Date(now+14*86400000).toISOString()});return {rows:alive,result:true};});setCustomerCookie(res,token);}
function body(req){return new Promise((resolve,reject)=>{let d='';req.on('data',c=>{d+=c;if(d.length>75*1024*1024){reject(new Error('Request too large'));req.destroy();}});req.on('end',()=>{try{resolve(d?JSON.parse(d):{});}catch(e){reject(e);}});});}
function hash(pw,salt){return crypto.scryptSync(pw,salt,64).toString('hex');}
function authFile(){return path.join(DATA,'auth.json');}
const paypalBase=()=>String(process.env.PAYPAL_MODE||'sandbox').toLowerCase()==='live'?'https://api-m.paypal.com':'https://api-m.sandbox.paypal.com';
function paypalConfigured(){return !!(process.env.PAYPAL_CLIENT_ID&&process.env.PAYPAL_CLIENT_SECRET)}
async function paypalToken(){if(!paypalConfigured())throw new Error('PayPal is not configured. Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in the hosting environment.');const auth=Buffer.from(process.env.PAYPAL_CLIENT_ID+':'+process.env.PAYPAL_CLIENT_SECRET).toString('base64');const r=await fetch(paypalBase()+'/v1/oauth2/token',{method:'POST',headers:{Authorization:'Basic '+auth,'Content-Type':'application/x-www-form-urlencoded'},body:'grant_type=client_credentials'});const d=await r.json();if(!r.ok||!d.access_token)throw new Error('Could not connect to PayPal. Check the PayPal API credentials and mode.');return d.access_token}
async function paypalRequest(route,method='GET',payload,requestId){const token=await paypalToken();const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};if(requestId)headers['PayPal-Request-Id']=requestId;const r=await fetch(paypalBase()+route,{method,headers,...(payload?{body:JSON.stringify(payload)}:{})});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.message||d.error_description||'PayPal request failed.');return d}
function safeBuyer(b){return {name:String(b.name||'').slice(0,160),company:String(b.company||'').slice(0,200),email:String(b.email||'').slice(0,254),phone:String(b.phone||'').slice(0,80),country:String(b.country||'').slice(0,100)}}

async function sendAdminNotification(subject, textBody) {
  // Persist the notification before returning success to the customer-facing route.
  const item = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    subject: String(subject || 'Qingke notification').slice(0, 180),
    text: String(textBody || '').slice(0, 12000),
    status: 'pending',
    attempts: 0,
    nextAttemptAt: new Date().toISOString(),
    lastError: '',
    sentAt: '',
    messageId: ''
  };
  await mutateCollection('email-outbox.json', rows => {
    rows.unshift(item);
    return { rows: rows.slice(0, 2000), result: true };
  });
  // Wake the worker immediately; the persisted queue survives process restarts.
  setImmediate(() => { processEmailOutbox().catch(e => console.error('Email outbox worker error:', String(e && e.message || e).slice(0, 300))); });
  return { queued: true, id: item.id };
}

let emailOutboxBusy = false;
async function processEmailOutbox() {
  if (emailOutboxBusy) return;
  emailOutboxBusy = true;
  try {
    const required = ['SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_PASS','SMTP_FROM','SMTP_ADMIN_EMAIL'];
    if (required.some(k => !String(process.env[k] || '').trim())) return;
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 8000
    });
    const now = Date.now();
    // Recover messages left in 'sending' by a crashed process after a conservative lease.
    await mutateCollection('email-outbox.json', rows => {
      for (const row of rows) {
        if (row.status === 'sending' && Date.parse(row.lastAttemptAt || 0) < now - 10 * 60 * 1000) {
          row.status = Number(row.attempts || 0) >= 8 ? 'failed' : 'pending';
          row.nextAttemptAt = new Date(now).toISOString();
          row.lastError = 'Recovered stale sending lease after process interruption.';
        }
      }
      return { rows, result: true };
    });
    const queue = await readCollection('email-outbox.json');
    const item = queue.find(x => x.status === 'pending' && (!x.nextAttemptAt || Date.parse(x.nextAttemptAt) <= now));
    if (!item) return;
    // Mark as sending before network I/O so the same process won't pick it twice.
    await mutateCollection('email-outbox.json', rows => {
      const current = rows.find(x => x.id === item.id && x.status === 'pending');
      if (!current) return { rows, result: false };
      current.status = 'sending';
      current.attempts = Number(current.attempts || 0) + 1;
      current.lastAttemptAt = new Date().toISOString();
      return { rows, result: true };
    });
    const claimed = (await readCollection('email-outbox.json')).find(x => x.id === item.id);
    if (!claimed || claimed.status !== 'sending') return;
    try {
      const result = await transporter.sendMail({
        from: process.env.SMTP_FROM,
        to: process.env.SMTP_ADMIN_EMAIL,
        subject: claimed.subject,
        text: claimed.text
      });
      await mutateCollection('email-outbox.json', rows => {
        const current = rows.find(x => x.id === item.id);
        if (current) { current.status = 'sent'; current.sentAt = new Date().toISOString(); current.messageId = String(result.messageId || '').slice(0, 300); current.lastError = ''; }
        return { rows, result: true };
      });
    } catch (e) {
      const errorText = String(e && e.message || e).slice(0, 300);
      await mutateCollection('email-outbox.json', rows => {
        const current = rows.find(x => x.id === item.id);
        if (current) {
          current.lastError = errorText;
          if (Number(current.attempts || 0) >= 8) current.status = 'failed';
          else {
            current.status = 'pending';
            current.nextAttemptAt = new Date(Date.now() + Math.min(6 * 60 * 60 * 1000, 30000 * (2 ** Math.max(0, Number(current.attempts || 1) - 1)))).toISOString();
          }
        }
        return { rows, result: true };
      });
      console.error('Admin notification email failed; queued for retry:', errorText);
    }
  } finally {
    emailOutboxBusy = false;
  }
}

function defaultHomeModules(){return [
{id:'carousel',label:'首页轮播图',kind:'existing',enabled:true,order:1,size:'full'},
{id:'hero',label:'首页主视觉',kind:'existing',enabled:true,order:2,size:'full'},
{id:'proofbar',label:'信任信息条',kind:'existing',enabled:true,order:3,size:'full'},
{id:'categories',label:'产品分类',kind:'existing',enabled:true,order:4,size:'full'},
{id:'featured',label:'精选产品',kind:'existing',enabled:true,order:5,size:'full'},
{id:'industries',label:'行业应用',kind:'existing',enabled:true,order:6,size:'full'},
{id:'support',label:'技术支持',kind:'existing',enabled:true,order:7,size:'full'},
{id:'contact',label:'联系横幅',kind:'existing',enabled:true,order:8,size:'full'},
...Array.from({length:8},(_,i)=>({id:'reserved-'+(i+1),label:'预留栏目 '+(i+1),kind:'reserved',enabled:false,order:9+i,size:'full',title:'',text:'',buttonText:'',href:'',image:''}))
];}
// Only publicly shipped frontend files may be served from the repository root.
// Source code, tests, reports, deployment configs and backup artifacts must never
// become downloadable merely because their extension is recognized by mime().
const PUBLIC_ROOT_FILES = new Set([
  'about.html','account.html','admin.html','applications.html','cart.html',
  'checkout.html','contact.html','homepage-reference-preview.html',
  'index-v15-legacy.html','index.html','markets.html','product.html',
  'products.html','quote-admin.html','quote-request.html','quote-view.html',
  'resources.html',
  'account.js','admin-free-editor.js','admin-home-layout.js',
  'admin-home-visual.js','admin-product-bulk.js','admin-sku-builder.js',
  'admin-zh.js','admin.js','cart.js','catalog.js','checkout.js',
  'commerce.js','contact.js','home-category-images.js','home-controls.js',
  'admin-image-audit.js','product-image-policy.js',
  'home-free-editor.js','home-modules.js','home-visual.js','quote-admin.js',
  'quote-request.js','quote-view.js','site-language.js','sku-picker.js',
  'admin.css','home-visual.css','styles.css','v70-reference.css',
  'home-visual-defaults.json','sitemap.xml'
]);
function publicStaticPath(requested) {
  if (typeof requested !== 'string' || !requested.startsWith('/') || requested.includes('\\') || /[\x00-\x1f\x7f]/.test(requested)) return false;
  const parts = requested.slice(1).split('/');
  if (!parts.length || parts.some(x => !x || x.startsWith('.') || x === '..')) return false;
  if (parts.length === 1) return PUBLIC_ROOT_FILES.has(parts[0]);
  if (parts[0] === 'products') return parts.length === 2 && /^[a-z0-9_-]+\.html$/i.test(parts[1]);
  if (parts[0] === 'assets') return parts.length <= 6 && /^[a-z0-9_./+%() -]+$/i.test(parts.slice(1).join('/')) && /\.(?:png|jpe?g|webp|gif|svg|pdf|ico|mp4|webm)$/i.test(parts[parts.length-1]);
  return false;
}
function mime(f){return ({'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.webp':'image/webp','.pdf':'application/pdf','.mp4':'video/mp4','.webm':'video/webm','.ico':'image/x-icon','.txt':'text/plain; charset=utf-8'})[path.extname(f).toLowerCase()]||'application/octet-stream';}
const server=http.createServer(async(req,res)=>{
  // Baseline browser security headers. Avoid a restrictive CSP here because existing pages
  // still contain inline scripts/styles; CSP needs a separate nonce/hash migration.
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','SAMEORIGIN');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  const url=new URL(req.url,'http://localhost'); const p=url.pathname;
  try {
    // Liveness endpoint for Render/platform health checks. Deliberately does not
    // expose database, mail, payment, translation, or secret configuration details.
    if(p==='/healthz' && req.method==='GET') return send(res,200,{ok:true});
    if(p.startsWith('/api/')) {
      if(p==='/api/status' && req.method==='GET') return send(res,200,{setupRequired:!fs.existsSync(authFile()),setupTokenRequired:process.env.NODE_ENV==='production'&&!fs.existsSync(authFile()),authenticated:await authed(req)});
      if(p==='/api/customer/register' && req.method==='POST') {if(rateLimited('customer-register:'+clientKey(req),8))return send(res,429,{error:'Too many registration attempts. Please try again later.'});const b=await body(req),name=String(b.name||'').trim().slice(0,160),company=String(b.company||'').trim().slice(0,200),email=String(b.email||'').trim().toLowerCase().slice(0,254),phone=String(b.phone||'').trim().slice(0,80),country=String(b.country||'').trim().slice(0,100),password=String(b.password||'');if(!name||!company||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return send(res,400,{error:'Enter your name, company and a valid email address.'});if(password.length<10)return send(res,400,{error:'Password must be at least 10 characters.'});const created=await mutateCollection('customers.json',rows=>{if(rows.some(x=>String(x.email).trim().toLowerCase()===email))return {write:false,result:{duplicate:true}};const salt=crypto.randomBytes(16).toString('hex'),customer={id:crypto.randomUUID(),name,company,email,phone,country,salt,passwordHash:hash(password,salt),createdAt:new Date().toISOString()};rows.unshift(customer);return {rows,result:{duplicate:false,customer}};});if(created.duplicate)return send(res,409,{error:'An account with this email already exists. Please sign in.'});await issueCustomerSession(res,created.customer.id);return send(res,201,{ok:true,customer:customerSafe(created.customer)});}
      if(p==='/api/customer/login' && req.method==='POST') {if(rateLimited('customer-login:'+clientKey(req),10))return send(res,429,{error:'Too many sign-in attempts. Please wait and try again.'});const b=await body(req),email=String(b.email||'').trim().toLowerCase(),password=String(b.password||''),c=(await readCollection('customers.json')).find(x=>String(x.email).toLowerCase()===email);let valid=false;if(c&&typeof c.salt==='string'&&typeof c.passwordHash==='string'){const candidate=Buffer.from(hash(password,c.salt),'hex'),stored=Buffer.from(c.passwordHash,'hex');valid=candidate.length===stored.length&&candidate.length>0&&crypto.timingSafeEqual(candidate,stored);}if(!valid)return send(res,401,{error:'Email or password is incorrect.'});await issueCustomerSession(res,c.id);return send(res,200,{ok:true,customer:customerSafe(c)});}
      if(p==='/api/customer/logout' && req.method==='POST') {const token=customerCookie(req);if(token)await mutateCollection('customer-sessions.json',rows=>({rows:rows.filter(x=>x.tokenHash!==tokenHash(token)),result:true}));setCustomerCookie(res,'',0);return send(res,200,{ok:true});}
      if(p==='/api/customer/me' && req.method==='GET') {const c=await currentCustomer(req);return c?send(res,200,{authenticated:true,customer:customerSafe(c)}):send(res,200,{authenticated:false,customer:null});}
      if(p==='/api/customer/profile' && req.method==='PATCH') {const current=await currentCustomer(req);if(!current)return send(res,401,{error:'Please sign in to update your profile.'});const b=await body(req),name=String(b.name||'').trim().slice(0,160),company=String(b.company||'').trim().slice(0,200),phone=String(b.phone||'').trim().slice(0,80),country=String(b.country||'').trim().slice(0,100);if(!name||!company)return send(res,400,{error:'Name and company are required.'});const updated=await mutateCollection('customers.json',rows=>{const c=rows.find(x=>x.id===current.id);if(!c)return {write:false,result:null};c.name=name;c.company=company;c.phone=phone;c.country=country;c.updatedAt=new Date().toISOString();return {rows,result:c};});if(!updated)return send(res,404,{error:'Customer account was not found.'});return send(res,200,{ok:true,customer:customerSafe(updated)});}
      if(p==='/api/customer/orders' && req.method==='GET') {const c=await currentCustomer(req);if(!c)return send(res,401,{error:'Please sign in to view your orders.'});const bank=(await readCollection('bank-transfers.json')).filter(o=>String(o.buyer?.email||'').toLowerCase()===c.email).map(o=>({id:o.id,createdAt:o.createdAt,status:o.status,paymentMethod:o.paymentMethod,amount:o.amount,currency:o.currency,items:o.items,shippingCarrier:o.shippingCarrier,trackingNumber:o.trackingNumber,trackingUrl:o.trackingUrl,shippedDate:o.shippedDate,deliveryStatus:o.deliveryStatus}));const paypal=(await readCollection('payments.json')).filter(o=>String(o.buyer?.email||'').toLowerCase()===c.email).map(o=>({id:o.id,createdAt:o.createdAt,status:o.status,paymentMethod:'PayPal',amount:o.amount,currency:o.currency,items:o.items}));const orders=[...bank,...paypal].sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));return send(res,200,{orders});}
      if(p==='/api/quotes' && req.method==='POST') {
        if(rateLimited('quote-request:'+clientKey(req),12)) return send(res,429,{error:'Too many quote requests. Please try again later.'});
        const b=await body(req),name=String(b.name||'').trim().slice(0,160),company=String(b.company||'').trim().slice(0,200),email=String(b.email||'').trim().toLowerCase().slice(0,254),phone=String(b.phone||'').trim().slice(0,80),country=String(b.country||'').trim().slice(0,100),currency=String(b.currency||'USD').toUpperCase();
        if(!name||!company||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return send(res,400,{error:'Enter your name, company and a valid email address.'});
        if(!['USD','EUR','GBP','CNY','SAR','CAD','AUD'].includes(currency))return send(res,400,{error:'Unsupported quotation currency.'});
        let items=[];try{items=Array.isArray(b.items)?b.items:JSON.parse(String(b.itemsJson||'[]'));}catch{return send(res,400,{error:'Product requirements must be a valid list.'});}
        if(!items.length||items.length>30)return send(res,400,{error:'Add between 1 and 30 requested products.'});
        items=items.map((x,i)=>({lineId:crypto.randomUUID(),productName:String(x.productName||x.name||'').trim().slice(0,200),model:String(x.model||'').trim().slice(0,160),parameters:String(x.parameters||x.specifications||'').trim().slice(0,3000),quantity:Math.max(1,Math.min(100000,Math.floor(Number(x.quantity||x.qty)||1))),unitPrice:null,lineTotal:null}));
        if(items.some(x=>!x.productName&&!x.model))return send(res,400,{error:'Each requested product needs a product name or model.'});
        const token=crypto.randomBytes(32).toString('hex'),now=new Date().toISOString(),id='KJQ-'+Date.now().toString(36).toUpperCase()+'-'+crypto.randomBytes(3).toString('hex').toUpperCase();
        const q={id,createdAt:now,updatedAt:now,status:'Pending pricing',buyer:{name,company,email,phone,country},currency,items,message:String(b.message||'').trim().slice(0,5000),validUntil:'',terms:'',subtotal:null,shipping:null,total:null,tokenHash:tokenHash(token),pricedAt:null};
        await mutateCollection('quotes.json',rows=>{rows.unshift(q);return {rows,result:true};});return send(res,201,{ok:true,quoteId:id,accessToken:token,message:'Your request was received. Keep your private quotation link safe.'});
      }
      if(p==='/api/quote/view' && req.method==='GET') {
        const token=String(url.searchParams.get('token')||'');if(!/^[a-f0-9]{64}$/.test(token))return send(res,404,{error:'Quotation not found.'});const q=(await readCollection('quotes.json')).find(x=>x.tokenHash===tokenHash(token));if(!q)return send(res,404,{error:'Quotation not found.'});
        if(q.status==='Quoted'&&q.validUntil&&/^\d{4}-\d{2}-\d{2}$/.test(q.validUntil)&&q.validUntil<new Date().toISOString().slice(0,10))return send(res,410,{error:'This quotation has expired. Please contact Qingke sales for an updated quotation.'});
        const {tokenHash:discard,...safe}=q;return send(res,200,{quote:safe});
      }
      if(p==='/api/quote/respond' && req.method==='POST') {
        if(rateLimited('quote-response:'+clientKey(req),20))return send(res,429,{error:'Too many quotation response attempts. Please try again later.'});
        const b=await body(req),token=String(b.token||''),action=String(b.action||''),message=String(b.message||'').trim().slice(0,2000);
        if(!/^[a-f0-9]{64}$/.test(token))return send(res,404,{error:'Quotation not found.'});
        if(!['accept','revision'].includes(action))return send(res,400,{error:'Choose accept or request revision.'});
        let outcome={kind:'not-found'};await mutateCollection('quotes.json',rows=>{const idx=rows.findIndex(x=>x.tokenHash===tokenHash(token));if(idx<0)return {rows,result:outcome};const q=rows[idx];if(q.status!=='Quoted'){outcome={kind:'conflict'};return {rows,result:outcome};}if(q.validUntil&&/^\d{4}-\d{2}-\d{2}$/.test(q.validUntil)&&q.validUntil<new Date().toISOString().slice(0,10)){outcome={kind:'expired'};return {rows,result:outcome};}const now=new Date().toISOString();q.status=action==='accept'?'Accepted':'Revision requested';q.customerResponse={action,message,at:now};q.updatedAt=now;q.history=Array.isArray(q.history)?q.history:[];q.history.push({type:'customer-response',action:q.status,message,at:now});rows[idx]=q;outcome={kind:'ok',status:q.status};return {rows,result:outcome};});
        if(outcome.kind==='not-found')return send(res,404,{error:'Quotation not found.'});if(outcome.kind==='conflict')return send(res,409,{error:'This quotation is not currently awaiting a customer response.'});if(outcome.kind==='expired')return send(res,410,{error:'This quotation has expired. Please contact Qingke sales.'});return send(res,200,{ok:true,status:outcome.status,message:action==='accept'?'Thank you. Your acceptance has been recorded.':'Your revision request has been sent to Qingke sales.'});
      }
      if(p==='/api/paypal/config' && req.method==='GET') return send(res,200,{enabled:paypalConfigured(),clientId:paypalConfigured()?process.env.PAYPAL_CLIENT_ID:'',mode:String(process.env.PAYPAL_MODE||'sandbox').toLowerCase()==='live'?'live':'sandbox',currency:String((await readDocument('settings.json')).paypalCurrency||'USD').toUpperCase()});
      if(p==='/api/paypal/create-order' && req.method==='POST') {
        if(rateLimited('paypal-create:'+clientKey(req),20))return send(res,429,{error:'Too many payment attempts. Please wait and try again.'});
        const b=await body(req), buyer=safeBuyer(b.buyer||{}), ids=Array.isArray(b.items)?b.items:[];
        if(!buyer.name||!buyer.company||!buyer.email||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyer.email))return send(res,400,{error:'Enter your name, company and a valid email before paying.'});
        if(!ids.length||ids.length>100)return send(res,400,{error:'Your cart is empty or contains too many items.'});
        const products=await readCollection('products.json'),lines=[];let currency=null,total=0;
        for(const item of ids){const product=products.find(x=>x.id===String(item.id)&&x.published!==false);if(!product)return send(res,400,{error:'A product in your cart is no longer available. Refresh your cart.'});const sku=item.skuId?((product.skus||[]).find(x=>String(x.id)===String(item.skuId))):null;if(item.skuId&&!sku)return send(res,400,{error:'Selected SKU is no longer available. Refresh the product page.'});if(Array.isArray(product.skus)&&product.skus.length&&!sku)return send(res,400,{error:'Choose a complete product specification (SKU) before placing the order.'});const rawPrice=sku?sku.price:product.price,rawCurrency=sku?sku.currency:product.currency;if(rawPrice===undefined||String(rawPrice).trim()===''||!Number.isFinite(Number(rawPrice))||Number(rawPrice)<0)return send(res,400,{error:'One or more products need a confirmed price before PayPal checkout.'});const c=String(rawCurrency||'USD').toUpperCase(),qty=Math.max(1,Math.min(999,Math.floor(Number(item.qty)||1)));if(currency&&currency!==c)return send(res,400,{error:'All products in one PayPal payment must use the same currency.'});currency=c;const unit=Number(Number(rawPrice).toFixed(2));if(unit<=0)return send(res,400,{error:'PayPal checkout requires a positive product price.'});total+=unit*qty;lines.push({id:product.id,skuId:sku?.id||'',skuName:sku?.name||'',model:String(product.model||product.name)+(sku?' / '+sku.name:''),qty,unitPrice:unit,currency:c});}
        if(!['USD','EUR','GBP','CAD','AUD','JPY','SGD','HKD'].includes(currency))return send(res,400,{error:'PayPal checkout currently supports USD, EUR, GBP, CAD, AUD, JPY, SGD and HKD. Please contact sales for other currencies.'});
        total=Number(total.toFixed(2));const id='KJ-'+Date.now().toString(36).toUpperCase()+'-'+crypto.randomBytes(3).toString('hex').toUpperCase();
        const order=await paypalRequest('/v2/checkout/orders','POST',{intent:'CAPTURE',purchase_units:[{reference_id:id,custom_id:id,invoice_id:id,description:'Qingke industrial instrumentation order '+id,amount:{currency_code:currency,value:total.toFixed(2),breakdown:{item_total:{currency_code:currency,value:total.toFixed(2)}}},items:lines.map(x=>({name:x.model.slice(0,127),quantity:String(x.qty),unit_amount:{currency_code:currency,value:x.unitPrice.toFixed(2)},category:'PHYSICAL_GOODS'}))}],application_context:{brand_name:String((await readDocument('settings.json')).company||'Qingke').slice(0,127),user_action:'PAY_NOW',shipping_preference:'NO_SHIPPING'}},id);
        await mutateCollection('payments.json',payments=>{payments.unshift({id,createdAt:new Date().toISOString(),status:'Created',paypalOrderId:order.id,amount:total.toFixed(2),currency,buyer,items:lines});return {rows:payments,result:true};});return send(res,201,{id,paypalOrderId:order.id,amount:total.toFixed(2),currency});
      }
      if(p==='/api/paypal/capture-order' && req.method==='POST') {
        if(rateLimited('paypal-capture:'+clientKey(req),20))return send(res,429,{error:'Too many capture attempts. Please wait and try again.'});
        const b=await body(req),paypalOrderId=String(b.paypalOrderId||'').trim();if(!paypalOrderId)return send(res,400,{error:'Missing PayPal order ID.'});
        const entry=(await readCollection('payments.json')).find(x=>x.paypalOrderId===paypalOrderId);if(!entry)return send(res,404,{error:'Payment order not found.'});if(entry.status==='Completed')return send(res,200,{ok:true,payment:{id:entry.id,status:entry.status,amount:entry.captureAmount||entry.amount,currency:entry.captureCurrency||entry.currency}});
        let result;try{result=await paypalRequest('/v2/checkout/orders/'+encodeURIComponent(entry.paypalOrderId)+'/capture','POST',{},entry.id+'-capture');}catch(e){
          // A network failure can happen after PayPal has captured the funds. Keep the same idempotency key on retry.
          console.error('PayPal capture request failed:',e.message);return send(res,502,{error:'PayPal capture could not be confirmed. Please retry the same order; do not create a new payment.'});
        }
        const unit=(result.purchase_units||[]).find(x=>x.reference_id===entry.id||x.custom_id===entry.id)||(result.purchase_units||[])[0],capture=(unit?.payments?.captures||[])[0];
        if(result.status!=='COMPLETED'||!capture||capture.status!=='COMPLETED')return send(res,409,{error:'PayPal has not confirmed a completed payment. Current status: '+String(result.status||capture?.status||'unknown')});
        const captureAmount=String(capture.amount?.value||''),captureCurrency=String(capture.amount?.currency_code||'').toUpperCase(),expectedAmount=Number(entry.amount).toFixed(2),expectedCurrency=String(entry.currency||'').toUpperCase();
        if(!captureAmount||!Number.isFinite(Number(captureAmount))||Number(captureAmount).toFixed(2)!==expectedAmount||captureCurrency!==expectedCurrency){
          console.error('PayPal capture amount/currency mismatch for local payment',entry.id,{expectedAmount,expectedCurrency,captureAmount,captureCurrency});return send(res,409,{error:'The captured amount or currency does not match the recorded order. Payment was not marked completed; contact support before retrying.'});
        }
        const saved=await mutateCollection('payments.json',payments=>{const idx=payments.findIndex(x=>x.paypalOrderId===paypalOrderId);if(idx<0)return {write:false,result:{kind:'missing'}};const current=payments[idx];if(current.status==='Completed')return {write:false,result:{kind:'completed',payment:current}};current.status='Completed';current.paidAt=current.paidAt||new Date().toISOString();current.paypalCaptureId=capture.id;current.paypalPayerId=result.payer?.payer_id||'';current.payerEmail=result.payer?.email_address||'';current.paypalStatus=result.status;current.captureStatus=capture.status;current.captureAmount=captureAmount;current.captureCurrency=captureCurrency;payments[idx]=current;return {rows:payments,result:{kind:'completed',payment:current}};});
        if(saved.kind==='missing')return send(res,404,{error:'Payment order not found while saving the capture result.'});const payment=saved.payment;return send(res,200,{ok:true,payment:{id:payment.id,status:payment.status,amount:payment.captureAmount||payment.amount,currency:payment.captureCurrency||payment.currency}});
      }

      if(p==='/api/setup' && req.method==='POST') { if(rateLimited('setup:'+clientKey(req),5)) return send(res,429,{error:'Too many setup attempts. Try again later.'}); if(fs.existsSync(authFile())) return send(res,409,{error:'Admin is already configured.'}); const b=await body(req); if(process.env.NODE_ENV==='production') {const configured=String(process.env.ADMIN_SETUP_TOKEN||'');if(configured.length<24)return send(res,503,{error:'首次初始化需要管理员先在 Render 环境变量中配置至少 24 字符的 ADMIN_SETUP_TOKEN。'});const submitted=String(b.setupToken||'');const expectedDigest=crypto.createHash('sha256').update(configured).digest(),actualDigest=crypto.createHash('sha256').update(submitted).digest();if(!crypto.timingSafeEqual(expectedDigest,actualDigest))return send(res,403,{error:'首次初始化密钥无效。请检查 Render ADMIN_SETUP_TOKEN。'});} if(!b.password||String(b.password).length<12) return send(res,400,{error:'Use a password with at least 12 characters.'}); const salt=crypto.randomBytes(16).toString('hex'); try{fs.writeFileSync(authFile(),JSON.stringify({salt,hash:hash(String(b.password),salt)}),{flag:'wx',mode:0o600});}catch(e){if(e&&e.code==='EEXIST')return send(res,409,{error:'管理员已初始化，请直接登录。'});throw e;} await issueAdminSession(res); return send(res,200,{ok:true}); }
      if(p==='/api/login' && req.method==='POST') {if(rateLimited('login:'+clientKey(req),10)) return send(res,429,{error:'Too many login attempts. Try again later.'}); const b=await body(req); if(!fs.existsSync(authFile())) return send(res,400,{error:'Complete admin setup first.'}); const a=JSON.parse(fs.readFileSync(authFile(),'utf8')); const h=hash(String(b.password||''),a.salt); if(!crypto.timingSafeEqual(Buffer.from(h,'hex'),Buffer.from(a.hash,'hex'))) return send(res,401,{error:'Incorrect password.'}); await issueAdminSession(res); return send(res,200,{ok:true});}
      if(p==='/api/logout' && req.method==='POST') {const token=cookie(req);if(token)await mutateCollection('admin-sessions.json',rows=>({rows:rows.filter(x=>x.tokenHash!==adminSessionHash(token)),result:true}));res.setHeader('Set-Cookie',`kj_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${process.env.NODE_ENV==='production'?'; Secure':''}`);return send(res,200,{ok:true});}
      if(p==='/api/bank-transfers' && req.method==='POST') {
        if(rateLimited('bank-transfer:'+clientKey(req),30)) return send(res,429,{error:'Too many order attempts. Please wait and try again.'});
        const b=await body(req), buyer=safeBuyer(b.buyer||b), items=Array.isArray(b.items)?b.items:[];
        if(!buyer.name||!buyer.company||!buyer.email||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyer.email)) return send(res,400,{error:'Name, company and a valid business email are required.'});
        if(!items.length||items.length>100) return send(res,400,{error:'Your cart is empty or contains too many products.'});
        const products=await readCollection('products.json'),lines=[]; let total=0, currency='USD', allPriced=true;
        for(const item of items){const product=products.find(x=>x.id===String(item.id)&&x.published!==false);if(!product)return send(res,400,{error:'A product in your cart is no longer available. Refresh your cart.'});const sku=item.skuId?((product.skus||[]).find(x=>String(x.id)===String(item.skuId))):null;if(item.skuId&&!sku)return send(res,400,{error:'Selected SKU is no longer available. Refresh the product page.'});if(Array.isArray(product.skus)&&product.skus.length&&!sku)return send(res,400,{error:'Choose a complete product specification (SKU) before placing the order.'});const qty=Math.max(1,Math.min(999,Math.floor(Number(item.qty)||1)));const rawPrice=sku?sku.price:product.price,rawCurrency=sku?sku.currency:product.currency;const price=Number(rawPrice);const valid=rawPrice!==undefined&&String(rawPrice).trim()!==''&&Number.isFinite(price)&&price>=0;if(!valid){allPriced=false;lines.push({id:product.id,skuId:sku?.id||'',skuName:sku?.name||'',model:String(product.model||product.name)+(sku?' / '+sku.name:''),category:product.category||'',subcategory:product.subcategory||'',group:product.group||'',specs:product.specs||{},qty,unitPrice:null,currency:rawCurrency||'USD'});continue;}const c=String(rawCurrency||'USD').toUpperCase();if(c!==currency&&lines.length)return send(res,400,{error:'Products with different currencies must be ordered separately.'});currency=c;total+=Number(price.toFixed(2))*qty;lines.push({id:product.id,skuId:sku?.id||'',skuName:sku?.name||'',model:String(product.model||product.name)+(sku?' / '+sku.name:''),category:product.category||'',subcategory:product.subcategory||'',group:product.group||'',specs:product.specs||{},qty,unitPrice:Number(price.toFixed(2)),currency:c});}
        const id='KJ-TT-'+Date.now().toString(36).toUpperCase()+'-'+crypto.randomBytes(3).toString('hex').toUpperCase();const now=new Date().toISOString();const record={id,createdAt:now,status:'Awaiting payment',paymentMethod:'Bank Transfer (T/T)',currency,amount:allPriced?total.toFixed(2):null,buyer,items:lines,orderNotes:String(b.orderNotes||'').slice(0,4000),remittanceDate:'',proofPath:'',receivedAmount:'',receivedDate:'',shippingCarrier:'',trackingNumber:'',trackingUrl:'',shippedDate:'',deliveryStatus:'Not shipped',adminNote:'',history:[{at:now,status:'Awaiting payment',note:'Order submitted by customer'}]};await mutateCollection('bank-transfers.json',records=>{records.unshift(record);return {rows:records,result:true};});return send(res,201,{ok:true,orderId:id,status:record.status,amount:record.amount,currency:record.currency,bankDetails:{beneficiary:(await readDocument('settings.json')).beneficiary,bankName:(await readDocument('settings.json')).bankName,bankAddress:(await readDocument('settings.json')).bankAddress,accountNumber:(await readDocument('settings.json')).accountNumber,swiftBic:(await readDocument('settings.json')).swiftBic,paymentInstructions:(await readDocument('settings.json')).paymentInstructions}});
      }
      if(p.startsWith('/api/bank-transfers/') && p.endsWith('/proof') && req.method==='POST') {
        if(rateLimited('proof:'+clientKey(req),20))return send(res,429,{error:'Too many upload attempts.'});
        const parts=p.split('/').filter(Boolean),id=decodeURIComponent(parts[2]||''),existing=(await readCollection('bank-transfers.json')).find(x=>x.id===id);
        if(!existing)return send(res,404,{error:'Order not found.'});
        const buyer=await currentCustomer(req),adminAuthorized=await authed(req);
        if(!adminAuthorized&&(!buyer||String(buyer.email).toLowerCase()!==String(existing.buyer?.email||'').toLowerCase()))return send(res,403,{error:'Sign in with the account used for this order to upload remittance proof.'});
        const b=await body(req),match=String(b.data||'').match(/^data:(application\/pdf|image\/png|image\/jpeg);base64,([A-Za-z0-9+/=]+)$/);
        if(!match)return send(res,400,{error:'Upload a PDF, PNG or JPG remittance receipt.'});
        const buf=Buffer.from(match[2],'base64');
        if(!buf.length)return send(res,400,{error:'The uploaded receipt is empty.'});
        if(buf.length>8*1024*1024)return send(res,413,{error:'Remittance proof must be 8 MB or smaller.'});
        const proofKind=match[1]==='application/pdf'?'pdf':match[1]==='image/png'?'png':'jpeg';
        if(!mediaSignatureOk(buf,proofKind))return send(res,400,{error:'收款凭证的实际文件格式与所选 PDF/图片格式不符，请重新上传。'});
        const dir=path.join(DATA,'private-proofs');fs.mkdirSync(dir,{recursive:true});
        const ext=match[1]==='application/pdf'?'pdf':match[1]==='image/png'?'png':'jpg',file=crypto.randomBytes(20).toString('hex')+'.'+ext,full=path.join(dir,file);
        fs.writeFileSync(full,buf,{flag:'wx'});
        try {
          const result=await mutateCollection('bank-transfers.json',rows=>{
            const order=rows.find(x=>x.id===id);
            if(!order)return {write:false,result:{kind:'missing'}};
            if(!adminAuthorized && (!buyer || String(buyer.email).toLowerCase()!==String(order.buyer?.email||'').toLowerCase()))return {write:false,result:{kind:'forbidden'}};
            const now=new Date().toISOString();order.proofPath=file;order.proofUploadedAt=now;
            if(order.status==='Awaiting payment')order.status='Awaiting verification';
            order.history=Array.isArray(order.history)?order.history:[];
            order.history.push({at:now,status:order.status,note:'Customer uploaded remittance proof; funds still require bank verification.'});
            return {rows,result:{kind:'saved',status:order.status}};
          });
          if(result.kind!=='saved'){fs.rmSync(full,{force:true});if(result.kind==='missing')return send(res,404,{error:'Order not found.'});return send(res,403,{error:'You are not allowed to upload proof for this order.'});}
          const noticeOrder=(await readCollection('bank-transfers.json')).find(x=>x.id===id);
          await sendAdminNotification('Qingke remittance proof uploaded: '+id,`A customer uploaded remittance proof.
Order: ${id}
Customer: ${String(noticeOrder?.buyer?.name||'').slice(0,160)}
Company: ${String(noticeOrder?.buyer?.company||'').slice(0,200)}
Customer email: ${String(noticeOrder?.buyer?.email||'').slice(0,254)}
Order amount: ${String(noticeOrder?.currency||'')} ${String(noticeOrder?.amount||'')}
Uploaded at: ${String(noticeOrder?.proofUploadedAt||'')}

Please review the private proof in the authenticated admin panel. This email does not confirm that funds have arrived.`);
          return send(res,201,{ok:true,message:'Proof received. It will be reviewed by our team.'});
        } catch(e){fs.rmSync(full,{force:true});throw e;}
      }
      if(p==='/api/inquiries' && req.method==='POST') {if(rateLimited('inquiry:'+clientKey(req),15))return send(res,429,{error:'Too many inquiries. Please try again later.'});const b=await body(req);if(!String(b.name||'').trim()||!String(b.email||'').trim()||!String(b.company||'').trim())return send(res,400,{error:'Name, company and business email are required.'});if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(b.email).trim()))return send(res,400,{error:'Enter a valid business email address.'});const inquiryItems=Array.isArray(b.items)?b.items.slice(0,100).map(item=>({id:String(item?.id||'').slice(0,160),skuId:String(item?.skuId||'').slice(0,160),skuName:String(item?.skuName||'').slice(0,200),model:String(item?.model||'').slice(0,200),name:String(item?.name||'').slice(0,200),qty:Math.max(1,Math.min(999,Math.floor(Number(item?.qty)||1))),unitPrice:Number.isFinite(Number(item?.unitPrice))?Number(Number(item.unitPrice).toFixed(2)):null,currency:String(item?.currency||'USD').toUpperCase().slice(0,3)})):[];const inquiry={id:crypto.randomUUID(),createdAt:new Date().toISOString(),status:'New',name:String(b.name).trim().slice(0,160),email:String(b.email).trim().toLowerCase().slice(0,254),company:String(b.company).trim().slice(0,200),phone:String(b.phone||'').trim().slice(0,80),country:String(b.country||'').trim().slice(0,100),subject:String(b.subject||'').trim().slice(0,200),message:String(b.message||b.orderNotes||'').trim().slice(0,5000),type:String(b.type||'Website Inquiry').trim().slice(0,100),source:String(b.source||b.createdFrom||'website').trim().slice(0,100),sourceUrl:String(b.sourceUrl||'').trim().slice(0,1000),category:String(b.category||'').trim().slice(0,200),model:String(b.model||'').trim().slice(0,200),productId:String(b.productId||'').trim().slice(0,160),productName:String(b.productName||'').trim().slice(0,200),quantity:Math.max(0,Math.min(1000000,Math.floor(Number(b.quantity)||0))),items:inquiryItems};await mutateCollection('inquiries.json',rows=>{rows.unshift(inquiry);return {rows,result:true};});await sendAdminNotification('New Qingke website inquiry: '+(inquiry.subject||inquiry.company),`A new website inquiry has been received.
Inquiry ID: ${inquiry.id}
Received: ${inquiry.createdAt}
Name: ${inquiry.name}
Company: ${inquiry.company}
Email: ${inquiry.email}
Phone: ${inquiry.phone}
Country: ${inquiry.country}
Subject: ${inquiry.subject}
Source: ${inquiry.source}
Source URL: ${inquiry.sourceUrl}
Product: ${inquiry.productName||inquiry.model}
Quantity: ${inquiry.quantity||''}
Items: ${inquiry.items.map(x=>`${x.model||x.name} [${x.skuId}] x${x.qty}`).join('; ')}

Message:
${inquiry.message}

Please sign in to the Qingke admin panel to manage this inquiry.`);return send(res,201,{ok:true,message:'Thank you. Your inquiry has been received.'});}
      if(p==='/api/products' && req.method==='GET') {const products=await readCollection('products.json');const isAdmin=await authed(req);if(isAdmin)res.setHeader('ETag',productsRevision(products));return send(res,200,isAdmin?products:products.filter(x=>x.published!==false));}
      if(p==='/api/categories' && req.method==='GET') {const categories=await readCollection('categories.json');if(await authed(req))res.setHeader('ETag',productsRevision(categories));return send(res,200,categories);}
      if(p==='/api/settings' && req.method==='GET') { const saved=await readDocument('settings.json'); return send(res,200,{phone:'',address:'',registration:'',paymentMethods:'',paymentInstructions:'',beneficiary:'',bankName:'',bankAddress:'',accountNumber:'',swiftBic:'',paypalEmail:'',paypalCurrency:'USD',homeModules:defaultHomeModules(),...saved}); }
      if(!await authed(req)) return send(res,401,{error:'Please sign in.'});
      if(p==='/api/admin/translation-provider-check' && req.method==='POST') {
        if(rateLimited('translation-provider-check:'+clientKey(req),3,60*60*1000)) return send(res,429,{error:'每小时最多测试 3 次，请稍后再试。'});
        const {probeTranslationProvider}=require('./lib/translation-provider');
        const result=await probeTranslationProvider();
        return send(res,result.ok?200:(result.configured?502:503),{ok:result.ok,configured:result.configured,message:result.message});
      }
      if(p==='/api/admin/translation-drafts' && req.method==='POST') {
        if(rateLimited('translation-drafts:'+clientKey(req),8,60*60*1000)) return send(res,429,{error:'Too many translation draft requests. Please try again later.'});
        const { generateTranslationDrafts } = require('./lib/translation-service');
        const result = await generateTranslationDrafts(await body(req));
        return send(res, result.status, result.body);
      }
      if(p==='/api/email-outbox' && req.method==='GET') {
        const rows=await readCollection('email-outbox.json');
        const safe=rows.slice(0,500).map(x=>({id:String(x.id||''),createdAt:x.createdAt||'',subject:String(x.subject||''),status:String(x.status||'pending'),attempts:Number(x.attempts||0),nextAttemptAt:x.nextAttemptAt||'',lastAttemptAt:x.lastAttemptAt||'',lastError:String(x.lastError||'').slice(0,300),sentAt:x.sentAt||'',messageId:String(x.messageId||''),textPreview:String(x.text||'').slice(0,800)}));
        return send(res,200,{items:safe,total:rows.length,configured:['SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_PASS','SMTP_FROM','SMTP_ADMIN_EMAIL'].every(k=>String(process.env[k]||'').trim())});
      }
      if(p.startsWith('/api/email-outbox/') && p.endsWith('/retry') && req.method==='POST') {
        const id=decodeURIComponent(p.split('/').filter(Boolean).slice(-2)[0]||'');
        const outcome=await mutateCollection('email-outbox.json',rows=>{
          const item=rows.find(x=>x.id===id);
          if(!item)return {write:false,result:{kind:'missing'}};
          if(item.status==='sent'||item.status==='sending')return {write:false,result:{kind:'not-retryable',status:item.status}};
          item.status='pending';item.attempts=0;item.nextAttemptAt=new Date().toISOString();item.lastAttemptAt='';item.manualRetryAt=new Date().toISOString();
          return {rows,result:{kind:'queued'}};
        });
        if(outcome.kind==='missing')return send(res,404,{error:'Email notification not found.'});
        if(outcome.kind==='not-retryable')return send(res,409,{error:outcome.status==='sent'?'This email has already been sent.':'This email is currently being sent.'});
        setImmediate(()=>{processEmailOutbox().catch(e=>console.error('Email outbox manual retry error:',String(e&&e.message||e).slice(0,300)));});
        return send(res,200,{ok:true,message:'Email notification queued for retry.'});
      }
      if(p.startsWith('/api/bank-transfers/') && p.endsWith('/proof') && req.method==='GET') {const parts=p.split('/').filter(Boolean),id=decodeURIComponent(parts[2]||''),record=(await readCollection('bank-transfers.json')).find(x=>x.id===id);if(!record||!record.proofPath)return send(res,404,{error:'No remittance proof found.'});const file=path.join(DATA,'private-proofs',path.basename(record.proofPath));if(!fs.existsSync(file))return send(res,404,{error:'Proof file is unavailable.'});const ext=path.extname(file).toLowerCase(),type=ext==='.pdf'?'application/pdf':ext==='.png'?'image/png':'image/jpeg';res.writeHead(200,{'Content-Type':type,'Content-Disposition':'attachment; filename="remittance-'+id+'.'+ext.slice(1)+'"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});return fs.createReadStream(file).pipe(res);}
      
      if(p==='/api/quotes' && req.method==='GET') return send(res,200,(await readCollection('quotes.json')).map(({tokenHash,...q})=>({...q,customerLinkTokenAvailable:!!tokenHash})));
      if(p.startsWith('/api/quotes/') && p.endsWith('/send-email') && req.method==='POST') {
        const id=decodeURIComponent(p.split('/').filter(Boolean).slice(-2)[0]||''),b=await body(req),rows=await readCollection('quotes.json'),q=rows.find(x=>x.id===id);
        if(!q)return send(res,404,{error:'Quotation not found.'});
        if(!q.tokenHash||!q.pricedAt||q.status!=='Quoted')return send(res,409,{error:'Save the quotation as Quoted before sending it.'});
        const accessToken=String(b.accessToken||'');if(!/^[a-f0-9]{64}$/.test(accessToken)||tokenHash(accessToken)!==q.tokenHash)return send(res,403,{error:'The current private link does not match this quotation. Save the quotation again and use its newest link.'});
        const host=String(process.env.PUBLIC_BASE_URL||'').trim().replace(/\/$/,'');if(!host||!/^https?:\/\//i.test(host))return send(res,503,{error:'Email sending is not configured: set PUBLIC_BASE_URL in the hosting environment.'});
        const required=['SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_PASS','SMTP_FROM'];if(required.some(k=>!String(process.env[k]||'').trim()))return send(res,503,{error:'Email sending is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and SMTP_FROM.'});
        if(!q.buyer||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(q.buyer.email||'')))return send(res,400,{error:'This quotation has no valid customer email address.'});
        let nodemailer;try{nodemailer=require('nodemailer')}catch{return send(res,503,{error:'Email module is not installed. Redeploy after installing project dependencies.'});}
        const link=host+'/quote-view.html?token='+encodeURIComponent(accessToken),subject='Qingke Quotation '+q.id;
        const lines=(q.items||[]).map(i=>`<tr><td style=\"padding:8px;border:1px solid #ddd\">${String(i.productName||i.model||'Product').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]))}</td><td style=\"padding:8px;border:1px solid #ddd\">${Number(i.quantity||1)}</td><td style=\"padding:8px;border:1px solid #ddd\">${q.currency} ${Number(i.unitPrice||0).toFixed(2)}</td><td style=\"padding:8px;border:1px solid #ddd\">${q.currency} ${Number(i.lineTotal||0).toFixed(2)}</td></tr>`).join('');
        const safeName=String(q.buyer.name||'Customer').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));
        const transporter=nodemailer.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||587),secure:String(process.env.SMTP_SECURE||'false').toLowerCase()==='true',auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS},connectionTimeout:10000,greetingTimeout:10000,socketTimeout:15000});
        try{const result=await transporter.sendMail({from:process.env.SMTP_FROM,to:q.buyer.email,subject,text:`Dear ${q.buyer.name||'Customer'},\n\nThank you for your inquiry. Your quotation ${q.id} is ready.\nView your private quotation: ${link}\n\nThis link is intended for you only.\n\nBest regards,\nQingke Sales Team`,html:`<div style=\"font-family:Arial,sans-serif;max-width:680px;margin:auto;color:#172033\"><h2>Qingke Commercial Quotation</h2><p>Dear ${safeName},</p><p>Thank you for your inquiry. Your quotation <b>${q.id}</b> is ready.</p><table style=\"border-collapse:collapse;width:100%\"><thead><tr><th style=\"padding:8px;border:1px solid #ddd;text-align:left\">Product</th><th style=\"padding:8px;border:1px solid #ddd\">Qty</th><th style=\"padding:8px;border:1px solid #ddd\">Unit price</th><th style=\"padding:8px;border:1px solid #ddd\">Line total</th></tr></thead><tbody>${lines}</tbody></table><p><b>Total: ${q.currency} ${Number(q.total||0).toFixed(2)}</b></p><p><a href=\"${link}\" style=\"display:inline-block;padding:12px 18px;background:#155eef;color:#fff;text-decoration:none;border-radius:6px\">View private quotation</a></p><p>This link is intended for you only. Please do not forward it.</p><p>Best regards,<br>Qingke Sales Team</p></div>`});
          const sentAt=new Date().toISOString();const recorded=await mutateCollection('quotes.json',records=>{const current=records.find(x=>x.id===id);if(!current)return {write:false,result:false};if(current.tokenHash!==q.tokenHash)return {write:false,result:false};current.emailSentAt=sentAt;current.emailSentTo=q.buyer.email;current.emailMessageId=result.messageId||'';return {rows:records,result:true};});if(!recorded)return send(res,409,{error:'邮件已发出，但报价在发送过程中发生变更，请核对客户收到的链接与最新报价。'});return send(res,200,{ok:true,sentTo:q.buyer.email,sentAt,message:'Quotation email sent successfully.'});
        }catch(e){console.error('Quotation email send failed:',e.message);return send(res,502,{error:'The email provider rejected or could not deliver the message. Check SMTP settings and server logs.'});}
      }
      if(p.startsWith('/api/quotes/') && p.endsWith('/convert-order') && req.method==='POST') {
        const id=decodeURIComponent(p.split('/').filter(Boolean).slice(-2)[0]||'');
        const now=new Date().toISOString();
        const outcome=await mutateCollections(['quotes.json','bank-transfers.json'], collections=>{
          const quotes=collections['quotes.json'], orders=collections['bank-transfers.json'];
          const qi=quotes.findIndex(x=>x.id===id);
          if(qi<0)return {write:false,result:{kind:'not-found'}};
          const q=quotes[qi];
          if(q.orderId){const existing=orders.find(x=>x.id===q.orderId);return {write:false,result:existing?{kind:'already',orderId:existing.id,status:existing.status,amount:existing.amount,currency:existing.currency}:{kind:'broken-reference'}};}
          if(q.status!=='Accepted'||q.customerResponse?.action!=='accept')return {write:false,result:{kind:'not-accepted'}};
          if(!q.buyer||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(q.buyer.email||'')))return {write:false,result:{kind:'bad-email'}};
          if(!Array.isArray(q.items)||!q.items.length||!Number.isFinite(Number(q.total))||Number(q.total)<0)return {write:false,result:{kind:'bad-total'}};
          const currency=String(q.currency||'USD').toUpperCase();if(!['USD','EUR','GBP','CNY','SAR','CAD','AUD'].includes(currency))return {write:false,result:{kind:'bad-currency'}};
          const orderId='KJ-QO-'+Date.now().toString(36).toUpperCase()+'-'+crypto.randomBytes(3).toString('hex').toUpperCase();
          const items=q.items.map(i=>({id:'quote:'+q.id+':'+String(i.lineId||crypto.randomUUID()),skuId:'',skuName:'',model:String(i.productName||i.model||'Quoted product').slice(0,200),category:'',subcategory:'',group:'',specs:{customerParameters:String(i.parameters||'').slice(0,3000)},qty:Math.max(1,Math.min(100000,Math.floor(Number(i.quantity)||1))),unitPrice:Number(Number(i.unitPrice).toFixed(2)),currency}));
          const order={id:orderId,createdAt:now,status:'Awaiting payment',paymentMethod:'Bank Transfer (T/T) — Accepted quotation',currency,amount:Number(Number(q.total).toFixed(2)).toFixed(2),buyer:safeBuyer(q.buyer),items,orderNotes:'Created from accepted quotation '+q.id+'\nTerms: '+String(q.terms||'').slice(0,2500),quotationId:q.id,quotationSubtotal:Number(Number(q.subtotal||0).toFixed(2)).toFixed(2),shipping:Number(Number(q.shipping||0).toFixed(2)).toFixed(2),remittanceDate:'',proofPath:'',receivedAmount:'',receivedDate:'',shippingCarrier:'',trackingNumber:'',trackingUrl:'',shippedDate:'',deliveryStatus:'Not shipped',adminNote:'',history:[{at:now,status:'Awaiting payment',note:'Created from customer-accepted quotation '+q.id}]};
          orders.unshift(order);q.orderId=orderId;q.orderCreatedAt=now;q.updatedAt=now;quotes[qi]=q;
          return {collections:{'quotes.json':quotes,'bank-transfers.json':orders},result:{kind:'created',orderId,quotationId:q.id,status:order.status,amount:order.amount,currency}};
        }, next=>commitQuoteOrderTransaction(next['bank-transfers.json'],next['quotes.json']));
        if(outcome.kind==='not-found')return send(res,404,{error:'Quotation not found.'});
        if(outcome.kind==='not-accepted')return send(res,409,{error:'Only a quotation explicitly accepted by the customer can be converted to an order.'});
        if(outcome.kind==='bad-email')return send(res,400,{error:'Quotation buyer email is invalid.'});
        if(outcome.kind==='bad-total')return send(res,400,{error:'The quotation must have priced items and a valid total.'});
        if(outcome.kind==='bad-currency')return send(res,400,{error:'Unsupported order currency.'});
        if(outcome.kind==='broken-reference')return send(res,409,{error:'This quotation has an order reference but the order record is missing. Check the data backup before retrying.'});
        if(outcome.kind==='already')return send(res,200,{ok:true,alreadyConverted:true,orderId:outcome.orderId,message:'This quotation has already been converted to an order.'});
        return send(res,201,{ok:true,orderId:outcome.orderId,quotationId:outcome.quotationId,status:outcome.status,amount:outcome.amount,currency:outcome.currency,message:'Accepted quotation converted to a bank-transfer order.'});
      }
      if(p.startsWith('/api/quotes/') && req.method==='PUT') {
        const id=decodeURIComponent(p.split('/').pop()),b=await body(req);
        const saved=await mutateCollection('quotes.json',rows=>{const i=rows.findIndex(x=>x.id===id);if(i<0)return {write:false,result:{status:404,error:'Quotation not found.'}};const q=rows[i];
        const currency=String(b.currency||q.currency||'USD').toUpperCase();if(!['USD','EUR','GBP','CNY','SAR','CAD','AUD'].includes(currency))return {write:false,result:{status:400,error:'Unsupported quotation currency.'}};
        let items;try{items=Array.isArray(b.items)?b.items:JSON.parse(String(b.itemsJson||'[]'));}catch{return {write:false,result:{status:400,error:'Quotation lines must be valid JSON.'}};}if(!Array.isArray(items)||items.length!==q.items.length)return {write:false,result:{status:400,error:'Do not add or remove requested lines while pricing. Ask the customer to submit a new request for changed requirements.'}};
        const priced=[];let subtotal=0;for(let n=0;n<q.items.length;n++){const old=q.items[n],x=items[n];if(!x||typeof x!=='object')return {write:false,result:{status:400,error:'Quotation line is invalid.'}};const unit=Number(x.unitPrice);if(!Number.isFinite(unit)||unit<0||unit>100000000)return {write:false,result:{status:400,error:'Each unit price must be a valid non-negative number.'}};const quantity=old.quantity;const lineTotal=Number((unit*quantity).toFixed(2));subtotal+=lineTotal;priced.push({...old,unitPrice:Number(unit.toFixed(2)),lineTotal});}
        const shipping=b.shipping===''||b.shipping===null||b.shipping===undefined?0:Number(b.shipping);if(!Number.isFinite(shipping)||shipping<0)return {write:false,result:{status:400,error:'Shipping must be a non-negative number.'}};const total=Number((subtotal+shipping).toFixed(2));q.items=priced;q.currency=currency;q.subtotal=Number(subtotal.toFixed(2));q.shipping=Number(shipping.toFixed(2));q.total=total;q.validUntil=String(b.validUntil||'').slice(0,30);q.terms=String(b.terms||'').slice(0,3000);q.status=String(b.status||'Quoted')==='Draft'?'Draft':'Quoted';q.updatedAt=new Date().toISOString();q.pricedAt=new Date().toISOString();const accessToken=crypto.randomBytes(32).toString('hex');q.tokenHash=tokenHash(accessToken);rows[i]=q;const {tokenHash:discard,...safe}=q;return {rows,result:{status:200,quote:safe,accessToken}};});return send(res,saved.status,{ok:saved.status===200,...saved});
      }
      if(p==='/api/resources/upload' && req.method==='POST') {const b=await body(req);const m=String(b.data||'').match(/^data:application\/pdf;base64,([A-Za-z0-9+/=]+)$/);if(!m||String(b.mime)!=='application/pdf')return send(res,400,{error:'Upload a PDF manual.'});const buf=Buffer.from(m[1],'base64');if(buf.length>20*1024*1024)return send(res,413,{error:'PDF must be 20 MB or smaller.'});if(!mediaSignatureOk(buf,'pdf'))return send(res,400,{error:'文件内容不是 PDF，请重新上传。'});const dir=path.join(MEDIA,'manuals');fs.mkdirSync(dir,{recursive:true});const file='manual-'+Date.now().toString(36)+'-'+crypto.randomBytes(4).toString('hex')+'.pdf';fs.writeFileSync(path.join(dir,file),buf,{flag:'wx'});return send(res,201,{ok:true,path:'/media/manuals/'+file,size:buf.length});}
      // Atomic publication changes: do not overwrite simultaneous product edits.
      if(p==='/api/products/publication' && req.method==='PATCH') {
        const b=await body(req);
        if(!b||!Array.isArray(b.items)||!b.items.length||b.items.length>500||b.items.some(x=>!x||typeof x.id!=='string'||!x.id.trim()||typeof x.expected!=='boolean')||typeof b.published!=='boolean')return send(res,400,{error:'请提供商品 ID、原始上下架状态和目标状态。'});
        const ids=b.items.map(x=>x.id);
        if(new Set(ids).size!==ids.length)return send(res,400,{error:'不能提交重复的产品 ID。'});
        const result=await mutateCollection('products.json',rows=>{
          const byId=new Map(rows.map(x=>[String(x.id),x]));
          if(b.items.some(x=>!byId.has(x.id)))return {write:false,result:{status:409,error:'某些商品已被删除，请刷新商品列表。'}};
          if(b.items.some(x=>(byId.get(x.id).published!==false)!==x.expected))return {write:false,result:{status:409,error:'某些商品的上下架状态已改变，请刷新重试。'}};
          const chosen=new Set(ids);
          return {rows:rows.map(x=>chosen.has(String(x.id))?{...x,published:b.published}:x),result:{status:200,count:ids.length}};
        });return send(res,result.status,{ok:result.status===200,...result});
      }
      // Atomically rename category/subcategory and its assigned products.
      if(p==='/api/catalogue/taxonomy' && req.method==='PATCH') {
        const b=await body(req),type=String(b.type||''),category=String(b.category||''),previous=String(b.previous||''),next=String(b.next||'').trim();
        if(!['major','sub'].includes(type)||!category.trim()||!next||next.length>150||(type==='sub'&&!previous.trim()))return send(res,400,{error:'请选择有效的分类和新名称。'});
        const categoryRevision=String(req.headers['if-match']||'').trim(),productListRevision=String(req.headers['x-product-revision']||'').trim();
        if(!categoryRevision||!productListRevision)return send(res,428,{error:'分类或产品版本缺失，请刷新后台后重试。'});
        const result=await mutateCollections(['categories.json','products.json'],collections=>{
          const cats=collections['categories.json'],prods=collections['products.json'];
          if(productsRevision(cats)!==categoryRevision||productsRevision(prods)!==productListRevision)return {write:false,result:{status:409,error:'分类或产品已被其他页面修改，请刷新后重新操作。'}};
          const cat=cats.find(x=>x.name===category);
          if(!cat)return {write:false,result:{status:409,error:'原分类已不存在。'}};
          if(type==='major'){
            if(cats.some(x=>x!==cat&&String(x.name).toLowerCase()===next.toLowerCase()))return {write:false,result:{status:409,error:'一级分类名称已存在。'}};
            cat.name=next;cat.slug=next.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'category';
            for(const product of prods)if(product.category===category)product.category=next;
          }else{
            if(!cat.subcategories.includes(previous))return {write:false,result:{status:409,error:'原二级分类已不存在。'}};
            if(cat.subcategories.some(x=>x!==previous&&x.toLowerCase()===next.toLowerCase()))return {write:false,result:{status:409,error:'二级分类名称已存在。'}};
            cat.subcategories=cat.subcategories.map(x=>x===previous?next:x);
            for(const product of prods)if(product.category===category&&product.subcategory===previous)product.subcategory=next;
          }
          return {collections,result:{status:200,affected:prods.filter(x=>x.category===(type==='major'?next:category)&&(type==='major'||x.subcategory===next)).length}};
        },commitCatalogueTransaction);
        return send(res,result.status,{ok:result.status===200,...result});
      }
      // Scoped product mutations prevent editing one product from overwriting another.
      if(p==='/api/products' && req.method==='POST') {
        const b=await body(req), rec=b.product;
        const error=validAdminProduct(rec);if(error)return send(res,400,{error});
        const result=await mutateCollection('products.json',rows=>{
          if(rows.some(x=>String(x.id)===rec.id))return {write:false,result:{status:409,error:'该产品 ID 已存在，请修改名称后重新创建。'}};
          rows.unshift(rec);return {rows,result:{status:201,product:rec}};
        });return send(res,result.status,{ok:result.status===201,...result});
      }
      if(p.startsWith('/api/products/') && !['/api/products/publication'].includes(p) && (req.method==='PUT'||req.method==='DELETE')) {
        let id;try{id=decodeURIComponent(p.slice('/api/products/'.length));}catch{return send(res,400,{error:'产品 ID 编码无效。'});}
        if(!id||id.includes('/')||id.length>160)return send(res,400,{error:'产品 ID 无效。'});
        const b=await body(req);
        if(!b || !b.expected || typeof b.expected!=='object' || Array.isArray(b.expected))return send(res,428,{error:'缺少原始产品版本，请刷新后台后重试。'});
        if(req.method==='PUT') {const error=validAdminProduct(b.product);if(error)return send(res,400,{error});if(b.product.id!==id)return send(res,400,{error:'产品 ID 不允许在编辑时修改。'});}
        const result=await mutateCollection('products.json',rows=>{
          const index=rows.findIndex(x=>String(x.id)===id);
          if(index<0)return {write:false,result:{status:409,error:'产品已被其他页面删除，请刷新后重试。'}};
          if(JSON.stringify(rows[index])!==JSON.stringify(b.expected))return {write:false,result:{status:409,error:'该产品已被其他管理员或页面更新，请复制未保存的内容，刷新后再编辑。'}};
          if(req.method==='DELETE'){rows.splice(index,1);return {rows,result:{status:200}};}
          rows[index]=b.product;return {rows,result:{status:200,product:b.product}};
        });return send(res,result.status,{ok:result.status===200,...result});
      }
      // Legacy list-wide operations remain available, with If-Match optimistic locking.
      if(p==='/api/products' && req.method==='PUT') {
        const b=await body(req);
        if(!Array.isArray(b)||b.length>20000)return send(res,400,{error:'需要不超过 20000 条的产品数组。'});
        const ids=new Set();for(const x of b){const error=validAdminProduct(x);if(error)return send(res,400,{error});if(ids.has(x.id))return send(res,400,{error:'整份产品列表中存在重复的产品 ID。'});ids.add(x.id);}
        const revision=String(req.headers['if-match']||'').trim();
        const result=await mutateCollection('products.json',rows=>{
          if(revision && revision!==productsRevision(rows))return {write:false,result:{status:409,error:'产品列表已在其他页面改变。请刷新后重新操作，避免覆盖新数据。'}};
          return {rows:b,result:{status:200,count:b.length}};
        });if(result.status===200)res.setHeader('ETag',productsRevision(b));
        return send(res,result.status,{ok:result.status===200,...result});
      }
      if(p==='/api/categories' && req.method==='PUT') {const b=await body(req); if(!Array.isArray(b)||b.length>100||b.some(c=>!c||typeof c.name!=='string'||!c.name.trim()||c.name.length>150||!Array.isArray(c.subcategories)||c.subcategories.length>300||c.subcategories.some(x=>typeof x!=='string'||!x.trim()||x.length>150)))return send(res,400,{error:'产品分类数据无效。'});const names=b.map(c=>String(c.name).trim().toLowerCase());if(new Set(names).size!==names.length||b.some(c=>new Set(c.subcategories.map(x=>x.trim().toLowerCase())).size!==c.subcategories.length))return send(res,400,{error:'一级或二级分类名称不能重复。'});const revision=String(req.headers['if-match']||'').trim();const result=await mutateCollection('categories.json',rows=>{if(revision&&revision!==productsRevision(rows))return {write:false,result:{status:409,error:'分类已被其他页面更新，请刷新后重试。'}};return {rows:b,result:{status:200,count:b.length}}});if(result.status===200)res.setHeader('ETag',productsRevision(b));return send(res,result.status,{ok:result.status===200,...result});}
      if(p==='/api/images' && req.method==='POST') {const b=await body(req); const match=String(b.data||'').match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);if(!match)return send(res,400,{error:'Upload a PNG, JPG or WebP image.'});const buf=Buffer.from(match[2],'base64');if(buf.length>5*1024*1024)return send(res,413,{error:'Image must be 5 MB or smaller.'});if(!mediaSignatureOk(buf,match[1]))return send(res,400,{error:'文件内容不是有效的图片格式，请重新上传。'});const ext=match[1]==='jpeg'?'jpg':match[1];const dir=path.join(MEDIA,'images');fs.mkdirSync(dir,{recursive:true});const file='product-'+Date.now().toString(36)+'-'+crypto.randomBytes(4).toString('hex')+'.'+ext;fs.writeFileSync(path.join(dir,file),buf,{flag:'wx'});return send(res,201,{ok:true,path:'/media/images/'+file,size:buf.length});}
      if(p==='/api/settings' && req.method==='PUT') {const b=await body(req);if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>['__proto__','constructor','prototype'].includes(k)))return send(res,400,{error:'网站设置必须是有效的字段对象。'});const patch={...b}; if(Object.prototype.hasOwnProperty.call(patch,'productGroupImages')){const images=patch.productGroupImages;if(!images||typeof images!=='object'||Array.isArray(images)||Object.keys(images).length>500||Object.entries(images).some(([k,v])=>k.length>450||['__proto__','constructor','prototype'].includes(k)||typeof v!=='string'||!validHomeDestination(v)||(v&&!/^(?:\/media\/images\/|assets\/|\/assets\/)/i.test(v))))return send(res,400,{error:'产品分组图片配置无效。'});}if(Object.prototype.hasOwnProperty.call(patch,'homeCarousel')){if(!Array.isArray(patch.homeCarousel)||patch.homeCarousel.length>10)return send(res,400,{error:'首页轮播最多可设置10张图片。'});if(!patch.homeCarousel.every(x=>x&&typeof x==='object'&&!Array.isArray(x)&&validHomeDestination(x.href===undefined?'':x.href)&&validHomeDestination(x.image===undefined?'':x.image)))return send(res,400,{error:'轮播图包含不安全的图片或链接地址。'});patch.homeCarousel=patch.homeCarousel.map((x,i)=>{let href=String(x.href||'').trim().slice(0,500);let image=String(x.image||'').trim().slice(0,500);if(href&&!href.startsWith('/')&&!/^(https?:|mailto:)/i.test(href))href='';if(image&&!image.startsWith('/')&&!/^(https?:)/i.test(image)&&!/^assets\//i.test(image))image='';return {id:String(x.id||('slide-'+(i+1))).slice(0,80),enabled:x.enabled!==false,order:Number.isFinite(Number(x.order))?Math.max(1,Math.min(99,Math.floor(Number(x.order)))):i+1,title:String(x.title||'').slice(0,160),text:String(x.text||'').slice(0,500),image,href,buttonText:String(x.buttonText||'').slice(0,80)};});} if(Object.prototype.hasOwnProperty.call(patch,'homeVisualContent')){const v=patch.homeVisualContent;if(!v||typeof v!=='object'||Array.isArray(v))return send(res,400,{error:'Invalid homepage content.'});const allowed=['categories','featured','applications','advantages','news'];for(const k of allowed){if(v[k]!==undefined&&(!Array.isArray(v[k])||v[k].length>20))return send(res,400,{error:'Homepage group exceeds 20 items.'});}if(!validHomeVisualDestinations(v))return send(res,400,{error:'首页链接或图片地址不安全，请检查后保存。'});const raw=JSON.stringify(v);if(raw.length>150000)return send(res,413,{error:'Homepage settings too large.'});} if(Object.prototype.hasOwnProperty.call(patch,'homeModules')){ if(!Array.isArray(patch.homeModules)||patch.homeModules.length>32)return send(res,400,{error:'Home layout must be a list of at most 32 modules.'}); const allowed=new Set(defaultHomeModules().map(x=>x.id)); const seen=new Set(); for(const m of patch.homeModules){if(!m||!allowed.has(String(m.id))||seen.has(String(m.id)))return send(res,400,{error:'Invalid or duplicate home module.'});if(!validHomeDestination(m.href===undefined?'':m.href)||!validHomeDestination(m.image===undefined?'':m.image))return send(res,400,{error:'首页模块包含不安全的图片或链接地址。'});seen.add(String(m.id));} patch.homeModules=patch.homeModules.map((m,i)=>{const size=['full','wide','half','third'].includes(m.size)?m.size:'full';let href=String(m.href||'').trim().slice(0,500);if(href&&!href.startsWith('/')&&!/^(https?:|mailto:)/i.test(href))href='';return {id:String(m.id),enabled:!!m.enabled,order:Number.isFinite(Number(m.order))?Math.max(1,Math.min(99,Math.floor(Number(m.order)))):i+1,size,title:String(m.title||'').slice(0,160),text:String(m.text||'').slice(0,1200),buttonText:String(m.buttonText||'').slice(0,80),href,image:String(m.image||'').slice(0,500)};}); } await mutateDocument('settings.json',current=>({document:{...current,...patch},result:true}));return send(res,200,{ok:true});}
      if(p==='/api/inquiries' && req.method==='GET') return send(res,200,await readCollection('inquiries.json'));
      if(p==='/api/payments' && req.method==='GET') return send(res,200,await readCollection('payments.json')); 
      if(p==='/api/bank-transfers' && req.method==='GET') return send(res,200,await readCollection('bank-transfers.json'));
      if(p==='/api/crm' && req.method==='GET') return send(res,200,await readCollection('crm.json'));
      if(p.startsWith('/api/crm/') && req.method==='PATCH') {const id=decodeURIComponent(p.split('/').pop()).toLowerCase(),b=await body(req);if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id)||id.length>254)return send(res,400,{error:'客户邮箱无效。'});const rec={email:id,stage:String(b.stage||'Lead').slice(0,60),owner:String(b.owner||'').slice(0,120),nextFollowUp:String(b.nextFollowUp||'').slice(0,30),notes:String(b.notes||'').slice(0,5000),updatedAt:new Date().toISOString()};await mutateCollection('crm.json',rows=>{const i=rows.findIndex(x=>String(x.email||'').toLowerCase()===id);if(i<0)rows.unshift(rec);else rows[i]={...rows[i],...rec};return {rows,result:true};});return send(res,200,{ok:true,record:rec});}
      if(p.startsWith('/api/bank-transfers/') && req.method==='PATCH') {
        const id=decodeURIComponent(p.split('/').pop()),b=await body(req);
        const allowed=['Awaiting payment','Awaiting verification','Paid','Refunded','Cancelled'];
        if(!allowed.includes(b.status))return send(res,400,{error:'Invalid payment status.'});
        const outcome=await mutateCollection('bank-transfers.json',records=>{
          const i=records.findIndex(x=>x.id===id);if(i<0)return {write:false,result:{kind:'missing'}};
          const record=records[i];
          const receivedAmount=b.receivedAmount!==undefined?String(b.receivedAmount).slice(0,40):String(record.receivedAmount||'');
          const receivedDate=b.receivedDate!==undefined?String(b.receivedDate).slice(0,30):String(record.receivedDate||'');
          if(b.status==='Paid'&&(!receivedAmount.trim()||!receivedDate.trim()))return {write:false,result:{kind:'missing-payment-details'}};
          if(b.status==='Paid'){
            const actual=Number(receivedAmount),expected=Number(record.amount);
            if(!Number.isFinite(actual)||actual<=0)return {write:false,result:{kind:'invalid-received-amount'}};
            if(Number.isFinite(expected)&&expected>0&&record.currency&&Math.abs(actual-expected)>0.01)return {write:false,result:{kind:'amount-mismatch',expected:record.amount,currency:record.currency}};
          }
          record.status=b.status;
          if(b.remittanceDate!==undefined)record.remittanceDate=String(b.remittanceDate).slice(0,30);
          if(b.receivedAmount!==undefined)record.receivedAmount=receivedAmount;
          if(b.receivedDate!==undefined)record.receivedDate=receivedDate;
          if(b.shippingCarrier!==undefined)record.shippingCarrier=String(b.shippingCarrier).slice(0,160);
          if(b.trackingNumber!==undefined)record.trackingNumber=String(b.trackingNumber).slice(0,160);
          if(b.trackingUrl!==undefined){const url=String(b.trackingUrl).trim();if(url&&!/^https:\/\//i.test(url))return {write:false,result:{kind:'invalid-tracking-url'}};record.trackingUrl=url.slice(0,500);}
          if(b.shippedDate!==undefined)record.shippedDate=String(b.shippedDate).slice(0,30);
          if(b.deliveryStatus!==undefined)record.deliveryStatus=String(b.deliveryStatus).slice(0,80);
          if(b.adminNote!==undefined)record.adminNote=String(b.adminNote).slice(0,2000);
          if(b.proofPath!==undefined)record.proofPath=String(b.proofPath).slice(0,500);
          record.history=Array.isArray(record.history)?record.history:[];
          record.history.push({at:new Date().toISOString(),status:b.status,note:String(b.adminNote||'').slice(0,500)});
          records[i]=record;return {rows:records,result:{kind:'ok',record}};
        });
        if(outcome.kind==='missing')return send(res,404,{error:'Bank transfer record not found.'});
        if(outcome.kind==='missing-payment-details')return send(res,400,{error:'Enter actual received amount and date before marking Paid.'});
        if(outcome.kind==='invalid-received-amount')return send(res,400,{error:'Actual received amount must be a positive number.'});
        if(outcome.kind==='amount-mismatch')return send(res,400,{error:'Received amount does not match the order total. Verify the bank receipt before marking Paid.',expected:outcome.expected,currency:outcome.currency});
        if(outcome.kind==='invalid-tracking-url')return send(res,400,{error:'Tracking URL must start with https://'});
        return send(res,200,{ok:true,record:outcome.record});
      }

      if(p.startsWith('/api/inquiries/') && req.method==='PATCH') {const id=decodeURIComponent(p.split('/').pop()),b=await body(req);if(!['New','In progress','Replied','Closed'].includes(b.status))return send(res,400,{error:'询盘状态无效。'});const result=await mutateCollection('inquiries.json',items=>{const i=items.findIndex(x=>x.id===id);if(i<0)return {write:false,result:{status:404,error:'询盘不存在。'}};items[i].status=b.status;return {rows:items,result:{status:200}};});return send(res,result.status,{ok:result.status===200,...result});}
      if(p.startsWith('/api/inquiries/') && req.method==='DELETE') {const id=decodeURIComponent(p.split('/').pop());const result=await mutateCollection('inquiries.json',rows=>{if(!rows.some(x=>x.id===id))return {write:false,result:{status:404,error:'询盘不存在。'}};return {rows:rows.filter(x=>x.id!==id),result:{status:200}};});return send(res,result.status,{ok:result.status===200,...result});}
      return send(res,404,{error:'API endpoint not found.'});
    }
    if (p.startsWith('/media/')) {
      const rel = p.slice('/media/'.length);
      const mediaPath = path.resolve(MEDIA, rel);
      if (!mediaPath.startsWith(MEDIA + path.sep) || rel.split('/').some(part => !part || part.startsWith('.'))) { res.writeHead(403); return res.end('Forbidden'); }
      if (!fs.existsSync(mediaPath) || !fs.statSync(mediaPath).isFile()) { res.writeHead(404); return res.end('Not found'); }
      const ext = path.extname(mediaPath).toLowerCase();
      if (!['.pdf','.png','.jpg','.jpeg','.webp'].includes(ext)) { res.writeHead(415); return res.end('Unsupported media type'); }
      res.writeHead(200, {'Content-Type': mime(mediaPath), 'X-Content-Type-Options':'nosniff', 'Cache-Control':'public, max-age=3600'});
      return fs.createReadStream(mediaPath).pipe(res);
    }
    let requested=decodeURIComponent(p==='/'?'/index.html':p);
    if (requested.startsWith('/data/') || requested === '/data' || requested.startsWith('/data-seed/') || requested === '/data-seed' || ['/server.js','/package.json','/package-lock.json'].includes(requested) || requested.split('/').some(part => part.startsWith('.'))) { res.writeHead(404); return res.end('Not found'); }
    if (!publicStaticPath(requested)) {res.writeHead(404);return res.end('Not found');}
    let file=path.resolve(ROOT,'.'+requested); if(!file.startsWith(ROOT+path.sep)) {res.writeHead(403);return res.end('Forbidden');} if(!fs.existsSync(file)||fs.statSync(file).isDirectory()){res.writeHead(404);return res.end('Not found');} res.writeHead(200,{'Content-Type':mime(file),'X-Content-Type-Options':'nosniff','X-Frame-Options':'SAMEORIGIN','Referrer-Policy':'strict-origin-when-cross-origin','Cache-Control': requested.endsWith('.html') ? 'no-cache' : 'public, max-age=3600'});fs.createReadStream(file).pipe(res);
  } catch(e){console.error(e);send(res,500,{error:'Server error. Check server log.'});}
});
server.listen(PORT,'0.0.0.0',()=>{
  console.log(`Qingke CMS running on http://localhost:${PORT}`);
  processEmailOutbox().catch(e => console.error('Email outbox startup error:', String(e && e.message || e).slice(0, 300)));
});
const emailOutboxTimer = setInterval(() => {
  processEmailOutbox().catch(e => console.error('Email outbox worker error:', String(e && e.message || e).slice(0, 300)));
}, 15000);
if (emailOutboxTimer.unref) emailOutboxTimer.unref();
