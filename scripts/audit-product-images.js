'use strict';
const fs=require('fs');const path=require('path');const assert=require('assert');
const root=path.resolve(__dirname,'..');
const products=JSON.parse(fs.readFileSync(path.join(root,'data','products.json'),'utf8'));
const suspect={
 'KJS3-2X/4X':'原图下部截断',
 'KJCS-102':'原图右侧、底部截断',
 'KJ-CL':'原图右侧、底部截断',
 'KJ-D9-2X-WX':'顶部紧贴边界，需复核整机',
 'KJ-D9-2X-T':'顶部紧贴边界，需复核整机'
};
let checked=0;const issues=[];const errors=[];let homeChecked=0;
function testImage(rel,model){
 const safe=String(rel||'').replace(/^\//,'').split(/[?#]/)[0];
 if(!safe||safe.includes('..')||!/^assets\//.test(safe)){errors.push(`${model}: invalid image path ${rel}`);return}
 const file=path.join(root,safe);if(!fs.existsSync(file)){errors.push(`${model}: missing ${safe}`);return}
 const b=fs.readFileSync(file);const png=b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
 const jpg=b[0]===0xff&&b[1]===0xd8&&b[b.length-2]===0xff&&b[b.length-1]===0xd9;
 const webp=b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP';
 if(!(png||jpg||webp)){errors.push(`${model}: unsupported/corrupt image signature ${safe}`);return}
 checked++;
}
for(const p of products){testImage(p.image,p.model||p.name||p.id);if(suspect[p.model])issues.push({model:p.model,image:p.image,review:suspect[p.model]})}
const homeDefaults=JSON.parse(fs.readFileSync(path.join(root,'home-visual-defaults.json'),'utf8'));
for(const group of ['hero','heroSlides','categories','featured','applications','news']){
  const src=homeDefaults[group];const items=Array.isArray(src)?src:(src?[src]:[]);
  for(const item of items){if(item&&item.image){testImage(item.image,`home ${group}: ${item.title||''}`);homeChecked++}}
}
for(const section of Object.values(homeDefaults.sections||{}))if(section&&section.image){testImage(section.image,'home module image');homeChecked++}

for(const f of ['index.html','products.html','product.html','cart.html','checkout.html','admin.html','styles.css','home-visual.css'])assert(fs.existsSync(path.join(root,f)),`missing ${f}`);
const style=fs.readFileSync(path.join(root,'styles.css'),'utf8');
const home=fs.readFileSync(path.join(root,'home-visual.css'),'utf8');
const catalog=fs.readFileSync(path.join(root,'products.html'),'utf8');
const detail=fs.readFileSync(path.join(root,'product.html'),'utf8');
for(const selector of ['.catalog-card .product-image img','.detail-image img','.cart-row img','.home-v18 .v18-product-image img','#imagePreview'])assert(style.includes(selector),`missing safe image selector ${selector}`);
for(const selector of ['.kh-categories .kh-card img','.kh-featured .kh-card img','.kh-hero-image img'])assert(home.includes(selector),`missing home-safe image selector ${selector}`);
assert(catalog.includes('@media(max-width:480px)')&&catalog.includes('grid-template-columns:minmax(0,1fr)'), 'missing phone single-column catalog layout');
assert(detail.includes('object-fit:contain!important'), 'detail image containment missing');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
for(const f of ['admin-image-audit.js','product-image-policy.js'])assert(server.includes(`'${f}'`),`static allowlist is missing ${f}`);
for(const f of ['products.html','product.html','cart.html'])assert(fs.readFileSync(path.join(root,f),'utf8').includes('product-image-policy.js'),`image policy not installed on ${f}`);
assert(fs.existsSync(path.join(root,'assets/product-photo-pending.svg')),'pending-photo visual is missing');
const report={date:'2026-10-24',productCount:products.length,homepageImageReferences:homeChecked,readableImageCount:checked,missingOrCorrupt:errors,manualReview:issues,pages:['home: categories/featured/hero/about','catalog: listing/filter/search','product: detail and SKU image','cart: thumbnail','admin: product image preview'],note:'CSS can prevent display clipping; cropped original pixels cannot be reconstructed without genuine replacement photos.'};
fs.writeFileSync(path.join(root,'PRODUCT_IMAGE_AUDIT_20261024.json'),JSON.stringify(report,null,2)+'\n');
console.log(`CHECKED product+home image references ${checked}/${products.length+homeChecked}; missing/corrupt ${errors.length}; manual review ${issues.length}`);
for(const x of issues)console.log(`REVIEW ${x.model}: ${x.review}`);
if(errors.length)throw Error(errors.join('\n'));
assert.strictEqual(checked,products.length+homeChecked);console.log('PASS full-site product image source and display-style static checks');
