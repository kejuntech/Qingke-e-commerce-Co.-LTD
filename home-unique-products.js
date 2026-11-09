/* Qingke homepage: preserve layout while preventing repeated product photos/models
   across Product Categories and Featured Products, including legacy saved CMS settings. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.KEJUNHomeUniqueProducts=api;
})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  const uniqueCandidates=[{"title":"LCD Pressure Transmitter","description":"KJ-QK-YL-301 Series","image":"assets/catalog-optimized-20261024/kj-qk-yl-301.webp","href":"product.html?id=kj-qk-yl-301","productId":"kj-qk-yl-301","badge":"View Details"},{"title":"Ultrasonic Level Transmitter","description":"KEJUN501 Series","image":"assets/catalog-optimized-20261024/kejun501.webp","href":"product.html?id=kejun501","productId":"kejun501","badge":"View Details"},{"title":"Turbine Flow Meter","description":"LWGY-KEJUN Series","image":"assets/catalog-optimized-20261024/lwgy-kejun.webp","href":"product.html?id=lwgy-kejun","productId":"lwgy-kejun","badge":"View Details"},{"title":"Industrial Temperature Sensor","description":"KEJUN-WRN Series","image":"assets/catalog-optimized-20261024/kejun-wrn.webp","href":"product.html?id=kejun-wrn","productId":"kejun-wrn","badge":"View Details"},{"title":"Differential Pressure Transmitter","description":"KJ-QK-3051 Series","image":"assets/catalog-optimized-20261024/kj-qk-3051.webp","href":"product.html?id=kj-qk-3051","productId":"kj-qk-3051","badge":"View Details"}];
  const knownLegacyFeatured=/^assets\/reference-home\/featured-[1-5]\.jpg$/i;
  const clean=v=>String(v||'').trim().replace(/^\/+/, '').split(/[?#]/)[0].toLowerCase();
  function normalizeCategoriesAndFeatured(categories,featured){
    const cats=Array.isArray(categories)?categories:[];
    const cards=Array.isArray(featured)?featured:[];
    const usedPhotos=new Set(),usedProducts=new Set();
    cats.filter(x=>x&&x.enabled!==false).forEach(x=>{
      if(x.image)usedPhotos.add(clean(x.image));
      if(x.productId)usedProducts.add(String(x.productId).toLowerCase());
    });
    const fallback=()=>uniqueCandidates.find(x=>!usedPhotos.has(clean(x.image))&&!usedProducts.has(String(x.productId).toLowerCase()));
    const result=[];
    for(let i=0;i<cards.length;i++){
      const orig=cards[i];if(!orig){continue;}
      if(orig.enabled===false){result.push(orig);continue;}
      let item=orig;
      // Migrate the original demo cards when saved CMS settings still override defaults.
      if(knownLegacyFeatured.test(clean(item.image))){item={...orig,...(uniqueCandidates[i]||fallback()||orig)};}
      const repeated=(item.image&&usedPhotos.has(clean(item.image)))||(item.productId&&usedProducts.has(String(item.productId).toLowerCase()));
      if(repeated){
        const alternative=fallback();
        if(!alternative)continue; // never show an actual duplicate if every alternate is used
        item={...orig,...alternative};
      }
      if(item.image)usedPhotos.add(clean(item.image));
      if(item.productId)usedProducts.add(String(item.productId).toLowerCase());
      result.push(item);
    }
    return result;
  }
  return {normalizeCategoriesAndFeatured,uniqueCandidates};
});
