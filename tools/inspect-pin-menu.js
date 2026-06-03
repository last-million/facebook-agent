// READ-ONLY inspection: open an iX profile, go to a recent post permalink,
// find our first comment, open its actions (kebab) menu, and dump every menu
// item + button aria-label so we can fix pinVisibleComment's selectors.
// Does NOT post, comment, or click Pin. Pure DOM inspection.
const { chromium } = require('playwright-core');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function ixPost(path, body, timeoutMs = 70000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('http://127.0.0.1:53200/api/v2/' + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });
    const text = await res.text();
    const parsed = JSON.parse(text);
    if (parsed?.error && Number(parsed.error.code || 0) !== 0) throw new Error(`ix ${path} err ${parsed.error.code}: ${parsed.error.message}`);
    return parsed;
  } finally { clearTimeout(timer); }
}

(async () => {
  const profileId = Number(process.argv[2] || 10);
  const postUrl = String(process.argv[3] || '');
  if (!postUrl) throw new Error('usage: node inspect-pin-menu.js <profileId> <postUrl>');

  console.log(JSON.stringify({ step: 'opening_profile', profileId }));
  // Close first to avoid 'already open' issues
  await ixPost('profile-close', { profile_id: profileId }).catch(() => {});
  await sleep(1500);
  const open = await ixPost('profile-open', {
    profile_id: profileId,
    args: ['--disable-popup-blocking', postUrl],
    load_extensions: false,
    cookies_backup: false,
    load_profile_info_page: false,
  });
  const endpoint = open.data.ws || ('http://' + open.data.debugging_address);
  console.log(JSON.stringify({ step: 'profile_opened', endpoint }));

  const browser = await chromium.connectOverCDP(endpoint, { timeout: 60000 });
  const context = browser.contexts()[0];
  let page = context.pages().find(p => /facebook\.com/i.test(p.url())) || context.pages()[0];
  await page.bringToFront();
  if (!page.url().includes('permalink')) {
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  }
  // FB permalink loads comments lazily. Wait for the comment text to appear,
  // scrolling to trigger lazy render.
  for (let i = 0; i < 12; i++) {
    await sleep(2500);
    await page.mouse.wheel(0, 600).catch(() => {});
    const hasComment = await page.evaluate(() => /mavlynk|Check this deal/i.test(document.body.innerText || '')).catch(() => false);
    if (hasComment) { console.log(JSON.stringify({ step: 'comment_text_visible', afterMs: (i + 1) * 2500 })); break; }
  }
  await sleep(1500);

  // Find a comment article (has a mavlynk link or is under the post). Dump the
  // structure of comment action controls.
  const dump = await page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const out = { commentBlocks: [], allButtonsNearComments: [] };
    // Comments usually live in [role="article"] nested under the main post,
    // or in div[aria-label^="Comment by"]. Capture candidates.
    const commentContainers = [
      ...document.querySelectorAll('[aria-label^="Comment by" i], [aria-label*="comment" i][role="article"], [role="article"]'),
    ].filter(visible);
    for (const c of commentContainers.slice(0, 12)) {
      const txt = (c.innerText || '').replace(/\s+/g, ' ').trim();
      if (!/mavlynk|http/i.test(txt) && txt.length > 400) continue; // skip the big post body
      const controls = [...c.querySelectorAll('[aria-label], [role="button"], button, a[role="link"]')]
        .filter(visible)
        .slice(0, 25)
        .map(el => ({
          tag: el.tagName,
          role: el.getAttribute('role') || '',
          ariaLabel: (el.getAttribute('aria-label') || '').slice(0, 90),
          ariaHaspopup: el.getAttribute('aria-haspopup') || '',
          text: ((el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()).slice(0, 50),
          hasSvg: !!el.querySelector('svg'),
        }))
        .filter(b => b.ariaLabel || b.text);
      out.commentBlocks.push({
        ariaLabel: (c.getAttribute('aria-label') || '').slice(0, 90),
        textStart: txt.slice(0, 120),
        controls,
      });
    }
    return out;
  }).catch(e => ({ error: String(e.message || e) }));

  console.log(JSON.stringify({ step: 'comment_dom_dump', dump }, null, 2));

  // DEFINITIVE approach: hover the visible "Like/Reply" action row via REAL
  // mouse move (that row IS rendered), which makes FB render the kebab next to
  // it. Then locate + click the kebab with real mouse.
  const likeBtn = page.locator('[aria-label^="Comment by" i]').filter({ hasText: /mavlynk|http/i }).first().getByRole('button', { name: /^Like$/i }).first();
  const likeBox = await likeBtn.boundingBox().catch(() => null);
  console.log(JSON.stringify({ step: 'like_box', likeBox }));
  if (likeBox) {
    // Move along the action row to trigger hover-render of the kebab
    await page.mouse.move(likeBox.x + 5, likeBox.y + likeBox.height / 2, { steps: 10 });
    await sleep(900);
    await page.mouse.move(likeBox.x + 40, likeBox.y + likeBox.height / 2, { steps: 6 });
    await sleep(900);
    const kbox2 = await page.locator('[aria-haspopup="menu"][aria-label*="Edit or delete" i]').first().boundingBox().catch(() => null);
    console.log(JSON.stringify({ step: 'kebab_box_after_row_hover', kbox2 }));
    if (kbox2) {
      await page.mouse.move(kbox2.x + kbox2.width / 2, kbox2.y + kbox2.height / 2, { steps: 5 });
      await sleep(400);
      await page.mouse.click(kbox2.x + kbox2.width / 2, kbox2.y + kbox2.height / 2);
      await sleep(1600);
      const items2 = await page.evaluate(() => {
        const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
        return [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]')].filter(visible).map(m => ({ role: m.getAttribute('role'), aria: (m.getAttribute('aria-label') || '').slice(0, 80), text: ((m.innerText || m.textContent || '').replace(/\s+/g, ' ').trim()).slice(0, 80) }));
      }).catch(() => []);
      console.log(JSON.stringify({ step: 'ROW_HOVER_MENU_ITEMS', itemCount: items2.length, items: items2 }, null, 2));
      await page.keyboard.press('Escape').catch(() => {});
    }
  }

  // BEST approach: call the kebab element's native .click() directly (triggers
  // React onClick without needing CSS hover). Then dump role=menuitem.
  const nativeClickMenu = await page.evaluate(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const arts = [...document.querySelectorAll('[aria-label^="Comment by" i]')].filter(a => /mavlynk|http/i.test(a.innerText || ''));
    const art = arts[0];
    if (!art) return { error: 'no_comment' };
    const kebab = [...art.querySelectorAll('[aria-haspopup="menu"]')].find(b => /edit or delete|more|manage|action/i.test(b.getAttribute('aria-label') || ''));
    if (!kebab) return { error: 'no_kebab', btns: [...art.querySelectorAll('[aria-haspopup]')].map(b => b.getAttribute('aria-label')) };
    kebab.click(); // native click
    await sleep(1500);
    const items = [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]')]
      .filter(visible)
      .map(m => ({ role: m.getAttribute('role'), aria: (m.getAttribute('aria-label') || '').slice(0, 80), text: ((m.innerText || m.textContent || '').replace(/\s+/g, ' ').trim()).slice(0, 80) }));
    return { kebabAria: kebab.getAttribute('aria-label'), itemCount: items.length, items };
  }).catch(e => ({ error: String(e.message || e) }));
  console.log(JSON.stringify({ step: 'NATIVE_CLICK_MENU', nativeClickMenu }, null, 2));
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(800);

  // Use a REAL Playwright click on the "Edit or delete this" kebab (synthetic
  // dispatchEvent doesn't trigger FB's React menu). Then dump menu items.
  try {
    // Force hover-hidden comment action buttons to be visible + clickable.
    await page.addStyleTag({ content: `
      [aria-haspopup="menu"] { opacity: 1 !important; visibility: visible !important; pointer-events: auto !important; }
      [aria-label*="Edit or delete" i], [aria-label*="More options" i] { opacity: 1 !important; visibility: visible !important; width:auto !important; height:auto !important; pointer-events:auto !important; }
    ` }).catch(() => {});
    await sleep(800);
    const kebabLoc = page.locator('[aria-haspopup="menu"][aria-label*="Edit or delete" i], [aria-haspopup="menu"][aria-label*="more" i], [aria-haspopup="menu"][aria-label*="manage" i]').first();
    const kc = await kebabLoc.count().catch(() => 0);
    console.log(JSON.stringify({ step: 'kebab_locator_count', count: kc }));
    if (kc > 0) {
      await kebabLoc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      await sleep(500);
      // Real hardware-style mouse move over the comment to trigger CSS :hover
      // (synthetic hover doesn't reveal the kebab). Move to comment center,
      // then to the kebab's box, then click via mouse.
      const commentLoc = page.locator('[aria-label^="Comment by" i]').filter({ hasText: /mavlynk|http/i }).first();
      const cbox = await commentLoc.boundingBox().catch(() => null);
      if (cbox) {
        await page.mouse.move(cbox.x + cbox.width / 2, cbox.y + cbox.height / 2, { steps: 8 });
        await sleep(700);
      }
      const kbox = await kebabLoc.boundingBox().catch(() => null);
      console.log(JSON.stringify({ step: 'kebab_box', kbox }));
      if (kbox) {
        await page.mouse.move(kbox.x + kbox.width / 2, kbox.y + kbox.height / 2, { steps: 6 });
        await sleep(500);
        await page.mouse.click(kbox.x + kbox.width / 2, kbox.y + kbox.height / 2);
      } else {
        await kebabLoc.click({ timeout: 5000, force: true }).catch((e) => console.log(JSON.stringify({ step: 'kebab_click_err', err: String(e.message || e).slice(0, 120) })));
      }
      await sleep(1800);
      const realMenu = await page.evaluate(() => {
        const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
        return [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]')]
          .filter(visible)
          .map(m => ({ role: m.getAttribute('role'), aria: (m.getAttribute('aria-label') || '').slice(0, 80), text: ((m.innerText || m.textContent || '').replace(/\s+/g, ' ').trim()).slice(0, 80) }));
      }).catch(e => ({ error: String(e.message || e) }));
      console.log(JSON.stringify({ step: 'REAL_MENU_ITEMS', realMenu }, null, 2));
      await page.keyboard.press('Escape').catch(() => {});
    }
  } catch (e) { console.log(JSON.stringify({ step: 'real_click_flow_err', err: String(e.message || e) })); }

  // (legacy synthetic dump below, kept for comparison)
  const menuDump = await page.evaluate(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const articles = [...document.querySelectorAll('[role="article"]')].filter(visible);
    const target = articles.find(a => /mavlynk|http/i.test(a.innerText || ''));
    if (!target) return { error: 'no_comment_with_link_found', articleCount: articles.length };
    // Hover to reveal action buttons
    for (const t of ['mouseover', 'mousemove', 'mouseenter']) target.dispatchEvent(new MouseEvent(t, { bubbles: true, view: window }));
    await sleep(800);
    // The comment kebab on OUR OWN comment is aria-haspopup="menu" with label
    // "Edit or delete this". Target aria-haspopup=menu specifically (avoid the
    // product-preview "Show more information" button).
    const kebab = [...target.querySelectorAll('[aria-haspopup="menu"]')]
      .filter(visible)
      .find(b => /edit or delete|more|action|option|manage/i.test((b.getAttribute('aria-label') || '')))
      || [...target.querySelectorAll('[aria-haspopup="menu"]')].filter(visible)[0];
    if (!kebab) {
      return {
        error: 'kebab_not_found_in_comment',
        sampleButtons: [...target.querySelectorAll('[role="button"],[aria-label]')].filter(visible).slice(0, 20).map(b => ({ aria: (b.getAttribute('aria-label') || '').slice(0, 80), text: (b.innerText || '').slice(0, 40) })),
      };
    }
    kebab.dispatchEvent(new MouseEvent('click', { bubbles: true, view: window }));
    await sleep(1200);
    const menuItems = [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="menu"] [role="button"], div[role="menu"] span')]
      .filter(visible)
      .slice(0, 30)
      .map(m => ({ role: m.getAttribute('role') || '', aria: (m.getAttribute('aria-label') || '').slice(0, 80), text: ((m.innerText || m.textContent || '').replace(/\s+/g, ' ').trim()).slice(0, 60) }))
      .filter(m => m.aria || m.text);
    return { kebabAria: kebab.getAttribute('aria-label'), menuItems };
  }).catch(e => ({ error: String(e.message || e) }));

  console.log(JSON.stringify({ step: 'kebab_menu_dump', menuDump }, null, 2));

  await ixPost('profile-close', { profile_id: profileId }).catch(() => {});
  console.log(JSON.stringify({ step: 'done' }));
  process.exit(0);
})().catch(err => { console.error('FAIL:', err.message); process.exit(1); });
