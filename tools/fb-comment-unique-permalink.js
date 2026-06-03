const { chromium } = require('playwright-core');
async function ixPost(path, body) { const res=await fetch('http://127.0.0.1:53200/api/v2/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})}); return res.json(); }
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
(async()=>{
 const profileId=20;
 const postUrl='https://www.facebook.com/groups/1567661940074941/permalink/3487061328134983/';
 const commentText='Check this deal: https://mavlynk.com/kbKSH';
 const marker='Hermes link test 20260517-083244';
 const open=await ixPost('profile-open',{profile_id:profileId,args:['--disable-popup-blocking',postUrl],load_extensions:true,cookies_backup:false,load_profile_info_page:false});
 const browser=await chromium.connectOverCDP(open.data.ws || ('http://'+open.data.debugging_address),{timeout:30000});
 const ctx=browser.contexts()[0];
 const page=ctx.pages().find(p=>!p.isClosed()) || await ctx.newPage();
 await page.goto(postUrl,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
 await sleep(8000);
 let clicked=await page.evaluate(()=>{
   const btns=[...document.querySelectorAll('[role="button"],button,a')];
   const b=btns.find(x=>/Leave a comment|Comment/i.test((x.getAttribute('aria-label')||x.innerText||'')));
   if(b){b.click(); return true;}
   return false;
 });
 await sleep(2500);
 let typed=false;
 for(const loc of [page.getByRole('textbox',{name:/write a comment|comment/i}), page.locator('div[contenteditable="true"][role="textbox"]'), page.locator('div[contenteditable="true"]')]){
   const n=await loc.count().catch(()=>0);
   for(let i=n-1;i>=0;i--){
     const box=loc.nth(i);
     try{
       if(!(await box.isVisible({timeout:800}).catch(()=>false))) continue;
       await box.click({timeout:3000});
       await page.keyboard.type(commentText,{delay:65});
       await sleep(700);
       await page.keyboard.press('Enter');
       typed=true; break;
     }catch(e){}
   }
   if(typed) break;
 }
 await sleep(9000);
 const verify=await page.evaluate(({marker,commentText})=>({
   url: location.href,
   title: document.title,
   markerVisible: document.body.innerText.includes(marker),
   commentVisible: document.body.innerText.includes(commentText),
   shortVisible: document.body.innerText.includes('mavlynk.com/kbKSH'),
   snippet: document.body.innerText.split('\n').filter(l=>l.includes(marker)||l.includes('mavlynk')).slice(0,30)
 }),{marker,commentText});
 console.log(JSON.stringify({clicked,typed,verify},null,2));
 await browser.close().catch(()=>{});
})().catch(e=>{console.error(e.stack||e.message);process.exit(1)});
