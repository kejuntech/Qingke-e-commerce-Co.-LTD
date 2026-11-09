#!/usr/bin/env node
'use strict';
// Preview by default. Delete only explicitly with --apply.
const fs=require('node:fs');const path=require('node:path');
const root=path.resolve(process.env.BACKUP_DIR||path.join(__dirname,'..','backups'));
const keep=Math.max(1,Number(process.env.BACKUP_KEEP_COUNT||10));
const maxAgeDays=Math.max(1,Number(process.env.BACKUP_MAX_AGE_DAYS||90));
const apply=process.argv.includes('--apply');
if(!fs.existsSync(root)){console.log(JSON.stringify({ok:true,root,found:0,remove:[],apply},null,2));process.exit(0);}
const now=Date.now();const entries=fs.readdirSync(root,{withFileTypes:true}).filter(e=>e.isDirectory()&&e.name.startsWith('kejun-backup-')).map(e=>{const p=path.join(root,e.name);const st=fs.statSync(p);return {name:e.name,path:p,mtime:st.mtimeMs};}).sort((a,b)=>b.mtime-a.mtime);
const remove=entries.filter((e,i)=>i>=keep||(now-e.mtime)>maxAgeDays*86400000);
// Never remove folders without a Qingke backup manifest, even if the name matches.
const safe=remove.filter(e=>fs.existsSync(path.join(e.path,'manifest.json')));
if(apply){for(const e of safe)fs.rmSync(e.path,{recursive:true,force:false});}
console.log(JSON.stringify({ok:true,root,found:entries.length,keepCount:keep,maxAgeDays,candidates:safe.map(e=>e.name),removed:apply?safe.map(e=>e.name):[],dryRun:!apply,message:apply?'Prune completed.':'Preview only; pass --apply to delete listed backups.'},null,2));
