// Mobile FB (m.facebook.com) comment submission. Used as a hybrid in
// fb-post-test-capture-url.js to save the ~35-40s desktop permalink page
// load. Mobile permalink loads in ~3-8s. Pin still uses desktop (mobile FB
// dropped the pin UI in 2024+).
//
// Defensive selector strategy: try multiple aria-label / role variants since
// the user-facing mobile DOM still gets reshuffled by Meta. Each step is
// allowed to gracefully fail and return {verified:false}, letting the caller
// fall back to the proven desktop path.

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function jitter(min, max) { return Math.floor(min + Math.random() * (max - min + 1)); }
async function humanPause(min = 1000, max = 2500) { await sleep(jitter(min, max)); }

function toMobileUrl(url) {
  return String(url || '')
    .replace(/^https?:\/\/(?:www\.|web\.)?facebook\.com/i, 'https://m.facebook.com')
    .replace(/^https?:\/\/mbasic\.facebook\.com/i, 'https://m.facebook.com');
}

function toDesktopUrl(url) {
  return String(url || '')
    .replace(/^https?:\/\/(?:m\.|mbasic\.|web\.)?facebook\.com/i, 'https://www.facebook.com');
}

function facebookGroupPostParts(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''), 'https://www.facebook.com/');
    const match = url.pathname.match(/\/groups\/([0-9]+)\/(?:permalink|posts)\/([0-9]+)/i);
    return match ? { groupId: match[1], postId: match[2] } : null;
  } catch (_) {
    return null;
  }
}

async function dismissMobileInterstitials(page) {
  // m.facebook.com aggressively shows "Continue in app", cookie banners,
  // and login nags. Dismiss everything we can find.
  await page.keyboard.press('Escape').catch(() => {});
  const patterns = [
    /not now|maybe later|continue on mobile site|continue in browser|skip|close|dismiss|accept all|essential only|allow essential only/i,
  ];
  await page.evaluate((labelPatterns) => {
    const regexes = labelPatterns.map((s) => new RegExp(s.slice(1, -2), 'i'));
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const buttons = [...document.querySelectorAll('button, [role="button"], a[role="link"], a')].filter(visible);
    for (const btn of buttons) {
      const label = (btn.getAttribute('aria-label') || btn.innerText || btn.textContent || '').replace(/\s+/g, ' ').trim();
      if (regexes.some((re) => re.test(label))) {
        try { btn.click(); } catch (_) {}
      }
    }
  }, patterns.map(String)).catch(() => {});
}

async function findMarkerArticleOnMobile(page, marker) {
  return await page.evaluate((m) => {
    if (!m) return null;
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    // Try various mobile FB article containers.
    const selectors = [
      'article[data-ft]',
      'article',
      '[role="article"]',
      '[data-pagelet]',
      '[data-sigil*="story"]',
      '[id^="story_"]',
    ];
    for (const sel of selectors) {
      const nodes = [...document.querySelectorAll(sel)].filter(visible);
      for (const n of nodes) {
        const text = (n.innerText || n.textContent || '').replace(/\s+/g, ' ');
        if (text.includes(m)) {
          return { selector: sel, textLen: text.length, hasCommentTextbox: Boolean(n.querySelector('textarea, [contenteditable="true"], [role="textbox"]')) };
        }
      }
    }
    return null;
  }, marker).catch(() => null);
}

async function findMobileCommentTextbox(page) {
  // Try in order: legacy mbasic textarea, modern m.facebook.com contenteditable
  const candidates = [
    page.locator('textarea[name="comment_text"]').first(),
    page.locator('textarea[name*="comment"]').first(),
    page.locator('[contenteditable="true"][aria-label*="omment" i]').first(),
    page.locator('[role="textbox"][aria-label*="omment" i]').first(),
    page.locator('[contenteditable="true"][data-sigil*="comment" i]').first(),
    page.getByRole('textbox', { name: /write a comment|reply|comment/i }).first(),
    page.locator('form[action*="comment"] textarea').first(),
    page.locator('textarea').first(),
  ];
  for (const c of candidates) {
    try {
      if (await c.count() === 0) continue;
      if (!(await c.isVisible({ timeout: 800 }).catch(() => false))) continue;
      return c;
    } catch (_) {}
  }
  return null;
}

