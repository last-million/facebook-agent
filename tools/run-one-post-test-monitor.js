const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const TOKEN_FILE = path.join(DATA_DIR, ".dashboard-token");
const EVENTS_FILE = path.join(DATA_DIR, "events.log");
const ERRORS_FILE = path.join(DATA_DIR, "errors.txt");
const BASE_URL = process.env.FACEBOOK_AGENT_BASE_URL || "http://127.0.0.1:9317";
const LIVE_CONFIRMATION = "PUBLISH TEST";

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const name = key.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    out[name] = value;
  }
  return out;
}

function safeRead(filePath, fallback = "") {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return fallback;
  }
}

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function linesAfterByte(filePath, offset) {
  try {
    const size = fileSize(filePath);
    if (size <= offset) return [];
    const fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(size - offset);
    fs.readSync(fd, buffer, 0, buffer.length, offset);
    fs.closeSync(fd);
    return buffer.toString("utf8").split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

const args = parseArgs(process.argv);
const runId = String(args["run-id"] || Date.now());
const confirmation = String(args.confirmation || "");
const logPath = path.join(DATA_DIR, `one-post-test-monitor-${runId}.jsonl`);
const summaryPath = path.join(DATA_DIR, `one-post-test-monitor-${runId}.summary.json`);
const token = safeRead(TOKEN_FILE).trim();
if (!token) throw new Error(`Dashboard token missing: ${TOKEN_FILE}`);
if (confirmation.trim().toUpperCase() !== LIVE_CONFIRMATION) {
  throw new Error(`Refusing live test: confirmation must be ${LIVE_CONFIRMATION}.`);
}

const startedAt = new Date();
const eventsOffset = fileSize(EVENTS_FILE);
const errorsOffset = fileSize(ERRORS_FILE);
const timeline = [];
const issues = [];

function append(row) {
  const payload = {
    at: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt.getTime(),
    ...row,
  };
  timeline.push(payload);
  fs.appendFileSync(logPath, `${JSON.stringify(payload)}\n`);
  console.log(JSON.stringify(payload));
}

function compact(value, limit = 1200) {
  if (value == null) return value;
  if (typeof value === "string") return value.length > limit ? `${value.slice(0, limit)}...` : value;
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => compact(item, Math.floor(limit / 2)));
  if (typeof value !== "object") return value;
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (["state", "registers", "raw", "liveLog"].includes(key)) continue;
    out[key] = compact(val, Math.floor(limit / 2));
  }
  return out;
}

let longLivedDispatcher = null;
function getLongLivedDispatcher(timeoutMs) {
  try {
    if (!longLivedDispatcher) {
      const { Agent } = require("undici");
      const oneHour = 60 * 60 * 1000;
      longLivedDispatcher = new Agent({
        headersTimeout: oneHour,
        bodyTimeout: oneHour,
        keepAliveTimeout: 60 * 1000,
        keepAliveMaxTimeout: oneHour,
      });
    }
  } catch { longLivedDispatcher = null; }
  return longLivedDispatcher;
}

