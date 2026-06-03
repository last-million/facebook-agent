const { chromium } = require('playwright-core');
async function ixPost(p,b,t=60000){const c=new AbortController();const tm=setTimeout(()=>c.abort(),t);try{const r=await fetch('http://127.0.0.1:53200/api/v2/'+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{}),signal:c.signal});const x=await r.text();try{return JSON.parse(x)}catch{throw new Error(x.slice(0,300))}}finally{clearTimeout(tm)}}
const EXT_ID = 'ndoliganogoohcgigfagdepbgpjbdbkh';
(async()=>{
  const profileId = 40;
  const productUrl = 'https://www.walmart.com/ip/1844338762';
  console.log(JSON.stringify({step:'opening',profileId}));
  const open = await ixPost('profile-open',{profile_id:profileId,args:['--disable-popup-blocking'],load_extensions:true,cookies_backup:false,load_profile_info_page:false});
  const endpoint = open?.data?.ws || ('http://'+open?.data?.debugging_address);
  const browser = await chromium.connectOverCDP(endpoint,{timeout:30000});
  try {
    const ctx = browser.contexts()[0] || await browser.newContext();
    const productPage = ctx.pages().find(p=>!p.isClosed()) || await ctx.newPage();
    await productPage.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(()=>{});
    await productPage.waitForTimeout(3000);
    await productPage.bringToFront();
    const extPage = await ctx.newPage();
    await extPage.goto(`chrome-extension://${EXT_ID}/popup.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await extPage.waitForTimeout(1500);

    // First check publisherId / apiKey VALUES
    const creds = await extPage.evaluate(() => {
      const p = window.ConnexityPubRdPopup || {};
      return { publisherId: String(p.publisherId || ''), apiKeySet: Boolean(p.apiKey && p.apiKey.length > 0), apiKeyLen: (p.apiKey || '').length, statusText: p.statusText || '' };
    });
    console.log(JSON.stringify({step:'creds_check', ...creds}));

    // Inject URL + tabTitle and explicitly call init()
    const initResult = await extPage.evaluate((url) => {
      if (!window.ConnexityPubRdPopup) return { error: 'no_popup_api' };
      try {
        window.ConnexityPubRdPopup.url = url;
        window.ConnexityPubRdPopup.tabTitle = 'Test Product';
        if (typeof window.ConnexityPubRdPopup.init === 'function') {
          window.ConnexityPubRdPopup.init();
          return { initCalled: true };
        }
        if (typeof window.ConnexityPubRdPopup.getStarted === 'function') {
          window.ConnexityPubRdPopup.getStarted();
          return { getStartedCalled: true };
        }
        return { noInitFunction: true };
      } catch (e) {
        return { error: e.message || String(e) };
      }
    }, productUrl);
    console.log(JSON.stringify({step:'init_called', ...initResult}));
    await extPage.waitForTimeout(4000);

    const stateAfterInit = await extPage.evaluate(() => {
      const btn = document.querySelector('#generate_link_button');
      const failure = (document.querySelector('#failure-section, .failure, [class*="failure"]')?.innerText || '').slice(0, 200);
      const status = (document.querySelector('#status, .status-text, .statusText')?.innerText || '').slice(0, 200);
      const visibleSections = [...document.querySelectorAll('section, [id*="section"]')].filter(s => s.offsetParent !== null).map(s => ({ id: s.id || '', cls: s.className || '', text: (s.innerText || '').slice(0, 100) })).slice(0, 8);
      return {
        bodyText: (document.body.innerText || '').slice(0, 600),
        generateButton: btn ? { visible: btn.offsetParent !== null, hidden: btn.hidden, disabled: btn.disabled, text: btn.innerText, classes: btn.className } : null,
        failure, status,
        visibleSections,
      };
    });
    console.log(JSON.stringify({step:'state_after_init', ...stateAfterInit}, null, 2));
  } finally {
    await browser.close().catch(()=>{});
    await ixPost('profile-close',{profile_id:profileId},15000).catch(()=>{});
  }
})().catch(e=>{console.error(JSON.stringify({step:'error',message:e.message}));process.exit(1);});
