const { chromium } = require('playwright-core');
async function ixPost(p,b,t=60000){const c=new AbortController();const tm=setTimeout(()=>c.abort(),t);try{const r=await fetch('http://127.0.0.1:53200/api/v2/'+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{}),signal:c.signal});const x=await r.text();try{return JSON.parse(x)}catch{throw new Error(x.slice(0,300))}}finally{clearTimeout(tm)}}
const EXT_ID = 'ndoliganogoohcgigfagdepbgpjbdbkh';
(async()=>{
  const profileId = 40;
  console.log(JSON.stringify({step:'opening',profileId}));
  const open = await ixPost('profile-open',{profile_id:profileId,args:['--disable-popup-blocking'],load_extensions:true,cookies_backup:false,load_profile_info_page:false});
  const endpoint = open?.data?.ws || ('http://'+open?.data?.debugging_address);
  const browser = await chromium.connectOverCDP(endpoint,{timeout:30000});
  try {
    const ctx = browser.contexts()[0] || await browser.newContext();
    const page = ctx.pages().find(p=>!p.isClosed()) || await ctx.newPage();
    await page.goto('https://www.walmart.com/ip/1844338762', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(()=>{});
    await page.waitForTimeout(4000);
    const extPage = await ctx.newPage();
    await extPage.goto(`chrome-extension://${EXT_ID}/popup.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await extPage.waitForTimeout(2000);
    const snap = await extPage.evaluate(() => {
      const body = (document.body.innerText || '').slice(0, 1500);
      const allButtons = [...document.querySelectorAll('button')].map(b => ({
        id: b.id,
        text: (b.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80),
        visible: b.offsetParent !== null,
        hidden: b.hidden,
        disabled: b.disabled,
        className: b.className.slice(0, 120),
      }));
      const inputs = [...document.querySelectorAll('input, textarea, select')].map(i => ({ id: i.id, type: i.type, value: (i.value || '').slice(0, 80), placeholder: i.placeholder || '' }));
      const dataAttrs = {};
      const root = document.body;
      for (const attr of root.attributes || []) { if (attr.name.startsWith('data-')) dataAttrs[attr.name] = attr.value; }
      const globalPub = typeof window.ConnexityPubRdPopup !== 'undefined' ? Object.keys(window.ConnexityPubRdPopup || {}) : null;
      return { url: location.href, title: document.title, bodyText: body, buttons: allButtons, inputs, dataAttrs, globalPub };
    });
    console.log(JSON.stringify({step:'extension_popup', ...snap}, null, 2));
  } finally {
    await browser.close().catch(()=>{});
    await ixPost('profile-close',{profile_id:profileId},15000).catch(()=>{});
  }
})().catch(e=>{console.error(JSON.stringify({step:'error',message:e.message,stack:e.stack}));process.exit(1);});
