const { chromium } = require('playwright-core');

async function ixPost(path, body, timeoutMs = 60000) {
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
    try { return JSON.parse(text); } catch { throw new Error('non-json: ' + text.slice(0, 300)); }
  } finally { clearTimeout(timer); }
}

(async () => {
  const profileId = 10;
  const groupId = '4854972804605257';
  const userIdFromCookie = '100090066176436';
  const groupUrl = `https://www.facebook.com/groups/${groupId}`;
  const userPageUrl = `https://www.facebook.com/groups/${groupId}/user/${userIdFromCookie}/`;

  console.log(JSON.stringify({ step: 'opening_profile', profileId }));
  const open = await ixPost('profile-open', {
    profile_id: profileId,
    args: ['--disable-popup-blocking', userPageUrl],
    load_extensions: true,
    cookies_backup: false,
    load_profile_info_page: false,
  });
  if (!open?.data?.ws && !open?.data?.debugging_address) {
    console.log(JSON.stringify({ step: 'open_failed', response: open }));
    return;
  }
  const endpoint = open.data.ws || ('http://' + open.data.debugging_address);
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 30000 });
  try {
    const context = browser.contexts()[0] || await browser.newContext();
    const page = context.pages().find(p => !p.isClosed()) || await context.newPage();
    console.log(JSON.stringify({ step: 'connected', currentUrl: page.url() }));

    const cookies = await context.cookies(['https://www.facebook.com']);
    const cUser = cookies.find(c => c.name === 'c_user');
    console.log(JSON.stringify({ step: 'cookies', c_user: cUser?.value || null, totalCookies: cookies.length }));

    await page.goto(userPageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => console.log(JSON.stringify({ step: 'goto_warn', url: userPageUrl, error: e.message })));
    await page.waitForTimeout(7000);
    console.log(JSON.stringify({ step: 'on_user_page', currentUrl: page.url(), title: await page.title().catch(() => '') }));

    const snapshot = await page.evaluate(({ gid }) => {
      const bodyText = (document.body.innerText || '').trim();
      const articles = [...document.querySelectorAll('[role="article"]')];
      const visibleArticles = articles.filter(a => {
        const r = a.getBoundingClientRect();
        return r.width > 50 && r.height > 50;
      });
      const recentPostSummaries = visibleArticles.slice(0, 6).map(a => {
        const text = (a.innerText || '').trim().slice(0, 500);
        const permalinks = [...a.querySelectorAll('a[href]')]
          .map(x => x.href || '')
          .filter(h => /\/groups\/\d+\/(permalink|posts)\/\d+/.test(h))
          .slice(0, 4);
        const imgs = [...a.querySelectorAll('img')]
          .map(x => ({ src: (x.currentSrc || x.src || '').slice(0, 120), w: x.naturalWidth || x.width, h: x.naturalHeight || x.height }))
          .filter(i => i.w > 80 && i.h > 80 && !/emoji|static\.xx|rsrc\.php/.test(i.src));
        const timestamps = [...a.querySelectorAll('a[role="link"] span, time')]
          .map(x => (x.innerText || x.getAttribute('title') || '').trim())
          .filter(t => /min|hour|today|yesterday|\d+\s*(s|m|h|d)\s*$/i.test(t))
          .slice(0, 2);
        return { textPreview: text, permalinks: [...new Set(permalinks)], imageCount: imgs.length, sampleImage: imgs[0]?.src || '', timestamps };
      });
      return {
        bodyHasLoginForm: /Log into Facebook|Forgot password|Create new account/i.test(bodyText.slice(0, 600)),
        bodyHasChallenge: /You're temporarily|Please enter|verify your|two-factor|security check/i.test(bodyText),
        articleCount: articles.length,
        visibleArticleCount: visibleArticles.length,
        firstBodyLines: bodyText.split('\n').filter(Boolean).slice(0, 12),
        recentPostSummaries,
      };
    }, { gid: groupId });
    console.log(JSON.stringify({ step: 'snapshot', ...snapshot }, null, 2));
  } finally {
    await browser.close().catch(() => {});
    console.log(JSON.stringify({ step: 'closing_profile' }));
    await ixPost('profile-close', { profile_id: profileId }, 15000).catch(e => console.log(JSON.stringify({ step: 'close_warn', error: e.message })));
  }
})().catch(e => { console.error(JSON.stringify({ step: 'error', message: e.message, stack: e.stack })); process.exit(1); });
