const { chromium } = require('playwright-core');
async function ixPost(p,b,t=60000){const c=new AbortController();const tm=setTimeout(()=>c.abort(),t);try{const r=await fetch('http://127.0.0.1:53200/api/v2/'+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{}),signal:c.signal});const x=await r.text();try{return JSON.parse(x)}catch{throw new Error(x.slice(0,300))}}finally{clearTimeout(tm)}}
const EXT_ID = 'ndoliganogoohcgigfagdepbgpjbdbkh';
(async()=>{
  const profileId = 40;
  const productUrl = 'https://www.walmart.com/ip/1844338762';
  const open = await ixPost('profile-open',{profile_id:profileId,args:['--disable-popup-blocking'],load_extensions:true,cookies_backup:false,load_profile_info_page:false});
  const endpoint = open?.data?.ws || ('http://'+open?.data?.debugging_address);
  const browser = await chromium.connectOverCDP(endpoint,{timeout:30000});
  try {
    const ctx = browser.contexts()[0] || await browser.newContext();
    const productPage = ctx.pages().find(p=>!p.isClosed()) || await ctx.newPage();
    await productPage.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(()=>{});
    await productPage.waitForTimeout(2500);

    const extPage = await ctx.newPage();
    // CRITICAL: inject the mock BEFORE the popup script runs
    await extPage.addInitScript((url) => {
      // Wait for chrome to be available, then patch chrome.tabs.query
      const installPatch = () => {
        if (typeof chrome === 'undefined' || !chrome.tabs) return false;
        const origQuery = chrome.tabs.query;
        chrome.tabs.query = function(qi, cb) {
          // For any "active true currentWindow true" call, return our product tab
          if (qi && (qi.active || qi.currentWindow)) {
            const fakeTab = { id: 999, windowId: 1, active: true, url, title: 'Walmart Product', highlighted: true, pinned: false, status: 'complete' };
            if (typeof cb === 'function') { try { cb([fakeTab]); } catch (_) {} return; }
            return Promise.resolve([fakeTab]);
          }
          // Other queries: pass-through
          if (typeof cb === 'function') return origQuery.call(chrome.tabs, qi, cb);
          return origQuery.call(chrome.tabs, qi);
        };
        window.__sylMockInstalled = true;
        return true;
      };
      if (!installPatch()) {
        const obs = setInterval(() => { if (installPatch()) clearInterval(obs); }, 30);
        setTimeout(() => clearInterval(obs), 5000);
      }
    }, productUrl);
    await extPage.goto(`chrome-extension://${EXT_ID}/popup.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await extPage.waitForTimeout(4000);
    const state1 = await extPage.evaluate(() => ({
      mockInstalled: Boolean(window.__sylMockInstalled),
      bodyText: (document.body.innerText || '').slice(0, 400),
      generateBtnVisible: (() => { const b = document.querySelector('#generate_link_button'); return b ? b.offsetParent !== null : null; })(),
      generateBtnText: (() => { const b = document.querySelector('#generate_link_button'); return b ? b.innerText : null; })(),
      merchant: window.ConnexityPubRdPopup?.merchant || null,
    }));
    console.log(JSON.stringify({step:'after_load_with_mock', ...state1}, null, 2));

    if (state1.generateBtnVisible) {
      console.log(JSON.stringify({step:'clicking_generate'}));
      await extPage.click('#generate_link_button');
      await extPage.waitForTimeout(8000);
      const final = await extPage.evaluate(() => ({
        deepLink: document.querySelector('#deepLink')?.value || '',
        globalDeeplink: window.generatedDeeplink || '',
        bodyText: (document.body.innerText || '').slice(0, 500),
      }));
      console.log(JSON.stringify({step:'generation_result', ...final}, null, 2));
    } else {
      console.log(JSON.stringify({step:'button_still_not_visible', message: 'Mock chrome.tabs.query may not have helped'}));
    }
  } finally {
    await browser.close().catch(()=>{});
    await ixPost('profile-close',{profile_id:profileId},15000).catch(()=>{});
  }
})().catch(e=>{console.error(JSON.stringify({step:'error',message:e.message}));process.exit(1);});
