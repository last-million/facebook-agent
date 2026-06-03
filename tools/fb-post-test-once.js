const { chromium } = require('playwright-core');
const fs = require('fs');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function jitter(min, max) { return Math.floor(min + Math.random() * (max - min + 1)); }
async function humanPause(min=500, max=1600) {
  const HARD_MIN = 1000;
  const HARD_MAX = 3000;
  const clampedMin = Math.max(HARD_MIN, Math.min(HARD_MAX, min));
  const clampedMax = Math.max(clampedMin, Math.min(HARD_MAX, max));
  await sleep(jitter(clampedMin, clampedMax));
}

async function ixPost(path, body) {
  const res = await fetch('http://127.0.0.1:53200/api/v2/' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new Error(text.slice(0, 1000)); }
}

async function clickFirst(page, candidates, opts = {}) {
  for (const c of candidates) {
    try {
      const loc = typeof c === 'string' ? page.locator(c) : c;
      const count = await loc.count().catch(() => 0);
      if (!count) continue;
      const first = loc.first();
      await first.waitFor({ state: 'visible', timeout: opts.timeout || 3000 });
      await first.hover({ timeout: 2000 }).catch(() => {});
      await humanPause(180, 500);
      await first.click({ timeout: opts.timeout || 5000 });
      return first;
    } catch (_) {}
  }
  return null;
}

async function typeIntoComposer(page, text) {
  const candidates = [
    page.getByRole('textbox', { name: /what.*mind|write.*something|create.*public.*post/i }),
    page.locator('div[role="dialog"] div[contenteditable="true"][role="textbox"]'),
    page.locator('div[role="dialog"] div[contenteditable="true"]'),
    page.locator('div[contenteditable="true"][role="textbox"]'),
    page.locator('div[contenteditable="true"]'),
  ];
  for (const loc of candidates) {
    const count = await loc.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const el = loc.nth(i);
      try {
        if (!(await el.isVisible({ timeout: 1000 }).catch(() => false))) continue;
        await el.click({ timeout: 5000 });
        await humanPause(300, 800);
        await page.keyboard.type(text, { delay: jitter(55, 125) });
        return true;
      } catch (_) {}
    }
  }
  return false;
}

async function extractPostUrls(page, groupUrl) {
  return await page.evaluate((groupUrl) => {
    const out = [];
    const groupMatch = groupUrl.match(/groups\/(\d+)/);
    const gid = groupMatch && groupMatch[1];
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.href || '';
      if (!href.includes('facebook.com')) continue;
      if (gid && href.includes(`/groups/${gid}/posts/`)) out.push(href.split('?')[0]);
      if (gid && href.includes(`/groups/${gid}/permalink/`)) out.push(href.split('?')[0]);
      if (href.includes('/posts/') && href.includes(gid || '/groups/')) out.push(href.split('?')[0]);
    }
    return [...new Set(out)].slice(0, 20);
  }, groupUrl);
}

