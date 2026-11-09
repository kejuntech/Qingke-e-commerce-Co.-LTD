#!/usr/bin/env node
'use strict';
// Local JSON store only. Dry-run by default. Preserves all existing products and manual edits.
const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..');
const input=JSON.parse(fs.readFileSync(path.join(root,'imports','brochure_20261024_new_products.json'),'utf8'));
const args=process.argv.slice(2),apply=args.includes('--apply'),optimize=args.includes('--optimize-existing-images');
const photoUpgrades=JSON.parse(fs.readFileSync(path.join(root,'imports','brochure_20261024_safe_legacy_photo_upgrades.json'),'utf8'));
const flag=args.find(x=>x.startsWith('--data-dir='));
const data=path.resolve(flag?flag.slice('--data-dir='.length):process.env.DATA_DIR||path.join(root,'data'));
if(process.env.DATABASE_URL||process.env.POSTGRES_URL||process.env.PGHOST){console.error('STOP: PostgreSQL configured. This JSON import tool cannot migrate a database.');process.exit(2);}
for(const f of ['products.json','categories.json'])if(!fs.existsSync(path.join(data,f))){console.error('Missing '+path.join(data,f));process.exit(2);}
const existing=JSON.parse(fs.readFileSync(path.join(data,'products.json'),'utf8'));
const cats=JSON.parse(fs.readFileSync(path.join(data,'categories.json'),'utf8'));
if(!Array.isArray(existing)||!Array.isArray(cats))throw Error('Invalid data file');
const identities=new Set(existing.flatMap(p=>[String(p.id||'').trim().toLowerCase(),String(p.model||'').trim().toLowerCase()]));
const additions=input.filter(x=>!identities.has(String(x.model).trim().toLowerCase())&&!identities.has(String(x.id).trim().toLowerCase()));
const upgradeMap=new Map(photoUpgrades.map(x=>[x.model,x]));
const photoChanges=existing.filter(x=>{const m=upgradeMap.get(x.model);return m&&x.image===m.oldImage;});
console.log(JSON.stringify({mode:apply?'apply':'dry-run',data,existing:existing.length,missing:additions.map(x=>x.model),optimizeExistingRequested:optimize,matchingOriginalPhotos:photoChanges.length,willPreserveOtherExistingFields:true} ,null,2));
if(!apply){console.log('DRY RUN ONLY. Add --apply to write with a backup.');process.exit(0)}
const backup=path.join(data,'brochure-import-backup-'+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(backup,{recursive:true,mode:0o700});
function atomicFile(f,obj){const file=path.join(data,f),temp=file+'.tmp-'+process.pid+'-'+Date.now();fs.writeFileSync(temp,JSON.stringify(obj,null,2)+'\n',{flag:'wx',mode:0o600});fs.renameSync(temp,file)}
for(const f of ['products.json','categories.json'])fs.copyFileSync(path.join(data,f),path.join(backup,f));
const updated=existing.map(x=>{const m=upgradeMap.get(x.model);return optimize&&m&&x.image===m.oldImage?{...x,image:m.optimizedImage}:x;});
const next=[...updated,...additions];if(new Set(next.map(x=>x.id)).size!==next.length)throw Error('Duplicate id abort');
const nextCats=[...cats];if(!nextCats.some(x=>x.name==='Control'))nextCats.push({name:'Control',slug:'control',subcategories:['Digital Display Controllers']});
atomicFile('products.json',next);atomicFile('categories.json',nextCats);
console.log('IMPORTED',additions.length,'OPTIMIZED',optimize?photoChanges.length:0,'backup:',backup);
