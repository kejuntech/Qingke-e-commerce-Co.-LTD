/* Configurable homepage sections. Hidden reserved modules create no DOM nodes until enabled. */
(function(){
  const defaults=[
    {id:'carousel',label:'首页轮播图',kind:'existing',enabled:true,order:1,size:'full'},
    {id:'hero',label:'首页主视觉',kind:'existing',enabled:true,order:2,size:'full'},
    {id:'proofbar',label:'信任信息条',kind:'existing',enabled:true,order:3,size:'full'},
    {id:'categories',label:'产品分类',kind:'existing',enabled:true,order:4,size:'full'},
    {id:'featured',label:'精选产品',kind:'existing',enabled:true,order:5,size:'full'},
    {id:'industries',label:'行业应用',kind:'existing',enabled:true,order:6,size:'full'},
    {id:'support',label:'技术支持',kind:'existing',enabled:true,order:7,size:'full'},
    {id:'contact',label:'联系横幅',kind:'existing',enabled:true,order:8,size:'full'},
    ...Array.from({length:8},(_,i)=>({id:'reserved-'+(i+1),label:'预留栏目 '+(i+1),kind:'reserved',enabled:false,order:9+i,size:'full',title:'',text:'',buttonText:'',href:'',image:''}))
  ];
  function merge(saved){const byId=new Map((Array.isArray(saved)?saved:[]).map(x=>[x.id,x]));return defaults.map(d=>({...d,...(byId.get(d.id)||{})})).sort((a,b)=>(Number(a.order)||99)-(Number(b.order)||99));}
  function safeHref(value){const s=String(value||'').trim();if(s.startsWith('/')||/^https?:\/\//i.test(s)||/^mailto:/i.test(s))return s;return '';}
  function renderModule(m){const section=document.createElement('section');section.dataset.homeModule=m.id;section.className='v18-section home-reserved-module home-size-'+(['full','wide','half','third'].includes(m.size)?m.size:'full');
    const wrap=document.createElement('div');wrap.className='v18-wrap';const title=document.createElement('h2');title.textContent=m.title||m.label||'More from Qingke';wrap.appendChild(title);
    if(m.image){const img=document.createElement('img');img.loading='lazy';img.alt=m.title||'';img.src=m.image;img.style.maxWidth='100%';img.style.height='auto';img.style.borderRadius='12px';wrap.appendChild(img)}
    if(m.text){const p=document.createElement('p');p.textContent=m.text;p.style.whiteSpace='pre-line';wrap.appendChild(p)}
    const href=safeHref(m.href);if(m.buttonText&&href){const a=document.createElement('a');a.className='v18-btn-outline';a.href=href;a.textContent=m.buttonText;wrap.appendChild(a)}
    section.appendChild(wrap);return section;
  }
  async function apply(){const main=document.querySelector('main');if(!main)return;let saved=[];try{const r=await fetch('/api/settings',{cache:'no-store'});if(r.ok){const s=await r.json();saved=s.homeModules||[]}}catch(_){/* keep the existing page if settings cannot load */}
    const config=merge(saved);const existing=new Map([...main.querySelectorAll('[data-home-module]')].map(el=>[el.dataset.homeModule,el]));
    for(const m of config){if(m.kind==='reserved'&&!m.enabled)continue;let el=existing.get(m.id);if(m.id==='carousel'){el=existing.get('carousel')||document.getElementById('home-carousel');if(el){el.hidden=!m.enabled;el.style.display=m.enabled?'':'none';el.classList.remove('home-size-full','home-size-wide','home-size-half','home-size-third');el.classList.add('home-size-'+(['full','wide','half','third'].includes(m.size)?m.size:'full'));main.appendChild(el)}}else if(m.kind==='reserved'){el=renderModule(m);main.appendChild(el)}else if(el){el.hidden=!m.enabled;el.style.display=m.enabled?'':'none';el.classList.remove('home-size-full','home-size-wide','home-size-half','home-size-third');el.classList.add('home-size-'+(['full','wide','half','third'].includes(m.size)?m.size:'full'));main.appendChild(el)}}
  }
  const style=document.createElement('style');style.textContent='.home-reserved-module{padding:clamp(32px,5vw,72px) 0;border-bottom:1px solid #e5eaf0}.home-reserved-module h2{margin:0 0 16px}.home-reserved-module p{max-width:760px;line-height:1.7}.home-size-wide .v18-wrap{max-width:1180px}.home-size-half .v18-wrap{max-width:760px}.home-size-third .v18-wrap{max-width:520px}.home-reserved-module[hidden]{display:none!important}';document.head.appendChild(style);
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',apply,{once:true});else apply();
})();
