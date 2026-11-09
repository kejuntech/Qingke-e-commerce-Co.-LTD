'use strict';
// Safe, auditable JSON -> PostgreSQL snapshot migration.
// Default is dry-run. --apply inserts only; it refuses to overwrite different data.
// --replace is an explicit destructive opt-in for keys whose payload changed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sha, keyFor } = require('./postgres-snapshot-keys');
const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const collections = ['products.json','settings.json','inquiries.json','categories.json','payments.json','bank-transfers.json','crm.json','customers.json','customer-sessions.json','admin-sessions.json','quotes.json','email-outbox.json'];
function load() {
  const out=[], manifest={};
  for (const name of collections) {
    const file=path.join(DATA,name);
    if (!fs.existsSync(file)) { console.log(`SKIP ${name}: file not present`); continue; }
    const parsed=JSON.parse(fs.readFileSync(file,'utf8'));
    const rows=Array.isArray(parsed)?parsed:[parsed];
    const collection=name.replace(/\.json$/,''); const keys=new Set();
    rows.forEach((payload,index)=>{
      const record_key=keyFor(name,payload,index);
      if(keys.has(record_key)) throw new Error(`Duplicate migration key in ${name}: ${record_key}. Resolve duplicate IDs/emails before migration.`);
      keys.add(record_key); out.push({collection,record_key,payload,payload_sha256:sha(payload),ordinal:index});
    });
    manifest[collection]={count:rows.length,sha256:sha(rows.map(x=>({key:keyFor(name,x,rows.indexOf(x)),payload_sha256:sha(x)})))};
    console.log(`READ ${name}: ${rows.length} record(s)`);
  }
  return {rows:out,manifest};
}
(async()=>{
  const {rows,manifest}=load();
  const byCollection={}; for(const row of rows)byCollection[row.collection]=(byCollection[row.collection]||0)+1;
  const runId=new Date().toISOString().replace(/[-:.TZ]/g,'')+'-'+crypto.randomBytes(4).toString('hex');
  console.log(`\nMigration run: ${runId}\nTotal records prepared: ${rows.length}`);
  console.log('Source manifest (collection: rows, content hash):');
  for(const [name,info] of Object.entries(manifest).sort(([a],[b])=>a.localeCompare(b))) console.log(`  ${name}: ${info.count}, ${info.sha256}`);
  if (!process.argv.includes('--apply')) { console.log('DRY RUN ONLY: database was not changed.'); return; }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for --apply.');
  const replace=process.argv.includes('--replace');
  const {Client}=require('pg');
  const client=new Client({connectionString:process.env.DATABASE_URL,ssl:process.env.PGSSLMODE==='disable'?false:{rejectUnauthorized:false}});
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(fs.readFileSync(path.join(__dirname,'..','db','postgres_snapshot_schema.sql'),'utf8'));
    const changed=[];
    for(const row of rows){
      const existing=await client.query('SELECT payload_sha256, payload FROM kejun_json_records WHERE collection=$1 AND record_key=$2 FOR UPDATE',[row.collection,row.record_key]);
      if(existing.rowCount){
        const oldHash=existing.rows[0].payload_sha256 || sha(existing.rows[0].payload);
        if(oldHash!==row.payload_sha256 && !replace) changed.push(`${row.collection}/${row.record_key}`);
      }
    }
    if(changed.length && !replace) throw new Error(`Refusing to overwrite ${changed.length} changed existing record(s). First conflicts: ${changed.slice(0,10).join(', ')}. Back up target DB, inspect differences, then explicitly use --replace if intended.`);
    for(const row of rows){
      if(replace){
        await client.query(`INSERT INTO kejun_json_records(collection,record_key,payload,payload_sha256,ordinal) VALUES($1,$2,$3::jsonb,$4,$5) ON CONFLICT(collection,record_key) DO UPDATE SET payload=EXCLUDED.payload,payload_sha256=EXCLUDED.payload_sha256,ordinal=EXCLUDED.ordinal,imported_at=NOW()`,[row.collection,row.record_key,JSON.stringify(row.payload),row.payload_sha256,row.ordinal]);
      } else {
        await client.query(`INSERT INTO kejun_json_records(collection,record_key,payload,payload_sha256,ordinal) VALUES($1,$2,$3::jsonb,$4,$5) ON CONFLICT(collection,record_key) DO NOTHING`,[row.collection,row.record_key,JSON.stringify(row.payload),row.payload_sha256,row.ordinal]);
      }
    }
    await client.query('INSERT INTO kejun_migration_runs(run_id,source_dir,row_count,manifest,applied) VALUES($1,$2,$3,$4::jsonb,TRUE)',[runId,DATA,rows.length,JSON.stringify(manifest)]);
    await client.query('COMMIT');
    console.log(`COMMITTED migration run ${runId}; replace=${replace}; rows prepared=${rows.length}.`);
    console.log('This is still a JSON snapshot import; live APIs are not switched to PostgreSQL.');
    console.log('Sensitive data warning: customer records and session/token hashes may be included. Restrict database access.');
  } catch(e) { await client.query('ROLLBACK'); throw e; }
  finally { await client.end(); }
})().catch(e=>{console.error('Migration failed:',e.message);process.exit(1)});
