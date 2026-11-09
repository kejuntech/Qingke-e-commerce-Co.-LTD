(function(){
  'use strict';
  // Verified manually against the bundled image files; replacing the real image is required.
  const qualityIssues={
    'assets/source-brochure/kjs3-2x-4x-photo.jpg':'KJS3-2X/4X：原图下端被截断',
    'assets/source-brochure/kjcs-102-photo.jpg':'KJCS-102：原图右侧及下端被截断',
    'assets/source-brochure/kj-cl-flowmeter-photo.jpg':'KJ-CL：原图右侧/下端被截断',
    'assets/source-brochure/kj-d9-2x-wx-photo.jpg':'KJ-D9-2X-WX：顶部接近画面边界，请更换完整实物照',
    'assets/source-brochure/kj-d9-2x-t-photo.jpg':'KJ-D9-2X-T：顶部接近画面边界，请更换完整实物照'
  };
  const norm=v=>String(v||'').split('?')[0].replace(/^\/+/, '');
  function update(){
    const input=document.getElementById('imagePath');if(!input)return;
    let note=document.getElementById('kejunImageQualityNotice');
    if(!note){note=document.createElement('p');note.id='kejunImageQualityNotice';note.setAttribute('role','status');note.style.cssText='font-size:13px;line-height:1.55;margin:6px 0;color:#9a3412';input.insertAdjacentElement('afterend',note)}
    const issue=qualityIssues[norm(input.value)];
    note.textContent=issue?'图片完整性提醒：'+issue+'。CSS 无法补回被截掉的产品，请上传完整原始照片。':'图片检查：请确认整机、螺纹与底部连接部分均在原照片中完整可见。';
  }
  document.addEventListener('input',e=>{if(e.target?.id==='imagePath')update()});
  document.addEventListener('change',e=>{if(e.target?.id==='imagePath')update()});
  document.addEventListener('click',e=>{if(e.target?.closest('#editProduct, #productDialog, [data-edit-product]'))setTimeout(update,0)});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',update);else update();
  window.KejunImageQualityIssues=Object.freeze({...qualityIssues});
})();
