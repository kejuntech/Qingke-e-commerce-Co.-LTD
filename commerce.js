(function(){
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function cartCount(){try{return JSON.parse(localStorage.getItem('kejunCart')||'[]').reduce((n,x)=>n+Number(x.qty||1),0)}catch{return 0}}
fetch('/api/settings').then(r=>r.ok?r.json():{}).then(s=>{
 document.querySelectorAll('.footer').forEach(f=>{
  const grid=f.querySelector('.footgrid'); if(!grid)return;
  const brand=grid.querySelector('div'); if(brand){const b=brand.querySelector('b');if(b)b.textContent=s.brand||'Qingke';}
  const cols=grid.querySelectorAll(':scope > div');const contact=cols[cols.length-1];
  if(contact){contact.innerHTML=`<b>Contact</b>${s.phone?`<p>Phone: ${esc(s.phone)}</p>`:''}${s.whatsapp?`<p>WhatsApp: <a href="https://wa.me/${String(s.whatsapp).replace(/\D/g,'')}" target="_blank" rel="noopener">${esc(s.whatsapp)}</a></p>`:''}${s.salesEmail?`<p>Email: <a href="mailto:${esc(s.salesEmail)}">${esc(s.salesEmail)}</a></p>`:''}${s.address||s.location?`<p>${esc(s.address||s.location)}</p>`:''}${s.registration?`<p>Registration: ${esc(s.registration)}</p>`:''}`;}
  let pay=grid.querySelector('.payment-column');if(!pay){pay=document.createElement('div');pay.className='payment-column';grid.appendChild(pay)}
  const methods=String(s.paymentMethods||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  pay.innerHTML=`<b>Payment Methods</b>${methods.length?`<ul>${methods.map(m=>`<li>${esc(m)}</li>`).join('')}</ul>`:'<p>Contact sales to confirm available payment methods.</p>'}${s.paymentInstructions?`<p>${esc(s.paymentInstructions).replace(/\n/g,'<br>')}</p>`:''}${s.beneficiary?`<p>Beneficiary: ${esc(s.beneficiary)}</p>`:''}${s.bankName?`<p>Bank: ${esc(s.bankName)}</p>`:''}${s.bankAddress?`<p>Bank address: ${esc(s.bankAddress)}</p>`:''}${s.accountNumber?`<p>Account / IBAN: ${esc(s.accountNumber)}</p>`:''}${s.swiftBic?`<p>SWIFT/BIC: ${esc(s.swiftBic)}</p>`:''}${s.paypalEmail?`<p>PayPal: ${esc(s.paypalEmail)}</p>`:''}`;
  if(!grid.querySelector('.commerce-foot-style')){const st=document.createElement('style');st.className='commerce-foot-style';st.textContent='.footgrid{grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}.payment-column ul{padding-left:18px;margin:8px 0}.payment-column li,.payment-column p{font-size:12px;line-height:1.6;overflow-wrap:anywhere}';f.appendChild(st)}
 });
}).catch(()=>{});
document.querySelectorAll('.links').forEach(links=>{if(!links.querySelector('[data-cart-link]')){const a=document.createElement('a');a.href='cart.html';a.dataset.cartLink='1';a.innerHTML=`Cart (<span data-cart-count>${cartCount()}</span>)`;links.appendChild(a)}});
document.querySelectorAll('[data-cart-count]').forEach(x=>x.textContent=cartCount());
})();