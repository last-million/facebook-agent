const { chromium } = require('playwright-core');
async function ixPost(p,b,t=60000){const c=new AbortController();const tm=setTimeout(()=>c.abort(),t);try{const r=await fetch('http://127.0.0.1:53200/api/v2/'+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{}),signal:c.signal});const x=await r.text();try{return JSON.parse(x)}catch{throw new Error(x.slice(0,300))}}finally{clearTimeout(tm)}}
(async()=>{
  const profileId = 10;
  const groupId = '4854972804605257';
  const pendingUrl = `https://www.facebook.com/groups/${groupId}/pending_posts/`;
  console.log(JSON.stringify({step:'opening',profileId,pendingUrl}));
  const open = await ixPost('profile-open',{profile_id:profileId,args:['--disable-popup-blocking',pendingUrl],load_extensions:true,cookies_backup:false,load_profile_info_page:false});
  const endpoint = open?.data?.ws || ('http://'+open?.data?.debugging_address);
  const browser = await chromium.connectOverCDP(endpoint,{timeout:30000});
  try {
    const ctx = browser.contexts()[0] || await browser.newContext();
    const page = ctx.pages().find(p=>!p.isClosed()) || await ctx.newPage();
    await page.goto(pendingUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(()=>{});
    await page.waitForTimeout(8000);
    await page.mouse.wheel(0,800).catch(()=>{});
    await page.waitForTimeout(3000);
    const snap = await page.evaluate(()=>{
      const body = (document.body.innerText||'').trim();
      const sample = body.split('\n').filter(Boolean).slice(0, 60);
      const visibleArticles = [...document.querySelectorAll('[role="article"]')].filter(a => {const r=a.getBoundingClientRect(); return r.width>50 && r.height>50;});
      const articleSummaries = visibleArticles.slice(0,3).map(a => {
        const text = (a.innerText||'').slice(0, 800);
        const allBtns = [...a.querySelectorAll('[role="button"], button, a[role="button"]')].map(b => (b.innerText||b.getAttribute('aria-label')||'').replace(/\s+/g,' ').trim()).filter(Boolean).slice(0,30);
        return { text, buttons: allBtns };
      });
      return { sampleBodyLines: sample, visibleArticleCount: visibleArticles.length, articleSummaries };
    });
    console.log(JSON.stringify({step:'pending_view', ...snap}, null, 2));
  } finally {
    await browser.close().catch(()=>{});
    await ixPost('profile-close',{profile_id:profileId},15000).catch(()=>{});
  }
})().catch(e=>{console.error(JSON.stringify({step:'error',message:e.message}));process.exit(1);});
