const { chromium } = require('playwright-core');
const fs = require('fs');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function jitter(min, max) { return Math.floor(min + Math.random() * (max - min + 1)); }
async function humanPause(min=500, max=1600) {
  // Cap ALL humanPauses to 1-3s range: anti-bot-friendly without wasting
  // wall-clock. Per-call args still allowed but clamped here so any call site
  // (81 of them) cannot stall longer than 3s.
  const HARD_MIN = 1000;
  const HARD_MAX = 3000;
  const clampedMin = Math.max(HARD_MIN, Math.min(HARD_MAX, min));
  const clampedMax = Math.max(clampedMin, Math.min(HARD_MAX, max));
  await sleep(jitter(clampedMin, clampedMax));
}
function clampInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function normalizeTextLoose(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function markerTextMatches(haystack, marker) {
  const rawHaystack = String(haystack || '');
  const rawMarker = String(marker || '');
  if (!rawMarker) return false;
  if (rawHaystack.includes(rawMarker)) return true;
  const cleanMarker = normalizeTextLoose(rawMarker);
  if (cleanMarker.length < 10) return false;
  const cleanHaystack = normalizeTextLoose(rawHaystack);
  if (cleanHaystack.includes(cleanMarker)) return true;
  const zdf = (rawMarker.match(/\bZDF-[A-Z0-9]{6,16}\b/i) || [])[0];
  return Boolean(zdf && new RegExp(`\\b${zdf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(rawHaystack));
}

async function ixPost(path, body, timeoutMs = 70000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch('http://127.0.0.1:53200/api/v2/' + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`ixbrowser_${path}_timeout_after_${Math.round(timeoutMs / 1000)}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error(text.slice(0, 1000)); }
  if (!res.ok) throw new Error(`IXBrowser ${path} HTTP ${res.status}: ${text.slice(0, 600)}`);
  const code = Number(parsed?.error?.code || 0);
  if (parsed?.error && code !== 0) {
    throw new Error(`IXBrowser ${path} error ${code}: ${parsed.error.message || 'unknown error'}`);
  }
  return parsed;
}

async function clickFirst(page, candidates, opts = {}) {
  for (const c of candidates) {
    try {
      const loc = typeof c === 'string' ? page.locator(c) : c;
      const count = await loc.count().catch(() => 0);
      if (!count) continue;
      for (let i = 0; i < Math.min(count, 5); i++) {
        const el = loc.nth(i);
        if (!(await el.isVisible({ timeout: 800 }).catch(() => false))) continue;
        await el.hover({ timeout: 2000 }).catch(() => {});
        await humanPause(180, 500);
        await el.click({ timeout: opts.timeout || 5000 });
        return el;
      }
    } catch (_) {}
  }
  return null;
}

async function facebookUiSnapshot(page) {
  return await page.evaluate(() => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const textOf = (el) => (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.textContent || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);
    const dialogs = [...document.querySelectorAll('div[role="dialog"]')].filter(visible);
    const root = dialogs[dialogs.length - 1] || document.body;
    const buttons = [...document.querySelectorAll('button, [role="button"], a[role="link"], [aria-label]')]
      .filter(visible)
      .map((el) => ({
        label: textOf(el),
        role: el.getAttribute('role') || el.tagName.toLowerCase(),
        disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
        inDialog: root !== document.body && root.contains(el),
      }))
      .filter((item) => item.label)
      .slice(0, 40);
    const boxes = [...document.querySelectorAll('textarea, input, [contenteditable="true"], [role="textbox"]')]
      .filter(visible)
      .map((el) => ({
        label: textOf(el),
        role: el.getAttribute('role') || el.tagName.toLowerCase(),
        inDialog: root !== document.body && root.contains(el),
      }))
      .slice(0, 20);
    return {
      url: location.href,
      title: document.title,
      dialogCount: dialogs.length,
      dialogText: (root.innerText || '').replace(/\s+/g, ' ').slice(0, 500),
      buttons,
      boxes,
    };
  }).catch((err) => ({ error: err.message || String(err) }));
}

// True when the visible page is a GENUINE membership wall (group is private /
// the profile is not a member / a join request is pending). These must NEVER be
// retried with a reload — reloading a wall just re-renders the wall.
async function groupHasMembershipWall(page) {
  const snap = await facebookUiSnapshot(page);
  if (snap.error) return false;
  const text = `${snap.title || ''} ${snap.dialogText || ''}`.toLowerCase();
  const membershipText = /join group|request to join|pending approval|cancel request|must be a member|you are not a member|join this group|only members can|members of this group|private group|visible to members|invitation only|invited to join/.test(text);
  const labels = (Array.isArray(snap.buttons) ? snap.buttons : [])
    .map((b) => String(b?.label || '').trim().toLowerCase())
    .filter(Boolean);
  const membershipButton = labels.some((label) => /^(join group|join this group|join|request to join|cancel request)$/.test(label) || /join group|request to join|cancel request/.test(label));
  return Boolean(membershipText || membershipButton);
}

// True when the page is a TRANSIENT "content isn't available" / error interstitial
// that FB sometimes serves right after a profile-open navigation, with NO real
// group content (no composer, no group header) and NO membership wall. This is
// recoverable with a reload / re-goto.
async function isGroupContentUnavailable(page) {
  if (await groupHasMembershipWall(page)) return false;
  const snap = await facebookUiSnapshot(page);
  if (snap.error) return false;
  const text = `${snap.title || ''} ${snap.dialogText || ''}`.toLowerCase();
  const unavailableText = /content isn't available|content isnt available|this content isn't available|isn't available right now|isnt available right now|not available right now|page (?:isn't|isnt|not) available|page not found|something went wrong|sorry, (?:this|that) (?:page|content)/.test(text);
  const labels = (Array.isArray(snap.buttons) ? snap.buttons : [])
    .map((b) => String(b?.label || '').trim().toLowerCase())
    .filter(Boolean);
  const errorButtons = labels.some((label) => /^(go to (?:feed|news ?feed)|go back|reload page|visit help center)$/.test(label));
  const hasComposer = await composerIsOpen(page).catch(() => false);
  // Only treat as "unavailable" when there is no live composer to post into.
  return Boolean(!hasComposer && (unavailableText || errorButtons));
}

// Bounded recovery: when the browser lands on a transient unavailable/error
// interstitial (commonly after ix profile-open skips our own navigation), force
// the group to actually render via reload + fresh goto. Terminates after a fixed
// number of attempts and applies whether or not navigation was skipped. Returns
// true once the page no longer looks unavailable, false if it remains so.
async function ensureGroupRendered(page, groupUrl) {
  const MAX_ATTEMPTS = 3;
  if (await groupHasMembershipWall(page)) {
    // Real access wall — reloading is pointless and out of scope here. Let the
    // downstream composer flow surface the membership error instead.
    console.log(JSON.stringify({ step: 'ensure_group_rendered_skip', reason: 'membership_wall_detected' }));
    return false;
  }
  if (!(await isGroupContentUnavailable(page))) return true;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(JSON.stringify({ step: 'group_unavailable_interstitial', attempt, maxAttempts: MAX_ATTEMPTS, url: page.url() }));
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => console.log(JSON.stringify({ step: 'ensure_group_rendered_reload_warn', attempt, message: e.message })));
    await humanPause(6000, 9000);
    if (!(await isGroupContentUnavailable(page))) {
      console.log(JSON.stringify({ step: 'group_rendered_after_recovery', attempt, via: 'reload', url: page.url() }));
      return true;
    }
    if (groupUrl) {
      await page.goto(groupUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => console.log(JSON.stringify({ step: 'ensure_group_rendered_goto_warn', attempt, message: e.message })));
      await humanPause(6000, 9000);
    }
    if (await groupHasMembershipWall(page)) {
      console.log(JSON.stringify({ step: 'ensure_group_rendered_stop', reason: 'membership_wall_after_reload', attempt }));
      return false;
    }
    if (!(await isGroupContentUnavailable(page))) {
      console.log(JSON.stringify({ step: 'group_rendered_after_recovery', attempt, via: 'goto', url: page.url() }));
      return true;
    }
  }
  console.log(JSON.stringify({ step: 'group_still_unavailable_after_recovery', maxAttempts: MAX_ATTEMPTS, url: page.url() }));
  return false;
}

// Resolve the NUMERIC facebook group id from a loaded group page. Vanity group URLs
// (e.g. /groups/o1498765421290862) navigate fine but carry no numeric id in the URL;
// the numeric id is needed for permalink / group-user URL matching during post
// verification. Best-effort: returns '' if it cannot be derived (callers tolerate
// an empty gid via their `!gid` fallbacks).
async function resolveNumericGroupIdFromPage(page) {
  // 1) FB frequently canonicalizes the address bar to the numeric id after load.
  const fromUrl = (String(page.url() || '').match(/\/groups\/(\d{6,})/) || [])[1];
  if (fromUrl) return fromUrl;
  // 2) Scan the page's own meta / links / inline scripts for the numeric group id.
  const fromDom = await page.evaluate(() => {
    for (const sel of ['link[rel="canonical"]', 'meta[property="og:url"]']) {
      const el = document.querySelector(sel);
      const v = el && (el.getAttribute('href') || el.getAttribute('content'));
      const m = String(v || '').match(/\/groups\/(\d{6,})/);
      if (m) return m[1];
    }
    for (const a of document.querySelectorAll('a[href*="/groups/"]')) {
      const m = (a.getAttribute('href') || '').match(/\/groups\/(\d{6,})(?:\/|\b)/);
      if (m) return m[1];
    }
    const scripts = [...document.querySelectorAll('script')].map((s) => s.textContent || '').join('\n').slice(0, 3000000);
    let m = scripts.match(/"group(?:ID|Id|_id)"\s*:\s*"?(\d{6,})"?/);
    if (m) return m[1];
    m = scripts.match(/\/groups\/(\d{6,})\/(?:permalink|posts|user|about|members|media)/);
    if (m) return m[1];
    return '';
  }).catch(() => '');
  return fromDom || '';
}

