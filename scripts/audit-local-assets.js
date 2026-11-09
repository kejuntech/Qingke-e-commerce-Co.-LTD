// Audit local asset references in HTML; external URLs and runtime templates are excluded.
const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..');
const pages=fs.readdirSync(root).filter(f=>f.endsWith('.html'));
const missing=[];let checked=0;
for(const page of pages){const html=fs.readFileSync(path.join(root,page),'utf8');const re=/(?:src|href)\s*=\s*["']([^"']+)["']/gi;let m;
while((m=re.exec(html))){const ref=m[1].split(/[?#]/)[0];if(!ref||/^(?:https?:|mailto:|tel:|data:|javascript:|#|\/\/|\{)/i.test(ref)||ref.includes('${'))continue;
if(ref.startsWith('/api/')||ref.startsWith('/uploads/'))continue;
const target=path.resolve(root,ref.replace(/^\//,''));if(!target.startsWith(root+path.sep))continue;
checked++;if(!fs.existsSync(target))missing.push({page,ref});}}
console.log(JSON.stringify({pages:pages.length,checked,missing},null,2));if(missing.length)process.exitCode=1;
