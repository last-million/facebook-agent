const DEFAULT_IXBROWSER_LOCAL_ENDPOINT = "http://127.0.0.1:53200/";
const API_PATH_CANDIDATES = ["/", "/api/", "/api/v1/", "/api/v2/", "/api/v3/", "/api/v4/", "/api/v5/"];
const LOOPBACK_HOST_CANDIDATES = ["127.0.0.1", "127.0.0.2"];
const DISCOVERY_TIMEOUT_MS = 2000;
const DISCOVERY_CACHE_MS = 5 * 60 * 1000;
const LISTENING_DISCOVERY_CACHE_MS = 30000;
const LISTENING_DISCOVERY_TIMEOUT_MS = 3500;
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

let cache = { configuredBaseUrl: "", effectiveBaseUrl: "", at: 0 };
let listeningEndpointCache = { endpoints: [], at: 0 };

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

function isLoopbackHost(host) {
  const value = String(host || "").toLowerCase();
  return value === "localhost" || value === "::1" || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(value);
}

async function discoverListeningEndpoints() {
  const now = Date.now();
  if (now - listeningEndpointCache.at < LISTENING_DISCOVERY_CACHE_MS) return listeningEndpointCache.endpoints;
  if (process.platform !== "win32") {
    listeningEndpointCache = { endpoints: [], at: now };
    return [];
  }
  const script = `
$ids = @(Get-Process -Name 'ixBrowser' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
if ($ids.Count -eq 0) { exit 0 }
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $ids -contains [int]$_.OwningProcess } |
  ForEach-Object {
    $address = [string]$_.LocalAddress
    if ($address -eq '0.0.0.0' -or $address -eq '::' -or $address -eq '::1' -or $address -like '127.*') {
      Write-Output ($address + '|' + [int]$_.LocalPort)
    }
  }
`;
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script,
    ], { windowsHide: true, timeout: LISTENING_DISCOVERY_TIMEOUT_MS, maxBuffer: 32 * 1024 });
    const endpoints = String(stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim().split("|"))
      .filter(([host, port]) => (host === "0.0.0.0" || host === "::" || host === "::1" || isLoopbackHost(host)) && /^\d+$/.test(port || ""))
      .map(([host, port]) => ({ host, port: String(Number(port)) }));
    listeningEndpointCache = { endpoints, at: now };
    return endpoints;
  } catch {
    listeningEndpointCache = { endpoints: [], at: now };
    return [];
  }
}

async function candidateBaseUrls(configuredBaseUrl) {
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
  const hostnames = new Set(isLoopbackHost(configuredUrl.hostname)
    ? LOOPBACK_HOST_CANDIDATES
    : [configuredUrl.hostname]);
  const ports = new Set([configuredUrl.port || "53200"]);
  for (const endpoint of await discoverListeningEndpoints()) {
    if (/^\d+$/.test(endpoint?.port || "")) ports.add(String(Number(endpoint.port)));
    if (isLoopbackHost(endpoint?.host)) hostnames.add(String(endpoint.host).toLowerCase());
  }
  const paths = [configuredUrl.pathname, ...API_PATH_CANDIDATES];
  for (const hostname of hostnames) {
    for (const port of ports) {
      for (const pathname of paths) {
        const url = new URL(configured);
        url.hostname = hostname;
        url.port = port;
        url.pathname = pathname;
        add(url.toString());
      }
    }
  }
  return candidates;
}

function isIxBrowserApiShape(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.error?.relay === "ixbrowser-wsl-relay") return false;
  const hasProfileData = Array.isArray(payload.data)
    || Array.isArray(payload.list)
    || (payload.data && typeof payload.data === "object" && (Array.isArray(payload.data.data) || Array.isArray(payload.data.list)));
  if (hasProfileData) return true;
  const code = Number(payload.error?.code ?? payload.code);
  if (code === 1007) return false;
  return Boolean(payload.error && typeof payload.error.code !== "undefined") || (code === 0 && Object.prototype.hasOwnProperty.call(payload, "data"));
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
    const wrapped = err?.name === "AbortError"
      ? new Error(`ixbrowser_${options.endpoint || "request"}_timeout_after_${Math.round((options.timeoutMs || 70000) / 1000)}s`)
      : err;
    wrapped.isNetworkError = true;
    throw wrapped;
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
  if (!response.ok) {
    const err = new Error(`IXBrowser ${options.endpoint || "request"} HTTP ${response.status}: ${text.slice(0, 600)}`);
    err.remoteStatus = response.status;
    throw err;
  }
  return payload;
}

async function resolveBaseUrl(baseUrl, options = {}) {
  const configured = normalizeBaseUrl(baseUrl || process.env.IXBROWSER_LOCAL_API || DEFAULT_IXBROWSER_LOCAL_ENDPOINT);
  const now = Date.now();
  if (!options.force && cache.configuredBaseUrl === configured && cache.effectiveBaseUrl && now - cache.at < DISCOVERY_CACHE_MS) {
    return cache.effectiveBaseUrl;
  }
  const headers = options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {};
  const failures = [];
  for (const candidate of await candidateBaseUrls(configured)) {
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
  cache = { configuredBaseUrl: configured, effectiveBaseUrl: "", at: 0 };
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
  const headers = options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {};
  let baseUrl = await resolveBaseUrl(options.baseUrl, options);
  const requestAtBase = async (base) => {
    const url = new URL(String(endpoint || "").replace(/^\//, ""), base).toString();
    const payload = await requestJson(url, body, { ...options, endpoint, headers });
    throwIxBrowserError(endpoint, payload);
    return payload;
  };
  try {
    return await requestAtBase(baseUrl);
  } catch (err) {
    const status = Number(err?.remoteStatus || 0);
    const recoverable = err?.isNetworkError || [404, 405, 502, 503, 504].includes(status) || /ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost/i.test(String(err?.message || ""));
    if (!recoverable) throw err;
    cache = { configuredBaseUrl: "", effectiveBaseUrl: "", at: 0 };
    baseUrl = await resolveBaseUrl(options.baseUrl, { ...options, force: true });
    if (!baseUrl) throw err;
    return await requestAtBase(baseUrl);
  }
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
