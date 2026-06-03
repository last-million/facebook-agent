const { chromium } = require('playwright-core');
async function ixPost(p,b,t=60000){const c=new AbortController();const tm=setTimeout(()=>c.abort(),t);try{const r=await fetch('http://127.0.0.1:53200/api/v2/'+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{}),signal:c.signal});const x=await r.text();try{return JSON.parse(x)}catch{throw new Error(x.slice(0,300))}}finally{clearTimeout(tm)}}
const EXT_ID = 'ndoliganogoohcgigfagdepbgpjbdbkh';
(async()=>{
  const open = await ixPost('profile-open',{profile_id:40,args:['--disable-popup-blocking'],load_extensions:true,cookies_backup:false,load_profile_info_page:false});
  const endpoint = open?.data?.ws || ('http://'+open?.data?.debugging_address);
  const browser = await chromium.connectOverCDP(endpoint,{timeout:30000});
  try {
    const ctx = browser.contexts()[0] || await browser.newContext();
    const productPage = ctx.pages().find(p=>!p.isClosed()) || await ctx.newPage();
    await productPage.goto('https://www.walmart.com/ip/1844338762', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(()=>{});
    await productPage.waitForTimeout(2500);
    const extPage = await ctx.newPage();
    await extPage.goto(`chrome-extension://${EXT_ID}/popup.html`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await extPage.waitForTimeout(2000);
    const data = await extPage.evaluate(async () => {
      const p = window.ConnexityPubRdPopup;
      if (!p) return { error: 'no_popup' };
      try { const r = p.getPublisherInfo(); if (r && r.catch) await r.catch(() => {}); } catch (e) {}
      await new Promise(r => setTimeout(r, 1500));
      try { const r = p.getActiveMerchants(); if (r && r.catch) await r.catch(() => {}); } catch (e) {}
      await new Promise(r => setTimeout(r, 3000));
      const arr = Array.isArray(p.activeMerchantsArray) ? p.activeMerchantsArray : [];
      const walmartMatches = arr.filter(m => /walmart/i.test(m.merchantName || '') || /walmart/i.test(m.merchantUrl || ''));
      const totalCount = arr.length;
      // Try generation after refresh
      p.url = 'https://www.walmart.com/ip/1844338762';
      p.tabTitle = 'Test Product';
      try { if (typeof p.init === 'function') p.init(); } catch (e) {}
      await new Promise(r => setTimeout(r, 4500));
      const btn = document.querySelector('#generate_link_button');
      const bodyText = (document.body.innerText || '').slice(0, 400);
      return {
        totalActiveMerchants: totalCount,
        walmartMatches,
        afterInitBodyText: bodyText,
        afterInitButtonVisible: btn ? btn.offsetParent !== null : null,
        afterInitButtonText: btn ? btn.innerText : null,
        merchantSetByExt: p.merchant || null,
      };
    });
    console.log(JSON.stringify({step:'walmart_search_result', ...data}, null, 2));
  } finally {
    await browser.close().catch(()=>{});
    await ixPost('profile-close',{profile_id:40},15000).catch(()=>{});
  }
})().catch(e=>{console.error(JSON.stringify({step:'error',message:e.message}));process.exit(1);});
