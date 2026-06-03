#!/usr/bin/env node
/*
 * Upload one customer-review image to the user's already-logged-in ChatGPT web
 * session, ask ChatGPT to make it HD/upright without changing the product, and
 * save the generated image to --output. This intentionally uses browser ChatGPT
 * (paid web account), not OpenAI API billing.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright-core');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[name] = true;
    else { out[name] = next; i += 1; }
  }
  return out;
}

async function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function dismissBlockingUi(page) {
  await page.keyboard.press('Escape').catch(() => {});
  const selectors = [
    'button[aria-label="Close"]',
    'button[aria-label="Dismiss"]',
    'button:has-text("Continue")',
    'button:has-text("Got it")',
    'button:has-text("Not now")',
    'button:has-text("Maybe later")',
    'button:has-text("Accept all")',
    'button:has-text("Skip")',
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).last();
    if (!await locator.count().catch(() => 0)) continue;
    try {
      if (await locator.isVisible({ timeout: 500 }).catch(() => false)) {
        await locator.click({ timeout: 1000 });
        await sleep(400);
      }
    } catch {}
  }
}

async function chatGptPageSnapshot(page) {
  return await page.evaluate(() => {
    const text = (document.body?.innerText || document.body?.textContent || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 2 && rect.height > 2 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const editors = Array.from(document.querySelectorAll('#prompt-textarea, [data-testid="prompt-textarea"], div[contenteditable="true"], textarea, [role="textbox"]'))
      .map((el) => ({
        tag: el.tagName,
        id: el.id || '',
        role: el.getAttribute('role') || '',
        testid: el.getAttribute('data-testid') || '',
        aria: el.getAttribute('aria-label') || '',
        visible: visible(el),
      }))
      .slice(0, 12);
    const buttons = Array.from(document.querySelectorAll('button, a[aria-label], [role="button"]'))
      .filter(visible)
      .map((el) => [
        el.getAttribute('aria-label') || '',
        el.getAttribute('data-testid') || '',
        el.textContent || '',
      ].join(' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 20);
    return {
      url: location.href,
      title: document.title || '',
      editors,
      buttons,
      body: text.slice(0, 650),
    };
  }).catch((err) => ({ error: String(err && err.message || err).slice(0, 260) }));
}

async function getImageFingerprints(page) {
  return await page.evaluate(() => Array.from(document.images).map((img) => ({
    src: img.currentSrc || img.src || '',
    width: img.naturalWidth || 0,
    height: img.naturalHeight || 0,
    top: img.getBoundingClientRect().top + window.scrollY,
  })).filter((img) => img.src));
}

async function attachmentEvidence(page, beforeSources, inputPath) {
  const fileName = path.basename(inputPath);
  const expectedSize = fs.statSync(inputPath).size;
  return await page.evaluate(({ beforeSources, fileName, expectedSize }) => {
    const before = new Set(beforeSources || []);
    const lowerFileName = String(fileName || '').toLowerCase();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 2 && rect.height > 2 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const fileInputs = Array.from(document.querySelectorAll('input[type="file"]')).map((el, index) => ({
      index,
      accept: el.getAttribute('accept') || '',
      files: el.files ? Array.from(el.files).map((file) => ({ name: file.name, size: file.size, type: file.type })) : [],
    }));
    const matchingInput = fileInputs.some((entry) => entry.files.some((file) => (
      String(file.name || '').toLowerCase() === lowerFileName || Number(file.size || 0) === Number(expectedSize || 0)
    )));
    const newImages = Array.from(document.images).map((img) => {
      const src = img.currentSrc || img.src || '';
      const rect = img.getBoundingClientRect();
      return {
        src,
        width: img.naturalWidth || Math.round(rect.width) || 0,
        height: img.naturalHeight || Math.round(rect.height) || 0,
        visible: visible(img),
      };
    }).filter((img) => img.src && !before.has(img.src) && (img.visible || img.width >= 32 || img.height >= 32));
    const nodes = Array.from(document.querySelectorAll('button, [role="button"], [data-testid], [aria-label], img, canvas, video, a, span, div'))
      .slice(-500)
      .map((el) => {
        const text = [
          el.getAttribute('aria-label') || '',
          el.getAttribute('data-testid') || '',
          el.getAttribute('title') || '',
          el.textContent || '',
        ].join(' ').replace(/\s+/g, ' ').trim();
        return { text, tag: el.tagName, visible: visible(el) };
      })
      .filter((item) => item.visible && item.text);
    const fileNameVisible = nodes.some((item) => item.text.toLowerCase().includes(lowerFileName));
    const attachmentNode = nodes.some((item) => /remove|attached|attachment|thumbnail|preview|uploaded|file ready|image ready/i.test(item.text));
    const bodyText = (document.body.innerText || '').toLowerCase();
    const uploadError = bodyText.match(/(failed to upload|couldn['’]?t upload|could not upload|unsupported file|file is too large|upload failed|something went wrong)/i)?.[0] || '';
    return {
      matchingInput,
      fileNameVisible,
      attachmentNode,
      newImageCount: newImages.length,
      uploadError,
      confirmed: Boolean(newImages.length || fileNameVisible || (matchingInput && attachmentNode)),
      fileInputs,
      newImages: newImages.slice(-5),
    };
  }, { beforeSources: [...beforeSources], fileName, expectedSize });
}

async function waitForAttachedImage(page, beforeSources, inputPath, timeoutMs = 25000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await attachmentEvidence(page, beforeSources, inputPath);
    if (last.uploadError) throw new Error(`ChatGPT image upload failed: ${last.uploadError}`);
    if (last.confirmed) return last;
    await sleep(350);
  }
  throw new Error(`ChatGPT image upload was not confirmed before submit. Evidence: ${JSON.stringify(last || {}).slice(0, 700)}`);
}

async function clickNewChatIfNeeded(page) {
  await dismissBlockingUi(page);
  const candidates = [
    'a[aria-label="New chat"]',
    'button[aria-label="New chat"]',
    '[data-testid="create-new-chat-button"]',
    'a[href="/"]',
  ];
  for (const selector of candidates) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      try {
        await locator.click({ timeout: 3000 });
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await sleep(500);
        return true;
      } catch {}
    }
  }
  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(700);
  await dismissBlockingUi(page);
  return true;
}

function writeLastModelFile(payload) {
  try {
    const path = require('path');
    const fs = require('fs');
    const outPath = path.join(__dirname, '..', 'data', 'chatgpt-hd-last-model.json');
    fs.writeFileSync(outPath, JSON.stringify({ ...payload, atIso: new Date().toISOString() }, null, 2) + '\n');
  } catch (_) {}
}

async function selectFastChatGptModel(page) {
  // Pick the FAST (non-thinking) model so image generation isn't slowed down
  // by reasoning passes. Targets: "GPT-5 Auto", "GPT-4o", "GPT-5" (instant).
  // Avoids: "Thinking", "o1", "Reasoning", "Pro" (slower).
  try {
    const switcher = await (async () => {
      const candidates = [
        page.locator('[data-testid="model-switcher-dropdown-button"]').first(),
        page.locator('button[aria-label*="Model selector" i]').first(),
        page.locator('button[aria-haspopup="menu"]').filter({ hasText: /gpt|model/i }).first(),
      ];
      for (const c of candidates) {
        if (await c.count().catch(() => 0)) {
          if (await c.isVisible({ timeout: 1500 }).catch(() => false)) return c;
        }
      }
      return null;
    })();
    if (!switcher) {
      console.log(JSON.stringify({ step: 'chatgpt_model_switcher_not_found' }));
      writeLastModelFile({ changed: false, reason: 'switcher_not_found' });
      return { changed: false, reason: 'switcher_not_found' };
    }
    const beforeLabel = await switcher.innerText().catch(() => '');
    await switcher.click({ timeout: 3000 }).catch(() => {});
    await sleep(700);
    // Try each fast-model menu item in priority order.
    const fastNames = [/^GPT-4o$/i, /^GPT-5$/i, /^GPT-4o mini$/i, /^Auto$/i, /^Instant$/i, /GPT-4o/i, /GPT-5(?!.*thinking)(?!.*reasoning)/i];
    let picked = null;
    for (const re of fastNames) {
      const item = page.locator('[role="menuitem"], [role="option"]').filter({ hasText: re }).first();
      if (await item.count().catch(() => 0)) {
        if (await item.isVisible({ timeout: 800 }).catch(() => false)) {
          await item.click({ timeout: 2000 }).catch(() => {});
          picked = re.toString();
          break;
        }
      }
    }
    await sleep(500);
    await page.keyboard.press('Escape').catch(() => {});
    const afterLabel = await page.locator('[data-testid="model-switcher-dropdown-button"]').first().innerText().catch(() => '');
    const result = { changed: Boolean(picked), before: beforeLabel.slice(0, 80), after: afterLabel.slice(0, 80), pickedPattern: picked, atIso: new Date().toISOString() };
    console.log(JSON.stringify({ step: 'chatgpt_model_selected', ...result }));
    writeLastModelFile(result);
    return { changed: Boolean(picked), before: beforeLabel, after: afterLabel };
  } catch (err) {
    const errResult = { error: String(err?.message || err).slice(0, 240) };
    console.log(JSON.stringify({ step: 'chatgpt_model_select_error', ...errResult }));
    writeLastModelFile({ changed: false, ...errResult });
    return { changed: false, error: String(err?.message || err) };
  }
}

async function findComposer(page, timeoutMs = 30000) {
  const selectors = [
    '#prompt-textarea',
    '[data-testid="prompt-textarea"]',
    '[data-testid="composer-root"] [contenteditable="true"]',
    'div[contenteditable="true"][data-lexical-editor="true"]',
    'div.ProseMirror[contenteditable="true"]',
    '[contenteditable="true"][role="textbox"]',
    '[aria-label*="Message"][contenteditable="true"]',
    'textarea[placeholder*="Message"]',
    'textarea',
    '[contenteditable="true"]',
  ];
  const start = Date.now();
  let triedFreshChat = false;
  while (Date.now() - start < timeoutMs) {
    if (!/chatgpt\.com|chat\.openai\.com/i.test(page.url())) {
      await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    }
    await dismissBlockingUi(page);
    for (const selector of selectors) {
      const locator = page.locator(selector).last();
      if (await locator.count().catch(() => 0)) {
        try {
          await locator.waitFor({ state: 'visible', timeout: 1500 });
          return locator;
        } catch {}
      }
    }
    if (!triedFreshChat && Date.now() - start > 6000) {
      triedFreshChat = true;
      await clickNewChatIfNeeded(page).catch(() => {});
    }
    await sleep(500);
  }
  const snapshot = await chatGptPageSnapshot(page);
  const body = String(snapshot.body || '');
  if (/log in to start chatting|log in to get answers|continue with google|continue with apple|sign up for free/i.test(body)) {
    throw new Error('ChatGPT browser is not logged in. Log in once in the Edge profile opened by the agent, then rerun product asset prep.');
  }
  throw new Error(`ChatGPT composer not found after ${timeoutMs}ms. Snapshot: ${JSON.stringify(snapshot).slice(0, 900)}`);
}

async function assertChatGptLoggedIn(page) {
  const body = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  if (/log in to start chatting|log in to get answers|continue with google|continue with apple|sign up for free/i.test(body)) {
    throw new Error('ChatGPT browser is not logged in. Log in once in the Edge profile opened by the agent, then rerun product asset prep.');
  }
}

async function composerHasPrompt(page, prompt) {
  const raw = String(prompt || '').replace(/\s+/g, ' ').trim();
  const needles = [
    raw.slice(0, 80),
    raw.split(/\s+/).slice(0, 8).join(' '),
    'Make this customer review image HD quality',
  ].filter((item) => item && item.length >= 12);
  return await page.evaluate((needles) => {
    const active = document.activeElement;
    const editors = [
      active,
      document.querySelector('#prompt-textarea'),
      ...document.querySelectorAll('[contenteditable="true"], textarea'),
    ].filter(Boolean);
    const text = editors.map((el) => [
      el.value || '',
      el.innerText || '',
      el.textContent || '',
    ].join('\n')).join('\n').replace(/\s+/g, ' ');
    return needles.some((needle) => text.includes(needle));
  }, needles).catch(() => false);
}

async function pastePrompt(page, prompt) {
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  const origin = (() => {
    try { return new URL(page.url()).origin; } catch { return 'https://chatgpt.com'; }
  })();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin }).catch(() => {});
  try {
    await page.evaluate(async (text) => {
      await navigator.clipboard.writeText(text);
    }, prompt);
    await page.keyboard.press(`${modifier}+V`);
    await sleep(350);
    if (await composerHasPrompt(page, prompt)) return { method: 'clipboard_paste' };
  } catch {}
  try {
    await page.keyboard.insertText(prompt);
    await sleep(250);
    if (await composerHasPrompt(page, prompt)) return { method: 'keyboard_insert_text' };
  } catch {}
  try {
    const inserted = await page.evaluate((text) => {
      const active = document.activeElement;
      if (!active) return false;
      if ('value' in active) {
        active.value = text;
        active.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        return true;
      }
      active.focus();
      const ok = document.execCommand && document.execCommand('insertText', false, text);
      if (!ok) active.textContent = text;
      active.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      return true;
    }, prompt);
    await sleep(250);
    if (inserted && await composerHasPrompt(page, prompt)) return { method: 'dom_insert_text' };
  } catch {}
  await page.keyboard.type(prompt, { delay: 0 });
  await sleep(250);
  return { method: 'keyboard_type_zero_delay', verified: await composerHasPrompt(page, prompt) };
}

async function setFileInputAndConfirm(page, inputPath, beforeSources) {
  const inputs = await page.locator('input[type="file"]').elementHandles();
  const errors = [];
  for (let i = inputs.length - 1; i >= 0; i -= 1) {
    try {
      await inputs[i].setInputFiles(inputPath);
      const evidence = await waitForAttachedImage(page, beforeSources, inputPath, 8000);
      return { method: 'direct_file_input', inputIndex: i, evidence };
    } catch (err) {
      errors.push(String(err && err.message || err).slice(0, 260));
    }
  }
  if (errors.length) throw new Error(`ChatGPT file input did not confirm upload: ${errors.join(' | ').slice(0, 800)}`);
  return null;
}

async function clickUploadControl(page) {
  const attachSelectors = [
    '[data-testid="composer-plus-btn"]',
    'button[aria-label*="Add photos"]',
    'button[aria-label*="Add files"]',
    'button[aria-label*="Attach files"]',
    'button[aria-label*="Upload files"]',
    'button[aria-label*="Upload"]',
    'button[aria-label*="Attach"]',
    'button[aria-label*="Add"]',
    'button:has-text("Upload")',
    'button:has-text("Attach")',
    'button:has-text("Add photos")',
    'button:has-text("Add files")',
    '[data-testid*="upload"]',
    '[data-testid*="attach"]',
  ];
  for (const selector of attachSelectors) {
    const button = page.locator(selector).first();
    if (await button.count()) {
      try {
        await button.click({ timeout: 3000 });
        await sleep(400);
        return selector;
      } catch {}
    }
  }
  return '';
}

async function clickUploadMenuItem(page) {
  const menuSelectors = [
    'text=/Upload from computer/i',
    'text=/Upload file/i',
    'text=/Upload files/i',
    'text=/Add photos/i',
    'text=/Add files/i',
  ];
  for (const selector of menuSelectors) {
    const item = page.locator(selector).last();
    if (await item.count()) {
      try {
        await item.click({ timeout: 2500 });
        return selector;
      } catch {}
    }
  }
  return '';
}

async function attachImage(page, inputPath) {
  const beforeSources = new Set((await getImageFingerprints(page)).map((img) => img.src));

  try {
    const direct = await setFileInputAndConfirm(page, inputPath, beforeSources);
    if (direct) return direct;
  } catch {}

  const chooserPromise = page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null);
  const clicked = await clickUploadControl(page);
  const menuClicked = await clickUploadMenuItem(page);
  const chooser = await chooserPromise;
  if (chooser) {
    await chooser.setFiles(inputPath);
    const evidence = await waitForAttachedImage(page, beforeSources, inputPath);
    return { method: 'filechooser', clicked, menuClicked, evidence };
  }

  const directAfterMenu = await setFileInputAndConfirm(page, inputPath, beforeSources);
  if (directAfterMenu) return { ...directAfterMenu, clicked, menuClicked };

  throw new Error('No ChatGPT upload/file input found.');
}

async function submitPrompt(page, prompt) {
  const composer = await findComposer(page);
  await composer.click({ timeout: 5000 });
  const paste = await pastePrompt(page, prompt);
  console.log(JSON.stringify({ step: 'chatgpt_prompt_inserted', ...paste }));
  if (paste.verified === false) {
    throw new Error('ChatGPT prompt insertion was not verified.');
  }
  await sleep(400);
  const sendSelectors = [
    '[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send message"]',
  ];
  for (const selector of sendSelectors) {
    const button = page.locator(selector).last();
    if (await button.count()) {
      try {
        if (await button.isDisabled().catch(() => false)) continue;
        await button.click({ timeout: 3000 });
        return;
      } catch {}
    }
  }
  await page.keyboard.press('Enter');
}

async function imageBytesFromPage(page, src) {
  const bytes = await page.evaluate(async (imageSrc) => {
    const response = await fetch(imageSrc);
    if (!response.ok) throw new Error(`image fetch HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    return Array.from(new Uint8Array(buffer));
  }, src);
  return Buffer.from(bytes);
}

async function chatGptGenerationFailureSnapshot(page) {
  return await page.evaluate(() => {
    const text = (document.body.innerText || document.body.textContent || '').replace(/\s+/g, ' ').trim();
    const patterns = [
      /image we created may violate our guardrails/i,
      /may violate our guardrails/i,
      /similarity to third-party content/i,
      /third-party content/i,
      /violat(?:e|es|ed|ing) (?:our )?guardrails/i,
      /image generation failed/i,
      /failed to generate/i,
      /couldn['’]?t generate/i,
      /could not generate/i,
      /unable to generate/i,
      /there was a problem generating/i,
      /error (?:creating|generating) image/i,
      /something went wrong/i,
      /try again later/i,
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (!match) continue;
      const index = Math.max(0, match.index - 160);
      return {
        failed: true,
        reason: match[0],
        snippet: text.slice(index, index + 420),
      };
    }
    return { failed: false, reason: '', snippet: '' };
  }).catch((err) => ({ failed: false, reason: '', snippet: String(err && err.message || err) }));
}

function isChatGptImageGuardrailError(message) {
  return /may violate our guardrails|similarity to third-party content|third-party content|violat(?:e|es|ed|ing) (?:our )?guardrails/i.test(String(message || ''));
}

function buildHdPrompt(mode = 'standard') {
  const standard = [
    'Make the attached image HD.',
    'Fix the image rotation if it is wrong.',
    'Keep the same photo and product.',
    'Return one downloadable image.'
  ];
  const guardrailSafe = [
    'Make the attached photo HD and fix rotation if wrong.',
    'Do not recreate logos, labels, text, packaging artwork, or third-party design.',
    'Keep the same photo and product.',
    'Return one downloadable image.'
  ];
  return (mode === 'guardrail_safe' ? guardrailSafe : standard).join(' ');
}

async function waitForGeneratedImage(page, beforeSources, timeoutMs, inputHash) {
  const start = Date.now();
  let best = null;
  while (Date.now() - start < timeoutMs) {
    const imgs = await getImageFingerprints(page);
    const candidates = imgs
      .filter((img) => img.width >= 512 && img.height >= 512)
      .filter((img) => !beforeSources.has(img.src))
      .sort((a, b) => (b.top - a.top) || (b.width * b.height - a.width * a.height));
    if (candidates.length) {
      best = candidates[0];
      await sleep(1500);
      const stable = (await getImageFingerprints(page)).find((img) => img.src === best.src && img.width === best.width && img.height === best.height);
      if (stable) {
        try {
          const bytes = await imageBytesFromPage(page, stable.src);
          const candidateHash = crypto.createHash('sha256').update(bytes).digest('hex');
          if (candidateHash !== inputHash) return { ...stable, bytes };
          beforeSources.add(stable.src);
        } catch {
          beforeSources.add(stable.src);
        }
      }
    }
    if (Date.now() - start > 12000) {
      const failure = await chatGptGenerationFailureSnapshot(page);
      if (failure.failed) {
        const detail = failure.snippet ? ` ${failure.snippet.slice(0, 500)}` : '';
        throw new Error(`ChatGPT image generation failed: ${failure.reason}.${detail}`);
      }
    }
    await sleep(800);
  }
  throw new Error('Timed out waiting for generated ChatGPT image.');
}

async function runGenerationAttempt(page, input, prompt, timeoutMs, inputHash, attempt, maxAttempts, promptMode = 'standard') {
  console.log(JSON.stringify({ step: 'chatgpt_generation_attempt_started', attempt, maxAttempts, promptMode }));
  await assertChatGptLoggedIn(page);
  await findComposer(page);
  // Phase 10: pick the FAST (non-thinking) model before submitting. Best-effort
  // - never blocks if the model picker isn't found. Only runs on first attempt
  // to avoid changing model mid-conversation.
  if (attempt === 1) {
    await selectFastChatGptModel(page).catch(() => {});
  }
  const attachment = await attachImage(page, input);
  console.log(JSON.stringify({
    step: 'chatgpt_image_upload_confirmed',
    attempt,
    method: attachment.method,
    newImageCount: attachment.evidence?.newImageCount || 0,
    matchingInput: Boolean(attachment.evidence?.matchingInput),
    fileNameVisible: Boolean(attachment.evidence?.fileNameVisible),
  }));
  await sleep(500);
  const beforeGenerated = new Set((await getImageFingerprints(page)).map((img) => img.src));
  await submitPrompt(page, prompt);
  const generated = await waitForGeneratedImage(page, beforeGenerated, timeoutMs, inputHash);
  console.log(JSON.stringify({
    step: 'chatgpt_generation_attempt_succeeded',
    attempt,
    width: generated.width,
    height: generated.height,
  }));
  return generated;
}

(async () => {
  const args = parseArgs(process.argv);
  const input = path.resolve(String(args.input || ''));
  const output = path.resolve(String(args.output || ''));
  const cdp = String(args.cdp || process.env.CHATGPT_EDGE_CDP || 'http://127.0.0.1:9333');
  const timeoutMs = Number(args.timeoutMs || 240000);
  const maxAttempts = Math.max(1, Math.min(5, Number(args.retries || args.retry || 3) || 3));
  const attemptTimeoutMs = Math.max(60000, Number(args['attempt-timeout-ms'] || args.attemptTimeoutMs || timeoutMs) || timeoutMs);
  if (!input || !fs.existsSync(input)) throw new Error(`input image not found: ${input}`);
  if (!output) throw new Error('--output is required');
  const inputHash = crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex');

  // Edge sometimes takes >30s to expose CDP on first launch with a fresh
  // profile directory. Give it more time and retry a few times before failing.
  let browser = null;
  const cdpAttempts = [
    { timeoutMs: 45000, waitBefore: 0 },
    { timeoutMs: 60000, waitBefore: 3000 },
    { timeoutMs: 60000, waitBefore: 6000 },
  ];
  let lastErr = null;
  for (const attempt of cdpAttempts) {
    if (attempt.waitBefore) await sleep(attempt.waitBefore);
    try {
      browser = await chromium.connectOverCDP(cdp, { timeout: attempt.timeoutMs });
      break;
    } catch (err) {
      lastErr = err;
      console.log(JSON.stringify({ step: 'chatgpt_cdp_connect_retry', error: String(err?.message || err).slice(0, 240) }));
    }
  }
  if (!browser) throw lastErr || new Error('connectOverCDP failed after all retries');
  const context = browser.contexts()[0] || await browser.newContext();
  const preferNewWindow = String(args['new-window'] || '').toLowerCase() === 'true';
  const allPages = context.pages();
  const chatPages = allPages.filter((p) => /chatgpt\.com|chat\.openai\.com/i.test(p.url()));
  let page = preferNewWindow ? chatPages.at(-1) : chatPages[0];
  page = page || allPages.at(-1) || await context.newPage();
  await page.bringToFront();
  if (!/chatgpt\.com|chat\.openai\.com/i.test(page.url())) {
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  }

  const attemptErrors = [];
  const promptModesUsed = [];
  let promptMode = 'standard';
  let guardrailRetryUsed = false;
  let generated = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1 || String(args['new-chat'] || '').toLowerCase() === 'true') {
      await clickNewChatIfNeeded(page);
    }
    try {
      promptModesUsed.push(promptMode);
      generated = await runGenerationAttempt(page, input, buildHdPrompt(promptMode), attemptTimeoutMs, inputHash, attempt, maxAttempts, promptMode);
      break;
    } catch (err) {
      const message = String(err && err.message || err);
      const guardrailBlocked = isChatGptImageGuardrailError(message);
      attemptErrors.push(message);
      console.log(JSON.stringify({
        step: 'chatgpt_generation_attempt_failed',
        attempt,
        maxAttempts,
        promptMode,
        guardrailBlocked,
        error: message.slice(0, 900),
      }));
      if (guardrailBlocked && !guardrailRetryUsed && attempt < maxAttempts) {
        guardrailRetryUsed = true;
        promptMode = 'guardrail_safe';
        console.log(JSON.stringify({
          step: 'chatgpt_guardrail_retry_prompt_selected',
          attempt: attempt + 1,
          reason: 'similarity_to_third_party_content',
          promptMode,
        }));
      }
      if (/not logged in/i.test(message) || attempt >= maxAttempts) {
        throw new Error(`ChatGPT HD failed after ${attempt} attempt(s): ${attemptErrors.join(' | ').slice(0, 1600)}`);
      }
      await clickNewChatIfNeeded(page);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await sleep(1500);
    }
  }
  if (!generated) throw new Error(`ChatGPT HD failed after ${maxAttempts} attempt(s): ${attemptErrors.join(' | ').slice(0, 1600)}`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, generated.bytes || await imageBytesFromPage(page, generated.src));
  console.log(JSON.stringify({
    ok: true,
    output,
    width: generated.width,
    height: generated.height,
    newChat: String(args['new-chat'] || '').toLowerCase() === 'true',
    attempts: attemptErrors.length + 1,
    retriedAfterFailure: attemptErrors.length > 0,
    guardrailRetryUsed,
    promptModesUsed,
  }));
  await browser.close().catch(() => {});
})().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error && error.stack || error) }));
  process.exit(1);
});
