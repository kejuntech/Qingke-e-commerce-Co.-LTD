'use strict';
// Read-only verification of source JSON against staged PostgreSQL snapshot rows.
const fs=require('node:fs'),path=require('node:path');
const { sha, keyFor } = require('./postgres-snapshot-keys');
const DATA=path.resolve(process.env.DATA_DIR||path.join(__dirname,'..','data'));
const collections=['products.json','settings.json','inquiries.json','categories.json','payments.json','bank-transfers.json','crm.json','customers.json','customer-sessions.json','admin-sessions.json','quotes.json','email-outbox.json'];
function loadSource(file){const p=path.join(DATA,file);if(!fs.existsSync(p))return {present:false,rows:[]};const v=JSON.parse(fs.readFileSync(p,'utf8'));return {present:true,rows:Array.isArray(v)?v:[v]};}
(async()=>{
 if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL is required. This script is read-only.');
 const {Client}=require('pg');const client=new Client({connectionString:process.env.DATABASE_URL,ssl:process.env.PGSSLMODE==='disable'?false:{rejectUnauthorized:false}});await client.connect();
 try{
  const exists=await client.query("SELECT to_regclass('public.kejun_json_records') AS table_name");if(!exists.rows[0].table_name)throw new Error('kejun_json_records table does not exist.');
  const result=await client.query('SELECT collection,record_key,payload,payload_sha256 FROM kejun_json_records');
  const db=new Map(result.rows.map(r=>[`${r.collection}\u0000${r.record_key}`,r]));let issues=0;
  console.log('Read-only payload-level source vs PostgreSQL snapshot verification:');
  for(const file of collections){const name=file.replace(/\.json$/,'');const src=loadSource(file);const seen=new Set();let matched=0,missing=0,changed=0;
   src.rows.forEach((item,index)=>{const key=keyFor(file,item,index),id=`${name}\u0000${key}`;if(seen.has(id)){changed++;issues++;return;}seen.add(id);const row=db.get(id);if(!row){missing++;issues++;return;}const expected=sha(item),actual=row.payload_sha256||sha(row.payload);if(expected!==actual){changed++;issues++;}else matched++;});
   const extras=[...db.keys()].filter(k=>k.startsWith(name+'\u0000')&&!seen.has(k)).length;issues+=extras;
   console.log(`${issues===0?'':' '} ${name}: source=${src.rows.length}, matched=${matched}, missing=${missing}, changed=${changed}, extra=${extras}${src.present?'':' (source file missing)'}`);
  }
  const extraCollections=[...new Set(result.rows.map(r=>r.collection))].filter(k=>!collections.includes(k+'.json'));
  if(extraCollections.length)console.log('Extra database collections: '+extraCollections.join(', '));
  console.log(`\nResult: ${issues===0?'PAYLOADS MATCH':'MISMATCHES FOUND'}; read-only check; this does not validate runtime cutover.`);if(issues)process.exitCode=2;
 }finally{await client.end();}
})().catch(e=>{console.error('Verification failed:',e.message);process.exit(1)});
