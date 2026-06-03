const { chromium } = require('playwright-core');
async function ixPost(path, body) { const res=await fetch('http://127.0.0.1:53200/api/v2/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})}); return res.json(); }
(async()=>{
 const urls=['https://m.facebook.com/groups/1567661940074941?sorting_setting=CHRONOLOGICAL','https://mbasic.facebook.com/groups/1567661940074941?sorting_setting=CHRONOLOGICAL'];
 const open=await ixPost('profile-open',{profile_id:20,args:['--disable-popup-blocking',urls[0]],load_extensions:true,cookies_backup:false,load_profile_info_page:false});
 const browser=await chromium.connectOverCDP(open.data.ws || ('http://'+open.data.debugging_address),{timeout:30000});
 const ctx=browser.contexts()[0];
 const out=[];
 for (const u of urls) {
   const page=await ctx.newPage();
   await page.goto(u,{waitUntil:'domcontentloaded',timeout:60000}).catch(e=>out.push({u,error:String(e.message)}));
   await page.waitForTimeout(10000);
   const data=await page.evaluate(()=>{
     const body=document.body.innerText;
     const links=[...document.querySelectorAll('a[href]')].map(a=>({href:a.href,text:(a.innerText||'').replace(/\s+/g,' ').trim()}));
     const interesting=links.filter(x=>/story_fbid|permalink|multi_permalinks|posts|groups\/1567661940074941/i.test(x.href) || /Deal of today|Special dea|Comment|Full Story|More/i.test(x.text));
     return {url:location.href,title:document.title,checks:{deal:body.includes('Deal of today'),special:body.includes('Special dea for today'),kbKSH:body.includes('kbKSH'),JaEiW:body.includes('JaEiW'),PrWaJ:body.includes('PrWaJ')}, snippets: body.split('\n').filter(l=>/Deal of today|Special dea|mavlynk|Laurie/i.test(l)).slice(0,50), interesting:interesting.slice(0,120)};
   });
   out.push(data);
   await page.close().catch(()=>{});
 }
 console.log(JSON.stringify(out,null,2));
 await browser.close().catch(()=>{});
})().catch(e=>{console.error(e.stack||e.message);process.exit(1)});