async function main() {
  const payload = process.argv[2]
    ? JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
    : JSON.parse(process.env.FB_POST_PAYLOAD || '{}');
  const required = ['profileId', 'groupUrl', 'postText', 'imagePath', 'commentText'];
  for (const k of required) if (!payload[k]) throw new Error('missing payload field: ' + k);
  if (!fs.existsSync(payload.imagePath)) throw new Error('image not found: ' + payload.imagePath);

  const open = await ixPost('profile-open', {
    profile_id: Number(payload.profileId),
    args: ['--disable-popup-blocking', payload.groupUrl],
    load_extensions: true,
    cookies_backup: false,
    load_profile_info_page: false,
  });
  const data = open.data || {};
  const endpoint = data.ws || (data.debugging_address ? 'http://' + data.debugging_address : '');
  if (!endpoint) throw new Error('IXBrowser did not return CDP endpoint: ' + JSON.stringify(open));
  console.log(JSON.stringify({ step: 'ix_open', profileId: data.profile_id, endpoint }));

  let browser;
  try {
  browser = await chromium.connectOverCDP(endpoint, { timeout: 30000 });
  const context = browser.contexts()[0] || await browser.newContext();
  let page = context.pages().find(p => !p.isClosed()) || await context.newPage();
  await page.goto(payload.groupUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => console.log(JSON.stringify({ step: 'goto_warn', message: e.message })));
  await humanPause(3500, 6500);
  console.log(JSON.stringify({ step: 'page_loaded', url: page.url(), title: await page.title().catch(() => '') }));

  const beforeUrls = await extractPostUrls(page, payload.groupUrl);
  console.log(JSON.stringify({ step: 'before_urls', count: beforeUrls.length, urls: beforeUrls.slice(0, 5) }));

  // Open composer.
  const opened = await clickFirst(page, [
    page.getByText(/write something|what's on your mind|create a public post/i),
    page.getByRole('button', { name: /write something|what's on your mind|create a public post/i }),
    page.locator('div[role="button"]').filter({ hasText: /write something|what's on your mind|create a public post/i }),
    page.locator('[aria-label*="Create a public post" i]'),
  ], { timeout: 6000 });
  if (!opened) throw new Error('could not open Facebook group composer');
  await humanPause(1600, 3000);

  const typed = await typeIntoComposer(page, payload.postText);
  if (!typed) throw new Error('could not type into composer');
  await humanPause(800, 1600);

  // Attach photo. Prefer file input, otherwise click Photo/video and retry.
  let fileInputs = page.locator('div[role="dialog"] input[type="file"], input[type="file"]');
  let count = await fileInputs.count().catch(() => 0);
  if (!count) {
    await clickFirst(page, [
      page.getByRole('button', { name: /photo\/video|photo|video/i }),
      page.locator('div[role="dialog"] [aria-label*="Photo" i]'),
      page.locator('[aria-label*="Photo/video" i]'),
    ], { timeout: 4000 });
    await humanPause(1000, 2200);
    fileInputs = page.locator('div[role="dialog"] input[type="file"], input[type="file"]');
    count = await fileInputs.count().catch(() => 0);
  }
  if (!count) throw new Error('no file input found for image upload');
  await fileInputs.first().setInputFiles(payload.imagePath);
  await humanPause(4500, 8000);
  console.log(JSON.stringify({ step: 'image_attached', imagePath: payload.imagePath }));

  // Click Post.
  const postButtonCandidates = [
    page.locator('div[role="dialog"]').getByRole('button', { name: /^Post$/i }),
    page.getByRole('button', { name: /^Post$/i }),
    page.locator('div[aria-label="Post"][role="button"]'),
  ];
  let clickedPost = false;
  for (const loc of postButtonCandidates) {
    const count = await loc.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const btn = loc.nth(i);
      try {
        if (!(await btn.isVisible({ timeout: 1000 }).catch(() => false))) continue;
        const disabled = await btn.getAttribute('aria-disabled').catch(() => null);
        if (disabled === 'true') continue;
        await btn.hover().catch(() => {});
        await humanPause(400, 1000);
        await btn.click({ timeout: 8000 });
        clickedPost = true;
        break;
      } catch (_) {}
    }
    if (clickedPost) break;
  }
  if (!clickedPost) throw new Error('could not click enabled Post button');
  console.log(JSON.stringify({ step: 'post_clicked' }));
  await humanPause(10000, 16000);

  // Try adding first comment if provided.
  let postUrls = await extractPostUrls(page, payload.groupUrl);
  const newUrls = postUrls.filter(u => !beforeUrls.includes(u));
  console.log(JSON.stringify({ step: 'after_post_urls', count: postUrls.length, newUrls }));

  // Best effort comment: click first visible Comment button on top/current post.
  if (payload.commentText) {
    const commentClicked = await clickFirst(page, [
      page.getByRole('button', { name: /^Comment$/i }),
      page.locator('[aria-label="Comment"]'),
      page.locator('span').filter({ hasText: /^Comment$/i }),
    ], { timeout: 5000 });
    if (commentClicked) {
      await humanPause(1000, 2200);
      const commentBoxes = [
        page.getByRole('textbox', { name: /write a comment|comment/i }),
        page.locator('div[contenteditable="true"][role="textbox"]'),
        page.locator('div[contenteditable="true"]'),
      ];
      let commented = false;
      for (const loc of commentBoxes) {
        const n = await loc.count().catch(() => 0);
        for (let i = 0; i < n; i++) {
          const box = loc.nth(i);
          try {
            if (!(await box.isVisible({ timeout: 700 }).catch(() => false))) continue;
            await box.click({ timeout: 3000 });
            await page.keyboard.type(payload.commentText, { delay: jitter(45, 115) });
            await humanPause(400, 900);
            await page.keyboard.press('Enter');
            commented = true;
            break;
          } catch (_) {}
        }
        if (commented) break;
      }
      console.log(JSON.stringify({ step: 'comment_attempted', commented }));
      await humanPause(4000, 8000);
    } else {
      console.log(JSON.stringify({ step: 'comment_skipped', reason: 'comment_button_not_found' }));
    }
  }

  postUrls = await extractPostUrls(page, payload.groupUrl);
  console.log(JSON.stringify({ step: 'result', postUrls: postUrls.slice(0, 10), likelyNewPostUrl: (newUrls[0] || postUrls[0] || '') }));
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

main().catch(async (e) => {
  console.error(JSON.stringify({ step: 'error', message: e.message, stack: e.stack }));
  process.exit(1);
});
