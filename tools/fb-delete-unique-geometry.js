const { chromium } = require('playwright-core');
async function ixPost(path, body) { const res=await fetch('http://127.0.0.1:53200/api/v2/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})}); return res.json(); }
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
(async()=>{
 const url='https://www.facebook.com/groups/1567661940074941/permalink/3487061328134983/';
 const marker='Hermes link test 20260517-083244';
 const open=await ixPost('profile-open',{profile_id:20,args:['--disable-popup-blocking',url],load_extensions:true,cookies_backup:false,load_profile_info_page:false});
 const browser=await chromium.connectOverCDP(open.data.ws || ('http://'+open.data.debugging_address),{timeout:30000});
 const page=browser.contexts()[0].pages().find(p=>!p.isClosed()) || await browser.contexts()[0].newPage();
 await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
 await sleep(10000);
 await page.keyboard.press('Escape').catch(()=>{});
 await sleep(500);
 const clickInfo=await page.evaluate((marker)=>{
   function visible(el){return !!(el.offsetWidth||el.offsetHeight||el.getClientRects().length)}
   const markerNodes=[...document.querySelectorAll('span, div')].filter(el=>visible(el) && (el.innerText||el.textContent||'').includes(marker));
   const markerNode=markerNodes.sort((a,b)=>(a.innerText||'').length-(b.innerText||'').length)[0];
   const mb=markerNode ? markerNode.getBoundingClientRect() : null;
   const actions=[...document.querySelectorAll('[role="button"],button')].filter(el=>visible(el) && /Actions for this post|Edit or delete this/i.test(el.getAttribute('aria-label')||''));
   const data=actions.map((el,idx)=>{const r=el.getBoundingClientRect(); const dy=mb?Math.abs((r.top+r.bottom)/2-(mb.top+mb.bottom)/2):99999; const dx=mb?Math.abs((r.left+r.right)/2-(mb.left+mb.right)/2):99999; return {idx, aria:el.getAttribute('aria-label'), x:(r.left+r.right)/2, y:(r.top+r.bottom)/2, dy, dx};});
   // Prefer a post action button above or near marker, not comment edit button below.
   data.sort((a,b)=>(a.dy+a.dx*0.15)-(b.dy+b.dx*0.15));
   const chosen=data[0];
   if(chosen){actions[chosen.idx].scrollIntoView({block:'center'}); actions[chosen.idx].click();}
   return {markerCount:markerNodes.length, markerBox:mb?{x:mb.x,y:mb.y,w:mb.width,h:mb.height}:null, actions:data.slice(0,10), chosen};
 }, marker);
 console.log(JSON.stringify({step:'clickInfo',clickInfo},null,2));
 await sleep(3000);
 const menuBefore=await page.evaluate(()=>[...document.querySelectorAll('[role="menuitem"], [role="button"], div, span')]
  .filter(el=>!!(el.offsetWidth||el.offsetHeight||el.getClientRects().length))
  .map(el=>({text:(el.innerText||'').replace(/\s+/g,' ').trim(),role:el.getAttribute('role'),aria:el.getAttribute('aria-label')}))
  .filter(x=>/Delete post|Edit post|Save post|Pin to Featured|Delete comment|Edit comment/i.test((x.text||'')+' '+(x.aria||'')))
  .slice(0,80));
 console.log(JSON.stringify({step:'menuBefore',menuBefore},null,2));
 const deleteClicked=await page.evaluate(()=>{
   const els=[...document.querySelectorAll('[role="menuitem"], [role="button"], div, span')].filter(el=>!!(el.offsetWidth||el.offsetHeight||el.getClientRects().length));
   // Prefer role=menuitem exact Delete post.
   let del=els.find(el=>el.getAttribute('role')==='menuitem' && /^Delete post$/i.test((el.innerText||'').replace(/\s+/g,' ').trim()));
   if(!del) del=els.find(el=>/^Delete post$/i.test((el.innerText||'').replace(/\s+/g,' ').trim()));
   if(del){del.click(); return {ok:true,text:(del.innerText||'').replace(/\s+/g,' ').trim(),role:del.getAttribute('role')};}
   return {ok:false};
 });
 console.log(JSON.stringify({step:'deleteClicked',deleteClicked}));
 await sleep(3500);
 const dialog=await page.evaluate(()=>{
   const ds=[...document.querySelectorAll('[role="dialog"]')].filter(el=>!!(el.offsetWidth||el.offsetHeight||el.getClientRects().length));
   return ds.map(d=>({text:(d.innerText||'').replace(/\s+/g,' ').trim().slice(0,1000), buttons:[...d.querySelectorAll('[role="button"],button')].map(b=>({text:(b.innerText||'').replace(/\s+/g,' ').trim(),aria:b.getAttribute('aria-label')}))})).slice(-3);
 });
 console.log(JSON.stringify({step:'dialog',dialog},null,2));
 const confirm=await page.evaluate(()=>{
   const ds=[...document.querySelectorAll('[role="dialog"]')].filter(el=>!!(el.offsetWidth||el.offsetHeight||el.getClientRects().length));
   for(const d of ds.reverse()){
     const btns=[...d.querySelectorAll('[role="button"],button')].filter(b=>!!(b.offsetWidth||b.offsetHeight||b.getClientRects().length));
     const b=btns.find(x=>/^Delete$/i.test((x.innerText||'').replace(/\s+/g,' ').trim()) || /Delete/i.test(x.getAttribute('aria-label')||''));
     if(b){b.click(); return {ok:true,text:(b.innerText||'').replace(/\s+/g,' ').trim(),aria:b.getAttribute('aria-label')};}
   }
   return {ok:false};
 });
 console.log(JSON.stringify({step:'confirm',confirm}));
 await sleep(16000);
 await page.reload({waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
 await sleep(10000);
 const verify=await page.evaluate((marker)=>({url:location.href,title:document.title,markerVisible:document.body.innerText.includes(marker),dealVisible:document.body.innerText.includes('Deal of today'),deletePostVisible:document.body.innerText.includes('Delete post'),snippets:document.body.innerText.split('\n').filter(l=>/Hermes link test|Deal of today|deleted|removed|available/i.test(l)).slice(0,50)}),marker);
 console.log(JSON.stringify({step:'verify',verify},null,2));
 await browser.close().catch(()=>{});
})().catch(e=>{console.error(JSON.stringify({step:'error',message:e.message,stack:e.stack}));process.exit(1)});