async function api(route, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 35000);
  try {
    const fetchOpts = {
      method: options.method || "GET",
      headers: {
        "content-type": "application/json",
        "x-dashboard-token": token,
        ...(options.headers || {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    };
    if ((options.timeoutMs || 0) > 240000) {
      const dispatcher = getLongLivedDispatcher(options.timeoutMs);
      if (dispatcher) fetchOpts.dispatcher = dispatcher;
    }
    const response = await fetch(`${BASE_URL}${route}`, fetchOpts);
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text };
    }
    if (!response.ok) {
      const err = new Error(payload?.message || `${route} HTTP ${response.status}`);
      err.statusCode = response.status;
      err.payload = payload;
      throw err;
    }
    return payload;
  } catch (err) {
    if (err.name === "AbortError") {
      const timeoutErr = new Error(`${route} timed out after ${Math.round((options.timeoutMs || 35000) / 1000)}s`);
      timeoutErr.statusCode = 504;
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function timedStep(name, work) {
  const started = Date.now();
  append({ type: "step_start", step: name });
  try {
    const result = await work();
    append({ type: "step_done", step: name, durationMs: Date.now() - started, result: compact(result) });
    return result;
  } catch (err) {
    const issue = {
      step: name,
      durationMs: Date.now() - started,
      message: err.message || String(err),
      statusCode: err.statusCode || 0,
      payload: compact(err.payload || null),
    };
    issues.push(issue);
    append({ type: "step_failed", ...issue });
    throw err;
  }
}

function selectedProductUrlsFromAssets(assets) {
  return [...new Set((assets?.selectedImages || [])
    .map((image) => String(image.productUrl || image.url || "").trim())
    .filter(Boolean))];
}

function summarizeLiveResult(result) {
  return {
    ok: result?.ok,
    posted: result?.posted,
    postUrl: result?.postUrl || "",
    planId: result?.planId || "",
    sequence: result?.sequence || "",
    profileId: result?.profileId || "",
    profile: result?.profile || "",
    commentProfileId: result?.commentProfileId || "",
    commentProfile: result?.commentProfile || "",
    groupUrl: result?.groupUrl || "",
    attemptedGroups: result?.attemptedGroups || [],
    attemptedCommentProfiles: result?.attemptedCommentProfiles || [],
    validation: result?.validation || null,
    message: result?.message || "",
    liveLogFile: result?.liveLogFile || "",
  };
}

async function main() {
  append({ type: "run_start", runId, logPath, summaryPath });
  const preflight = await timedStep("preflight", async () => {
    const [status, state] = await Promise.all([api("/api/status"), api("/api/state")]);
    const s = state.state;
    return {
      dashboardStatus: status.heartbeat?.status || "",
      active: status.active || null,
      armed: Boolean(s.operator?.armedForExternalActions),
      approvalRequired: Boolean(s.operator?.approvalRequired),
      autopilot: Boolean(s.operator?.autopilotEnabled),
      groups: String(s.posting?.groups || "").split(/\r?\n/).filter((line) => line.trim()).length,
      assignments: Array.isArray(s.posting?.groupAssignmentData) ? s.posting.groupAssignmentData.length : 0,
      dedicatedSylProfile: s.affiliate?.dedicatedIxProfileId || "",
      maxConcurrentProfiles: s.ixbrowser?.maxConcurrentProfiles || "",
    };
  });
  if (!preflight.armed) throw new Error("External actions are not armed.");
  if (!preflight.dedicatedSylProfile) throw new Error("Dedicated ShopYourLikes profile missing.");

  const discovery = await timedStep("product_discovery", async () => {
    const result = await api("/api/products/discover", {
      method: "POST",
      timeoutMs: 120000,
      body: {
        testPost: true,
        includeExistingCandidates: true,
        includeUsedProducts: false,
        strictFresh: true,
        targetCandidateCount: 24,
      },
    });
    const urls = [...new Set((result.candidates || [])
      .map((candidate) => String(candidate.url || candidate.productUrl || "").trim())
      .filter(Boolean))];
    if (!urls.length) throw new Error(result.message || "Product discovery returned no usable URLs.");
    return { discovered: result.discovered || 0, candidateCount: urls.length, urls };
  });

  const useCached = Boolean(args["use-cached"]);
  const assets = await timedStep("product_assets_hd", async () => {
    const result = await api("/api/products/prepare-assets", {
      method: "POST",
      timeoutMs: 1800000,
      body: {
        limit: 1,
        testPost: true,
        forceFresh: !useCached,
        disableCachedFallback: !useCached,
        productUrls: discovery.urls,
      },
    });
    const selectedUrls = selectedProductUrlsFromAssets(result);
    if (!selectedUrls.length) throw new Error("Image prep returned no selected product URL.");
    if (!Number(result.selected || 0)) throw new Error("Image prep selected zero review images.");
    if (result.hdEnabled !== false && !Number(result.hdUpgraded || 0)) {
      throw new Error("ChatGPT HD image was not prepared.");
    }
    return {
      selected: result.selected || 0,
      hdEnabled: result.hdEnabled !== false,
      hdUpgraded: result.hdUpgraded || 0,
      selectedUrls,
      selectedImages: (result.selectedImages || []).map((image) => ({
        productUrl: image.productUrl || "",
        localPath: image.localPath || "",
        candidateCount: image.candidateCount || "",
        chatgptHd: image.chatgptHd ? {
          ok: Boolean(image.chatgptHd.ok),
          outputPath: image.chatgptHd.outputPath || "",
          error: image.chatgptHd.error || "",
        } : null,
      })),
    };
  });

  const selectedUrls = assets.selectedUrls;

  const syl = await timedStep("shopyourlikes_extension", async () => {
    const result = await api("/api/integrations/shopyourlikes-extension/generate", {
      method: "POST",
      timeoutMs: 360000,
      body: {
        profileId: Number(preflight.dedicatedSylProfile),
        urls: selectedUrls,
        shortenAfter: false,
        forceFresh: false,
      },
    });
    const links = (result.results || []).filter((item) => item.success && item.sylLink).map((item) => item.sylLink);
    if (!links.length) throw new Error(`ShopYourLikes returned no usable links: ${JSON.stringify(compact(result.results || []))}`);
    const reused = (result.results || []).filter((item) => item.success && item.sylLink && item.reused).length;
    return {
      profileId: result.profileId,
      requested: selectedUrls.length,
      generated: Math.max(0, links.length - reused),
      reused,
      windowsCdpFallback: Boolean(result.windowsCdpFallback),
      links,
      results: result.results || [],
    };
  });

  const shortlinks = await timedStep("mavlynk_shortlink", async () => {
    const result = await api("/api/integrations/shortlink/shorten-batch", {
      method: "POST",
      timeoutMs: 180000,
      body: { urls: syl.links, saveToPosting: true },
    });
    const ok = (result.results || []).filter((item) => item.success && item.shortUrl);
    if (!ok.length) throw new Error(`Mavlynk returned no shortlinks: ${JSON.stringify(compact(result.results || []))}`);
    return { saved: result.saved || 0, skipped: result.skipped || 0, shortened: ok.length, results: result.results || [] };
  });

  const plan = await timedStep("prepare_test_post_plan", async () => {
    const result = await api("/api/posting/prepare-test-post", {
      method: "POST",
      timeoutMs: 120000,
      body: { limit: 1, testPost: true, productUrls: selectedUrls },
    });
    if (!Number(result.itemCount || 0) || !Number(result.readyForLiveConnector || 0)) {
      throw new Error(`Posting plan not ready: itemCount=${result.itemCount || 0}, ready=${result.readyForLiveConnector || 0}`);
    }
    const row = (result.sample || [])[0] || {};
    if (!row.planId || !row.sequence) throw new Error("Posting plan sample missing planId or sequence.");
    return {
      planId: result.planId,
      itemCount: result.itemCount,
      readyForLiveConnector: result.readyForLiveConnector,
      row: {
        planId: row.planId,
        sequence: row.sequence,
        profile: row.profile,
        profileId: row.profileId,
        groupUrl: row.groupUrl,
        productUrl: row.productUrl,
        image: row.image,
        link: row.link,
        liveExecution: row.liveExecution,
      },
    };
  });

  const live = await timedStep("live_facebook_publish", async () => {
    const row = plan.row;
    const result = await api("/api/posting/run-live-test-post", {
      method: "POST",
      timeoutMs: 900000,
      body: {
        planId: row.planId,
        sequence: row.sequence,
        operatorApprovedLive: true,
        liveConfirmation: LIVE_CONFIRMATION,
      },
    });
    return summarizeLiveResult(result);
  });

  const events = linesAfterByte(EVENTS_FILE, eventsOffset);
  const errorLines = linesAfterByte(ERRORS_FILE, errorsOffset);
  const summary = {
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    ok: Boolean(live.ok && live.postUrl),
    postUrl: live.postUrl || "",
    planId: live.planId || plan.planId || "",
    profile: live.profile || plan.row.profile || "",
    groupUrl: live.groupUrl || plan.row.groupUrl || "",
    selectedProductUrls: selectedUrls,
    steps: timeline.filter((row) => row.type === "step_done" || row.type === "step_failed")
      .map((row) => ({ step: row.step, type: row.type, durationMs: row.durationMs, message: row.message || row.result?.message || "" })),
    issues,
    eventCount: events.length,
    recentEvents: events.slice(-80),
    newErrorLines: errorLines.slice(-80),
    logPath,
    summaryPath,
  };
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  append({ type: "run_done", summary: compact(summary, 2000) });
  if (!summary.ok) process.exitCode = 2;
}

main().catch((err) => {
  const events = linesAfterByte(EVENTS_FILE, eventsOffset);
  const errorLines = linesAfterByte(ERRORS_FILE, errorsOffset);
  const summary = {
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    ok: false,
    fatal: err.message || String(err),
    issues,
    eventCount: events.length,
    recentEvents: events.slice(-80),
    newErrorLines: errorLines.slice(-80),
    logPath,
    summaryPath,
  };
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  append({ type: "run_failed", fatal: summary.fatal, summary: compact(summary, 2000) });
  process.exit(1);
});
