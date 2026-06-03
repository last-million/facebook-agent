const { chromium } = require('playwright-core');
async function ixPost(p,b,t=60000){const c=new AbortController();const tm=setTimeout(()=>c.abort(),t);try{const r=await fetch('http://127.0.0.1:53200/api/v2/'+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{}),signal:c.signal});const x=await r.text();try{return JSON.parse(x)}catch{throw new Error(x.slice(0,300))}}finally{clearTimeout(tm)}}
(async()=>{
  // Use moderator profile 41 (not Amandra), since Amandra might be filtered from her own pending view
  const profileId = 41;
  const groupId = '4854972804605257';
  const pendingUrl = `https://www.facebook.com/groups/${groupId}/pending_posts/`;
  console.log(JSON.stringify({step:'opening', profileId, pendingUrl}));
  const open = await ixPost('profile-open',{profile_id:profileId,args:['--disable-popup-blocking',pendingUrl],load_extensions:true,cookies_backup:false,load_profile_info_page:false});
  const endpoint = open?.data?.ws || ('http://'+open?.data?.debugging_address);
  const browser = await chromium.connectOverCDP(endpoint,{timeout:30000});
  try {
    const ctx = browser.contexts()[0] || await browser.newContext();
    const page = ctx.pages().find(p=>!p.isClosed()) || await ctx.newPage();
    const cookies = await ctx.cookies(['https://www.facebook.com']);
    const cUser = cookies.find(c=>c.name==='c_user');
    console.log(JSON.stringify({step:'session_c_user', value: cUser?.value || null}));
    await page.goto(pendingUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(()=>{});
    await page.waitForTimeout(8000);
    // scroll a few times to load all pending entries
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, 1500).catch(()=>{});
      await page.waitForTimeout(2500);
    }
    const snap = await page.evaluate(()=>{
      const url = location.href;
      const body = (document.body.innerText||'').replace(/\s+/g,' ').slice(0, 800);
      const arts = [...document.querySelectorAll('[role="article"]')].filter(a=>{const r=a.getBoundingClientRect();return r.width>50&&r.height>50;});
      // count near "Pending posts · N"
      const heading = Array.from(document.querySelectorAll('h1, h2, h3, span')).map(el=>(el.innerText||'').trim()).find(t=>/pending posts/i.test(t)) || '';
      const summaries = arts.slice(0, 12).map(a=>{
        const text = (a.innerText||'').replace(/\s+/g,' ').slice(0, 220);
        const authorEl = [...a.querySelectorAll('h3 a, h4 a, strong a')].find(x => (x.innerText||'').trim().length > 1);
        const author = authorEl ? authorEl.innerText.trim().slice(0,80) : '';
        return { author, textPreview: text };
      });
      return { url, heading, totalArticles: arts.length, body, articles: summaries };
    });
    console.log(JSON.stringify({step:'pending_scan_deep', ...snap}, null, 2));
  } finally {
    await browser.close().catch(()=>{});
    await ixPost('profile-close',{profile_id:profileId},15000).catch(()=>{});
  }
})().catch(e=>{console.error(JSON.stringify({step:'error',message:e.message}));process.exit(1);});
