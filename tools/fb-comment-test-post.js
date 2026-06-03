const { chromium } = require('playwright-core');
async function ixPost(path, body) { const res=await fetch('http://127.0.0.1:53200/api/v2/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})}); return res.json(); }
(async()=>{
 const fs=require('fs');
 const payload = process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) : {};
 const groupUrl=payload.groupUrl || 'https://www.facebook.com/groups/1567661940074941/';
 const commentText=payload.commentText || 'Check this deal: https://mavlynk.com/kbKSH';
 const targetText=payload.postText || 'Deal of today';
 const open=await ixPost('profile-open',{profile_id:Number(payload.profileId || 20),args:['--disable-popup-blocking',groupUrl],load_extensions:true,cookies_backup:false,load_profile_info_page:false});
 const browser=await chromium.connectOverCDP(open.data.ws || ('http://'+open.data.debugging_address),{timeout:30000});
 const ctx=browser.contexts()[0]; const page=ctx.pages().find(p=>!p.isClosed()) || await ctx.newPage();
 await page.goto(groupUrl,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
 await page.waitForTimeout(7000);
 const clicked=await page.evaluate((targetText)=>{
   const roots=[...document.querySelectorAll('div')].filter(el=>(el.innerText||'').includes(targetText));
   for(const root of roots.reverse()){
     const btn=[...root.querySelectorAll('[role="button"],button')].find(b=>/Leave a comment|Comment/i.test((b.getAttribute('aria-label')||b.innerText||'')));
     if(btn){btn.click(); return true;}
   }
   return false;
 }, targetText);
 console.log(JSON.stringify({step:'comment_button', clicked}));
 await page.waitForTimeout(2500);
 let typed=false;
 const locs=[page.getByRole('textbox',{name:/comment|write a comment/i}), page.locator('div[contenteditable="true"][role="textbox"]'), page.locator('div[contenteditable="true"]')];
 for(const loc of locs){
   const n=await loc.count().catch(()=>0);
   for(let i=n-1;i>=0;i--){
     const box=loc.nth(i);
     try{
       if(!(await box.isVisible({timeout:800}).catch(()=>false))) continue;
       await box.click({timeout:3000});
       await page.keyboard.type(commentText,{delay:65});
       await page.waitForTimeout(800);
       await page.keyboard.press('Enter');
       typed=true; break;
     }catch(e){}
   }
   if(typed) break;
 }
 console.log(JSON.stringify({step:'comment_submit', typed}));
 await page.waitForTimeout(7000);
 const verify=await page.evaluate((commentText)=>document.body.innerText.includes(commentText), commentText);
 console.log(JSON.stringify({step:'verify_comment_visible', verify}));
 await browser.close().catch(()=>{});
})().catch(e=>{console.error(e.stack||e.message);process.exit(1)});
