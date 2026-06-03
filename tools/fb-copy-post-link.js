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
   const roots=[...document.querySelectorAll('div')].filter(el=>(el.innerText||'').includes(target));
   for (const root of roots.reverse()) {
     const btn=[...root.querySelectorAll('[role="button"],button')].find(b=>(b.getAttribute('aria-label')||'').includes('Actions for this post'));
     if (btn) { btn.click(); return true; }
   }
   return false;
 });
 console.log(JSON.stringify({step:'actions_clicked', clicked}));
 await page.waitForTimeout(3000);
 const menu = await page.evaluate(() => {
   return [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], a[href], [role="button"]')]
    .map(el=>({text:(el.innerText||el.getAttribute('aria-label')||'').replace(/\s+/g,' ').trim(), aria:el.getAttribute('aria-label'), role:el.getAttribute('role'), href:el.href||''}))
    .filter(x=>/copy|link|view|embed|share|save|turn|edit|delete|post/i.test((x.text||'')+' '+(x.aria||'')+' '+(x.href||'')))
    .slice(0,80);
 });
 console.log(JSON.stringify({step:'menu', menu}, null, 2));
 // Try click Copy link if present.
 const copyClicked = await page.evaluate(() => {
   const els=[...document.querySelectorAll('[role="menuitem"], [role="button"], span, div')];
   const el=els.find(e=>/copy link/i.test((e.innerText||e.getAttribute('aria-label')||'').replace(/\s+/g,' ').trim()));
   if (el) { el.click(); return true; }
   return false;
 });
 console.log(JSON.stringify({step:'copy_clicked', copyClicked}));
 await page.waitForTimeout(2000);
 let clip='';
 try { clip=await page.evaluate(()=>navigator.clipboard.readText()); } catch(e) { clip='CLIPBOARD_READ_FAILED: '+e.message; }
 console.log(JSON.stringify({step:'clipboard', clip}, null, 2));
 await browser.close().catch(()=>{});
})().catch(e=>{console.error(e.stack||e.message);process.exit(1)});