async function facebookLoginSnapshot(page) {
  return await page.evaluate(() => {
    const text = (document.body?.innerText || document.body?.textContent || '').replace(/\s+/g, ' ').slice(0, 1200);
    const lower = text.toLowerCase();
    const href = location.href;
    const loginFields = document.querySelectorAll('input[type="password"], input[name="email"], input[name="pass"]').length;
    const loginText = /log in|login|sign in|email or phone|password|forgot password|checkpoint|two-factor|two factor|enter code/.test(lower);
    const loginUrl = /facebook\.com\/(?:login|checkpoint|recover|two_factor|confirmemail)/i.test(href);
    const accountChecks = [
      ['account_suspended', /\b(we suspended your account|your account (?:has been )?suspended|account suspended|suspended your facebook account)\b/],
      ['account_disabled', /\b(your account (?:has been )?disabled|account (?:has been )?disabled|we disabled your account|facebook account (?:has been )?disabled)\b/],
      ['account_deactivated', /\b(your account (?:has been )?deactivated|account deactivated)\b/],
      ['account_locked', /\b(your account (?:has been )?locked|account locked|temporarily locked)\b/],
      ['identity_review_required', /\b(confirm your identity|identity confirmation required|request a review|disagree with decision|we need to review your account)\b/],
      ['publish_identity_required', /confirm your identity before you can publish/],
      ['account_restricted', /\b(you can't use facebook right now|you cannot use facebook right now|your account is restricted|restricted from using facebook)\b/],
    ];
    const accountMatch = accountChecks.find(([, pattern]) => pattern.test(lower));
    const accountBlocked = Boolean(accountMatch || /facebook\.com\/checkpoint\/(?:disabled|appeal|blocked|1501092823525282)/i.test(href));
    return {
      loginRequired: Boolean(loginFields || loginText || loginUrl),
      accountBlocked,
      accountBlockReason: accountMatch?.[0] || (accountBlocked ? 'checkpoint_account_blocked' : ''),
      url: href,
      title: document.title || '',
      loginFields,
      snippet: text.slice(0, 500),
    };
  }).catch((err) => ({ loginRequired: false, error: err.message || String(err) }));
}

// Detects a PAGE-PUBLISH block dialog that FB raises right after clicking Post, e.g.
// "Confirm your identity before you can publish as this Page. Open the Facebook app on your
// phone and follow the instructions." This is a page/account-level restriction — the post does
// NOT go live. It appears at post-SUBMIT time (often as a modal), so the login/nav account-block
// check never sees it (a reload dismisses it first). Scans the FULL page + any dialog text (not
// the 1200-char login snippet) so it is caught regardless of page length.
async function detectPublishBlockDialog(page) {
  return await page.evaluate(() => {
    const collect = (root) => (root && (root.innerText || root.textContent) || '').replace(/\s+/g, ' ');
    let text = collect(document.body);
    for (const d of document.querySelectorAll('[role="dialog"], [role="alertdialog"]')) text += ' ' + collect(d);
    const lower = text.toLowerCase();
    const patterns = [
      // Require the CONTIGUOUS dialog phrase (not the bare "before you can publish as this page",
      // which appears in benign help/setup chrome) so a healthy profile is never blacklisted by
      // passive text. These are active block messages only.
      ['publish_identity_confirmation', /confirm your identity before you can publish|confirm your identity.{0,40}publish as this page/],
      ['page_publish_blocked', /you can't publish as this page|you cannot publish as this page|this page can't post|page is restricted from posting|can't post as this page/],
    ];
    const hit = patterns.find(([, re]) => re.test(lower));
    return hit ? { blocked: true, reason: hit[0], snippet: text.slice(0, 400) } : { blocked: false };
  }).catch(() => ({ blocked: false }));
}

async function assertFacebookLoggedIn(page, stage = 'facebook') {
  const snapshot = await facebookLoginSnapshot(page);
  if (snapshot.accountBlocked) {
    console.log(JSON.stringify({ step: 'facebook_account_status_blocked', stage, ...snapshot }));
    throw new Error(`facebook_account_suspended_or_disabled at ${stage}: ${snapshot.accountBlockReason || 'account_blocked'}`);
  }
  if (!snapshot.loginRequired) return snapshot;
  console.log(JSON.stringify({ step: 'facebook_login_required', stage, ...snapshot }));
  throw new Error(`facebook_login_required_for_profile at ${stage}`);
}

async function waitForManualFacebookLogin(page, stage = 'facebook', options = {}) {
  const timeoutMs = clampInt(options.timeoutMs || 300000, 15000, 900000);
  const pollMs = clampInt(options.pollMs || 5000, 1000, 30000);
  const first = await facebookLoginSnapshot(page);
  if (first.accountBlocked) {
    console.log(JSON.stringify({ step: 'facebook_account_status_blocked', stage, ...first }));
    throw new Error(`facebook_account_suspended_or_disabled at ${stage}: ${first.accountBlockReason || 'account_blocked'}`);
  }
  if (!first.loginRequired) return first;
  console.log(JSON.stringify({
    step: 'facebook_login_required_waiting',
    stage,
    timeoutMs,
    url: first.url,
    title: first.title,
    loginFields: first.loginFields,
    snippet: first.snippet,
  }));
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await humanPause(Math.max(800, pollMs - 600), pollMs + 600);
    const snapshot = await facebookLoginSnapshot(page);
    if (snapshot.accountBlocked) {
      console.log(JSON.stringify({ step: 'facebook_account_status_blocked', stage, waitedMs: Date.now() - started, ...snapshot }));
      throw new Error(`facebook_account_suspended_or_disabled at ${stage}: ${snapshot.accountBlockReason || 'account_blocked'}`);
    }
    if (!snapshot.loginRequired) {
      console.log(JSON.stringify({
        step: 'facebook_login_restored',
        stage,
        waitedMs: Date.now() - started,
        url: snapshot.url,
        title: snapshot.title,
      }));
      return snapshot;
    }
  }
  const latest = await facebookLoginSnapshot(page);
  if (latest.accountBlocked) {
    console.log(JSON.stringify({ step: 'facebook_account_status_blocked', stage, waitedMs: Date.now() - started, ...latest }));
    throw new Error(`facebook_account_suspended_or_disabled at ${stage}: ${latest.accountBlockReason || 'account_blocked'}`);
  }
  console.log(JSON.stringify({
    step: 'facebook_login_wait_timeout',
    stage,
    timeoutMs,
    url: latest.url,
    title: latest.title,
    snippet: latest.snippet,
  }));
  throw new Error(`facebook_login_required_for_profile at ${stage}`);
}

async function ensureFacebookLoggedIn(page, payload, stage = 'facebook') {
  if (payload.waitForManualLogin === false) return await assertFacebookLoggedIn(page, stage);
  return await waitForManualFacebookLogin(page, stage, {
    timeoutMs: payload.manualLoginTimeoutMs || payload.manual_login_timeout_ms || 300000,
  });
}

async function composerIsOpen(page) {
  return await page.evaluate(() => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const dialogs = [...document.querySelectorAll('div[role="dialog"]')].filter(visible);
    if (dialogs.some((dialog) => [...dialog.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')].some(visible))) {
      return true;
    }
    // Q&A group composer flavor: FB renders an "Answer as <Page>" textbox
    // OUTSIDE the role=dialog wrapper. Accept any visible page-level
    // composer textbox whose aria-label/placeholder matches a composer prompt.
    const composerLabelRegex = /(answer as|what's on your mind|write something|create a public post|start a post|post anonymously|exprimez|cr[eé]er une publication|cr[eé]ez une publication|[eé]crire quelque chose)/i;
    const composerBoxes = [...document.querySelectorAll('[role="textbox"], [contenteditable="true"], textarea')].filter(visible);
    return composerBoxes.some((el) => {
      const label = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (composerLabelRegex.test(label)) return true;
      const rect = el.getBoundingClientRect();
      // Large editable area on the page after a click is a composer too.
      return el.getAttribute('contenteditable') === 'true' && rect.width >= 240 && rect.height >= 32;
    });
  }).catch(() => false);
}

async function openComposer(page) {
  const openPostRegex = /write something|what's on your mind|create a public post|create post|start a post|post anonymously|exprimez-vous|exprimez vous|créer une publication|creer une publication|créez une publication|creez une publication|écrire quelque chose|ecrire quelque chose/i;
  const locatorOpen = await clickFirst(page, [
    page.getByText(openPostRegex),
    page.getByRole('button', { name: openPostRegex }),
    page.locator('div[role="button"]').filter({ hasText: openPostRegex }),
    page.locator('div, span').filter({ hasText: openPostRegex }),
    page.locator('[aria-label*="Create a public post" i]'),
    page.locator('[aria-label*="Create post" i]'),
    page.locator('[aria-label*="Exprimez" i]'),
  ], { timeout: 9000 });
  if (locatorOpen) {
    await humanPause(1200, 2400);
    if (await composerIsOpen(page)) return { opened: true, method: 'known_locator' };
  }

  const adaptive = await page.evaluate(() => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const labelOf = (el) => (el.getAttribute('aria-label') || el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    const clickable = [...document.querySelectorAll('button, [role="button"], a, div[aria-label], span[aria-label], div, span')].filter(visible);
    const scored = clickable.map((el) => {
      const label = labelOf(el);
      const lower = label.toLowerCase();
      let score = 0;
      if (/write something|what's on your mind|create a public post|create post|start a post|post anonymously|exprimez-vous|exprimez vous|cr[eé]er une publication|cr[eé]ez une publication|[eé]crire quelque chose/.test(lower)) score += 130;
      if (/\bpost\b|\bpublication\b/.test(lower)) score += 20;
      if (/photo|vid[ée]o|comment|commentaire|like|j'aime|share|partager|join|rejoindre|invite|inviter|search|rechercher|notification|messenger|menu/.test(lower)) score -= 60;
      if (el.getAttribute('aria-disabled') === 'true' || el.disabled) score -= 100;
      const rect = el.getBoundingClientRect();
      if (rect.width > 180 && rect.height > 24) score += 10;
      return { el, label, score };
    }).filter((item) => item.score > 40).sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best) return { clicked: false, candidates: scored.slice(0, 5).map(({ label, score }) => ({ label, score })) };
    best.el.scrollIntoView({ block: 'center', inline: 'center' });
    best.el.click();
    return { clicked: true, label: best.label.slice(0, 160), score: best.score };
  }).catch((err) => ({ clicked: false, error: err.message || String(err) }));
  if (adaptive.clicked) {
    await humanPause(1400, 2800);
    if (await composerIsOpen(page)) return { opened: true, method: 'adaptive_score', ...adaptive };
  }
  return { opened: false, method: 'failed', adaptive, diagnostic: await facebookUiSnapshot(page) };
}

function shouldRetryComposerOpen(result) {
  if (result?.opened) return false;
  const diagnostic = result?.diagnostic || {};
  const buttons = Array.isArray(diagnostic.buttons) ? diagnostic.buttons : [];
  const boxes = Array.isArray(diagnostic.boxes) ? diagnostic.boxes : [];
  const text = `${diagnostic.title || ''} ${diagnostic.dialogText || ''}`.toLowerCase();
  const buttonText = buttons.map((button) => String(button?.label || '').trim().toLowerCase()).filter(Boolean).join(' | ');
  // (B) Split the old combined regex. A TRUE membership wall / account-level
  // block is permanent — never retry. A bare transient "content isn't available"
  // interstitial WITHOUT any membership signal is recoverable — allow the
  // recovery ladder (Home/scroll/reload/goto) to run.
  const membershipWall = /join group|request to join|pending approval|cancel request|must be a member|temporarily blocked|not allowed|private group|only members can|members of this group|invitation only/.test(`${text} ${buttonText}`);
  if (membershipWall) return false;
  const transientUnavailable = /not available|content isn't available|content isnt available|isn't available right now|isnt available right now|page not found|something went wrong/.test(text);
  if (transientUnavailable) return true;
  const labels = buttons.map((button) => String(button?.label || '').trim()).filter(Boolean);
  const loadingButtons = labels.filter((label) => /^loading(?:\.\.\.)?$/i.test(label) || /\bloading\b/i.test(label)).length;
  const usefulControls = labels.filter((label) => /write something|what's on your mind|create a public post|create post|start a post|post anonymously|exprimez-vous|exprimez vous|cr[eé]er une publication|cr[eé]ez une publication|[eé]crire quelque chose|\bpost\b|\bpublication\b/i.test(label) && !/\bloading\b/i.test(label)).length;
  if (buttons.length === 0 && boxes.length === 0) return true;
  if (boxes.length === 0 && loadingButtons >= 3 && usefulControls === 0) return true;
  if (boxes.length === 0 && labels.length > 0 && loadingButtons >= Math.ceil(labels.length * 0.6)) return true;
  // The "Create post" dialog opened but its editor textbox hasn't rendered
  // yet (FB lazy-loads the inner React tree). Retry after waiting longer so
  // the editor has time to mount instead of failing outright.
  const dialogOpened = (Number(diagnostic.dialogCount) || 0) > 0;
  const dialogPromptsCreate = /create\s*post|cr[eé]er.*publication|cr[eé]ez.*publication/i.test(diagnostic.dialogText || '');
  const composerLabelRegex = /(answer as|what's on your mind|write something|create a public post|start a post|post anonymously|exprimez|cr[eé]er une publication|cr[eé]ez une publication|[eé]crire quelque chose)/i;
  const hasComposerBox = boxes.some((b) => composerLabelRegex.test(String(b?.label || '')));
  if (dialogOpened && dialogPromptsCreate && !hasComposerBox) return true;
  return false;
}

async function openComposerWithRecovery(page, groupUrl) {
  let result = await openComposer(page);
  if (result.opened || !shouldRetryComposerOpen(result)) return result;
  console.log(JSON.stringify({
    step: 'composer_open_retry_wait',
    reason: 'facebook_group_loaded_without_visible_controls',
    diagnostic: result.diagnostic,
  }));
  await page.keyboard.press('Home').catch(() => {});
  await page.mouse.wheel(0, -1800).catch(() => {});
  await humanPause(6500, 9500);
  result = await openComposer(page);
  if (result.opened || !shouldRetryComposerOpen(result)) return { ...result, retry: 'home_wait' };
  await page.mouse.wheel(0, 1200).catch(() => {});
  await humanPause(5500, 8500);
  result = await openComposer(page);
  if (result.opened || !shouldRetryComposerOpen(result)) return { ...result, retry: 'scroll_wait' };
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await humanPause(9000, 13000);
  result = await openComposer(page);
  if (result.opened || !shouldRetryComposerOpen(result) || !groupUrl) return { ...result, retry: 'reload_wait' };
  await page.goto(groupUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await humanPause(9000, 13000);
  result = await openComposer(page);
  return { ...result, retry: 'group_reload_wait' };
}

async function waitForComposerText(page, text, timeoutMs = 6000) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  const marker = raw.split(/\r?\n/)[0].trim().slice(0, 80);
  const words = raw.split(/\s+/).filter((word) => word.length >= 4);
  const needles = [...new Set([
    marker,
    raw.slice(0, 40),
    words.slice(0, 3).join(' '),
    words[0] || '',
  ].map((item) => item.trim()).filter((item) => item.length >= 4))];
  if (!needles.length) return true;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = await page.evaluate((needles) => {
      const dialogs = [...document.querySelectorAll('div[role="dialog"]')];
      const root = dialogs[dialogs.length - 1] || document.body;
      const active = document.activeElement;
      const text = [
        root.innerText || '',
        root.textContent || '',
        active?.value || '',
        active?.innerText || '',
        active?.textContent || '',
      ].join('\n').replace(/\s+/g, ' ');
      return needles.some((needle) => text.includes(needle));
    }, needles).catch(() => false);
    if (found) return true;
    await sleep(400);
  }
  return false;
}

function shouldAvoidKeyboardType(text) {
  return /[^\u0009\u000a\u000d\u0020-\u007e]/u.test(String(text || ''));
}

async function editorSnapshot(page) {
  return await page.evaluate(() => {
    const active = document.activeElement;
    const dialogs = [...document.querySelectorAll('div[role="dialog"]')];
    const root = dialogs[dialogs.length - 1] || document.body;
    return {
      activeTag: active?.tagName || '',
      activeRole: active?.getAttribute?.('role') || '',
      activeEditable: active?.getAttribute?.('contenteditable') || '',
      activeText: (active?.innerText || active?.textContent || active?.value || '').replace(/\s+/g, ' ').slice(0, 220),
      dialogText: (root.innerText || root.textContent || '').replace(/\s+/g, ' ').slice(0, 500),
    };
  }).catch((err) => ({ error: err.message || String(err) }));
}

async function adaptiveComposerEditor(page) {
  return await page.evaluate(() => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const labelOf = (el) => (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();
    const dialogs = [...document.querySelectorAll('div[role="dialog"]')].filter(visible);
    const dialog = dialogs[dialogs.length - 1] || null;
    const candidates = [...document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"], [role="textbox"]')]
      .filter(visible)
      .map((el) => {
        const label = labelOf(el);
        const lower = label.toLowerCase();
        const rect = el.getBoundingClientRect();
        let score = 0;
        if (dialog && dialog.contains(el)) score += 80;
        if (el.getAttribute('contenteditable') === 'true') score += 35;
        if (el.getAttribute('role') === 'textbox') score += 25;
        if (/what.*mind|write.*something|create.*post|public post|post|exprimez-vous|exprimez vous|cr[eé]er.*publication|[eé]crire quelque chose/.test(lower)) score += 45;
        if (/search|rechercher|comment|commentaire|reply|r[ée]pondre|message|messenger|email|password|mot de passe/.test(lower)) score -= 100;
        if (rect.width >= 180 && rect.height >= 20) score += 12;
        if (rect.height >= 48) score += 8;
        return { el, label, score, width: Math.round(rect.width), height: Math.round(rect.height) };
      })
      .filter((item) => item.score > 20)
      .sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (!best) return { focused: false, candidates: candidates.slice(0, 8).map(({ label, score, width, height }) => ({ label, score, width, height })) };
    best.el.scrollIntoView({ block: 'center', inline: 'center' });
    best.el.focus();
    best.el.click();
    return {
      focused: true,
      label: best.label.slice(0, 160),
      score: best.score,
      width: best.width,
      height: best.height,
      tag: best.el.tagName,
      role: best.el.getAttribute('role') || '',
      editable: best.el.getAttribute('contenteditable') || '',
    };
  }).catch((err) => ({ focused: false, error: err.message || String(err) }));
}

async function forceInsertComposerText(page, text) {
  return await page.evaluate((text) => {
    const active = document.activeElement;
    if (!active) return { inserted: false, reason: 'no active element' };
    const fire = (el, type, inputType = 'insertText') => {
      try {
        el.dispatchEvent(new InputEvent(type, { bubbles: true, cancelable: true, inputType, data: text }));
      } catch {
        el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
      }
    };
    if (active.isContentEditable || active.getAttribute('contenteditable') === 'true' || active.getAttribute('role') === 'textbox') {
      active.focus();
      const ok = document.execCommand && document.execCommand('insertText', false, text);
      if (!ok && !(active.innerText || active.textContent || '').includes(text.slice(0, 8))) {
        active.textContent = text;
      }
      fire(active, 'beforeinput');
      fire(active, 'input');
      fire(active, 'change');
      return { inserted: true, method: ok ? 'execCommand_insertText' : 'contenteditable_textContent' };
    }
    if ('value' in active) {
      active.focus();
      active.value = text;
      fire(active, 'beforeinput');
      fire(active, 'input');
      fire(active, 'change');
      return { inserted: true, method: 'value_input' };
    }
    return { inserted: false, reason: 'active element is not editable', tag: active.tagName, role: active.getAttribute('role') || '' };
  }, text).catch((err) => ({ inserted: false, reason: err.message || String(err) }));
}

async function typeIntoComposer(page, text) {
  const candidates = [
    page.getByRole('textbox', { name: /what.*mind|write.*something|create.*public.*post|answer as|exprimez-vous|exprimez vous|cr[eé]er.*publication|[eé]crire quelque chose/i }),
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
        await page.keyboard.insertText(text).catch(() => {});
        if (!(await waitForComposerText(page, text))) {
          await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
          await page.keyboard.press('Backspace').catch(() => {});
          await humanPause(200, 500);
          const forced = await forceInsertComposerText(page, text);
          if (forced.inserted && await waitForComposerText(page, text, 8000)) return true;
          if (shouldAvoidKeyboardType(text)) continue;
          await page.keyboard.type(text, { delay: jitter(35, 80) }).catch(() => {});
          if (!(await waitForComposerText(page, text))) continue;
        }
        return true;
      } catch (_) {}
    }
  }
  const adaptive = await adaptiveComposerEditor(page);
  if (adaptive.focused) {
    console.log(JSON.stringify({ step: 'composer_editor_selected', ...adaptive }));
    await humanPause(300, 700);
    await page.keyboard.insertText(text).catch(() => {});
    if (await waitForComposerText(page, text)) return true;
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    await humanPause(200, 500);
    const forced = await forceInsertComposerText(page, text);
    console.log(JSON.stringify({ step: 'composer_force_insert_attempted', ...forced, snapshot: await editorSnapshot(page) }));
    if (forced.inserted && await waitForComposerText(page, text, 8000)) return true;
    if (!shouldAvoidKeyboardType(text)) {
      await page.keyboard.type(text, { delay: jitter(35, 80) }).catch(() => {});
      if (await waitForComposerText(page, text)) return true;
    }
  } else {
    console.log(JSON.stringify({ step: 'composer_editor_not_found', ...adaptive, diagnostic: await facebookUiSnapshot(page) }));
  }
  return false;
}

async function clickPostButton(page) {
  const locators = [
    page.locator('div[role="dialog"]').getByRole('button', { name: /^Post$/i }),
    page.locator('div[role="dialog"]').getByRole('button', { name: /^Publish$/i }),
    page.locator('div[role="dialog"]').getByRole('button', { name: /^Publier$/i }),
    page.getByRole('button', { name: /^Post$/i }),
    page.getByRole('button', { name: /^Publish$/i }),
    page.getByRole('button', { name: /^Publier$/i }),
    page.locator('div[aria-label="Post"][role="button"]'),
    page.locator('div[aria-label="Publish"][role="button"]'),
    page.locator('div[aria-label="Publier"][role="button"]'),
  ];
  for (const loc of locators) {
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const btn = loc.nth(i);
      try {
        if (!(await btn.isVisible({ timeout: 1000 }).catch(() => false))) continue;
        const disabled = await btn.evaluate((el) => Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true' || getComputedStyle(el).pointerEvents === 'none')).catch(() => false);
        if (disabled) continue;
        const label = await btn.evaluate((el) => (el.getAttribute('aria-label') || el.innerText || '').replace(/\s+/g, ' ').trim()).catch(() => '');
        await btn.hover().catch(() => {});
        await humanPause(500, 1100);
        await btn.click({ timeout: 10000 });
        return { clicked: true, method: 'known_locator', label };
      } catch (_) {}
    }
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    const adaptive = await page.evaluate(() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const labelOf = (el) => (el.getAttribute('aria-label') || el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      const dialogs = [...document.querySelectorAll('div[role="dialog"]')].filter(visible);
      const dialog = dialogs[dialogs.length - 1] || null;
      const nodes = [...document.querySelectorAll('button, [role="button"], div[aria-label]')].filter(visible);
      const scored = nodes.map((el) => {
        const label = labelOf(el);
        const lower = label.toLowerCase();
        let score = 0;
        if (/^(post|publish|publier)$/.test(lower)) score += 120;
        if (/\b(post|publish|publier)\b/.test(lower)) score += 45;
        if (dialog && dialog.contains(el)) score += 35;
        if (/photo|video|comment|like|share|cancel|close|back|schedule|audience|friends|public/.test(lower)) score -= 70;
        if (el.disabled || el.getAttribute('aria-disabled') === 'true' || getComputedStyle(el).pointerEvents === 'none') score -= 120;
        const rect = el.getBoundingClientRect();
        if (rect.width >= 48 && rect.height >= 24) score += 5;
        return { el, label, score };
      }).filter((item) => item.score > 70).sort((a, b) => b.score - a.score);
      const best = scored[0];
      if (!best) return { clicked: false, candidates: scored.slice(0, 5).map(({ label, score }) => ({ label, score })) };
      best.el.scrollIntoView({ block: 'center', inline: 'center' });
      best.el.click();
      return { clicked: true, label: best.label.slice(0, 160), score: best.score };
    }).catch((err) => ({ clicked: false, error: err.message || String(err) }));
    if (adaptive.clicked) return { clicked: true, method: 'adaptive_score', attempt, ...adaptive };
    await humanPause(900, 1600);
  }
  const fallback = await page.evaluate(() => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const labelOf = (el) => (el.getAttribute('aria-label') || el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    const dialogs = [...document.querySelectorAll('div[role="dialog"]')].filter(visible);
    const dialog = dialogs[dialogs.length - 1] || null;
    if (!dialog) return { clicked: false, reason: 'no dialog' };
    const buttons = [...dialog.querySelectorAll('button, [role="button"]')]
      .filter(visible)
      .map((el) => {
        const label = labelOf(el);
        const lower = label.toLowerCase();
        const rect = el.getBoundingClientRect();
        const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true' || getComputedStyle(el).pointerEvents === 'none';
        const bad = /photo|video|comment|like|share|cancel|close|back|schedule|audience|friends|public|add|edit|remove/.test(lower);
        return { el, label, disabled, bad, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, area: rect.width * rect.height };
      })
      .filter((item) => !item.disabled && !item.bad);
    const exact = buttons.find((item) => /^(post|publish|publier)$/i.test(item.label));
    const best = exact || buttons.sort((a, b) => b.y - a.y || b.x - a.x || b.area - a.area)[0];
    if (!best) return { clicked: false, reason: 'no enabled dialog action', labels: buttons.map((item) => item.label).slice(0, 12) };
    best.el.scrollIntoView({ block: 'center', inline: 'center' });
    best.el.click();
    return { clicked: true, label: best.label.slice(0, 160), method: exact ? 'dialog_exact_fallback' : 'dialog_primary_action_fallback' };
  }).catch((err) => ({ clicked: false, reason: err.message || String(err) }));
  if (fallback.clicked) return fallback;
  return { clicked: false, diagnostic: await facebookUiSnapshot(page) };
}

function textNeedles(text) {
  const raw = String(text || '').trim();
  const urls = raw.match(/https?:\/\/\S+/g) || [];
  const withoutUrls = raw.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
  return [...new Set([raw, ...urls.map(u => u.replace(/[).,]+$/g, '')), withoutUrls]
    .map(s => String(s || '').trim())
    .filter(s => s.length >= 6))];
}

function requiredCommentNeedles(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  const urls = raw.match(/https?:\/\/\S+/g) || [];
  if (urls.length) {
    return [...new Set(urls.flatMap((url) => {
      const clean = url.replace(/[).,]+$/g, '');
      const withoutProtocol = clean.replace(/^https?:\/\//i, '');
      const withoutWww = withoutProtocol.replace(/^www\./i, '');
      return [clean, withoutProtocol, withoutWww];
    }).filter((item) => item.length >= 6))];
  }
  return raw.length >= 12 ? [raw] : [];
}

async function waitForAnyBodyText(page, needles, timeoutMs = 15000) {
  const wanted = (needles || []).filter(Boolean);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = await page.evaluate((wanted) => {
      const text = document.body.innerText || '';
      return wanted.find(needle => text.includes(needle)) || '';
    }, wanted).catch(() => '');
    if (found) return found;
    await sleep(800);
  }
  return '';
}

async function waitForPublishedCommentText(page, commentText, timeoutMs = 22000) {
  const wanted = requiredCommentNeedles(commentText);
  if (!wanted.length) return { verified: false, needle: '', reason: 'no_required_comment_needle' };
  const started = Date.now();
  // Poll FB DOM faster (was 800ms). Each successful comment publish makes the
  // comment visible within 1-3s; tighter polling means we exit as soon as it
  // appears instead of waiting up to 800ms after.
  const pollIntervalMs = 350;
  while (Date.now() - started < timeoutMs) {
    const found = await page.evaluate((wanted) => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const editors = [...document.querySelectorAll('textarea, input, [contenteditable="true"], [role="textbox"]')].filter(visible);
      const nodes = [...document.querySelectorAll('[role="article"], [role="comment"], div, span, a')]
        .filter(visible)
        .filter((el) => !editors.some((editor) => el === editor || el.contains(editor)))
        .map((el) => ({
          tag: el.tagName,
          role: el.getAttribute('role') || '',
          text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(),
        }))
        .filter((item) => item.text.length >= 6 && !/write a comment|leave a comment|commenter|reply/i.test(item.text));
      for (const item of nodes) {
        const needle = wanted.find((value) => item.text.includes(value));
        if (needle) return { verified: true, needle, tag: item.tag, role: item.role, snippet: item.text.slice(0, 300) };
      }
      return { verified: false, needle: '', reason: 'required_comment_link_not_visible' };
    }, wanted).catch((err) => ({ verified: false, needle: '', reason: err?.message || String(err) }));
    if (found.verified) return found;
    await sleep(pollIntervalMs);
  }
  return { verified: false, needle: '', reason: 'required_comment_link_not_visible' };
}

async function clickCommentSubmitControl(page) {
  return await page.evaluate(() => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const active = document.activeElement;
    const activeRect = active?.getBoundingClientRect?.() || null;
    const labelOf = (el) => (el.getAttribute('aria-label') || el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    const nodes = [...document.querySelectorAll('button, [role="button"], [aria-label]')].filter(visible);
    const scored = nodes.map((el) => {
      const label = labelOf(el);
      const lower = label.toLowerCase();
      const rect = el.getBoundingClientRect();
      const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true' || getComputedStyle(el).pointerEvents === 'none';
      let score = 0;
      if (/^(send|post|comment)$/i.test(label)) score += 90;
      if (/\b(send|post comment|comment|envoyer|publier|commenter)\b/i.test(label)) score += 55;
      if (/^(reply|répondre|repondre)$/i.test(label)) score -= 140;
      if (/like|share|photo|gif|sticker|emoji|cancel|close|more|menu|edit|delete/i.test(lower)) score -= 80;
      if (disabled) score -= 120;
      if (active && (el.closest('[role="article"]') || document.body).contains(active)) score += 8;
      if (activeRect && Math.abs((rect.top + rect.height / 2) - (activeRect.top + activeRect.height / 2)) < 90) score += 30;
      if (activeRect && rect.left > activeRect.left) score += 8;
      return { el, label, score };
    }).filter((item) => item.score > 30).sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best) return { clicked: false, reason: 'comment_submit_control_not_found', candidates: scored.slice(0, 5).map(({ label, score }) => ({ label, score })) };
    best.el.scrollIntoView({ block: 'center', inline: 'center' });
    best.el.click();
    return { clicked: true, label: best.label.slice(0, 120), score: best.score };
  }).catch((err) => ({ clicked: false, reason: err?.message || String(err) }));
}

async function facebookRestrictionSnapshot(page, options = {}) {
  return await page.evaluate(({ includeBody }) => {
    const normalize = (value) => String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const roots = [];
    const dialogs = [...document.querySelectorAll('div[role="dialog"]')].filter(visible);
    if (dialogs.length) roots.push(dialogs[dialogs.length - 1]);
    const alerts = [...document.querySelectorAll('[role="alert"], [aria-live], [data-pagelet*="Toast"]')].filter(visible);
    roots.push(...alerts.slice(-5));
    if (includeBody) roots.push(document.body);
    const raw = roots.map(root => root?.innerText || root?.textContent || '').filter(Boolean).join('\n');
    const text = normalize(raw).toLowerCase();
    const checks = [
      ['comment_not_allowed', /\b(not allowed|not permitted|not authorized|not authorised)\b/],
      ['cannot_comment', /\b(can't comment|cannot comment|cant comment|unable to comment|couldn't comment|could not comment)\b/],
      ['comments_disabled', /\b(comments are turned off|comments disabled|commenting has been turned off|comments have been limited|commenting is limited)\b/],
      ['action_blocked', /\b(action blocked|temporarily blocked|try again later|restrict certain activity|misusing this feature)\b/],
      ['post_pending_or_unavailable', /\b(post is pending|pending approval|content isn't available|content is not available|post unavailable|this post isn't available)\b/],
      ['fr_cannot_comment', /\b(vous ne pouvez pas commenter|impossible de commenter|pas autoris|commentaires?.*(desactiv|limite|ferme)|temporairement bloque)\b/],
    ];
    for (const [reason, pattern] of checks) {
      if (pattern.test(text)) {
        return { blocked: true, reason, pattern: String(pattern), snippet: normalize(raw).slice(0, 1000) };
      }
    }
    return { blocked: false, reason: '', pattern: '', snippet: normalize(raw).slice(0, 300) };
  }, { includeBody: options.includeBody !== false }).catch((err) => {
    const message = err?.message || String(err);
    const pageGone = /target page|context|browser has been closed|page has been closed/i.test(message);
    return {
      blocked: pageGone,
      reason: pageGone ? 'page_unavailable_during_comment' : '',
      pattern: pageGone ? 'page_closed' : '',
      snippet: message.slice(0, 1000),
    };
  });
}

async function uploadSnapshot(page) {
  return await page.evaluate(() => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const dialogs = [...document.querySelectorAll('div[role="dialog"]')].filter(visible);
    const roots = dialogs.length ? dialogs : [document.body];
    const text = roots.map(root => root.innerText || '').join('\n');
    const media = [];
    const pushMedia = (item) => {
      const key = `${item.kind}|${item.width}|${item.height}|${item.src || item.label || ''}`;
      if (!media.some(existing => `${existing.kind}|${existing.width}|${existing.height}|${existing.src || existing.label || ''}` === key)) {
        media.push(item);
      }
    };
    for (const root of roots) {
      for (const img of root.querySelectorAll('img')) {
        if (!visible(img)) continue;
        const src = img.currentSrc || img.src || '';
        const alt = img.alt || '';
        const aria = img.getAttribute('aria-label') || '';
        const rect = img.getBoundingClientRect();
        const width = Math.max(img.naturalWidth || 0, img.width || 0, rect.width || 0);
        const height = Math.max(img.naturalHeight || 0, img.height || 0, rect.height || 0);
        const combined = `${src} ${alt} ${aria}`;
        if (width >= 64 && height >= 64 && !/emoji|avatar|profile|static\.xx|rsrc\.php/i.test(combined)) {
          pushMedia({ kind: 'img', width: Math.round(width), height: Math.round(height), src: src.slice(0, 140), alt: alt.slice(0, 80) });
        }
      }
      for (const el of root.querySelectorAll('[style]')) {
        if (!visible(el)) continue;
        const bg = getComputedStyle(el).backgroundImage || '';
        const rect = el.getBoundingClientRect();
        if (rect.width >= 64 && rect.height >= 64 && /url\(|blob:|scontent|fbcdn|lookaside/i.test(bg) && !/static\.xx|rsrc\.php/i.test(bg)) {
          pushMedia({ kind: 'background', width: Math.round(rect.width), height: Math.round(rect.height) });
        }
      }
      for (const el of root.querySelectorAll('canvas, [data-visualcompletion="media-vc-image"], [data-visualcompletion="ignore-dynamic"], [aria-label*="photo" i], [aria-label*="image" i]')) {
        if (!visible(el)) continue;
        const rect = el.getBoundingClientRect();
        const label = el.getAttribute('aria-label') || el.innerText || '';
        if (rect.width >= 64 && rect.height >= 64 && /photo|image|video|media|preview|canvas/i.test(`${label} ${el.tagName}`)) {
          pushMedia({ kind: el.tagName.toLowerCase() === 'canvas' ? 'canvas' : 'media-container', width: Math.round(rect.width), height: Math.round(rect.height), label: label.slice(0, 80) });
        }
      }
    }
    const hasRemovePhotoControl = roots.some(root => [...root.querySelectorAll('[aria-label],[role="button"],button')].some(el => visible(el) && (
      /remove photo|remove image|remove attachment|edit photo|tag photo|add photos|add more photos|supprimer la photo|retirer la photo|modifier la photo/i
        .test(el.getAttribute('aria-label') || el.innerText || '')
    )));
    const fileInputHasFiles = [...document.querySelectorAll('input[type="file"]')].some(el => (el.files || []).length > 0);
    const enabledPostButton = roots.some(root => [...root.querySelectorAll('div[role="button"], button')].some(el => {
      const label = (el.getAttribute('aria-label') || el.innerText || '').trim();
      const rect = el.getBoundingClientRect();
      const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
      return rect.width > 0 && rect.height > 0 && !disabled && /^(post|publish|publier)$/i.test(label);
    }));
    const stillUploading = /uploading|processing|preparing|téléchargement|chargement|préparation/i.test(text);
    return {
      mediaCount: media.length,
      media: media.slice(0, 4),
      hasRemovePhotoControl,
      fileInputHasFiles,
      enabledPostButton,
      stillUploading,
      dialogCount: dialogs.length,
      snippet: text.replace(/\s+/g, ' ').slice(0, 220),
    };
  }).catch(() => ({ mediaCount: 0, media: [], hasRemovePhotoControl: false, fileInputHasFiles: false, enabledPostButton: false, stillUploading: false, snippet: '' }));
}

async function waitForImageUploadConfirmation(page, timeoutMs = 60000, options = {}) {
  const started = Date.now();
  let last = null;
  let quietSince = 0;
  const uploadEvents = Array.isArray(options.uploadEvents) ? options.uploadEvents : [];
  const uploadEventStart = Number.isFinite(options.uploadEventStart) ? options.uploadEventStart : uploadEvents.length;
  while (Date.now() - started < timeoutMs) {
    last = await uploadSnapshot(page);
    const elapsed = Date.now() - started;
    if (last.stillUploading) quietSince = 0;
    else if (!quietSince) quietSince = elapsed;
    if ((last.mediaCount > 0 || last.hasRemovePhotoControl) && !last.stillUploading) {
      return { ...last, acceptedBy: 'preview_or_attachment_control' };
    }
    const freshUploadEvent = uploadEvents.slice(uploadEventStart).find((event) => event && event.status >= 200 && event.status < 400);
    if (elapsed > 4500 && freshUploadEvent && last.enabledPostButton && !last.stillUploading) {
      return { ...last, acceptedBy: 'facebook_upload_network_and_enabled_post_button', uploadEvent: freshUploadEvent };
    }
    if (elapsed > 9000 && last.fileInputHasFiles && last.enabledPostButton && !last.stillUploading) {
      return { ...last, acceptedBy: 'file_input_and_enabled_post_button' };
    }
    if (elapsed > 24000 && quietSince && elapsed - quietSince > 6000) {
      return { ...last, acceptedBy: 'best_effort_after_quiet_attach_wait', confirmationWeak: true };
    }
    await sleep(1000);
  }
  return { ...(last || {}), acceptedBy: 'best_effort_after_image_gate_timeout', confirmationWeak: true };
}

function imageUploadPreviewConfirmed(preview) {
  return Boolean(preview && !preview.confirmationWeak && (
    preview.mediaCount > 0 ||
    preview.hasRemovePhotoControl ||
    preview.fileInputHasFiles ||
    preview.acceptedBy === 'facebook_upload_network_and_enabled_post_button'
  ));
}

async function setFileOnBestInput(page, imagePath) {
  for (const loc of [
    page.locator('div[role="dialog"] input[type="file"][accept*="image"]'),
    page.locator('div[role="dialog"] input[type="file"]'),
    page.locator('input[type="file"][accept*="image"]'),
    page.locator('input[type="file"]'),
  ]) {
    const count = await loc.count().catch(() => 0);
    for (let i = count - 1; i >= 0; i--) {
      try {
        await loc.nth(i).setInputFiles(imagePath);
        return { method: 'input', index: i };
      } catch (_) {}
    }
  }
  throw new Error('no usable image file input found');
}

async function attachImageToComposer(page, imagePath, options = {}) {
  if (!imagePath || !fs.existsSync(imagePath)) throw new Error(`image file not found: ${imagePath || '(blank)'}`);
  if (!/\.(?:jpe?g|png)$/i.test(imagePath)) {
    throw new Error(`Facebook image must be JPG or PNG, not ${imagePath.split(/[\\/]/).pop() || imagePath}`);
  }
  const waitOptions = {
    ...options,
    uploadEventStart: Array.isArray(options.uploadEvents) ? options.uploadEvents.length : 0,
  };
  const dialog = page.locator('div[role="dialog"]').last();
  let attachMethod = null;
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null);
  const clickedPhoto = await clickFirst(page, [
    dialog.getByRole('button', { name: /photo\/video|photo|video|photos\/videos/i }),
    dialog.locator('[aria-label*="Photo" i]'),
    dialog.locator('[aria-label*="Video" i]'),
    page.getByRole('button', { name: /photo\/video|photo|video|photos\/videos/i }),
    page.locator('[aria-label*="Photo/video" i]'),
  ], { timeout: 6000 });
  const chooser = clickedPhoto ? await chooserPromise : null;
  if (chooser) {
    await chooser.setFiles(imagePath);
    attachMethod = { method: 'filechooser' };
  } else {
    await humanPause(800, 1600);
    attachMethod = await setFileOnBestInput(page, imagePath);
  }
  let preview = await waitForImageUploadConfirmation(page, 60000, waitOptions);
  if (!imageUploadPreviewConfirmed(preview)) {
    await humanPause(800, 1400);
    const retryMethod = await setFileOnBestInput(page, imagePath).catch((err) => ({ method: 'input_retry_failed', error: err?.message || String(err) }));
    const retryPreview = await waitForImageUploadConfirmation(page, 45000, waitOptions);
    if (imageUploadPreviewConfirmed(retryPreview)) {
      return { method: `${attachMethod?.method || 'unknown'}+${retryMethod.method || 'input_retry'}`, preview: retryPreview, firstPreview: preview };
    }
    preview = retryPreview;
    attachMethod = { ...attachMethod, retryMethod };
  }
  if (!imageUploadPreviewConfirmed(preview)) {
    throw new Error(`image_upload_not_confirmed: Facebook did not show a usable image preview for ${imagePath.split(/[\\/]/).pop() || imagePath}`);
  }
  return { ...attachMethod, preview };
}

