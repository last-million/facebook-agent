const { chromium } = require('playwright-core');
async function ixPost(p,b,t=60000){const c=new AbortController();const tm=setTimeout(()=>c.abort(),t);try{const r=await fetch('http://127.0.0.1:53200/api/v2/'+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{}),signal:c.signal});const x=await r.text();try{return JSON.parse(x)}catch{throw new Error(x.slice(0,300))}}finally{clearTimeout(tm)}}
(async()=>{
  const profileId = 16; // publisher
  const postUrl = 'https://www.facebook.com/groups/4854972804605257/permalink/25915026441506587/';
  console.log(JSON.stringify({step:'opening',profileId,postUrl}));
  const open = await ixPost('profile-open',{profile_id:profileId,args:['--disable-popup-blocking',postUrl],load_extensions:true,cookies_backup:false,load_profile_info_page:false});
  const endpoint = open?.data?.ws || ('http://'+open?.data?.debugging_address);
  const browser = await chromium.connectOverCDP(endpoint,{timeout:30000});
  try {
    const ctx = browser.contexts()[0] || await browser.newContext();
    const page = ctx.pages().find(p=>!p.isClosed()) || await ctx.newPage();
    await page.goto(postUrl,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
    await page.waitForTimeout(10000);
    await page.mouse.wheel(0,500).catch(()=>{});
    await page.waitForTimeout(3000);
    const snap = await page.evaluate(()=>{
      const body = (document.body.innerText||'');
      const hasMavlynk = body.includes('mavlynk.com');
      const hasMarker = body.includes('Walmart deal alert');
      const mavlynkMatches = body.match(/mavlynk\.com\/[A-Za-z0-9]+/g) || [];
      const commentSnippets = body.split('\n').filter(l => l.toLowerCase().includes('mavlynk') || l.includes('Save With Emily') || l.includes('comment')).slice(0,10);
      const title = document.title || '';
      return { title, hasMavlynk, hasMarker, mavlynkUrls: [...new Set(mavlynkMatches)], commentSnippets, bodyFirst500: body.slice(0, 500) };
    });
    console.log(JSON.stringify({step:'inspection', ...snap}, null, 2));
  } finally {
    await browser.close().catch(()=>{});
    await ixPost('profile-close',{profile_id:profileId},15000).catch(()=>{});
  }
})().catch(e=>{console.error(JSON.stringify({step:'error',message:e.message}));process.exit(1);});
