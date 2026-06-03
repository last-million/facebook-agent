const { chromium } = require('playwright-core');
async function ixPost(p,b,t=60000){const c=new AbortController();const tm=setTimeout(()=>c.abort(),t);try{const r=await fetch('http://127.0.0.1:53200/api/v2/'+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{}),signal:c.signal});const x=await r.text();try{return JSON.parse(x)}catch{throw new Error(x.slice(0,300))}}finally{clearTimeout(tm)}}
(async()=>{
  const profileId = 40;
  const productUrl = 'https://www.walmart.com/ip/1844338762';
  console.log(JSON.stringify({step:'opening',profileId,productUrl}));
  const open = await ixPost('profile-open',{profile_id:profileId,args:['--disable-popup-blocking',productUrl],load_extensions:true,cookies_backup:false,load_profile_info_page:false});
  const endpoint = open?.data?.ws || ('http://'+open?.data?.debugging_address);
  const browser = await chromium.connectOverCDP(endpoint,{timeout:30000});
  const ctx = browser.contexts()[0] || await browser.newContext();
  const page = ctx.pages().find(p=>!p.isClosed()) || await ctx.newPage();
  await page.goto(productUrl,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
  await page.bringToFront();
  console.log(JSON.stringify({step:'product_page_loaded', url: page.url()}));
  console.log(JSON.stringify({step:'instructions', message: 'Profile 40 is now open showing a Walmart product. Click the ShopYourLikes extension icon in the toolbar manually and try to generate the link. Report what you see.'}));
  // Disconnect playwright but leave profile open for user
  await browser.close().catch(()=>{});
  // DO NOT close the profile - user needs to interact
  console.log(JSON.stringify({step:'done', note: 'Profile 40 left open for manual testing. Run stop-facebook-agent.bat or close manually when done.'}));
})().catch(e=>{console.error(JSON.stringify({step:'error',message:e.message}));process.exit(1);});
