const { chromium } = require('playwright-core');
async function ixPost(p,b,t=60000){const c=new AbortController();const tm=setTimeout(()=>c.abort(),t);try{const r=await fetch('http://127.0.0.1:53200/api/v2/'+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{}),signal:c.signal});const x=await r.text();try{return JSON.parse(x)}catch{throw new Error(x.slice(0,300))}}finally{clearTimeout(tm)}}
(async()=>{
  const profileId = 10;
  const groupId = '4854972804605257';
  // Three views worth checking for moderators:
  const targets = [
    { name: 'group_chronological_scrolled', url: `https://www.facebook.com/groups/${groupId}/?sorting_setting=CHRONOLOGICAL` },
    { name: 'pending_posts_admin', url: `https://www.facebook.com/groups/${groupId}/pending_posts/` },
    { name: 'scheduled_posts_admin', url: `https://www.facebook.com/groups/${groupId}/scheduled_posts/` },
    { name: 'group_manage', url: `https://www.facebook.com/groups/${groupId}/manage/` },
  ];
  const open = await ixPost('profile-open',{profile_id:profileId,args:['--disable-popup-blocking'],load_extensions:true,cookies_backup:false,load_profile_info_page:false});
  const endpoint = open?.data?.ws || ('http://'+open?.data?.debugging_address);
  const browser = await chromium.connectOverCDP(endpoint,{timeout:30000});
  try {
    const ctx = browser.contexts()[0] || await browser.newContext();
    const page = ctx.pages().find(p=>!p.isClosed()) || await ctx.newPage();
    for (const target of targets) {
      try {
        console.log(JSON.stringify({step:'visiting', name: target.name, url: target.url}));
        await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e=>{});
        await page.waitForTimeout(6000);
        await page.mouse.wheel(0,1200).catch(()=>{});
        await page.waitForTimeout(3000);
        const snap = await page.evaluate(()=>{
          const body = (document.body.innerText||'').trim();
          const url = location.href;
          const title = document.title || '';
          const arts = [...document.querySelectorAll('[role="article"]')].filter(a=>{const r=a.getBoundingClientRect();return r.width>50&&r.height>50;});
          const summaries = arts.slice(0,5).map(a=>{
            const text = (a.innerText||'').replace(/\s+/g,' ').trim().slice(0,200);
            const links = [...a.querySelectorAll('a[href]')].map(x=>x.href||'').filter(h=>/\/groups\/\d+\/(permalink|posts)\/\d+/.test(h)).slice(0,2);
            const author = [...a.querySelectorAll('strong, h3 a, h4 a')].map(x=>(x.innerText||'').trim()).find(t=>t.length>0&&t.length<80) || '';
            return { author, textPreview: text, permalinks: [...new Set(links)] };
          });
          return {
            url, title,
            bodyFirstChars: body.slice(0, 600),
            hasErrorPage: /content isn't available|content is not available|page not available|sorry, something went wrong|access denied/i.test(body),
            hasPendingTab: /pending posts/i.test(body),
            hasScheduledTab: /scheduled posts/i.test(body),
            articleCount: arts.length,
            articles: summaries,
          };
        });
        console.log(JSON.stringify({step:'snapshot', name: target.name, ...snap}, null, 2));
      } catch (e) {
        console.log(JSON.stringify({step:'target_error', name: target.name, error: e.message}));
      }
    }
  } finally {
    await browser.close().catch(()=>{});
    await ixPost('profile-close',{profile_id:profileId},15000).catch(()=>{});
  }
})().catch(e=>{console.error(JSON.stringify({step:'error',message:e.message}));process.exit(1);});
