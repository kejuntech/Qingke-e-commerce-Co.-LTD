/* Product bulk publishing: changes are sent only after confirmation. */
(()=>{
  'use strict';
  const selected=new Set();
  let saving=false;
  const $=id=>document.getElementById(id);
  const count=()=>{const el=$('productSelectedCount');if(el)el.textContent=`已选择 ${selected.size} 项`;};
  function sync(){
    const boxes=[...document.querySelectorAll('.product-bulk-check')];
    for(const box of boxes){box.checked=selected.has(box.dataset.productId);}
    const all=$('productSelectVisible');
    if(all){all.checked=boxes.length>0&&boxes.every(x=>x.checked);all.indeterminate=boxes.some(x=>x.checked)&&!all.checked;}
    count();
  }
  function prune(){if(typeof products!=='undefined'){const ids=new Set(products.map(x=>String(x.id)));for(const id of selected)if(!ids.has(id))selected.delete(id);}sync();}
  document.addEventListener('change',event=>{
    const el=event.target;
    if(saving && (el.matches('.product-bulk-check') || el.id==='productSelectVisible')) { sync(); return; }
    if(el.matches('.product-bulk-check')){el.checked?selected.add(el.dataset.productId):selected.delete(el.dataset.productId);sync();}
    if(el.id==='productSelectVisible'){
      document.querySelectorAll('.product-bulk-check').forEach(box=>{el.checked?selected.add(box.dataset.productId):selected.delete(box.dataset.productId);});sync();
    }
  });
  document.addEventListener('click',async event=>{
    const id=event.target.id;
    if(saving && ['productBulkClear','productBulkPublish','productBulkUnpublish'].includes(id)) return;
    if(id==='productBulkClear'){selected.clear();sync();return;}
    if(id!=='productBulkPublish'&&id!=='productBulkUnpublish')return;
    if(typeof products==='undefined'||typeof api!=='function')return;
    prune();
    const publish=id==='productBulkPublish';
    if(!selected.size){$('productBulkStatus').textContent='请先选择商品';return;}
    const idsToUpdate=new Set([...selected]);
    const expectedItems=products.filter(p=>idsToUpdate.has(String(p.id))).map(p=>({id:String(p.id),expected:p.published!==false}));
    const action=publish?'上架':'下架';
    if(!confirm(`确认将 ${selected.size} 个商品批量${action}吗？`))return;
    const buttons=[$('productBulkPublish'),$('productBulkUnpublish')];
    saving=true;
    buttons.forEach(b=>b.disabled=true);
    const clearButton=$('productBulkClear');if(clearButton)clearButton.disabled=true;
    const selectVisible=$('productSelectVisible');if(selectVisible)selectVisible.disabled=true;
    const status=$('productBulkStatus');status.textContent='正在保存，请勿关闭页面…';
    try{
      await api('/api/products/publication',{method:'PATCH',body:JSON.stringify({items:expectedItems,published:publish})});
      // Re-read persisted state; do not report success based on a PUT response alone.
      const saved=await api('/api/products');
      const persisted=Array.isArray(saved)?saved:(Array.isArray(saved.products)?saved.products:null);
      if(!persisted)throw Error('服务器返回的商品列表格式无效，请刷新核实');
      const expected=idsToUpdate;
      const verified=persisted.filter(p=>expected.has(String(p.id)));
      if(verified.length!==expected.size||verified.some(p=>(p.published!==false)!==publish))throw Error('服务器保存结果与操作不一致，请刷新核实');
      products=persisted;selected.clear();renderProducts();status.textContent=`已核对服务器数据：成功${action} ${verified.length} 个商品`; 
    }catch(error){status.textContent=`保存失败，当前列表未更新：${error.message}`;}
    finally{saving=false;buttons.forEach(b=>b.disabled=false);if(clearButton)clearButton.disabled=false;if(selectVisible)selectVisible.disabled=false;sync();}
  });
  // Product rows are rebuilt by filters, edits, and reloads.
  const observer=new MutationObserver(()=>prune());
  const start=()=>{const tbody=$('productRows');if(tbody){observer.observe(tbody,{childList:true});sync();}};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
})();
