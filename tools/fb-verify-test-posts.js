const { chromium } = require('playwright-core');
async function ixPost(path, body) { const res=await fetch('http://127.0.0.1:53200/api/v2/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})}); return res.json(); }
(async()=>{
 const groupUrl='https://www.facebook.com/groups/1567661940074941/';
 const open=await ixPost('profile-open',{profile_id:20,args:['--disable-popup-blocking',groupUrl],load_extensions:true,cookies_backup:false,load_profile_info_page:false});
 const browser=await chromium.connectOverCDP(open.data.ws || ('http://'+open.data.debugging_address),{timeout:30000});
 const page=browser.contexts()[0].pages().find(p=>!p.isClosed()) || await browser.contexts()[0].newPage();
 await page.goto(groupUrl,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
 await page.waitForTimeout(10000);
 const result=await page.evaluate(()=>{
  const text=document.body.innerText;
  const needles=['Deal of today','Special dea for today','https://mavlynk.com/kbKSH','https://mavlynk.com/JaEiW','https://mavlynk.com/PrWaJ'];
  const articleTexts=[...document.querySelectorAll('[role="article"], div')]
    .map(el=>(el.innerText||'').replace(/\s+/g,' ').trim())
    .filter(t=>t.includes('Deal of today')||t.includes('Special dea for today')||t.includes('mavlynk.com'))
    .slice(-20);
  const links=[...document.querySelectorAll('a[href]')].map(a=>a.href).filter(h=>h.includes('/groups/1567661940074941/')).map(h=>h.split('?')[0]);
  return {checks:Object.fromEntries(needles.map(n=>[n,text.includes(n)])), articleTexts, groupLinks:[...new Set(links)].slice(0,20)};
 });
 console.log(JSON.stringify(result,null,2));
 await browser.close().catch(()=>{});
})().catch(e=>{console.error(e.stack||e.message);process.exit(1)});
