const { chromium } = require('playwright-core');
async function ixPost(path, body) { const res=await fetch('http://127.0.0.1:53200/api/v2/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})}); return res.json(); }
(async()=>{
 const groupUrl='https://www.facebook.com/groups/1567661940074941/';
 const open=await ixPost('profile-open',{profile_id:20,args:['--disable-popup-blocking',groupUrl],load_extensions:true,cookies_backup:false,load_profile_info_page:false});
 const browser=await chromium.connectOverCDP(open.data.ws || ('http://'+open.data.debugging_address),{timeout:30000});
 const page=browser.contexts()[0].pages().find(p=>!p.isClosed()) || await browser.contexts()[0].newPage();
 await page.goto(groupUrl,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
 await page.waitForTimeout(7000);
 const clicked = await page.evaluate(() => {
   const target='Deal of today';
   const candidates=[...document.querySelectorAll('div')].filter(el=>(el.innerText||'').includes(target));
   for (const root of candidates.reverse()) {
     const links=[...root.querySelectorAll('a[href]')];
     const ts = links.find(a => (a.href||'').includes('/groups/1567661940074941/?') && (a.innerText||'').trim().length > 10);
     if (ts) { ts.setAttribute('target','_self'); ts.click(); return {ok:true, href:ts.href, text:ts.innerText}; }
   }
   return {ok:false};
 });
 console.log(JSON.stringify({step:'clicked_timestamp', clicked}, null, 2));
 await page.waitForTimeout(10000);
 const title = await page.title().catch(()=>'');
 console.log(JSON.stringify({step:'resolved', url:page.url(), title}, null, 2));
 await browser.close().catch(()=>{});
})().catch(e=>{console.error(e.stack||e.message);process.exit(1)});
