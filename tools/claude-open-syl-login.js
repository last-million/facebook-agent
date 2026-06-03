const { chromium } = require('playwright-core');
async function ixPost(p,b,t=60000){const c=new AbortController();const tm=setTimeout(()=>c.abort(),t);try{const r=await fetch('http://127.0.0.1:53200/api/v2/'+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{}),signal:c.signal});const x=await r.text();try{return JSON.parse(x)}catch{throw new Error(x.slice(0,300))}}finally{clearTimeout(tm)}}
(async()=>{
  const profileId = 40;
  const loginUrl = 'https://www.shopyourlikes.com/login';
  console.log(JSON.stringify({step:'opening',profileId,loginUrl}));
  // Open profile and DO NOT close - leave open so user can log in
  const open = await ixPost('profile-open',{profile_id:profileId,args:['--disable-popup-blocking',loginUrl],load_extensions:true,cookies_backup:false,load_profile_info_page:false});
  const endpoint = open?.data?.ws || ('http://'+open?.data?.debugging_address);
  const browser = await chromium.connectOverCDP(endpoint,{timeout:30000});
  const ctx = browser.contexts()[0] || await browser.newContext();
  const page = ctx.pages().find(p=>!p.isClosed()) || await ctx.newPage();
  await page.goto(loginUrl,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
  await page.waitForTimeout(4000);
  const snap = await page.evaluate(()=>{
    const body = (document.body.innerText||'').slice(0,400);
    return { url: location.href, title: document.title, bodyFirst: body };
  });
  console.log(JSON.stringify({step:'opened_login_page', ...snap}, null, 2));
  console.log(JSON.stringify({step:'instructions', message: 'Profile 40 is now open in IXBrowser. Log into ShopYourLikes manually, then close the IXBrowser window. The session will persist.'}));
  // Disconnect playwright but LEAVE the browser open for user
  await browser.close().catch(()=>{});
  // DO NOT call profile-close — user needs the window open to log in
  console.log(JSON.stringify({step:'done', note: 'Profile 40 remains open in IXBrowser for you to log in manually.'}));
})().catch(e=>{console.error(JSON.stringify({step:'error',message:e.message}));process.exit(1);});