async function findMobileCommentSubmit(page) {
  // Mobile submit can be a form button, an aria-labelled icon, or Enter.
  const candidates = [
    page.locator('form[action*="comment"] button[type="submit"]').first(),
    page.locator('button[type="submit"][name="post"]').first(),
    page.locator('[aria-label="Post"]').first(),
    page.locator('[aria-label="Send"]').first(),
    page.locator('[aria-label*="Send comment" i]').first(),
    page.getByRole('button', { name: /^post$|^send$|reply/i }).first(),
  ];
  for (const c of candidates) {
    try {
      if (await c.count() === 0) continue;
      if (!(await c.isVisible({ timeout: 800 }).catch(() => false))) continue;
      return c;
    } catch (_) {}
  }
  return null;
}

async function submitCommentOnMobilePermalink(page, marker, commentText, mobilePostUrl) {
  const result = {
    clicked: false,
    typed: false,
    submitted: false,
    verified: false,
    blocked: false,
    blockReason: '',
    restrictionText: '',
    mobileRedirectedToDesktop: false,
    currentUrl: '',
    pageTitle: '',
  };
  try {
    await page.goto(mobilePostUrl, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
    await humanPause(1000, 1800);
    const afterNavUrl = page.url();
    result.currentUrl = afterNavUrl;
    result.pageTitle = await page.title().catch(() => '');
    if (!/^https?:\/\/m\.facebook\.com/i.test(afterNavUrl)) {
      result.mobileRedirectedToDesktop = true;
      result.blocked = true;
      result.blockReason = 'mobile_redirected_to_desktop';
      result.restrictionText = `m.facebook.com redirected to ${afterNavUrl}`;
      return result;
    }
    await dismissMobileInterstitials(page);
    await humanPause(800, 1500);
    const article = await findMarkerArticleOnMobile(page, marker);
    if (!article) {
      result.blocked = true;
      result.blockReason = 'marker_article_not_found_on_mobile';
      return result;
    }
    const textbox = await findMobileCommentTextbox(page);
    if (!textbox) {
      result.blocked = true;
      result.blockReason = 'mobile_comment_textbox_not_found';
      return result;
    }
    await textbox.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    await textbox.click({ timeout: 3000 }).catch(() => {});
    result.clicked = true;
    await humanPause(1000, 1800);
    // Type the comment text via insertText (works for both textarea + contenteditable)
    await page.keyboard.insertText(commentText).catch(async () => {
      // Fallback: fill or type
      try { await textbox.fill(commentText, { timeout: 3000 }); } catch (_) {
        await textbox.type(commentText, { delay: 30, timeout: 5000 }).catch(() => {});
      }
    });
    result.typed = true;
    await humanPause(1000, 2000);
    // Try Enter first (works on m.facebook.com React version)
    await page.keyboard.press('Enter').catch(() => {});
    await humanPause(1500, 2500);
    let visible = await verifyMobileCommentVisible(page, commentText);
    if (!visible) {
      // Maybe Enter inserted newline; try submit button.
      const submit = await findMobileCommentSubmit(page);
      if (submit) {
        await submit.click({ timeout: 3000 }).catch(() => {});
        await humanPause(1500, 2500);
        visible = await verifyMobileCommentVisible(page, commentText);
      }
    }
    if (!visible) {
      // Last resort: Ctrl+Enter
      await page.keyboard.press('Control+Enter').catch(() => {});
      await humanPause(1500, 2500);
      visible = await verifyMobileCommentVisible(page, commentText);
    }
    result.submitted = visible;
    result.verified = visible;
    if (!visible) {
      result.blocked = true;
      result.blockReason = 'mobile_comment_not_visible_after_submit';
    }
    return result;
  } catch (err) {
    result.blocked = true;
    result.blockReason = 'mobile_comment_exception';
    result.restrictionText = String(err?.message || err).slice(0, 600);
    return result;
  }
}

async function verifyMobileCommentVisible(page, commentText) {
  const needles = String(commentText || '').match(/https?:\/\/[^\s]+/g) || [String(commentText || '').slice(0, 30)];
  return await page.evaluate((ns) => {
    const text = (document.body?.innerText || '').replace(/\s+/g, ' ');
    return ns.some((n) => n && text.includes(n));
  }, needles).catch(() => false);
}

module.exports = { submitCommentOnMobilePermalink, toMobileUrl, toDesktopUrl, facebookGroupPostParts };
