/* Never show a known incomplete source photo as though it were a full product photo.
 * Uploading a genuinely complete image under a new URL automatically restores it.
 * This does NOT change product records or substitute a different manufacturer's model. */
(function(){
  'use strict';
  const invalid=new Set([
    'kjs3-2x-4x-photo.jpg', 'kjcs-102-photo.jpg', 'kj-cl-flowmeter-photo.jpg',
    'kj-d9-2x-wx-photo.jpg', 'kj-d9-2x-t-photo.jpg'
  ]);
  const fallback='/assets/product-photo-pending.svg';
  function review(img){
    if(!img || img.tagName!=='IMG')return;
    const path=String(img.getAttribute('src')||'').split(/[?#]/)[0].toLowerCase();
    if(!invalid.has(path.split('/').pop()))return;
    img.dataset.originalProductPhoto=img.getAttribute('src');
    img.dataset.productPhotoNeedsReplacement='true';
    img.src=fallback;
    img.title='完整产品实物图待上传；当前原始照片已被截断';
  }
  function scan(root){if(root?.matches?.('img'))review(root);root?.querySelectorAll?.('img').forEach(review)}
  const boot=()=>{
    scan(document);
    const obs=new MutationObserver(mutations=>{for(const m of mutations){
      if(m.type==='attributes')review(m.target);
      else for(const node of m.addedNodes)if(node.nodeType===1)scan(node);
    }});
    obs.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['src']});
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
