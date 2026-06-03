const { chromium } = require('playwright-core');
async function ixPost(path, body) { const res=await fetch('http://127.0.0.1:53200/api/v2/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})}); return res.json(); }
(async()=>{
 const postUrl='https://www.facebook.com/groups/1567661940074941/permalink/3487061328134983/';
 const marker='Hermes link test 20260517-083244';
 const commentText='Check this deal: https://mavlynk.com/kbKSH';
 const open=await ixPost('profile-open',{profile_id:20,args:['--disable-popup-blocking',postUrl],load_extensions:true,cookies_backup:false,load_profile_info_page:false});
 const browser=await chromium.connectOverCDP(open.data.ws || ('http://'+open.data.debugging_address),{timeout:30000});
 const page=browser.contexts()[0].pages().find(p=>!p.isClosed()) || await browser.contexts()[0].newPage();
 await page.goto(postUrl,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
 await page.waitForTimeout(10000);
 const data=await page.evaluate(({marker,commentText})=>({
   url: location.href,
   title: document.title,
   markerVisible: document.body.innerText.includes(marker),
   commentVisible: document.body.innerText.includes(commentText),
   kbKSHVisible: document.body.innerText.includes('kbKSH'),
   snippets: document.body.innerText.split('\n').filter(l=>l.includes(marker)||l.includes('mavlynk')||l.includes('Deal of today')).slice(0,50),
   links:[...document.querySelectorAll('a[href]')].map(a=>a.href).filter(h=>h.includes('3487061328134983')||h.includes('mavlynk')).slice(0,20)
 }),{marker,commentText});
 console.log(JSON.stringify(data,null,2));
 await browser.close().catch(()=>{});
})().catch(e=>{console.error(e.stack||e.message);process.exit(1)});
