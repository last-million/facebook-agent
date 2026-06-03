const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function cdpEndpointFromIxOpenResult(result = {}) {
  const candidates = [
    result.debugging_address,
    result.debuggingAddress,
    result.debugging_addr,
    result.cdp,
    result.cdp_url,
    result.ws,
    result.websocket,
    result.webSocketDebuggerUrl,
  ].filter(Boolean);
  for (const candidate of candidates) {
    const value = String(candidate);
    if (value.startsWith("ws://") || value.startsWith("http://")) return value;
    if (/^(?:\d+\.\d+\.\d+\.\d+|127\.0\.0\.1|localhost):\d+$/i.test(value)) return `http://${value}`;
  }
  throw new Error(`IXBrowser opened the profile but did not return a CDP endpoint: ${JSON.stringify(result).slice(0, 500)}`);
}

async function ixBrowserRequest(endpoint, body = {}) {
  const response = await fetch(`http://127.0.0.1:53200/api/v2/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`IXBrowser returned non-JSON HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  if (!response.ok) throw new Error(`IXBrowser HTTP ${response.status}: ${text.slice(0, 500)}`);
  if (payload.error && payload.error.code !== 0) throw new Error(`IXBrowser API error: ${JSON.stringify(payload.error)}`);
  return payload.data || payload;
}

async function generateShopYourLikesLinkInExtension(context, productUrl, extensionId) {
  const pages = context.pages().filter((page) => !page.isClosed());
  const productPage = pages[0] || await context.newPage();
  await productPage.goto(productUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  await productPage.waitForTimeout(3500);
  await productPage.bringToFront();
  const title = await productPage.title().catch(() => "");

  const extensionPage = await context.newPage();
  try {
    await extensionPage.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "domcontentloaded", timeout: 20000 });
    await extensionPage.waitForTimeout(1500);
    await extensionPage.evaluate(({ url, title }) => {
      if (window.ConnexityPubRdPopup) {
        window.ConnexityPubRdPopup.url = url;
        window.ConnexityPubRdPopup.tabTitle = title || url;
      }
    }, { url: productUrl, title });
    await extensionPage.waitForSelector("#generate_link_button", { timeout: 15000 });
    await extensionPage.click("#generate_link_button");
    const sylLink = await extensionPage.waitForFunction(() => {
      const fromGlobal = window.generatedDeeplink || "";
      const field = document.querySelector("#deepLink")?.value || "";
      const buttonText = document.querySelector("#generate_link_button")?.innerText || "";
      const fromButton = (buttonText.match(/https?:\/\/\S+/i) || [""])[0];
      return fromGlobal || field || fromButton || "";
    }, null, { timeout: 60000 }).then((handle) => handle.jsonValue());
    if (!sylLink || !/^https?:\/\//i.test(String(sylLink))) throw new Error("ShopYourLikes extension did not expose a generated link.");
    return String(sylLink).trim();
  } finally {
    await extensionPage.close().catch(() => {});
    await productPage.bringToFront().catch(() => {});
  }
}

function extractMavlynkShortUrl(result) {
  return result?.shorturl
    || result?.short_url
    || result?.data?.shorturl
    || result?.data?.short_url
    || result?.url
    || result?.shortUrl
    || result?.shortlink
    || result?.link
    || "";
}

async function createMavlynkShortlink(targetUrl) {
  const secrets = readJson(path.join(process.cwd(), "data", "secrets.local.json"));
  const apiKey = secrets.shortlink?.apiKey;
  if (!apiKey) throw new Error("Mavlynk API key is missing.");
  const baseUrl = String(secrets.shortlink?.baseUrl || "https://mavlynk.com/").replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/api/url/add`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${apiKey}`,
      "x-api-key": apiKey,
    },
    body: JSON.stringify({ url: targetUrl }),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Mavlynk returned non-JSON HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  if (!response.ok) throw new Error(`Mavlynk HTTP ${response.status}: ${JSON.stringify(payload).slice(0, 500)}`);
  const shortUrl = extractMavlynkShortUrl(payload);
  if (!shortUrl) throw new Error(`Mavlynk response missing shorturl: ${JSON.stringify(payload).slice(0, 500)}`);
  return { shortUrl, raw: payload };
}

async function main() {
  const requestPath = process.argv[2];
  if (!requestPath) throw new Error("request JSON path argument is required");
  const request = readJson(requestPath);
  const profileId = Number(request.profileId);
  const productUrls = Array.isArray(request.productUrls) ? request.productUrls : [];
  const extensionId = request.extensionId || "ndoliganogoohcgigfagdepbgpjbdbkh";
  const shouldShorten = request.shortenAfter !== false;
  if (!profileId) throw new Error("profileId is required");
  if (!productUrls.length) throw new Error("productUrls are required");

  let cdpEndpoint = String(request.cdpEndpoint || "").trim();
  let browser = null;
  if (cdpEndpoint) {
    browser = await chromium.connectOverCDP(cdpEndpoint, { timeout: 20000 }).catch(() => null);
  }
  if (!browser) {
    const openResult = await ixBrowserRequest("profile-open", {
      profile_id: profileId,
      args: ["--disable-popup-blocking"],
      load_extensions: true,
      cookies_backup: false,
      load_profile_info_page: false,
    });
    cdpEndpoint = cdpEndpointFromIxOpenResult(openResult);
    browser = await chromium.connectOverCDP(cdpEndpoint, { timeout: 20000 });
  }
  const results = [];
  try {
    const context = browser.contexts()[0] || await browser.newContext();
    for (const productUrl of productUrls) {
      try {
        const sylLink = await generateShopYourLikesLinkInExtension(context, productUrl, extensionId);
        let shortUrl = "";
        let rawShortlink = null;
        if (shouldShorten) {
          const shortened = await createMavlynkShortlink(sylLink);
          shortUrl = shortened.shortUrl;
          rawShortlink = shortened.raw;
        }
        results.push({ productUrl, sylLink, shortUrl, success: true, rawShortlink });
      } catch (err) {
        results.push({ productUrl, success: false, error: err.message || String(err) });
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  console.log(`RESULT_JSON ${JSON.stringify({ success: true, profileId, results })}`);
}

main().catch((err) => {
  console.error(err && err.stack || err);
  console.log(`RESULT_JSON ${JSON.stringify({ success: false, error: err?.message || String(err) })}`);
  process.exit(1);
});
