const { chromium } = require('playwright-core');

async function ixPost(path, body) {
  const res = await fetch('http://127.0.0.1:53200/api/v2/' + path, {
    method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body || {})
  });
  return res.json();
}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
async function clickDeleteForVisiblePost(page, marker) {
  // Click the Actions menu for the smallest visible container that contains marker.
  const clickedActions = await page.evaluate((marker) => {
    const roots = [...document.querySelectorAll('[role="article"], div')]
      .filter(el => (el.innerText || '').includes(marker))
      .filter(el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length))
      .sort((a,b) => (a.innerText || '').length - (b.innerText || '').length);
    for (const root of roots) {
      const buttons = [...root.querySelectorAll('[role="button"],button')];
      const action = buttons.find(b => /Actions for this post/i.test(b.getAttribute('aria-label') || ''));
      if (action) {
        action.scrollIntoView({block:'center'});
        action.click();
        return {ok:true, rootText:(root.innerText||'').slice(0,500)};
      }
    }
    return {ok:false, roots: roots.length};
  }, marker);
  console.log(JSON.stringify({step:'actions', marker, clickedActions}, null, 2));
  if (!clickedActions.ok) return false;
  await sleep(2500);

  const deleteClicked = await page.evaluate(() => {
    const items = [...document.querySelectorAll('[role="menuitem"], [role="button"], div, span')]
      .filter(el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const del = items.find(el => /^Delete post$/i.test((el.innerText || '').replace(/\s+/g,' ').trim()));
    if (del) { del.click(); return true; }
    return false;
  });
  console.log(JSON.stringify({step:'delete_menu_clicked', marker, deleteClicked}));
  if (!deleteClicked) return false;
  await sleep(2500);

  const confirmClicked = await page.evaluate(() => {
    const candidates = [...document.querySelectorAll('[role="button"],button,div,span')]
      .filter(el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    // Prefer buttons in active dialog with exact Delete text.
    const del = candidates.find(el => /^Delete$/i.test((el.innerText || '').replace(/\s+/g,' ').trim()) || /^Move to trash$/i.test((el.innerText || '').replace(/\s+/g,' ').trim()));
    if (del) { del.click(); return (del.innerText || '').replace(/\s+/g,' ').trim(); }
    return '';
  });
  console.log(JSON.stringify({step:'confirm_clicked', marker, confirmClicked}));
  await sleep(7000);
  return !!confirmClicked;
}

(async()=>{
  const profileId = 20;
  const groupUrl = 'https://www.facebook.com/groups/1567661940074941/';
  const uniqueUrl = 'https://www.facebook.com/groups/1567661940074941/permalink/3487061328134983/';
  const open = await ixPost('profile-open', {profile_id:profileId,args:['--disable-popup-blocking', uniqueUrl],load_extensions:true,cookies_backup:false,load_profile_info_page:false});
  const browser = await chromium.connectOverCDP(open.data.ws || ('http://' + open.data.debugging_address), {timeout:30000});
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find(p=>!p.isClosed()) || await ctx.newPage();
  const results = [];

  // 1) Delete the known permalink test post.
  await page.goto(uniqueUrl, {waitUntil:'domcontentloaded', timeout:60000}).catch(()=>{});
  await sleep(9000);
  const beforeUnique = await page.evaluate(() => ({url:location.href,title:document.title,text:document.body.innerText.includes('Hermes link test 20260517-083244')}));
  console.log(JSON.stringify({step:'before_unique', beforeUnique}, null, 2));
  if (beforeUnique.text) {
    const ok = await clickDeleteForVisiblePost(page, 'Hermes link test 20260517-083244');
    results.push({target:'Hermes link test 20260517-083244', ok});
  } else {
    results.push({target:'Hermes link test 20260517-083244', ok:false, reason:'not visible before delete'});
  }

  // 2) Scan feed for earlier test posts. Use recent feed context and own Delete controls only.
  await page.goto(groupUrl + '?sorting_setting=CHRONOLOGICAL', {waitUntil:'domcontentloaded', timeout:60000}).catch(()=>{});
  await sleep(10000);
  const markers = ['Special dea for today', 'Deal of today'];
  for (const marker of markers) {
    for (let attempt=0; attempt<3; attempt++) {
      const present = await page.evaluate((marker) => document.body.innerText.includes(marker), marker);
      console.log(JSON.stringify({step:'feed_marker_present', marker, attempt, present}));
      if (!present) break;
      const ok = await clickDeleteForVisiblePost(page, marker);
      results.push({target:marker, attempt, ok});
      if (!ok) break;
      await sleep(3000);
    }
  }

  // 3) Verify known unique URL and marker visibility after deletion.
  await page.goto(uniqueUrl, {waitUntil:'domcontentloaded', timeout:60000}).catch(()=>{});
  await sleep(9000);
  const verifyUnique = await page.evaluate(() => ({url:location.href,title:document.title,markerVisible:document.body.innerText.includes('Hermes link test 20260517-083244'),bodySnippet:document.body.innerText.slice(0,800)}));

  await page.goto(groupUrl + '?sorting_setting=CHRONOLOGICAL', {waitUntil:'domcontentloaded', timeout:60000}).catch(()=>{});
  await sleep(9000);
  const verifyFeed = await page.evaluate(() => ({
    uniqueVisible: document.body.innerText.includes('Hermes link test 20260517-083244'),
    specialVisible: document.body.innerText.includes('Special dea for today'),
    dealVisible: document.body.innerText.includes('Deal of today'),
  }));
  console.log(JSON.stringify({step:'final', results, verifyUnique, verifyFeed}, null, 2));
  await browser.close().catch(()=>{});
})().catch(e=>{console.error(JSON.stringify({step:'error',message:e.message,stack:e.stack}));process.exit(1)});
