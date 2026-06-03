const { chromium } = require('playwright-core');
async function ixPost(path, body) { const res=await fetch('http://127.0.0.1:53200/api/v2/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})}); return res.json(); }
(async()=>{
 const groupUrl='https://www.facebook.com/groups/1567661940074941/';
 const open=await ixPost('profile-open',{profile_id:20,args:['--disable-popup-blocking',groupUrl],load_extensions:true,cookies_backup:false,load_profile_info_page:false});
 const browser=await chromium.connectOverCDP(open.data.ws || ('http://'+open.data.debugging_address),{timeout:30000});
 const page=browser.contexts()[0].pages().find(p=>!p.isClosed()) || await browser.contexts()[0].newPage();
 await page.goto(groupUrl,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
 await page.waitForTimeout(8000);
 const data=await page.evaluate(()=>{
   const target='Deal of today';
   function summarize(el){
     return {
       tag: el.tagName,
       role: el.getAttribute('role'),
       aria: el.getAttribute('aria-label'),
       text: (el.innerText||el.textContent||'').replace(/\s+/g,' ').trim().slice(0,1500),
       links:[...el.querySelectorAll('a[href]')].map(a=>({href:a.href,text:(a.innerText||a.getAttribute('aria-label')||'').replace(/\s+/g,' ').trim().slice(0,200), aria:a.getAttribute('aria-label'), role:a.getAttribute('role')})).slice(0,80),
       buttons:[...el.querySelectorAll('[role="button"],button')].map(b=>({text:(b.innerText||'').replace(/\s+/g,' ').trim().slice(0,200), aria:b.getAttribute('aria-label'), role:b.getAttribute('role')})).slice(0,80)
     };
   }
   const nodes=[...document.querySelectorAll('div, [role="article"]')].filter(el=>(el.innerText||'').includes(target));
   const unique=[]; const seen=new Set();
   for (const n of nodes) {
     let el=n;
     for(let i=0;i<6 && el.parentElement;i++){
       if((el.getAttribute('role')||'')==='article') break;
       el=el.parentElement;
     }
     if(!seen.has(el)){seen.add(el); unique.push(summarize(el));}
   }
   return {count:unique.length, items:unique.slice(-8)};
 });
 console.log(JSON.stringify(data,null,2));
 await browser.close().catch(()=>{});
})().catch(e=>{console.error(e.stack||e.message);process.exit(1)});
