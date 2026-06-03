const { chromium } = require('playwright-core');
async function ixPost(p,b,t=60000){const c=new AbortController();const tm=setTimeout(()=>c.abort(),t);try{const r=await fetch('http://127.0.0.1:53200/api/v2/'+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{}),signal:c.signal});const x=await r.text();try{return JSON.parse(x)}catch{throw new Error(x.slice(0,300))}}finally{clearTimeout(tm)}}
const EXT_ID = 'ndoliganogoohcgigfagdepbgpjbdbkh';
(async()=>{
  const profileId = 40;
  const open = await ixPost('profile-open',{profile_id:profileId,args:['--disable-popup-blocking'],load_extensions:true,cookies_backup:false,load_profile_info_page:false});
  const endpoint = open?.data?.ws || ('http://'+open?.data?.debugging_address);
  const browser = await chromium.connectOverCDP(endpoint,{timeout:30000});
  try {
    const ctx = browser.contexts()[0] || await browser.newContext();
    const productPage = ctx.pages().find(p=>!p.isClosed()) || await ctx.newPage();
    await productPage.goto('https://www.walmart.com/ip/1844338762', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(()=>{});
    await productPage.waitForTimeout(3000);

    // Also visit the extension's OPTIONS page to see what's configured there
    const optsPage = await ctx.newPage();
    await optsPage.goto(`chrome-extension://${EXT_ID}/options.html`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(e => console.log(JSON.stringify({step:'options_err',e: e.message})));
    await optsPage.waitForTimeout(2500);
    const optsSnap = await optsPage.evaluate(() => ({
      url: location.href,
      title: document.title,
      bodyText: (document.body.innerText || '').slice(0, 1500),
    }));
    console.log(JSON.stringify({step:'options_page', ...optsSnap}, null, 2));
    await optsPage.close().catch(()=>{});

    // Now force refresh via popup
    const extPage = await ctx.newPage();
    await extPage.goto(`chrome-extension://${EXT_ID}/popup.html`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await extPage.waitForTimeout(2000);
    const refreshResult = await extPage.evaluate(async () => {
      const p = window.ConnexityPubRdPopup;
      if (!p) return { error: 'no_popup_api' };
      const out = { calls: [] };
      try { if (typeof p.getPublisherInfo === 'function') { await p.getPublisherInfo(); out.calls.push('getPublisherInfo'); } } catch (e) { out.publisherInfoError = e.message; }
      await new Promise(r => setTimeout(r, 2000));
      try { if (typeof p.getActiveMerchants === 'function') { await p.getActiveMerchants(); out.calls.push('getActiveMerchants'); } } catch (e) { out.merchantsError = e.message; }
      await new Promise(r => setTimeout(r, 3000));
      out.publisherInfo = p.publisherInfo ? JSON.parse(JSON.stringify(p.publisherInfo)) : null;
      out.activeMerchantsCount = Array.isArray(p.activeMerchantsArray) ? p.activeMerchantsArray.length : 'not_array';
      out.activeMerchantsSample = Array.isArray(p.activeMerchantsArray) ? p.activeMerchantsArray.slice(0, 10) : null;
      return out;
    });
    console.log(JSON.stringify({step:'force_refresh', ...refreshResult}, null, 2));
  } finally {
    await browser.close().catch(()=>{});
    await ixPost('profile-close',{profile_id:profileId},15000).catch(()=>{});
  }
})().catch(e=>{console.error(JSON.stringify({step:'error',message:e.message}));process.exit(1);});
