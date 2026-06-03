const { chromium } = require('playwright-core');
async function ixPost(p,b,t=60000){const c=new AbortController();const tm=setTimeout(()=>c.abort(),t);try{const r=await fetch('http://127.0.0.1:53200/api/v2/'+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{}),signal:c.signal});const x=await r.text();try{return JSON.parse(x)}catch{throw new Error(x.slice(0,300))}}finally{clearTimeout(tm)}}
(async()=>{
  const profileId = 16;
  const postUrl = 'https://www.facebook.com/groups/4854972804605257/permalink/25917211807954717/';
  const open = await ixPost('profile-open',{profile_id:profileId,args:['--disable-popup-blocking',postUrl],load_extensions:true,cookies_backup:false,load_profile_info_page:false});
  const endpoint = open?.data?.ws || ('http://'+open?.data?.debugging_address);
  const browser = await chromium.connectOverCDP(endpoint,{timeout:30000});
  try {
    const ctx = browser.contexts()[0] || await browser.newContext();
    const page = ctx.pages().find(p=>!p.isClosed()) || await ctx.newPage();
    await page.goto(postUrl,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
    await page.waitForTimeout(8000);
    // scroll to load all comments
    for (let i = 0; i < 5; i++) { await page.mouse.wheel(0,800).catch(()=>{}); await page.waitForTimeout(2000); }
    const result = await page.evaluate(() => {
      // Find the main post's comment area only - the [role="article"] that's the main post
      const articles = [...document.querySelectorAll('[role="article"]')];
      // Each comment is also a [role="article"] usually
      const commentArticles = articles.filter(a => {
        const text = (a.innerText||'');
        return /mavlynk|sylikes|Check this deal/i.test(text);
      });
      const summaries = commentArticles.map(a => {
        const text = (a.innerText||'').replace(/\s+/g, ' ').slice(0,300);
        const mavlynk = ((a.innerText||'').match(/mavlynk\.com\/[A-Za-z0-9]+/g) || []);
        return { text, mavlynkLinks: [...new Set(mavlynk)] };
      });
      return {
        url: location.href,
        title: document.title,
        articlesWithMavlynk: summaries.length,
        articles: summaries,
      };
    });
    console.log(JSON.stringify({step:'count', ...result}, null, 2));
  } finally {
    await browser.close().catch(()=>{});
    await ixPost('profile-close',{profile_id:profileId},15000).catch(()=>{});
  }
})().catch(e=>{console.error(JSON.stringify({step:'error',message:e.message}));process.exit(1);});
