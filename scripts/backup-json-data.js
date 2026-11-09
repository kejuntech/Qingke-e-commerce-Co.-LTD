#!/usr/bin/env node
'use strict';
// Safe JSON-data backup/verification/restore helper for Qingke V18.
// Usage:
//   node scripts/backup-json-data.js backup [backup-root]
//   node scripts/backup-json-data.js verify <backup-folder>
//   node scripts/backup-json-data.js restore <backup-folder> --dry-run
//   node scripts/backup-json-data.js restore <backup-folder> --apply
// Restore is intentionally blocked unless --apply is explicit.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const DEFAULT_BACKUP_ROOT = path.resolve(process.env.BACKUP_DIR || path.join(ROOT, 'backups'));
const JSON_FILES = ['products.json','settings.json','inquiries.json','categories.json','payments.json','bank-transfers.json','crm.json','customers.json','customer-sessions.json','admin-sessions.json','quotes.json','email-outbox.json','auth.json'];
const DIRS = ['uploads','private-proofs'];
// Product images are stored outside DATA_DIR in this project; back them up too.
const EXTERNAL_DIRS = [{ rel: 'site-assets/uploads', source: path.join(ROOT, 'assets', 'uploads'), target: path.join(ROOT, 'assets', 'uploads') }];
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
function fail(msg){console.error('ERROR: '+msg);process.exitCode=1;}
function copyTree(src,dst,rel='',manifest=[]){
  if(!fs.existsSync(src)) return manifest;
  const st=fs.lstatSync(src); if(st.isSymbolicLink()) throw new Error('Symbolic links are not allowed in backups: '+src);
  if(st.isDirectory()){fs.mkdirSync(dst,{recursive:true});for(const n of fs.readdirSync(src).sort())copyTree(path.join(src,n),path.join(dst,n),path.join(rel,n),manifest);}
  else if(st.isFile()){fs.mkdirSync(path.dirname(dst),{recursive:true});const bytes=fs.readFileSync(src);fs.writeFileSync(dst,bytes,{flag:'wx'});manifest.push({path:rel.replace(/\\/g,'/'),size:bytes.length,sha256:sha(bytes)});}
  return manifest;
}
function readManifest(folder){const p=path.join(folder,'manifest.json');if(!fs.existsSync(p))throw new Error('manifest.json is missing');const m=JSON.parse(fs.readFileSync(p,'utf8'));if(m.format!=='KEJUN_JSON_BACKUP_V1'||!Array.isArray(m.files))throw new Error('Unsupported backup manifest');return m;}
function verify(folder){const m=readManifest(folder);let bad=0,total=0;for(const f of m.files){if(typeof f.path!=='string'||f.path.startsWith('/')||f.path.split('/').includes('..')){console.error('Unsafe manifest path');bad++;continue;}const p=path.resolve(folder,'data',f.path);if(!p.startsWith(path.resolve(folder,'data')+path.sep)){console.error('Path escapes backup: '+f.path);bad++;continue;}if(!fs.existsSync(p)||!fs.statSync(p).isFile()){console.error('Missing: '+f.path);bad++;continue;}const b=fs.readFileSync(p);if(b.length!==f.size||sha(b)!==f.sha256){console.error('Hash/size mismatch: '+f.path);bad++;}else total++;}console.log(JSON.stringify({ok:bad===0,verified:total,failed:bad,createdAt:m.createdAt,sourceDataDir:m.sourceDataDir},null,2));return bad===0;}
function backup(root){fs.mkdirSync(root,{recursive:true});const stamp=new Date().toISOString().replace(/[:.]/g,'-');const folder=path.join(root,'kejun-backup-'+stamp);fs.mkdirSync(folder,{recursive:false});const outData=path.join(folder,'data');fs.mkdirSync(outData,{recursive:true});const manifest=[];
  for(const name of JSON_FILES){const src=path.join(DATA,name);if(fs.existsSync(src)){const b=fs.readFileSync(src);if(name.endsWith('.json'))JSON.parse(b.toString('utf8'));const dst=path.join(outData,name);fs.writeFileSync(dst,b,{flag:'wx'});manifest.push({path:name,size:b.length,sha256:sha(b)});}}
  for(const name of DIRS){const src=path.join(DATA,name);if(fs.existsSync(src))copyTree(src,path.join(outData,name),name,manifest);}
  for(const item of EXTERNAL_DIRS){if(fs.existsSync(item.source))copyTree(item.source,path.join(outData,item.rel),item.rel,manifest);}
  const doc={format:'KEJUN_JSON_BACKUP_V1',createdAt:new Date().toISOString(),sourceDataDir:DATA,files:manifest.sort((a,b)=>a.path.localeCompare(b.path)),note:'Contains private customer data and possibly admin credential hashes. Store securely; do not publish.'};fs.writeFileSync(path.join(folder,'manifest.json'),JSON.stringify(doc,null,2),{flag:'wx'});console.log(JSON.stringify({ok:true,backupFolder:folder,fileCount:manifest.length,totalBytes:manifest.reduce((s,x)=>s+x.size,0)},null,2));}