async function submitCommentOnVisiblePost(page, marker, commentText, expectedPostUrl = '') {
  const expectedPostParts = facebookGroupPostParts(expectedPostUrl);
  const result = {
    clicked: false,
    typed: false,
    submitted: false,
    verified: false,
    verifiedNeedle: '',
    blocked: false,
    blockReason: '',
    restrictionText: '',
    expectedPostUrl: expectedPostUrl || '',
  };
  const currentPostSnapshot = async () => {
    const url = await page.evaluate(() => location.href).catch(() => page.url());
    const parts = facebookGroupPostParts(url);
    return {
      url,
      parts,
      matchesExpected: !expectedPostParts || Boolean(parts && parts.groupId === expectedPostParts.groupId && parts.postId === expectedPostParts.postId),
    };
  };
  const ensureExpectedPostLoaded = async (stage) => {
    const snapshot = await currentPostSnapshot();
    result.currentPostUrl = snapshot.url;
    if (!snapshot.matchesExpected) {
      result.blocked = true;
      result.blockReason = 'expected_post_permalink_mismatch_before_comment';
      result.blockStage = stage;
      result.expectedPostParts = expectedPostParts;
      result.currentPostParts = snapshot.parts;
      result.restrictionText = `Expected ${expectedPostUrl || 'target post'}, current ${snapshot.url || 'unknown'}`.slice(0, 1000);
      return false;
    }
    return true;
  };
  const applyRestriction = (snapshot) => {
    if (!snapshot?.blocked) return false;
    result.blocked = true;
    result.blockReason = snapshot.reason || snapshot.pattern || 'facebook_restriction';
    result.restrictionText = snapshot.snippet || '';
    return true;
  };
  if (applyRestriction(await facebookRestrictionSnapshot(page, { includeBody: false }))) return result;
  if (!(await ensureExpectedPostLoaded('initial_page'))) return result;
  // Duplicate-comment guard: if a comment with this exact text already exists
  // on the page (e.g. from a previous test run on this same post URL, or from
  // an earlier submission of this run that we didn't initially verify), skip
  // posting another one. The verify-after-submit step will mark it ok.
  const existingDupCheck = await page.evaluate(({ commentText }) => {
    try {
      const target = String(commentText || '').trim();
      if (!target) return { found: false };
      const body = document.body.innerText || '';
      if (!body.includes(target)) return { found: false };
      // Also check via permalink extraction: any element whose innerText
      // contains the FULL target text (not just a fragment).
      const matches = [...document.querySelectorAll('div, span')].filter((el) => {
        const t = (el.innerText || '').trim();
        return t.length >= target.length && t.length <= target.length + 1500 && t.includes(target);
      }).length;
      return { found: matches > 0, matchCount: matches };
    } catch (e) { return { found: false, error: e?.message || String(e) }; }
  }, { commentText }).catch(() => ({ found: false }));
  if (existingDupCheck.found) {
    result.clicked = false;
    result.typed = false;
    result.submitted = true;
    result.verified = true;
    result.skipped = true;
    result.skipReason = 'comment_already_exists_on_post_no_duplicate_needed';
    result.verifiedNeedle = commentText;
    result.duplicateCheck = existingDupCheck;
    return result;
  }
  const initialCommentPath = await page.evaluate(() => location.pathname).catch(() => '');
  const captureTargetState = async () => page.evaluate((marker) => {
    const text = document.body.innerText || '';
    const title = document.title || '';
    const exactGroupPostPath = /\/groups\/[0-9]+\/(?:permalink|posts)\/[0-9]+/i.test(location.pathname || '');
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const matches = (value) => {
      if (!marker) return false;
      if (String(value || '').includes(marker)) return true;
      const normalize = (input) => String(input || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      const cleanMarker = normalize(marker);
      return cleanMarker.length >= 12 && normalize(value).includes(cleanMarker);
    };
    const markerArticles = [...document.querySelectorAll('[role="article"]')]
      .filter((el) => visible(el) && marker && matches(el.innerText || ''));
    const markerRoots = [...document.querySelectorAll('[role="article"], div')]
      .filter((el) => visible(el) && marker && matches(el.innerText || ''));
    const exactPermalinkCommentBoxes = [...document.querySelectorAll('[contenteditable="true"], [role="textbox"], textarea, [aria-label*="Comment as" i], [aria-label*="Write a comment" i], [aria-label*="commenter" i]')]
      .filter((el) => {
        if (!visible(el)) return false;
        const label = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (/what.*mind|write something|create post|search facebook/.test(label)) return false;
        return /comment as|write a comment|commenter|\bcomment\b/.test(label);
      });
    return {
      markerVisible: matches(text),
      titleHasMarker: matches(title),
      exactGroupPostPath,
      visibleMarkerArticleCount: markerArticles.length,
      visibleMarkerRootCount: markerRoots.length,
      exactPermalinkCommentBoxCount: exactPermalinkCommentBoxes.length,
    };
  }, marker).catch(() => ({ markerVisible: false, titleHasMarker: false, exactGroupPostPath: false, visibleMarkerArticleCount: 0, visibleMarkerRootCount: 0, exactPermalinkCommentBoxCount: 0 }));
  let initialTargetState = await captureTargetState();
  const MAX_COMMENT_TARGET_RETRIES = 6;
  let commentTargetRetries = 0;
  // FAST-PATH: we navigated to the EXPECTED permalink URL and the URL still
  // matches that exact post. We know we're on the right page - skip the slow
  // "find role=article with marker" retry loop (was burning up to 86s waiting
  // for a defensive DOM check that's not needed once URL is confirmed).
  const urlConfirmsRightPost = (() => {
    if (!expectedPostParts) return false;
    if (!initialTargetState.exactGroupPostPath) return false;
    // currentPostSnapshot.matchesExpected check was already done above
    return true;
  })();
  while (
    initialTargetState.visibleMarkerArticleCount === 0
    && commentTargetRetries < MAX_COMMENT_TARGET_RETRIES
    && !urlConfirmsRightPost
  ) {
    commentTargetRetries += 1;
    const waitMs = 5000 + commentTargetRetries * 2500;
    await page.waitForTimeout(waitMs);
    await page.mouse.wheel(0, 500 + commentTargetRetries * 200).catch(() => {});
    if (commentTargetRetries === 3) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(4000);
    }
    initialTargetState = await captureTargetState();
    if (initialTargetState.visibleMarkerArticleCount > 0) break;
  }
  // When URL-confirmed but markerArticleCount still 0, do ONE short wait + scroll
  // to let the article render, then move on.
  if (urlConfirmsRightPost && initialTargetState.visibleMarkerArticleCount === 0) {
    await page.waitForTimeout(2500);
    await page.mouse.wheel(0, 400).catch(() => {});
    initialTargetState = await captureTargetState();
  }
  result.initialTargetState = initialTargetState;
  result.commentTargetRetries = commentTargetRetries;
  const markerVisibleBeforeComment = Boolean(initialTargetState.visibleMarkerArticleCount > 0);
  const exactPermalinkFallbackAllowed = Boolean(
    expectedPostParts &&
    initialTargetState.exactGroupPostPath &&
    initialTargetState.markerVisible &&
    initialTargetState.visibleMarkerRootCount > 0 &&
    initialTargetState.exactPermalinkCommentBoxCount > 0
  );
  const onExpectedPermalinkWithMarker = Boolean(
    expectedPostParts &&
    initialTargetState.exactGroupPostPath &&
    initialTargetState.markerVisible
  );
  if (!markerVisibleBeforeComment && !exactPermalinkFallbackAllowed && !onExpectedPermalinkWithMarker) {
    result.blocked = true;
    result.blockReason = 'target_marker_article_not_visible_before_comment';
    return result;
  }
  if (!(await ensureExpectedPostLoaded('before_comment_button_click'))) return result;
  const clickedByMarker = (markerVisibleBeforeComment || exactPermalinkFallbackAllowed || onExpectedPermalinkWithMarker) ? await page.evaluate(({ marker, allowTitleFallback }) => {
    const normalize = (input) => String(input || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const matches = (value) => {
      if (!marker) return false;
      if (String(value || '').includes(marker)) return true;
      const cleanMarker = normalize(marker);
      return cleanMarker.length >= 12 && normalize(value).includes(cleanMarker);
    };
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const buttonLabel = (el) => (el.getAttribute('aria-label') || el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    const articleRoots = [...document.querySelectorAll('[role="article"]')]
      .filter(el => visible(el) && marker && matches(el.innerText || ''));
    const markerRoots = [...document.querySelectorAll('[role="article"], [data-pagelet], div')]
      .filter((el) => visible(el) && marker && matches(el.innerText || ''))
      .map((el) => {
        const textLength = (el.innerText || '').length;
        const hasCommentControl = [...el.querySelectorAll('[role="button"],button,a,[contenteditable="true"],[role="textbox"],textarea')]
          .some((control) => visible(control) && /Leave a comment|Write a comment|Comment as|Commenter|\bComment\b/i.test(buttonLabel(control)));
        return { el, textLength, hasCommentControl };
      })
      .filter((item) => item.textLength < 30000)
      .sort((a, b) => {
        if (a.hasCommentControl !== b.hasCommentControl) return a.hasCommentControl ? -1 : 1;
        return a.textLength - b.textLength;
      })
      .map((item) => item.el);
    const roots = articleRoots.length ? articleRoots : markerRoots;
    const scopedRoots = [];
    for (const root of roots.slice(0, 8)) {
      let current = root;
      for (let depth = 0; current && depth < 6; depth += 1) {
        if (!scopedRoots.includes(current) && visible(current)) scopedRoots.push(current);
        current = current.parentElement;
      }
    }
    if (!scopedRoots.length && allowTitleFallback) scopedRoots.push(document.querySelector('[role="main"]') || document.body);
    for (const root of scopedRoots) {
      const buttons = [...root.querySelectorAll('[role="button"],button,a')]
        .filter(visible)
        .map((el) => ({ el, label: buttonLabel(el) }))
        .filter((item) => /Leave a comment|Write a comment|Comment|Commenter/i.test(item.label));
      const btn = buttons[0]?.el;
      if (btn) { btn.click(); return true; }
    }
    return false;
  }, { marker, allowTitleFallback: exactPermalinkFallbackAllowed }).catch(() => false) : false;
  if (!clickedByMarker && !exactPermalinkFallbackAllowed) {
    result.blocked = true;
    result.blockReason = 'marker_scoped_comment_button_not_found';
    return result;
  }
  result.clicked = true;
  await humanPause(400, 800);
  if (!(await ensureExpectedPostLoaded('after_comment_button_click'))) return result;
  const markerScopedBox = await page.evaluate((marker) => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const labelOf = (el) => (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    const matches = (value) => {
      if (!marker) return false;
      if (String(value || '').includes(marker)) return true;
      const normalize = (input) => String(input || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      const cleanMarker = normalize(marker);
      return cleanMarker.length >= 12 && normalize(value).includes(cleanMarker);
    };
    const articleRoots = [...document.querySelectorAll('[role="article"]')]
      .filter((el) => visible(el) && marker && matches(el.innerText || ''));
    const markerRoots = [...document.querySelectorAll('[role="article"], [data-pagelet], div')]
      .filter((el) => visible(el) && marker && matches(el.innerText || ''))
      .map((el) => {
        const textLength = (el.innerText || '').length;
        const boxCount = [...el.querySelectorAll('[contenteditable="true"], [role="textbox"], textarea')]
          .filter(visible).length;
        return { el, textLength, boxCount };
      })
      .filter((item) => item.textLength < 30000)
      .sort((a, b) => {
        if (a.boxCount !== b.boxCount) return b.boxCount - a.boxCount;
        return a.textLength - b.textLength;
      })
      .map((item) => item.el);
    const preferredRoot = articleRoots[0] || markerRoots[0];
    if (!preferredRoot) return { clicked: false, reason: 'target_marker_root_not_found_after_comment_open' };
    const boxes = [...preferredRoot.querySelectorAll('[contenteditable="true"], [role="textbox"], textarea')]
      .filter(visible)
      .map((el) => {
        const label = labelOf(el);
        const lower = label.toLowerCase();
        let score = 0;
        if (/comment|commenter/.test(lower)) score += 90;
        if (/write|reply|rÃ©pondre|commenter/.test(lower)) score += 25;
        if (/what.*mind|write something|create post/.test(lower)) score -= 100;
        return { el, label, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);
    const best = boxes[0];
    if (!best) return { clicked: false, reason: 'marker_scoped_comment_box_not_found' };
    best.el.scrollIntoView({ block: 'center', inline: 'center' });
    best.el.click();
    return { clicked: true, label: best.label.slice(0, 160), score: best.score };
  }, marker).catch((err) => ({ clicked: false, reason: err.message || String(err) }));
  result.markerScopedBox = markerScopedBox;
  if (!markerScopedBox.clicked) {
    if (!(await ensureExpectedPostLoaded('before_permalink_scoped_comment_box'))) return result;
    const permalinkScopedBox = await page.evaluate(({ marker, initialPath }) => {
      const exactPath = /\/groups\/[0-9]+\/(?:permalink|posts)\/[0-9]+/i;
      if (!exactPath.test(location.pathname) && !exactPath.test(initialPath || '')) {
        return { clicked: false, reason: 'not_exact_group_permalink_comment_fallback' };
      }
      const bodyText = document.body.innerText || '';
      const matches = (value) => {
        if (!marker) return false;
        if (String(value || '').includes(marker)) return true;
        const normalize = (input) => String(input || '')
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[^\p{L}\p{N}]+/gu, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
        const cleanMarker = normalize(marker);
        return cleanMarker.length >= 12 && normalize(value).includes(cleanMarker);
      };
      if (!marker || !matches(bodyText)) return { clicked: false, reason: 'target_marker_not_visible_for_permalink_comment_fallback' };
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const labelOf = (el) => (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      const markerRoots = [...document.querySelectorAll('[role="article"], [data-pagelet], div')]
        .filter((el) => visible(el) && matches(el.innerText || ''))
        .map((el) => {
          const textLength = (el.innerText || '').length;
          const boxCount = [...el.querySelectorAll('[contenteditable="true"], [role="textbox"], textarea, [aria-label*="Comment as" i], [aria-label*="Write a comment" i], [aria-label*="commenter" i]')]
            .filter(visible).length;
          return { el, textLength, boxCount };
        })
        .filter((item) => item.textLength < 30000)
        .sort((a, b) => {
          if (a.boxCount !== b.boxCount) return b.boxCount - a.boxCount;
          return a.textLength - b.textLength;
        })
        .map((item) => item.el);
      const markerRoot = markerRoots[0] || null;
      const markerRect = markerRoot?.getBoundingClientRect?.() || null;
      if (!markerRoot) return { clicked: false, reason: 'target_marker_article_not_found_for_permalink_comment_fallback' };
      const selector = [
        '[contenteditable="true"]',
        '[role="textbox"]',
        'textarea',
        '[aria-label*="Comment as" i]',
        '[aria-label*="Write a comment" i]',
        '[aria-label*="commenter" i]',
      ].join(',');
      const searchRoot = markerRoot;
      const boxes = [...searchRoot.querySelectorAll(selector)]
        .filter(visible)
        .map((el) => {
          const label = labelOf(el);
          const lower = label.toLowerCase();
          const rect = el.getBoundingClientRect();
          let score = 0;
          if (/comment as|write a comment|commenter/.test(lower)) score += 130;
          else if (/\bcomment\b|leave a comment/.test(lower)) score += 85;
          if (el.matches?.('[contenteditable="true"], [role="textbox"], textarea')) score += 35;
          if (/reply|write|commenter/.test(lower)) score += 20;
          if (/what.*mind|write something|create post|search facebook/.test(lower)) score -= 180;
          if (markerRect) {
            if (rect.top >= markerRect.top - 120) score += 20;
            else score -= 90;
          }
          return { el, label, score, top: Math.round(rect.top) };
        })
        .filter((item) => item.score >= 90)
        .sort((a, b) => b.score - a.score);
      const best = boxes[0];
      if (!best) return {
        clicked: false,
        reason: 'permalink_scoped_comment_box_not_found',
        candidates: boxes.slice(0, 5).map(({ label, score, top }) => ({ label: label.slice(0, 120), score, top })),
      };
      best.el.scrollIntoView({ block: 'center', inline: 'center' });
      best.el.click();
      return { clicked: true, label: best.label.slice(0, 160), score: best.score, top: best.top, fallback: true };
    }, { marker, initialPath: initialCommentPath }).catch((err) => ({ clicked: false, reason: err.message || String(err) }));
    result.permalinkScopedBox = permalinkScopedBox;
    if (!permalinkScopedBox.clicked) {
      result.blocked = true;
      result.blockReason = markerScopedBox.reason || permalinkScopedBox.reason || 'marker_scoped_comment_box_not_found';
      return result;
    }
  }
  if (!(await ensureExpectedPostLoaded('before_comment_text_insert'))) return result;
  await page.keyboard.insertText(commentText).catch(() => {});
  await humanPause(250, 500);
  result.typed = true;
  result.submitAttempts = [];
  const verifyCommentNow = async (timeoutMs = 5000) => {
    const published = await waitForPublishedCommentText(page, commentText, timeoutMs);
    result.verified = Boolean(published.verified);
    result.verifiedNeedle = published.needle || '';
    result.verifiedSnippet = published.snippet || '';
    result.verifyReason = published.reason || '';
    if (result.verified) result.submitted = true;
    return result.verified;
  };
  // Check if Enter cleared the comment textbox - FB clears it on successful
  // submission. This is a near-instant signal that we can use to short-circuit
  // the verify polling (which can take 3-6s waiting for the comment to render
  // in the DOM). If textbox is empty, we still call verify but with a tiny
  // timeout to confirm.
  const textboxClearedAfterSubmit = async () => {
    return await page.evaluate(() => {
      const ae = document.activeElement;
      if (!ae) return false;
      const isEditor = ae.isContentEditable || ae.tagName === 'TEXTAREA' || ae.getAttribute?.('role') === 'textbox';
      if (!isEditor) return false;
      const text = (ae.innerText || ae.textContent || ae.value || '').replace(/​/g, '').trim();
      return text.length === 0;
    }).catch(() => false);
  };
  const submitAttempt = async (method, action) => {
    const entry = { method, ok: false };
    if (!(await ensureExpectedPostLoaded(`before_submit_${method}`))) {
      entry.ok = false;
      entry.error = result.blockReason;
      result.submitAttempts.push(entry);
      return false;
    }
    try {
      const actionResult = await action();
      if (actionResult && typeof actionResult === 'object') Object.assign(entry, actionResult);
      entry.ok = actionResult !== false;
    } catch (err) {
      entry.ok = false;
      entry.error = err?.message || String(err);
    }
    result.submitAttempts.push(entry);
    await humanPause(300, 600);
    // If textbox is empty after Enter, FB accepted the submit - poll briefly
    // for DOM render. If textbox still has text, the action did nothing - exit
    // fast and let the next method (Ctrl+Enter, submit-control) try.
    const cleared = await textboxClearedAfterSubmit();
    return await verifyCommentNow(cleared ? 4000 : 1500);
  };
  // First submit attempt: shorter verify because Enter usually works within 1-3s.
  const submitAttemptShort = async (method, action) => {
    const entry = { method, ok: false };
    if (!(await ensureExpectedPostLoaded(`before_submit_${method}`))) {
      entry.ok = false;
      entry.error = result.blockReason;
      result.submitAttempts.push(entry);
      return false;
    }
    try {
      const actionResult = await action();
      if (actionResult && typeof actionResult === 'object') Object.assign(entry, actionResult);
      entry.ok = actionResult !== false;
    } catch (err) {
      entry.ok = false;
      entry.error = err?.message || String(err);
    }
    result.submitAttempts.push(entry);
    await humanPause(200, 400);
    const cleared = await textboxClearedAfterSubmit();
    return await verifyCommentNow(cleared ? 2800 : 1200);
  };
  // ANTI-TAG GUARD: after typing, FB may pop a mention/autocomplete dropdown (it tries to
  // match text to a person/page). If we press Enter to submit while that dropdown is open,
  // FB ACCEPTS the highlighted mention — tagging a random person and MANGLING the comment/
  // link (e.g. "mavlynk.com/<Someone's Name>"), which FB then drops or renders wrong (this
  // is the cause of the "tagged someone / broken link / missing comment" reports). Close any
  // open dropdown with Escape and confirm our exact link is still in the composer; if a
  // mention mangled or cleared it, re-focus, clear, and retype the clean comment once.
  const commentGuardNeedles = requiredCommentNeedles(commentText);
  const composerGuardState = async () => page.evaluate((needles) => {
    const ae = document.activeElement;
    const txt = (ae ? (ae.innerText || ae.textContent || ae.value || '') : '').replace(/​/g, '');
    const dropdown = [...document.querySelectorAll('[role="listbox"],[role="menu"],[aria-label*="Suggestion" i]')].some((el) => { const r = el.getBoundingClientRect(); return r.width > 30 && r.height > 20; });
    const editorFocused = !!ae && (ae.isContentEditable || ae.tagName === 'TEXTAREA' || ae.getAttribute('role') === 'textbox');
    return { dropdown, editorFocused, hasAll: needles.length > 0 && needles.every((n) => txt.includes(n)), sample: txt.slice(0, 160) };
  }, commentGuardNeedles).catch(() => ({ dropdown: false, editorFocused: true, hasAll: true, sample: '' }));
  // Move the caret to the very END (past the 2 trailing spaces the comment text now ends with)
  // and close any open mention/hashtag suggestion popover. Called right before EVERY Enter so a
  // submit never accepts a highlighted mention and tags a random person.
  const dismissMentionDropdownBeforeSubmit = async () => {
    await page.keyboard.press('End').catch(() => {});
    const gs = await composerGuardState();
    if (gs.dropdown) { await page.keyboard.press('Escape').catch(() => {}); await humanPause(150, 320); }
  };
  {
    let gs = await composerGuardState();
    if (gs.dropdown) {
      await page.keyboard.press('Escape').catch(() => {});
      await humanPause(250, 500);
      gs = await composerGuardState();
    }
    if (!gs.hasAll) {
      console.log(JSON.stringify({ step: 'comment_autocomplete_mangle_detected', sample: gs.sample }));
      if (!gs.editorFocused) {
        const box = page.locator('div[contenteditable="true"][role="textbox"], [aria-label*="Write a comment" i]').first();
        await box.click({ timeout: 2500 }).catch(() => {});
        await humanPause(150, 350);
      }
      await page.keyboard.press('Control+A').catch(() => {});
      await page.keyboard.press('Delete').catch(() => {});
      await humanPause(200, 400);
      await page.keyboard.insertText(commentText).catch(() => {});
      await humanPause(300, 600);
      const gs2 = await composerGuardState();
      if (gs2.dropdown) { await page.keyboard.press('Escape').catch(() => {}); await humanPause(200, 400); }
    }
    console.log(JSON.stringify({ step: 'comment_pre_submit_guard', dropdownClosed: gs.dropdown, intact: (await composerGuardState()).hasAll }));
  }
  await submitAttemptShort('enter', async () => {
    await dismissMentionDropdownBeforeSubmit();
    await page.keyboard.press('Enter');
    return true;
  });
  if (!result.verified && !result.blocked) {
    await submitAttempt('control_enter', async () => {
      await dismissMentionDropdownBeforeSubmit();
      await page.keyboard.press('Control+Enter');
      return true;
    });
  }
  if (!result.verified && !result.blocked) {
    const submitControl = await clickCommentSubmitControl(page);
    result.submitControl = submitControl;
    if (submitControl.clicked) {
      await submitAttempt('submit_control', async () => submitControl);
    }
  }
  if (!result.verified && !result.blocked) {
    await submitAttempt('enter_retry', async () => {
      await dismissMentionDropdownBeforeSubmit();
      await page.keyboard.press('Enter');
      return true;
    });
  }
  if (!result.submitted && !result.blocked && !expectedPostParts) for (const loc of [
    page.getByRole('textbox', { name: /write a comment|comment|commenter/i }),
    page.locator('[aria-label*="Write a comment" i]'),
    page.locator('div[contenteditable="true"][role="textbox"]'),
    page.locator('div[contenteditable="true"]'),
  ]) {
    const n = await loc.count().catch(() => 0);
    for (let i = n - 1; i >= 0; i--) {
      const box = loc.nth(i);
      try {
        if (!(await ensureExpectedPostLoaded('before_locator_comment_box'))) break;
        if (!(await box.isVisible({ timeout: 800 }).catch(() => false))) continue;
        await box.click({ timeout: 3000 });
        if (!(await ensureExpectedPostLoaded('before_locator_comment_text_insert'))) break;
        await page.keyboard.insertText(commentText).catch(() => {});
        await humanPause(500, 1000);
        result.typed = true;
        if (await submitAttempt('locator_enter', async () => {
          await dismissMentionDropdownBeforeSubmit();
          await page.keyboard.press('Enter');
          return true;
        })) break;
      } catch (err) {
        applyRestriction(await facebookRestrictionSnapshot(page));
        if (result.blocked) break;
      }
    }
    if (result.submitted) break;
    if (result.blocked) break;
  }
  if (!result.submitted && !result.blocked && !expectedPostParts) {
    if (!(await ensureExpectedPostLoaded('before_adaptive_comment_box'))) return result;
    const adaptiveBox = await page.evaluate((marker) => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const labelOf = (el) => (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      const matches = (value) => {
        if (!marker) return false;
        if (String(value || '').includes(marker)) return true;
        const normalize = (input) => String(input || '')
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[^\p{L}\p{N}]+/gu, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
        const cleanMarker = normalize(marker);
        return cleanMarker.length >= 12 && normalize(value).includes(cleanMarker);
      };
      const roots = [...document.querySelectorAll('[role="article"], div')].filter((el) => marker && matches(el.innerText || ''));
      const preferredRoot = roots.find((el) => el.matches?.('[role="article"]')) || roots[roots.length - 1] || document.body;
      const boxes = [...document.querySelectorAll('[contenteditable="true"], [role="textbox"], textarea')]
        .filter(visible)
        .map((el) => {
          const label = labelOf(el);
          const lower = label.toLowerCase();
          let score = 0;
          if (/comment|commenter/.test(lower)) score += 90;
          if (preferredRoot.contains(el)) score += 60;
          if (/write|reply|répondre|commenter/.test(lower)) score += 25;
          if (/what.*mind|write something|create post/.test(lower)) score -= 100;
          return { el, label, score };
        })
        .filter((item) => item.score > 20)
        .sort((a, b) => b.score - a.score);
      const best = boxes[0];
      if (!best) return { clicked: false, candidates: boxes.slice(0, 5).map(({ label, score }) => ({ label, score })) };
      best.el.scrollIntoView({ block: 'center', inline: 'center' });
      best.el.click();
      return { clicked: true, label: best.label.slice(0, 160), score: best.score };
    }, marker).catch((err) => ({ clicked: false, error: err.message || String(err) }));
    if (adaptiveBox.clicked) {
      await humanPause(500, 1000);
      if (!(await ensureExpectedPostLoaded('before_adaptive_comment_text_insert'))) return result;
      await page.keyboard.insertText(commentText).catch(() => {});
      await humanPause(500, 1000);
      result.clicked = true;
      result.typed = true;
      result.adaptiveBox = adaptiveBox;
      await submitAttempt('adaptive_enter', async () => {
        await page.keyboard.press('Enter');
        return true;
      });
    } else {
      applyRestriction(await facebookRestrictionSnapshot(page));
      result.diagnostic = await facebookUiSnapshot(page);
    }
  }
  if (result.typed) {
    // ALWAYS confirm the comment PERSISTS after a fresh reload — even when the immediate
    // check already "verified" it. FB renders a submitted comment OPTIMISTICALLY
    // (client-side) for a few seconds even when its spam filter is about to REJECT a
    // link-comment (mavlynk shortlinks are a classic trigger), so an immediate DOM match
    // can verify a comment that vanishes right after. Previously the reload re-check only
    // ran when the immediate check FAILED, so an optimistic match locked in a false
    // "verified" and the comment was recorded as landed even though it never stuck. Now we
    // re-verify after a reload unconditionally: a comment only counts if it survives the
    // reload, so a rejected/transient comment is correctly marked failed and retried with
    // another profile — in both #test and prod.
    const optimisticVerified = result.verified;
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await humanPause(4000, 7000);
    const reloadedPublished = await waitForPublishedCommentText(page, commentText, 14000);
    result.verified = Boolean(reloadedPublished.verified);
    result.verifiedNeedle = reloadedPublished.needle || result.verifiedNeedle || '';
    result.verifiedSnippet = reloadedPublished.snippet || result.verifiedSnippet || '';
    result.verifyReason = reloadedPublished.reason || result.verifyReason || '';
    result.reloadedAfterSubmit = true;
    result.optimisticVerified = optimisticVerified;
    if (result.verified) {
      result.submitted = true;
    } else if (optimisticVerified) {
      // Was visible immediately but GONE after reload -> FB rejected/removed the link-comment.
      result.submitted = false;
      result.verifyReason = result.verifyReason || 'comment_did_not_persist_after_reload_fb_likely_rejected_link_comment';
    }
    if (!result.verified && applyRestriction(await facebookRestrictionSnapshot(page))) {
      result.submitted = false;
    }
  } else if (!result.blocked) {
    applyRestriction(await facebookRestrictionSnapshot(page));
  }
  return result;
}

async function pinVisibleComment(page, commentText) {
  const result = { requested: true, menuOpened: false, clicked: false, confirmed: false, verified: false, reason: '' };
  const needles = textNeedles(commentText);
  const pinMenuPattern = /pin comment|pin this comment|\bpin\b|epingler|épingler|fijar|fixer/i;
  const clickPinMenuItem = async (root = null) => {
    await humanPause(800, 1500);
    const pinItem = await clickFirst(page, [
      page.getByRole('menuitem', { name: pinMenuPattern }),
      page.locator('[role="menuitem"]').filter({ hasText: pinMenuPattern }),
      page.locator('[role="menuitemradio"]').filter({ hasText: pinMenuPattern }),
    ], { timeout: 4500 });
    if (!pinItem) {
      result.reason = 'pin menu item not found';
      // Diagnostic: capture all visible menu items to see what FB does show
      result.openMenuItems = await page.evaluate(() => {
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
        };
        return [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="menu"] [role="button"], [role="menu"] a')]
          .filter(visible)
          .slice(0, 25)
          .map((el) => ({
            tag: el.tagName,
            role: el.getAttribute('role') || '',
            ariaLabel: (el.getAttribute('aria-label') || '').slice(0, 80),
            text: ((el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()).slice(0, 80),
          }));
      }).catch(() => []);
      await page.keyboard.press('Escape').catch(() => {});
      return false;
    }
    result.clicked = true;
    await humanPause(800, 1500);
    const confirm = await clickFirst(page, [
      page.locator('div[role="dialog"]').getByRole('button', { name: /^Pin$/i }),
      page.getByRole('button', { name: /^Pin$/i }),
      page.locator('div[role="dialog"] [role="button"]').filter({ hasText: /^Pin$/i }),
    ], { timeout: 2500 });
    result.confirmed = Boolean(confirm);
    await humanPause(3500, 6000);
    result.verified = await page.evaluate((needles) => {
      const text = document.body.innerText || '';
      return needles.some(needle => text.includes(needle)) && /Pinned|Unpin comment/i.test(text);
    }, needles).catch(() => false);
    if (!result.verified && root) {
      const menuCheckOpened = await clickFirst(page, [
        root.getByLabel(/actions for this comment|more|options|menu/i),
        root.locator('[aria-haspopup="menu"]'),
        root.locator('[aria-label*="More" i]'),
        root.locator('[aria-label*="Options" i]'),
      ], { timeout: 2500 });
      if (menuCheckOpened) {
        await humanPause(600, 1200);
        result.verified = await page.locator('[role="menuitem"]').filter({ hasText: /unpin comment|unpin/i }).first().isVisible({ timeout: 2500 }).catch(() => false);
        await page.keyboard.press('Escape').catch(() => {});
      }
    }
    if (!result.verified) result.reason = 'pin action clicked but pinned state was not verified';
    return true;
  };
  for (const needle of needles) {
    const articles = page.locator('[role="article"]').filter({ hasText: needle });
    const count = await articles.count().catch(() => 0);
    for (let i = count - 1; i >= 0; i--) {
      const root = articles.nth(i);
      try {
        if (!(await root.isVisible({ timeout: 800 }).catch(() => false))) continue;
        await root.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
        await root.hover({ timeout: 3000 }).catch(() => {});
        await humanPause(500, 1000);
        const opened = await clickFirst(page, [
          // Modern FB aria-labels (post 2025 updates)
          root.getByLabel(/comment menu|comment options|comment actions|more comment options|options for this comment/i),
          // Legacy / generic
          root.getByLabel(/actions for this comment|^more$|^options$|^menu$/i),
          root.locator('[aria-haspopup="menu"]'),
          root.locator('[aria-label*="More" i]'),
          root.locator('[aria-label*="Options" i]'),
          root.locator('[role="button"]').filter({ hasText: /^\s*(\.\.\.|More)\s*$/i }),
          // SVG kebab fallback - 3-dots icon inside a button
          root.locator('div[role="button"]:has(svg)').last(),
        ], { timeout: 3500 });
        if (!opened) continue;
        result.menuOpened = true;
        await clickPinMenuItem(root);
        return result;
      } catch (err) {
        result.reason = err.message || String(err);
      }
    }
  }
  const adaptive = await page.evaluate((needles) => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const labelOf = (el) => (el.getAttribute('aria-label') || el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    const candidates = [...document.querySelectorAll('[role="article"], [role="comment"], div, li')]
      .filter((el) => {
        if (!visible(el)) return false;
        const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ');
        return needles.some((needle) => needle && text.includes(needle)) && text.length < 5000;
      })
      .map((el) => ({ el, length: (el.innerText || el.textContent || '').length }))
      .sort((a, b) => a.length - b.length)
      .slice(0, 12);
    for (const { el } of candidates) {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      for (const type of ['mouseover', 'mousemove', 'mouseenter']) {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      const controls = [...el.querySelectorAll('[aria-haspopup="menu"], [aria-label], [role="button"], button, a')]
        .map((control) => {
          const label = labelOf(control);
          const lower = label.toLowerCase();
          const rect = control.getBoundingClientRect();
          let score = 0;
          if (/actions for this comment|comment actions|more options|more|options|menu/.test(lower)) score += 120;
          if (control.getAttribute('aria-haspopup') === 'menu') score += 90;
          if (/^\s*(\.\.\.|more)\s*$/i.test(label)) score += 60;
          if (/like|reply|comment as|write a comment|share|send|search|messenger/.test(lower)) score -= 120;
          if (rect.width <= 60 && rect.height <= 60) score += 15;
          if (rect.width <= 2 || rect.height <= 2) score -= 30;
          return { control, label, score };
        })
        .filter((item) => item.score > 40)
        .sort((a, b) => b.score - a.score);
      const best = controls[0];
      if (!best) continue;
      best.control.scrollIntoView({ block: 'center', inline: 'center' });
      for (const type of ['mouseover', 'mousemove', 'mousedown', 'mouseup', 'click']) {
        best.control.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return { opened: true, label: best.label.slice(0, 160), score: best.score };
    }
    return { opened: false, reason: 'adaptive_comment_actions_menu_not_found' };
  }, needles).catch((err) => ({ opened: false, reason: err?.message || String(err) }));
  if (adaptive.opened) {
    result.menuOpened = true;
    result.adaptive = adaptive;
    await clickPinMenuItem();
    return result;
  }
  if (!result.reason) result.reason = 'comment actions menu not found';
  if (adaptive?.reason) result.adaptive = adaptive;
  // Diagnostic: capture all buttons/aria-labels near the comment so we can
  // see what selectors FB is actually rendering now.
  try {
    result.menuDiagnostic = await page.evaluate((needles) => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      const articles = [...document.querySelectorAll('[role="article"]')]
        .filter((el) => visible(el) && needles.some((n) => n && (el.innerText || '').includes(n)));
      const article = articles[articles.length - 1];
      if (!article) return { reason: 'article_with_needle_not_found' };
      const controls = [...article.querySelectorAll('[role="button"], button, a[role="link"], [aria-haspopup], [aria-label]')]
        .filter(visible)
        .slice(0, 30)
        .map((el) => ({
          tag: el.tagName,
          role: el.getAttribute('role') || '',
          ariaLabel: (el.getAttribute('aria-label') || '').slice(0, 80),
          ariaHaspopup: el.getAttribute('aria-haspopup') || '',
          text: ((el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()).slice(0, 60),
          hasSvg: el.querySelector('svg') ? true : false,
          dataTestId: el.getAttribute('data-testid') || '',
        }));
      return { articleTextLen: (article.innerText || '').length, controls };
    }, needles).catch((err) => ({ error: String(err?.message || err).slice(0, 240) }));
  } catch (_) { /* best-effort diagnostic only */ }
  return result;
}

function extractCandidatesFromText(text, gid) {
  const urls = new Set();
  const ids = new Set();
  const userIds = new Set();
  if (!text) return { urls: [], ids: [], userIds: [] };
  const urlRe = /https?:\\?\/\\?\/(?:www\.|m\.|mbasic\.)?facebook\.com\\?\/groups\\?\/([0-9]+)\\?\/(?:permalink|posts)\\?\/([0-9]+)/g;
  let m;
  while ((m = urlRe.exec(text))) {
    if (!gid || m[1] === gid) urls.add(`https://www.facebook.com/groups/${m[1]}/permalink/${m[2]}/`);
  }
  const groupUserRe = /https?:\\?\/\\?\/(?:www\.|m\.|mbasic\.)?facebook\.com\\?\/groups\\?\/([0-9]+)\\?\/user\\?\/([0-9]+)/g;
  while ((m = groupUserRe.exec(text))) {
    if (!gid || m[1] === gid) userIds.add(m[2]);
  }
  const multiPermalinkRe = /(?:multi_permalinks(?:%5B%5D|\[\])?|story_fbid|top_level_post_id|post_id|legacy_fbid)[\\"'=:%&;]+([0-9]{8,})/g;
  while (gid && (m = multiPermalinkRe.exec(text))) {
    urls.add(`https://www.facebook.com/groups/${gid}/permalink/${m[1]}/`);
  }
  const keys = [
    /"(?:post_id|story_fbid|top_level_post_id|legacy_fbid|subscription_target_id)"\s*:\s*"?([0-9]{8,})"?/g,
    /(?:post_id|story_fbid|top_level_post_id|legacy_fbid)=([0-9]{8,})/g,
    /"id"\s*:\s*"([0-9]{8,})"/g,
  ];
  for (const re of keys) {
    while ((m = re.exec(text))) ids.add(m[1]);
  }
  return { urls: [...urls], ids: [...ids].slice(0, 80), userIds: [...userIds].slice(0, 30) };
}

function isFacebookGroupPostUrl(url, gid) {
  const value = String(url || '');
  return Boolean(gid && (
    value.includes(`/groups/${gid}/permalink/`) ||
    value.includes(`/groups/${gid}/posts/`)
  ));
}

function facebookGroupPostParts(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''), 'https://www.facebook.com/');
    const match = url.pathname.match(/\/groups\/([0-9]+)\/(?:permalink|posts)\/([0-9]+)/i);
    return match ? { groupId: match[1], postId: match[2] } : null;
  } catch (_) {
    const match = String(rawUrl || '').match(/\/groups\/([0-9]+)\/(?:permalink|posts)\/([0-9]+)/i);
    return match ? { groupId: match[1], postId: match[2] } : null;
  }
}

function sameFacebookGroupPostUrl(left, right) {
  const a = facebookGroupPostParts(left);
  const b = facebookGroupPostParts(right);
  return Boolean(a && b && a.groupId === b.groupId && a.postId === b.postId);
}

async function commentTargetPreflight(page, postUrl, marker) {
  const expected = facebookGroupPostParts(postUrl);
  const snapshot = await page.evaluate(({ marker }) => {
    const text = document.body.innerText || '';
    const title = document.title || '';
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const matches = (value) => {
      if (!marker) return false;
      if (String(value || '').includes(marker)) return true;
      const normalize = (input) => String(input || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      const cleanMarker = normalize(marker);
      return cleanMarker.length >= 12 && normalize(value).includes(cleanMarker);
    };
    const unavailable = /content isn't available|content is not available|post unavailable|this post isn't available|post is pending|pending approval/i.test(text);
    const markerArticles = [...document.querySelectorAll('[role="article"]')]
      .filter((el) => visible(el) && matches(el.innerText || ''));
    const markerRoots = [...document.querySelectorAll('[role="article"], div')]
      .filter((el) => visible(el) && matches(el.innerText || ''));
    const exactPermalinkCommentBoxes = [...document.querySelectorAll('[contenteditable="true"], [role="textbox"], textarea, [aria-label*="Comment as" i], [aria-label*="Write a comment" i], [aria-label*="commenter" i]')]
      .filter((el) => {
        if (!visible(el)) return false;
        const label = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (/what.*mind|write something|create post|search facebook/.test(label)) return false;
        return /comment as|write a comment|commenter|\bcomment\b/.test(label);
      });
    return {
      url: location.href,
      title,
      markerVisible: matches(text),
      titleHasMarker: matches(title),
      visibleMarkerArticleCount: markerArticles.length,
      markerRootCount: markerRoots.length,
      exactPermalinkCommentBoxCount: exactPermalinkCommentBoxes.length,
      unavailable,
      snippet: text.split('\n').filter((line) => line.includes(marker) || /content isn't available|pending|approval|comment/i.test(line)).slice(0, 12),
    };
  }, { marker }).catch((err) => ({
    url: page.url(),
    title: '',
    markerVisible: false,
    titleHasMarker: false,
    visibleMarkerArticleCount: 0,
    markerRootCount: 0,
    exactPermalinkCommentBoxCount: 0,
    unavailable: false,
    error: err?.message || String(err),
    snippet: [],
  }));
  const current = facebookGroupPostParts(snapshot.url);
  const urlMatches = expected ? Boolean(current && expected.groupId === current.groupId && expected.postId === current.postId) : true;
  const visibleMarkerArticle = Number(snapshot.visibleMarkerArticleCount || 0) > 0;
  const exactPermalinkMarkerVisible = Boolean(
    expected &&
    urlMatches &&
    (
      visibleMarkerArticle ||
      (
        snapshot.markerVisible &&
        Number(snapshot.markerRootCount || 0) > 0 &&
        Number(snapshot.exactPermalinkCommentBoxCount || 0) > 0
      )
    )
  );
  const exactPermalinkFallbackVisible = Boolean(
    exactPermalinkMarkerVisible &&
    Number(snapshot.exactPermalinkCommentBoxCount || 0) > 0
  );
  const onExpectedPermalinkWithMarker = Boolean(
    expected &&
    urlMatches &&
    snapshot.markerVisible &&
    Number(snapshot.markerRootCount || 0) > 0 &&
    !snapshot.unavailable
  );
  const ok = Boolean(urlMatches && (visibleMarkerArticle || exactPermalinkFallbackVisible || exactPermalinkMarkerVisible || onExpectedPermalinkWithMarker) && !snapshot.unavailable);
  return {
    ok,
    expected,
    current,
    urlMatches,
    ...snapshot,
    reason: ok
      ? ''
      : !urlMatches
        ? 'comment_target_permalink_mismatch'
        : snapshot.unavailable
          ? 'comment_target_unavailable_or_pending'
          : 'target_marker_article_not_visible_before_comment',
  };
}

async function extractDomUrls(page, gid, marker) {
  return await page.evaluate(({gid, marker}) => {
    const groupPostUrlFromHref = (href) => {
      try {
        const url = new URL(href, location.href);
        const path = url.pathname;
        let match = path.match(new RegExp(`/groups/${gid}/(?:permalink|posts)/(\\d+)`));
        if (match) return `https://www.facebook.com/groups/${gid}/permalink/${match[1]}/`;
        for (const key of ['multi_permalinks', 'multi_permalinks[]', 'story_fbid', 'post_id']) {
          const value = url.searchParams.get(key);
          if (/^\d{8,}$/.test(value || '')) return `https://www.facebook.com/groups/${gid}/permalink/${value}/`;
        }
      } catch (_) {}
      return '';
    };
    const urls = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.href || '';
      const text = (a.innerText || '').replace(/\s+/g, ' ').trim();
      const postUrl = groupPostUrlFromHref(href);
      if (postUrl) urls.add(postUrl);
      if (marker && text.includes(marker) && postUrl) urls.add(postUrl);
    }
    return [...urls];
  }, {gid, marker});
}

async function extractMarkerScopedPostUrls(page, gid, marker) {
  return await page.evaluate(({gid, marker}) => {
    const urls = new Set();
    const groupPostUrlFromHref = (href) => {
      try {
        const url = new URL(href, location.href);
        const path = url.pathname;
        let match = path.match(new RegExp(`/groups/${gid}/(?:permalink|posts)/(\\d+)`));
        if (match) return `https://www.facebook.com/groups/${gid}/permalink/${match[1]}/`;
        for (const key of ['multi_permalinks', 'multi_permalinks[]', 'story_fbid', 'post_id']) {
          const value = url.searchParams.get(key);
          if (/^\d{8,}$/.test(value || '')) return `https://www.facebook.com/groups/${gid}/permalink/${value}/`;
        }
      } catch (_) {}
      return '';
    };
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const markerNodes = [...document.querySelectorAll('[role="article"], div, span')]
      .filter(el => visible(el) && marker && (el.innerText || '').includes(marker));
    const roots = [];
    for (const node of markerNodes.slice(-12)) {
      let current = node;
      for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
        if (!visible(current)) continue;
        if (current.matches?.('[role="article"], [role="dialog"], div')) roots.push(current);
      }
    }
    const preferred = [
      ...roots.filter(el => el.matches?.('[role="article"]')),
      ...roots,
    ].slice(-8);
    for (const root of preferred.reverse()) {
      for (const a of root.querySelectorAll('a[href]')) {
        const postUrl = groupPostUrlFromHref(a.href || '');
        if (postUrl) urls.add(postUrl);
      }
    }
    return [...urls];
  }, {gid, marker}).catch(() => []);
}

function facebookGroupUserPageUrl(gid, userId) {
  const cleanGid = String(gid || '').replace(/\D+/g, '');
  const cleanUserId = String(userId || '').replace(/\D+/g, '');
  return cleanGid && cleanUserId ? `https://www.facebook.com/groups/${cleanGid}/user/${cleanUserId}/` : '';
}

function mergeGroupUserCandidates(...lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const item of list || []) {
      const userId = String(item?.userId || '').replace(/\D+/g, '');
      if (!userId) continue;
      const existing = byId.get(userId);
      if (!existing || Number(item.score || 0) > Number(existing.score || 0)) {
        byId.set(userId, {
          userId,
          url: item.url || facebookGroupUserPageUrl(item.groupId || '', userId),
          label: String(item.label || '').slice(0, 160),
          score: Number(item.score || 0),
          source: String(item.source || 'unknown').slice(0, 80),
        });
      }
    }
  }
  return [...byId.values()].sort((a, b) => b.score - a.score);
}

async function extractComposerActorIdentity(page) {
  return await page.evaluate(() => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const dialogs = [...document.querySelectorAll('div[role="dialog"]')].filter(visible);
    const root = dialogs[dialogs.length - 1] || document.body;
    const snippet = (root.innerText || root.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    const match = snippet.match(/(?:create post|create a post)\s+(.+?)\s+(?:public group|public|friends|only me|add groups|edit|add to your post|post\b)/i);
    const label = match ? match[1].replace(/\b(profile|page)\b/ig, '').replace(/\s+/g, ' ').trim() : '';
    return {
      label: label && !/^(create post|public group|add groups|post)$/i.test(label) ? label.slice(0, 160) : '',
      snippet,
    };
  }).catch(() => ({ label: '', snippet: '' }));
}

function boostGroupUserCandidatesByPublisherActor(candidates, actor = {}) {
  const actorLabel = String(actor?.label || '').replace(/'s profile\b/i, '').trim();
  const cleanActor = normalizeTextLoose(actorLabel);
  if (!cleanActor || cleanActor.length < 3) return candidates || [];
  return (candidates || [])
    .map((item) => {
      const cleanLabel = normalizeTextLoose(String(item?.label || '').replace(/'s profile\b/i, ''));
      const actorMatch = cleanLabel && (cleanLabel.includes(cleanActor) || cleanActor.includes(cleanLabel));
      return actorMatch
        ? { ...item, score: Number(item.score || 0) + 20000, source: `${item.source || 'unknown'}+composer_actor_match` }
        : item;
    })
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
}

async function extractVisibleGroupUserCandidates(page, gid, marker, source = 'page') {
  return await page.evaluate(({ gid, marker, source }) => {
    const normalize = (input) => String(input || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const matches = (value) => {
      if (!marker) return false;
      if (String(value || '').includes(marker)) return true;
      const cleanMarker = normalize(marker);
      return cleanMarker.length >= 12 && normalize(value).includes(cleanMarker);
    };
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const labelOf = (el) => (el.getAttribute('aria-label') || el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    const rows = [];
    for (const a of document.querySelectorAll('a[href]')) {
      let parsed;
      try { parsed = new URL(a.href || '', location.href); } catch (_) { continue; }
      const match = parsed.pathname.match(new RegExp(`/groups/${gid}/user/(\\d+)`, 'i'));
      if (!match) continue;
      const userId = match[1];
      const label = labelOf(a);
      const isVisible = visible(a);
      const dialog = a.closest('[role="dialog"]');
      const article = a.closest('[role="article"]');
      let markerDepth = 0;
      let current = a;
      for (let depth = 1; current && depth <= 8; depth += 1, current = current.parentElement) {
        if (matches(current.innerText || current.textContent || '')) {
          markerDepth = depth;
          break;
        }
      }
      let score = 0;
      if (isVisible) score += 30;
      else score -= 80;
      if (dialog) score += 250;
      if (article && matches(article.innerText || '')) score += 900;
      if (markerDepth) score += Math.max(200, 900 - markerDepth * 50);
      if (label && !/facebook|group|photo|cover/i.test(label)) score += 30;
      rows.push({
        userId,
        url: `https://www.facebook.com/groups/${gid}/user/${userId}/`,
        label: label.slice(0, 160),
        score,
        source,
      });
    }
    const best = new Map();
    for (const row of rows) {
      const existing = best.get(row.userId);
      if (!existing || row.score > existing.score) best.set(row.userId, row);
    }
    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, 12);
  }, { gid, marker, source }).catch(() => []);
}

async function extractComposerGroupUserCandidates(page, gid, source = 'composer_actor') {
  return await page.evaluate(({ gid, source }) => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const labelOf = (el) => (el.getAttribute('aria-label') || el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    const dialogs = [...document.querySelectorAll('div[role="dialog"]')].filter(visible);
    const root = dialogs[dialogs.length - 1] || null;
    if (!root) return [];
    const rows = [];
    for (const a of root.querySelectorAll('a[href]')) {
      let parsed;
      try { parsed = new URL(a.href || '', location.href); } catch (_) { continue; }
      const match = parsed.pathname.match(new RegExp(`/groups/${gid}/user/(\\d+)`, 'i'));
      if (!match) continue;
      rows.push({
        userId: match[1],
        url: `https://www.facebook.com/groups/${gid}/user/${match[1]}/`,
        label: labelOf(a).slice(0, 160),
        score: 50000 + (visible(a) ? 100 : 0),
        source,
      });
    }
    const best = new Map();
    for (const row of rows) {
      const existing = best.get(row.userId);
      if (!existing || row.score > existing.score) best.set(row.userId, row);
    }
    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, 4);
  }, { gid, source }).catch(() => []);
}

async function discoverPostUrlsFromGroupUserPages(page, payload, gid, marker, groupUserCandidates = [], options = {}) {
  const startedAt = Date.now();
  const budgetMs = clampInt(options.budgetMs || 90000, 15000, 180000);
  const deadline = startedAt + budgetMs;
  const maxCandidates = clampInt(options.maxCandidates || 3, 1, 6);
  const maxAttempts = clampInt(options.maxAttempts || 2, 1, 3);
  const explicitIds = [
    payload.facebookUserId,
    payload.facebook_user_id,
    payload.publisherFacebookUserId,
    payload.publisher_facebook_user_id,
  ].map((value) => String(value || '').replace(/\D+/g, '')).filter(Boolean);
  const reliableGroupUserCandidates = (groupUserCandidates || []).filter((item) => {
    const source = String(item?.source || '');
    if (/payload|composer|image_attached|post_submit_refresh_page|composer_actor_match/i.test(source)) return true;
    return Number(item?.score || 0) >= 1000;
  });
  const candidates = mergeGroupUserCandidates(
    explicitIds.map((userId) => ({
      userId,
      url: facebookGroupUserPageUrl(gid, userId),
      score: 10000,
      source: 'payload_facebook_user_id',
    })),
    reliableGroupUserCandidates,
  ).filter((item) => item.url);
  const selected = explicitIds.length
    ? candidates.filter((item) => explicitIds.includes(String(item.userId || '').replace(/\D+/g, '')))
    : candidates.slice(0, maxCandidates);
  if (explicitIds.length && !selected.length && candidates.length) {
    selected.push(candidates[0]);
  }
  const visited = [];
  const found = [];
  const addFound = (url, userId, source, priority) => {
    const clean = String(url || '').split('?')[0];
    if (!isFacebookGroupPostUrl(clean, gid)) return;
    if (found.some((item) => item.url === clean)) return;
    found.push({ url: clean, userId, source, priority });
  };
  for (const candidate of selected) {
    if (Date.now() >= deadline) break;
    const userUrl = facebookGroupUserPageUrl(gid, candidate.userId) || candidate.url;
    if (!userUrl) continue;
    const visit = {
      userId: candidate.userId,
      userUrl,
      source: candidate.source,
      score: candidate.score,
      attempts: [],
    };
    visited.push(visit);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (Date.now() >= deadline) break;
      if (attempt === 1) {
        await page.goto(userUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((err) => {
          visit.attempts.push({ attempt, error: err?.message || String(err) });
        });
      } else {
        await page.mouse.wheel(0, 1800).catch(() => {});
      }
      await humanPause(1600 + attempt * 400, 2800 + attempt * 600);
      await ensureFacebookLoggedIn(page, {
        ...payload,
        manualLoginTimeoutMs: Math.min(Number(payload.manualLoginTimeoutMs || payload.manual_login_timeout_ms || 300000), 15000),
      }, 'group_user_post_search');
      const markerScoped = await extractMarkerScopedPostUrls(page, gid, marker).catch(() => []);
      const domUrls = await extractDomUrls(page, gid, marker).catch(() => []);
      const pageState = await page.evaluate((marker) => {
        const text = document.body.innerText || '';
        const visible = (el) => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const markerArticles = [...document.querySelectorAll('[role="article"]')]
          .filter((el) => visible(el) && marker && (el.innerText || '').includes(marker));
        return {
          url: location.href,
          title: document.title || '',
          markerVisible: marker ? text.includes(marker) : false,
          visibleMarkerArticleCount: markerArticles.length,
          snippet: text.split('\n').filter((line) => marker && line.includes(marker)).slice(0, 6),
        };
      }, marker).catch((err) => ({ error: err?.message || String(err) }));
      markerScoped.forEach((url) => addFound(url, candidate.userId, 'group_user_marker_scoped', 5));
      if (pageState.visibleMarkerArticleCount > 0) {
        domUrls.forEach((url) => addFound(url, candidate.userId, 'group_user_dom_marker_visible', 15));
      }
      visit.attempts.push({
        attempt,
        url: pageState.url || page.url(),
        title: pageState.title || '',
        markerVisible: Boolean(pageState.markerVisible),
        visibleMarkerArticleCount: Number(pageState.visibleMarkerArticleCount || 0),
        markerScopedUrls: markerScoped.slice(0, 8),
        domUrls: domUrls.slice(0, 8),
        foundCount: found.length,
      });
      if (found.length) break;
    }
    if (found.length) break;
  }
  return {
    candidates: candidates.slice(0, 10),
    selected,
    visited,
    found,
    urls: found.map((item) => item.url),
    elapsedMs: Date.now() - startedAt,
    timedOut: Date.now() >= deadline && !found.length,
  };
}

async function verifyCandidate(context, url, marker) {
  const p = await context.newPage();
  try {
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await p.waitForTimeout(2500);
    const expected = facebookGroupPostParts(url);
    const data = await p.evaluate(({ marker, expected }) => {
      const matches = (value) => {
        if (!marker) return false;
        if (String(value || '').includes(marker)) return true;
        const normalize = (input) => String(input || '')
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[^\p{L}\p{N}]+/gu, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
        const cleanMarker = normalize(marker);
        return cleanMarker.length >= 12 && normalize(value).includes(cleanMarker);
      };
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const mediaIn = (root) => {
        const media = [];
        for (const img of root.querySelectorAll('img')) {
          const src = img.currentSrc || img.src || '';
          const alt = img.alt || '';
          const aria = img.getAttribute('aria-label') || '';
          const width = img.naturalWidth || img.width || 0;
          const height = img.naturalHeight || img.height || 0;
          const combined = `${src} ${alt} ${aria}`;
          if (width >= 100 && height >= 100 && !/emoji|avatar|profile|static\.xx|rsrc\.php/i.test(combined)) {
            const srcIds = (src.match(/\d{8,20}/g) || []).slice(0, 8);
            media.push({ kind: 'img', width, height, src: src.slice(0, 200), alt: alt.slice(0, 80), srcIds });
          }
        }
        for (const el of root.querySelectorAll('[style]')) {
          const bg = getComputedStyle(el).backgroundImage || '';
          const rect = el.getBoundingClientRect();
          if (rect.width >= 100 && rect.height >= 100 && /blob:|scontent|fbcdn|lookaside/i.test(bg) && !/static\.xx|rsrc\.php/i.test(bg)) {
            media.push({ kind: 'background', width: Math.round(rect.width), height: Math.round(rect.height) });
          }
        }
        return media;
      };
      const bodyText = document.body.innerText || '';
      const title = document.title || '';
      const expectedPostId = expected?.postId || '';
      const rootCandidates = [
        ...document.querySelectorAll('[role="article"], [data-pagelet*="FeedUnit"], [data-pagelet*="Group"]')
      ].filter(visible);
      const scoredRoots = rootCandidates.map((el) => {
        const text = el.innerText || '';
        const hrefs = [...el.querySelectorAll('a[href]')].map(a => a.href || '').join(' ');
        let score = 0;
        if (matches(text)) score += 100;
        if (expectedPostId && hrefs.includes(expectedPostId)) score += 40;
        if (el.matches?.('[role="article"]')) score += 20;
        const rect = el.getBoundingClientRect();
        score -= Math.max(0, rect.top) / 1000;
        return { el, text, score };
      }).sort((a, b) => b.score - a.score);
      const postRoot = scoredRoots[0]?.el || document.body;
      const postRootText = postRoot.innerText || '';
      const postMedia = mediaIn(postRoot);
      const exactPermalink = Boolean(
        expectedPostId &&
        (location.pathname.includes(`/permalink/${expectedPostId}`) || location.pathname.includes(`/posts/${expectedPostId}`))
      );
      return {
        url: location.href,
        title,
        hasMarker: matches(postRootText),
        bodyHasMarker: matches(bodyText),
        titleHasMarker: matches(title),
        exactPermalink,
        hasOwnControls: /Edit post|Delete post/.test(bodyText),
        hasPostMedia: postMedia.length > 0,
        postMedia: postMedia.slice(0, 4),
        snippet: postRootText.split('\n').filter(l => l.includes(marker) || l.includes('mavlynk')).slice(0, 20)
      };
    }, { marker, expected });
    return data;
  } finally {
    await p.close().catch(() => {});
  }
}

function summarizeCandidateVerification(result, fallbackUrl = '') {
  return {
    url: result?.url || fallbackUrl,
    title: result?.title || '',
    hasMarker: Boolean(result?.hasMarker),
    bodyHasMarker: Boolean(result?.bodyHasMarker),
    titleHasMarker: Boolean(result?.titleHasMarker),
    exactPermalink: Boolean(result?.exactPermalink),
    hasOwnControls: Boolean(result?.hasOwnControls),
    hasPostMedia: Boolean(result?.hasPostMedia),
    postMediaCount: Array.isArray(result?.postMedia) ? result.postMedia.length : 0,
    snippet: Array.isArray(result?.snippet) ? result.snippet.slice(0, 8) : [],
    error: result?.error || '',
  };
}

function candidateVerificationScore(result, imageRequired = false) {
  if (!result || result.error) return 0;
  let score = 0;
  if (result.hasMarker) score += 100;
  if (result.bodyHasMarker) score += 50;
  if (result.titleHasMarker) score += 70;
  if (result.exactPermalink) score += 30;
  if (result.hasPostMedia) score += 25;
  if (!imageRequired || result.hasPostMedia) score += 10;
  return score;
}

function candidateHasTrustedMarker(result = {}) {
  return Boolean(result.hasMarker || result.bodyHasMarker || (result.titleHasMarker && result.exactPermalink));
}

function candidateHasStrongPermalinkMarker(result = {}) {
  return Boolean(result?.exactPermalink && (result.hasMarker || result.bodyHasMarker));
}

async function verifyCandidateWithRetry(context, url, marker, options = {}) {
  const attempts = clampInt(options.attempts || 4, 1, 6);
  const imageRequired = Boolean(options.imageRequired);
  const requireStrongMarker = Boolean(options.requireStrongMarker);
  const diagnostics = [];
  let best = null;
  let trustedPermalinkAttempt = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await verifyCandidate(context, url, marker).catch(e => ({ url, error: e.message || String(e) }));
    const withAttempt = { ...result, attempt };
    diagnostics.push({ attempt, ...summarizeCandidateVerification(result, url) });
    if (candidateVerificationScore(withAttempt, imageRequired) > candidateVerificationScore(best, imageRequired)) best = withAttempt;
    const markerAccepted = requireStrongMarker ? candidateHasStrongPermalinkMarker(result) : candidateHasTrustedMarker(result);
    if (markerAccepted && result.exactPermalink) {
      trustedPermalinkAttempt = trustedPermalinkAttempt || attempt;
    }
    if (markerAccepted && (!imageRequired || result.hasPostMedia || (trustedPermalinkAttempt && attempt >= Math.min(attempts, trustedPermalinkAttempt + 1)))) {
      return { ...withAttempt, verificationAttempts: diagnostics };
    }
    if (attempt < attempts) {
      await humanPause(3500 + attempt * 1800, 5600 + attempt * 2600);
    }
  }
  return { ...(best || { url }), verificationAttempts: diagnostics };
}

async function bodyMarkerChecks(page, marker) {
  return await page.evaluate(({ marker }) => {
    const text = document.body.innerText || '';
    const media = [];
    const markerRoots = [...document.querySelectorAll('[role="article"], div')]
      .filter(el => marker && (el.innerText || '').includes(marker));
    const root = markerRoots.find(el => el.matches?.('[role="article"]')) || markerRoots[0] || document.body;
    for (const img of root.querySelectorAll('img')) {
      const src = img.currentSrc || img.src || '';
      const alt = img.alt || '';
      const aria = img.getAttribute('aria-label') || '';
      const width = img.naturalWidth || img.width || 0;
      const height = img.naturalHeight || img.height || 0;
      const combined = `${src} ${alt} ${aria}`;
      if (width >= 100 && height >= 100 && !/emoji|avatar|profile|static\.xx|rsrc\.php/i.test(combined)) {
        media.push({ kind: 'img', width, height, src: src.slice(0, 140), alt: alt.slice(0, 80) });
      }
    }
    for (const el of root.querySelectorAll('[style]')) {
      const bg = getComputedStyle(el).backgroundImage || '';
      const rect = el.getBoundingClientRect();
      if (rect.width >= 100 && rect.height >= 100 && /blob:|scontent|fbcdn|lookaside/i.test(bg) && !/static\.xx|rsrc\.php/i.test(bg)) {
        media.push({ kind: 'background', width: Math.round(rect.width), height: Math.round(rect.height) });
      }
    }
    const normalize = (input) => String(input || '')
      .normalize('NFD')
      .replace(/[̀-ͯ︀-️]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const matchesLoose = (value) => {
      if (!marker) return false;
      const sv = String(value || '');
      if (sv.includes(marker)) return true;
      const cleanMarker = normalize(marker);
      return cleanMarker.length >= 12 && normalize(sv).includes(cleanMarker);
    };
    return {
      markerVisible: matchesLoose(text),
      ownControls: /Edit post|Delete post|Approve|Decline|Reject/.test(text),
      postMediaVerified: media.length > 0,
      postMedia: media.slice(0, 4),
      snippet: text.split('\n').filter(line => matchesLoose(line) || /approve|pending|admin/i.test(line)).slice(0, 20),
    };
  }, { marker }).catch((err) => ({
    markerVisible: false,
    ownControls: false,
    postMediaVerified: false,
    postMedia: [],
    snippet: [],
    error: err?.message || String(err),
  }));
}

async function captureApprovalDiagnostic(page, marker) {
  // When admin approval fails, dump enough info to diagnose: URL, title, count
  // of pending articles, sample article texts, every button label+aria, every
  // link href. Lets us tell apart "post not in queue" vs "Approve button moved".
  try {
    return await page.evaluate((m) => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      const articles = [...document.querySelectorAll('[role="article"]')].filter(visible);
      const articleSamples = articles.slice(0, 6).map((a, i) => ({
        idx: i,
        textStart: (a.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200),
        textLen: (a.innerText || '').length,
        containsMarker: m ? (a.innerText || '').includes(m) : null,
        buttonCount: a.querySelectorAll('button, [role="button"]').length,
      }));
      const bodyContainsMarker = m ? (document.body.innerText || '').includes(m) : null;
      const allButtons = [...document.querySelectorAll('button, [role="button"], a[role="button"]')]
        .filter(visible)
        .slice(0, 40)
        .map((b) => ({
          tag: b.tagName,
          role: b.getAttribute('role') || '',
          ariaLabel: (b.getAttribute('aria-label') || '').slice(0, 80),
          text: ((b.innerText || b.textContent || '').replace(/\s+/g, ' ').trim()).slice(0, 60),
          dataTestId: b.getAttribute('data-testid') || '',
        }))
        .filter((b) => b.ariaLabel || b.text);
      return {
        url: location.href,
        title: document.title,
        articleCount: articles.length,
        bodyContainsMarker,
        articleSamples,
        buttons: allButtons,
      };
    }, marker).catch((err) => ({ error: String(err?.message || err).slice(0, 240) }));
  } catch (err) {
    return { error: String(err?.message || err).slice(0, 240) };
  }
}

async function clickApproveForVisibleMarker(page, marker, publisherUserId = '', groupId = '') {
  const result = {
    clicked: false,
    confirmed: false,
    label: '',
    method: '',
    reason: '',
  };
  const markerVisible = await page.evaluate((marker) => {
    const text = document.body.innerText || '';
    if (!marker) return false;
    if (text.includes(marker)) return true;
    const normalize = (input) => String(input || '')
      .normalize('NFD')
      .replace(/[̀-ͯ︀-️]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const cleanMarker = normalize(marker);
    return cleanMarker.length >= 12 && normalize(text).includes(cleanMarker);
  }, marker).catch(() => false);
  const cleanPublisherId = String(publisherUserId || '').replace(/\D+/g, '');
  if (!markerVisible && !cleanPublisherId) {
    result.reason = 'marker_not_visible_before_approval';
    result.diagnostic = await captureApprovalDiagnostic(page, marker);
    console.log(JSON.stringify({ step: 'admin_approval_diagnostic', reason: result.reason, diagnostic: result.diagnostic }));
    return result;
  }
  if (!markerVisible && cleanPublisherId) {
    const authorMatchResult = await page.evaluate(({ publisherId, gid }) => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 50 && r.height > 50 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      const approveRegex = /^(approve|approve post|approve all|approuver|autoriser)$/i;
      const articles = [...document.querySelectorAll('[role="article"]')].filter(visible);
      for (const a of articles) {
        const authorLinks = [...a.querySelectorAll('a[href]')].filter(link => {
          const href = String(link.href || '');
          return href.includes(`/groups/${gid}/user/${publisherId}/`) || href.includes(`profile.php?id=${publisherId}`) || (href.includes(`/user/${publisherId}/`) && href.includes(`/groups/${gid}/`));
        });
        if (!authorLinks.length) continue;
        const btns = [...a.querySelectorAll('button, [role="button"], a[role="button"]')];
        const approveBtn = btns.find(b => {
          const label = (b.innerText || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
          return approveRegex.test(label);
        });
        if (approveBtn) {
          approveBtn.scrollIntoView({ block: 'center' });
          approveBtn.click();
          return { clicked: true, label: (approveBtn.innerText || approveBtn.getAttribute('aria-label') || 'Approve').slice(0, 80) };
        }
      }
      return { clicked: false, reason: 'no_pending_article_matched_publisher_or_no_approve_button', articleCount: articles.length };
    }, { publisherId: cleanPublisherId, gid: groupId }).catch((err) => ({ clicked: false, reason: err?.message || String(err) }));
    if (authorMatchResult.clicked) {
      result.clicked = true;
      result.method = 'author_matched_publisher_user_id';
      result.label = authorMatchResult.label || 'Approve';
      await humanPause(1000, 2200);
      const confirmName = /^(approve|approve post|approve all|approuver|autoriser)$/i;
      const confirmText = /\b(approve|approve post|approuver|autoriser)\b/i;
      const confirm = await clickFirst(page, [
        page.locator('div[role="dialog"]').getByRole('button', { name: confirmName }),
        page.locator('div[role="dialog"] button, div[role="dialog"] [role="button"]').filter({ hasText: confirmText }),
        page.getByRole('button', { name: /^(confirm|done|ok|yes)$/i }),
      ], { timeout: 2500 });
      result.confirmed = Boolean(confirm);
      await humanPause(4500, 8000);
      return result;
    }
    result.reason = authorMatchResult.reason || 'author_match_failed_and_marker_not_visible';
    result.diagnostic = await captureApprovalDiagnostic(page, marker);
    console.log(JSON.stringify({ step: 'admin_approval_diagnostic', reason: result.reason, authorMatchInfo: authorMatchResult, diagnostic: result.diagnostic }));
    return result;
  }
  const approveName = /^(approve|approve post|approve all|approuver|autoriser)$/i;
  const approveText = /\b(approve|approve post|approuver|autoriser)\b/i;
  const roots = [
    page.locator('[role="article"]').filter({ hasText: marker }),
    page.locator('[data-pagelet]').filter({ hasText: marker }),
    page.locator('div').filter({ hasText: marker }),
  ];
  for (const root of roots) {
    const count = await root.count().catch(() => 0);
    for (let i = Math.min(count, 8) - 1; i >= 0; i -= 1) {
      const scoped = root.nth(i);
      if (!(await scoped.isVisible({ timeout: 700 }).catch(() => false))) continue;
      await scoped.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      const clicked = await clickFirst(page, [
        scoped.getByRole('button', { name: approveName }),
        scoped.locator('button, [role="button"]').filter({ hasText: approveText }),
        scoped.locator('[aria-label*="Approve" i], [aria-label*="Approuver" i]'),
      ], { timeout: 4000 });
      if (!clicked) continue;
      result.clicked = true;
      result.method = 'marker_scoped_approve_button';
      result.label = await clicked.evaluate(el => (el.getAttribute('aria-label') || el.innerText || el.textContent || '').replace(/\s+/g, ' ').slice(0, 120)).catch(() => 'Approve');
      await humanPause(1000, 2200);
      const confirm = await clickFirst(page, [
        page.locator('div[role="dialog"]').getByRole('button', { name: approveName }),
        page.locator('div[role="dialog"] button, div[role="dialog"] [role="button"]').filter({ hasText: approveText }),
        page.getByRole('button', { name: /^(confirm|done|ok|yes)$/i }),
      ], { timeout: 2500 });
      result.confirmed = Boolean(confirm);
      await humanPause(4500, 8000);
      return result;
    }
  }
  result.reason = 'approve_button_not_found_for_marker';
  result.diagnostic = await captureApprovalDiagnostic(page, marker);
  console.log(JSON.stringify({ step: 'admin_approval_diagnostic', reason: result.reason, diagnostic: result.diagnostic }));
  return result;
}

async function openGroupReviewSurface(page, groupUrl, marker, publisherUserId = '', groupId = '') {
  const rawBase = String(groupUrl || '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  const numericGid = String(groupId || '').replace(/\D+/g, '');
  // Admin surfaces only resolve with the NUMERIC group id; a vanity slug
  // (/groups/o1498765.../pending_posts/) redirects to the group FEED, so the moderator never sees
  // the pending queue and posts stay pending. Prefer the numeric-id base whenever we have it.
  const base = numericGid ? `https://www.facebook.com/groups/${numericGid}` : rawBase;
  const targets = [
    `${base}/pending_posts/`,
    `${base}/pending_posts`,
    `${base}/manage_post_queue`,
    `${base}/posts/pending`,
    base,
  ];
  const visited = [];
  const MAX_SCROLLS_PER_TARGET = 12;
  const cleanPublisherId = String(publisherUserId || '').replace(/\D+/g, '');
  const markerCheck = async () => page.evaluate(({ marker, publisherId, gid }) => {
    try {
      const bodyText = document.body.innerText || '';
      if (marker && bodyText.includes(marker)) return true;
      if (publisherId && gid) {
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 50 && r.height > 50 && s.visibility !== 'hidden' && s.display !== 'none';
        };
        const articles = [...document.querySelectorAll('[role="article"]')].filter(visible);
        for (const a of articles) {
          const authorLinks = [...a.querySelectorAll('a[href]')].filter(link => {
            const href = String(link.href || '');
            return href.includes(`/groups/${gid}/user/${publisherId}/`) || href.includes(`profile.php?id=${publisherId}`);
          });
          if (authorLinks.length) return true;
        }
      }
      return false;
    } catch { return false; }
  }, { marker, publisherId: cleanPublisherId, gid: groupId }).catch(() => false);
  for (const target of targets) {
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    visited.push(page.url());
    await humanPause(3500, 5000);
    if (await markerCheck()) return { opened: true, url: page.url(), visited, method: 'direct_review_url_first_screen', scrollsRequired: 0 };
    const clicked = await clickFirst(page, [
      page.getByRole('link', { name: /manage content|pending admin approval|pending posts|post approval/i }),
      page.getByRole('button', { name: /manage content|pending admin approval|pending posts|post approval/i }),
      page.locator('a, [role="link"], [role="button"]').filter({ hasText: /manage content|pending admin approval|pending posts|post approval/i }),
    ], { timeout: 2500 });
    if (clicked) {
      await humanPause(3000, 5000);
      visited.push(page.url());
      if (await markerCheck()) return { opened: true, url: page.url(), visited, method: 'clicked_manage_content_first_screen', scrollsRequired: 0 };
    }
    let lastHeight = await page.evaluate(() => document.body.scrollHeight).catch(() => 0);
    let stagnantScrolls = 0;
    for (let scroll = 1; scroll <= MAX_SCROLLS_PER_TARGET; scroll += 1) {
      await page.mouse.wheel(0, 1800).catch(() => {});
      await humanPause(1800, 2800);
      if (await markerCheck()) return { opened: true, url: page.url(), visited, method: 'direct_review_url_after_scroll', scrollsRequired: scroll };
      const newHeight = await page.evaluate(() => document.body.scrollHeight).catch(() => 0);
      if (newHeight <= lastHeight + 20) {
        stagnantScrolls += 1;
        if (stagnantScrolls >= 2) break;
      } else {
        stagnantScrolls = 0;
        lastHeight = newHeight;
      }
    }
  }
  // PERMISSION SIGNAL: if NONE of the visited urls kept an admin-queue path, every
  // /pending_posts|/manage_post_queue request 302-redirected to the group FEED — which Facebook
  // only does when this account is NOT an admin/moderator of the group. Surface that distinctly so
  // the server can (a) NOT misread it as "post is not pending" and (b) try the next moderator.
  const reachedAdminSurface = visited.some((u) => /\/(pending_posts|manage_post_queue|posts\/pending)/i.test(String(u || '')));
  return {
    opened: false,
    url: page.url(),
    visited,
    // null = INCONCLUSIVE: without a numeric gid we cannot build a valid admin URL, so a feed
    // landing is NOT proof the approver lacks rights — never let a flaky gid-resolve MASK a real
    // moderator grant by reporting false here.
    adminSurfaceReachable: numericGid ? reachedAdminSurface : null,
    method: !numericGid
      ? 'admin_surface_inconclusive_no_numeric_gid'
      : (reachedAdminSurface ? 'marker_not_found_after_full_scroll' : 'pending_queue_redirected_to_feed_no_admin_surface'),
  };
}

async function approvePendingPost(page, context, payload, gid, marker) {
  const postUrl = payload.postUrl;
  const groupUrl = payload.groupUrl || `https://www.facebook.com/groups/${gid}`;
  const attempts = [];
  const verified = [];
  let approvalResult = { clicked: false, confirmed: false, reason: 'not_attempted' };
  const collectVerifiedUrls = async (source) => {
    const markerScopedUrls = await extractMarkerScopedPostUrls(page, gid, marker).catch(() => []);
    const domUrls = await extractDomUrls(page, gid, marker).catch(() => []);
    const candidateUrls = [...new Set([...markerScopedUrls, ...domUrls])].filter(url => isFacebookGroupPostUrl(url, gid));
    for (const u of candidateUrls.slice(0, 25)) {
      if (verified.some(item => item.candidate === u || item.url === u)) continue;
          const candidate = await verifyCandidate(context, u, marker).catch(e => ({ url: u, error: e.message }));
          if (candidateHasStrongPermalinkMarker(candidate)) verified.push({ candidate: u, source, ...candidate });
          if (candidateHasStrongPermalinkMarker(candidate) && candidate.hasPostMedia) break;
    }
    return { source, markerScopedUrls, domUrls, candidateUrls };
  };
  if (postUrl) {
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => attempts.push({ target: postUrl, warning: e.message }));
    await humanPause(2000, 3500);
    attempts.push({ target: postUrl, url: page.url(), title: await page.title().catch(() => '') });
    approvalResult = await clickApproveForVisibleMarker(page, marker, payload.publisherFacebookUserId || payload.facebookUserId, gid);
    const directChecks = await bodyMarkerChecks(page, marker);
    if (!approvalResult.clicked && directChecks.markerVisible && directChecks.postMediaVerified) {
      console.log(JSON.stringify({
        step: 'approval_attempted',
        mode: 'approve_only',
        postUrl,
        groupUrl,
        marker,
        ...approvalResult,
        reason: approvalResult.reason || 'post_visible_no_approval_button_needed',
        attempts,
        bodyChecks: directChecks,
      }, null, 2));
      console.log(JSON.stringify({
        step: 'result',
        mode: 'approve_only',
        marker,
        postUrl,
        postPageUrl: postUrl,
        bodyChecks: {
          markerVisible: true,
          ownControls: directChecks.ownControls,
        },
        imageVerified: true,
        postMediaVerified: true,
        commentResult: { skipped: true, clicked: false, typed: false, submitted: false, verified: false },
        commentPinResult: { requested: false, skipped: true, menuOpened: false, clicked: false, confirmed: false, verified: false, reason: '' },
        candidateCount: 1,
        verified: [{ candidate: postUrl, url: postUrl, hasMarker: true, hasPostMedia: true, source: 'direct_post_visible' }],
      }, null, 2));
      return;
    }
  }
  if (!approvalResult.clicked) {
    const reviewSurface = await openGroupReviewSurface(page, groupUrl, marker, payload.publisherFacebookUserId || payload.facebookUserId, gid);
    attempts.push({ target: groupUrl, ...reviewSurface });
    // Emit an explicit surface-reachability signal the server keys off of (separate from the
    // overloaded "no pending article" reason): false => approver is not a moderator of this group.
    console.log(JSON.stringify({
      step: 'admin_approval_surface',
      adminSurfaceReachable: reviewSurface.adminSurfaceReachable === undefined ? true : reviewSurface.adminSurfaceReachable,
      landedUrl: reviewSurface.url,
      method: reviewSurface.method,
      visited: (reviewSurface.visited || []).slice(-5),
    }));
    approvalResult = await clickApproveForVisibleMarker(page, marker, payload.publisherFacebookUserId || payload.facebookUserId, gid);
    attempts.push({ target: page.url(), ...(await collectVerifiedUrls('review_surface')) });
  }
  if (!postUrl && approvalResult.clicked) {
    await page.goto(groupUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await humanPause(4000, 7000);
    attempts.push({ target: groupUrl, ...(await collectVerifiedUrls('group_after_approval')) });
    if (!verified.length) {
      const searchTarget = `${groupUrl.replace(/[?#].*$/, '').replace(/\/+$/, '')}/search/?q=${encodeURIComponent(marker)}`;
      await page.goto(searchTarget, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await humanPause(4000, 7000);
      attempts.push({ target: searchTarget, ...(await collectVerifiedUrls('group_search_after_approval')) });
    }
  }
  if (postUrl) {
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await humanPause(2000, 3500);
  }
  const checks = await bodyMarkerChecks(page, marker);
  let resolvedPostUrl = verified[0]?.candidate || verified[0]?.url || postUrl;
  if (postUrl) {
    const candidate = await verifyCandidate(context, postUrl, marker).catch(e => ({ url: postUrl, error: e.message }));
    if (candidateHasStrongPermalinkMarker(candidate)) verified.push({ candidate: postUrl, ...candidate });
    resolvedPostUrl = verified[0]?.candidate || verified[0]?.url || postUrl;
  }
  console.log(JSON.stringify({
    step: 'approval_attempted',
    mode: 'approve_only',
    postUrl: resolvedPostUrl,
    groupUrl,
    marker,
    ...approvalResult,
    attempts,
    bodyChecks: checks,
  }, null, 2));
  console.log(JSON.stringify({
    step: 'result',
    mode: 'approve_only',
    marker,
    postUrl: resolvedPostUrl,
    postPageUrl: resolvedPostUrl,
    bodyChecks: {
      markerVisible: checks.markerVisible || verified.some(item => item.hasMarker),
      ownControls: checks.ownControls,
    },
    imageVerified: true,
    postMediaVerified: checks.postMediaVerified || verified.some(item => item.hasPostMedia),
    commentResult: { skipped: true, clicked: false, typed: false, submitted: false, verified: false },
    commentPinResult: { requested: false, skipped: true, menuOpened: false, clicked: false, confirmed: false, verified: false, reason: '' },
    candidateCount: verified.length,
    verified,
  }, null, 2));
}

// HARVEST: read a SOURCE group's /media grid, open the first N media posts, and extract each post's
// TEXT + IMAGE + the LINK in its first comment. READ-ONLY (never posts/comments). Returns [{href,text,image,link}].
async function harvestGroupFeed(page, count, opts = {}) {
  const out = [];
  const seenLinks = new Set(); // dedup harvested PRODUCTS by their first-comment URL (each product = unique url)
  await page.waitForTimeout(3000);
  try { await page.waitForSelector('a[href*="fbid="]', { timeout: 25000 }); } catch (_) {}
  // Scroll the LAZY-LOAD CONTAINER (tiles live in a scrollable DIV; scrolling body alone loads only 0-4 —
  // the documented sparse-grid bug). Stop at >=30 tiles, or no growth for 3 cycles, or 45s. Never throw:
  // a sparse grid is a valid throttled outcome handled by the server re-scan loop.
  { const deadline = Date.now() + 45000; let prev = -1, flat = 0;
    while (Date.now() < deadline) {
      const n = await page.evaluate(() => {
        const tiles = document.querySelectorAll('a[href*="/photo"][href*="fbid="]');
        let el = tiles[0], scroller = null;
        while (el && el !== document.body) { try { if (el.scrollHeight > el.clientHeight + 60 && /auto|scroll/.test(getComputedStyle(el).overflowY)) { scroller = el; break; } } catch (_) {} el = el.parentElement; }
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
        window.scrollTo(0, document.body.scrollHeight);
        return tiles.length;
      }).catch(() => 0);
      if (n >= 30) break;
      if (n <= prev) { flat++; if (flat >= 3) break; } else { flat = 0; prev = n; }
      await page.mouse.wheel(0, 2400).catch(() => {});
      await page.waitForTimeout(1500);
    }
  }
  const collected = await page.evaluate(() => {
    const items = []; const seen = new Set();
    for (const a of Array.from(document.querySelectorAll('a[href]'))) {
      const h = a.href || '';
      if (!/\/photo/i.test(h) || !/fbid=/i.test(h)) continue;   // ONLY photo-viewer links (clean post; /posts/ pages carry sidebar ADS)
      if (/set=p\./i.test(h)) continue;                          // skip profile/cover photos
      const fbid = (h.match(/fbid=(\d+)/) || [])[1] || '';
      const postId = (h.match(/set=gm?\.(\d+)/) || [])[1] || fbid;
      if (!postId || seen.has(postId)) continue; seen.add(postId); // ONE entry per distinct post, in grid order (latest first)
      items.push({ href: h, postId });
    }
    return { found: items.length, items: items.slice(0, 60) };
  });
  console.log(JSON.stringify({ step: 'harvest_media_links', found: collected.found, sample: collected.items.slice(0, 6).map((l) => l.href.slice(0, 90)) }));
  const links = collected.items;
  const seenIds = new Set((opts.seenIds || []).map(String));
  const pIndex = Number(opts.profileIndex || 0), pCount = Math.max(1, Number(opts.profileCount || 1));
  // skip tiles already scraped (continue from where we left off), then PARTITION the unseen tiles among the
  // N parallel profiles so each profile takes DIFFERENT products (no overlap, ~Nx faster).
  let work = links.filter((it) => !seenIds.has(String(it.postId)));
  if (pCount > 1) work = work.filter((_, idx) => (idx % pCount) === pIndex);
  console.log(JSON.stringify({ step: 'harvest_partition', total: links.length, mine: work.length, profileIndex: pIndex, profileCount: pCount }));
  for (let i = 0; i < work.length && out.length < count; i++) {
    const item = work[i];
    try {
      await page.goto(item.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
      // proceed as soon as the post content (article or its image) renders, capped at 3500ms — faster than a
      // flat 3.5s wait on fast loads, and just as safe on slow ones (still waits up to the cap).
      await page.waitForSelector('div[role="article"], img[src*="fbcdn"]', { timeout: 3500 }).catch(() => {});
      await page.waitForTimeout(600);
      // Load the COMMENTS (the affiliate link is in the FIRST COMMENT) + expand "See more" captions.
      try {
        for (let c = 0; c < 4; c++) {
          await page.mouse.wheel(0, 1500).catch(() => {});
          await page.waitForTimeout(800); // up to 4*800=3200ms (~= old fixed 3300ms) for slow comments...
          // ...but STOP scrolling the instant the first-comment external link is loaded (most posts: 1 scroll).
          const linkLoaded = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).some((a) => /l\.facebook\.com\/l\.php|mavlynk\.com|walmrt\.us|amzn|a\.co|bit\.ly|tinyurl|geni\.us|shareasale|liketk|rstyle/i.test(a.href || ''))).catch(() => false);
          if (linkLoaded) break;
        }
        await page.evaluate(() => {
          for (const el of Array.from(document.querySelectorAll('div[role="button"],span,a'))) {
            const t = (el.innerText || '').trim();
            if (/^see more$/i.test(t) || /view\s+\d+\s*(more\s*)?comment|view all|most relevant/i.test(t)) { try { el.click(); } catch (_) {} }
          }
        });
        await page.waitForTimeout(700);
      } catch (_) {}
      const data = await page.evaluate(() => {
        const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
        const isUrl = (s) => /^https?:\/\//i.test(s.trim()) || /^www\./i.test(s.trim());
        const isChrome = (s) => /^(Like|Comment|Share|Reply|See more|See less|All reactions|Active|Write a comment|See translation|Most relevant|Top fan|Author|Follow|Send|Share to|Sponsored|·)\b/i.test(s) || /^\d+\s*(comment|share|reaction|like)/i.test(s);
        const cands = [];
        for (const el of Array.from(document.querySelectorAll('div[dir="auto"], span[dir="auto"]'))) {
          const t = clean(el.innerText);
          if (t.length >= 12 && t.length <= 6000 && !isUrl(t) && !isChrome(t)) cands.push(t);
        }
        cands.sort((a, b) => b.length - a.length);
        const ogTitle = clean((document.querySelector('meta[property="og:title"]') || {}).content);
        const ogDesc = clean((document.querySelector('meta[property="og:description"]') || {}).content);
        let text = cands[0] || ogDesc || ogTitle || '';
        let image = '', max = 0;
        for (const im of Array.from(document.querySelectorAll('img'))) {
          const w = im.naturalWidth || 0, h = im.naturalHeight || 0;
          if (w >= 350 && h >= 200 && w * h > max && !/emoji|static|rsrc\.php/i.test(im.src)) { max = w * h; image = im.src; }
        }
        const META = /facebook\.com|fbcdn|messenger|fb\.me|meta\.(ai|com)|instagram\.com|whatsapp\.com|oculus|threads\.net/i;
        // JUNK = GIF replies, videos, news links etc. that appear in comments but are NOT the product link.
        const JUNK = /giphy\.com|tenor\.com|\.(gif|mp4|webm|mov)(\?|$)|imgur\.com|youtu\.?be|youtube\.com|spotify|soundcloud|wikipedia|gph\.is|\/news\/|wivb\.com|\b(cnn|bbc|nytimes|foxnews|reuters|apnews)\.com/i;
        // AFFILIATE = known product/affiliate shortener + network domains -> always preferred over a random link.
        const AFFIL = /mavlynk\.com|walmrt\.us|amzn\.to|amzlink\.to|a\.co|amazon\.[a-z.]+\/.*tag=|shopstyle|shopmy|go\.shop|rstyle\.me|shareasale|liketk|ltk\.app|geni\.us|sovrn|howl\.|collab|rakuten|sjv\.io|pxf\.io|prf\.hn|bit\.ly|tinyurl/i;
        const linkCands = [];
        for (const a of Array.from(document.querySelectorAll('a[href]'))) {
          let h = a.href || '';
          if (/l\.facebook\.com\/l\.php\?u=/i.test(h)) { try { h = decodeURIComponent((h.match(/[?&]u=([^&]+)/) || [])[1] || ''); } catch (_) {} }
          if (!/^https?:\/\//i.test(h) || META.test(h) || JUNK.test(h)) continue;
          linkCands.push(h);
        }
        // prefer a known affiliate/shortener link; else the first clean external link; else "" (skipped upstream)
        let link = linkCands.find((h) => AFFIL.test(h)) || linkCands[0] || '';
        // clean the link: drop FB tracking params (fbclid, brid, aem) -> the bare product/affiliate URL
        if (link) link = link.replace(/([?&])(fbclid|brid|aem|_aem|mibextid)=[^&]*/gi, '$1').replace(/[?&]+$/,'').replace(/\?&/, '?');
        return { text, image, link, ogTitle, ogDesc, candCount: cands.length, top3: cands.slice(0, 3) };
      });
      const dkey = (data.link || '').split(/[?#]/)[0] || ('post:' + item.postId); // unique PRODUCT key = first-comment URL
      if (seenLinks.has(dkey)) { console.log(JSON.stringify({ step: 'harvest_skip_duplicate', key: dkey })); continue; }
      seenLinks.add(dkey);
      // DOWNLOAD the image NOW (authed session; fbcdn urls are signed/short-lived and 403 later from the server).
      let imageLocalPath = '';
      if (data.image) {
        try {
          const b64 = await page.evaluate(async (url) => {
            const r = await fetch(url); if (!r.ok) return '';
            const bytes = new Uint8Array(await r.arrayBuffer());
            let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
            return btoa(s);
          }, data.image);
          if (b64 && b64.length > 2000) {
            const crypto = require('crypto'); const pathmod = require('path');
            const sha = crypto.createHash('sha1').update(dkey).digest('hex').slice(0, 16);
            const dir = pathmod.join(__dirname, '..', 'data', 'harvested-images');
            fs.mkdirSync(dir, { recursive: true });
            const fp = pathmod.join(dir, sha + '.jpg');
            fs.writeFileSync(fp, Buffer.from(b64, 'base64'));
            imageLocalPath = fp;
          }
        } catch (e) { console.log(JSON.stringify({ step: 'harvest_image_download_failed', error: String((e && e.message) || e).slice(0, 140) })); }
      }
      out.push({ href: item.href, postId: item.postId, productKey: dkey, imageLocalPath, ...data });
      console.log(JSON.stringify({ step: 'harvest_item', n: out.length, textLen: (data.text || '').length, textPreview: (data.text || '').slice(0, 100), imageSaved: !!imageLocalPath, link: data.link, key: dkey }));
    } catch (e) {
      console.log(JSON.stringify({ step: 'harvest_item_error', href: item.href.slice(0, 120), error: String((e && e.message) || e).slice(0, 160) }));
    }
  }
  return out;
}

async function main() {
  const payload = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const targetUrl = payload.harvestOnly && payload.groupUrl
    ? (String(payload.groupUrl).replace(/\/+$/, '').replace(/\/media$/i, '') + '/media')
    : ((payload.commentOnly || payload.approveOnly || payload.verifyOnly || payload.pinOnly) && payload.postUrl ? payload.postUrl : payload.groupUrl);
  // Group identifier may be a NUMERIC id (/groups/123456…) OR a vanity slug
  // (/groups/o1498765421290862). Numeric ids are used directly; a vanity slug
  // navigates fine but its numeric id (needed for permalink/user-url matching during
  // verification) is resolved from the loaded group page below. `gid` is `let` so the
  // resolved value also flows into the response-capture closure that reads it.
  const gidRaw = (String(targetUrl || '').match(/groups\/([^/?#]+)/) || [])[1] || '';
  if (!gidRaw) throw new Error('could not parse group id');
  let gid = /^\d+$/.test(gidRaw) ? gidRaw : '';
  const groupVanitySlug = gid ? '' : gidRaw;
  const marker = payload.marker || payload.postText;

  const __connectorStartedAt = Date.now();
  let __lastPhaseAt = __connectorStartedAt;
  const __timingsFile = require('path').join(__dirname, '..', 'data', `fb-connector-timings-${__connectorStartedAt}.jsonl`);
  function logTiming(phase) {
    const now = Date.now();
    const totalMs = now - __connectorStartedAt;
    const phaseMs = now - __lastPhaseAt;
    __lastPhaseAt = now;
    const entry = { step: 'timing', phase, phaseMs, totalMs, atIso: new Date(now).toISOString() };
    console.log(JSON.stringify(entry));
    try { fs.appendFileSync(__timingsFile, JSON.stringify(entry) + '\n'); } catch (_) {}
  }
  logTiming('main_started');

  // BATCH SESSION REUSE (flag-gated by the server; payload.reuseCdpEndpoint is set ONLY by the batch
  // cross-comment path). When present, SKIP the ~1-min ixPost('profile-open') and attach to the already-
  // open session; if that connect fails (dead/race) we fall back to a fresh open at connectOverCDP below.
  // When absent (EVERY normal call) this runs the proven profile-open verbatim — byte-for-byte unchanged.
  const reusedCdpEndpoint = payload.reuseCdpEndpoint ? String(payload.reuseCdpEndpoint) : "";
  let endpoint;
  if (reusedCdpEndpoint) {
    endpoint = reusedCdpEndpoint;
    console.log(JSON.stringify({ step: 'ix_reuse', endpoint }));
    logTiming('after_ix_reuse_connect_skipped');
  } else {
    const open = await ixPost('profile-open', {
      profile_id: Number(payload.profileId),
      args: ['--disable-popup-blocking', targetUrl],
      load_extensions: true,
      cookies_backup: false,
      load_profile_info_page: false,
    }, Number(payload.profileOpenTimeoutMs || 70000));
    endpoint = open.data.ws || ('http://' + open.data.debugging_address);
    console.log(JSON.stringify({ step: 'ix_open', endpoint }));
    logTiming('after_ix_profile_open');
  }

  let browser;
  try {
  try {
    browser = await chromium.connectOverCDP(endpoint, { timeout: reusedCdpEndpoint ? 8000 : 30000 });
  } catch (connErr) {
    if (!reusedCdpEndpoint) throw connErr; // normal path: behaviour identical to before
    // Reuse endpoint died between the server's liveness check and this connect -> fall back to a FRESH
    // open so the (cross-)comment still completes. This is the load-bearing reuse safety net.
    console.log(JSON.stringify({ step: 'ix_reuse_connect_failed', endpoint, error: String((connErr && connErr.message) || connErr).slice(0, 200), fallback: 'fresh_open' }));
    const freshOpen = await ixPost('profile-open', {
      profile_id: Number(payload.profileId),
      args: ['--disable-popup-blocking', targetUrl],
      load_extensions: true,
      cookies_backup: false,
      load_profile_info_page: false,
    }, Number(payload.profileOpenTimeoutMs || 70000));
    endpoint = freshOpen.data.ws || ('http://' + freshOpen.data.debugging_address);
    console.log(JSON.stringify({ step: 'ix_open_fallback', endpoint }));
    browser = await chromium.connectOverCDP(endpoint, { timeout: 30000 });
  }
  const context = browser.contexts()[0] || await browser.newContext();
  // CPU SAVER (no-GPU box): block the heavy resources the posting flow never
  // needs -- autoplay video/audio + fonts are the main software-rendering CPU
  // sink on the FB feed and cause posts to hang on low-core machines. Keep
  // images (needed for upload verification), scripts, styles, and xhr/fetch.
  // Best-effort: any failure falls back to normal behavior, never blocks a post.
  try {
    await context.route('**/*', (route) => {
      try {
        const t = route.request().resourceType();
        const u = route.request().url();
        // Block only autoplay VIDEO/AUDIO (the real software-render CPU sink).
        // Keep fonts (FB composer UI needs them), images (upload), scripts, styles.
        if (t === 'media') return route.abort();
        if (/\.(mp4|m4v|webm|ogv|mov|m4a|mp3|ogg)(\?|#|$)/i.test(u)) return route.abort();
        return route.continue();
      } catch (_) { try { return route.continue(); } catch (e) {} }
    });
    console.log(JSON.stringify({ step: 'cpu_saver_route', blocked: 'media,font,video' }));
  } catch (e) { console.log(JSON.stringify({ step: 'cpu_saver_route_skipped', error: String(e.message || e).slice(0, 120) })); }
  const page = context.pages().find(p => !p.isClosed()) || await context.newPage();

  if (!String(payload.facebookUserId || '').replace(/\D+/g, '')) {
    let detected = '';
    let detectedSource = '';
    try {
      const cookies = await context.cookies(['https://www.facebook.com']);
      const cUser = (cookies || []).find(c => c && c.name === 'c_user' && /^\d{6,}$/.test(String(c.value || '')));
      if (cUser) { detected = String(cUser.value); detectedSource = 'c_user_cookie'; }
    } catch (_) {}
    if (!detected) {
      try {
        const probe = context.pages().find(p => !p.isClosed()) || await context.newPage();
        await probe.goto('https://www.facebook.com/me/', { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
        await probe.waitForTimeout(1500);
        const probeUrl = probe.url() || '';
        const m = probeUrl.match(/facebook\.com\/(?:profile\.php\?id=)?(\d{6,})/);
        if (m) { detected = m[1]; detectedSource = 'me_redirect'; }
        if (probe !== page) await probe.close().catch(() => {});
      } catch (_) {}
    }
    if (detected) {
      payload.facebookUserId = detected;
      if (!payload.publisherFacebookUserId) payload.publisherFacebookUserId = detected;
      console.log(JSON.stringify({ step: 'facebook_user_id_detected', source: detectedSource, userId: detected }));
    } else {
      console.log(JSON.stringify({ step: 'facebook_user_id_detection_failed', reason: 'c_user cookie missing and /me/ redirect did not expose numeric id; falling back to DOM scoring' }));
    }
  } else {
    console.log(JSON.stringify({ step: 'facebook_user_id_provided', source: 'payload', userId: String(payload.facebookUserId).replace(/\D+/g, '') }));
  }

  const captured = [];
  const uploadEvents = [];
  const uploadedPhotoIds = [];
  const addUploadedPhotoId = (id) => {
    const s = String(id || '').replace(/\D+/g, '');
    if (/^\d{8,20}$/.test(s) && !uploadedPhotoIds.includes(s)) {
      uploadedPhotoIds.push(s);
      if (uploadedPhotoIds.length > 100) uploadedPhotoIds.shift();
    }
  };
  page.on('response', async (res) => {
    const url = res.url();
    if (/facebook\.com/i.test(url) && /upload|media|photo|attachment|composer/i.test(url)) {
      uploadEvents.push({
        url: url.split('?')[0].slice(0, 220),
        status: res.status(),
        at: Date.now(),
      });
      if (uploadEvents.length > 25) uploadEvents.shift();
      // IMAGE-ID CAPTURE (verification phase): read THIS upload XHR's body and harvest photo/
      // media id digits. This request is this browser's OWN image upload, so its id is unique
      // per worker (unlike the rotating, non-unique caption). We LOG candidates now; the
      // rendered post-image ids are parsed in verifyCandidate; a live test confirms a match
      // before we gate capture on it.
      try {
        const body = await res.text();
        if (body && body.length < 4000000) {
          const keyed = body.match(/"(?:photo_id|media_id|legacy_attachment_id|attachment_id|fbid|id)"\s*:\s*"?(\d{8,20})"?/g) || [];
          for (const m of keyed) { const d = (m.match(/(\d{8,20})/) || [])[1]; if (d) addUploadedPhotoId(d); }
          if (keyed.length) console.log(JSON.stringify({ step: 'upload_response_photo_ids', url: url.split('?')[0].slice(0, 120), keyedCount: keyed.length, ids: [...new Set(keyed.map(m => (m.match(/(\d{8,20})/) || [])[1]).filter(Boolean))].slice(0, 10), bodySample: body.slice(0, 600) }));
        }
      } catch (_) {}
    }
    if (!/facebook\.com\/(api\/graphql|ajax|graphql|api\/)*/i.test(url)) return;
    if (!/graphql|composer|ufi|story|feedback|api/i.test(url)) return;
    try {
      const txt = await res.text();
      const markerSeen = markerTextMatches(txt, marker);
      if (markerSeen || /story_fbid|post_id|legacy_fbid|permalink|subscription_target_id/i.test(txt)) {
        const c = extractCandidatesFromText(txt.slice(0, 1500000), gid);
        if (c.urls.length || c.ids.length || markerSeen) captured.push({ url, status: res.status(), marker: markerSeen, at: Date.now(), ...c });
      }
    } catch (_) {}
  });

  if (payload.harvestOnly) {
    const harvestCount = Math.max(1, Math.min(20, Number(payload.harvestCount || 4)));
    console.log(JSON.stringify({ step: 'harvest_started', mediaUrl: targetUrl, count: harvestCount }));
    let harvested = [];
    try { harvested = await harvestGroupFeed(page, harvestCount, { seenIds: payload.harvestSeenIds || [], profileIndex: payload.harvestProfileIndex || 0, profileCount: payload.harvestProfileCount || 1 }); }
    catch (e) { console.log(JSON.stringify({ step: 'harvest_error', error: String((e && e.message) || e).slice(0, 300) })); }
    console.log(JSON.stringify({ step: 'harvest_result', count: harvested.length, items: harvested }));
    return; // the finally block closes the browser
  }

  if (payload.approveOnly) {
    // The admin pending-queue surface (pending_posts / manage_post_queue) only resolves with the
    // NUMERIC group id. When the group is addressed by a VANITY slug (e.g. /groups/o1498765421290862)
    // gid is empty here, so FB redirects pending_posts to the group FEED and the author-link match is
    // disabled — the moderator never sees the queue and every post is left pending (never approved).
    // Resolve the numeric id from the rendered group page FIRST.
    if (!gid) {
      // RETRY: a transient render/login miss returns empty gid; if we then build the vanity admin
      // URL it redirects to the feed and the server would wrongly conclude "approver not a moderator"
      // — masking the operator's rights grant. Try up to twice before giving up (then INCONCLUSIVE).
      for (let gidAttempt = 1; gidAttempt <= 2 && !gid; gidAttempt += 1) {
        await page.goto(`https://www.facebook.com/groups/${gidRaw}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await humanPause(2000, 3500);
        await ensureFacebookLoggedIn(page, payload, 'approve_only_group').catch(() => {});
        const resolvedGid = await resolveNumericGroupIdFromPage(page).catch(() => '');
        if (resolvedGid) gid = resolvedGid;
        console.log(JSON.stringify({ step: 'admin_approval_gid_resolved', gidRaw, gid: gid || '', resolved: Boolean(resolvedGid), attempt: gidAttempt }));
      }
    }
    await approvePendingPost(page, context, payload, gid, marker);
    return;
  }

  if ((payload.commentOnly || payload.pinOnly) && payload.postUrl) {
    await page.goto(payload.postUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => console.log(JSON.stringify({ step: 'goto_warn', message: e.message })));
    await humanPause(1800, 3200);
    await ensureFacebookLoggedIn(page, payload, payload.pinOnly ? 'pin_only_post_url' : 'comment_only_post_url');
    console.log(JSON.stringify({ step: 'page_loaded', url: page.url(), title: await page.title().catch(() => ''), mode: payload.pinOnly ? 'pin_only' : 'comment_only' }));
    let targetPreflight = await commentTargetPreflight(page, payload.postUrl, marker);
    console.log(JSON.stringify({ step: 'comment_target_preflight', attempt: 1, ...targetPreflight, postPageUrl: payload.postUrl }));
    // PATIENT wait-for-post: a cross-account commenter is a DIFFERENT profile than the
    // publisher, so a JUST-published post often shows "content isn't available / pending" or an
    // unrendered body to it for the first ~30-90s until FB PROPAGATES the post to that account's
    // view. The old loop bailed the instant `unavailable` was true (exit condition
    // `!targetPreflight.unavailable`), so the comment failed with comment_target_unavailable_or_pending
    // mere seconds after publish (e.g. p19's post: p12 tried at +5s, p9 at +30s, both bailed).
    // FIX: keep RETRYING through `unavailable` — re-navigate to the exact permalink (~every 10s)
    // to pick up propagation, and poll the body otherwise — up to a 120s budget. Still gated on
    // urlMatches/titleHasMarker (or a transient unavailable) so we never comment on a WRONG post;
    // give up only after the budget (then it's genuinely not visible to this profile).
    const PREFLIGHT_BUDGET_MS = 120000;
    const preflightStartedAt = Date.now();
    let preflightAttempt = 1;
    let preflightNudgedReload = false;
    let lastRenavAt = 0;
    while (!targetPreflight.ok && (Date.now() - preflightStartedAt) < PREFLIGHT_BUDGET_MS) {
      const stillWorthRetrying = targetPreflight.urlMatches || targetPreflight.titleHasMarker || targetPreflight.unavailable;
      if (!stillWorthRetrying) break; // we are NOT on the right post and it's not a transient unavailable -> stop
      await page.waitForTimeout(3000);
      if (targetPreflight.unavailable && (Date.now() - lastRenavAt) > 10000) {
        // not yet propagated to THIS profile -> re-open the exact permalink to refresh that view
        await page.goto(payload.postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await humanPause(2500, 4500);
        lastRenavAt = Date.now();
      } else if (!preflightNudgedReload && (Date.now() - preflightStartedAt) > 30000) {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await humanPause(2500, 4500);
        preflightNudgedReload = true;
      }
      preflightAttempt += 1;
      targetPreflight = await commentTargetPreflight(page, payload.postUrl, marker);
      console.log(JSON.stringify({ step: 'comment_target_preflight', attempt: preflightAttempt, ...targetPreflight, postPageUrl: payload.postUrl, elapsedMs: Date.now() - preflightStartedAt }));
      if (targetPreflight.ok) break;
    }
    let commentResult = { skipped: !payload.commentText, clicked: false, typed: false, submitted: false, verified: false };
    const targetReadyForCommentMode = targetPreflight.ok || (
      payload.pinOnly &&
      targetPreflight.urlMatches &&
      !targetPreflight.unavailable
    );
    if (!targetReadyForCommentMode) {
      commentResult = {
        skipped: false,
        clicked: false,
        typed: false,
        submitted: false,
        verified: false,
        blocked: true,
        blockReason: targetPreflight.reason,
        restrictionText: (targetPreflight.snippet || []).join(' | ').slice(0, 500),
      };
    } else if (payload.pinOnly && payload.commentText) {
      const existingComment = await waitForPublishedCommentText(page, payload.commentText, 9000).catch((err) => ({
        verified: false,
        needle: '',
        snippet: '',
        reason: err?.message || String(err),
      }));
      commentResult = {
        skipped: true,
        pinOnly: true,
        clicked: false,
        typed: false,
        submitted: Boolean(existingComment.verified),
        verified: Boolean(existingComment.verified),
        verifiedNeedle: existingComment.needle || '',
        verifiedSnippet: existingComment.snippet || '',
        verifyReason: existingComment.reason || '',
      };
    } else if (payload.commentText) {
      commentResult = await submitCommentOnVisiblePost(page, marker, payload.commentText, payload.postUrl);
      await humanPause(700, 1400);
    }
    const commentAttemptUrl = await page.evaluate(() => location.href).catch(() => page.url());
    console.log(JSON.stringify({ step: 'comment_attempted', commented: commentResult.submitted, ...commentResult, postPageUrl: payload.postUrl, currentUrl: commentAttemptUrl }));
    let commentPinResult = {
      requested: payload.pinFirstComment !== false && Boolean(payload.commentText),
      skipped: payload.pinFirstComment === false || !payload.commentText,
      menuOpened: false,
      clicked: false,
      confirmed: false,
      verified: false,
      reason: '',
    };
    if (commentPinResult.requested) {
      if (!commentResult.verified) {
        commentPinResult.reason = 'comment_not_verified_before_pin';
      } else {
        commentPinResult = await pinVisibleComment(page, payload.commentText).catch((err) => ({
          requested: true,
          menuOpened: false,
          clicked: false,
          confirmed: false,
          verified: false,
          reason: err?.message || String(err),
        }));
      }
    }
    console.log(JSON.stringify({ step: 'comment_pin_attempted', ...commentPinResult, postPageUrl: payload.postUrl }));
    const publishedCommentCheck = await waitForPublishedCommentText(page, payload.commentText, 1200).catch((err) => ({
      verified: false,
      needle: '',
      reason: err?.message || String(err),
    }));
    const bodyChecks = await page.evaluate(({marker}) => {
      const text = document.body.innerText || '';
      return {
        markerVisible: text.includes(marker),
        ownControls: /Edit post|Delete post/.test(text),
      };
    }, {marker}).catch((err) => ({
      markerVisible: false,
      ownControls: false,
      error: err?.message || String(err),
    }));
    bodyChecks.commentVisible = Boolean(publishedCommentCheck.verified);
    bodyChecks.commentNeedle = publishedCommentCheck.needle || '';
    bodyChecks.commentVerifyReason = publishedCommentCheck.reason || '';
    console.log(JSON.stringify({
      step: 'result',
      mode: payload.pinOnly ? 'pin_only' : 'comment_only',
      marker,
      postUrl: payload.postUrl,
      postPageUrl: payload.postUrl,
      bodyChecks,
      imageVerified: true,
      postMediaVerified: true,
      commentResult,
      commentPinResult,
      verified: [{ candidate: payload.postUrl, url: payload.postUrl, hasMarker: bodyChecks.markerVisible, hasPostMedia: true }],
    }, null, 2));
    return;
  }

  if (payload.findOnly) {
    const baseGroupUrl = String(payload.groupUrl || '').replace(/[?#].*$/, '').replace(/\/+$/, '');
    const markerToken = (String(marker || '').match(/ZDF-[A-Z0-9]+/i) || [marker])[0];
    const targets = [...new Set([
      payload.groupUrl,
      `${baseGroupUrl}?sorting_setting=CHRONOLOGICAL`,
      `${baseGroupUrl}/search/?q=${encodeURIComponent(marker)}`,
      markerToken && markerToken !== marker ? `${baseGroupUrl}/search/?q=${encodeURIComponent(markerToken)}` : '',
    ].filter(Boolean))];
    let markerScopedUrls = [];
    let domUrls = [];
    let verified = [];
    let bodyChecks = { markerVisible: false, ownControls: false };
    const visited = [];
    const findOnlyStartedAt = Date.now();
    const FIND_ONLY_BUDGET_MS = clampInt(payload.findOnlyBudgetMs || 180000, 60000, 240000);
    let findOnlyBudgetExceeded = false;
    let publisherGroupUserCandidatesFromFind = [];
    for (const target of targets) {
      if (Date.now() - findOnlyStartedAt > FIND_ONLY_BUDGET_MS) { findOnlyBudgetExceeded = true; break; }
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => console.log(JSON.stringify({ step: 'goto_warn', target, message: e.message })));
      await ensureFacebookLoggedIn(page, payload, 'find_only_marker_scan');
      // Resolve the numeric gid for a VANITY group (o-prefixed slug) so permalink/user-URL regexes
      // are not built broken (/groups//...). Without this isFacebookGroupPostUrl rejects every
      // candidate and submitted-URL recovery captures ZERO permalinks for this group.
      if (!gid) {
        const fg = await resolveNumericGroupIdFromPage(page).catch(() => '');
        if (fg) { gid = fg; console.log(JSON.stringify({ step: 'find_only_gid_resolved', gidRaw, gid })); }
      }
      visited.push(page.url());
      publisherGroupUserCandidatesFromFind = mergeGroupUserCandidates(
        publisherGroupUserCandidatesFromFind,
        await extractVisibleGroupUserCandidates(page, gid, marker, 'find_only_target_page').catch(() => []),
      );
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        if (Date.now() - findOnlyStartedAt > FIND_ONLY_BUDGET_MS) { findOnlyBudgetExceeded = true; break; }
        await humanPause(attempt === 1 ? 4500 : 6500, attempt === 1 ? 7500 : 9500);
        bodyChecks = await page.evaluate(({ marker }) => {
          const text = document.body.innerText || '';
          return {
            markerVisible: text.includes(marker),
            ownControls: /Edit post|Delete post/.test(text),
          };
        }, { marker }).catch(() => ({ markerVisible: false, ownControls: false }));
        markerScopedUrls = [...new Set([...markerScopedUrls, ...(await extractMarkerScopedPostUrls(page, gid, marker).catch(() => []))])];
        domUrls = [...new Set([...domUrls, ...(await extractDomUrls(page, gid, marker).catch(() => []))])];
        const candidateUrls = [...new Set([...markerScopedUrls, ...domUrls])].filter(url => isFacebookGroupPostUrl(url, gid));
        for (const u of candidateUrls.slice(0, 25)) {
          if (verified.some(item => item.candidate === u || item.url === u)) continue;
          let v;
          try {
            v = await verifyCandidate(context, u, marker);
          } catch (err) {
            v = { url: u, error: err?.message || String(err) };
          }
          console.log(JSON.stringify({ step: 'find_only_candidate_verified', candidate: u, hasMarker: Boolean(v.hasMarker), bodyHasMarker: Boolean(v.bodyHasMarker), titleHasMarker: Boolean(v.titleHasMarker), exactPermalink: Boolean(v.exactPermalink), error: v.error || '' }));
          if (candidateHasStrongPermalinkMarker(v)) verified.push({ candidate: u, ...v });
          if (candidateHasStrongPermalinkMarker(v) && isFacebookGroupPostUrl(u, gid)) break;
        }
        if (verified.length) break;
        if (attempt === 1) await page.keyboard.press('Home').catch(() => {});
        await page.mouse.wheel(0, 1800).catch(() => {});
      }
      if (verified.length) break;
    }
    let groupUserDiscovery = null;
    if (!verified.length && !findOnlyBudgetExceeded) {
      const remaining = Math.max(20000, FIND_ONLY_BUDGET_MS - (Date.now() - findOnlyStartedAt));
      groupUserDiscovery = await discoverPostUrlsFromGroupUserPages(page, payload, gid, marker, publisherGroupUserCandidatesFromFind, {
        budgetMs: Math.min(remaining, 90000),
        maxCandidates: 3,
        maxAttempts: 2,
      }).catch((err) => ({ error: err?.message || String(err), candidates: publisherGroupUserCandidatesFromFind.slice(0, 8), selected: [], visited: [], found: [], urls: [] }));
      console.log(JSON.stringify({ step: 'find_only_group_user_discovery', foundCount: groupUserDiscovery?.found?.length || 0, visitedCount: groupUserDiscovery?.visited?.length || 0, elapsedMs: groupUserDiscovery?.elapsedMs || 0, error: groupUserDiscovery?.error || '' }));
      for (const item of groupUserDiscovery?.found || []) {
        if (verified.some(v => v.candidate === item.url || v.url === item.url)) continue;
        let v;
        try {
          v = await verifyCandidate(context, item.url, marker);
        } catch (err) {
          v = { url: item.url, error: err?.message || String(err) };
        }
        console.log(JSON.stringify({ step: 'find_only_group_user_candidate_verified', candidate: item.url, userId: item.userId, hasMarker: Boolean(v.hasMarker), bodyHasMarker: Boolean(v.bodyHasMarker), titleHasMarker: Boolean(v.titleHasMarker), exactPermalink: Boolean(v.exactPermalink), error: v.error || '' }));
        if (candidateHasStrongPermalinkMarker(v)) verified.push({ candidate: item.url, source: 'find_only_group_user_marker_scoped', ...v });
        if (candidateHasStrongPermalinkMarker(v) && isFacebookGroupPostUrl(item.url, gid)) break;
      }
    }
    const postPageUrl = verified[0]?.candidate || verified[0]?.url || '';
    console.log(JSON.stringify({
      step: 'result',
      mode: 'find_only',
      marker,
      postUrl: postPageUrl,
      postPageUrl,
      bodyChecks,
      imageVerified: true,
      postMediaVerified: verified.some(item => item.hasPostMedia),
      postPermalinkVerified: verified.length > 0,
      markerPermalinkVerified: verified.some(item => candidateHasStrongPermalinkMarker(item)),
      titlePermalinkVerified: verified.some(item => item.titleHasMarker && item.exactPermalink),
      commentResult: { skipped: true, clicked: false, typed: false, submitted: false, verified: false },
      commentPinResult: { requested: false, skipped: true, menuOpened: false, clicked: false, confirmed: false, verified: false, reason: '' },
      visited,
      markerScopedUrls,
      domNew: domUrls,
      candidateCount: [...new Set([...markerScopedUrls, ...domUrls])].length,
      publisherGroupUserCandidates: publisherGroupUserCandidatesFromFind.slice(0, 8),
      groupUserDiscovery,
      findOnlyBudgetExceeded,
      findOnlyElapsedMs: Date.now() - findOnlyStartedAt,
      verified,
    }, null, 2));
    return;
  }

  // ix profile-open already loaded targetUrl (passed in args). Don't trigger
  // a second navigation that costs another 30-60s FB page load when the
  // browser is already on the right page. Only goto if URL doesn't match.
  const currentGroupUrl = page.url();
  const groupUrlClean = String(payload.groupUrl || '').split('#')[0].replace(/\/+$/, '');
  const currentUrlClean = String(currentGroupUrl || '').split('#')[0].replace(/\/+$/, '');
  const alreadyOnGroupPage = groupUrlClean && currentUrlClean.startsWith(groupUrlClean);
  if (alreadyOnGroupPage) {
    console.log(JSON.stringify({ step: 'page_load_skipped', reason: 'browser_already_on_group_url_from_profile_open', currentUrl: currentGroupUrl }));
    await humanPause(2000, 3500);
  } else {
    await page.goto(payload.groupUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => console.log(JSON.stringify({ step: 'goto_warn', message: e.message })));
    await humanPause(4000, 7000);
  }
  await ensureFacebookLoggedIn(page, payload, 'group_page');
  console.log(JSON.stringify({ step: 'page_loaded', url: page.url(), title: await page.title().catch(() => '') }));
  logTiming('after_group_page_loaded');

  // (A) The page may have landed on a transient "content isn't available" /
  // error interstitial — most often when ix profile-open put us on the group
  // URL and we skipped our own navigation above. Force the group to actually
  // render (bounded reload + fresh goto) before trying to open the composer.
  // Skips immediately if there is a genuine membership wall or the group is
  // already rendered, so it costs nothing on the happy path.
  if (await isGroupContentUnavailable(page)) {
    const rendered = await ensureGroupRendered(page, payload.groupUrl);
    if (!rendered) {
      if (await groupHasMembershipWall(page)) {
        // Real access barrier — let the composer flow report the wall/access error.
        console.log(JSON.stringify({ step: 'group_membership_wall_after_recovery', url: page.url() }));
      } else {
        // Still a bare unavailable interstitial after all bounded reloads:
        // this is a GROUP-RENDER problem, not an account block. Use wording the
        // server classifier will NOT treat as a hard account block.
        console.log(JSON.stringify({ step: 'group_page_unavailable_giving_up', url: page.url(), title: await page.title().catch(() => '') }));
        throw new Error('group page unavailable after 3 reloads: content markup not rendered');
      }
    }
  }
  logTiming('after_ensure_group_rendered');

  // Vanity group URL (e.g. /groups/o1498765421290862) carried no numeric id — now that
  // the group has rendered, resolve the numeric group id for permalink/user-url matching
  // during verification. `gid` is mutable so the response-capture closure picks it up too.
  if (!gid) {
    gid = await resolveNumericGroupIdFromPage(page);
    console.log(JSON.stringify({ step: gid ? 'group_numeric_id_resolved' : 'group_numeric_id_unresolved', gid: gid || '', vanitySlug: groupVanitySlug, url: page.url() }));
  }

  const beforeDomUrls = await extractDomUrls(page, gid, marker).catch(() => []);
  let publisherGroupUserCandidates = await extractVisibleGroupUserCandidates(page, gid, marker, 'group_page_before_composer');

  const composerOpen = await openComposerWithRecovery(page, payload.groupUrl);
  console.log(JSON.stringify({ step: 'composer_open_attempted', ...composerOpen, diagnostic: composerOpen.opened ? undefined : composerOpen.diagnostic }));
  if (!composerOpen.opened) {
    // Distinguish a TRUE membership/question gate (operator must join the group) from a generic /
    // transient composer-open miss — otherwise the server collapses both to "cannot_post_in_group"
    // and wrongly benches profiles. A distinct error lets the server label it not_a_member_of_group.
    const d = composerOpen.diagnostic || {};
    const btns = Array.isArray(d.buttons) ? d.buttons : [];
    const probe = `${d.title || ''} ${d.dialogText || ''} ${btns.map((b) => String(b && b.label || '').toLowerCase()).join(' | ')}`.toLowerCase();
    if (/join group|request to join|pending approval|cancel request|must be a member|you are not a member|only members can|members of this group|invitation only|invited to join|private group|answer.*question.*join|membership question/.test(probe)) {
      throw new Error('facebook_group_membership_required_not_a_member');
    }
    throw new Error('could not open composer');
  }
  logTiming('after_composer_opened');
  await humanPause(900, 1700);
  publisherGroupUserCandidates = mergeGroupUserCandidates(
    publisherGroupUserCandidates,
    await extractComposerGroupUserCandidates(page, gid, 'composer_open_actor'),
    await extractVisibleGroupUserCandidates(page, gid, marker, 'composer_open'),
  );

  if (!(await typeIntoComposer(page, payload.postText))) {
    console.log(JSON.stringify({ step: 'composer_type_diagnostic', diagnostic: await facebookUiSnapshot(page) }));
    throw new Error('could not type post');
  }
  await humanPause(900, 1700);
  publisherGroupUserCandidates = mergeGroupUserCandidates(
    publisherGroupUserCandidates,
    await extractComposerGroupUserCandidates(page, gid, 'composer_typed_actor'),
    await extractVisibleGroupUserCandidates(page, gid, marker, 'composer_typed'),
  );

  const imageAttach = await attachImageToComposer(page, payload.imagePath, { uploadEvents });
  await humanPause(1200, 2200);
  const publisherActor = await extractComposerActorIdentity(page);
  publisherGroupUserCandidates = mergeGroupUserCandidates(
    publisherGroupUserCandidates,
    await extractComposerGroupUserCandidates(page, gid, 'image_attached_actor'),
    await extractVisibleGroupUserCandidates(page, gid, marker, 'image_attached'),
  );
  publisherGroupUserCandidates = boostGroupUserCandidatesByPublisherActor(publisherGroupUserCandidates, publisherActor);
  console.log(JSON.stringify({
    step: 'publisher_group_user_candidates',
    publisherActor,
    candidates: publisherGroupUserCandidates.slice(0, 8),
  }));
  console.log(JSON.stringify({ step: 'image_attached', confirmed: true, ...imageAttach }));
  logTiming('after_image_attached');

  const postClick = await clickPostButton(page);
  if (!postClick.clicked) {
    console.log(JSON.stringify({ step: 'post_button_diagnostic', diagnostic: postClick.diagnostic || await facebookUiSnapshot(page) }));
    throw new Error('could not click Post');
  }
  const postClickedAt = Date.now();
  console.log(JSON.stringify({ step: 'post_clicked', ...postClick, postClickedAt }));
  logTiming('after_post_clicked');

  await humanPause(2200, 3600);
  // PAGE-PUBLISH BLOCK (e.g. "Confirm your identity before you can publish as this Page"): detect
  // it the moment it appears — BEFORE any reload/fast-path can dismiss it — and surface a HARD
  // account block so the server auto-blacklists this profile (it cannot publish until resolved).
  {
    const publishBlock = await detectPublishBlockDialog(page);
    if (publishBlock.blocked) {
      // Emit the SAME step the server's livePostLogValidation keys off (facebook_account_status_blocked)
      // so validation.facebookAccountBlocked=true propagates and isHardAccountBlockOutcome quarantines
      // this profile. (Emitting a custom step name left the flag false and the profile was re-picked.)
      console.log(JSON.stringify({ step: 'facebook_account_status_blocked', stage: 'post_submit_publish_block', accountBlocked: true, accountBlockReason: publishBlock.reason, snippet: publishBlock.snippet }));
      throw new Error(`facebook_account_suspended_or_disabled at post_submit: confirm your identity before you can publish as this Page (${publishBlock.reason})`);
    }
  }
  const composerStillOpen = await composerIsOpen(page).catch(() => false);
  const postTextStillInComposer = composerStillOpen && await waitForComposerText(page, payload.postText, 1500).catch(() => false);
  if (postTextStillInComposer) {
    const retryPostClick = await clickPostButton(page);
    console.log(JSON.stringify({ step: 'post_click_retry', ...retryPostClick }));
    if (!retryPostClick.clicked) {
      const retryComposerStillOpen = await composerIsOpen(page).catch(() => false);
      const retryPostTextStillInComposer = retryComposerStillOpen && await waitForComposerText(page, payload.postText, 1200).catch(() => false);
      const retryDiagnostic = retryPostClick.diagnostic || await facebookUiSnapshot(page);
      console.log(JSON.stringify({ step: 'post_button_retry_diagnostic', diagnostic: retryDiagnostic }));
      if (!retryComposerStillOpen || !retryPostTextStillInComposer) {
        console.log(JSON.stringify({
          step: 'post_click_retry_assumed_submitted',
          reason: 'composer_closed_or_text_cleared_after_initial_post_click',
          composerStillOpen: retryComposerStillOpen,
          postTextStillInComposer: retryPostTextStillInComposer,
        }));
      } else {
        throw new Error('could not click Post after retry');
      }
    }
  }

  // Fast-path check: if FB's GraphQL response after the Post click already
  // contains a fresh permalink for this group, we have everything we need and
  // can skip the 10s+reload+publisher_self_page loop (saves 30-90s).
  await humanPause(2500, 3500);
  const fastPathCaptureCheck = (() => {
    const postClickedAtMs = Number(postClickedAt) || 0;
    const ids = [];
    for (const row of captured) {
      if (postClickedAtMs && row.at && row.at < postClickedAtMs) continue;
      // CONCURRENCY: only trust a post id from a network response that carried THIS post's
      // own caption (row.marker). With 3 profiles posting at once, each browser's feed
      // responses also contain the OTHER workers' fresh posts; without this, the "newest id"
      // would grab another worker's post (collision). Their posts carry a DIFFERENT caption
      // (caption-dedup guarantees distinct captions within the concurrent batch), so they are
      // skipped here. (Re-capturing an OLD same-caption post only happens when the same
      // products are re-posted rapidly so their old posts linger in the feed — a test
      // artifact; in prod, fresh products + 550 rotating captions keep this caption unique
      // in the recent feed.)
      if (!row.marker) continue;
      for (const u of row.urls || []) {
        const m = String(u || '').match(/\/groups\/(\d+)\/permalink\/(\d{15,19})\/?/);
        if (m && m[1] === String(gid)) ids.push(m[2]);
      }
    }
    if (!ids.length) return null;
    const newest = ids.reduce((a, b) => (BigInt(a) > BigInt(b) ? a : b));
    return `https://www.facebook.com/groups/${gid}/permalink/${newest}/`;
  })();
  const skipRefreshAndSelfPage = Boolean(fastPathCaptureCheck);
  let beforeRefreshUrl = page.url();
  if (skipRefreshAndSelfPage) {
    console.log(JSON.stringify({
      step: 'post_submit_fast_path_capture_found',
      capturedUrl: fastPathCaptureCheck,
      capturedCount: captured.length,
      reason: 'skip_refresh_and_publisher_self_page_loop',
    }));
  } else {
    await humanPause(7000, 8500);
    beforeRefreshUrl = page.url();
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(async () => {
      await page.goto(payload.groupUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    });
    await humanPause(3000, 5000);
    await ensureFacebookLoggedIn(page, payload, 'post_submit_refresh_check');
  }
  logTiming('after_post_submit_refresh_or_fast_path');
  console.log(JSON.stringify({
    step: 'post_submit_refresh_check',
    fastPathCaptureFound: skipRefreshAndSelfPage,
    beforeRefreshUrl,
    afterRefreshUrl: page.url(),
    title: await page.title().catch(() => ''),
    capturedCount: captured.length,
  }));

  // Determine the publisher's effective posting identity. FB profiles often
  // post AS a Page attached to the account (the page's user ID is different
  // from the personal c_user cookie). Prefer the COMPOSER ACTOR's user ID
  // (whoever the post was created as) over c_user.
  const cUserId = String(payload.facebookUserId || payload.publisherFacebookUserId || '').replace(/\D+/g, '');
  let composerActorUserId = '';
  let composerActorLabel = '';
  let composerActorConfidence = 'none';
  if (Array.isArray(publisherGroupUserCandidates) && publisherGroupUserCandidates.length) {
    const numericCandidates = publisherGroupUserCandidates.filter((c) => /^\d{6,}$/.test(String(c?.userId || '').replace(/\D+/g, '')));
    // Tier 1: candidate boosted by composer-actor match (best signal)
    const tier1 = numericCandidates
      .filter((c) => /composer|image_attached|post_submit_refresh_page|payload|composer_actor_match/i.test(String(c?.source || '')) || Number(c?.score || 0) >= 1000)
      .sort((a, b) => Number(b?.score || 0) - Number(a?.score || 0))[0];
    if (tier1) {
      composerActorUserId = String(tier1.userId).replace(/\D+/g, '');
      composerActorLabel = String(tier1.label || '');
      composerActorConfidence = 'composer_actor_or_payload_high_score';
    } else {
      // Tier 2: highest-score visible group-page candidate (often a Page that
      // the publisher uses to post). Better than c_user when c_user shows nothing.
      const tier2 = numericCandidates
        .filter((c) => Number(c?.score || 0) >= 50)
        .sort((a, b) => Number(b?.score || 0) - Number(a?.score || 0))[0];
      if (tier2) {
        composerActorUserId = String(tier2.userId).replace(/\D+/g, '');
        composerActorLabel = String(tier2.label || '');
        composerActorConfidence = 'top_visible_page_candidate_fallback';
      }
    }
  }
  // Effective publisher ID for the group-user URL: prefer composer actor (page)
  // since posts in FB groups default to posting AS the attached Page, not the
  // personal profile. The composer actor's user ID is what /groups/{gid}/user/X/
  // will show our new post under. Fall back to c_user only if composer actor
  // wasn't detected.
  const publisherUserIdForUrl = composerActorUserId || cUserId;
  console.log(JSON.stringify({
    step: 'publisher_identity_resolved',
    cUserId,
    composerActorUserId,
    composerActorLabel,
    composerActorConfidence,
    chose: composerActorUserId ? 'composer_actor_or_top_candidate' : 'c_user_personal',
    publisherUserIdForUrl,
  }));
  // Update payload so admin approval and downstream code use the page ID too.
  if (publisherUserIdForUrl) {
    payload.publisherFacebookUserId = publisherUserIdForUrl;
  }
  let publisherSelfPagePermalinks = [];
  let publisherSelfPageMarkerVisible = false;
  let publisherSelfPageAttempts = 0;
  let newestPostPermalink = '';
  let newestPostMeta = null;
  if (skipRefreshAndSelfPage) {
    console.log(JSON.stringify({
      step: 'post_submit_publisher_self_page_skipped',
      reason: 'fast_path_capture_already_has_permalink',
    }));
  } else if (publisherUserIdForUrl && /^\d{6,}$/.test(publisherUserIdForUrl)) {
    const selfPageUrl = `https://www.facebook.com/groups/${gid}/user/${publisherUserIdForUrl}/`;
    const MAX_SELF_PAGE_ATTEMPTS = 4;
    const SELF_PAGE_RETRY_WAITS_MS = [0, 15000, 20000, 25000];
    for (let attempt = 1; attempt <= MAX_SELF_PAGE_ATTEMPTS; attempt += 1) {
      publisherSelfPageAttempts = attempt;
      const waitBeforeMs = SELF_PAGE_RETRY_WAITS_MS[attempt - 1] || 20000;
      if (waitBeforeMs > 0) await page.waitForTimeout(waitBeforeMs);
      try {
        await page.goto(selfPageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await ensureFacebookLoggedIn(page, payload, 'post_submit_publisher_self_page');
        await humanPause(3500, 5500);
        const topmostArticle = await page.evaluate(({ gid }) => {
          const visible = (el) => {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return r.width > 80 && r.height > 80 && s.visibility !== 'hidden' && s.display !== 'none';
          };
          const articles = [...document.querySelectorAll('[role="article"]')]
            .filter(visible)
            .map((el) => ({ el, top: el.getBoundingClientRect().top }))
            .sort((a, b) => a.top - b.top);
          for (const { el } of articles) {
            const permalinkRe = new RegExp(`/groups/${gid}/(?:permalink|posts)/(\\d+)`);
            const links = [...el.querySelectorAll('a[href]')]
              .map((a) => a.href || '')
              .filter((h) => permalinkRe.test(h));
            if (!links.length) continue;
            const permalink = links[0].split('?')[0];
            const m = permalink.match(permalinkRe);
            const postId = m ? m[1] : '';
            const timestampSpans = [...el.querySelectorAll('a span, time, [data-tooltip-content]')]
              .map((s) => (s.innerText || s.getAttribute('title') || s.getAttribute('data-tooltip-content') || '').replace(/\s+/g, ' ').trim())
              .filter(Boolean)
              .slice(0, 6);
            return {
              permalink,
              postId,
              timestamps: timestampSpans,
              textPreview: (el.innerText || '').replace(/\s+/g, ' ').slice(0, 220),
              articleCount: articles.length,
            };
          }
          return null;
        }, { gid }).catch(() => null);
        if (topmostArticle && topmostArticle.permalink) {
          newestPostPermalink = topmostArticle.permalink;
          newestPostMeta = topmostArticle;
        }
        publisherSelfPageMarkerVisible = await page.evaluate((m) => {
          try { return Boolean(m && (document.body.innerText || '').includes(m)); } catch { return false; }
        }, marker).catch(() => false);
        publisherSelfPagePermalinks = await extractMarkerScopedPostUrls(page, gid, marker).catch(() => []);
        if (!publisherSelfPagePermalinks.length) {
          const domSelf = await extractDomUrls(page, gid, marker).catch(() => []);
          publisherSelfPagePermalinks = [...new Set(domSelf)];
        }
        if (newestPostPermalink && !publisherSelfPagePermalinks.includes(newestPostPermalink)) {
          publisherSelfPagePermalinks.unshift(newestPostPermalink);
        }
        console.log(JSON.stringify({
          step: 'post_submit_publisher_self_page',
          selfPageUrl,
          attempt,
          markerVisible: publisherSelfPageMarkerVisible,
          permalinksFound: publisherSelfPagePermalinks.length,
          permalinks: publisherSelfPagePermalinks.slice(0, 6),
          newestPostPermalink,
          newestPostMeta: newestPostMeta ? { postId: newestPostMeta.postId, timestamps: newestPostMeta.timestamps, articleCount: newestPostMeta.articleCount, textPreviewStart: (newestPostMeta.textPreview || '').slice(0, 80) } : null,
        }));
        if (newestPostPermalink || publisherSelfPageMarkerVisible || publisherSelfPagePermalinks.length > 0) break;
      } catch (err) {
        console.log(JSON.stringify({ step: 'post_submit_publisher_self_page_error', selfPageUrl, attempt, error: err?.message || String(err) }));
      }
    }
    await page.goto(payload.groupUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await humanPause(1500, 2500);
    // If self-page returned NO permalinks (pending posts are hidden from
    // publisher's contributions, OR account is fresh), ALSO scan the group's
    // chronological main feed for the topmost article authored by our user id.
    if (!newestPostPermalink && publisherSelfPagePermalinks.length === 0) {
      const feedUrl = `${String(payload.groupUrl || '').replace(/[?#].*$/, '').replace(/\/+$/, '')}/?sorting_setting=CHRONOLOGICAL`;
      try {
        await page.goto(feedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await ensureFacebookLoggedIn(page, payload, 'post_submit_group_feed_fallback');
        await humanPause(4000, 6000);
        await page.mouse.wheel(0, 600).catch(() => {});
        await humanPause(1500, 2500);
        const feedNewest = await page.evaluate(({ gid, publisherId }) => {
          const visible = (el) => {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return r.width > 50 && r.height > 50 && s.visibility !== 'hidden' && s.display !== 'none';
          };
          const articles = [...document.querySelectorAll('[role="article"], [data-pagelet*="FeedUnit"]')]
            .filter(visible)
            .map((el) => ({ el, top: el.getBoundingClientRect().top }))
            .sort((a, b) => a.top - b.top);
          for (const { el } of articles) {
            const authorLinks = [...el.querySelectorAll('a[href]')].filter((a) => {
              const h = String(a.href || '');
              return h.includes(`/groups/${gid}/user/${publisherId}/`) || h.includes(`profile.php?id=${publisherId}`);
            });
            if (!authorLinks.length) continue;
            const permalinkRe = new RegExp(`/groups/${gid}/(?:permalink|posts)/(\\d+)`);
            const links = [...el.querySelectorAll('a[href]')].map((a) => a.href || '').filter((h) => permalinkRe.test(h));
            if (!links.length) continue;
            const permalink = links[0].split('?')[0];
            const m = permalink.match(permalinkRe);
            return { permalink, postId: m ? m[1] : '', textPreview: (el.innerText || '').replace(/\s+/g, ' ').slice(0, 220) };
          }
          return null;
        }, { gid, publisherId: publisherUserIdForUrl }).catch(() => null);
        if (feedNewest && feedNewest.permalink) {
          newestPostPermalink = feedNewest.permalink;
          newestPostMeta = feedNewest;
          publisherSelfPagePermalinks.unshift(feedNewest.permalink);
        }
        console.log(JSON.stringify({
          step: 'post_submit_group_feed_fallback',
          feedUrl,
          found: Boolean(feedNewest && feedNewest.permalink),
          permalink: feedNewest?.permalink || '',
          postId: feedNewest?.postId || '',
          textPreview: feedNewest?.textPreview || '',
        }));
      } catch (err) {
        console.log(JSON.stringify({ step: 'post_submit_group_feed_fallback_error', error: err?.message || String(err) }));
      }
      await page.goto(payload.groupUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await humanPause(1500, 2500);
    }
  } else {
    console.log(JSON.stringify({ step: 'post_submit_publisher_self_page_skipped', reason: 'no_known_publisher_user_id' }));
  }

  let postPublishWarning = '';
  publisherGroupUserCandidates = mergeGroupUserCandidates(
    publisherGroupUserCandidates,
    await extractVisibleGroupUserCandidates(page, gid, marker, 'post_submit_refresh_page'),
  );
  const afterDomUrls = await extractDomUrls(page, gid, marker).catch((err) => {
    postPublishWarning = err?.message || String(err);
    return [];
  });
  const domNew = afterDomUrls.filter(u => !beforeDomUrls.includes(u));
  const markerScopedUrls = await extractMarkerScopedPostUrls(page, gid, marker);

  const candidateUrls = new Map();
  const addCandidateUrl = (url, source = 'unknown', priority = 50) => {
    const clean = String(url || '').split('?')[0];
    if (!isFacebookGroupPostUrl(clean, gid)) return;
    const existing = candidateUrls.get(clean);
    if (!existing || priority < existing.priority) {
      candidateUrls.set(clean, { source, priority });
    }
  };
  publisherSelfPagePermalinks.forEach(url => addCandidateUrl(url, 'publisher_self_page', 1));
  domNew.forEach(url => addCandidateUrl(url, 'dom_new', 10));
  markerScopedUrls.forEach(url => addCandidateUrl(url, 'marker_scoped', 20));
  const groupUserDiscovery = await discoverPostUrlsFromGroupUserPages(page, payload, gid, marker, publisherGroupUserCandidates, {
    budgetMs: 90000,
    maxCandidates: 3,
    maxAttempts: 2,
  })
    .catch((err) => ({
      error: err?.message || String(err),
      candidates: publisherGroupUserCandidates.slice(0, 8),
      selected: [],
      visited: [],
      found: [],
      urls: [],
    }));
  for (const item of groupUserDiscovery.found || []) {
    addCandidateUrl(item.url, item.source || 'group_user_marker_scoped', item.priority || 5);
  }
  const knownUserIds = new Set([
    String(payload.facebookUserId || '').replace(/\D+/g, ''),
    String(payload.publisherFacebookUserId || '').replace(/\D+/g, ''),
    ...publisherGroupUserCandidates.map(item => String(item?.userId || '').replace(/\D+/g, '')),
    ...captured.flatMap(row => Array.isArray(row?.userIds) ? row.userIds.map(id => String(id || '').replace(/\D+/g, '')) : []),
  ].filter(id => /^\d{6,}$/.test(id)));
  for (const row of captured) {
    for (const u of row.urls || []) addCandidateUrl(u, row.marker ? 'captured_marker_response' : 'captured_response', row.marker ? 0 : 80);
    if (row.marker) {
      for (const id of (row.ids || []).slice(0, 8)) {
        const cleanId = String(id || '').replace(/\D+/g, '');
        if (!/^\d{15,19}$/.test(cleanId)) continue;
        if (cleanId === gid) continue;
        if (knownUserIds.has(cleanId)) continue;
        if (/^(100\d{12}|122\d{12,16})$/.test(cleanId)) continue;
        addCandidateUrl(`https://www.facebook.com/groups/${gid}/permalink/${cleanId}/`, 'captured_marker_response_id_filtered', 14);
      }
    }
  }

  // Highest-ID candidate from captured network responses is the FRESHLY CREATED
  // post (FB returns it right after Post click). Boost its priority so it is
  // tried BEFORE older posts that happen to share marker text. Self-page may
  // return older posts of the same Page that have similar text from rotation -
  // this guard makes sure the new post always wins.
  //
  // SAFETY: only consider responses received AFTER the Post button click. This
  // rejects pre-click captures from the initial feed render that might have
  // referenced older group posts with similar text.
  const capturedPostIds = [];
  for (const row of captured) {
    if (postClickedAt && row.at && row.at < postClickedAt) continue;
    // CONCURRENCY: same own-caption guard as the fast-path above — only this worker's own
    // post id (its response carried our caption), never a concurrent sibling's post.
    if (!row.marker) continue;
    for (const u of row.urls || []) {
      const idMatch = String(u || '').match(/\/permalink\/(\d{15,19})\/?/);
      if (idMatch) capturedPostIds.push(idMatch[1]);
    }
  }
  const allCandidateMaxId = (() => {
    let max = '';
    for (const u of candidateUrls.keys()) {
      const m = u.match(/\/permalink\/(\d{15,19})\/?/);
      if (m && (!max || BigInt(m[1]) > BigInt(max))) max = m[1];
    }
    return max;
  })();
  const newestCapturedId = capturedPostIds.length
    ? capturedPostIds.reduce((a, b) => (BigInt(a) > BigInt(b) ? a : b))
    : '';
  let trustedNewestCapturedUrl = '';
  if (newestCapturedId && newestCapturedId === allCandidateMaxId) {
    trustedNewestCapturedUrl = `https://www.facebook.com/groups/${gid}/permalink/${newestCapturedId}/`;
    candidateUrls.set(trustedNewestCapturedUrl, { source: 'newest_captured_post_id', priority: 0 });
    console.log(JSON.stringify({
      step: 'newest_captured_post_id_boosted',
      url: trustedNewestCapturedUrl,
      postId: newestCapturedId,
      reason: 'highest_post_id_across_all_candidates_assumed_freshly_created',
      trustedAsVerified: true,
    }));
  }

  if (captured.length) {
    console.log(JSON.stringify({
      step: 'post_submit_network_capture',
      capturedCount: captured.length,
      captured: captured.slice(0, 8),
      candidateCount: candidateUrls.size,
    }));
  }

  if (!candidateUrls.size) {
    // The post IS live — FB just hasn't surfaced it on the feed/self-page yet at the
    // instant we first looked. Mirror a human REFRESH: reload the chronological feed
    // and the publisher's own group page, WAIT for FB to propagate, then re-scan for
    // our post. The previous logic only re-extracted from the stale current page
    // (no reload), so it kept finding nothing and the post was wrongly declared
    // "pending" -> sent to a ~6min moderator approval that then found nothing to
    // approve (the post was already live). This refresh-and-recheck is exactly the
    // manual refresh that proves the post is there.
    const groupBaseRecheck = String(payload.groupUrl || '').replace(/[?#].*$/, '').replace(/\/+$/, '');
    const recheckTargets = [
      `${groupBaseRecheck}/?sorting_setting=CHRONOLOGICAL`,
      publisherUserIdForUrl ? `${groupBaseRecheck}/user/${publisherUserIdForUrl}/` : '',
    ].filter(Boolean);
    for (let attempt = 1; attempt <= 3 && !candidateUrls.size && !newestPostPermalink; attempt += 1) {
      await humanPause(9000, 13000); // allow FB time to propagate the freshly created post
      for (const target of recheckTargets) {
        if (candidateUrls.size || newestPostPermalink) break;
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        await ensureFacebookLoggedIn(page, payload, 'post_submit_refresh_recheck').catch(() => {});
        await humanPause(3500, 5500);
        await page.mouse.wheel(0, 700).catch(() => {});
        await humanPause(1500, 2500);
        // Topmost in-group article authored by our publisher = the freshly created post.
        const recheckTopmost = await page.evaluate(({ gid, publisherId }) => {
          const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 50 && r.height > 50 && s.visibility !== 'hidden' && s.display !== 'none'; };
          const articles = [...document.querySelectorAll('[role="article"], [data-pagelet*="FeedUnit"]')].filter(visible).map((el) => ({ el, top: el.getBoundingClientRect().top })).sort((a, b) => a.top - b.top);
          const permalinkRe = new RegExp(`/groups/${gid}/(?:permalink|posts)/(\\d+)`);
          for (const { el } of articles) {
            if (publisherId) {
              const byPublisher = [...el.querySelectorAll('a[href]')].some((a) => { const h = String(a.href || ''); return h.includes(`/groups/${gid}/user/${publisherId}/`) || h.includes(`profile.php?id=${publisherId}`); });
              if (!byPublisher) continue;
            }
            const link = [...el.querySelectorAll('a[href]')].map((a) => a.href || '').find((h) => permalinkRe.test(h));
            if (link) return link.split('?')[0];
          }
          return '';
        }, { gid, publisherId: publisherUserIdForUrl }).catch(() => '');
        // Trust the topmost ONLY if it is a post that is NEW since before we clicked
        // Post (not a pre-existing post of the same publisher) — cannot grab an old post.
        if (recheckTopmost && isFacebookGroupPostUrl(recheckTopmost, gid) && !beforeDomUrls.includes(recheckTopmost)) {
          newestPostPermalink = recheckTopmost;
          newestPostMeta = { permalink: recheckTopmost, source: 'post_submit_refresh_recheck_topmost', attempt };
          addCandidateUrl(recheckTopmost, 'refresh_recheck_topmost', 2);
        }
        const recheckMarkerScoped = await extractMarkerScopedPostUrls(page, gid, marker).catch(() => []);
        const recheckDomUrls = await extractDomUrls(page, gid, marker).catch(() => []);
        recheckMarkerScoped.forEach(url => addCandidateUrl(url, 'refresh_recheck_marker_scoped', 6));
        recheckDomUrls.forEach(url => addCandidateUrl(url, 'refresh_recheck_dom', 12));
        console.log(JSON.stringify({ step: 'post_submit_refresh_recheck', attempt, target, topmostNew: Boolean(newestPostPermalink), candidateCount: candidateUrls.size }));
      }
    }
  }

  const verified = [];
  const candidateVerificationAttempts = [];
  const imageRequired = Boolean(String(payload.imagePath || '').trim());
  // COLLISION FIX: the self-page TOPMOST article and the HIGHEST-captured-id are strong hints of
  // our new post, but they are NOT proof — when profiles share a Page identity (or two sibling
  // products post within ~1s), the topmost/highest-id post can be a SIBLING's. The old code
  // PUSHED them into verified[] with FABRICATED hasMarker/exactPermalink flags and then SKIPPED
  // verification — which let a sibling's URL through (two workers captured one post). Now we add
  // them as HIGH-PRIORITY CANDIDATES that MUST pass verifyCandidate below (which loads the exact
  // permalink and confirms THIS worker's UNIQUE marker is on the body). A sibling's permalink
  // carries a different marker -> rejected -> we fall through to find/verify our own post.
  if (newestPostPermalink) {
    const cleanNp = String(newestPostPermalink).split('?')[0];
    const ex = candidateUrls.get(cleanNp);
    if (!ex || ex.priority > 0) candidateUrls.set(cleanNp, { source: 'publisher_self_page_topmost_article', priority: 0 });
    console.log(JSON.stringify({ step: 'candidate_seed_from_newest_post', candidate: cleanNp, reason: 'self_page_topmost_must_verify_marker_on_permalink' }));
  }
  if (trustedNewestCapturedUrl) {
    // (already added to candidateUrls at priority 0 where it was computed) — do NOT fabricate a
    // verified entry; it must pass the real marker-on-permalink verification below.
    console.log(JSON.stringify({ step: 'captured_id_seed_must_verify', candidate: trustedNewestCapturedUrl, reason: 'highest_captured_id_can_be_a_sibling_post_under_shared_page' }));
  }
  const sortedCandidateUrls = [...candidateUrls.entries()]
    .sort((a, b) => a[1].priority - b[1].priority)
    .map(([url, meta]) => ({ url, ...meta }));
  const maxVerificationCandidates = captured.length ? 12 : 15;
  const verifyStartedAt = Date.now();
  const VERIFY_LOOP_BUDGET_MS = 240000;
  let verifyBudgetExceeded = false;
  const hasHighConfidenceCandidates = sortedCandidateUrls.some((c) => c.priority < 30);
  const publisherSelfPageEmpty = publisherUserIdForUrl && publisherSelfPagePermalinks.length === 0;
  // Only skip if we ALREADY have a trusted verified candidate. Don't skip just
  // because the self-page is empty - captured network URLs may contain the
  // actual new post permalink that we should verify.
  const skipVerificationLoop = (verified.length > 0);
  if (skipVerificationLoop) {
    console.log(JSON.stringify({
      step: 'candidate_verification_skipped',
      reason: 'already_have_strong_marker_verified_candidate',
      verifiedCount: verified.length,
      selfPageUserId: publisherUserIdForUrl,
      sortedCandidateCount: sortedCandidateUrls.length,
      sources: [...new Set(sortedCandidateUrls.map((c) => c.source))],
      message: 'A candidate already passed strong body-marker verification; skipping the rest of the verification loop.',
    }));
  }
  console.log(JSON.stringify({ step: 'candidate_verification_started', total: skipVerificationLoop ? 0 : Math.min(sortedCandidateUrls.length, maxVerificationCandidates), imageRequired, budgetMs: VERIFY_LOOP_BUDGET_MS, skipped: skipVerificationLoop, trustedVerifiedCount: verified.length }));
  const candidatesToVerify = skipVerificationLoop ? [] : sortedCandidateUrls.slice(0, maxVerificationCandidates);
  for (const { url: u, source, priority } of candidatesToVerify) {
    const elapsed = Date.now() - verifyStartedAt;
    if (elapsed > VERIFY_LOOP_BUDGET_MS) {
      verifyBudgetExceeded = true;
      console.log(JSON.stringify({ step: 'candidate_verification_budget_exceeded', elapsedMs: elapsed, budgetMs: VERIFY_LOOP_BUDGET_MS, remaining: sortedCandidateUrls.length - candidateVerificationAttempts.length }));
      break;
    }
    let v;
    try {
      v = await verifyCandidateWithRetry(context, u, marker, { imageRequired, attempts: imageRequired ? 4 : 3, requireStrongMarker: true });
    } catch (err) {
      v = { url: u, error: err?.message || String(err) };
      console.log(JSON.stringify({ step: 'candidate_verification_error', candidate: u, source, priority, error: v.error.slice(0, 400) }));
    }
    candidateVerificationAttempts.push({
      candidate: u,
      source,
      priority,
      attempts: v.verificationAttempts || [summarizeCandidateVerification(v, u)],
      best: summarizeCandidateVerification(v, u),
    });
    console.log(JSON.stringify({ step: 'candidate_verified', candidate: u, source, priority, hasMarker: Boolean(v.hasMarker), bodyHasMarker: Boolean(v.bodyHasMarker), titleHasMarker: Boolean(v.titleHasMarker), exactPermalink: Boolean(v.exactPermalink), hasPostMedia: Boolean(v.hasPostMedia), error: v.error || '', attemptsRun: Array.isArray(v.verificationAttempts) ? v.verificationAttempts.length : 1, elapsedMs: Date.now() - verifyStartedAt }));
    // IMAGE-ID MATCH (verification phase): does this candidate's rendered post image carry one
    // of OUR uploaded photo ids? Our own post should match; another worker's / an old post
    // should NOT. Logged now so a live test confirms the signal before we gate capture on it.
    const candSrcIds = Array.isArray(v.postMedia) ? [...new Set(v.postMedia.flatMap(m => Array.isArray(m.srcIds) ? m.srcIds : []))] : [];
    const imageIdMatch = uploadedPhotoIds.filter(id => candSrcIds.includes(id));
    console.log(JSON.stringify({ step: 'candidate_image_id_check', candidate: u, uploadedPhotoIdCount: uploadedPhotoIds.length, sampleUploadedIds: uploadedPhotoIds.slice(0, 6), candidateSrcIds: candSrcIds.slice(0, 10), imageIdMatch, imageMatches: imageIdMatch.length > 0 }));
    if (candidateHasStrongPermalinkMarker(v) && (!imageRequired || v.hasPostMedia || v.hasMarker || v.bodyHasMarker || v.titleHasMarker)) {
      verified.push({ candidate: u, source, priority, ...v });
    }
    if (candidateHasStrongPermalinkMarker(v) && (!imageRequired || v.hasPostMedia || v.hasMarker || v.bodyHasMarker || v.titleHasMarker) && isFacebookGroupPostUrl(u, gid)) break;
  }
  console.log(JSON.stringify({ step: 'candidate_verification_finished', verified: verified.length, attempted: candidateVerificationAttempts.length, elapsedMs: Date.now() - verifyStartedAt, budgetExceeded: verifyBudgetExceeded }));

  // FINAL refresh-and-RE-VERIFY: if NOTHING verified yet, the post is almost certainly
  // LIVE but FB simply hasn't rendered it on its permalink yet at the instant we checked
  // — this is the #1 cause of a FALSE "pending" -> wasted ~6min moderator approval
  // (operator confirmed: a manual page refresh shows the post live). Mirror that refresh:
  // wait for FB to propagate, reload the feed/self-page to (re)discover our post URL, and
  // RE-VERIFY the top candidates with fresh render time. Everything here is marker-checked
  // (verifyCandidateWithRetry + candidateHasStrongPermalinkMarker) so it can never trust
  // the wrong post. Hard-capped so it can never run long / slow the box.
  if (!verified.length) {
    const groupBaseReverify = String(payload.groupUrl || '').replace(/[?#].*$/, '').replace(/\/+$/, '');
    const reverifyTargets = [
      `${groupBaseReverify}/?sorting_setting=CHRONOLOGICAL`,
      publisherUserIdForUrl ? `${groupBaseReverify}/user/${publisherUserIdForUrl}/` : '',
    ].filter(Boolean);
    const reverifyStartedAt = Date.now();
    const REVERIFY_BUDGET_MS = 120000;
    for (let pass = 1; pass <= 3 && !verified.length && (Date.now() - reverifyStartedAt) < REVERIFY_BUDGET_MS; pass += 1) {
      await humanPause(10000, 14000); // give FB time to render the new post on its permalink
      for (const target of reverifyTargets) {
        if (verified.length) break;
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        await ensureFacebookLoggedIn(page, payload, 'post_submit_reverify').catch(() => {});
        await humanPause(2500, 4000);
        await page.mouse.wheel(0, 700).catch(() => {});
        const reMarker = await extractMarkerScopedPostUrls(page, gid, marker).catch(() => []);
        const reDom = await extractDomUrls(page, gid, marker).catch(() => []);
        reMarker.forEach(url => addCandidateUrl(url, 'reverify_marker_scoped', 6));
        reDom.forEach(url => addCandidateUrl(url, 'reverify_dom', 12));
      }
      const reverifyUrls = [...candidateUrls.entries()].sort((a, b) => a[1].priority - b[1].priority).map(([url]) => url).filter(url => isFacebookGroupPostUrl(url, gid)).slice(0, 5);
      for (const u of reverifyUrls) {
        if (verified.length) break;
        let rv;
        try {
          rv = await verifyCandidateWithRetry(context, u, marker, { imageRequired, attempts: imageRequired ? 4 : 3, requireStrongMarker: true });
        } catch (err) { rv = { url: u, error: err?.message || String(err) }; }
        if (candidateHasStrongPermalinkMarker(rv) && (!imageRequired || rv.hasPostMedia || rv.hasMarker || rv.bodyHasMarker || rv.titleHasMarker)) {
          verified.push({ candidate: u, source: 'post_submit_reverify', ...rv });
        }
      }
      console.log(JSON.stringify({ step: 'post_submit_reverify', pass, verified: verified.length, candidateCount: candidateUrls.size, elapsedMs: Date.now() - reverifyStartedAt }));
    }
  }

  // Target the verified permalink first so the first comment lands on the post
  // that was just created, not another visible group item.
  let commentResult = { skipped: !payload.commentText, clicked: false, typed: false, submitted: false, verified: false };
  let postPageUrl = verified[0]?.candidate || verified[0]?.url || '';
  if (payload.commentText) {
    try {
      if (!postPageUrl) {
        commentResult = {
          skipped: false,
          clicked: false,
          typed: false,
          submitted: false,
          verified: false,
          blocked: true,
          blockReason: 'verified_post_permalink_required_before_comment',
          restrictionText: 'Comment was not attempted because the new post permalink was not verified.',
        };
      } else {
        // OPTION B: try commenting in-place on the group page first - the
        // post we just published is at the top of the feed and our marker
        // text is unique, so submitCommentOnVisiblePost can scope to it
        // without the URL check. Saves the 35-40s permalink navigate.
        const postParts = facebookGroupPostParts(postPageUrl);
        const currentUrlBeforeComment = page.url();
        // Accept any URL under /groups/{gid}/ - group page, user page (publisher
        // Contributions), or even the permalink itself - all show our marker
        // article and let us comment in place. Saves the 35-40s permalink
        // navigate when we're already on a group-scoped surface.
        const onGroupContext = Boolean(postParts && currentUrlBeforeComment.match(new RegExp(`/groups/${postParts.groupId}(?:/|\\?|#|$)`)));
        console.log(JSON.stringify({ step: 'comment_phase_diagnostic', postPageUrl, postParts, currentUrlBeforeComment, onGroupContext }));
        let usedInPlace = false;
        if (onGroupContext) {
          // PHASE 7: if we're on /groups/{gid}/user/{uid}/ (Contributions) or
          // similar, navigate to the GROUP FEED first. FB doesn't show fresh
          // posts on Contributions for several seconds/minutes, but the group
          // feed shows our just-posted article at the top. This lets the
          // marker-article pre-check fire and the in-place comment save the
          // 30-35s permalink navigate.
          // Quick check FIRST: is marker already in an article on CURRENT page?
          // If yes, no need to navigate (save 12s). If no, try navigating to
          // group feed where the post might be at top.
          const markerArticleOnCurrentPage = await page.evaluate((m) => {
            if (!m) return false;
            const articles = document.querySelectorAll('[role="article"]');
            for (const a of articles) {
              const text = (a.innerText || '').replace(/\s+/g, ' ');
              if (text.includes(m)) return true;
            }
            return false;
          }, marker).catch(() => false);
          const groupFeedRe = new RegExp(`/groups/${postParts.groupId}/?(\\?|#|$)`);
          const onGroupFeed = groupFeedRe.test(currentUrlBeforeComment);
          if (!markerArticleOnCurrentPage && !onGroupFeed && payload.groupUrl) {
            await page.goto(payload.groupUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await humanPause(800, 1500);
            console.log(JSON.stringify({ step: 'comment_pre_navigate_to_group_feed', from: currentUrlBeforeComment, to: page.url() }));
          }
          // FAST pre-check: only attempt in-place if our marker article is
          // already in the DOM as a proper [role="article"] container. Loose
          // body-text matches were clicking the wrong post (deal-alert text
          // is common). Strict article match prevents wrong-post clicks.
          await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
          const markerVisibleNow = await page.evaluate((m) => {
            if (!m) return false;
            const articles = document.querySelectorAll('[role="article"]');
            for (const a of articles) {
              const text = (a.innerText || '').replace(/\s+/g, ' ');
              if (text.includes(m)) return true;
            }
            return false;
          }, marker).catch(() => false);
          if (markerVisibleNow) {
            await humanPause(300, 700);
            logTiming('after_comment_permalink_navigate');
            const inPlace = await submitCommentOnVisiblePost(page, marker, payload.commentText, '');
            if (inPlace.verified) {
              commentResult = inPlace;
              usedInPlace = true;
              console.log(JSON.stringify({ step: 'comment_in_place_succeeded', reason: 'skipped_permalink_navigate', currentUrl: currentUrlBeforeComment }));
            } else {
              console.log(JSON.stringify({ step: 'comment_in_place_failed_fallback_to_permalink', reason: inPlace.blockReason || inPlace.verifyReason || 'in_place_did_not_verify' }));
            }
          } else {
            console.log(JSON.stringify({ step: 'comment_in_place_skipped_marker_not_visible', currentUrl: currentUrlBeforeComment }));
          }
        }
        if (!usedInPlace) {
          // Phase 8 (mobile FB) DISABLED by default - caused 14min regression
          // in testing (likely UA-mismatch issues with IXBrowser profile).
          // Set FB_USE_MOBILE_COMMENT=1 explicitly to opt in.
          const useMobileForComment = process.env.FB_USE_MOBILE_COMMENT === '1';
          if (useMobileForComment) {
            const mobileLib = (() => { try { return require('./fb-mobile-comment'); } catch (_) { return null; } })();
            if (mobileLib && mobileLib.submitCommentOnMobilePermalink) {
              const mobileUrl = mobileLib.toMobileUrl(postPageUrl);
              const mobileStartedAt = Date.now();
              const mobileResult = await mobileLib.submitCommentOnMobilePermalink(page, marker, payload.commentText, mobileUrl);
              console.log(JSON.stringify({ step: 'mobile_comment_attempted', verified: mobileResult.verified, blocked: mobileResult.blocked, blockReason: mobileResult.blockReason, mobileRedirectedToDesktop: mobileResult.mobileRedirectedToDesktop, elapsedMs: Date.now() - mobileStartedAt, currentUrl: mobileResult.currentUrl }));
              if (mobileResult.verified) {
                commentResult = {
                  clicked: mobileResult.clicked,
                  typed: mobileResult.typed,
                  submitted: true,
                  verified: true,
                  verifiedNeedle: payload.commentText,
                  source: 'mobile_facebook',
                  mobileUrl,
                };
                logTiming('after_comment_permalink_navigate');
                logTiming('after_comment_attempted');
              }
            }
          }
          if (!commentResult.verified) {
            await page.goto(postPageUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
            await humanPause(300, 600);
            if (!onGroupContext) logTiming('after_comment_permalink_navigate');
            commentResult = await submitCommentOnVisiblePost(page, marker, payload.commentText, postPageUrl);
          }
        }
        await humanPause(100, 250);
      }
    } catch (err) {
      const message = err?.message || String(err);
      commentResult = {
        skipped: false,
        clicked: false,
        typed: false,
        submitted: false,
        verified: false,
        blocked: /not allowed|not permitted|comment|blocked|target page|context|browser has been closed/i.test(message),
        blockReason: /target page|context|browser has been closed/i.test(message) ? 'page_unavailable_during_comment' : 'comment_phase_error',
        restrictionText: message.slice(0, 1000),
      };
    }
  }
  if (!postPageUrl && commentResult.verified) {
    const postCommentScopedUrls = await extractMarkerScopedPostUrls(page, gid, marker);
    for (const u of postCommentScopedUrls) {
      const v = await verifyCandidate(context, u, marker).catch(e => ({ url: u, error: e.message }));
      if (candidateHasStrongPermalinkMarker(v)) {
        verified.push({ candidate: u, ...v, source: 'post_comment_marker_scoped' });
        postPageUrl = u;
        break;
      }
    }
  }
  const commentAttemptUrl = await page.evaluate(() => location.href).catch(() => page.url());
  console.log(JSON.stringify({ step: 'comment_attempted', commented: commentResult.submitted, ...commentResult, postPageUrl, currentUrl: commentAttemptUrl }));
  logTiming('after_comment_attempted');

  // If comment was posted in-place (Option B) we may be on the publisher's
  // user/contributions page or the group page. The pin step requires the
  // permalink page where the comment-actions menu renders. Navigate there
  // once before pin runs.
  if (payload.pinFirstComment !== false && payload.commentText && commentResult.verified && postPageUrl) {
    const beforePinUrl = await page.evaluate(() => location.href).catch(() => page.url());
    const beforePinParts = facebookGroupPostParts(beforePinUrl);
    const expectedPinParts = facebookGroupPostParts(postPageUrl);
    const onPermalinkForPin = beforePinParts && expectedPinParts &&
      beforePinParts.groupId === expectedPinParts.groupId &&
      beforePinParts.postId === expectedPinParts.postId;
    if (!onPermalinkForPin) {
      console.log(JSON.stringify({ step: 'pin_pre_navigate_to_permalink', from: beforePinUrl, to: postPageUrl }));
      await page.goto(postPageUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      // Wait for the comment text to appear on the permalink page before
      // pinVisibleComment scans for it. Without this, pin scans run on an
      // empty/skeleton permalink and find no comment article to pin.
      const commentNeedles = requiredCommentNeedles(payload.commentText || '');
      await page.waitForFunction((needles) => {
        const text = document.body?.innerText || '';
        return needles.some((needle) => text.includes(needle));
      }, commentNeedles, { timeout: 12000 }).catch(() => {});
      await humanPause(500, 1200);
    }
  }

  let commentPinResult = {
    requested: payload.pinFirstComment !== false && Boolean(payload.commentText),
    skipped: payload.pinFirstComment === false || !payload.commentText,
    menuOpened: false,
    clicked: false,
    confirmed: false,
    verified: false,
    reason: '',
  };
  if (commentPinResult.requested) {
    if (!commentResult.verified) {
      commentPinResult.reason = 'comment_not_verified_before_pin';
    } else {
      commentPinResult = await pinVisibleComment(page, payload.commentText).catch((err) => ({
        requested: true,
        menuOpened: false,
        clicked: false,
        confirmed: false,
        verified: false,
        reason: err?.message || String(err),
      }));
    }
  }
  console.log(JSON.stringify({ step: 'comment_pin_attempted', ...commentPinResult, postPageUrl }));
  logTiming('after_comment_pin_attempted');

  const publishedCommentCheck = await waitForPublishedCommentText(page, payload.commentText, 1200).catch((err) => ({
    verified: false,
    needle: '',
    reason: err?.message || String(err),
  }));
  const bodyChecks = await page.evaluate(({marker}) => {
    const text = document.body.innerText || '';
    return {
      markerVisible: text.includes(marker),
      ownControls: /Edit post|Delete post/.test(text),
    };
  }, {marker}).catch((err) => ({
    markerVisible: false,
    ownControls: false,
    error: err?.message || String(err),
  }));
  bodyChecks.commentVisible = Boolean(publishedCommentCheck.verified);
  bodyChecks.commentNeedle = publishedCommentCheck.needle || '';
  bodyChecks.commentVerifyReason = publishedCommentCheck.reason || '';
  logTiming('after_published_comment_check');

  console.log(JSON.stringify({
    step: 'result',
    marker,
    postUrl: postPageUrl,
    postPageUrl,
    bodyChecks,
    postPublishWarning,
    imageVerified: true,
    postMediaVerified: verified.some(item => item.hasPostMedia),
    postPermalinkVerified: verified.length > 0,
    markerPermalinkVerified: verified.some(item => candidateHasStrongPermalinkMarker(item)),
    titlePermalinkVerified: verified.some(item => item.titleHasMarker && item.exactPermalink),
    commentResult,
    commentPinResult,
    capturedCount: captured.length,
    captured: captured.slice(0, 10),
    domNew,
    markerScopedUrls,
    publisherGroupUserCandidates: publisherGroupUserCandidates.slice(0, 8),
    groupUserDiscovery,
    candidateSources: sortedCandidateUrls.slice(0, 20),
    maxVerificationCandidates,
    candidatePostUrls: sortedCandidateUrls.map(item => item.url).slice(0, 20),
    candidateVerificationAttempts,
    unverifiedCandidateUrls: sortedCandidateUrls.map(item => item.url).filter(url => !verified.some(item => item.candidate === url || item.url === url)).slice(0, 20),
    candidateCount: candidateUrls.size,
    verified,
  }, null, 2));

  } finally {
    // KEEP-OPEN (batch): payload.keepBrowserOpen is set ONLY by the batch poster path so the iX window
    // survives for a later cross-comment to reuse via connectOverCDP. browser.close() on a CDP-ATTACHED
    // browser closes the REMOTE iX window (not just the local handle), so we must NOT call it here for
    // keep-open runs — the server's batch teardown owns the eventual close. Default (no flag) = close, unchanged.
    if (browser && !payload.keepBrowserOpen) await browser.close().catch(() => {});
    else if (browser && payload.keepBrowserOpen) console.log(JSON.stringify({ step: 'ix_kept_open_for_batch', endpoint }));
  }
}

main().catch(e => { console.error(JSON.stringify({ step: 'error', message: e.message, stack: e.stack })); process.exit(1); });
