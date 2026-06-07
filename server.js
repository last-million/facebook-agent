const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn, execFile } = require("child_process");
const { promisify } = require("util");
const tls = require("tls");
const cheerio = require("cheerio");
const { chromium } = require("playwright-core");

const SHOPYOURLIKES_EXTENSION_ID = "ndoliganogoohcgigfagdepbgpjbdbkh";
const execFileAsync = promisify(execFile);

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const AGENT_CHATGPT_EDGE_USER_DATA_DIR = path.join(DATA_DIR, "chatgpt-agent-edge-profile");
const JOBS_FILE = path.join(DATA_DIR, "jobs.json");
const LOG_FILE = path.join(DATA_DIR, "events.log");
// DURABLE audit log: events.log is a rolling 500KB/last-600 buffer for the dashboard; AUDIT_DIR
// holds one append-only NEVER-trimmed file per local day (the permanent "what happened" record).
const AUDIT_DIR = path.join(DATA_DIR, "audit");
let __auditDateStr = "";
let __auditFilePath = "";
let __lastPerPostLogSweep = 0;
const PER_POST_LOG_SWEEP_INTERVAL_MS = 6 * 3600 * 1000;
const STATE_FILE = path.join(DATA_DIR, "workflow-state.json");
const LOCAL_DB_DIR = path.join(DATA_DIR, "local-db");
const FB_LIVE_POST_LEDGER_FILE = path.join(LOCAL_DB_DIR, "facebook-live-posts.jsonl");
const IXBROWSER_CDP_CACHE_FILE = path.join(DATA_DIR, "ixbrowser-cdp-cache.json");
const SECRETS_FILE = path.join(DATA_DIR, "secrets.local.json");
const APPROVALS_FILE = path.join(DATA_DIR, "approval-decisions.json");
const DASHBOARD_TOKEN_FILE = path.join(DATA_DIR, ".dashboard-token");
const MIRO_CONTEXT_FILE = path.join(ROOT, "MIRO_SCHEMA_UNDERSTANDING.md");
const FINAL_PROCESS_FILE = path.join(ROOT, "FINAL_MIRO_PROCESS_READ.md");
const PORT = Number(process.env.FACEBOOK_AGENT_PORT || 9317);
const HOST = "127.0.0.1";
const HERMES_BIN = "/root/.local/bin/hermes";
const WSL_PROJECT = "/mnt/c/Users/Administrator/Desktop/facbeook agent";
const MAX_JOB_OUTPUT = 120000;
const MAX_EVENTS_BYTES = 500000;
const MAX_CONCURRENT_NORMAL_IX_PROFILES = 4;
const MAX_COMMENT_FALLBACK_PROFILES = 6;
const FACEBOOK_LIVE_POST_TIMEOUT_MS = 600000;
const FACEBOOK_ADMIN_APPROVAL_TIMEOUT_MS = 360000;
const FACEBOOK_COMMENT_RECOVERY_TIMEOUT_MS = 240000;
const HERMES_IMAGE_SELECTOR_TIMEOUT_MS = 120000;
const TEST_HERMES_IMAGE_SELECTOR_TIMEOUT_MS = 90000;
const REVIEW_IMAGE_CANDIDATE_COUNT = 5;
const TEST_REVIEW_IMAGE_CANDIDATE_COUNT = 2;
const HERMES_FAST_MODEL = "gpt-5.4-mini";
const IMAGE_SELECTOR_SERVICE_URL = "http://127.0.0.1:9318";
let __imageSelectorAutoStartedAt = 0;

async function callImageSelectorService(prompt, timeoutMs = 90000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${IMAGE_SELECTOR_SERVICE_URL}/select`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`selector service HTTP ${res.status}: ${text.slice(0, 300)}`);
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`selector service returned non-JSON: ${text.slice(0, 200)}`); }
    if (!data.ok) throw new Error(`selector service error: ${data.error || "unknown"} ${data.message || ""}`.trim());
    return String(data.content || "");
  } finally {
    clearTimeout(timer);
  }
}

async function ensureImageSelectorServiceRunning() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`${IMAGE_SELECTOR_SERVICE_URL}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) return true;
  } catch (_) {
    // Not running - try to start it
  }
  if (Date.now() - __imageSelectorAutoStartedAt < 30000) return false;
  __imageSelectorAutoStartedAt = Date.now();
  try {
    const { spawn } = require("child_process");
    const child = spawn("wsl.exe", [
      "-e", "bash", "-lc",
      "cd '/mnt/c/Users/Administrator/Desktop/facbeook agent' && (nohup python3 tools/image-selector-server.py > /tmp/image-selector-server.log 2>&1 &) && sleep 1",
    ], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    await new Promise((r) => setTimeout(r, 3000));
    const res = await fetch(`${IMAGE_SELECTOR_SERVICE_URL}/health`).catch(() => null);
    if (res?.ok) {
      logEvent("image_selector_service_auto_started", { url: IMAGE_SELECTOR_SERVICE_URL });
      return true;
    }
    logEvent("image_selector_service_auto_start_failed", { url: IMAGE_SELECTOR_SERVICE_URL });
  } catch (err) {
    logEvent("image_selector_service_auto_start_error", { error: oneLineField(err.message || String(err), 240) });
  }
  return false;
}
const TEST_PIPELINE_STEPS = [
  ["select", "Select"],
  ["discovery", "Products"],
  ["assets", "Images"],
  ["hdImages", "HD Images"],
  ["syl", "ShopYourLikes"],
  ["shortlink", "Shortlink"],
  ["plan", "Plan"],
  ["post", "Post"],
  ["postUrl", "Post URL"],
  ["comment", "Comment"],
];
const TEST_STEP_STATUSES = new Set(["waiting", "running", "done", "failed", "skipped"]);
const TEST_RUN_STATUSES = new Set(["idle", "running", "ready", "done", "blocked", "failed"]);
const LIVE_TEST_CONFIRMATION = "PUBLISH TEST";
const LIVE_FULL_CONFIRMATION = "PUBLISH FULL PLAN";
const IXBROWSER_EXECUTABLE_CANDIDATES = [
  "C:\\Program Files\\ixBrowser\\ixBrowser.exe",
  "C:\\Program Files (x86)\\ixBrowser\\ixBrowser.exe",
  path.join(process.env.APPDATA || "", "ixBrowser-Resources", "synchronizer", "ixBrowser.exe"),
  path.join(process.env.LOCALAPPDATA || "", "Programs", "ixBrowser", "ixBrowser.exe"),
].filter(Boolean);
const IXBROWSER_DESKTOP_LOGIN_WAIT_MS = 300000;
const IXBROWSER_DESKTOP_START_WAIT_MS = 60000;
const IXBROWSER_DESKTOP_RECOVERY_POLL_MS = 2000;
const IXBROWSER_DESKTOP_LOGIN_ASSIST_INTERVAL_MS = 30000;
const IXBROWSER_DESKTOP_LOGIN_ASSIST_TIMEOUT_MS = 10000;
const SECRET_SECTIONS = ["openai", "openrouter", "webshare", "proxyProvider", "ixbrowser", "shopyourlikes", "shortlink", "extension", "firecrawl", "affiliateProxy"];
const API_KEY_SECTIONS = ["openai", "openrouter", "webshare", "proxyProvider", "ixbrowser", "shopyourlikes", "shortlink", "extension", "firecrawl"];
const REAL_ROOT = fs.realpathSync(ROOT);
function loadOrCreateDashboardToken() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const token = fs.readFileSync(DASHBOARD_TOKEN_FILE, "utf8").trim();
    if (token) return token;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const token = crypto.randomBytes(32).toString("hex");
  const tempFile = `${DASHBOARD_TOKEN_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, `${token}\n`, { mode: 0o600 });
  fs.renameSync(tempFile, DASHBOARD_TOKEN_FILE);
  try { fs.chmodSync(DASHBOARD_TOKEN_FILE, 0o600); } catch {}
  return token;
}
const SESSION_TOKEN = loadOrCreateDashboardToken();
const PROMPT_INJECTION_PATTERN = /\b(ignore|disregard|override|forget)\s+(all\s+)?(previous|prior|above|system|developer|instructions?)|system prompt|developer message|jailbreak|do anything now/i;
const EXTERNAL_SERVICE_TIMEOUT_MS = 20000;
const ALLOWED_WEBSHARE_HOSTS = new Set(["proxy.webshare.io"]);
const ALLOWED_MAVLYNK_HOSTS = new Set(["mavlynk.com", "www.mavlynk.com"]);
const ALLOWED_FIRECRAWL_HOSTS = new Set(["api.firecrawl.dev", "127.0.0.1", "localhost"]);
const EDGE_EXECUTABLE_CANDIDATES = [
  process.env.FACEBOOK_AGENT_EDGE_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);
const DEFAULT_EDGE_USER_DATA_DIR = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "User Data")
  : "";
const DEFAULT_WALMART_CATEGORY_SOURCES = [
  "Toys Deals | https://www.walmart.com/shop/savings/toys?povid=GlobalNav_rWeb_BabyKidsToys_ToysGames_deals&facet=special_offers%3AClearance%7C%7Cspecial_offers%3AReduced+Price%7C%7Cspecial_offers%3ARollback%7C%7Cretailer_type%3APro+Sellers",
  "Women's Plus | https://www.walmart.com/browse/womens-plus/5438_133195?facet=special_offers%3AClearance%7C%7Cspecial_offers%3AReduced+Price%7C%7Cspecial_offers%3ARollback%7C%7Cretailer_type%3APro+Sellers",
].join("\n");
const DEFAULT_WALMART_SEARCH_QUERIES = "garden\nsummer";
const DEFAULT_WALMART_DISCOVERY_URLS = [
  "https://www.walmart.com/shop/savings/toys?povid=GlobalNav_rWeb_BabyKidsToys_ToysGames_deals&facet=special_offers%3AClearance%7C%7Cspecial_offers%3AReduced+Price%7C%7Cspecial_offers%3ARollback%7C%7Cretailer_type%3APro+Sellers",
  "https://www.walmart.com/browse/womens-plus/5438_133195?facet=special_offers%3AClearance%7C%7Cspecial_offers%3AReduced+Price%7C%7Cspecial_offers%3ARollback%7C%7Cretailer_type%3APro+Sellers",
  "https://www.walmart.com/search?q=garden&facet=special_offers%3AClearance%7C%7Cspecial_offers%3AReduced+Price%7C%7Cspecial_offers%3ARollback%7C%7Cretailer_type%3APro+Sellers",
  "https://www.walmart.com/search?q=summer&facet=special_offers%3AClearance%7C%7Cspecial_offers%3AReduced+Price%7C%7Cspecial_offers%3ARollback%7C%7Cretailer_type%3APro+Sellers",
].join("\n");
const DEFAULT_BLOCKED_IXBROWSER_PROFILES = "wise";
const DEFAULT_MODERATOR_IXBROWSER_PROFILES = "41 - moderator\n42 - moderator";

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(LOCAL_DB_DIR, { recursive: true });
try { fs.mkdirSync(AUDIT_DIR, { recursive: true }); } catch {}
if (!fs.existsSync(JOBS_FILE)) fs.writeFileSync(JOBS_FILE, "[]\n");
if (!fs.existsSync(APPROVALS_FILE)) fs.writeFileSync(APPROVALS_FILE, "[]\n");
if (!fs.existsSync(FB_LIVE_POST_LEDGER_FILE)) fs.writeFileSync(FB_LIVE_POST_LEDGER_FILE, "");
if (!fs.existsSync(STATE_FILE)) fs.writeFileSync(STATE_FILE, JSON.stringify(defaultState(), null, 2) + "\n");
if (!fs.existsSync(SECRETS_FILE)) {
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(defaultSecrets(), null, 2) + "\n");
  try { fs.chmodSync(SECRETS_FILE, 0o600); } catch {}
}

let enabled = false;
let active = null;
let localDiscoverySession = null;
let localShopYourLikesSession = null;
let heartbeat = {
  startedAt: new Date().toISOString(),
  lastBeat: new Date().toISOString(),
  enabled,
  activeJobId: null,
  status: "idle",
};
let lastAuthFailureLogAt = 0;
let lastIxBrowserAutoOpenAt = 0;
const ixBrowserCdpEndpointCache = new Map();
const ixBrowserProfileOpenLocks = new Map();
const normalIxProfileUseLocks = new Map();

function parseJsonFile(filePath) {
  let lastError = null;
  const delays = [0, 30, 80, 160, 320, 640, 1000];
  for (const delay of delays) {
    if (delay) sleepSync(delay);
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
    } catch (err) {
      lastError = err;
      if (err?.code && !["ENOENT", "EBUSY", "EPERM", "EACCES"].includes(err.code) && err.name !== "SyntaxError") break;
    }
  }
  throw lastError;
}

function readJobs() {
  try {
    return parseJsonFile(JOBS_FILE);
  } catch {
    return [];
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function atomicWrite(filePath, content) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  let lastError = null;
  const retryDelays = [40, 80, 160, 320, 640, 1000, 1500, 2200, 3000, 4000];
  for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
    try {
      fs.writeFileSync(tempPath, content, "utf8");
      fs.renameSync(tempPath, filePath);
      return;
    } catch (err) {
      lastError = err;
      if (!["EPERM", "EACCES", "EBUSY"].includes(err?.code) || attempt === retryDelays.length - 1) break;
      sleepSync(retryDelays[attempt]);
    }
  }
  if (["EPERM", "EACCES", "EBUSY"].includes(lastError?.code)) {
    try {
      fs.writeFileSync(tempPath, content, "utf8");
      fs.copyFileSync(tempPath, filePath);
      fs.unlinkSync(tempPath);
      return;
    } catch (err) {
      lastError = err;
    }
  }
  try { fs.unlinkSync(tempPath); } catch {}
  throw lastError;
}

function writeJobs(jobs) {
  atomicWrite(JOBS_FILE, JSON.stringify(jobs, null, 2) + "\n");
}

function readApprovalDecisions() {
  try {
    const rows = parseJsonFile(APPROVALS_FILE);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function writeApprovalDecisions(rows) {
  atomicWrite(APPROVALS_FILE, JSON.stringify(Array.isArray(rows) ? rows.slice(0, 1000) : [], null, 2) + "\n");
}

function approvalId(source, value) {
  return crypto.createHash("sha256").update(`${source}\n${value}`).digest("hex").slice(0, 18);
}

function latestApprovalDecisionMap() {
  const map = new Map();
  for (const row of readApprovalDecisions()) {
    if (!row?.id) continue;
    map.set(row.id, row);
  }
  return map;
}

function defaultTestRunState() {
  return {
    status: "idle",
    active: false,
    updatedAt: "",
    progress: {
      title: "Idle",
      percent: 0,
      detail: "No 1-post test is running.",
      tone: "idle",
      updatedAt: "",
    },
    timing: {
      startedAt: "",
      finishedAt: "",
      elapsedMs: 0,
    },
    steps: Object.fromEntries(TEST_PIPELINE_STEPS.map(([id, label]) => [id, { label, status: "waiting", detail: "" }])),
    result: {
      profile: "",
      groupUrl: "",
      planId: "",
      postUrl: "",
      candidatePostUrls: [],
    },
  };
}

// Parallel-test live progress. Workers update the in-memory array directly
// (atomic on the single JS thread), and a single flusher writes it into
// state.testParallel.lanes so the dashboard can poll /api/state and render one
// live lane per parallel post — without N concurrent writeState() calls racing.
let __testParallelLanes = [];
let __testParallelFlushTimer = null;
function flushTestParallelLanes() {
  try {
    const s = readState();
    if (!s.testParallel) s.testParallel = { active: false, parallelPosts: 4, lanes: [], updatedAt: "" };
    s.testParallel.lanes = __testParallelLanes.map((lane) => ({ ...lane }));
    s.testParallel.active = __testParallelLanes.some((lane) => lane.status === "running");
    s.testParallel.updatedAt = new Date().toISOString();
    writeState(s);
  } catch (err) { /* best-effort live flush; final write still happens */ }
}
function setTestParallelLane(index, patch) {
  const cur = __testParallelLanes[index] || {};
  const next = { ...cur, ...patch };
  if (next.startedAt) {
    const end = next.finishedAt ? new Date(next.finishedAt).getTime() : Date.now();
    next.elapsedMs = Math.max(0, end - new Date(next.startedAt).getTime());
  }
  __testParallelLanes[index] = next;
}
let __testParallelStopRequested = false;
// Hard-stop a running parallel test: set the stop flag (no NEW worker proceeds past its
// stop check), clear the live-flush timer, mark any non-terminal lanes "stopped", and
// persist testParallel inactive so the dashboard reflects it immediately. A post already
// submitted to Facebook can't be un-sent, but the run stops advancing and the UI clears.
function stopTestParallel(reason = "operator_stop") {
  __testParallelStopRequested = true;
  if (__testParallelFlushTimer) { clearInterval(__testParallelFlushTimer); __testParallelFlushTimer = null; }
  // CLEAR the lanes entirely on Stop so the dashboard display empties immediately (previously
  // the terminal lanes lingered on screen and looked like a still-running test).
  __testParallelLanes = [];
  try {
    const s = readState();
    if (!s.testParallel) s.testParallel = { active: false, parallelPosts: 4, lanes: [], updatedAt: "" };
    s.testParallel.lanes = [];
    s.testParallel.active = false;
    s.testParallel.updatedAt = new Date().toISOString();
    writeState(s);
  } catch (err) { /* best-effort */ }
  logEvent("test_parallel_posts_stopped", { reason });
}

function defaultState() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    testRun: defaultTestRunState(),
    testParallel: { active: false, parallelPosts: 3, lanes: [], updatedAt: "" },
    operator: {
      armedForExternalActions: false,
      autopilotEnabled: false,
      autopilotTickSeconds: 120,
      autopilotDryRun: true,
      autopilotProfileAllowlist: "",
      commentCooldownHours: 48, // a profile whose comment fails/gets auto-removed is benched from commenting this long, then retried
      autopilotMaxPostsPerRun: 0, // HARD per-run cap: 0 = unlimited; >0 = auto-disarm after exactly N confirmed posts
      autopilotPostsThisRun: 0, // counter of confirmed posts since the run was armed (reset on each fresh arm)
      autopilotWorkerStaggerSeconds: 25,
      adminApprovalSettleSeconds: 3,
      parallelOpenStaggerSeconds: 8,
      cpuGovernorEnabled: true,
      cpuGovernorMaxPercent: 85,
      cpuGovernorMaxWaitSeconds: 120,
      auditLogRetentionDays: 30, // durable data/audit/audit-YYYY-MM-DD.log kept this many days
      perPostLogRetentionDays: 14, // data/fb-live-post-log-*.json detail logs kept this many days
      prepareTomorrowTarget: 50,
      approvalRequired: true,
      scheduleEnabled: false,
      scheduleTimezone: "America/New_York",
      runDays: "Mon\nTue\nWed\nThu\nFri\nSat\nSun",
      startTime: "",
      stopTime: "",
    },
    rules: {
      minutesBetweenPosts: 12,
      randomMinutesBetweenPosts: true,
      minMinutesBetweenPosts: 5,
      maxMinutesBetweenPosts: 16,
      secondsBetweenPostsMin: 0,
      secondsBetweenPostsMax: 0,
      commentsBeforeAccountMove: 5,
      maxCommentsBeforeAccountSave: 10,
      postsPerProfilePerDay: 5,
      peakHoursTimezone: "America/New_York",
      peakStartTime: "18:00",
      peakStopTime: "23:00",
      requireDealSignal: "10+ bought since yesterday",
      linkPlacement: "pinned_first_comment",
      pinFirstComment: false,
      postBodyLinkAllowed: false,
      pauseOnErrors: true,
      pauseOnInvalidProxy: true,
      pauseOnLimitedAccount: true,
    },
    posting: {
      groups: "",
      groupAssignmentMode: "percentage_manual_review",
      groupProfileAssignments: "",
      groupAssignmentData: [],
      // CONTENT SOURCE GROUPS (default OFF): harvest recent posts (text + image + the link in the first
      // comment) from these source FB groups and re-use them as ready-to-post content. enabled=false =>
      // byte-for-byte current behavior (nothing reads groupsText). One facebook.com/groups/… URL per line.
      contentSources: { enabled: false, groupsText: "", notes: "" },
      groupFallbackPolicy: "if a profile cannot post in its selected group, try the next available group URL from this run; if no group works, skip that profile and record the issue with profile id/name",
      profileGroupIssueLogEndpoint: "/api/posting/profile-group-issue",
      publishedPostUrls: "",
      sourceUrls: "",
      shortlinks: "",
      commentTemplate: "Check this deal: {link}",
      ownedGroupsByProfile: "",
      facebookProfileStatus: "",
      readyDescriptionsPath: "",
      readyImagesPath: "",
      moderatorAccountNotes: "Moderator accounts are approval-only: approve pending group posts, then normal non-moderator profiles add first comments.",
    },
    productAssets: {
      enabled: true,
      productUrls: "",
      reviewImagesPerProduct: 1,
      reviewCandidateCount: REVIEW_IMAGE_CANDIDATE_COUNT,
      useHermesImageReview: true,
      imageSelectionModel: "hermes_default_llm",
      chatgptHdEnabled: false,
      chatgptHdConversationLimit: 9, // generate this many HD images per ChatGPT conversation, then rotate to a fresh one
      chatgptEdgeCdp: "http://127.0.0.1:9334",
      chatgptEdgeUserDataDir: AGENT_CHATGPT_EDGE_USER_DATA_DIR,
      chatgptEdgeProfileDirectory: "Default",
      minReviewRating: 4,
      preferredReviewRating: 5,
      requireCustomerReviewImages: true,
      requireRealisticImages: true,
      requirePositiveReviewsOnly: true,
      approvalRequired: true,
      reviewImageCandidates: "",
      selectedReviewImages: "",
      blacklistedProducts: "",
      outputPath: "data/product-assets",
      notes: "For each product page, inspect public product/review media and collect up to 5 realistic customer review image candidates from positive reviews only. Accept 4-5 star reviews, prioritize 5-star reviews, ask the Hermes default LLM/image reviewer to select the best candidate, then save exactly 1 selected image as a descriptive SEO-safe JPG/PNG filename. Upgrade it through the logged-in ChatGPT browser account for HD quality and always ask ChatGPT to correct product orientation/upright rotation when enabled. Facebook upload files must be JPG or PNG, never WebP.",
    },
    contentRotation: {
      usePostTextsInOrder: true,
      avoidPostTextReuse: true,
      postTexts: "",
      postTextCursor: 0,
      useCommentLeadInsInOrder: true,
      avoidCommentLeadInReuse: true,
      commentLeadIns: "",
      commentLeadInCursor: 0,
      notes: "One line per item. Use post text lines in order for Facebook post bodies. Use comment lead-in lines in order before the shortlink in the pinned first comment.",
    },
    dealSource: {
      source: "Amazon, Walmart, Target",
      allowedRetailers: "amazon.com\nwalmart.com\ntarget.com",
      selectedFilters: "Clearance, Reduced Price, Rollback, Pro Sellers",
      priceFilter: "",
      brandFilter: "",
      colorFilter: "",
      categoryFilter: "Toys Deals, Women's Plus, garden, summer",
      notes: "Use recent activity signal before preparing posts. Start with Walmart daily deal discovery, but keep source rules store-agnostic.",
    },
    productDiscovery: {
      enabled: true,
      primaryStore: "walmart",
      dailyRefreshEnabled: true,
      reusePostedProductAfterDays: 7,
      retryNoReviewPhotoAfterDays: 14,
      assetBufferTarget: 0,
      assetFillBatchSize: 9, // prepare products "9 by 9" — one #40 SYL session + one ChatGPT-HD conversation per batch

      autopilotDiscoveryMaxAgeHours: 20,
      maxDiscoveryPagesPerSource: 5,
      requireProSeller: true,
      includeClearance: true,
      includeReducedPrice: true,
      includeRollback: true,
      allowedRetailers: "walmart.com\namazon.com\ntarget.com",
      walmartCategorySources: DEFAULT_WALMART_CATEGORY_SOURCES,
      walmartSearchQueries: DEFAULT_WALMART_SEARCH_QUERIES,
      otherStoreSourceUrls: "",
      generatedSourceUrls: DEFAULT_WALMART_DISCOVERY_URLS,
      minActivitySignal: "10+ bought since yesterday",
      targetMode: "assigned_profiles_x_posts_per_day",
      assignedProfileCount: 0,
      dailyPostTarget: 0,
      candidateBufferPercent: 20,
      targetCandidateCount: 0,
      rankingRules: "Prioritize fresh reduced-price products with clear deal signal, strong positive reviews, safe product images, affiliate compatibility, and no prior use in the posted-product register.",
      notes: "Generated source URLs are discovery pages/searches, not final product URLs. Hermes should inspect these with a browser, rank candidates, reject products already posted, then move unique chosen product pages into Product URLs.",
    },
    affiliate: {
      service: "ShopYourLikes",
      enabled: true,
      cleanExistingAffiliateLinks: true,
      shortenAfterAffiliate: true,
      useDedicatedIxProfile: true,
      dedicatedIxProfileId: "",
      dedicatedIxProfileName: "",
      dedicatedIxProfileFixedIp: true,
      rotateDedicatedProfileIp: false,
      generateShortlinksInDedicatedProfile: false,
      browserProfilePath: "data/shopyourlikes-browser-profile",
      browserStartUrl: "https://www.shopyourlikes.com/",
      browserUseDedicatedProxy: true,
      browserSelectedProxyId: "",
      browserLastOpenedAt: "",
      browserStatus: "not opened",
      apiRequestsUseDedicatedProxy: true,
      originalLinks: "",
      cleanedLinks: "",
      shopyourlikesLinks: "",
      finalShortlinks: "",
      linkMappings: [],
      lastExtensionRunAt: "",
      notes: "Clean existing affiliate/tracking parameters first. Generate the ShopYourLikes affiliate link from the browser extension while the retailer product page is open in the dedicated IXBrowser profile, then shorten that SYL link with Mavlynk. The posting planner requires the final Mavlynk shortlink to be mapped to the ShopYourLikes URL for the same product. Do not rotate any dedicated ShopYourLikes profile/IP.",
    },
    shortlink: {
      provider: "Mavlynk",
      enabled: true,
      apiStatus: "not configured",
      useAffiliateDedicatedIxProfile: false,
      apiRequestsUseAffiliateProxy: false,
      notes: "Mavlynk may use the local machine IP. In affiliate mode, shorten only the ShopYourLikes extension-generated affiliate URL before posting.",
    },
    affiliateProxy: {
      enabled: true,
      provider: "Webshare",
      requiredCountry: "US",
      staticOnly: true,
      lockedToSelectedProxy: true,
      apiRequestsMustUseProxy: true,
      selectedProxyId: "",
      proxyAddress: "",
      proxyPort: "",
      lastAssignedAt: "",
      lastTestAt: "",
      lastObservedIp: "",
      lastObservedCountry: "",
      status: "not configured",
      notes: "Dedicated private US proxy/IP is reserved for the ShopYourLikes IXBrowser extension/login profile. Mavlynk can use the local machine IP.",
    },
    webshare: {
      enabled: false,
      apiStatus: "not configured",
      currentIp: "",
      failedIps: "",
      notes: "Store API keys outside this project. Track IPs that did not work.",
    },
    proxyProvider: {
      provider: "Webshare",
      enabled: true,
      apiStatus: "not configured",
      requiredLocation: "US",
      notes: "Use Webshare proxies. Track bad proxies and request approval before removing or switching.",
    },
    ixbrowser: {
      enabled: true,
      apiStatus: "not configured",
      maxProfilesPerRun: 100000, // effectively "use ALL assigned profiles" (was 5 — that burned the same 5 accounts into a Facebook throttle). Scales to 3000+ profiles; least-used-first keeps each account's load minimal.
      maxConcurrentProfiles: MAX_CONCURRENT_NORMAL_IX_PROFILES,
      profilesForNextRun: "",
      activeProfiles: "",
      blockedProfiles: DEFAULT_BLOCKED_IXBROWSER_PROFILES,
      moderatorProfiles: DEFAULT_MODERATOR_IXBROWSER_PROFILES,
      failedProfiles: "",
      reconcileMissStreak: "{}",
      profileIpMap: "",
      accountSelector: "",
      profileRunNotes: "Use only the selected/queued normal profiles for the next run. Never run more than 4 normal Facebook/IXBrowser accounts in parallel by default. The editable blocked-profile list, moderator approval accounts, and dedicated ShopYourLikes profile are excluded from normal posting/comment rotation.",
      notes: "Each IXBrowser profile should map to one proxy and one Facebook account.",
    },
    memory: {
      compactHermesPrompts: true,
      includeMiroContext: true,
      maxPromptUrlLines: 80,
      maxPromptTextLines: 120,
      maxPromptTextLineLength: 260,
      maxJobRuntimeMinutes: 30,
      maxQueuedJobs: 50,
      notes: "Keep Hermes prompts compact. Summarize large banks and cap job runtime/output so context windows stay usable.",
    },
    triggers: {
      heartbeatSeconds: 3,
      autoStartQueuedJobs: false,
      pauseWhenSecurityWarnings: true,
      pauseWhenExternalPortsChange: true,
      notes: "Triggers define when the local worker is allowed to run. External actions still require the arm switch.",
    },
    security: {
      lastAuditAt: "",
      dashboardHost: HOST,
      dashboardPort: PORT,
      requireDashboardToken: true,
      rejectCrossOriginRequests: true,
      notes: "Dashboard is local-only. Machine-level ports are audited but not closed automatically to avoid locking out remote administration.",
    },
    tracking: {
      dailyActionLog: "",
      notes: "Track action/comment counts by day, account, profile, and IP before moving accounts.",
    },
    extension: {
      enabled: false,
      name: "ShopYourLikes",
      apiStatus: "not configured",
      source: "",
      shopifyUrlWorkflow: true,
      notes: "ShopYourLikes creates affiliate links. Use clean retailer URLs first.",
    },
    files: {
      inactiveAccounts: "data/inactive-accounts.txt",
      invalidProxies: "data/invalid-proxies.txt",
      limitedAccounts: "data/limited-accounts.txt",
      downFacebookProfiles: "data/down-facebook-profiles.txt",
      pendingApprovals: "data/pending-approvals.txt",
      affiliateLinks: "data/affiliate-links.txt",
      accountsToReview: "data/accounts-to-review.txt",
      failedIps: "data/failed-ips.txt",
      productCandidates: "data/product-candidates.jsonl",
      productReviewImages: "data/product-review-images.txt",
      postingPlan: "data/posting-plan.jsonl",
      usedProducts: "data/used-products.txt",
      noReviewPhotoProducts: "data/no-review-photo-products.txt",
      productTitles: "data/product-titles.txt",
      blacklistedProducts: "data/blacklisted-products.txt",
      usedPostTexts: "data/used-post-texts.txt",
      usedCommentLeadIns: "data/used-comment-leadins.txt",
      errors: "data/errors.txt",
      harvestedProducts: "data/harvested-products.jsonl",
    },
  };
}

function defaultSecrets() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    openai: {
      apiKey: "",
      notes: "Optional. Hermes currently uses OpenAI/Codex auth outside this project.",
    },
    openrouter: {
      apiKey: "",
      notes: "Optional mirror only. Hermes fallback key is stored in ~/.hermes/.env.",
    },
    webshare: {
      apiKey: "",
      baseUrl: "https://proxy.webshare.io/api/v2",
      mode: "direct",
      notes: "Used to list proxies and apply selected proxy to IXBrowser profiles.",
    },
    proxyProvider: {
      apiKey: "",
      baseUrl: "https://proxy.webshare.io/api/v2",
      providerName: "Webshare",
      notes: "Webshare is the confirmed proxy provider.",
    },
    ixbrowser: {
      apiKey: "",
      baseUrl: "http://127.0.0.1:53200/api/v2",
      notes: "ixBrowser local API usually does not require an API key. Keep it on 127.0.0.1.",
    },
    shopyourlikes: {
      apiKey: "",
      publisherId: "",
      baseUrl: "",
      notes: "ShopYourLikes is handled through the browser extension/login in the dedicated IXBrowser profile.",
    },
    shortlink: {
      apiKey: "",
      baseUrl: "https://mavlynk.com/",
      providerName: "Mavlynk",
      notes: "Mavlynk shortlink API details still need confirmation.",
    },
    extension: {
      apiKey: "",
      baseUrl: "",
      notes: "Optional browser extension API details when the exact extension is confirmed.",
    },
    firecrawl: {
      apiKey: "",
      baseUrl: "https://api.firecrawl.dev/",
      providerName: "Firecrawl",
      notes: "Primary product-page customer review image extractor. Uses enhanced proxy and converts one selected image per product to local JPG/PNG for Facebook upload.",
    },
    affiliateProxy: {
      proxyType: "http",
      host: "",
      port: "",
      username: "",
      password: "",
      provider: "Webshare",
      proxyId: "",
      notes: "Dedicated fixed US proxy for ShopYourLikes and Mavlynk API requests. Credentials are not sent to Hermes.",
    },
  };
}

function readState() {
  try {
    const state = deepMerge(defaultState(), parseJsonFile(STATE_FILE));
    normalizeWorkflowState(state);
    return state;
  } catch (err) {
    logEvent("workflow_state_read_failed", { error: String(err) });
    return defaultState();
  }
}

function readSecrets() {
  try {
    return deepMerge(defaultSecrets(), parseJsonFile(SECRETS_FILE));
  } catch (err) {
    logEvent("secrets_read_failed", { error: String(err) });
    return defaultSecrets();
  }
}

function writeSecrets(patch) {
  const existing = readSecrets();
  const next = deepMerge(existing, patch || {});
  sanitizeSecretInput(next);
  for (const section of API_KEY_SECTIONS) {
    if (!next[section]) continue;
    if (patch?.[section]?.clearApiKey) {
      next[section].apiKey = "";
    } else if (Object.prototype.hasOwnProperty.call(patch?.[section] || {}, "apiKey") && !patch[section].apiKey) {
      next[section].apiKey = existing[section].apiKey;
    }
    delete next[section].clearApiKey;
  }
  next.webshare.baseUrl = normalizeAllowedServiceBaseUrl(next.webshare.baseUrl || defaultSecrets().webshare.baseUrl, ALLOWED_WEBSHARE_HOSTS, "Webshare");
  next.proxyProvider.baseUrl = normalizeAllowedServiceBaseUrl(next.proxyProvider.baseUrl || defaultSecrets().proxyProvider.baseUrl, ALLOWED_WEBSHARE_HOSTS, "Proxy provider");
  if (next.ixbrowser?.baseUrl) {
    next.ixbrowser.baseUrl = normalizeIxBrowserBaseUrl(next.ixbrowser.baseUrl);
  }
  next.shortlink.baseUrl = normalizeOptionalServiceBaseUrl(next.shortlink.baseUrl || defaultSecrets().shortlink.baseUrl, "Mavlynk", ALLOWED_MAVLYNK_HOSTS);
  next.shopyourlikes.baseUrl = normalizeOptionalServiceBaseUrl(next.shopyourlikes.baseUrl, "ShopYourLikes");
  next.firecrawl.baseUrl = normalizeOptionalServiceBaseUrl(next.firecrawl.baseUrl || defaultSecrets().firecrawl.baseUrl, "Firecrawl", ALLOWED_FIRECRAWL_HOSTS);
  if (patch?.affiliateProxy) {
    if (patch.affiliateProxy.clearApiKey) {
      next.affiliateProxy.host = "";
      next.affiliateProxy.port = "";
      next.affiliateProxy.username = "";
      next.affiliateProxy.password = "";
      next.affiliateProxy.proxyId = "";
    } else {
      for (const key of ["host", "port", "username", "password", "proxyId"]) {
        if (Object.prototype.hasOwnProperty.call(patch.affiliateProxy, key) && !patch.affiliateProxy[key]) {
          next.affiliateProxy[key] = existing.affiliateProxy[key];
        }
      }
    }
    delete next.affiliateProxy.clearApiKey;
  }
  next.updatedAt = new Date().toISOString();
  atomicWrite(SECRETS_FILE, JSON.stringify(next, null, 2) + "\n");
  try { fs.chmodSync(SECRETS_FILE, 0o600); } catch {}
  return next;
}

function sanitizeSecretInput(secrets) {
  for (const section of API_KEY_SECTIONS) {
    if (!secrets[section]) continue;
    for (const key of ["apiKey", "baseUrl", "publisherId", "providerName", "mode"]) {
      if (Object.prototype.hasOwnProperty.call(secrets[section], key)) {
        secrets[section][key] = String(secrets[section][key] || "").trim();
      }
    }
  }
  if (secrets.affiliateProxy) {
    for (const key of ["proxyType", "host", "port", "username", "provider", "proxyId"]) {
      if (Object.prototype.hasOwnProperty.call(secrets.affiliateProxy, key)) {
        secrets.affiliateProxy[key] = String(secrets.affiliateProxy[key] || "").trim();
      }
    }
    secrets.affiliateProxy.host = normalizeProxyHost(secrets.affiliateProxy.host);
    secrets.affiliateProxy.port = normalizePort(secrets.affiliateProxy.port, "Affiliate proxy port", { allowBlank: true });
  }
}

function publicSecrets(secrets = readSecrets()) {
  const copy = JSON.parse(JSON.stringify(secrets));
  for (const section of API_KEY_SECTIONS) {
    const apiKey = copy[section]?.apiKey || "";
    copy[section].hasApiKey = Boolean(apiKey);
    copy[section].apiKey = "";
  }
  copy.affiliateProxy.hasProxy = Boolean(copy.affiliateProxy?.host && copy.affiliateProxy?.port);
  copy.affiliateProxy.hasUsername = Boolean(copy.affiliateProxy?.username);
  copy.affiliateProxy.hasPassword = Boolean(copy.affiliateProxy?.password);
  copy.affiliateProxy.host = copy.affiliateProxy.host ? maskHost(copy.affiliateProxy.host) : "";
  copy.affiliateProxy.username = "";
  copy.affiliateProxy.password = "";
  return copy;
}

function applyApiStatusesToState(state, secrets = readSecrets()) {
  state.webshare.apiStatus = secrets.webshare.apiKey ? "configured" : "missing key";
  state.proxyProvider.apiStatus = secrets.proxyProvider.apiKey || secrets.webshare.apiKey ? "configured" : "missing key";
  state.ixbrowser.apiStatus = secrets.ixbrowser.baseUrl ? "configured" : "missing URL";
  state.shortlink.apiStatus = secrets.shortlink.apiKey ? "configured" : "missing key";
  state.extension.apiStatus = "not used";
  state.productAssets.extractorStatus = secrets.firecrawl.apiKey || process.env.FIRECRAWL_API_KEY ? "Firecrawl configured" : "Jina Reader fallback only";
  return state;
}

function buildIntegrationHealth() {
  const secrets = readSecrets();
  const state = applyApiStatusesToState(readState(), secrets);
  const check = (id, label, ok, message, options = {}) => ({
    id,
    label,
    required: options.required !== false,
    ok: Boolean(ok),
    status: ok ? "ready" : options.required === false ? "optional_not_configured" : "needs_setup",
    message,
  });
  const services = [
    check("webshare", "Webshare API", secrets.webshare.apiKey, secrets.webshare.apiKey ? "API key saved; live test still required." : "Missing Webshare API key."),
    check("ixbrowser", "IXBrowser local API", secrets.ixbrowser.baseUrl, secrets.ixbrowser.baseUrl ? "Local API URL saved; session login tested by Test IXBrowser." : "Missing IXBrowser local API URL."),
    check("affiliateProxy", "Dedicated ShopYourLikes proxy", secrets.affiliateProxy.host && secrets.affiliateProxy.port && state.affiliateProxy.staticOnly && state.affiliateProxy.lockedToSelectedProxy, secrets.affiliateProxy.host && secrets.affiliateProxy.port ? "Proxy credentials saved for the dedicated ShopYourLikes browser profile." : "Optional until you require a fixed ShopYourLikes proxy/IP.", { required: false }),
    check("shopyourlikes", "ShopYourLikes IXBrowser profile", state.affiliate.dedicatedIxProfileId || state.affiliate.dedicatedIxProfileName, state.affiliate.dedicatedIxProfileId ? `Dedicated IXBrowser profile selected: ${state.affiliate.dedicatedIxProfileId}` : "Select a dedicated IXBrowser profile for ShopYourLikes extension/login.", { required: false }),
    check("shortlink", "Mavlynk API", secrets.shortlink.apiKey, secrets.shortlink.apiKey ? "API key saved." : "Missing Mavlynk API key."),
  ];
  const requiredMissing = services.filter((service) => service.required && !service.ok).length;
  const optionalMissing = services.filter((service) => !service.required && !service.ok).length;
  return {
    at: new Date().toISOString(),
    summary: {
      requiredMissing,
      optionalMissing,
      ready: requiredMissing === 0,
    },
    services,
  };
}

function maskSecret(value) {
  if (!value) return "";
  if (value.length <= 8) return "********";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function maskHost(value) {
  const text = String(value || "");
  if (!text) return "";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) {
    const parts = text.split(".");
    return `${parts[0]}.${parts[1]}.*.${parts[3]}`;
  }
  if (text.length <= 10) return "********";
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function writeState(state, opts = {}) {
  const existing = readState();
  const clean = deepMerge(defaultState(), state);
  // CONTROL-FLAG CLOBBER GUARD: an in-flight autopilot tick (or any background task) holds a
  // STALE state snapshot and may call writeState minutes later. Without this, that stale write
  // resurrects operator control flags the operator just changed (e.g. re-arming after a disarm),
  // which is exactly how a "stop" got lost. UNLESS the caller is the operator's explicit control
  // path (opts.controlWrite === true), preserve the freshest ON-DISK values for these flags so a
  // stale snapshot can never override a fresh enable/disable/arm/disarm or the per-run counter.
  if (!opts.controlWrite) {
    const exOp = existing.operator || {};
    clean.operator = clean.operator || {};
    for (const f of ["autopilotEnabled", "armedForExternalActions", "autopilotDryRun", "autopilotPostsThisRun"]) {
      if (Object.prototype.hasOwnProperty.call(exOp, f)) clean.operator[f] = exOp[f];
    }
  }
  clean.ixbrowser.failedProfiles = mergeProtectedRecordLines(
    clean.ixbrowser?.failedProfiles,
    existing.ixbrowser?.failedProfiles,
  );
  clean.posting.facebookProfileStatus = mergeProtectedRecordLines(
    clean.posting?.facebookProfileStatus,
    existing.posting?.facebookProfileStatus,
  );
  if (
    (!Array.isArray(clean.posting?.groupAssignmentData) || !clean.posting.groupAssignmentData.some((entry) => Array.isArray(entry?.profiles) && entry.profiles.length)) &&
    Array.isArray(existing.posting?.groupAssignmentData) &&
    existing.posting.groupAssignmentData.some((entry) => Array.isArray(entry?.profiles) && entry.profiles.length)
  ) {
    clean.posting.groupAssignmentData = existing.posting.groupAssignmentData;
    clean.posting.groupProfileAssignments = existing.posting.groupProfileAssignments;
  }
  if (Array.isArray(clean.posting?.groupAssignmentData) && Array.isArray(existing.posting?.groupAssignmentData)) {
    for (const newEntry of clean.posting.groupAssignmentData) {
      if (!newEntry?.url) continue;
      if (Object.prototype.hasOwnProperty.call(newEntry, "requiresAdminApproval") && newEntry.requiresAdminApproval === true) continue;
      const newKey = normalizedFacebookGroupKey(newEntry.url);
      const existingMatch = existing.posting.groupAssignmentData.find((e) => normalizedFacebookGroupKey(e?.url) === newKey);
      if (existingMatch && existingMatch.requiresAdminApproval === true) {
        newEntry.requiresAdminApproval = true;
      }
    }
  }
  mergeAffiliateMappingsIntoState(clean, existing);
  normalizeWorkflowState(clean);
  clean.updatedAt = new Date().toISOString();
  atomicWrite(STATE_FILE, JSON.stringify(clean, null, 2) + "\n");
  return clean;
}

function mergeAffiliateMappingsIntoState(state, existing) {
  const entries = [
    ...(Array.isArray(existing?.affiliate?.linkMappings) ? existing.affiliate.linkMappings : []),
    ...(Array.isArray(state?.affiliate?.linkMappings) ? state.affiliate.linkMappings : []),
  ];
  const byProduct = new Map();
  for (const entry of entries) {
    const mapped = normalizeAffiliateLinkMapping(entry, state);
    if (!mapped) continue;
    const key = mapped.productKey.toLowerCase();
    const existingMapped = byProduct.get(key);
    if (!existingMapped || Date.parse(mapped.updatedAt || "") >= Date.parse(existingMapped.updatedAt || "")) {
      byProduct.set(key, {
        ...(existingMapped || {}),
        ...mapped,
      });
    }
  }
  const mappings = [...byProduct.values()];
  if (!mappings.length) {
    state.affiliate.linkMappings = [];
    return;
  }
  const originalOrder = recordLines(state.affiliate?.originalLinks)
    .map((line) => canonicalProduct(line, state)?.key?.toLowerCase())
    .filter(Boolean);
  const orderIndex = (entry) => {
    const index = originalOrder.indexOf(entry.productKey.toLowerCase());
    return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
  };
  mappings.sort((left, right) => {
    const leftIndex = orderIndex(left);
    const rightIndex = orderIndex(right);
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    return left.productKey.localeCompare(right.productKey);
  });
  state.affiliate.linkMappings = mappings;
  state.affiliate.originalLinks = appendUniqueLines(state.affiliate.originalLinks, mappings.map((entry) => entry.productUrl));
  state.affiliate.shopyourlikesLinks = appendUniqueLines(state.affiliate.shopyourlikesLinks, mappings.map((entry) => entry.sylLink));
  if (state.affiliate?.enabled !== false) {
    const mappedShortlinks = mappings.map((entry) => entry.shortUrl).join("\n");
    state.affiliate.finalShortlinks = mappedShortlinks;
    state.posting.shortlinks = mappedShortlinks;
  }
}

function sanitizeTestRunState(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const clean = defaultTestRunState();
  clean.status = TEST_RUN_STATUSES.has(source.status) ? source.status : clean.status;
  clean.active = Boolean(source.active);
  clean.updatedAt = oneLineField(source.updatedAt || "", 80);

  const progress = source.progress && typeof source.progress === "object" ? source.progress : {};
  clean.progress = {
    title: oneLineField(progress.title || clean.progress.title, 160),
    percent: clampNumber(progress.percent, 0, 100, clean.progress.percent),
    detail: oneLineField(progress.detail || clean.progress.detail, 1000),
    tone: ["idle", "running", "ok", "warn", "danger"].includes(progress.tone) ? progress.tone : clean.progress.tone,
    updatedAt: oneLineField(progress.updatedAt || clean.updatedAt || "", 80),
  };
  const timing = source.timing && typeof source.timing === "object" ? source.timing : {};
  const startedAt = oneLineField(timing.startedAt || source.startedAt || "", 80);
  const finishedAt = oneLineField(timing.finishedAt || source.finishedAt || "", 80);
  const startedMs = Date.parse(startedAt);
  const finishedMs = Date.parse(finishedAt);
  clean.timing = {
    startedAt,
    finishedAt,
    elapsedMs: Number.isFinite(startedMs)
      ? Math.max(0, (Number.isFinite(finishedMs) ? finishedMs : Date.now()) - startedMs)
      : 0,
  };

  const sourceSteps = source.steps && typeof source.steps === "object" ? source.steps : {};
  for (const [id, label] of TEST_PIPELINE_STEPS) {
    const legacyStep = id === "post" && sourceSteps.handoff && typeof sourceSteps.handoff === "object"
      ? sourceSteps.handoff
      : {};
    const step = sourceSteps[id] && typeof sourceSteps[id] === "object" ? sourceSteps[id] : legacyStep;
    clean.steps[id] = {
      label: oneLineField(step.label || label, 80),
      status: TEST_STEP_STATUSES.has(step.status) ? step.status : "waiting",
      detail: oneLineField(step.detail || "", 1000),
    };
  }

  const result = source.result && typeof source.result === "object" ? source.result : {};
  clean.result = {
    profile: oneLineField(result.profile || "", 300),
    groupUrl: oneLineField(result.groupUrl || "", 1000),
    planId: oneLineField(result.planId || "", 160),
    postUrl: oneLineField(result.postUrl || "", 1000),
    candidatePostUrls: Array.isArray(result.candidatePostUrls)
      ? result.candidatePostUrls.map((url) => oneLineField(url, 1000)).filter(Boolean).slice(0, 5)
      : [],
  };
  return clean;
}

function maxCandidateCountFromAttempts(attempts = []) {
  return Math.max(0, ...(attempts || []).map((attempt) => Number(attempt?.candidateCount || 0)));
}

function firstAttemptError(attempts = []) {
  return (attempts || []).find((attempt) => attempt?.error)?.error || "";
}

function summarizeTestAssetResult(selectedResults = [], failedResults = [], state = readState()) {
  const selectedImageCount = selectedResults.length;
  const hdEnabled = state.productAssets?.chatgptHdEnabled !== false;
  const hdImageCount = selectedResults.filter((result) => result.chatgptHd?.ok).length;
  const selected = selectedResults[0] || null;
  const failure = failedResults[0] || null;
  const candidateCount = Math.max(
    Number(selected?.candidateCount || 0),
    Array.isArray(selected?.candidateOptions) ? selected.candidateOptions.length : 0,
    maxCandidateCountFromAttempts(failure?.attempts || []),
  );
  const attemptError = firstAttemptError(failure?.attempts || []);
  const hdError = selectedResults.find((result) => result.chatgptHd && !result.chatgptHd.ok)?.chatgptHd?.error || "";
  const failureError = failure?.chatgptHd?.error || failure?.message || failure?.error || attemptError || "";
  const guardrailError = [hdError, failureError].find((value) => isChatGptImageGuardrailFailure(value)) || "";
  const selector = selected?.selection?.selector || "image selector";
  const baseDetail = selectedImageCount
    ? `${selectedImageCount} selected base JPG image(s) ready. ${candidateCount || selectedImageCount} usable candidate(s) reviewed by ${selector}.`
    : `No selected base JPG image was prepared. ${candidateCount ? `${candidateCount} candidate URL(s) found, but 0 usable JPG image(s) were created.` : "No candidate image reached the converter."}${attemptError ? ` First failure: ${oneLineField(attemptError, 220)}` : ""}`;
  if (!hdEnabled) {
    return { selectedImageCount, hdImageCount, baseDetail, hdStatus: "skipped", hdDetail: "ChatGPT HD disabled.", blocked: !selectedImageCount };
  }
  if (!selectedImageCount) {
    if (guardrailError) {
      return {
        selectedImageCount,
        hdImageCount,
        baseDetail,
        hdStatus: "failed",
        hdDetail: `ChatGPT HD guardrail/similarity blocked the product image; product was blacklisted and skipped. ${oneLineField(guardrailError, 260)}`,
        blocked: true,
      };
    }
    return { selectedImageCount, hdImageCount, baseDetail, hdStatus: "failed", hdDetail: "Blocked before ChatGPT HD: no selected base JPG image was prepared.", blocked: true };
  }
  if (hdImageCount) {
    return {
      selectedImageCount,
      hdImageCount,
      baseDetail,
      hdStatus: "done",
      hdDetail: `${hdImageCount}/${selectedImageCount} HD image(s) ready for Facebook.${selected?.localPath ? ` ${selected.localPath}` : ""}`,
      blocked: false,
    };
  }
  return {
    selectedImageCount,
    hdImageCount,
    baseDetail,
    hdStatus: "failed",
    hdDetail: `ChatGPT HD did not prepare a Facebook-ready PNG/JPG image for ${selectedImageCount} selected base JPG image(s).${hdError ? ` ${oneLineField(hdError, 260)}` : ""}`,
    blocked: true,
  };
}

function applyTestAssetProgressToState(state, selectedResults = [], failedResults = []) {
  const summary = summarizeTestAssetResult(selectedResults, failedResults, state);
  const testRun = sanitizeTestRunState(state.testRun);
  if (!testRun.active && testRun.status !== "running") return summary;
  const now = new Date().toISOString();
  const currentPercent = clampNumber(testRun.progress?.percent, 0, 100, 0);
  testRun.updatedAt = now;
  testRun.status = summary.blocked ? "blocked" : "running";
  testRun.active = !summary.blocked;
  testRun.steps.assets.status = summary.selectedImageCount ? "done" : "failed";
  testRun.steps.assets.detail = summary.baseDetail;
  testRun.steps.hdImages.status = summary.hdStatus;
  testRun.steps.hdImages.detail = summary.hdDetail;
  if (!summary.blocked && testRun.steps.plan.status === "failed" && /base review image|image/i.test(testRun.steps.plan.detail || "")) {
    testRun.steps.plan.status = "waiting";
    testRun.steps.plan.detail = "";
  }
  testRun.progress = {
    title: summary.blocked ? "1-post test: image prep blocked" : "1-post test: images ready",
    percent: Math.max(currentPercent, summary.blocked ? 48 : 58),
    detail: summary.blocked ? (summary.selectedImageCount ? summary.hdDetail : summary.baseDetail) : summary.hdDetail,
    tone: summary.blocked ? "danger" : "running",
    updatedAt: now,
  };
  state.testRun = testRun;
  return summary;
}

function testPrepStepText(testRun, id, fallbackLabel) {
  const step = testRun.steps?.[id] || {};
  const status = step.status || "waiting";
  const detail = step.detail || "waiting";
  return `${fallbackLabel}: ${status} - ${detail}`;
}

function combinedTestPrepProgressDetail(testRun) {
  return oneLineField([
    testPrepStepText(testRun, "assets", "Images"),
    testPrepStepText(testRun, "hdImages", "HD"),
    testPrepStepText(testRun, "syl", "SYL"),
    testPrepStepText(testRun, "shortlink", "Mavlynk"),
    "Plan waits until image/HD and links finish.",
  ].join(" | "), 1000);
}

function persistTestAssetProgressStage(stage = {}) {
  try {
    const state = readState();
    const testRun = sanitizeTestRunState(state.testRun);
    if (!stage.force && !testRun.active && testRun.status !== "running") return null;
    const now = new Date().toISOString();
    testRun.status = stage.status || "running";
    testRun.active = stage.active !== false;
    testRun.updatedAt = now;
    if (stage.assetsStatus) {
      testRun.steps.assets = {
        label: "Images",
        status: stage.assetsStatus,
        detail: oneLineField(stage.assetsDetail || testRun.steps.assets?.detail || "", 1000),
      };
    }
    if (stage.hdStatus) {
      testRun.steps.hdImages = {
        label: "HD Images",
        status: stage.hdStatus,
        detail: oneLineField(stage.hdDetail || testRun.steps.hdImages?.detail || "", 1000),
      };
    }
    const currentPercent = clampNumber(testRun.progress?.percent, 0, 100, 0);
    const nextPercent = clampNumber(stage.percent, 0, 99, currentPercent);
    testRun.progress = {
      title: stage.title || "1-post test: Images/ChatGPT HD + ShopYourLikes/Mavlynk",
      percent: Math.max(currentPercent, nextPercent),
      detail: oneLineField(stage.detail || combinedTestPrepProgressDetail(testRun), 1000),
      tone: stage.tone || "running",
      updatedAt: now,
    };
    state.testRun = testRun;
    const nextState = writeState(state);
    logEvent("test_asset_progress_saved", {
      assets: testRun.steps.assets.status,
      hdImages: testRun.steps.hdImages.status,
      percent: testRun.progress.percent,
    });
    return nextState;
  } catch (err) {
    logEvent("test_asset_progress_save_failed", { error: oneLineField(err.message || String(err), 240) });
    return null;
  }
}

function persistTestRunStepProgress(stage = {}) {
  try {
    const state = readState();
    const testRun = sanitizeTestRunState(state.testRun);
    if (!stage.force && !testRun.active && testRun.status !== "running") return null;
    const now = new Date().toISOString();
    testRun.status = stage.status || "running";
    testRun.active = stage.active !== false;
    testRun.updatedAt = now;
    for (const [id, patch] of Object.entries(stage.steps || {})) {
      const current = testRun.steps?.[id] || {};
      testRun.steps[id] = {
        label: patch.label || current.label || id,
        status: patch.status || current.status || "waiting",
        detail: oneLineField(patch.detail || current.detail || "", 1000),
      };
    }
    const currentPercent = clampNumber(testRun.progress?.percent, 0, 100, 0);
    const nextPercent = clampNumber(stage.percent, 0, 99, currentPercent);
    testRun.progress = {
      title: stage.title || testRun.progress?.title || "1-post test",
      percent: Math.max(currentPercent, nextPercent),
      detail: oneLineField(stage.detail || testRun.progress?.detail || "", 1000),
      tone: stage.tone || "running",
      updatedAt: now,
    };
    state.testRun = testRun;
    const nextState = writeState(state);
    logEvent("test_progress_saved", {
      status: nextState.testRun.status,
      active: nextState.testRun.active,
      percent: nextState.testRun.progress.percent,
    });
    return nextState;
  } catch (err) {
    logEvent("test_progress_save_failed", { error: oneLineField(err.message || String(err), 240) });
    return null;
  }
}

function persistTestAssetFailure(error) {
  const state = readState();
  const testRun = sanitizeTestRunState(state.testRun);
  const now = new Date().toISOString();
  const message = oneLineField(error?.message || String(error || "Product image preparation failed."), 700);
  testRun.status = "blocked";
  testRun.active = false;
  testRun.updatedAt = now;
  testRun.steps.assets.status = "failed";
  testRun.steps.assets.detail = message;
  testRun.steps.hdImages.status = "failed";
  testRun.steps.hdImages.detail = "Blocked before ChatGPT HD because image preparation failed.";
  testRun.progress = {
    title: "1-post test: image prep blocked",
    percent: 48,
    detail: message,
    tone: "danger",
    updatedAt: now,
  };
  state.testRun = testRun;
  return writeState(state);
}

function liveResultValidationErrors(result = {}) {
  return Array.isArray(result?.validation?.errors) ? result.validation.errors.map(String) : [];
}

function liveResultValidationWarnings(result = {}) {
  return Array.isArray(result?.validation?.warnings) ? result.validation.warnings.map(String) : [];
}

function liveResultPostValidationFailed(errors = []) {
  return errors.some((error) => {
    const text = String(error || "");
    if (/comment|pin|ufi/i.test(text)) return false;
    return /post|image|media|marker|approval|permalink|url/i.test(text);
  });
}

function liveResultCommentValidationFailed(errors = []) {
  return errors.some((error) => /comment|pin|ufi/i.test(error));
}

function persistLiveTestResult(result = {}) {
  const state = readState();
  const testRun = sanitizeTestRunState(state.testRun);
  const now = new Date().toISOString();
  const postUrl = oneLineField(result.postUrl || "", 1000);
  const profile = oneLineField(result.profile || result.profileId || "", 300);
  const groupUrl = oneLineField(result.groupUrl || "", 1000);
  const planId = oneLineField(result.planId || "", 160);
  const candidatePostUrls = Array.isArray(result.candidatePostUrls)
    ? result.candidatePostUrls.map((url) => oneLineField(url, 1000)).filter(Boolean).slice(0, 5)
    : [];
  const errors = liveResultValidationErrors(result);
  const warnings = liveResultValidationWarnings(result);
  const ok = Boolean(postUrl && result.ok !== false);
  const detail = oneLineField(result.message || postUrl || "Facebook live connector finished without a verified post URL.", 1000);

  testRun.updatedAt = now;
  testRun.active = false;
  testRun.status = ok ? "done" : "blocked";
  const startedAt = testRun.timing?.startedAt || result.startedAt || now;
  const startedMs = Date.parse(startedAt);
  const finishedMs = Date.parse(now);
  testRun.timing = {
    startedAt,
    finishedAt: now,
    elapsedMs: Number.isFinite(startedMs) && Number.isFinite(finishedMs) ? Math.max(0, finishedMs - startedMs) : 0,
  };
  if (profile || groupUrl) testRun.steps.select = { label: "Select", status: "done", detail: `${profile} ${groupUrl}`.trim() };
  if (testRun.steps.discovery?.status === "waiting") testRun.steps.discovery = { label: "Products", status: "done", detail: "Fresh product discovery completed." };
  if (ok) {
    testRun.steps.post = { label: "Post", status: "done", detail: `Post + HD image verified in ${groupUrl || "Facebook group"}.` };
    testRun.steps.postUrl = { label: "Post URL", status: "done", detail: postUrl };
    testRun.steps.comment = {
      label: "Comment",
      status: "done",
      detail: result.commentProfile
        ? `First comment verified with ${result.commentProfile}.`
        : "First comment verified.",
    };
    testRun.progress = {
      title: "1-post test: published",
      percent: 100,
      detail: warnings.length ? `Published with warning: ${warnings.join(", ")}` : postUrl,
      tone: warnings.length ? "warn" : "ok",
      updatedAt: now,
    };
  } else if (postUrl) {
    const postFailed = liveResultPostValidationFailed(errors);
    const commentFailed = liveResultCommentValidationFailed(errors);
    testRun.steps.post = { label: "Post", status: postFailed ? "failed" : "done", detail: postFailed ? detail : `Post URL captured: ${postUrl}` };
    testRun.steps.postUrl = { label: "Post URL", status: "done", detail: postUrl };
    testRun.steps.comment = { label: "Comment", status: commentFailed ? "failed" : "done", detail: commentFailed ? detail : "First comment/pin did not report an error." };
    testRun.progress = {
      title: "Facebook verification failed",
      percent: 100,
      detail,
      tone: "danger",
      updatedAt: now,
    };
  } else {
    const candidateDetail = candidatePostUrls.length ? ` Candidate permalink: ${candidatePostUrls[0]}` : "";
    testRun.steps.post = { label: "Post", status: result.posted ? "done" : "failed", detail };
    testRun.steps.postUrl = { label: "Post URL", status: "failed", detail: `${detail || "Post URL was not captured."}${candidateDetail}`.trim() };
    testRun.steps.comment = { label: "Comment", status: "failed", detail: result.posted ? "Post URL was not captured, so comment/pin could not be verified." : "Post did not complete." };
    testRun.progress = {
      title: "1-post test: URL capture needed",
      percent: 100,
      detail,
      tone: "danger",
      updatedAt: now,
    };
  }
  testRun.result = { profile, groupUrl, planId, postUrl, candidatePostUrls };
  state.testRun = testRun;
  return writeState(state);
}

function persistLiveTestFailure(error = {}) {
  const result = {
    ...(error?.payload || {}),
    ok: false,
    posted: Boolean(error?.payload?.posted),
    postUrl: error?.payload?.postUrl || "",
    message: error?.message || String(error || "Facebook live publish blocked."),
    validation: error?.livePostValidation || error?.payload?.validation || null,
    candidatePostUrls: Array.isArray(error?.candidatePostUrls) ? error.candidatePostUrls : (Array.isArray(error?.payload?.candidatePostUrls) ? error.payload.candidatePostUrls : []),
    uncertainAfterPostClick: Boolean(error?.uncertainAfterPostClick || error?.payload?.uncertainAfterPostClick),
  };
  return persistLiveTestResult(result);
}

function isModeratorApprovalProfileLine(line = "") {
  return /\b(admin|administrator|moderator|mod|owner|approve|approval|admin_approval)\b/i.test(String(line || ""));
}

function normalizedProfileListLines(...sources) {
  const seen = new Set();
  const lines = [];
  for (const source of sources) {
    for (const line of recordLines(source)) {
      const clean = oneLineField(line, 300);
      if (!clean) continue;
      const key = clean.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(clean);
    }
  }
  return lines;
}

function normalizeWorkflowState(state) {
  state.testRun = sanitizeTestRunState(state.testRun);
  state.rules.minutesBetweenPosts = clampNumber(state.rules.minutesBetweenPosts, 1, 1440, 12);
  state.rules.randomMinutesBetweenPosts = Boolean(state.rules.randomMinutesBetweenPosts);
  state.rules.minMinutesBetweenPosts = clampNumber(state.rules.minMinutesBetweenPosts, 1, 1440, 5);
  state.rules.maxMinutesBetweenPosts = clampNumber(state.rules.maxMinutesBetweenPosts, 1, 1440, 16);
  if (state.rules.minMinutesBetweenPosts > state.rules.maxMinutesBetweenPosts) {
    const previousMin = state.rules.minMinutesBetweenPosts;
    state.rules.minMinutesBetweenPosts = state.rules.maxMinutesBetweenPosts;
    state.rules.maxMinutesBetweenPosts = previousMin;
  }
  // Optional SECONDS-based spacing window (0 = disabled -> use minutes above).
  // When max>0, the per-profile gap is a RANDOM value in [min,max] seconds.
  state.rules.secondsBetweenPostsMin = clampNumber(state.rules.secondsBetweenPostsMin, 0, 3600, 0);
  state.rules.secondsBetweenPostsMax = clampNumber(state.rules.secondsBetweenPostsMax, 0, 3600, 0);
  if (state.rules.secondsBetweenPostsMin > state.rules.secondsBetweenPostsMax && state.rules.secondsBetweenPostsMax > 0) {
    const prevSecMin = state.rules.secondsBetweenPostsMin;
    state.rules.secondsBetweenPostsMin = state.rules.secondsBetweenPostsMax;
    state.rules.secondsBetweenPostsMax = prevSecMin;
  }
  state.rules.commentsBeforeAccountMove = clampNumber(state.rules.commentsBeforeAccountMove, 1, 100, 5);
  state.rules.maxCommentsBeforeAccountSave = clampNumber(state.rules.maxCommentsBeforeAccountSave, 1, 500, 10);
  state.rules.postsPerProfilePerDay = clampNumber(state.rules.postsPerProfilePerDay, 1, 20, 5);
  // HARD per-run post limiter fields (defense-in-depth; readers also clampNumber): 0 = unlimited.
  state.operator = state.operator || {};
  state.operator.autopilotMaxPostsPerRun = clampNumber(state.operator.autopilotMaxPostsPerRun, 0, 1000000, 0);
  state.operator.autopilotPostsThisRun = clampNumber(state.operator.autopilotPostsThisRun, 0, 1000000, 0);
  state.operator.commentCooldownHours = clampNumber(state.operator.commentCooldownHours, 1, 720, 48);
  const blockedProfileLines = normalizedProfileListLines(state.ixbrowser?.blockedProfiles);
  const movedModeratorLines = blockedProfileLines.filter(isModeratorApprovalProfileLine);
  state.ixbrowser.blockedProfiles = blockedProfileLines
    .filter((line) => !isModeratorApprovalProfileLine(line))
    .slice(0, 500)
    .join("\n");
  state.ixbrowser.moderatorProfiles = normalizedProfileListLines(
    state.ixbrowser?.moderatorProfiles,
    movedModeratorLines.join("\n"),
  )
    .slice(0, 500)
    .join("\n");
  // ixBrowser reconcile miss-streak: a small JSON map of profileId->consecutive-absent-count.
  // Keep it a compact valid-JSON string; reset to "{}" if it ever gets corrupted.
  state.ixbrowser.reconcileMissStreak = (() => {
    try {
      const parsed = JSON.parse(String(state.ixbrowser?.reconcileMissStreak || "{}"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? JSON.stringify(parsed).slice(0, 4000)
        : "{}";
    } catch (_e) {
      return "{}";
    }
  })();
  state.posting.groupAssignmentMode = "percentage_manual_review";
  state.posting.groupProfileAssignments = String(state.posting.groupProfileAssignments || "").slice(0, 200000);
  state.posting.groupFallbackPolicy = String(state.posting.groupFallbackPolicy || defaultState().posting.groupFallbackPolicy).slice(0, 600);
  state.posting.profileGroupIssueLogEndpoint = "/api/posting/profile-group-issue";
  state.posting.publishedPostUrls = String(state.posting.publishedPostUrls || "").slice(0, 200000);
  state.posting.groupAssignmentData = Array.isArray(state.posting.groupAssignmentData)
    ? state.posting.groupAssignmentData.slice(0, 500).map((entry) => ({
      url: String(entry?.url || "").slice(0, 1000),
      sharePercent: clampNumber(entry?.sharePercent, 0, 100, 0),
      requiresAdminApproval: Boolean(entry?.requiresAdminApproval || entry?.requires_admin_approval || entry?.adminApproval || entry?.admin_approval),
      profiles: Array.isArray(entry?.profiles)
        ? entry.profiles
          .slice(0, 500)
          .map((profile) => String(profile || "").slice(0, 300))
          .filter((profile) => (
            !isDedicatedShopYourLikesProfileLabel(profile, state) &&
            !isBlockedIxBrowserProfileLabel(profile, state) &&
            !isFacebookAdminApprovalProfileLabel(profile, state, entry?.url)
          ))
        : [],
    })).filter((entry) => entry.url)
    : [];
  // CONTENT SOURCE GROUPS (default OFF). Normalize the config + MIRROR the master flag onto operator so
  // hot-path gates read operator.contentSourcesEnabled === true. When off (default), everything downstream
  // is inert (nothing reads groupsText). One facebook.com/groups/… URL per line.
  if (!state.posting.contentSources || typeof state.posting.contentSources !== "object") state.posting.contentSources = {};
  state.posting.contentSources.enabled = state.posting.contentSources.enabled === true;
  state.posting.contentSources.groupsText = String(state.posting.contentSources.groupsText || "").slice(0, 20000);
  state.posting.contentSources.notes = String(state.posting.contentSources.notes || "").slice(0, 5000);
  state.posting.contentSources.exclusive = state.posting.contentSources.exclusive === true; // ONLY post copied products (skip web discovery)
  state.posting.contentSources.reserveTarget = clampNumber(state.posting.contentSources.reserveTarget, 1, 1000, 20); // keep this many copied products ready
  state.posting.contentSources.reserveRefillAt = clampNumber(state.posting.contentSources.reserveRefillAt, 0, Math.max(0, state.posting.contentSources.reserveTarget - 1), 10); // resume harvesting when reserve drops to this
  state.operator = state.operator || {};
  state.operator.contentSourcesEnabled = state.posting.contentSources.enabled === true;
  state.operator.contentSourcesExclusive = state.posting.contentSources.enabled === true && state.posting.contentSources.exclusive === true;
  state.productAssets.reviewImagesPerProduct = 1;
  state.productAssets.reviewCandidateCount = clampNumber(state.productAssets.reviewCandidateCount, 1, REVIEW_IMAGE_CANDIDATE_COUNT, REVIEW_IMAGE_CANDIDATE_COUNT);
  state.productAssets.chatgptEdgeUserDataDir = normalizedChatGptEdgeUserDataDir(state.productAssets.chatgptEdgeUserDataDir);
  state.productAssets.chatgptEdgeProfileDirectory = String(state.productAssets.chatgptEdgeProfileDirectory || "Default").trim() || "Default";
  state.productAssets.useHermesImageReview = state.productAssets.useHermesImageReview !== false;
  state.productAssets.imageSelectionModel = String(state.productAssets.imageSelectionModel || "hermes_default_llm").slice(0, 80);
  state.productAssets.minReviewRating = clampNumber(state.productAssets.minReviewRating, 1, 5, 4);
  state.productAssets.preferredReviewRating = clampNumber(state.productAssets.preferredReviewRating, state.productAssets.minReviewRating, 5, 5);
  state.productDiscovery.enabled = Boolean(state.productDiscovery.enabled);
  state.productDiscovery.dailyRefreshEnabled = Boolean(state.productDiscovery.dailyRefreshEnabled);
  state.productDiscovery.requireProSeller = Boolean(state.productDiscovery.requireProSeller);
  state.productDiscovery.includeClearance = Boolean(state.productDiscovery.includeClearance);
  state.productDiscovery.includeReducedPrice = Boolean(state.productDiscovery.includeReducedPrice);
  state.productDiscovery.includeRollback = Boolean(state.productDiscovery.includeRollback);
  state.productDiscovery.primaryStore = String(state.productDiscovery.primaryStore || "walmart").slice(0, 80);
  state.productDiscovery.allowedRetailers = String(state.productDiscovery.allowedRetailers || "").slice(0, 20000);
  state.productDiscovery.walmartCategorySources = String(state.productDiscovery.walmartCategorySources || "").slice(0, 50000);
  state.productDiscovery.walmartSearchQueries = String(state.productDiscovery.walmartSearchQueries || "").slice(0, 50000);
  state.productDiscovery.otherStoreSourceUrls = String(state.productDiscovery.otherStoreSourceUrls || "").slice(0, 100000);
  state.productDiscovery.generatedSourceUrls = String(state.productDiscovery.generatedSourceUrls || "").slice(0, 200000);
  state.productDiscovery.minActivitySignal = String(state.productDiscovery.minActivitySignal || "").slice(0, 500);
  const assignedProfileCount = countAssignedProfiles(state);
  const postsPerDay = clampNumber(state.rules.postsPerProfilePerDay, 1, 20, 5);
  const dailyPostTarget = assignedProfileCount * postsPerDay;
  const candidateBufferPercent = clampNumber(state.productDiscovery.candidateBufferPercent, 0, 300, 20);
  state.productDiscovery.targetMode = "assigned_profiles_x_posts_per_day";
  state.productDiscovery.assignedProfileCount = assignedProfileCount;
  state.productDiscovery.dailyPostTarget = dailyPostTarget;
  state.productDiscovery.candidateBufferPercent = candidateBufferPercent;
  state.productDiscovery.targetCandidateCount = Math.ceil(dailyPostTarget * (1 + (candidateBufferPercent / 100)));
  state.productDiscovery.rankingRules = String(state.productDiscovery.rankingRules || "").slice(0, 5000);
  state.productDiscovery.notes = String(state.productDiscovery.notes || "").slice(0, 5000);
  state.affiliate.apiRequestsUseDedicatedProxy = Boolean(state.affiliate.apiRequestsUseDedicatedProxy);
  state.shortlink.apiRequestsUseAffiliateProxy = Boolean(state.shortlink.apiRequestsUseAffiliateProxy);
  state.affiliateProxy.enabled = Boolean(state.affiliateProxy.enabled);
  state.affiliateProxy.staticOnly = Boolean(state.affiliateProxy.staticOnly);
  state.affiliateProxy.lockedToSelectedProxy = Boolean(state.affiliateProxy.lockedToSelectedProxy);
  state.affiliateProxy.apiRequestsMustUseProxy = Boolean(state.affiliateProxy.apiRequestsMustUseProxy);
  state.affiliateProxy.requiredCountry = String(state.affiliateProxy.requiredCountry || "US").toUpperCase().slice(0, 2);
  const dedicatedAffiliateFlow = state.affiliate.enabled && (
    state.affiliate.useDedicatedIxProfile ||
    state.affiliate.apiRequestsUseDedicatedProxy ||
    state.affiliateProxy.enabled
  );
  if (state.affiliate.enabled && state.affiliate.useDedicatedIxProfile) {
    state.affiliate.dedicatedIxProfileFixedIp = true;
    state.affiliate.rotateDedicatedProfileIp = false;
  }
  if (dedicatedAffiliateFlow) {
    state.affiliate.apiRequestsUseDedicatedProxy = true;
    state.affiliateProxy.enabled = true;
    state.affiliateProxy.staticOnly = true;
    state.affiliateProxy.lockedToSelectedProxy = true;
    state.affiliateProxy.apiRequestsMustUseProxy = true;
  }
  state.ixbrowser.maxProfilesPerRun = clampNumber(state.ixbrowser.maxProfilesPerRun, 1, 1000000, 100000);
  state.ixbrowser.maxConcurrentProfiles = clampNumber(
    state.ixbrowser.maxConcurrentProfiles,
    1,
    MAX_CONCURRENT_NORMAL_IX_PROFILES,
    MAX_CONCURRENT_NORMAL_IX_PROFILES
  );
  state.ixbrowser.profileRunNotes = String(state.ixbrowser.profileRunNotes || "").slice(0, 5000);
  state.contentRotation.postTextCursor = clampNumber(state.contentRotation.postTextCursor, 0, 100000, 0);
  state.contentRotation.commentLeadInCursor = clampNumber(state.contentRotation.commentLeadInCursor, 0, 100000, 0);
  state.memory.maxPromptUrlLines = clampNumber(state.memory.maxPromptUrlLines, 10, 500, 80);
  state.memory.maxPromptTextLines = clampNumber(state.memory.maxPromptTextLines, 10, 1000, 120);
  state.memory.maxPromptTextLineLength = clampNumber(state.memory.maxPromptTextLineLength, 80, 1000, 260);
  state.memory.maxJobRuntimeMinutes = clampNumber(state.memory.maxJobRuntimeMinutes, 1, 240, 30);
  state.memory.maxQueuedJobs = clampNumber(state.memory.maxQueuedJobs, 1, 200, 50);
  state.triggers.heartbeatSeconds = clampNumber(state.triggers.heartbeatSeconds, 3, 120, 3);
  state.security.dashboardHost = HOST;
  state.security.dashboardPort = PORT;
  state.security.requireDashboardToken = true;
  state.security.rejectCrossOriginRequests = true;
  return state;
}

function countAssignedProfiles(state) {
  const profiles = new Set();
  for (const group of Array.isArray(state.posting?.groupAssignmentData) ? state.posting.groupAssignmentData : []) {
    for (const profile of Array.isArray(group?.profiles) ? group.profiles : []) {
      const value = String(profile || "").trim();
      if (value) profiles.add(value.toLowerCase());
    }
  }
  return profiles.size;
}

function profileIdFromLabel(value) {
  const match = String(value || "").trim().match(/^(\d{1,20})(?:\s*[-: ]|$)/);
  return match ? Number(match[1]) : 0;
}

function profileKeyFromLabel(value) {
  const text = String(value || "").trim();
  const id = profileIdFromLabel(text);
  return id ? `id:${id}` : `label:${text.toLowerCase()}`;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function deepMerge(base, patch) {
  const result = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === "object" && !Array.isArray(value) && base[key] && typeof base[key] === "object" && !Array.isArray(base[key])) {
      result[key] = deepMerge(base[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function registerFiles() {
  const files = readState().files;
  return Object.fromEntries(Object.entries(files).map(([key, value]) => [key, safeProjectPath(value)]));
}

function safeProjectPath(value) {
  const resolved = path.resolve(ROOT, String(value || ""));
  const relative = path.relative(ROOT, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Register path escapes project: ${value}`);
  }
  return resolved;
}

function toWindowsExplorerPath(filePath) {
  const absolutePath = path.resolve(filePath);
  const mountMatch = absolutePath.match(/^\/mnt\/([a-z])\/(.*)$/i);
  if (mountMatch) {
    return `${mountMatch[1].toUpperCase()}:\\${mountMatch[2].replace(/\//g, "\\")}`;
  }
  return absolutePath;
}

function openFolderInWindows(filePath) {
  const folderPath = fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? path.dirname(filePath) : filePath;
  fs.mkdirSync(folderPath, { recursive: true });
  const realFolder = assertSafeProjectRealPath(folderPath);
  const windowsPath = toWindowsExplorerPath(realFolder);
  execFile("explorer.exe", [windowsPath], { windowsHide: true }, (err) => {
    if (err) logEvent("open_folder_failed", { path: realFolder, error: String(err) });
  });
  return { path: realFolder, windowsPath };
}

function assertSafeProjectRealPath(filePath) {
  let probe = filePath;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) throw new Error(`Register path cannot be verified: ${filePath}`);
    probe = parent;
  }
  const realProbe = fs.realpathSync(probe);
  if (realProbe !== REAL_ROOT && !realProbe.startsWith(REAL_ROOT + path.sep)) {
    throw new Error(`Register real path escapes project: ${filePath}`);
  }
  if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) {
    throw new Error(`Register file cannot be a symlink: ${filePath}`);
  }
  return filePath;
}

function normalizeBaseUrl(value) {
  const url = new URL(String(value || ""));
  url.pathname = url.pathname.replace(/\/?$/, "/");
  url.search = "";
  url.hash = "";
  url.username = "";
  url.password = "";
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only http/https base URLs are allowed");
  return url.toString();
}

function normalizeUrlForComparison(value) {
  try {
    const url = new URL(String(value || "").trim());
    url.hash = "";
    url.username = "";
    url.password = "";
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) {
      url.port = "";
    }
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    const params = [...url.searchParams.entries()]
      .filter(([key]) => !/^(utm_|fbclid$|gclid$|msclkid$)/i.test(key))
      .sort(([leftKey, leftValue], [rightKey, rightValue]) => `${leftKey}=${leftValue}`.localeCompare(`${rightKey}=${rightValue}`));
    url.search = "";
    for (const [key, paramValue] of params) url.searchParams.append(key, paramValue);
    return url.toString().replace(/\/$/, "");
  } catch {
    return String(value || "").trim().replace(/\/+$/, "").toLowerCase();
  }
}

function normalizeAllowedServiceBaseUrl(value, allowedHosts, serviceName) {
  const url = new URL(normalizeBaseUrl(value));
  if (url.protocol !== "https:") {
    throw serviceConfigError(`${serviceName} API URL must use HTTPS.`, `${serviceName.toLowerCase().replace(/\s+/g, "_")}_invalid_base_url`);
  }
  const host = url.hostname.toLowerCase();
  if (!allowedHosts.has(host)) {
    throw serviceConfigError(`${serviceName} API URL host is not allowed: ${host}`, `${serviceName.toLowerCase().replace(/\s+/g, "_")}_invalid_base_url`);
  }
  return url.toString();
}

function normalizeOptionalServiceBaseUrl(value, serviceName, allowedHosts = null) {
  const text = String(value || "").trim();
  if (!text) return "";
  const url = new URL(normalizeBaseUrl(text));
  if (url.protocol !== "https:") {
    throw serviceConfigError(`${serviceName} API URL must use HTTPS.`, `${serviceName.toLowerCase().replace(/\s+/g, "_")}_invalid_base_url`);
  }
  const host = url.hostname.toLowerCase();
  if (isLocalOrPrivateHost(host)) {
    throw serviceConfigError(`${serviceName} API URL cannot point to localhost or private network addresses.`, `${serviceName.toLowerCase().replace(/\s+/g, "_")}_invalid_base_url`);
  }
  if (allowedHosts && !allowedHosts.has(host)) {
    throw serviceConfigError(`${serviceName} API URL host is not allowed: ${host}`, `${serviceName.toLowerCase().replace(/\s+/g, "_")}_invalid_base_url`);
  }
  return url.toString();
}

function isLocalOrPrivateHost(host) {
  if (["localhost", "127.0.0.1", "::1"].includes(host)) return true;
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const [a, b] = match.slice(1).map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function normalizeProxyHost(value) {
  const host = String(value || "").trim();
  if (!host) return "";
  if (!/^[a-zA-Z0-9.-]+$/.test(host)) {
    throw serviceConfigError("Affiliate proxy host contains invalid characters.", "affiliate_proxy_invalid_host");
  }
  return host;
}

function normalizePort(value, label, options = {}) {
  const text = String(value || "").trim();
  if (!text && options.allowBlank) return "";
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw serviceConfigError(`${label} must be a valid TCP port.`, `${label.toLowerCase().replace(/\s+/g, "_")}_invalid`);
  }
  return String(port);
}

function serviceConfigError(message, publicError = "service_config_error") {
  const err = new Error(message);
  err.statusCode = 409;
  err.publicError = publicError;
  return err;
}

function assertLoopbackUrl(value) {
  const url = new URL(normalizeBaseUrl(value));
  const host = url.hostname.toLowerCase();
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("IXBrowser base URL must stay on localhost/127.0.0.1");
  }
  return url.toString();
}

function normalizeIxBrowserBaseUrl(value) {
  const url = new URL(assertLoopbackUrl(value || defaultSecrets().ixbrowser.baseUrl));
  const normalizedPath = url.pathname.replace(/\/+$/, "").toLowerCase();
  if (!normalizedPath || normalizedPath === "") {
    url.pathname = "/api/v2/";
  } else if (normalizedPath === "/api/v2") {
    url.pathname = "/api/v2/";
  }
  return url.toString();
}

function readRegisters() {
  const files = registerFiles();
  const registers = {};
  for (const [key, filePath] of Object.entries(files)) {
    assertSafeProjectRealPath(filePath);
    try {
      registers[key] = fs.readFileSync(filePath, "utf8");
    } catch {
      registers[key] = "";
    }
  }
  return registers;
}

function writeRegisters(registers) {
  const files = registerFiles();
  const existing = readRegisters();
  for (const [key, filePath] of Object.entries(files)) {
    if (!Object.prototype.hasOwnProperty.call(registers, key)) continue;
    // productCandidates and postingPlan are JSONL DATA files, written
    // authoritatively (and row-capped) by writeJsonlFile. Re-writing them here
    // through the 200KB text-register byte cap silently dropped the newest rows
    // (kept oldest 200KB), so newly discovered products never persisted. Skip
    // them; writeJsonlFile owns these files.
    if (key === "productCandidates" || key === "postingPlan") continue;
    assertSafeProjectRealPath(filePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    assertSafeProjectRealPath(path.dirname(filePath));
    if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) {
      throw new Error(`Register file cannot be a symlink: ${filePath}`);
    }
    const merged = mergeProtectedRecordLines(registers[key], existing[key]);
    atomicWrite(filePath, merged.slice(0, 200000));
  }
  return readRegisters();
}

function isProtectedRecordLine(line) {
  return /one_ip_attempt=1\/1|status=cannot_comment|status=cannot_post_in_group|status=cannot_post_in_any_group|action=quarantined|posting_group_issue/i.test(String(line || ""));
}

function mergeProtectedRecordLines(nextValue, existingValue) {
  const nextLines = String(nextValue || "").split(/\r?\n/);
  const seen = new Set(nextLines.map((line) => line.trim()).filter(Boolean));
  const protectedLines = String(existingValue || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && isProtectedRecordLine(line) && !seen.has(line));
  if (!protectedLines.length) return String(nextValue || "");
  const prefix = String(nextValue || "").trimEnd();
  return `${prefix}${prefix ? "\n" : ""}${protectedLines.join("\n")}\n`;
}

function recordLines(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function isContentRotationHeadingLine(line) {
  const clean = String(line || "").trim();
  if (!clean) return true;
  if (/^[=\-_*~]{3,}$/.test(clean)) return true;
  if (/^\d{1,6}\s+.+\b(caption|captions|post texts?|comment lead-ins?|ideas?|templates?)\b/i.test(clean)) return true;
  if (/^(caption|captions|post texts?|comment lead-ins?|ideas?|templates?)\s*:?$/i.test(clean)) return true;
  return false;
}

function contentRotationLines(value) {
  return recordLines(value).filter((line) => !isContentRotationHeadingLine(line));
}

function appendUniqueLines(existingText, additions) {
  const lines = recordLines(existingText);
  const seen = new Set(lines.map((line) => line.toLowerCase()));
  for (const value of additions || []) {
    const line = String(value || "").trim();
    if (!line) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(line);
  }
  return lines.join("\n");
}

function readJsonlFile(relativePath) {
  const filePath = safeProjectPath(relativePath);
  if (!fs.existsSync(filePath)) return [];
  return String(fs.readFileSync(filePath, "utf8") || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function readJsonlAbsoluteFile(filePath, options = {}) {
  if (!fs.existsSync(filePath)) return [];
  const limit = Number(options.limit || 0);
  const lines = String(fs.readFileSync(filePath, "utf8") || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const rows = limit > 0 ? lines.slice(-limit) : lines;
  return rows.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function writeJsonlFile(relativePath, rows) {
  const filePath = safeProjectPath(relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const content = (rows || []).map((row) => JSON.stringify(row)).join("\n");
  atomicWrite(filePath, content ? `${content}\n` : "");
  return content ? `${content}\n` : "";
}

// CONTENT-SOURCE HARVEST tracking (default OFF). Persistent, LOSSLESS dedup by the first-comment URL
// (each product has a UNIQUE affiliate url). Record: { firstCommentUrl, productKey, text, imageLocalPath,
// harvestedAt, posted, imageDeleted }. The synthetic productKey is derived from the url, so the same
// product harvested from two groups maps to ONE key and is never posted twice.
function harvestSyntheticKey(url) {
  return "harvested:" + crypto.createHash("sha1").update(String(url || "")).digest("hex").slice(0, 12);
}
function readHarvestedProducts(state = readState()) {
  const file = state.files?.harvestedProducts || "data/harvested-products.jsonl";
  try { return readJsonlFile(file); } catch { return []; }
}
function harvestedRecordForKey(key, state = readState()) {
  const k = String(key || "");
  return readHarvestedProducts(state).find((r) => r && (r.productKey === k || harvestSyntheticKey(r.firstCommentUrl) === k)) || null;
}
function appendHarvestedProduct(record, state = readState()) {
  const file = state.files?.harvestedProducts || "data/harvested-products.jsonl";
  const url = String(record?.firstCommentUrl || "").trim();
  if (!url) return false;
  const rows = readHarvestedProducts(state);
  if (rows.some((r) => String(r.firstCommentUrl || "") === url)) return false; // idempotent dedup by url
  rows.push({
    firstCommentUrl: url,
    productKey: record.productKey || harvestSyntheticKey(url),
    text: String(record.text || "").slice(0, 4000),
    imageLocalPath: String(record.imageLocalPath || ""),
    sourceGroupUrl: String(record.sourceGroupUrl || ""),
    harvestedAt: new Date().toISOString(),
    posted: "",
    imageDeleted: false,
  });
  writeJsonlFile(file, rows);
  return true;
}
function updateHarvestedProductRecord(key, patch, state = readState()) {
  const file = state.files?.harvestedProducts || "data/harvested-products.jsonl";
  const k = String(key || "");
  const rows = readHarvestedProducts(state);
  let changed = false;
  for (const r of rows) { if (r && (r.productKey === k || harvestSyntheticKey(r.firstCommentUrl) === k)) { Object.assign(r, patch || {}); changed = true; } }
  if (changed) writeJsonlFile(file, rows);
  return changed;
}

function appendJsonlAbsoluteFile(filePath, row) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`);
}

function writeTextFile(relativePath, content) {
  const filePath = safeProjectPath(relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWrite(filePath, String(content || ""));
}

function sourceLineUrl(line) {
  const match = String(line || "").match(/https?:\/\/\S+/i);
  return match ? match[0].replace(/[),.;]+$/, "") : "";
}

function allowedRetailerHosts(state) {
  const hosts = new Set(["walmart.com", "amazon.com", "target.com"]);
  for (const line of recordLines(state.productDiscovery?.allowedRetailers || state.dealSource?.allowedRetailers || "")) {
    try {
      const parsed = line.includes("://") ? new URL(line).hostname : line;
      const host = String(parsed || "").trim().toLowerCase().replace(/^www\./, "");
      if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) hosts.add(host);
    } catch {
      continue;
    }
  }
  return hosts;
}

function hostAllowed(host, allowedHosts) {
  const clean = String(host || "").toLowerCase().replace(/^www\./, "");
  return [...allowedHosts].some((allowed) => clean === allowed || clean.endsWith(`.${allowed}`));
}

function walmartFacetForState(state) {
  const discovery = state.productDiscovery || {};
  const facets = [];
  if (discovery.includeClearance) facets.push("special_offers:Clearance");
  if (discovery.includeReducedPrice) facets.push("special_offers:Reduced Price");
  if (discovery.includeRollback) facets.push("special_offers:Rollback");
  if (discovery.requireProSeller) facets.push("retailer_type:Pro Sellers");
  return facets.join("||");
}

function withWalmartFacet(rawUrl, state) {
  try {
    const url = new URL(rawUrl);
    if (!/(^|\.)walmart\.com$/i.test(url.hostname)) return rawUrl;
    const facet = walmartFacetForState(state);
    if (facet) url.searchParams.set("facet", facet);
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function walmartSearchUrl(query, state) {
  const url = new URL("https://www.walmart.com/search");
  url.searchParams.set("q", query);
  const facet = walmartFacetForState(state);
  if (facet) url.searchParams.set("facet", facet);
  return url.toString();
}

function productDiscoverySources(state) {
  const urls = [];
  const seen = new Set();
  const add = (raw) => {
    const value = String(raw || "").trim();
    if (!value) return;
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    urls.push(value);
  };
  for (const line of recordLines(state.productDiscovery?.generatedSourceUrls)) add(line);
  if (!urls.length) {
    for (const line of recordLines(state.productDiscovery?.walmartCategorySources)) {
      const url = sourceLineUrl(line);
      if (url) add(withWalmartFacet(url, state));
    }
    for (const line of recordLines(state.productDiscovery?.walmartSearchQueries)) {
      const url = sourceLineUrl(line);
      add(url ? withWalmartFacet(url, state) : walmartSearchUrl(line, state));
    }
    for (const line of recordLines(state.productDiscovery?.otherStoreSourceUrls)) add(line);
  }
  const allowed = allowedRetailerHosts(state);
  return urls.filter((raw) => {
    try {
      const url = new URL(raw);
      return ["http:", "https:"].includes(url.protocol) && hostAllowed(url.hostname, allowed);
    } catch {
      return false;
    }
  });
}

function titleFromSlug(slug, fallback) {
  const title = decodeURIComponent(String(slug || ""))
    .replace(/\+/g, " ")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return title ? title.replace(/\b\w/g, (letter) => letter.toUpperCase()) : fallback;
}

function canonicalProduct(rawUrl, state) {
  // HARVESTED products use a synthetic key (harvested:<hash>), not a real retailer URL. Return a stable
  // pseudo-product so they survive the whole pipeline (the new URL() below would throw + drop them).
  // Only reachable when the content-source feature is enabled (gated upstream by contentSourcesEnabled).
  if (String(rawUrl || "").startsWith("harvested:")) {
    const id = String(rawUrl).slice("harvested:".length);
    return { store: "harvested", host: "", productId: id, key: String(rawUrl), url: String(rawUrl), title: "" };
  }
  try {
    const url = new URL(String(rawUrl || "").replace(/\\\//g, "/"));
    if (!["http:", "https:"].includes(url.protocol)) return null;
    const allowed = allowedRetailerHosts(state);
    if (!hostAllowed(url.hostname, allowed)) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    url.hash = "";
    url.search = "";
    const parts = url.pathname.split("/").filter(Boolean).map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
    if (host.endsWith("walmart.com")) {
      const ipIndex = parts.findIndex((part) => part.toLowerCase() === "ip");
      if (ipIndex < 0) return null;
      const candidateParts = parts.slice(ipIndex + 1);
      const productId = [...candidateParts].reverse().find((part) => /^[a-z0-9]{5,}$/i.test(part));
      if (!productId) return null;
      const slug = candidateParts.find((part) => part !== productId && !/^[a-z0-9]{5,}$/i.test(part)) || "";
      return {
        store: "walmart",
        host: "walmart.com",
        productId,
        key: `walmart:${productId}`,
        url: `https://www.walmart.com/ip/${productId}`,
        title: titleFromSlug(slug, `Walmart product ${productId}`),
      };
    }
    if (host.endsWith("amazon.com")) {
      const asin = (url.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i) || [])[1];
      if (!asin) return null;
      return {
        store: "amazon",
        host: "amazon.com",
        productId: asin.toUpperCase(),
        key: `amazon:${asin.toUpperCase()}`,
        url: `https://www.amazon.com/dp/${asin.toUpperCase()}`,
        title: titleFromSlug(parts[0], `Amazon product ${asin.toUpperCase()}`),
      };
    }
    if (host.endsWith("target.com")) {
      const productId = (url.pathname.match(/A-(\d+)/i) || [])[1] || crypto.createHash("sha256").update(url.pathname).digest("hex").slice(0, 12);
      return {
        store: "target",
        host: "target.com",
        productId,
        key: `target:${productId}`,
        url: url.toString(),
        title: titleFromSlug(parts.at(-1), `Target product ${productId}`),
      };
    }
    const productId = crypto.createHash("sha256").update(`${host}${url.pathname}`).digest("hex").slice(0, 16);
    return {
      store: host.split(".")[0],
      host,
      productId,
      key: `${host}:${productId}`,
      url: url.toString(),
      title: titleFromSlug(parts.at(-1), `${host} product`),
    };
  } catch {
    return null;
  }
}

function normalizeCandidateUrl(raw, sourceUrl) {
  const text = String(raw || "")
    .replace(/\\u002F/g, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .trim();
  if (!text || /^(javascript|mailto):/i.test(text)) return "";
  try {
    if (text.startsWith("//")) return `https:${text}`;
    if (text.startsWith("/")) return new URL(text, sourceUrl).toString();
    if (/^https?:\/\//i.test(text)) return text;
  } catch {
    return "";
  }
  return "";
}

function safeText(value, max = 240) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function isAntiBotHtml(html) {
  const sample = String(html || "").slice(0, 60000);
  return /robot or human|captcha|perimeterx|_pxappid|verify you are human|blocked\?url=/i.test(sample);
}

function isAntiBotText(text) {
  const sample = String(text || "").slice(0, 60000);
  return /robot or human|captcha|perimeterx|_pxappid|verify you are human|hold tight|press and hold|blocked\?url=|unusual traffic/i.test(sample);
}

function parseJsonScript($, selector) {
  const text = $(selector).first().text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function pushProductCandidate(candidates, rawUrl, sourceUrl, state, details = {}) {
  const url = normalizeCandidateUrl(rawUrl, sourceUrl);
  const product = canonicalProduct(url, state);
  if (!product) return;
  const existing = candidates.get(product.key);
  candidates.set(product.key, {
    ...product,
    ...(existing || {}),
    title: safeText(details.title || existing?.title || product.title, 300),
    price: details.price ?? existing?.price ?? null,
    originalPrice: details.originalPrice ?? existing?.originalPrice ?? null,
    rating: details.rating ?? existing?.rating ?? null,
    reviewCount: details.reviewCount ?? existing?.reviewCount ?? null,
    imageUrl: details.imageUrl || existing?.imageUrl || "",
    seller: safeText(details.seller || existing?.seller || "", 160),
    dealSignal: safeText(details.dealSignal || existing?.dealSignal || "", 180),
    discoveryMethod: existing?.discoveryMethod && details.discoveryMethod === "html_scan"
      ? existing.discoveryMethod
      : details.discoveryMethod || existing?.discoveryMethod || "link",
  });
}

function extractWalmartProductUrlFromObject(item) {
  const urlFields = [
    "canonicalUrl",
    "productUrl",
    "productURL",
    "productPageUrl",
    "productPageURL",
    "product_url",
    "url",
    "link",
    "clickThroughUrl",
    "seeAllLink",
  ];
  for (const field of urlFields) {
    const value = item?.[field];
    if (typeof value === "string" && /(?:^https?:\/\/(?:www\.)?walmart\.com|^\/)?\/?ip\//i.test(value)) return value;
  }
  const id = item?.usItemId || item?.itemId || item?.productId || item?.product_id;
  if (id && /^[a-z0-9]{5,}$/i.test(String(id))) return `https://www.walmart.com/ip/${id}`;
  return "";
}

function firstNumeric(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const match = value.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
      if (match) return Number(match[0]);
    }
  }
  return null;
}

function extractWalmartDetailsFromObject(item) {
  const priceInfo = item?.priceInfo || item?.price || item?.currentPrice || {};
  const ratingInfo = item?.rating || item?.averageRating || item?.reviews || {};
  const imageInfo = item?.imageInfo || item?.image || item?.images || {};
  const sellerInfo = item?.seller || item?.sellerInfo || item?.sellerName || {};
  const imageUrl = typeof imageInfo === "string"
    ? imageInfo
    : imageInfo?.thumbnailUrl || imageInfo?.mainImage?.url || imageInfo?.url || imageInfo?.src || "";
  return {
    title: item?.name || item?.title || item?.productName || item?.displayName || "",
    price: firstNumeric(priceInfo?.currentPrice?.price, priceInfo?.linePrice, priceInfo?.price, item?.price),
    originalPrice: firstNumeric(priceInfo?.wasPrice?.price, priceInfo?.listPrice, item?.preDiscountPrice),
    rating: firstNumeric(ratingInfo?.averageOverallRating, ratingInfo?.ratingValue, ratingInfo?.rating, item?.averageRating),
    reviewCount: firstNumeric(ratingInfo?.totalReviewCount, ratingInfo?.reviewCount, ratingInfo?.count, item?.numberOfReviews),
    imageUrl,
    seller: typeof sellerInfo === "string" ? sellerInfo : sellerInfo?.name || sellerInfo?.sellerName || item?.sellerName || "",
    dealSignal: item?.salesUnit || item?.availabilityStatusDisplayValue || item?.fulfillmentTitle || item?.badge?.text || "",
  };
}

function collectProductObjectsFromJson(value, sourceUrl, state, candidates, limits = { nodes: 0, maxNodes: 20000 }) {
  if (!value || limits.nodes >= limits.maxNodes) return;
  limits.nodes += 1;
  if (Array.isArray(value)) {
    for (const item of value) collectProductObjectsFromJson(item, sourceUrl, state, candidates, limits);
    return;
  }
  if (typeof value !== "object") return;
  const rawUrl = extractWalmartProductUrlFromObject(value);
  if (rawUrl) {
    pushProductCandidate(candidates, rawUrl, sourceUrl, state, {
      ...extractWalmartDetailsFromObject(value),
      discoveryMethod: "walmart_next_data",
    });
  }
  for (const nested of Object.values(value)) {
    if (!nested || (typeof nested !== "object" && !Array.isArray(nested))) continue;
    collectProductObjectsFromJson(nested, sourceUrl, state, candidates, limits);
  }
}

function extractProductLinks(html, sourceUrl, state) {
  const text = String(html || "").replace(/\\u002F/g, "/").replace(/\\\//g, "/").replace(/&amp;/g, "&");
  const candidates = new Map();
  const $ = cheerio.load(text);
  $("a[href]").each((_, element) => {
    pushProductCandidate(candidates, $(element).attr("href"), sourceUrl, state, {
      title: $(element).attr("aria-label") || $(element).text(),
      discoveryMethod: "anchor",
    });
  });
  const nextData = parseJsonScript($, "script#__NEXT_DATA__");
  if (nextData) collectProductObjectsFromJson(nextData, sourceUrl, state, candidates);
  const walmartPattern = /(?:https?:\/\/(?:www\.)?walmart\.com)?\/ip\/[^"'<>\s\\]+/gi;
  for (const match of text.matchAll(walmartPattern)) {
    pushProductCandidate(candidates, match[0], sourceUrl, state, { discoveryMethod: "html_scan" });
  }
  return [...candidates.values()];
}

async function fetchText(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || EXTERNAL_SERVICE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function jinaReaderUrl(rawUrl) {
  const normalized = String(rawUrl || "").replace(/^https?:\/\//i, "");
  return `https://r.jina.ai/http://${normalized}`;
}

async function fetchJinaReaderText(rawUrl) {
  return fetchText(jinaReaderUrl(rawUrl), { timeoutMs: 60000 });
}

function productKeysFromText(text, state) {
  const keys = new Set();
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    try {
      const row = JSON.parse(line);
      if (row.productKey) keys.add(String(row.productKey).toLowerCase());
      if (row.key) keys.add(String(row.key).toLowerCase());
      if (row.url || row.productUrl) {
        const product = canonicalProduct(row.url || row.productUrl, state);
        if (product) keys.add(product.key.toLowerCase());
      }
      continue;
    } catch {
      // Fall through and scan pipe/text records.
    }
    for (const match of line.matchAll(/https?:\/\/[^\s|]+/gi)) {
      const product = canonicalProduct(match[0], state);
      if (product) keys.add(product.key.toLowerCase());
    }
    const productId = (line.match(/product_id=([^|\s]+)/i) || [])[1];
    const retailer = (line.match(/retailer=([^|\s]+)/i) || [])[1];
    if (productId && retailer) keys.add(`${retailer.toLowerCase()}:${productId.toLowerCase()}`);
  }
  return keys;
}

// Posted-product reuse window: a product re-qualifies for posting once it has
// not been used within this many days (state.productDiscovery.reusePostedProductAfterDays,
// default 7). 0 = never reuse (legacy permanent exclusion). Keeps the product
// queue full for high-scale continuous publishing instead of burning each
// product once and running dry.
function usedProductReuseWindowDays(state = readState()) {
  return clampNumber(state.productDiscovery?.reusePostedProductAfterDays, 0, 3650, 7);
}

// Keys of products used WITHIN the reuse window (still blocked). Products last
// used longer ago than the window drop out, so they become postable again.
// Undated legacy records stay blocked (safer than a surprise re-post).
function recentlyUsedProductKeys(text, state = readState(), windowDays) {
  const days = windowDays == null
    ? usedProductReuseWindowDays(state)
    : clampNumber(windowDays, 0, 3650, 7);
  if (!days) return productKeysFromText(text, state);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const recentLines = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    let ts = NaN;
    if (line.startsWith("{")) {
      try {
        const row = JSON.parse(line);
        ts = Date.parse(row.at || row.usedAt || row.postedAt || row.timestamp || "");
      } catch {}
    } else {
      ts = Date.parse(line.split("|")[0].trim());
    }
    if (Number.isNaN(ts) || ts >= cutoff) recentLines.push(rawLine);
  }
  return productKeysFromText(recentLines.join("\n"), state);
}

function noReviewPhotoRetryWindowDays(state = readState()) {
  return clampNumber(state.productDiscovery?.retryNoReviewPhotoAfterDays, 0, 3650, 14);
}

// Keys of products marked "no customer review photos" WITHIN the retry window (still
// skipped). After the window they drop out and get re-inspected — so a one-off lazy-load
// miss self-heals and is NEVER a permanent ban. Mirrors recentlyUsedProductKeys.
function recentlyNoPhotoProductKeys(text, state = readState(), windowDays) {
  const days = windowDays == null
    ? noReviewPhotoRetryWindowDays(state)
    : clampNumber(windowDays, 0, 3650, 14);
  if (!days) return productKeysFromText(text, state);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const recentLines = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    let ts = NaN;
    if (line.startsWith("{")) {
      try { const row = JSON.parse(line); ts = Date.parse(row.at || row.markedAt || row.timestamp || ""); } catch {}
    } else {
      ts = Date.parse(line.split("|")[0].trim());
    }
    if (Number.isNaN(ts) || ts >= cutoff) recentLines.push(rawLine);
  }
  return productKeysFromText(recentLines.join("\n"), state);
}

// TRUE only when a RELIABLE scrape actually saw the reviews and found 0 customer photos —
// i.e. some provider RETURNED content with candidateCount:0 and NO transient/anti-bot error
// is present. Walmart photos load lazily, so a block/timeout/closed-session miss must NOT
// count (it would wrongly drop a product that DOES have photos). The TTL also self-heals.
function productGenuinelyHasNoReviewPhotos(attempts = []) {
  const list = Array.isArray(attempts) ? attempts : [];
  if (!list.length) return false;
  // A provider that successfully RETURNED the reviews page and found 0 photo candidates
  // (candidateCount:0, no error) is reliable proof — REGARDLESS of OTHER providers being
  // anti-bot-blocked (Jina is ALWAYS blocked for Walmart's datacenter-IP defense; that block
  // is expected and must NOT veto a clean zero from Firecrawl or the #40 residential browser).
  // The #40 browser's genuine "found no usable page" throw also counts (it reached the page,
  // distinct from its anti-bot throw). Walmart lazy-loads photos so a one-off miss is possible
  // — the 14-day retry TTL self-heals any wrong mark, so this is safe.
  const cleanZero = list.some((a) => a && !a.error && Number(a.candidateCount || 0) === 0 && a.provider && !/partial_antibot/i.test(String(a.provider)));
  const browserNoPage = list.some((a) => a && a.error
    && /found no usable page|no usable (?:review )?page/i.test(String(a.error))
    && !/verification|anti-?bot|robot|captcha/i.test(String(a.error)));
  return cleanZero || browserNoPage;
}

// Append a REVERSIBLE no-photo mark (leading ISO timestamp so the retry window applies).
// Separate register from the PERMANENT blacklist so a confirmed-no-photo product auto-retries.
function recordProductNoReviewPhotos(registers, product, detail = "", at = new Date().toISOString()) {
  const key = String(product?.key || "").toLowerCase();
  if (!key) return;
  const line = [
    at,
    `product_key=${key}`,
    `product_url=${oneLineField(product?.url || "", 240)}`,
    product?.productId ? `product_id=${product.productId}` : "",
    product?.store ? `retailer=${product.store}` : "",
    "status=no_review_photos",
    "reason=no_customer_review_photos",
    detail ? `detail=${oneLineField(detail, 200)}` : "",
  ].filter(Boolean).join(" | ");
  registers.noReviewPhotoProducts = appendUniqueRecordLine(registers.noReviewPhotoProducts || "# Products a reliable scrape confirmed have NO customer review photos (auto-retried after retryNoReviewPhotoAfterDays)\n", line);
  logEvent("product_no_review_photos_marked", { productKey: key, productId: product?.productId || "" });
}

function uniqueProductUrls(values, state) {
  const products = [];
  const seen = new Set();
  for (const value of values || []) {
    const product = canonicalProduct(value, state);
    if (!product || seen.has(product.key)) continue;
    seen.add(product.key);
    products.push(product);
  }
  return products;
}

function productBlacklistText(state = readState(), registers = null) {
  const sources = [state.productAssets?.blacklistedProducts || ""];
  if (registers && Object.prototype.hasOwnProperty.call(registers, "blacklistedProducts")) {
    sources.push(registers.blacklistedProducts || "");
  } else {
    try {
      sources.push(readRegisters().blacklistedProducts || "");
    } catch {}
  }
  return sources.join("\n");
}

function productBlacklistDecisions(state = readState(), registers = null) {
  const decisions = new Map();
  for (const line of recordLines(productBlacklistText(state, registers))) {
    const keys = productKeysFromText(line, state);
    if (!keys.size) continue;
    const resolved = /status=(?:resolved|approved|cleared|ignored|removed|unblocked)|action=(?:remove_blacklist|unblacklist|product_unblocked)/i.test(line);
    const blocked = !resolved && /status=(?:blacklisted|blocked)|reason=chatgpt_hd_guardrail|action=skip_product|product_blacklisted/i.test(line);
    if (!blocked && !resolved) continue;
    for (const key of keys) decisions.set(key, { blocked, line });
  }
  return decisions;
}

function blacklistedProductKeys(state = readState(), registers = null) {
  const keys = new Set();
  for (const [key, decision] of productBlacklistDecisions(state, registers)) {
    if (decision.blocked) keys.add(key);
  }
  return keys;
}

function isProductBlacklisted(product, state = readState(), registers = null) {
  const key = String(product?.key || canonicalProduct(product?.url || product, state)?.key || "").toLowerCase();
  return Boolean(key && blacklistedProductKeys(state, registers).has(key));
}

function filterBlacklistedProducts(products, state = readState(), registers = null, options = {}) {
  if (options.includeBlacklistedProducts || options.include_blacklisted_products) return products || [];
  const blockedKeys = blacklistedProductKeys(state, registers);
  if (!blockedKeys.size) return products || [];
  return (products || []).filter((product) => !blockedKeys.has(String(product?.key || "").toLowerCase()));
}

function blacklistProductRecordLine(product, reason, detail, at = new Date().toISOString()) {
  return [
    at,
    `product_key=${product.key}`,
    `product_url=${product.url}`,
    `product_id=${product.productId || ""}`,
    `retailer=${product.store || ""}`,
    "status=blacklisted",
    "action=skip_product",
    `reason=${oneLineField(reason || "product_blacklisted", 120)}`,
    detail ? `detail=${oneLineField(detail, 500)}` : "",
  ].filter(Boolean).join(" | ");
}

function markProductCandidateBlacklisted(product, state = readState(), reason = "product_blacklisted", detail = "", at = new Date().toISOString()) {
  const file = state.files?.productCandidates || "data/product-candidates.jsonl";
  const rows = readJsonlFile(file);
  if (!rows.length) return false;
  const productKey = String(product?.key || "").toLowerCase();
  let changed = false;
  const nextRows = rows.map((row) => {
    const rowProduct = canonicalProduct(row.url || row.productUrl || "", state);
    const rowKey = String(row.productKey || row.key || rowProduct?.key || "").toLowerCase();
    if (!rowKey || rowKey !== productKey) return row;
    changed = true;
    return {
      ...row,
      status: "blacklisted",
      imageStatus: "blacklisted_chatgpt_hd_guardrail",
      blacklistReason: reason,
      blacklistDetail: oneLineField(detail, 500),
      blacklistedAt: row.blacklistedAt || at,
    };
  });
  if (changed) writeJsonlFile(file, nextRows);
  return changed;
}

function blacklistProductForPosting(productValue, reason = "product_blacklisted", detail = "", state = readState()) {
  const product = productValue?.key ? productValue : canonicalProduct(productValue?.url || productValue, state);
  if (!product?.key) return null;
  const at = new Date().toISOString();
  const line = blacklistProductRecordLine(product, reason, detail, at);
  const registers = readRegisters();
  const alreadyBlocked = blacklistedProductKeys(state, registers).has(product.key.toLowerCase());
  if (!alreadyBlocked) {
    registers.blacklistedProducts = appendUniqueRecordLine(registers.blacklistedProducts || "# Blacklisted products\n", line);
    writeRegisters(registers);
    const latestState = readState();
    latestState.productAssets.blacklistedProducts = appendUniqueRecordLine(latestState.productAssets?.blacklistedProducts || "", line);
    writeState(latestState);
  }
  const candidateUpdated = markProductCandidateBlacklisted(product, state, reason, detail, at);
  logEvent("product_blacklisted_for_posting", {
    productKey: product.key,
    productUrl: product.url,
    reason,
    alreadyBlocked,
    candidateUpdated,
  });
  return { product, line, alreadyBlocked, candidateUpdated };
}

function latestDiscoveryRunAt(state) {
  return String(state.productDiscovery?.lastSuccessfulRunAt || "").trim();
}

function productCandidateRowsForDiscoveryRun(state, runAt = latestDiscoveryRunAt(state)) {
  const expected = String(runAt || "").trim();
  if (!expected) return [];
  return readJsonlFile(state.files.productCandidates || "data/product-candidates.jsonl")
    .filter((row) => String(row.latestDiscoveryRunAt || row.discoveryRunAt || row.lastSeenAt || "").trim() === expected);
}

// Build a productKey -> REAL stored title map from the discovery candidate rows. The post
// signature/locator must show the real product NAME, not the numeric "Walmart product {id}"
// fallback. Discovery already scrapes and stores the real title on each candidate row, but
// uniqueProductUrls() rebuilds products from URL-only (canonicalProduct re-derives the numeric
// slug fallback for slugless /ip/ URLs) and DISCARDS it. This map lets us re-attach it.
function storedProductTitleMap(candidateRows, state) {
  const map = new Map();
  for (const row of candidateRows || []) {
    const u = row && (row.url || row.productUrl);
    if (!u) continue;
    const stored = String(row.cleanTitle || row.title || "").trim();
    if (!stored || isNumericFallbackTitle(stored)) continue; // never carry a numeric fallback as the "real" title
    let key = String(row.productKey || "").toLowerCase();
    if (!key) { try { const p = canonicalProduct(u, state); key = p && p.key ? p.key.toLowerCase() : ""; } catch { key = ""; } }
    if (key && !map.has(key)) map.set(key, stored);
  }
  // Merge the scraped-title register — this is the source for products that entered via a
  // pasted/generated URL list (not the discovery candidate cache) and so had no stored title.
  try { for (const [k, v] of realProductTitleMap()) { if (k && v && !map.has(k)) map.set(k, v); } } catch {}
  return map;
}
function attachStoredProductTitles(products, titleMap) {
  for (const p of products || []) {
    if (!p || !p.key) continue;
    const t = titleMap.get(p.key.toLowerCase());
    if (t) p.storedTitle = t;
  }
  return products;
}

function collectProductUrlsForPosting(state, options = {}) {
  const latestOnly = Boolean(options.latestDiscoveryOnly || options.latest_discovery_only);
  const candidateRows = latestOnly
    ? productCandidateRowsForDiscoveryRun(state)
    : readJsonlFile(state.files.productCandidates || "data/product-candidates.jsonl");
  const titleMap = storedProductTitleMap(candidateRows, state);
  const candidates = candidateRows
    .map((row) => row.url || row.productUrl)
    .filter(Boolean);
  if (latestOnly) return filterBlacklistedProducts(attachStoredProductTitles(uniqueProductUrls(candidates, state), titleMap), state, null, options);
  // HARVESTED content sources (default OFF): inject UNPOSTED harvested products as synthetic url lines,
  // FIRST so they post before web-discovery products. canonicalProduct accepts harvested:<hash> keys;
  // posted ones drop out (their image is deleted). When the feature is off this list is empty.
  const harvestedKeys = state.operator?.contentSourcesEnabled === true
    ? readHarvestedProducts(state).filter((r) => r && !r.posted && r.imageLocalPath && r.firstCommentUrl).map((r) => r.productKey)
    : [];
  // EXCLUSIVE mode: post ONLY copied products (skip web-discovery products entirely). When off, copied
  // products are mixed in FIRST but web-discovery products still flow.
  const webDiscovery = state.operator?.contentSourcesExclusive === true ? [] : [
    ...recordLines(state.productAssets?.productUrls),
    ...recordLines(state.posting?.sourceUrls),
    ...candidates,
  ];
  return filterBlacklistedProducts(attachStoredProductTitles(uniqueProductUrls([
    ...harvestedKeys,
    ...webDiscovery,
  ], state), titleMap), state, null, options);
}

function mergeProductUrlText(existingText, products, maxLines = 500) {
  const seen = new Set();
  const lines = [];
  for (const line of recordLines(existingText)) {
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(line);
  }
  for (const product of products || []) {
    const key = product.url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(product.url);
  }
  return lines.slice(0, maxLines).join("\n");
}

function removePendingApprovalTypes(value, types) {
  const typeSet = new Set(types);
  return String(value || "")
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (trimmed.startsWith("#")) return true;
      const type = (trimmed.match(/type=([^|\s]+)/i) || [])[1];
      return !type || !typeSet.has(type);
    })
    .join("\n") + "\n";
}

function appendApprovalLine(registers, line) {
  registers.pendingApprovals = appendUniqueRecordLine(registers.pendingApprovals || "# Pending approvals\n", line);
}

function productDiscoveryRow(product, state, sourceUrl, target, parser, options = {}) {
  const at = options.at || options.discoveryRunAt || new Date().toISOString();
  const discoveryRunAt = options.discoveryRunAt || at;
  return {
    at,
    discoveryRunAt,
    latestDiscoveryRunAt: discoveryRunAt,
    lastSeenAt: discoveryRunAt,
    status: "candidate",
    productKey: product.key,
    productId: product.productId,
    store: product.store,
    title: product.title,
    url: product.url,
    price: product.price,
    originalPrice: product.originalPrice,
    rating: product.rating,
    reviewCount: product.reviewCount,
    imageUrl: product.imageUrl,
    seller: product.seller,
    dealSignal: product.dealSignal,
    discoveryMethod: product.discoveryMethod,
    sourceUrl,
    lastSeenSourceUrl: sourceUrl,
    sourceHost: new URL(sourceUrl).hostname,
    parser,
    lastSeenParser: parser,
    targetRunCount: target,
    dealSignalRequired: state.productDiscovery.minActivitySignal || "",
    ranking: "fresh_deal_signal_positive_reviews_affiliate_compatible_unique",
    imageStatus: `needs_positive_${state.productAssets.minReviewRating || 4}_to_${state.productAssets.preferredReviewRating || 5}_star_review_image`,
    linkStatus: state.shortlink?.enabled ? "needs_mavlynk_shortlink" : "shortlink_disabled",
  };
}

function mergeDiscoveredProductsIntoState(state, registers, products, options = {}) {
  const target = clampNumber(options.target || state.productDiscovery?.targetCandidateCount, 1, 500, 100);
  const parser = options.parser || "cheerio";
  const sourceUrl = options.sourceUrl || "";
  const discoveryRunAt = options.discoveryRunAt || new Date().toISOString();
  const includeUsedProducts = Boolean(options.includeUsedProducts || options.include_used_products);
  const includeBlacklistedProducts = Boolean(options.includeBlacklistedProducts || options.include_blacklisted_products);
  const includeExistingInResult = Boolean(options.includeExistingInResult || options.include_existing_in_result);
  const markExistingSeen = Boolean(options.markExistingSeen || options.mark_existing_seen || includeExistingInResult);
  const usedKeys = recentlyUsedProductKeys(registers.usedProducts, state);
  const blacklistedKeys = includeBlacklistedProducts ? new Set() : blacklistedProductKeys(state, registers);
  const existingRows = readJsonlFile(state.files.productCandidates || "data/product-candidates.jsonl");
  const rowMap = new Map();
  for (const row of existingRows) {
    const key = String(row.productKey || row.key || "").toLowerCase();
    if (key) rowMap.set(key, row);
  }
  const discovered = [];
  const seenRunKeys = new Set();
  for (const product of products || []) {
    const key = product.key.toLowerCase();
    if (!includeUsedProducts && usedKeys.has(key)) continue;
    if (!includeBlacklistedProducts && blacklistedKeys.has(key)) continue;
    if (seenRunKeys.has(key)) continue;
    const existing = rowMap.get(key);
    if (existing) {
      if (markExistingSeen) {
        const row = {
          ...existing,
          productKey: existing.productKey || product.key,
          productId: existing.productId || product.productId,
          store: existing.store || product.store,
          title: product.title || existing.title,
          url: existing.url || product.url,
          price: product.price || existing.price,
          originalPrice: product.originalPrice || existing.originalPrice,
          rating: product.rating || existing.rating,
          reviewCount: product.reviewCount || existing.reviewCount,
          imageUrl: product.imageUrl || existing.imageUrl,
          seller: product.seller || existing.seller,
          dealSignal: product.dealSignal || existing.dealSignal,
          discoveryMethod: product.discoveryMethod || existing.discoveryMethod,
          latestDiscoveryRunAt: discoveryRunAt,
          lastSeenAt: discoveryRunAt,
          lastSeenSourceUrl: sourceUrl || product.url,
          lastSeenParser: parser,
        };
        rowMap.set(key, row);
        seenRunKeys.add(key);
        if (includeExistingInResult) {
          discovered.push({ ...row, reusedExistingCandidate: true });
          if (discovered.length >= target) break;
        }
      }
      continue;
    }
    const row = productDiscoveryRow(product, state, sourceUrl || product.url, target, parser, { discoveryRunAt });
    discovered.push(row);
    rowMap.set(key, row);
    seenRunKeys.add(key);
    if (discovered.length >= target) break;
  }
  const candidateContent = writeJsonlFile(state.files.productCandidates || "data/product-candidates.jsonl", [...rowMap.values()].slice(-500));
  if (registers) registers.productCandidates = candidateContent;
  state.productAssets.productUrls = mergeProductUrlText(state.productAssets.productUrls, discovered, 500);
  state.posting.sourceUrls = mergeProductUrlText(state.posting.sourceUrls, discovered, 500);
  return discovered;
}

async function runProductDiscovery(options = {}) {
  const state = readState();
  if (!state.productDiscovery?.enabled) {
    const err = new Error("Product discovery is disabled.");
    err.statusCode = 409;
    throw err;
  }
  const target = clampNumber(
    options.targetCandidateCount || options.target_candidate_count || state.productDiscovery?.targetCandidateCount,
    1,
    500,
    100
  );
  const sources = productDiscoverySources(state).slice(0, 20);
  if (!sources.length) {
    const err = new Error("No valid product discovery source URLs are configured.");
    err.statusCode = 400;
    throw err;
  }
  const registers = readRegisters();
  const discovered = [];
  const errors = [];
  const parser = "cheerio";
  const parsersUsed = new Set();
  const discoveryRunAt = new Date().toISOString();
  const includeExistingCandidates = Boolean(options.includeExistingCandidates || options.include_existing_candidates);
  const includeUsedProducts = Boolean(options.includeUsedProducts || options.include_used_products);
  const maxPages = clampNumber(state.productDiscovery?.maxDiscoveryPagesPerSource, 1, 30, 5);
  const newCount = () => discovered.filter((row) => !row.reusedExistingCandidate).length;
  const withPageParam = (rawUrl, pageNum) => {
    try { const u = new URL(rawUrl); u.searchParams.set("page", String(pageNum)); return u.toString(); }
    catch { return rawUrl; }
  };
  // Page 1 of every source first; then paginate (page 2, 3, ...) ONLY while we
  // still need more NEW products and deeper pages keep yielding fresh ones. This
  // rotates across categories/searches AND deeper pages instead of running dry
  // on page 1. Stops early once a deeper page adds nothing new (sources exhausted).
  for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
    if (newCount() >= target) break;
    const newBeforePage = newCount();
    for (const baseSourceUrl of sources) {
      if (newCount() >= target) break;
      const sourceUrl = pageNum === 1 ? baseSourceUrl : withPageParam(baseSourceUrl, pageNum);
      let products = [];
      let parserName = parser;
      const useReaderFallback = async (reason) => {
        try {
          const readableText = await fetchJinaReaderText(sourceUrl);
          const readerProducts = extractProductLinks(readableText, sourceUrl, state);
          if (!readerProducts.length) {
            errors.push({ sourceUrl, message: `${reason}; reader fallback found no product links.` });
            return false;
          }
          products = readerProducts;
          parserName = "jina_reader";
          return true;
        } catch (readerErr) {
          errors.push({ sourceUrl, message: `${reason}; reader fallback failed: ${String(readerErr.message || readerErr).slice(0, 120)}` });
          return false;
        }
      };
      try {
        const html = await fetchText(sourceUrl, { timeoutMs: 15000 });
        if (isAntiBotHtml(html)) {
          throw new Error("Source returned an anti-bot or CAPTCHA page; open the URL in a normal browser/profile or provide product URLs manually.");
        }
        products = extractProductLinks(html, sourceUrl, state);
        if (!products.length) {
          const recovered = await useReaderFallback("No product links were visible in the fetched page HTML");
          if (!recovered) continue;
        }
      } catch (err) {
        const message = String(err.message || err).slice(0, 180);
        const recovered = await useReaderFallback(`Direct fetch failed: ${message}`);
        if (!recovered) continue;
      }
      const remaining = target - newCount();
      const rows = mergeDiscoveredProductsIntoState(state, registers, products, {
        sourceUrl,
        target: remaining,
        parser: parserName,
        discoveryRunAt,
        includeExistingInResult: includeExistingCandidates,
        markExistingSeen: includeExistingCandidates,
        includeUsedProducts,
      });
      if (rows.length) parsersUsed.add(parserName);
      discovered.push(...rows);
    }
    if (pageNum > 1 && newCount() === newBeforePage) break;
  }
  const newCandidateCount = discovered.filter((row) => !row.reusedExistingCandidate).length;
  const refreshedCandidateCount = discovered.filter((row) => row.reusedExistingCandidate).length;
  const antiBotBlocked = !discovered.length
    && errors.length >= sources.length
    && errors.every((item) => /anti-bot|captcha|human/i.test(item.message || ""));
  const status = discovered.length
    ? (newCandidateCount ? "direct_discovery_saved" : "direct_discovery_refreshed_existing_candidates")
    : antiBotBlocked
      ? "needs_browser_verification"
      : "no_products_found";
  const finishedAt = new Date().toISOString();
  state.productDiscovery.lastRunAt = finishedAt;
  state.productDiscovery.lastRunStatus = status;
  state.productDiscovery.lastRunParser = parsersUsed.size ? [...parsersUsed].join("+") : parser;
  state.productDiscovery.lastRunCandidateCount = discovered.length;
  state.productDiscovery.lastRunNewCandidateCount = newCandidateCount;
  state.productDiscovery.lastRunRefreshedCandidateCount = refreshedCandidateCount;
  if (discovered.length) state.productDiscovery.lastSuccessfulRunAt = discoveryRunAt;
  const nextState = writeState(state);
  if (discovered.length) {
    appendApprovalLine(registers, `${new Date().toISOString()} | type=product_discovery_run | status=pending | candidate_count=${discovered.length} | target=${target} | file=${nextState.files.productCandidates} | reason=review unique product candidates before asset/post planning`);
    writeRegisters(registers);
  }
  const parserSummary = parsersUsed.size ? [...parsersUsed].join("+") : parser;
  logEvent("product_discovery_completed", { status, discovered: discovered.length, newCandidates: newCandidateCount, refreshedCandidates: refreshedCandidateCount, target, errors: errors.length, parser: parserSummary });
  return {
    state: nextState,
    registers: readRegisters(),
    status,
    discovered: discovered.length,
    newCandidates: newCandidateCount,
    refreshedCandidates: refreshedCandidateCount,
    discoveryRunAt,
    target,
    parser: parserSummary,
    sourcesChecked: sources.length,
    file: nextState.files.productCandidates,
    candidates: discovered.slice(0, 50),
    errors,
    message: antiBotBlocked
      ? "Direct filter discovery reached the configured sources, but every source returned anti-bot/human verification HTML. Use the local browser or dedicated ShopYourLikes profile flow, solve verification manually if shown, then capture the visible page."
      : discovered.length
        ? (newCandidateCount
          ? "Direct filter discovery saved unique product candidates for review."
          : "Direct filter discovery refreshed existing unused candidates seen in the current filter scan.")
        : "Direct filter discovery completed but did not find new unique product URLs.",
  };
}

function localBrowserExecutablePath() {
  const found = EDGE_EXECUTABLE_CANDIDATES.find((candidate) => {
    try {
      return candidate && fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
  if (found) return found;
  const err = new Error("Microsoft Edge was not found. Set FACEBOOK_AGENT_EDGE_PATH to a Chromium-compatible browser executable.");
  err.statusCode = 500;
  err.publicError = "local_browser_missing";
  throw err;
}

function affiliateBrowserProfileDir(state = readState()) {
  const configured = String(state.affiliate?.browserProfilePath || "data/shopyourlikes-browser-profile").trim();
  return path.isAbsolute(configured) ? configured : path.join(ROOT, configured);
}

function playwrightProxyFromAffiliateConfig(proxy) {
  if (!proxy?.host || !proxy?.port) return null;
  const server = `${proxy.proxyType || "http"}://${normalizeProxyHost(proxy.host)}:${normalizePort(proxy.port, "Affiliate browser proxy port")}`;
  const out = { server };
  if (proxy.username) out.username = proxy.username;
  if (proxy.password) out.password = proxy.password;
  return out;
}

async function closeShopYourLikesBrowser(reason) {
  const session = localShopYourLikesSession;
  localShopYourLikesSession = null;
  if (!session?.context) return { ok: false, status: "not_open" };
  try {
    await session.context.close({ reason: reason || "shopyourlikes_browser_closed" });
    const state = readState();
    state.affiliate.browserStatus = "closed";
    writeState(state);
    logEvent("shopyourlikes_browser_closed", { reason: oneLineField(reason || "operator", 120) });
    return { ok: true, status: "closed" };
  } catch (err) {
    logEvent("shopyourlikes_browser_close_failed", { error: oneLineField(err.message || String(err), 240) });
    return { ok: false, status: "close_failed", message: oneLineField(err.message || String(err), 240) };
  }
}

async function openShopYourLikesBrowser(body = {}) {
  requireExternalArmed();
  const state = readState();
  const proxyId = String(body.proxyId || state.affiliate.browserSelectedProxyId || state.affiliateProxy.selectedProxyId || "").trim();
  if (proxyId && proxyId !== state.affiliateProxy.selectedProxyId) {
    const payload = await getWebshareProxies();
    const proxy = (payload.results || []).find((item) => String(item.id || item.proxy_address) === proxyId);
    if (!proxy) return { ok: false, status: "proxy_not_found", message: "Selected Webshare proxy was not found." };
    writeAffiliateProxySelection(proxy);
  }
  const latestState = readState();
  const startUrl = String(body.url || latestState.affiliate.browserStartUrl || "https://www.shopyourlikes.com/").trim();
  const userDataDir = affiliateBrowserProfileDir(latestState);
  fs.mkdirSync(userDataDir, { recursive: true });
  let context = localShopYourLikesSession?.context || null;
  const launchOptions = {
    executablePath: localBrowserExecutablePath(),
    headless: false,
    viewport: { width: 1365, height: 900 },
    locale: "en-US",
    acceptDownloads: true,
    args: ["--disable-popup-blocking", "--disable-extension-welcome-page"],
  };
  if (!context) {
    if (latestState.affiliate.browserUseDedicatedProxy !== false) {
      launchOptions.proxy = playwrightProxyFromAffiliateConfig(affiliateProxyConfig());
    }
    context = await chromium.launchPersistentContext(userDataDir, launchOptions);
    localShopYourLikesSession = { context, openedAt: new Date().toISOString(), userDataDir };
    context.on("close", () => {
      if (localShopYourLikesSession?.context === context) localShopYourLikesSession = null;
    });
  }
  const pages = context.pages().filter((page) => !page.isClosed());
  const page = pages[0] || await context.newPage();
  if (startUrl && /^https?:\/\//i.test(startUrl)) {
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch((err) => {
      logEvent("shopyourlikes_browser_navigation_warning", { error: oneLineField(err.message || String(err), 240) });
    });
  }
  const nextState = readState();
  nextState.affiliate.browserProfilePath = path.relative(ROOT, userDataDir).startsWith("..") ? userDataDir : path.relative(ROOT, userDataDir);
  nextState.affiliate.browserStartUrl = startUrl || nextState.affiliate.browserStartUrl;
  nextState.affiliate.browserUseDedicatedProxy = latestState.affiliate.browserUseDedicatedProxy !== false;
  nextState.affiliate.browserSelectedProxyId = readState().affiliateProxy.selectedProxyId || proxyId;
  nextState.affiliate.browserLastOpenedAt = new Date().toISOString();
  nextState.affiliate.browserStatus = "open";
  nextState.affiliate.useDedicatedIxProfile = false;
  nextState.affiliate.dedicatedIxProfileFixedIp = true;
  nextState.affiliate.rotateDedicatedProfileIp = false;
  writeState(nextState);
  logEvent("shopyourlikes_browser_opened", { profilePath: nextState.affiliate.browserProfilePath, proxyId: nextState.affiliate.browserSelectedProxyId || "saved" });
  return {
    ok: true,
    status: "open",
    url: page.url(),
    title: await page.title().catch(() => ""),
    profilePath: nextState.affiliate.browserProfilePath,
    proxy: sanitizeAffiliateProxyState(nextState).selectedProxyId || "saved affiliate proxy",
  };
}

async function closeLocalDiscoverySession(reason) {
  const session = localDiscoverySession;
  localDiscoverySession = null;
  if (!session?.context) return { ok: false, status: "not_open" };
  try {
    await session.context.close({ reason: reason || "local_discovery_finished" });
    logEvent("local_discovery_browser_closed", { reason: oneLineField(reason || "completed", 120) });
    return { ok: true, status: "closed" };
  } catch (err) {
    logEvent("local_discovery_browser_close_failed", { error: oneLineField(err.message || String(err), 240) });
    return { ok: false, status: "close_failed", message: oneLineField(err.message || String(err), 240) };
  }
}

async function captureLocalDiscoveryPage(options = {}) {
  const userDataDir = path.join(DATA_DIR, "local-browser-profile");
  fs.mkdirSync(userDataDir, { recursive: true });
  let context = localDiscoverySession?.context || null;
  let navigationError = "";
  if (!context) {
    context = await chromium.launchPersistentContext(userDataDir, {
      executablePath: localBrowserExecutablePath(),
      headless: false,
      viewport: { width: 1365, height: 900 },
      locale: "en-US",
      args: ["--disable-popup-blocking"],
    });
    localDiscoverySession = { context, openedAt: new Date().toISOString() };
    context.on("close", () => {
      if (localDiscoverySession?.context === context) localDiscoverySession = null;
    });
    logEvent("local_discovery_browser_opened");
  }
  const pages = context.pages().filter((page) => !page.isClosed());
  const page = pages[0] || await context.newPage();
  const pageUrl = page.url();
  const capturePageIsBlank = options.captureOnly && (!/^https?:\/\//i.test(pageUrl) || pageUrl === "about:blank");
  if (options.sourceUrl && (!options.captureOnly || capturePageIsBlank)) {
    try {
      await page.goto(options.sourceUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    } catch (err) {
      navigationError = String(err.message || err).slice(0, 240);
    }
  }
  await page.waitForTimeout(options.settleMs || 3500);
  const snapshot = await page.evaluate(() => ({
    url: window.location.href,
    title: document.title || "",
    text: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 1200),
    html: document.documentElement?.outerHTML || "",
  }));
  return { navigationError, ...snapshot };
}

async function runLocalBrowserProductDiscovery(body = {}) {
  requireExternalArmed();
  const state = readState();
  if (!state.productDiscovery?.enabled) {
    const err = new Error("Product discovery is disabled.");
    err.statusCode = 409;
    throw err;
  }
  const captureOnly = Boolean(body.captureOnly);
  const sourceUrl = captureOnly
    ? assertAllowedDiscoveryPageUrl(body.sourceUrl || "", state, { allowBlank: true })
    : assertAllowedDiscoveryPageUrl(body.sourceUrl || firstDiscoverySourceUrl(state), state);
  const snapshot = await captureLocalDiscoveryPage({ sourceUrl, captureOnly });
  const currentUrl = assertAllowedDiscoveryPageUrl(snapshot.url, state);
  const antiBot = isAntiBotHtml(snapshot.html) || /robot or human|captcha|verify you are human/i.test(`${snapshot.title} ${snapshot.text}`);
  if (antiBot) {
    logEvent("local_browser_discovery_needs_human_verification", { sourceUrl: sourceUrl || currentUrl });
    return {
      state: readState(),
      registers: readRegisters(),
      status: "needs_human_verification",
      browser: "local_edge_playwright",
      sourceUrl: sourceUrl || currentUrl,
      currentUrl,
      title: snapshot.title,
      message: "Local browser opened the Walmart page, but Walmart is showing human verification. Solve it manually in that browser window, then click Capture Local Page.",
      navigationError: snapshot.navigationError,
      localBrowserClose: { ok: false, status: "left_open_for_manual_verification" },
      discovered: 0,
      reviewImageCandidates: 0,
    };
  }
  const registers = readRegisters();
  const products = extractProductLinks(snapshot.html, currentUrl || sourceUrl, state);
  const selectedProduct = canonicalProduct(currentUrl || sourceUrl, state);
  if (selectedProduct) {
    products.unshift({
      ...selectedProduct,
      title: safeText(snapshot.title || selectedProduct.title, 300),
      discoveryMethod: "selected_product_page",
    });
  }
  const target = clampNumber(state.productDiscovery?.targetCandidateCount, 1, 500, 100);
  const discoveryRunAt = new Date().toISOString();
  const discovered = mergeDiscoveredProductsIntoState(state, registers, products, {
    sourceUrl: currentUrl || sourceUrl,
    target,
    parser: "local_edge_playwright_cheerio",
    discoveryRunAt,
  });
  const imageCandidates = extractReviewImageCandidates(snapshot.html, currentUrl || sourceUrl, state, products);
  if (imageCandidates.length) {
    state.productAssets.reviewImageCandidates = mergeReviewImageCandidateLines(state.productAssets.reviewImageCandidates, imageCandidates);
    appendApprovalLine(registers, `${new Date().toISOString()} | type=review_image_candidates | status=pending | candidate_count=${imageCandidates.length} | source=${currentUrl || sourceUrl} | reason=approve positive-review image candidates before JPG/PNG conversion/upload`);
    writeRegisters(registers);
  }
  if (discovered.length) {
    state.productDiscovery.lastRunAt = discoveryRunAt;
    state.productDiscovery.lastRunStatus = "local_browser_discovery_saved";
    state.productDiscovery.lastRunParser = "local_edge_playwright_cheerio";
    state.productDiscovery.lastRunCandidateCount = discovered.length;
    state.productDiscovery.lastRunNewCandidateCount = discovered.length;
    state.productDiscovery.lastRunRefreshedCandidateCount = 0;
    state.productDiscovery.lastSuccessfulRunAt = discoveryRunAt;
  }
  const nextState = writeState(state);
  if (discovered.length) {
    appendApprovalLine(registers, `${new Date().toISOString()} | type=local_browser_product_discovery | status=pending | candidate_count=${discovered.length} | source=${currentUrl || sourceUrl} | reason=review local-browser product candidates before asset/post planning`);
    writeRegisters(registers);
  }
  logEvent("local_browser_product_discovery_completed", {
    discovered: discovered.length,
    reviewImageCandidates: imageCandidates.length,
    captureOnly,
  });
  const localBrowserClose = body.closeBrowserAfterUse === false
    ? { ok: false, status: "left_open_by_request" }
    : await closeLocalDiscoverySession("local_browser_product_discovery_completed");
  return {
    state: nextState,
    registers: readRegisters(),
    status: "captured",
    browser: "local_edge_playwright",
    localBrowserClose,
    sourceUrl: sourceUrl || currentUrl,
    currentUrl,
    title: snapshot.title,
    parser: "local_edge_playwright_cheerio",
    discovered: discovered.length,
    reviewImageCandidates: imageCandidates.length,
    candidates: discovered.slice(0, 50),
    imageCandidates: imageCandidates.slice(0, 50),
    navigationError: snapshot.navigationError,
    message: discovered.length || imageCandidates.length
      ? "Captured local browser page and saved candidates for review."
      : "Captured local browser page, but no product links or positive-review image candidates were visible.",
  };
}


function highQualityReviewImageUrl(rawUrl) {
  let text = String(rawUrl || "").replace(/&amp;/g, "&").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    if (/walmartimages\.com$/i.test(url.hostname) || /walmartimages\.com/i.test(url.hostname)) {
      url.searchParams.set("odnWidth", "1200");
      url.searchParams.set("odnHeight", "1200");
      if (!url.searchParams.has("odnBg")) url.searchParams.set("odnBg", "ffffff");
    }
    return url.toString();
  } catch {
    return text;
  }
}

function isReviewRasterImageUrl(value) {
  const raw = String(value || "").replace(/&amp;/g, "&").trim();
  if (!raw || /\.svg(?:[?#]|$)/i.test(raw)) return false;
  if (/logo|icon|sprite|placeholder|loading|badge|privacy|spark|favicon/i.test(raw)) return false;
  try {
    const url = new URL(raw);
    const pathText = `${url.hostname}${url.pathname}`.toLowerCase();
    const hasRasterExt = /\.(?:jpe?g|png|webp|avif)(?:$|[?#])/i.test(raw);
    // Walmart's image CDN serves customer REVIEW photos as extension-less URLs like
    // i5.walmartimages.com/dfw/<hash>/k2-_<uuid>.v1 (ends in .v1, not .jpg). The old
    // ".jpg/.png required" check rejected EVERY review photo. But NOT every
    // walmartimages.com URL is a review photo — catalog/hero/packaging images live on
    // the SAME CDN (e.g. /asr/...jpeg, /seo/...). Accept a Walmart image ONLY when it
    // matches the customer-photo shape (a /dfw/ path, a k2- filename, or the .v1 form),
    // otherwise the context-free caller (collectReviewImageUrls) harvests catalog images
    // as "review photos" and could auto-post a non-review image.
    const isWalmartHost = /walmartimages\.com/i.test(url.hostname);
    const isWalmartReviewPhoto = isWalmartHost
      && (/\/dfw\//i.test(url.pathname) || /\/k2[-_]/i.test(url.pathname) || /\.v1(?:[?#]|$)/i.test(raw));
    if (isWalmartReviewPhoto) return true;
    if (isWalmartHost) return false; // walmart catalog/hero image, not a customer photo
    if (!hasRasterExt) return false;
    return /review|customer|ugc|photos?/i.test(pathText);
  } catch {
    return false;
  }
}

function productAssetRelativeDir(product, state) {
  const base = String(state.productAssets?.outputPath || "data/product-assets").trim() || "data/product-assets";
  const slug = String(`${product.store || "product"}-${product.productId || product.key || "item"}`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90) || "product-review-image";
  return path.join(base, slug);
}

function parseMarkdownCustomerPhotoCandidates(markdown, context) {
  const rows = [];
  const text = String(markdown || "");
  const customerBlock = (text.match(/##\s*Customer photos[\s\S]*?(?:Filtered and sorted|### Showing|##\s|$)/i) || [""])[0];
  if (!customerBlock) return rows;
  const source = customerBlock;
  const pattern = /!\[[^\]]*(?:customer photos?|review|image \d+)[^\]]*\]\((https?:\/\/[^)]+)\)/gi;
  for (const match of source.matchAll(pattern)) {
    const imageUrl = match[1].replace(/&amp;/g, "&").trim();
    if (!isReviewRasterImageUrl(imageUrl)) continue;
    rows.push({
      productUrl: context.productUrl,
      productTitle: context.productTitle,
      rating: context.preferredRating || 5,
      sentiment: "positive_or_neutral",
      imageUrl,
      visualHint: "customer photo block; prefer actual product visible over packaging-only",
      source: "customer_photos_markdown",
      priority: "preferred",
    });
  }
  return rows;
}

// Is a title just the numeric "Walmart product {id}" slug fallback (or a bare id)? Such
// titles must never reach a public post or be trusted as the unique locator.
function isNumericFallbackTitle(s) {
  const t = String(s || "").trim();
  if (!t) return true;
  if (/^(walmart|amazon|target|ebay)\s+product\s+[a-z0-9]{4,}$/i.test(t)) return true;
  if (/^\d{4,}$/.test(t)) return true;
  return false;
}

// THE single source of truth for a post's locator MARKER (the cleaned title phrase that is
// appended to the post and exact-matched to find it). Shared by livePostPayloadForRow AND the
// concurrent pick loops (so the batch can dedup on the SAME value). Cap is generous (160) so
// VARIANT/COLOR/SIZE words at the END of a title survive — a 100-char cap dropped the trailing
// color and made two sibling products ("...Toy Storage - Blue" vs "...- Butter") share a marker,
// which collided under parallel posting. Numeric "Walmart product {id}" titles fall back to a
// per-product deterministic natural phrase (no number/code).
const POST_MARKER_FB_ADJ = ["Cozy", "Handy", "Smart", "Bright", "Classic", "Trusty", "Comfy", "Sleek", "Sturdy", "Lovely", "Premium", "Everyday", "Essential", "Deluxe", "Compact", "Versatile", "Stylish", "Durable", "Charming", "Practical"];
const POST_MARKER_FB_NOUN = ["Home", "Kitchen", "Outdoor", "Family", "Living", "Bargain", "Treasure", "Staple", "Upgrade", "Pick", "Gem", "Favorite", "Companion", "Helper", "Saver", "Choice", "Wonder", "Comfort", "Style", "Essential"];
function computePostMarkerPhrase(row) {
  let rawTitle = String((row && (row.title || row.productTitle)) || "").replace(/\s+/g, " ").trim();
  if (isNumericFallbackTitle(rawTitle)) {
    const seed = String((row && (row.productKey || row.productId || row.url || row.title)) || "fallback");
    const h = crypto.createHash("sha1").update(seed).digest();
    const w1 = POST_MARKER_FB_ADJ[h[0] % POST_MARKER_FB_ADJ.length];
    const w2 = POST_MARKER_FB_NOUN[h[1] % POST_MARKER_FB_NOUN.length];
    let w3 = POST_MARKER_FB_NOUN[h[2] % POST_MARKER_FB_NOUN.length];
    if (w3 === w2) w3 = POST_MARKER_FB_NOUN[(h[2] + 1) % POST_MARKER_FB_NOUN.length];
    rawTitle = `${w1} ${w2} ${w3} Deal`;
  }
  let phrase = rawTitle.replace(/[&<>"'`|#@]+/g, " ").replace(/\s+/g, " ").trim();
  if (phrase.length > 160) phrase = phrase.slice(0, 160).replace(/\s+\S*$/, "").trim(); // keep variant tail; never cut mid-word
  if (phrase.length < 8) phrase = "Walmart clearance deal find";
  return phrase;
}
// Two markers are "siblings" if one is a prefix of the other OR they share a long (>=60 char)
// common prefix — i.e. variant products of the same listing (e.g. RC Lamborghini "...- Red" vs
// "...- White"). Such products must NOT post in the SAME concurrent batch: their near-identical
// captions make the feed-capture ambiguous. The body-marker verify already rejects a wrong grab,
// but keeping siblings out of one batch is cheap defense-in-depth (they post in separate ticks).
function markersAreSiblings(a, b) {
  const x = String(a || "").toLowerCase().trim();
  const y = String(b || "").toLowerCase().trim();
  if (!x || !y) return false;
  if (x === y || x.startsWith(y) || y.startsWith(x)) return true;
  const n = Math.min(x.length, y.length);
  let i = 0;
  while (i < n && x[i] === y[i]) i += 1;
  return i >= 60;
}

// Pull the REAL human product title out of an already-scraped product page (the review-image
// providers fetch this page anyway). Priority: og:title -> <h1> -> <title> -> JSON-LD name
// (HTML), or the "Title:" header / first "# " H1 (Jina markdown). Rejects the numeric fallback
// and review-page/anti-bot chrome so we never store a number or "Customer Reviews".
function extractRealProductTitleFromContent(content) {
  const html = String(content?.html || content?.rawHtml || "");
  const markdown = String(content?.markdown || content?.text || "");
  const decode = (s) => String(s || "")
    .replace(/&amp;/gi, "&").replace(/&#0?39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/&nbsp;/gi, " ").replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return " "; } });
  const clean = (s) => decode(String(s || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .replace(/\s*[-|–—:]\s*Walmart\.com.*$/i, "")
    .replace(/\s*[-|–—:]\s*Walmart\s*$/i, "")
    .replace(/\s*[-|–—:]?\s*(customer\s+)?(ratings?\s*(and|&)\s*reviews?|reviews?)\s*$/i, "") // reviews-page title -> clean product name
    .trim();
  const rejectTitle = (t) => {
    if (!t || t.length < 8) return true;
    if (isNumericFallbackTitle(t)) return true;
    if (/^(customer reviews?|reviews? for|product reviews?|ratings?\s*(and|&)\s*reviews?)\b/i.test(t)) return true;
    if (/just a moment|are you a human|verify you are|captcha|access denied|robot|enable javascript/i.test(t)) return true;
    return false;
  };
  const cands = [];
  if (html) {
    const og = html.match(/<meta[^>]+(?:property|name)=["']og:title["'][^>]*content=["']([^"']+)["']/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']og:title["']/i);
    if (og) cands.push(og[1]);
    const h1 = html.match(/<h1[^>]*>([\s\S]{4,300}?)<\/h1>/i); if (h1) cands.push(h1[1]);
    const tt = html.match(/<title[^>]*>([\s\S]{4,300}?)<\/title>/i); if (tt) cands.push(tt[1]);
    const ld = html.match(/"@type"\s*:\s*"Product"[\s\S]{0,400}?"name"\s*:\s*"([^"]{8,200})"/i)
      || html.match(/"name"\s*:\s*"([^"]{8,200})"[\s\S]{0,400}?"@type"\s*:\s*"Product"/i);
    if (ld) cands.push(ld[1]);
  }
  if (markdown) {
    const tl = markdown.match(/^\s*Title:\s*(.+)$/im); if (tl) cands.push(tl[1]);
    const mh = markdown.match(/^\s*#\s+(.{4,200})$/m); if (mh) cands.push(mh[1]);
  }
  for (const c of cands) { const t = clean(c); if (!rejectTitle(t)) return t.slice(0, 200); }
  return "";
}

// Persist productKey -> real title (keyed upsert) so it survives to the posting plan even for
// products that entered via a pasted URL list (not the discovery candidate cache).
function recordProductRealTitle(productKey, title) {
  const key = String(productKey || "").trim();
  const t = String(title || "").trim();
  if (!key || !t || isNumericFallbackTitle(t)) return;
  try {
    const registers = readRegisters();
    const lines = recordLines(registers.productTitles);
    const out = [];
    let found = false;
    let changed = false;
    for (const line of lines) {
      if (!line || line.startsWith("#")) { out.push(line); continue; }
      const i = line.indexOf("\t");
      const k = i < 0 ? line : line.slice(0, i);
      if (k.trim().toLowerCase() === key.toLowerCase()) {
        found = true;
        const v = i < 0 ? "" : line.slice(i + 1);
        if (v.trim() !== t) { out.push(`${key}\t${t}`); changed = true; } else out.push(line);
      } else out.push(line);
    }
    if (!found) { out.push(`${key}\t${t}`); changed = true; }
    if (changed) {
      registers.productTitles = (out.filter(Boolean).join("\n") + "\n").slice(0, 200000);
      writeRegisters(registers);
      logEvent("product_real_title_recorded", { productKey: key, title: oneLineField(t, 120) });
    }
  } catch (err) {
    logEvent("product_real_title_record_failed", { productKey: key, error: oneLineField(err.message || String(err), 160) });
  }
}
function realProductTitleMap() {
  const map = new Map();
  try {
    const registers = readRegisters();
    for (const line of recordLines(registers.productTitles)) {
      if (!line || line.startsWith("#")) continue;
      const i = line.indexOf("\t");
      if (i < 0) continue;
      const k = line.slice(0, i).trim().toLowerCase();
      const v = line.slice(i + 1).trim();
      if (k && v && !isNumericFallbackTitle(v) && !map.has(k)) map.set(k, v);
    }
  } catch {}
  return map;
}

function extractReviewImageCandidatesFromContent(content, product, state) {
  const html = String(content?.html || content?.rawHtml || "");
  const markdown = String(content?.markdown || content?.text || "");
  const htmlAntiBot = Boolean(html && isAntiBotHtml(html));
  const markdownAntiBot = Boolean(markdown && isAntiBotText(markdown));
  const pageUrl = product.url;
  const rows = html && !htmlAntiBot ? extractReviewImageCandidates(html, pageUrl, state, [product]) : [];
  // Harvest the REAL product title from this already-fetched page and persist it (operator
  // request: "with the scraping of review images he should get also product title"). Stored
  // once, used later as the post signature + exact-match locator — no numeric fallback posted.
  const realTitle = extractRealProductTitleFromContent(content);
  if (realTitle && product && product.key) recordProductRealTitle(product.key, realTitle);
  const context = {
    productUrl: product.url,
    productTitle: safeText(realTitle || product.title || product.productId || product.url, 200),
    minRating: clampNumber(state.productAssets?.minReviewRating, 1, 5, 4),
    preferredRating: clampNumber(state.productAssets?.preferredReviewRating, 1, 5, 5),
  };
  rows.push(...parseMarkdownCustomerPhotoCandidates(markdown, context));
  if (!rows.length && (htmlAntiBot || markdownAntiBot)) {
    throw new Error(`${content?.provider || "product_content"} returned verification/anti-bot content and no usable customer review image candidates.`);
  }
  const productId = product.productId || "";
  return uniqueReviewImageCandidates(rows, 25).map((row, index) => ({
    ...row,
    imageUrl: highQualityReviewImageUrl(row.imageUrl),
    seoFilename: seoFileName(row.productTitle, productId, index),
  }));
}

// One or more Firecrawl API keys (newline/comma separated). Multiple keys give
// automatic fallback when one runs out of credits/rate limit.
// Each Firecrawl line is "fc-key" or "fc-key | http://user:pass@host:port" — the
// optional per-key IP proxy (operator wants each key egressing from its own IP to
// api.firecrawl.dev). Split on the first "|"; the key is everything before it.
function firecrawlKeyConfigs(secrets = readSecrets()) {
  const raw = secrets.firecrawl?.apiKeys || secrets.firecrawl?.apiKey || process.env.FIRECRAWL_API_KEY || "";
  return String(raw)
    .split(/[\n,]+/)
    .map((line) => {
      const parts = String(line).split("|");
      return { key: (parts[0] || "").trim(), proxy: (parts[1] || "").trim() };
    })
    .filter((c) => c.key && /^fc-/i.test(c.key));
}
function firecrawlApiKeys(secrets = readSecrets()) {
  return firecrawlKeyConfigs(secrets).map((c) => c.key);
}
// Firecrawl proxy strategy. CREDIT COST (matters on FREE plans, ~500-1000 credits):
//   basic=1 credit, auto=Firecrawl picks (1 credit, escalates to ~5 only if the site
//   blocks), enhanced=5 credits EVERY scrape (always stealth). Default "auto" — cheapest
//   that still beats Walmart anti-bot (it auto-escalates when basic is blocked). Override
//   via secrets.firecrawl.proxyMode = "basic" | "auto" | "enhanced".
function firecrawlProxyMode(secrets = readSecrets()) {
  const m = String(secrets.firecrawl?.proxyMode || "auto").trim().toLowerCase();
  return ["basic", "auto", "enhanced"].includes(m) ? m : "auto";
}
// Cache one undici ProxyAgent per distinct proxy URL so each Firecrawl key can egress
// from its own IP. A blank proxy => null dispatcher (direct, server IP).
let __firecrawlKeyCursor = 0; // round-robin cursor so requests spread equally across keys
const __firecrawlProxyDispatchers = new Map();
function firecrawlProxyDispatcherForUrl(proxyUrl) {
  const clean = String(proxyUrl || "").trim();
  if (!clean) return null;
  if (__firecrawlProxyDispatchers.has(clean)) return __firecrawlProxyDispatchers.get(clean);
  let dispatcher = null;
  try {
    const { ProxyAgent } = require("undici");
    dispatcher = new ProxyAgent(clean);
    logEvent("firecrawl_key_proxy_dispatcher_ready", { proxy: clean.replace(/\/\/[^@/]*@/, "//***@") });
  } catch (err) {
    logEvent("firecrawl_key_proxy_dispatcher_failed", { proxy: clean.replace(/\/\/[^@/]*@/, "//***@"), error: oneLineField(err.message || String(err), 160) });
    dispatcher = null;
  }
  __firecrawlProxyDispatchers.set(clean, dispatcher);
  return dispatcher;
}

async function firecrawlScrapeProduct(product, state, secrets = readSecrets()) {
  const configs = firecrawlKeyConfigs(secrets);
  if (!configs.length) return null;
  // ROUND-ROBIN the starting key so requests spread EQUALLY across all keys (keeps every
  // free-plan key warm + maximizes combined quota); still falls through every key on error.
  const startIdx = (((__firecrawlKeyCursor++) % configs.length) + configs.length) % configs.length;
  const ordered = configs.slice(startIdx).concat(configs.slice(0, startIdx));
  const base = normalizeOptionalServiceBaseUrl(secrets.firecrawl?.baseUrl || defaultSecrets().firecrawl.baseUrl, "Firecrawl", ALLOWED_FIRECRAWL_HOSTS) || defaultSecrets().firecrawl.baseUrl;
  const endpoint = new URL("/v2/scrape", base).toString();
  // Scrape the Walmart REVIEWS page (where customer photos live) — NOT the product
  // page, which has none. Firecrawl renders the JS + handles the anti-bot; scroll to
  // pull the lazy-loaded review-photo carousel into the HTML before capture.
  const targetUrl = (product.store === "walmart" && product.productId)
    ? `https://www.walmart.com/reviews/product/${encodeURIComponent(product.productId)}`
    : product.url;
  const payload = {
    url: targetUrl,
    formats: ["markdown", "html", "links"],
    proxy: firecrawlProxyMode(secrets),
    location: { country: "US" },
    waitFor: 4000,
    actions: [
      { type: "wait", milliseconds: 2500 },
      { type: "scroll", direction: "down" },
      { type: "wait", milliseconds: 1200 },
      { type: "scroll", direction: "down" },
      { type: "wait", milliseconds: 1200 },
      { type: "scroll", direction: "down" },
      { type: "wait", milliseconds: 1500 },
    ],
  };
  let lastErr = null;
  for (let i = 0; i < configs.length; i += 1) {
    const dispatcher = firecrawlProxyDispatcherForUrl(ordered[i].proxy);
    try {
      const result = await fetchJson(endpoint, {
        method: "POST",
        timeoutMs: 120000,
        headers: { "Authorization": `Bearer ${ordered[i].key}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        ...(dispatcher ? { dispatcher } : {}),
      });
      const data = result?.data || result;
      const html = data?.html || data?.rawHtml || "";
      const markdown = data?.markdown || "";
      // A 200 with an empty body (or success:false) is an anti-bot/blank render, NOT a
      // real result. Returning it as success would short-circuit the provider chain
      // (Jina/browser never run) and silently yield 0 review candidates. Record it and
      // try the next key; if none left, the post-loop throw lets the next provider run.
      if (result?.success === false || (!String(html).trim() && !String(markdown).trim())) {
        logEvent("firecrawl_empty_result", { keyIndex: i, ofKeys: configs.length, targetUrl });
        lastErr = new Error(`Firecrawl returned empty content (blank/anti-bot render) for ${targetUrl}`);
        continue;
      }
      if (i > 0) logEvent("firecrawl_key_fallback_used", { keyIndex: i, ofKeys: configs.length });
      return { provider: "firecrawl", html, markdown, raw: data, targetUrl };
    } catch (err) {
      lastErr = err;
      const status = Number(err.remoteStatus || err.statusCode || 0);
      const exhausted = status === 402 || status === 429 || /quota|rate.?limit|exhaust|insufficient|credit|payment/i.test(String(err.message || ""));
      if (exhausted && i < configs.length - 1) {
        logEvent("firecrawl_key_exhausted_trying_next", { keyIndex: i, ofKeys: configs.length, status, error: oneLineField(err.message || String(err), 160) });
        continue;
      }
      // Non-quota error (e.g. scrape failed for this URL) — don't burn the other keys.
      throw err;
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

async function jinaReaderProduct(product) {
  const markdown = await fetchJinaReaderText(product.url);
  return { provider: isAntiBotText(markdown) ? "jina_reader_partial_antibot" : "jina_reader", markdown, html: "" };
}

async function jinaReaderWalmartReviewsProduct(product) {
  if (product?.store !== "walmart" || !product?.productId) return null;
  const reviewUrl = `https://www.walmart.com/reviews/product/${encodeURIComponent(product.productId)}`;
  const markdown = await fetchJinaReaderText(reviewUrl);
  return {
    provider: isAntiBotText(markdown) ? "jina_reader_reviews_partial_antibot" : "jina_reader_reviews",
    markdown,
    html: "",
  };
}

async function chooseNormalIxBrowserProfileForProductCapture(state) {
  const data = await ixBrowserRequest("profile-list", { page: 1, limit: 100 });
  const rows = ixBrowserProfileRows(data);
  for (const rawProfile of rows.profiles || []) {
    const profile = sanitizeIxBrowserProfile(rawProfile);
    const profileId = Number(profile.profile_id || profile.id || 0);
    const label = oneLineField(`${profileId}${profile.name ? ` - ${profile.name}` : ""}`, 180);
    if (!profileId || !label) continue;
    if (normalIxProfileUseLocks.has(String(profileId))) continue;
    if (isDedicatedShopYourLikesIxProfile(profileId, state) || isDedicatedShopYourLikesProfileLabel(label, state)) continue;
    if (isBlockedIxBrowserProfileLabel(label, state)) continue;
    if (isFacebookProfileQuarantinedForFacebook(label, state)) continue;
    if (isFacebookAdminApprovalProfileId(profileId, state) || isFacebookAdminApprovalProfileLabel(label, state)) continue;
    return { profileId, label };
  }
  return null;
}

async function ixBrowserReviewImagesProduct(product, state = readState(), secrets = readSecrets(), options = {}) {
  if (options.disableBrowserFallback || options.disable_browser_fallback) return null;
  // Capture the Walmart review page through the dedicated ShopYourLikes #40 profile:
  // it uses the residential proxy IP that Walmart does NOT flag. Jina's cloud IP and
  // the posting profiles' datacenter IPs both hit Walmart's "Robot/Human" captcha.
  // #40 is kept-open, so we must NOT close it before/after this capture.
  const sylProfileId = Number(state.affiliate?.dedicatedIxProfileId) || 0;
  const captureProfile = sylProfileId
    ? { profileId: sylProfileId, label: `${sylProfileId} - shopyourlikes`, isSyl: true }
    : await chooseNormalIxBrowserProfileForProductCapture(state);
  if (!captureProfile?.profileId) return null;
  const urls = [];
  if (product?.store === "walmart" && product?.productId) {
    urls.push(`https://www.walmart.com/reviews/product/${encodeURIComponent(product.productId)}`);
  }
  urls.push(product.url);
  const attempts = [];
  try {
    for (const sourceUrl of [...new Set(urls.filter(Boolean))]) {
      try {
        const snapshot = await captureIxBrowserPage(captureProfile.profileId, {
          sourceUrl,
          captureOnly: false,
          closeExistingBeforeOpen: !captureProfile.isSyl,
          closeProfileOnError: !captureProfile.isSyl,
          settleMs: 6000,
          scrollForLazyLoad: true,
        });
        attempts.push({
          provider: "ixbrowser_review_image_page",
          profileId: captureProfile.profileId,
          sourceUrl,
          title: snapshot.title || "",
          navigationError: snapshot.navigationError || "",
        });
        if (isAntiBotHtml(snapshot.html) || isAntiBotText(`${snapshot.title || ""} ${snapshot.text || ""}`)) {
          attempts.push({
            provider: "ixbrowser_review_image_page",
            profileId: captureProfile.profileId,
            sourceUrl,
            error: "browser page showed Walmart verification/anti-bot content",
          });
          continue;
        }
        const candidates = extractReviewImageCandidatesFromContent({
          provider: "ixbrowser_review_image_page",
          html: snapshot.html || "",
          markdown: "",
        }, product, state);
        if (!candidates.length) {
          attempts.push({
            provider: "ixbrowser_review_image_page",
            profileId: captureProfile.profileId,
            sourceUrl,
            candidateCount: 0,
          });
          continue;
        }
        return {
          provider: "ixbrowser_review_image_page",
          html: snapshot.html || "",
          markdown: "",
          candidates,
          raw: {
            profileId: captureProfile.profileId,
            profile: captureProfile.label,
            sourceUrl,
            currentUrl: snapshot.url || "",
            navigationError: snapshot.navigationError || "",
            attempts,
          },
        };
      } catch (err) {
        attempts.push({
          provider: "ixbrowser_review_image_page",
          profileId: captureProfile.profileId,
          sourceUrl,
          error: oneLineField(err.message || String(err), 300),
        });
      }
    }
  } finally {
    await ixBrowserCloseAfterUse(captureProfile.profileId, "product_review_image_browser_fallback_completed");
  }
  const err = new Error(`IXBrowser review image fallback found no usable page. attempts=${JSON.stringify(attempts).slice(0, 500)}`);
  err.attempts = attempts;
  throw err;
}

async function downloadImageBuffer(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "image/avif,image/webp,image/apng,image/png,image/jpeg,image/*,*/*;q=0.8",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        referer: "https://www.walmart.com/",
      },
    });
    if (!response.ok) throw new Error(`image HTTP ${response.status}`);
    const type = response.headers.get("content-type") || "";
    if (!/^image\//i.test(type)) throw new Error(`not an image: ${type || "unknown content-type"}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    assertUsableReviewImageBuffer(buffer, type, url);
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

function imageSignatureMimeFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return "";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png";
  if (buffer.slice(0, 4).toString("ascii") === "RIFF" && buffer.slice(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buffer.slice(0, 6).toString("ascii").startsWith("GIF")) return "image/gif";
  const boxType = buffer.slice(4, 8).toString("ascii");
  const brand = buffer.slice(8, 16).toString("ascii");
  if (boxType === "ftyp" && /avif|avis/i.test(brand)) return "image/avif";
  return "";
}

function assertUsableReviewImageBuffer(buffer, contentType = "", url = "") {
  const byteLength = Buffer.isBuffer(buffer) ? buffer.length : 0;
  if (byteLength < 8192) {
    throw new Error(`image body too small for a usable review photo (${byteLength} bytes)`);
  }
  const signatureMime = imageSignatureMimeFromBuffer(buffer);
  if (!signatureMime) {
    const head = buffer.slice(0, Math.min(buffer.length, 256)).toString("utf8");
    const bodyHint = /<html|<!doctype|<error|accessdenied|request denied|<svg/i.test(head)
      ? "download returned markup/error content"
      : `unsupported image bytes (${contentType || "unknown content-type"})`;
    throw new Error(`${bodyHint}${url ? ` from ${url.slice(0, 180)}` : ""}`);
  }
  return signatureMime;
}

function imageMimeFromBuffer(buffer) {
  return imageSignatureMimeFromBuffer(buffer) || "image/jpeg";
}

async function convertImageToJpeg(inputPath, outputPath) {
  const buffer = fs.readFileSync(inputPath);
  const browser = await chromium.launch({
    executablePath: localBrowserExecutablePath(),
    headless: true,
    args: ["--disable-popup-blocking"],
  });
  try {
    const page = await browser.newPage();
    const converted = await page.evaluate(async ({ dataUrl }) => {
      const img = new Image();
      img.decoding = "async";
      const loaded = new Promise((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("image decode failed"));
      });
      img.src = dataUrl;
      await loaded;
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      return {
        dataUrl: canvas.toDataURL("image/jpeg", 0.92),
        width: canvas.width,
        height: canvas.height,
      };
    }, { dataUrl: `data:${imageMimeFromBuffer(buffer)};base64,${buffer.toString("base64")}` });
    const dataUrl = typeof converted === "string" ? converted : converted?.dataUrl || "";
    const match = String(dataUrl || "").match(/^data:image\/jpeg;base64,(.+)$/);
    if (!match) throw new Error("Browser image conversion did not return JPEG output.");
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, Buffer.from(match[1], "base64"));
    return {
      width: Number(converted?.width || 0),
      height: Number(converted?.height || 0),
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

function chatGptHdStatePath() {
  return path.join(DATA_DIR, "chatgpt-hd-state.json");
}

function isChatGptLoginRequiredError(value) {
  return /chatgpt browser is not logged in|log in once|log in to start chatting|continue with google|continue with apple|sign up for free/i.test(String(value || ""));
}

function isChatGptImageGuardrailFailure(value) {
  return /image we created may violate our guardrails|may violate.{0,80}guardrails|guardrails concerning similarity|similarity to third-party content|third-party content|violat(?:e|es|ed|ing).{0,80}guardrails/i.test(String(value || ""));
}

function readChatGptHdState() {
  try {
    const parsed = parseJsonFile(chatGptHdStatePath());
    return {
      currentConversationCount: clampNumber(parsed.currentConversationCount, 0, 100000, 0),
      totalProcessed: clampNumber(parsed.totalProcessed, 0, 100000000, 0),
      lastRotatedAt: parsed.lastRotatedAt || "",
      updatedAt: parsed.updatedAt || "",
    };
  } catch {
    return { currentConversationCount: 0, totalProcessed: 0, lastRotatedAt: "", updatedAt: "" };
  }
}

function writeChatGptHdState(state) {
  atomicWrite(chatGptHdStatePath(), JSON.stringify(state, null, 2) + "\n");
  return state;
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function chatGptCdpUrl(assetState = {}) {
  const raw = String(assetState.chatgptEdgeCdp || "http://127.0.0.1:9334").trim();
  const url = new URL(raw || "http://127.0.0.1:9334");
  const host = url.hostname.toLowerCase();
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("ChatGPT browser CDP must stay on localhost/127.0.0.1.");
  }
  if (url.protocol !== "http:") {
    throw new Error("ChatGPT browser CDP must be a local HTTP endpoint.");
  }
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url;
}

async function canReachChatGptCdp(cdpUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(new URL("/json/version", cdpUrl).toString(), { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function chatGptEdgeUserDataDir(assetState = {}) {
  return normalizedChatGptEdgeUserDataDir(assetState.chatgptEdgeUserDataDir || assetState.chatgptBrowserProfilePath || "");
}

function chatGptEdgeProfileDirectory(assetState = {}) {
  return String(assetState.chatgptEdgeProfileDirectory || "").trim();
}

function normalizedPathForCompare(value) {
  return path.resolve(String(value || "")).replace(/[\\/]+/g, "\\").replace(/\\+$/g, "").toLowerCase();
}

function isDefaultEdgeUserDataDir(value) {
  return Boolean(DEFAULT_EDGE_USER_DATA_DIR)
    && normalizedPathForCompare(value) === normalizedPathForCompare(DEFAULT_EDGE_USER_DATA_DIR);
}

function normalizedChatGptEdgeUserDataDir(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return AGENT_CHATGPT_EDGE_USER_DATA_DIR;
  return path.isAbsolute(raw) ? path.resolve(raw) : safeProjectPath(raw);
}

function chatGptEdgeProfileIsAgentOwned(userDataDir) {
  return normalizedPathForCompare(userDataDir) === normalizedPathForCompare(AGENT_CHATGPT_EDGE_USER_DATA_DIR);
}

async function windowsEdgeMainProcesses() {
  if (process.platform !== "win32") return [];
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process -Filter \"name = 'msedge.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Depth 3",
    ], { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 }));
  } catch {
    return [];
  }
  if (!stdout.trim()) return [];
  try {
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

async function chatGptCdpProcessOwnedByUserData(userDataDir, port) {
  const targetUserData = normalizedPathForCompare(userDataDir);
  const targetPortPattern = new RegExp(`--remote-debugging-port=${String(port).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$|")`, "i");
  const processes = await windowsEdgeMainProcesses();
  return processes.some((processInfo) => {
    const commandLine = String(processInfo.CommandLine || "");
    if (!commandLine || /--type=/i.test(commandLine) || !targetPortPattern.test(commandLine)) return false;
    const lower = commandLine.toLowerCase();
    return lower.includes(`--user-data-dir=${targetUserData}`.toLowerCase())
      || lower.includes(`--user-data-dir="${targetUserData}"`.toLowerCase());
  });
}

async function chatGptEdgeProfileOpenWithoutCdp(userDataDir, profileDirectory, port) {
  const processes = await windowsEdgeMainProcesses();
  const targetUserData = normalizedPathForCompare(userDataDir);
  const defaultEdgeUserData = normalizedPathForCompare(DEFAULT_EDGE_USER_DATA_DIR || "");
  const targetProfile = String(profileDirectory || "Default").toLowerCase();
  const targetPortPattern = new RegExp(`--remote-debugging-port=${String(port).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$|")`, "i");
  const matching = processes.find((processInfo) => {
    const commandLine = String(processInfo.CommandLine || "");
    if (!commandLine || /--type=/i.test(commandLine)) return false;
    const lower = commandLine.toLowerCase();
    const hasCdp = targetPortPattern.test(commandLine);
    if (hasCdp) return false;
    const hasProfile = lower.includes(`--profile-directory=${targetProfile}`) || (!profileDirectory && lower.includes("--profile-directory=default"));
    const hasUserData = lower.includes(`--user-data-dir=${targetUserData}`.toLowerCase()) || lower.includes(`--user-data-dir="${targetUserData}"`.toLowerCase());
    const defaultProfileWithoutUserData = targetUserData === defaultEdgeUserData && hasProfile;
    return hasUserData || defaultProfileWithoutUserData;
  });
  if (!matching) return null;
  return { pid: matching.ProcessId, profileDirectory: profileDirectory || "Default", userDataDir };
}

async function closeBlockingChatGptEdgeProfile(blockingProfile) {
  const pid = Number(blockingProfile?.pid);
  if (process.platform !== "win32" || !pid) return false;
  await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-Command",
    `Stop-Process -Id ${pid} -Force -ErrorAction Stop`,
  ], { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
  logEvent("chatgpt_blocking_edge_profile_closed", {
    pid,
    profileDirectory: blockingProfile.profileDirectory,
    reason: "reopen_with_cdp_for_hd_image_workflow",
  });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return true;
}

// Set by warmup when it successfully launches Edge. Lets the later HD step
// trust this Edge without the unreliable WMI-based ownership detection.
let __chatGptWarmupContext = null;

async function ensureChatGptCdpBrowser(assetState = {}) {
  let cdpUrl = chatGptCdpUrl(assetState);
  let port = Number(cdpUrl.port || 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("ChatGPT browser CDP port is invalid.");
  const userDataDir = chatGptEdgeUserDataDir(assetState);
  const profileDirectory = chatGptEdgeProfileDirectory(assetState);
  const agentOwnedProfile = chatGptEdgeProfileIsAgentOwned(userDataDir);
  fs.mkdirSync(userDataDir, { recursive: true });
  const openNewWindow = () => {
    const windowArgs = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--disable-popup-blocking",
      "--new-window",
      "--window-size=1280,980",
      "https://chatgpt.com/",
    ];
    if (profileDirectory) windowArgs.splice(2, 0, `--profile-directory=${profileDirectory}`);
    const child = spawn(localBrowserExecutablePath(), windowArgs, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
    return child;
  };
  if (await canReachChatGptCdp(cdpUrl)) {
    // If warmup launched Edge on the same port + user-data-dir recently,
    // TRUST it. Skip the WMI-based ownership check which is unreliable when
    // Edge spawns child processes with different command-line shapes.
    const warmupTrust = __chatGptWarmupContext
      && Number(__chatGptWarmupContext.port) === port
      && normalizedPathForCompare(__chatGptWarmupContext.userDataDir || "") === normalizedPathForCompare(userDataDir)
      && (Date.now() - Number(__chatGptWarmupContext.at || 0)) < 30 * 60 * 1000;
    if (warmupTrust) {
      logEvent("chatgpt_cdp_reused_from_warmup", { cdp: cdpUrl.toString(), warmupAgeSec: Math.round((Date.now() - __chatGptWarmupContext.at) / 1000) });
      return { started: false, newWindowOpened: false, reused: true, cdp: cdpUrl.toString(), userDataDir, profileDirectory, port, agentOwned: agentOwnedProfile };
    }
    if (!(await chatGptCdpProcessOwnedByUserData(userDataDir, port))) {
      const originalPort = port;
      for (let candidatePort = originalPort + 1; candidatePort <= originalPort + 20; candidatePort += 1) {
        const candidateUrl = new URL(cdpUrl.toString());
        candidateUrl.port = String(candidatePort);
        if (!(await canReachChatGptCdp(candidateUrl))) {
          cdpUrl = candidateUrl;
          port = candidatePort;
          logEvent("chatgpt_cdp_port_shifted_for_isolation", {
            fromPort: originalPort,
            toPort: port,
            reason: "configured_port_belongs_to_non_agent_edge_profile",
          });
          break;
        }
      }
      if (port === originalPort) {
        throw new Error(`ChatGPT CDP port ${originalPort} is already used by a non-agent Edge profile. Close that debug browser or change the ChatGPT CDP endpoint to a free localhost port.`);
      }
      // Port shifted — need to launch a fresh Edge on the new port.
      openNewWindow();
      for (let i = 0; i < 60; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (await canReachChatGptCdp(cdpUrl)) {
          logEvent("chatgpt_cdp_new_window_opened", { cdp: cdpUrl.toString(), userDataDir, profileDirectory, isolated: agentOwnedProfile });
          return { started: false, newWindowOpened: true, cdp: cdpUrl.toString(), userDataDir, profileDirectory, port, agentOwned: agentOwnedProfile };
        }
      }
      throw new Error(`Opened isolated Edge for ChatGPT, but CDP did not answer at ${cdpUrl.toString()} after 30s.`);
    }
    // CDP is reachable AND owned by our profile - reuse, no second window.
    // The chatgpt-hd-upgrade.js script will find the existing chatgpt page
    // and open a "New chat" inside it. Avoids the duplicate-window UX.
    logEvent("chatgpt_cdp_reused_existing_window", { cdp: cdpUrl.toString(), userDataDir, profileDirectory, isolated: agentOwnedProfile });
    return { started: false, newWindowOpened: false, reused: true, cdp: cdpUrl.toString(), userDataDir, profileDirectory, port, agentOwned: agentOwnedProfile };
  }
  const alreadyOpenWithoutCdp = await chatGptEdgeProfileOpenWithoutCdp(userDataDir, profileDirectory, port);
  if (alreadyOpenWithoutCdp) {
    if (chatGptEdgeProfileIsAgentOwned(userDataDir)) {
      await closeBlockingChatGptEdgeProfile(alreadyOpenWithoutCdp);
    } else {
      throw new Error(`The configured ChatGPT Edge profile is already open without CDP: ${userDataDir}. Save your work and close Microsoft Edge once, then rerun ChatGPT HD so the agent can reopen that same profile with CDP. The agent will not close this non-isolated profile after HD work finishes.`);
    }
  }
  openNewWindow();
  // Same 30s wait as the port-shift path - Edge cold start is variable.
  for (let i = 0; i < 60; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (await canReachChatGptCdp(cdpUrl)) {
      const profilePath = path.relative(ROOT, userDataDir).startsWith("..") ? userDataDir : path.relative(ROOT, userDataDir);
      logEvent("chatgpt_cdp_browser_started", { cdp: cdpUrl.toString(), profilePath, profileDirectory, isolated: agentOwnedProfile });
      return { started: true, newWindowOpened: true, cdp: cdpUrl.toString(), userDataDir, profilePath, profileDirectory, port, agentOwned: agentOwnedProfile };
    }
  }
  throw new Error(`Started Edge for ChatGPT profile "${profileDirectory || "Default"}", but CDP did not answer at ${cdpUrl.toString()} after 30s.`);
}

async function closeChatGptCdpBrowserSession(hdSession = {}, reason = "completed") {
  const cdpBrowser = hdSession.cdpBrowser || {};
  if (!cdpBrowser.cdp) return { ok: true, status: "not_opened" };
  if (hdSession.keepBrowserOpenForLogin || hdSession.chatGptLoginRequired) {
    logEvent("chatgpt_cdp_browser_left_open_for_login", {
      cdp: oneLineField(cdpBrowser.cdp, 160),
      reason: oneLineField(reason, 120),
    });
    return { ok: true, status: "left_open_for_chatgpt_login", cdp: cdpBrowser.cdp, port: cdpBrowser.port || "" };
  }
  if (cdpBrowser.agentOwned === false) {
    logEvent("chatgpt_cdp_browser_close_skipped_not_agent_owned", {
      cdp: oneLineField(cdpBrowser.cdp, 160),
      reason: oneLineField(reason, 120),
    });
    return { ok: true, status: "skipped_not_agent_owned", cdp: cdpBrowser.cdp };
  }
  if (process.platform !== "win32") return { ok: true, status: "not_windows", cdp: cdpBrowser.cdp };
  let port = Number(cdpBrowser.port || 0);
  if (!port) {
    try { port = Number(new URL(cdpBrowser.cdp).port || 80); } catch {}
  }
  if (!port) return { ok: false, status: "port_missing", cdp: cdpBrowser.cdp };
  const userDataDir = cdpBrowser.userDataDir || "";
  if (userDataDir && !chatGptEdgeProfileIsAgentOwned(userDataDir)) {
    logEvent("chatgpt_cdp_browser_close_skipped_external_profile", {
      cdp: oneLineField(cdpBrowser.cdp, 160),
      userDataDir: oneLineField(userDataDir, 240),
      reason: oneLineField(reason, 120),
    });
    return { ok: true, status: "skipped_external_profile", cdp: cdpBrowser.cdp, port };
  }
  const escapedPort = String(port).replace(/'/g, "''");
  const escapedUserData = String(userDataDir || AGENT_CHATGPT_EDGE_USER_DATA_DIR).replace(/'/g, "''");
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `$userData = '${escapedUserData}'; $rows = Get-CimInstance Win32_Process -Filter "name = 'msedge.exe'" | Where-Object { $_.CommandLine -match '--remote-debugging-port=${escapedPort}(\\s|$|")' -and $_.CommandLine -match [regex]::Escape($userData) -and $_.CommandLine -notmatch '--type=' }; $ids = @($rows | Select-Object -ExpandProperty ProcessId); foreach ($id in $ids) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }; [pscustomobject]@{ count = $ids.Count; ids = $ids } | ConvertTo-Json -Depth 3`,
    ], { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
    let parsed = {};
    try { parsed = JSON.parse(stdout || "{}"); } catch {}
    const count = Number(parsed.count || 0);
    logEvent(count ? "chatgpt_cdp_browser_closed" : "chatgpt_cdp_browser_close_not_needed", {
      cdp: oneLineField(cdpBrowser.cdp, 160),
      port,
      count,
      reason: oneLineField(reason, 120),
    });
    return { ok: true, status: count ? "closed" : "not_found", cdp: cdpBrowser.cdp, port, count };
  } catch (err) {
    logEvent("chatgpt_cdp_browser_close_failed", {
      cdp: oneLineField(cdpBrowser.cdp, 160),
      port,
      error: oneLineField(err.message || String(err), 240),
    });
    return { ok: false, status: "close_failed", cdp: cdpBrowser.cdp, port, message: oneLineField(err.message || String(err), 240) };
  }
}

async function inspectChatGptCdpLogin(cdp) {
  const out = {
    cdp,
    url: "",
    title: "",
    loggedIn: false,
    loginPrompt: false,
    status: "unknown",
  };
  let browser = null;
  try {
    browser = await chromium.connectOverCDP(cdp, { timeout: 8000 });
    const context = browser.contexts()[0] || await browser.newContext();
    let page = context.pages().find((candidate) => /chatgpt\.com|chat\.openai\.com/i.test(candidate.url()))
      || context.pages()[0]
      || await context.newPage();
    await page.bringToFront().catch(() => {});
    if (!/chatgpt\.com|chat\.openai\.com/i.test(page.url())) {
      await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
    }
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const bodyText = await page.locator("body").innerText({ timeout: 8000 }).catch(() => "");
    const loginPrompt = /log in to start chatting|log in to get answers|continue with google|continue with apple|sign up for free/i.test(bodyText);
    const loggedInSignals = /chat history|new chat|search chats|projects|settings/i.test(bodyText);
    out.url = page.url();
    out.title = await page.title().catch(() => "");
    out.loginPrompt = loginPrompt;
    out.loggedIn = !loginPrompt && loggedInSignals;
    out.status = out.loggedIn ? "logged_in" : loginPrompt ? "login_required" : "unknown";
  } catch (err) {
    out.status = "check_failed";
    out.error = oneLineField(err.message || String(err), 300);
  } finally {
    try { if (browser) browser.disconnect(); } catch {}
  }
  return out;
}

async function openDedicatedChatGptBrowserForSetup() {
  const state = readState();
  state.productAssets.chatgptHdEnabled = state.productAssets.chatgptHdEnabled !== false;
  state.productAssets.chatgptEdgeCdp = state.productAssets.chatgptEdgeCdp || "http://127.0.0.1:9334";
  state.productAssets.chatgptEdgeUserDataDir = AGENT_CHATGPT_EDGE_USER_DATA_DIR;
  state.productAssets.chatgptEdgeProfileDirectory = "Default";

  let cdpUrl = chatGptCdpUrl(state.productAssets);
  let port = Number(cdpUrl.port || 80);
  const userDataDir = AGENT_CHATGPT_EDGE_USER_DATA_DIR;
  const profileDirectory = "Default";
  fs.mkdirSync(userDataDir, { recursive: true });

  if (await canReachChatGptCdp(cdpUrl)) {
    if (!(await chatGptCdpProcessOwnedByUserData(userDataDir, port))) {
      const originalPort = port;
      let shifted = false;
      for (let candidatePort = originalPort + 1; candidatePort <= originalPort + 20; candidatePort += 1) {
        const candidateUrl = new URL(cdpUrl.toString());
        candidateUrl.port = String(candidatePort);
        if (!(await canReachChatGptCdp(candidateUrl))) {
          cdpUrl = candidateUrl;
          port = candidatePort;
          shifted = true;
          state.productAssets.chatgptEdgeCdp = cdpUrl.toString();
          logEvent("chatgpt_setup_cdp_port_shifted", { fromPort: originalPort, toPort: port });
          break;
        }
      }
      if (!shifted) {
        throw new Error(`ChatGPT CDP port ${originalPort} is already used by another browser profile. Close that debug browser or change the ChatGPT CDP endpoint to a free localhost port.`);
      }
    }
  }

  const blockingProfile = await chatGptEdgeProfileOpenWithoutCdp(userDataDir, profileDirectory, port);
  if (blockingProfile) await closeBlockingChatGptEdgeProfile(blockingProfile);

  let started = false;
  if (!(await canReachChatGptCdp(cdpUrl))) {
    const child = spawn(localBrowserExecutablePath(), [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      `--profile-directory=${profileDirectory}`,
      "--no-first-run",
      "--disable-popup-blocking",
      "--new-window",
      "--window-size=1280,980",
      "https://chatgpt.com/",
    ], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
    started = true;
    for (let i = 0; i < 24; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (await canReachChatGptCdp(cdpUrl)) break;
    }
  }

  if (!(await canReachChatGptCdp(cdpUrl))) {
    throw new Error(`Opened dedicated ChatGPT Edge profile, but CDP did not answer at ${cdpUrl.toString()}.`);
  }

  state.productAssets.chatgptEdgeCdp = cdpUrl.toString();
  state.productAssets.chatgptEdgeUserDataDir = userDataDir;
  state.productAssets.chatgptEdgeProfileDirectory = profileDirectory;
  const nextState = writeState(state);
  const login = await inspectChatGptCdpLogin(cdpUrl.toString());
  logEvent("chatgpt_setup_browser_opened", {
    cdp: cdpUrl.toString(),
    started,
    loginStatus: login.status,
    userDataDir,
  });
  return {
    ok: true,
    started,
    cdp: cdpUrl.toString(),
    userDataDir,
    profileDirectory,
    login,
    state: nextState,
  };
}

async function runChatGptHdUpgrade(inputPath, outputPngPath, assetState, hdSession = {}) {
  const scriptPath = safeProjectPath("tools/chatgpt-hd-upgrade.js");
  if (!fs.existsSync(scriptPath)) throw new Error("ChatGPT HD script missing: tools/chatgpt-hd-upgrade.js");
  const cdpBrowser = hdSession.cdpBrowser || await ensureChatGptCdpBrowser(assetState);
  hdSession.cdpBrowser = cdpBrowser;
  const rotationLimit = clampNumber(assetState.chatgptHdConversationLimit, 1, 100, 9);
  const hdState = readChatGptHdState();
  // CONVERSATION REUSE (avoids wasting time opening a new chat per image): keep generating in the
  // SAME ChatGPT conversation until it has produced `rotationLimit` images, THEN rotate to a fresh
  // conversation. priorConversationCount = images already produced in the current conversation.
  const priorConversationCount = clampNumber(hdState.currentConversationCount, 0, 100000, 0);
  const shouldStartNewChat = priorConversationCount <= 0 || priorConversationCount >= rotationLimit;
  const nodeCommand = [
    `node ${psQuote(toWindowsExplorerPath(scriptPath))}`,
    `--input ${psQuote(toWindowsExplorerPath(inputPath))}`,
    `--output ${psQuote(toWindowsExplorerPath(outputPngPath))}`,
    `--cdp ${psQuote(cdpBrowser.cdp)}`,
    `--new-chat ${shouldStartNewChat ? "true" : "false"}`,
    "--retries 3",
    "--attempt-timeout-ms 180000",
    "--new-window true",
  ].join(" ");
  const command = [
    `Set-Location -LiteralPath ${psQuote(toWindowsExplorerPath(ROOT))}`,
    nodeCommand,
  ].join("; ");
  let stdout = "";
  let stderr = "";
  try {
    ({ stdout, stderr } = await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
      cwd: ROOT,
      windowsHide: true,
      timeout: 360000,
      maxBuffer: 1024 * 1024,
    }));
  } catch (err) {
    stdout = err.stdout || "";
    stderr = err.stderr || "";
    const outputLines = `${stderr || ""}\n${stdout || ""}`
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    let parsedFailure = null;
    let failureText = "";
    for (const line of [...outputLines].reverse()) {
      try {
        const parsed = JSON.parse(line);
        if (parsed?.error || parsed?.ok === false || parsed?.step === "error") {
          parsedFailure = parsed;
          failureText = line;
          break;
        }
      } catch {}
    }
    if (!failureText) failureText = outputLines.find((line) => /error|failed|timeout|timed out/i.test(line)) || outputLines.at(-1) || String(err.message || err);
    const message = parsedFailure?.error || parsedFailure?.message || `ChatGPT HD command failed: ${failureText.slice(0, 700)}`;
    if (isChatGptLoginRequiredError(message)) {
      hdSession.chatGptLoginRequired = true;
      hdSession.keepBrowserOpenForLogin = true;
    }
    throw new Error(message);
  }
  const text = String(stdout || stderr || "").trim().split(/\r?\n/).filter(Boolean).pop() || "{}";
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error(`ChatGPT HD returned non-JSON output: ${text.slice(0, 500)}`); }
  if (!parsed.ok) {
    const message = parsed.error || "ChatGPT HD upgrade failed";
    if (isChatGptLoginRequiredError(message)) {
      hdSession.chatGptLoginRequired = true;
      hdSession.keepBrowserOpenForLogin = true;
    }
    throw new Error(message);
  }
  const now = new Date().toISOString();
  // If we rotated to a NEW conversation this call it now holds 1 image; otherwise the CURRENT
  // conversation's image count goes up by 1. This count gates the next rotation (>= rotationLimit).
  const nextConversationCount = shouldStartNewChat ? 1 : priorConversationCount + 1;
  writeChatGptHdState({
    currentConversationCount: nextConversationCount,
    totalProcessed: hdState.totalProcessed + 1,
    lastRotatedAt: shouldStartNewChat ? now : (hdState.lastRotatedAt || now),
    updatedAt: now,
  });
  return { ...parsed, newConversationStarted: shouldStartNewChat, conversationImageCount: nextConversationCount, rotationLimit, cdpBrowser };
}

async function maybeUpgradeReviewImageWithChatGpt(inputImagePath, outputImagePath, state, hdSession = {}) {
  const assetState = state.productAssets || {};
  if (assetState.chatgptHdEnabled === false) return null;
  const outputExt = path.extname(outputImagePath).toLowerCase();
  const outputPngPath = outputExt === ".png"
    ? outputImagePath
    : outputImagePath.replace(/\.(?:webp|jpe?g|png)$/i, ".png");
  const result = await runChatGptHdUpgrade(inputImagePath, outputPngPath, assetState, hdSession);
  if (outputPngPath !== outputImagePath) {
    await convertImageToJpeg(outputPngPath, outputImagePath);
    try { fs.unlinkSync(outputPngPath); } catch {}
  }
  return result;
}

async function materializeReviewImage(product, candidate, state, options = {}) {
  const relativeDir = productAssetRelativeDir(product, state);
  const absoluteDir = safeProjectPath(relativeDir);
  fs.mkdirSync(absoluteDir, { recursive: true });
  const sourceUrl = highQualityReviewImageUrl(candidate.imageUrl);
  const tempPath = path.join(absoluteDir, "review-image-source");
  const titleForFile = candidate.productTitle || product.title || product.productId || product.key || "product-review-image";
  const productIdForFile = product.productId || product.key || "product";
  const candidateIndex = clampNumber(options.index, 0, 100, 0);
  const fileName = seoFileName(titleForFile, productIdForFile, candidateIndex);
  const outputRelative = path.join(relativeDir, fileName).replace(/\\/g, "/");
  const outputPath = safeProjectPath(outputRelative);
  const hdFileName = fileName.replace(/\.(?:webp|jpe?g|png)$/i, "-chatgpt-hd.png");
  const hdOutputRelative = path.join(relativeDir, hdFileName).replace(/\\/g, "/");
  const hdOutputPath = safeProjectPath(hdOutputRelative);
  const image = await downloadImageBuffer(sourceUrl);
  let dimensions = { width: 0, height: 0 };
  try {
    fs.writeFileSync(tempPath, image);
    dimensions = await convertImageToJpeg(tempPath, outputPath);
  } finally {
    try { fs.unlinkSync(tempPath); } catch {}
  }
  const visualSignals = await analyzeReviewImageVisualSignals(outputPath).catch((err) => ({
    ok: false,
    error: oneLineField(err.message || String(err), 180),
    rejectForPosting: false,
  }));
  let finalRelative = outputRelative;
  let finalPath = outputPath;
  let finalFileName = fileName;
  let hdResult = null;
  if (!options.skipHd) {
    try {
      hdResult = await maybeUpgradeReviewImageWithChatGpt(outputPath, hdOutputPath, state, options.hdSession || {});
      if (fs.existsSync(hdOutputPath)) {
        finalRelative = hdOutputRelative;
        finalPath = hdOutputPath;
        finalFileName = hdFileName;
      }
    } catch (err) {
      hdResult = { ok: false, error: String(err.message || err).slice(0, 700) };
      logEvent("chatgpt_hd_upgrade_failed", { productKey: product.key, error: hdResult.error });
      if (isChatGptImageGuardrailFailure(hdResult.error)) {
        blacklistProductForPosting(product, "chatgpt_hd_guardrail", hdResult.error, state);
        logEvent("chatgpt_hd_guardrail_product_blacklisted", { productKey: product.key, productUrl: product.url });
        return {
          sourceUrl,
          localPath: "",
          originalLocalPath: outputRelative,
          absolutePath: "",
          fileName: "",
          bytes: 0,
          width: dimensions.width || 0,
          height: dimensions.height || 0,
          visualSignals,
          candidateIndex,
          chatgptHd: { ...hdResult, blacklistedProduct: true, reason: "chatgpt_hd_guardrail" },
          error: "chatgpt_hd_guardrail_product_blacklisted",
          message: "ChatGPT HD guardrail/similarity blocked this image; product was blacklisted and skipped.",
          blacklisted: true,
        };
      }
    }
  }
  const stat = fs.statSync(finalPath);
  return {
    sourceUrl,
    localPath: finalRelative,
    originalLocalPath: outputRelative,
    absolutePath: finalPath,
    fileName: finalFileName,
    bytes: stat.size,
    width: dimensions.width || 0,
    height: dimensions.height || 0,
    visualSignals,
    candidateIndex,
    chatgptHd: hdResult,
  };
}

async function compressHdPngToJpeg(hdRelative) {
  // ChatGPT HD output is a ~2.5MB PNG → FB upload takes ~28s. Resize to max
  // 1200px + JPG q85 via WSL PIL → ~300-500KB → upload ~10s. Big speed win.
  const jpgRelative = String(hdRelative).replace(/\.png$/i, ".jpg");
  const wslPng = `${WSL_PROJECT}/${String(hdRelative).replace(/\\/g, "/")}`;
  const wslJpg = `${WSL_PROJECT}/${String(jpgRelative).replace(/\\/g, "/")}`;
  const py = `from PIL import Image; im=Image.open(${JSON.stringify(wslPng)}).convert("RGB"); im.thumbnail((1200,1200)); im.save(${JSON.stringify(wslJpg)},"JPEG",quality=85,optimize=True); print("ok")`;
  await execFileAsync("wsl.exe", ["-e", "python3", "-c", py], { timeout: 30000, windowsHide: true, maxBuffer: 1024 * 256 });
  return jpgRelative;
}

async function upgradeMaterializedReviewImage(product, materialized, state, options = {}) {
  const baseRelative = materialized.originalLocalPath || materialized.localPath;
  const basePath = safeProjectPath(baseRelative);
  const hdRelative = String(baseRelative).replace(/\.(?:webp|jpe?g|png)$/i, "-chatgpt-hd.png");
  const hdPath = safeProjectPath(hdRelative);
  let hdResult = null;
  let finalRelative = baseRelative;
  let finalPath = basePath;
  try {
    if (typeof options.onAssetProgress === "function") {
      options.onAssetProgress({
        stage: "hd_running",
        product,
        localPath: baseRelative,
      });
    }
    hdResult = await maybeUpgradeReviewImageWithChatGpt(basePath, hdPath, state, options.hdSession || {});
    if (fs.existsSync(hdPath)) {
      finalRelative = hdRelative;
      finalPath = hdPath;
      // Compress the big HD PNG to an optimized JPG so the FB upload is ~3x
      // faster. Fall back to the PNG if compression fails (no regression).
      try {
        const jpgRelative = await compressHdPngToJpeg(hdRelative);
        const jpgPath = safeProjectPath(jpgRelative);
        if (fs.existsSync(jpgPath) && fs.statSync(jpgPath).size > 1000) {
          const pngKB = Math.round(fs.statSync(hdPath).size / 1024);
          const jpgKB = Math.round(fs.statSync(jpgPath).size / 1024);
          finalRelative = jpgRelative;
          finalPath = jpgPath;
          try { fs.unlinkSync(hdPath); } catch {}
          logEvent("chatgpt_hd_compressed_to_jpeg", { from: hdRelative, to: jpgRelative, pngKB, jpgKB });
        }
      } catch (compErr) {
        logEvent("chatgpt_hd_compress_failed_using_png", { error: oneLineField(compErr.message || String(compErr), 200) });
      }
    }
    if (typeof options.onAssetProgress === "function") {
      options.onAssetProgress({
        stage: "hd_done",
        product,
        localPath: finalRelative,
        ok: Boolean(hdResult?.ok),
      });
    }
  } catch (err) {
    hdResult = { ok: false, error: String(err.message || err).slice(0, 700) };
    if (typeof options.onAssetProgress === "function") {
      options.onAssetProgress({
        stage: "hd_failed",
        product,
        localPath: baseRelative,
        error: hdResult.error,
      });
    }
    logEvent("chatgpt_hd_upgrade_failed", { productKey: product.key, error: hdResult.error });
    if (isChatGptImageGuardrailFailure(hdResult.error)) {
      blacklistProductForPosting(product, "chatgpt_hd_guardrail", hdResult.error, state);
      logEvent("chatgpt_hd_guardrail_product_blacklisted", { productKey: product.key, productUrl: product.url });
      return {
        ...materialized,
        localPath: "",
        originalLocalPath: baseRelative,
        absolutePath: "",
        fileName: "",
        bytes: 0,
        chatgptHd: { ...hdResult, blacklistedProduct: true, reason: "chatgpt_hd_guardrail" },
        error: "chatgpt_hd_guardrail_product_blacklisted",
        message: "ChatGPT HD guardrail/similarity blocked this image; product was blacklisted and skipped.",
        blacklisted: true,
      };
    }
  }
  const stat = fs.statSync(finalPath);
  return {
    ...materialized,
    localPath: finalRelative,
    originalLocalPath: baseRelative,
    absolutePath: finalPath,
    fileName: path.basename(finalRelative),
    bytes: stat.size,
    chatgptHd: hdResult,
  };
}

function looksLikeProductPageUrlForProduct(value, product) {
  try {
    const url = new URL(String(value || "").trim());
    const host = url.hostname.toLowerCase();
    const productId = String(product?.productId || "").trim();
    if (product?.url && normalizeUrlForComparison(url.toString()) === normalizeUrlForComparison(product.url)) return true;
    if (productId && host.includes("walmart.") && url.pathname.toLowerCase().includes(`/ip/${productId.toLowerCase()}`)) return true;
    return false;
  } catch {
    return false;
  }
}

function reviewImageUrlFromParts(parts, product) {
  const urls = parts
    .map((part) => String(part || "").trim())
    .filter((part) => /^https?:\/\//i.test(part));
  const imageUrl = urls.find((url) => !looksLikeProductPageUrlForProduct(url, product) && /\.(jpe?g|png|webp|gif)(\?|#|$)/i.test(url));
  return imageUrl || urls.find((url) => !looksLikeProductPageUrlForProduct(url, product)) || "";
}

function reviewRatingFromParts(parts) {
  for (const part of parts) {
    const text = String(part || "").trim();
    const keyed = text.match(/^rating=([1-5](?:\.\d+)?)/i);
    if (keyed) return keyed[1];
    if (/^[1-5](?:\.\d+)?$/.test(text)) return text;
  }
  return "";
}

function existingReviewImageCandidatesForProduct(product, state, limit = REVIEW_IMAGE_CANDIDATE_COUNT) {
  const productNeedles = [
    product?.key,
    product?.productId,
    product?.url,
  ].map((value) => String(value || "").trim().toLowerCase()).filter(Boolean);
  const texts = [
    state.productAssets?.reviewImageCandidates,
    state.productAssets?.selectedReviewImages,
  ];
  const candidates = [];
  for (const text of texts) {
    for (const line of recordLines(text)) {
      const lower = line.toLowerCase();
      if (productNeedles.length && !productNeedles.some((needle) => lower.includes(needle))) continue;
      const parts = line.split("|").map((part) => part.trim());
      const imageUrl = reviewImageUrlFromParts(parts, product);
      if (!imageUrl) continue;
      const candidate = {
        imageUrl,
        productTitle: parts[2] && !/^https?:\/\//i.test(parts[2]) ? parts[2] : product.title,
        rating: reviewRatingFromParts(parts),
        sentiment: lower.includes("negative") ? "unknown" : "positive_or_neutral",
        reviewText: oneLineField(line, 300),
        source: "existing_review_candidate",
        priority: lower.includes("preferred") || lower.includes("approved") ? "preferred" : "accepted",
      };
      candidates.push(candidate);
    }
  }
  return uniqueReviewImageCandidates(candidates, limit);
}

function existingReviewImageCandidateForProduct(product, state) {
  return existingReviewImageCandidatesForProduct(product, state, 1)[0] || null;
}

function existingApprovedReviewImageForProduct(product, state, priorAttempts = []) {
  const image = reviewImageForProduct(selectedReviewImageLines(state), product);
  if (!image?.approved || !image.imagePath) return null;
  let absolutePath = "";
  try {
    absolutePath = safeProjectPath(image.imagePath);
  } catch {
    return null;
  }
  if (!fs.existsSync(absolutePath)) return null;
  const stat = fs.statSync(absolutePath);
  const localPath = path.relative(ROOT, absolutePath).replace(/\\/g, "/");
  return {
    product,
    provider: "existing_approved_review_image",
    candidate: {
      imageUrl: image.imageUrl || image.raw,
      productTitle: product.title || product.productId || product.url,
      rating: "",
      sentiment: "positive_or_neutral",
      source: "selectedReviewImages",
      priority: "approved_reuse",
    },
    sourceUrl: image.imageUrl || image.raw || product.url,
    localPath,
    originalLocalPath: localPath,
    absolutePath,
    fileName: path.basename(localPath),
    bytes: stat.size,
    width: 0,
    height: 0,
    chatgptHd: { ok: true, reused: true, source: "existing_approved_review_image" },
    attempts: [
      ...(priorAttempts || []),
      { provider: "existing_approved_review_image", reused: true, localPath },
    ],
    selection: {
      selector: "existing_approved_review_image",
      choice: 1,
      reason: "Reused an existing approved review image because fresh product-page candidates were not decodable.",
      confidence: 1,
      contactSheet: "",
    },
    candidateCount: 1,
    candidateOptions: [{
      number: 1,
      sourceUrl: image.imageUrl || image.raw || product.url,
      localPath,
      rating: "",
      provider: "existing_approved_review_image",
      width: 0,
      height: 0,
      qualityScore: 0,
    }],
  };
}

function approvedMappedProductFallbacks(state, excludedKeys = new Set(), limit = 10) {
  const reviewImages = selectedReviewImageLines(state);
  const blacklistedKeys = blacklistedProductKeys(state);
  const products = [];
  const seen = new Set();
  for (const mapping of affiliateLinkMappings(state)) {
    const product = canonicalProduct(mapping.productUrl, state);
    const key = String(product?.key || "").toLowerCase();
    if (!product || !key || seen.has(key) || excludedKeys.has(key) || blacklistedKeys.has(key)) continue;
    const image = reviewImageForProduct(reviewImages, product);
    if (!image?.approved || !image.imagePath) continue;
    try {
      if (!fs.existsSync(safeProjectPath(image.imagePath))) continue;
    } catch {
      continue;
    }
    seen.add(key);
    products.push(product);
    if (products.length >= limit) break;
  }
  return products;
}

function wslPathFromWindows(filePath) {
  const absolute = path.resolve(filePath);
  const driveMatch = absolute.match(/^([A-Za-z]):\\(.*)$/);
  if (!driveMatch) return absolute.replace(/\\/g, "/");
  const drive = driveMatch[1].toLowerCase();
  const rest = driveMatch[2].replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/").replace(/%3A/gi, ":");
  return `/mnt/${drive}/${rest}`;
}

async function analyzeReviewImageVisualSignals(filePath) {
  const absolutePath = safeProjectPath(filePath);
  const buffer = fs.readFileSync(absolutePath);
  const ext = path.extname(absolutePath).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/webp";
  const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
  const browser = await chromium.launch({
    executablePath: localBrowserExecutablePath(),
    headless: true,
    args: ["--disable-popup-blocking"],
  });
  try {
    const page = await browser.newPage();
    return await page.evaluate(async (src) => {
      const img = await new Promise((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error("image decode failed"));
        element.src = src;
      });
      const maxSide = 180;
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
      const width = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
      const height = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, width, height);
      const data = ctx.getImageData(0, 0, width, height).data;
      const lumas = new Float32Array(width * height);
      let white = 0;
      let dark = 0;
      let gray = 0;
      let colored = 0;
      let lowSaturation = 0;
      let totalSat = 0;
      let opaque = 0;
      for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
        const alpha = data[i + 3] / 255;
        if (alpha < 0.2) continue;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const luma = (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
        const sat = max ? (max - min) / max : 0;
        lumas[p] = luma;
        opaque += 1;
        totalSat += sat;
        if (luma > 235) white += 1;
        if (luma < 45) dark += 1;
        if (max - min < 24) gray += 1;
        if (sat > 0.18 && max - min > 34) colored += 1;
        if (sat < 0.11) lowSaturation += 1;
      }
      let edge = 0;
      let edgeSamples = 0;
      for (let y = 1; y < height; y += 1) {
        for (let x = 1; x < width; x += 1) {
          const p = y * width + x;
          const dx = Math.abs(lumas[p] - lumas[p - 1]);
          const dy = Math.abs(lumas[p] - lumas[p - width]);
          if (Math.max(dx, dy) > 42) edge += 1;
          edgeSamples += 1;
        }
      }
      const count = Math.max(1, opaque);
      const ratios = {
        whiteRatio: white / count,
        darkRatio: dark / count,
        grayRatio: gray / count,
        colorPixelRatio: colored / count,
        lowSaturationRatio: lowSaturation / count,
        edgeRatio: edge / Math.max(1, edgeSamples),
        averageSaturation: totalSat / count,
      };
      const lineArtOrInstructionRisk = ratios.grayRatio > 0.68
        && ratios.colorPixelRatio < 0.14
        && ratios.averageSaturation < 0.14
        && ratios.edgeRatio > 0.055;
      const mostlyBlankPackageRisk = ratios.whiteRatio > 0.48
        && ratios.colorPixelRatio < 0.16
        && ratios.lowSaturationRatio > 0.72;
      const productVisibleLikely = ratios.colorPixelRatio > 0.18
        && ratios.averageSaturation > 0.13
        && !lineArtOrInstructionRisk;
      const rejectForPosting = lineArtOrInstructionRisk || mostlyBlankPackageRisk;
      const round = (value) => Math.round(value * 1000) / 1000;
      return {
        ok: true,
        width: img.naturalWidth || width,
        height: img.naturalHeight || height,
        whiteRatio: round(ratios.whiteRatio),
        grayRatio: round(ratios.grayRatio),
        colorPixelRatio: round(ratios.colorPixelRatio),
        averageSaturation: round(ratios.averageSaturation),
        edgeRatio: round(ratios.edgeRatio),
        lineArtOrInstructionRisk,
        mostlyBlankPackageRisk,
        productVisibleLikely,
        rejectForPosting,
      };
    }, dataUrl);
  } finally {
    await browser.close().catch(() => {});
  }
}

function reviewCandidateDescriptor(item) {
  return [
    item.candidate?.reviewText,
    item.candidate?.visualHint,
    item.candidate?.productTitle,
    item.candidate?.imageUrl,
    item.candidate?.source,
  ].filter(Boolean).join(" ");
}

function reviewCandidateQualityScore(item) {
  const rating = Number(item.candidate?.rating || 0);
  const width = Number(item.width || 0);
  const height = Number(item.height || 0);
  const area = width * height;
  const aspect = width && height ? Math.max(width / height, height / width) : 9;
  const descriptor = reviewCandidateDescriptor(item);
  const visual = item.visualSignals || {};
  let score = rating * 100;
  if (String(item.candidate?.priority || "").toLowerCase() === "preferred") score += 35;
  if (/review_json|review_dom|customer_photos/i.test(item.candidate?.source || item.provider || "")) score += 20;
  if (area >= 900000) score += 25;
  else if (area >= 360000) score += 12;
  if (aspect <= 1.45) score += 18;
  else if (aspect <= 2.1) score += 8;
  else score -= 20;
  if (/stock|main|hero|catalog/i.test(item.candidate?.source || "")) score -= 15;
  if (/\b(assembled|installed|in use|using|worn|wearing|opened|out of (?:the )?box|set up|on my|fits|works|plugged in|mounted)\b/i.test(descriptor)) score += 28;
  if (/\b(packaging|package|box|boxed|label|sealed|unopened|shipping|carton|wrapper|barcode|manual|instruction|instructions|diagram)\b/i.test(descriptor)) score -= 75;
  if (visual.productVisibleLikely) score += 55;
  if (visual.lineArtOrInstructionRisk) score -= 180;
  if (visual.mostlyBlankPackageRisk) score -= 140;
  if (visual.rejectForPosting) score -= 220;
  if (Number(visual.colorPixelRatio || 0) >= 0.22) score += 20;
  return score;
}

function validateSelectedReviewImageForPosting(selectedBase, selection = {}, candidateCount = 0) {
  const visual = selectedBase?.visualSignals || {};
  const reasonText = String(selection.reason || "");
  const descriptor = reviewCandidateDescriptor(selectedBase || {});
  const rejectionReasons = [];
  if (selection.reject === true || selection.accepted === false) {
    rejectionReasons.push(reasonText || "Hermes rejected the selected image.");
  }
  if (/packaging-only|package only|box only|manual|instruction|diagram|not visible|no actual product|product is not visible/i.test(reasonText)) {
    rejectionReasons.push(`Selector reason: ${reasonText}`);
  }
  if (visual.lineArtOrInstructionRisk) {
    rejectionReasons.push("local visual gate detected a manual/instruction/diagram-style image, not a real product photo");
  }
  if (visual.mostlyBlankPackageRisk) {
    rejectionReasons.push("local visual gate detected a mostly blank/packaging-style image");
  }
  if (/\b(manual|instruction|instructions|diagram|barcode|shipping carton|label only)\b/i.test(descriptor)) {
    rejectionReasons.push("candidate metadata looks like manual/packaging media");
  }
  if (!rejectionReasons.length) return { ok: true, reason: "" };
  return {
    ok: false,
    reason: oneLineField(rejectionReasons.join("; "), 500),
    candidateCount,
  };
}

function parseJsonObjectFromText(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try { return JSON.parse(raw.slice(first, last + 1)); } catch {}
  }
  return null;
}

async function createReviewCandidateContactSheet(product, candidates, state) {
  const relativeDir = productAssetRelativeDir(product, state);
  const sheetRelative = path.join(relativeDir, "review-candidates-contact-sheet.png").replace(/\\/g, "/");
  const sheetPath = safeProjectPath(sheetRelative);
  fs.mkdirSync(path.dirname(sheetPath), { recursive: true });
  const items = candidates.map((candidate, index) => {
    const absolutePath = safeProjectPath(candidate.originalLocalPath || candidate.localPath);
    const buffer = fs.readFileSync(absolutePath);
    return {
      label: `#${index + 1}`,
      rating: String(candidate.candidate?.rating || ""),
      source: String(candidate.candidate?.source || candidate.provider || ""),
      reviewText: String(candidate.candidate?.reviewText || candidate.candidate?.visualHint || ""),
      dataUrl: `data:${imageMimeFromBuffer(buffer)};base64,${buffer.toString("base64")}`,
    };
  });
  const browser = await chromium.launch({
    executablePath: localBrowserExecutablePath(),
    headless: true,
    args: ["--disable-popup-blocking"],
  });
  try {
    const page = await browser.newPage();
    const pngDataUrl = await page.evaluate(async ({ items, title }) => {
      const loadImage = (src) => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("contact sheet image decode failed"));
        img.src = src;
      });
      const images = [];
      for (const item of items) images.push({ item, img: await loadImage(item.dataUrl) });
      const cellW = 260;
      const cellH = 320;
      const pad = 24;
      const headerH = 70;
      const cols = Math.min(5, Math.max(1, images.length));
      const rows = Math.ceil(images.length / cols);
      const canvas = document.createElement("canvas");
      canvas.width = (cols * cellW) + (pad * 2);
      canvas.height = headerH + (rows * cellH) + pad;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#f8fafc";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#111827";
      ctx.font = "700 20px Arial";
      ctx.fillText(String(title || "Review image candidates").slice(0, 90), pad, 34);
      ctx.font = "400 13px Arial";
      ctx.fillStyle = "#4b5563";
      ctx.fillText("Pick the best real customer review image for Facebook posting.", pad, 56);
      for (const [index, { item, img }] of images.entries()) {
        const col = index % cols;
        const row = Math.floor(index / cols);
        const x = pad + (col * cellW);
        const y = headerH + (row * cellH);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(x, y, cellW - 12, cellH - 12);
        ctx.strokeStyle = "#cbd5e1";
        ctx.strokeRect(x, y, cellW - 12, cellH - 12);
        ctx.fillStyle = "#111827";
        ctx.font = "700 22px Arial";
        ctx.fillText(item.label, x + 12, y + 30);
        ctx.font = "400 12px Arial";
        ctx.fillStyle = "#475569";
        ctx.fillText(`rating ${item.rating || "?"} | ${String(item.source || "").slice(0, 24)}`, x + 58, y + 28);
        if (item.reviewText) {
          ctx.font = "400 11px Arial";
          ctx.fillStyle = "#64748b";
          ctx.fillText(String(item.reviewText).replace(/\s+/g, " ").slice(0, 42), x + 12, y + 44);
        }
        const boxX = x + 12;
        const boxY = y + (item.reviewText ? 60 : 46);
        const boxW = cellW - 36;
        const boxH = cellH - (item.reviewText ? 90 : 76);
        const scale = Math.min(boxW / img.naturalWidth, boxH / img.naturalHeight);
        const drawW = img.naturalWidth * scale;
        const drawH = img.naturalHeight * scale;
        const drawX = boxX + ((boxW - drawW) / 2);
        const drawY = boxY + ((boxH - drawH) / 2);
        ctx.drawImage(img, drawX, drawY, drawW, drawH);
      }
      return canvas.toDataURL("image/png");
    }, { items, title: product.title || product.productId || product.url });
    const match = String(pngDataUrl || "").match(/^data:image\/png;base64,(.+)$/);
    if (!match) throw new Error("Contact sheet render did not return PNG.");
    fs.writeFileSync(sheetPath, Buffer.from(match[1], "base64"));
    return { path: sheetRelative, absolutePath: sheetPath };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function selectBestReviewImageWithHermes(product, candidates, state, options = {}) {
  const fallbackSorted = [...candidates].sort((a, b) => reviewCandidateQualityScore(b) - reviewCandidateQualityScore(a));
  const fallback = fallbackSorted[0];
  if (state.productAssets?.useHermesImageReview === false) {
    return {
      selector: "local_quality_fallback",
      choice: candidates.indexOf(fallback) + 1,
      accepted: !fallback?.visualSignals?.rejectForPosting,
      reject: Boolean(fallback?.visualSignals?.rejectForPosting),
      reason: fallback?.visualSignals?.rejectForPosting
        ? "Hermes image review is disabled; local visual gate rejected this packaging/manual-style image."
        : "Hermes image review is disabled.",
      confidence: 0.5,
      contactSheet: "",
    };
  }
  let sheet = null;
  try {
    sheet = await createReviewCandidateContactSheet(product, candidates, state);
    const candidateSummary = candidates.map((candidate, index) => ({
      number: index + 1,
      rating: candidate.candidate?.rating || "",
      source: candidate.candidate?.source || candidate.provider || "",
      priority: candidate.candidate?.priority || "",
      reviewText: oneLineField(candidate.candidate?.reviewText || candidate.candidate?.visualHint || "", 280),
      width: candidate.width || 0,
      height: candidate.height || 0,
      visualSignals: candidate.visualSignals || null,
      productUrl: product.url,
      imagePathWindows: toWindowsExplorerPath(safeProjectPath(candidate.originalLocalPath || candidate.localPath)),
      imagePathWsl: wslPathFromWindows(safeProjectPath(candidate.originalLocalPath || candidate.localPath)),
      sourceUrl: candidate.sourceUrl,
      localQualityScore: reviewCandidateQualityScore(candidate),
    }));
    const prompt = [
      "You are Hermes default LLM acting as a visual product-review image selector.",
      "Inspect the contact sheet image and the individual local image files if your tools/model can view images.",
      "Choose exactly one candidate for the Facebook product post.",
      "",
      "Visual selection rules:",
      "- Prefer a real customer review photo over stock/catalog-looking images.",
      "- Highest priority: the actual product is clearly visible, assembled/opened, being used, worn, installed, or shown outside the box.",
      "- Among candidates that clearly show the product, prefer the one that shows the MAXIMUM of the product: the whole/complete item fully in frame, the largest and most fully-visible view (and its main parts/set if any), rather than a partial crop, a single small detail, a far-away shot, or a close-up of just one corner.",
      "- Down-rank packaging-only photos: retail box, label, wrapper, shipping carton, barcode, or sealed/unopened package without the real product visible.",
      "- Reject instruction/manual/diagram photos even if they show line drawings of the product.",
      "- Select a packaging-only image only if every usable candidate is packaging-only; in that case set accepted=false and reject=true so the workflow can skip this product.",
      "- If there is only one candidate and it is packaging-only, manual/instruction/diagram-like, or the actual product is not clearly visible, set accepted=false and reject=true.",
      "- Product must be clearly visible, upright, natural, and not badly cropped.",
      "- Reject blurry, dark, duplicate-looking, watermark/text-heavy, wrong-product, or mostly-logo images.",
      "- Prefer 5-star/positive review context when visual quality is close.",
      "",
      `Product: ${product.title || product.productId || product.url}`,
      `Contact sheet Windows path: ${toWindowsExplorerPath(sheet.absolutePath)}`,
      `Contact sheet WSL path: ${wslPathFromWindows(sheet.absolutePath)}`,
      "",
      "Candidates:",
      JSON.stringify(candidateSummary, null, 2),
      "",
      "Return strict JSON only with this shape:",
      "{\"choice\":1,\"accepted\":true,\"reject\":false,\"reason\":\"short visual reason\",\"confidence\":0.0}",
    ].join("\n");
    const selectorTimeoutMs = options.testPost || options.test_post
      ? TEST_HERMES_IMAGE_SELECTOR_TIMEOUT_MS
      : HERMES_IMAGE_SELECTOR_TIMEOUT_MS;
    let parsed = null;
    let choice = 0;
    let selectorLabel = "openai_fast_direct";
    let attemptError = null;
    // The persistent HTTP image-selector service (WSL, port 9318) is the ONLY model path. Per-call
    // `wsl.exe … python3 fast-image-selector.py` and the hermes CLI both HANG ~75s+ on this box
    // (proven), so they are removed from the hot path. On a miss we (re)start the service, AWAIT it,
    // and retry the HTTP call; if it still can't decide, we drop to the local quality gate (outer catch).
    for (let attempt = 1; attempt <= 3 && !choice; attempt += 1) {
      const attemptPrompt = attempt === 1
        ? prompt
        : `IMPORTANT: Return ONLY this exact JSON shape, nothing else:\n{"choice":N,"accepted":true,"reject":false,"reason":"short visual reason","confidence":0.6}\nN is an integer from 1 to ${candidates.length} for the most natural-looking customer-photo image.\n\n${prompt}`;
      let stdout = "";
      try {
        stdout = await callImageSelectorService(attemptPrompt, Math.min(selectorTimeoutMs, 90000));
      } catch (svcErr) {
        attemptError = svcErr;
        logEvent("image_selector_service_retry", { productKey: product.key, attempt, error: oneLineField(svcErr.message || String(svcErr), 240) });
        try { await ensureImageSelectorServiceRunning(); } catch {} // (re)start + AWAIT, then retry the HTTP service
        continue;
      }
      parsed = parseJsonObjectFromText(stdout);
      choice = clampNumber(parsed?.choice, 1, candidates.length, 0);
      if (!choice) {
        attemptError = new Error(`Image selector service returned no valid choice on attempt ${attempt}.`);
        if (attempt < 3) { logEvent("openai_image_review_retry", { productKey: product.key, attempt, parsed: parsed ? JSON.stringify(parsed).slice(0, 300) : "" }); try { await ensureImageSelectorServiceRunning(); } catch {} }
      }
    }
    if (!choice) throw attemptError || new Error("Image selector did not return a valid choice.");
    return {
      selector: selectorLabel,
      choice,
      accepted: parsed?.accepted !== false && parsed?.reject !== true,
      reject: parsed?.reject === true || parsed?.accepted === false,
      reason: oneLineField(parsed?.reason || "Selector chose the best candidate.", 500),
      confidence: Math.max(0, Math.min(1, Number(parsed?.confidence || 0))),
      contactSheet: sheet.path,
    };
  } catch (err) {
    logEvent("hermes_image_review_failed", { productKey: product.key, error: oneLineField(err.message || String(err), 300) });
    return {
      selector: "local_quality_fallback",
      choice: candidates.indexOf(fallback) + 1,
      accepted: !fallback?.visualSignals?.rejectForPosting,
      reject: Boolean(fallback?.visualSignals?.rejectForPosting),
      reason: fallback?.visualSignals?.rejectForPosting
        ? `Hermes image review failed; local visual gate rejected the best candidate as packaging/manual-style media. ${oneLineField(err.message || String(err), 180)}`
        : `Hermes image review failed; used local quality/rating score. ${oneLineField(err.message || String(err), 220)}`,
      confidence: 0.35,
      contactSheet: sheet?.path || "",
      error: oneLineField(err.message || String(err), 500),
    };
  }
}

async function extractReviewImageCandidateSetForProduct(product, state, secrets = readSecrets(), options = {}) {
  const attempts = [];
  const providers = [];
  const browserFallbackOnly = Boolean(options.browserFallbackOnly || options.browser_fallback_only);
  const allowBrowser = !options.disableBrowserFallback && !options.disable_browser_fallback;
  if (!browserFallbackOnly) {
    // FREE paths FIRST so we don't burn the limited free Firecrawl quota: Jina (fast) then
    // our own Webshare-residential #40 IXBrowser capture (the path that actually beats
    // Walmart's datacenter-IP anti-bot, 0 API credits). Firecrawl is the PAID LAST RESORT —
    // it only runs if every free path failed. (Firecrawl can't use our proxy: it scrapes
    // from ITS own IPs and only accepts basic/auto/enhanced, so our residential proxy is
    // applied via the #40 browser instead, which is free.)
    providers.push(jinaReaderWalmartReviewsProduct);
    providers.push(jinaReaderProduct);
    if (allowBrowser) providers.push(ixBrowserReviewImagesProduct);
    if (firecrawlApiKeys(secrets).length) providers.push(firecrawlScrapeProduct);
  } else if (allowBrowser) {
    providers.push(ixBrowserReviewImagesProduct);
  }
  for (const provider of providers) {
    try {
      const content = await provider(product, state, secrets, options);
      if (!content) continue;
      const candidates = Array.isArray(content.candidates)
        ? content.candidates
        : extractReviewImageCandidatesFromContent(content, product, state);
      attempts.push({ provider: content.provider, candidateCount: candidates.length });
      if (!candidates.length) continue;
      return { product, provider: content.provider, candidates, attempts };
    } catch (err) {
      attempts.push({ provider: provider.name, error: String(err.message || err).slice(0, 700) });
    }
  }
  const existingCandidates = options.forceFresh || options.force_fresh ? [] : existingReviewImageCandidatesForProduct(product, state, REVIEW_IMAGE_CANDIDATE_COUNT);
  if (existingCandidates.length) {
    attempts.push({ provider: "existing_review_candidate", candidateCount: existingCandidates.length });
    return { product, provider: "existing_review_candidate", candidates: existingCandidates, attempts };
  }
  return { product, error: "no_review_image_extracted", attempts };
}

async function extractOneReviewImageForProduct(product, state, secrets = readSecrets(), options = {}) {
  const forceFresh = Boolean(options.forceFresh || options.force_fresh);
  // Look-ahead buffer reuse: if this product already has an approved HD image,
  // reuse it directly -- no fresh scrape, no ChatGPT regeneration. This makes
  // the 1-post test as fast as production and lets production consume the
  // prepared buffer. forceFresh still regenerates; the browser-fallback-only
  // retry pass skips this so it can do its explicit fresh extraction.
  if (!forceFresh && !options.browserFallbackOnly) {
    const existingApproved = existingApprovedReviewImageForProduct(product, state, []);
    if (existingApproved && existingApproved.localPath) {
      if (typeof options.onAssetProgress === "function") {
        try { options.onAssetProgress({ stage: "hd_done", ok: true, product, localPath: existingApproved.localPath, reused: true }); } catch {}
      }
      return existingApproved;
    }
  }
  const candidateSet = await extractReviewImageCandidateSetForProduct(product, state, secrets, options);
  if (candidateSet.error || !candidateSet.candidates?.length) {
    return forceFresh ? candidateSet : (existingApprovedReviewImageForProduct(product, state, candidateSet.attempts || []) || candidateSet);
  }
  const reviewCandidateCount = clampNumber(state.productAssets?.reviewCandidateCount, 1, REVIEW_IMAGE_CANDIDATE_COUNT, REVIEW_IMAGE_CANDIDATE_COUNT);
  const materializedCandidates = [];
  const attempts = [...(candidateSet.attempts || [])];
  for (const [index, candidate] of candidateSet.candidates.slice(0, reviewCandidateCount).entries()) {
    try {
      const materialized = await materializeReviewImage(product, candidate, state, {
        ...options,
        index,
        skipHd: true,
      });
      materialized.candidate = candidate;
      materialized.provider = candidateSet.provider;
      materialized.qualityScore = reviewCandidateQualityScore(materialized);
      materializedCandidates.push(materialized);
    } catch (err) {
      attempts.push({ provider: candidateSet.provider, candidateIndex: index + 1, error: String(err.message || err).slice(0, 700) });
    }
  }
  if (!materializedCandidates.length) {
    return forceFresh
      ? { product, error: "no_review_image_materialized", attempts }
      : existingApprovedReviewImageForProduct(product, state, attempts)
      || { product, error: "no_review_image_materialized", attempts };
  }
  const selection = await selectBestReviewImageWithHermes(product, materializedCandidates, state, options);
  const selectedBase = materializedCandidates[Math.max(0, Math.min(materializedCandidates.length - 1, Number(selection.choice || 1) - 1))] || materializedCandidates[0];
  const candidateOptions = materializedCandidates.map((candidate, index) => ({
    number: index + 1,
    sourceUrl: candidate.sourceUrl,
    localPath: candidate.originalLocalPath || candidate.localPath,
    rating: candidate.candidate?.rating || "",
    provider: candidate.provider,
    width: candidate.width || 0,
    height: candidate.height || 0,
    qualityScore: candidate.qualityScore,
    visualSignals: candidate.visualSignals || null,
  }));
  const acceptance = validateSelectedReviewImageForPosting(selectedBase, selection, materializedCandidates.length);
  if (!acceptance.ok) {
    attempts.push({ provider: "review_image_visual_gate", candidateCount: materializedCandidates.length, error: acceptance.reason });
    return {
      product,
      error: "review_image_rejected_not_product_visible",
      message: acceptance.reason,
      attempts,
      selection,
      candidateCount: materializedCandidates.length,
      candidateOptions,
    };
  }
  if (typeof options.onAssetProgress === "function") {
    options.onAssetProgress({
      stage: "base_selected",
      product,
      candidateCount: materializedCandidates.length,
      selector: selection.selector || "image selector",
      localPath: selectedBase.originalLocalPath || selectedBase.localPath,
    });
  }
  const upgraded = await upgradeMaterializedReviewImage(product, selectedBase, state, options);
  const upgradeAttempts = upgraded?.error
    ? [...attempts, { provider: "chatgpt_hd", error: upgraded.message || upgraded.error }]
    : attempts;
  return {
    product,
    ...upgraded,
    provider: `${candidateSet.provider}+${selection.selector}`,
    candidate: selectedBase.candidate,
    attempts: upgradeAttempts,
    selection,
    candidateCount: materializedCandidates.length,
    candidateOptions,
  };
}

function mergeSelectedReviewImageLines(existingText, results, hdEnabled = true) {
  const at = new Date().toISOString();
  const kept = recordLines(existingText).filter((line) => {
    const lower = line.toLowerCase();
    return !results.some((result) => result.product?.key && lower.includes(result.product.key.toLowerCase()));
  });
  for (const result of results) {
    if (!result.localPath) continue;
    // When HD is intentionally disabled, the base review JPG is the production
    // image and is approved for posting. When HD is enabled but failed, the
    // image still needs human review (the operator opted in to HD for a reason).
    const hdOk = Boolean(result.chatgptHd?.ok);
    const facebookReady = hdEnabled ? hdOk : true;
    const imageSourceLabel = !hdEnabled
      ? "base_review_jpg_hd_disabled"
      : hdOk
        ? "chatgpt_hd_png_download"
        : "base_review_jpg_hd_failed";
    kept.push([
      at,
      `product_key=${result.product.key}`,
      result.product.url,
      `product_id=${result.product.productId || ""}`,
      `retailer=${result.product.store || ""}`,
      `rating=${result.candidate?.rating || ""}`,
      `source=${result.provider}`,
      result.sourceUrl,
      result.localPath,
      facebookReady ? "status=approved_for_posting" : "status=selected_image_ready_pending_human_approval",
      "rule=one_high_quality_customer_review_image_per_product",
      `review_candidates_checked=${result.candidateCount || 1}`,
      `image_selector=${result.selection?.selector || "single_candidate"}`,
      result.selection?.contactSheet ? `contact_sheet=${result.selection.contactSheet}` : "",
      result.selection?.reason ? `selection_reason=${oneLineField(result.selection.reason, 220)}` : "",
      "product_page_review_image=yes",
      `facebook_image_source=${imageSourceLabel}`,
      "rotation_requested=always_correct_product_orientation",
      result.chatgptHd?.error ? `chatgpt_hd_error=${oneLineField(result.chatgptHd.error, 260)}` : "",
    ].join(" | "));
  }
  return kept.slice(-500).join("\n");
}

// Fire-and-forget warmup: open iX SYL profile, top posting profiles, and (if
// enabled) ChatGPT Edge AT THE START of the pipeline so they're already open
// by the time SYL/posting/HD steps need them. Each step's open call hits the
// cache and skips the 5-30s cold open.
let __pipelineWarmupInFlight = null;
// The posting profile opened early so the connector can REUSE it (no churn).
let __warmupPostingSlot = null; // { profileId, groupUrl, at, testPost }
function warmupPipelineResourcesAsync(options = {}) {
  if (__pipelineWarmupInFlight) return __pipelineWarmupInFlight;
  __pipelineWarmupInFlight = (async () => {
    try {
      const state = readState();
      const sylProfileId = Number(state.affiliate?.dedicatedIxProfileId) || 0;
      const hdEnabled = state.productAssets?.chatgptHdEnabled !== false;
      const isTestPost = Boolean(options.testPost);
      // Pre-open the posting profile FROM THE START so you see the exact profile
      // that will post open early, and the connector REUSES it (no close/reopen
      // churn). To avoid the old "two profiles" bug (warmup guessed one, the
      // SHUFFLED test plan picked another), STASH the chosen slot:
      // preparePostingPlan forces this profile to the front and
      // runLiveFacebookPostFromPlan skips its pre-open close so it is reused.
      let warmPostingProfileId = 0;
      if (!options.skipPostingWarmup) {
        try {
          const warmBase = assignProfileRunIndexes(filterExcludedProfileSlots(postingSlots(state), {}));
          if (warmBase.length) {
            const chosen = isTestPost ? warmBase[randomInt(0, warmBase.length - 1)] : warmBase[0];
            warmPostingProfileId = Number(chosen.profileId || profileIdFromLabel(chosen.profile) || 0);
            if (warmPostingProfileId) {
              __warmupPostingSlot = { profileId: warmPostingProfileId, groupUrl: chosen.groupUrl || "", at: Date.now(), testPost: isTestPost };
            }
          }
        } catch (slotErr) {
          logEvent("warmup_posting_slot_pick_failed", { error: oneLineField(slotErr.message || String(slotErr), 200) });
        }
      }
      const postingSlotIds = warmPostingProfileId ? [warmPostingProfileId] : [];
      logEvent("warmup_pipeline_resources_started", {
        sylProfileId,
        postingProfileIds: postingSlotIds,
        testPost: isTestPost,
        hdEnabled,
        totalWarmups: (sylProfileId ? 1 : 0) + postingSlotIds.length + (hdEnabled ? 1 : 0),
      });
      const warmups = [];
      if (sylProfileId && !__sylGenInFlightProfiles.has(sylProfileId)) {
        warmups.push(
          ixBrowserOpenForCdp(sylProfileId, { reason: "warmup_syl", closeExistingBeforeOpen: false, reuseOpenProfile: true })
            .then(() => logEvent("warmup_ix_profile_ready", { profileId: sylProfileId, role: "syl" }))
            .catch((err) => logEvent("warmup_ix_profile_failed", { profileId: sylProfileId, role: "syl", error: oneLineField(err.message || String(err), 240) })),
        );
      } else if (sylProfileId) {
        // A SYL link generation is using #40 right now — do NOT re-open it (that
        // closed the shared browser mid-generation). It's already open + in use.
        logEvent("warmup_syl_skipped_gen_in_flight", { profileId: sylProfileId });
      }
      for (const pid of postingSlotIds) {
        warmups.push(
          ixBrowserOpenForCdp(pid, { reason: "warmup_posting", closeExistingBeforeOpen: false, reuseOpenProfile: true })
            .then(() => logEvent("warmup_ix_profile_ready", { profileId: pid, role: "posting" }))
            .catch((err) => logEvent("warmup_ix_profile_failed", { profileId: pid, role: "posting", error: oneLineField(err.message || String(err), 240) })),
        );
      }
      if (hdEnabled) {
        warmups.push(
          ensureChatGptCdpBrowser(state.productAssets || {})
            .then((res) => {
              // Record that warmup successfully launched Edge - this lets the
              // later HD step skip the unreliable process-ownership check and
              // just trust this Edge instance.
              __chatGptWarmupContext = { port: res?.port, userDataDir: res?.userDataDir, at: Date.now(), cdp: res?.cdp };
              logEvent("warmup_chatgpt_edge_ready");
            })
            .catch((err) => logEvent("warmup_chatgpt_edge_failed", { error: oneLineField(err.message || String(err), 240) })),
        );
      }
      await Promise.allSettled(warmups);
      logEvent("warmup_pipeline_resources_complete");
    } catch (err) {
      logEvent("warmup_pipeline_resources_error", { error: oneLineField(err.message || String(err), 240) });
    } finally {
      __pipelineWarmupInFlight = null;
    }
  })();
  return __pipelineWarmupInFlight;
}

async function prepareProductAssetChecks(options = {}) {
  // Fire warmup IN PARALLEL with asset prep so SYL/posting/Edge profiles are
  // ready by the time we need them. Don't await - asset prep can run on its
  // own (uses HTTP image-selector, no iX/Edge).
  warmupPipelineResourcesAsync({ testPost: Boolean(options.testPost || options.test_post), skipPostingWarmup: Boolean(options.bufferFill) });
  const state = readState();
  const isTestPost = Boolean(options.testPost || options.test_post);
  state.productAssets.reviewImagesPerProduct = 1;
  state.productAssets.reviewCandidateCount = isTestPost
    ? TEST_REVIEW_IMAGE_CANDIDATE_COUNT
    : REVIEW_IMAGE_CANDIDATE_COUNT;
  const overrideProductUrls = Array.isArray(options.productUrls)
    ? options.productUrls
    : Array.isArray(options.product_urls)
      ? options.product_urls
      : [];
  const discoveredProducts = overrideProductUrls.length
    ? uniqueProductUrls(overrideProductUrls, state)
    : collectProductUrlsForPosting(state);
  const filterRegisters = readRegisters();
  const allowedProducts = filterBlacklistedProducts(discoveredProducts, state, filterRegisters, options);
  const usedKeys = recentlyUsedProductKeys(filterRegisters.usedProducts, state);
  const skipNoPhoto = !(options.includeUsedProducts || options.include_used_products || options.includeNoReviewPhotoProducts || options.include_no_review_photo_products);
  const noPhotoKeys = skipNoPhoto ? recentlyNoPhotoProductKeys(filterRegisters.noReviewPhotoProducts, state) : new Set();
  const products = (options.includeUsedProducts || options.include_used_products)
    ? allowedProducts
    : allowedProducts.filter((product) => !usedKeys.has(product.key.toLowerCase()) && !noPhotoKeys.has(product.key.toLowerCase()));
  if (!products.length) {
    const blacklistedCount = discoveredProducts.length - allowedProducts.length;
    const err = new Error(discoveredProducts.length
      ? blacklistedCount > 0
        ? "No unused product URLs are ready after removing blacklisted products. Run product discovery again or remove cleared products from the blacklist."
        : "No unused product URLs are ready. Run product discovery first or clear only invalid test-used products."
      : "No product URLs are ready. Run product discovery first or paste product URLs.");
    err.statusCode = 400;
    throw err;
  }
  const at = new Date().toISOString();
  const secrets = readSecrets();
  const requestedLimit = options.limit || state.productAssets.assetPrepareLimit || products.length;
  const limit = clampNumber(requestedLimit, 1, 500, products.length);
  // Test mode: skip the expensive browser-based fallback (browser-per-product
  // hammers iX desktop with "Server busy" errors). Without that fallback, each
  // product attempt is cheap (~5-15s via jina_reader + image selector), so we
  // can afford to iterate up to 12 products before giving up.
  const inspectCap = isTestPost ? Math.max(limit, 12) : products.length;
  const maxProductsToInspect = clampNumber(options.maxProductsToInspect || options.max_products_to_inspect || inspectCap, limit, products.length, inspectCap);
  const selectedResults = [];
  let failedResults = [];
  const hdSession = {};
  let chatGptBrowserClose = { ok: true, status: "not_opened" };
  let inspectedProducts = 0;
  const persistAssetStage = (stage = {}) => {
    if (!isTestPost) return;
    persistTestAssetProgressStage(stage);
  };
  const onAssetProgress = (event = {}) => {
    if (!isTestPost) return;
    const productLabel = oneLineField(event.product?.title || event.product?.productId || event.product?.key || "selected product", 120);
    if (event.stage === "base_selected") {
      persistAssetStage({
        percent: 43,
        assetsStatus: "done",
        assetsDetail: `Base review image selected for ${productLabel}; ${event.candidateCount || REVIEW_IMAGE_CANDIDATE_COUNT} candidate(s) reviewed by ${event.selector || "image selector"}.`,
        hdStatus: state.productAssets.chatgptHdEnabled === false ? "skipped" : "running",
        hdDetail: state.productAssets.chatgptHdEnabled === false ? "ChatGPT HD disabled." : "ChatGPT HD/rotation starting for the selected product image.",
      });
    } else if (event.stage === "hd_running") {
      persistAssetStage({
        percent: 47,
        hdStatus: "running",
        hdDetail: `ChatGPT HD/rotation is processing ${productLabel}; output must be PNG/JPG for Facebook.`,
      });
    } else if (event.stage === "hd_done") {
      persistAssetStage({
        percent: 56,
        hdStatus: event.ok ? "done" : "failed",
        hdDetail: event.ok ? `ChatGPT HD PNG/JPG ready: ${event.localPath || ""}` : `ChatGPT HD finished without a confirmed PNG/JPG for ${productLabel}.`,
      });
    } else if (event.stage === "hd_failed") {
      persistAssetStage({
        percent: 48,
        hdStatus: "failed",
        hdDetail: `ChatGPT HD failed for ${productLabel}: ${oneLineField(event.error || "unknown error", 300)}`,
      });
    }
  };
  try {
    persistAssetStage({
      percent: 28,
      assetsStatus: "running",
      assetsDetail: `Reviewing product-page customer images for up to ${maxProductsToInspect} candidate product(s); stopping after ${limit} approved base image(s).`,
      hdStatus: state.productAssets.chatgptHdEnabled === false ? "skipped" : "waiting",
      hdDetail: state.productAssets.chatgptHdEnabled === false ? "ChatGPT HD disabled." : "Waiting for selected base image before ChatGPT HD/rotation.",
    });
    for (const product of products.slice(0, maxProductsToInspect)) {
      if (selectedResults.length >= limit) break;
      inspectedProducts += 1;
      persistAssetStage({
        percent: Math.min(42, 28 + inspectedProducts),
        assetsStatus: "running",
        assetsDetail: `Checking review image candidates for product ${inspectedProducts}/${maxProductsToInspect}: ${oneLineField(product.title || product.productId || product.key, 140)}.`,
        hdStatus: state.productAssets.chatgptHdEnabled === false ? "skipped" : "waiting",
        hdDetail: state.productAssets.chatgptHdEnabled === false ? "ChatGPT HD disabled." : "Waiting for selected base image before ChatGPT HD/rotation.",
      });
      const result = await extractOneReviewImageForProduct(product, state, secrets, {
        hdSession,
        testPost: isTestPost,
        forceFresh: Boolean(options.forceFresh || options.force_fresh || options.disableCachedFallback || options.disable_cached_fallback),
        disableBrowserFallback: true,
        onAssetProgress,
      });
      if (result.localPath) selectedResults.push(result);
      else {
        failedResults.push(result);
        persistAssetStage({
          percent: Math.min(42, 28 + inspectedProducts),
          assetsStatus: "running",
          assetsDetail: `Product ${inspectedProducts}/${maxProductsToInspect} did not produce an approved review image; checking the next candidate.`,
        });
      }
    }
    // In test mode, do NOT run the browser-based fallback for failed products.
    // It spawns iX browser instances per product which is slow and hammers the
    // iX desktop API (caused "Server busy" / desktop recovery cascades). Test
    // mode should fail fast if the cheap jina_reader path returned no usable
    // images for the first batch of products.
    // Browser fallback DISABLED in BOTH test and prod. It opened a NORMAL posting
    // profile (e.g. #19) and loaded the Walmart product/reviews page on this server's
    // flagged datacenter IP, which just hit Walmart's "Robot/Human" anti-bot — burning
    // a posting profile per product for nothing. Review images now come from Jina only
    // (cloud IP). Products Jina can't scrape are skipped (the next eligible product is
    // tried). This makes test == prod. To re-enable a proxied capture later, route it
    // through the residential affiliate proxy, NOT a raw posting profile.
    // Browser fallback now captures through the residential-proxy #40 profile (above),
    // which Walmart doesn't flag — so it's safe to run in BOTH test and prod (test == prod).
    const allowBrowserFallback = !options.disableBrowserFallback && !options.disable_browser_fallback;
    if (selectedResults.length < limit && allowBrowserFallback) {
      const browserFallbackFailures = [];
      const failedProductKeys = new Set(failedResults.map((result) => String(result.product?.key || "").toLowerCase()).filter(Boolean));
      const originalFailuresByKey = new Map(failedResults.map((result) => [String(result.product?.key || "").toLowerCase(), result]).filter(([key]) => key));
      for (const failed of failedResults) {
        if (selectedResults.length >= limit) break;
        if (failed.blacklisted) continue;
        const product = failed.product;
        if (!product?.key) continue;
        const result = await extractOneReviewImageForProduct(product, state, secrets, {
          hdSession,
          testPost: isTestPost,
          forceFresh: Boolean(options.forceFresh || options.force_fresh || options.disableCachedFallback || options.disable_cached_fallback),
          browserFallbackOnly: true,
          onAssetProgress,
        });
        if (result.localPath) {
          selectedResults.push(result);
          failedProductKeys.delete(String(product.key).toLowerCase());
        } else {
          result.attempts = [
            ...(failed.attempts || []),
            ...(result.attempts || []),
          ];
          browserFallbackFailures.push(result);
        }
      }
      const browserFailuresByKey = new Map(browserFallbackFailures.map((result) => [String(result.product?.key || "").toLowerCase(), result]).filter(([key]) => key));
      failedResults = [...failedProductKeys]
        .map((key) => browserFailuresByKey.get(key) || originalFailuresByKey.get(key))
        .filter(Boolean);
    }
    if (!selectedResults.length && (options.testPost || options.test_post) && !options.forceFresh && !options.force_fresh && !options.disableCachedFallback && !options.disable_cached_fallback) {
      const excludedKeys = new Set(products.map((product) => String(product.key || "").toLowerCase()).filter(Boolean));
      const fallbackProducts = approvedMappedProductFallbacks(state, excludedKeys, limit);
      for (const product of fallbackProducts) {
        if (selectedResults.length >= limit) break;
        const result = existingApprovedReviewImageForProduct(product, state, [{
          provider: "test_post_cached_asset_fallback",
          error: "Fresh filter/search products did not produce a usable positive-review image; reused a product that already has an approved image and ShopYourLikes/Mavlynk mapping.",
        }]);
        if (result?.localPath) {
          result.provider = "test_post_cached_approved_asset_fallback";
          result.selection = {
            ...(result.selection || {}),
            selector: "test_post_cached_approved_asset_fallback",
            reason: "Fresh filter/search products were blocked by Walmart verification or had no usable review image, so the 1-post test reused an already approved image/link-mapped product.",
          };
          selectedResults.push(result);
        }
      }
      if (selectedResults.length) {
        logEvent("test_post_asset_fallback_reused_approved_product", {
          selected: selectedResults.length,
          failedFreshProducts: failedResults.length,
          productUrls: selectedResults.map((result) => result.product?.url || "").filter(Boolean),
        });
      }
    }
  } finally {
    if (isTestPost) {
      chatGptBrowserClose = await closeChatGptCdpBrowserSession(hdSession, "product_asset_checks_completed");
    } else {
      // Prod runs reuse the same ChatGPT Edge profile across many products
      // and across back-to-back batches. Closing+reopening Edge between
      // batches costs ~10-15s and risks the chatgpt.com session getting
      // logged out by Cloudflare on cold start. Keep it open for prod.
      chatGptBrowserClose = { ok: true, status: "kept_open_for_prod", cdp: hdSession.cdpBrowser?.cdp || "" };
      if (hdSession.cdpBrowser?.cdp) {
        logEvent("chatgpt_cdp_browser_kept_open_for_prod", {
          cdp: oneLineField(hdSession.cdpBrowser.cdp, 160),
          reason: "prod_product_asset_checks_completed",
        });
      }
    }
  }
  const activeReviewCandidateCount = state.productAssets.reviewCandidateCount || REVIEW_IMAGE_CANDIDATE_COUNT;
  state.productAssets.reviewImagesPerProduct = 1;
  // Preserve the actual count used for this run (2 in test, 5 in prod) instead
  // of unconditionally resetting to the prod default. The reset was confusing
  // the log message and persisting wrong state for next runs.
  state.productAssets.reviewCandidateCount = isTestPost
    ? TEST_REVIEW_IMAGE_CANDIDATE_COUNT
    : REVIEW_IMAGE_CANDIDATE_COUNT;
  state.productAssets.selectedReviewImages = mergeSelectedReviewImageLines(state.productAssets.selectedReviewImages, selectedResults, state.productAssets?.chatgptHdEnabled !== false);
  const candidateRows = selectedResults.flatMap((result) => {
    const rows = (result.candidateOptions || []).map((candidate) => ({
      productUrl: result.product.url,
      productTitle: result.product.title || result.candidate?.productTitle || result.product.productId,
      rating: candidate.rating || result.candidate?.rating || "",
      sentiment: result.candidate?.sentiment || "positive_or_neutral",
      imageUrl: candidate.sourceUrl,
      seoFilename: path.basename(candidate.localPath || "review-image.jpg"),
      source: candidate.provider || result.provider,
      priority: candidate.number === result.selection?.choice ? "hermes_selected_best" : "candidate_for_hermes_review",
    }));
    if (rows.length) return rows;
    return [{
      productUrl: result.product.url,
      productTitle: result.product.title || result.candidate?.productTitle || result.product.productId,
      rating: result.candidate?.rating || "",
      sentiment: result.candidate?.sentiment || "positive_or_neutral",
      imageUrl: result.sourceUrl,
      seoFilename: "review-image.jpg",
      source: result.provider,
      priority: "selected_image_ready",
    }];
  });
  state.productAssets.reviewImageCandidates = mergeReviewImageCandidateLines(state.productAssets.reviewImageCandidates, candidateRows);
  const mergedState = readState();
  mergedState.productAssets.reviewImagesPerProduct = state.productAssets.reviewImagesPerProduct;
  mergedState.productAssets.reviewCandidateCount = state.productAssets.reviewCandidateCount;
  mergedState.productAssets.selectedReviewImages = state.productAssets.selectedReviewImages;
  mergedState.productAssets.reviewImageCandidates = state.productAssets.reviewImageCandidates;
  if (isTestPost) {
    applyTestAssetProgressToState(mergedState, selectedResults, failedResults);
  }
  const nextState = writeState(mergedState);

  const rows = [
    "# Product review images",
    "# fields: timestamp | product_url | product_id | retailer | required_images | min_rating | preferred_rating | output_path | status | source_url | local_facebook_image_path | notes",
    "# rule: collect up to 5 customer review image candidates per product; Hermes default LLM/image review selects the best one; exactly 1 selected image is sent to ChatGPT HD/Facebook",
    ...selectedResults.map((result) => {
      const hdEnabledRow = state.productAssets?.chatgptHdEnabled !== false;
      const hdOkRow = Boolean(result.chatgptHd?.ok);
      const facebookReadyRow = hdEnabledRow ? hdOkRow : true;
      const hdStatusLabel = !hdEnabledRow ? "disabled" : hdOkRow ? "yes" : "failed";
      const imageSourceLabelRow = !hdEnabledRow
        ? "base_review_jpg_hd_disabled"
        : hdOkRow
          ? "chatgpt_hd_png_download"
          : "base_review_jpg_hd_failed";
      return [
        at,
        result.product.url,
        result.product.productId,
        result.product.store,
        1,
        state.productAssets.minReviewRating || 4,
        state.productAssets.preferredReviewRating || 5,
        state.productAssets.outputPath || "data/product-assets",
        facebookReadyRow ? "approved_for_posting" : "selected_image_ready_pending_human_approval",
        result.sourceUrl,
        result.localPath,
        `provider=${result.provider}; bytes=${result.bytes}; original_local_image=${result.originalLocalPath || result.localPath}; review_candidates_checked=${result.candidateCount || 1}; image_selector=${result.selection?.selector || "single_candidate"}; contact_sheet=${result.selection?.contactSheet || ""}; selection_reason=${oneLineField(result.selection?.reason || "", 220)}; product_page_review_image=yes; chatgpt_hd=${hdStatusLabel}; facebook_image_source=${imageSourceLabelRow}; facebook_image_format=${/\.png$/i.test(result.localPath || "") ? "png" : "jpg"}; rotation_requested=always_correct_product_orientation; rotated_if_needed=yes; one image per product${result.chatgptHd?.error ? `; chatgpt_hd_error=${oneLineField(result.chatgptHd.error, 260)}` : ""}`,
      ].join(" | ");
    }),
    ...failedResults.map((result) => [
      at,
      result.product.url,
      result.product.productId,
      result.product.store,
      1,
      state.productAssets.minReviewRating || 4,
      state.productAssets.preferredReviewRating || 5,
      state.productAssets.outputPath || "data/product-assets",
      result.blacklisted ? "blacklisted_chatgpt_hd_guardrail" : "failed_no_review_image",
      "",
      "",
      `${result.error ? `error=${oneLineField(result.message || result.error, 260)}; ` : ""}attempts=${JSON.stringify(result.attempts || []).slice(0, 500)}`,
    ].join(" | ")),
  ].join("\n") + "\n";
  writeTextFile(state.files.productReviewImages || "data/product-review-images.txt", rows);
  const registers = readRegisters();
  appendApprovalLine(registers, `${at} | type=product_asset_check_run | status=pending | product_count=${products.length} | review_candidates_per_product=${activeReviewCandidateCount} | selected_images=${selectedResults.length} | failed=${failedResults.length} | file=${state.files.productReviewImages} | reason=approve Hermes-selected JPG/PNG review images before Facebook upload use`);
  // Reversibly mark products a RELIABLE scrape confirmed have NO customer review photos so
  // the buffer fill stops re-inspecting them (auto-retried after retryNoReviewPhotoAfterDays).
  // Only on the fill/prod path, only the genuine-no-photo signal (never a transient block),
  // and only "no_review_image_extracted" (the materialize/visual-gate errors mean photos DID exist).
  if (options.bufferFill || !isTestPost) {
    for (const result of failedResults) {
      if (result && result.product && result.product.key && !result.blacklisted
          && /no_review_image_extracted/.test(String(result.error || ""))
          && productGenuinelyHasNoReviewPhotos(result.attempts)) {
        recordProductNoReviewPhotos(registers, result.product, "provider-confirmed 0 review photos");
      }
    }
  }
  writeRegisters(registers);
  logEvent("product_asset_checks_prepared", { productCount: products.length, selected: selectedResults.length, failed: failedResults.length, reviewCandidatesPerProduct: activeReviewCandidateCount, mode: isTestPost ? "test" : "prod" });
  const hdUpgraded = selectedResults.filter((result) => result.chatgptHd?.ok).length;
  const hdFailures = selectedResults.filter((result) => result.chatgptHd && !result.chatgptHd.ok).length;
  return {
    state: nextState,
    registers: readRegisters(),
    productCount: products.length,
    selected: selectedResults.length,
    failed: failedResults.length,
    hdEnabled: state.productAssets.chatgptHdEnabled !== false,
    hdUpgraded,
    hdFailures,
    chatGptBrowserClose,
    file: state.files.productReviewImages,
    reviewCandidatesPerProduct: activeReviewCandidateCount,
    selectedImages: selectedResults.map((result) => ({
      productUrl: result.product.url,
      localPath: result.localPath,
      originalLocalPath: result.originalLocalPath || result.localPath,
      sourceUrl: result.sourceUrl,
      provider: result.provider,
      bytes: result.bytes,
      chatgptHd: result.chatgptHd || null,
      selection: result.selection || null,
      candidateCount: result.candidateCount || 1,
      candidateOptions: result.candidateOptions || [],
    })),
    failures: failedResults.map((result) => ({
      productUrl: result.product?.url || "",
      error: result.error || "",
      message: result.message || "",
      blacklisted: Boolean(result.blacklisted),
      attempts: result.attempts || [],
      candidateCount: maxCandidateCountFromAttempts(result.attempts || []),
    })),
  };
}

function normalizeCdpEndpoint(value) {
  let text = String(value || "").trim();
  if (!text) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  const url = new URL(text);
  if (!["http:", "ws:"].includes(url.protocol)) {
    throw serviceConfigError("IXBrowser debugging endpoint must be local HTTP or WS.", "ixbrowser_debug_endpoint_invalid");
  }
  const host = url.hostname.toLowerCase();
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw serviceConfigError("IXBrowser debugging endpoint must stay on localhost/127.0.0.1.", "ixbrowser_debug_endpoint_invalid");
  }
  url.username = "";
  url.password = "";
  return url.toString();
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
    try {
      return normalizeCdpEndpoint(candidate);
    } catch {
      continue;
    }
  }
  const err = new Error("IXBrowser opened the profile but did not return a local debugging address.");
  err.statusCode = 502;
  err.publicError = "ixbrowser_debug_endpoint_missing";
  throw err;
}

function cacheIxBrowserCdpEndpoint(profileId, result = {}) {
  try {
    const cdpEndpoint = cdpEndpointFromIxOpenResult(result);
    ixBrowserCdpEndpointCache.set(Number(profileId), {
      cdpEndpoint,
      result,
      updatedAt: new Date().toISOString(),
    });
    writeIxBrowserCdpCacheFile();
    return cdpEndpoint;
  } catch {
    return "";
  }
}

function readIxBrowserCdpCacheFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(IXBROWSER_CDP_CACHE_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeIxBrowserCdpCacheFile() {
  const payload = {};
  for (const [profileId, value] of ixBrowserCdpEndpointCache.entries()) {
    payload[String(profileId)] = value;
  }
  try {
    atomicWrite(IXBROWSER_CDP_CACHE_FILE, JSON.stringify(payload, null, 2) + "\n");
  } catch (err) {
    logEvent("ixbrowser_cdp_cache_write_failed", { error: oneLineField(err.message || String(err), 240) });
  }
}

function cachedIxBrowserCdpEndpoint(profileId) {
  const numericProfileId = Number(profileId);
  const memoryValue = ixBrowserCdpEndpointCache.get(numericProfileId);
  if (memoryValue) return memoryValue;
  const diskValue = readIxBrowserCdpCacheFile()[String(numericProfileId)];
  if (diskValue?.cdpEndpoint) {
    ixBrowserCdpEndpointCache.set(numericProfileId, diskValue);
    return diskValue;
  }
  return null;
}

function cdpVersionUrl(endpoint) {
  const url = new URL(normalizeCdpEndpoint(endpoint));
  if (url.protocol === "ws:") url.protocol = "http:";
  url.pathname = "/json/version";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function isCachedCdpEndpointAlive(endpoint) {
  try {
    const payload = await fetchJson(cdpVersionUrl(endpoint), { timeoutMs: 2500 });
    return Boolean(payload?.Browser || payload?.webSocketDebuggerUrl);
  } catch {
    return false;
  }
}

function assertIxBrowserPreOpenCleanupOk(result, profileId, reason) {
  if (!result || result.ok !== false || result.status !== "close_failed") return;
  const err = new Error(`IXBrowser profile ${profileId} could not be closed before opening (${reason || "preopen cleanup"}): ${result.message || "close failed"}. The agent stopped to avoid duplicate windows.`);
  err.statusCode = 409;
  err.publicError = "ixbrowser_preopen_cleanup_failed";
  throw err;
}

function isIxBrowserProfileAlreadyClosedError(err) {
  return Number(err?.ixBrowserCode || 0) === 1009 || /process not found|not found/i.test(String(err?.message || err));
}

async function withIxBrowserProfileOpenLock(profileId, work) {
  const numericProfileId = Number(profileId);
  const key = String(numericProfileId || profileId || "");
  const previous = ixBrowserProfileOpenLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const chained = previous.catch(() => {}).then(() => current);
  ixBrowserProfileOpenLocks.set(key, chained);
  await previous.catch(() => {});
  try {
    return await work();
  } finally {
    release();
    if (ixBrowserProfileOpenLocks.get(key) === chained) ixBrowserProfileOpenLocks.delete(key);
  }
}

function acquireNormalIxProfileUse(profileId, purpose) {
  const numericProfileId = Number(profileId);
  if (!numericProfileId || isDedicatedShopYourLikesIxProfile(numericProfileId)) return () => {};
  const key = String(numericProfileId);
  const existing = normalIxProfileUseLocks.get(key);
  if (existing) {
    const err = new Error(`IXBrowser profile ${numericProfileId} is already busy with ${existing.purpose}. Wait for that run to finish, or click Stop / Clear Test.`);
    err.statusCode = 409;
    err.publicError = "ixbrowser_profile_busy";
    throw err;
  }
  normalIxProfileUseLocks.set(key, { purpose: oneLineField(purpose || "workflow", 120), startedAt: new Date().toISOString() });
  return () => {
    if (normalIxProfileUseLocks.get(key)?.purpose === oneLineField(purpose || "workflow", 120)) {
      normalIxProfileUseLocks.delete(key);
    }
  };
}

function assertAllowedDiscoveryPageUrl(rawUrl, state, options = {}) {
  const value = String(rawUrl || "").trim();
  if (!value && options.allowBlank) return "";
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    const err = new Error("Browser discovery source URL is invalid.");
    err.statusCode = 400;
    throw err;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    const err = new Error("Browser discovery source URL must be HTTP or HTTPS.");
    err.statusCode = 400;
    throw err;
  }
  const host = parsed.hostname.toLowerCase();
  if (isLocalOrPrivateHost(host) && !options.allowLocalForTest) {
    const err = new Error("Browser discovery source URL cannot point to localhost or a private network.");
    err.statusCode = 400;
    throw err;
  }
  if (!hostAllowed(host, allowedRetailerHosts(state))) {
    const err = new Error(`Browser discovery source host is not in Allowed retailer domains: ${host}`);
    err.statusCode = 400;
    throw err;
  }
  parsed.hash = "";
  return parsed.toString();
}

function firstDiscoverySourceUrl(state) {
  return productDiscoverySources(state)[0] || "";
}

function collectReviewImageUrls(value, output = new Set(), depth = 0) {
  if (!value || depth > 4) return output;
  if (typeof value === "string") {
    if (isReviewRasterImageUrl(value)) {
      output.add(value.replace(/\\u002F/g, "/").replace(/\\\//g, "/"));
    }
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectReviewImageUrls(item, output, depth + 1);
    return output;
  }
  if (typeof value !== "object") return output;
  for (const key of ["url", "src", "imageUrl", "imageURL", "thumbnailUrl", "largeUrl", "mediaUrl"]) {
    collectReviewImageUrls(value[key], output, depth + 1);
  }
  for (const key of ["images", "photos", "media", "attachments", "customerImages", "reviewImages"]) {
    collectReviewImageUrls(value[key], output, depth + 1);
  }
  return output;
}

function looksLikeReviewObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).join(" ").toLowerCase();
  return /review|rating|submission|author|usernickname|reviewtext|customer/.test(keys);
}

function reviewRatingFromObject(value) {
  return firstNumeric(
    value?.rating,
    value?.ratingValue,
    value?.overallRating,
    value?.reviewRating?.ratingValue,
    value?.reviewRating?.rating,
    value?.stars,
  );
}

function reviewTextFromObject(value) {
  return safeText([
    value?.title,
    value?.name,
    value?.reviewTitle,
    value?.reviewText,
    value?.text,
    value?.comment,
    value?.body,
  ].filter(Boolean).join(" "), 700);
}

function positiveReviewSentiment(text) {
  if (/\b(bad|awful|terrible|horrible|broken|defective|return(ed)?|refund|waste|poor|worst|disappointed|not worth|doesn'?t work|did not work)\b/i.test(text)) return "reject_negative_terms";
  return "positive_or_neutral";
}

function collectReviewImageCandidatesFromJson(value, context, rows = [], limits = { nodes: 0, maxNodes: 25000 }) {
  if (!value || limits.nodes >= limits.maxNodes) return rows;
  limits.nodes += 1;
  if (Array.isArray(value)) {
    for (const item of value) collectReviewImageCandidatesFromJson(item, context, rows, limits);
    return rows;
  }
  if (typeof value !== "object") return rows;
  if (looksLikeReviewObject(value)) {
    const rating = reviewRatingFromObject(value);
    const text = reviewTextFromObject(value);
    const sentiment = positiveReviewSentiment(text);
    const imageUrls = [...collectReviewImageUrls(value)];
    if (rating && rating >= context.minRating && sentiment !== "reject_negative_terms" && imageUrls.length) {
      for (const imageUrl of imageUrls) {
        rows.push({
          productUrl: context.productUrl,
          productTitle: context.productTitle,
          rating,
          sentiment,
          imageUrl,
          reviewText: safeText(text, 300),
          source: "review_json",
          priority: rating >= context.preferredRating ? "preferred" : "accepted",
        });
      }
    }
  }
  for (const nested of Object.values(value)) {
    if (!nested || (typeof nested !== "object" && !Array.isArray(nested))) continue;
    collectReviewImageCandidatesFromJson(nested, context, rows, limits);
  }
  return rows;
}

function extractDomReviewImageCandidates($, context) {
  const rows = [];
  const selectors = "[data-testid*='review'], [data-automation-id*='review'], [class*='review'], [aria-label*='review' i]";
  $(selectors).each((_, element) => {
    const section = $(element);
    const text = safeText(section.text(), 1200);
    const rating = firstNumeric(
      (text.match(/(\d(?:\.\d)?)\s*out of\s*5/i) || [])[1],
      (text.match(/(\d(?:\.\d)?)\s*stars?/i) || [])[1],
      section.attr("aria-label"),
    );
    const sentiment = positiveReviewSentiment(text);
    if (!rating || rating < context.minRating || sentiment === "reject_negative_terms") return;
    section.find("img[src], img[data-src]").each((__, img) => {
      const raw = $(img).attr("src") || $(img).attr("data-src") || "";
      try {
        const imageUrl = new URL(raw, context.productUrl).toString();
        if (!isReviewRasterImageUrl(imageUrl)) return;
        rows.push({
          productUrl: context.productUrl,
          productTitle: context.productTitle,
          rating,
          sentiment,
          imageUrl,
          reviewText: safeText(text, 300),
          source: "review_dom",
          priority: rating >= context.preferredRating ? "preferred" : "accepted",
        });
      } catch {}
    });
  });
  return rows;
}

function seoFileName(title, productId, index) {
  const base = String(title || `product-${productId || "review"}`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90) || "review-image";
  const id = String(productId || "product").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const suffix = index > 0 ? `-${index + 1}` : "";
  return `${base}${id ? `-${id}` : ""}-customer-review${suffix}.jpg`;
}

function uniqueReviewImageCandidates(rows, limit = 100) {
  const seen = new Set();
  return rows
    .filter((row) => {
      const key = `${row.productUrl}|${row.imageUrl}`.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => Number(b.rating || 0) - Number(a.rating || 0))
    .slice(0, limit);
}

function extractReviewImageCandidates(html, pageUrl, state, products = []) {
  const $ = cheerio.load(String(html || ""));
  const nextData = parseJsonScript($, "script#__NEXT_DATA__");
  const product = products[0] || canonicalProduct(pageUrl, state) || {};
  const context = {
    productUrl: product.url || pageUrl,
    productTitle: safeText(product.title || $("h1").first().text() || $("title").text(), 200),
    minRating: clampNumber(state.productAssets?.minReviewRating, 1, 5, 4),
    preferredRating: clampNumber(state.productAssets?.preferredReviewRating, 1, 5, 5),
  };
  const rows = [];
  if (nextData) collectReviewImageCandidatesFromJson(nextData, context, rows);
  rows.push(...extractDomReviewImageCandidates($, context));
  const productId = product.productId || "";
  return uniqueReviewImageCandidates(rows).map((row, index) => ({
    ...row,
    seoFilename: seoFileName(row.productTitle, productId, index),
  }));
}

function mergeReviewImageCandidateLines(existingText, rows) {
  const lines = recordLines(existingText);
  const seen = new Set(lines.map((line) => line.toLowerCase()));
  const additions = [];
  const at = new Date().toISOString();
  for (const row of rows || []) {
    const line = [
      at,
      row.productUrl,
      row.productTitle,
      row.rating,
      row.sentiment,
      row.imageUrl,
      "",
      row.seoFilename,
      "pending",
      `${row.source}; ${row.priority}; approve before JPG/PNG conversion/upload`,
    ].join(" | ");
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    additions.push(line);
  }
  return [...lines, ...additions].slice(-500).join("\n");
}

function assertAllowedAffiliateProductUrl(rawUrl, state) {
  return assertAllowedDiscoveryPageUrl(rawUrl, state);
}

function collectShopYourLikesProductUrls(body, state) {
  // Accept productUrls/product_urls (plural array) too — the buffer fill passes
  // { productUrls: [oneUrl] }. Without this, that key was ignored and the function
  // fell back to ALL saved URLs below, generating links for EVERY product in a loop
  // instead of the single one requested.
  const bodyUrls = Array.isArray(body.urls) ? body.urls
    : Array.isArray(body.productUrls) ? body.productUrls
    : Array.isArray(body.product_urls) ? body.product_urls
    : [body.url, body.productUrl].filter(Boolean);
  const urls = bodyUrls.length
    ? bodyUrls
    : [
        ...recordLines(state.affiliate?.originalLinks),
        ...recordLines(state.productAssets?.productUrls),
        ...recordLines(state.posting?.sourceUrls),
      ];
  const seen = new Set();
  const clean = [];
  for (const rawUrl of urls) {
    const url = assertAllowedAffiliateProductUrl(rawUrl, state);
    const product = canonicalProduct(url, state);
    const key = String(product?.key || url).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push(product?.url || url);
  }
  return clean;
}

function existingShopYourLikesForProductUrl(productUrl, state) {
  const product = canonicalProduct(productUrl, state);
  if (!product?.key) return null;
  const productKey = product.key.toLowerCase();
  const mapped = affiliateLinkMappings(state).find((entry) => entry.productKey.toLowerCase() === productKey);
  if (mapped?.sylLink) {
    return {
      productUrl: mapped.productUrl || product.url,
      productKey: mapped.productKey || product.key,
      sylLink: mapped.sylLink,
      shortUrl: mapped.shortUrl || "",
      source: "existing_affiliate_mapping",
    };
  }

  const originalLinks = recordLines(state.affiliate?.originalLinks);
  const sylLinks = recordLines(state.affiliate?.shopyourlikesLinks);
  for (let index = 0; index < originalLinks.length && index < sylLinks.length; index += 1) {
    const legacyProduct = canonicalProduct(originalLinks[index], state);
    const sylLink = sylLinks[index] || "";
    if (legacyProduct?.key?.toLowerCase() !== productKey || !isShopYourLikesUrl(sylLink)) continue;
    return {
      productUrl: legacyProduct.url || product.url,
      productKey: legacyProduct.key || product.key,
      sylLink,
      shortUrl: "",
      source: "existing_legacy_syl_mapping",
    };
  }
  return null;
}

async function generateShopYourLikesLinkInExtension(context, productUrl) {
  const pages = context.pages().filter((page) => !page.isClosed());
  // Don't reuse the profile's facebook.com startup tab - navigating it makes
  // the operator watch facebook.com load before we redirect to the product
  // (a few wasted seconds). Prefer: existing product tab, else a non-facebook
  // tab, else a fresh tab. The facebook startup tab is left alone.
  const productPage = pages.find((page) => { const u = String(page.url() || ""); return u && u !== "about:blank" && !/facebook\.com/i.test(u); })
    || await context.newPage();
  // Do NOT load the Walmart product page. This server's datacenter IP trips
  // Walmart's "Robot or Human?" anti-bot, which blocked link generation and made
  // the buffer fill loop product-after-product. The SYL extension only needs the
  // product URL (supplied below via the mocked chrome.tabs.query), NOT the page
  // content — image scraping is the extension's own UI feature, unused by us — so
  // we stay on about:blank and never touch Walmart. Faster too (no 45s page load).
  await productPage.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
  await productPage.waitForTimeout(500);
  await productPage.bringToFront().catch(() => {});

  const extensionPage = await context.newPage();
  try {
    // Mock chrome.tabs.query BEFORE popup script runs so the extension
    // believes the active tab is the Walmart product (not the popup tab).
    // Without this, chrome.tabs.query returns the popup's own chrome-extension
    // URL and the extension renders "Retailer offline".
    await extensionPage.addInitScript((url) => {
      const installPatch = () => {
        if (typeof chrome === "undefined" || !chrome.tabs) return false;
        const origQuery = chrome.tabs.query;
        chrome.tabs.query = function (qi, cb) {
          if (qi && (qi.active || qi.currentWindow || qi.lastFocusedWindow)) {
            const fakeTab = { id: 999, windowId: 1, active: true, url, title: "ShopYourLikes Generator", highlighted: true, pinned: false, status: "complete" };
            if (typeof cb === "function") { try { cb([fakeTab]); } catch (_) {} return; }
            return Promise.resolve([fakeTab]);
          }
          if (typeof cb === "function") return origQuery.call(chrome.tabs, qi, cb);
          return origQuery.call(chrome.tabs, qi);
        };
        return true;
      };
      if (!installPatch()) {
        const obs = setInterval(() => { if (installPatch()) clearInterval(obs); }, 30);
        setTimeout(() => clearInterval(obs), 5000);
      }
    }, productUrl);
    await extensionPage.goto(`chrome-extension://${SHOPYOURLIKES_EXTENSION_ID}/popup.html`, { waitUntil: "domcontentloaded", timeout: 15000 });
    await extensionPage.waitForTimeout(1500);
    await extensionPage.evaluate((url) => {
      if (window.ConnexityPubRdPopup) {
        window.ConnexityPubRdPopup.url = url;
        window.ConnexityPubRdPopup.tabTitle = document.title || url;
      }
    }, productUrl);
    await extensionPage.waitForSelector("#generate_link_button", { timeout: 15000 });
    const initialBtnText = await extensionPage.evaluate(() => document.querySelector("#generate_link_button")?.innerText || "");
    const linkFromInitialButton = (String(initialBtnText).match(/https?:\/\/\S+/i) || [""])[0];
    if (!linkFromInitialButton) {
      await extensionPage.click("#generate_link_button");
    }
    const sylLink = await extensionPage.waitForFunction(() => {
      const fromGlobal = window.generatedDeeplink || "";
      const field = document.querySelector("#deepLink")?.value || "";
      const buttonText = document.querySelector("#generate_link_button")?.innerText || "";
      const fromButton = (buttonText.match(/https?:\/\/\S+/i) || [""])[0];
      return fromGlobal || field || fromButton || "";
    }, null, { timeout: 45000 }).then((handle) => handle.jsonValue());
    if (!sylLink || !/^https?:\/\//i.test(String(sylLink))) {
      throw new Error("ShopYourLikes extension did not expose a generated link.");
    }
    return String(sylLink).trim();
  } finally {
    await extensionPage.close().catch(() => {});
    await productPage.bringToFront().catch(() => {});
  }
}

async function connectIxBrowserCdpWithRetry(cdpEndpoint, options = {}) {
  const attempts = clampNumber(options.attempts || 3, 1, 5, 3);
  const timeout = clampNumber(options.timeout || 60000, 15000, 120000, 60000);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // Hard timeout: Playwright's own connectOverCDP timeout sometimes does NOT
      // fire when the CDP endpoint is reachable but unresponsive, which hangs the
      // whole flow indefinitely (observed: SYL link-gen stuck for minutes right
      // after opening the profile, before any per-step timeout could fire). Race
      // it against a hard timer so a dead connect always fails fast and retries.
      return await Promise.race([
        chromium.connectOverCDP(cdpEndpoint, { timeout }),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`connectOverCDP hard timeout after ${timeout + 5000}ms`)), timeout + 5000)),
      ]);
    } catch (err) {
      lastError = err;
      const message = String(err.message || err);
      if (!/timeout|timed out|econnrefused|socket|closed|connectovercdp|websocket/i.test(message) || attempt >= attempts) throw err;
      logEvent("ixbrowser_cdp_connect_retry", {
        cdpEndpoint: oneLineField(cdpEndpoint, 160),
        attempt,
        attempts,
        error: oneLineField(message, 260),
      });
      await sleep(1500 * attempt);
    }
  }
  throw lastError || new Error("IXBrowser CDP connect failed.");
}

// Tracks SYL profiles (#40) with an active link-generation so the fire-and-forget
// warmup never re-opens — and thus closes — the dedicated browser mid-generation.
// That race produced "browserContext.newPage: ... has been closed" for every
// product + the retry looping the operator saw.
const __sylGenInFlightProfiles = new Set();
async function generateShopYourLikesExtensionLinks(body = {}) {
  requireExternalArmed();
  let state = readState();
  const dedicatedProfileId = dedicatedShopYourLikesIxProfileId(state);
  const profileId = Number(body.profileId || body.profile_id || dedicatedProfileId);
  const affiliateEnabled = state.affiliate?.enabled !== false;
  const requestedProductUrls = collectShopYourLikesProductUrls(body, state);
  if (!requestedProductUrls.length) {
    const err = new Error("No product URLs were supplied or saved for ShopYourLikes extension link generation.");
    err.statusCode = 400;
    err.publicError = "product_urls_required";
    throw err;
  }
  if (!affiliateEnabled) {
    const results = [];
    let shortened = 0;
    for (const productUrl of requestedProductUrls) {
      try {
        const m = await createMavlynkShortlink(productUrl);
        const shortUrl = m.shortUrl || "";
        if (shortUrl) shortened += 1;
        results.push({
          productUrl,
          sylLink: productUrl,
          shortUrl,
          success: true,
          reused: false,
          source: "affiliate_disabled_raw_walmart_via_mavlynk",
          rawShortlink: m.raw || null,
        });
      } catch (err) {
        results.push({ productUrl, success: false, error: oneLineField(err.message || String(err), 240) });
      }
    }
    state = readState();
    state.affiliate.lastExtensionRunAt = new Date().toISOString();
    state.affiliate.shortenAfterAffiliate = true;
    writeState(state);
    logEvent("shopyourlikes_extension_skipped_affiliate_disabled", {
      profileId: dedicatedProfileId || 0,
      requested: requestedProductUrls.length,
      shortened,
      mode: "raw_walmart_via_mavlynk",
    });
    return {
      state: readState(),
      profileId: dedicatedProfileId || 0,
      extensionId: "",
      windowsCdpFallback: false,
      sylGenerated: 0,
      sylReused: 0,
      shortened,
      results,
      mode: "affiliate_disabled_raw_walmart_via_mavlynk",
    };
  }
  if (!dedicatedProfileId) {
    const err = new Error("Save a dedicated ShopYourLikes IXBrowser profile before generating extension links.");
    err.statusCode = 400;
    err.publicError = "shopyourlikes_ix_profile_required";
    throw err;
  }
  if (profileId !== dedicatedProfileId) {
    const err = new Error(`ShopYourLikes link generation must use dedicated IXBrowser profile ${dedicatedProfileId}.`);
    err.statusCode = 409;
    err.publicError = "shopyourlikes_requires_dedicated_profile";
    throw err;
  }

  const shouldShorten = body.shortenAfter !== false;
  const forceFresh = body.forceFresh === true || body.force_fresh === true || body.force === true;
  const maxNewLinks = clampNumber(body.maxNewLinks || body.max_new_links || 0, 0, 500, 0);
  const results = [];
  const productUrls = [];
  if (!forceFresh) {
    for (const productUrl of requestedProductUrls) {
      const existing = existingShopYourLikesForProductUrl(productUrl, state);
      if (!existing?.sylLink) {
        productUrls.push(productUrl);
        continue;
      }
      let shortUrl = existing.shortUrl || "";
      let rawShortlink = null;
      let shortlinkError = "";
      if (shouldShorten && !shortUrl) {
        try {
          const shortened = await createMavlynkShortlink(existing.sylLink);
          shortUrl = shortened.shortUrl || "";
          rawShortlink = shortened.raw || null;
        } catch (err) {
          shortlinkError = err.message || String(err);
        }
      }
      results.push({
        productUrl: existing.productUrl || productUrl,
        sylLink: existing.sylLink,
        shortUrl,
        success: true,
        reused: true,
        source: existing.source || "existing_syl_mapping",
        ...(rawShortlink ? { rawShortlink } : {}),
        ...(shortlinkError ? { shortlinkError } : {}),
      });
    }
  } else {
    productUrls.push(...requestedProductUrls);
  }
  if (maxNewLinks && productUrls.length > maxNewLinks) {
    const skipped = productUrls.splice(maxNewLinks);
    skipped.forEach((productUrl) => {
      results.push({
        productUrl,
        success: false,
        skipped: true,
        error: `new_syl_generation_limited_to_${maxNewLinks}`,
      });
    });
  }

  let openResult = null;
  let browser;
  let usedWindowsCdpFallback = false;
  let sessionNotReady = false;
  try {
    if (productUrls.length) {
      __sylGenInFlightProfiles.add(profileId);
      logEvent("shopyourlikes_opening_profile", { profileId, generating: productUrls.length });
      openResult = await ixBrowserOpenForCdp(profileId, { reason: "shopyourlikes_extension_links" });
      try {
        browser = await connectIxBrowserCdpWithRetry(openResult.cdpEndpoint, { attempts: 1, timeout: 30000 });
      } catch (err) {
        logEvent("shopyourlikes_cdp_connect_failed_attempting_soft_recovery", {
          profileId,
          cdpEndpoint: oneLineField(openResult.cdpEndpoint, 160),
          error: oneLineField(err.message || String(err), 260),
        });
        // Soft recovery: invalidate the cached CDP endpoint and ask IXBrowser
        // for a fresh handle without closing the profile window. IXBrowser
        // returns the SAME open window's debug endpoint if the profile is
        // still alive, which keeps the SYL extension/login state intact and
        // saves the ~20-30s reopen cost.
        ixBrowserCdpEndpointCache.delete(profileId);
        writeIxBrowserCdpCacheFile();
        await sleep(1500);
        let softRecovered = false;
        try {
          openResult = await ixBrowserOpenForCdp(profileId, {
            reason: "shopyourlikes_cdp_soft_recovery",
            reuseOpenProfile: false,
            closeExistingBeforeOpen: false,
          });
          browser = await connectIxBrowserCdpWithRetry(openResult.cdpEndpoint, { attempts: 2, timeout: 45000 });
          softRecovered = true;
          logEvent("shopyourlikes_cdp_soft_recovery_ok", {
            profileId,
            cdpEndpoint: oneLineField(openResult.cdpEndpoint, 160),
          });
        } catch (softErr) {
          logEvent("shopyourlikes_cdp_soft_recovery_failed_falling_back_to_force_close", {
            profileId,
            error: oneLineField(softErr.message || String(softErr), 260),
          });
        }
        if (!softRecovered) {
          await ixBrowserForceCloseForRecovery(profileId, "shopyourlikes_cdp_connect_failed");
          await sleep(2000);
          openResult = await ixBrowserOpenForCdp(profileId, {
            reason: "shopyourlikes_extension_links_reopen_after_cdp_failure",
            reuseOpenProfile: false,
          });
          browser = await connectIxBrowserCdpWithRetry(openResult.cdpEndpoint, { attempts: 2, timeout: 45000 });
        }
      }
      const context = browser.contexts()[0] || await browser.newContext();
      for (const productUrl of productUrls) {
        let sylLink = "";
        try {
          sylLink = await generateShopYourLikesLinkInExtension(context, productUrl);
        } catch (err) {
          const failMessage = err?.message || String(err);
          results.push({ productUrl, success: false, error: failMessage });
          const sessionBroken = /retailer offline|retaileroffline|not logged in|sign in|signin|login required|did not expose a generated link/i.test(failMessage);
          logEvent("shopyourlikes_link_generation_failed", {
            profileId,
            productUrl: oneLineField(productUrl, 240),
            error: oneLineField(failMessage, 500),
            hint: /retailer offline|retaileroffline/i.test(failMessage)
              ? "ShopYourLikes extension says 'Retailer offline'. Open the dedicated SYL IXBrowser profile, log in/refresh, confirm Walmart is in the active-merchants list."
              : /not logged in|sign in|signin|login required/i.test(failMessage)
                ? "ShopYourLikes session expired. Open the dedicated SYL IXBrowser profile and log into ShopYourLikes again."
                : "",
          });
          // FAIL-FAST: a logged-out / "Retailer offline" extension fails identically
          // for every product. Stop the batch instead of spinning ~45s per remaining
          // product (that silent spin was misread as a box-level hang).
          if (sessionBroken) {
            sessionNotReady = true;
            logEvent("shopyourlikes_batch_aborted_session_not_ready", { profileId, remaining: productUrls.length - productUrls.indexOf(productUrl) - 1 });
            break;
          }
          continue;
        }
        // The SYL link IS generated now. Record it as success IMMEDIATELY — independent
        // of the Mavlynk shortening below — so it is persisted and NEVER regenerated.
        // The previous code discarded the SYL link whenever shortening threw, so every
        // product regenerated its link from scratch on each pass = the "shortlink in a
        // loop" bug. Shortening is a cheap API call the reuse path retries next time.
        let shortUrl = "";
        let rawShortlink = null;
        let shortlinkError = "";
        if (shouldShorten) {
          try {
            const shortened = await createMavlynkShortlink(sylLink);
            shortUrl = shortened.shortUrl;
            rawShortlink = shortened.raw;
          } catch (err) {
            shortlinkError = oneLineField(err?.message || String(err), 200);
            logEvent("shopyourlikes_shortlink_failed_syl_link_kept", { profileId, productUrl: oneLineField(productUrl, 200), error: shortlinkError });
          }
        }
        results.push({ productUrl, sylLink, shortUrl, success: true, rawShortlink, ...(shortlinkError ? { shortlinkError } : {}) });
      }
    }
  } catch (err) {
    if (!isWindowsLocalCdpConnectError(err)) throw err;
    usedWindowsCdpFallback = true;
    logEvent("shopyourlikes_extension_windows_cdp_fallback", {
      profileId,
      requested: requestedProductUrls.length,
      reused: results.filter((item) => item.reused).length,
      generating: productUrls.length,
      cdpEndpoint: oneLineField(openResult?.cdpEndpoint || "", 160),
      error: oneLineField(err.message || String(err), 240),
    });
    const fallback = await runWindowsShopYourLikesExtensionLinks(profileId, productUrls, { shortenAfter: shouldShorten, cdpEndpoint: openResult?.cdpEndpoint || "" });
    results.push(...(fallback.results || []));
  } finally {
    if (browser) await browser.close().catch(() => {});
    __sylGenInFlightProfiles.delete(profileId);
  }

  const sylSuccesses = results.filter((item) => item.success && item.sylLink);
  const shortlinkSuccesses = results.filter((item) => item.success && item.sylLink && item.shortUrl);
  if (sylSuccesses.length) {
    state = readState();
    state.affiliate.originalLinks = appendUniqueLines(state.affiliate.originalLinks, sylSuccesses.map((item) => item.productUrl));
    state.affiliate.shopyourlikesLinks = appendUniqueLines(state.affiliate.shopyourlikesLinks, sylSuccesses.map((item) => item.sylLink));
    if (shortlinkSuccesses.length) {
      const mappingResult = upsertAffiliateLinkMappings(state, shortlinkSuccesses.map((item) => ({
        productUrl: item.productUrl,
        sylLink: item.sylLink,
        shortUrl: item.shortUrl,
        source: "shopyourlikes_extension_then_mavlynk",
      })));
      state.posting.shortlinks = mappingResult.mappings.map((entry) => entry.shortUrl).join("\n");
    }
    state.affiliate.lastExtensionRunAt = new Date().toISOString();
    state.affiliate.shortenAfterAffiliate = shouldShorten;
    writeState(state);
  }
  logEvent("shopyourlikes_extension_links_generated", { profileId, requested: requestedProductUrls.length, reused: results.filter((item) => item.reused).length, generating: productUrls.length, generated: sylSuccesses.filter((item) => !item.reused).length, shortened: shortlinkSuccesses.length, windowsCdpFallback: usedWindowsCdpFallback });
  return { state: readState(), profileId, extensionId: SHOPYOURLIKES_EXTENSION_ID, windowsCdpFallback: usedWindowsCdpFallback, sessionNotReady, sylGenerated: sylSuccesses.filter((item) => !item.reused).length, sylReused: results.filter((item) => item.reused).length, shortened: shortlinkSuccesses.length, results };
}

async function ixBrowserOpenForCdp(profileId, options = {}) {
  const numericProfileId = Number(profileId);
  if (!numericProfileId) {
    const err = new Error("IXBrowser profile ID is required for browser discovery.");
    err.statusCode = 400;
    throw err;
  }
  return await withIxBrowserProfileOpenLock(numericProfileId, async () => {
    const cached = cachedIxBrowserCdpEndpoint(numericProfileId);
    const canReuseCachedProfile = isDedicatedShopYourLikesIxProfile(numericProfileId) || options.closeExistingBeforeOpen === false;
    if (canReuseCachedProfile && cached?.cdpEndpoint && options.reuseOpenProfile !== false && await isCachedCdpEndpointAlive(cached.cdpEndpoint)) {
      logEvent("ixbrowser_profile_cdp_reused", {
        profileId: numericProfileId,
        reason: oneLineField(options.reason || "cdp_open", 120),
      });
      return { result: { ...(cached.result || {}), reusedExistingWindow: true }, cdpEndpoint: cached.cdpEndpoint, reusedExistingWindow: true };
    }
    let preOpenClose = null;
    if (!isDedicatedShopYourLikesIxProfile(numericProfileId) && options.closeExistingBeforeOpen !== false) {
      preOpenClose = await ixBrowserCloseAfterUse(numericProfileId, options.preOpenCloseReason || "ixbrowser_preopen_cleanup");
      assertIxBrowserPreOpenCleanupOk(preOpenClose, numericProfileId, options.preOpenCloseReason || "ixbrowser_preopen_cleanup");
      await sleep(700);
    }
    const result = await ixBrowserRequest("profile-open", {
      profile_id: numericProfileId,
      args: ["--disable-popup-blocking"],
      load_extensions: true,
      cookies_backup: false,
      load_profile_info_page: false,
    });
    const cdpEndpoint = cacheIxBrowserCdpEndpoint(numericProfileId, result) || cdpEndpointFromIxOpenResult(result);
    return { result, cdpEndpoint, preOpenClose };
  });
}

async function ixBrowserCloseAfterUse(profileId, reason) {
  const numericProfileId = Number(profileId);
  if (!numericProfileId) return { ok: false, status: "profile_id_missing" };
  if (isDedicatedShopYourLikesIxProfile(numericProfileId)) {
    logEvent("ixbrowser_dedicated_shopyourlikes_kept_open", { profileId: numericProfileId, reason: oneLineField(reason || "completed", 120) });
    return { ok: true, status: "kept_open_dedicated_shopyourlikes_profile", profileId: numericProfileId };
  }
  ixBrowserCdpEndpointCache.delete(numericProfileId);
  writeIxBrowserCdpCacheFile();
  try {
    const result = await ixBrowserRequest("profile-close", { profile_id: numericProfileId });
    logEvent("ixbrowser_profile_closed_after_use", { profileId: numericProfileId, reason: oneLineField(reason || "completed", 120) });
    return { ok: true, status: "closed", profileId: numericProfileId, result };
  } catch (err) {
    if (isIxBrowserProfileAlreadyClosedError(err)) {
      logEvent("ixbrowser_profile_already_closed", {
        profileId: numericProfileId,
        reason: oneLineField(reason || "completed", 120),
        details: oneLineField(err.message || String(err), 160),
      });
      return { ok: true, status: "already_closed", profileId: numericProfileId, message: oneLineField(err.message || String(err), 160) };
    }
    logEvent("ixbrowser_profile_close_failed", {
      profileId: numericProfileId,
      reason: oneLineField(reason || "completed", 120),
      error: oneLineField(err.message || String(err), 240),
    });
    return { ok: false, status: "close_failed", profileId: numericProfileId, message: oneLineField(err.message || String(err), 240) };
  }
}

async function ixBrowserForceCloseForRecovery(profileId, reason) {
  const numericProfileId = Number(profileId);
  if (!numericProfileId) return { ok: false, status: "profile_id_missing" };
  ixBrowserCdpEndpointCache.delete(numericProfileId);
  writeIxBrowserCdpCacheFile();
  try {
    const result = await ixBrowserRequest("profile-close", { profile_id: numericProfileId });
    logEvent("ixbrowser_profile_force_closed_for_recovery", {
      profileId: numericProfileId,
      reason: oneLineField(reason || "cdp_recovery", 120),
    });
    return { ok: true, status: "closed", profileId: numericProfileId, result };
  } catch (err) {
    if (isIxBrowserProfileAlreadyClosedError(err)) {
      logEvent("ixbrowser_profile_force_close_already_closed", {
        profileId: numericProfileId,
        reason: oneLineField(reason || "cdp_recovery", 120),
        details: oneLineField(err.message || String(err), 160),
      });
      return { ok: true, status: "already_closed", profileId: numericProfileId };
    }
    logEvent("ixbrowser_profile_force_close_failed", {
      profileId: numericProfileId,
      reason: oneLineField(reason || "cdp_recovery", 120),
      error: oneLineField(err.message || String(err), 240),
    });
    return { ok: false, status: "close_failed", profileId: numericProfileId, error: err.message || String(err) };
  }
}

function dedicatedShopYourLikesIxProfileId(state = readState()) {
  const profileId = Number(state.affiliate?.dedicatedIxProfileId);
  return Number.isFinite(profileId) && profileId > 0 ? profileId : 0;
}

function isDedicatedShopYourLikesIxProfile(profileId, state = readState()) {
  const dedicatedProfileId = dedicatedShopYourLikesIxProfileId(state);
  return Boolean(dedicatedProfileId && Number(profileId) === dedicatedProfileId);
}

function isDedicatedShopYourLikesProfileLabel(label, state = readState()) {
  const clean = String(label || "").trim();
  if (!clean) return false;
  const lower = clean.toLowerCase();
  if (/shop\s*your\s*likes|shopyourlikes|sylikes/i.test(lower)) return true;
  const profileId = profileIdFromLabel(clean);
  if (profileId && isDedicatedShopYourLikesIxProfile(profileId, state)) return true;
  const name = String(state.affiliate?.dedicatedIxProfileName || "").trim().toLowerCase();
  return Boolean(name && lower.includes(name));
}

function blockedIxBrowserProfileLines(state = null) {
  const source = state?.ixbrowser?.blockedProfiles ?? readState().ixbrowser?.blockedProfiles ?? DEFAULT_BLOCKED_IXBROWSER_PROFILES;
  return recordLines(source)
    .map((line) => line.replace(/\s+#.*$/, "").trim())
    .filter(Boolean);
}

function blockedProfileIdFromLine(line) {
  const explicit = String(line || "").match(/\bprofile[_ -]?id\s*=\s*(\d{1,20})\b/i);
  if (explicit) return Number(explicit[1]);
  return profileIdFromLabel(line);
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isBlockedIxBrowserProfileLabel(label, state = null) {
  const clean = String(label || "").trim();
  if (!clean) return false;
  const profileId = profileIdFromLabel(clean);
  const lower = clean.toLowerCase();
  const namePart = lower.replace(/^\s*\d{1,20}\s*[-: ]\s*/, "").trim();
  for (const line of blockedIxBrowserProfileLines(state)) {
    const blockedId = blockedProfileIdFromLine(line);
    const blockedLower = line.toLowerCase();
    const blockedName = blockedLower.replace(/^\s*\d{1,20}\s*[-: ]\s*/, "").trim();
    if (blockedId && profileId && blockedId === profileId) return true;
    if (blockedLower === lower || (blockedName && blockedName === namePart)) return true;
    if (blockedName && new RegExp(`\\b${escapeRegExp(blockedName)}\\b`, "i").test(clean)) return true;
    if (!blockedId && blockedLower && new RegExp(`\\b${escapeRegExp(blockedLower)}\\b`, "i").test(clean)) return true;
  }
  return false;
}

function isFacebookAdminApprovalProfileLabel(label, state = readState(), groupUrl = "") {
  const clean = String(label || "").trim();
  if (!clean) return false;
  const profileId = profileIdFromLabel(clean);
  const lower = clean.toLowerCase();
  if (/\b(admin|administrator|moderator|mod|owner|approve|approval)\b/i.test(lower)) return true;
  const targetGroupKey = normalizedFacebookGroupKey(groupUrl);
  for (const source of [
    state.ixbrowser?.moderatorProfiles,
    state.posting?.ownedGroupsByProfile,
    state.posting?.moderatorAccountNotes,
  ]) {
    for (const line of recordLines(source)) {
      const lineProfileId = profileIdFromLabel(line);
      const sameProfile = profileId
        ? lineProfileId === profileId || new RegExp(`\\bprofile[_ -]?id\\s*=\\s*${profileId}\\b`, "i").test(line)
        : line.toLowerCase().includes(lower);
      if (!sameProfile) continue;
      if (targetGroupKey) {
        const lineGroupUrls = sanitizeFacebookGroupUrlList(line);
        if (lineGroupUrls.length && !lineGroupUrls.some((url) => normalizedFacebookGroupKey(url) === targetGroupKey)) continue;
      }
      if (/\b(role|status|source)\s*=\s*(admin|administrator|moderator|mod|owner|approve|approval|admin_approval)\b/i.test(line)) return true;
      if (/\b(admin|administrator|moderator|mod|owner|approve|approval)\b/i.test(line)) return true;
    }
  }
  return false;
}

function isFacebookAdminApprovalProfileId(profileId, state = readState(), groupUrl = "") {
  const numericProfileId = Number(profileId || 0);
  if (!numericProfileId) return false;
  return isFacebookAdminApprovalProfileLabel(String(numericProfileId), state, groupUrl);
}

function assertNotDedicatedShopYourLikesIxProfile(profileId, action) {
  if (!isDedicatedShopYourLikesIxProfile(profileId)) return;
  const err = new Error(`IXBrowser profile ${profileId} is reserved for ShopYourLikes/Mavlynk. It is not allowed for ${action}.`);
  err.statusCode = 409;
  err.publicError = "dedicated_shopyourlikes_profile_reserved";
  throw err;
}

function isWindowsLocalCdpConnectError(err) {
  return /connect ECONNREFUSED (?:127\.0\.0\.1|localhost):\d+/i.test(String(err?.message || err));
}

function windowsPathFromWslPath(filePath) {
  const normalized = path.resolve(filePath).replace(/\\/g, "/");
  const match = normalized.match(/^\/mnt\/([a-z])\/(.*)$/i);
  if (!match) return filePath;
  return `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, "\\")}`;
}

function powerShellSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function runWindowsShopYourLikesExtensionLinks(profileId, productUrls, options = {}) {
  const requestDir = path.join(DATA_DIR, "windows-syl-requests");
  fs.mkdirSync(requestDir, { recursive: true });
  const requestPath = path.join(requestDir, `request-${Date.now()}-${crypto.randomBytes(6).toString("hex")}.json`);
  fs.writeFileSync(requestPath, JSON.stringify({
    profileId: Number(profileId),
    productUrls,
    cdpEndpoint: options.cdpEndpoint || "",
    extensionId: SHOPYOURLIKES_EXTENSION_ID,
    shortenAfter: options.shortenAfter !== false,
  }, null, 2) + "\n");

  const powershell = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
  const command = [
    "Set-Location",
    powerShellSingleQuote(windowsPathFromWslPath(ROOT)),
    ";",
    "node",
    powerShellSingleQuote(".\\tools\\windows-shopyourlikes-extension-runner.js"),
    powerShellSingleQuote(windowsPathFromWslPath(requestPath)),
  ].join(" ");

  try {
    const { stdout, stderr } = await execFileAsync(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
      timeout: 180000,
      maxBuffer: 1024 * 1024 * 5,
      cwd: ROOT,
    });
    const resultLine = String(stdout || "").split(/\r?\n/).find((line) => line.startsWith("RESULT_JSON "));
    if (!resultLine) {
      const err = new Error(`Windows ShopYourLikes runner did not return RESULT_JSON. stdout=${oneLineField(stdout, 500)} stderr=${oneLineField(stderr, 500)}`);
      err.statusCode = 502;
      err.publicError = "windows_syl_runner_bad_output";
      throw err;
    }
    const result = JSON.parse(resultLine.slice("RESULT_JSON ".length));
    if (!result.success) {
      const err = new Error(result.error || "Windows ShopYourLikes runner failed.");
      err.statusCode = 502;
      err.publicError = "windows_syl_runner_failed";
      throw err;
    }
    return result;
  } finally {
    fs.unlink(requestPath, () => {});
  }
}

async function captureIxBrowserPage(profileId, options = {}) {
  let result;
  let cdpEndpoint;
  let browser;
  let navigationError = "";
  const releaseProfileUse = acquireNormalIxProfileUse(profileId, options.captureOnly ? "browser_capture_visible_page" : "browser_product_discovery");
  try {
    const openResult = await ixBrowserOpenForCdp(profileId, {
      closeExistingBeforeOpen: options.closeExistingBeforeOpen,
      reason: "browser_capture",
      preOpenCloseReason: "browser_capture_preopen_cleanup",
    });
    result = openResult.result;
    cdpEndpoint = openResult.cdpEndpoint;
    browser = await connectIxBrowserCdpWithRetry(cdpEndpoint, { attempts: 3, timeout: 60000 });
    const context = browser.contexts()[0] || await browser.newContext();
    const pages = context.pages().filter((page) => !page.isClosed());
    const page = pages[0] || await context.newPage();
    if (options.sourceUrl && !options.captureOnly) {
      try {
        await page.goto(options.sourceUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
      } catch (err) {
        navigationError = String(err.message || err).slice(0, 240);
      }
    }
    await page.waitForTimeout(options.settleMs || 2500);
    if (options.scrollForLazyLoad) {
      // Walmart review photos are lazy-loaded as you scroll. Scroll the whole page
      // in steps so the customer-photo thumbnails render into the DOM BEFORE we
      // snapshot — otherwise the html has 0 review images even on the real page.
      try {
        await page.evaluate(async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const step = Math.max(400, Math.floor((window.innerHeight || 800) * 0.85));
          let lastH = -1;
          for (let i = 0; i < 30; i += 1) {
            window.scrollTo(0, i * step);
            await sleep(450);
            const h = document.body ? document.body.scrollHeight : 0;
            if (i * step >= h && h === lastH) break;
            lastH = h;
          }
          window.scrollTo(0, document.body ? document.body.scrollHeight : 0);
          await sleep(1800);
          window.scrollTo(0, 0);
          await sleep(500);
        });
      } catch (_e) { /* best-effort lazy-load */ }
      await page.waitForTimeout(2000);
    }
    const snapshot = await page.evaluate(() => ({
      url: window.location.href,
      title: document.title || "",
      text: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 1200),
      html: document.documentElement?.outerHTML || "",
    }));
    return {
      ixOpenResult: result,
      cdpEndpoint,
      navigationError,
      ...snapshot,
    };
  } catch (err) {
    if (result && options.closeProfileOnError !== false) {
      await ixBrowserCloseAfterUse(profileId, "browser_capture_error");
    }
    throw err;
  } finally {
    if (browser) await browser.close({ reason: "facebook-agent-cdp-disconnect" }).catch(() => {});
    releaseProfileUse();
  }
}

async function runIxBrowserProductDiscovery(body = {}) {
  requireExternalArmed();
  const state = readState();
  if (!state.productDiscovery?.enabled) {
    const err = new Error("Product discovery is disabled.");
    err.statusCode = 409;
    throw err;
  }
  const profileId = body.profileId || body.profile_id;
  const captureOnly = Boolean(body.captureOnly);
  const sourceUrl = captureOnly
    ? assertAllowedDiscoveryPageUrl(body.sourceUrl || "", state, { allowBlank: true })
    : assertAllowedDiscoveryPageUrl(body.sourceUrl || firstDiscoverySourceUrl(state), state);
  const snapshot = await captureIxBrowserPage(profileId, { sourceUrl, captureOnly, closeExistingBeforeOpen: !captureOnly });
  const currentUrl = assertAllowedDiscoveryPageUrl(snapshot.url, state);
  const antiBot = isAntiBotHtml(snapshot.html) || /robot or human|captcha|verify you are human/i.test(`${snapshot.title} ${snapshot.text}`);
  if (antiBot) {
    logEvent("browser_discovery_needs_human_verification", { profileId, sourceUrl: sourceUrl || currentUrl });
    return {
      state: readState(),
      registers: readRegisters(),
      status: "needs_human_verification",
      profileId,
      sourceUrl: sourceUrl || currentUrl,
      currentUrl,
      title: snapshot.title,
      message: "IXBrowser opened the page, but Walmart is showing human verification. Solve it manually in the opened profile, then click Capture Visible Page.",
      navigationError: snapshot.navigationError,
      ixProfileClose: { ok: false, status: "left_open_for_manual_verification", profileId },
      discovered: 0,
      reviewImageCandidates: 0,
    };
  }
  const registers = readRegisters();
  const products = extractProductLinks(snapshot.html, currentUrl || sourceUrl, state);
  const selectedProduct = canonicalProduct(currentUrl || sourceUrl, state);
  if (selectedProduct) {
    products.unshift({
      ...selectedProduct,
      title: safeText(snapshot.title || selectedProduct.title, 300),
      discoveryMethod: "selected_product_page",
    });
  }
  const target = clampNumber(state.productDiscovery?.targetCandidateCount, 1, 500, 100);
  const discoveryRunAt = new Date().toISOString();
  const discovered = mergeDiscoveredProductsIntoState(state, registers, products, {
    sourceUrl: currentUrl || sourceUrl,
    target,
    parser: "ixbrowser_cdp_cheerio",
    discoveryRunAt,
  });
  const imageCandidates = extractReviewImageCandidates(snapshot.html, currentUrl || sourceUrl, state, products);
  if (imageCandidates.length) {
    state.productAssets.reviewImageCandidates = mergeReviewImageCandidateLines(state.productAssets.reviewImageCandidates, imageCandidates);
    appendApprovalLine(registers, `${new Date().toISOString()} | type=review_image_candidates | status=pending | candidate_count=${imageCandidates.length} | source=${currentUrl || sourceUrl} | reason=approve positive-review image candidates before JPG/PNG conversion/upload`);
    writeRegisters(registers);
  }
  if (discovered.length) {
    state.productDiscovery.lastRunAt = discoveryRunAt;
    state.productDiscovery.lastRunStatus = "browser_discovery_saved";
    state.productDiscovery.lastRunParser = "ixbrowser_cdp_cheerio";
    state.productDiscovery.lastRunCandidateCount = discovered.length;
    state.productDiscovery.lastRunNewCandidateCount = discovered.length;
    state.productDiscovery.lastRunRefreshedCandidateCount = 0;
    state.productDiscovery.lastSuccessfulRunAt = discoveryRunAt;
  }
  const nextState = writeState(state);
  if (discovered.length) {
    appendApprovalLine(registers, `${new Date().toISOString()} | type=browser_product_discovery | status=pending | candidate_count=${discovered.length} | source=${currentUrl || sourceUrl} | reason=review IXBrowser-captured product candidates before asset/post planning`);
    writeRegisters(registers);
  }
  logEvent("browser_product_discovery_completed", {
    profileId,
    discovered: discovered.length,
    reviewImageCandidates: imageCandidates.length,
    captureOnly,
  });
  const ixProfileClose = body.closeProfileAfterUse === false
    ? { ok: false, status: "left_open_by_request", profileId }
    : await ixBrowserCloseAfterUse(profileId, "browser_product_discovery_completed");
  return {
    state: nextState,
    registers: readRegisters(),
    status: "captured",
    profileId,
    ixProfileClose,
    sourceUrl: sourceUrl || currentUrl,
    currentUrl,
    title: snapshot.title,
    parser: "ixbrowser_cdp_cheerio",
    discovered: discovered.length,
    reviewImageCandidates: imageCandidates.length,
    candidates: discovered.slice(0, 50),
    imageCandidates: imageCandidates.slice(0, 50),
    navigationError: snapshot.navigationError,
    message: discovered.length || imageCandidates.length
      ? "Captured visible browser page and saved candidates for review."
      : "Captured visible browser page, but no product links or positive-review image candidates were visible.",
  };
}

function randomInt(min, max) {
  const low = Math.ceil(Math.min(min, max));
  const high = Math.floor(Math.max(min, max));
  return Math.floor(Math.random() * (high - low + 1)) + low;
}

function shuffledCopy(items = []) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(0, index);
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function postingSlots(state) {
  const slots = [];
  const postsPerProfile = clampNumber(state.rules.postsPerProfilePerDay, 1, 20, 5);
  const maxProfilesPerRun = clampNumber(state.ixbrowser?.maxProfilesPerRun, 1, 1000000, 100000);
  const groups = Array.isArray(state.posting?.groupAssignmentData) ? state.posting.groupAssignmentData : [];
  // FRESH-FIRST coverage: order each group's profiles by least-posted-today then least-lifetime BEFORE
  // emitting slots, so the LOW slot indexes (which the plan fills first when products/scarce per-index
  // assets are limited) go to the freshest/rested profiles — not the raw groupAssignmentData order
  // (which lists heavily-used profiles first and starved fresh ones of ready rows). Ledger maps are
  // computed ONCE here (NOT per slot). __cnt is key-type robust (number or string profileId keys).
  const __todayByPid = (autopilotPublishedTodayByProfile(state).byProfile) || new Map();
  const __histByPid = autopilotPostHistoryByProfile();
  const __cnt = (m, label) => { const pid = profileIdFromLabel(label); return m.get(pid) || m.get(String(pid)) || 0; };
  const orderFreshFirst = (profiles) => (Array.isArray(profiles) ? profiles : []).map((p, i) => ({ p, i })).sort((a, b) => {
    const ta = __cnt(__todayByPid, a.p), tb = __cnt(__todayByPid, b.p);
    if (ta !== tb) return ta - tb;
    const ha = __cnt(__histByPid, a.p), hb = __cnt(__histByPid, b.p);
    if (ha !== hb) return ha - hb;
    return a.i - b.i;
  }).map((x) => x.p);
  // Memoize per distinct profiles array (once per group) so the sort isn't recomputed for every
  // postNumber round — matters at 3000 profiles × many post-rounds.
  const __freshOrderMemo = new Map();
  const orderFreshFirstCached = (profiles) => {
    if (__freshOrderMemo.has(profiles)) return __freshOrderMemo.get(profiles);
    const ordered = orderFreshFirst(profiles);
    __freshOrderMemo.set(profiles, ordered);
    return ordered;
  };
  const allGroupUrls = [
    ...groups.map((group) => String(group.url || "").trim()),
    ...recordLines(state.posting?.groups),
  ].filter(Boolean);
  const normalProfileKeys = new Set();
  const seenSlots = new Set();
  for (let postNumber = 1; postNumber <= postsPerProfile; postNumber += 1) {
    for (const group of groups) {
      const groupUrl = String(group.url || "").trim();
      if (!groupUrl) continue;
      for (const profile of orderFreshFirstCached(group.profiles)) {
        const label = String(profile || "").trim();
        if (!label) continue;
        const profileId = profileIdFromLabel(label);
        if (isDedicatedShopYourLikesProfileLabel(label, state)) continue;
        if (isBlockedIxBrowserProfileLabel(label, state)) continue;
        if (isFacebookProfileQuarantinedForFacebook(label, state, groupUrl)) continue;
        if (isFacebookAdminApprovalProfileLabel(label, state, groupUrl)) continue;
        if (isProfileBlockedForPosting(label, state, groupUrl)) continue;
        let effectiveGroupUrl = groupUrl;
        if (isProfileGroupBlockedForPosting(label, groupUrl, state)) {
          effectiveGroupUrl = allGroupUrls.find((candidateGroupUrl) => {
            if (normalizedFacebookGroupKey(candidateGroupUrl) === normalizedFacebookGroupKey(groupUrl)) return false;
            return !isProfileGroupBlockedForPosting(label, candidateGroupUrl, state);
          }) || "";
          if (!effectiveGroupUrl) continue;
          if (isBlockedIxBrowserProfileLabel(label, state)) continue;
          if (isFacebookProfileQuarantinedForFacebook(label, state, effectiveGroupUrl)) continue;
          if (isFacebookAdminApprovalProfileLabel(label, state, effectiveGroupUrl)) continue;
        }
        const profileKey = profileKeyFromLabel(label);
        if (!normalProfileKeys.has(profileKey)) {
          if (normalProfileKeys.size >= maxProfilesPerRun) continue;
          normalProfileKeys.add(profileKey);
        }
        const slotKey = `${postNumber}|${profileKey}|${normalizedFacebookGroupKey(effectiveGroupUrl)}`;
        if (seenSlots.has(slotKey)) continue;
        seenSlots.add(slotKey);
        slots.push({ groupUrl: effectiveGroupUrl, assignedGroupUrl: groupUrl, profile: label, profileKey, profileId, postNumber });
      }
    }
  }
  return slots;
}

function excludedProfileIdSetFromOptions(options = {}) {
  return new Set([
    ...(Array.isArray(options.excludeProfileIds) ? options.excludeProfileIds : []),
    ...(Array.isArray(options.exclude_profile_ids) ? options.exclude_profile_ids : []),
    options.excludeProfileId,
    options.exclude_profile_id,
  ].map((value) => Number(value || 0)).filter(Boolean));
}

function filterExcludedProfileSlots(slots = [], options = {}) {
  const excludedIds = excludedProfileIdSetFromOptions(options);
  if (!excludedIds.size) return slots;
  return slots.filter((slot) => {
    const profileId = Number(slot?.profileId || profileIdFromLabel(slot?.profile) || 0);
    return !profileId || !excludedIds.has(profileId);
  });
}

function statusLineAppliesToFacebookGroup(line, groupUrl) {
  const targetGroupKey = normalizedFacebookGroupKey(groupUrl);
  if (!targetGroupKey) return true;
  const lineGroupUrls = sanitizeFacebookGroupUrlList(line);
  if (!lineGroupUrls.length) return true;
  return lineGroupUrls.some((url) => normalizedFacebookGroupKey(url) === targetGroupKey);
}

function isProfileBlockedForPosting(label, state, groupUrl = "") {
  const text = String(label || "").trim();
  if (!text) return false;
  if (isFacebookProfileQuarantinedForFacebook(text, state, groupUrl)) return true;
  const lowerLabel = text.toLowerCase();
  const profileId = profileIdFromLabel(text);
  const sources = [
    state.posting?.facebookProfileStatus,
    state.ixbrowser?.failedProfiles,
  ].join("\n").toLowerCase().split(/\r?\n/);
  const matching = sources.filter((line) => {
    if (!/status=(cannot_comment|cannot_post_in_any_group|resolved|approved|cleared|ignored)|action=(quarantined|skip_profile|profile_unblocked|profile_group_unblocked)/i.test(line)) return false;
    if (!statusLineAppliesToFacebookGroup(line, groupUrl)) return false;
    if (profileId && line.includes(`profile_id=${profileId}`)) return true;
    return lowerLabel.length > 2 && line.includes(lowerLabel);
  });
  const latest = matching[matching.length - 1] || "";
  if (!latest) return false;
  if (/status=(resolved|approved|cleared|ignored)|action=(profile_unblocked|profile_group_unblocked)/i.test(latest)) return false;
  if (isTransientPostingProfileFailureLine(latest)) return false;
  if (postingFailureLineExceededAgeBudget(latest)) return false;
  return /status=(cannot_comment|cannot_post_in_any_group)|action=quarantined|skip_profile/i.test(latest);
}

function isFacebookProfileQuarantinedForFacebook(label, state = readState(), groupUrl = "") {
  const text = String(label || "").trim();
  if (!text) return false;
  const lowerLabel = text.toLowerCase();
  const profileId = profileIdFromLabel(text);
  const sources = [
    state.posting?.facebookProfileStatus,
    state.ixbrowser?.failedProfiles,
  ].join("\n").toLowerCase().split(/\r?\n/);
  const matching = sources.filter((line) => {
    if (!/status=(facebook_account_suspended_or_disabled|facebook_account_blocked_or_review_required|facebook_account_disabled|facebook_account_suspended|facebook_account_locked|cannot_use_facebook|cannot_comment|resolved|approved|cleared|ignored)|issue=(facebook_account_status|account_unusable|account_hard_blocked)|action=(quarantined|skip_ixbrowser_profile_for_facebook|profile_unblocked|profile_group_unblocked)/i.test(line)) return false;
    if (!statusLineAppliesToFacebookGroup(line, groupUrl)) return false;
    if (profileId && line.includes(`profile_id=${profileId}`)) return true;
    return lowerLabel.length > 2 && line.includes(lowerLabel);
  });
  const latest = matching[matching.length - 1] || "";
  if (!latest) return false;
  if (/status=(resolved|approved|cleared|ignored)|action=(profile_unblocked|profile_group_unblocked)/i.test(latest)) return false;
  return /status=(facebook_account_suspended_or_disabled|facebook_account_blocked_or_review_required|facebook_account_disabled|facebook_account_suspended|facebook_account_locked|cannot_use_facebook|cannot_comment)|issue=(facebook_account_status|account_unusable|account_hard_blocked)|action=(quarantined|skip_ixbrowser_profile_for_facebook)/i.test(latest);
}

function isTransientPostingProfileFailureLine(line = "") {
  const text = String(line || "").toLowerCase();
  if (!text) return false;
  if (/status=(facebook_account_suspended_or_disabled|facebook_account_blocked_or_review_required|facebook_account_disabled|facebook_account_suspended|facebook_account_locked|cannot_use_facebook|cannot_comment)|issue=(facebook_account_status|account_unusable|account_hard_blocked)|action=(quarantined|skip_ixbrowser_profile_for_facebook)|reason=(not allowed to post|not a member|join group|content isn't available|content is not available|checkpoint|two[- ]factor|account[_ ](?:suspended|disabled|locked|review))/i.test(text)) {
    return false;
  }
  return /reason=(image_upload_not_confirmed|automation_image_confirmation_false_negative)|could not open composer|composer not found|facebook[_ ]login[_ ]required|facebook_login_required_for_profile|ixbrowser[_ ]login[_ ]required|ixbrowser.*(?:profile-open|timeout|timed out|connectovercdp|target page|browser has been closed|process not found|error 1009)|preopen[_ ]cleanup|permalink[_ ]not[_ ](?:captured|verified)|facebook_post_(?:permalink_not_captured|marker_permalink_not_verified)|connector[_ ]timed?[_ ]out|connector[_ ]failed|no permalink was captured|not verified after clicking post/i.test(text);
}

const PROFILE_FAILURE_STICKY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PROFILE_TRANSIENT_FAILURE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const PROFILE_COMMENT_FAILURE_MAX_AGE_MS = 45 * 60 * 1000;

// A profile whose ONLY failure was first-comment verification (the POST actually published) gets a SHORT
// graduated cooldown — long enough for the tick to move on to fresh profiles, but NOT the full 24h sticky
// block (the post succeeded). NARROW: requires status=cannot_post_in_group AND a comment-verification
// reason, so it never shortens the cooldown for genuine cannot_post / suspended / member-block lines.
function isCommentVerificationFailureLine(line = "") {
  const text = String(line || "").toLowerCase();
  if (!/status=cannot_post_in_group/i.test(text)) return false;
  return /required first comment was not verified|comment was not verified|comment_blocked:|comment_target_unavailable_or_pending|comment_profile_cannot_access_post_permalink|marker_scoped_comment_button_not_found/i.test(text);
}

function recordLineAgeMs(line) {
  const match = String(line || "").match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/);
  if (!match) return Number.POSITIVE_INFINITY;
  const at = Date.parse(match[1]);
  if (!Number.isFinite(at)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Date.now() - at);
}

function postingFailureLineExceededAgeBudget(line) {
  const ageMs = recordLineAgeMs(line);
  if (!Number.isFinite(ageMs)) return false;
  // Comment-verification-only failure (the post DID publish) → SHORT 45-min cooldown, checked FIRST, so
  // the tick skips the profile briefly then lets it back — instead of a 24h sticky block for a post that
  // actually worked (the cause of the p51 over-block + re-pick storm).
  if (isCommentVerificationFailureLine(line)) return ageMs > PROFILE_COMMENT_FAILURE_MAX_AGE_MS;
  if (isTransientPostingProfileFailureLine(line)) return ageMs > PROFILE_TRANSIENT_FAILURE_MAX_AGE_MS;
  return ageMs > PROFILE_FAILURE_STICKY_MAX_AGE_MS;
}

function normalizedFacebookGroupKey(value) {
  return String(value || "").trim().toLowerCase().replace(/[?#].*$/g, "").replace(/\/+$/g, "");
}

function isProfileGroupBlockedForPosting(label, groupUrl, state) {
  const text = String(label || "").trim();
  const groupKey = normalizedFacebookGroupKey(groupUrl);
  if (!text || !groupKey) return false;
  const lowerLabel = text.toLowerCase();
  const profileId = profileIdFromLabel(text);
  const sources = [
    state.posting?.facebookProfileStatus,
    state.ixbrowser?.failedProfiles,
  ].join("\n").toLowerCase().split(/\r?\n/);
  const matching = sources.filter((line) => {
    if (!/status=(cannot_post_in_group|resolved|approved|cleared|ignored)|action=(profile_unblocked|profile_group_unblocked)/i.test(line)) return false;
    const lineGroup = normalizedFacebookGroupKey((line.match(/group_url=([^|]+)/i) || [])[1] || "");
    if (lineGroup !== groupKey) return false;
    if (profileId && line.includes(`profile_id=${profileId}`)) return true;
    return lowerLabel.length > 2 && line.includes(lowerLabel);
  });
  const latest = matching[matching.length - 1] || "";
  if (!latest) return false;
  if (/status=(resolved|approved|cleared|ignored)|action=(profile_unblocked|profile_group_unblocked)/i.test(latest)) return false;
  if (isTransientPostingProfileFailureLine(latest)) return false;
  if (postingFailureLineExceededAgeBudget(latest)) return false;
  return /status=cannot_post_in_group/i.test(latest);
}

function fallbackGroupUrlsForSlot(slot, state) {
  const urls = [];
  const seen = new Set();
  const add = (value) => {
    const clean = String(value || "").trim();
    if (!clean) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    urls.push(clean);
  };
  for (const entry of Array.isArray(state.posting?.groupAssignmentData) ? state.posting.groupAssignmentData : []) {
    add(entry?.url);
  }
  recordLines(state.posting?.groups).forEach(add);
  return urls
    .filter((groupUrl) => groupUrl !== slot.groupUrl)
    .filter((groupUrl) => !isProfileGroupBlockedForPosting(slot.profile, groupUrl, state))
    .slice(0, 20);
}

function concurrencyBatchForSlot(slot, state) {
  const maxConcurrentProfiles = clampNumber(
    state.ixbrowser?.maxConcurrentProfiles,
    1,
    MAX_CONCURRENT_NORMAL_IX_PROFILES,
    MAX_CONCURRENT_NORMAL_IX_PROFILES
  );
  const profileIndex = Math.max(0, Number(slot.profileRunIndex || 0));
  return {
    maxConcurrentProfiles,
    concurrencyBatch: Math.floor(profileIndex / maxConcurrentProfiles) + 1,
    concurrencySlot: (profileIndex % maxConcurrentProfiles) + 1,
  };
}

function assignProfileRunIndexes(slots) {
  const profileIndexes = new Map();
  let nextIndex = 0;
  return slots.map((slot) => {
    const key = slot.profileKey || profileKeyFromLabel(slot.profile);
    if (!profileIndexes.has(key)) {
      profileIndexes.set(key, nextIndex);
      nextIndex += 1;
    }
    return { ...slot, profileRunIndex: profileIndexes.get(key) };
  });
}

function legacyPostingSlots(state) {
  const slots = [];
  const postsPerProfile = clampNumber(state.rules.postsPerProfilePerDay, 1, 20, 5);
  const groups = Array.isArray(state.posting?.groupAssignmentData) ? state.posting.groupAssignmentData : [];
  for (const group of groups) {
    const groupUrl = String(group.url || "").trim();
    if (!groupUrl) continue;
    for (const profile of Array.isArray(group.profiles) ? group.profiles : []) {
      const label = String(profile || "").trim();
      if (!label) continue;
      for (let postNumber = 1; postNumber <= postsPerProfile; postNumber += 1) {
        slots.push({ groupUrl, profile: label, postNumber });
      }
    }
  }
  return slots;
}

function selectedReviewImageLines(state) {
  const lines = recordLines(state.productAssets?.selectedReviewImages);
  return lines.map((line) => {
    const parts = String(line || "").split("|").map((part) => part.trim());
    const fields = recordFieldsFromLine(line);
    const facebookImagePath = parts.find((part) => /(?:^|[\/])[^|]+\.(?:jpe?g|png)$/i.test(part)) || "";
    const legacyWebpPath = parts.find((part) => /(?:^|[\/])[^|]+\.webp$/i.test(part)) || "";
    const imageUrl = parts.find((part) => /^https?:\/\/[^\s|]+\.(?:jpe?g|png|webp)(?:[?#].*)?$/i.test(part)) || "";
    const productUrl = parts.find((part) => /^https?:\/\/[^\s|]*\/(?:ip|dp|p)\//i.test(part)) || sourceLineUrl(line);
    const status = reviewImageApprovalStatus(line, parts);
    const productId = fields.product_id || fields.productId || "";
    const retailer = fields.retailer || "";
    const productKey = fields.product_key || (productId && retailer ? `${retailer}:${productId}` : "");
    return {
      raw: facebookImagePath || imageUrl || legacyWebpPath || line,
      url: productUrl,
      productKey,
      imagePath: facebookImagePath,
      legacyWebpPath,
      imageUrl,
      status,
      approved: isApprovedReviewImageStatus(status) && Boolean(facebookImagePath),
    };
  });
}

function reviewImageApprovalStatus(line, parts = []) {
  const fields = recordFieldsFromLine(line);
  if (fields.status) return fields.status.trim().toLowerCase();
  const statusPart = parts.find((part) => /^(approved|human_approved|selected_(?:webp|image)_approved|approved_for_posting|selected_(?:webp|image)_ready_pending_human_approval|pending|rejected|failed)/i.test(part));
  return statusPart ? statusPart.trim().toLowerCase() : "approval_status_missing";
}

function isApprovedReviewImageStatus(status) {
  const normalized = String(status || "").toLowerCase();
  if (!normalized || /pending|reject|denied|fail|needs/.test(normalized)) return false;
  return /(^|[_-])approved($|[_-])|human_approved|approved_for_posting|selected_(?:webp|image)_approved/.test(normalized);
}

function rotationValue(lines, cursor, index, avoidReuse) {
  if (!lines.length) return "";
  const offset = clampNumber(cursor, 0, 100000, 0) + index;
  if (avoidReuse && offset >= lines.length) return "";
  return lines[offset % lines.length] || "";
}

function reviewImageForProduct(reviewImages, product) {
  const productKey = String(product?.key || "").toLowerCase();
  const productUrl = String(product?.url || "").toLowerCase();
  return reviewImages.find((image) => String(image.productKey || "").toLowerCase() === productKey)
    || reviewImages.find((image) => String(image.url || "").toLowerCase() === productUrl)
    || null;
}

function linkForProductAtIndex(product, productIndex, products, state) {
  const affiliateEnabled = state.affiliate?.enabled !== false;
  const mappedAffiliate = affiliateShortlinkForProduct(product, state);
  if (mappedAffiliate.shortUrl) return mappedAffiliate.shortUrl;
  if (affiliateEnabled) return "";

  const finalShortlinks = recordLines(state.affiliate?.finalShortlinks);
  const postingShortlinks = recordLines(state.posting?.shortlinks);
  const shortlinks = finalShortlinks.length ? finalShortlinks : postingShortlinks;
  if (!shortlinks.length) return "";

  const originalLinks = recordLines(state.affiliate?.originalLinks);
  for (let index = 0; index < originalLinks.length && index < shortlinks.length; index += 1) {
    const originalProduct = canonicalProduct(originalLinks[index], state);
    if (originalProduct?.key && originalProduct.key === product.key) return shortlinks[index] || "";
  }

  const productPosition = products.findIndex((candidate) => candidate.key === product.key);
  if (productPosition >= 0 && shortlinks[productPosition]) return shortlinks[productPosition];
  return shortlinks[productIndex] || "";
}

function isShopYourLikesUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    const host = url.hostname.toLowerCase();
    return host === "go.sylikes.com" || host.endsWith(".sylikes.com") || host === "sylikes.com" || host.endsWith(".shopyourlikes.com") || host === "shopyourlikes.com";
  } catch {
    return false;
  }
}

function isMavlynkShortUrl(value) {
  try {
    return ALLOWED_MAVLYNK_HOSTS.has(new URL(String(value || "").trim()).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function normalizeAffiliateLinkMapping(entry, state) {
  const product = canonicalProduct(entry?.productUrl || entry?.originalProductUrl || entry?.originalUrl || "", state);
  const sylLink = String(entry?.sylLink || entry?.shopYourLikesUrl || entry?.shopyourlikesUrl || "").trim();
  const shortUrl = String(entry?.shortUrl || entry?.mavlynkUrl || entry?.finalShortlink || "").trim();
  if (!product || !isShopYourLikesUrl(sylLink) || !isMavlynkShortUrl(shortUrl)) return null;
  return {
    productUrl: product.url,
    productKey: product.key,
    productId: product.productId,
    retailer: product.store,
    sylLink,
    shortUrl,
    updatedAt: String(entry?.updatedAt || "").trim() || "1970-01-01T00:00:00.000Z",
    source: String(entry?.source || "shopyourlikes_then_mavlynk").slice(0, 80),
  };
}

function affiliateLinkMappings(state) {
  return (Array.isArray(state.affiliate?.linkMappings) ? state.affiliate.linkMappings : [])
    .map((entry) => normalizeAffiliateLinkMapping(entry, state))
    .filter(Boolean);
}

function affiliateProductUrlForSylLink(sylLink, state) {
  const normalizedSyl = normalizeUrlForComparison(sylLink);
  const mapped = affiliateLinkMappings(state).find((entry) => normalizeUrlForComparison(entry.sylLink) === normalizedSyl);
  if (mapped?.productUrl) return mapped.productUrl;

  const sylLinks = recordLines(state.affiliate?.shopyourlikesLinks);
  const originalLinks = recordLines(state.affiliate?.originalLinks);
  const index = sylLinks.findIndex((line) => normalizeUrlForComparison(line) === normalizedSyl);
  return index >= 0 ? (originalLinks[index] || "") : "";
}

function upsertAffiliateLinkMappings(state, entries = []) {
  if (!state.affiliate) state.affiliate = {};
  const current = affiliateLinkMappings(state);
  const byProductKey = new Map(current.map((entry) => [entry.productKey.toLowerCase(), entry]));
  let saved = 0;
  let skipped = 0;
  for (const entry of entries) {
    const mapped = normalizeAffiliateLinkMapping(entry, state);
    if (!mapped) {
      skipped += 1;
      continue;
    }
    byProductKey.set(mapped.productKey.toLowerCase(), {
      ...byProductKey.get(mapped.productKey.toLowerCase()),
      ...mapped,
      updatedAt: new Date().toISOString(),
    });
    saved += 1;
  }

  const originalOrder = recordLines(state.affiliate.originalLinks)
    .map((line) => canonicalProduct(line, state)?.key?.toLowerCase())
    .filter(Boolean);
  const orderIndex = (entry) => {
    const index = originalOrder.indexOf(entry.productKey.toLowerCase());
    return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
  };
  const mappings = [...byProductKey.values()].sort((left, right) => {
    const leftIndex = orderIndex(left);
    const rightIndex = orderIndex(right);
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    return left.productKey.localeCompare(right.productKey);
  });
  state.affiliate.linkMappings = mappings;
  state.affiliate.originalLinks = appendUniqueLines(state.affiliate.originalLinks, mappings.map((entry) => entry.productUrl));
  state.affiliate.shopyourlikesLinks = appendUniqueLines(state.affiliate.shopyourlikesLinks, mappings.map((entry) => entry.sylLink));
  state.affiliate.finalShortlinks = mappings.map((entry) => entry.shortUrl).join("\n");
  return { saved, skipped, mappings };
}

function affiliateShortlinkForProduct(product, state) {
  const productKey = String(product?.key || "").toLowerCase();
  if (!productKey) return { productUrl: "", sylLink: "", shortUrl: "", index: -1 };
  const mapped = affiliateLinkMappings(state).find((entry) => entry.productKey.toLowerCase() === productKey);
  if (mapped) return { ...mapped, index: affiliateLinkMappings(state).findIndex((entry) => entry.productKey.toLowerCase() === productKey) };
  return { productUrl: "", sylLink: "", shortUrl: "", index: -1 };
}

function legacyAffiliateShortlinkForProduct(product, state) {
  const originalLinks = recordLines(state.affiliate?.originalLinks);
  const sylLinks = recordLines(state.affiliate?.shopyourlikesLinks);
  const finalShortlinks = recordLines(state.affiliate?.finalShortlinks);
  const limit = Math.min(originalLinks.length, sylLinks.length, finalShortlinks.length);
  for (let index = 0; index < limit; index += 1) {
    const originalProduct = canonicalProduct(originalLinks[index], state);
    if (!originalProduct?.key || originalProduct.key !== product.key) continue;
    const sylLink = sylLinks[index] || "";
    const shortUrl = finalShortlinks[index] || "";
    if (!isShopYourLikesUrl(sylLink) || !isMavlynkShortUrl(shortUrl)) continue;
    return {
      productUrl: originalLinks[index],
      sylLink,
      shortUrl,
      index,
    };
  }
  return { productUrl: "", sylLink: "", shortUrl: "", index: -1 };
}

// ---- Stage 2: look-ahead asset buffer -----------------------------------
// "Buffer-ready" = a product whose Facebook assets are fully prepared AHEAD of
// posting: an APPROVED local HD/base review image (JPG/PNG) plus a final
// SYL+Mavlynk shortlink. Post text + comment lead-in come from the rotation
// pools (always available). A full buffer means posting (prod AND test) never
// waits on ChatGPT HD or ShopYourLikes.
function assetBufferTargetCount(state = readState()) {
  const explicit = clampNumber(state.productDiscovery?.assetBufferTarget, 0, 500, 0);
  if (explicit) return explicit;
  // Auto: keep ~a day's worth of posts ready (unique profiles x posts/profile).
  // Floor at 9 so there is ALWAYS a standing reserve of >=9 ready products (matches the
  // "9 by 9" batch unit + the ChatGPT-HD per-conversation limit), so posting never waits
  // on image-gen and leftover reserve survives past the window close for the next night.
  const profiles = new Set(filterExcludedProfileSlots(postingSlots(state), {}).map((slot) => slot.profileKey)).size || 1;
  const perProfile = clampNumber(state.rules?.postsPerProfilePerDay, 1, 20, 5);
  return Math.max(9, Math.min(200, profiles * perProfile));
}

function productHasReadyAssets(product, state = readState(), reviewImages = null) {
  if (!product) return false;
  // HARVESTED products: ready when the record has its downloaded image (still on disk) + the first-comment
  // link, and it has NOT been posted yet. No ShopYourLikes shortlink needed (link = the harvested url).
  if (String(product.key || "").startsWith("harvested:")) {
    const rec = harvestedRecordForKey(product.key, state);
    return Boolean(rec && !rec.posted && rec.firstCommentUrl && rec.imageLocalPath && fs.existsSync(safeProjectPath(rec.imageLocalPath)));
  }
  const images = reviewImages || selectedReviewImageLines(state);
  const image = reviewImageForProduct(images, product);
  if (!image || !image.approved) return false;
  const shortUrl = affiliateShortlinkForProduct(product, state).shortUrl;
  return Boolean(shortUrl && isMavlynkShortUrl(shortUrl));
}

function assetBufferStatus(state = readState(), registers = readRegisters()) {
  const reviewImages = selectedReviewImageLines(state);
  // Precompute approved-image keys + valid-shortlink keys ONCE so readiness is
  // an O(1) Set lookup per product. (Calling affiliateShortlinkForProduct per
  // product re-normalizes ALL link mappings each time -> O(products x mappings).)
  const approvedKeys = new Set();
  for (const img of reviewImages) {
    if (!img || !img.approved) continue;
    if (img.productKey) approvedKeys.add(String(img.productKey).toLowerCase());
    if (img.url) { const p = canonicalProduct(img.url, state); if (p) approvedKeys.add(p.key.toLowerCase()); }
  }
  const shortlinkKeys = new Set();
  for (const m of affiliateLinkMappings(state)) {
    if (m && m.productKey && m.shortUrl && isMavlynkShortUrl(m.shortUrl)) shortlinkKeys.add(String(m.productKey).toLowerCase());
  }
  const usedKeys = recentlyUsedProductKeys(registers.usedProducts, state);
  const noPhotoKeys = recentlyNoPhotoProductKeys(registers.noReviewPhotoProducts, state);
  const ready = [];
  const pending = [];
  for (const product of collectProductUrlsForPosting(state)) {
    const key = String(product.key || "").toLowerCase();
    if (usedKeys.has(key)) continue;
    if (noPhotoKeys.has(key)) continue; // reliable scrape confirmed no review photos — skip until retry window
    if (key.startsWith("harvested:")) { if (productHasReadyAssets(product, state, reviewImages)) ready.push(product); else pending.push(product); continue; }
    if (approvedKeys.has(key) && shortlinkKeys.has(key)) ready.push(product);
    else pending.push(product);
  }
  const target = assetBufferTargetCount(state);
  return {
    target,
    readyCount: ready.length,
    pendingCount: pending.length,
    eligibleCount: ready.length + pending.length,
    shortfall: Math.max(0, target - ready.length),
    readyUrls: ready.map((product) => product.url),
    nextPendingUrls: pending.map((product) => product.url),
  };
}

// ── CPU governor ─────────────────────────────────────────────────────────────
// Measures TOTAL system CPU via os.cpus() — every process on the box, INCLUDING the
// separate Pinterest agent. The FB agent throttles against this so it (a) uses maximum
// power when the box is idle, and (b) AUTOMATICALLY yields to Pinterest the moment total
// load rises: it never monopolises cores or starves the other agent. No process is ever
// touched — this is pure back-pressure on our own launches.
function __cpuTimesSnapshot() {
  const cpus = os.cpus() || [];
  let idle = 0, total = 0;
  for (const c of cpus) {
    const t = c.times || {};
    idle += t.idle || 0;
    total += (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.idle || 0) + (t.irq || 0);
  }
  return { idle, total };
}
async function currentCpuLoadPercent(sampleMs = 240) {
  const a = __cpuTimesSnapshot();
  await sleep(sampleMs);
  const b = __cpuTimesSnapshot();
  const idleDelta = b.idle - a.idle;
  const totalDelta = b.total - a.total;
  if (totalDelta <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100)));
}
// Block until total system CPU drops below the configured ceiling, so a new heavy browser
// render is never piled onto a saturated box (which would hang it AND fight Pinterest).
// Polls briefly; after maxWaitMs it proceeds anyway so a persistently-busy box can't
// deadlock the pipeline forever.
async function waitForCpuHeadroom(options = {}) {
  const st = readState();
  if (st.operator?.cpuGovernorEnabled === false) return { load: 0, waitedMs: 0, proceeded: true, disabled: true };
  const maxPercent = clampNumber(options.maxPercent != null ? options.maxPercent : st.operator?.cpuGovernorMaxPercent, 50, 99, 85);
  const maxWaitMs = clampNumber(options.maxWaitMs != null ? options.maxWaitMs : (st.operator?.cpuGovernorMaxWaitSeconds || 0) * 1000, 0, 600000, 120000);
  const startedAt = Date.now();
  let load = await currentCpuLoadPercent();
  let logged = false;
  while (load >= maxPercent && (Date.now() - startedAt) < maxWaitMs) {
    if (!logged) { logEvent("cpu_governor_waiting", { load, maxPercent, label: options.label || "" }); logged = true; }
    await sleep(3000);
    load = await currentCpuLoadPercent();
  }
  if (logged) logEvent("cpu_governor_resumed", { load, maxPercent, waitedMs: Date.now() - startedAt, label: options.label || "" });
  return { load, waitedMs: Date.now() - startedAt, proceeded: true };
}

// ── POSTING PRIORITY ─────────────────────────────────────────────────────────
// Posting is strict TOP priority over PREP (buffer fills / discovery / review-image scrape /
// ChatGPT-HD / SYL link-gen). A COUNTER (not a bool) so overlapping or manual posts each hold a
// reference and one finishing can't clear another's. begin/end MUST bracket the live publish via
// try/finally so a thrown/timed-out post still decrements — otherwise PREP is starved forever
// (the buffer never refills, posting drains to 0 and stops = deadlock-by-starvation).
let __livePostingInFlight = 0;
function beginLivePostingBatch() { __livePostingInFlight += 1; }
function endLivePostingBatch() { __livePostingInFlight = Math.max(0, __livePostingInFlight - 1); }
function isLivePostingInFlight() { return __livePostingInFlight > 0; }
// PREP yields to posting at SAFE boundaries (between fill batches — never mid-post, never with an
// iX/HD browser half-open). Bounded (default 180s) then PROCEEDS, symmetric to waitForCpuHeadroom,
// so prep can NEVER be permanently starved. Posting-idle is checked FIRST, then CPU headroom.
async function waitForPostingIdle(options = {}) {
  const maxWaitMs = clampNumber(options.maxWaitMs != null ? options.maxWaitMs : 180000, 0, 600000, 180000);
  const startedAt = Date.now();
  let logged = false;
  while (isLivePostingInFlight() && (Date.now() - startedAt) < maxWaitMs) {
    if (!logged) { logEvent("prep_yield_to_posting", { label: options.label || "" }); logged = true; }
    await sleep(1500);
  }
  if (logged) logEvent("prep_resume_after_posting", { waitedMs: Date.now() - startedAt, label: options.label || "" });
  return { waitedMs: Date.now() - startedAt, proceeded: true };
}

let __assetBufferFillInFlight = null;
// Prepare the next eligible products (SYL link + image/HD) one at a time until
// the buffer hits target or no eligible products remain. Single-flight; safe to
// fire-and-forget after discovery or after a post publishes. Applies equally to
// prod and test (both consume the same ready buffer).
// ===== CONTENT-SOURCE HARVEST (default OFF) =====================================================
// Spawn the connector in READ-ONLY harvestOnly mode for ONE group/profile; return its parsed items[].
async function runHarvestConnector(groupUrl, profileId, harvestCount) {
  const scriptPath = liveFacebookPostingScriptPath();
  const payloadDir = path.join(DATA_DIR, "harvest-requests");
  fs.mkdirSync(payloadDir, { recursive: true });
  const payloadPath = path.join(payloadDir, `harvest-${Date.now()}-${crypto.randomBytes(5).toString("hex")}.json`);
  fs.writeFileSync(payloadPath, JSON.stringify({ harvestOnly: true, groupUrl, profileId: Number(profileId), harvestCount: clampNumber(harvestCount, 1, 20, 4) }));
  try {
    const { stdout } = await execFileAsync("node", [scriptPath, payloadPath], { cwd: ROOT, windowsHide: true, timeout: 6 * 60 * 1000, maxBuffer: 24 * 1024 * 1024 });
    const objs = parseJsonLogObjects(stdout);
    const result = objs.filter((o) => o && o.step === "harvest_result").pop();
    return (result && Array.isArray(result.items)) ? result.items : [];
  } finally {
    try { fs.unlinkSync(payloadPath); } catch (_) {}
  }
}

let __harvestSourcesInFlight = null;
let __harvestNextAt = 0;
let __harvestEmptyRounds = 0;
let __harvestWorkingProfileByGroup = new Map(); // groupUrl -> a PROVEN member profile (learned automatically)
let __harvestProfileAttemptByGroup = new Map(); // groupUrl -> rotating index; advances when an auto-pick reads nothing
let __harvestReservePaused = false; // hysteresis: pause harvesting at reserveTarget, resume at reserveRefillAt
// Parallel 4-by-4 harvest across DISTINCT member profiles. Single-flight, posting/CPU-governed, dedups
// by first-comment URL on disk, persists records + downloaded images. Re-scan cadence via __harvestNextAt.
async function harvestContentSourcesAsync(options = {}) {
  if (__harvestSourcesInFlight) return __harvestSourcesInFlight;
  __harvestSourcesInFlight = (async () => {
    const state = readState();
    if (state.operator?.contentSourcesEnabled !== true) { __harvestNextAt = Date.now() + 300000; return { skipped: "disabled" }; }
    // RESERVE hysteresis: fill the copied-product reserve to reserveTarget, pause, then resume harvesting
    // only once posting has drained it down to reserveRefillAt. Both editable from the dashboard.
    const cs = state.posting?.contentSources || {};
    const reserveTarget = clampNumber(cs.reserveTarget, 1, 1000, 20);
    const reserveRefillAt = clampNumber(cs.reserveRefillAt, 0, Math.max(0, reserveTarget - 1), 10);
    const reserve = readHarvestedProducts(state).filter((r) => r && !r.posted && r.imageLocalPath && r.firstCommentUrl).length;
    if (reserve >= reserveTarget) __harvestReservePaused = true;
    if (reserve <= reserveRefillAt) __harvestReservePaused = false;
    if (__harvestReservePaused) { __harvestNextAt = Date.now() + 60000; logEvent("harvest_reserve_satisfied", { reserve, target: reserveTarget, refillAt: reserveRefillAt }); return { reserveSatisfied: reserve }; }
    const lines = recordLines(state.posting?.contentSources?.groupsText);
    const pool = [...new Set(postingSlots(state).map((s) => Number(s.profileId)).filter(Boolean))]; // round-robin pool for bare urls
    const pairs = [];
    for (const line of lines) {
      const m = String(line).match(/(https?:\/\/[^\s|@]*groups\/[^\s|@/]+)/i);
      if (!m) continue;
      const groupUrl = m[1];
      const pidMatch = String(line).match(/[|@]\s*(\d{1,6})/); // OPTIONAL "url | profileId" pin; otherwise FULLY AUTOMATIC
      let profileId = 0, autoPicked = false;
      if (pidMatch) {
        profileId = Number(pidMatch[1]);
      } else if (__harvestWorkingProfileByGroup.has(groupUrl)) {
        profileId = __harvestWorkingProfileByGroup.get(groupUrl); // reuse the PROVEN member learned earlier
      } else if (pool.length) {
        profileId = pool[(__harvestProfileAttemptByGroup.get(groupUrl) || 0) % pool.length]; // rotate across runs to FIND a member
        autoPicked = true;
      }
      if (profileId) pairs.push({ groupUrl, profileId, autoPicked });
    }
    if (!pairs.length) { __harvestNextAt = Date.now() + 300000; return { groups: 0 }; }
    const existingByUrl = new Map(readHarvestedProducts(state).map((r) => [String(r.firstCommentUrl || ""), r]));
    let harvestedNew = 0, skippedSeen = 0, reusedOld = 0;
    const harvestCount = clampNumber(options.harvestCount || 4, 1, 20, 4);
    for (let i = 0; i < pairs.length; i += 4) { // 4-by-4
      const round = pairs.slice(i, i + 4);
      await waitForPostingIdle({ label: "harvest_sources" }).catch(() => {});   // posting always wins
      await waitForCpuHeadroom({ label: "harvest_sources" }).catch(() => {});    // yield to a busy box + Pinterest
      await Promise.all(round.map(async (pair) => {
        let release = null;
        try { release = acquireNormalIxProfileUse(pair.profileId, "facebook_harvest"); }
        catch (e) { logEvent("harvest_profile_busy_skipped", { profileId: pair.profileId }); return; } // posting/discovery owns it -> skip
        try {
          const items = await runHarvestConnector(pair.groupUrl, pair.profileId, harvestCount);
          for (const it of items) {
            const url = String(it.link || "").trim();
            if (!url) continue;
            let rel = "";
            if (it.imageLocalPath) { try { rel = path.relative(ROOT, it.imageLocalPath).replace(/\\/g, "/"); } catch (_) { rel = ""; } }
            const existing = existingByUrl.get(url);
            if (existing) {
              // Already tracked = duplicate. DEDUP — EXCEPT: if it was POSTED >= 10 days ago AND is re-found
              // in the source group now, RE-ENABLE it for ONE more post (the connector already re-downloaded
              // its image). Re-posting will set posted again, restarting the 10-day clock.
              if (!existing.posted) { skippedSeen++; continue; } // unposted: already pending, skip
              const ageMs = Date.now() - Date.parse(existing.posted || "");
              if (!(Number.isFinite(ageMs) && ageMs >= 10 * 86400000)) { skippedSeen++; continue; } // posted < 10 days: skip
              updateHarvestedProductRecord(existing.productKey, { posted: "", imageDeleted: false, imageLocalPath: rel, text: it.text, harvestedAt: new Date().toISOString(), reusedAt: new Date().toISOString() }, readState());
              existing.posted = ""; reusedOld++;
              continue;
            }
            const persisted = appendHarvestedProduct({ firstCommentUrl: url, text: it.text, imageLocalPath: rel, sourceGroupUrl: pair.groupUrl }, readState());
            if (persisted) { existingByUrl.set(url, { firstCommentUrl: url, posted: "" }); harvestedNew++; }
          }
          // AUTO-LEARN the member profile: a profile that READ the group (returned items) is a proven member
          // -> remember it for next time. An auto-picked profile that read NOTHING (likely not a member) ->
          // rotate to the next profile on the next run until a member is found.
          if (items.length > 0) { __harvestWorkingProfileByGroup.set(pair.groupUrl, pair.profileId); }
          else if (pair.autoPicked) {
            __harvestProfileAttemptByGroup.set(pair.groupUrl, (__harvestProfileAttemptByGroup.get(pair.groupUrl) || 0) + 1);
            if (__harvestWorkingProfileByGroup.get(pair.groupUrl) === pair.profileId) __harvestWorkingProfileByGroup.delete(pair.groupUrl);
          }
          logEvent("harvest_group_done", { profileId: pair.profileId, groupUrl: pair.groupUrl, got: items.length, autoPicked: pair.autoPicked });
        } catch (e) { logEvent("harvest_connector_error", { profileId: pair.profileId, error: oneLineField((e && e.message) || String(e), 160) }); }
        finally { try { if (release) release(); } catch (_) {} }
      }));
      if (i + 4 < pairs.length) await sleep(clampNumber(options.interRoundGapMs || 25000, 5000, 120000, 25000)); // anti-throttle pacing
    }
    // RE-SCAN cadence: drain fast when producing; re-scan ~every minute when idle; back off when long-exhausted.
    if ((harvestedNew + reusedOld) > 0) { __harvestEmptyRounds = 0; __harvestNextAt = Date.now(); }
    else { __harvestEmptyRounds += 1; __harvestNextAt = Date.now() + (__harvestEmptyRounds >= 30 ? 300000 : 60000); }
    logEvent("harvest_round", { groups: pairs.length, harvestedNew, reusedOld, skippedSeen, emptyRounds: __harvestEmptyRounds, nextInSec: Math.round((__harvestNextAt - Date.now()) / 1000) });
    return { groups: pairs.length, harvestedNew, reusedOld, skippedSeen };
  })().catch((e) => { logEvent("harvest_sources_error", { error: oneLineField((e && e.message) || String(e), 200) }); __harvestNextAt = Date.now() + 120000; return { error: true }; })
    .finally(() => { __harvestSourcesInFlight = null; });
  return __harvestSourcesInFlight;
}

async function fillAssetBufferAsync(options = {}) {
  if (__assetBufferFillInFlight) return __assetBufferFillInFlight;
  __assetBufferFillInFlight = (async () => {
    const summary = { prepared: 0, attempted: 0, linkOk: 0, imageOk: 0, errors: [], stoppedReason: "" };
    const startStatus = assetBufferStatus();
    // targetOverride lets prepare-tomorrow build a DEEP buffer (e.g. 50 for next day) beyond
    // the normal per-day auto-target. 0 = use the configured target/shortfall.
    const targetOverride = clampNumber(options.targetOverride, 0, 500, 0);
    const remainingToTarget = targetOverride ? Math.max(0, targetOverride - startStatus.readyCount) : (startStatus.shortfall || 1);
    const cap = clampNumber(options.max, 1, 500, remainingToTarget || 1);
    logEvent("asset_buffer_fill_started", { target: targetOverride || startStatus.target, readyCount: startStatus.readyCount, shortfall: startStatus.shortfall, cap, targetOverride: targetOverride || undefined });
    const tried = new Set();
    // Matches the dead shared-SYL-#40-CDP-session errors so the fill aborts instead of
    // hammering a dead session product-after-product (the 499-failures-in-a-burst pattern).
    const DEAD_SYL_SESSION_RE = /has been closed|context or browser|connection closed|protocol error.*closed|target (?:page|closed)|session closed/i;
    // Batch unit = 9 by default ("9 by 9"): the SYL link-gen runs the whole batch in ONE #40
    // session AND the ChatGPT-HD step generates all 9 images in ONE conversation (its per-
    // conversation limit is 9) — so one batch == one HD conversation, no mid-batch rotation,
    // minimum lost time. Ceiling raised 8->12 to allow the 9 unit (plus a little headroom).
    const batchSize = clampNumber(options.batchSize || readState().productDiscovery?.assetFillBatchSize, 1, 12, 9);
    let emptyBatches = 0;
    try {
      // BATCHED fill (operator wants "3-by-3 / 4-by-4"): process batchSize products per round.
      // SYL link-gen runs for the WHOLE batch in ONE #40 session (was one open per product),
      // and ONE prepareProductAssetChecks call per batch INSPECTS the whole batch — it skips
      // products with no review photos and prepares the photo-having ones. That is what churns
      // PAST the no-photo products automatically instead of re-trying the same ones one at a time.
      while (summary.prepared < cap) {
        // PRIORITY GATE (safe boundary): posting strictly preempts prep. Yield BEFORE choosing
        // the next batch / opening any browser, so posting never waits on prep and prep never
        // interrupts a post or orphans an iX/HD session. Then recompute status FRESH (so a post
        // that just consumed/used a product is reflected — no stale snapshot, no clobber, no
        // re-prepping a just-posted product). CPU headroom is the second gate.
        await waitForPostingIdle({ label: "asset_fill" });
        const status = assetBufferStatus();
        const remaining = targetOverride ? (targetOverride - status.readyCount) : status.shortfall;
        if (remaining <= 0) { summary.stoppedReason = "buffer_full"; break; }
        const batch = status.nextPendingUrls.filter((url) => !tried.has(url)).slice(0, batchSize);
        if (!batch.length) { summary.stoppedReason = "no_more_eligible_products"; break; }
        batch.forEach((url) => tried.add(url));
        // CPU governor: yield to live posting + the Pinterest agent before this heavy batch.
        await waitForCpuHeadroom({ label: "asset_fill" });
        summary.attempted += batch.length;
        // 1) Batched SYL link-gen — all URLs in ONE #40 session.
        let linkResult;
        try {
          linkResult = await generateShopYourLikesExtensionLinks({ productUrls: batch });
        } catch (err) {
          const msg = oneLineField(err.message || String(err), 160);
          summary.errors.push(`link:${msg}`);
          if (DEAD_SYL_SESSION_RE.test(msg)) {
            summary.stoppedReason = "shopyourlikes_session_dead";
            logEvent("asset_buffer_fill_aborted_syl_session_dead", { error: msg, attempted: summary.attempted });
            break;
          }
          continue;
        }
        if (linkResult && linkResult.sessionNotReady) {
          summary.stoppedReason = "shopyourlikes_session_not_ready";
          summary.errors.push("link:shopyourlikes_session_not_ready");
          break;
        }
        const rows = Array.isArray(linkResult?.results) ? linkResult.results : [];
        const linkedUrls = rows.filter((r) => r && r.success && r.sylLink).map((r) => r.productUrl);
        summary.linkOk += linkedUrls.length;
        if (!linkedUrls.length) {
          // Circuit-breaker on the SWALLOWED (returned) dead-session error for the batch.
          if (rows.some((r) => r && r.error && DEAD_SYL_SESSION_RE.test(String(r.error)))) {
            summary.stoppedReason = "shopyourlikes_session_dead";
            logEvent("asset_buffer_fill_aborted_syl_session_dead", { attempted: summary.attempted, batch: batch.length });
            break;
          }
          if (++emptyBatches >= 3) { summary.stoppedReason = "too_many_empty_batches"; break; }
          continue; // none of this batch generated a link — try the next batch
        }
        emptyBatches = 0;
        // 2) Batched image prep — ONE call inspects all linked URLs, SKIPS no-photo products,
        // and prepares the photo-having ones (this is what churns past no-photo products).
        await waitForCpuHeadroom({ label: "asset_fill_images" });
        try {
          await prepareProductAssetChecks({ productUrls: linkedUrls, limit: linkedUrls.length, bufferFill: true });
          summary.imageOk += linkedUrls.length;
        } catch (err) {
          summary.errors.push(`image:${oneLineField(err.message || String(err), 160)}`);
        }
        // 3) Count how many of this batch became fully ready (approved image + shortlink).
        const st2 = readState();
        for (const url of batch) {
          if (productHasReadyAssets(canonicalProduct(url, st2), st2)) summary.prepared += 1;
        }
      }
    } catch (err) {
      summary.errors.push(`fatal:${oneLineField(err.message || String(err), 160)}`);
    } finally {
      const endStatus = assetBufferStatus();
      summary.readyCount = endStatus.readyCount;
      summary.target = endStatus.target;
      logEvent("asset_buffer_fill_complete", { prepared: summary.prepared, attempted: summary.attempted, linkOk: summary.linkOk, imageOk: summary.imageOk, readyCount: endStatus.readyCount, target: endStatus.target, stoppedReason: summary.stoppedReason, errors: summary.errors.slice(0, 5) });
      __assetBufferFillInFlight = null;
    }
    return summary;
  })();
  return __assetBufferFillInFlight;
}

// One-time backfill: scrape & record the REAL product title for products ALREADY in the
// posting pool that still have only the numeric "Walmart product {id}" fallback (so they post
// a real name instead of the generic fallback phrase, without waiting for the buffer to cycle).
// Reuses the existing scrape providers — Jina product-page fast-path, then the #40 residential
// browser (the one that beats Walmart anti-bot). Single-flight; safe to fire from an endpoint.
let __titleBackfillInFlight = null;
async function backfillProductTitlesAsync(options = {}) {
  if (__titleBackfillInFlight) return __titleBackfillInFlight;
  __titleBackfillInFlight = (async () => {
    const state = readState();
    const secrets = readSecrets();
    const max = clampNumber(options.max, 1, 80, 25);
    const have = realProductTitleMap();
    const targets = collectProductUrlsForPosting(state).filter((p) => {
      if (!p || !p.key || have.has(p.key.toLowerCase())) return false;
      return isNumericFallbackTitle(p.storedTitle || p.title || "");
    }).slice(0, max);
    const summary = { scanned: 0, recorded: 0, failed: 0, examples: [] };
    logEvent("product_title_backfill_started", { candidates: targets.length });
    for (const product of targets) {
      summary.scanned += 1;
      let title = "";
      try { const c = await jinaReaderProduct(product); title = extractRealProductTitleFromContent(c); } catch {}
      if (!title) { try { const c = await ixBrowserReviewImagesProduct(product, state, secrets, {}); if (c) title = extractRealProductTitleFromContent(c); } catch {} }
      if (title) { recordProductRealTitle(product.key, title); summary.recorded += 1; if (summary.examples.length < 5) summary.examples.push(oneLineField(title, 80)); }
      else summary.failed += 1;
      await sleep(1500);
    }
    logEvent("product_title_backfill_finished", { scanned: summary.scanned, recorded: summary.recorded, failed: summary.failed });
    return summary;
  })();
  try { return await __titleBackfillInFlight; } finally { __titleBackfillInFlight = null; }
}

// ---- Stage 3: autonomous publisher (daily-cap + prepare-tomorrow) -------
// Master switch: operator.autopilotEnabled (default OFF). When ON + armed +
// inside schedule, the scheduler auto-publishes ready buffer products within
// per-profile daily caps, then prepares tomorrow's buffer once the cap is met.
// Manual flows are unaffected; only autopilot-context posts bypass approval.
let __todayByProfileCache = { at: 0, tz: "", result: null };
function autopilotPublishedTodayByProfile(state = readState()) {
  const tz = state.operator?.scheduleTimezone || state.rules?.peakHoursTimezone || "America/New_York";
  // SCALE: this is a full synchronous ledger scan called multiple times per tick (postingSlots +
  // capacity + picker). A short 30s cache collapses those to ONE scan — the main event-loop-block /
  // shared-box (Pinterest) starvation risk at large ledger sizes. The cache is INVALIDATED the instant
  // a post lands (runWorker), so fairness/cap counts stay accurate; idle/fast-retry ticks reuse it.
  // Returned Maps are read-only by all callers.
  if (__todayByProfileCache.result && __todayByProfileCache.tz === tz && Date.now() - __todayByProfileCache.at < 30000) {
    return __todayByProfileCache.result;
  }
  // Reuse ONE Intl formatter (dateKeyForTimezone makes a new one per call, which
  // cost ~1s across hundreds of ledger lines), and pre-filter by UTC date prefix
  // so formatToParts only runs on ~today's lines.
  let fmt = null;
  try { fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }); } catch (_) {}
  const dayKeyOf = (d) => {
    if (!fmt) return d.toISOString().slice(0, 10);
    const m = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
    return (m.year && m.month && m.day) ? `${m.year}-${m.month}-${m.day}` : d.toISOString().slice(0, 10);
  };
  const nowMs = Date.now();
  const dayMs = 86400000;
  const utcPrefixes = new Set([nowMs - dayMs, nowMs, nowMs + dayMs].map((ms) => new Date(ms).toISOString().slice(0, 10)));
  const today = dayKeyOf(new Date(nowMs));
  const byProfile = new Map();
  const byGroup = new Map(); // per-group today-counts for group fairness (piggybacked on this scan)
  const seen = new Set();
  const lastAtByProfile = new Map();
  let total = 0;
  let lastPostAt = 0;
  try {
    const raw = fs.readFileSync(FB_LIVE_POST_LEDGER_FILE, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.indexOf('"postUrl":"http') === -1) continue; // only successful publishes
      let row;
      try { row = JSON.parse(trimmed); } catch { continue; }
      const postUrl = String(row.postUrl || "").trim();
      if (!postUrl) continue;
      const at = String(row.at || "");
      if (!at || !utcPrefixes.has(at.slice(0, 10))) continue; // cheap pre-filter before formatToParts
      if (dayKeyOf(new Date(at)) !== today) continue;
      const profileId = Number(row.profileId || 0);
      const dedupe = `${profileId}|${postUrl}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      byProfile.set(profileId, (byProfile.get(profileId) || 0) + 1);
      // Key on the CONFIG groupUrl (the vanity URL we posted TO) — not actualGroupUrl (the numeric
      // permalink) — so these counts align with the ready-row groupUrls used in orderReadyRowsLeastUsed.
      const gkey = normalizedFacebookGroupKey(String(row.groupUrl || row.actualGroupUrl || ""));
      if (gkey) byGroup.set(gkey, (byGroup.get(gkey) || 0) + 1);
      total += 1;
      const ts = Date.parse(at);
      if (Number.isFinite(ts)) {
        if (ts > lastPostAt) lastPostAt = ts;
        if (ts > (lastAtByProfile.get(profileId) || 0)) lastAtByProfile.set(profileId, ts);
      }
    }
  } catch (err) {
    if (err.code !== "ENOENT") logEvent("autopilot_ledger_read_error", { error: oneLineField(err.message || String(err), 160) });
  }
  const result = { byProfile, byGroup, total, lastPostAt, lastAtByProfile };
  __todayByProfileCache = { at: Date.now(), tz, result };
  return result;
}

// ALL-TIME published-post count per profile, straight from the ledger (the automatic action history).
// Used to ALWAYS pick the LEAST-used accounts first, so lifetime posting load spreads evenly across
// every profile and no single account gets hammered into a Facebook velocity throttle.
let __postHistoryCache = { at: 0, map: null };
function autopilotPostHistoryByProfile() {
  if (__postHistoryCache.map && Date.now() - __postHistoryCache.at < 300000) return __postHistoryCache.map; // 5min: all-time count drifts slowly; avoids a full ledger scan every ~25s fast-retry tick
  const byProfile = new Map();
  const seen = new Set();
  try {
    const raw = fs.readFileSync(FB_LIVE_POST_LEDGER_FILE, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.indexOf('"postUrl":"http') === -1) continue; // successful publishes only
      let r; try { r = JSON.parse(t); } catch { continue; }
      const pid = Number(r.profileId || 0);
      const u = String(r.postUrl || "");
      if (!pid || !u.startsWith("http")) continue;
      const dk = pid + "|" + u;
      if (seen.has(dk)) continue; // one post counts once
      seen.add(dk);
      byProfile.set(pid, (byProfile.get(pid) || 0) + 1);
    }
  } catch {}
  __postHistoryCache = { at: Date.now(), map: byProfile };
  return byProfile;
}

function autopilotCapacityByProfile(state = readState()) {
  // A count-mode run (operator.autopilotMaxPostsPerRun > 0) is bounded ONLY by the requested count:
  // the per-profile DAILY cap is intentionally lifted so the run always reaches the number asked for
  // (operator opted out of the 75/day-style throttle and has plenty of profiles). Continuous/time
  // runs keep the daily cap (now raisable up to 1000/profile) as their safety throttle.
  const runLimit = clampNumber(state.operator?.autopilotMaxPostsPerRun, 0, 1000000, 0);
  const dailyCap = clampNumber(state.rules?.postsPerProfilePerDay, 1, 1000, 5);
  const perProfile = runLimit > 0 ? Math.max(runLimit, dailyCap) : dailyCap;
  const published = autopilotPublishedTodayByProfile(state);
  const profiles = new Map();
  for (const slot of filterExcludedProfileSlots(postingSlots(state), {})) {
    const pid = Number(slot.profileId || profileIdFromLabel(slot.profile) || 0);
    if (!pid || profiles.has(pid)) continue;
    const used = published.byProfile.get(pid) || 0;
    profiles.set(pid, { profileId: pid, profile: slot.profile, postedToday: used, remaining: Math.max(0, perProfile - used), lastPostAt: (published.lastAtByProfile && published.lastAtByProfile.get(pid)) || 0 });
  }
  let list = [...profiles.values()];
  // Optional autopilot allowlist: restrict autonomous posting to specific profile
  // IDs (e.g. the highest-trust accounts that least often go pending). Accepts
  // "19,10,12" or "19 - name" lines. Empty = all eligible profiles. Scoped to
  // autopilot only — manual full-plan posting is unaffected.
  const allowRaw = String(state.operator?.autopilotProfileAllowlist || "").trim();
  if (allowRaw) {
    const allowed = new Set(allowRaw.split(/[\n,]+/).map((s) => parseInt(String(s).trim(), 10)).filter((n) => Number.isFinite(n) && n > 0));
    if (allowed.size) list = list.filter((p) => allowed.has(Number(p.profileId)));
  }
  return {
    perProfile,
    profiles: list,
    totalRemaining: list.reduce((sum, item) => sum + item.remaining, 0),
    totalPostedToday: published.total,
    lastPostAt: published.lastPostAt,
  };
}

function autopilotStatus(state = readState()) {
  const enabled = Boolean(state.operator?.autopilotEnabled);
  const armed = Boolean(state.operator?.armedForExternalActions);
  const scheduleEnabled = Boolean(state.operator?.scheduleEnabled);
  const scheduleOpen = autopilotPostingWindowOpen(state);
  const capacity = autopilotCapacityByProfile(state);
  const buffer = assetBufferStatus(state);
  return {
    enabled,
    armed,
    scheduleEnabled,
    scheduleOpen,
    active: enabled && armed && scheduleOpen && capacity.totalRemaining > 0,
    phase: !enabled ? "off" : !armed ? "not_armed" : !scheduleOpen ? "outside_schedule" : capacity.totalRemaining > 0 ? "publishing" : "prepare_tomorrow",
    tickSeconds: clampNumber(state.operator?.autopilotTickSeconds, 30, 3600, 120),
    capacity,
    buffer: { target: buffer.target, readyCount: buffer.readyCount, shortfall: buffer.shortfall, eligibleCount: buffer.eligibleCount },
  };
}

let __autopilotTickInFlight = false;
let __autopilotLastDecision = null;
let __autopilotSchedulerTimer = null;
let __autopilotDiscoveryInFlight = false;
let __autopilotLastDiscoveryAt = 0;
// Keep production posting unblocked by the fresh-discovery / latest-run asserts:
// refresh candidates with the fast HTTP discovery (no browser) when stale, and
// re-stamp still-live existing candidates into the latest run. Throttled +
// single-flight so it never hammers the sources.
async function autopilotMaybeRefreshDiscoveryAsync(reason, options = {}) {
  if (__autopilotDiscoveryInFlight) return { skipped: "in_flight" };
  const state = readState();
  const maxAgeHours = clampNumber(state.productDiscovery?.autopilotDiscoveryMaxAgeHours, 1, 168, 20);
  const lastRun = Date.parse(state.productDiscovery?.lastSuccessfulRunAt || "") || 0;
  const stale = !lastRun || (Date.now() - lastRun) > maxAgeHours * 3600 * 1000;
  const minGapMs = Math.max(15 * 60 * 1000, (maxAgeHours / 4) * 3600 * 1000);
  // FORCED discovery (e.g. the product POOL ran dry mid-window) bypasses the 20h staleness gate
  // — otherwise the loop would stall waiting for the timer. Still keep a SHORT hard min-gap so a
  // run of empty ticks can't hammer the Walmart sources.
  const force = Boolean(options.force);
  const forceMinGapMs = clampNumber(state.productDiscovery?.autopilotForceDiscoveryMinGapMinutes, 2, 60, 8) * 60 * 1000;
  if (force) {
    if ((Date.now() - __autopilotLastDiscoveryAt) < forceMinGapMs) return { skipped: "forced_min_gap" };
  } else if (!stale && (Date.now() - __autopilotLastDiscoveryAt) < minGapMs) {
    return { skipped: "fresh" };
  }
  __autopilotDiscoveryInFlight = true;
  __autopilotLastDiscoveryAt = Date.now();
  try {
    const result = await runProductDiscovery({ includeExistingCandidates: true });
    logEvent("autopilot_discovery_refreshed", { reason, status: result?.status || "", candidates: Number(result?.candidateCount || (Array.isArray(result?.discovered) ? result.discovered.length : 0) || 0) });
    return { ok: true, status: result?.status || "" };
  } catch (err) {
    logEvent("autopilot_discovery_refresh_failed", { reason, error: oneLineField(err.message || String(err), 200) });
    return { ok: false, error: oneLineField(err.message || String(err), 200) };
  } finally {
    __autopilotDiscoveryInFlight = false;
  }
}
// ---- HARD per-run post-count limiter + mid-tick gate ------------------------
// autopilotMaxPostsPerRun (0=unlimited) caps how many posts a single armed run makes; when hit,
// the autopilot AUTO-DISARMS (enabled=false + armed=false) so it cannot overshoot or keep going.
function autopilotRunLimit(state = readState()) {
  // Match autopilotCapacityByProfile's clamp (1e6): a COUNT run must be able to reach exactly N
  // even for large N. (Was 1000 — which silently auto-disarmed any count run above 1000 posts.)
  return clampNumber(state.operator?.autopilotMaxPostsPerRun, 0, 1000000, 0);
}
function autopilotPostsThisRunCount(state = readState()) {
  return clampNumber(state.operator?.autopilotPostsThisRun, 0, 1000000, 0);
}
function autopilotAutoDisarm(reason, detail) {
  const s = readState();
  s.operator = s.operator || {};
  s.operator.autopilotEnabled = false;
  s.operator.armedForExternalActions = false;
  writeState(s, { controlWrite: true });
  logEvent("autopilot_auto_disarmed", { reason, detail });
  // 100% COMMENTS to the very end: a count run disarms the instant it hits N, which would otherwise
  // stop the armed-gated comment resweep — leaving a tail post (whose posters were still busy at
  // inline-comment time) uncommented. Kick a few FORCED resweeps (now that posting is idle, the
  // proven-access poster profiles are free) so every post still gets its different-profile comment.
  if (reason === "run_limit_reached") {
    (async () => {
      for (let pass = 0; pass < 5; pass += 1) {
        try {
          const r = await resweepUncommentedFacebookPostsAsync({ force: true, max: 50, windowHours: 12 });
          if (!r || (r.checked === 0 && r.recommented === 0)) break; // nothing left to comment
        } catch {}
        await sleep(5000);
      }
      logEvent("autopilot_final_comment_resweep_done", { reason });
    })().catch(() => {});
  }
}
// Fresh-read gate: may the autopilot publish RIGHT NOW? Re-read on each call so a mid-tick
// disable/disarm or a reached run-limit takes effect immediately (not only at the next tick).
function autopilotMayPostNow() {
  const s = readState();
  if (s.operator?.autopilotEnabled !== true) return { ok: false, reason: "disabled" };
  if (s.operator?.armedForExternalActions !== true) return { ok: false, reason: "disarmed" };
  const lim = autopilotRunLimit(s);
  if (lim > 0 && autopilotPostsThisRunCount(s) >= lim) return { ok: false, reason: "run_limit_reached" };
  return { ok: true };
}
// One autopilot cycle. SAFE BY DEFAULT: with operator.autopilotDryRun !== false
// it only LOGS the post it would make and never posts, builds/persists a plan,
// or opens browsers. Set autopilotDryRun=false to go live.
async function autopilotTickAsync(options = {}) {
  if (__autopilotTickInFlight) return { skipped: "tick_in_flight" };
  const state = readState();
  if (!state.operator?.autopilotEnabled) return { skipped: "autopilot_disabled" };
  if (!state.operator?.armedForExternalActions) return { skipped: "not_armed" };
  const dryRun = state.operator?.autopilotDryRun !== false;
  // Sync the roster + blacklist with what actually exists in iX before computing capacity, so
  // GONE profiles are dropped and stale automation benches re-enter rotation. FAIL-CLOSED +
  // debounced + interval-throttled internally; never throws into the tick.
  if (!dryRun) {
    try { await reconcileProfilesWithIxBrowser(); } catch (_e) { /* reconcile never breaks a tick */ }
  }
  __autopilotTickInFlight = true;
  const decision = { at: new Date().toISOString(), dryRun, action: "", detail: "" };
  try {
    const scheduleOpen = autopilotPostingWindowOpen(state);
    const capacity = autopilotCapacityByProfile(state);
    const buffer = assetBufferStatus(state);
    decision.capacity = { totalRemaining: capacity.totalRemaining, totalPostedToday: capacity.totalPostedToday };
    decision.buffer = { readyCount: buffer.readyCount, target: buffer.target, shortfall: buffer.shortfall };

    // PHASE A: prepare tomorrow when outside schedule or the daily cap is met.
    // COMMENT RE-SWEEP: guarantee every already-live post eventually gets its different-profile
    // first comment (its product is retired on publish, so the autopilot won't re-pick it; this
    // catches any post whose inline comment attempt failed under 3-by-3). Fire-and-forget,
    // single-flight, armed-gated, throttled to once / 90s, yields to active posting.
    if (!dryRun && state.operator?.autopilotEnabled && state.operator?.armedForExternalActions
        && !__commentResweepInFlight && (Date.now() - __lastCommentResweepAt) > 90000) {
      resweepUncommentedFacebookPostsAsync({ max: 5 }).catch(() => {});
    }
    // CONTENT-SOURCE HARVEST (default OFF): fire-and-forget, single-flight, armed-gated, ~1-min re-scan
    // cadence (__harvestNextAt). Harvests source groups' posts (text + image + first-comment link) into
    // the buffer in parallel 4-by-4. When contentSourcesEnabled is off this never fires.
    if (!dryRun && state.operator?.contentSourcesEnabled === true && state.operator?.armedForExternalActions
        && !__harvestSourcesInFlight && Date.now() >= __harvestNextAt) {
      harvestContentSourcesAsync({}).catch(() => {});
    }
    if (!scheduleOpen || capacity.totalRemaining <= 0) {
      decision.action = "prepare_tomorrow";
      decision.detail = !scheduleOpen ? "outside_schedule" : "daily_cap_reached";
      if (!dryRun) {
        const disc = await autopilotMaybeRefreshDiscoveryAsync("prepare_tomorrow");
        if (disc && !disc.skipped) decision.discovery = disc;
        const prepTarget = clampNumber(state.operator?.prepareTomorrowTarget, 1, 500, 50);
        if (state.operator?.autopilotAutoFill !== false && buffer.readyCount < prepTarget && !__assetBufferFillInFlight) {
          // Deep-prepare tomorrow's buffer (default 50) — products, SYL+Mavlynk links, review
          // images. FIRE-AND-FORGET (not awaited) so a multi-minute prep never DEFERS the next
          // autopilot tick (which would delay posting when the window reopens). Single-flight
          // guarded + CPU-governed; runs in the background until the buffer hits the target.
          fillAssetBufferAsync({ targetOverride: prepTarget, max: Math.min(prepTarget, 60) }).catch((err) => logEvent("autopilot_prepare_tomorrow_fill_error", { error: oneLineField(err.message || String(err), 160) }));
          decision.bufferFill = { started: true, prepareTarget: prepTarget };
        }
      }
      __autopilotLastDecision = decision;
      logEvent("autopilot_prepare_tomorrow", decision);
      return decision;
    }

    // PHASE B: pick profiles eligible NOW = have daily capacity AND past their
    // OWN per-profile spacing. Concurrency = up to maxConcurrentProfiles workers,
    // each a DIFFERENT profile (mirrors the proven full-plan batching).
    const now = Date.now();
    // Per-profile spacing gap. If a SECONDS window is configured (secondsBetweenPostsMax>0),
    // use a RANDOM gap in [min,max] SECONDS (anti-bot jitter, sub-minute capable); otherwise
    // fall back to the minutes-based spacing.
    const __secMax = clampNumber(state.rules?.secondsBetweenPostsMax, 0, 3600, 0);
    const __secMin = clampNumber(state.rules?.secondsBetweenPostsMin, 0, 3600, 0);
    const minGapMs = __secMax > 0
      ? randomInt(Math.min(__secMin, __secMax), Math.max(__secMin, __secMax)) * 1000
      : clampNumber(state.rules?.minMinutesBetweenPosts || state.rules?.minutesBetweenPosts, 1, 1440, 5) * 60 * 1000;
    const maxWorkers = clampNumber(state.ixbrowser?.maxConcurrentProfiles, 1, MAX_CONCURRENT_NORMAL_IX_PROFILES, MAX_CONCURRENT_NORMAL_IX_PROFILES);
    decision.maxWorkers = maxWorkers;
    const withCapacity = capacity.profiles.filter((p) => p.remaining > 0);
    const eligibleProfiles = withCapacity.filter((p) => (now - (p.lastPostAt || 0)) >= minGapMs);
    if (!eligibleProfiles.length) {
      if (withCapacity.length) {
        const soonestMs = Math.min(...withCapacity.map((p) => minGapMs - (now - (p.lastPostAt || 0))));
        decision.action = "wait_spacing";
        decision.detail = `${Math.max(0, Math.round(soonestMs / 1000))}s until a profile clears spacing (${withCapacity.length} with capacity)`;
      } else {
        decision.action = "no_profile_capacity";
        decision.detail = "no profile has remaining daily capacity";
      }
      __autopilotLastDecision = decision;
      return decision;
    }

    // PHASE C: must have ready products in the buffer. If empty, REPLENISH (self-healing loop):
    // fill from the pending pool; if the pool ITSELF is exhausted (no eligible products left to
    // prepare), force fresh DISCOVERY then fill — so posting auto-resumes without waiting for the
    // 20h staleness timer. All FIRE-AND-FORGET + single-flight so the tick never blocks; the next
    // tick (~120s) posts the moment a product becomes ready. Daily caps + window close stay the
    // only STOPs.
    if (buffer.readyCount <= 0) {
      decision.action = "fill_then_wait";
      decision.detail = "no_ready_products";
      if (!dryRun && state.operator?.autopilotAutoFill !== false) {
        const poolExhausted = (Number(buffer.eligibleCount) || 0) <= 0;
        if (poolExhausted) {
          decision.detail = "pool_exhausted_discovering";
          autopilotMaybeRefreshDiscoveryAsync("pool_exhausted", { force: true })
            .then((d) => { if (d && d.ok && !d.skipped && !__assetBufferFillInFlight) return fillAssetBufferAsync({ max: Math.min(Math.max(buffer.target || 9, maxWorkers * 2), 12) }); })
            .catch((err) => logEvent("autopilot_pool_replenish_error", { error: oneLineField(err.message || String(err), 160) }));
        } else if (!__assetBufferFillInFlight) {
          fillAssetBufferAsync({ max: Math.min(Math.max(buffer.shortfall || 0, maxWorkers * 2), 12) }).catch((err) => logEvent("autopilot_fill_error", { error: oneLineField(err.message || String(err), 160) }));
        }
      }
      __autopilotLastDecision = decision;
      logEvent("autopilot_idle", decision);
      return decision;
    }

    // Keep the buffer TOPPED while posting: if below target, kick a background fill now (don't
    // wait for it to drain to 0). Fire-and-forget + single-flight so this tick still posts.
    if (!dryRun && state.operator?.autopilotAutoFill !== false && buffer.shortfall > 0 && !__assetBufferFillInFlight) {
      fillAssetBufferAsync({ max: Math.min(Math.max(buffer.shortfall, maxWorkers), 12) }).catch(() => {});
    }

    const workerProfiles = eligibleProfiles.slice(0, maxWorkers);

    // PHASE D (DRY-RUN): report up to N would-publish (distinct profiles), no posting.
    if (dryRun) {
      const targets = [];
      for (let i = 0; i < workerProfiles.length && i < buffer.readyUrls.length; i += 1) {
        targets.push({ productUrl: buffer.readyUrls[i], profile: workerProfiles[i].profile, profileId: workerProfiles[i].profileId, remaining: workerProfiles[i].remaining });
      }
      decision.action = "dry_run_would_publish";
      decision.workers = targets.length;
      decision.targets = targets;
      decision.detail = `${buffer.readyCount} ready; would publish ${targets.length} concurrently (cap ${maxWorkers})`;
      __autopilotLastDecision = decision;
      logEvent("autopilot_dry_run_would_publish", decision);
      return decision;
    }

    // PHASE E (LIVE): ensure discovery fresh, build plan, pick up to N ready rows
    // with DISTINCT eligible profiles, and publish them CONCURRENTLY.
    await autopilotMaybeRefreshDiscoveryAsync("before_publish");
    let plan;
    try {
      // discoveryAlreadyRun: the line above already refreshed candidates — without this,
      // preparePostingPlanWithFallbackProfiles runs a SECOND un-throttled discovery every tick.
      // COUNT mode keeps a DEEPER ready pool per tick so the group+profile fairness sort has rows
      // for multiple groups to spread across (postingSlots front-loads group[0], so a shallow pool
      // can be all one group). maxWorkers (3) still caps posts/tick, so this never overshoots N.
      const __planCap = autopilotRunLimit(state) > 0 ? 30 : 10;
      plan = await preparePostingPlanWithFallbackProfiles({ testPost: false, autopilot: true, discoveryAlreadyRun: true, limit: Math.min(capacity.totalRemaining, __planCap) });
    } catch (err) {
      decision.action = "plan_unavailable";
      decision.detail = oneLineField(err.message || String(err), 220);
      __autopilotLastDecision = decision;
      logEvent("autopilot_plan_unavailable", decision);
      return decision;
    }
    // Match ready rows against ALL eligible profiles (capacity + spacing), not
    // just the first maxWorkers slice — otherwise the plan's ready row is often
    // for a different eligible profile and the tick wastes itself as no_ready_row.
    // The maxWorkers cap is still enforced by the picked.length break below.
    const eligibleIds = new Set(eligibleProfiles.map((p) => p.profileId));
    // FAIRNESS: order ready rows so the LEAST-used profiles (fewest posts today) are picked first,
    // spreading posting opportunity equally across available profiles.
    // THROTTLE-SAFE FAIRNESS: recent volume is what trips Facebook throttles, so deprioritize profiles
    // that already posted TODAY the hardest, THEN order by all-time history (fewest posts ever first).
    // Net: a rested account ALWAYS goes before a recently-hammered one, and lifetime load still balances
    // evenly among equally-rested accounts. (Earlier least-lifetime-only ordering wrongly tried the
    // newer-but-recently-throttled accounts first and burned the run on cannot_post retries.)
    const postHistory = autopilotPostHistoryByProfile();
    const usageByPid = new Map(eligibleProfiles.map((p) => [Number(p.profileId), (p.postedToday || 0) * 1000000 + (postHistory.get(Number(p.profileId)) || 0)]));
    const recentlyFailed = recentlyFailedProfileSet(state);
    // GROUP FAIRNESS: today's per-group counts (from the same single ledger scan) so the picker
    // prefers the least-posted group first, then the least-used profile — equal across BOTH.
    const usageByGroupKey = autopilotPublishedTodayByProfile(state).byGroup || new Map();
    const readyRows = orderReadyRowsLeastUsed(
      latestPostingPlanRows(readState()).filter((row) => row.runType === "full_posting_plan" && row.planId === plan.planId && String(row.liveExecution || "").startsWith("ready")),
      usageByPid,
      recentlyFailed,
      usageByGroupKey,
    );
    const picked = [];
    const usedIds = new Set();
    const usedProductKeys = new Set();
    const usedMarkers = new Set();
    for (const row of readyRows) {
      const pid = Number(row.profileId || profileIdFromLabel(row.profile) || 0);
      if (!eligibleIds.has(pid) || usedIds.has(pid)) continue;
      const prodKey = String(row.productKey || row.productUrl || row.link || "").toLowerCase();
      if (prodKey && usedProductKeys.has(prodKey)) continue; // each post must use a UNIQUE product
      // CONCURRENCY SAFETY: two products whose markers are the same OR variant SIBLINGS (shared
      // long title prefix, e.g. RC Lambo "...- Red" vs "...- White") must NOT be in the same
      // parallel batch — their near-identical captions make feed-capture ambiguous. Skip siblings.
      const markerKey = computePostMarkerPhrase(row).toLowerCase();
      if (markerKey && [...usedMarkers].some((m) => markersAreSiblings(markerKey, m))) continue;
      usedIds.add(pid);
      if (prodKey) usedProductKeys.add(prodKey);
      usedMarkers.add(markerKey);
      picked.push(row);
      if (picked.length >= maxWorkers) break;
    }
    if (!picked.length) {
      decision.action = "no_ready_row";
      decision.detail = `plan ${plan.planId}: ${readyRows.length} ready row(s), none match the ${eligibleIds.size} eligible profile(s)`;
      __autopilotLastDecision = decision;
      logEvent("autopilot_no_ready_row", decision);
      return decision;
    }
    // HARD PER-RUN LIMIT: trim this batch to the remaining allowance so even a concurrent batch
    // can NEVER overshoot the cap (0 = unlimited). If nothing remains, auto-disarm and stop.
    {
      const lim = autopilotRunLimit(state);
      if (lim > 0) {
        const already = autopilotPostsThisRunCount(readState());
        const remaining = Math.max(0, lim - already);
        if (picked.length > remaining) {
          logEvent("autopilot_run_limit_trim", { limit: lim, already, remaining, requested: picked.length });
          picked.length = remaining;
        }
        if (!picked.length) {
          autopilotAutoDisarm("run_limit_reached", `posted ${already}/${lim} this run`);
          decision.action = "run_limit_reached";
          decision.detail = `per-run limit ${lim} reached (${already} posted); auto-disarmed`;
          __autopilotLastDecision = decision;
          logEvent("autopilot_run_limit_reached", decision);
          return decision;
        }
      }
    }
    decision.action = "publishing";
    decision.workers = picked.length;
    decision.targets = picked.map((r) => ({ planId: r.planId, sequence: r.sequence, profile: r.profile, profileId: Number(r.profileId || 0), groupUrl: r.groupUrl, productUrl: r.productUrl }));
    logEvent("autopilot_publishing", decision);
    // Posting mode (each worker = a distinct profile with its own profile lock):
    //  - DEFAULT (sequential + staggered): two concurrent FB *renders* saturate a
    //    low-core/no-GPU box and both hang, so post one fully, wait a settle delay,
    //    then the next. Reliable in-order posting.
    //  - CONCURRENT (operator.autopilotConcurrentPosting=true): publish all picked
    //    workers in parallel. Only safe when posts are LEAN — assets pre-ready so no
    //    image/link generation competes for CPU during the render.
    decision.outcomes = [];
    const runWorker = async (r) => {
      // MID-TICK GATE: re-read fresh state right before this post. If the operator disabled/disarmed
      // or the per-run limit was hit since the tick started (or since a sibling worker posted), do
      // NOT post. This makes a stop take effect WITHIN the current batch, not just at the next tick.
      const gate = autopilotMayPostNow();
      if (!gate.ok) {
        logEvent("autopilot_worker_skipped", { profileId: Number(r.profileId || 0), reason: gate.reason });
        return { profileId: Number(r.profileId || 0), ok: false, postUrl: "", error: `skipped_${gate.reason}` };
      }
      try {
        const v = await runLiveFacebookPostFromPlan({ fullRun: true, autopilot: true, planId: r.planId, sequence: r.sequence, countTowardRun: true });
        autoBlacklistProfileIfNeeded({ profileId: Number(r.profileId || 0), profile: r.profile, ok: Boolean(v && v.ok), postUrl: (v && v.postUrl) || "", errorText: (v && (v.error || v.reason)) || "", validation: v && v.validation, source: "autopilot" });
        // The per-run counter is now bumped at the RECORD moment inside completeVerifiedFacebookPostWithComment
        // (gated by ready.__autopilotRunPost = body.countTowardRun), so a post that LANDS but whose comment/
        // cleanup errors afterward is STILL counted exactly once — fixing the rare under-count where
        // "stop at N" could overshoot by 1 (e.g. p48: posted, but its worker threw right after landing).
        return { profileId: Number(r.profileId || 0), ok: Boolean(v && v.ok), postUrl: (v && v.postUrl) || "", error: "" };
      } catch (err) {
        autoBlacklistProfileIfNeeded({ profileId: Number(r.profileId || 0), profile: r.profile, ok: false, postUrl: "", errorText: oneLineField((err && (err.profileFailureReason || err.message)) || String(err), 240), profileRetryable: !!(err && err.profileRetryable), validation: err && err.livePostValidation, source: "autopilot" });
        return { profileId: Number(r.profileId || 0), ok: false, postUrl: "", error: oneLineField((err && err.message) || String(err), 200) };
      }
    };
    // Mark live posting IN FLIGHT for the whole dispatch so PREP yields to it (priority).
    // try/finally guarantees the signal clears even if a worker throws (no starvation leak).
    beginLivePostingBatch();
    try {
    if (state.operator?.autopilotConcurrentPosting && picked.length > 1) {
      const openStaggerMs = clampNumber(state.operator?.parallelOpenStaggerSeconds, 0, 30, 8) * 1000;
      logEvent("autopilot_posting_concurrent", { workers: picked.length, openStaggerMs, profileIds: picked.map((r) => Number(r.profileId || 0)) });
      // Stagger the worker STARTS so the iX profile-open requests don't collide (4 simultaneous
      // connectOverCDP opens slam the local iX API). The heavy renders still overlap afterward.
      const settled = await Promise.allSettled(picked.map((r, i) => (async () => {
        if (i > 0 && openStaggerMs > 0) {
          logEvent("autopilot_worker_open_stagger", { waitMs: i * openStaggerMs, profileId: Number(r.profileId || 0) });
          await sleep(i * openStaggerMs);
        }
        // CPU governor: don't launch this extra render until the box (incl. Pinterest)
        // has headroom. Worker 0 always goes immediately so progress never stalls.
        if (i > 0) await waitForCpuHeadroom({ label: `autopilot_worker_p${Number(r.profileId || 0)}` });
        return runWorker(r);
      })()));
      decision.outcomes = settled.map((s, i) => (s.status === "fulfilled" ? s.value : { profileId: Number(picked[i].profileId || 0), ok: false, postUrl: "", error: "worker_rejected" }));
    } else {
      const staggerMs = clampNumber(state.operator?.autopilotWorkerStaggerSeconds, 0, 600, 25) * 1000;
      for (let wi = 0; wi < picked.length; wi += 1) {
        decision.outcomes.push(await runWorker(picked[wi]));
        if (wi < picked.length - 1 && staggerMs > 0) {
          logEvent("autopilot_worker_stagger", { waitMs: staggerMs, nextProfileId: Number((picked[wi + 1] && picked[wi + 1].profileId) || 0) });
          await sleep(staggerMs);
        }
      }
    }
    } finally {
      endLivePostingBatch();
    }
    decision.posted = decision.outcomes.filter((o) => o.ok || o.postUrl).length;
    // HARD LIMIT (race-free): bump the per-run counter ONCE from this batch's actual landed posts,
    // then auto-disarm if the cap is reached. RACE-SAFETY: (a) ticks are single-flight
    // (__autopilotTickInFlight) so no two ticks ever run concurrently; (b) this readState→writeState
    // is synchronous with NO await, and so is the PUT handler's preserve pair, so in single-threaded
    // JS they cannot interleave — whichever runs first, the other reads the post-write value; (c) the
    // pre-dispatch trim already capped this batch to the remaining allowance. So total never exceeds N.
    if (!dryRun && decision.posted > 0) {
      // The per-run counter is now bumped PER-POST inside runWorker (above), so progress shows live and
      // auto-stop fires the instant the Nth post lands. Here we ONLY read it back for the decision log —
      // re-incrementing here would double-count and trip auto-disarm at N/2.
      decision.postsThisRun = autopilotPostsThisRunCount(readState());
    }
    decision.action = "published";
    __autopilotLastDecision = decision;
    logEvent("autopilot_published", decision);
    // Proactively TOP UP the buffer in the BACKGROUND after consuming products, so it
    // never drains to 0 then stutters (the old behaviour only refilled at readyCount<=0).
    // Single-flight guarded (a running fill is a no-op) and fire-and-forget so the tick
    // returns immediately. The fill itself is CPU-governed via fillAssetBufferAsync.
    if (!dryRun && state.operator?.autopilotAutoFill !== false && !__assetBufferFillInFlight) {
      const sf = assetBufferStatus().shortfall;
      if (sf > 0) {
        logEvent("autopilot_background_topup_fill", { shortfall: sf });
        fillAssetBufferAsync({ max: Math.min(sf, 5) }).catch((err) => logEvent("autopilot_topup_fill_error", { error: oneLineField(err.message || String(err), 160) }));
      }
    }
    return decision;
  } catch (err) {
    decision.action = "error";
    decision.detail = oneLineField(err.message || String(err), 300);
    __autopilotLastDecision = decision;
    logEvent("autopilot_tick_error", decision);
    return decision;
  } finally {
    __autopilotTickInFlight = false;
  }
}

function startAutopilotScheduler() {
  if (__autopilotSchedulerTimer) return;
  const tick = async () => {
    __autopilotSchedulerTimer = null;
    try {
      const state = readState();
      if (state.operator?.autopilotEnabled && state.operator?.armedForExternalActions) {
        await autopilotTickAsync();
      }
    } catch (err) {
      logEvent("autopilot_scheduler_error", { error: oneLineField(err.message || String(err), 200) });
    } finally {
      const op = readState().operator || {};
      const normalSecs = clampNumber(op.autopilotTickSeconds, 30, 3600, 120);
      // FAST-RETRY: when the last tick couldn't post only because the ready buffer was momentarily
      // empty / still topping up (the fill is fire-and-forget in the background), re-tick SOON so a
      // freshly-prepared product posts within ~25s instead of eating the full ~120s idle penalty —
      // the "prepare in parallel, never block posting" win. We do NOT fast-retry wait_spacing (that
      // gap is deliberate throttle-safety) or terminal states (done / limit reached / window closed).
      const waitingOnAssets = __autopilotLastDecision && /^(fill_then_wait|no_ready_row|plan_unavailable)$/.test(String(__autopilotLastDecision.action || ""));
      const armed = op.autopilotEnabled && op.armedForExternalActions;
      const secs = (armed && waitingOnAssets) ? clampNumber(op.autopilotFastRetrySeconds, 10, 120, 25) : normalSecs;
      __autopilotSchedulerTimer = setTimeout(tick, secs * 1000);
    }
  };
  __autopilotSchedulerTimer = setTimeout(tick, 15000);
  logEvent("autopilot_scheduler_started");
}

function preparePostingPlan(options = {}) {
  const state = readState();
  const overrideProductUrls = Array.isArray(options.productUrls)
    ? options.productUrls
    : Array.isArray(options.product_urls)
      ? options.product_urls
      : [];
  let products = overrideProductUrls.length
    ? attachStoredProductTitles(uniqueProductUrls(overrideProductUrls, state), storedProductTitleMap(readJsonlFile(state.files.productCandidates || "data/product-candidates.jsonl"), state))
    : collectProductUrlsForPosting(state, { latestDiscoveryOnly: !options.testPost && !options.autopilot });
  // Autopilot posts from the prepared BUFFER (approved image + shortlink), which
  // may include products from earlier discovery runs. Skip the latest-run filter
  // for autopilot so the ready buffer inventory is postable (manual full runs
  // keep the strict latest-run filter).
  if (!options.testPost && !options.autopilot) {
    const latestProducts = collectProductUrlsForPosting(state, { latestDiscoveryOnly: true });
    const latestKeys = new Set(latestProducts.map((product) => product.key.toLowerCase()));
    products = products.filter((product) => latestKeys.has(product.key.toLowerCase()));
  }
  const registers = readRegisters();
  const productCountBeforeBlacklist = products.length;
  products = filterBlacklistedProducts(products, state, registers, options);
  const configuredSlots = filterExcludedProfileSlots(postingSlots(state), options);
  const suppliedExtraSlots = filterExcludedProfileSlots(Array.isArray(options.extraSlots) ? options.extraSlots : [], options);
  const baseSlots = assignProfileRunIndexes(configuredSlots.length ? configuredSlots : suppliedExtraSlots);
  let slots = options.testPost ? shuffledCopy(baseSlots) : baseSlots;
  // Use the profile warmup pre-opened (if recent) FIRST so the connector reuses
  // that already-open profile instead of cold-opening a second one. Non-test
  // plans aren't shuffled, so baseSlots[0] already matches the warmed pick.
  if (options.testPost && __warmupPostingSlot && Number(__warmupPostingSlot.profileId)
      && (Date.now() - Number(__warmupPostingSlot.at || 0)) < 10 * 60 * 1000) {
    const warmId = Number(__warmupPostingSlot.profileId);
    const idx = slots.findIndex((slot) => Number(slot.profileId || profileIdFromLabel(slot.profile) || 0) === warmId);
    if (idx > 0) {
      const [warm] = slots.splice(idx, 1);
      slots.unshift(warm);
    }
  }
  if (!slots.length) {
    const err = new Error("No eligible Facebook posting profile is ready. Check group assignments and unblock/fix at least one normal IXBrowser profile; moderator, blocked, failed, and ShopYourLikes profiles are excluded.");
    err.statusCode = 400;
    err.publicError = "no_eligible_facebook_posting_profile";
    throw err;
  }
  if (!products.length) {
    const err = new Error(productCountBeforeBlacklist
      ? "All ready product URLs are blacklisted. Run product discovery again or remove cleared products from the blacklist."
      : "No unique product URLs are ready. Run product discovery first.");
    err.statusCode = 400;
    throw err;
  }
  const usedKeys = recentlyUsedProductKeys(registers.usedProducts, state);
  const noPhotoKeys = recentlyNoPhotoProductKeys(registers.noReviewPhotoProducts, state);
  const usableProducts = products.filter((product) => !usedKeys.has(product.key.toLowerCase()) && !noPhotoKeys.has(product.key.toLowerCase()));
  if (!options.testPost && !usableProducts.length) {
    const err = new Error("All available products are already marked used.");
    err.statusCode = 409;
    throw err;
  }
  const postTexts = contentRotationLines(state.contentRotation?.postTexts);
  const commentLeadIns = contentRotationLines(state.contentRotation?.commentLeadIns);
  const reviewImages = selectedReviewImageLines(state);
  const productPool = options.testPost ? products : usableProducts;
  const productsWithApprovedImages = productPool.filter((product) => String(product.key || "").startsWith("harvested:") || reviewImageForProduct(reviewImages, product)?.approved); // harvested products carry their OWN downloaded image -> front of the plan, within the limit
  const planProducts = [
    ...productsWithApprovedImages,
    ...productPool.filter((product) => !productsWithApprovedImages.some((approved) => approved.key === product.key)),
  ];
  const requestedLimit = options.limit
    ? clampNumber(options.limit, 1, 500, 1)
    : clampNumber(state.productDiscovery?.dailyPostTarget, 1, 500, slots.length);
  const limit = Math.min(slots.length, planProducts.length, requestedLimit);
  const runType = options.testPost ? "one_post_test" : "full_posting_plan";
  const planId = `plan_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
  const at = new Date().toISOString();
  let delayCursor = 0;
  const rows = [];
  for (let index = 0; index < limit; index += 1) {
    const slot = slots[index];
    const concurrency = concurrencyBatchForSlot(slot, state);
    const product = planProducts[index];
    const originalProductIndex = Math.max(0, products.findIndex((candidate) => candidate.key === product.key));
    // HARVESTED products carry their OWN text + image + link (the first-comment url) — bypass the rotation
    // post-text, the review-image channel, and ShopYourLikes link-gen.
    const harvestedRec = String(product.key || "").startsWith("harvested:") ? harvestedRecordForKey(product.key, state) : null;
    const postText = harvestedRec ? String(harvestedRec.text || "").trim()
      : rotationValue(postTexts, state.contentRotation.postTextCursor, index, state.contentRotation.avoidPostTextReuse);
    const commentLeadIn = rotationValue(commentLeadIns, state.contentRotation.commentLeadInCursor, index, state.contentRotation.avoidCommentLeadInReuse);
    const affiliateLink = affiliateShortlinkForProduct(product, state);
    const shortlink = harvestedRec ? String(harvestedRec.firstCommentUrl || "") : linkForProductAtIndex(product, originalProductIndex, products, state);
    const imageRecord = harvestedRec ? null : reviewImageForProduct(reviewImages, product);
    const image = harvestedRec ? String(harvestedRec.imageLocalPath || "") : (imageRecord?.approved ? imageRecord.raw : "");
    const delay = state.rules.randomMinutesBetweenPosts
      ? randomInt(state.rules.minMinutesBetweenPosts || 5, state.rules.maxMinutesBetweenPosts || 16)
      : clampNumber(state.rules.minutesBetweenPosts, 1, 1440, 12);
    delayCursor += delay;
    const linkForPreview = shortlink || (state.affiliate?.enabled !== false ? "" : product.url);
    const commentText = String(state.posting.commentTemplate || "{lead_in} {link}")
      .replace("{lead_in}", commentLeadIn)
      .replace("{link}", linkForPreview)
      .replace(/\s{2,}/g, " ")
      .trim();
    const missingAssets = [];
    if (!shortlink) missingAssets.push(state.affiliate?.enabled !== false ? "shopyourlikes_mavlynk_shortlink" : "mavlynk_shortlink");
    if (harvestedRec) { if (!image) missingAssets.push("harvested_image"); } // harvested image is the downloaded local file, not a review-image record
    else if (!imageRecord) missingAssets.push("positive_review_image");
    else if (!imageRecord.approved) missingAssets.push("human_approved_review_image");
    if (!postText) missingAssets.push("unique_post_text");
    // commentLeadIn is intentionally NOT a readiness gate. It is a cosmetic comment intro (the comment
    // template may not even use {lead_in}). With a small lead-in pool + avoid-reuse, gating on it BLOCKED
    // every row past the pool size — starving all but the first ~9 profiles of ready rows so fresh
    // profiles were never selected. The comment text above already tolerates an empty lead-in.
    const readyForLiveConnector = missingAssets.length === 0;
    rows.push({
      at,
      planId,
      sequence: index + 1,
      runType,
      status: "pending_approval",
      liveExecution: readyForLiveConnector ? "ready_for_manual_or_official_connector_after_approval" : `blocked_until_${missingAssets.join("_and_")}`,
      missingAssets,
      profile: slot.profile,
      profileId: slot.profileId || profileIdFromLabel(slot.profile) || "",
      profileRunIndex: slot.profileRunIndex,
      maxConcurrentProfiles: concurrency.maxConcurrentProfiles,
      concurrencyBatch: concurrency.concurrencyBatch,
      concurrencySlot: concurrency.concurrencySlot,
      groupUrl: slot.groupUrl,
      fallbackGroupUrls: fallbackGroupUrlsForSlot(slot, state),
      groupFallbackPolicy: state.posting.groupFallbackPolicy,
      profileGroupIssueLogEndpoint: state.posting.profileGroupIssueLogEndpoint,
      productUrl: product.url,
      productKey: product.key,
      productId: product.productId,
      retailer: product.store,
      title: harvestedRec ? (String(harvestedRec.text || "").slice(0, 120) || product.title) : (product.storedTitle || product.title), // harvested: its description; else the real discovered title
      productDiscoveryAt: runType === "full_posting_plan" ? (state.productDiscovery?.lastSuccessfulRunAt || "") : "",
      productDiscoveryStatus: runType === "full_posting_plan" ? (state.productDiscovery?.lastRunStatus || "") : "",
      postText,
      commentLeadIn,
      commentTextPreview: commentText,
      link: linkForPreview,
      shopYourLikesUrl: affiliateLink.sylLink || "",
      linkSource: affiliateLink.sylLink ? "mavlynk_shortened_shopyourlikes" : (shortlink ? "mavlynk_shortlink" : "missing"),
      linkStatus: shortlink ? "shortlink_ready" : "needs_mavlynk_shortlink",
      image: image || "",
      imageStatus: imageRecord ? (imageRecord.approved ? "approved_image_ready" : `needs_human_image_approval:${imageRecord.status}`) : "needs_positive_review_image",
      postTextStatus: postText ? "post_text_ready" : "needs_unique_post_text",
      commentLeadInStatus: commentLeadIn ? "comment_lead_in_ready" : "needs_unique_comment_lead_in",
      plannedDelayMinutesFromPrevious: delay,
      plannedOffsetMinutes: delayCursor,
      peakWindow: `${state.rules.peakStartTime || "18:00"}-${state.rules.peakStopTime || "23:00"} ${state.rules.peakHoursTimezone || "America/New_York"}`,
      linkPlacement: state.rules.linkPlacement,
      pinFirstComment: Boolean(state.rules.pinFirstComment),
      externalActionPolicy: "approval_required_no_browser_limit_bypass",
    });
  }
  const postingPlanContent = writeJsonlFile(state.files.postingPlan || "data/posting-plan.jsonl", rows);
  registers.postingPlan = postingPlanContent;
  registers.pendingApprovals = removePendingApprovalTypes(registers.pendingApprovals, ["posting_plan_item", "posting_plan_run"]);
  appendApprovalLine(registers, `${at} | type=posting_plan_run | run_type=${runType} | plan_id=${planId} | status=pending | item_count=${rows.length} | file=${state.files.postingPlan} | reason=approve prepared posting plan before any live connector`);
  for (const row of rows) {
    appendApprovalLine(registers, `${at} | type=posting_plan_item | run_type=${runType} | plan_id=${planId} | sequence=${row.sequence} | profile=${row.profile} | group_url=${row.groupUrl} | product_url=${row.productUrl} | status=pending | reason=${row.liveExecution}`);
  }
  writeRegisters(registers);
  logEvent(options.testPost ? "posting_test_plan_prepared" : "posting_plan_prepared", { planId, itemCount: rows.length, runType });
  return {
    state: readState(),
    registers: readRegisters(),
    planId,
    runType,
    itemCount: rows.length,
    readyForLiveConnector: rows.filter((row) => row.liveExecution.startsWith("ready")).length,
    blocked: rows.filter((row) => row.liveExecution.startsWith("blocked")).length,
    file: state.files.postingPlan,
    sample: rows.slice(0, 10),
  };
}

function profileRankingFromLedger(profileId, ledgerEntries = []) {
  let lastSuccessMs = 0;
  let lastFailureMs = 0;
  const numericProfileId = Number(profileId || 0);
  if (!numericProfileId) return { lastSuccessMs, lastFailureMs };
  for (const item of ledgerEntries) {
    if (!item || Number(item.profileId || 0) !== numericProfileId) continue;
    const atMs = Date.parse(item.at || 0);
    if (!Number.isFinite(atMs)) continue;
    const status = String(item.status || "").toLowerCase();
    if (["published", "published_with_warning"].includes(status)) {
      if (atMs > lastSuccessMs) lastSuccessMs = atMs;
    } else if (/error|failed|cannot|missing|unverified|recovery_failed|url_not_found|uncertain_after_post_click|verification_failed|no_alternate|preopen_cleanup_failed/i.test(status)) {
      if (atMs > lastFailureMs) lastFailureMs = atMs;
    }
  }
  return { lastSuccessMs, lastFailureMs };
}

async function ixBrowserPostingFallbackSlots(state = readState(), options = {}) {
  const excludedIds = excludedProfileIdSetFromOptions(options);
  const groupUrls = [];
  const seenGroups = new Set();
  const addGroup = (value) => {
    const clean = sanitizeFacebookGroupUrl(value, { allowBlank: true });
    const key = normalizedFacebookGroupKey(clean);
    if (!clean || !key || seenGroups.has(key)) return;
    seenGroups.add(key);
    groupUrls.push(clean);
  };
  for (const group of Array.isArray(state.posting?.groupAssignmentData) ? state.posting.groupAssignmentData : []) {
    addGroup(group?.url);
  }
  recordLines(state.posting?.groups).forEach(addGroup);
  if (!groupUrls.length) return [];

  const data = await ixBrowserRequest("profile-list", { page: 1, limit: 100 });
  const rows = ixBrowserProfileRows(data);
  const maxProfiles = clampNumber(state.ixbrowser?.maxProfilesPerRun, 1, 1000000, 100000);
  let ledgerEntries = [];
  try { ledgerEntries = readJsonlAbsoluteFile(FB_LIVE_POST_LEDGER_FILE, { limit: 5000 }); } catch {}
  const eligible = [];
  for (const rawProfile of rows.profiles || []) {
    const profile = sanitizeIxBrowserProfile(rawProfile);
    const profileId = Number(profile.profile_id || profile.id || 0);
    const label = oneLineField(`${profileId}${profile.name ? ` - ${profile.name}` : ""}`, 180);
    if (!profileId || !label) continue;
    if (excludedIds.has(profileId)) continue;
    if (isDedicatedShopYourLikesIxProfile(profileId, state) || isDedicatedShopYourLikesProfileLabel(label, state)) continue;
    if (isBlockedIxBrowserProfileLabel(label, state)) continue;
    if (isFacebookAdminApprovalProfileId(profileId, state) || isFacebookAdminApprovalProfileLabel(label, state)) continue;
    const allowedGroups = groupUrls.filter((groupUrl) => (
      !isProfileBlockedForPosting(label, state, groupUrl) &&
      !isProfileGroupBlockedForPosting(label, groupUrl, state)
    ));
    if (!allowedGroups.length) continue;
    const ranking = profileRankingFromLedger(profileId, ledgerEntries);
    eligible.push({
      profileId,
      label,
      allowedGroups,
      ranking,
      originalIndex: eligible.length,
    });
  }
  const now = Date.now();
  const SUCCESS_FRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
  const FAILURE_HOT_WINDOW_MS = 6 * 60 * 60 * 1000;
  const isTestPost = Boolean(options.testPost || options.test_post);
  if (isTestPost) {
    // Test runs: pick a random eligible profile so we exercise different
    // identities instead of always landing on the highest-ranked one. Hot-
    // failure profiles still go last so we don't immediately re-hit a broken
    // profile in a back-to-back retry.
    for (let i = eligible.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [eligible[i], eligible[j]] = [eligible[j], eligible[i]];
    }
    eligible.sort((a, b) => {
      const aHotFailure = a.ranking.lastFailureMs > 0 && (now - a.ranking.lastFailureMs) < FAILURE_HOT_WINDOW_MS;
      const bHotFailure = b.ranking.lastFailureMs > 0 && (now - b.ranking.lastFailureMs) < FAILURE_HOT_WINDOW_MS;
      if (aHotFailure !== bHotFailure) return aHotFailure ? 1 : -1;
      return 0;
    });
  } else {
    eligible.sort((a, b) => {
      const aHasFreshSuccess = a.ranking.lastSuccessMs > 0 && (now - a.ranking.lastSuccessMs) < SUCCESS_FRESH_WINDOW_MS;
      const bHasFreshSuccess = b.ranking.lastSuccessMs > 0 && (now - b.ranking.lastSuccessMs) < SUCCESS_FRESH_WINDOW_MS;
      if (aHasFreshSuccess !== bHasFreshSuccess) return aHasFreshSuccess ? -1 : 1;
      if (a.ranking.lastSuccessMs !== b.ranking.lastSuccessMs) return b.ranking.lastSuccessMs - a.ranking.lastSuccessMs;
      const aHotFailure = a.ranking.lastFailureMs > 0 && (now - a.ranking.lastFailureMs) < FAILURE_HOT_WINDOW_MS;
      const bHotFailure = b.ranking.lastFailureMs > 0 && (now - b.ranking.lastFailureMs) < FAILURE_HOT_WINDOW_MS;
      if (aHotFailure !== bHotFailure) return aHotFailure ? 1 : -1;
      if (a.ranking.lastFailureMs !== b.ranking.lastFailureMs) return a.ranking.lastFailureMs - b.ranking.lastFailureMs;
      return a.originalIndex - b.originalIndex;
    });
  }
  const slots = [];
  for (const entry of eligible.slice(0, maxProfiles)) {
    for (const groupUrl of entry.allowedGroups) {
      slots.push({
        groupUrl,
        assignedGroupUrl: groupUrl,
        profile: entry.label,
        profileKey: profileKeyFromLabel(entry.label),
        profileId: entry.profileId,
        postNumber: 1,
      });
    }
  }
  logEvent("ixbrowser_posting_fallback_slots_loaded", {
    groups: groupUrls.length,
    profiles: Math.min(eligible.length, maxProfiles),
    slots: slots.length,
    totalProfiles: rows.total || rows.profiles?.length || 0,
    excludedProfiles: excludedIds.size,
    sortedBy: isTestPost
      ? "random_with_hot_failure_last"
      : "recent_success_desc_then_oldest_failure_asc",
    topProfile: slots[0]?.profile || "",
    eligibleCount: eligible.length,
  });
  return slots;
}

async function preparePostingPlanWithFallbackProfiles(options = {}) {
  if (!options.testPost && !options.discoveryAlreadyRun && !options.discovery_already_run && !options.skipDiscovery && !options.skip_discovery) {
    const discovery = await runProductDiscovery({
      includeExistingCandidates: true,
      includeUsedProducts: false,
    });
    if (!Number(discovery.discovered || 0)) {
      const err = new Error(discovery.message || "Fresh production product discovery found no usable product candidates.");
      err.statusCode = 409;
      throw err;
    }
  }
  try {
    return preparePostingPlan(options);
  } catch (err) {
    if (err.publicError !== "no_eligible_facebook_posting_profile" && !/No group\/profile assignments are ready/i.test(err.message || "")) throw err;
    const extraSlots = await ixBrowserPostingFallbackSlots(readState(), options);
    if (!extraSlots.length) throw err;
    return preparePostingPlan({ ...options, extraSlots });
  }
}

function oneLineField(value, maxLength = 180) {
  return String(value || "")
    .replace(/[\r\n|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeProfileRecord(body = {}) {
  const rawLabel = oneLineField(body.profileLabel || body.profile || "", 180);
  const selectedName = oneLineField(body.profileName || "", 160);
  let profileId = oneLineField(body.profileId || body.profile_id || "", 64);
  if (!/^\d{1,20}$/.test(profileId)) profileId = "";
  if (!profileId) {
    const match = rawLabel.match(/^\s*(\d{1,20})(?:\s*[-: ]|$)/);
    if (match) profileId = match[1];
  }
  const label = rawLabel || [profileId, selectedName].filter(Boolean).join(" - ");
  const looseName = selectedName || label.replace(/^\s*\d{1,20}\s*[-: ]\s*/, "");
  const keySource = profileId ? `id:${profileId}` : `label:${label.toLowerCase()}`;
  const profileKey = crypto.createHash("sha256").update(keySource).digest("hex").slice(0, 16);
  const tokens = [`profile_key=${profileKey}`];
  if (profileId) tokens.push(`profile_id=${profileId}`);
  if (label) tokens.push(`profile=${label}`);
  const strictTokens = [...tokens];
  if (looseName && looseName !== label) tokens.push(looseName);
  return {
    profileId,
    profileKey,
    label,
    name: looseName,
    reason: oneLineField(body.reason || "Facebook comment limit or IP/account review required", 240),
    strictTokens: strictTokens.map((token) => token.toLowerCase()),
    tokens: tokens.map((token) => token.toLowerCase()),
  };
}

function profileRecordExists(sources, record, markerPattern) {
  return sources.join("\n").toLowerCase().split(/\r?\n/).some((line) => {
    if (!markerPattern.test(line)) return false;
    return record.tokens.some((token) => token.length > 2 && line.includes(token));
  });
}

function appendUniqueRecordLine(value, line) {
  const current = String(value || "").trimEnd();
  const lines = current.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  if (lines.includes(line)) return current ? `${current}\n` : "";
  return `${current}${current ? "\n" : ""}${line}\n`;
}

function removeProfileLine(value, record) {
  const tokens = record.strictTokens || record.tokens;
  return String(value || "")
    .split(/\r?\n/)
    .filter((line) => {
      const lower = line.toLowerCase();
      return !tokens.some((token) => token.length > 2 && lower.includes(token));
    })
    .join("\n");
}

function buildProfileRecordLine(record, fields) {
  const parts = [
    new Date().toISOString(),
    `profile_key=${record.profileKey}`,
  ];
  if (record.profileId) parts.push(`profile_id=${record.profileId}`);
  parts.push(`profile=${record.label}`);
  if (record.name && record.name !== record.label) parts.push(`name=${record.name}`);
  for (const [key, value] of Object.entries(fields)) {
    parts.push(`${key}=${oneLineField(value, 260)}`);
  }
  return parts.join(" | ");
}

function writeCommentLimitAttempt(body) {
  const record = normalizeProfileRecord(body);
  if (!record.label) {
    const err = new Error("Profile ID or name is required");
    err.statusCode = 400;
    throw err;
  }
  const state = readState();
  const registers = readRegisters();
  const sources = [
    registers.pendingApprovals,
    registers.accountsToReview,
    registers.failedIps,
    state.ixbrowser?.failedProfiles,
  ].map((value) => String(value || ""));
  if (profileRecordExists(sources, record, /one_ip_attempt=1\/1/i)) {
    const err = new Error("This profile already used its one IP correction attempt");
    err.statusCode = 409;
    throw err;
  }
  const line = buildProfileRecordLine(record, {
    one_ip_attempt: "1/1",
    status: "pending_manual_comment_test",
    reason: record.reason,
    action: "one approved proxy correction only; if comments still fail, quarantine profile",
  });
  state.ixbrowser.failedProfiles = appendUniqueRecordLine(state.ixbrowser.failedProfiles, line);
  registers.pendingApprovals = appendUniqueRecordLine(registers.pendingApprovals, line);
  registers.accountsToReview = appendUniqueRecordLine(registers.accountsToReview, line);
  registers.failedIps = appendUniqueRecordLine(registers.failedIps, line);
  const nextState = writeState(state);
  const nextRegisters = writeRegisters(registers);
  logEvent("comment_limit_one_ip_attempt_recorded", {
    profileId: record.profileId || "",
    profileKey: record.profileKey,
  });
  return { state: nextState, registers: nextRegisters, attempt: { profileId: record.profileId, profileKey: record.profileKey } };
}

function writeCommentLimitQuarantine(body) {
  const record = normalizeProfileRecord(body);
  if (!record.label) {
    const err = new Error("Profile ID or name is required");
    err.statusCode = 400;
    throw err;
  }
  const state = readState();
  const registers = readRegisters();
  const line = buildProfileRecordLine(record, {
    status: "cannot_comment",
    reason: record.reason,
    action: "quarantined; no automatic IP retry/comment test; manual review required",
  });
  state.ixbrowser.failedProfiles = appendUniqueRecordLine(state.ixbrowser.failedProfiles, line);
  state.posting.facebookProfileStatus = appendUniqueRecordLine(state.posting.facebookProfileStatus, line);
  state.ixbrowser.activeProfiles = removeProfileLine(state.ixbrowser.activeProfiles, record);
  state.ixbrowser.profilesForNextRun = removeProfileLine(state.ixbrowser.profilesForNextRun, record);
  registers.limitedAccounts = appendUniqueRecordLine(registers.limitedAccounts, line);
  registers.downFacebookProfiles = appendUniqueRecordLine(registers.downFacebookProfiles, line);
  registers.pendingApprovals = appendUniqueRecordLine(registers.pendingApprovals, line);
  registers.accountsToReview = appendUniqueRecordLine(registers.accountsToReview, line);
  const nextState = writeState(state);
  const nextRegisters = writeRegisters(registers);
  logEvent("comment_limit_profile_quarantined", {
    profileId: record.profileId || "",
    profileKey: record.profileKey,
  });
  return { state: nextState, registers: nextRegisters, quarantine: { profileId: record.profileId, profileKey: record.profileKey } };
}

function facebookAccountBlockStatusFromReason(reason = "") {
  const text = String(reason || "").toLowerCase();
  if (/suspend|disable|deactivat/.test(text)) return "facebook_account_suspended_or_disabled";
  return "facebook_account_blocked_or_review_required";
}

function recordFacebookAccountHardBlock(body = {}) {
  const record = normalizeProfileRecord({
    ...body,
    reason: body.reason || "Facebook account is suspended, disabled, locked, or requires account review.",
  });
  if (!record.label) {
    const err = new Error("Profile ID or name is required");
    err.statusCode = 400;
    throw err;
  }
  const groupUrl = sanitizeFacebookGroupUrl(body.groupUrl || body.group_url || "", { allowBlank: true });
  const status = facebookAccountBlockStatusFromReason(record.reason);
  const state = readState();
  const registers = readRegisters();
  const line = buildProfileRecordLine(record, {
    component: "facebook_account_status",
    issue: "account_unusable",
    status,
    group_url: groupUrl || "not_supplied",
    reason: record.reason,
    source: oneLineField(body.source || "facebook_live_connector", 120),
    action: "quarantined_skip_ixbrowser_profile_for_facebook",
  });
  state.ixbrowser.failedProfiles = appendUniqueRecordLine(state.ixbrowser.failedProfiles, line);
  state.posting.facebookProfileStatus = appendUniqueRecordLine(state.posting.facebookProfileStatus, line);
  state.ixbrowser.activeProfiles = removeProfileLine(state.ixbrowser.activeProfiles, record);
  state.ixbrowser.profilesForNextRun = removeProfileLine(state.ixbrowser.profilesForNextRun, record);
  registers.inactiveAccounts = appendUniqueRecordLine(registers.inactiveAccounts, line);
  registers.downFacebookProfiles = appendUniqueRecordLine(registers.downFacebookProfiles, line);
  registers.accountsToReview = appendUniqueRecordLine(registers.accountsToReview, line);
  if (/restricted|limited|cannot use facebook|can't use facebook/i.test(record.reason)) {
    registers.limitedAccounts = appendUniqueRecordLine(registers.limitedAccounts, line);
  }
  registers.errors = appendUniqueRecordLine(registers.errors, [
    new Date().toISOString(),
    "error",
    "facebook_account_status",
    oneLineField(body.jobId || body.job_id || "", 80),
    record.profileId || "",
    record.name || record.label,
    "FACEBOOK_ACCOUNT_QUARANTINED",
    record.reason,
    `group_url=${groupUrl || "not_supplied"} source=${oneLineField(body.source || "facebook_live_connector", 80)}`,
    "open",
  ].join(" | "));
  const nextState = writeState(state);
  const nextRegisters = writeRegisters(registers);
  logEvent("facebook_account_profile_quarantined", {
    profileId: record.profileId || "",
    profileKey: record.profileKey,
    profile: record.label,
    groupUrl: groupUrl || "",
    status,
    source: oneLineField(body.source || "facebook_live_connector", 120),
  });
  return { state: nextState, registers: nextRegisters, quarantine: { profileId: record.profileId, profileKey: record.profileKey, status } };
}

function sanitizeFacebookGroupUrl(value, options = {}) {
  const raw = String(value || "").trim();
  if (!raw && options.allowBlank) return "";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    const err = new Error("A valid Facebook group URL is required");
    err.statusCode = 400;
    throw err;
  }
  if (!/(^|\.)facebook\.com$/i.test(parsed.hostname) || !/^\/groups\//i.test(parsed.pathname)) {
    const err = new Error("Only https://www.facebook.com/groups/... URLs are allowed");
    err.statusCode = 400;
    throw err;
  }
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  return parsed.toString();
}

const __fbGroupUrlListMemo = new Map();
function sanitizeFacebookGroupUrlList(value) {
  // Pure function of `value`; memoize string inputs. It is called per-status-line inside the
  // per-profile/per-product block checks, so the same log lines get re-parsed thousands of times
  // during one autopilotStatus/assetBufferStatus compute. Memoizing collapses that to once/line.
  const __memoStr = typeof value === "string" ? value : null;
  if (__memoStr !== null) { const hit = __fbGroupUrlListMemo.get(__memoStr); if (hit) return hit; }
  const embeddedUrls = Array.isArray(value)
    ? []
    : (String(value || "").match(/https?:\/\/(?:[^/\s|,]+\.)?facebook\.com\/groups\/[^\s|,)]+/gi) || []);
  const raw = Array.isArray(value)
    ? value
    : (embeddedUrls.length ? embeddedUrls : String(value || "").split(/\r?\n|,/));
  const urls = [];
  const seen = new Set();
  for (const item of raw) {
    try {
      const clean = sanitizeFacebookGroupUrl(item, { allowBlank: true });
      if (!clean) continue;
      const key = clean.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      urls.push(clean);
    } catch {
      // Ignore malformed attempted URLs in issue logs; keep the primary error concise.
    }
  }
  const __res = urls.slice(0, 20);
  if (__memoStr !== null) { if (__fbGroupUrlListMemo.size > 50000) __fbGroupUrlListMemo.clear(); __fbGroupUrlListMemo.set(__memoStr, __res); }
  return __res;
}

function sanitizeFacebookPostUrl(value) {
  const raw = String(value || "").trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    const err = new Error("A valid Facebook post URL is required");
    err.statusCode = 400;
    throw err;
  }
  if (!/(^|\.)facebook\.com$/i.test(parsed.hostname)) {
    const err = new Error("Only Facebook post URLs are allowed");
    err.statusCode = 400;
    throw err;
  }
  if (!/^\/groups\/[^/]+\/(?:permalink|posts)\/[^/]+\/?$/i.test(parsed.pathname)) {
    const err = new Error("Only Facebook group post/permalink URLs are accepted, for example https://www.facebook.com/groups/{groupId}/permalink/{postId}/");
    err.statusCode = 400;
    throw err;
  }
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString();
}

function facebookGroupUrlFromPostUrl(postUrl) {
  try {
    const parsed = new URL(String(postUrl || "").trim());
    const match = parsed.pathname.match(/^\/groups\/([^/]+)\/(?:permalink|posts)\/[^/]+\/?$/i);
    if (!match) return "";
    return `https://www.facebook.com/groups/${match[1]}`;
  } catch {
    return "";
  }
}

function livePostLedgerKey(row = {}, profileId = "") {
  return [
    oneLineField(row.planId || row.plan_id || "", 120),
    Number(row.sequence || row.seq || 0),
    Number(profileId || row.profileId || profileIdFromLabel(row.profile) || 0),
  ].join(":");
}

function appendFacebookLivePostLedger(event = {}) {
  const row = {
    at: new Date().toISOString(),
    event: oneLineField(event.event || "event", 80),
    key: oneLineField(event.key || "", 180),
    planId: oneLineField(event.planId || "", 140),
    sequence: Number(event.sequence || 0),
    profileId: Number(event.profileId || 0),
    profile: oneLineField(event.profile || "", 180),
    groupUrl: oneLineField(event.groupUrl || "", 1000),
    actualGroupUrl: oneLineField(event.actualGroupUrl || facebookGroupUrlFromPostUrl(event.postUrl) || "", 1000),
    postUrl: oneLineField(event.postUrl || "", 1000),
    status: oneLineField(event.status || "", 120),
    message: oneLineField(event.message || "", 700),
    liveLogFile: oneLineField(event.liveLogFile || "", 300),
    payloadFile: oneLineField(event.payloadFile || "", 300),
    validation: event.validation && typeof event.validation === "object" ? {
      ok: Boolean(event.validation.ok),
      errors: Array.isArray(event.validation.errors) ? event.validation.errors.map(String).slice(0, 20) : [],
      warnings: Array.isArray(event.validation.warnings) ? event.validation.warnings.map(String).slice(0, 20) : [],
      postClicked: Boolean(event.validation.postClicked),
      imageConfirmed: Boolean(event.validation.imageConfirmed),
      postMediaVerified: Boolean(event.validation.postMediaVerified),
      commentPostVisible: event.validation.commentPostVisible !== false,
      commentSubmitted: Boolean(event.validation.commentSubmitted),
      commentVerified: Boolean(event.validation.commentVerified),
      commentBlocked: Boolean(event.validation.commentBlocked),
      pinRequired: Boolean(event.validation.pinRequired),
      commentPinClicked: Boolean(event.validation.commentPinClicked),
      commentPinVerified: Boolean(event.validation.commentPinVerified),
    } : null,
    closeResult: event.closeResult && typeof event.closeResult === "object" ? {
      ok: Boolean(event.closeResult.ok),
      status: oneLineField(event.closeResult.status || "", 80),
      profileId: Number(event.closeResult.profileId || 0),
      message: oneLineField(event.closeResult.message || "", 240),
    } : null,
  };
  try {
    appendJsonlAbsoluteFile(FB_LIVE_POST_LEDGER_FILE, row);
  } catch (err) {
    logEvent("facebook_live_post_ledger_write_failed", {
      event: row.event,
      key: row.key,
      error: oneLineField(err.message || String(err), 240),
    });
  }
  return row;
}

function requiredCommentNeedlesForServer(text = "") {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  const urls = raw.match(/https?:\/\/\S+/g) || [];
  if (urls.length) {
    return [...new Set(urls.flatMap((url) => {
      const clean = url.replace(/[).,]+$/g, "");
      const withoutProtocol = clean.replace(/^https?:\/\//i, "");
      const withoutWww = withoutProtocol.replace(/^www\./i, "");
      return [clean, withoutProtocol, withoutWww];
    }).filter((item) => item.length >= 6))];
  }
  return raw.length >= 12 ? [raw] : [];
}

function liveLogHasRequiredCommentNeedle(liveLogFile = "", commentText = "") {
  const needles = requiredCommentNeedlesForServer(commentText);
  if (!needles.length || !liveLogFile) return false;
  try {
    const logPath = safeProjectPath(liveLogFile);
    const log = parseJsonFile(logPath);
    const rows = Array.isArray(log?.objects) ? log.objects : [];
    const text = rows.map((item) => [
      item?.verifiedNeedle,
      item?.verifiedSnippet,
      item?.bodyChecks?.commentNeedle,
      item?.commentResult?.verifiedNeedle,
      item?.commentResult?.verifiedSnippet,
      item?.commentResult?.verified === true ? item?.bodyChecks?.commentNeedle : "",
    ].filter(Boolean).join("\n")).join("\n");
    return needles.some((needle) => text.includes(needle));
  } catch {
    return false;
  }
}

function latestPublishedFacebookLivePostForRow(row = {}, profileId = "") {
  const key = livePostLedgerKey(row, profileId);
  const rows = readJsonlAbsoluteFile(FB_LIVE_POST_LEDGER_FILE, { limit: 5000 });
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const item = rows[index];
    if (!item || item.key !== key || !item.postUrl) continue;
    if (!["published", "published_with_warning", "published_verification_failed"].includes(String(item.status || ""))) continue;
    try {
      const postUrl = sanitizeFacebookPostUrl(item.postUrl);
      return {
        ...item,
        postUrl,
        actualGroupUrl: item.actualGroupUrl || facebookGroupUrlFromPostUrl(postUrl) || item.groupUrl || "",
      };
    } catch {
      continue;
    }
  }
  return null;
}

function latestSubmittedUrlMissingFacebookLivePostForRow(row = {}, profileId = "") {
  const key = livePostLedgerKey(row, profileId);
  const rows = readJsonlAbsoluteFile(FB_LIVE_POST_LEDGER_FILE, { limit: 5000 });
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const item = rows[index];
    if (!item || item.key !== key) continue;
    if (item.postUrl && ["published", "published_with_warning", "published_verification_failed"].includes(String(item.status || ""))) {
      return null;
    }
    const event = String(item.event || "");
    const status = String(item.status || "");
    if (status === "submitted_url_missing" || /^submitted_url_missing/.test(event)) {
      return {
        ...item,
        actualGroupUrl: item.actualGroupUrl || item.groupUrl || "",
      };
    }
  }
  return null;
}

function latestDifferentProfileVerifiedCommentForPost(postUrl = "", publishingProfileId = "") {
  let cleanPostUrl = "";
  try {
    cleanPostUrl = sanitizeFacebookPostUrl(postUrl);
  } catch {
    return null;
  }
  const publisherId = Number(publishingProfileId || 0);
  const rows = readJsonlAbsoluteFile(FB_LIVE_POST_LEDGER_FILE, { limit: 5000 });
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const item = rows[index];
    if (!item || item.postUrl !== cleanPostUrl) continue;
    if (item.event !== "comment_recovery_finished") continue;
    if (!["published", "published_with_warning"].includes(String(item.status || ""))) continue;
    if (publisherId && Number(item.profileId || 0) === publisherId) continue;
    if (item.validation && item.validation.commentVerified === false) continue;
    return item;
  }
  return null;
}

function postingPlanRowForRecord(body = {}) {
  const rows = latestPostingPlanRows();
  const planId = oneLineField(body.planId || body.plan_id || "", 140);
  const sequence = Number(body.sequence || body.seq || 0);
  if (!planId && !sequence) return null;
  // EXACT match (planId + sequence) is the only confident identification of the posted row.
  if (planId && sequence) return rows.find((row) => row.planId === planId && Number(row.sequence) === sequence) || null;
  if (sequence) return rows.find((row) => Number(row.sequence) === sequence) || null;
  // planId ONLY: never guess across sequences — matching the FIRST row records the WRONG product
  // (the duplicate-post bug: the actually-posted product never gets marked used → re-picked next
  // tick → posted again). Only resolve when the plan has exactly one row for that id.
  const matches = rows.filter((row) => row.planId === planId);
  return matches.length === 1 ? matches[0] : null;
}

function recordPublishedFacebookPostUrl(body) {
  const postUrl = sanitizeFacebookPostUrl(body.postUrl || body.post_url || body.url);
  const at = new Date().toISOString();
  const planId = oneLineField(body.planId || body.plan_id || "", 120);
  const profile = oneLineField(body.profile || body.profileLabel || body.profile_label || "", 180);
  const suppliedGroupUrl = sanitizeFacebookGroupUrl(body.groupUrl || body.group_url || "", { allowBlank: true });
  const postedGroupUrl = facebookGroupUrlFromPostUrl(postUrl);
  const groupUrl = postedGroupUrl || suppliedGroupUrl;
  const state = readState();
  const line = [
    at,
    "type=facebook_post_published",
    planId ? `plan_id=${planId}` : "",
    profile ? `profile=${profile}` : "",
    groupUrl ? `group_url=${groupUrl}` : "",
    `post_url=${postUrl}`,
    "status=recorded",
  ].filter(Boolean).join(" | ");
  state.posting.publishedPostUrls = appendUniqueRecordLine(state.posting.publishedPostUrls || "", line);
  state.tracking.dailyActionLog = appendUniqueRecordLine(state.tracking.dailyActionLog || "", line);
  const nextState = writeState(state);
  // Prefer the EXACT posted row the caller hands us — it knows precisely which product/post text
  // was published. Re-deriving by planId+sequence is only a fallback for the external
  // record-post-url endpoint. (Recording the wrong row's product was the duplicate-post bug.)
  const row = (body.row && typeof body.row === "object") ? body.row : postingPlanRowForRecord(body);
  if (row) markLivePostedRegisters(row, postUrl);
  // HARVESTED product just posted -> DELETE the downloaded image to save HDD, but KEEP its text+url forever
  // (the record stays with posted set, so the harvester's url-dedup never re-fetches it).
  if (row && String(row.productKey || "").startsWith("harvested:")) {
    try {
      if (row.image) { const ip = safeProjectPath(row.image); if (fs.existsSync(ip)) { fs.unlinkSync(ip); logEvent("harvested_image_deleted", { productKey: row.productKey, image: row.image }); } }
    } catch (e) { logEvent("harvested_image_deletion_error", { productKey: row.productKey, error: oneLineField(e.message || String(e), 140) }); }
    try { updateHarvestedProductRecord(row.productKey, { posted: new Date().toISOString(), imageDeleted: true, postUrl: String(postUrl || "") }); } catch (_) {}
  }
  logEvent("facebook_post_url_recorded", { planId, profile, groupUrl, postUrl });
  return {
    state: nextState,
    registers: readRegisters(),
    postUrl,
    planId,
    profile,
    groupUrl,
    recordedAt: at,
  };
}

function latestPostingPlanRows(state = readState()) {
  return readJsonlFile(state.files?.postingPlan || "data/posting-plan.jsonl");
}

function selectedPostingPlanRow(rows, body = {}) {
  const planId = oneLineField(body.planId || body.plan_id || "", 140);
  const sequence = Number(body.sequence || body.seq || 0);
  const runType = body.fullRun ? "full_posting_plan" : "one_post_test";
  const scopedRows = rows.filter((row) => row.runType === runType);
  if (planId || sequence) {
    const matched = scopedRows.find((row) => (!planId || row.planId === planId) && (!sequence || Number(row.sequence) === sequence));
    if (matched) return matched;
    return null;
  }
  return scopedRows[0] || null;
}

function assertProjectFileForPosting(value, label) {
  const raw = String(value || "").trim();
  if (!raw) {
    const err = new Error(`${label} is missing from the posting plan.`);
    err.statusCode = 409;
    throw err;
  }
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : safeProjectPath(raw);
  if (!fs.existsSync(resolved)) {
    const err = new Error(`${label} file was not found: ${raw}`);
    err.statusCode = 409;
    throw err;
  }
  const real = fs.realpathSync(resolved);
  const relative = path.relative(REAL_ROOT, real);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    const err = new Error(`${label} must stay inside the Facebook Agent project folder.`);
    err.statusCode = 400;
    throw err;
  }
  return real;
}

function assertFacebookUploadImageFormat(filePath) {
  const ext = path.extname(filePath || "").toLowerCase();
  if (![".jpg", ".jpeg", ".png"].includes(ext)) {
    const err = new Error(`Facebook image must be JPG or PNG. WebP is not allowed for posting: ${path.basename(filePath || "")}`);
    err.statusCode = 409;
    throw err;
  }
  return true;
}

function postingPlanRowApprovalStatus(row, state = readState()) {
  if (!state.operator?.approvalRequired) return "not_required";
  const rowStatus = String(row?.status || "").toLowerCase();
  if (/approved|ready_for_live/.test(rowStatus)) return "approved";
  const decisions = latestApprovalDecisionMap();
  const registers = readRegisters();
  for (const line of recordLines(registers.pendingApprovals || "")) {
    const fields = recordFieldsFromLine(line);
    if (fields.type !== "posting_plan_item") continue;
    if (row?.planId && fields.plan_id !== row.planId) continue;
    if (row?.sequence && Number(fields.sequence || 0) !== Number(row.sequence)) continue;
    const decision = decisions.get(approvalId("pendingApprovals", line));
    if (decision?.status) return decision.status;
  }
  return "missing";
}

function liveApprovalGrantedForRow(row, body = {}, state = readState()) {
  if (!state.operator?.approvalRequired) return true;
  // Autopilot bypasses the human approval gate for its OWN autonomous posts
  // only (manual flows keep the gate). Requires BOTH the per-call autopilot
  // flag AND the global master switch -- defense in depth.
  if ((body.autopilot || body.autopilot_run) && state.operator?.autopilotEnabled) return true;
  if (body.fullRun) return postingPlanRowApprovalStatus(row, state) === "approved";
  if (body.operatorApprovedLive || body.operator_approved_live || body.operatorConfirmedLive || body.operator_confirmed_live) return true;
  return postingPlanRowApprovalStatus(row, state) === "approved";
}

function assertProductionApprovalGateEnabled(state = readState()) {
  if (state.operator?.approvalRequired) return;
  const err = new Error("Full production runs require Human approval to be enabled. Turn on Human approval, approve the posting-plan rows, then start the live full run.");
  err.statusCode = 409;
  err.publicError = "production_approval_gate_required";
  throw err;
}

function assertFullPostingPlanRowsApproved(rows = [], state = readState()) {
  const missing = rows.filter((row) => postingPlanRowApprovalStatus(row, state) !== "approved");
  if (!missing.length) return;
  const err = new Error(`Full production run blocked: ${missing.length} ready row(s) still need posting-plan approval before any live publish starts.`);
  err.statusCode = 409;
  err.publicError = "production_approval_missing";
  err.missingApprovals = missing.slice(0, 20).map((row) => ({
    planId: row.planId || "",
    sequence: row.sequence || "",
    profile: row.profile || "",
    groupUrl: row.groupUrl || "",
  }));
  throw err;
}

function assertPostingRowReadyForLive(row, body = {}) {
  if (!row) {
    const err = new Error("No prepared posting-plan row is available. Run the 1-post workflow first.");
    err.statusCode = 404;
    throw err;
  }
  const expectedRunType = body.fullRun ? "full_posting_plan" : "one_post_test";
  if (row.runType !== expectedRunType) {
    const err = new Error(`Prepared row is for ${row.runType || "unknown"} but this route requires ${expectedRunType}.`);
    err.statusCode = 409;
    throw err;
  }
  const state = readState();
  if (!liveApprovalGrantedForRow(row, body, state)) {
    const err = new Error("Live Facebook posting is waiting for explicit approval. Approve the posting-plan item or confirm the live run from the dashboard.");
    err.statusCode = 409;
    throw err;
  }
  if (!String(row.liveExecution || "").startsWith("ready")) {
    const err = new Error(`Posting row is not ready for live connector: ${row.liveExecution || "unknown"}`);
    err.statusCode = 409;
    throw err;
  }
  const profileId = Number(row.profileId || profileIdFromLabel(row.profile));
  if (!profileId) {
    const err = new Error("Posting row is missing an IXBrowser profile ID.");
    err.statusCode = 409;
    throw err;
  }
  assertNotDedicatedShopYourLikesIxProfile(profileId, "Facebook live posting");
  const profileLabel = String(row.profile || profileId).trim();
  const groupUrl = sanitizeFacebookGroupUrl(row.groupUrl || "");
  if (isDedicatedShopYourLikesProfileLabel(profileLabel, state)) {
    const err = new Error(`IXBrowser profile "${profileLabel}" is reserved for ShopYourLikes/Mavlynk and cannot be used for Facebook live posting.`);
    err.statusCode = 409;
    err.publicError = "dedicated_shopyourlikes_profile_reserved";
    throw err;
  }
  if (isBlockedIxBrowserProfileLabel(profileLabel, state)) {
    const err = new Error(`IXBrowser profile "${profileLabel}" is blocked by name and cannot be used for Facebook live posting.`);
    err.statusCode = 409;
    err.publicError = "ixbrowser_profile_name_blocked";
    throw err;
  }
  if (isFacebookAdminApprovalProfileId(profileId, state, groupUrl) || isFacebookAdminApprovalProfileLabel(profileLabel, state, groupUrl)) {
    const err = new Error(`IXBrowser profile "${profileLabel}" is a moderator/admin approval profile for this group and cannot be used for normal Facebook posting.`);
    err.statusCode = 409;
    err.publicError = "facebook_moderator_profile_reserved_for_approval";
    throw err;
  }
  if (isProfileBlockedForPosting(profileLabel, state, groupUrl) || isProfileGroupBlockedForPosting(profileLabel, groupUrl, state)) {
    const err = new Error(`IXBrowser profile "${profileLabel}" is blocked from Facebook posting for ${groupUrl}. Fix/unblock the profile in settings or rebuild the plan with another eligible profile.`);
    err.statusCode = 409;
    err.publicError = "facebook_profile_blocked_for_posting";
    throw err;
  }
  const imagePath = assertProjectFileForPosting(row.image, "Facebook image");
  assertFacebookUploadImageFormat(imagePath);
  if (!String(row.postText || "").trim()) {
    const err = new Error("Posting row is missing post text.");
    err.statusCode = 409;
    throw err;
  }
  if (!String(row.commentTextPreview || row.link || "").trim()) {
    const err = new Error("Posting row is missing first-comment text/link.");
    err.statusCode = 409;
    throw err;
  }
  return { profileId, groupUrl, imagePath };
}

function parseJsonLogObjects(text) {
  const rows = [];
  let buffer = "";
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!buffer && !trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
    buffer = buffer ? `${buffer}\n${line}` : line;
    try {
      const parsed = JSON.parse(buffer);
      rows.push(parsed);
      buffer = "";
    } catch {
      // Keep buffering pretty-printed JSON log objects.
    }
  }
  return rows;
}

// The live-posting connector opens the ixBrowser profile INSIDE the child process and logs its CDP
// endpoint as {step:'ix_open'|'ix_open_fallback', endpoint}. The server-side endpoint cache is NOT
// populated by this path, so to REUSE a kept-open session (batch cross-comment) we harvest the LAST
// ix_open endpoint from the connector log. Inert unless a caller reads .cdpEndpoint (batch path only).
function cdpEndpointFromLog(objects = []) {
  let endpoint = "";
  for (const item of Array.isArray(objects) ? objects : []) {
    if (!item || typeof item !== "object") continue;
    const step = String(item.step || "");
    if ((step === "ix_open" || step === "ix_open_fallback") && item.endpoint) endpoint = String(item.endpoint);
  }
  return endpoint;
}

function firstFacebookPostUrlFromLog(objects = []) {
  const candidates = [];
  for (const item of objects) {
    if (!item || typeof item !== "object") continue;
    const step = String(item.step || "").toLowerCase();
    const markerVerified = Boolean(
      item.markerPermalinkVerified ||
      item.commentResult?.verified ||
      item.commentResult?.verifiedNeedle ||
      item.verifiedNeedle ||
      item.verified === true
    );
    if (markerVerified) {
      if (item.postUrl) candidates.push(item.postUrl);
      if (item.postPageUrl) candidates.push(item.postPageUrl);
      if (step === "result" && item.likelyNewPostUrl) candidates.push(item.likelyNewPostUrl);
    }
    if (Array.isArray(item.verified)) {
      for (const verified of item.verified) {
        if (verified?.exactPermalink && verified?.hasMarker) candidates.push(verified?.candidate, verified?.url);
      }
    }
  }
  for (const candidate of candidates.filter(Boolean)) {
    try {
      return sanitizeFacebookPostUrl(candidate);
    } catch {}
  }
  return "";
}

function facebookPostCandidateUrlsFromLog(objects = [], groupUrl = "") {
  const candidates = [];
  const add = (value) => {
    if (!value) return;
    try {
      const clean = sanitizeFacebookPostUrl(value);
      const expectedGroup = normalizedFacebookGroupKey(groupUrl);
      const actualGroup = normalizedFacebookGroupKey(facebookGroupUrlFromPostUrl(clean));
      if (expectedGroup && actualGroup && expectedGroup !== actualGroup) return;
      candidates.push(clean);
    } catch {}
  };
  for (const item of objects || []) {
    if (!item || typeof item !== "object") continue;
    add(item.postUrl);
    add(item.postPageUrl);
    add(item.likelyNewPostUrl);
    for (const key of ["domNew", "markerScopedUrls", "candidatePostUrls", "unverifiedCandidateUrls"]) {
      if (!Array.isArray(item[key])) continue;
      item[key].forEach(add);
    }
    if (Array.isArray(item.candidateVerificationAttempts)) {
      for (const row of item.candidateVerificationAttempts) {
        add(row?.candidate);
        add(row?.best?.url);
        if (Array.isArray(row?.attempts)) row.attempts.forEach((attempt) => add(attempt?.url));
      }
    }
    if (Array.isArray(item.candidateSources)) {
      for (const row of item.candidateSources) add(row?.url);
    }
    if (Array.isArray(item.verified)) {
      for (const verified of item.verified) {
        add(verified?.candidate);
        add(verified?.url);
      }
    }
    if (Array.isArray(item.captured)) {
      for (const captured of item.captured) {
        if (Array.isArray(captured?.urls)) captured.urls.forEach(add);
      }
    }
    if (Array.isArray(item.urls)) item.urls.forEach(add);
  }
  return [...new Set(candidates)];
}

function livePostLogShowsSubmittedPost(objects = []) {
  return (objects || []).some((item) => {
    const step = String(item?.step || "").toLowerCase();
    return step === "post_clicked" || step === "comment_attempted" || step === "result";
  });
}

function unverifiedFacebookPublishError(message, validation = null, details = {}) {
  const err = new Error(message || "Facebook publish was not verified; no permalink was captured.");
  err.statusCode = 502;
  err.livePostValidation = validation || {
    ok: false,
    errors: ["facebook_publish_permalink_not_verified"],
    warnings: [],
    postClicked: true,
    imageConfirmed: false,
    postMediaVerified: false,
  };
  err.livePostLog = details.livePostLog || [];
  err.livePostLogFile = details.livePostLogFile || "";
  err.candidatePostUrls = Array.isArray(details.candidatePostUrls) ? details.candidatePostUrls.slice(0, 20) : [];
  err.uncertainAfterPostClick = Boolean(details.uncertainAfterPostClick || validation?.postClicked);
  err.payloadFile = details.payloadFile || "";
  err.payloadDeleted = Boolean(details.payloadDeleted);
  return err;
}

function latestLiveLogStep(objects = [], stepName = "") {
  const wanted = String(stepName || "").toLowerCase();
  return [...(objects || [])].reverse().find((item) => String(item?.step || "").toLowerCase() === wanted) || null;
}

function livePostLogValidation(objects = [], payload = {}) {
  const imageStep = latestLiveLogStep(objects, "image_attached");
  const commentStep = latestLiveLogStep(objects, "comment_attempted");
  const pinStep = latestLiveLogStep(objects, "comment_pin_attempted");
  const resultStep = latestLiveLogStep(objects, "result");
  const accountStatusStep = latestLiveLogStep(objects, "facebook_account_status_blocked");
  const loginWaitStep = latestLiveLogStep(objects, "facebook_login_required_waiting");
  const loginTimeoutStep = latestLiveLogStep(objects, "facebook_login_wait_timeout");
  const loginRestoredStep = latestLiveLogStep(objects, "facebook_login_restored");
  const imageRequired = Boolean(String(payload.imagePath || "").trim());
  const commentRequired = Boolean(String(payload.commentText || "").trim());
  const commentOnly = payload.commentOnly === true;
  const pinRequired = commentRequired && payload.pinFirstComment !== false;
  const postClicked = commentOnly
    ? Boolean(commentStep || resultStep)
    : Boolean(latestLiveLogStep(objects, "post_clicked")?.clicked || commentStep || resultStep);
  const imageConfirmed = Boolean(imageStep?.confirmed || resultStep?.imageVerified);
  const postMediaVerified = Boolean(resultStep?.postMediaVerified);
  const postPermalinkVerified = Boolean(resultStep?.postPermalinkVerified || resultStep?.postUrl || resultStep?.postPageUrl);
  const titlePermalinkVerified = Boolean(
    resultStep?.titlePermalinkVerified ||
    (Array.isArray(resultStep?.verified) && resultStep.verified.some((item) => item?.titleHasMarker && item?.exactPermalink))
  );
  const markerPermalinkVerified = Boolean(
    resultStep?.markerPermalinkVerified ||
    (Array.isArray(resultStep?.verified) && resultStep.verified.some((item) => (
      item?.exactPermalink && item?.hasMarker
    )))
  );
  const postMediaKnown = Boolean(
    resultStep &&
    Object.prototype.hasOwnProperty.call(resultStep, "postMediaVerified") &&
    ((Array.isArray(resultStep.verified) && resultStep.verified.length) || Number(resultStep.candidateCount || 0) > 0)
  );
  const commentSubmitted = Boolean(
    commentStep?.submitted ||
    commentStep?.commented ||
    resultStep?.commentResult?.submitted
  );
  const commentBlocked = Boolean(commentStep?.blocked || resultStep?.commentResult?.blocked);
  const commentBlockReason = oneLineField(
    commentStep?.blockReason ||
    resultStep?.commentResult?.blockReason ||
    "facebook_restriction",
    120
  );
  const commentVerified = Boolean(
    commentStep?.verified ||
    resultStep?.commentResult?.verified ||
    resultStep?.bodyChecks?.commentVisible
  );
  const commentPostVisible = !commentOnly || !resultStep?.bodyChecks || resultStep.bodyChecks.markerVisible !== false || commentVerified;
  const commentPinClicked = Boolean(pinStep?.clicked || resultStep?.commentPinResult?.clicked);
  const commentPinVerified = Boolean(pinStep?.verified || resultStep?.commentPinResult?.verified);
  const errors = [];
  const warnings = [];
  if (accountStatusStep) {
    errors.push(`facebook_account_status_blocked:${oneLineField(accountStatusStep.accountBlockReason || "account_blocked", 80)}`);
  } else if (loginWaitStep && !loginRestoredStep) {
    errors.push(commentOnly ? "comment_profile_login_required" : "facebook_profile_login_required");
  } else if (!postClicked) {
    errors.push(objects.length ? "post_not_submitted" : "connector_failed_before_publish");
  } else {
    if (imageRequired && !imageConfirmed) errors.push("image_upload_not_confirmed");
    else if (!commentOnly && !markerPermalinkVerified) {
      errors.push(postPermalinkVerified ? "facebook_post_marker_permalink_not_verified" : "facebook_post_permalink_not_captured");
    }
    else if (imageRequired && postMediaKnown && !postMediaVerified) {
      if (postPermalinkVerified && markerPermalinkVerified) warnings.push("facebook_post_image_not_visible_on_permalink");
      else errors.push("facebook_post_image_not_verified");
    }
    if (commentRequired && !commentPostVisible) errors.push("comment_profile_cannot_access_post_permalink");
    else if (commentRequired && commentBlocked) errors.push(`comment_blocked:${commentBlockReason}`);
    else if (commentRequired && !commentSubmitted) errors.push("comment_not_submitted");
    else if (commentRequired && !commentVerified) errors.push("comment_not_verified");
    else if (pinRequired && !commentPinClicked) warnings.push("comment_pin_not_available");
    else if (pinRequired && !commentPinVerified) warnings.push("comment_pin_not_verified");
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    postClicked,
    imageRequired,
    imageConfirmed,
    postMediaVerified,
    postPermalinkVerified,
    markerPermalinkVerified,
    titlePermalinkVerified,
    facebookAccountBlocked: Boolean(accountStatusStep),
    facebookAccountBlockReason: accountStatusStep?.accountBlockReason || "",
    commentRequired,
    commentPostVisible,
    commentSubmitted,
    commentVerified,
    commentBlocked,
    commentBlockReason: commentBlocked ? commentBlockReason : "",
    pinRequired,
    commentPinClicked,
    commentPinVerified,
  };
}

function livePostValidationHasCommentProblem(validation = {}) {
  return (validation.errors || []).some((error) => {
    const text = String(error || "").toLowerCase();
    return text === "comment_profile_cannot_access_post_permalink" || text === "comment_not_submitted" || text === "comment_not_verified" || text.startsWith("comment_blocked");
  });
}

function livePostValidationAllowsCommentProfileFallback(validation = {}) {
  const errors = Array.isArray(validation.errors) ? validation.errors.map((error) => String(error || "").toLowerCase()) : [];
  const retryableCommentError = (error) => (
    error === "comment_profile_cannot_access_post_permalink" ||
    error === "comment_not_submitted" ||
    error === "comment_not_verified" ||
    error.startsWith("comment_blocked")
  );
  if (!errors.length || !errors.some(retryableCommentError)) return false;
  if (errors.some((error) => !retryableCommentError(error))) return false;
  if (errors.some((error) => /^comment_blocked:(comments_disabled|content_unavailable|page_unavailable)/i.test(error))) return false;
  return true;
}

function failedCommentRecoveryValidationFromAttempts(attempts = []) {
  const validations = (attempts || [])
    .map((attempt) => attempt?.validation)
    .filter((validation) => validation && typeof validation === "object");
  const commentErrors = [];
  const warnings = [];
  for (const validation of validations) {
    for (const error of validation.errors || []) {
      const text = String(error || "");
      if (/comment|pin|ufi/i.test(text)) commentErrors.push(text);
      else if (/target_marker|expected_post_permalink|comment_profile|profile_cannot_access/i.test(text)) commentErrors.push(text);
    }
    for (const warning of validation.warnings || []) warnings.push(String(warning || ""));
  }
  const blocked = validations.find((validation) => validation.commentBlocked || String(validation.commentBlockReason || "").trim());
  return {
    ok: false,
    errors: [...new Set(commentErrors.length ? commentErrors : ["comment_not_verified"])],
    warnings: [...new Set(warnings.filter(Boolean))],
    postClicked: true,
    imageRequired: false,
    imageConfirmed: true,
    postMediaVerified: true,
    postPermalinkVerified: true,
    markerPermalinkVerified: validations.some((validation) => validation.markerPermalinkVerified === true),
    titlePermalinkVerified: validations.some((validation) => validation.titlePermalinkVerified === true),
    commentRequired: true,
    commentPostVisible: validations.length ? validations.some((validation) => validation.commentPostVisible !== false) : true,
    commentSubmitted: validations.some((validation) => validation.commentSubmitted === true),
    commentVerified: false,
    commentBlocked: Boolean(blocked),
    commentBlockReason: blocked ? oneLineField(blocked.commentBlockReason || "facebook_restriction", 120) : "",
    pinRequired: true,
    commentPinClicked: validations.some((validation) => validation.commentPinClicked === true),
    commentPinVerified: false,
  };
}

function livePostValidationNeedsPinRecovery(validation = {}) {
  return Boolean(
    validation?.ok &&
    validation.pinRequired &&
    validation.commentVerified &&
    !validation.commentPinVerified
  );
}

function mergeCommentPinValidation(baseValidation = {}, pinValidation = {}) {
  const warnings = new Set([
    ...((Array.isArray(baseValidation.warnings) ? baseValidation.warnings : [])
      .filter((warning) => !/^comment_pin_not_available$|^comment_pin_not_verified$/i.test(String(warning || "")))),
    ...(Array.isArray(pinValidation.warnings) ? pinValidation.warnings : []),
  ]);
  if (pinValidation.commentPinVerified) {
    for (const warning of [...warnings]) {
      if (/^comment_pin_not_available$|^comment_pin_not_verified$/i.test(String(warning || ""))) warnings.delete(warning);
    }
  }
  return {
    ...baseValidation,
    errors: Array.isArray(baseValidation.errors) ? baseValidation.errors : [],
    warnings: [...warnings],
    commentPinClicked: Boolean(baseValidation.commentPinClicked || pinValidation.commentPinClicked),
    commentPinVerified: Boolean(baseValidation.commentPinVerified || pinValidation.commentPinVerified),
  };
}

function recordPublishedPostCommentIssue({ row, ready, groupUrl, attemptedGroups, validation, postUrl, profileId, profileLabel }) {
  if (!livePostValidationHasCommentProblem(validation)) return null;
  const issueProfileId = Number(profileId || ready?.profileId || row?.profileId || profileIdFromLabel(row?.profile) || 0);
  const issueProfileLabel = oneLineField(profileLabel || (issueProfileId === Number(ready?.profileId || 0) ? row.profile : "") || row.profile || issueProfileId || "", 180);
  try {
    return recordPostingProfileGroupIssue({
      profile: issueProfileLabel || issueProfileId,
      profileId: issueProfileId,
      groupUrl,
      attemptedGroupUrls: attemptedGroups,
      reason: `Post published but required first comment was not verified: ${(validation.errors || []).join(", ") || "unknown_comment_error"} post_url=${postUrl || ""}`,
      skipProfile: false,
    });
  } catch (err) {
    logEvent("facebook_live_post_comment_issue_record_failed", {
      planId: row.planId,
      sequence: row.sequence,
      profileId: issueProfileId || ready?.profileId || row?.profileId || 0,
      groupUrl,
      postUrl: postUrl || "",
      error: oneLineField(err.message || String(err), 300),
    });
    return null;
  }
}

function commentRecoveryFallbackProfilesForGroup(row, groupUrl, state = readState(), options = {}) {
  const targetGroupKey = normalizedFacebookGroupKey(groupUrl);
  if (!targetGroupKey) return [];
  const excludedIds = new Set(
    [row?.profileId, profileIdFromLabel(row?.profile), options.excludeProfileId]
      .map((value) => Number(value || 0))
      .filter(Boolean)
  );
  const seen = new Set();
  const candidates = [];
  const benchedCommenters = commentCooldownBenchedSet(groupUrl, state); // single ledger scan; O(1) per candidate
  const addCandidate = (label, source) => {
    const cleanLabel = oneLineField(label || "", 180);
    const profileId = profileIdFromLabel(cleanLabel);
    if (!cleanLabel || !profileId || excludedIds.has(profileId) || seen.has(profileId)) return;
    if (isDedicatedShopYourLikesProfileLabel(cleanLabel, state) || isDedicatedShopYourLikesIxProfile(profileId, state)) return;
    if (isBlockedIxBrowserProfileLabel(cleanLabel, state)) return;
    if (isFacebookProfileQuarantinedForFacebook(cleanLabel, state, groupUrl)) return;
    if (isFacebookAdminApprovalProfileId(profileId, state, groupUrl) || isFacebookAdminApprovalProfileLabel(cleanLabel, state, groupUrl)) return;
    const commentStatus = facebookCommentProfileStatusForGroup(profileId, groupUrl);
    if (commentStatus.hasRecentFailure && !commentStatus.hasSuccess) return;
    if (benchedCommenters.has(profileId)) return; // benched 48h after a comment issue/auto-removal
    seen.add(profileId);
    candidates.push({
      profileId,
      profile: cleanLabel,
      groupUrl,
      source: oneLineField(source || "same_group_assignment", 80),
    });
  };
  for (const profile of successfulFacebookCommentProfilesForGroup(groupUrl, { excludeProfileIds: [...excludedIds] })) {
    addCandidate(profile.profile, profile.source);
  }
  for (const entry of Array.isArray(state.posting?.groupAssignmentData) ? state.posting.groupAssignmentData : []) {
    if (normalizedFacebookGroupKey(entry?.url) !== targetGroupKey) continue;
    for (const label of Array.isArray(entry?.profiles) ? entry.profiles : []) addCandidate(label, "same_group_assignment");
  }
  for (const entry of Array.isArray(state.posting?.groupAssignmentData) ? state.posting.groupAssignmentData : []) {
    if (normalizedFacebookGroupKey(entry?.url) === targetGroupKey) continue;
    for (const label of Array.isArray(entry?.profiles) ? entry.profiles : []) addCandidate(label, "other_assignment_probe_same_group_access");
  }
  for (const label of [
    ...recordLines(state.ixbrowser?.profilesForNextRun),
    ...recordLines(state.ixbrowser?.activeProfiles),
  ]) {
    addCandidate(label, "ixbrowser_profile_pool_probe_same_group_access");
  }
  return candidates.slice(0, MAX_COMMENT_FALLBACK_PROFILES);
}

async function ixBrowserCommentFallbackProfilesForGroup(row, groupUrl, state = readState(), options = {}) {
  const excludedIds = new Set(
    [row?.profileId, profileIdFromLabel(row?.profile), options.excludeProfileId]
      .map((value) => Number(value || 0))
      .filter(Boolean)
  );
  try {
    const data = await ixBrowserRequest("profile-list", { page: 1, limit: 100 });
    const rows = ixBrowserProfileRows(data);
    const seen = new Set();
    const candidates = [];
    const benchedCommenters = commentCooldownBenchedSet(groupUrl, state); // single ledger scan; O(1) per candidate
    for (const rawProfile of rows.profiles || []) {
      const profile = sanitizeIxBrowserProfile(rawProfile);
      const profileId = Number(profile.profile_id || profile.id || 0);
      const label = oneLineField(`${profileId}${profile.name ? ` - ${profile.name}` : ""}`, 180);
      if (!profileId || excludedIds.has(profileId) || seen.has(profileId)) continue;
      if (isDedicatedShopYourLikesIxProfile(profileId, state) || isDedicatedShopYourLikesProfileLabel(label, state)) continue;
      if (isBlockedIxBrowserProfileLabel(label, state)) continue;
      if (isFacebookProfileQuarantinedForFacebook(label, state, groupUrl)) continue;
      if (isFacebookAdminApprovalProfileId(profileId, state, groupUrl) || isFacebookAdminApprovalProfileLabel(label, state, groupUrl)) continue;
      const commentStatus = facebookCommentProfileStatusForGroup(profileId, groupUrl);
      if (commentStatus.hasRecentFailure && !commentStatus.hasSuccess) continue;
      if (benchedCommenters.has(profileId)) continue; // benched 48h after a comment issue/auto-removal
      seen.add(profileId);
      candidates.push({
        profileId,
        profile: label,
        groupUrl,
        source: "ixbrowser_profile_list_probe_same_group_access",
      });
      if (candidates.length >= MAX_COMMENT_FALLBACK_PROFILES) break;
    }
    logEvent("comment_fallback_ixbrowser_profile_pool_loaded", {
      groupUrl,
      total: rows.total || rows.profiles?.length || 0,
      candidates: candidates.length,
    });
    return candidates;
  } catch (err) {
    logEvent("comment_fallback_ixbrowser_profile_pool_failed", {
      groupUrl,
      error: oneLineField(err.message || String(err), 260),
    });
    return [];
  }
}

async function existingIxBrowserProfileIdSet() {
  const data = await ixBrowserRequest("profile-list", { page: 1, limit: 200 });
  const rows = ixBrowserProfileRows(data);
  return new Set((rows.profiles || [])
    .map((profile) => Number(profile.profile_id || profile.id || 0))
    .filter(Boolean));
}

async function filterExistingIxBrowserProfiles(profiles = [], groupUrl = "", reason = "comment_fallback") {
  let idSet = null;
  try {
    idSet = await existingIxBrowserProfileIdSet();
  } catch (err) {
    logEvent("ixbrowser_profile_existence_filter_failed", {
      groupUrl,
      reason,
      error: oneLineField(err.message || String(err), 260),
    });
    return profiles;
  }
  const kept = [];
  const removed = [];
  for (const profile of profiles || []) {
    const profileId = Number(profile?.profileId || profile?.profile_id || profileIdFromLabel(profile?.profile || profile?.label) || 0);
    if (profileId && idSet.has(profileId)) kept.push(profile);
    else removed.push({
      profileId,
      profile: oneLineField(profile?.profile || profile?.label || profileId || "", 180),
      source: oneLineField(profile?.source || "", 80),
    });
  }
  if (removed.length) {
    logEvent("ixbrowser_missing_profiles_skipped", {
      groupUrl,
      reason,
      removed,
    });
  }
  return kept;
}

function mergeProfileCandidates(...lists) {
  const state = readState();
  const seen = new Set();
  const merged = [];
  for (const list of lists) {
    for (const profile of list || []) {
      const profileId = Number(profile?.profileId || profile?.profile_id || profileIdFromLabel(profile?.profile || profile?.label) || 0);
      if (!profileId || seen.has(profileId)) continue;
      const label = oneLineField(profile?.profile || profile?.profileLabel || profile?.label || profileId, 180);
      if (isDedicatedShopYourLikesIxProfile(profileId, state) || isDedicatedShopYourLikesProfileLabel(label, state)) continue;
      if (isBlockedIxBrowserProfileLabel(label, state)) continue;
      if (isFacebookProfileQuarantinedForFacebook(label, state, profile?.groupUrl || profile?.actualGroupUrl || "")) continue;
      if (isFacebookAdminApprovalProfileId(profileId, state) || isFacebookAdminApprovalProfileLabel(label, state)) continue;
      seen.add(profileId);
      merged.push({
        ...profile,
        profileId,
        profile: label,
      });
    }
  }
  return merged;
}

function compactLivePostLog(objects = []) {
  return objects.slice(-20).map((item) => {
    if (!item || typeof item !== "object") return item;
    const copy = { ...item };
    if (Array.isArray(copy.captured)) copy.captured = copy.captured.slice(0, 5);
    if (Array.isArray(copy.verified)) copy.verified = copy.verified.slice(0, 5);
    if (Array.isArray(copy.snippets)) copy.snippets = copy.snippets.slice(0, 8);
    return copy;
  });
}

function liveFacebookPostingScriptPath() {
  const preferred = safeProjectPath("tools/fb-post-test-capture-url.js");
  if (fs.existsSync(preferred)) return preferred;
  const fallback = safeProjectPath("data/fb-post-hd-robust-once.js");
  if (fs.existsSync(fallback)) return fallback;
  const err = new Error("No Facebook live posting connector script was found.");
  err.statusCode = 500;
  throw err;
}

function writeLiveFacebookPostLogFile({ payloadRelative, scriptPath, stdout, stderr, objects, validation, outcome }) {
  const logRelative = path.join("data", `fb-live-post-log-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.json`).replace(/\\/g, "/");
  const logPath = safeProjectPath(logRelative);
  // Keep stdout/stderr structure (newlines) and allow 200KB so we don't lose
  // the post-90s timing markers and comment-phase events to truncation.
  const truncateKeepLines = (s, max) => {
    const str = String(s || "");
    return str.length > max ? str.slice(0, max) + "\n...[truncated]" : str;
  };
  atomicWrite(logPath, JSON.stringify({
    at: new Date().toISOString(),
    outcome,
    payloadFile: payloadRelative,
    script: path.relative(ROOT, scriptPath).replace(/\\/g, "/"),
    validation,
    objects: compactLivePostLog(objects),
    stdout: truncateKeepLines(stdout, 200000),
    stderr: truncateKeepLines(stderr, 50000),
  }, null, 2) + "\n");
  return logRelative;
}

async function runLiveFacebookPostScript(payload, options = {}) {
  // HARD KILL FUNNEL: this is the SOLE point where the live capture connector is spawned for
  // EVERY path (autopilot publish, #test, comment recovery, admin approval, URL recovery). A
  // fresh armed-check here means disarming (armedForExternalActions=false) instantly blocks all
  // live posting regardless of when the disarm arrives relative to the caller's earlier checks —
  // closing the race where ~hundreds of lines of logic run between an entry check and the spawn.
  requireExternalArmed();
  const scriptPath = liveFacebookPostingScriptPath();
  const fileName = `fb-live-post-payload-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.json`;
  const payloadRelative = path.join("data", fileName).replace(/\\/g, "/");
  const payloadPath = safeProjectPath(payloadRelative);
  const timeoutMs = clampNumber(options.timeoutMs || FACEBOOK_LIVE_POST_TIMEOUT_MS, 30000, 900000, FACEBOOK_LIVE_POST_TIMEOUT_MS);
  atomicWrite(payloadPath, JSON.stringify(payload, null, 2) + "\n");
  let stdout = "";
  let stderr = "";
  const cleanupPayload = () => {
    try {
      fs.unlinkSync(payloadPath);
      return true;
    } catch {
      return false;
    }
  };
  try {
    ({ stdout, stderr } = await execFileAsync("node", [scriptPath, payloadPath], {
      cwd: ROOT,
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    }));
  } catch (err) {
    stdout = err.stdout || "";
    stderr = err.stderr || "";
    const objects = parseJsonLogObjects(`${stdout}\n${stderr}`);
    const validation = livePostLogValidation(objects, payload);
    const candidatePostUrls = facebookPostCandidateUrlsFromLog(objects, payload.groupUrl || "");
    const liveLogFile = writeLiveFacebookPostLogFile({ payloadRelative, scriptPath, stdout, stderr, objects, validation, outcome: "error" });
    const lastError = [...objects].reverse().find((item) => item?.step === "error");
    const timedOut = err.killed || err.code === "ETIMEDOUT" || /timed out|timeout/i.test(err.message || "");
    const message = timedOut
      ? `Facebook live post connector timed out after ${Math.round(timeoutMs / 1000)} seconds.`
      : lastError?.message || String(stderr || stdout || err.message || err).split(/\r?\n/).filter(Boolean).pop() || "Facebook live post connector failed.";
    const wrapped = new Error(oneLineField(message, 700));
    wrapped.statusCode = 502;
    wrapped.publicError = timedOut ? "facebook_live_post_connector_timeout" : "";
    wrapped.livePostLog = objects;
    wrapped.livePostValidation = validation;
    wrapped.livePostLogFile = liveLogFile;
    wrapped.candidatePostUrls = candidatePostUrls;
    wrapped.uncertainAfterPostClick = Boolean(validation?.postClicked && candidatePostUrls.length);
    wrapped.payloadFile = payloadRelative;
    wrapped.payloadDeleted = cleanupPayload();
    throw wrapped;
  }
  const payloadDeleted = cleanupPayload();
  const objects = parseJsonLogObjects(stdout);
  const validation = livePostLogValidation(objects, payload);
  const liveLogFile = writeLiveFacebookPostLogFile({ payloadRelative, scriptPath, stdout, stderr, objects, validation, outcome: "ok" });
  return {
    payloadFile: payloadRelative,
    payloadDeleted,
    liveLogFile,
    script: path.relative(ROOT, scriptPath).replace(/\\/g, "/"),
    stdout,
    stderr,
    objects,
    postUrl: firstFacebookPostUrlFromLog(objects),
    cdpEndpoint: cdpEndpointFromLog(objects), // inert unless the batch cross-comment path reads it
    candidatePostUrls: facebookPostCandidateUrlsFromLog(objects, payload.groupUrl || ""),
    validation,
  };
}

function livePostPayloadForRow(row, groupUrl, imagePath, profileId, options = {}) {
  const basePostText = String(row.postText || "").trim();
  const includeComment = options.includeComment !== false;
  const trackingSeed = [
    row.planId || "",
    row.productKey || "",
    row.productId || "",
    row.sequence || "",
    row.link || "",
  ].filter(Boolean).join("|") || crypto.randomBytes(4).toString("hex");
  const trackingRef = `ZDF-${crypto.createHash("sha1").update(trackingSeed).digest("hex").slice(0, 8).toUpperCase()}`;
  // UNIQUE POST SIGNATURE (post-location anchor — operator design): always append a SHORT
  // line at the END of the caption containing emojis + the product's UNIQUE short title +
  // 2 hashtags. The short title is unique per product (and products aren't reused within the
  // reuse window), so it is unique in the recent feed — UNLIKE the rotating caption, whose
  // variants repeat over time and caused the agent to grab OLD same-caption posts. The agent
  // locates its own post by EXACT-matching this title (marker), so it never confuses its post
  // with another worker's or an old look-alike. No tracking code, just natural product text.
  const POST_SIG_EMOJIS = ["🔥", "✨", "🛒", "😍", "💥", "⚡", "🎉", "👀", "🙌", "💰"];
  const POST_SIG_TAGS = ["#WalmartFinds", "#WalmartDeals", "#DealAlert", "#Clearance", "#Rollback", "#HotDeal", "#Savings", "#GrabItNow", "#TreatYourself", "#ShopSmart"];
  // UNIQUE FULL-PHRASE LOCATOR (operator design — NO code/ZDF/#Deal): the post ends with a
  // descriptive line = emojis + the product's FULL title PHRASE + 2 themed hashtags. The agent
  // locates its own post by EXACT-matching that phrase. computePostMarkerPhrase is the shared
  // source of truth (also used by the concurrent pick loops to dedup), keeps variant/color tails
  // (160-char cap), and substitutes a per-product non-numeric phrase for numeric-fallback titles.
  const phrase = computePostMarkerPhrase(row);
  const sigHash = crypto.createHash("sha1").update(String(row.productKey || row.productId || row.url || phrase || trackingSeed)).digest();
  const sigE1 = POST_SIG_EMOJIS[sigHash[0] % POST_SIG_EMOJIS.length];
  let sigE2 = POST_SIG_EMOJIS[sigHash[1] % POST_SIG_EMOJIS.length];
  if (sigE2 === sigE1) sigE2 = POST_SIG_EMOJIS[(sigHash[1] + 1) % POST_SIG_EMOJIS.length];
  const sigT1 = POST_SIG_TAGS[sigHash[2] % POST_SIG_TAGS.length];
  let sigT2 = POST_SIG_TAGS[sigHash[3] % POST_SIG_TAGS.length];
  if (sigT2 === sigT1) sigT2 = POST_SIG_TAGS[(sigHash[3] + 1) % POST_SIG_TAGS.length];
  const signatureLine = `${sigE1} ${phrase} ${sigE2} ${sigT1} ${sigT2}`;
  const postText = basePostText ? `${basePostText}\n\n${signatureLine}` : signatureLine;
  // marker = the unique full title phrase (posted verbatim). Located by EXACT match. The
  // post-capture lock + the 7-day product-reuse window mean no OTHER recent post shares it.
  const marker = oneLineField(phrase, 200);
  return {
    profileId,
    groupUrl,
    marker,
    trackingRef,
    facebookUserId: oneLineField(row.facebookUserId || row.facebook_user_id || row.publisherFacebookUserId || row.publisher_facebook_user_id || "", 64).replace(/\D+/g, ""),
    postText,
    imagePath: toWindowsExplorerPath(imagePath),
    // Append 2 trailing spaces after the comment (which ends with the mavlynk link) so that at
    // submit (Enter) the caret is NOT inside the link/word token — this stops Facebook from
    // attaching a mention/hashtag autocomplete to the link end and tagging a random person.
    commentText: includeComment ? (String(row.commentTextPreview || row.link || "").trim() + "  ") : "",
    pinFirstComment: row.pinFirstComment !== false,
    waitForManualLogin: true,
    manualLoginTimeoutMs: 300000,
  };
}

async function recoverSubmittedFacebookPostUrl({
  row,
  ready,
  groupUrl,
  ledgerKey,
  reason = "",
  sourceLiveLogFile = "",
  sourcePayloadFile = "",
  closeResults = [],
  profileUseAlreadyAcquired = false,
}) {
  const numericProfileId = Number(ready?.profileId || row?.profileId || profileIdFromLabel(row?.profile) || 0);
  if (!numericProfileId) {
    return {
      ok: false,
      postUrl: "",
      validation: { ok: false, errors: ["submitted_url_recovery_profile_missing"], warnings: [] },
      message: "Submitted-post URL recovery could not run because the IXBrowser profile ID is missing.",
      liveLog: [],
    };
  }
  const payload = {
    ...livePostPayloadForRow(row, groupUrl, "", numericProfileId, { includeComment: false }),
    findOnly: true,
    imagePath: "",
    commentText: "",
    pinFirstComment: false,
  };
  let releaseProfileUse = () => {};
  let acquiredProfileUse = false;
  try {
    if (!profileUseAlreadyAcquired) {
      releaseProfileUse = acquireNormalIxProfileUse(numericProfileId, "facebook_submitted_url_recovery");
      acquiredProfileUse = true;
    }
    const preOpenClose = await ixBrowserCloseAfterUse(numericProfileId, "facebook_submitted_url_recovery_preopen_cleanup");
    closeResults.push(preOpenClose);
    assertIxBrowserPreOpenCleanupOk(preOpenClose, numericProfileId, "facebook_submitted_url_recovery_preopen_cleanup");
    if (preOpenClose?.status === "closed") await sleep(700);
    appendFacebookLivePostLedger({
      event: "submitted_url_recovery_started",
      key: ledgerKey,
      planId: row.planId,
      sequence: row.sequence,
      profileId: numericProfileId,
      profile: row.profile || "",
      groupUrl,
      status: "running",
      message: oneLineField(reason || "Trying to recover the permalink for a post that was submitted before URL capture.", 700),
      liveLogFile: sourceLiveLogFile,
      payloadFile: sourcePayloadFile,
    });
    const scriptResult = await runLiveFacebookPostScript(payload, { timeoutMs: FACEBOOK_COMMENT_RECOVERY_TIMEOUT_MS });
    const postUrl = scriptResult.postUrl || firstFacebookPostUrlFromLog(scriptResult.objects);
    const validation = scriptResult.validation || livePostLogValidation(scriptResult.objects, payload);
    appendFacebookLivePostLedger({
      event: "submitted_url_recovery_finished",
      key: ledgerKey,
      planId: row.planId,
      sequence: row.sequence,
      profileId: numericProfileId,
      profile: row.profile || "",
      groupUrl,
      actualGroupUrl: postUrl ? facebookGroupUrlFromPostUrl(postUrl) || groupUrl : groupUrl,
      postUrl,
      status: postUrl && validation.ok ? "url_recovered" : "url_not_found",
      message: postUrl && validation.ok
        ? "Recovered submitted Facebook post URL from the group feed marker."
        : "Submitted Facebook post URL was not found in the group feed marker scan.",
      validation,
      liveLogFile: scriptResult.liveLogFile || "",
      payloadFile: scriptResult.payloadFile || "",
    });
    return {
      ok: Boolean(postUrl && validation.ok),
      postUrl,
      validation,
      payloadFile: scriptResult.payloadFile || "",
      payloadDeleted: Boolean(scriptResult.payloadDeleted),
      liveLogFile: scriptResult.liveLogFile || "",
      script: scriptResult.script,
      liveLog: compactLivePostLog(scriptResult.objects),
      objects: scriptResult.objects,
      message: postUrl && validation.ok
        ? "Recovered submitted Facebook post URL."
        : "Submitted Facebook post URL was not recovered.",
    };
  } catch (err) {
    const liveObjects = err.livePostLog || [];
    const postUrl = firstFacebookPostUrlFromLog(liveObjects);
    const validation = err.livePostValidation || (liveObjects.length ? livePostLogValidation(liveObjects, payload) : null) || {
      ok: false,
      errors: ["submitted_url_recovery_connector_error"],
      warnings: [],
    };
    appendFacebookLivePostLedger({
      event: "submitted_url_recovery_error",
      key: ledgerKey,
      planId: row.planId,
      sequence: row.sequence,
      profileId: numericProfileId,
      profile: row.profile || "",
      groupUrl,
      actualGroupUrl: postUrl ? facebookGroupUrlFromPostUrl(postUrl) || groupUrl : groupUrl,
      postUrl,
      status: postUrl && validation.ok ? "url_recovered_after_error" : "url_recovery_failed",
      message: oneLineField(err.message || String(err), 700),
      validation,
      liveLogFile: err.livePostLogFile || "",
      payloadFile: err.payloadFile || "",
    });
    return {
      ok: Boolean(postUrl && validation.ok),
      postUrl,
      validation,
      payloadFile: err.payloadFile || "",
      payloadDeleted: Boolean(err.payloadDeleted),
      liveLogFile: err.livePostLogFile || "",
      script: path.relative(ROOT, liveFacebookPostingScriptPath()).replace(/\\/g, "/"),
      liveLog: compactLivePostLog(liveObjects),
      objects: liveObjects,
      message: postUrl && validation.ok ? "Recovered submitted Facebook post URL after connector error." : oneLineField(err.message || String(err), 700),
    };
  } finally {
    try {
      const closeResult = await ixBrowserCloseAfterUse(numericProfileId, "facebook_submitted_url_recovery_finished");
      closeResults.push(closeResult);
      appendFacebookLivePostLedger({
        event: "browser_closed_after_submitted_url_recovery",
        key: ledgerKey,
        planId: row.planId,
        sequence: row.sequence,
        profileId: numericProfileId,
        profile: row.profile || "",
        groupUrl,
        status: closeResult?.ok ? "closed" : "close_failed",
        closeResult,
      });
    } catch (closeErr) {
      logEvent("facebook_submitted_url_recovery_close_failed", {
        planId: row.planId,
        sequence: row.sequence,
        profileId: numericProfileId,
        groupUrl,
        error: oneLineField(closeErr.message || String(closeErr), 300),
      });
    }
    if (acquiredProfileUse) releaseProfileUse();
  }
}

function livePostingBatchesByUniqueProfile(rows, maxConcurrentProfiles) {
  const batches = [];
  let remaining = [...(rows || [])];
  while (remaining.length) {
    const batch = [];
    const usedProfiles = new Set();
    const nextRemaining = [];
    for (const row of remaining) {
      const profileKey = String(row.profileId || profileIdFromLabel(row.profile) || row.profile || "").trim().toLowerCase();
      if (batch.length < maxConcurrentProfiles && profileKey && !usedProfiles.has(profileKey)) {
        batch.push(row);
        usedProfiles.add(profileKey);
      } else {
        nextRemaining.push(row);
      }
    }
    if (!batch.length) batch.push(nextRemaining.shift());
    batches.push(batch);
    remaining = nextRemaining;
  }
  return batches;
}

function isFacebookGroupAccessPublishFailure(message = "") {
  return /could not open composer|composer not found|not allowed to post|cannot post|permission|join group|not a member|content isn't available|page unavailable/i.test(String(message || ""));
}

// A GROUP page that won't render (our bounded group-render recovery gave up, or FB
// served a bare "content isn't available" interstitial) is a GROUP problem, not a
// profile-health problem. Benching the profile for this would burn healthy profiles
// one-by-one over a broken / wrong / private group. Membership walls, account/login,
// and profile-open failures are deliberately EXCLUDED here (those DO warrant benching
// and are handled by their own classifiers).
function isFacebookGroupRenderUnavailableFailure(message = "") {
  const t = String(message || "").toLowerCase();
  if (!/group page unavailable|content markup not rendered|content isn't available|content is not available|content isnt available|isn't available right now|isnt available right now|not available right now|page not found/.test(t)) return false;
  if (/join group|request to join|pending approval|must be a member|not a member|invitation only|only members|account|suspend|disabl|lock|checkpoint|restrict|login|logged out|sign ?in|profile[ _-]?open|error 2007|does not exist/.test(t)) return false;
  return true;
}

// The account is NOT a member of the group (or it's request-to-join / membership-question gated).
// This is a GROUP/CONFIG problem, NOT profile health — never bench the profile for it; the operator
// must add the account to the group OR assign it a group it already belongs to.
function isFacebookGroupMembershipFailure(message = "") {
  return /facebook_group_membership_required_not_a_member|not a member|request to join|must be a member|only members can|members of this group|join group|invitation only|invited to join|membership question/i.test(String(message || ""));
}

function isFacebookProfileOpenOrLoginFailure(message = "") {
  return /ixbrowser.*(?:profile-open|profile open|timeout|timed out|login|required|error)|profile-open.*(?:timeout|timed out|error)|facebook_login_required_for_profile|facebook login required|checkpoint|two-factor|two factor|connectovercdp|cdp.*(?:timeout|timed out|refused|closed)|target page|browser has been closed/i.test(String(message || ""));
}

function isFacebookAccountHardBlockedFailure(message = "", validation = null, objects = []) {
  const text = [
    message,
    Array.isArray(validation?.errors) ? validation.errors.join(" ") : "",
    Array.isArray(objects) ? objects.map((item) => [
      item?.step,
      item?.accountBlockReason,
      item?.snippet,
      item?.message,
    ].filter(Boolean).join(" ")).join(" ") : "",
  ].join(" ").toLowerCase();
  return /facebook_account_suspended_or_disabled|facebook_account_status_blocked|account_suspended|account_disabled|account_deactivated|account_locked|identity_review_required|account_restricted|checkpoint_account_blocked|your account (?:has been )?(?:suspended|disabled|locked|deactivated)|we suspended your account|we disabled your account|you can't use facebook right now|you cannot use facebook right now|request a review|disagree with decision/i.test(text);
}

function isNonFallbackFacebookPublishFailure(message = "") {
  return /image_upload_not_confirmed|no usable image file input|image file not found|could not type post|could not click post|facebook post was submitted|verification failed/i.test(String(message || ""));
}

function markLivePostedRegisters(row, postUrl) {
  const registers = readRegisters();
  const at = new Date().toISOString();
  if (row.productUrl) registers.usedProducts = appendUniqueRecordLine(registers.usedProducts || "", `${at} | product_key=${row.productKey || ""} | product_url=${row.productUrl} | plan_id=${row.planId || ""} | post_url=${postUrl || ""}`);
  if (row.postText) registers.usedPostTexts = appendUniqueRecordLine(registers.usedPostTexts || "", `${at} | plan_id=${row.planId || ""} | ${oneLineField(row.postText, 500)}`);
  if (row.commentLeadIn) registers.usedCommentLeadIns = appendUniqueRecordLine(registers.usedCommentLeadIns || "", `${at} | plan_id=${row.planId || ""} | ${oneLineField(row.commentLeadIn, 300)}`);
  writeRegisters(registers);
}

function dateKeyForTimezone(date = new Date(), timezone = "America/New_York") {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    if (map.year && map.month && map.day) return `${map.year}-${map.month}-${map.day}`;
  } catch {}
  return date.toISOString().slice(0, 10);
}

function productKeysUsedOnDate(text, state, dayKey) {
  const keys = new Set();
  for (const line of recordLines(text)) {
    const firstField = String(line).split("|")[0].trim();
    const match = firstField.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!match || match[1] !== dayKey) continue;
    for (const key of productKeysFromText(line, state)) keys.add(key);
  }
  return keys;
}

function assertProductNotUsedToday(row, state = readState()) {
  const key = String(row?.productKey || canonicalProduct(row?.productUrl || "", state)?.key || "").toLowerCase();
  if (!key) return;
  const timezone = state.operator?.scheduleTimezone || state.rules?.peakHoursTimezone || "America/New_York";
  const dayKey = dateKeyForTimezone(new Date(), timezone);
  const usedToday = productKeysUsedOnDate(readRegisters().usedProducts, state, dayKey);
  if (!usedToday.has(key)) return;
  const err = new Error(`Product already used today (${dayKey} ${timezone}): ${row.productUrl || row.productKey}. Refresh product discovery and rebuild the production plan.`);
  err.statusCode = 409;
  throw err;
}

function assertProductionScheduleOpen(state = readState()) {
  if (!state.operator?.scheduleEnabled) return true;
  if (withinSchedule(state.operator.startTime, state.operator.stopTime, state.operator.scheduleTimezone, state.operator.runDays)) return true;
  const err = new Error(`Production live run is outside schedule: ${state.operator.startTime || "--:--"}-${state.operator.stopTime || "--:--"} ${state.operator.scheduleTimezone || "America/New_York"}.`);
  err.statusCode = 409;
  throw err;
}

function assertFullPostingPlanHasFreshDiscovery(rows, state = readState()) {
  const expected = String(state.productDiscovery?.lastSuccessfulRunAt || "").trim();
  if (!expected) {
    const err = new Error("Fresh product discovery is required before production posting. Run product candidates discovery and rebuild the full plan.");
    err.statusCode = 409;
    throw err;
  }
  const stale = (rows || []).filter((row) => String(row.productDiscoveryAt || "").trim() !== expected);
  if (!stale.length) return true;
  const err = new Error(`Full production plan is stale. Product candidates were refreshed at ${expected}; rebuild the full posting plan before starting production.`);
  err.statusCode = 409;
  throw err;
}

function assertFullPostingPlanUsesLatestDiscoveryProducts(rows, state = readState()) {
  const latestKeys = new Set(productCandidateRowsForDiscoveryRun(state).map((row) => String(row.productKey || row.key || "").toLowerCase()).filter(Boolean));
  if (!latestKeys.size) {
    const err = new Error("Fresh product discovery has no usable candidate rows. Run product candidates discovery and rebuild the full plan.");
    err.statusCode = 409;
    throw err;
  }
  const outsideLatestRun = (rows || []).filter((row) => {
    const key = String(row.productKey || canonicalProduct(row.productUrl || "", state)?.key || "").toLowerCase();
    return !key || !latestKeys.has(key);
  });
  if (!outsideLatestRun.length) return true;
  const err = new Error("Full production plan contains products that were not seen in the latest filter discovery run. Rebuild the full plan from fresh product candidates.");
  err.statusCode = 409;
  throw err;
}

function recordFacebookCommentProfileUsage({ row, groupUrl, postUrl, profileId, profileLabel, validation }) {
  const state = readState();
  const line = [
    new Date().toISOString(),
    "type=facebook_first_comment_profile_used",
    row?.planId ? `plan_id=${row.planId}` : "",
    row?.sequence ? `sequence=${row.sequence}` : "",
    profileId ? `profile_id=${profileId}` : "",
    profileLabel ? `profile=${oneLineField(profileLabel, 180)}` : "",
    groupUrl ? `group_url=${groupUrl}` : "",
    postUrl ? `post_url=${postUrl}` : "",
    validation?.commentPinVerified ? "pin_status=verified" : (validation?.commentPinClicked ? "pin_status=clicked_unverified" : "pin_status=not_available"),
    "status=comment_verified",
  ].filter(Boolean).join(" | ");
  state.tracking.dailyActionLog = appendUniqueRecordLine(state.tracking.dailyActionLog || "", line);
  writeState(state);
  logEvent("facebook_first_comment_profile_used", {
    planId: row?.planId || "",
    sequence: row?.sequence || 0,
    profileId: Number(profileId || 0),
    groupUrl: groupUrl || "",
    postUrl: postUrl || "",
  });
}

function isTransientCommentProfileFailure(validation = {}) {
  const errors = Array.isArray(validation.errors) ? validation.errors.map((error) => String(error || "").toLowerCase()) : [];
  const blockReason = String(validation.commentBlockReason || validation.commentResult?.blockReason || "").toLowerCase();
  // "couldn't LOCATE the comment box/button" failures are TRANSIENT (selector/timing miss,
  // nothing was ever submitted to FB) -> retry, never 48h-bench. The token can live in
  // commentBlockReason OR in the errors[] array (ledger stores it as
  // "comment_blocked:marker_scoped_comment_button_not_found"), so scan BOTH. Genuine FB
  // rejections (comment_did_not_persist..., cannot_comment, action_blocked,
  // comment_profile_cannot_access_post_permalink) are NOT in this list and stay benchable.
  const locateMissRe = /target_marker_root_not_found|target_marker_not_visible|target_marker_article_not_visible|expected_post_permalink_mismatch|marker_scoped_comment_button_not_found|marker_scoped_comment_box_not_found|permalink_scoped_comment_box_not_found|target_marker_not_visible_for_permalink_comment_fallback|comment_box_not_found|comment_button_not_found|no_comment_box|0_comment_boxes|comment_box_count_0|comment_(?:box|button|composer)_(?:locate|selector)_timeout|comment_selector_timeout|comment_target_unavailable|comment_target_unavailable_or_pending|comment_target_not_ready|comment_target_pending|ixbrowser_profile_busy|comment_recovery_profile_busy|profile_busy|profile_in_use/i;
  if (locateMissRe.test(blockReason) || errors.some((e) => locateMissRe.test(e))) {
    return true;
  }
  if (
    validation.postPermalinkVerified === true &&
    (validation.titlePermalinkVerified === true || validation.postMediaVerified === true) &&
    errors.includes("comment_profile_cannot_access_post_permalink")
  ) {
    return true;
  }
  return false;
}

function facebookCommentProfileStatusForGroup(profileId, groupUrl) {
  const numericProfileId = Number(profileId || 0);
  const groupKey = normalizedFacebookGroupKey(groupUrl);
  if (!numericProfileId || !groupKey) return { hasSuccess: false, hasRecentFailure: false, latest: null };
  const rows = readJsonlAbsoluteFile(FB_LIVE_POST_LEDGER_FILE, { limit: 5000 });
  let latest = null;
  let hasSuccess = false;
  for (const item of rows) {
    if (!item || item.event !== "comment_recovery_finished") continue;
    if (Number(item.profileId || 0) !== numericProfileId) continue;
    const itemGroupKey = normalizedFacebookGroupKey(item.actualGroupUrl || item.groupUrl || facebookGroupUrlFromPostUrl(item.postUrl));
    if (itemGroupKey !== groupKey) continue;
    const itemSucceeded = ["published", "published_with_warning"].includes(String(item.status || "")) && item.validation?.commentVerified !== false;
    if (itemSucceeded) hasSuccess = true;
    latest = item;
  }
  if (!latest) return { hasSuccess: false, hasRecentFailure: false, latest: null };
  const isTransientFailure = isTransientCommentProfileFailure(latest.validation || {});
  const hasRecentFailure = !hasSuccess && !isTransientFailure && (latest.validation?.errors || []).some((error) => {
    const text = String(error || "").toLowerCase();
    return text === "comment_profile_cannot_access_post_permalink" || text.startsWith("comment_blocked");
  });
  return { hasSuccess, hasRecentFailure, isTransientFailure, latest };
}

// 48h COMMENT COOLDOWN: a profile whose LAST comment in this group failed/was auto-removed (FB
// sometimes silently deletes link-comments) is benched from commenting for commentCooldownHours
// (default 48h), then auto-retried. Transient glitches (marker-not-found etc.) are NOT benched.
// Returns the SET of benched profileIds for the group from a SINGLE ledger scan (so callers can
// filter many candidates in O(1) each — no per-candidate re-scan of the 5000-row ledger).
function commentCooldownBenchedSet(groupUrl, state = readState()) {
  const benched = new Set();
  const groupKey = normalizedFacebookGroupKey(groupUrl);
  if (!groupKey) return benched;
  const windowMs = clampNumber(state.operator?.commentCooldownHours, 1, 720, 48) * 60 * 60 * 1000;
  const cutoff = Date.now() - windowMs;
  const latestByPid = new Map();
  for (const item of readJsonlAbsoluteFile(FB_LIVE_POST_LEDGER_FILE, { limit: 5000 })) {
    if (!item || item.event !== "comment_recovery_finished") continue;
    const pid = Number(item.profileId || 0);
    if (!pid) continue;
    const k = normalizedFacebookGroupKey(item.actualGroupUrl || item.groupUrl || facebookGroupUrlFromPostUrl(item.postUrl));
    if (k !== groupKey) continue;
    const at = Date.parse(item.at || "");
    if (!Number.isFinite(at) || at < cutoff) continue; // outside window -> cooled down already
    const prev = latestByPid.get(pid);
    if (!prev || Date.parse(prev.at || "") < at) latestByPid.set(pid, item);
  }
  for (const [pid, item] of latestByPid.entries()) {
    const succeeded = ["published", "published_with_warning"].includes(String(item.status || "")) && item.validation?.commentVerified !== false;
    if (succeeded) continue; // last attempt landed -> not benched
    if (isTransientCommentProfileFailure(item.validation || {})) continue; // transient, not an account issue
    benched.add(pid); // real comment failure within the cooldown window
  }
  return benched;
}

function successfulFacebookCommentProfilesForGroup(groupUrl, options = {}) {
  const groupKey = normalizedFacebookGroupKey(groupUrl);
  if (!groupKey) return [];
  const excludedIds = new Set((options.excludeProfileIds || [])
    .map((value) => Number(value || 0))
    .filter(Boolean));
  const byProfile = new Map();
  const rows = readJsonlAbsoluteFile(FB_LIVE_POST_LEDGER_FILE, { limit: 5000 });
  for (const item of rows) {
    if (!item || item.event !== "comment_recovery_finished") continue;
    const profileId = Number(item.profileId || 0);
    if (!profileId || excludedIds.has(profileId)) continue;
    const itemGroupKey = normalizedFacebookGroupKey(item.actualGroupUrl || item.groupUrl || facebookGroupUrlFromPostUrl(item.postUrl));
    if (itemGroupKey !== groupKey) continue;
    if (!["published", "published_with_warning"].includes(String(item.status || ""))) continue;
    if (item.validation?.commentVerified === false) continue;
    byProfile.set(profileId, {
      profileId,
      profile: oneLineField(item.profile || profileId, 180),
      groupUrl,
      source: "previous_comment_success_same_group",
      at: item.at || "",
    });
  }
  return [...byProfile.values()].sort((left, right) => String(right.at || "").localeCompare(String(left.at || "")));
}

function facebookAdminProfileLabelsFromConfiguredText(text = "", groupUrl = "", source = "configured_admin_profile") {
  const targetGroupKey = normalizedFacebookGroupKey(groupUrl);
  const candidates = [];
  const seen = new Set();
  for (const line of recordLines(text)) {
    const cleanLine = oneLineField(line, 1000);
    if (!cleanLine) continue;
    const lineGroupUrls = sanitizeFacebookGroupUrlList(cleanLine);
    if (lineGroupUrls.length && targetGroupKey && !lineGroupUrls.some((url) => normalizedFacebookGroupKey(url) === targetGroupKey)) continue;
    const profileId = Number(
      (cleanLine.match(/\bprofile[_ -]?id\s*=\s*(\d{1,20})\b/i) || [])[1] ||
      (cleanLine.match(/^(\d{1,20})(?:\s*[-:| ]|$)/) || [])[1] ||
      0
    );
    if (!profileId) continue;
    const beforePipe = cleanLine.split("|")[0].trim();
    const name =
      (cleanLine.match(/\bprofile\s*=\s*([^|]+)/i) || [])[1] ||
      (cleanLine.match(/\bname\s*=\s*([^|]+)/i) || [])[1] ||
      beforePipe ||
      String(profileId);
    const label = oneLineField(/^\d/.test(name) ? name : `${profileId} - ${name}`, 180);
    if (seen.has(profileId)) continue;
    seen.add(profileId);
    candidates.push({ profileId, profile: label, groupUrl, source });
  }
  return candidates;
}

async function facebookAdminApprovalProfilesForGroup(groupUrl, state = readState(), options = {}) {
  const excludedIds = new Set([options.excludeProfileId, options.publisherProfileId]
    .map((value) => Number(value || 0))
    .filter(Boolean));
  const seen = new Set();
  const candidates = [];
  const add = (profileId, profile, source) => {
    const numericProfileId = Number(profileId || profileIdFromLabel(profile) || 0);
    const label = oneLineField(profile || numericProfileId || "", 180);
    if (!numericProfileId || !label || excludedIds.has(numericProfileId) || seen.has(numericProfileId)) return;
    if (isDedicatedShopYourLikesIxProfile(numericProfileId, state) || isDedicatedShopYourLikesProfileLabel(label, state)) return;
    if (isFacebookProfileQuarantinedForFacebook(label, state, groupUrl)) return;
    const approvalOnlyProfile = isFacebookAdminApprovalProfileId(numericProfileId, state, groupUrl) || isFacebookAdminApprovalProfileLabel(label, state, groupUrl);
    if (isBlockedIxBrowserProfileLabel(label, state) && !approvalOnlyProfile) return;
    seen.add(numericProfileId);
    candidates.push({ profileId: numericProfileId, profile: label, groupUrl, source: oneLineField(source, 80) });
  };
  const configuredSources = [
    [state.ixbrowser?.moderatorProfiles, "moderator_profiles"],
    [state.posting?.ownedGroupsByProfile, "owned_groups_by_profile"],
    [state.posting?.moderatorAccountNotes, "moderator_account_notes"],
  ];
  for (const [text, source] of configuredSources) {
    for (const entry of facebookAdminProfileLabelsFromConfiguredText(text, groupUrl, source)) {
      add(entry.profileId, entry.profile, entry.source);
    }
  }
  try {
    const data = await ixBrowserRequest("profile-list", { page: 1, limit: 100 });
    const rows = ixBrowserProfileRows(data);
    for (const rawProfile of rows.profiles || []) {
      const profile = sanitizeIxBrowserProfile(rawProfile);
      const profileId = Number(profile.profile_id || profile.id || 0);
      const label = oneLineField(`${profileId}${profile.name ? ` - ${profile.name}` : ""}`, 180);
      if (!isFacebookAdminApprovalProfileId(profileId, state, groupUrl) && !isFacebookAdminApprovalProfileLabel(label, state, groupUrl)) continue;
      add(profileId, label, "ixbrowser_admin_name_match");
    }
    logEvent("facebook_admin_approval_profiles_loaded", {
      groupUrl,
      candidates: candidates.length,
      totalProfiles: rows.total || rows.profiles?.length || 0,
    });
  } catch (err) {
    logEvent("facebook_admin_approval_profiles_load_failed", {
      groupUrl,
      error: oneLineField(err.message || String(err), 260),
    });
  }
  return candidates.slice(0, MAX_COMMENT_FALLBACK_PROFILES);
}

function facebookAdminApprovalValidationFromLog(objects = [], postUrl = "") {
  const resultStep = latestLiveLogStep(objects, "result");
  const verifiedByResult = Array.isArray(resultStep?.verified)
    ? resultStep.verified.some((item) => item?.hasMarker && item?.hasPostMedia)
    : false;
  const exactPermalinkVerified = Array.isArray(resultStep?.verified)
    ? resultStep.verified.some((item) => item?.exactPermalink && item?.hasMarker)
    : false;
  const markerVisible = Boolean(
    resultStep?.bodyChecks?.markerVisible ||
    verifiedByResult ||
    exactPermalinkVerified ||
    resultStep?.markerPermalinkVerified
  );
  const postMediaVerified = Boolean(
    resultStep?.postMediaVerified ||
    resultStep?.imageVerified ||
    resultStep?.bodyChecks?.postMediaVerified ||
    verifiedByResult
  );
  const approvalStep = latestLiveLogStep(objects, "approval_attempted");
  // FAST-BAIL signal: the moderator SUCCESSFULLY scanned the group's pending queue and
  // found NO post from this publisher (reason no_pending_article_matched_publisher). That
  // means the post is NOT pending — it is already live (or never landed) — so no moderator
  // can approve it and retrying other moderators just burns ~1min each. Only set when a
  // real diagnostic scan ran AND the marker wasn't verified (so we never bail on a session
  // error, which would not produce this diagnostic).
  const diagnosticStep = latestLiveLogStep(objects, "admin_approval_diagnostic");
  // PERMISSION SIGNAL from the connector: false => every /pending_posts request redirected to the
  // group feed, i.e. the approving account is NOT a moderator of THIS group.
  const surfaceStep = latestLiveLogStep(objects, "admin_approval_surface");
  // adminSurfaceReachable: true = queue rendered (real moderator) | false = redirected to feed
  // (not a moderator of THIS group) | null = INCONCLUSIVE (numeric gid unresolved — prove nothing).
  const surfaceReachable = surfaceStep ? surfaceStep.adminSurfaceReachable : undefined;
  const approverLacksAdminRole = surfaceReachable === false;
  const noPendingPostForPublisher = Boolean(
    diagnosticStep &&
    /no_pending_article_matched_publisher/i.test(String(diagnosticStep.reason || "")) &&
    !markerVisible &&
    // ONLY trust "post is not pending" when the moderation queue ACTUALLY rendered (surface===true).
    // A feed redirect (non-admin) or an inconclusive gid produces the same reason but proves nothing
    // — must NOT be read as "not pending" (the bug that left every post pending forever).
    surfaceReachable === true
  );
  const errors = [];
  const warnings = [];
  if (approverLacksAdminRole) errors.push("admin_approval_surface_unavailable_approver_not_admin");
  if (!markerVisible) errors.push("admin_approval_post_marker_not_verified");
  if (!postMediaVerified) errors.push("admin_approval_post_image_not_verified");
  if (!approvalStep?.clicked && markerVisible && postMediaVerified) warnings.push("admin_approval_button_not_needed_or_not_found");
  return {
    noPendingPostForPublisher,
    approverLacksAdminRole,
    ok: errors.length === 0,
    errors,
    warnings,
    postClicked: true,
    imageRequired: true,
    imageConfirmed: postMediaVerified,
    postMediaVerified,
    commentRequired: false,
    commentPostVisible: markerVisible,
    commentSubmitted: false,
    commentVerified: false,
    commentBlocked: false,
    commentBlockReason: "",
    pinRequired: false,
    commentPinClicked: false,
    commentPinVerified: false,
    approvalClicked: Boolean(approvalStep?.clicked),
    postUrl,
  };
}

async function runFacebookAdminApprovalAttempt({ row, profileId, profileLabel, groupUrl, postUrl, ledgerKey, reason, timeoutMs }) {
  const numericProfileId = Number(profileId);
  const cleanProfile = oneLineField(profileLabel || numericProfileId || "", 180);
  const closeResults = [];
  const state = readState();
  if (isDedicatedShopYourLikesIxProfile(numericProfileId) || isDedicatedShopYourLikesProfileLabel(cleanProfile)) {
    return {
      ok: false,
      profileId: numericProfileId,
      profile: cleanProfile,
      closeResults,
      validation: { ok: false, errors: ["dedicated_shopyourlikes_profile_reserved_for_affiliate"], warnings: [] },
      message: "Dedicated ShopYourLikes IXBrowser profile is reserved for affiliate URL generation and cannot approve Facebook posts.",
      liveLog: [],
      liveLogFile: "",
    };
  }
  const approvalOnlyProfile = isFacebookAdminApprovalProfileId(numericProfileId, state, groupUrl) || isFacebookAdminApprovalProfileLabel(cleanProfile, state, groupUrl);
  if (isFacebookProfileQuarantinedForFacebook(cleanProfile, state, groupUrl)) {
    return {
      ok: false,
      profileId: numericProfileId,
      profile: cleanProfile,
      closeResults,
      validation: { ok: false, errors: ["facebook_profile_quarantined"], warnings: [] },
      message: `IXBrowser profile "${cleanProfile}" is quarantined for Facebook and will not be used for admin approval.`,
      liveLog: [],
      liveLogFile: "",
    };
  }
  if (isBlockedIxBrowserProfileLabel(cleanProfile, state) && !approvalOnlyProfile) {
    return {
      ok: false,
      profileId: numericProfileId,
      profile: cleanProfile,
      closeResults,
      validation: { ok: false, errors: ["ixbrowser_profile_name_blocked"], warnings: [] },
      message: `IXBrowser profile "${cleanProfile}" is blocked by name and will not be used for Facebook admin approval.`,
      liveLog: [],
      liveLogFile: "",
    };
  }
  const markerPayload = livePostPayloadForRow(row, groupUrl, "", numericProfileId, { includeComment: false });
  const publisherUserId = String(
    row?.publisherFacebookUserId || row?.publisher_facebook_user_id || row?.facebookUserId || markerPayload?.facebookUserId || ""
  ).replace(/\D+/g, "");
  const payload = {
    profileId: numericProfileId,
    groupUrl,
    postUrl,
    marker: markerPayload.marker,
    approveOnly: true,
    imagePath: "",
    postText: "",
    commentText: "",
    pinFirstComment: false,
    publisherFacebookUserId: publisherUserId,
  };
  let releaseProfileUse = () => {};
  try {
    releaseProfileUse = acquireNormalIxProfileUse(numericProfileId, "facebook_admin_approval");
  } catch (err) {
    return {
      ok: false,
      profileId: numericProfileId,
      profile: cleanProfile,
      closeResults,
      validation: { ok: false, errors: ["admin_approval_profile_busy"], warnings: [] },
      message: err.message || String(err),
      liveLog: [],
      liveLogFile: "",
    };
  }
  try {
    const preOpenClose = await ixBrowserCloseAfterUse(numericProfileId, "facebook_admin_approval_preopen_cleanup");
    closeResults.push(preOpenClose);
    assertIxBrowserPreOpenCleanupOk(preOpenClose, numericProfileId, "facebook_admin_approval_preopen_cleanup");
    if (preOpenClose?.status === "closed") await sleep(700);
    appendFacebookLivePostLedger({
      event: "admin_approval_started",
      key: ledgerKey,
      planId: row.planId,
      sequence: row.sequence,
      profileId: numericProfileId,
      profile: cleanProfile,
      groupUrl,
      postUrl,
      status: "running",
      message: oneLineField(reason || "Trying admin/moderator approval for a pending group post.", 700),
    });
    const scriptResult = await runLiveFacebookPostScript(payload, { timeoutMs: clampNumber(timeoutMs, 30000, FACEBOOK_ADMIN_APPROVAL_TIMEOUT_MS, FACEBOOK_ADMIN_APPROVAL_TIMEOUT_MS) });
    const approvedUrl = firstFacebookPostUrlFromLog(scriptResult.objects) || postUrl;
    const validation = facebookAdminApprovalValidationFromLog(scriptResult.objects, approvedUrl);
    appendFacebookLivePostLedger({
      event: "admin_approval_finished",
      key: ledgerKey,
      planId: row.planId,
      sequence: row.sequence,
      profileId: numericProfileId,
      profile: cleanProfile,
      groupUrl,
      postUrl: approvedUrl,
      status: validation.ok ? "approved_and_verified" : "admin_approval_failed",
      message: validation.ok ? "Admin approval verified the pending post permalink." : `Admin approval did not verify the post: ${validation.errors.join(", ") || "unknown_approval_error"}`,
      validation,
      liveLogFile: scriptResult.liveLogFile || "",
      payloadFile: scriptResult.payloadFile || "",
    });
    return {
      ok: validation.ok,
      profileId: numericProfileId,
      profile: cleanProfile,
      postUrl: approvedUrl,
      validation,
      closeResults,
      payloadFile: scriptResult.payloadFile || "",
      payloadDeleted: Boolean(scriptResult.payloadDeleted),
      liveLogFile: scriptResult.liveLogFile || "",
      script: scriptResult.script,
      message: validation.ok ? "Admin approval verified the pending post permalink." : "Admin approval did not verify the pending post permalink.",
      liveLog: compactLivePostLog(scriptResult.objects),
    };
  } catch (err) {
    const liveObjects = err.livePostLog || [];
    const approvedUrl = firstFacebookPostUrlFromLog(liveObjects) || postUrl;
    const validation = facebookAdminApprovalValidationFromLog(liveObjects, approvedUrl);
    if (isFacebookAccountHardBlockedFailure(err.message || String(err), err.livePostValidation || validation, liveObjects)) {
      recordFacebookAccountHardBlock({
        profile: cleanProfile,
        profileId: numericProfileId,
        groupUrl,
        reason: err.message || "Facebook admin/moderator account is suspended, disabled, locked, or requires review.",
        source: "facebook_admin_approval",
      });
    }
    appendFacebookLivePostLedger({
      event: "admin_approval_error",
      key: ledgerKey,
      planId: row.planId,
      sequence: row.sequence,
      profileId: numericProfileId,
      profile: cleanProfile,
      groupUrl,
      postUrl: approvedUrl,
      status: "admin_approval_failed",
      message: oneLineField(err.message || String(err), 700),
      validation,
      liveLogFile: err.livePostLogFile || "",
      payloadFile: err.payloadFile || "",
    });
    return {
      ok: false,
      profileId: numericProfileId,
      profile: cleanProfile,
      postUrl: approvedUrl,
      validation,
      closeResults,
      payloadFile: err.payloadFile || "",
      payloadDeleted: Boolean(err.payloadDeleted),
      liveLogFile: err.livePostLogFile || "",
      script: path.relative(ROOT, liveFacebookPostingScriptPath()).replace(/\\/g, "/"),
      message: oneLineField(err.message || String(err), 700),
      liveLog: compactLivePostLog(liveObjects),
    };
  } finally {
    const closeResult = await ixBrowserCloseAfterUse(numericProfileId, "facebook_admin_approval_finished");
    closeResults.push(closeResult);
    appendFacebookLivePostLedger({
      event: "browser_closed_after_admin_approval",
      key: ledgerKey,
      planId: row.planId,
      sequence: row.sequence,
      profileId: numericProfileId,
      profile: cleanProfile,
      groupUrl,
      postUrl,
      status: closeResult?.ok ? "closed" : "close_failed",
      closeResult,
    });
    releaseProfileUse();
  }
}

// A VANITY group URL (/groups/o149…) and the NUMERIC permalink URL (/groups/1098…) are the SAME group
// but normalize to different keys. Build the alias set from the ledger (it logs groupUrl=vanity AND a
// numeric postUrl/actualGroupUrl for the same posts), so group-config matching works for BOTH forms —
// otherwise the admin-approval gate never fires for a vanity-configured group and posts die in review.
let __groupAliasCache = { at: 0, map: null };
function groupKeyAliasSet(groupUrl) {
  const base = normalizedFacebookGroupKey(String(groupUrl || ""));
  if (!base) return new Set();
  if (!__groupAliasCache.map || Date.now() - __groupAliasCache.at > 300000) {
    const pairs = new Map();
    const link = (a, b) => { if (!pairs.has(a)) pairs.set(a, new Set()); pairs.get(a).add(b); };
    try {
      const lines = fs.readFileSync(FB_LIVE_POST_LEDGER_FILE, "utf8").split(/\r?\n/);
      for (const ln of lines) {
        const t = ln.trim(); if (!t || t.indexOf('"postUrl":"http') === -1) continue;
        let r; try { r = JSON.parse(t); } catch { continue; }
        const k1 = normalizedFacebookGroupKey(String(r.groupUrl || ""));
        const k2 = normalizedFacebookGroupKey(String(r.actualGroupUrl || facebookGroupUrlFromPostUrl(r.postUrl) || ""));
        if (k1 && k2 && k1 !== k2) { link(k1, k2); link(k2, k1); }
      }
    } catch {}
    __groupAliasCache = { at: Date.now(), map: pairs };
  }
  const out = new Set([base]);
  const al = __groupAliasCache.map.get(base);
  if (al) for (const a of al) out.add(a);
  return out;
}
function groupsMatchByAlias(urlA, urlB) {
  const a = groupKeyAliasSet(urlA), b = groupKeyAliasSet(urlB);
  for (const k of a) if (b.has(k)) return true;
  return false;
}
function isAdminApprovalEnabledForGroup(groupUrl, state = readState()) {
  if (!normalizedFacebookGroupKey(groupUrl)) return false;
  const assignments = Array.isArray(state.posting?.groupAssignmentData) ? state.posting.groupAssignmentData : [];
  for (const group of assignments) {
    if (!groupsMatchByAlias(groupUrl, group?.url)) continue; // vanity<->numeric aware
    return Boolean(group?.requiresAdminApproval || group?.requires_admin_approval || group?.adminApproval || group?.admin_approval);
  }
  return false;
}

function autoEnableAdminApprovalIfPersistentFailures(groupUrl) {
  const targetKey = normalizedFacebookGroupKey(groupUrl);
  if (!targetKey) return false;
  let ledgerEntries = [];
  try { ledgerEntries = readJsonlAbsoluteFile(FB_LIVE_POST_LEDGER_FILE, { limit: 500 }); } catch {}
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const recentUncertain = ledgerEntries.filter((item) => {
    if (!item) return false;
    const itemGroupKey = normalizedFacebookGroupKey(item.groupUrl || item.actualGroupUrl || "");
    if (itemGroupKey !== targetKey) return false;
    const atMs = Date.parse(item.at || 0);
    if (!Number.isFinite(atMs) || atMs < cutoff) return false;
    const status = String(item.status || "").toLowerCase();
    const event = String(item.event || "").toLowerCase();
    return /uncertain_after_post_click/.test(status) || /uncertain_after_click/.test(event);
  });
  if (recentUncertain.length < 2) return false;
  const stateToUpdate = readState();
  let changed = false;
  for (const g of (Array.isArray(stateToUpdate.posting?.groupAssignmentData) ? stateToUpdate.posting.groupAssignmentData : [])) {
    if (normalizedFacebookGroupKey(g?.url) === targetKey && !g.requiresAdminApproval) {
      g.requiresAdminApproval = true;
      changed = true;
    }
  }
  if (!changed) return false;
  try {
    writeState(stateToUpdate);
    logEvent("facebook_group_auto_flagged_requires_admin_approval", {
      groupUrl,
      recentUncertainCount: recentUncertain.length,
      reason: "post_submitted_but_permalink_not_captured_repeatedly",
    });
    return true;
  } catch (err) {
    logEvent("facebook_group_auto_flag_failed", { groupUrl, error: oneLineField(err.message || String(err), 200) });
    return false;
  }
}

// Serialize moderator-approval sessions box-wide: the moderator profiles (p41/p42) are
// shared, so two pending posts approving at once collide on iX profile-open and burn the
// 8-min budget. This single-flight chain runs approvals one-at-a-time; each approval's
// budget timer starts AFTER it acquires the lock (queue-wait is not charged against it).
let __adminApprovalLockChain = Promise.resolve();
function acquireAdminApprovalLock() {
  let release;
  const next = new Promise((res) => { release = res; });
  const prior = __adminApprovalLockChain;
  __adminApprovalLockChain = prior.then(() => next);
  return prior.then(() => release);
}
async function approvePendingFacebookPostWithAdminProfiles({ row, ready, groupUrl, candidateUrls, ledgerKey, closeResults, reason }) {
  let state = readState();
  if (!isAdminApprovalEnabledForGroup(groupUrl, state)) {
    const autoEnabled = autoEnableAdminApprovalIfPersistentFailures(groupUrl);
    if (autoEnabled) {
      state = readState();
      appendFacebookLivePostLedger({
        event: "admin_approval_auto_enabled_for_group",
        key: ledgerKey,
        planId: row.planId,
        sequence: row.sequence,
        profileId: ready?.profileId,
        profile: row.profile || "",
        groupUrl,
        status: "admin_approval_auto_enabled",
        message: "Two or more recent uncertain-after-click failures on this group; auto-enabled admin approval flag.",
      });
    }
  }
  if (!isAdminApprovalEnabledForGroup(groupUrl, state)) {
    appendFacebookLivePostLedger({
      event: "admin_approval_skipped_group_does_not_require_moderation",
      key: ledgerKey,
      planId: row.planId,
      sequence: row.sequence,
      profileId: ready?.profileId,
      profile: row.profile || "",
      groupUrl,
      status: "admin_approval_skipped",
      message: "Group is not flagged as requiring admin approval; skipping moderator-profile cycle.",
    });
    logEvent("facebook_admin_approval_skipped_group_not_moderated", { groupUrl });
    return null;
  }
  const urls = [...new Set((candidateUrls || []).map((url) => {
    try { return sanitizeFacebookPostUrl(url); } catch { return ""; }
  }).filter(Boolean))];
  // Try pending queue search by author ID FIRST (empty postUrl) — fastest reliable
  // approach. Fall back to specific candidate permalinks only if that fails.
  const targetUrls = urls.length ? ["", ...urls.slice(0, 8)] : [""];
  const adminProfiles = await facebookAdminApprovalProfilesForGroup(groupUrl, state, { excludeProfileId: ready.profileId });
  appendFacebookLivePostLedger({
    event: "admin_approval_planned",
    key: ledgerKey,
    planId: row.planId,
    sequence: row.sequence,
    profileId: ready.profileId,
    profile: row.profile || "",
    groupUrl,
    status: adminProfiles.length ? "admin_profiles_available" : "no_admin_profile",
    message: adminProfiles.length
      ? (urls.length
        ? `Trying ${adminProfiles.length} admin/moderator profile(s) against ${urls.length} candidate permalink(s).`
        : `Trying ${adminProfiles.length} admin/moderator profile(s) to find a pending post by marker without a captured permalink.`)
      : "No admin/moderator IXBrowser profile is configured or detectable for this group.",
    candidateUrls: urls.slice(0, 10),
  });
  if (!adminProfiles.length) return null;
  const lockRequestedAt = Date.now();
  const releaseApprovalLock = await acquireAdminApprovalLock();
  logEvent("facebook_admin_approval_lock_acquired", { profileId: ready.profileId, queueWaitMs: Date.now() - lockRequestedAt });
  try {
  const publisherClose = await ixBrowserCloseAfterUse(ready.profileId, "facebook_live_post_before_admin_approval");
  closeResults.push(publisherClose);
  // SERIALIZE the moderator session on low-core/no-GPU boxes: ixBrowserCloseAfterUse
  // only awaits the close REQUEST — the publisher browser process keeps tearing down
  // asynchronously. Opening the moderator browser immediately (below) renders TWO
  // heavy sessions at once and saturates a 4-core box, so both hang and the post is
  // never approved. Wait for the publisher to fully settle so the approval session
  // runs ALONE on a freed box.
  if (publisherClose?.status === "closed") {
    const settleMs = clampNumber(state.operator?.adminApprovalSettleSeconds, 0, 60, 3) * 1000;
    if (settleMs > 0) {
      logEvent("facebook_admin_approval_publisher_settle", { waitMs: settleMs, profileId: ready.profileId });
      await sleep(settleMs);
    }
  }
  const attempts = [];
  const MAX_ADMIN_APPROVAL_ATTEMPTS = 6;
  const MAX_ADMIN_APPROVAL_WALL_CLOCK_MS = 8 * 60 * 1000;
  const approvalStartedAt = Date.now();
  let budgetExceeded = false;
  outer: for (const postUrl of targetUrls) {
    let urlMarkerMissing = false;
    for (const adminProfile of adminProfiles) {
      if (attempts.length >= MAX_ADMIN_APPROVAL_ATTEMPTS) { budgetExceeded = true; break outer; }
      // Strictly bound the HELD box-wide moderator lock: the 8-min cap was only checked
      // BETWEEN attempts, so a single 6-min attempt could hold the lock ~14 min and stall
      // every other pending-post approval. Never start an attempt with <20s of budget, and
      // cap this attempt's own timeout to the remaining budget.
      const remainingBudgetMs = MAX_ADMIN_APPROVAL_WALL_CLOCK_MS - (Date.now() - approvalStartedAt);
      if (remainingBudgetMs <= 20000) { budgetExceeded = true; break outer; }
      const attempt = await runFacebookAdminApprovalAttempt({
        row,
        timeoutMs: Math.min(FACEBOOK_ADMIN_APPROVAL_TIMEOUT_MS, remainingBudgetMs),
        profileId: adminProfile.profileId,
        profileLabel: adminProfile.profile,
        groupUrl,
        postUrl,
        ledgerKey,
        reason,
      });
      closeResults.push(...(attempt.closeResults || []));
      attempts.push({
        profileId: attempt.profileId,
        profile: attempt.profile,
        postUrl: attempt.postUrl || postUrl,
        ok: Boolean(attempt.ok),
        validation: attempt.validation,
        liveLogFile: attempt.liveLogFile || "",
        message: oneLineField(attempt.message || "", 300),
      });
      if (attempt.ok && attempt.postUrl) {
        return {
          ...attempt,
          attemptedApprovalProfiles: attempts,
          approvalProfileId: attempt.profileId,
          approvalProfile: attempt.profile,
        };
      }
      // FAST-BAIL: a moderator confirmed (via a real pending-queue scan) that this
      // publisher has NO post awaiting moderation — the post is already live (or never
      // landed), NOT pending. No other moderator will find it pending either, so stop the
      // whole cycle now instead of opening every moderator (~1min each, ~6min total). This
      // frees the shared box fast and never competes with the Pinterest agent.
      // APPROVER IS NOT A MODERATOR OF THIS GROUP: the pending queue redirected to the feed for
      // this profile. Do NOT fast-bail — a DIFFERENT configured moderator (e.g. 42 vs 41) may hold
      // the role. Try the next profile instead.
      if (attempt.validation?.approverLacksAdminRole) {
        logEvent("facebook_admin_approval_profile_not_admin_of_group", {
          profileId: attempt.profileId,
          profile: attempt.profile,
          groupUrl,
        });
        continue;
      }
      if (attempt.validation?.noPendingPostForPublisher) {
        logEvent("facebook_admin_approval_no_pending_post_fast_bail", {
          profileId: attempt.profileId,
          attemptsSoFar: attempts.length,
          reason: "publisher_has_no_pending_post_in_queue_post_is_not_pending",
        });
        break outer;
      }
      const errs = Array.isArray(attempt.validation?.errors) ? attempt.validation.errors.map(e => String(e || '').toLowerCase()) : [];
      const markerMissingOnUrl = postUrl && errs.some(e => /admin_approval_post_marker_not_verified|admin_approval_page_unavailable|admin_approval_post_not_found_at_url/i.test(e));
      if (markerMissingOnUrl) { urlMarkerMissing = true; break; }
    }
    if (urlMarkerMissing) {
      logEvent("facebook_admin_approval_skipping_remaining_profiles_for_url", {
        postUrl,
        attemptsSoFar: attempts.length,
        reason: "marker_not_on_url_other_profiles_would_see_same",
      });
    }
  }
  // LOUD operator signal: if EVERY configured moderator profile redirected away from the pending
  // queue, none of them actually moderate this group. This is an operator/permission problem, NOT
  // "post is not pending" — surface it unmistakably so posts don't silently pile up pending.
  if (attempts.length > 0 && attempts.every((a) => a.validation?.approverLacksAdminRole)) {
    logEvent("facebook_admin_approval_no_admin_profile_has_rights", {
      groupUrl,
      triedProfiles: [...new Set(attempts.map((a) => a.profileId))],
      message: "Configured moderator profiles are NOT admins/moderators of this group. Grant them the moderator role on Facebook for this group, or configure profiles that already moderate it.",
    });
  }
  if (budgetExceeded) {
    logEvent("facebook_admin_approval_budget_exceeded", {
      attempts: attempts.length,
      maxAttempts: MAX_ADMIN_APPROVAL_ATTEMPTS,
      elapsedMs: Date.now() - approvalStartedAt,
      maxElapsedMs: MAX_ADMIN_APPROVAL_WALL_CLOCK_MS,
    });
  }
  return {
    ok: false,
    postUrl: urls[0] || attempts.find((attempt) => attempt.postUrl)?.postUrl || "",
    attemptedApprovalProfiles: attempts,
    validation: attempts[attempts.length - 1]?.validation || { ok: false, errors: ["admin_approval_not_verified"], warnings: [] },
    liveLogFile: attempts[attempts.length - 1]?.liveLogFile || "",
    message: attempts.length
      ? `Admin approval did not verify the pending post after ${attempts.length} attempt(s).`
      : "No admin approval attempt was made.",
  };
  } finally {
    releaseApprovalLock();
    logEvent("facebook_admin_approval_lock_released", { profileId: ready.profileId });
  }
}

async function runFacebookCommentRecoveryAttempt({ row, profileId, profileLabel, groupUrl, postUrl, imagePath, ledgerKey, reason }) {
  const numericProfileId = Number(profileId);
  const cleanProfile = oneLineField(profileLabel || numericProfileId || "", 180);
  const closeResults = [];
  const state = readState();
  if (isDedicatedShopYourLikesIxProfile(numericProfileId) || isDedicatedShopYourLikesProfileLabel(cleanProfile)) {
    const validation = {
      ok: false,
      errors: ["dedicated_shopyourlikes_profile_reserved_for_affiliate"],
      warnings: [],
      commentRequired: true,
      commentSubmitted: false,
      commentVerified: false,
    };
    appendFacebookLivePostLedger({
      event: "comment_recovery_skipped",
      key: ledgerKey,
      planId: row.planId,
      sequence: row.sequence,
      profileId: numericProfileId,
      profile: cleanProfile,
      groupUrl,
      actualGroupUrl: groupUrl,
      postUrl,
      status: "comment_recovery_failed",
      message: "Dedicated ShopYourLikes IXBrowser profile is reserved for affiliate URL generation and cannot comment.",
      validation,
    });
    return {
      ok: false,
      profileId: numericProfileId,
      profile: cleanProfile,
      validation,
      closeResults,
      message: "Dedicated ShopYourLikes IXBrowser profile is reserved for affiliate URL generation and cannot comment.",
      liveLog: [],
      liveLogFile: "",
      payloadFile: "",
      payloadDeleted: false,
      script: path.relative(ROOT, liveFacebookPostingScriptPath()).replace(/\\/g, "/"),
    };
  }
  if (isBlockedIxBrowserProfileLabel(cleanProfile, state)) {
    const validation = {
      ok: false,
      errors: ["ixbrowser_profile_name_blocked"],
      warnings: [],
      commentRequired: true,
      commentSubmitted: false,
      commentVerified: false,
    };
    appendFacebookLivePostLedger({
      event: "comment_recovery_skipped",
      key: ledgerKey,
      planId: row.planId,
      sequence: row.sequence,
      profileId: numericProfileId,
      profile: cleanProfile,
      groupUrl,
      actualGroupUrl: groupUrl,
      postUrl,
      status: "comment_recovery_failed",
      message: `IXBrowser profile "${cleanProfile}" is blocked by name and will not be used for Facebook comments.`,
      validation,
    });
    return {
      ok: false,
      profileId: numericProfileId,
      profile: cleanProfile,
      validation,
      closeResults,
      message: `IXBrowser profile "${cleanProfile}" is blocked by name and will not be used for Facebook comments.`,
      liveLog: [],
      liveLogFile: "",
      payloadFile: "",
      payloadDeleted: false,
      script: path.relative(ROOT, liveFacebookPostingScriptPath()).replace(/\\/g, "/"),
    };
  }
  if (isFacebookProfileQuarantinedForFacebook(cleanProfile, state, groupUrl)) {
    const validation = {
      ok: false,
      errors: ["facebook_profile_quarantined"],
      warnings: [],
      commentRequired: true,
      commentSubmitted: false,
      commentVerified: false,
    };
    appendFacebookLivePostLedger({
      event: "comment_recovery_skipped",
      key: ledgerKey,
      planId: row.planId,
      sequence: row.sequence,
      profileId: numericProfileId,
      profile: cleanProfile,
      groupUrl,
      actualGroupUrl: groupUrl,
      postUrl,
      status: "comment_recovery_failed",
      message: `IXBrowser profile "${cleanProfile}" is quarantined for Facebook and will not be used for comments.`,
      validation,
    });
    return {
      ok: false,
      profileId: numericProfileId,
      profile: cleanProfile,
      validation,
      closeResults,
      message: `IXBrowser profile "${cleanProfile}" is quarantined for Facebook and will not be used for comments.`,
      liveLog: [],
      liveLogFile: "",
      payloadFile: "",
      payloadDeleted: false,
      script: path.relative(ROOT, liveFacebookPostingScriptPath()).replace(/\\/g, "/"),
    };
  }
  const payload = {
    ...livePostPayloadForRow(row, groupUrl, imagePath, numericProfileId),
    commentOnly: true,
    postUrl,
    imagePath: "",
  };
  let releaseProfileUse = () => {};
  try {
    releaseProfileUse = acquireNormalIxProfileUse(numericProfileId, "facebook_comment_recovery");
  } catch (err) {
    const validation = { ok: false, errors: ["comment_recovery_profile_busy"], warnings: [], commentRequired: true, commentSubmitted: false, commentVerified: false };
    appendFacebookLivePostLedger({
      event: "comment_recovery_skipped",
      key: ledgerKey,
      planId: row.planId,
      sequence: row.sequence,
      profileId: numericProfileId,
      profile: cleanProfile,
      groupUrl,
      actualGroupUrl: groupUrl,
      postUrl,
      status: "comment_recovery_failed",
      message: oneLineField(err.message || String(err), 700),
      validation,
    });
    return {
      ok: false,
      profileId: numericProfileId,
      profile: cleanProfile,
      validation,
      closeResults,
      message: err.message || String(err),
      liveLog: [],
      liveLogFile: "",
      payloadFile: "",
      payloadDeleted: false,
      script: path.relative(ROOT, liveFacebookPostingScriptPath()).replace(/\\/g, "/"),
    };
  }
  try {
    const preOpenClose = await ixBrowserCloseAfterUse(numericProfileId, "facebook_comment_recovery_preopen_cleanup");
    closeResults.push(preOpenClose);
    assertIxBrowserPreOpenCleanupOk(preOpenClose, numericProfileId, "facebook_comment_recovery_preopen_cleanup");
    if (preOpenClose?.status === "closed") await sleep(700);
    appendFacebookLivePostLedger({
      event: "comment_recovery_started",
      key: ledgerKey,
      planId: row.planId,
      sequence: row.sequence,
      profileId: numericProfileId,
      profile: cleanProfile,
      groupUrl,
      actualGroupUrl: groupUrl,
      postUrl,
      status: "running",
      message: oneLineField(reason || "Running comment-only recovery for an already published post.", 700),
    });
    const scriptResult = await runLiveFacebookPostScript(payload, { timeoutMs: FACEBOOK_COMMENT_RECOVERY_TIMEOUT_MS });
    const validation = scriptResult.validation || livePostLogValidation(scriptResult.objects, payload);
    appendFacebookLivePostLedger({
      event: "comment_recovery_finished",
      key: ledgerKey,
      planId: row.planId,
      sequence: row.sequence,
      profileId: numericProfileId,
      profile: cleanProfile,
      groupUrl,
      actualGroupUrl: groupUrl,
      postUrl,
      status: validation.ok ? (validation.warnings?.length ? "published_with_warning" : "published") : "comment_recovery_failed",
      message: validation.ok ? "Comment-only recovery verified the required comment link." : `Comment-only recovery failed: ${validation.errors.join(", ") || "unknown_verification_error"}`,
      validation,
      liveLogFile: scriptResult.liveLogFile || "",
      payloadFile: scriptResult.payloadFile || "",
    });
    if (!validation.ok) {
      recordPublishedPostCommentIssue({
        row,
        ready: { profileId: numericProfileId },
        groupUrl,
        attemptedGroups: [groupUrl],
        validation,
        postUrl,
        profileId: numericProfileId,
        profileLabel: cleanProfile,
      });
    } else {
      recordFacebookCommentProfileUsage({
        row,
        groupUrl,
        postUrl,
        profileId: numericProfileId,
        profileLabel: cleanProfile,
        validation,
      });
    }
    return {
      ok: validation.ok,
      profileId: numericProfileId,
      profile: cleanProfile,
      validation,
      closeResults,
      payloadFile: scriptResult.payloadFile || "",
      payloadDeleted: scriptResult.payloadDeleted,
      liveLogFile: scriptResult.liveLogFile || "",
      script: scriptResult.script,
      message: validation.ok ? "Comment-only recovery verified the required comment link." : "Comment-only recovery did not verify the required link.",
      liveLog: compactLivePostLog(scriptResult.objects),
    };
  } catch (err) {
    const liveObjects = err.livePostLog || [];
    const validation = err.livePostValidation || (liveObjects.length ? livePostLogValidation(liveObjects, payload) : null) || {
      ok: false,
      errors: ["comment_recovery_connector_error"],
      warnings: [],
      commentRequired: true,
      commentSubmitted: false,
      commentVerified: false,
    };
    if (isFacebookAccountHardBlockedFailure(err.message || String(err), validation, liveObjects)) {
      recordFacebookAccountHardBlock({
        profile: cleanProfile,
        profileId: numericProfileId,
        groupUrl,
        reason: err.message || validation.facebookAccountBlockReason || "Facebook account is suspended, disabled, locked, or requires review.",
        source: "facebook_comment_recovery",
      });
    }
    appendFacebookLivePostLedger({
      event: "comment_recovery_error",
      key: ledgerKey,
      planId: row.planId,
      sequence: row.sequence,
      profileId: numericProfileId,
      profile: cleanProfile,
      groupUrl,
      actualGroupUrl: groupUrl,
      postUrl,
      status: "comment_recovery_failed",
      message: err.message || String(err),
      validation,
      liveLogFile: err.livePostLogFile || "",
      payloadFile: err.payloadFile || "",
    });
    recordPublishedPostCommentIssue({
      row,
      ready: { profileId: numericProfileId },
      groupUrl,
      attemptedGroups: [groupUrl],
      validation,
      postUrl,
      profileId: numericProfileId,
      profileLabel: cleanProfile,
    });
    return {
      ok: false,
      profileId: numericProfileId,
      profile: cleanProfile,
      validation,
      closeResults,
      payloadFile: err.payloadFile || "",
      payloadDeleted: Boolean(err.payloadDeleted),
      liveLogFile: err.livePostLogFile || "",
      script: path.relative(ROOT, liveFacebookPostingScriptPath()).replace(/\\/g, "/"),
      message: oneLineField(err.message || String(err), 700),
      liveLog: compactLivePostLog(liveObjects),
    };
  } finally {
    const closeResult = await ixBrowserCloseAfterUse(numericProfileId, "facebook_comment_recovery_finished");
    closeResults.push(closeResult);
    appendFacebookLivePostLedger({
      event: "browser_closed_after_comment_recovery",
      key: ledgerKey,
      planId: row.planId,
      sequence: row.sequence,
      profileId: numericProfileId,
      profile: cleanProfile,
      groupUrl,
      actualGroupUrl: groupUrl,
      postUrl,
      status: closeResult?.ok ? "closed" : "close_failed",
      closeResult,
    });
    releaseProfileUse();
  }
}

async function runFacebookCommentPinOnlyAttempt({ row, profileId, profileLabel, groupUrl, postUrl, imagePath, ledgerKey, reason }) {
  const numericProfileId = Number(profileId);
  const cleanProfile = oneLineField(profileLabel || numericProfileId || "", 180);
  const closeResults = [];
  const state = readState();
  if (isDedicatedShopYourLikesIxProfile(numericProfileId) || isDedicatedShopYourLikesProfileLabel(cleanProfile)) {
    const validation = {
      ok: false,
      errors: ["dedicated_shopyourlikes_profile_reserved_for_affiliate"],
      warnings: [],
      commentRequired: true,
      commentSubmitted: false,
      commentVerified: false,
      pinRequired: true,
      commentPinClicked: false,
      commentPinVerified: false,
    };
    appendFacebookLivePostLedger({
      event: "comment_pin_recovery_skipped",
      key: ledgerKey,
      planId: row.planId,
      sequence: row.sequence,
      profileId: numericProfileId,
      profile: cleanProfile,
      groupUrl,
      actualGroupUrl: groupUrl,
      postUrl,
      status: "comment_pin_recovery_failed",
      message: "Dedicated ShopYourLikes IXBrowser profile is reserved for affiliate URL generation and cannot pin Facebook comments.",
      validation,
    });
    return {
      ok: false,
      profileId: numericProfileId,
      profile: cleanProfile,
      validation,
      closeResults,
      message: "Dedicated ShopYourLikes IXBrowser profile is reserved for affiliate URL generation and cannot pin Facebook comments.",
      liveLog: [],
      liveLogFile: "",
      payloadFile: "",
      payloadDeleted: false,
      script: path.relative(ROOT, liveFacebookPostingScriptPath()).replace(/\\/g, "/"),
    };
  }
  if (isBlockedIxBrowserProfileLabel(cleanProfile, state)) {
    const validation = {
      ok: false,
      errors: ["ixbrowser_profile_name_blocked"],
      warnings: [],
      commentRequired: true,
      commentSubmitted: false,
      commentVerified: false,
      pinRequired: true,
      commentPinClicked: false,
      commentPinVerified: false,
    };
    appendFacebookLivePostLedger({
      event: "comment_pin_recovery_skipped",
      key: ledgerKey,
      planId: row.planId,
      sequence: row.sequence,
      profileId: numericProfileId,
      profile: cleanProfile,
      groupUrl,
      actualGroupUrl: groupUrl,
      postUrl,
      status: "comment_pin_recovery_failed",
      message: `IXBrowser profile "${cleanProfile}" is blocked by name and will not be used for Facebook comment pinning.`,
      validation,
    });
    return {
      ok: false,
      profileId: numericProfileId,
      profile: cleanProfile,
      validation,
      closeResults,
      message: `IXBrowser profile "${cleanProfile}" is blocked by name and will not be used for Facebook comment pinning.`,
      liveLog: [],
      liveLogFile: "",
      payloadFile: "",
      payloadDeleted: false,
      script: path.relative(ROOT, liveFacebookPostingScriptPath()).replace(/\\/g, "/"),
    };
  }
  if (isFacebookProfileQuarantinedForFacebook(cleanProfile, state, groupUrl)) {
    const validation = {
      ok: false,
      errors: ["facebook_profile_quarantined"],
      warnings: [],
      commentRequired: true,
      commentSubmitted: false,
      commentVerified: false,
      pinRequired: true,
      commentPinClicked: false,
      commentPinVerified: false,
    };
    appendFacebookLivePostLedger({
      event: "comment_pin_recovery_skipped",
      key: ledgerKey,
      planId: row.planId,
      sequence: row.sequence,
      profileId: numericProfileId,
      profile: cleanProfile,
      groupUrl,
      actualGroupUrl: groupUrl,
      postUrl,
      status: "comment_pin_recovery_failed",
      message: `IXBrowser profile "${cleanProfile}" is quarantined for Facebook and will not be used for comment pinning.`,
      validation,
    });
    return {
      ok: false,
      profileId: numericProfileId,
      profile: cleanProfile,
      validation,
      closeResults,
      message: `IXBrowser profile "${cleanProfile}" is quarantined for Facebook and will not be used for comment pinning.`,
      liveLog: [],
      liveLogFile: "",
      payloadFile: "",
      payloadDeleted: false,
      script: path.relative(ROOT, liveFacebookPostingScriptPath()).replace(/\\/g, "/"),
    };
  }
  const payload = {
    ...livePostPayloadForRow(row, groupUrl, imagePath, numericProfileId),
    commentOnly: true,
    pinOnly: true,
    postUrl,
    imagePath: "",
  };
  let releaseProfileUse = () => {};
  try {
    releaseProfileUse = acquireNormalIxProfileUse(numericProfileId, "facebook_comment_pin_recovery");
  } catch (err) {
    const validation = { ok: false, errors: ["comment_pin_recovery_profile_busy"], warnings: [], commentRequired: true, commentVerified: false, pinRequired: true, commentPinVerified: false };
    appendFacebookLivePostLedger({
      event: "comment_pin_recovery_skipped",
      key: ledgerKey,
      planId: row.planId,
      sequence: row.sequence,
      profileId: numericProfileId,
      profile: cleanProfile,
      groupUrl,
      actualGroupUrl: groupUrl,
      postUrl,
      status: "comment_pin_recovery_failed",
      message: oneLineField(err.message || String(err), 700),
      validation,
    });
    return {
      ok: false,
      profileId: numericProfileId,
      profile: cleanProfile,
      validation,
      closeResults,
      message: err.message || String(err),
      liveLog: [],
      liveLogFile: "",
      payloadFile: "",
      payloadDeleted: false,
      script: path.relative(ROOT, liveFacebookPostingScriptPath()).replace(/\\/g, "/"),
    };
  }
  try {
    const preOpenClose = await ixBrowserCloseAfterUse(numericProfileId, "facebook_comment_pin_recovery_preopen_cleanup");
    closeResults.push(preOpenClose);
    assertIxBrowserPreOpenCleanupOk(preOpenClose, numericProfileId, "facebook_comment_pin_recovery_preopen_cleanup");
    if (preOpenClose?.status === "closed") await sleep(700);
    appendFacebookLivePostLedger({
      event: "comment_pin_recovery_started",
      key: ledgerKey,
      planId: row.planId,
      sequence: row.sequence,
      profileId: numericProfileId,
      profile: cleanProfile,
      groupUrl,
      actualGroupUrl: groupUrl,
      postUrl,
      status: "running",
      message: oneLineField(reason || "Running pin-only recovery for an already verified first comment.", 700),
    });
    const scriptResult = await runLiveFacebookPostScript(payload, { timeoutMs: FACEBOOK_COMMENT_RECOVERY_TIMEOUT_MS });
    const validation = scriptResult.validation || livePostLogValidation(scriptResult.objects, payload);
    const pinVerified = Boolean(validation.commentPinVerified);
    appendFacebookLivePostLedger({
      event: "comment_pin_recovery_finished",
      key: ledgerKey,
      planId: row.planId,
      sequence: row.sequence,
      profileId: numericProfileId,
      profile: cleanProfile,
      groupUrl,
      actualGroupUrl: groupUrl,
      postUrl,
      status: pinVerified ? "comment_pin_verified" : "comment_pin_recovery_failed",
      message: pinVerified ? "Pin-only recovery verified the first comment pin." : "Pin-only recovery did not verify the first comment pin.",
      validation,
      liveLogFile: scriptResult.liveLogFile || "",
      payloadFile: scriptResult.payloadFile || "",
    });
    return {
      ok: pinVerified,
      profileId: numericProfileId,
      profile: cleanProfile,
      validation,
      closeResults,
      payloadFile: scriptResult.payloadFile || "",
      payloadDeleted: scriptResult.payloadDeleted,
      liveLogFile: scriptResult.liveLogFile || "",
      script: scriptResult.script,
      message: pinVerified ? "Pin-only recovery verified the first comment pin." : "Pin-only recovery did not verify the first comment pin.",
      liveLog: compactLivePostLog(scriptResult.objects),
    };
  } catch (err) {
    const liveObjects = err.livePostLog || [];
    const validation = err.livePostValidation || (liveObjects.length ? livePostLogValidation(liveObjects, payload) : null) || {
      ok: false,
      errors: ["comment_pin_recovery_connector_error"],
      warnings: [],
      commentRequired: true,
      commentVerified: false,
      pinRequired: true,
      commentPinVerified: false,
    };
    if (isFacebookAccountHardBlockedFailure(err.message || String(err), validation, liveObjects)) {
      recordFacebookAccountHardBlock({
        profile: cleanProfile,
        profileId: numericProfileId,
        groupUrl,
        reason: err.message || validation.facebookAccountBlockReason || "Facebook account is suspended, disabled, locked, or requires review.",
        source: "facebook_comment_pin_recovery",
      });
    }
    appendFacebookLivePostLedger({
      event: "comment_pin_recovery_error",
      key: ledgerKey,
      planId: row.planId,
      sequence: row.sequence,
      profileId: numericProfileId,
      profile: cleanProfile,
      groupUrl,
      actualGroupUrl: groupUrl,
      postUrl,
      status: "comment_pin_recovery_failed",
      message: err.message || String(err),
      validation,
      liveLogFile: err.livePostLogFile || "",
      payloadFile: err.payloadFile || "",
    });
    return {
      ok: false,
      profileId: numericProfileId,
      profile: cleanProfile,
      validation,
      closeResults,
      payloadFile: err.payloadFile || "",
      payloadDeleted: Boolean(err.payloadDeleted),
      liveLogFile: err.livePostLogFile || "",
      script: path.relative(ROOT, liveFacebookPostingScriptPath()).replace(/\\/g, "/"),
      message: oneLineField(err.message || String(err), 700),
      liveLog: compactLivePostLog(liveObjects),
    };
  } finally {
    const closeResult = await ixBrowserCloseAfterUse(numericProfileId, "facebook_comment_pin_recovery_finished");
    closeResults.push(closeResult);
    appendFacebookLivePostLedger({
      event: "browser_closed_after_comment_pin_recovery",
      key: ledgerKey,
      planId: row.planId,
      sequence: row.sequence,
      profileId: numericProfileId,
      profile: cleanProfile,
      groupUrl,
      actualGroupUrl: groupUrl,
      postUrl,
      status: closeResult?.ok ? "closed" : "close_failed",
      closeResult,
    });
    releaseProfileUse();
  }
}

async function recoverFacebookCommentPinWithProfiles({ row, ready, groupUrl, postUrl, imagePath, baseValidation, ledgerKey, closeResults, excludeProfileIds = [] }) {
  if (!livePostValidationNeedsPinRecovery(baseValidation)) return null;
  const state = readState();
  const seen = new Set(excludeProfileIds.map((value) => Number(value || 0)).filter(Boolean));
  const candidates = [];
  const addCandidate = (profileId, profileLabel, source) => {
    const id = Number(profileId || profileIdFromLabel(profileLabel) || 0);
    const label = oneLineField(profileLabel || id || "", 180);
    if (!id || seen.has(id)) return;
    if (isDedicatedShopYourLikesIxProfile(id, state) || isDedicatedShopYourLikesProfileLabel(label, state)) return;
    if (isBlockedIxBrowserProfileLabel(label, state)) return;
    seen.add(id);
    candidates.push({ profileId: id, profile: label, groupUrl, source: oneLineField(source || "pin_recovery", 80) });
  };
  addCandidate(ready.profileId, row.profile || ready.profileId, "post_publisher_pin_recovery");
  appendFacebookLivePostLedger({
    event: "comment_pin_recovery_planned",
    key: ledgerKey,
    planId: row.planId,
    sequence: row.sequence,
    profileId: ready.profileId,
    profile: row.profile || "",
    groupUrl,
    actualGroupUrl: groupUrl,
    postUrl,
    status: candidates.length ? "pin_profiles_available" : "no_pin_profile",
    message: candidates.length
      ? `Trying ${candidates.length} publisher profile(s) to pin the already verified first comment.`
      : "No publisher profile is available to pin the already verified first comment.",
    validation: baseValidation,
  });
  if (!candidates.length) return null;
  const attempts = [];
  const pinCloseResults = [];
  for (const profile of candidates.slice(0, MAX_COMMENT_FALLBACK_PROFILES)) {
    const attempt = await runFacebookCommentPinOnlyAttempt({
      row,
      profileId: profile.profileId,
      profileLabel: profile.profile,
      groupUrl,
      postUrl,
      imagePath,
      ledgerKey,
      reason: "First comment was verified, but the comment profile could not expose/verify the pin action.",
    });
    pinCloseResults.push(...(attempt.closeResults || []));
    attempts.push({
      profileId: attempt.profileId,
      profile: attempt.profile,
      ok: Boolean(attempt.ok),
      validation: attempt.validation,
      liveLogFile: attempt.liveLogFile || "",
      message: oneLineField(attempt.message || "", 300),
    });
    if (attempt.ok) {
      const validation = mergeCommentPinValidation(baseValidation, attempt.validation);
      closeResults.push(...pinCloseResults);
      return {
        ok: true,
        profileId: attempt.profileId,
        profile: attempt.profile,
        validation,
        attemptedPinProfiles: attempts,
        closeResults: pinCloseResults,
        payloadFile: attempt.payloadFile || "",
        payloadDeleted: Boolean(attempt.payloadDeleted),
        liveLogFile: attempt.liveLogFile || "",
        script: attempt.script,
        message: `First comment pin verified with ${attempt.profile}.`,
        liveLog: attempt.liveLog || [],
      };
    }
  }
  closeResults.push(...pinCloseResults);
  return {
    ok: false,
    validation: baseValidation,
    attemptedPinProfiles: attempts,
    closeResults: pinCloseResults,
    liveLogFile: attempts[attempts.length - 1]?.liveLogFile || "",
    message: attempts.length
      ? `First comment was verified, but pin was not verified after ${attempts.length} pin profile attempt(s).`
      : "No pin recovery attempt was made.",
  };
}

// Bounded-concurrency comment gate (was strictly one-at-a-time). Each commenter opens its OWN iX
// profile in a child process and holds a live page through a ~minute-long preflight + submit. Running
// comments ONE AT A TIME made several posts' comments serialize into a multi-minute tail. We now allow
// a SMALL number to overlap (operator.maxConcurrentComments, default 2, capped at 4) — DIFFERENT
// profiles only, so each commenter has its own iX window and one path's profile-close can't tear down
// another's (per-profile collisions stay prevented by withIxBrowserProfileOpenLock + acquireNormalIxProfileUse).
// This roughly halves comment wall-clock; the post already landed, and the resweep still backstops 100%.
let __commentSemaphoreActive = 0;
const __commentSemaphoreWaiters = [];
function acquireCommentLock() {
  const limit = clampNumber(readState().operator?.maxConcurrentComments, 1, 4, 2);
  return new Promise((resolveAcquire) => {
    const grant = () => {
      __commentSemaphoreActive += 1;
      let released = false;
      resolveAcquire(() => {
        if (released) return; // idempotent release
        released = true;
        __commentSemaphoreActive -= 1;
        const nextWaiter = __commentSemaphoreWaiters.shift();
        if (nextWaiter) nextWaiter(); // wake exactly one queued commenter
      });
    };
    if (__commentSemaphoreActive < limit) grant();
    else __commentSemaphoreWaiters.push(grant);
  });
}

// Serialize the PUBLISH + URL-CAPTURE critical section box-wide. This is what makes
// "3-by-3 but IN ORDER" safe: 3 workers run concurrently (pick, open, then comment phases
// overlap), but only ONE worker clicks Post and captures its permalink at a time. The
// collision happened because 2+ posts hit the SHARED group feed within ~2s, so each
// browser's "newest post in the feed" capture could grab a SIBLING's post (or an old
// same-caption one). With this lock, when worker B posts+captures, worker A has ALREADY
// captured its own URL and is out of the critical section — so B's post is unambiguously
// the newest in the feed at B's capture moment. No two posts are ever "newest" at once =>
// no collision, no cross-grab. Same proven single-flight pattern as the comment/approval
// locks. Released the instant the URL is captured; the slower comment phase still overlaps.
let __postCaptureLockChain = Promise.resolve();
function acquirePostCaptureLock() {
  let release;
  const next = new Promise((res) => { release = res; });
  const prior = __postCaptureLockChain;
  __postCaptureLockChain = prior.then(() => next);
  return prior.then(() => release);
}

async function recoverFacebookCommentWithProfiles(args) {
  const lockRequestedAt = Date.now();
  const release = await acquireCommentLock();
  // logEvent calls are INSIDE the try so that release() in finally is guaranteed even if
  // logEvent throws (e.g. fs.appendFileSync EMFILE/EACCES under load). If it threw between
  // acquire and try, the lock chain would never resolve -> permanent box-wide comment
  // deadlock. (Each logEvent is also individually try-guarded.)
  try {
    try { logEvent("facebook_comment_lock_acquired", { profileId: args?.ready?.profileId, queueWaitMs: Date.now() - lockRequestedAt }); } catch {}
    return await recoverFacebookCommentWithProfilesInner(args);
  } finally {
    release();
    try { logEvent("facebook_comment_lock_released", { profileId: args?.ready?.profileId }); } catch {}
  }
}

async function recoverFacebookCommentWithProfilesInner({ row, ready, groupUrl, postUrl, imagePath, profiles, ledgerKey, reason }) {
  const attempts = [];
  const closeResults = [];
  const profileList = (profiles || []).filter(Boolean);
  const totalProfiles = profileList.length;
  let noAccessCount = 0;
  const maxNoAccess = clampNumber(readState().operator?.maxCommentNoAccessAttempts, 1, 20, 3);
  for (const profile of profileList) {
    const profileId = Number(profile?.profileId || profile?.profile_id || profile);
    if (!profileId) continue;
    const attemptNumber = attempts.length + 1;
    const profileLabel = profile?.profile || profile?.profileLabel || profile?.label || profileId;
    persistTestRunStepProgress({
      title: "Facebook first comment",
      percent: 92,
      detail: `Trying first comment with profile ${profileLabel} (${attemptNumber}/${totalProfiles}) on the verified post URL.`,
      steps: {
        post: { label: "Post", status: "done", detail: `Post URL captured: ${postUrl}` },
        postUrl: { label: "Post URL", status: "done", detail: postUrl },
        comment: { label: "Comment", status: "running", detail: `Trying different profile ${profileLabel} (${attemptNumber}/${totalProfiles}).` },
      },
    });
    const attempt = await runFacebookCommentRecoveryAttempt({
      row,
      profileId,
      profileLabel,
      groupUrl,
      postUrl,
      imagePath,
      ledgerKey,
      reason,
    });
    attempts.push({
      profileId: attempt.profileId,
      profile: attempt.profile,
      ok: Boolean(attempt.ok),
      validation: attempt.validation,
      liveLogFile: attempt.liveLogFile || "",
      message: oneLineField(attempt.message || "", 300),
    });
    closeResults.push(...(attempt.closeResults || []));
    if (!attempt.ok) {
      const errors = Array.isArray(attempt.validation?.errors) ? attempt.validation.errors.join(", ") : "";
      persistTestRunStepProgress({
        title: "Facebook first comment",
        percent: 92,
        detail: `Profile ${attempt.profile || profileLabel} did not verify the first comment${errors ? `: ${errors}` : ""}.`,
        steps: {
          post: { label: "Post", status: "done", detail: `Post URL captured: ${postUrl}` },
          postUrl: { label: "Post URL", status: "done", detail: postUrl },
          comment: {
            label: "Comment",
            status: attemptNumber < totalProfiles ? "running" : "failed",
            detail: attemptNumber < totalProfiles
              ? `Profile ${attempt.profile || profileLabel} failed; switching to next different profile.`
              : `No different profile verified the first comment. Last error: ${errors || attempt.message || "unknown"}`,
          },
        },
      });
    }
    if (attempt.ok) {
      return {
        ok: true,
        posted: true,
        postUrl,
        planId: row.planId,
        sequence: row.sequence,
        profileId: ready.profileId,
        profile: row.profile || "",
        commentProfileId: attempt.profileId,
        commentProfile: attempt.profile,
        groupUrl,
        attemptedGroups: [groupUrl],
        attemptedCommentProfiles: attempts,
        closeResults,
        payloadFile: attempt.payloadFile || "",
        payloadDeleted: Boolean(attempt.payloadDeleted),
        liveLogFile: attempt.liveLogFile || "",
        script: attempt.script,
        message: `Post already published; first comment was verified with comment profile ${attempt.profile}.`,
        validation: attempt.validation,
        liveLog: attempt.liveLog || [],
        state: readState(),
        registers: readRegisters(),
      };
    }
    // NO-ACCESS CAP: if this profile failed because it can't reach the group, count it; after
    // `maxNoAccess` such dead-ends stop cycling (give up fast -> post kept, comment skipped)
    // instead of opening every remaining probe profile one-by-one.
    const failStr = `${Array.isArray(attempt.validation?.errors) ? attempt.validation.errors.join(" ") : ""} ${attempt.message || ""}`.toLowerCase();
    if (/cannot[ _].*access|cannot_access|profile_cannot_access|no[ _].*group[ _].*access|not[ _]a[ _]member|group_issue|group_unavailable|content_unavailable/.test(failStr)) {
      noAccessCount += 1;
      if (noAccessCount >= maxNoAccess) {
        logEvent("comment_recovery_no_access_cap_reached", { noAccessCount, tried: attempts.length, groupUrl });
        break;
      }
    }
  }
  const lastAttempt = attempts[attempts.length - 1] || null;
  return {
    ok: false,
    posted: true,
    postUrl,
    planId: row.planId,
    sequence: row.sequence,
    profileId: ready.profileId,
    profile: row.profile || "",
    groupUrl,
    attemptedGroups: [groupUrl],
    attemptedCommentProfiles: attempts,
    closeResults,
    payloadFile: "",
    payloadDeleted: false,
    liveLogFile: lastAttempt?.liveLogFile || "",
    script: path.relative(ROOT, liveFacebookPostingScriptPath()).replace(/\\/g, "/"),
    message: attempts.length
      ? `Post published, but the first-comment link was not verified after ${attempts.length} profile attempt(s).`
      : "Post published, but no approved fallback profile is assigned to this group for first-comment recovery.",
    validation: failedCommentRecoveryValidationFromAttempts(attempts),
    liveLog: [],
    state: readState(),
    registers: readRegisters(),
  };
}

async function closeLiveProfileBeforeCommentFallback({ row, ready, groupUrl, postUrl, ledgerKey, closeResults }) {
  const closeResult = await ixBrowserCloseAfterUse(ready.profileId, "facebook_live_post_before_comment_profile_fallback");
  closeResults.push(closeResult);
  appendFacebookLivePostLedger({
    event: "browser_closed_before_comment_profile_fallback",
    key: ledgerKey,
    planId: row.planId,
    sequence: row.sequence,
    profileId: ready.profileId,
    profile: row.profile || "",
    groupUrl,
    actualGroupUrl: groupUrl,
    postUrl,
    status: closeResult?.ok ? "closed" : "close_failed",
    closeResult,
  });
  return closeResult;
}

async function recoverPublishedPostCommentWithFallbackProfiles({ row, ready, groupUrl, postUrl, imagePath, validation, ledgerKey, closeResults }) {
  if (!livePostValidationAllowsCommentProfileFallback(validation)) return null;
  const state = readState();
  const configuredProfiles = commentRecoveryFallbackProfilesForGroup(row, groupUrl, state, { excludeProfileId: ready.profileId });
  const ixProfiles = await ixBrowserCommentFallbackProfilesForGroup(row, groupUrl, state, { excludeProfileId: ready.profileId });
  let fallbackProfiles = mergeProfileCandidates(configuredProfiles, ixProfiles).slice(0, MAX_COMMENT_FALLBACK_PROFILES);
  fallbackProfiles = (await filterExistingIxBrowserProfiles(fallbackProfiles, groupUrl, "published_post_comment_fallback"))
    .slice(0, MAX_COMMENT_FALLBACK_PROFILES);
  appendFacebookLivePostLedger({
    event: "comment_profile_fallback_planned",
    key: ledgerKey,
    planId: row.planId,
    sequence: row.sequence,
    profileId: ready.profileId,
    profile: row.profile || "",
    groupUrl,
    actualGroupUrl: groupUrl,
    postUrl,
    status: fallbackProfiles.length ? "fallback_profiles_available" : "no_fallback_profile",
    message: fallbackProfiles.length
      ? `Trying ${fallbackProfiles.length} approved same-group fallback profile(s) for the required first comment.`
      : "No approved same-group fallback profile is assigned for first-comment recovery.",
    validation,
  });
  if (!fallbackProfiles.length) return null;
  await closeLiveProfileBeforeCommentFallback({ row, ready, groupUrl, postUrl, ledgerKey, closeResults });
  const recovery = await recoverFacebookCommentWithProfiles({
    row,
    ready,
    groupUrl,
    postUrl,
    imagePath,
    ledgerKey,
    profiles: fallbackProfiles,
    reason: "Publishing profile did not verify the first comment; trying approved fallback profile assigned to the same group.",
  });
  closeResults.push(...(recovery.closeResults || []));
  return recovery;
}

async function recoverFirstCommentWithPublisherProfileFallback({ row, ready, groupUrl, postUrl, imagePath, ledgerKey, closeResults, reason }) {
  const publisherProfile = {
    profileId: Number(ready.profileId || profileIdFromLabel(row.profile) || 0),
    profile: row.profile || ready.profileId,
    source: "publisher_profile_comment_last_resort",
  };
  if (!publisherProfile.profileId) return null;
  appendFacebookLivePostLedger({
    event: "publisher_comment_last_resort_planned",
    key: ledgerKey,
    planId: row.planId,
    sequence: row.sequence,
    profileId: ready.profileId,
    profile: row.profile || "",
    groupUrl,
    actualGroupUrl: groupUrl,
    postUrl,
    status: "publisher_profile_available",
    message: "Different-profile comment was not possible; using the publishing profile for the required first comment as a last resort.",
  });
  const recovery = await recoverFacebookCommentWithProfiles({
    row,
    ready,
    groupUrl,
    postUrl,
    imagePath,
    ledgerKey,
    profiles: [publisherProfile],
    reason: reason || "Last resort: no different approved profile or admin profile could access the post, so the publishing profile is adding the required first comment.",
  });
  closeResults.push(...(recovery.closeResults || []));
  recovery.publisherCommentFallback = {
    attempted: true,
    ok: Boolean(recovery.ok),
    profileId: publisherProfile.profileId,
    profile: publisherProfile.profile,
    liveLogFile: recovery.liveLogFile || "",
  };
  if (recovery.ok) {
    const warnings = new Set([
      ...((Array.isArray(recovery.validation?.warnings) ? recovery.validation.warnings : []).map(String)),
      "first_comment_used_publisher_profile",
    ]);
    recovery.validation = {
      ...(recovery.validation || {}),
      warnings: [...warnings],
    };
    recovery.message = `${recovery.message} Warning: publishing profile was used for the first comment because no different profile could access the post.`;
  }
  return recovery;
}

// ---- LEAST-USED PROFILE FAIRNESS --------------------------------------------
// Spread posting/commenting opportunity EQUALLY across available profiles: prefer the profiles
// used the FEWEST times recently — UNUSED first (in random order), then least-used. Usage is read
// from the durable dailyActionLog / ledger (no new state). Scales with however many profiles exist.
const PROFILE_USAGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
function commentUsageCountByProfile(state = readState(), windowMs = PROFILE_USAGE_WINDOW_MS) {
  const cutoff = Date.now() - windowMs;
  const counts = new Map();
  for (const line of recordLines(state.tracking?.dailyActionLog)) {
    if (!/type=facebook_first_comment_profile_used/i.test(line)) continue;
    const tsM = line.match(/(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)/);
    const at = tsM ? Date.parse(tsM[1]) : NaN;
    if (Number.isFinite(at) && at < cutoff) continue;
    const idM = line.match(/profile_id=(\d{1,20})/i);
    if (idM) { const pid = Number(idM[1]); counts.set(pid, (counts.get(pid) || 0) + 1); }
  }
  return counts;
}
const RECENT_FAILURE_WINDOW_MS = 60 * 60 * 1000;
// Profiles that FAILED to post/open within the last hour — these are DEPRIORITIZED in fairness so a
// freshly-broken profile (e.g. profile-open error, before the blacklist threshold trips) can't keep
// getting re-picked and STALL a run. Single scan of the failure registers.
function recentlyFailedProfileSet(state = readState(), windowMs = RECENT_FAILURE_WINDOW_MS) {
  const cutoff = Date.now() - windowMs;
  const set = new Set();
  for (const line of [state.posting?.facebookProfileStatus, state.ixbrowser?.failedProfiles].join("\n").split(/\r?\n/)) {
    if (/status=(resolved|approved|cleared|ignored)|action=(profile_unblocked|profile_group_unblocked)/i.test(line)) continue;
    if (!/status=cannot_post_in_any_group|action=skip_profile|auto_soft_strike=1|soft_failure_pending/i.test(line)) continue;
    const idM = line.match(/profile_id=(\d{1,20})/i);
    if (!idM) continue;
    const tsM = line.match(/(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)/);
    const at = tsM ? Date.parse(tsM[1]) : NaN;
    if (Number.isFinite(at) && at < cutoff) continue;
    set.add(Number(idM[1]));
  }
  return set;
}
// Order: healthy BEFORE just-failed (so a broken profile can't stall), then least-used within each
// (fairness). Shuffle first so equal-usage profiles (esp. all unused=0) are randomized.
function orderProfilesLeastUsedFirst(profiles, usageMap, failedSet = new Set()) {
  return shuffledCopy(profiles).sort((a, b) => {
    const pa = Number(a.profileId || profileIdFromLabel(a.profile) || 0);
    const pb = Number(b.profileId || profileIdFromLabel(b.profile) || 0);
    const fa = failedSet.has(pa) ? 1 : 0, fb = failedSet.has(pb) ? 1 : 0;
    if (fa !== fb) return fa - fb; // healthy (0) before recently-failed (1)
    return (usageMap.get(pa) || 0) - (usageMap.get(pb) || 0);
  });
}
// Order ready posting-plan rows: healthy-least-used first, just-failed profiles last (fair + no stall).
function orderReadyRowsLeastUsed(rows, postCountByPid, failedSet = new Set(), groupCountByKey = new Map()) {
  return rows.slice().sort((a, b) => {
    // HARVESTED content-source products post FIRST — the whole point of the feature is to publish the
    // copied products. When content-sources is off there are none, so this is inert (all === 1).
    const ha = String(a.productKey || "").startsWith("harvested:") ? 0 : 1;
    const hb = String(b.productKey || "").startsWith("harvested:") ? 0 : 1;
    if (ha !== hb) return ha - hb;
    const pa = Number(a.profileId || profileIdFromLabel(a.profile) || 0);
    const pb = Number(b.profileId || profileIdFromLabel(b.profile) || 0);
    const fa = failedSet.has(pa) ? 1 : 0, fb = failedSet.has(pb) ? 1 : 0;
    if (fa !== fb) return fa - fb;
    // GROUP FAIRNESS (primary): with multiple groups, post to the LEAST-posted-today group first so
    // posts spread EQUALLY across groups. Default-empty map => ga===gb===0 => other callers unchanged.
    const ga = groupCountByKey.get(normalizedFacebookGroupKey(String(a.groupUrl || ""))) ?? 0;
    const gb = groupCountByKey.get(normalizedFacebookGroupKey(String(b.groupUrl || ""))) ?? 0;
    if (ga !== gb) return ga - gb;
    // PROFILE FAIRNESS (secondary): least-posted-today profile within the chosen group tier.
    return (postCountByPid.get(pa) ?? 1e9) - (postCountByPid.get(pb) ?? 1e9);
  });
}

// Profiles that SUCCESSFULLY posted to THIS group recently have PROVEN comment access — you must be
// a member to post. Using them as the top first-comment candidates is the "cross-comment among the
// batch's own posters" path: it guarantees the comment lands (no membership guessing), derived purely
// from the ledger (no fragile open-session reuse needed). Newest-first, excludes the post's own
// publisher, skips SYL/blocked/quarantined. Bounded read from the end of the ledger.
function recentGroupPosterCommentCandidates(groupUrl, state = readState(), options = {}) {
  const excludeId = Number(options.excludeProfileId || 0);
  const gkey = normalizedFacebookGroupKey(String(groupUrl || ""));
  if (!gkey) return [];
  const maxAgeMs = clampNumber(options.maxAgeHours, 1, 720, 72) * 3600000;
  const nowMs = Date.now();
  const seen = new Set();
  const out = [];
  try {
    const lines = fs.readFileSync(FB_LIVE_POST_LEDGER_FILE, "utf8").split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0 && out.length < 12; i -= 1) {
      const t = lines[i].trim();
      if (!t || t.indexOf('"postUrl":"http') === -1) continue; // successful publishes only
      let r; try { r = JSON.parse(t); } catch { continue; }
      if (!r.postUrl) continue;
      if (normalizedFacebookGroupKey(String(r.groupUrl || r.actualGroupUrl || "")) !== gkey) continue;
      const ts = Date.parse(r.at || "");
      if (Number.isFinite(ts) && nowMs - ts > maxAgeMs) continue;
      const pid = Number(r.profileId || 0);
      if (!pid || pid === excludeId || seen.has(pid)) continue;
      const label = String(r.profile || pid);
      if (isDedicatedShopYourLikesProfileLabel(label, state)) continue;
      if (isBlockedIxBrowserProfileLabel(label, state)) continue;
      if (isFacebookProfileQuarantinedForFacebook(label, state, groupUrl)) continue;
      seen.add(pid);
      out.push({ profileId: pid, profile: r.profile || String(pid), source: "recent_group_poster" });
    }
  } catch {}
  return out;
}

async function addRequiredFirstCommentWithDifferentProfile({ row, ready, groupUrl, postUrl, imagePath, postValidation, ledgerKey, closeResults }) {
  const state = readState();
  const configuredProfiles = commentRecoveryFallbackProfilesForGroup(row, groupUrl, state, { excludeProfileId: ready.profileId });
  const ixProfiles = await ixBrowserCommentFallbackProfilesForGroup(row, groupUrl, state, { excludeProfileId: ready.profileId });
  let commentProfiles = mergeProfileCandidates(configuredProfiles, ixProfiles).slice(0, MAX_COMMENT_FALLBACK_PROFILES);
  commentProfiles = (await filterExistingIxBrowserProfiles(commentProfiles, groupUrl, "required_first_comment"))
    .slice(0, MAX_COMMENT_FALLBACK_PROFILES);
  // FAIRNESS: pick a DIFFERENT profile each time, but order each tier LEAST-USED-FIRST (unused
  // profiles first, in random order; then least-used) so commenting opportunity spreads equally
  // across profiles. Still TIERED: profiles with CONFIRMED group access (assigned to THIS group,
  // or with a past successful comment here) are tried FIRST; "probe" profiles (might-have-access
  // guesses) only after — so we never waste minutes on dead-end no-access profiles before the good
  // ones (the "stuck on the last post" symptom).
  const commentUsage = commentUsageCountByProfile(state);
  const commentRecentlyFailed = recentlyFailedProfileSet(state);
  const confirmedTier = orderProfilesLeastUsedFirst(commentProfiles.filter((p) => !/probe/i.test(String(p.source || ""))), commentUsage, commentRecentlyFailed);
  const probeTier = orderProfilesLeastUsedFirst(commentProfiles.filter((p) => /probe/i.test(String(p.source || ""))), commentUsage, commentRecentlyFailed);
  commentProfiles = [...confirmedTier, ...probeTier];
  // PROVEN-ACCESS FIRST (default on): prepend profiles that recently POSTED to this group — they are
  // guaranteed members, so the first comment attempt lands before the no-access cap can trip. This is
  // the cross-comment-among-posters guarantee; the resweep then catches any post whose posters were
  // still busy at inline-comment time. Set operator.provenPosterCommentFirst=false to disable.
  if (state.operator?.provenPosterCommentFirst !== false) {
    const have = new Set(commentProfiles.map((p) => Number(p.profileId || p.profile_id || 0)));
    const posters = recentGroupPosterCommentCandidates(groupUrl, state, { excludeProfileId: ready.profileId })
      .filter((p) => !have.has(Number(p.profileId)));
    if (posters.length) {
      commentProfiles = [...posters, ...commentProfiles].slice(0, Math.max(MAX_COMMENT_FALLBACK_PROFILES, posters.length + 2));
    }
  }
  appendFacebookLivePostLedger({
    event: "comment_profile_required_planned",
    key: ledgerKey,
    planId: row.planId,
    sequence: row.sequence,
    profileId: ready.profileId,
    profile: row.profile || "",
    groupUrl,
    actualGroupUrl: groupUrl,
    postUrl,
    status: commentProfiles.length ? "comment_profiles_available" : "no_comment_profile",
    message: commentProfiles.length
      ? `Post was created; using ${commentProfiles.length} different approved same-group profile(s) for the required first comment.`
      : "Post was created, but no different approved same-group profile is assigned for the required first comment.",
    validation: postValidation || null,
  });
  if (!commentProfiles.length) {
    return {
      ok: false,
      posted: true,
      postUrl,
      planId: row.planId,
      sequence: row.sequence,
      profileId: ready.profileId,
      profile: row.profile || "",
      groupUrl,
      attemptedGroups: [groupUrl],
      attemptedCommentProfiles: [],
      closeResults,
      payloadFile: "",
      payloadDeleted: false,
      liveLogFile: "",
      script: path.relative(ROOT, liveFacebookPostingScriptPath()).replace(/\\/g, "/"),
      message: "Post published, but no different approved same-group IXBrowser profile is assigned to add the first comment.",
      validation: { ok: false, errors: ["comment_requires_different_profile_unavailable"], warnings: [], commentRequired: true, commentSubmitted: false, commentVerified: false },
      postValidation: postValidation || null,
      liveLog: [],
      state: readState(),
      registers: readRegisters(),
    };
  }
  await closeLiveProfileBeforeCommentFallback({ row, ready, groupUrl, postUrl, ledgerKey, closeResults });
  const recovery = await recoverFacebookCommentWithProfiles({
    row,
    ready,
    groupUrl,
    postUrl,
    imagePath,
    ledgerKey,
    profiles: commentProfiles,
    reason: "Required policy: first comment must be added by a different approved profile assigned to the same group.",
  });
  closeResults.push(...(recovery.closeResults || []));
  if (recovery.ok && livePostValidationNeedsPinRecovery(recovery.validation)) {
    const pinRecovery = await recoverFacebookCommentPinWithProfiles({
      row,
      ready,
      groupUrl,
      postUrl,
      imagePath,
      baseValidation: recovery.validation,
      ledgerKey,
      closeResults,
      excludeProfileIds: [recovery.commentProfileId, recovery.profileId],
    });
    if (pinRecovery?.ok) {
      return {
        ...recovery,
        validation: pinRecovery.validation,
        pinRecoveryResult: {
          ok: true,
          profileId: pinRecovery.profileId,
          profile: pinRecovery.profile,
          liveLogFile: pinRecovery.liveLogFile || "",
          attemptedPinProfiles: pinRecovery.attemptedPinProfiles || [],
        },
        closeResults,
        message: `${recovery.message} ${pinRecovery.message}`,
        liveLog: pinRecovery.liveLog?.length ? pinRecovery.liveLog : recovery.liveLog,
      };
    }
    recovery.pinRecoveryResult = pinRecovery || null;
  }
  const recoveryErrors = Array.isArray(recovery.validation?.errors) ? recovery.validation.errors.map((error) => String(error || "").toLowerCase()) : [];
  const approvalMayHelp = recoveryErrors.some((error) => (
    error === "comment_profile_cannot_access_post_permalink" ||
    /^comment_blocked:(comments_disabled|post_pending_or_unavailable|content_unavailable|page_unavailable)/i.test(error)
  ));
  if (!recovery.ok && approvalMayHelp) {
    const approvalResult = await approvePendingFacebookPostWithAdminProfiles({
      row,
      ready,
      groupUrl,
      candidateUrls: [postUrl],
      ledgerKey,
      closeResults,
      reason: "Different-profile comment could not access or use the post; trying admin approval on the verified permalink before retrying comment.",
    });
    if (approvalResult?.ok) {
      const retryState = readState();
      const retryConfigured = commentRecoveryFallbackProfilesForGroup(row, groupUrl, retryState, {
        excludeProfileId: ready.profileId,
      });
      const retryIx = await ixBrowserCommentFallbackProfilesForGroup(row, groupUrl, retryState, {
        excludeProfileId: ready.profileId,
      });
      commentProfiles = mergeProfileCandidates(retryConfigured, retryIx)
        .filter((profile) => Number(profile.profileId) !== Number(approvalResult.profileId || approvalResult.approvalProfileId || 0))
        .slice(0, MAX_COMMENT_FALLBACK_PROFILES);
      commentProfiles = (await filterExistingIxBrowserProfiles(commentProfiles, groupUrl, "required_first_comment_after_admin_approval"))
        .slice(0, MAX_COMMENT_FALLBACK_PROFILES);
      const retry = await recoverFacebookCommentWithProfiles({
        row,
        ready,
        groupUrl,
        postUrl: approvalResult.postUrl || postUrl,
        imagePath,
        ledgerKey,
        profiles: commentProfiles,
        reason: "Admin approval was verified; retrying required first comment with a different profile.",
      });
      closeResults.push(...(retry.closeResults || []));
      if (retry.ok && livePostValidationNeedsPinRecovery(retry.validation)) {
        const pinRecovery = await recoverFacebookCommentPinWithProfiles({
          row,
          ready,
          groupUrl,
          postUrl: approvalResult.postUrl || postUrl,
          imagePath,
          baseValidation: retry.validation,
          ledgerKey,
          closeResults,
          excludeProfileIds: [retry.commentProfileId, retry.profileId],
        });
        if (pinRecovery?.ok) {
          return {
            ...retry,
            approvalResult: {
              ok: Boolean(approvalResult.ok),
              approvalProfileId: approvalResult.approvalProfileId || approvalResult.profileId || "",
              approvalProfile: approvalResult.approvalProfile || approvalResult.profile || "",
              liveLogFile: approvalResult.liveLogFile || "",
              attemptedApprovalProfiles: approvalResult.attemptedApprovalProfiles || [],
            },
            postValidation: postValidation || null,
            validation: pinRecovery.validation,
            pinRecoveryResult: {
              ok: true,
              profileId: pinRecovery.profileId,
              profile: pinRecovery.profile,
              liveLogFile: pinRecovery.liveLogFile || "",
              attemptedPinProfiles: pinRecovery.attemptedPinProfiles || [],
            },
            closeResults,
            message: `${retry.message} ${pinRecovery.message}`,
            liveLog: pinRecovery.liveLog?.length ? pinRecovery.liveLog : retry.liveLog,
          };
        }
        retry.pinRecoveryResult = pinRecovery || null;
      }
      return {
        ...retry,
        approvalResult: {
          ok: Boolean(approvalResult.ok),
          approvalProfileId: approvalResult.approvalProfileId || approvalResult.profileId || "",
          approvalProfile: approvalResult.approvalProfile || approvalResult.profile || "",
          liveLogFile: approvalResult.liveLogFile || "",
          attemptedApprovalProfiles: approvalResult.attemptedApprovalProfiles || [],
        },
        postValidation: postValidation || null,
        closeResults,
      };
    }
    recovery.approvalResult = approvalResult || null;
  }
  if (!recovery.ok && approvalMayHelp) {
    appendFacebookLivePostLedger({
      event: "publisher_comment_last_resort_skipped",
      key: ledgerKey,
      planId: row.planId,
      sequence: row.sequence,
      profileId: ready.profileId,
      profile: row.profile || "",
      groupUrl,
      actualGroupUrl: groupUrl,
      postUrl,
      status: "same_profile_comment_blocked_by_policy",
      message: "Different-profile comment failed, but same-profile first comments are disabled by policy.",
      validation: recovery.validation || null,
    });
    recovery.publisherCommentFallback = {
      ok: false,
      skipped: true,
      reason: "same_profile_comment_blocked_by_policy",
    };
  }
  return {
    ...recovery,
    postValidation: postValidation || null,
    closeResults,
  };
}

// ── COMMENT RE-SWEEP — guarantee every LIVE post gets a different-profile first comment ─────────
// A post is published (and its product retired, to prevent duplicate posting) BEFORE the first
// comment is attempted. If that inline attempt fails (commenter busy / none eligible this moment /
// transient miss), the post would stay live-but-uncommented forever — the autopilot never re-picks
// a retired product. This sweep finds recently-published posts that still lack a DIFFERENT-profile
// verified comment and re-attempts the COMMENT ONLY (never reposts: product stays retired, the
// per-run 20-count is untouched). Reconstructs the full row from posting-plan.jsonl by planId+seq.
// Single-flight, armed-gated, throttled, yields to active posting, budget-bounded.
let __commentResweepInFlight = null;
let __lastCommentResweepAt = 0;
async function resweepUncommentedFacebookPostsAsync(options = {}) {
  if (__commentResweepInFlight) return __commentResweepInFlight;
  __commentResweepInFlight = (async () => {
    const summary = { checked: 0, recommented: 0, stillMissing: 0, errors: [] };
    try {
      const state = readState();
      // Re-commenting is an EXTERNAL action — gate on the universal kill switch unless forced.
      if (!options.force && !(state.operator?.autopilotEnabled && state.operator?.armedForExternalActions)) {
        return summary;
      }
      const windowMs = clampNumber(options.windowHours, 1, 168, 24) * 3600 * 1000;
      const cutoff = Date.now() - windowMs;
      const maxToFix = clampNumber(options.max, 1, 50, 10);
      const rows = readJsonlAbsoluteFile(FB_LIVE_POST_LEDGER_FILE, { limit: 8000 });
      const publishedByUrl = new Map();
      for (const r of rows) {
        if (!r || !r.postUrl) continue;
        const isPublished = /^published/.test(String(r.event || "")) || ["published", "published_with_warning", "published_after_admin_approval"].includes(String(r.status || ""));
        if (!isPublished) continue;
        const at = Date.parse(r.at || "") || 0;
        if (at && at < cutoff) continue;
        publishedByUrl.set(r.postUrl, r); // keep the latest published row per permalink
      }
      for (const [postUrl, ev] of publishedByUrl) {
        // Bound by ATTEMPTS, not just successes: a post that can never be commented (no eligible
        // commenter) must not make every 90s sweep do full-cost recovery work against it.
        if (summary.recommented >= maxToFix || summary.checked >= maxToFix) break;
        const publisherId = Number(ev.profileId || 0);
        if (latestDifferentProfileVerifiedCommentForPost(postUrl, publisherId)) continue; // already has a different-profile comment
        const row = postingPlanRowForRecord({ planId: ev.planId, sequence: ev.sequence });
        const commentText = String(row?.commentTextPreview || row?.link || "").trim();
        if (!row || !commentText) { summary.stillMissing += 1; continue; } // cannot reconstruct the comment
        await waitForPostingIdle({ label: "comment_resweep" });
        if (latestDifferentProfileVerifiedCommentForPost(postUrl, publisherId)) continue; // a concurrent post may have just commented it
        summary.checked += 1;
        const groupUrl = facebookGroupUrlFromPostUrl(postUrl) || ev.actualGroupUrl || ev.groupUrl || row.groupUrl;
        const ready = { profileId: publisherId, imagePath: row.imagePath || ev.imagePath || "" };
        const closeResults = [];
        try {
          const res = await addRequiredFirstCommentWithDifferentProfile({
            row,
            ready,
            groupUrl,
            postUrl,
            imagePath: ready.imagePath,
            postValidation: { ok: true, errors: [], warnings: ["comment_resweep_recover"] },
            ledgerKey: livePostLedgerKey(row, publisherId),
            closeResults,
          });
          if (res?.ok || latestDifferentProfileVerifiedCommentForPost(postUrl, publisherId)) summary.recommented += 1;
          else summary.stillMissing += 1;
        } catch (err) {
          summary.errors.push(oneLineField(err.message || String(err), 160));
        }
      }
    } catch (err) {
      summary.errors.push("fatal:" + oneLineField(err.message || String(err), 160));
    } finally {
      __lastCommentResweepAt = Date.now();
      __commentResweepInFlight = null;
    }
    if (summary.checked || summary.recommented || summary.errors.length) {
      logEvent("facebook_comment_resweep_complete", summary);
    }
    return summary;
  })();
  return __commentResweepInFlight;
}

async function completeVerifiedFacebookPostWithComment({
  row,
  ready,
  groupUrl,
  postUrl,
  validation,
  ledgerKey,
  attemptedGroups,
  closeResults,
  postPayloadFile = "",
  postPayloadDeleted = false,
  postLiveLogFile = "",
  postScript = "",
  postLogObjects = [],
  approvalResult = null,
}) {
  const actualGroupUrl = facebookGroupUrlFromPostUrl(postUrl) || groupUrl;
  recordPublishedFacebookPostUrl({
    postUrl,
    row,
    planId: row.planId,
    sequence: row.sequence,
    profile: row.profile || ready.profileId,
    groupUrl: actualGroupUrl,
  });
  // PER-POST run counter, bumped at the RECORD moment — so a post that LANDS but whose comment/cleanup
  // throws afterward is STILL counted exactly once (fixes the rare "stop at N could do N+1" under-count).
  // Gated to autopilot RUN posts (ready.__autopilotRunPost, set only by the tick via countTowardRun — NOT
  // #test) + idempotent (ready.__runCounted). Synchronous readState→writeState = atomic in single-threaded JS.
  if (ready.__autopilotRunPost && !ready.__runCounted) {
    ready.__runCounted = true;
    const sNow = readState();
    const newCount = autopilotPostsThisRunCount(sNow) + 1;
    sNow.operator = sNow.operator || {};
    sNow.operator.autopilotPostsThisRun = newCount;
    writeState(sNow, { controlWrite: true });
    __todayByProfileCache = { at: 0, tz: "", result: null }; // post landed -> next tick rescans fairness/caps
    logEvent("autopilot_post_counted", { profileId: ready.profileId, postsThisRun: newCount, source: "on_record" });
    const lim = autopilotRunLimit(sNow);
    if (lim > 0 && newCount >= lim) autopilotAutoDisarm("run_limit_reached", `posted ${newCount}/${lim} this run`);
  }
  appendFacebookLivePostLedger({
    event: approvalResult?.ok ? "published_after_admin_approval" : "published",
    key: ledgerKey,
    planId: row.planId,
    sequence: row.sequence,
    profileId: ready.profileId,
    profile: row.profile || "",
    groupUrl,
    actualGroupUrl,
    postUrl,
    status: validation?.warnings?.length ? "published_with_warning" : "published",
    message: approvalResult?.ok
      ? `Post permalink verified after admin approval by ${approvalResult.approvalProfile || approvalResult.profile || approvalResult.profileId}.`
      : "Post permalink verified before comment step.",
    validation,
    liveLogFile: postLiveLogFile || "",
    payloadFile: postPayloadFile || "",
    approvalProfileId: approvalResult?.approvalProfileId || approvalResult?.profileId || "",
    approvalProfile: approvalResult?.approvalProfile || approvalResult?.profile || "",
  });
  logEvent(approvalResult?.ok ? "facebook_live_post_completed_after_admin_approval" : "facebook_live_post_completed", {
    planId: row.planId,
    sequence: row.sequence,
    profileId: ready.profileId,
    groupUrl: actualGroupUrl,
    postUrl,
    approvalProfileId: approvalResult?.approvalProfileId || approvalResult?.profileId || "",
  });
  if (validation?.commentVerified && validation?.commentSubmitted) {
    appendFacebookLivePostLedger({
      event: "same_profile_comment_already_verified_in_publisher_session",
      key: ledgerKey,
      planId: row.planId,
      sequence: row.sequence,
      profileId: ready.profileId,
      profile: row.profile || "",
      groupUrl: actualGroupUrl,
      postUrl,
      status: "published_with_comment",
      message: "Publisher session already submitted and verified the first comment; skipping different-profile recovery.",
      validation,
    });
    logEvent("facebook_live_post_same_profile_comment_verified", {
      planId: row.planId,
      sequence: row.sequence,
      profileId: ready.profileId,
      postUrl,
    });
    return {
      ok: true,
      posted: true,
      postUrl,
      planId: row.planId,
      sequence: row.sequence,
      profileId: ready.profileId,
      profile: row.profile || "",
      groupUrl: actualGroupUrl,
      attemptedGroups,
      closeResults,
      payloadFile: postPayloadFile,
      payloadDeleted: postPayloadDeleted,
      liveLogFile: postLiveLogFile,
      script: postScript,
      message: `Post published by ${row.profile || ready.profileId}; first comment by same profile verified in publisher session.`,
      validation,
      commentProfileId: ready.profileId,
      commentProfile: row.profile || String(ready.profileId),
      approvalResult: approvalResult ? {
        ok: Boolean(approvalResult.ok),
        approvalProfileId: approvalResult.approvalProfileId || approvalResult.profileId || "",
        approvalProfile: approvalResult.approvalProfile || approvalResult.profile || "",
        liveLogFile: approvalResult.liveLogFile || "",
        attemptedApprovalProfiles: approvalResult.attemptedApprovalProfiles || [],
      } : null,
      liveLog: compactLivePostLog(postLogObjects),
      state: readState(),
      registers: readRegisters(),
    };
  }
  // Publisher posted only (includeComment:false); the FIRST COMMENT is always made by a
  // DIFFERENT, random profile with group access (realism). Release the publisher lock and
  // wait for approval propagation here, then fall through to the different-profile comment.
  if (postUrl) {
    const releaseKeyPre = String(Number(ready.profileId));
    // Close the publisher browser BEFORE releasing its busy lock so lock-state == process
    // state. Otherwise the profile reads "free" (lock deleted) while its iX window is still
    // open until the post-finally close, and a concurrent worker that opens/closes the same
    // profile id can tear down an in-use page ("Target page/context/browser has been
    // closed"). The post URL is already captured and the first comment is made by a
    // DIFFERENT profile, so the publisher session is finished here. (The finally-close later
    // becomes a harmless no-op.)
    await ixBrowserCloseAfterUse(ready.profileId, "publisher_close_before_different_profile_comment").catch(() => {});
    if (releaseKeyPre && normalIxProfileUseLocks.has(releaseKeyPre)) {
      normalIxProfileUseLocks.delete(releaseKeyPre);
      logEvent("facebook_live_post_publisher_lock_released_for_different_profile_comment", { profileId: ready.profileId });
    }
    if (approvalResult?.ok) {
      const POST_APPROVAL_PROPAGATION_WAIT_MS_PRE = 45000;
      logEvent("facebook_live_post_waiting_for_fb_approval_propagation", { profileId: ready.profileId, waitMs: POST_APPROVAL_PROPAGATION_WAIT_MS_PRE });
      await sleep(POST_APPROVAL_PROPAGATION_WAIT_MS_PRE);
    }
  }
  if (false && postUrl) { // same-profile comment path DISABLED — comment is made by a different random profile below
    const releaseKey = String(Number(ready.profileId));
    if (releaseKey && normalIxProfileUseLocks.has(releaseKey)) {
      normalIxProfileUseLocks.delete(releaseKey);
      logEvent("facebook_live_post_publisher_lock_released_for_same_profile_comment", { profileId: ready.profileId });
    }
    if (approvalResult?.ok) {
      const POST_APPROVAL_PROPAGATION_WAIT_MS = 45000;
      logEvent("facebook_live_post_waiting_for_fb_approval_propagation", { profileId: ready.profileId, waitMs: POST_APPROVAL_PROPAGATION_WAIT_MS });
      await sleep(POST_APPROVAL_PROPAGATION_WAIT_MS);
    }
    appendFacebookLivePostLedger({
      event: "same_profile_comment_retry_after_post_verified",
      key: ledgerKey,
      planId: row.planId,
      sequence: row.sequence,
      profileId: ready.profileId,
      profile: row.profile || "",
      groupUrl: actualGroupUrl,
      postUrl,
      status: "running",
      message: "Publisher session did not finalize the comment in one shot; retrying first comment with the SAME publisher profile against the verified permalink before any different-profile fallback.",
    });
    const sameProfileRecovery = await recoverFacebookCommentWithProfiles({
      row,
      ready,
      groupUrl: actualGroupUrl,
      postUrl,
      imagePath: ready.imagePath,
      profiles: [{ profileId: ready.profileId, profile: row.profile || String(ready.profileId) }],
      ledgerKey,
      reason: "Same-profile first comment retry on verified permalink (publisher reopens to comment on its own post).",
    });
    if (sameProfileRecovery?.closeResults?.length) closeResults.push(...sameProfileRecovery.closeResults);
    if (sameProfileRecovery?.ok) {
      logEvent("facebook_live_post_completed_same_profile_comment", {
        planId: row.planId,
        sequence: row.sequence,
        profileId: ready.profileId,
        postUrl,
      });
      return {
        ok: true,
        posted: true,
        postUrl,
        planId: row.planId,
        sequence: row.sequence,
        profileId: ready.profileId,
        profile: row.profile || "",
        groupUrl: actualGroupUrl,
        attemptedGroups,
        closeResults,
        payloadFile: postPayloadFile,
        payloadDeleted: postPayloadDeleted,
        liveLogFile: postLiveLogFile,
        script: postScript,
        message: `Post published by ${row.profile || ready.profileId}; first comment added by SAME profile on verified permalink.`,
        validation: sameProfileRecovery.validation || validation,
        commentProfileId: ready.profileId,
        commentProfile: row.profile || String(ready.profileId),
        approvalResult: approvalResult ? {
          ok: Boolean(approvalResult.ok),
          approvalProfileId: approvalResult.approvalProfileId || approvalResult.profileId || "",
          approvalProfile: approvalResult.approvalProfile || approvalResult.profile || "",
          liveLogFile: approvalResult.liveLogFile || "",
          attemptedApprovalProfiles: approvalResult.attemptedApprovalProfiles || [],
        } : null,
        liveLog: sameProfileRecovery.liveLog?.length ? sameProfileRecovery.liveLog : compactLivePostLog(postLogObjects),
        state: readState(),
        registers: readRegisters(),
      };
    }
    appendFacebookLivePostLedger({
      event: "same_profile_comment_retry_failed",
      key: ledgerKey,
      planId: row.planId,
      sequence: row.sequence,
      profileId: ready.profileId,
      profile: row.profile || "",
      groupUrl: actualGroupUrl,
      postUrl,
      status: "comment_recovery_failed",
      message: oneLineField(sameProfileRecovery?.message || "Same-profile comment retry failed; will not fall back to different profile per operator policy.", 400),
      validation: sameProfileRecovery?.validation || null,
    });
    return {
      ok: false,
      posted: true,
      postUrl,
      planId: row.planId,
      sequence: row.sequence,
      profileId: ready.profileId,
      profile: row.profile || "",
      groupUrl: actualGroupUrl,
      attemptedGroups,
      closeResults,
      payloadFile: postPayloadFile,
      payloadDeleted: postPayloadDeleted,
      liveLogFile: postLiveLogFile,
      script: postScript,
      message: `Post published by ${row.profile || ready.profileId} (URL: ${postUrl}); same-profile first comment retry failed. ${sameProfileRecovery?.message || ""}`.trim(),
      validation: sameProfileRecovery?.validation || validation,
      commentProfileId: ready.profileId,
      commentProfile: row.profile || String(ready.profileId),
      approvalResult: approvalResult ? {
        ok: Boolean(approvalResult.ok),
        approvalProfileId: approvalResult.approvalProfileId || approvalResult.profileId || "",
        approvalProfile: approvalResult.approvalProfile || approvalResult.profile || "",
        liveLogFile: approvalResult.liveLogFile || "",
        attemptedApprovalProfiles: approvalResult.attemptedApprovalProfiles || [],
      } : null,
      liveLog: sameProfileRecovery?.liveLog?.length ? sameProfileRecovery.liveLog : compactLivePostLog(postLogObjects),
      state: readState(),
      registers: readRegisters(),
    };
  }
  const commentResult = await addRequiredFirstCommentWithDifferentProfile({
    row,
    ready,
    groupUrl: actualGroupUrl,
    postUrl,
    imagePath: ready.imagePath,
    postValidation: validation,
    ledgerKey,
    closeResults,
  });
  return {
    ...commentResult,
    attemptedGroups,
    closeResults,
    postPayloadFile,
    postPayloadDeleted,
    postLiveLogFile,
    postScript,
    approvalResult: approvalResult ? {
      ok: Boolean(approvalResult.ok),
      approvalProfileId: approvalResult.approvalProfileId || approvalResult.profileId || "",
      approvalProfile: approvalResult.approvalProfile || approvalResult.profile || "",
      liveLogFile: approvalResult.liveLogFile || "",
      attemptedApprovalProfiles: approvalResult.attemptedApprovalProfiles || [],
    } : null,
    message: commentResult.ok
      ? `Post published by ${row.profile || ready.profileId}; ${approvalResult?.ok ? "admin approval verified the permalink; " : ""}${commentResult.message}`
      : commentResult.message,
    liveLog: commentResult.liveLog?.length ? commentResult.liveLog : compactLivePostLog(postLogObjects),
    state: readState(),
    registers: readRegisters(),
  };
}

async function runLiveFacebookPostFromPlan(body = {}) {
  requireExternalArmed();
  const state = readState();
  const rows = latestPostingPlanRows(state);
  const row = selectedPostingPlanRow(rows, body);
  const ready = assertPostingRowReadyForLive(row, body);
  // Mark this as an autopilot RUN post (counts toward operator.autopilotMaxPostsPerRun). Set ONLY for the
  // autopilot tick (body.countTowardRun) — NOT #test (which also passes autopilot:true). The counter is
  // bumped at the RECORD moment in completeVerifiedFacebookPostWithComment, so a landed-then-errored post
  // is still counted exactly once (auto-stop-at-N stays exact).
  if (body.countTowardRun) ready.__autopilotRunPost = true;
  if (body.fullRun) {
    assertProductionScheduleOpen(state);
    // Autopilot posts prepared buffer products that may predate the latest
    // discovery run — skip the freshness/latest-run asserts for it (schedule and
    // not-used-today guards stay). Manual full runs keep all asserts.
    if (!body.autopilot) {
      assertFullPostingPlanHasFreshDiscovery([row], state);
      assertFullPostingPlanUsesLatestDiscoveryProducts([row], state);
    }
    assertProductNotUsedToday(row, state);
  }
  const attemptedGroups = [];
  const groupUrls = [ready.groupUrl, ...sanitizeFacebookGroupUrlList(row.fallbackGroupUrls || [])];
  const uniqueGroups = [];
  const seenGroups = new Set();
  for (const groupUrl of groupUrls) {
    const clean = sanitizeFacebookGroupUrl(groupUrl, { allowBlank: true });
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seenGroups.has(key)) continue;
    seenGroups.add(key);
    uniqueGroups.push(clean);
  }
  const ledgerKey = livePostLedgerKey(row, ready.profileId);
  const priorPublished = latestPublishedFacebookLivePostForRow(row, ready.profileId);
  if (priorPublished?.postUrl) {
    const actualGroupUrl = priorPublished.actualGroupUrl || facebookGroupUrlFromPostUrl(priorPublished.postUrl) || priorPublished.groupUrl || ready.groupUrl;
    const commentText = String(row.commentTextPreview || row.link || "").trim();
    const priorDifferentComment = latestDifferentProfileVerifiedCommentForPost(priorPublished.postUrl, ready.profileId);
    if (!priorDifferentComment && commentText) {
      const closeResults = [];
      const commentResult = await addRequiredFirstCommentWithDifferentProfile({
        row,
        ready,
        groupUrl: actualGroupUrl,
        postUrl: priorPublished.postUrl,
        imagePath: ready.imagePath,
        postValidation: priorPublished.validation || { ok: true, errors: [], warnings: ["local_db_duplicate_publish_prevented"] },
        ledgerKey,
        closeResults,
      });
      return {
        ...commentResult,
        closeResults,
        message: commentResult.ok
          ? `Existing post found; ${commentResult.message}`
          : commentResult.message,
        state: readState(),
        registers: readRegisters(),
      };
    }
    appendFacebookLivePostLedger({
      event: "duplicate_publish_prevented",
      key: ledgerKey,
      planId: row.planId,
      sequence: row.sequence,
      profileId: ready.profileId,
      profile: row.profile || "",
      groupUrl: ready.groupUrl,
      actualGroupUrl,
      postUrl: priorPublished.postUrl,
      status: "published",
      message: "Returned existing local database post URL to prevent duplicate Facebook publish.",
      validation: priorPublished.validation || { ok: true, errors: [], warnings: ["local_db_duplicate_publish_prevented"] },
      commentProfileId: priorDifferentComment?.profileId || "",
      commentProfile: priorDifferentComment?.profile || "",
    });
    return {
      ok: true,
      posted: true,
      postUrl: priorPublished.postUrl,
      planId: row.planId,
      sequence: row.sequence,
      profileId: ready.profileId,
      profile: row.profile || "",
      groupUrl: actualGroupUrl,
      attemptedGroups: [],
      closeResults: [],
      payloadFile: "",
      payloadDeleted: false,
      liveLogFile: priorPublished.liveLogFile || "",
      script: path.relative(ROOT, liveFacebookPostingScriptPath()).replace(/\\/g, "/"),
      message: "Already published in local database; duplicate publish prevented.",
      validation: priorPublished.validation || { ok: true, errors: [], warnings: ["local_db_duplicate_publish_prevented"] },
      commentProfileId: priorDifferentComment?.profileId || "",
      commentProfile: priorDifferentComment?.profile || "",
      liveLog: [],
      state: readState(),
      registers: readRegisters(),
    };
  }
  const priorSubmittedMissing = latestSubmittedUrlMissingFacebookLivePostForRow(row, ready.profileId);
  if (priorSubmittedMissing) {
    const recoveryGroupUrl = priorSubmittedMissing.groupUrl || priorSubmittedMissing.actualGroupUrl || ready.groupUrl;
    const recoveryCloseResults = [];
    const recovered = await recoverSubmittedFacebookPostUrl({
      row,
      ready,
      groupUrl: recoveryGroupUrl,
      ledgerKey,
      reason: "Previous connector run submitted this post but stopped before permalink capture; recovering without reposting.",
      sourceLiveLogFile: priorSubmittedMissing.liveLogFile || "",
      sourcePayloadFile: priorSubmittedMissing.payloadFile || "",
      closeResults: recoveryCloseResults,
    });
    if (recovered?.ok && recovered.postUrl) {
      return await completeVerifiedFacebookPostWithComment({
        row,
        ready,
        groupUrl: recoveryGroupUrl,
        postUrl: recovered.postUrl,
        validation: recovered.validation || { ok: true, errors: [], warnings: ["submitted_url_recovered_from_marker_scan"] },
        ledgerKey,
        attemptedGroups: [recoveryGroupUrl],
        closeResults: recoveryCloseResults,
        postPayloadFile: recovered.payloadFile || "",
        postPayloadDeleted: Boolean(recovered.payloadDeleted),
        postLiveLogFile: recovered.liveLogFile || "",
        postScript: recovered.script || path.relative(ROOT, liveFacebookPostingScriptPath()).replace(/\\/g, "/"),
        postLogObjects: recovered.objects || [],
      });
    }
    const approvalResult = await approvePendingFacebookPostWithAdminProfiles({
      row,
      ready,
      groupUrl: recoveryGroupUrl,
      candidateUrls: facebookPostCandidateUrlsFromLog(recovered?.objects || [], recoveryGroupUrl),
      ledgerKey,
      closeResults: recoveryCloseResults,
      reason: "Publisher marker scan did not recover the submitted post URL; checking admin/moderator pending review by marker before giving up.",
    });
    if (approvalResult?.ok && approvalResult.postUrl) {
      return await completeVerifiedFacebookPostWithComment({
        row,
        ready,
        groupUrl: recoveryGroupUrl,
        postUrl: approvalResult.postUrl,
        validation: approvalResult.validation,
        ledgerKey,
        attemptedGroups: [recoveryGroupUrl],
        closeResults: recoveryCloseResults,
        postPayloadFile: recovered?.payloadFile || "",
        postPayloadDeleted: Boolean(recovered?.payloadDeleted),
        postLiveLogFile: approvalResult.liveLogFile || recovered?.liveLogFile || "",
        postScript: approvalResult.script || recovered?.script || path.relative(ROOT, liveFacebookPostingScriptPath()).replace(/\\/g, "/"),
        postLogObjects: approvalResult.liveLog || recovered?.objects || [],
        approvalResult,
      });
    }
    throw unverifiedFacebookPublishError(
      "Previous Facebook post was not found by marker in feed/search/admin review; no permalink was captured, so the test will retry another eligible profile.",
      recovered?.validation || approvalResult?.validation || { ok: false, errors: ["submitted_url_recovery_failed"], warnings: [] },
      {
        livePostLog: recovered?.objects || recovered?.liveLog || [],
        livePostLogFile: approvalResult?.liveLogFile || recovered?.liveLogFile || priorSubmittedMissing.liveLogFile || "",
        payloadFile: recovered?.payloadFile || priorSubmittedMissing.payloadFile || "",
        payloadDeleted: Boolean(recovered?.payloadDeleted),
      },
    );
  }
  let lastError = null;
  const groupErrors = [];
  const closeResults = [];
  for (const groupUrl of uniqueGroups) {
    attemptedGroups.push(groupUrl);
    // Publisher POSTS ONLY — never comments in its own session. The first comment is always
  // made afterwards by a DIFFERENT, random profile with group access (realism requirement).
  const payload = livePostPayloadForRow(row, groupUrl, ready.imagePath, ready.profileId, { includeComment: false });
    const releaseProfileUse = acquireNormalIxProfileUse(ready.profileId, "facebook_live_post");
    let scriptResult = null;
    try {
      let preOpenClose = null;
      // If warmup pre-opened THIS exact profile recently, reuse it: skip the
      // pre-open close so the connector's profile-open reuses the already-open
      // window (no close/reopen churn). Consume once so retries still get a
      // clean close.
      const warmedReuse = __warmupPostingSlot
        && Number(__warmupPostingSlot.profileId) === Number(ready.profileId)
        && (Date.now() - Number(__warmupPostingSlot.at || 0)) < 10 * 60 * 1000;
      if (warmedReuse) {
        __warmupPostingSlot = null;
        logEvent("facebook_live_post_reusing_warmed_profile", { planId: row.planId, sequence: row.sequence, profileId: ready.profileId, groupUrl });
      } else {
        preOpenClose = await ixBrowserCloseAfterUse(ready.profileId, "facebook_live_post_preopen_cleanup");
        assertIxBrowserPreOpenCleanupOk(preOpenClose, ready.profileId, "facebook_live_post_preopen_cleanup");
        if (preOpenClose?.status === "closed") await sleep(700);
      }
      logEvent("facebook_live_post_started", { planId: row.planId, sequence: row.sequence, profileId: ready.profileId, groupUrl });
      appendFacebookLivePostLedger({
        event: "attempt_started",
        key: ledgerKey,
        planId: row.planId,
        sequence: row.sequence,
        profileId: ready.profileId,
        profile: row.profile || "",
        groupUrl,
        status: "running",
      });
      // Retry a TRANSIENT iX connector/open failure that happened BEFORE any post was made
      // (e.g. the p19 "connector_failed at main_started" case). SAFE against double-posting:
      // retries ONLY when uncertainAfterPostClick is false, postClicked is false, AND no
      // candidate post URL exists — i.e. definitively nothing was published. Never retries a
      // login / account-block / group-access failure.
      //
      // POST-CAPTURE LOCK ("3-by-3 in order"): serialize this publish+capture across concurrent
      // workers so each post is unambiguously the newest in the shared group feed at its own
      // capture moment (no collision/cross-grab). Released in finally the instant capture is
      // done — BEFORE the comment phase, so comments still overlap. logEvent is INSIDE the try
      // so a logEvent throw can never skip release() (the deadlock lesson from the comment lock).
      // POST-CAPTURE LOCK is now OFF by default: with the per-product UNIQUE title marker,
      // every capture path rejects a sibling's post (verifyCandidate requires THIS post's
      // marker on the permalink; the trust-without-reopen paths are gated on row.marker /
      // this profile's own self-page). So serializing is no longer needed — and removing it
      // restores PARALLEL browser-open + prepare + image-wait across the 3 workers. Kept
      // behind operator.serializePostCapture (default off) for instant rollback if ever needed.
      const usePostCaptureLock = readState().operator?.serializePostCapture === true;
      const releasePostCapture = usePostCaptureLock ? await acquirePostCaptureLock() : null;
      try {
        try { if (usePostCaptureLock) logEvent("facebook_live_post_capture_lock_acquired", { planId: row.planId, sequence: row.sequence, profileId: ready.profileId }); } catch {}
        let connTries = 0;
        const maxConnTries = clampNumber(readState().operator?.connectorOpenRetries, 0, 3, 1);
        for (;;) {
          try {
            scriptResult = await runLiveFacebookPostScript(payload);
            break;
          } catch (scriptErr) {
            const m = String((scriptErr && scriptErr.message) || scriptErr || "");
            const noPostMade = !(scriptErr && scriptErr.uncertainAfterPostClick)
              && !(scriptErr && scriptErr.livePostValidation && scriptErr.livePostValidation.postClicked)
              && !(scriptErr && Array.isArray(scriptErr.candidatePostUrls) && scriptErr.candidatePostUrls.length);
            const transientOpen = /connector|could not open|profile[ _].*open|profile-open|cdp|connect|websocket|target (?:page|closed)|has been closed|connection closed|timed out|timeout|server busy|ECONN|socket hang/i.test(m)
              && !/logged out|login|sign ?in|suspend|disabled|locked|checkpoint|account|blocked|group/i.test(m);
            if (connTries < maxConnTries && noPostMade && transientOpen) {
              connTries += 1;
              logEvent("facebook_live_post_connector_retry", { planId: row.planId, sequence: row.sequence, profileId: ready.profileId, attempt: connTries, error: oneLineField(m, 160) });
              await ixBrowserCloseAfterUse(ready.profileId, "connector_retry_cleanup").catch(() => {});
              await sleep(4000);
              continue;
            }
            throw scriptErr;
          }
        }
      } finally {
        if (releasePostCapture) releasePostCapture();
        try { if (usePostCaptureLock) logEvent("facebook_live_post_capture_lock_released", { planId: row.planId, sequence: row.sequence, profileId: ready.profileId, postUrl: (scriptResult && scriptResult.postUrl) || "" }); } catch {}
      }
      const postUrl = scriptResult.postUrl;
      if (postUrl) {
        let validation = scriptResult.validation || livePostLogValidation(scriptResult.objects, payload);
        let finalPostUrl = postUrl;
        let approvalResult = null;
        // SKIP the slow (~6-min) moderator-approval flow when the post is ALREADY verified
        // live/visible. The publisher posts with includeComment:false, so validation.ok is
        // often false on a perfectly-live post (comment_not_submitted), which previously
        // triggered a wasteful approval cycle that even flagged the landed post "failed".
        // A post is CONFIRMED LIVE only when markerPermalinkVerified is true — the connector
        // opened the EXACT public permalink and found our unique marker, which a still-pending
        // (non-visible) post CANNOT satisfy (no public permalink yet). We deliberately do NOT
        // key on the weaker postPermalinkVerified (a pending post can also have a URL string) or
        // on title/media alone (the publisher can self-view its own pending post). Skip approval
        // only when confirmed-live AND the only residual errors are comment-step ones.
        const postConfirmedLive = validation.markerPermalinkVerified === true && (!validation.imageRequired || validation.postMediaVerified === true);
        const liveEnoughToComment = postConfirmedLive && (validation.ok || livePostValidationAllowsCommentProfileFallback(validation));
        if (!validation.ok && !liveEnoughToComment) {
          approvalResult = await approvePendingFacebookPostWithAdminProfiles({
            row,
            ready,
            groupUrl,
            candidateUrls: [postUrl, ...facebookPostCandidateUrlsFromLog(scriptResult.objects, groupUrl)],
            ledgerKey,
            closeResults,
            reason: "A permalink candidate exists but the post is not fully verified; checking whether admin approval is required.",
          });
          if (approvalResult?.ok && approvalResult.postUrl) {
            finalPostUrl = approvalResult.postUrl;
            validation = approvalResult.validation;
          }
        }
        if (!validation.ok && !liveEnoughToComment) {
          const message = `Facebook post URL was captured, but publish verification failed: ${validation.errors.join(", ") || "unknown_verification_error"}.`;
          logEvent("facebook_live_post_verification_failed", {
            planId: row.planId,
            sequence: row.sequence,
            profileId: ready.profileId,
            groupUrl,
            postUrl: finalPostUrl,
            errors: validation.errors,
          });
          return {
            ok: false,
            posted: true,
            postUrl: finalPostUrl,
            planId: row.planId,
            sequence: row.sequence,
            profileId: ready.profileId,
            profile: row.profile || "",
            groupUrl: facebookGroupUrlFromPostUrl(finalPostUrl) || groupUrl,
            attemptedGroups,
            closeResults,
            payloadFile: scriptResult.payloadFile,
            payloadDeleted: scriptResult.payloadDeleted,
            liveLogFile: scriptResult.liveLogFile || "",
            script: scriptResult.script,
            message,
            validation,
            liveLog: compactLivePostLog(scriptResult.objects),
            approvalResult,
            state: readState(),
            registers: readRegisters(),
          };
        }
        return await completeVerifiedFacebookPostWithComment({
          row,
          ready,
          groupUrl,
          postUrl: finalPostUrl,
          validation,
          ledgerKey,
          attemptedGroups,
          closeResults,
          postPayloadFile: scriptResult.payloadFile,
          postPayloadDeleted: scriptResult.payloadDeleted,
          postLiveLogFile: scriptResult.liveLogFile || "",
          postScript: scriptResult.script,
          postLogObjects: scriptResult.objects,
          approvalResult,
        });
      }
      const missingUrlValidation = scriptResult.validation || livePostLogValidation(scriptResult.objects, payload);
      const candidateUrls = facebookPostCandidateUrlsFromLog(scriptResult.objects, groupUrl);
      if (candidateUrls.length) {
        const approvalResult = await approvePendingFacebookPostWithAdminProfiles({
          row,
          ready,
          groupUrl,
          candidateUrls,
          ledgerKey,
          closeResults,
          reason: "Post click produced candidate permalink(s), but Facebook did not expose a verified visible post. Trying admin approval before failing.",
        });
        if (approvalResult?.ok && approvalResult.postUrl) {
          return await completeVerifiedFacebookPostWithComment({
            row,
            ready,
            groupUrl,
            postUrl: approvalResult.postUrl,
            validation: approvalResult.validation,
            ledgerKey,
            attemptedGroups,
            closeResults,
            postPayloadFile: scriptResult.payloadFile,
            postPayloadDeleted: scriptResult.payloadDeleted,
            postLiveLogFile: scriptResult.liveLogFile || "",
            postScript: scriptResult.script,
            postLogObjects: scriptResult.objects,
            approvalResult,
          });
        }
      }
      if (!missingUrlValidation.postMediaVerified) {
        if (missingUrlValidation.postClicked && missingUrlValidation.imageConfirmed) {
          const approvalResult = await approvePendingFacebookPostWithAdminProfiles({
            row,
            ready,
            groupUrl,
            candidateUrls,
            ledgerKey,
            closeResults,
            reason: "Facebook accepted the post click but no verified permalink appeared; checking admin/moderator pending review by marker before trying another profile/group.",
          });
          if (approvalResult?.ok && approvalResult.postUrl) {
            return await completeVerifiedFacebookPostWithComment({
              row,
              ready,
              groupUrl,
              postUrl: approvalResult.postUrl,
              validation: approvalResult.validation,
              ledgerKey,
              attemptedGroups,
              closeResults,
              postPayloadFile: scriptResult.payloadFile,
              postPayloadDeleted: scriptResult.payloadDeleted,
              postLiveLogFile: approvalResult.liveLogFile || scriptResult.liveLogFile || "",
              postScript: approvalResult.script || scriptResult.script,
              postLogObjects: scriptResult.objects,
              approvalResult,
            });
          }
          logEvent("facebook_live_post_uncertain_after_click_stop", {
            planId: row.planId,
            sequence: row.sequence,
            profileId: ready.profileId,
            groupUrl,
            candidateUrls: candidateUrls.slice(0, 5),
            liveLogFile: scriptResult.liveLogFile || "",
          });
          appendFacebookLivePostLedger({
            event: "attempt_uncertain_after_click_stop",
            key: ledgerKey,
            planId: row.planId,
            sequence: row.sequence,
            profileId: ready.profileId,
            profile: row.profile || "",
            groupUrl,
            status: "uncertain_after_post_click",
            message: "Post click completed but Facebook did not expose a verified visible post; stopped to prevent duplicate publishing.",
            validation: missingUrlValidation,
            candidatePostUrls: candidateUrls,
            liveLogFile: scriptResult.liveLogFile || "",
            payloadFile: scriptResult.payloadFile || "",
          });
          throw unverifiedFacebookPublishError(
            "Facebook publish is uncertain after clicking Post; stopped before retrying another profile to prevent duplicate posts.",
            missingUrlValidation,
            {
              livePostLog: scriptResult.objects,
              livePostLogFile: scriptResult.liveLogFile || "",
              candidatePostUrls: candidateUrls,
              uncertainAfterPostClick: true,
              payloadFile: scriptResult.payloadFile || "",
              payloadDeleted: Boolean(scriptResult.payloadDeleted),
            },
          );
        }
        lastError = new Error("Facebook post was not verified after clicking Post; no permalink was captured.");
        groupErrors.push({ groupUrl, error: lastError.message });
        logEvent("facebook_live_post_unverified_no_url_try_next", {
          planId: row.planId,
          sequence: row.sequence,
          profileId: ready.profileId,
          groupUrl,
          liveLogFile: scriptResult.liveLogFile || "",
        });
        appendFacebookLivePostLedger({
          event: "attempt_unverified_no_url_try_next",
          key: ledgerKey,
          planId: row.planId,
          sequence: row.sequence,
          profileId: ready.profileId,
          profile: row.profile || "",
          groupUrl,
          status: "failed_try_next",
          message: lastError.message,
          validation: missingUrlValidation,
          liveLogFile: scriptResult.liveLogFile || "",
          payloadFile: scriptResult.payloadFile || "",
        });
        continue;
      }
      lastError = new Error("Facebook post may have been submitted, but no post URL was captured.");
      lastError.livePostLog = scriptResult.objects;
      const recoveredSubmittedUrl = await recoverSubmittedFacebookPostUrl({
        row,
        ready,
        groupUrl,
        ledgerKey,
        reason: "Post click completed and media was verified, but no permalink was captured; recovering the URL before comment.",
        sourceLiveLogFile: scriptResult.liveLogFile || "",
        sourcePayloadFile: scriptResult.payloadFile || "",
        closeResults,
        profileUseAlreadyAcquired: true,
      });
      if (recoveredSubmittedUrl?.ok && recoveredSubmittedUrl.postUrl) {
        return await completeVerifiedFacebookPostWithComment({
          row,
          ready,
          groupUrl,
          postUrl: recoveredSubmittedUrl.postUrl,
          validation: recoveredSubmittedUrl.validation || { ok: true, errors: [], warnings: ["submitted_url_recovered_from_marker_scan"] },
          ledgerKey,
          attemptedGroups,
          closeResults,
          postPayloadFile: scriptResult.payloadFile || recoveredSubmittedUrl.payloadFile || "",
          postPayloadDeleted: Boolean(scriptResult.payloadDeleted),
          postLiveLogFile: recoveredSubmittedUrl.liveLogFile || scriptResult.liveLogFile || "",
          postScript: recoveredSubmittedUrl.script || scriptResult.script,
          postLogObjects: recoveredSubmittedUrl.objects || scriptResult.objects,
        });
      }
      const approvalResult = await approvePendingFacebookPostWithAdminProfiles({
        row,
        ready,
        groupUrl,
        candidateUrls: facebookPostCandidateUrlsFromLog(recoveredSubmittedUrl?.objects || scriptResult.objects, groupUrl),
        ledgerKey,
        closeResults,
        reason: "Submitted post URL recovery did not find the permalink; checking admin/moderator pending review by marker.",
      });
      if (approvalResult?.ok && approvalResult.postUrl) {
        return await completeVerifiedFacebookPostWithComment({
          row,
          ready,
          groupUrl,
          postUrl: approvalResult.postUrl,
          validation: approvalResult.validation,
          ledgerKey,
          attemptedGroups,
          closeResults,
          postPayloadFile: scriptResult.payloadFile || recoveredSubmittedUrl?.payloadFile || "",
          postPayloadDeleted: Boolean(scriptResult.payloadDeleted),
          postLiveLogFile: approvalResult.liveLogFile || recoveredSubmittedUrl?.liveLogFile || scriptResult.liveLogFile || "",
          postScript: approvalResult.script || recoveredSubmittedUrl?.script || scriptResult.script,
          postLogObjects: recoveredSubmittedUrl?.objects || scriptResult.objects,
          approvalResult,
        });
      }
      appendFacebookLivePostLedger({
        event: "submitted_url_missing",
        key: ledgerKey,
        planId: row.planId,
        sequence: row.sequence,
        profileId: ready.profileId,
        profile: row.profile || "",
        groupUrl,
        status: "submitted_url_missing",
        message: lastError.message,
        validation: scriptResult.validation || livePostLogValidation(scriptResult.objects, payload),
        liveLogFile: scriptResult.liveLogFile || "",
        payloadFile: scriptResult.payloadFile || "",
      });
      throw unverifiedFacebookPublishError(
        "Facebook publish was not verified after post click: no permalink was captured and no matching marker appeared in feed/search/admin review.",
        scriptResult.validation || livePostLogValidation(scriptResult.objects, payload),
        {
          livePostLog: scriptResult.objects,
          livePostLogFile: scriptResult.liveLogFile || "",
          payloadFile: scriptResult.payloadFile || "",
          payloadDeleted: Boolean(scriptResult.payloadDeleted),
        },
      );
    } catch (err) {
      lastError = err;
      const errorMessage = oneLineField(err.message || String(err), 300);
      groupErrors.push({ groupUrl, error: errorMessage });
      if (err.uncertainAfterPostClick) {
        appendFacebookLivePostLedger({
          event: "attempt_uncertain_after_click_no_extra_recovery",
          key: ledgerKey,
          planId: row.planId,
          sequence: row.sequence,
          profileId: ready.profileId,
          profile: row.profile || "",
          groupUrl,
          status: "uncertain_after_post_click",
          message: "Post click completed and candidate permalink was captured; stopped immediately to prevent duplicate posting and recovery loops.",
          validation: err.livePostValidation || null,
          candidatePostUrls: Array.isArray(err.candidatePostUrls) ? err.candidatePostUrls : [],
          liveLogFile: err.livePostLogFile || "",
          payloadFile: err.payloadFile || "",
        });
        throw err;
      }
      const liveObjects = err.livePostLog || [];
      const postUrl = firstFacebookPostUrlFromLog(liveObjects);
      // PAGE/ACCOUNT HARD BLOCK mid-publish (e.g. "Confirm your identity before you can publish as
      // this Page"): the connector logs post_clicked THEN throws, so without this the submitted-post
      // recovery branch below swallows it into a generic "unverified publish" error and the profile
      // is NEVER blacklisted (re-picked every tick). If no permalink was captured, quarantine HERE.
      if (!postUrl && isFacebookAccountHardBlockedFailure(err.message || "", err.livePostValidation, liveObjects)) {
        recordFacebookAccountHardBlock({
          profile: row.profile || ready.profileId,
          profileId: ready.profileId,
          groupUrl,
          reason: oneLineField(err.message || err.livePostValidation?.facebookAccountBlockReason || "Facebook account/page is blocked or requires identity confirmation before publishing.", 200),
          source: "facebook_live_post_post_submit_block",
        });
        logEvent("facebook_live_post_account_blocked_try_next_profile", { planId: row.planId, sequence: row.sequence, profileId: ready.profileId, groupUrl, error: oneLineField(err.message || "", 180) });
        const blockErr = new Error(`facebook_account_suspended_or_disabled: ${oneLineField(err.message || "account hard block", 180)}`);
        blockErr.livePostValidation = err.livePostValidation || { ok: false, errors: ["facebook_account_status_blocked"], facebookAccountBlocked: true };
        throw blockErr;
      }
      if (postUrl || livePostLogShowsSubmittedPost(liveObjects)) {
        const validation = err.livePostValidation || livePostLogValidation(liveObjects, payload);
        if (postUrl) {
          let finalPostUrl = postUrl;
          let finalValidation = validation;
          let approvalResult = null;
          if (!finalValidation.ok) {
            approvalResult = await approvePendingFacebookPostWithAdminProfiles({
              row,
              ready,
              groupUrl,
              candidateUrls: [postUrl, ...facebookPostCandidateUrlsFromLog(liveObjects, groupUrl)],
              ledgerKey,
              closeResults,
              reason: "A connector error happened after a candidate permalink was seen; checking whether admin approval is required.",
            });
            if (approvalResult?.ok && approvalResult.postUrl) {
              finalPostUrl = approvalResult.postUrl;
              finalValidation = approvalResult.validation;
            }
          }
          if (!finalValidation.ok) {
            const message = `Facebook post URL was captured after a connector error, but publish verification failed: ${finalValidation.errors.join(", ") || "unknown_verification_error"}.`;
            logEvent("facebook_live_post_verification_failed_after_connector_error", {
              planId: row.planId,
              sequence: row.sequence,
              profileId: ready.profileId,
              groupUrl,
              postUrl: finalPostUrl,
              errors: finalValidation.errors,
            });
            return {
              ok: false,
              posted: true,
              postUrl: finalPostUrl,
              planId: row.planId,
              sequence: row.sequence,
              profileId: ready.profileId,
              profile: row.profile || "",
              groupUrl: facebookGroupUrlFromPostUrl(finalPostUrl) || groupUrl,
              attemptedGroups,
              closeResults,
              payloadFile: err.payloadFile || "",
              payloadDeleted: Boolean(err.payloadDeleted),
              liveLogFile: err.livePostLogFile || "",
              script: path.relative(ROOT, liveFacebookPostingScriptPath()).replace(/\\/g, "/"),
              message,
              validation: finalValidation,
              liveLog: compactLivePostLog(liveObjects),
              approvalResult,
              state: readState(),
              registers: readRegisters(),
            };
          }
          return await completeVerifiedFacebookPostWithComment({
            row,
            ready,
            groupUrl,
            postUrl: finalPostUrl,
            validation: finalValidation,
            ledgerKey,
            attemptedGroups,
            closeResults,
            postPayloadFile: err.payloadFile || "",
            postPayloadDeleted: Boolean(err.payloadDeleted),
            postLiveLogFile: err.livePostLogFile || "",
            postScript: path.relative(ROOT, liveFacebookPostingScriptPath()).replace(/\\/g, "/"),
            postLogObjects: liveObjects,
            approvalResult,
          });
        }
        const candidateUrls = [...new Set([
          ...facebookPostCandidateUrlsFromLog(liveObjects, groupUrl),
          ...(Array.isArray(err.candidatePostUrls) ? err.candidatePostUrls : []),
        ])];
        if (candidateUrls.length) {
          const approvalResult = await approvePendingFacebookPostWithAdminProfiles({
            row,
            ready,
            groupUrl,
            candidateUrls,
            ledgerKey,
            closeResults,
            reason: "The connector saw submitted-post network activity without a verified URL; trying admin approval before failing.",
          });
          if (approvalResult?.ok && approvalResult.postUrl) {
            return await completeVerifiedFacebookPostWithComment({
              row,
              ready,
              groupUrl,
              postUrl: approvalResult.postUrl,
              validation: approvalResult.validation,
              ledgerKey,
              attemptedGroups,
              closeResults,
              postPayloadFile: err.payloadFile || "",
              postPayloadDeleted: Boolean(err.payloadDeleted),
              postLiveLogFile: err.livePostLogFile || "",
              postScript: path.relative(ROOT, liveFacebookPostingScriptPath()).replace(/\\/g, "/"),
              postLogObjects: liveObjects,
              approvalResult,
            });
          }
        }
        const recoveredSubmittedUrl = await recoverSubmittedFacebookPostUrl({
          row,
          ready,
          groupUrl,
          ledgerKey,
          reason: "Connector saw the post submit, then failed before permalink capture; recovering the URL before comment.",
          sourceLiveLogFile: err.livePostLogFile || "",
          sourcePayloadFile: err.payloadFile || "",
          closeResults,
          profileUseAlreadyAcquired: true,
        });
        if (recoveredSubmittedUrl?.ok && recoveredSubmittedUrl.postUrl) {
          return await completeVerifiedFacebookPostWithComment({
            row,
            ready,
            groupUrl,
            postUrl: recoveredSubmittedUrl.postUrl,
            validation: recoveredSubmittedUrl.validation || { ok: true, errors: [], warnings: ["submitted_url_recovered_from_marker_scan"] },
            ledgerKey,
            attemptedGroups,
            closeResults,
            postPayloadFile: err.payloadFile || recoveredSubmittedUrl.payloadFile || "",
            postPayloadDeleted: Boolean(err.payloadDeleted),
            postLiveLogFile: recoveredSubmittedUrl.liveLogFile || err.livePostLogFile || "",
            postScript: recoveredSubmittedUrl.script || path.relative(ROOT, liveFacebookPostingScriptPath()).replace(/\\/g, "/"),
            postLogObjects: recoveredSubmittedUrl.objects || liveObjects,
          });
        }
        const markerApprovalResult = await approvePendingFacebookPostWithAdminProfiles({
          row,
          ready,
          groupUrl,
          candidateUrls: [...new Set([
            ...facebookPostCandidateUrlsFromLog(recoveredSubmittedUrl?.objects || liveObjects, groupUrl),
            ...(Array.isArray(err.candidatePostUrls) ? err.candidatePostUrls : []),
          ])],
          ledgerKey,
          closeResults,
          reason: "Connector failed after post submit and marker scan did not recover the permalink; checking admin/moderator pending review by marker.",
        });
        if (markerApprovalResult?.ok && markerApprovalResult.postUrl) {
          return await completeVerifiedFacebookPostWithComment({
            row,
            ready,
            groupUrl,
            postUrl: markerApprovalResult.postUrl,
            validation: markerApprovalResult.validation,
            ledgerKey,
            attemptedGroups,
            closeResults,
            postPayloadFile: err.payloadFile || recoveredSubmittedUrl?.payloadFile || "",
            postPayloadDeleted: Boolean(err.payloadDeleted),
            postLiveLogFile: markerApprovalResult.liveLogFile || recoveredSubmittedUrl?.liveLogFile || err.livePostLogFile || "",
            postScript: markerApprovalResult.script || recoveredSubmittedUrl?.script || path.relative(ROOT, liveFacebookPostingScriptPath()).replace(/\\/g, "/"),
            postLogObjects: recoveredSubmittedUrl?.objects || liveObjects,
            approvalResult: markerApprovalResult,
          });
        }
        logEvent("facebook_live_post_partial_no_fallback", { planId: row.planId, sequence: row.sequence, profileId: ready.profileId, groupUrl, error: oneLineField(err.message || String(err), 300) });
        appendFacebookLivePostLedger({
          event: "submitted_url_missing_after_connector_error",
          key: ledgerKey,
          planId: row.planId,
          sequence: row.sequence,
          profileId: ready.profileId,
          profile: row.profile || "",
          groupUrl,
          status: "submitted_url_missing",
          message: "Post submitted but URL not captured; no fallback attempted to prevent duplicate posting.",
          validation: err.livePostValidation || livePostLogValidation(liveObjects, payload),
          liveLogFile: err.livePostLogFile || "",
          payloadFile: err.payloadFile || "",
        });
        throw unverifiedFacebookPublishError(
          "Facebook connector clicked Post but no permalink/marker was verified after feed/search/admin review; stopped before retrying another profile to prevent duplicate posts.",
          err.livePostValidation || livePostLogValidation(liveObjects, payload),
          {
            livePostLog: liveObjects,
            livePostLogFile: err.livePostLogFile || markerApprovalResult?.liveLogFile || "",
            candidatePostUrls: [...new Set([
              ...facebookPostCandidateUrlsFromLog(recoveredSubmittedUrl?.objects || liveObjects, groupUrl),
              ...(Array.isArray(err.candidatePostUrls) ? err.candidatePostUrls : []),
            ])],
            uncertainAfterPostClick: true,
            payloadFile: err.payloadFile || "",
            payloadDeleted: Boolean(err.payloadDeleted),
          },
        );
      }
      const failureValidation = err.livePostValidation || (liveObjects.length ? livePostLogValidation(liveObjects, payload) : null);
      if (isFacebookAccountHardBlockedFailure(errorMessage, failureValidation, liveObjects)) {
        recordFacebookAccountHardBlock({
          profile: row.profile || ready.profileId,
          profileId: ready.profileId,
          groupUrl,
          reason: errorMessage || failureValidation?.facebookAccountBlockReason || "Facebook account is suspended, disabled, locked, or requires review.",
          source: "facebook_live_post",
        });
        logEvent("facebook_live_post_account_blocked_try_next_profile", {
          planId: row.planId,
          sequence: row.sequence,
          profileId: ready.profileId,
          groupUrl,
          error: errorMessage,
        });
        appendFacebookLivePostLedger({
          event: "profile_account_blocked_try_next_profile",
          key: ledgerKey,
          planId: row.planId,
          sequence: row.sequence,
          profileId: ready.profileId,
          profile: row.profile || "",
          groupUrl,
          status: "profile_quarantined_try_next",
          message: errorMessage,
          validation: failureValidation,
          liveLogFile: err.livePostLogFile || "",
          payloadFile: err.payloadFile || "",
        });
        const profileError = new Error(`Facebook account for profile ${row.profile || ready.profileId} is blocked: ${errorMessage}. Skipping this IXBrowser profile for Facebook and retrying another eligible profile.`);
        profileError.statusCode = err.statusCode || 502;
        profileError.publicError = "facebook_account_suspended_or_disabled";
        profileError.profileRetryable = true;
        profileError.profileId = ready.profileId;
        profileError.profile = row.profile || "";
        profileError.livePostLog = liveObjects;
        profileError.livePostValidation = failureValidation;
        profileError.livePostLogFile = err.livePostLogFile || "";
        throw profileError;
      }
      if (isFacebookProfileOpenOrLoginFailure(errorMessage)) {
        recordPostingProfileGroupIssue({
          profile: row.profile || ready.profileId,
          profileId: ready.profileId,
          groupUrl,
          attemptedGroupUrls: attemptedGroups,
          reason: errorMessage || "IXBrowser/Facebook profile could not be opened or is logged out.",
          skipProfile: true,
        });
        logEvent("facebook_live_post_profile_failed_try_next_profile", {
          planId: row.planId,
          sequence: row.sequence,
          profileId: ready.profileId,
          groupUrl,
          error: errorMessage,
        });
        appendFacebookLivePostLedger({
          event: "profile_attempt_failed_try_next_profile",
          key: ledgerKey,
          planId: row.planId,
          sequence: row.sequence,
          profileId: ready.profileId,
          profile: row.profile || "",
          groupUrl,
          status: "profile_failed_try_next",
          message: errorMessage,
          validation: err.livePostValidation || (liveObjects.length ? livePostLogValidation(liveObjects, payload) : null),
          liveLogFile: err.livePostLogFile || "",
          payloadFile: err.payloadFile || "",
        });
        const profileError = new Error(`Facebook profile ${row.profile || ready.profileId} failed before posting: ${errorMessage}. Retrying another eligible profile.`);
        profileError.statusCode = err.statusCode || 502;
        profileError.publicError = "facebook_profile_open_or_login_failure";
        profileError.profileRetryable = true;
        profileError.profileId = ready.profileId;
        profileError.profile = row.profile || "";
        profileError.livePostLog = liveObjects;
        profileError.livePostValidation = err.livePostValidation || (liveObjects.length ? livePostLogValidation(liveObjects, payload) : null);
        profileError.livePostLogFile = err.livePostLogFile || "";
        throw profileError;
      }
      if (isNonFallbackFacebookPublishFailure(errorMessage) || !isFacebookGroupAccessPublishFailure(errorMessage)) {
        logEvent("facebook_live_post_connector_failed_no_fallback", {
          planId: row.planId,
          sequence: row.sequence,
          profileId: ready.profileId,
          groupUrl,
          error: errorMessage,
        });
        appendFacebookLivePostLedger({
          event: "attempt_failed_no_fallback",
          key: ledgerKey,
          planId: row.planId,
          sequence: row.sequence,
          profileId: ready.profileId,
          profile: row.profile || "",
          groupUrl,
          status: "failed_no_fallback",
          message: errorMessage,
          validation: err.livePostValidation || (liveObjects.length ? livePostLogValidation(liveObjects, payload) : null),
          liveLogFile: err.livePostLogFile || "",
          payloadFile: err.payloadFile || "",
        });
        const connectorError = new Error(errorMessage || "Facebook live post connector failed before publish.");
        connectorError.statusCode = err.statusCode || 502;
        connectorError.livePostLog = liveObjects;
        connectorError.livePostValidation = err.livePostValidation || (liveObjects.length ? livePostLogValidation(liveObjects, payload) : null);
        connectorError.livePostLogFile = err.livePostLogFile || "";
        throw connectorError;
      }
      recordPostingProfileGroupIssue({
        profile: row.profile || ready.profileId,
        profileId: ready.profileId,
        groupUrl,
        attemptedGroupUrls: attemptedGroups,
        reason: err.message || "Facebook live post connector could not post in this group.",
        skipProfile: false,
      });
      logEvent("facebook_live_post_group_failed", {
        planId: row.planId,
        sequence: row.sequence,
        profileId: ready.profileId,
        groupUrl,
        error: oneLineField(err.message || String(err), 300),
      });
      appendFacebookLivePostLedger({
        event: "group_attempt_failed",
        key: ledgerKey,
        planId: row.planId,
        sequence: row.sequence,
        profileId: ready.profileId,
        profile: row.profile || "",
        groupUrl,
        status: "group_failed_try_next",
        message: errorMessage,
        validation: err.livePostValidation || (liveObjects.length ? livePostLogValidation(liveObjects, payload) : null),
        liveLogFile: err.livePostLogFile || "",
        payloadFile: err.payloadFile || "",
      });
    } finally {
      const closeResult = await ixBrowserCloseAfterUse(ready.profileId, "facebook_live_post_attempt_finished");
      closeResults.push(closeResult);
      appendFacebookLivePostLedger({
        event: "browser_closed_after_attempt",
        key: ledgerKey,
        planId: row.planId,
        sequence: row.sequence,
        profileId: ready.profileId,
        profile: row.profile || "",
        groupUrl,
        status: closeResult?.ok ? "closed" : "close_failed",
        closeResult,
      });
      releaseProfileUse();
    }
  }
  // A GROUP that won't render is a GROUP problem, not a profile-health problem. If
  // EVERY group attempt failed purely because the group page would not render
  // ("content isn't available" / our bounded group-render recovery gave up), do NOT
  // bench the (healthy) profile — otherwise a broken / wrong / private group would
  // burn the entire profile pool one profile per tick. We still record a non-blocking
  // diagnostic for visibility and keep the profile eligible.
  const allGroupRenderUnavailable = groupErrors.length > 0
    ? groupErrors.every((item) => isFacebookGroupRenderUnavailableFailure(item.error || ""))
    : isFacebookGroupRenderUnavailableFailure(lastError?.message || "");
  // Membership failure = account isn't in the group: a GROUP/CONFIG issue, not profile health.
  const allMembershipFailure = groupErrors.length > 0
    ? groupErrors.every((item) => isFacebookGroupMembershipFailure(item.error || ""))
    : isFacebookGroupMembershipFailure(lastError?.message || "");
  const dontBenchProfile = allGroupRenderUnavailable || allMembershipFailure;
  recordPostingProfileGroupIssue({
    profile: row.profile || ready.profileId,
    profileId: ready.profileId,
    groupUrl: ready.groupUrl,
    attemptedGroupUrls: attemptedGroups,
    reason: lastError?.message || "No configured Facebook group accepted this profile for posting.",
    skipProfile: !dontBenchProfile, // never bench on a group-render OR membership problem
  });
  if (allMembershipFailure) {
    logEvent("posting_profile_not_a_member_of_group", {
      profileId: ready.profileId,
      profile: row.profile || "",
      groupUrl: ready.groupUrl,
      attempts: groupErrors.length,
      message: "Account is NOT a member of this group — add it on Facebook OR assign it a group it already belongs to. Profile NOT benched.",
    });
  } else if (allGroupRenderUnavailable) {
    logEvent("posting_group_render_unavailable_profile_not_benched", {
      profileId: ready.profileId,
      profile: row.profile || "",
      groupUrl: ready.groupUrl,
      attempts: groupErrors.length,
      reason: oneLineField(lastError?.message || "", 160),
    });
  }
  const groupErrorSummary = groupErrors.length
    ? groupErrors.map((item, index) => `attempt ${index + 1} ${item.groupUrl}: ${item.error}`).join("; ")
    : "";
  appendFacebookLivePostLedger({
    event: "all_groups_failed",
    key: ledgerKey,
    planId: row.planId,
    sequence: row.sequence,
    profileId: ready.profileId,
    profile: row.profile || "",
    groupUrl: ready.groupUrl,
    status: "failed",
    message: groupErrorSummary || lastError?.message || "No configured Facebook group accepted this profile for posting.",
  });
  const err = new Error(groupErrorSummary ? `Facebook live post failed in every configured group: ${groupErrorSummary}` : (lastError?.message || "Facebook live post failed in every configured group."));
  err.statusCode = lastError?.statusCode || 502;
  // PRESERVE the profile-health signal: this wrapper message hides the original reason (e.g.
  // "IXBrowser profile-open error 2007: Profile does not exist"), and after truncation the
  // auto-blacklist classifier can't see it. Carry the retryable flag + the fuller original reason
  // so a broken/deleted profile still gets benched (otherwise least-used fairness re-picks it forever).
  err.profileRetryable = Boolean(lastError && lastError.profileRetryable) || isFacebookProfileOpenOrLoginFailure(lastError?.message || "");
  err.profileFailureReason = oneLineField((lastError && lastError.message) || "", 240);
  if (lastError?.uncertainAfterPostClick) {
    err.publicError = "facebook_publish_uncertain_after_post_click";
    err.uncertainAfterPostClick = true;
    err.livePostValidation = lastError.livePostValidation || null;
    err.livePostLog = lastError.livePostLog || [];
    err.livePostLogFile = lastError.livePostLogFile || "";
    err.candidatePostUrls = Array.isArray(lastError.candidatePostUrls) ? lastError.candidatePostUrls : [];
  }
  throw err;
}

function isRetryableOnePostProfileGroupFailure(err) {
  const message = String(err?.message || err || "");
  if (err?.uncertainAfterPostClick || /uncertain after clicking post|clicked post|no permalink|candidate permalink|prevent duplicate|not verified after clicking post/i.test(message)) {
    return false;
  }
  return Boolean(err?.profileRetryable)
    || isFacebookProfileOpenOrLoginFailure(message)
    || /failed in every configured group|could not open composer|not allowed to post|cannot post|not a member|join group|content isn't available|content is not available/i.test(message);
}

async function runLiveFacebookOnePostTestWithFallback(body = {}) {
  // PREFLIGHT: confirm iX desktop is reachable and logged in BEFORE we start
  // burning time on per-profile attempts. If iX is down or logged out we want
  // to fail fast with a clear "open iX browser and log in" message instead of
  // triggering 60s recovery waits per profile attempt.
  try {
    await ixBrowserPreflightCheck();
  } catch (err) {
    err.statusCode = err.statusCode || 503;
    throw err;
  }
  const maxAttempts = clampNumber(body.maxProfileGroupAttempts || body.max_profile_group_attempts || 5, 1, 10, 5);
  const attempts = [];
  const failedProfileIds = excludedProfileIdSetFromOptions(body);
  let attemptBody = { ...body, fullRun: false, operatorApprovedLive: true };
  let lastError = null;
  const lockState = readState();
  let lockedProductUrl = "";
  let lockedProductKey = "";
  try {
    const initialRow = selectedPostingPlanRow(latestPostingPlanRows(lockState), attemptBody);
    lockedProductUrl = String(initialRow?.productUrl || "").trim();
    lockedProductKey = String(initialRow?.productKey || canonicalProduct(lockedProductUrl, lockState)?.key || "").trim();
  } catch (_) {}
  if (!lockedProductUrl) {
    lockedProductUrl = [
      ...(Array.isArray(body.productUrls) ? body.productUrls : []),
      ...(Array.isArray(body.product_urls) ? body.product_urls : []),
    ].map((value) => String(value || "").trim()).filter(Boolean)[0] || "";
    lockedProductKey = String(canonicalProduct(lockedProductUrl, lockState)?.key || "").trim();
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await runLiveFacebookPostFromPlan(attemptBody);
      result.profileGroupAttempts = attempts;
      result.profileGroupAttemptCount = attempts.length + 1;
      return result;
    } catch (err) {
      lastError = err;
      let failedRow = null;
      try {
        failedRow = selectedPostingPlanRow(latestPostingPlanRows(readState()), attemptBody);
      } catch (_) {}
      const failedProfileId = Number(
        failedRow?.profileId ||
        profileIdFromLabel(failedRow?.profile) ||
        0
      );
      if (failedProfileId) {
        failedProfileIds.add(failedProfileId);
        // Bench a broken/deleted profile here too (single-post test path), same as the autopilot +
        // parallel paths — so e.g. "profile does not exist" gets blacklisted everywhere.
        autoBlacklistProfileIfNeeded({ profileId: failedProfileId, profile: failedRow?.profile || String(failedProfileId), ok: false, postUrl: "", errorText: oneLineField((err && (err.profileFailureReason || err.message)) || String(err), 240), profileRetryable: !!(err && err.profileRetryable), source: "single_post_test" });
      }
      attempts.push({
        attempt,
        planId: attemptBody.planId || attemptBody.plan_id || "",
        sequence: attemptBody.sequence || attemptBody.seq || 0,
        profileId: failedProfileId || "",
        profile: failedRow?.profile || "",
        error: oneLineField(err.message || String(err), 500),
        retryable: isRetryableOnePostProfileGroupFailure(err),
      });
      if (!isRetryableOnePostProfileGroupFailure(err) || attempt >= maxAttempts) break;
      const retryState = readState();
      const previousRows = latestPostingPlanRows(retryState);
      let previousRow = null;
      try {
        previousRow = selectedPostingPlanRow(previousRows, attemptBody);
      } catch (_) {
        previousRow = previousRows.find((row) => row.runType === "one_post_test") || null;
      }
      const retryProductUrls = [
        lockedProductUrl,
        previousRow?.productUrl,
        ...(Array.isArray(body.productUrls) ? body.productUrls : []),
        ...(Array.isArray(body.product_urls) ? body.product_urls : []),
      ].map((value) => String(value || "").trim()).filter(Boolean);
      const prepared = await preparePostingPlanWithFallbackProfiles({
        limit: 1,
        testPost: true,
        excludeProfileIds: [...failedProfileIds],
        ...(retryProductUrls.length ? { productUrls: [...new Set(retryProductUrls)] } : {}),
      });
      const nextRow = prepared.sample?.[0];
      if (!nextRow) break;
      const nextProfileId = Number(nextRow.profileId || profileIdFromLabel(nextRow.profile) || 0);
      if (nextProfileId && failedProfileIds.has(nextProfileId)) {
        const noAlternate = new Error(`Profile/group retry planner selected failed profile ${nextRow.profile}; no alternate eligible posting profile was available for ${nextRow.groupUrl || previousRow?.groupUrl || "the selected group"}.`);
        noAlternate.statusCode = 409;
        throw noAlternate;
      }
      const previousProductKey = previousRow?.productKey || canonicalProduct(previousRow?.productUrl || "", retryState)?.key || "";
      const nextProductKey = nextRow.productKey || canonicalProduct(nextRow.productUrl || "", retryState)?.key || "";
      const referenceProductKey = lockedProductKey || previousProductKey;
      if (referenceProductKey && nextProductKey && referenceProductKey.toLowerCase() !== nextProductKey.toLowerCase()) {
        const mismatch = new Error(`Profile/group retry changed product from ${lockedProductUrl || previousRow?.productUrl || "(unknown)"} to ${nextRow.productUrl}; refusing to publish the wrong product.`);
        mismatch.statusCode = 409;
        throw mismatch;
      }
      attemptBody = {
        ...body,
        fullRun: false,
        planId: prepared.planId,
        sequence: nextRow.sequence,
        operatorApprovedLive: true,
      };
      logEvent("facebook_live_test_retry_next_profile_group", {
        attempt: attempt + 1,
        previousError: oneLineField(err.message || String(err), 300),
        planId: prepared.planId,
        sequence: nextRow.sequence,
        profileId: Number(nextRow.profileId || 0),
        groupUrl: nextRow.groupUrl || "",
      });
    }
  }
  const finalError = new Error(
    attempts.length
      ? `Facebook 1-post test failed after ${attempts.length} profile/group attempt(s): ${attempts.map((item) => item.error).join("; ")}`
      : (lastError?.message || "Facebook 1-post test failed.")
  );
  finalError.statusCode = lastError?.statusCode || 502;
  finalError.profileGroupAttempts = attempts;
  finalError.publicError = lastError?.publicError || "";
  finalError.uncertainAfterPostClick = Boolean(lastError?.uncertainAfterPostClick);
  finalError.livePostValidation = lastError?.livePostValidation || null;
  finalError.livePostLog = lastError?.livePostLog || [];
  finalError.livePostLogFile = lastError?.livePostLogFile || "";
  finalError.candidatePostUrls = Array.isArray(lastError?.candidatePostUrls) ? lastError.candidatePostUrls : [];
  throw finalError;
}

async function runFacebookFirstCommentRecoveryFromPostUrl(body = {}) {
  requireExternalArmed();
  assertLiveRunConfirmation(body, LIVE_TEST_CONFIRMATION, "first-comment recovery");
  const postUrl = sanitizeFacebookPostUrl(body.postUrl || body.post_url || body.url);
  const rows = latestPostingPlanRows();
  const row = selectedPostingPlanRow(rows, body);
  const ready = assertPostingRowReadyForLive(row, body);
  const groupUrl = facebookGroupUrlFromPostUrl(postUrl) || ready.groupUrl;
  const ledgerKey = livePostLedgerKey(row, ready.profileId);
  const closeResults = [];
  const validation = {
    ok: true,
    errors: [],
    warnings: ["manual_first_comment_recovery"],
    postClicked: true,
    imageRequired: false,
    imageConfirmed: true,
    postMediaVerified: true,
    postPermalinkVerified: true,
    commentRequired: true,
  };
  const result = await addRequiredFirstCommentWithDifferentProfile({
    row,
    ready,
    groupUrl,
    postUrl,
    imagePath: ready.imagePath,
    postValidation: validation,
    ledgerKey,
    closeResults,
  });
  const response = {
    ...result,
    posted: true,
    postUrl,
    planId: row.planId,
    sequence: row.sequence,
    profileId: ready.profileId,
    profile: row.profile || ready.profileId,
    groupUrl,
    closeResults: result.closeResults || closeResults,
  };
  if (response.ok) {
    recordPublishedFacebookPostUrl({
      postUrl,
      row,
      planId: row.planId,
      sequence: row.sequence,
      profile: row.profile || ready.profileId,
      groupUrl,
    });
  }
  const nextState = persistLiveTestResult(response);
  return {
    ...response,
    state: nextState,
    registers: readRegisters(),
  };
}

async function runLiveFacebookFullPostingPlan(body = {}) {
  requireExternalArmed();
  // Sync roster + blacklist with the live iX profile-list before the run picks profiles, so a
  // deleted profile is never attempted and a stale automation bench is cleared. FAIL-CLOSED +
  // debounced internally; never throws into the run.
  try { await reconcileProfilesWithIxBrowser({ force: true }); } catch (_e) { /* reconcile never blocks a run */ }
  const state = readState();
  assertProductionApprovalGateEnabled(state);
  assertLiveRunConfirmation(body, LIVE_FULL_CONFIRMATION, "full production posting run");
  assertProductionScheduleOpen(state);
  const planId = oneLineField(body.planId || body.plan_id || "", 140);
  const allRows = latestPostingPlanRows(state)
    .filter((row) => row.runType === "full_posting_plan")
    .filter((row) => !planId || row.planId === planId);
  const rows = allRows.filter((row) => String(row.liveExecution || "").startsWith("ready"));
  if (!rows.length) {
    const err = new Error(planId ? "No ready full posting-plan rows were found for that plan." : "No ready full posting-plan rows are available. Prepare the full posting plan first.");
    err.statusCode = 404;
    throw err;
  }
  assertFullPostingPlanRowsApproved(rows, state);
  assertFullPostingPlanHasFreshDiscovery(rows, state);
  assertFullPostingPlanUsesLatestDiscoveryProducts(rows, state);
  const maxConcurrentProfiles = clampNumber(
    body.maxConcurrentProfiles || body.max_concurrent_profiles || state.ixbrowser?.maxConcurrentProfiles,
    1,
    MAX_CONCURRENT_NORMAL_IX_PROFILES,
    MAX_CONCURRENT_NORMAL_IX_PROFILES,
  );
  const results = [];
  const batches = livePostingBatchesByUniqueProfile(rows, maxConcurrentProfiles);
  const failedProfileIds = new Set();
  for (let index = 0; index < batches.length; index += 1) {
    assertProductionScheduleOpen(readState());
    const batch = batches[index];
    const batchResults = await Promise.all(batch.map(async (row) => {
      const rowProfileId = Number(row.profileId || profileIdFromLabel(row.profile) || 0);
      if (rowProfileId && failedProfileIds.has(rowProfileId)) {
        return {
          ok: false,
          posted: false,
          skipped: true,
          profileFailure: true,
          planId: row.planId,
          sequence: row.sequence,
          profile: row.profile || "",
          profileId: rowProfileId,
          groupUrl: row.groupUrl || "",
          message: "Skipped because this IXBrowser profile already failed earlier in the same live run.",
          statusCode: 409,
        };
      }
      try {
        return await runLiveFacebookPostFromPlan({
          ...body,
          fullRun: true,
          planId: row.planId,
          sequence: row.sequence,
        });
      } catch (err) {
        const profileFailure = Boolean(err?.profileRetryable) || isFacebookProfileOpenOrLoginFailure(err?.message || err);
        if (profileFailure && rowProfileId) failedProfileIds.add(rowProfileId);
        return {
          ok: false,
          posted: false,
          profileFailure,
          planId: row.planId,
          sequence: row.sequence,
          profile: row.profile || "",
          profileId: rowProfileId || row.profileId || "",
          groupUrl: row.groupUrl || "",
          message: oneLineField(err.message || String(err), 700),
          statusCode: err.statusCode || 500,
        };
      }
    }));
    results.push(...batchResults);
    logEvent("facebook_live_full_batch_finished", {
      planId: planId || rows[0]?.planId || "",
      batch: index + 1,
      count: batch.length,
      posted: batchResults.filter((result) => result.posted).length,
      failed: batchResults.filter((result) => !result.ok).length,
    });
    if (body.stopOnError && batchResults.some((result) => !result.ok)) break;
  }
  const posted = results.filter((result) => result.posted).length;
  const captured = results.filter((result) => result.postUrl).length;
  const failed = results.filter((result) => !result.ok).length;
  return {
    ok: failed === 0,
    planId: planId || rows[0]?.planId || "",
    attempted: results.length,
    posted,
    captured,
    failed,
    maxConcurrentProfiles,
    results,
    state: readState(),
    registers: readRegisters(),
  };
}

function recordPostingProfileGroupIssue(body) {
  const record = normalizeProfileRecord(body);
  if (!record.label) {
    const err = new Error("Profile ID or name is required");
    err.statusCode = 400;
    throw err;
  }
  const groupUrl = sanitizeFacebookGroupUrl(body.groupUrl || body.group_url || "", { allowBlank: true });
  const attemptedGroups = sanitizeFacebookGroupUrlList(body.attemptedGroupUrls || body.attempted_group_urls || body.attemptedGroups || []);
  const skipProfile = Boolean(body.skipProfile || body.skip_profile || body.noWorkingGroup || body.no_working_group);
  const status = skipProfile ? "cannot_post_in_any_group" : "cannot_post_in_group";
  const action = skipProfile ? "skip_profile_for_posting_run_manual_review_required" : "try_next_assigned_group_for_same_profile";
  const reason = oneLineField(body.reason || "Facebook group did not allow this profile to post", 260);
  const state = readState();
  const registers = readRegisters();
  const line = buildProfileRecordLine(record, {
    component: "facebook_review",
    issue: "posting_group_issue",
    status,
    group_url: groupUrl || "not_supplied",
    attempted_groups: attemptedGroups.join(","),
    reason,
    action,
  });
  state.posting.facebookProfileStatus = appendUniqueRecordLine(state.posting.facebookProfileStatus, line);
  if (skipProfile) state.ixbrowser.failedProfiles = appendUniqueRecordLine(state.ixbrowser.failedProfiles, line);
  registers.errors = appendUniqueRecordLine(registers.errors, [
    new Date().toISOString(),
    skipProfile ? "error" : "warning",
    "facebook_review",
    oneLineField(body.jobId || body.job_id || "", 80),
    record.profileId || "",
    record.name || record.label,
    "POSTING_GROUP_ACCESS_DENIED",
    reason,
    `group_url=${groupUrl || "not_supplied"} attempted_groups=${attemptedGroups.length}`,
    skipProfile ? "open" : "acknowledged",
  ].join(" | "));
  if (skipProfile) {
    registers.accountsToReview = appendUniqueRecordLine(registers.accountsToReview, line);
  }
  const nextState = writeState(state);
  const nextRegisters = writeRegisters(registers);
  logEvent("posting_profile_group_issue", {
    profileId: record.profileId || "",
    profileName: record.name || record.label,
    groupUrl: groupUrl || "",
    attemptedGroups: attemptedGroups.length,
    status,
    action,
  });
  return {
    state: nextState,
    registers: nextRegisters,
    issue: {
      profileId: record.profileId,
      profileName: record.name || record.label,
      groupUrl,
      attemptedGroups,
      status,
      action,
    },
  };
}

function unblockPostingProfile(body = {}) {
  const record = normalizeProfileRecord(body);
  if (!record.label && !record.profileId) {
    const err = new Error("Profile ID or label is required");
    err.statusCode = 400;
    throw err;
  }
  const groupUrl = sanitizeFacebookGroupUrl(body.groupUrl || body.group_url || "", { allowBlank: true });
  const reason = oneLineField(body.reason || "Operator manually cleared profile failure", 240);
  const scope = groupUrl ? "profile_group_unblocked" : "profile_unblocked";
  const status = "resolved";
  const state = readState();
  const line = buildProfileRecordLine(record, {
    component: "facebook_review",
    issue: "posting_group_issue",
    status,
    group_url: groupUrl || "all_groups",
    reason,
    action: scope,
  });
  state.ixbrowser.failedProfiles = appendUniqueRecordLine(state.ixbrowser.failedProfiles, line);
  state.posting.facebookProfileStatus = appendUniqueRecordLine(state.posting.facebookProfileStatus, line);
  // Also drop the profile from the MANUAL blacklist (ixbrowser.blockedProfiles) so a
  // full unblock truly re-enables it — but only when clearing all groups, and only the
  // line(s) for THIS profile id (never the default reserved entries like "wise").
  if (record.profileId && !groupUrl) {
    state.ixbrowser.blockedProfiles = String(state.ixbrowser.blockedProfiles || "")
      .split(/\r?\n/)
      .filter((ln) => {
        const id = blockedProfileIdFromLine(ln.replace(/\s*#.*$/, ""));
        return !(id && id === Number(record.profileId));
      })
      .join("\n");
  }
  const nextState = writeState(state);
  logEvent("posting_profile_unblocked", {
    profileId: record.profileId || "",
    profileName: record.name || record.label,
    groupUrl: groupUrl || "all_groups",
    scope,
  });
  return {
    state: nextState,
    unblocked: {
      profileId: record.profileId,
      profileName: record.name || record.label,
      groupUrl: groupUrl || "all_groups",
      scope,
    },
  };
}

// ---- AUTO-BLACKLIST blocked / restricted profiles ---------------------------
// A single post FAILURE is normally TRANSIENT (could not open composer / connector
// timeout) and the profile stays eligible. But a profile that keeps failing that
// way is effectively logged-out / restricted and just poisons every batch. So:
//  - a HARD account block (suspended/disabled/checkpoint) quarantines IMMEDIATELY
//    (permanent until manually unblocked), and
//  - REPEATED transient blocking failures (>= threshold, in-session OR persisted)
//    escalate to a NON-transient quarantine that the existing
//    isProfileBlockedForPosting() machinery honors (so EVERY pick path excludes it),
//    which auto-recovers once the failure line ages out (self-healing pool).
let __profileBlockStreak = {};
const PROFILE_AUTO_BLOCK_THRESHOLD = 2;
const PROFILE_AUTO_BLOCK_RECENT_WINDOW_MS = 3 * 60 * 60 * 1000;

function isHardAccountBlockOutcome(errorText, validation) {
  if (validation && validation.facebookAccountBlocked === true) return true;
  const t = String(errorText || "").toLowerCase();
  if (!t) return false;
  // PERMANENT: a missing/deleted ixBrowser profile (error 2007) will NEVER succeed -> permanent
  // blacklist (operator must recreate/re-login + unblock). Treated as a hard block, not a cooldown.
  if (/profile[ _-]?(?:does[ _]?not[ _]?exist|not[ _]?found)|profile does not exist|\berror 2007\b/i.test(t)) return true;
  return /account[ _-]?(?:suspend|disabl|lock|restrict|review|unavailable)|checkpoint|confirm (?:your )?identity|verify (?:your )?identity|we limit how often you can|temporarily (?:locked|restricted|blocked)|your account (?:has been|is)\b/i.test(t);
}

function isTransientBlockingPostFailure(errorText) {
  const t = String(errorText || "").toLowerCase();
  if (!t) return false;
  // NOTE: deliberately does NOT include the wrapper "failed in every configured group"
  // — that string also wraps product/image/content failures (NOT profile-health), and
  // counting those would wrongly streak a healthy profile. The genuine profile-health
  // sub-reasons below are present in real dead-profile errors and still match.
  return /could not open composer|composer not found|facebook[ _]login[ _]required|log in to continue|profile[ _-]?(?:open|login)[^.|]{0,24}fail|profile[ _-]?open[ _-]?(?:error|failed)|could not open profile|ixbrowser[^|]{0,20}error 100\d|\berror 1009\b|process not found|target page.*(?:closed)|browser has been closed|connector[ _]timed?[ _]?out|connector[ _]failed|connectovercdp/i.test(t);
}

function recentProfileBlockingFailureCount(pid, state) {
  const cutoff = Date.now() - PROFILE_AUTO_BLOCK_RECENT_WINDOW_MS;
  const sources = [state.posting?.facebookProfileStatus, state.ixbrowser?.failedProfiles].join("\n").split(/\r?\n/);
  let n = 0;
  for (const line of sources) {
    if (!line.includes(`profile_id=${pid}`)) continue;
    if (/status=(resolved|approved|cleared|ignored)|action=(profile_unblocked|profile_group_unblocked)/i.test(line)) continue;
    if (!/status=cannot_post_in_any_group|action=skip_profile|skip_profile_for_posting_run|auto_soft_strike=1/i.test(line)) continue;
    const m = line.match(/(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)/);
    const at = m ? Date.parse(m[1]) : NaN;
    if (Number.isFinite(at) && at < cutoff) continue;
    n += 1;
  }
  return n;
}

// Records the outcome of a single profile's post attempt and auto-blacklists the
// profile when it is genuinely blocked/restricted. NEVER throws (health tracking
// must not break a posting flow).
function autoBlacklistProfileIfNeeded(opts = {}) {
  try {
    const profile = String(opts.profile || "").trim();
    const pid = Number(opts.profileId || profileIdFromLabel(profile) || 0);
    if (!pid) return;
    const ok = Boolean(opts.ok || opts.postUrl); // a captured permalink proves the profile CAN post
    if (ok) { __profileBlockStreak[pid] = 0; return; }
    const errorText = String(opts.errorText || opts.error || "");
    const hard = isHardAccountBlockOutcome(errorText, opts.validation);
    // opts.profileRetryable is the connector's structured "profile open/login failed" signal —
    // robust even when the wrapper message hides/truncates the original reason. Treat it as soft.
    const soft = isTransientBlockingPostFailure(errorText) || opts.profileRetryable === true;
    if (!hard && !soft) return; // not a profile-health failure (e.g. product/image issue) — ignore
    __profileBlockStreak[pid] = (__profileBlockStreak[pid] || 0) + 1;
    const state = readState();
    if (isProfileBlockedForPosting(String(pid), state, "")) return; // already excluded — no duplicate line
    const record = normalizeProfileRecord({ profileId: pid, profileLabel: profile || String(pid) });
    const streak = __profileBlockStreak[pid];
    const persisted = recentProfileBlockingFailureCount(pid, state);
    const total = Math.max(streak, persisted + 1); // +1 = the current failure
    if (!(hard || total >= PROFILE_AUTO_BLOCK_THRESHOLD)) {
      // Below threshold: leave a breadcrumb that the NEXT failure will count (so even
      // 600s-timeout failures, which never reach recordPostingProfileGroupIssue, are
      // tallied and survive a restart). status=soft_failure_pending/action=count is NOT
      // matched by isProfileBlockedForPosting, so the breadcrumb can never block on its own.
      const crumb = buildProfileRecordLine(record, { component: "facebook_review", issue: "posting_soft_failure", status: "soft_failure_pending", action: "count", reason: oneLineField(errorText, 120), auto_soft_strike: "1", source: "auto_blacklist_streak" });
      state.ixbrowser.failedProfiles = appendUniqueRecordLine(state.ixbrowser.failedProfiles, crumb);
      writeState(state);
      return;
    }
    const fields = hard
      ? { component: "facebook_review", issue: "account_hard_blocked", status: "cannot_post_in_any_group", action: "quarantined", reason: "auto_blacklist_account_blocked_or_restricted", source: opts.source || "auto_blacklist", auto_blocked: "1" }
      : { component: "facebook_review", issue: "posting_group_issue", status: "cannot_post_in_any_group", action: "skip_profile", reason: `auto_blacklist_repeated_blocking_failures_${total}`, source: opts.source || "auto_blacklist", auto_blocked: "1" };
    const line = buildProfileRecordLine(record, fields);
    state.ixbrowser.failedProfiles = appendUniqueRecordLine(state.ixbrowser.failedProfiles, line);
    state.posting.facebookProfileStatus = appendUniqueRecordLine(state.posting.facebookProfileStatus, line);
    writeState(state);
    logEvent("profile_auto_blacklisted", { profileId: pid, profile, hard, streak, persisted, total, source: opts.source || "", lastError: oneLineField(errorText, 160) });
  } catch (_e) { /* never break a posting flow */ }
}

// ---- ixBrowser RECONCILIATION ----------------------------------------------
// Keep the working roster + blacklist in sync with what actually exists in iX.
// THREE outcomes per profile, in priority order:
//   1. GONE (not in the live iX profile-list anymore) => drop it from the roster
//      (groupAssignmentData / groupProfileAssignments / ownedGroupsByProfile) AND
//      clear its blacklist records. The operator wants deleted profiles to simply
//      disappear from the working list — not sit benched forever.
//   2. STALE AUTOMATION BENCH (profile still exists but is benched only by an
//      automation failure: posting_group_issue / could-not-open-composer /
//      group-render / repeated_blocking_failures / the comment marker false
//      positive) => clear the bench (reuse unblockPostingProfile) so it re-enters
//      rotation.
//   3. GENUINE FB-ACCOUNT SUSPENSION (account_unusable / suspended_or_disabled /
//      checkpoint / account_hard_blocked) => leave it benched. NEVER cleared here.
// SAFETY GUARDS (all encoded below):
//   (a) FAIL-CLOSED: if the profile-list fetch FAILS or returns an empty/
//       implausibly-small list, do NOTHING (never remove based on a bad fetch).
//   (b) DEBOUNCE: only remove a profile after it is absent from
//       RECONCILE_REMOVAL_STREAK_REQUIRED (2) consecutive SUCCESSFUL
//       reconciliations. The miss-streak is persisted in
//       state.ixbrowser.reconcileMissStreak (a JSON map of profileId->count) so a
//       single transient blip can never delete a profile.
//   (c) RESERVED PROFILES UNTOUCHED: wise / moderators (#41,#42) / dedicated
//       ShopYourLikes / the #40-43 restricted band are never removed and never
//       unblocked by this pass.
const RECONCILE_REMOVAL_STREAK_REQUIRED = 2;
const RECONCILE_MIN_PLAUSIBLE_PROFILE_COUNT = 3;
const RECONCILE_RESERVED_PROFILE_IDS = new Set([40, 41, 42, 43]);
const RECONCILE_MIN_INTERVAL_MS = 60 * 1000;
let __reconcileInFlight = false;
let __reconcileLastAt = 0;

function isReservedReconcileProfile(profileId, label, state) {
  const id = Number(profileId || profileIdFromLabel(label) || 0);
  if (id && RECONCILE_RESERVED_PROFILE_IDS.has(id)) return true;
  if (isDedicatedShopYourLikesProfileLabel(label || String(id || ""), state)) return true;
  if (isModeratorApprovalProfileLine(label || "")) return true;
  // Never touch anything still on the manual blacklist (wise, operator pins).
  if (isBlockedIxBrowserProfileLabel(label || String(id || ""), state)) return true;
  return false;
}

function parseReconcileMissStreak(state) {
  try {
    const parsed = JSON.parse(String(state.ixbrowser?.reconcileMissStreak || "{}"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_e) {
    return {};
  }
}

// Collect every distinct profile id currently referenced by the working roster.
function reconcileRosterProfileIds(state) {
  const ids = new Map(); // id -> representative label
  const add = (label) => {
    const id = profileIdFromLabel(label);
    if (!id) return;
    if (!ids.has(id)) ids.set(id, String(label || "").trim() || String(id));
  };
  for (const entry of Array.isArray(state.posting?.groupAssignmentData) ? state.posting.groupAssignmentData : []) {
    for (const profile of Array.isArray(entry?.profiles) ? entry.profiles : []) add(profile);
  }
  for (const line of recordLines(state.posting?.groupProfileAssignments)) add(line);
  for (const line of recordLines(state.posting?.ownedGroupsByProfile)) add(line);
  return ids;
}

// Drop a profile id from every roster surface (groupAssignmentData rows,
// groupProfileAssignments text, ownedGroupsByProfile text). Returns true if it
// changed anything.
function reconcileRemoveProfileFromRoster(state, profileId) {
  const id = Number(profileId || 0);
  if (!id) return false;
  let changed = false;
  if (Array.isArray(state.posting?.groupAssignmentData)) {
    for (const entry of state.posting.groupAssignmentData) {
      if (!Array.isArray(entry?.profiles)) continue;
      const kept = entry.profiles.filter((profile) => profileIdFromLabel(profile) !== id);
      if (kept.length !== entry.profiles.length) {
        entry.profiles = kept;
        changed = true;
      }
    }
  }
  for (const field of ["groupProfileAssignments", "ownedGroupsByProfile"]) {
    const current = String(state.posting?.[field] || "");
    if (!current) continue;
    const kept = current.split(/\r?\n/).filter((line) => !line.trim() || profileIdFromLabel(line) !== id);
    const nextValue = kept.join("\n");
    if (nextValue !== current) {
      state.posting[field] = nextValue;
      changed = true;
    }
  }
  return changed;
}

// Strip a GONE profile's blacklist/failure records so it does not linger benched
// after it has already been removed from the roster. Operates on the in-memory
// state object (caller persists via writeState).
function reconcileClearGoneProfileBlacklist(state, profileId, label) {
  const record = normalizeProfileRecord({ profileId: String(profileId), profile: label });
  state.ixbrowser.failedProfiles = removeProfileLine(state.ixbrowser?.failedProfiles, record);
  state.posting.facebookProfileStatus = removeProfileLine(state.posting?.facebookProfileStatus, record);
  state.ixbrowser.blockedProfiles = String(state.ixbrowser?.blockedProfiles || "")
    .split(/\r?\n/)
    .filter((line) => {
      const lineId = blockedProfileIdFromLine(line.replace(/\s*#.*$/, ""));
      return !(lineId && lineId === Number(profileId));
    })
    .join("\n");
}

async function reconcileProfilesWithIxBrowser(options = {}) {
  if (__reconcileInFlight) return { skipped: "reconcile_in_flight" };
  if (!options.force && Date.now() - __reconcileLastAt < RECONCILE_MIN_INTERVAL_MS) {
    return { skipped: "reconcile_debounced_interval" };
  }
  __reconcileInFlight = true;
  const summary = { at: new Date().toISOString(), removed: [], unbenched: [], pendingRemoval: [], kept: 0 };
  try {
    // SAFETY GUARD (a): FAIL-CLOSED on a bad/empty/tiny fetch. existingIxBrowserProfileIdSet()
    // throws on a hard failure; an implausibly small set means iX is mid-restart / logged out.
    let liveIds;
    try {
      liveIds = await existingIxBrowserProfileIdSet();
    } catch (err) {
      logEvent("ixbrowser_reconcile_skipped_fetch_failed", { error: oneLineField(err.message || String(err), 240) });
      return { skipped: "profile_list_fetch_failed" };
    }
    if (!(liveIds instanceof Set) || liveIds.size < RECONCILE_MIN_PLAUSIBLE_PROFILE_COUNT) {
      logEvent("ixbrowser_reconcile_skipped_implausible_list", { liveCount: liveIds ? liveIds.size : 0, min: RECONCILE_MIN_PLAUSIBLE_PROFILE_COUNT });
      return { skipped: "implausible_profile_list", liveCount: liveIds ? liveIds.size : 0 };
    }

    const state = readState();
    const rosterIds = reconcileRosterProfileIds(state);
    const missStreak = parseReconcileMissStreak(state);
    const nextMissStreak = {};
    let dirty = false;

    // PASS 1: GONE profiles. Consider every id referenced by the roster OR carrying a
    // blacklist/failure record. Reserved ids are never touched.
    const candidateIds = new Set(rosterIds.keys());
    for (const raw of [state.posting?.facebookProfileStatus, state.ixbrowser?.failedProfiles].join("\n").split(/\r?\n/)) {
      const m = raw.match(/profile_id=(\d{1,20})/i);
      if (m) candidateIds.add(Number(m[1]));
    }
    for (const id of candidateIds) {
      const label = rosterIds.get(id) || String(id);
      if (isReservedReconcileProfile(id, label, state)) continue;
      if (liveIds.has(id)) continue; // still exists in iX -> not gone
      // GONE this cycle. Bump the persisted miss-streak (SAFETY GUARD (b): debounce).
      const streak = (Number(missStreak[id]) || 0) + 1;
      if (streak >= RECONCILE_REMOVAL_STREAK_REQUIRED) {
        const removedFromRoster = reconcileRemoveProfileFromRoster(state, id);
        reconcileClearGoneProfileBlacklist(state, id, label);
        dirty = true;
        summary.removed.push({ profileId: id, label, removedFromRoster, missStreak: streak });
        // streak satisfied + acted on -> drop the counter (do not carry into nextMissStreak)
      } else {
        nextMissStreak[id] = streak;
        summary.pendingRemoval.push({ profileId: id, label, missStreak: streak, required: RECONCILE_REMOVAL_STREAK_REQUIRED });
      }
    }

    // PASS 2: profiles that DO exist but carry a STALE AUTOMATION bench -> clear it so they
    // re-enter rotation. Skip genuine FB suspensions (NEVER cleared) and reserved profiles.
    for (const [id, label] of rosterIds.entries()) {
      if (!liveIds.has(id)) continue; // gone profiles handled in PASS 1
      if (isReservedReconcileProfile(id, label, state)) continue;
      if (isFacebookProfileQuarantinedForFacebook(String(id), state, "")) continue; // genuine suspension stays
      if (!isProfileBlockedForPosting(String(id), state, "")) { summary.kept += 1; continue; }
      // Benched, but NOT a genuine suspension => automation-only bench. Clear it.
      try {
        const result = unblockPostingProfile({ profileId: String(id), profileLabel: label, reason: "ixbrowser reconcile: automation-only bench cleared (profile still exists)" });
        // unblockPostingProfile persists immediately; refresh our working copy so PASS-1 edits
        // are layered on the latest persisted state.
        state.ixbrowser.failedProfiles = result.state.ixbrowser.failedProfiles;
        state.ixbrowser.blockedProfiles = result.state.ixbrowser.blockedProfiles;
        state.posting.facebookProfileStatus = result.state.posting.facebookProfileStatus;
        summary.unbenched.push({ profileId: id, label });
      } catch (err) {
        logEvent("ixbrowser_reconcile_unbench_failed", { profileId: id, error: oneLineField(err.message || String(err), 200) });
      }
    }

    state.ixbrowser.reconcileMissStreak = JSON.stringify(nextMissStreak);
    // Always persist the (possibly empty) miss-streak so a recovered profile clears its counter.
    writeState(state);
    if (dirty || summary.unbenched.length || Object.keys(nextMissStreak).length) {
      logEvent("ixbrowser_reconcile_applied", {
        removed: summary.removed.length,
        unbenched: summary.unbenched.length,
        pendingRemoval: summary.pendingRemoval.length,
        liveCount: liveIds.size,
      });
    }
    __reconcileLastAt = Date.now();
    return summary;
  } catch (err) {
    logEvent("ixbrowser_reconcile_error", { error: oneLineField(err.message || String(err), 240) });
    return { skipped: "reconcile_error", error: oneLineField(err.message || String(err), 240) };
  } finally {
    __reconcileInFlight = false;
  }
}

// Snapshot of profiles currently excluded from posting (for the dashboard).
function currentlyBlockedProfilesSummary(state = readState()) {
  const sources = [state.posting?.facebookProfileStatus, state.ixbrowser?.failedProfiles].join("\n").split(/\r?\n/).filter(Boolean);
  const byId = new Map();
  for (const line of sources) {
    const m = line.match(/profile_id=(\d{1,20})/i);
    if (m) byId.set(m[1], line); // append-order => last write per id is the latest line
  }
  const out = [];
  const have = new Set();
  for (const [pid, latestLine] of byId.entries()) {
    if (!isProfileBlockedForPosting(String(pid), state, "")) continue;
    const labelM = latestLine.match(/profile=([^|]+)/i);
    const reasonM = latestLine.match(/reason=([^|]+)/i);
    const tsM = latestLine.match(/(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)/);
    have.add(Number(pid));
    out.push({
      profileId: Number(pid),
      label: labelM ? labelM[1].trim() : String(pid),
      reason: reasonM ? reasonM[1].trim() : "",
      since: tsM ? tsM[1] : "",
      type: isFacebookProfileQuarantinedForFacebook(String(pid), state, "") ? "account_blocked_or_restricted" : "repeated_post_failures",
      auto: /source=auto_blacklist|auto_blocked=1/i.test(latestLine),
    });
  }
  // Also surface MANUAL blacklist entries (ixbrowser.blockedProfiles) that carry a
  // numeric profile id — these never age out (operator must clear them).
  for (const raw of String(state.ixbrowser?.blockedProfiles || "").split(/\r?\n/)) {
    const bid = blockedProfileIdFromLine(raw.replace(/\s*#.*$/, ""));
    if (!bid || have.has(bid)) continue;
    have.add(bid);
    const cm = raw.match(/#\s*(.+)$/);
    out.push({
      profileId: bid,
      label: raw.replace(/\s*#.*$/, "").trim() || String(bid),
      reason: cm ? cm[1].trim() : "manual blacklist (operator)",
      since: "",
      type: "manual_blacklist",
      auto: false,
    });
  }
  return out.sort((a, b) => a.profileId - b.profileId);
}

// Profiles currently on 48h COMMENT COOLDOWN (last comment failed/auto-removed within the window),
// for the dashboard. Shows the reason + when each becomes eligible to comment again.
function commentCooldownProfilesSummary(state = readState()) {
  const windowMs = clampNumber(state.operator?.commentCooldownHours, 1, 720, 48) * 60 * 60 * 1000;
  const cutoff = Date.now() - windowMs;
  const rows = readJsonlAbsoluteFile(FB_LIVE_POST_LEDGER_FILE, { limit: 5000 });
  const latestByPid = new Map();
  for (const item of rows) {
    if (!item || item.event !== "comment_recovery_finished") continue;
    const pid = Number(item.profileId || 0);
    if (!pid) continue;
    const at = Date.parse(item.at || "");
    if (!Number.isFinite(at) || at < cutoff) continue;
    const prev = latestByPid.get(pid);
    if (!prev || Date.parse(prev.at || "") < at) latestByPid.set(pid, item);
  }
  const out = [];
  for (const [pid, item] of latestByPid.entries()) {
    const succeeded = ["published", "published_with_warning"].includes(String(item.status || "")) && item.validation?.commentVerified !== false;
    if (succeeded) continue;
    if (isTransientCommentProfileFailure(item.validation || {})) continue;
    const at = Date.parse(item.at || "");
    out.push({
      profileId: pid,
      label: oneLineField(item.profile || String(pid), 60),
      reason: oneLineField((Array.isArray(item.validation?.errors) ? item.validation.errors.join(",") : "") || item.validation?.verifyReason || item.message || "comment did not persist (FB auto-removed)", 90),
      since: item.at || "",
      retryAt: Number.isFinite(at) ? new Date(at + windowMs).toISOString() : "",
      group: item.actualGroupUrl || item.groupUrl || "",
    });
  }
  return out.sort((a, b) => a.profileId - b.profileId);
}

function clearAllFailedPostingProfiles(body = {}) {
  const groupUrlFilter = sanitizeFacebookGroupUrl(body.groupUrl || body.group_url || "", { allowBlank: true });
  const reason = oneLineField(body.reason || "Operator bulk-cleared accumulated profile failures", 240);
  const state = readState();
  const sources = [
    state.posting?.facebookProfileStatus || "",
    state.ixbrowser?.failedProfiles || "",
  ];
  const seenProfiles = new Map();
  const groupKeyFilter = groupUrlFilter ? normalizedFacebookGroupKey(groupUrlFilter) : "";
  for (const text of sources) {
    for (const rawLine of String(text || "").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const lower = line.toLowerCase();
      if (!/status=(cannot_comment|cannot_post_in_any_group|cannot_post_in_group)/i.test(lower)) continue;
      if (/status=(facebook_account_suspended_or_disabled|facebook_account_blocked_or_review_required|facebook_account_disabled|facebook_account_suspended|facebook_account_locked|cannot_use_facebook|cannot_comment)|issue=(facebook_account_status|account_unusable|account_hard_blocked)/i.test(lower)) continue;
      const fields = recordFieldsFromLine(line);
      const profileId = String(fields.profile_id || "").replace(/\D+/g, "");
      const profileLabel = oneLineField(fields.profile || "", 180);
      if (!profileId && !profileLabel) continue;
      const lineGroupKey = normalizedFacebookGroupKey(fields.group_url || "");
      if (groupKeyFilter && lineGroupKey && lineGroupKey !== groupKeyFilter) continue;
      const groupForOverride = groupUrlFilter || (fields.group_url && fields.group_url !== "not_supplied" && fields.group_url !== "all_groups" ? fields.group_url : "");
      const key = `${profileId}::${normalizedFacebookGroupKey(groupForOverride)}`;
      if (seenProfiles.has(key)) continue;
      seenProfiles.set(key, { profileId, profileLabel, groupUrl: groupForOverride });
    }
  }
  let nextState = state;
  const unblocked = [];
  for (const { profileId, profileLabel, groupUrl } of seenProfiles.values()) {
    try {
      const result = unblockPostingProfile({ profileId, profileLabel, groupUrl, reason });
      nextState = result.state;
      unblocked.push(result.unblocked);
    } catch (err) {
      logEvent("posting_profile_unblock_skipped", {
        profileId,
        profileLabel,
        groupUrl,
        error: oneLineField(err.message || String(err), 200),
      });
    }
  }
  logEvent("posting_profiles_bulk_unblocked", {
    cleared: unblocked.length,
    groupUrlFilter: groupUrlFilter || "all_groups",
  });
  return {
    state: readState(),
    cleared: unblocked.length,
    unblocked,
  };
}

function recordFieldsFromLine(line) {
  const fields = {};
  String(line || "").split("|").map((part) => part.trim()).forEach((part) => {
    const eq = part.indexOf("=");
    if (eq <= 0) return;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) fields[key] = value;
  });
  return fields;
}

function summarizeApprovalLine(line) {
  const fields = recordFieldsFromLine(line);
  const profile = fields.profile || fields.profile_id || "Workflow item";
  const status = fields.status || fields.action || "needs approval";
  const reason = fields.reason || fields.action || String(line || "").slice(0, 120);
  return {
    title: profile,
    subtitle: status.replaceAll("_", " "),
    detail: reason,
  };
}

function decisionStatus(decisions, id) {
  const decision = decisions.get(id);
  return decision?.status || "pending";
}

function jobNeedsQueueApproval(job, state = readState()) {
  if (!state.operator?.approvalRequired) return false;
  return job.approvalRequired !== false;
}

function jobQueueApprovalStatus(job, state = readState()) {
  if (!jobNeedsQueueApproval(job, state)) return "approved";
  return job.queueApprovalStatus === "approved" ? "approved" : "pending";
}

function buildApprovalItems() {
  const decisions = latestApprovalDecisionMap();
  const registers = readRegisters();
  const state = readState();
  const jobs = readJobs();
  const registerItems = String(registers.pendingApprovals || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const id = approvalId("pendingApprovals", line);
      const summary = summarizeApprovalLine(line);
      const decision = decisions.get(id);
      return {
        id,
        type: "register",
        source: "pendingApprovals",
        title: summary.title,
        subtitle: summary.subtitle,
        detail: summary.detail,
        raw: line,
        status: decision?.status || "pending",
        decidedAt: decision?.decidedAt || "",
        decidedBy: decision?.decidedBy || "",
        note: decision?.note || "",
        createdAt: line.match(/^\d{4}-\d{2}-\d{2}T[^|]+/)?.[0]?.trim() || "",
      };
    });

  const planItems = jobs
    .filter((job) => job.approvalRequired && job.mode === "plan" && job.status === "done" && String(job.output || "").trim())
    .map((job) => {
      const id = approvalId("job", job.id);
      const decision = decisions.get(id);
      return {
        id,
        type: "plan",
        source: "jobs",
        title: `Validate Hermes plan: ${job.title || "Untitled"}`,
        subtitle: "plan output ready",
        detail: String(job.output || "").slice(0, 1600),
        raw: job.id,
        status: decision?.status || "pending",
        decidedAt: decision?.decidedAt || "",
        decidedBy: decision?.decidedBy || "",
        note: decision?.note || "",
        createdAt: job.finishedAt || job.updatedAt || job.createdAt || "",
      };
    });

  const allItems = [...registerItems, ...planItems].sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
  const history = readApprovalDecisions()
    .slice(-80)
    .reverse()
    .map((decision) => {
      const item = allItems.find((entry) => entry.id === decision.id);
      return {
        ...decision,
        title: item?.title || decision.title || decision.id,
        subtitle: item?.subtitle || decision.type || "",
        detail: item?.detail || decision.note || "",
      };
    });
  return {
    items: allItems,
    pending: allItems.filter((item) => item.status === "pending"),
    queuedJobs: jobs.filter((job) => job.status === "queued").map((job) => {
      const queueApprovalStatus = jobQueueApprovalStatus(job, state);
      return {
        id: job.id,
        title: job.title,
        mode: job.mode,
        createdAt: job.createdAt,
        text: String(job.text || "").slice(0, 1200),
        approvalRequired: jobNeedsQueueApproval(job, state),
        queueApprovalStatus,
        approvedAt: job.queueApprovedAt || "",
        approvedBy: job.queueApprovedBy || "",
      };
    }),
    history,
  };
}

function recordApprovalDecision(body = {}) {
  const action = body.action === "reject" ? "rejected" : "approved";
  const id = oneLineField(body.id || "", 80);
  if (!/^[a-f0-9]{18}$/.test(id)) {
    const err = new Error("Valid approval id is required");
    err.statusCode = 400;
    throw err;
  }
  const current = buildApprovalItems();
  const item = current.items.find((entry) => entry.id === id);
  if (!item) {
    const err = new Error("Approval item was not found");
    err.statusCode = 404;
    throw err;
  }
  const rows = readApprovalDecisions().filter((row) => row.id !== id);
  const decision = {
    id,
    type: item.type,
    status: action,
    title: item.title,
    source: item.source,
    note: oneLineField(body.note || "", 400),
    decidedBy: "local_operator",
    decidedAt: new Date().toISOString(),
  };
  rows.push(decision);
  writeApprovalDecisions(rows);
  logEvent("approval_decision_recorded", { approvalId: id, status: action, type: item.type });
  return { decision, approvals: buildApprovalItems() };
}

function approveQueuedJobs(body = {}) {
  const now = new Date().toISOString();
  const action = body.action === "reject" ? "reject" : "approve";
  const requestedIds = Array.isArray(body.jobIds) ? body.jobIds.map((id) => oneLineField(id, 80)).filter(Boolean) : [];
  const approveAll = Boolean(body.allQueued);
  const jobs = readJobs();
  let changed = 0;
  for (const job of jobs) {
    if (job.status !== "queued") continue;
    if (!approveAll && !requestedIds.includes(job.id)) continue;
    if (action === "reject") {
      job.status = "stopped";
      job.queueApprovalStatus = "rejected";
      job.error = oneLineField(body.note || "Rejected by local operator before run.", 600);
      job.finishedAt = now;
    } else {
      job.queueApprovalStatus = "approved";
      job.queueApprovedAt = now;
      job.queueApprovedBy = "local_operator";
      job.approvalRequired = true;
    }
    job.updatedAt = now;
    changed += 1;
  }
  if (!changed) {
    const err = new Error("No matching queued task was found");
    err.statusCode = 404;
    throw err;
  }
  writeJobs(jobs);
  logEvent(action === "reject" ? "queued_jobs_rejected" : "queued_jobs_approved", { count: changed });
  return { changed, approvals: buildApprovalItems(), jobs: readJobs() };
}

// Local (not UTC) YYYY-MM-DD for the audit filename, so files roll at the operator's midnight.
function auditLocalDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
// Delete audit files older than auditLogRetentionDays. Runs ONLY on date-roll/startup (never the
// hot path). Each unlink is individually try-guarded; NEVER deletes today's / the active file.
function auditRetentionSweep(todayStr) {
  try {
    const retentionDays = clampNumber(readState().operator?.auditLogRetentionDays, 1, 3650, 30);
    const todayMs = Date.parse(`${todayStr}T00:00:00Z`);
    if (!Number.isFinite(todayMs)) return;
    for (const name of fs.readdirSync(AUDIT_DIR)) {
      const m = /^audit-(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
      if (!m) continue;
      if (m[1] === todayStr) continue; // never the current day
      const fileMs = Date.parse(`${m[1]}T00:00:00Z`);
      if (!Number.isFinite(fileMs)) continue;
      const ageDays = (todayMs - fileMs) / 86400000;
      if (ageDays > retentionDays) {
        const p = path.join(AUDIT_DIR, name);
        if (p === __auditFilePath) continue;
        try { fs.unlinkSync(p); } catch {}
      }
    }
  } catch {}
}

// Bound the unbounded growth of per-post detail logs (data/fb-live-post-log-*.json). Deletes
// files older than perPostLogRetentionDays (default 14). ASYNC + bounded (<=500/pass) so it never
// blocks the event loop; strict filename regex so it only ever touches our own per-post logs;
// each unlink individually guarded. The post LEDGER (facebook-live-posts.jsonl) is NEVER touched
// here — it is the authoritative append-only record that dedup/daily-caps depend on.
async function sweepPerPostLogs() {
  try {
    const retentionDays = clampNumber(readState().operator?.perPostLogRetentionDays, 1, 3650, 14);
    const cutoffMs = Date.now() - retentionDays * 86400000;
    const names = await fs.promises.readdir(DATA_DIR);
    let deleted = 0;
    for (const name of names) {
      if (deleted >= 500) break;
      const m = /^fb-live-post-log-(\d{10,})-[0-9a-f]+\.json$/.exec(name);
      if (!m) continue;
      const tsMs = Number(m[1]);
      if (!Number.isFinite(tsMs) || tsMs >= cutoffMs) continue; // keep recent / unparseable
      try { await fs.promises.unlink(path.join(DATA_DIR, name)); deleted += 1; } catch {}
    }
    if (deleted) logEvent("per_post_log_retention_swept", { deleted, retentionDays });
  } catch {}
}

function logEvent(message, fields = {}) {
  const at = new Date();
  const entry = { at: at.toISOString(), message, ...fields };
  const line = JSON.stringify(entry) + "\n";
  // The append is INSIDE the try so logEvent can NEVER throw — a throw here (EMFILE/EACCES/
  // ENOSPC/transient lock under parallel load) must not abort a caller, especially the
  // lock-wrapper logEvents whose throw would skip a release() and deadlock the box.
  try {
    fs.appendFileSync(LOG_FILE, line);
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > MAX_EVENTS_BYTES) {
      const lines = fs.readFileSync(LOG_FILE, "utf8").split(/\r?\n/).filter(Boolean).slice(-600);
      atomicWrite(LOG_FILE, lines.join("\n") + "\n");
    }
    // DURABLE AUDIT LOG (never trimmed): append the SAME line to data/audit/audit-YYYY-MM-DD.log.
    // Hot path = a cached-path append. mkdir + retention sweep run ONLY when the local date rolls
    // (≈once/day) or on first event. All inside this try so it can never throw (lock-wrapper safety).
    const dateStr = auditLocalDateStr(at);
    if (dateStr !== __auditDateStr) {
      const newPath = path.join(AUDIT_DIR, `audit-${dateStr}.log`);
      fs.mkdirSync(AUDIT_DIR, { recursive: true });
      fs.appendFileSync(newPath, line); // prove the new day's file is writable BEFORE caching it
      __auditDateStr = dateStr;          // commit cache ONLY after success, so a transient mkdir/
      __auditFilePath = newPath;         // append error doesn't silently disable audit all day
      auditRetentionSweep(dateStr);
    } else {
      fs.appendFileSync(__auditFilePath, line);
    }
  } catch {
    // Logging must not break the dashboard.
  }
}

function recentEvents(limit = 80) {
  if (!fs.existsSync(LOG_FILE)) return [];
  return fs.readFileSync(LOG_FILE, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-limit)
    .map((line) => {
      try { return JSON.parse(line); } catch { return { at: "", message: line }; }
    });
}

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function text(res, code, message) {
  res.writeHead(code, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(message);
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || EXTERNAL_SERVICE_TIMEOUT_MS);
  try {
    let response;
    try {
      response = await fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
      const wrapped = new Error(err.name === "AbortError"
        ? `Network request timed out for ${new URL(url).origin}`
        : `Network request failed for ${new URL(url).origin}: ${err.message}`);
      wrapped.statusCode = 503;
      wrapped.publicError = "external_network_error";
      throw wrapped;
    }
    const textBody = await response.text();
    let payload = null;
    try { payload = textBody ? JSON.parse(textBody) : null; } catch { payload = { raw: textBody }; }
    if (!response.ok) {
      const err = new Error(`External API returned HTTP ${response.status}`);
      err.statusCode = 502;
      err.remoteStatus = response.status;
      err.payload = payload;
      err.publicError = "external_api_error";
      throw err;
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function webshareRequest(pathname) {
  const secrets = readSecrets();
  if (!secrets.webshare.apiKey) throw serviceConfigError("Webshare API key is missing. Add it in Integrations API Keys, then save.", "webshare_missing_api_key");
  const base = normalizeAllowedServiceBaseUrl(secrets.webshare.baseUrl || defaultSecrets().webshare.baseUrl, ALLOWED_WEBSHARE_HOSTS, "Webshare");
  const url = new URL(pathname.replace(/^\//, ""), base);
  try {
    return await fetchJson(url.toString(), {
      method: "GET",
      headers: { "Authorization": `Token ${secrets.webshare.apiKey}` },
    });
  } catch (err) {
    throw normalizeWebshareError(err);
  }
}

function normalizeWebshareError(err) {
  if (err.remoteStatus === 401 || err.remoteStatus === 403) {
    const wrapped = serviceConfigError("Webshare rejected the API key. Check the saved Webshare key, then save and test again.", "webshare_auth_failed");
    wrapped.remoteStatus = err.remoteStatus;
    return wrapped;
  }
  const message = err.remoteStatus
    ? `Webshare API request failed with HTTP ${err.remoteStatus}.`
    : `Webshare API request failed: ${err.message}`;
  const wrapped = new Error(message);
  wrapped.statusCode = err.statusCode || 502;
  wrapped.publicError = err.publicError || "webshare_api_error";
  wrapped.remoteStatus = err.remoteStatus;
  return wrapped;
}

function sanitizeWebshareProxy(proxy) {
  const port = normalizePort(proxy.port, "Webshare proxy port");
  return {
    id: proxy.id,
    proxy_address: normalizeProxyHost(proxy.proxy_address),
    port,
    valid: proxy.valid,
    country_code: proxy.country_code,
    city_name: proxy.city_name,
    username: proxy.username ? maskSecret(proxy.username) : "",
    password: proxy.password ? maskSecret(proxy.password) : "",
    last_verification: proxy.last_verification,
    created_at: proxy.created_at,
  };
}

// Routes affiliate API calls (the Mavlynk shortening) through the dedicated
// ShopYourLikes #40 proxy IP — when shortlink.apiRequestsUseAffiliateProxy is on —
// instead of the server's own datacenter IP. Uses undici's ProxyAgent as the
// fetch dispatcher (cached per proxy endpoint).
let __affiliateApiDispatcher = null;
let __affiliateApiDispatcherKey = "";
function affiliateProxyDispatcherForApi() {
  if (!readState().shortlink?.apiRequestsUseAffiliateProxy) return null;
  let cfg;
  try { cfg = affiliateProxyConfig(); } catch { return null; }
  if (!cfg.host || !cfg.port) return null;
  const key = `${cfg.host}:${cfg.port}:${cfg.username || ""}`;
  if (__affiliateApiDispatcher && __affiliateApiDispatcherKey === key) return __affiliateApiDispatcher;
  try {
    const { ProxyAgent } = require("undici");
    const token = cfg.username ? "Basic " + Buffer.from(`${cfg.username}:${cfg.password || ""}`).toString("base64") : undefined;
    __affiliateApiDispatcher = new ProxyAgent({ uri: `http://${cfg.host}:${cfg.port}`, ...(token ? { token } : {}) });
    __affiliateApiDispatcherKey = key;
    logEvent("affiliate_api_proxy_dispatcher_ready", { host: cfg.host, port: cfg.port });
    return __affiliateApiDispatcher;
  } catch (err) {
    logEvent("affiliate_api_proxy_dispatcher_failed", { error: oneLineField(err.message || String(err), 200) });
    return null;
  }
}

async function mavlynkRequest(path, options = {}) {
  const secrets = readSecrets();
  if (!secrets.shortlink.apiKey) throw serviceConfigError("Mavlynk API key is missing. Add it in Integrations, then save.", "shortlink_missing_api_key");
  const base = normalizeAllowedServiceBaseUrl(
    secrets.shortlink.baseUrl || defaultSecrets().shortlink.baseUrl,
    ALLOWED_MAVLYNK_HOSTS,
    "Mavlynk"
  );
  const url = new URL(path.replace(/^\//, ""), base);
  const dispatcher = affiliateProxyDispatcherForApi();
  try {
    return await fetchJson(url.toString(), {
      method: options.method || "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${secrets.shortlink.apiKey}`,
        "X-API-Key": secrets.shortlink.apiKey,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      timeoutMs: options.timeoutMs || 30000,
      ...(dispatcher ? { dispatcher } : {}),
    });
  } catch (err) {
    if (err.remoteStatus === 401 || err.remoteStatus === 403) {
      const wrapped = serviceConfigError("Mavlynk rejected the API key. Check the saved key, then save and test again.", "shortlink_auth_failed");
      wrapped.remoteStatus = err.remoteStatus;
      return wrapped;
    }
    throw err;
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

function existingMavlynkShortlinkForTargetUrl(targetUrl, state = readState()) {
  const normalizedTarget = normalizeUrlForComparison(targetUrl);
  if (!normalizedTarget) return "";
  if (isShopYourLikesUrl(targetUrl)) {
    const mapped = affiliateLinkMappings(state)
      .find((entry) => normalizeUrlForComparison(entry.sylLink) === normalizedTarget && isMavlynkShortUrl(entry.shortUrl));
    return mapped?.shortUrl || "";
  }
  return "";
}

async function createMavlynkShortlink(targetUrl) {
  let lastResult = null;
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const result = await mavlynkRequest("/api/url/add", { body: { url: targetUrl } });
      lastResult = result;
      const shortUrl = extractMavlynkShortUrl(result);
      if (shortUrl) return { shortUrl, raw: result, attempts: attempt };
      lastError = new Error("Mavlynk did not return shorturl for the supplied link.");
    } catch (err) {
      lastError = err;
      if (err.publicError === "shortlink_auth_failed" || err.publicError === "shortlink_missing_api_key") throw err;
    }
    if (attempt < 3) await sleep(1200 * attempt);
  }

  const existingShortUrl = existingMavlynkShortlinkForTargetUrl(targetUrl);
  if (existingShortUrl) {
    logEvent("shortlink_existing_mapping_reused_after_mavlynk_retry", {
      targetHost: (() => { try { return new URL(targetUrl).hostname; } catch { return ""; } })(),
      shortUrl: existingShortUrl,
      reason: oneLineField(lastError?.message || "mavlynk_missing_result", 160),
    });
    return {
      shortUrl: existingShortUrl,
      raw: {
        source: "local_existing_mavlynk_mapping_after_retry",
        lastResult,
        lastError: lastError?.message || "",
      },
      attempts: 3,
      reusedExisting: true,
    };
  }
  const err = new Error(lastError?.message || "Mavlynk did not return shorturl for the supplied link.");
  err.statusCode = lastError?.statusCode || 502;
  err.publicError = lastError?.publicError || "shortlink_missing_result";
  err.payload = lastResult;
  throw err;
}

function sanitizeAffiliateProxyState(state = readState(), secrets = readSecrets()) {
  return {
    enabled: state.affiliateProxy.enabled,
    provider: state.affiliateProxy.provider,
    requiredCountry: state.affiliateProxy.requiredCountry,
    staticOnly: state.affiliateProxy.staticOnly,
    lockedToSelectedProxy: state.affiliateProxy.lockedToSelectedProxy,
    apiRequestsMustUseProxy: state.affiliateProxy.apiRequestsMustUseProxy,
    selectedProxyId: state.affiliateProxy.selectedProxyId || secrets.affiliateProxy.proxyId || "",
    proxyAddress: state.affiliateProxy.proxyAddress ? maskHost(state.affiliateProxy.proxyAddress) : "",
    proxyPort: state.affiliateProxy.proxyPort || "",
    hasCredentials: Boolean(secrets.affiliateProxy.host && secrets.affiliateProxy.port),
    hasAuth: Boolean(secrets.affiliateProxy.username && secrets.affiliateProxy.password),
    lastAssignedAt: state.affiliateProxy.lastAssignedAt,
    lastTestAt: state.affiliateProxy.lastTestAt,
    lastObservedIp: state.affiliateProxy.lastObservedIp ? maskHost(state.affiliateProxy.lastObservedIp) : "",
    lastObservedCountry: state.affiliateProxy.lastObservedCountry,
    status: state.affiliateProxy.status,
  };
}

function pickAffiliateProxy(proxies, state = readState()) {
  const requiredCountry = String(state.affiliateProxy.requiredCountry || state.proxyProvider.requiredLocation || "US").toUpperCase();
  const candidates = (proxies || []).filter((proxy) => {
    const country = String(proxy.country_code || "").toUpperCase();
    try {
      return (!requiredCountry || country === requiredCountry) && proxy.valid !== false && normalizeProxyHost(proxy.proxy_address) && normalizePort(proxy.port, "Webshare proxy port");
    } catch {
      return false;
    }
  });
  return candidates[0] || null;
}

function writeAffiliateProxySelection(proxy) {
  const secrets = readSecrets();
  const state = readState();
  if (!proxy?.proxy_address || !proxy?.port) throw new Error("Selected proxy is missing host or port.");
  const proxyHost = normalizeProxyHost(proxy.proxy_address);
  const proxyPort = normalizePort(proxy.port, "Webshare proxy port");
  const nextSecrets = deepMerge(secrets, {
    affiliateProxy: {
      proxyType: "http",
      host: proxyHost,
      port: proxyPort,
      username: proxy.username || "",
      password: proxy.password || "",
      provider: "Webshare",
      proxyId: proxy.id || "",
    },
  });
  writeSecrets(nextSecrets);

  state.affiliateProxy.enabled = true;
  state.affiliateProxy.provider = "Webshare";
  state.affiliateProxy.requiredCountry = String(proxy.country_code || state.affiliateProxy.requiredCountry || "US").toUpperCase();
  state.affiliateProxy.staticOnly = true;
  state.affiliateProxy.lockedToSelectedProxy = true;
  state.affiliateProxy.apiRequestsMustUseProxy = true;
  state.affiliateProxy.selectedProxyId = proxy.id || "";
  state.affiliateProxy.proxyAddress = proxyHost;
  state.affiliateProxy.proxyPort = proxyPort;
  state.affiliateProxy.lastAssignedAt = new Date().toISOString();
  state.affiliateProxy.status = "assigned";
  state.affiliate.apiRequestsUseDedicatedProxy = true;
  // Route the Mavlynk shortening through the dedicated #40 affiliate proxy IP too,
  // not the server's IP (the operator requires the shortlink step to use the SYL
  // ShopYourLikes profile/proxy that this same flow just assigned).
  state.shortlink.apiRequestsUseAffiliateProxy = true;
  writeState(state);
  return sanitizeAffiliateProxyState(state, nextSecrets);
}

function affiliateProxyConfig() {
  const secrets = readSecrets();
  const state = readState();
  if (!state.affiliateProxy.enabled || !state.affiliateProxy.apiRequestsMustUseProxy) {
    throw new Error("Dedicated affiliate proxy is not enabled.");
  }
  const proxy = secrets.affiliateProxy;
  if (!proxy.host || !proxy.port) throw serviceConfigError("Dedicated affiliate proxy is not configured.", "affiliate_proxy_missing");
  return {
    ...proxy,
    host: normalizeProxyHost(proxy.host),
    port: normalizePort(proxy.port, "Affiliate proxy port"),
  };
}

async function testAffiliateProxy() {
  const proxy = affiliateProxyConfig();
  let payload;
  try {
    payload = await httpsJsonViaHttpProxy("https://ipinfo.io/json", proxy);
  } catch (err) {
    try {
      payload = await httpsJsonViaHttpProxy("https://api.ipify.org?format=json", proxy);
    } catch (fallbackErr) {
      const wrapped = new Error(`Affiliate proxy test failed: ${fallbackErr.message || err.message}`);
      wrapped.statusCode = 502;
      wrapped.publicError = "affiliate_proxy_test_failed";
      throw wrapped;
    }
  }
  const observedIp = payload.ip || "";
  const observedCountry = String(payload.country || "").toUpperCase();
  const state = readState();
  state.affiliateProxy.lastTestAt = new Date().toISOString();
  state.affiliateProxy.lastObservedIp = observedIp;
  state.affiliateProxy.lastObservedCountry = observedCountry || state.affiliateProxy.requiredCountry;
  state.affiliateProxy.status = observedCountry && observedCountry !== state.affiliateProxy.requiredCountry ? "country_mismatch" : "proxy_ok";
  writeState(state);
  return {
    ok: state.affiliateProxy.status === "proxy_ok",
    observedIp: observedIp ? maskHost(observedIp) : "",
    observedCountry: state.affiliateProxy.lastObservedCountry,
    requiredCountry: state.affiliateProxy.requiredCountry,
    status: state.affiliateProxy.status,
  };
}

function httpsJsonViaHttpProxy(targetUrl, proxy) {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    if (target.protocol !== "https:") return reject(new Error("Only HTTPS proxy tests are supported."));
    const proxyHost = normalizeProxyHost(proxy.host);
    const proxyPort = Number(normalizePort(proxy.port, "Affiliate proxy port"));
    const socket = net.connect(proxyPort, proxyHost);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Proxy request timed out."));
    }, 25000);
    let connectBuffer = Buffer.alloc(0);
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.once("connect", () => {
      const auth = proxy.username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password || ""}`).toString("base64")}\r\n`
        : "";
      socket.write([
        `CONNECT ${target.hostname}:443 HTTP/1.1`,
        `Host: ${target.hostname}:443`,
        auth.trimEnd(),
        "Connection: keep-alive",
        "",
        "",
      ].filter((line) => line !== "").join("\r\n") + "\r\n\r\n");
    });
    socket.on("data", onConnectData);
    function onConnectData(chunk) {
      connectBuffer = Buffer.concat([connectBuffer, chunk]);
      const marker = connectBuffer.indexOf("\r\n\r\n");
      if (marker === -1) return;
      socket.off("data", onConnectData);
      const header = connectBuffer.slice(0, marker).toString("latin1");
      const leftover = connectBuffer.slice(marker + 4);
      if (!/^HTTP\/1\.[01] 2\d\d/i.test(header)) {
        clearTimeout(timer);
        socket.destroy();
        reject(new Error(`Proxy CONNECT failed: ${header.split(/\r?\n/)[0]}`));
        return;
      }
      const secure = tls.connect({ socket, servername: target.hostname }, () => {
        const requestPath = `${target.pathname || "/"}${target.search || ""}`;
        secure.write([
          `GET ${requestPath} HTTP/1.1`,
          `Host: ${target.host}`,
          "Accept: application/json",
          "Connection: close",
          "",
          "",
        ].join("\r\n"));
      });
      let responseBuffer = leftover;
      secure.setTimeout(EXTERNAL_SERVICE_TIMEOUT_MS, () => {
        clearTimeout(timer);
        secure.destroy(new Error("Proxy target request timed out."));
      });
      secure.on("data", (data) => {
        responseBuffer = Buffer.concat([responseBuffer, data]);
        if (responseBuffer.length > 1_000_000) {
          clearTimeout(timer);
          secure.destroy(new Error("Proxy target response is too large."));
        }
      });
      secure.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      secure.once("end", () => {
        clearTimeout(timer);
        try {
          resolve(parseHttpJsonResponse(responseBuffer));
        } catch (err) {
          reject(err);
        }
      });
    }
  });
}

function parseHttpJsonResponse(buffer) {
  const marker = buffer.indexOf("\r\n\r\n");
  if (marker === -1) throw new Error("Invalid HTTP response from proxy test.");
  const header = buffer.slice(0, marker).toString("latin1");
  const bodyBuffer = buffer.slice(marker + 4);
  const status = header.split(/\r?\n/)[0] || "";
  if (!/^HTTP\/1\.[01] 2\d\d/i.test(status)) throw new Error(`Proxy target request failed: ${status}`);
  const isChunked = /transfer-encoding:\s*chunked/i.test(header);
  const body = isChunked ? decodeChunked(bodyBuffer).toString("utf8") : bodyBuffer.toString("utf8");
  return JSON.parse(body);
}

function decodeChunked(buffer) {
  let offset = 0;
  const chunks = [];
  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf("\r\n", offset);
    if (lineEnd === -1) break;
    const sizeText = buffer.slice(offset, lineEnd).toString("latin1").split(";", 1)[0];
    const size = parseInt(sizeText, 16);
    if (!Number.isFinite(size)) break;
    offset = lineEnd + 2;
    if (size === 0) break;
    chunks.push(buffer.slice(offset, offset + size));
    offset += size + 2;
  }
  return Buffer.concat(chunks);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findIxBrowserExecutable() {
  return IXBROWSER_EXECUTABLE_CANDIDATES.find((candidate) => {
    try { return fs.existsSync(candidate); } catch { return false; }
  }) || "";
}

function focusIxBrowserDesktopWindow(reason = "login_required") {
  if (process.platform !== "win32") return false;
  const script = `
$sig = @'
using System;
using System.Runtime.InteropServices;
public static class Win32Window {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@
Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue | Out-Null
$proc = Get-Process ixBrowser -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object StartTime | Select-Object -First 1
if ($proc) {
  [Win32Window]::ShowWindowAsync($proc.MainWindowHandle, 9) | Out-Null
  Start-Sleep -Milliseconds 250
  [Win32Window]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
  Write-Output $proc.Id
}
`;
  execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    windowsHide: true,
    timeout: 6000,
    maxBuffer: 4096,
  }, (err, stdout) => {
    if (err) {
      logEvent("ixbrowser_desktop_focus_failed", { reason, error: oneLineField(err.message || String(err), 240) });
      return;
    }
    const pid = String(stdout || "").trim();
    logEvent(pid ? "ixbrowser_desktop_focused" : "ixbrowser_desktop_focus_no_window", { reason, pid });
  });
  return true;
}

function openIxBrowserDesktop(reason = "login_required") {
  const exePath = findIxBrowserExecutable();
  const now = Date.now();
  if (!exePath) {
    logEvent("ixbrowser_desktop_autostart_missing", { reason });
    return { opened: false, alreadyRequested: false, path: "", message: "IXBrowser desktop executable was not found." };
  }
  if (now - lastIxBrowserAutoOpenAt < 30000) {
    focusIxBrowserDesktopWindow(reason);
    return { opened: true, alreadyRequested: true, path: exePath, message: "IXBrowser desktop auto-open was already requested recently." };
  }
  lastIxBrowserAutoOpenAt = now;
  const child = spawn(exePath, [], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
  logEvent("ixbrowser_desktop_autostarted", { reason, path: exePath });
  setTimeout(() => focusIxBrowserDesktopWindow(reason), 1500);
  return { opened: true, alreadyRequested: false, path: exePath, message: "IXBrowser desktop opened. Finish login there if prompted." };
}

async function runIxBrowserDesktopLoginAssistant(reason = "login_required") {
  if (process.platform !== "win32") return { ok: false, skipped: true, reason: "not_windows" };
  const script = `
$sig = @'
using System;
using System.Runtime.InteropServices;
public static class Win32Window {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@
Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue | Out-Null
Add-Type -AssemblyName UIAutomationClient -ErrorAction SilentlyContinue | Out-Null
Add-Type -AssemblyName UIAutomationTypes -ErrorAction SilentlyContinue | Out-Null
$proc = Get-Process ixBrowser -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object StartTime | Select-Object -First 1
if (-not $proc) {
  @{ ok = $false; clicked = $false; reason = "no_window" } | ConvertTo-Json -Compress
  exit 0
}
[Win32Window]::ShowWindowAsync($proc.MainWindowHandle, 9) | Out-Null
Start-Sleep -Milliseconds 250
[Win32Window]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 700
$root = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
if (-not $root) {
  @{ ok = $false; clicked = $false; reason = "no_automation_root"; pid = $proc.Id; window = $proc.MainWindowTitle } | ConvertTo-Json -Compress
  exit 0
}
$condition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Button
)
$buttons = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
$matches = @()
for ($i = 0; $i -lt $buttons.Count; $i++) {
  $button = $buttons.Item($i)
  $name = [string]$button.Current.Name
  if ([string]::IsNullOrWhiteSpace($name)) { continue }
  if ($name -match '(?i)(cancel|close|logout|log out|delete|remove|register|sign up|create account)') { continue }
  if ($name -match '(?i)(login|log in|sign in|continue|confirm|retry|try again|ok|yes)') {
    $matches += $button
  }
}
if ($matches.Count -eq 0) {
  @{ ok = $true; clicked = $false; reason = "no_safe_login_button"; pid = $proc.Id; window = $proc.MainWindowTitle } | ConvertTo-Json -Compress
  exit 0
}
$target = $matches[0]
$buttonName = [string]$target.Current.Name
$clicked = $false
$clickError = ""
try {
  $invoke = $target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $invoke.Invoke()
  $clicked = $true
} catch {
  $clickError = $_.Exception.Message
}
@{
  ok = $true
  clicked = $clicked
  button = $buttonName
  reason = $(if ($clicked) { "safe_button_invoked" } else { "invoke_failed" })
  error = $clickError
  pid = $proc.Id
  window = $proc.MainWindowTitle
} | ConvertTo-Json -Compress
`;
  try {
    const { stdout, stderr } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-Command", script,
    ], {
      cwd: ROOT,
      windowsHide: true,
      timeout: IXBROWSER_DESKTOP_LOGIN_ASSIST_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
    });
    let result = null;
    try { result = JSON.parse(String(stdout || "").trim()); } catch {}
    if (!result) result = { ok: false, clicked: false, reason: "bad_assist_output", output: oneLineField(stdout || stderr || "", 400) };
    logEvent("ixbrowser_desktop_login_assist", {
      reason,
      ok: Boolean(result.ok),
      clicked: Boolean(result.clicked),
      button: oneLineField(result.button || "", 120),
      resultReason: oneLineField(result.reason || "", 120),
      error: oneLineField(result.error || "", 240),
    });
    return result;
  } catch (err) {
    logEvent("ixbrowser_desktop_login_assist_failed", { reason, error: oneLineField(err.message || String(err), 240) });
    return { ok: false, clicked: false, reason: "assist_failed", error: err.message || String(err) };
  }
}

async function ixBrowserRequestOnce(endpoint, payload = {}) {
  const secrets = readSecrets();
  const base = normalizeIxBrowserBaseUrl(secrets.ixbrowser.baseUrl || defaultSecrets().ixbrowser.baseUrl);
  const url = new URL(endpoint.replace(/^\//, ""), base);
  const headers = { "content-type": "application/json" };
  if (secrets.ixbrowser.apiKey) headers.Authorization = `Bearer ${secrets.ixbrowser.apiKey}`;
  const response = await fetchJson(url.toString(), {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (!response || !response.error || typeof response.error.code === "undefined") return response;
  if (response.error.code !== 0) throw ixBrowserError(response.error);
  return Object.prototype.hasOwnProperty.call(response, "data") ? response.data : true;
}

function isIxBrowserLocalConnectionError(err) {
  return err?.publicError === "external_network_error" && /127\.0\.0\.1|localhost/i.test(err.message || "");
}

function isRecoverableIxBrowserDesktopError(err) {
  return err?.publicError === "ixbrowser_login_required" || isIxBrowserLocalConnectionError(err);
}

function ixBrowserDesktopRecoveryTimeoutMs(err) {
  return err?.publicError === "ixbrowser_login_required"
    ? IXBROWSER_DESKTOP_LOGIN_WAIT_MS
    : IXBROWSER_DESKTOP_START_WAIT_MS;
}

function ixBrowserDesktopRecoveryProgress(err, timeoutMs) {
  const seconds = Math.ceil(timeoutMs / 1000);
  if (err?.publicError === "ixbrowser_login_required") {
    return {
      title: "IXBrowser login required",
      detail: `IXBrowser desktop is logged out. Log in in the IXBrowser window; the test will retry automatically for up to ${seconds} seconds.`,
    };
  }
  return {
    title: "Starting IXBrowser",
    detail: `IXBrowser desktop is not ready. Opening IXBrowser and retrying automatically for up to ${seconds} seconds.`,
  };
}

async function waitForIxBrowserDesktopRecovery(endpoint, payload, recovery, firstErr) {
  const startedAt = Date.now();
  let timeoutMs = ixBrowserDesktopRecoveryTimeoutMs(firstErr);
  let deadline = startedAt + timeoutMs;
  let lastErr = firstErr;
  let attempts = 0;
  let lastLoginAssistAt = 0;
  const runLoginAssistIfNeeded = async (err, force = false) => {
    if (err?.publicError !== "ixbrowser_login_required") return null;
    const now = Date.now();
    if (!force && now - lastLoginAssistAt < IXBROWSER_DESKTOP_LOGIN_ASSIST_INTERVAL_MS) return null;
    lastLoginAssistAt = now;
    const assist = await runIxBrowserDesktopLoginAssistant("ixbrowser_desktop_recovery");
    if (assist?.clicked) {
      persistTestRunStepProgress({
        title: "IXBrowser login assistant",
        percent: 86,
        detail: `Desktop assistant clicked "${oneLineField(assist.button || "login", 80)}". If password or 2FA is requested, finish it manually in IXBrowser.`,
        tone: "warn",
      });
    }
    return assist;
  };
  const firstProgress = ixBrowserDesktopRecoveryProgress(firstErr, timeoutMs);
  persistTestRunStepProgress({
    title: firstProgress.title,
    percent: 86,
    detail: firstProgress.detail,
    tone: "warn",
  });
  logEvent("ixbrowser_desktop_recovery_wait_started", {
    endpoint,
    reason: firstErr?.publicError || "",
    path: recovery.path,
    timeoutMs,
  });
  await runLoginAssistIfNeeded(firstErr, true);

  while (Date.now() < deadline) {
    const remainingMs = Math.max(250, deadline - Date.now());
    await sleep(Math.min(IXBROWSER_DESKTOP_RECOVERY_POLL_MS, remainingMs));
    attempts += 1;
    try {
      const result = await ixBrowserRequestOnce(endpoint, payload);
      logEvent("ixbrowser_request_recovered_after_desktop_wait", {
        endpoint,
        waitedMs: Date.now() - startedAt,
        attempts,
      });
      persistTestRunStepProgress({
        title: "IXBrowser ready",
        percent: 86,
        detail: "IXBrowser is ready again; continuing the Facebook workflow.",
        tone: "running",
      });
      return result;
    } catch (retryErr) {
      lastErr = retryErr;
      if (!isRecoverableIxBrowserDesktopError(retryErr)) throw retryErr;
      await runLoginAssistIfNeeded(retryErr);
      if (retryErr.publicError === "ixbrowser_login_required" && timeoutMs < IXBROWSER_DESKTOP_LOGIN_WAIT_MS) {
        timeoutMs = IXBROWSER_DESKTOP_LOGIN_WAIT_MS;
        deadline = Date.now() + timeoutMs;
        const loginProgress = ixBrowserDesktopRecoveryProgress(retryErr, timeoutMs);
        persistTestRunStepProgress({
          title: loginProgress.title,
          percent: 86,
          detail: loginProgress.detail,
          tone: "warn",
        });
        logEvent("ixbrowser_desktop_login_required_during_recovery", {
          endpoint,
          timeoutMs,
        });
      }
    }
  }

  const timeoutErr = lastErr || firstErr || new Error("IXBrowser did not become ready.");
  timeoutErr.ixBrowserDesktopOpened = true;
  timeoutErr.ixBrowserDesktopPath = recovery.path;
  timeoutErr.ixBrowserAutoRetry = true;
  if (timeoutErr.publicError === "ixbrowser_login_required") {
    timeoutErr.message = `${timeoutErr.message} IXBrowser desktop is open; log in there, then run the test again if the wait timed out.`;
  } else {
    timeoutErr.message = `IXBrowser did not become ready after ${Math.ceil(timeoutMs / 1000)} seconds. Keep IXBrowser open and logged in, then run the test again. Last error: ${timeoutErr.message}`;
  }
  logEvent("ixbrowser_desktop_recovery_wait_timeout", {
    endpoint,
    waitedMs: Date.now() - startedAt,
    attempts,
    error: oneLineField(timeoutErr.message || String(timeoutErr), 500),
  });
  persistTestRunStepProgress({
    title: "IXBrowser still not ready",
    percent: 86,
    detail: oneLineField(timeoutErr.message || String(timeoutErr), 1000),
    tone: "danger",
  });
  throw timeoutErr;
}

function isTransientIxBrowserServerError(err) {
  const code = Number(err?.ixBrowserCode || 0);
  // iX returns code 500 ("Internal Server Error") or 1008 ("Server busy")
  // intermittently when it's under load. Both are transient - a 2-4s pause
  // and one retry usually clears them.
  return code === 500 || code === 1008;
}

async function ixBrowserRequest(endpoint, payload = {}) {
  try {
    return await ixBrowserRequestOnce(endpoint, payload);
  } catch (err) {
    if (isTransientIxBrowserServerError(err)) {
      logEvent("ixbrowser_transient_500_retrying", {
        endpoint,
        ixCode: err.ixBrowserCode,
        errorText: oneLineField(err.message || String(err), 200),
      });
      await sleep(2500);
      try {
        const retryResult = await ixBrowserRequestOnce(endpoint, payload);
        logEvent("ixbrowser_transient_500_recovered", { endpoint, ixCode: err.ixBrowserCode });
        return retryResult;
      } catch (retryErr) {
        if (isTransientIxBrowserServerError(retryErr)) {
          await sleep(4000);
          try {
            const retry2Result = await ixBrowserRequestOnce(endpoint, payload);
            logEvent("ixbrowser_transient_500_recovered_on_second_retry", { endpoint, ixCode: retryErr.ixBrowserCode });
            return retry2Result;
          } catch (retry2Err) {
            const hint = "iX desktop is failing this endpoint repeatedly. Close all iX profile windows in the iX desktop app, then close+reopen iX desktop itself, log in, and re-launch the test.";
            logEvent("ixbrowser_transient_500_unrecoverable", {
              endpoint,
              ixCode: retry2Err.ixBrowserCode,
              errorText: oneLineField(retry2Err.message || String(retry2Err), 200),
              hint,
            });
            // Attach the actionable hint to the error message so the UI surfaces it.
            retry2Err.message = `${retry2Err.message} | ${hint}`;
            throw retry2Err;
          }
        }
        throw retryErr;
      }
    }
    const canTryDesktopOpen = isRecoverableIxBrowserDesktopError(err);
    if (!canTryDesktopOpen) throw err;
    const recovery = openIxBrowserDesktop(err.publicError || "ixbrowser_request_failed");
    if (!recovery.opened) {
      err.ixBrowserDesktopOpened = false;
      err.ixBrowserDesktopPath = recovery.path;
      err.ixBrowserAutoRetry = false;
      throw err;
    }
    return await waitForIxBrowserDesktopRecovery(endpoint, payload, recovery, err);
  }
}

// Quick preflight: confirm iX desktop API is up + logged in BEFORE starting
// a posting run. Calls a cheap profile-list with a single retry, fails fast
// with a clear "please open and log in" message if iX is unreachable/logged
// out. Avoids burning 60s+ per profile attempt on doomed recovery loops.
async function ixBrowserPreflightCheck() {
  const start = Date.now();
  try {
    const probe = await ixBrowserRequestOnce("profile-list", { page: 1, limit: 1 });
    logEvent("ixbrowser_preflight_ok", { tookMs: Date.now() - start, hasProfiles: Array.isArray(probe?.data) ? probe.data.length > 0 : true });
    return true;
  } catch (err) {
    const code = Number(err?.ixBrowserCode || 0);
    const loginRequired = err?.publicError === "ixbrowser_login_required" || code === 10002;
    const networkDown = err?.publicError === "external_network_error" || /127\.0\.0\.1|localhost|ECONNREFUSED|ETIMEDOUT/i.test(err?.message || "");
    let message;
    if (loginRequired) {
      message = "IXBrowser is logged out. Open the IXBrowser desktop app, sign in, keep it running, then re-launch the test.";
    } else if (networkDown) {
      message = "IXBrowser desktop is not running or not reachable on 127.0.0.1:53200. Open the IXBrowser desktop app, sign in, keep it running, then re-launch the test.";
    } else {
      message = `IXBrowser preflight failed: ${err?.message || String(err)}. Open the IXBrowser desktop app, sign in, then re-launch the test.`;
    }
    const e = new Error(message);
    e.statusCode = loginRequired ? 409 : 503;
    e.publicError = loginRequired ? "ixbrowser_login_required" : "ixbrowser_desktop_unavailable";
    e.preflightMs = Date.now() - start;
    logEvent("ixbrowser_preflight_failed", {
      tookMs: e.preflightMs,
      reason: e.publicError,
      hint: oneLineField(message, 400),
      underlyingError: oneLineField(err?.message || String(err), 300),
    });
    throw e;
  }
}

function ixBrowserError(error) {
  const code = Number(error?.code || 0);
  const rawMessage = String(error?.message || `IXBrowser error ${code}`);
  const loginRequired = code === 10002 || /重新登录|請重新登入|请重新登录|login/i.test(rawMessage);
  const profileMissing = code === 2007 || /profile does not exist|profile not found|配置文件不存在/i.test(rawMessage);
  const profileOpenFailed = code === 1004 || /profile open failed|配置文件打开失败/i.test(rawMessage);
  const message = loginRequired
    ? "IXBrowser login required. Open the IXBrowser desktop app, log in again, keep it running, then click Test IXBrowser or Load IXBrowser Profiles."
    : profileMissing
      ? `IXBrowser profile no longer exists (error ${code}). Remove this profile from posting assignments and reload IXBrowser profiles.`
      : profileOpenFailed
        ? `IXBrowser could not open this profile (error ${code}). It may be locked by another open window or iX desktop is glitched. The system will try the next profile.`
        : `IXBrowser error ${code}: ${rawMessage}`;
  const err = new Error(message);
  err.statusCode = loginRequired ? 409 : profileMissing ? 404 : 502;
  err.publicError = loginRequired
    ? "ixbrowser_login_required"
    : profileMissing
      ? "ixbrowser_profile_missing"
      : profileOpenFailed
        ? "ixbrowser_profile_open_failed"
        : "ixbrowser_error";
  err.ixBrowserCode = code;
  return err;
}

function ixBrowserProfileRows(payload) {
  if (Array.isArray(payload)) return { total: payload.length, profiles: payload };
  if (payload && Array.isArray(payload.data)) {
    return { total: Number(payload.total || payload.data.length), profiles: payload.data };
  }
  if (payload && Array.isArray(payload.list)) {
    return { total: Number(payload.total || payload.list.length), profiles: payload.list };
  }
  return { total: 0, profiles: [] };
}

function sanitizeIxBrowserProfile(profile = {}) {
  return {
    profile_id: profile.profile_id || profile.id || "",
    id: profile.id || profile.profile_id || "",
    name: profile.name || profile.title || "",
    site_url: profile.site_url || "",
    note: profile.note || "",
    color: profile.color || "",
    group_id: profile.group_id || "",
    group_name: profile.group_name || "",
    tag_id: profile.tag_id || "",
    tag_name: profile.tag_name || "",
    proxy_mode: profile.proxy_mode || "",
    proxy_type: profile.proxy_type || "",
    real_ip: profile.real_ip ? maskHost(profile.real_ip) : "",
    last_open_time: profile.last_open_time || "",
  };
}

function requireExternalArmed() {
  if (!readState().operator.armedForExternalActions) {
    const err = new Error("External actions are locked. Arm external actions first.");
    err.statusCode = 409;
    err.publicError = "external_actions_locked";
    throw err;
  }
}

function liveConfirmationText(body = {}) {
  return String(
    body.liveConfirmation ||
    body.live_confirmation ||
    body.confirmationText ||
    body.confirmation_text ||
    "",
  ).trim().toUpperCase();
}

function assertLiveRunConfirmation(body = {}, expected, label) {
  if (liveConfirmationText(body) === expected) return;
  const err = new Error(`Typed confirmation required for ${label}. Type ${expected} in the dashboard confirmation prompt.`);
  err.statusCode = 409;
  err.publicError = "live_confirmation_required";
  err.expectedConfirmation = expected;
  err.liveAction = label;
  throw err;
}

async function getWebshareProxies() {
  const secrets = readSecrets();
  const mode = secrets.webshare.mode === "backbone" ? "backbone" : "direct";
  const payload = await webshareRequest(`/proxy/list/?mode=${encodeURIComponent(mode)}&page=1&page_size=50`);
  if (!payload || !Array.isArray(payload.results)) {
    const err = new Error("Webshare proxy list response had an unexpected shape.");
    err.statusCode = 502;
    err.publicError = "webshare_bad_response";
    throw err;
  }
  return payload;
}

function sanitizeWebshareProxyList(proxies) {
  return (proxies || []).map((proxy) => {
    try {
      return sanitizeWebshareProxy(proxy);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > 2_000_000) {
        const err = new Error("Request body too large.");
        err.statusCode = 413;
        err.publicError = "request_body_too_large";
        req.destroy();
        reject(err);
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function assertDashboardRequest(req, url) {
  const origin = req.headers.origin;
  const allowedOrigins = new Set([
    `http://${HOST}:${PORT}`,
    `http://localhost:${PORT}`,
  ]);
  if (origin && !allowedOrigins.has(origin)) {
    const err = new Error("Request origin is not allowed");
    err.statusCode = 403;
    err.publicError = "dashboard_origin_forbidden";
    throw err;
  }
  if (url.pathname.startsWith("/api/") && req.headers["x-dashboard-token"] !== SESSION_TOKEN) {
    const err = new Error("Dashboard token is missing or invalid");
    err.statusCode = 403;
    err.publicError = "dashboard_token_invalid";
    throw err;
  }
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error("Invalid JSON body");
    err.statusCode = 400;
    throw err;
  }
}

function buildPrompt(job) {
  const state = readState();
  let miroContext = "";
  if (state.memory?.includeMiroContext) {
    try {
      miroContext = fs.readFileSync(MIRO_CONTEXT_FILE, "utf8").trim();
    } catch {
      miroContext = "Miro schema context file is missing.";
    }
  } else {
    miroContext = "Miro context disabled by dashboard memory settings.";
  }
  let finalProcess = "";
  if (state.memory?.includeMiroContext) {
    try {
      finalProcess = fs.readFileSync(FINAL_PROCESS_FILE, "utf8").trim();
    } catch {
      finalProcess = "Final Miro process read file is missing.";
    }
  } else {
    finalProcess = "Final Miro process context disabled by dashboard memory settings.";
  }

  const safeState = buildPromptState(state);
  return [
    "You are Hermes running from the local Facebook Agent dashboard.",
    "",
    "Project context from the visible Miro schema:",
    miroContext,
    "",
    "Final process read:",
    finalProcess,
    "",
    "Current local dashboard workflow state:",
    JSON.stringify(safeState, null, 2),
    "",
    "Prompt-safety note:",
    "Dashboard free-text fields are summarized and prompt-like instruction lines are redacted before they reach Hermes.",
    "",
    "Safety rules:",
    "- Do not collect, print, or store passwords, cookies, tokens, or session secrets.",
    "- Do not spam, mass-message, scrape private data, evade platform limits, or impersonate people.",
    "- For posting, commenting, DMs, account changes, ads, or anything irreversible, produce a plan and wait for explicit human approval.",
    "- Moderator/admin IXBrowser profiles are approval-only. Use them only to approve pending group posts, then switch back to normal non-moderator profiles for first comments.",
    "- Posting fallback: if a selected Facebook group does not allow the selected profile to post, try another saved group URL from the same approved plan. If none works, skip that profile for the run and record the issue locally with profile id/name at /api/posting/profile-group-issue. Do not bypass platform limits.",
    "- Work only from the task details below. If access is missing, say exactly what is missing.",
    "",
    `Job title: ${job.title || "Untitled job"}`,
    `Mode: ${job.mode || "plan"}`,
    "",
    "Task:",
    job.text || "",
    "",
    "Return concise status, decisions, and next steps. If files are created or edited, list exact paths.",
  ].join("\n");
}

function buildPromptState(state) {
  const copy = JSON.parse(JSON.stringify(state));
  const warnings = [];
  const maxUrlLines = clampNumber(state.memory?.maxPromptUrlLines, 10, 500, 80);
  const maxTextLines = clampNumber(state.memory?.maxPromptTextLines, 10, 1000, 120);
  const maxTextLength = clampNumber(state.memory?.maxPromptTextLineLength, 80, 1000, 260);
  const productUrls = summarizeUrlLines(state.productAssets?.productUrls, { maxLines: maxUrlLines, allowProjectPath: false, warnings });
  const reviewImageCandidates = summarizeUrlLines(state.productAssets?.reviewImageCandidates, { maxLines: maxUrlLines, allowProjectPath: true, warnings });
  const selectedReviewImages = summarizeUrlLines(state.productAssets?.selectedReviewImages, { maxLines: maxUrlLines, allowProjectPath: true, warnings });
  const discoveryGeneratedSourceUrls = summarizeUrlLines(state.productDiscovery?.generatedSourceUrls, { maxLines: maxUrlLines, allowProjectPath: false, warnings });
  const discoveryOtherStoreSourceUrls = summarizeUrlLines(state.productDiscovery?.otherStoreSourceUrls, { maxLines: maxUrlLines, allowProjectPath: false, warnings });
  const postTexts = summarizePromptLines(state.contentRotation?.postTexts, { maxLines: maxTextLines, maxLineLength: maxTextLength, warnings });
  const commentLeadIns = summarizePromptLines(state.contentRotation?.commentLeadIns, { maxLines: maxTextLines, maxLineLength: Math.min(maxTextLength, 260), warnings });

  copy.productAssets = {
    ...copy.productAssets,
    productUrls,
    reviewImageCandidates,
    selectedReviewImages,
    notes: summarizePromptLines(state.productAssets?.notes, { maxLines: 8, maxLineLength: 300, warnings }),
  };
  copy.productDiscovery = {
    ...copy.productDiscovery,
    walmartCategorySources: summarizePromptLines(state.productDiscovery?.walmartCategorySources, { maxLines: maxUrlLines, maxLineLength: 500, warnings }),
    walmartSearchQueries: summarizePromptLines(state.productDiscovery?.walmartSearchQueries, { maxLines: maxTextLines, maxLineLength: 180, warnings }),
    otherStoreSourceUrls: discoveryOtherStoreSourceUrls,
    generatedSourceUrls: discoveryGeneratedSourceUrls,
    rankingRules: summarizePromptLines(state.productDiscovery?.rankingRules, { maxLines: 12, maxLineLength: 280, warnings }),
    notes: summarizePromptLines(state.productDiscovery?.notes, { maxLines: 8, maxLineLength: 300, warnings }),
  };
  copy.contentRotation = {
    ...copy.contentRotation,
    postTexts,
    commentLeadIns,
    notes: summarizePromptLines(state.contentRotation?.notes, { maxLines: 8, maxLineLength: 300, warnings }),
  };
  redactPromptNetworkState(copy, state, warnings);
  copy.promptInputWarnings = warnings.slice(0, 80);
  return copy;
}

function redactPromptNetworkState(copy, state, warnings) {
  const profileLineLimit = Math.min(clampNumber(state.memory?.maxPromptTextLines, 10, 1000, 120), 80);
  if (copy.affiliateProxy) {
    for (const key of ["selectedProxyId", "proxyAddress", "proxyPort", "lastObservedIp"]) {
      if (copy.affiliateProxy[key]) copy.affiliateProxy[key] = "[REDACTED network metadata]";
    }
  }
  if (copy.webshare) {
    copy.webshare.currentIp = copy.webshare.currentIp ? "[REDACTED network metadata]" : "";
    copy.webshare.failedIps = {
      count: countNonCommentLines(state.webshare?.failedIps),
      redacted: true,
    };
  }
  if (copy.ixbrowser) {
    copy.ixbrowser.profileIpMap = {
      count: countNonCommentLines(state.ixbrowser?.profileIpMap),
      redacted: true,
    };
    copy.ixbrowser.activeProfiles = summarizePromptLines(redactNetworkIdentifiers(state.ixbrowser?.activeProfiles), {
      maxLines: profileLineLimit,
      maxLineLength: 220,
      warnings,
    });
    copy.ixbrowser.profilesForNextRun = summarizePromptLines(redactNetworkIdentifiers(state.ixbrowser?.profilesForNextRun), {
      maxLines: profileLineLimit,
      maxLineLength: 220,
      warnings,
    });
    copy.ixbrowser.moderatorProfiles = summarizePromptLines(redactNetworkIdentifiers(state.ixbrowser?.moderatorProfiles), {
      maxLines: profileLineLimit,
      maxLineLength: 220,
      warnings,
    });
    copy.ixbrowser.failedProfiles = summarizePromptLines(redactNetworkIdentifiers(state.ixbrowser?.failedProfiles), {
      maxLines: profileLineLimit,
      maxLineLength: 260,
      warnings,
    });
  }
  if (copy.posting) {
    copy.posting.facebookProfileStatus = summarizePromptLines(redactNetworkIdentifiers(state.posting?.facebookProfileStatus), {
      maxLines: profileLineLimit,
      maxLineLength: 260,
      warnings,
    });
  }
  warnings.push("Redacted proxy/IP metadata before sending workflow state to Hermes.");
}

function redactNetworkIdentifiers(value) {
  return String(value || "")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[REDACTED_IP]")
    .replace(/\bproxy(?:_id)?=([^\s|]+)/gi, "proxy=[REDACTED]");
}

function countNonCommentLines(value) {
  return String(value || "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#")).length;
}

function summarizePromptLines(value, options = {}) {
  const maxLines = options.maxLines || 40;
  const maxLineLength = options.maxLineLength || 240;
  const warnings = options.warnings || [];
  const lines = String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const kept = [];
  for (const [index, line] of lines.slice(0, maxLines).entries()) {
    if (PROMPT_INJECTION_PATTERN.test(line)) {
      warnings.push(`Redacted prompt-like text at line ${index + 1}.`);
      kept.push("[REDACTED prompt-like instruction]");
      continue;
    }
    kept.push(line.slice(0, maxLineLength));
  }
  if (lines.length > maxLines) warnings.push(`Truncated ${lines.length - maxLines} extra text lines.`);
  return { count: lines.length, lines: kept };
}

function summarizeUrlLines(value, options = {}) {
  const maxLines = options.maxLines || 80;
  const warnings = options.warnings || [];
  const lines = String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const kept = [];
  let invalid = 0;
  for (const line of lines.slice(0, maxLines)) {
    const safe = parseSafeAssetLine(line, options.allowProjectPath);
    if (safe) kept.push(safe);
    else invalid += 1;
  }
  if (invalid) warnings.push(`Ignored ${invalid} invalid URL/path line(s).`);
  if (lines.length > maxLines) warnings.push(`Truncated ${lines.length - maxLines} extra URL/path lines.`);
  return { count: lines.length, validCount: kept.length, lines: kept };
}

function parseSafeAssetLine(line, allowProjectPath) {
  if (PROMPT_INJECTION_PATTERN.test(line)) return null;
  try {
    const url = new URL(line);
    if (url.protocol !== "https:") return null;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    if (!allowProjectPath) return null;
    if (/^[a-zA-Z]:[\\/]/.test(line) || line.startsWith("\\\\") || line.includes("..")) return null;
    const resolved = safeProjectPath(line);
    return path.relative(ROOT, resolved).replaceAll(path.sep, "/");
  }
}

function runPowerShellJson(script) {
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${error.message}${stderr ? `\n${stderr}` : ""}`;
        reject(error);
        return;
      }
      try {
        resolve(JSON.parse(stdout || "{}"));
      } catch (err) {
        err.message = `Could not parse PowerShell JSON: ${err.message}`;
        reject(err);
      }
    });
  });
}

async function runSecurityAudit() {
  const script = `
$listeners = Get-NetTCPConnection -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess,@{Name='ProcessName';Expression={(Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName}}
$firewall = Get-NetFirewallProfile | Select-Object Name,Enabled,DefaultInboundAction,DefaultOutboundAction
$hardeningRules = Get-NetFirewallRule -Group 'Facebook Agent Hardening' -ErrorAction SilentlyContinue | Select-Object DisplayName,Enabled,Direction,Action,Profile
$rdpConnections = Get-NetTCPConnection -LocalPort 3389 -State Established -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort,State,OwningProcess
$processes = Get-Process node,wsl,wslrelay -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,Path,StartTime
[pscustomobject]@{
  listeners = @($listeners)
  firewallProfiles = @($firewall)
  hardeningRules = @($hardeningRules)
  rdpConnections = @($rdpConnections)
  processes = @($processes)
} | ConvertTo-Json -Depth 5
`;
  const raw = await runPowerShellJson(script);
  const listeners = Array.isArray(raw.listeners) ? raw.listeners : raw.listeners ? [raw.listeners] : [];
  const firewallProfiles = Array.isArray(raw.firewallProfiles) ? raw.firewallProfiles : raw.firewallProfiles ? [raw.firewallProfiles] : [];
  const hardeningRules = Array.isArray(raw.hardeningRules) ? raw.hardeningRules : raw.hardeningRules ? [raw.hardeningRules] : [];
  const rdpConnections = Array.isArray(raw.rdpConnections) ? raw.rdpConnections : raw.rdpConnections ? [raw.rdpConnections] : [];
  const processes = Array.isArray(raw.processes) ? raw.processes : raw.processes ? [raw.processes] : [];
  const warnings = buildSecurityWarnings(listeners, firewallProfiles, hardeningRules, rdpConnections);
  const report = {
    at: new Date().toISOString(),
    dashboard: {
      url: `http://${HOST}:${PORT}`,
      localOnly: listeners.some((item) => Number(item.LocalPort) === PORT && item.LocalAddress === HOST),
      tokenRequired: true,
      crossOriginRejected: true,
    },
    warnings,
    listeners,
    firewallProfiles,
    hardeningRules,
    rdpConnections: rdpConnections.map((item) => ({
      LocalAddress: item.LocalAddress,
      LocalPort: item.LocalPort,
      RemoteAddress: maskHost(item.RemoteAddress),
      State: item.State,
      OwningProcess: item.OwningProcess,
    })),
    processes,
    references: [
      "OWASP GenAI/LLM: prompt injection and insecure output handling",
      "Promptfoo: local red-team scans for prompt injection/data leakage",
      "Anthropic claude-code-security-review: diff-aware semantic security review",
      "Gitleaks/Semgrep: secrets and static analysis",
    ],
  };
  logEvent("security_audit_completed", { warningCount: warnings.length });
  return report;
}

function buildSecurityWarnings(listeners, firewallProfiles, hardeningRules = [], rdpConnections = []) {
  const warnings = [];
  const seenWarnings = new Set();
  const pushWarning = (warning) => {
    const key = [warning.severity, warning.port || "", warning.profile || "", warning.message].join("|");
    if (seenWarnings.has(key)) return;
    seenWarnings.add(key);
    warnings.push(warning);
  };
  const loopback = new Set(["127.0.0.1", "::1", "localhost"]);
  const hardeningEnabled = (displayName) => hardeningRules.some((rule) => String(rule.DisplayName || "") === displayName && Boolean(rule.Enabled));
  const blockedByHardening = (port) => {
    if ([135, 139, 445].includes(port)) return hardeningEnabled("FAH Block SMB RPC TCP");
    if ([5357, 5358].includes(port)) return hardeningEnabled("FAH Block Device Discovery TCP");
    if (port >= 49152) return hardeningEnabled("FAH Block Dynamic RPC TCP");
    return false;
  };
  const externallyReachable = listeners.filter((item) => {
    const address = String(item.LocalAddress || "");
    return !loopback.has(address);
  });
  for (const item of externallyReachable) {
    const port = Number(item.LocalPort);
    const processName = item.ProcessName || `pid ${item.OwningProcess}`;
    if (port === PORT) {
      pushWarning({ severity: "critical", port, processName, message: "Dashboard port is exposed beyond localhost. Stop it and restart bound to 127.0.0.1." });
    } else if (port === 3389) {
      const activeCount = rdpConnections.length;
      const allowListActive = hardeningEnabled("FAH Allow RDP From Approved IPs");
      pushWarning({
        severity: allowListActive ? "low" : "high",
        port,
        processName,
        message: allowListActive
          ? "RDP is restricted by the Facebook Agent Hardening allow-list rule."
          : `RDP is listening on all interfaces with ${activeCount} established connection(s). Restrict it to your approved public IP or VPN before disabling broad access.`,
      });
    } else if ([135, 139, 445].includes(port)) {
      if (blockedByHardening(port)) {
        pushWarning({ severity: "low", port, processName, message: "Windows RPC/SMB-style service is listening, but an inbound hardening block rule is active." });
      } else {
        pushWarning({ severity: "high", port, processName, message: "Windows RPC/SMB-style service is listening externally. Restrict to trusted networks if not required." });
      }
    } else if (port === 5357) {
      if (blockedByHardening(port)) {
        pushWarning({ severity: "low", port, processName, message: "Windows device/service discovery endpoint is listening, but an inbound hardening block rule is active." });
      } else {
        pushWarning({ severity: "medium", port, processName, message: "Windows device/service discovery endpoint is externally reachable. Disable or firewall if not needed." });
      }
    } else if (port >= 49152) {
      if (blockedByHardening(port)) {
        pushWarning({ severity: "low", port, processName, message: "Dynamic Windows service port is listening, but an inbound hardening block rule is active." });
      } else {
        pushWarning({ severity: "medium", port, processName, message: "Dynamic Windows service port is externally reachable. Review service necessity and firewall scope." });
      }
    }
  }
  for (const profile of firewallProfiles) {
    if (!profile.Enabled) {
      pushWarning({ severity: "high", profile: profile.Name, message: "Windows Firewall profile is disabled." });
    }
  }
  if (!listeners.some((item) => Number(item.LocalPort) === PORT && item.LocalAddress === HOST)) {
    pushWarning({ severity: "critical", port: PORT, message: "Dashboard listener was not found on 127.0.0.1." });
  }
  return warnings;
}

function updateJob(id, patch) {
  const jobs = readJobs();
  const index = jobs.findIndex((job) => job.id === id);
  if (index === -1) return null;
  jobs[index] = { ...jobs[index], ...patch, updatedAt: new Date().toISOString() };
  writeJobs(jobs);
  return jobs[index];
}

function resetInterruptedJobs() {
  const jobs = readJobs();
  let changed = false;
  for (const job of jobs) {
    if (job.status === "running") {
      job.status = "failed";
      job.error = `${job.error || ""}\nDashboard restarted while this job was running.`.trim();
      job.finishedAt = new Date().toISOString();
      job.updatedAt = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) writeJobs(jobs);
}

function capOutput(value) {
  if (value.length <= MAX_JOB_OUTPUT) return value;
  return value.slice(value.length - MAX_JOB_OUTPUT);
}

function runJob(job) {
  if (active) return false;

  const state = readState();
  if (jobNeedsQueueApproval(job, state) && job.queueApprovalStatus !== "approved") {
    heartbeat.status = "waiting_approval";
    logEvent("job_waiting_for_human_approval", { jobId: job.id, title: job.title });
    return false;
  }
  const runtimeMinutes = clampNumber(state.memory?.maxJobRuntimeMinutes, 1, 240, 30);
  const prompt = buildPrompt(job);
  const args = [
    "-d", "Ubuntu-24.04",
    "--exec", "/bin/bash", "-lc",
    `cd "$1" && ${HERMES_BIN} -z "$2"`,
    "hermes-runner",
    WSL_PROJECT,
    prompt,
  ];

  updateJob(job.id, {
    status: "running",
    startedAt: new Date().toISOString(),
    output: "",
    error: "",
    approvalRequired: job.approvalRequired !== false && readState().operator.approvalRequired,
  });
  logEvent("job_started", { jobId: job.id, title: job.title });

  const child = spawn("wsl.exe", args, {
    cwd: ROOT,
    windowsHide: true,
  });

  const runtimeTimer = setTimeout(() => {
    updateJob(job.id, {
      status: "failed",
      error: `Hermes job timed out after ${runtimeMinutes} minute(s).`,
      finishedAt: new Date().toISOString(),
    });
    logEvent("job_timeout", { jobId: job.id, runtimeMinutes });
    child.kill("SIGTERM");
  }, runtimeMinutes * 60 * 1000);

  active = { id: job.id, child, startedAt: Date.now(), runtimeTimer };
  heartbeat.activeJobId = job.id;
  heartbeat.status = "running";

  let output = "";
  let error = "";
  child.stdout.on("data", (chunk) => {
    output = capOutput(output + chunk.toString());
    updateJob(job.id, { output });
  });
  child.stderr.on("data", (chunk) => {
    error = capOutput(error + chunk.toString());
    updateJob(job.id, { error });
  });
  child.on("exit", (code) => {
    clearTimeout(runtimeTimer);
    const current = readJobs().find((item) => item.id === job.id);
    if (current?.finishedAt && ["stopped", "failed"].includes(current.status)) {
      logEvent("job_already_finalized", { jobId: job.id, status: current.status, exitCode: code });
      active = null;
      heartbeat.activeJobId = null;
      heartbeat.status = enabled ? "enabled" : "idle";
      return;
    }
    const status = code === 0 ? "done" : "failed";
    updateJob(job.id, {
      status,
      exitCode: code,
      finishedAt: new Date().toISOString(),
      output,
      error,
    });
    logEvent("job_finished", { jobId: job.id, status, exitCode: code });
    active = null;
    heartbeat.activeJobId = null;
    heartbeat.status = enabled ? "enabled" : "idle";
    if (enabled && readState().triggers.autoStartQueuedJobs) setTimeout(processQueue, 500);
  });
  child.on("error", (err) => {
    clearTimeout(runtimeTimer);
    updateJob(job.id, { status: "failed", error: String(err), finishedAt: new Date().toISOString() });
    logEvent("job_error", { jobId: job.id, error: String(err) });
    active = null;
  });
  return true;
}

function processQueue() {
  if (!enabled || active) return;
  const state = readState();
  if (state.operator.scheduleEnabled && !withinSchedule(state.operator.startTime, state.operator.stopTime, state.operator.scheduleTimezone, state.operator.runDays)) {
    heartbeat.status = "scheduled";
    return;
  }
  const jobs = readJobs();
  const next = jobs.find((job) => job.status === "queued" && (!jobNeedsQueueApproval(job, state) || job.queueApprovalStatus === "approved"));
  if (next) runJob(next);
  else if (jobs.some((job) => job.status === "queued")) heartbeat.status = "waiting_approval";
}

function withinSchedule(startTime, stopTime, timezone, runDays) {
  const nowParts = zonedNowParts(timezone);
  const allowedDays = parseRunDays(runDays);
  if (allowedDays.size && !allowedDays.has(nowParts.weekday)) return false;
  if (!startTime || !stopTime) return true;
  const now = new Date();
  const current = Number.isFinite(nowParts.hour) ? nowParts.hour * 60 + nowParts.minute : now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = stopTime.split(":").map(Number);
  const start = sh * 60 + sm;
  const stop = eh * 60 + em;
  if (!Number.isFinite(start) || !Number.isFinite(stop)) return true;
  if (start <= stop) return current >= start && current <= stop;
  return current >= start || current <= stop;
}

// The effective autopilot POSTING WINDOW. Priority: an explicit operator schedule (if
// enabled) wins; otherwise the peak-hours window (rules.peakStartTime/peakStopTime) acts as
// the start/end time — post inside it, deep-prepare tomorrow once it ends; otherwise 24/7.
function autopilotPostingWindowOpen(state = readState()) {
  if (state.operator?.scheduleEnabled) {
    return withinSchedule(state.operator?.startTime, state.operator?.stopTime, state.operator?.scheduleTimezone, state.operator?.runDays);
  }
  const ps = state.rules?.peakStartTime;
  const pe = state.rules?.peakStopTime;
  if (ps && pe) {
    return withinSchedule(ps, pe, state.rules?.peakHoursTimezone || state.operator?.scheduleTimezone, state.operator?.runDays);
  }
  return true;
}

function zonedNowParts(timezone) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || "America/New_York",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date());
    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return {
      weekday: normalizeWeekday(map.weekday),
      hour: Number(map.hour),
      minute: Number(map.minute),
    };
  } catch {
    const now = new Date();
    return {
      weekday: normalizeWeekday(now.toLocaleDateString("en-US", { weekday: "short" })),
      hour: now.getHours(),
      minute: now.getMinutes(),
    };
  }
}

function parseRunDays(value) {
  const tokens = String(value || "").split(/[\s,;]+/).map(normalizeWeekday).filter(Boolean);
  return new Set(tokens);
}

function normalizeWeekday(value) {
  const key = String(value || "").slice(0, 3).toLowerCase();
  const map = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
  return map[key] || "";
}

// Short-lived cache for the ixBrowser profile list. The dashboard auto-loads this on every
// open/tab-switch and each cold call costs ~500-750ms (network to the local ixBrowser API).
// A 45s TTL + in-flight collapse makes repeat/multi-tab loads nearly free and stops the
// profile picker from hammering ixBrowser (a prior source of event-loop saturation).
let __ixProfilesCache = { at: 0, data: null, inflight: null };
const IX_PROFILES_CACHE_TTL_MS = 45000;

// Heavy status endpoints the dashboard polls. autopilotStatus()/assetBufferStatus() fan out into
// a per-profile x per-status-line x per-group-URL regex cascade that became pathologically slow as
// the status logs grew; polled by an open dashboard tab they pin the event loop and wedge the box.
// A long TTL means the heavy compute runs at most ~once/15s no matter how hard the UI polls.
let __autopilotStatusCache = { at: 0, body: null };
let __assetBufferStatusCache = { at: 0, body: null };
const STATUS_CACHE_TTL_MS = 300000;

let lastHeartbeatTick = 0;
setInterval(() => {
  // Per-post-log retention: low-frequency (>=6h) fire-and-forget sweep so the detail-log dir
  // stays bounded. Gated independently of the heartbeat throttle; never blocks (async).
  if (Date.now() - __lastPerPostLogSweep > PER_POST_LOG_SWEEP_INTERVAL_MS) {
    __lastPerPostLogSweep = Date.now();
    sweepPerPostLogs().catch(() => {});
  }
  const state = readState();
  const intervalMs = clampNumber(state.triggers?.heartbeatSeconds, 3, 120, 3) * 1000;
  if (Date.now() - lastHeartbeatTick < intervalMs) return;
  lastHeartbeatTick = Date.now();
  const scheduled = enabled && state.operator.scheduleEnabled && !withinSchedule(state.operator.startTime, state.operator.stopTime, state.operator.scheduleTimezone, state.operator.runDays);
  heartbeat = {
    ...heartbeat,
    lastBeat: new Date().toISOString(),
    enabled,
    activeJobId: active?.id || null,
    status: active ? "running" : scheduled ? "scheduled" : enabled ? "enabled" : "idle",
  };
}, 1000);

function serveStatic(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
    res.end(data);
  });
}

function serveIndex(res) {
  fs.readFile(path.join(ROOT, "web", "index.html"), "utf8", (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const html = data.replace("__DASHBOARD_TOKEN__", SESSION_TOKEN);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(html);
  });
}

resetInterruptedJobs();

const server = http.createServer(async (req, res) => {
  try {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  assertDashboardRequest(req, url);

  if (req.method === "GET" && url.pathname === "/") {
    return serveIndex(res);
  }
  if (req.method === "GET" && url.pathname === "/app.css") {
    return serveStatic(res, path.join(ROOT, "web", "app.css"), "text/css; charset=utf-8");
  }
  if (req.method === "GET" && url.pathname === "/app.js") {
    return serveStatic(res, path.join(ROOT, "web", "app.js"), "application/javascript; charset=utf-8");
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    let testRunMirror = null;
    try {
      const t = readState().testRun || {};
      if (t.active || ["running", "ready", "blocked"].includes(String(t.status || ""))) {
        testRunMirror = {
          status: t.status || "",
          active: Boolean(t.active),
          percent: Number(t?.progress?.percent || 0),
          title: oneLineField(t?.progress?.title || "1-post test", 120),
          detail: oneLineField(t?.progress?.detail || "", 240),
          tone: t?.progress?.tone || "",
          updatedAt: t.updatedAt || "",
        };
      }
    } catch {}
    const mergedHeartbeat = testRunMirror && testRunMirror.active
      ? { ...heartbeat, status: heartbeat.status === "running" ? heartbeat.status : "test_running", testRun: testRunMirror }
      : (testRunMirror ? { ...heartbeat, testRun: testRunMirror } : heartbeat);
    return json(res, 200, { heartbeat: mergedHeartbeat, enabled, active: active ? { id: active.id, startedAt: active.startedAt } : null, testRun: testRunMirror });
  }
  if (req.method === "GET" && url.pathname === "/api/jobs") {
    return json(res, 200, { jobs: readJobs(), events: recentEvents() });
  }
  if (req.method === "GET" && url.pathname === "/api/state") {
    return json(res, 200, { state: readState() });
  }
  if (req.method === "GET" && url.pathname === "/api/registers") {
    return json(res, 200, { registers: readRegisters() });
  }
  if (req.method === "GET" && url.pathname === "/api/approvals") {
    return json(res, 200, buildApprovalItems());
  }
  if (req.method === "GET" && url.pathname === "/api/secrets") {
    return json(res, 200, { secrets: publicSecrets() });
  }
  if (req.method === "GET" && url.pathname === "/api/integrations/health") {
    return json(res, 200, buildIntegrationHealth());
  }
  if (req.method === "GET" && url.pathname === "/api/content-sources/harvested") {
    const st = readState();
    const rows = readHarvestedProducts(st).map((r) => ({
      productKey: r.productKey,
      firstCommentUrl: r.firstCommentUrl,
      text: r.text || "",
      sourceGroupUrl: r.sourceGroupUrl || "",
      harvestedAt: r.harvestedAt || "",
      posted: r.posted || "",
      postUrl: r.postUrl || "",
      imageDeleted: !!r.imageDeleted,
      hasImage: Boolean(r.imageLocalPath && !r.imageDeleted && (() => { try { return fs.existsSync(safeProjectPath(r.imageLocalPath)); } catch { return false; } })()),
    })).reverse(); // newest first
    return json(res, 200, { harvested: rows, total: rows.length });
  }
  if (req.method === "GET" && url.pathname === "/api/content-sources/harvested-image") {
    const rec = harvestedRecordForKey(url.searchParams.get("key") || "");
    if (!rec || !rec.imageLocalPath || rec.imageDeleted) { res.writeHead(404); return res.end("no image"); }
    try {
      const fp = safeProjectPath(rec.imageLocalPath);
      if (!fs.existsSync(fp)) { res.writeHead(404); return res.end("image gone (deleted after posting)"); }
      res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store" });
      return res.end(fs.readFileSync(fp));
    } catch (e) { res.writeHead(500); return res.end("error"); }
  }
  if (req.method === "GET" && url.pathname === "/api/products/discovered") {
    // WEB-SCRAPING products (Walmart/Amazon discovery) saved in product-candidates.jsonl, newest-first, deduped.
    const st = readState();
    const registers = readRegisters();
    const usedKeys = recentlyUsedProductKeys(registers.usedProducts, st);
    const rows = readJsonlFile(st.files.productCandidates || "data/product-candidates.jsonl");
    const seen = new Set(); const out = [];
    for (let i = rows.length - 1; i >= 0 && out.length < 300; i -= 1) {
      const r = rows[i]; if (!r || !r.productKey) continue;
      const k = String(r.productKey).toLowerCase();
      if (seen.has(k)) continue; seen.add(k);
      out.push({
        productKey: r.productKey,
        title: r.title || "",
        url: r.url || "",
        store: r.store || "",
        imageUrl: r.imageUrl || "",
        status: r.status || "",
        used: usedKeys.has(k),
        lastSeenAt: r.lastSeenAt || r.at || "",
      });
    }
    return json(res, 200, { discovered: out, total: out.length });
  }
  if (req.method === "POST" && url.pathname === "/api/security/audit") {
    const report = await runSecurityAudit();
    const state = readState();
    state.security.lastAuditAt = report.at;
    writeState(state);
    if (state.triggers.pauseWhenSecurityWarnings && report.warnings.some((warning) => ["critical", "high"].includes(warning.severity))) {
      enabled = false;
      logEvent("worker_disabled_after_security_warning", { warningCount: report.warnings.length });
    }
    return json(res, 200, { report });
  }
  if (req.method === "PUT" && url.pathname === "/api/state") {
    const body = await readJson(req);
    const incoming = body.state || {};
    // ARM = a fresh run: when the operator transitions autopilotEnabled false->true, reset the
    // per-run post counter so the hard limiter (autopilotMaxPostsPerRun) counts THIS run only.
    try {
      const before = readState();
      const wasEnabled = before.operator?.autopilotEnabled === true;
      const nowEnabled = incoming.operator?.autopilotEnabled === true;
      incoming.operator = incoming.operator || {};
      if (!wasEnabled && nowEnabled) {
        incoming.operator.autopilotPostsThisRun = 0; // fresh arm => count THIS run only
        logEvent("autopilot_run_armed_counter_reset", { maxPostsPerRun: incoming.operator.autopilotMaxPostsPerRun });
      } else if (incoming.operator.autopilotPostsThisRun === undefined || incoming.operator.autopilotPostsThisRun === null) {
        // controlWrite skips the protected-preserve, so a PUT that omits the counter must NOT reset
        // it (that would orphan the hard limit). Preserve the running count unless explicitly set.
        // (before = readState() is already normalized/clamped, so prior is a valid finite number;
        // the explicit range guard is belt-and-suspenders against a corrupt counter.)
        const prior = before.operator?.autopilotPostsThisRun;
        incoming.operator.autopilotPostsThisRun = (Number.isFinite(prior) && prior >= 0 && prior <= 1000000) ? prior : 0;
      }
    } catch (_e) {}
    // controlWrite:true => the operator's explicit values for the protected control flags win.
    const state = writeState(incoming, { controlWrite: true });
    logEvent("workflow_state_saved");
    return json(res, 200, { state });
  }
  if (req.method === "POST" && url.pathname === "/api/test-progress") {
    const body = await readJson(req);
    const state = readState();
    state.testRun = sanitizeTestRunState(body.testRun || body);
    const nextState = writeState(state);
    logEvent("test_progress_saved", {
      status: nextState.testRun.status,
      active: nextState.testRun.active,
      percent: nextState.testRun.progress.percent,
    });
    return json(res, 200, { state: nextState, testRun: nextState.testRun });
  }
  if (req.method === "PUT" && url.pathname === "/api/registers") {
    const body = await readJson(req);
    const registers = writeRegisters(body.registers || {});
    logEvent("registers_saved");
    return json(res, 200, { registers });
  }
  if (req.method === "POST" && url.pathname === "/api/comment-limit/one-ip-attempt") {
    const body = await readJson(req);
    const result = writeCommentLimitAttempt(body);
    return json(res, 200, result);
  }
  if (req.method === "POST" && url.pathname === "/api/comment-limit/quarantine") {
    const body = await readJson(req);
    const result = writeCommentLimitQuarantine(body);
    return json(res, 200, result);
  }
  if (req.method === "POST" && url.pathname === "/api/approvals/decision") {
    const body = await readJson(req);
    return json(res, 200, recordApprovalDecision(body));
  }
  if (req.method === "POST" && url.pathname === "/api/jobs/approval") {
    const body = await readJson(req);
    return json(res, 200, approveQueuedJobs(body));
  }
  if (req.method === "PUT" && url.pathname === "/api/secrets") {
    const body = await readJson(req);
    const secrets = writeSecrets(body.secrets || {});
    writeState(applyApiStatusesToState(readState(), secrets));
    logEvent("secrets_saved");
    return json(res, 200, { secrets: publicSecrets(secrets) });
  }
  if (req.method === "POST" && url.pathname === "/api/integrations/webshare/test") {
    requireExternalArmed();
    const profile = await webshareRequest("/profile/");
    logEvent("webshare_test_ok");
    return json(res, 200, { ok: true, profile: { email: profile.email || null, username: profile.username || null } });
  }
  if (req.method === "POST" && url.pathname === "/api/integrations/webshare/proxies") {
    requireExternalArmed();
    const payload = await getWebshareProxies();
    const proxies = sanitizeWebshareProxyList(payload.results);
    logEvent("webshare_proxies_loaded", { count: proxies.length });
    return json(res, 200, { count: payload.count || proxies.length, proxies });
  }
  if (req.method === "POST" && url.pathname === "/api/integrations/webshare/assign-affiliate-proxy") {
    requireExternalArmed();
    const payload = await getWebshareProxies();
    const proxy = pickAffiliateProxy(payload.results || []);
    if (!proxy) return json(res, 404, { error: "no_matching_proxy", message: "No valid Webshare proxy matched the required country." });
    const affiliateProxy = writeAffiliateProxySelection(proxy);
    logEvent("affiliate_proxy_assigned", { proxyId: proxy.id || "", country: proxy.country_code || "", proxyAddress: proxy.proxy_address ? maskHost(proxy.proxy_address) : "" });
    return json(res, 200, { affiliateProxy });
  }
  if (req.method === "POST" && url.pathname === "/api/integrations/affiliate-proxy/test") {
    requireExternalArmed();
    const result = await testAffiliateProxy();
    logEvent("affiliate_proxy_tested", { status: result.status, observedCountry: result.observedCountry, observedIp: result.observedIp ? maskHost(result.observedIp) : "" });
    return json(res, 200, { result, affiliateProxy: sanitizeAffiliateProxyState() });
  }
  if (req.method === "POST" && url.pathname === "/api/integrations/chatgpt-browser/open") {
    const result = await openDedicatedChatGptBrowserForSetup();
    return json(res, 200, result);
  }
  if (req.method === "POST" && url.pathname === "/api/integrations/shopyourlikes-browser/open") {
    requireExternalArmed();
    const body = await readJson(req);
    const result = await openShopYourLikesBrowser(body);
    return json(res, result.ok === false ? 404 : 200, { result, state: readState(), affiliateProxy: sanitizeAffiliateProxyState() });
  }
  if (req.method === "POST" && url.pathname === "/api/integrations/shopyourlikes-browser/close") {
    requireExternalArmed();
    const result = await closeShopYourLikesBrowser("operator");
    return json(res, 200, { result, state: readState() });
  }
  if (req.method === "POST" && url.pathname === "/api/integrations/ixbrowser/test") {
    const data = await ixBrowserRequest("profile-list", { page: 1, limit: 1 });
    const rows = ixBrowserProfileRows(data);
    logEvent("ixbrowser_test_ok");
    return json(res, 200, { ok: true, sampleCount: rows.profiles.length, total: rows.total });
  }
  if (req.method === "POST" && url.pathname === "/api/integrations/ixbrowser/profiles") {
    const now = Date.now();
    if (__ixProfilesCache.data && now - __ixProfilesCache.at < IX_PROFILES_CACHE_TTL_MS) {
      return json(res, 200, { ...__ixProfilesCache.data, cached: true });
    }
    if (!__ixProfilesCache.inflight) {
      __ixProfilesCache.inflight = (async () => {
        const data = await ixBrowserRequest("profile-list", { page: 1, limit: 100 });
        const rows = ixBrowserProfileRows(data);
        const profiles = rows.profiles.map(sanitizeIxBrowserProfile);
        const payload = { count: rows.total || profiles.length, profiles };
        __ixProfilesCache = { at: Date.now(), data: payload, inflight: null };
        logEvent("ixbrowser_profiles_loaded", { count: profiles.length });
        return payload;
      })().catch((err) => { __ixProfilesCache.inflight = null; throw err; });
    }
    const payload = await __ixProfilesCache.inflight;
    return json(res, 200, payload);
  }
  if (req.method === "POST" && url.pathname === "/api/integrations/ixbrowser/open") {
    requireExternalArmed();
    const body = await readJson(req);
    const profileId = Number(body.profileId || body.profile_id);
    if (!profileId) return json(res, 400, { error: "profile_id_required" });
    if (isDedicatedShopYourLikesIxProfile(profileId)) {
      const opened = await ixBrowserOpenForCdp(profileId, {
        reason: "manual_dedicated_shopyourlikes_open",
        closeExistingBeforeOpen: false,
      });
      logEvent("ixbrowser_profile_opened", { profileId, reusedExistingWindow: Boolean(opened.reusedExistingWindow) });
      return json(res, 200, { result: opened.result });
    }
    const result = await withIxBrowserProfileOpenLock(profileId, async () => {
      const preOpenClose = await ixBrowserCloseAfterUse(profileId, "manual_ixbrowser_open_preopen_cleanup");
      assertIxBrowserPreOpenCleanupOk(preOpenClose, profileId, "manual_ixbrowser_open_preopen_cleanup");
      await sleep(700);
      const opened = await ixBrowserRequest("profile-open", {
        profile_id: profileId,
        load_extensions: true,
        load_profile_info_page: false,
        cookies_backup: true,
        args: ["--disable-extension-welcome-page"],
      });
      cacheIxBrowserCdpEndpoint(profileId, opened);
      return opened;
    });
    logEvent("ixbrowser_profile_opened", { profileId });
    return json(res, 200, { result });
  }
  if (req.method === "POST" && url.pathname === "/api/integrations/ixbrowser/open-assigned-group") {
    requireExternalArmed();
    const body = await readJson(req);
    const state = readState();
    const profileId = Number(body.profileId || body.profile_id);
    if (!profileId) return json(res, 400, { error: "profile_id_required" });
    assertNotDedicatedShopYourLikesIxProfile(profileId, "Facebook group/profile work");
    const profileNeedle = String(profileId).toLowerCase();
    const assignments = Array.isArray(state.posting?.groupAssignmentData) ? state.posting.groupAssignmentData : [];
    const assigned = assignments.find((entry) => (entry.profiles || []).some((profile) => String(profile || "").toLowerCase().startsWith(profileNeedle)));
    const assignedProfileLabel = (assigned?.profiles || []).find((profile) => String(profile || "").toLowerCase().startsWith(profileNeedle)) || String(profileId);
    if (isBlockedIxBrowserProfileLabel(assignedProfileLabel, state)) {
      return json(res, 409, { error: "ixbrowser_profile_name_blocked", message: `IXBrowser profile "${assignedProfileLabel}" is blocked by name and cannot be used for Facebook group/profile work.` });
    }
    const fallbackGroupUrl = recordLines(state.posting?.groups)[0] || "";
    const groupUrl = String(body.groupUrl || assigned?.url || fallbackGroupUrl || "").trim();
    let parsedGroupUrl;
    try {
      parsedGroupUrl = new URL(groupUrl);
    } catch {
      return json(res, 400, { error: "group_url_required", message: "No valid Facebook group URL is assigned or supplied." });
    }
    if (!/(^|\.)facebook\.com$/i.test(parsedGroupUrl.hostname) || !/^\/groups\//i.test(parsedGroupUrl.pathname)) {
      return json(res, 400, { error: "facebook_group_url_required", message: "Only https://www.facebook.com/groups/... URLs are allowed here." });
    }
    parsedGroupUrl.hash = "";
    const cleanGroupUrl = parsedGroupUrl.toString();
    const result = await withIxBrowserProfileOpenLock(profileId, async () => {
      const preOpenClose = await ixBrowserCloseAfterUse(profileId, "assigned_group_open_preopen_cleanup");
      assertIxBrowserPreOpenCleanupOk(preOpenClose, profileId, "assigned_group_open_preopen_cleanup");
      await sleep(700);
      const opened = await ixBrowserRequest("profile-open", {
        profile_id: profileId,
        load_extensions: true,
        load_profile_info_page: false,
        cookies_backup: true,
        args: ["--disable-popup-blocking", "--disable-extension-welcome-page", cleanGroupUrl],
      });
      cacheIxBrowserCdpEndpoint(profileId, opened);
      return opened;
    });
    logEvent("ixbrowser_assigned_group_opened", { profileId, groupUrl: cleanGroupUrl });
    return json(res, 200, { ok: true, profileId, groupUrl: cleanGroupUrl, result });
  }
  if (req.method === "POST" && url.pathname === "/api/integrations/ixbrowser/close") {
    requireExternalArmed();
    const body = await readJson(req);
    const profileId = Number(body.profileId || body.profile_id);
    if (!profileId) return json(res, 400, { error: "profile_id_required" });
    if (isDedicatedShopYourLikesIxProfile(profileId) && !body.forceDedicatedClose) {
      logEvent("ixbrowser_dedicated_shopyourlikes_close_skipped", { profileId });
      return json(res, 200, { ok: true, status: "kept_open_dedicated_shopyourlikes_profile", profileId });
    }
    ixBrowserCdpEndpointCache.delete(profileId);
    writeIxBrowserCdpCacheFile();
    const result = await ixBrowserRequest("profile-close", { profile_id: profileId });
    logEvent("ixbrowser_profile_closed", { profileId });
    return json(res, 200, { result });
  }
  if (req.method === "POST" && url.pathname === "/api/integrations/shopyourlikes-extension/generate") {
    requireExternalArmed();
    const body = await readJson(req);
    const result = await generateShopYourLikesExtensionLinks(body);
    return json(res, 200, result);
  }
  if (req.method === "POST" && url.pathname === "/api/integrations/shortlink/test") {
    requireExternalArmed();
    const result = await mavlynkRequest("/api/url/add", { body: { url: "https://example.com/" }, timeoutMs: 15000 });
    logEvent("shortlink_test_ok", { provider: "Mavlynk" });
    return json(res, 200, { ok: true, shortUrl: extractMavlynkShortUrl(result), result });
  }
  if (req.method === "POST" && url.pathname === "/api/integrations/shortlink/shorten") {
    requireExternalArmed();
    const body = await readJson(req);
    if (!body.url) return json(res, 400, { error: "url_required" });
    const { shortUrl, raw } = await createMavlynkShortlink(body.url);
    logEvent("shortlink_shortened", { url: body.url, shortUrl });
    return json(res, 200, { original: body.url, shortUrl, raw });
  }
  if (req.method === "POST" && url.pathname === "/api/integrations/shortlink/shorten-batch") {
    requireExternalArmed();
    const body = await readJson(req);
    const urls = Array.isArray(body.urls) ? body.urls : [body.url].filter(Boolean);
    if (urls.length === 0) return json(res, 400, { error: "urls_required" });
    const results = [];
    for (const url of urls) {
      try {
        const { shortUrl, raw } = await createMavlynkShortlink(url);
        results.push({ original: url, shortUrl, success: true, raw });
      } catch (err) {
        results.push({ original: url, success: false, error: err.message });
      }
    }
    const successes = results.filter((item) => item.success && item.shortUrl);
    let state = null;
    let saved = 0;
    let skipped = 0;
    if (body.saveToPosting && successes.length) {
      state = readState();
      if (state.affiliate?.enabled !== false) {
        const affiliateMappings = successes
          .map((item) => {
            const sylLink = String(item.original || "").trim();
            if (!isShopYourLikesUrl(sylLink)) return null;
            const productUrl = affiliateProductUrlForSylLink(sylLink, state);
            if (!productUrl) return null;
            return {
              productUrl,
              sylLink,
              shortUrl: item.shortUrl,
              source: "shortlink_batch_shopyourlikes",
            };
          })
          .filter(Boolean);
        const mappingResult = upsertAffiliateLinkMappings(state, affiliateMappings);
        saved = mappingResult.saved;
        skipped = successes.length - saved;
        if (saved) {
          state.posting.shortlinks = mappingResult.mappings.map((entry) => entry.shortUrl).join("\n");
        }
      } else {
        state.affiliate.finalShortlinks = appendUniqueLines(state.affiliate.finalShortlinks, successes.map((item) => item.shortUrl));
        state.posting.shortlinks = appendUniqueLines(state.posting.shortlinks, successes.map((item) => item.shortUrl));
        saved = successes.length;
      }
      if (skipped) {
        logEvent("shortlink_non_syl_not_saved_to_posting", { skipped, reason: "affiliate mode requires a ShopYourLikes URL mapped to a product URL" });
      }
      state = writeState(state);
    }
    logEvent("shortlink_batch_shortened", { count: results.length, saved });
    return json(res, 200, { state, results, saved, skipped });
  }
  if (req.method === "POST" && url.pathname === "/api/integrations/ixbrowser/apply-webshare-proxy") {
    requireExternalArmed();
    const body = await readJson(req);
    const profileId = Number(body.profileId || body.profile_id);
    if (!profileId) return json(res, 400, { error: "profile_id_required" });
    assertNotDedicatedShopYourLikesIxProfile(profileId, "normal proxy rotation");
    const proxiesPayload = await getWebshareProxies();
    const proxy = (proxiesPayload.results || []).find((item) => item.id === body.proxyId || item.proxy_address === body.proxyAddress);
    if (!proxy) return json(res, 404, { error: "proxy_not_found" });
    const result = await ixBrowserRequest("profile-update-proxy-for-custom-proxy", {
      profile_id: profileId,
      proxy_info: {
        proxy_mode: 2,
        proxy_type: "http",
        proxy_ip: proxy.proxy_address,
        proxy_port: proxy.port,
        proxy_user: proxy.username,
        proxy_password: proxy.password,
        proxy_check_line: "global_line",
      },
    });
    logEvent("ixbrowser_webshare_proxy_applied", { profileId, proxyId: proxy.id, proxyAddress: proxy.proxy_address ? maskHost(proxy.proxy_address) : "" });
    return json(res, 200, { result, proxy: sanitizeWebshareProxy(proxy) });
  }
  if (req.method === "POST" && url.pathname === "/api/products/discover") {
    const body = await readJson(req);
    const result = await runProductDiscovery(body);
    return json(res, 200, result);
  }
  if (req.method === "POST" && url.pathname === "/api/products/discover-browser") {
    requireExternalArmed();
    const body = await readJson(req);
    const result = await runIxBrowserProductDiscovery(body);
    return json(res, 200, result);
  }
  if (req.method === "POST" && url.pathname === "/api/products/discover-local-browser") {
    requireExternalArmed();
    const body = await readJson(req);
    const result = await runLocalBrowserProductDiscovery(body);
    return json(res, 200, result);
  }
  if (req.method === "POST" && url.pathname === "/api/products/prepare-assets") {
    const body = await readJson(req);
    try {
      const result = await prepareProductAssetChecks(body);
      return json(res, 200, result);
    } catch (err) {
      if (body.testPost || body.test_post) persistTestAssetFailure(err);
      throw err;
    }
  }
  if (req.method === "GET" && url.pathname === "/api/products/asset-buffer-status") {
    const now = Date.now();
    if (!__assetBufferStatusCache.body || now - __assetBufferStatusCache.at >= STATUS_CACHE_TTL_MS) {
      __assetBufferStatusCache = { at: now, body: { ok: true, buffer: assetBufferStatus() } };
    }
    return json(res, 200, __assetBufferStatusCache.body);
  }
  if (req.method === "GET" && url.pathname === "/api/autopilot/status") {
    const now = Date.now();
    if (!__autopilotStatusCache.body || now - __autopilotStatusCache.at >= STATUS_CACHE_TTL_MS) {
      __autopilotStatusCache = { at: now, body: { ok: true, autopilot: autopilotStatus(), lastDecision: __autopilotLastDecision } };
    }
    return json(res, 200, __autopilotStatusCache.body);
  }
  if (req.method === "POST" && url.pathname === "/api/autopilot/tick") {
    const decision = await autopilotTickAsync({ manual: true });
    return json(res, 200, { ok: true, decision, autopilot: autopilotStatus() });
  }
  if (req.method === "GET" && url.pathname === "/api/prod/health") {
    // Box health for the Prod tab: total CPU (incl. Pinterest), whether the SEPARATE
    // Pinterest agent (port 59812) is still up (safety), and the no-photo-mark count.
    const cpuPercent = await currentCpuLoadPercent();
    const pinterestUp = await new Promise((resolve) => {
      let done = false; const finish = (v) => { if (!done) { done = true; resolve(v); } };
      try {
        const sock = net.connect({ host: "127.0.0.1", port: 59812 }, () => { sock.destroy(); finish(true); });
        sock.on("error", () => finish(false));
        sock.setTimeout(1500, () => { sock.destroy(); finish(false); });
      } catch { finish(false); }
    });
    let noPhotoMarks = 0;
    try {
      const regs = readRegisters();
      noPhotoMarks = String(regs.noReviewPhotoProducts || "").split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#")).length;
    } catch {}
    return json(res, 200, { ok: true, cpuPercent, pinterestUp, noPhotoMarks });
  }
  if (req.method === "GET" && url.pathname === "/api/prod/activity") {
    // LIVE pipeline feed for the Prod tab: product-finding, asset prep (SYL link + review
    // image), posting steps per profile, cross-account comments — from the event-log tail —
    // plus recent landed posts and the current tick decision.
    let tail = "";
    try {
      const stat = fs.statSync(LOG_FILE);
      const startAt = Math.max(0, stat.size - 60000);
      const fd = fs.openSync(LOG_FILE, "r");
      const buf = Buffer.alloc(stat.size - startAt);
      fs.readSync(fd, buf, 0, buf.length, startAt);
      fs.closeSync(fd);
      tail = buf.toString("utf8");
    } catch {}
    const LABELS = [
      [/^autopilot_publishing$/, "▶ Publishing this cycle"],
      [/^facebook_live_post_started$/, "📤 Posting"],
      [/^facebook_post_url_recorded$/, "🔗 Post URL captured"],
      [/^facebook_live_post_completed/, "✅ Post landed"],
      [/^facebook_first_comment_profile_used$/, "💬 Comment added (different profile)"],
      [/^facebook_live_post_group_failed$/, "❌ Post failed (composer)"],
      [/admin_approval_lock_acquired/, "⏳ Moderator approval"],
      [/^autopilot_no_ready_row$/, "… waiting (no eligible profile / spacing)"],
      [/^autopilot_idle$/, "… idle (buffer empty, filling)"],
      [/^cpu_governor_waiting$/, "⏸ Waiting for CPU headroom"],
      [/^asset_buffer_fill_started$/, "⚙ Preparing products (buffer fill)"],
      [/^autopilot_background_topup_fill$/, "⚙ Topping up buffer"],
      [/^shopyourlikes_extension_links_generated$/, "🔗 ShopYourLikes links generated"],
      [/^asset_buffer_fill_complete$/, "⚙ Buffer fill complete"],
      [/^product_no_review_photos_marked$/, "⏭ Skipped (no review photos)"],
      [/review_image|chatgpt_hd|materializ/i, "🖼 Review image prepared"],
      [/discover|product_candidate/i, "🔎 Finding products (discovery)"],
    ];
    const feed = [];
    for (const raw of tail.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line[0] !== "{") continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      const hit = LABELS.find((e) => e[0].test(String(j.message || "")));
      if (!hit) continue;
      feed.push({ at: j.at || "", label: hit[1], profileId: j.profileId || "", workers: (j.workers != null ? j.workers : "") });
    }
    let recentPosts = [];
    try {
      // Tail-read the ledger (last ~64KB) instead of the whole file — keeps the 4s poll
      // event-loop-friendly as the ledger grows over the agent's uptime.
      let ltail = "";
      try {
        const lstat = fs.statSync(FB_LIVE_POST_LEDGER_FILE);
        const lstart = Math.max(0, lstat.size - 64000);
        const lfd = fs.openSync(FB_LIVE_POST_LEDGER_FILE, "r");
        const lbuf = Buffer.alloc(lstat.size - lstart);
        fs.readSync(lfd, lbuf, 0, lbuf.length, lstart);
        fs.closeSync(lfd);
        ltail = lbuf.toString("utf8");
      } catch {}
      const llines = ltail.split(/\r?\n/);
      const seen = new Set();
      for (let i = llines.length - 1; i >= 0 && recentPosts.length < 10; i -= 1) {
        const line = llines[i].trim();
        if (!line || line[0] !== "{") continue;
        let r; try { r = JSON.parse(line); } catch { continue; }
        const u = r.postUrl || r.url || "";
        if (/^https?:\/\//.test(String(u)) && !seen.has(u)) { seen.add(u); recentPosts.push({ profile: r.profile || r.profileId || "", postUrl: u, at: r.at || "" }); }
      }
    } catch {}
    return json(res, 200, { ok: true, feed: feed.slice(-24), recentPosts, lastDecision: __autopilotLastDecision });
  }
  if (req.method === "POST" && url.pathname === "/api/products/fill-asset-buffer") {
    const body = await readJson(req);
    const summary = await fillAssetBufferAsync({ max: clampNumber(body.max, 1, 50, 1) });
    return json(res, 200, { ok: true, ...summary, buffer: assetBufferStatus() });
  }
  if (req.method === "POST" && url.pathname === "/api/products/backfill-titles") {
    const body = await readJson(req);
    const summary = await backfillProductTitlesAsync({ max: clampNumber(body.max, 1, 80, 25) });
    return json(res, 200, { ok: true, ...summary });
  }
  if (req.method === "POST" && url.pathname === "/api/products/open-assets-folder") {
    const state = readState();
    const folder = safeProjectPath(String(state.productAssets?.outputPath || "data/product-assets"));
    const opened = openFolderInWindows(folder);
    logEvent("product_assets_folder_opened", { path: opened.path, windowsPath: opened.windowsPath });
    return json(res, 200, { ok: true, ...opened });
  }
  if (req.method === "POST" && url.pathname === "/api/posting/prepare-plan") {
    const body = await readJson(req);
    const result = await preparePostingPlanWithFallbackProfiles({
      limit: body.limit,
      testPost: Boolean(body.testPost || body.test_post || body.mode === "test"),
      productUrls: Array.isArray(body.productUrls) ? body.productUrls : body.product_urls,
    });
    return json(res, 200, result);
  }
  if (req.method === "POST" && url.pathname === "/api/posting/prepare-test-post") {
    const body = await readJson(req);
    const result = await preparePostingPlanWithFallbackProfiles({
      limit: 1,
      testPost: true,
      productUrls: Array.isArray(body.productUrls) ? body.productUrls : body.product_urls,
    });
    return json(res, 200, result);
  }
  if (req.method === "POST" && url.pathname === "/api/posting/run-live-test-post") {
    const body = await readJson(req);
    try {
      const result = await runLiveFacebookOnePostTestWithFallback({ ...body, fullRun: false });
      const nextState = persistLiveTestResult(result);
      return json(res, 200, { ...result, state: nextState, registers: readRegisters() });
    } catch (err) {
      const nextState = persistLiveTestFailure(err);
      err.state = nextState;
      err.registers = readRegisters();
      throw err;
    }
  }
  if (req.method === "POST" && url.pathname === "/api/posting/stop-test-parallel") {
    stopTestParallel("operator_stop");
    return json(res, 200, { ok: true, stopped: true, state: readState() });
  }
  if (req.method === "POST" && url.pathname === "/api/posting/run-live-test-post-parallel") {
    const body = await readJson(req);
    const state0 = readState();
    const N = clampNumber(body.parallelPosts || state0.testParallel?.parallelPosts, 1, 6, 4);
    { const s = readState(); if (!s.testParallel) s.testParallel = { active: false, parallelPosts: 4, lanes: [], updatedAt: "" }; s.testParallel.parallelPosts = N; writeState(s); }
    try {
      // Prepare up to N ready products mapped to distinct profiles, then post them
      // ALL AT ONCE (Promise.allSettled) — same engine as autopilot concurrent mode.
      const plan = await preparePostingPlanWithFallbackProfiles({
        limit: N,
        autopilot: true,
        productUrls: Array.isArray(body.productUrls) ? body.productUrls : body.product_urls,
      });
      // Match THIS plan's ready rows by planId only. (Previously required
      // runType === "full_posting_plan" AND used testPost:true which caps the plan at
      // one row — so the 4-parallel test found 0 ready rows despite a full buffer.)
      const readyRows = latestPostingPlanRows(readState()).filter((row) => row.planId === plan.planId && String(row.liveExecution || "").startsWith("ready"));
      // MIRROR PROD: apply the SAME profile allowlist + blocked/quarantine exclusion + recently-used
      // product dedup the autopilot applies, so a #test batch is a faithful preview of a prod batch
      // (fresh products, allowed + healthy profiles). #test stays UNCAPPED/on-demand by design (it
      // does NOT enforce the daily cap), and an EXPLICIT productUrls list overrides the freshness
      // dedup (operator deliberately chose those products to test).
      const testState = readState();
      const explicitTestUrls = (Array.isArray(body.productUrls) ? body.productUrls : (Array.isArray(body.product_urls) ? body.product_urls : [])).filter(Boolean);
      const testUsedKeys = explicitTestUrls.length ? new Set() : recentlyUsedProductKeys(readRegisters().usedProducts, testState);
      const allowRawTest = String(testState.operator?.autopilotProfileAllowlist || "").trim();
      const allowedTestIds = new Set();
      if (allowRawTest) for (const tok of allowRawTest.split(/[\n,]+/)) { const n = parseInt(String(tok).trim(), 10); if (Number.isFinite(n) && n > 0) allowedTestIds.add(n); }
      // FAIRNESS (like prod): order ready rows least-used-first (fewest recent posts) so posting
      // opportunity spreads equally across available profiles.
      const testPostCounts = autopilotPublishedTodayByProfile(testState).byProfile || new Map();
      const testRecentlyFailed = recentlyFailedProfileSet(testState);
      readyRows.sort((a, b) => {
        const pa = Number(a.profileId || profileIdFromLabel(a.profile) || 0);
        const pb = Number(b.profileId || profileIdFromLabel(b.profile) || 0);
        const fa = testRecentlyFailed.has(pa) ? 1 : 0, fb = testRecentlyFailed.has(pb) ? 1 : 0;
        if (fa !== fb) return fa - fb; // healthy before just-failed (no stall on a broken profile)
        return (testPostCounts.get(pa) || 0) - (testPostCounts.get(pb) || 0);
      });
      const picked = [];
      const usedIds = new Set();
      const usedProductKeys = new Set();
      const usedMarkers = new Set();
      for (const row of readyRows) {
        const pid = Number(row.profileId || profileIdFromLabel(row.profile) || 0);
        if (!pid || usedIds.has(pid)) continue;
        if (allowedTestIds.size && !allowedTestIds.has(pid)) continue; // honor autopilotProfileAllowlist like prod
        if (isProfileBlockedForPosting(row.profile, testState, row.groupUrl)) continue; // skip blocked/quarantined like prod
        const prodKey = String(row.productKey || row.productUrl || row.link || "").toLowerCase();
        if (prodKey && usedProductKeys.has(prodKey)) continue; // each post must use a UNIQUE product (in-batch)
        const rowProductKey = String(row.productKey || "").toLowerCase();
        if (rowProductKey && testUsedKeys.has(rowProductKey)) continue; // skip recently-posted products (fresh, like prod)
        // CONCURRENCY SAFETY: same-marker OR variant-SIBLING products (shared long title prefix)
        // must NOT be in the same parallel batch — skip siblings so capture stays unambiguous.
        const markerKey = computePostMarkerPhrase(row).toLowerCase();
        if (markerKey && [...usedMarkers].some((m) => markersAreSiblings(markerKey, m))) continue;
        usedIds.add(pid);
        if (prodKey) usedProductKeys.add(prodKey);
        usedMarkers.add(markerKey);
        picked.push(row);
        if (picked.length >= N) break;
      }
      if (!picked.length) {
        return json(res, 200, { ok: false, error: "no_ready_rows", detail: `plan ${plan.planId}: ${readyRows.length} ready row(s), none postable`, requested: N, planId: plan.planId, state: readState() });
      }
      __testParallelStopRequested = false;
      __testParallelLanes = picked.map((r, i) => ({ workerIndex: i, profileId: Number(r.profileId || 0), profile: r.profile, productUrl: r.productUrl, groupUrl: r.groupUrl, status: "running", step: "posting", postUrl: "", error: "", startedAt: new Date().toISOString(), finishedAt: "", elapsedMs: 0 }));
      flushTestParallelLanes();
      if (__testParallelFlushTimer) clearInterval(__testParallelFlushTimer);
      __testParallelFlushTimer = setInterval(flushTestParallelLanes, 1200);
      logEvent("test_parallel_posts_started", { requested: N, workers: picked.length, profileIds: picked.map((r) => Number(r.profileId || 0)), planId: plan.planId });
      const openStaggerMs = clampNumber(readState().operator?.parallelOpenStaggerSeconds, 0, 30, 8) * 1000;
      // Priority gate: a manual parallel test is also live posting -> PREP yields to it too
      // (so the invariant "posting preempts prep" holds for ALL live posting, not just autopilot).
      beginLivePostingBatch();
      let settled;
      try {
      settled = await Promise.allSettled(picked.map((r, i) => (async () => {
        try {
          if (__testParallelStopRequested) {
            setTestParallelLane(i, { status: "failed", step: "stopped", error: "stopped_by_operator", finishedAt: new Date().toISOString() });
            return { workerIndex: i, profileId: Number(r.profileId || 0), ok: false, postUrl: "", error: "stopped_by_operator" };
          }
          if (i > 0 && openStaggerMs > 0) {
            const waitS = Math.round((i * openStaggerMs) / 1000);
            setTestParallelLane(i, { status: "queued", step: `staggering open (+${waitS}s)` });
            await sleep(i * openStaggerMs);
          }
          // CPU governor: wait for box headroom (incl. Pinterest) before this extra render.
          if (i > 0) {
            setTestParallelLane(i, { status: "queued", step: "waiting for CPU headroom" });
            await waitForCpuHeadroom({ label: `test_worker_p${Number(r.profileId || 0)}` });
          }
          if (__testParallelStopRequested) {
            setTestParallelLane(i, { status: "failed", step: "stopped", error: "stopped_by_operator", finishedAt: new Date().toISOString() });
            return { workerIndex: i, profileId: Number(r.profileId || 0), ok: false, postUrl: "", error: "stopped_by_operator" };
          }
          setTestParallelLane(i, { status: "running", step: "starting" });
          const v = await runLiveFacebookPostFromPlan({ fullRun: true, autopilot: true, planId: r.planId, sequence: r.sequence });
          const ok = Boolean(v && v.ok);
          autoBlacklistProfileIfNeeded({ profileId: Number(r.profileId || 0), profile: r.profile, ok: ok || Boolean(v && v.postUrl), postUrl: (v && v.postUrl) || "", errorText: (v && (v.error || v.reason)) || "", validation: v && v.validation, source: "test_parallel" });
          setTestParallelLane(i, { status: ok ? "done" : "failed", step: ok ? "done" : "failed", postUrl: (v && v.postUrl) || "", finishedAt: new Date().toISOString() });
          return { workerIndex: i, profileId: Number(r.profileId || 0), ok, postUrl: (v && v.postUrl) || "", error: "" };
        } catch (err) {
          autoBlacklistProfileIfNeeded({ profileId: Number(r.profileId || 0), profile: r.profile, ok: false, postUrl: "", errorText: oneLineField((err && (err.profileFailureReason || err.message)) || String(err), 240), profileRetryable: !!(err && err.profileRetryable), source: "test_parallel" });
          setTestParallelLane(i, { status: "failed", step: "failed", error: oneLineField((err && err.message) || String(err), 200), finishedAt: new Date().toISOString() });
          return { workerIndex: i, profileId: Number(r.profileId || 0), ok: false, postUrl: "", error: oneLineField((err && err.message) || String(err), 200) };
        }
      })()));
      } finally { endLivePostingBatch(); }
      if (__testParallelFlushTimer) { clearInterval(__testParallelFlushTimer); __testParallelFlushTimer = null; }
      flushTestParallelLanes();
      const outcomes = settled.map((s) => (s.status === "fulfilled" ? s.value : { ok: false, postUrl: "", error: "worker_rejected" }));
      logEvent("test_parallel_posts_completed", { workers: picked.length, landed: outcomes.filter((o) => o.ok || o.postUrl).length });
      return json(res, 200, { ok: true, requested: N, workers: picked.length, outcomes, planId: plan.planId, state: readState(), registers: readRegisters() });
    } catch (err) {
      if (__testParallelFlushTimer) { clearInterval(__testParallelFlushTimer); __testParallelFlushTimer = null; }
      try { flushTestParallelLanes(); } catch (_e) {}
      throw err;
    }
  }
  if (req.method === "POST" && url.pathname === "/api/posting/recover-first-comment") {
    const body = await readJson(req);
    const result = await runFacebookFirstCommentRecoveryFromPostUrl({ ...body, fullRun: body.fullRun === true });
    return json(res, 200, result);
  }
  if (req.method === "POST" && url.pathname === "/api/posting/resweep-comments") {
    const body = await readJson(req);
    const result = await resweepUncommentedFacebookPostsAsync({ force: true, max: clampNumber(body.max, 1, 50, 10), windowHours: clampNumber(body.windowHours, 1, 168, 24) });
    return json(res, 200, { ok: true, ...result });
  }
  if (req.method === "POST" && url.pathname === "/api/posting/run-live-full-plan") {
    const body = await readJson(req);
    const result = await runLiveFacebookFullPostingPlan({ ...body, fullRun: true });
    return json(res, 200, result);
  }
  if (req.method === "POST" && url.pathname === "/api/posting/profile-group-issue") {
    const body = await readJson(req);
    const result = recordPostingProfileGroupIssue(body);
    return json(res, 200, result);
  }
  if (req.method === "GET" && url.pathname === "/api/profiles/blocked") {
    const st = readState();
    return json(res, 200, { ok: true, blocked: currentlyBlockedProfilesSummary(st), cooldown: commentCooldownProfilesSummary(st) });
  }
  if (req.method === "POST" && url.pathname === "/api/ixbrowser/profile-unblock") {
    const body = await readJson(req);
    const result = unblockPostingProfile(body);
    return json(res, 200, result);
  }
  if (req.method === "POST" && url.pathname === "/api/ixbrowser/clear-failed-profiles") {
    const body = await readJson(req);
    const result = clearAllFailedPostingProfiles(body);
    return json(res, 200, result);
  }
  if (req.method === "POST" && url.pathname === "/api/ixbrowser/reconcile-profiles") {
    const body = await readJson(req);
    const result = await reconcileProfilesWithIxBrowser({ force: body.force !== false });
    return json(res, 200, { ok: !result.skipped, result });
  }
  if (req.method === "POST" && url.pathname === "/api/posting/record-post-url") {
    const body = await readJson(req);
    const result = recordPublishedFacebookPostUrl(body);
    return json(res, 200, result);
  }
  if (req.method === "POST" && url.pathname === "/api/jobs") {
    const body = await readJson(req);
    const now = new Date().toISOString();
    const requestedMode = body.mode === "execute" ? "execute" : "plan";
    const state = readState();
    if (requestedMode === "execute" && !state.operator.armedForExternalActions) {
      return json(res, 409, { error: "execute_mode_blocked", message: "Arm external actions before queueing execute mode." });
    }
    const currentJobs = readJobs();
    const maxQueuedJobs = clampNumber(state.memory?.maxQueuedJobs, 1, 200, 50);
    const activeQueueCount = currentJobs.filter((item) => ["queued", "running"].includes(item.status)).length;
    if (activeQueueCount >= maxQueuedJobs) {
      return json(res, 429, { error: "queue_limit_reached", message: `Queue limit reached (${maxQueuedJobs}). Clear or finish jobs before adding more.` });
    }
    const job = {
      id: `job_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      title: String(body.title || "Facebook agent task").slice(0, 120),
      mode: requestedMode,
      text: String(body.text || "").slice(0, 20000),
      status: "queued",
      approvalRequired: Boolean(state.operator.approvalRequired),
      queueApprovalStatus: state.operator.approvalRequired ? "pending" : "approved",
      createdAt: now,
      updatedAt: now,
      output: "",
      error: "",
    };
    const jobs = currentJobs;
    jobs.unshift(job);
    writeJobs(jobs);
    logEvent("job_queued", { jobId: job.id, title: job.title });
    processQueue();
    return json(res, 201, { job });
  }
  if (req.method === "POST" && url.pathname === "/api/control") {
    const body = await readJson(req);
    if (body.action === "enable") {
      enabled = true;
      logEvent("worker_enabled");
      if (readState().triggers.autoStartQueuedJobs) processQueue();
    } else if (body.action === "disable") {
      enabled = false;
      logEvent("worker_disabled");
    } else if (body.action === "start-next") {
      enabled = true;
      processQueue();
    } else if (body.action === "stop-active") {
      if (active?.child) {
        active.child.kill("SIGTERM");
        updateJob(active.id, { status: "stopped", finishedAt: new Date().toISOString() });
        logEvent("job_stop_requested", { jobId: active.id });
      }
    } else if (body.action === "clear-done") {
      writeJobs(readJobs().filter((job) => !["done", "failed", "stopped"].includes(job.status)));
      logEvent("completed_jobs_cleared");
    }
    return json(res, 200, { ok: true, enabled });
  }

  json(res, 404, { error: "not_found" });
  } catch (err) {
    const code = err.statusCode || 500;
    const isDashboardAuthFailure = err.publicError === "dashboard_token_invalid";
    if (!isDashboardAuthFailure || Date.now() - lastAuthFailureLogAt > 60000) {
      if (isDashboardAuthFailure) lastAuthFailureLogAt = Date.now();
      const authFailureMeta = isDashboardAuthFailure
        ? {
            remoteAddress: req.socket?.remoteAddress || null,
            userAgent: req.headers["user-agent"] || null,
            tokenPresent: Boolean(req.headers["x-dashboard-token"]),
            origin: req.headers.origin || null,
            referer: req.headers.referer || null,
          }
        : {};
      logEvent("request_failed", { method: req.method, url: req.url, error: String(err), ...authFailureMeta });
    }
    const errorName = err.publicError || (code === 400 ? "bad_request" : "server_error");
    const payload = { error: errorName, message: String(err.message || err) };
    if (err.ixBrowserCode) payload.ixBrowserCode = err.ixBrowserCode;
    if (typeof err.ixBrowserDesktopOpened !== "undefined") payload.ixBrowserDesktopOpened = Boolean(err.ixBrowserDesktopOpened);
    if (err.ixBrowserDesktopPath) payload.ixBrowserDesktopPath = err.ixBrowserDesktopPath;
    if (typeof err.ixBrowserAutoRetry !== "undefined") payload.ixBrowserAutoRetry = Boolean(err.ixBrowserAutoRetry);
    if (err.remoteStatus) payload.remoteStatus = err.remoteStatus;
    if (err.livePostValidation) payload.validation = err.livePostValidation;
    if (err.livePostLog) payload.liveLog = compactLivePostLog(err.livePostLog);
    if (err.livePostLogFile) payload.liveLogFile = err.livePostLogFile;
    if (err.uncertainAfterPostClick) payload.uncertainAfterPostClick = true;
    if (Array.isArray(err.candidatePostUrls) && err.candidatePostUrls.length) payload.candidatePostUrls = err.candidatePostUrls;
    if (err.expectedConfirmation) payload.expectedConfirmation = err.expectedConfirmation;
    if (err.liveAction) payload.liveAction = err.liveAction;
    if (Array.isArray(err.missingApprovals)) payload.missingApprovals = err.missingApprovals;
    if (err.state) payload.state = err.state;
    if (err.registers) payload.registers = err.registers;
    if (!res.headersSent) return json(res, code, payload);
    res.end();
  }
});

server.listen(PORT, HOST, () => {
  logEvent("dashboard_started", { url: `http://${HOST}:${PORT}` });
  console.log(`Facebook Agent dashboard: http://${HOST}:${PORT}`);
  // Warm up the persistent image-selector service in WSL so the first asset
  // prep call doesn't pay the WSL cold-start.
  // [WEDGE-DEBUG] temporarily disabled to isolate the boot wedge (see _wedgewatch).
  // ensureImageSelectorServiceRunning().catch((err) => {
  //   logEvent("image_selector_service_warmup_error", { error: oneLineField(err.message || String(err), 240) });
  // });
  // Stage 3 autonomous publisher. Dormant unless operator.autopilotEnabled +
  // armed; dry-run by default (logs decisions, never posts) until
  // operator.autopilotDryRun is set false.
  startAutopilotScheduler();
  // Kick one per-post-log retention sweep shortly after startup (covers a process that was down
  // across the interval), then the heartbeat repeats it every >=6h.
  setTimeout(() => { __lastPerPostLogSweep = Date.now(); sweepPerPostLogs().catch(() => {}); }, 30000);
});
