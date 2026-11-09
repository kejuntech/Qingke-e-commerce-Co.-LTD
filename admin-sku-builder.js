(()=>{
const $=s=>document.querySelector(s), form=$('#productForm'); if(!form)return;
const optionHost=$('#skuOptionRows'), variantsHost=$('#skuVariantRows'), status=$('#skuBuilderStatus'), jsonField=form.elements.skusJson;
let optionCount=0, variants=[], generatedOptionsSignature=null;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const slug=s=>String(s||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,36)||'option';
// Each specification group has an independent visibility checkbox, editable name,
// five-level directory path and independently enabled values.
let restoredGroupConfig=[];
function splitValues(text){return String(text||'').split(/[\n,，;；]/).map(x=>x.trim()).filter(Boolean);}
function addOption(name='',values='',config=null){
 const parts=String(name).split(' / ').map(x=>x.trim()).filter(Boolean),leaf=parts.pop()||'';
 const path=parts.join(' / '), item=config&&typeof config==='object'?config:{};
 const list=Array.isArray(item.values)?item.values.map(v=>typeof v==='string'?{name:v,enabled:true}:v):splitValues(values).map(v=>({name:v,enabled:true}));
 optionCount++;
 const row=document.createElement('section');row.className='sku-option-row';
 row.innerHTML=`<div class="sku-group-heading"><label class="sku-group-toggle"><input type="checkbox" data-group-enabled ${item.enabled===false?'':'checked'}><strong>前台展示并参与组合</strong></label><button type="button" class="smallbtn danger" data-option-remove>删除规格组</button></div><div class="sku-group-fields"><label>规格组名称（可修改）<input data-option-name maxlength="80" value="${esc(item.label||leaf)}" placeholder="例如 输出信号 / 螺纹 / 电源 / 测量范围"></label><label>规格目录（最多五级，可选）<input data-option-path value="${esc(item.path??path)}" placeholder="例如 电气参数 / 输出信号"></label></div><label class="sku-bulk-values">快速填写规格值（逗号或换行分隔）<textarea data-option-values rows="2" placeholder="例如 4-20mA, RS485, 0-10V">${esc(list.map(v=>v.name).join(', '))}</textarea></label><div class="sku-value-header"><strong>规格值</strong><span>勾选后参与组合</span></div><div class="sku-value-list" data-value-list></div><button type="button" class="smallbtn" data-value-add>＋ 添加规格值</button>`;
 const listHost=row.querySelector('[data-value-list]'), bulk=row.querySelector('[data-option-values]');
 function drawValues(entries){listHost.innerHTML='';entries.forEach(entry=>{
  const el=document.createElement('div');el.className='sku-value-entry';el.innerHTML=`<input type="checkbox" data-value-enabled aria-label="启用规格值" ${entry.enabled===false?'':'checked'}><input data-value-name maxlength="160" aria-label="规格值名称" value="${esc(entry.name)}" placeholder="例如 4-20mA"><button type="button" data-value-delete class="smallbtn danger" aria-label="删除这个规格值">×</button>`;
  el.querySelector('[data-value-delete]').onclick=()=>{el.remove();syncBulk();};
  el.querySelector('[data-value-name]').addEventListener('input',syncBulk);
  listHost.append(el);
 });}
 function syncBulk(){bulk.value=[...listHost.querySelectorAll('[data-value-name]')].map(x=>x.value).filter(Boolean).join(', ');}
 function fromBulk(){const prev=new Map([...listHost.querySelectorAll('.sku-value-entry')].map(el=>[el.querySelector('[data-value-name]').value.trim(),el.querySelector('[data-value-enabled]').checked]));drawValues(splitValues(bulk.value).map(name=>({name,enabled:prev.has(name)?prev.get(name):true})));}
 bulk.addEventListener('change',fromBulk);
 row.querySelector('[data-value-add]').onclick=()=>{const el={name:'',enabled:true}; const existing=[...listHost.querySelectorAll('.sku-value-entry')].map(x=>({name:x.querySelector('[data-value-name]').value,enabled:x.querySelector('[data-value-enabled]').checked}));drawValues([...existing,el]);listHost.querySelector('.sku-value-entry:last-child [data-value-name]')?.focus();};
 row.querySelector('[data-option-remove]').onclick=()=>{if(!window.confirm('删除这个规格组？请重新生成组合后才会更改 SKU。'))return;row.remove();status.textContent='规格组已删除，需重新生成并确认 SKU 变化。';};
 drawValues(list);optionHost.append(row);return row;
}
function readGroupConfig(){
 const rows=[...optionHost.querySelectorAll('.sku-option-row')];const names=new Set();
 return rows.map(row=>{
  const name=row.querySelector('[data-option-name]').value.trim(),path=row.querySelector('[data-option-path]').value.trim();
  if(!name)throw Error('请填写规格组名称。');
  if(name.includes('/')||name.length>80)throw Error('规格组名称不可包含 /，且最多80个字符。');
  const parts=path?path.split('/').map(v=>v.trim()):[];
  if(parts.length>5||parts.some(v=>!v||v.length>80))throw Error('规格目录最多五级，每级必须填写名称。');
  const key=[...parts,name].join(' / '), normalized=key.toLocaleLowerCase();
  if(names.has(normalized))throw Error('规格组目录及名称不能重复。');names.add(normalized);
  const values=[...row.querySelectorAll('.sku-value-entry')].map(el=>({name:el.querySelector('[data-value-name]').value.trim(),enabled:el.querySelector('[data-value-enabled]').checked}));
  if(values.some(v=>!v.name))throw Error(`规格组“${name}”含有空白规格值，请填写或删除。`);
  if(values.some(v=>v.name.length>160))throw Error('规格值不能超过160个字符。');
  if(new Set(values.map(v=>v.name.toLocaleLowerCase())).size!==values.length)throw Error(`规格组“${name}”存在重复规格值。`);
  const enabled=row.querySelector('[data-group-enabled]').checked;
  if(enabled&&!values.some(v=>v.enabled))throw Error(`规格组“${name}”已经勾选展示，请至少勾选一个规格值。`);
  return {path:parts.join(' / '),label:name,name:key,enabled,values};
 });
}
function readOptions(){return readGroupConfig().filter(g=>g.enabled).map(g=>({name:g.name,values:g.values.filter(v=>v.enabled).map(v=>v.name)}));}
function combinations(opts){return opts.reduce((acc,o)=>acc.flatMap(a=>o.values.map(v=>({...a,[o.name]:v}))),[{}]);}
function readExisting(){try{const arr=JSON.parse(jsonField.value||'[]');return Array.isArray(arr)?arr:[]}catch{return []}}
let lastBulkSnapshot=null;
function renderVariants(){lastBulkSnapshot=null;if(!variants.length){variantsHost.innerHTML='';return}variantsHost.innerHTML=`<table style="width:100%;border-collapse:collapse"><thead><tr><th style="padding:7px"><input type="checkbox" id="skuSelectAll" aria-label="全选 SKU"></th><th style="text-align:left;padding:7px">属性组合</th><th style="text-align:left;padding:7px">SKU ID</th><th style="text-align:left;padding:7px">价格 (USD)</th><th style="text-align:left;padding:7px">库存（选填）</th><th style="text-align:left;padding:7px">图片路径（选填）</th></tr></thead><tbody>${variants.map((v,i)=>`<tr data-variant-index="${i}"><td style="padding:7px"><input type="checkbox" data-sku-select aria-label="选择 SKU ${i+1}"></td><td style="padding:7px;min-width:160px">${Object.entries(v.attributes).map(([k,val])=>`<span class="spec">${esc(k)}: ${esc(val)}</span>`).join(' ')}</td><td style="padding:7px"><input data-sku-id value="${esc(v.id)}" required style="min-width:120px"></td><td style="padding:7px"><input data-sku-price type="number" min="0.01" step="0.01" value="${v.price??''}" required style="width:110px"></td><td style="padding:7px"><input data-sku-stock type="number" min="0" step="1" value="${v.inventoryQuantity??''}" style="width:90px"></td><td style="padding:7px"><input data-sku-image value="${esc(v.image||'')}" placeholder="assets/..." style="min-width:150px"></td></tr>`).join('')}</tbody></table><div class="tax-card" style="margin-top:12px;padding:12px"><label>筛选 SKU（编码或规格）<input id="skuFilter" type="search" placeholder="输入型号、编码或规格关键词"></label><span id="skuFilterCount" aria-live="polite"></span><button type="button" class="secondary" id="skuSelectVisible">勾选当前筛选结果</button><button type="button" class="secondary" id="skuClearSelection">清空勾选</button></div><div class="tax-card" style="margin-top:12px;padding:12px"><strong>批量编辑选中的 SKU</strong><p class="product-toolbar-note">先勾选行；留空的字段不会更改。批量修改后仍需点击“应用组合”及“保存产品”。</p><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end"><label>统一价格 USD<input id="skuBulkPrice" type="number" min="0.01" step="0.01" placeholder="不修改"></label><label>统一库存<input id="skuBulkStock" type="number" min="0" step="1" placeholder="不修改"></label><label>SKU 编码前缀<input id="skuBulkPrefix" maxlength="32" placeholder="例如 PT2088-"></label><button type="button" class="secondary" id="skuBulkApply">批量应用到选中行</button><button type="button" class="secondary" id="skuBulkUndo" disabled>撤销上一次批量修改</button></div></div><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px"><button type="button" class="secondary" id="skuExportCsv">导出 SKU CSV</button><label style="display:inline-flex;gap:5px;align-items:center">导入 SKU CSV（仅更新匹配编码）<input type="file" id="skuImportCsv" accept=".csv,text/csv" style="max-width:230px"></label></div><button type="button" class="primary" id="skuApply" style="margin-top:10px">应用组合并写入 SKU 数据</button>`; $('#skuApply').onclick=applyVariants; $('#skuSelectAll').onchange=e=>{tableRows().filter(r=>!r.hidden).forEach(r=>r.querySelector('[data-sku-select]').checked=e.target.checked);filterSkuRows();}; $('#skuFilter').oninput=filterSkuRows; variantsHost.querySelectorAll('[data-sku-id]').forEach(input=>input.addEventListener('input',filterSkuRows)); $('#skuSelectVisible').onclick=()=>{tableRows().filter(r=>!r.hidden).forEach(r=>r.querySelector('[data-sku-select]').checked=true);filterSkuRows();}; $('#skuClearSelection').onclick=()=>{variantsHost.querySelectorAll('[data-sku-select]').forEach(c=>c.checked=false);filterSkuRows();}; variantsHost.querySelectorAll('[data-sku-select]').forEach(c=>c.onchange=filterSkuRows); $('#skuBulkApply').onclick=bulkApply; $('#skuBulkUndo').onclick=undoBulkApply; $('#skuExportCsv').onclick=exportCsv; $('#skuImportCsv').onchange=importCsv; filterSkuRows(); }
const csvCell=value=>{const raw=String(value??'');const safe=/^[\s]*[=+@\-\t\r]/.test(raw)?'\t'+raw:raw;return '"'+safe.replace(/"/g,'""')+'"';};
function parseCsv(text){
 const rows=[];let row=[],field='',quoted=false,closed=false;
 text=String(text).replace(/^\uFEFF/,'');
 for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(c==='"'&&text[i+1]==='"'){field+='"';i++;}else if(c==='"'){quoted=false;closed=true;}else field+=c;}else if(c==='"'){if(field||closed)throw Error('CSV 引号格式错误');quoted=true;}else if(c===','){row.push(field);field='';closed=false;}else if(c==='\n'){row.push(field.replace(/\r$/,''));rows.push(row);row=[];field='';closed=false;}else if(c==='\r'&&text[i+1]==='\n'){continue;}else if(closed)throw Error('CSV 引号后有非法字符');else field+=c;}
 if(quoted)throw Error('CSV 引号没有闭合');if(field!==''||row.length){row.push(field.replace(/\r$/,''));rows.push(row);}return rows.filter(r=>r.some(v=>v!==''));
}
function tableRows(){return [...variantsHost.querySelectorAll('[data-variant-index]')];}
function filterSkuRows(){
 const input=$('#skuFilter');if(!input)return;
 const term=input.value.trim().toLocaleLowerCase();let visible=0;
 for(const row of tableRows()){
  const id=row.querySelector('[data-sku-id]').value;
  const attrs=variants[Number(row.dataset.variantIndex)]?.attributes||{};
  const haystack=[id,...Object.entries(attrs).flat()].join(' ').toLocaleLowerCase();
  row.hidden=!!term&&!haystack.includes(term);
  row.style.display=row.hidden?'none':'';
  if(!row.hidden)visible++;
 }
 const counter=$('#skuFilterCount');if(counter)counter.textContent=`显示 ${visible} / ${tableRows().length} 个 SKU；已选 ${variantsHost.querySelectorAll('[data-sku-select]:checked').length} 个。`;
 const visibleRows=tableRows().filter(r=>!r.hidden);
 const selectAll=$('#skuSelectAll');if(selectAll){selectAll.checked=visibleRows.length>0&&visibleRows.every(r=>r.querySelector('[data-sku-select]').checked);selectAll.indeterminate=visibleRows.some(r=>r.querySelector('[data-sku-select]').checked)&&!selectAll.checked;}
}
function exportCsv(){
 const rows=tableRows();if(!rows.length)return;
 const header=['SKU ID','Price USD','Stock','Image Path','Attributes JSON'];
 const lines=[header.map(csvCell).join(',')];
 for(const row of rows){const v=variants[Number(row.dataset.variantIndex)];lines.push([row.querySelector('[data-sku-id]').value.trim(),row.querySelector('[data-sku-price]').value,row.querySelector('[data-sku-stock]').value,row.querySelector('[data-sku-image]').value,JSON.stringify(v.attributes)].map(csvCell).join(','));}
 const blob=new Blob(['\uFEFF'+lines.join('\r\n')],{type:'text/csv;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='kejun-sku-'+new Date().toISOString().slice(0,10)+'.csv';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);status.textContent=`已导出 ${rows.length} 行 SKU。修改后可导入，最终仍需保存产品。`;
}
async function importCsv(event){
 const file=event.target.files?.[0];event.target.value='';if(!file)return;
 try{
  if(file.size>2*1024*1024)throw Error('CSV 文件不能超过 2 MB。');
  const records=parseCsv(await file.text());if(records.length<2)throw Error('CSV 没有数据行。');if(records.length>501)throw Error('单次最多导入 500 行。');
  const header=records.shift().map(x=>x.trim());const expected=['SKU ID','Price USD','Stock','Image Path','Attributes JSON'];if(header.join('|')!==expected.join('|'))throw Error('CSV 列名或顺序不正确，请先导出模板再修改。');
  const rows=tableRows(), byId=new Map();for(const r of rows){const id=r.querySelector('[data-sku-id]').value.trim();if(!id||byId.has(id))throw Error('当前 SKU 编码为空或重复，请先修正表格再导入。');byId.set(id,r);}const updates=[];const seen=new Set();
  for(const record of records){if(record.length!==5)throw Error('CSV 列数不正确。');const [id,price,stock,img,attr]=record;if(seen.has(id))throw Error('CSV 中存在重复 SKU 编码：'+id);seen.add(id);
   const row=byId.get(id);if(!row)throw Error('找不到 SKU 编码：'+id+'。请先生成相同的组合。');
   const original=variants[Number(row.dataset.variantIndex)].attributes;let incoming;try{incoming=JSON.parse(attr)}catch{throw Error('规格 JSON 格式错误：'+id)}
   if(JSON.stringify(incoming)!==JSON.stringify(original))throw Error('规格属性不匹配：'+id+'。不允许用 CSV 改变组合身份。');
   if(!/^\d+(?:\.\d{1,2})?$/.test(price)||Number(price)<=0||Number(price)>10000000)throw Error('价格无效（USD，最多两位小数）：'+id);
   if(stock!==''&&(!/^\d+$/.test(stock)||!Number.isSafeInteger(Number(stock))))throw Error('库存无效：'+id);
   if(img.length>1000||/^[\s]*(?:javascript|data|vbscript):/i.test(img)||/[<>]/.test(img))throw Error('图片路径不安全或过长：'+id);
   updates.push({row,price,stock,img});
  }
  // Import creates a new editing checkpoint: an older bulk undo must not overwrite imported values.
  lastBulkSnapshot=null;const undoButton=$('#skuBulkUndo');if(undoButton)undoButton.disabled=true;
  for(const u of updates){u.row.querySelector('[data-sku-price]').value=u.price;u.row.querySelector('[data-sku-stock]').value=u.stock;u.row.querySelector('[data-sku-image]').value=u.img;}
  status.textContent=`成功导入 ${updates.length} 行；未匹配行保持不变。请检查并点击“应用组合”，再保存产品。`;
 }catch(e){status.textContent='导入失败，未修改任何行：'+e.message;}
}
function undoBulkApply(){
 if(!lastBulkSnapshot){status.textContent='没有可撤销的批量修改。';return;}
 for(const entry of lastBulkSnapshot){
  for(const [selector,value] of Object.entries(entry.values))entry.row.querySelector(selector).value=value;
 }
 lastBulkSnapshot=null;
 $('#skuBulkUndo').disabled=true;
 filterSkuRows();
 status.textContent='已撤销上一次批量修改；如已点击保存产品，撤销不会回滚服务器数据。';
}
function bulkApply(){
 const selected=[...variantsHost.querySelectorAll('[data-variant-index]')].filter(r=>r.querySelector('[data-sku-select]').checked);
 if(!selected.length){status.textContent='请先勾选要批量修改的 SKU 行。';return;}
 if(selected.length>20&&!window.confirm(`即将批量修改 ${selected.length} 个 SKU（包括可能被当前筛选隐藏的已勾选行）。是否继续？`)){status.textContent='已取消批量修改，原数据保持不变。';return;}
 const price=$('#skuBulkPrice').value.trim(),stock=$('#skuBulkStock').value.trim(),prefix=$('#skuBulkPrefix').value.trim();
 if(!price&&!stock&&!prefix){status.textContent='请至少填写一项批量修改内容。';return;}
 if(price!==''&&(!/^\d+(?:\.\d{1,2})?$/.test(price)||Number(price)<=0||Number(price)>10000000)){status.textContent='批量价格必须大于 0。';return;}
 if(stock!==''&&(!/^\d+$/.test(stock)||!Number.isSafeInteger(Number(stock)))){status.textContent='批量库存必须是非负整数。';return;}
 if(prefix&&!/^[a-zA-Z0-9_-]{1,32}$/.test(prefix)){status.textContent='SKU 前缀仅支持英文字母、数字、短横线和下划线。';return;}
 const allRows=[...variantsHost.querySelectorAll('[data-variant-index]')];
 const proposed=new Map(selected.map(r=>[r,prefix?prefix+r.querySelector('[data-sku-id]').value.trim():r.querySelector('[data-sku-id]').value.trim()]));
 const ids=allRows.map(r=>proposed.get(r)??r.querySelector('[data-sku-id]').value.trim());
 if(ids.some(id=>!id)||new Set(ids).size!==ids.length){status.textContent='修改后 SKU 编码为空或重复，已取消本次批量操作。';return;}
 lastBulkSnapshot=selected.map(row=>({row,values:Object.fromEntries(['[data-sku-price]','[data-sku-stock]','[data-sku-id]'].map(selector=>[selector,row.querySelector(selector).value]))}));
 const undoButton=$('#skuBulkUndo');if(undoButton)undoButton.disabled=false;
 selected.forEach(r=>{if(price!=='')r.querySelector('[data-sku-price]').value=price;if(stock!=='')r.querySelector('[data-sku-stock]').value=stock;if(prefix)r.querySelector('[data-sku-id]').value=proposed.get(r);});
 status.textContent=`已批量更新 ${selected.length} 行，请检查并点击“应用组合”，然后保存产品。`;
}
function currentDrafts(){
 const drafts=new Map();
 for(const row of tableRows()){
  const v=variants[Number(row.dataset.variantIndex)];if(!v||!v.attributes)continue;
  const key=JSON.stringify(v.attributes);
  drafts.set(key,{id:row.querySelector('[data-sku-id]').value.trim(),price:row.querySelector('[data-sku-price]').value,inventoryQuantity:row.querySelector('[data-sku-stock]').value,image:row.querySelector('[data-sku-image]').value});
 }
 return drafts;
}
function generate(){try{const drafts=currentDrafts();const opts=readOptions();if(!opts.length)throw Error('请至少勾选一个需要展示的规格组，并勾选它的规格值。');const count=opts.reduce((n,o)=>n*o.values.length,1);if(count>500)throw Error(`当前会生成 ${count} 个组合，超过单次安全上限 500。请减少属性值或分批创建。`);const combos=combinations(opts);const comboKeys=new Set(combos.map(a=>JSON.stringify(a)));const removed=[...drafts.keys()].filter(k=>!comboKeys.has(k));if(removed.length&&!window.confirm(`新的规格组合将移除 ${removed.length} 个当前表格中的 SKU（包括尚未保存的修改）。确定继续吗？`)){status.textContent='已取消重新生成，当前 SKU 表格及修改保持不变。';return;}const existing=readExisting();variants=combos.map((attributes,i)=>{const old=existing.find(s=>s.attributes&&Object.keys(attributes).length===Object.keys(s.attributes).length&&Object.entries(attributes).every(([k,v])=>s.attributes[k]===v));const comboName=Object.values(attributes).join(' / ');const draft=drafts.get(JSON.stringify(attributes));return {id:draft?.id||old?.id||slug(comboName)+'-'+(i+1),name:comboName,attributes,price:draft?draft.price:(old?.price??(form.elements.price.value.trim()?Number(form.elements.price.value):'')),currency:'USD',inventoryQuantity:draft?draft.inventoryQuantity:(old?.inventoryQuantity??''),image:draft?draft.image:(old?.image||'')};});generatedOptionsSignature=JSON.stringify(readGroupConfig());renderVariants();status.textContent=`已生成 ${variants.length} 个组合。请为每个组合核对 SKU ID 和 USD 价格，再点击“应用组合”。`; }catch(e){status.textContent=e.message;}}
function applyVariants(){try{const rows=[...variantsHost.querySelectorAll('[data-variant-index]')];const result=rows.map(r=>{const i=Number(r.dataset.variantIndex),v=variants[i];const price=r.querySelector('[data-sku-price]').value;const stock=r.querySelector('[data-sku-stock]').value;return {...v,id:r.querySelector('[data-sku-id]').value.trim(),price:price===''?null:Number(price),currency:'USD',inventoryQuantity:stock===''?undefined:Number(stock),image:r.querySelector('[data-sku-image]').value.trim()||undefined,name:Object.values(v.attributes).join(' / ')};});const ids=new Set();for(const v of result){if(!v.id)throw Error('每个 SKU 都必须有唯一 ID。');if(ids.has(v.id))throw Error('SKU ID 重复，请修改后再应用。');ids.add(v.id);if(!Number.isFinite(v.price)||v.price<=0||v.price>10000000||Math.abs(Math.round(v.price*100)-v.price*100)>1e-7)throw Error(`请给 ${v.name} 填写大于 0 的 USD 价格。`);if(v.inventoryQuantity!==undefined&&(!Number.isInteger(v.inventoryQuantity)||v.inventoryQuantity<0))throw Error('库存必须为大于或等于 0 的整数。');if(v.image&&(v.image.length>1000||/^[\s]*(?:javascript|data|vbscript):/i.test(v.image)||/[<>]/.test(v.image)))throw Error('SKU 图片路径不安全或过长：'+v.id);}jsonField.value=JSON.stringify(result.map(v=>{const out={id:v.id,name:v.name,attributes:v.attributes,price:v.price,currency:'USD'};if(v.inventoryQuantity!==undefined)out.inventoryQuantity=v.inventoryQuantity;if(v.image)out.image=v.image;return out;}),null,2);status.textContent=`已将 ${result.length} 个 SKU 写入产品表单；还需要点击页面底部“Save product”保存产品。`;return true; }catch(e){status.textContent=e.message;return false;}}
function isCompleteSkuMatrix(arr,optionMap){
 const groups=[...optionMap.entries()];
 if(!groups.length)return false;
 const expected=groups.reduce((n,[,values])=>n*values.length,1);
 if(expected!==arr.length)return false;
 const seen=new Set();
 for(const sku of arr){
  const attrs=sku.attributes;
  if(!attrs||typeof attrs!=='object'||Array.isArray(attrs)||Object.keys(attrs).length!==groups.length)return false;
  const key=JSON.stringify(groups.map(([name,values])=>{
   const value=String(attrs[name]??'');return values.includes(value)?value:null;
  }));
  if(key.includes('null')||seen.has(key))return false;
  seen.add(key);
 }
 return seen.size===expected;
}
function restoreOrAddGroups(optionMap){
 const restored=Array.isArray(restoredGroupConfig)?restoredGroupConfig:[];
 if(restored.length){
  const handled=new Set();
  for(const item of restored){
   const key=String(item.name||[item.path,item.label].filter(Boolean).join(' / '));
   const values=(item.values||[]).map(v=>typeof v==='string'?v:String(v.name||''));
   addOption(key,values.join(', '),item);handled.add(key);
  }
  for(const [name,values] of optionMap)if(!handled.has(name))addOption(name,values.join(', '));
 }else for(const [name,values] of optionMap)addOption(name,values.join(', '));
}
function loadSparseExisting(arr,optionMap){
 // A sparse matrix represents deliberately unavailable combinations. Never fill gaps implicitly.
 optionHost.innerHTML='';optionCount=0;
 restoreOrAddGroups(optionMap);
 variants=arr.map(v=>({...v,attributes:{...v.attributes}}));
 generatedOptionsSignature=JSON.stringify(readGroupConfig());
 renderVariants();
 status.textContent=`已载入 ${variants.length} 个已保存 SKU（非完整组合）。可修改价格、库存、图片并保存；如需增加组合，请先备份后点击“生成规格组合”。`;
}
function loadExisting(){const arr=readExisting();if(!arr.length){status.textContent='当前产品没有已保存的 SKU。先添加规格组并生成组合。';return;}const optionMap=new Map();arr.forEach(v=>Object.entries(v.attributes||{}).forEach(([k,val])=>{if(!optionMap.has(k))optionMap.set(k,[]);if(!optionMap.get(k).includes(String(val)))optionMap.get(k).push(String(val));}));if(!isCompleteSkuMatrix(arr,optionMap)){loadSparseExisting(arr,optionMap);return;}optionHost.innerHTML='';optionCount=0;restoreOrAddGroups(optionMap);if(!optionMap.size){status.textContent='现有 SKU 没有 attributes 属性对象，无法自动还原规格组。请手动添加规格组。';return;}generate();status.textContent='已从现有 SKU 还原规格组。请检查组合与价格后再应用。';}
window.kejunGetSkuGroups=()=>optionHost.children.length?readGroupConfig():restoredGroupConfig;
window.kejunLoadSkuGroups=groups=>{restoredGroupConfig=Array.isArray(groups)?JSON.parse(JSON.stringify(groups)):[];};
// The product form's Save button must not silently discard edits in the SKU grid.
// Synchronize visible grid values before admin.js builds the product payload.
window.kejunSyncSkuBeforeSave=()=>{
 // A changed attribute group requires regeneration; otherwise the grid still
 // represents old combinations and saving would silently discard the edit.
 if(optionHost.children.length){
  let signature;
  try{signature=JSON.stringify(readGroupConfig());}catch(e){status.textContent=e.message;const error=$('#productError');if(error)error.textContent=e.message;return false;}
  if(!tableRows().length||signature!==generatedOptionsSignature){
   status.textContent='规格组选项已修改，请先点击“生成 SKU 组合”，核对价格和库存后再保存。';
   const error=$('#productError');if(error)error.textContent=status.textContent;
   return false;
  }
 }
 if(!tableRows().length)return true; // Existing JSON remains authoritative if grid was never generated.
 const ok=applyVariants();
 if(!ok){const error=$('#productError');if(error)error.textContent='SKU 规格保存失败：'+status.textContent;}
 return ok;
};
$('#skuAddOption')?.addEventListener('click',()=>addOption());
$('#skuLoadTemplate')?.addEventListener('click',()=>{
 if(optionHost.children.length&&!window.confirm('将添加四个示例规格组，不会删除现有规格组。继续吗？'))return;
 [['电源','24VDC, 220VAC'],['螺纹','G1/2, M20×1.5, NPT1/2'],['测量范围','0-10kPa, 0-100kPa, 0-1MPa'],['输出信号','4-20mA, RS485, 0-10V']].forEach(([name,values])=>{if(![...optionHost.querySelectorAll('[data-option-name]')].some(x=>x.value===name))addOption(name,values)});
 status.textContent='已加入四组工业仪表示例。请根据实际产品能力修改后再生成组合；不支持的组合不要发布。';
});$('#skuGenerate')?.addEventListener('click',generate);$('#skuLoadExisting')?.addEventListener('click',loadExisting);
// Keep the builder aligned with the existing product editor each time a dialog is opened.
const dialog=$('#productDialog'); if(dialog){const observer=new MutationObserver(()=>{if(dialog.open){const arr=readExisting();if(!arr.length&&optionHost.children.length===0&&restoredGroupConfig.length){restoreOrAddGroups(new Map());}if(arr.length&&optionHost.children.length===0){const m=new Map();arr.forEach(v=>Object.entries(v.attributes||{}).forEach(([k,val])=>{if(!m.has(k))m.set(k,[]);if(!m.get(k).includes(String(val)))m.get(k).push(String(val));}));if(m.size){if(!isCompleteSkuMatrix(arr,m)){loadSparseExisting(arr,m);return;}restoreOrAddGroups(m);generate();status.textContent='已自动载入现有 SKU 组合，可直接修改后保存产品。';}}}else{optionHost.innerHTML='';variantsHost.innerHTML='';variants=[];generatedOptionsSignature=null;}});observer.observe(dialog,{attributes:true,attributeFilter:['open']});}
})();
