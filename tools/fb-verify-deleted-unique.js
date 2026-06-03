const { chromium } = require('playwright-core');
async function ixPost(path, body) { const res=await fetch('http://127.0.0.1:53200/api/v2/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})}); return res.json(); }
(async()=>{
 const url='https://www.facebook.com/groups/1567661940074941/permalink/3487061328134983/';
 const open=await ixPost('profile-open',{profile_id:20,args:['--disable-popup-blocking','about:blank'],load_extensions:true,cookies_backup:false,load_profile_info_page:false});
 const browser=await chromium.connectOverCDP(open.data.ws || ('http://'+open.data.debugging_address),{timeout:30000});
 const ctx=browser.contexts()[0];
 const page=await ctx.newPage();
 await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
 await page.waitForTimeout(12000);
 await page.reload({waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
 await page.waitForTimeout(8000);
 const data=await page.evaluate(()=>({
   url: location.href,
   title: document.title,
   markerInBody: document.body.innerText.includes('Hermes link test 20260517-083244'),
   dealInBody: document.body.innerText.includes('Deal of today'),
   deleteControl: document.body.innerText.includes('Delete post'),
   contentUnavailable: /content isn.t available|This content isn.t available|removed|not available/i.test(document.body.innerText),
   snippets: document.body.innerText.split('\n').filter(l=>/Hermes link test|Deal of today|content|removed|available/i.test(l)).slice(0,50)
 }));
 console.log(JSON.stringify(data,null,2));
 await browser.close().catch(()=>{});
})().catch(e=>{console.error(e.stack||e.message);process.exit(1)});
