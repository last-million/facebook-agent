const { chromium } = require('playwright-core');
async function ixPost(p,b,t=60000){const c=new AbortController();const tm=setTimeout(()=>c.abort(),t);try{const r=await fetch('http://127.0.0.1:53200/api/v2/'+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{}),signal:c.signal});const x=await r.text();try{return JSON.parse(x)}catch{throw new Error(x.slice(0,300))}}finally{clearTimeout(tm)}}
(async()=>{
  const profileId = 40;
  const productUrl = 'https://www.walmart.com/ip/1844338762';
  console.log(JSON.stringify({step:'opening',profileId}));
  const open = await ixPost('profile-open',{profile_id:profileId,args:['--disable-popup-blocking'],load_extensions:true,cookies_backup:false,load_profile_info_page:false});
  const endpoint = open?.data?.ws || ('http://'+open?.data?.debugging_address);
  const browser = await chromium.connectOverCDP(endpoint,{timeout:30000});
  try {
    const ctx = browser.contexts()[0] || await browser.newContext();
    const page = ctx.pages().find(p=>!p.isClosed()) || await ctx.newPage();
    // First check shopyourlikes.com directly
    console.log(JSON.stringify({step:'visit_syl_home'}));
    await page.goto('https://www.shopyourlikes.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(()=>{});
    await page.waitForTimeout(8000);
    const homeSnap = await page.evaluate(()=>{
      const body = (document.body.innerText||'').slice(0, 800);
      const url = location.href;
      const title = document.title;
      const buttons = [...document.querySelectorAll('button, a[role="button"]')].map(b=>(b.innerText||b.getAttribute('aria-label')||'').replace(/\s+/g,' ').trim()).filter(t=>t.length>0 && t.length<60).slice(0,15);
      const loggedIn = /sign out|log out|my account|dashboard|publisher/i.test(body);
      const loginPrompt = /log in|sign in|email|password/i.test(body);
      return { url, title, bodyFirstChars: body, buttons, loggedIn, loginPrompt };
    });
    console.log(JSON.stringify({step:'syl_home', ...homeSnap}, null, 2));
    // Try the extension click flow approach - open product page in new tab, then trigger extension
    console.log(JSON.stringify({step:'visit_walmart_product', productUrl}));
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(()=>{});
    await page.waitForTimeout(8000);
    const productSnap = await page.evaluate(()=>{
      const buttons = [...document.querySelectorAll('button')].map(b=>({text:(b.innerText||'').replace(/\s+/g,' ').trim(), id: b.id, classes: b.className})).filter(b=>b.text.length>0 && b.text.length<60).slice(0,20);
      const generateBtns = [...document.querySelectorAll('#generate_link_button, [id*="generate"], [class*="generate"]')].map(b=>({id: b.id, class: b.className, text:(b.innerText||'').slice(0,80), visible: b.offsetParent !== null, hidden: b.hidden}));
      return { url: location.href, title: document.title, buttons: buttons.slice(0,10), generateBtns };
    });
    console.log(JSON.stringify({step:'walmart_product', ...productSnap}, null, 2));
  } finally {
    await browser.close().catch(()=>{});
    await ixPost('profile-close',{profile_id:profileId},15000).catch(()=>{});
  }
})().catch(e=>{console.error(JSON.stringify({step:'error',message:e.message,stack:e.stack}));process.exit(1);});
