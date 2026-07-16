const DEFAULT_IXBROWSER_LOCAL_ENDPOINT = "http://127.0.0.1:53200/";
const API_PATH_CANDIDATES = ["/", "/api/v2/"];
const LOOPBACK_HOST_CANDIDATES = ["127.0.0.1", "127.0.0.2"];
const DISCOVERY_TIMEOUT_MS = 5000;
const DISCOVERY_CACHE_MS = 5 * 60 * 1000;

let cache = { configuredBaseUrl: "", effectiveBaseUrl: "", at: 0 };

function normalizeBaseUrl(value) {
  let text = String(value || DEFAULT_IXBROWSER_LOCAL_ENDPOINT).trim();
  if (/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i.test(text)) {
    text = `http://${text}`;
  }
  const url = new URL(text);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("IXBrowser URL must use http or https");
  const host = url.hostname.toLowerCase();
  if (!["localhost", "::1"].includes(host) && !/^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host)) throw new Error("IXBrowser URL must stay on localhost/127.0.0.0/8");
  url.pathname = (url.pathname.replace(/\/+$/, "") || "") + "/";
  url.search = "";
  url.hash = "";
  url.username = "";
  url.password = "";
  return url.toString();
}

function candidateBaseUrls(configuredBaseUrl) {
  const configured = normalizeBaseUrl(configuredBaseUrl);
  const configuredUrl = new URL(configured);
  const seen = new Set();
  const candidates = [];
  const add = (value) => {
    const normalized = normalizeBaseUrl(value);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  };
  add(configured);
  const hostnames = ["localhost", "127.0.0.1"].includes(configuredUrl.hostname.toLowerCase())
    ? LOOPBACK_HOST_CANDIDATES
    : [configuredUrl.hostname];
  for (const hostname of hostnames) {
    for (const pathname of API_PATH_CANDIDATES) {
      const url = new URL(pathname, configured);
      url.hostname = hostname;
      add(url.toString());
    }
  }
  return candidates;
}

function isIxBrowserApiShape(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.error && typeof payload.error.code !== "undefined") return true;
  if (typeof payload.code !== "undefined" && (Object.prototype.hasOwnProperty.call(payload, "data") || Object.prototype.hasOwnProperty.call(payload, "msg"))) return true;
  return Array.isArray(payload.data) || Array.isArray(payload.list) || (payload.data && typeof payload.data === "object" && (Array.isArray(payload.data.data) || Array.isArray(payload.data.list)));
}

async function requestJson(url, body, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 70000);
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(options.headers || {}) },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`ixbrowser_${options.endpoint || "request"}_timeout_after_${Math.round((options.timeoutMs || 70000) / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`IXBrowser ${options.endpoint || "request"} returned non-JSON HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  if (!response.ok) throw new Error(`IXBrowser ${options.endpoint || "request"} HTTP ${response.status}: ${text.slice(0, 600)}`);
  return payload;
}

async function resolveBaseUrl(baseUrl, options = {}) {
  const configured = normalizeBaseUrl(baseUrl || process.env.IXBROWSER_LOCAL_API || DEFAULT_IXBROWSER_LOCAL_ENDPOINT);
  const now = Date.now();
  if (cache.configuredBaseUrl === configured && cache.effectiveBaseUrl && now - cache.at < DISCOVERY_CACHE_MS) {
    return cache.effectiveBaseUrl;
  }
  const headers = options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {};
  const failures = [];
  for (const candidate of candidateBaseUrls(configured)) {
    try {
      const probeUrl = new URL("profile-list", candidate).toString();
      const payload = await requestJson(probeUrl, { page: 1, limit: 1 }, {
        endpoint: "profile-list",
        headers,
        timeoutMs: options.discoveryTimeoutMs || DISCOVERY_TIMEOUT_MS,
      });
      if (isIxBrowserApiShape(payload)) {
        cache = { configuredBaseUrl: configured, effectiveBaseUrl: candidate, at: now };
        return candidate;
      }
      failures.push(`${candidate}: unexpected_response`);
    } catch (err) {
      failures.push(`${candidate}: ${String(err?.message || err).slice(0, 180)}`);
    }
  }
  cache = { configuredBaseUrl: configured, effectiveBaseUrl: configured, at: now };
  if (options.logDiscoveryFailure) {
    console.log(JSON.stringify({ step: "ixbrowser_api_discovery_failed", configuredBaseUrl: configured, attempts: failures.slice(0, 4) }));
  }
  return configured;
}

function throwIxBrowserError(endpoint, payload) {
  const raw = payload?.error || (typeof payload?.code !== "undefined" ? { code: payload.code, message: payload.message || payload.msg } : null);
  if (!raw || Number(raw.code || 0) === 0) return;
  throw new Error(`IXBrowser ${endpoint} error ${raw.code}: ${raw.message || "unknown error"}`);
}

async function ixBrowserRawRequest(endpoint, body = {}, options = {}) {
  const baseUrl = await resolveBaseUrl(options.baseUrl, options);
  const url = new URL(String(endpoint || "").replace(/^\//, ""), baseUrl).toString();
  const headers = options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {};
  const payload = await requestJson(url, body, { ...options, endpoint, headers });
  throwIxBrowserError(endpoint, payload);
  return payload;
}

async function ixBrowserDataRequest(endpoint, body = {}, options = {}) {
  const payload = await ixBrowserRawRequest(endpoint, body, options);
  if (Object.prototype.hasOwnProperty.call(payload, "data")) return payload.data;
  return payload;
}

module.exports = {
  DEFAULT_IXBROWSER_LOCAL_ENDPOINT,
  normalizeBaseUrl,
  resolveBaseUrl,
  ixBrowserRawRequest,
  ixBrowserDataRequest,
};
