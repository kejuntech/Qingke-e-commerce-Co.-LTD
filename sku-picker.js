/* Qingke product-detail SKU option picker: independent specification groups. */
(function(){'use strict';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const currency=sku=>{const price=Number(sku.price);return sku.price!==null&&sku.price!==undefined&&String(sku.price).trim()!==''&&Number.isFinite(price)&&price>0?`${String(sku.currency||'USD')} ${price.toFixed(2)}`:'Price on request';};
function getGroups(product){
 const list=Array.isArray(product.skus)?product.skus:[];
 const allKeys=[...new Set(list.flatMap(s=>Object.keys(s.attributes||{})))];
 const saved=Array.isArray(product.skuGroups)?product.skuGroups:[];
 return allKeys.map(key=>{
  const info=saved.find(g=>String(g.name||[g.path,g.label].filter(Boolean).join(' / '))===key)||{};
  const values=[...new Set(list.map(s=>String(s.attributes?.[key]??'')).filter(Boolean))];
  // Only show values that really exist in a saved SKU. No phantom combination.
  return {key,label:String(info.label||key.split(' / ').pop()),values};
 });
}
window.kejunInitSkuPicker=function(product){
 const select=document.getElementById('skuSelect'),host=document.getElementById('skuChoiceGroups');
 if(!select||!host||!Array.isArray(product.skus)||!product.skus.length)return;
 const list=product.skus, groups=getGroups(product);
 if(!groups.length||list.some(s=>!groups.every(g=>typeof s.attributes?.[g.key]==='string'))){
  select.hidden=false;host.textContent='';return; // Legacy or irregular SKU records use the original safe dropdown.
 }
 const selected=Object.fromEntries(groups.map(g=>[g.key,String(list[0].attributes[g.key])]));
 const price=document.getElementById('selectedPrice'),buy=document.getElementById('buy'),add=document.getElementById('add');
 const image=document.querySelector('.detail-image img'),originalImage=image?.getAttribute('src')||'';
 select.hidden=true;select.style.display='none';const fallbackLabel=document.getElementById('skuFallbackLabel');if(fallbackLabel){fallbackLabel.hidden=true;fallbackLabel.style.display='none';}
 function match(s,filter){return Object.entries(filter).every(([key,value])=>s.attributes[key]===value);}
 function redraw(){
  const matching=list.filter(s=>match(s,selected));
  const chosen=matching.length===1?matching[0]:null;
  if(chosen){select.value=String(chosen.id);price.textContent=currency(chosen);if(image)image.src=chosen.image?('/'+String(chosen.image).replace(/^\//,'')):originalImage;}
  else {select.value='';price.textContent='该规格组合不可购买，请重新选择';if(image)image.src=originalImage;}
  if(add)add.disabled=!chosen;if(buy)buy.disabled=!chosen;
  for(const [gi,g] of groups.entries()){
   const buttons=host.querySelectorAll(`[data-group-index="${gi}"]`);
   for(const button of buttons){
    const value=button.dataset.optionValue;
    const feasible=list.some(s=>s.attributes[g.key]===value);
    button.disabled=!feasible;
    const active=selected[g.key]===value;
    button.classList.toggle('selected',active);button.setAttribute('aria-pressed',String(active));
   }
  }
 }
 host.innerHTML=groups.map((g,gi)=>`<fieldset class="sku-pick-group"><legend>${esc(g.label)}：<span data-selected-group="${gi}">${esc(selected[g.key])}</span></legend><div class="sku-pick-choices">${g.values.map(value=>`<button type="button" class="sku-pick-choice" data-group-index="${gi}" data-option-value="${esc(value)}" aria-pressed="false">${esc(value)}</button>`).join('')}</div></fieldset>`).join('');
 host.addEventListener('click',event=>{
  const btn=event.target.closest('button[data-group-index]');if(!btn||btn.disabled)return;
  const key=groups[Number(btn.dataset.groupIndex)].key;
  selected[key]=btn.dataset.optionValue;
  // Preserve other choices where possible; if the selected matrix is sparse,
  // choose compatible existing values instead of creating a nonexistent SKU.
  if(!list.some(s=>match(s,selected))){
   const compatible=list.find(s=>s.attributes[key]===selected[key]);
   if(compatible)for(const g of groups)if(g.key!==key)selected[g.key]=compatible.attributes[g.key];
  }
  groups.forEach((g,i)=>{const node=host.querySelector(`[data-selected-group="${i}"]`);if(node)node.textContent=selected[g.key];});
  redraw();
 });
 redraw();
};
})();
