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
 const clicked=await page.evaluate((marker)=>{
  const roots=[...document.querySelectorAll('[role="article"], div')].filter(el=>(el.innerText||'').includes(marker)).sort((a,b)=>(a.innerText||'').length-(b.innerText||'').length);
  for(const root of roots){
    const action=[...root.querySelectorAll('[role="button"],button')].find(b=>/Actions for this post/i.test(b.getAttribute('aria-label')||''));
    if(action){action.scrollIntoView({block:'center'}); action.click(); return {ok:true, root:(root.innerText||'').slice(0,600)};}
  }
  return {ok:false, roots:roots.length};
 }, marker);
 await sleep(3000);
 const menu=await page.evaluate(()=>[...document.querySelectorAll('[role="menuitem"], [role="button"], span, div')]
   .filter(el=>!!(el.offsetWidth||el.offsetHeight||el.getClientRects().length))
   .map(el=>({text:(el.innerText||'').replace(/\s+/g,' ').trim().slice(0,120),aria:el.getAttribute('aria-label'),role:el.getAttribute('role')}))
   .filter(x=>/delete|edit|save|hide|turn off|feedback|actions/i.test((x.text||'')+' '+(x.aria||'')))
   .slice(0,80));
 console.log(JSON.stringify({clicked,menu},null,2));
 const deleteClicked=await page.evaluate(()=>{
   const els=[...document.querySelectorAll('[role="menuitem"], [role="button"], div, span')].filter(el=>!!(el.offsetWidth||el.offsetHeight||el.getClientRects().length));
   const del=els.find(el=>/^Delete post$/i.test((el.innerText||'').replace(/\s+/g,' ').trim()));
   if(del){del.click(); return true;} return false;
 });
 await sleep(2500);
 const confirm=await page.evaluate(()=>{
   const els=[...document.querySelectorAll('[role="button"],button,div,span')].filter(el=>!!(el.offsetWidth||el.offsetHeight||el.getClientRects().length));
   const del=els.find(el=>/^Delete$/i.test((el.innerText||'').replace(/\s+/g,' ').trim()));
   if(del){del.click(); return true;} return false;
 });
 await sleep(12000);
 const verify=await page.evaluate((marker)=>({url:location.href,title:document.title,marker:document.body.innerText.includes(marker),deleteControl:document.body.innerText.includes('Delete post'),snippet:document.body.innerText.split('\n').filter(l=>/Hermes link test|Deal of today|deleted|removed|available/i.test(l)).slice(0,30)}),marker);
 console.log(JSON.stringify({deleteClicked,confirm,verify},null,2));
 await browser.close().catch(()=>{});
})().catch(e=>{console.error(e.stack||e.message);process.exit(1)});
