const { chromium } = require('playwright-core');
async function ixPost(p,b,t=60000){const c=new AbortController();const tm=setTimeout(()=>c.abort(),t);try{const r=await fetch('http://127.0.0.1:53200/api/v2/'+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{}),signal:c.signal});const x=await r.text();try{return JSON.parse(x)}catch{throw new Error(x.slice(0,300))}}finally{clearTimeout(tm)}}
const EXT_ID = 'ndoliganogoohcgigfagdepbgpjbdbkh';
(async()=>{
  const profileId = 40;
  // Try multiple Walmart URLs
  const testUrls = [
    'https://www.walmart.com/ip/1844338762',
    'https://www.walmart.com/ip/14278061055',
    'https://www.walmart.com/ip/18018958800',
  ];
  console.log(JSON.stringify({step:'opening',profileId}));
  const open = await ixPost('profile-open',{profile_id:profileId,args:['--disable-popup-blocking'],load_extensions:true,cookies_backup:false,load_profile_info_page:false});
  const endpoint = open?.data?.ws || ('http://'+open?.data?.debugging_address);
  const browser = await chromium.connectOverCDP(endpoint,{timeout:30000});
  try {
    const ctx = browser.contexts()[0] || await browser.newContext();
    const productPage = ctx.pages().find(p=>!p.isClosed()) || await ctx.newPage();

    // First: check extension's full state - publisher info + active merchants
    const extPage = await ctx.newPage();
    await extPage.goto(`chrome-extension://${EXT_ID}/popup.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await extPage.waitForTimeout(2500);
    const extState = await extPage.evaluate(() => {
      const p = window.ConnexityPubRdPopup || {};
      return {
        publisherId: String(p.publisherId || ''),
        publisherInfo: p.publisherInfo ? JSON.parse(JSON.stringify(p.publisherInfo)) : null,
        activeMerchantsArray: Array.isArray(p.activeMerchantsArray) ? p.activeMerchantsArray.slice(0, 30) : null,
        activeMerchantsCount: Array.isArray(p.activeMerchantsArray) ? p.activeMerchantsArray.length : null,
        merchant: p.merchant || null,
      };
    });
    console.log(JSON.stringify({step:'extension_global_state', ...extState}, null, 2));

    // Test each URL
    for (const productUrl of testUrls) {
      console.log(JSON.stringify({step:'testing_url', productUrl}));
      await productPage.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(()=>{});
      await productPage.waitForTimeout(2500);
      await productPage.bringToFront();

      const freshExt = await ctx.newPage();
      await freshExt.goto(`chrome-extension://${EXT_ID}/popup.html`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await freshExt.waitForTimeout(1500);
      const result = await freshExt.evaluate(async (url) => {
        if (!window.ConnexityPubRdPopup) return { error: 'no_popup_api' };
        window.ConnexityPubRdPopup.url = url;
        window.ConnexityPubRdPopup.tabTitle = 'Test Product';
        try { window.ConnexityPubRdPopup.init && window.ConnexityPubRdPopup.init(); } catch (e) {}
        await new Promise(r => setTimeout(r, 3500));
        const btn = document.querySelector('#generate_link_button');
        return {
          url: location.href.includes('popup.html') ? url : location.href,
          merchant: window.ConnexityPubRdPopup.merchant || null,
          retailerOffline: /retailer offline/i.test(document.body.innerText || ''),
          bodyTextShort: (document.body.innerText || '').slice(0, 300),
          generateButtonVisible: btn ? btn.offsetParent !== null : null,
          generateButtonText: btn ? btn.innerText : null,
        };
      }, productUrl);
      console.log(JSON.stringify({step:'url_result', ...result}, null, 2));
      await freshExt.close().catch(() => {});
    }
  } finally {
    await browser.close().catch(()=>{});
    await ixPost('profile-close',{profile_id:profileId},15000).catch(()=>{});
  }
})().catch(e=>{console.error(JSON.stringify({step:'error',message:e.message}));process.exit(1);});
