const { chromium } = require('playwright-core');
async function ixPost(path, body) {
  const res = await fetch('http://127.0.0.1:53200/api/v2/' + path, {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body||{})});
  return await res.json();
}
(async()=>{
 const groupUrl='https://www.facebook.com/groups/1567661940074941/';
 const open=await ixPost('profile-open',{profile_id:20,args:['--disable-popup-blocking',groupUrl],load_extensions:true,cookies_backup:false,load_profile_info_page:false});
 const endpoint=(open.data&&open.data.ws)||('http://'+open.data.debugging_address);
 const browser=await chromium.connectOverCDP(endpoint,{timeout:30000});
 const page=(browser.contexts()[0].pages().find(p=>!p.isClosed())) || await browser.contexts()[0].newPage();
 await page.goto(groupUrl,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
 await page.waitForTimeout(8000);
 const result=await page.evaluate(()=>{
   const target='Deal of today';
   const anchors=[...document.querySelectorAll('a[href]')].map(a=>({href:a.href,text:(a.innerText||a.getAttribute('aria-label')||'').trim()}));
   const posts=[];
   for (const el of [...document.querySelectorAll('div[role="article"], div')]) {
     const text=(el.innerText||'').replace(/\s+/g,' ').trim();
     if (!text.includes(target)) continue;
     const links=[...el.querySelectorAll('a[href]')].map(a=>a.href).filter(h=>/\/groups\/\d+\/(permalink|posts)\//.test(h)).map(h=>h.split('?')[0]);
     posts.push({text:text.slice(0,1000), links:[...new Set(links)].slice(0,10)});
   }
   const allPermalinks=[...new Set(anchors.map(a=>a.href).filter(h=>/\/groups\/\d+\/(permalink|posts)\//.test(h)).map(h=>h.split('?')[0]))].slice(0,20);
   return {url:location.href,title:document.title, containsTarget:document.body.innerText.includes(target), posts, allPermalinks};
 });
 console.log(JSON.stringify(result,null,2));
 await browser.close().catch(()=>{});
})().catch(e=>{console.error(e.stack||e.message);process.exit(1)});
