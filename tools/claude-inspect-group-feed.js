const { chromium } = require('playwright-core');
async function ixPost(p,b,t=60000){const c=new AbortController();const tm=setTimeout(()=>c.abort(),t);try{const r=await fetch('http://127.0.0.1:53200/api/v2/'+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{}),signal:c.signal});const x=await r.text();try{return JSON.parse(x)}catch{throw new Error(x.slice(0,300))}}finally{clearTimeout(tm)}}
(async()=>{
  const profileId = 10;
  const groupId = '4854972804605257';
  const userId = '100090066176436';
  const groupUrl = `https://www.facebook.com/groups/${groupId}/?sorting_setting=CHRONOLOGICAL`;
  console.log(JSON.stringify({step:'opening',profileId,groupUrl}));
  const open = await ixPost('profile-open',{profile_id:profileId,args:['--disable-popup-blocking',groupUrl],load_extensions:true,cookies_backup:false,load_profile_info_page:false});
  const endpoint = open?.data?.ws || ('http://'+open?.data?.debugging_address);
  const browser = await chromium.connectOverCDP(endpoint,{timeout:30000});
  try {
    const ctx = browser.contexts()[0] || await browser.newContext();
    const page = ctx.pages().find(p=>!p.isClosed()) || await ctx.newPage();
    await page.goto(groupUrl,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
    await page.waitForTimeout(8000);
    await page.mouse.wheel(0,1500).catch(()=>{});
    await page.waitForTimeout(3000);
    const snap = await page.evaluate(({userId,gid})=>{
      const arts = [...document.querySelectorAll('[role="article"]')].filter(a=>{const r=a.getBoundingClientRect(); return r.width>50 && r.height>50;});
      return arts.slice(0,10).map(a=>{
        const text = (a.innerText||'').trim().slice(0,250);
        const authorLink = [...a.querySelectorAll('a[href]')].find(x=>(x.href||'').includes(`/groups/${gid}/user/`));
        const authorMatch = authorLink ? (authorLink.href.match(/\/user\/(\d+)/)||[])[1] : '';
        const isAmandra = authorMatch === userId;
        const timeMarker = [...a.querySelectorAll('a span, time')].map(x=>(x.innerText||x.getAttribute('title')||'').trim()).find(t=>/min|hour|today|second|just now|\d+\s*(s|m|h)\b/i.test(t)) || '';
        const permalink = ([...a.querySelectorAll('a[href]')].map(x=>x.href).find(h=>/\/groups\/\d+\/(permalink|posts)\/\d+/.test(h))||'').split('?')[0];
        return { author: authorLink?.innerText?.trim().slice(0,60) || '', authorUserId: authorMatch, isAmandra, timeMarker, permalink, textPreview: text };
      });
    },{userId,gid:groupId});
    console.log(JSON.stringify({step:'feed_snapshot',articles: snap}, null, 2));
    const amandraPosts = snap.filter(a => a.isAmandra);
    console.log(JSON.stringify({step:'summary', totalVisible: snap.length, amandraPosts: amandraPosts.length, amandraDetails: amandraPosts}, null, 2));
  } finally {
    await browser.close().catch(()=>{});
    await ixPost('profile-close',{profile_id:profileId},15000).catch(()=>{});
  }
})().catch(e=>{console.error(JSON.stringify({step:'error',message:e.message}));process.exit(1);});