function restore(folder,apply){if(!verify(folder))throw new Error('Backup verification failed; restore cancelled.');const m=readManifest(folder);const root=path.resolve(folder,'data');
  // Validate all JSON payloads before touching current data.
  for(const f of m.files){if(f.path.endsWith('.json'))JSON.parse(fs.readFileSync(path.join(root,f.path),'utf8'));}
  if(!apply){console.log(JSON.stringify({ok:true,dryRun:true,filesToRestore:m.files.length,targetDataDir:DATA,message:'No files were changed. Re-run with --apply only after taking a current backup.'},null,2));return;}
  // Create a pre-restore backup first. If backup fails, no restore occurs.
  backup(DEFAULT_BACKUP_ROOT);
  for(const f of m.files){const rel=f.path.split('/');if(rel.some(x=>x==='..'||x==='.'||!x))throw new Error('Unsafe path in manifest');const src=path.resolve(root,f.path);let dst;
    if(f.path==='site-assets/uploads'||f.path.startsWith('site-assets/uploads/')){const suffix=f.path.slice('site-assets/uploads'.length).replace(/^\//,'');dst=path.resolve(ROOT,'assets','uploads',suffix);if(dst!==path.resolve(ROOT,'assets','uploads')&&!dst.startsWith(path.resolve(ROOT,'assets','uploads')+path.sep))throw new Error('Restore path escapes assets/uploads');}
    else {dst=path.resolve(DATA,f.path);if(!dst.startsWith(DATA+path.sep))throw new Error('Restore path escapes DATA_DIR');}
    fs.mkdirSync(path.dirname(dst),{recursive:true});const temp=dst+'.restore-'+crypto.randomBytes(5).toString('hex');fs.copyFileSync(src,temp);fs.renameSync(temp,dst);}
  console.log(JSON.stringify({ok:true,restored:m.files.length,targetDataDir:DATA,message:'Restore completed. Files absent from this backup were not deleted.'},null,2));}
const [cmd,arg,flag]=process.argv.slice(2);
try{
 if(cmd==='backup')backup(path.resolve(arg||DEFAULT_BACKUP_ROOT));
 else if(cmd==='verify'){if(!arg)throw new Error('Usage: verify <backup-folder>');if(!verify(path.resolve(arg)))process.exitCode=1;}
 else if(cmd==='restore'){if(!arg)throw new Error('Usage: restore <backup-folder> --dry-run|--apply');if(flag!=='--dry-run'&&flag!=='--apply')throw new Error('Restore requires explicit --dry-run or --apply');restore(path.resolve(arg),flag==='--apply');}
 else throw new Error('Usage: backup [backup-root] | verify <backup-folder> | restore <backup-folder> --dry-run|--apply');
}catch(e){fail(e.message);}
