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
 console.log(JSON.stringify({step:'loaded',url:page.url(),title:await page.title(),marker:await page.locator(`text=${marker}`).count().catch(()=>0)}));
 // close any menu/dialog
 await page.keyboard.press('Escape').catch(()=>{});
 await sleep(1000);
 // Try all Laurie post action buttons until a menu with Delete post appears.
 const actionButtons = page.getByRole('button', { name: /Actions for this post by Laurie Elizabeth/i });
 const n = await actionButtons.count().catch(()=>0);
 console.log(JSON.stringify({step:'action_count',n}));
 let openedIndex=-1;
 for(let i=n-1;i>=0;i--){
   const btn=actionButtons.nth(i);
   try{
     if(!(await btn.isVisible({timeout:1000}).catch(()=>false))) continue;
     await btn.scrollIntoViewIfNeeded().catch(()=>{});
     await btn.hover().catch(()=>{});
     await sleep(500);
     await btn.click({timeout:5000});
     await sleep(2000);
     const del=page.getByRole('menuitem', { name: /^Delete post$/i });
     const delCount=await del.count().catch(()=>0);
     console.log(JSON.stringify({step:'opened_candidate',i,delCount}));
     if(delCount>0){ openedIndex=i; break; }
     await page.keyboard.press('Escape').catch(()=>{});
     await sleep(500);
   }catch(e){ console.log(JSON.stringify({step:'candidate_error',i,msg:e.message})); }
 }
 if(openedIndex<0) throw new Error('No Delete post menuitem found');
 await page.getByRole('menuitem', { name: /^Delete post$/i }).first().click({timeout:5000});
 await sleep(2500);
 const dialogText=await page.locator('[role="dialog"]').last().innerText({timeout:3000}).catch(e=>'NO_DIALOG '+e.message);
 console.log(JSON.stringify({step:'dialog',dialogText}));
 const dialog=page.locator('[role="dialog"]').last();
 // Prefer exact button inside the dialog.
 const confirmCandidates=[
   dialog.getByRole('button',{name:/^Delete$/i}),
   dialog.getByRole('button',{name:/Move to trash/i}),
   page.getByRole('button',{name:/^Delete$/i}),
   page.getByRole('button',{name:/Move to trash/i})
 ];
 let confirmed=false;
 for(const c of confirmCandidates){
   const cN=await c.count().catch(()=>0);
   for(let i=0;i<cN;i++){
     const b=c.nth(i);
     if(!(await b.isVisible({timeout:700}).catch(()=>false))) continue;
     await b.click({timeout:5000});
     confirmed=true;
     break;
   }
   if(confirmed) break;
 }
 console.log(JSON.stringify({step:'confirmed',confirmed}));
 await sleep(15000);
 await page.reload({waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
 await sleep(10000);
 const verify=await page.evaluate((marker)=>({url:location.href,title:document.title,markerVisible:document.body.innerText.includes(marker),deletePostVisible:document.body.innerText.includes('Delete post'),contentUnavailable:/content isn.t available|not available|removed|deleted/i.test(document.body.innerText),snippets:document.body.innerText.split('\n').filter(l=>/Hermes link test|Deal of today|available|removed|deleted/i.test(l)).slice(0,60)}),marker);
 console.log(JSON.stringify({step:'verify',verify},null,2));
 await browser.close().catch(()=>{});
})().catch(e=>{console.error(JSON.stringify({step:'error',message:e.message,stack:e.stack}));process.exit(1)});
