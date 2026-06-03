const { chromium } = require('playwright-core');
async function ixPost(path, body) { const res=await fetch('http://127.0.0.1:53200/api/v2/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})}); return res.json(); }
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
(async()=>{
 const postUrl='https://www.facebook.com/groups/1567661940074941/permalink/3487061328134983/';
 const marker='Hermes link test 20260517-083244';
 const commentText='Check this deal: https://mavlynk.com/kbKSH';
 const open=await ixPost('profile-open',{profile_id:20,args:['--disable-popup-blocking',postUrl],load_extensions:true,cookies_backup:false,load_profile_info_page:false});
 const browser=await chromium.connectOverCDP(open.data.ws || ('http://'+open.data.debugging_address),{timeout:30000});
 const page=browser.contexts()[0].pages().find(p=>!p.isClosed()) || await browser.contexts()[0].newPage();
 await page.goto(postUrl,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
 await sleep(9000);
 const pre=await page.evaluate((marker)=>({url:location.href, markerVisible:document.body.innerText.includes(marker), buttons:[...document.querySelectorAll('[role="button"],button,a')].map((b,i)=>({i,text:(b.innerText||'').replace(/\s+/g,' ').trim().slice(0,80),aria:b.getAttribute('aria-label')})).filter(x=>/comment|reply/i.test((x.text||'')+' '+(x.aria||''))).slice(0,30)}), marker);
 console.log(JSON.stringify({step:'pre',pre},null,2));
 const clicked=await page.evaluate((marker)=>{
   let roots=[...document.querySelectorAll('[role="article"], div')].filter(el=>(el.innerText||'').includes(marker));
   roots=roots.sort((a,b)=>(a.innerText||'').length-(b.innerText||'').length);
   for(const root of roots){
     const btns=[...root.querySelectorAll('[role="button"],button,a')];
     const b=btns.find(x=>/^Comment$/i.test((x.innerText||'').trim()) || /Leave a comment/i.test(x.getAttribute('aria-label')||''));
     if(b){ b.scrollIntoView({block:'center'}); b.click(); return {ok:true, text:b.innerText||'', aria:b.getAttribute('aria-label')||'', rootText:(root.innerText||'').slice(0,300)}; }
   }
   return {ok:false, roots:roots.length};
 }, marker);
 console.log(JSON.stringify({step:'clicked',clicked},null,2));
 await sleep(3000);
 const textboxes=await page.evaluate(()=>[...document.querySelectorAll('div[contenteditable="true"], [role="textbox"]')].map((b,i)=>({i, visible:!!(b.offsetWidth||b.offsetHeight||b.getClientRects().length), text:(b.innerText||'').replace(/\s+/g,' ').trim().slice(0,80), aria:b.getAttribute('aria-label'), role:b.getAttribute('role')})).slice(-20));
 console.log(JSON.stringify({step:'textboxes',textboxes},null,2));
 let typed=false;
 for(const loc of [page.getByRole('textbox',{name:/write a comment|comment/i}), page.locator('div[contenteditable="true"][role="textbox"]'), page.locator('div[contenteditable="true"]')]){
   const n=await loc.count().catch(()=>0);
   for(let i=n-1;i>=0;i--){
     const box=loc.nth(i);
     try{
       if(!(await box.isVisible({timeout:800}).catch(()=>false))) continue;
       await box.click({timeout:3000});
       await page.keyboard.type(commentText,{delay:70});
       await sleep(800);
       await page.keyboard.press('Enter');
       typed=true; break;
     }catch(e){}
   }
   if(typed) break;
 }
 await sleep(10000);
 const verify=await page.evaluate(({marker,commentText})=>({url:location.href,title:document.title,markerVisible:document.body.innerText.includes(marker),commentVisible:document.body.innerText.includes(commentText),shortVisible:document.body.innerText.includes('kbKSH'),snippets:document.body.innerText.split('\n').filter(l=>l.includes(marker)||l.includes('mavlynk')||l.includes('Deal of today')).slice(0,50)}),{marker,commentText});
 console.log(JSON.stringify({step:'verify',typed,verify},null,2));
 await browser.close().catch(()=>{});
})().catch(e=>{console.error(e.stack||e.message);process.exit(1)});
