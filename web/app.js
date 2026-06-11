const $ = (id) => document.getElementById(id);
const DASHBOARD_TOKEN = document.querySelector('meta[name="dashboard-token"]')?.content || "";

let workflowState = null;
let workflowRegisters = {};
let dirty = false;
let requestBusy = false;
let loadedSecrets = null;
let integrationProfiles = [];
let integrationProxies = [];
let groupAssignmentDraft = [];
let autoIntegrationRan = false;
let autoIntegrationRunning = false;
let autoAssignmentSaveTimer = null;
let autoAssignmentSaving = false;
let dirtyVersion = 0;
let lastJobs = [];
let lastEvents = [];
let lastApprovals = { items: [], pending: [], queuedJobs: [], history: [] };
let runtimeEnabled = false;
let localProgressActive = false;
let localProgressClearTimer = null;
const DEFAULT_VIEW = "overview";
const VIEW_STORAGE_KEY = "facebook-agent-dashboard-view";
const ADVANCED_UI_STORAGE_KEY = "facebook-agent-dashboard-advanced-ui";
const MAX_NORMAL_IX_CONCURRENT_PROFILES = 4;
const PREPARE_ASSETS_TIMEOUT_MS = 1800000;
const IXBROWSER_DASHBOARD_WAIT_MS = 420000;
const VIEW_SUBTITLES = {
  overview: "Production readiness, safety switches, analytics, and comment-limit review.",
  monitor: "Live Hermes queue, active run progress, and event timeline.",
  approvals: "Human validation for plans and queued tasks before anything is accepted.",
  credentials: "All saved service keys, local API URLs, and fixed proxy credentials in one place.",
  integrations: "IXBrowser profile control, Webshare proxy loading, and the fixed ShopYourLikes profile.",
  posting: "Posting limits, groups, profile assignment, comments, shortlinks, and plan output.",
  prod: "Live autonomous posting — status, safety, master controls, pipeline actions, and the steps.",
  test: "One-button end-to-end 1-post test, live step progress, and final published URL capture.",
  content: "Walmart source URLs, product discovery, review-image assets, and text rotation.",
  affiliate: "ShopYourLikes affiliate generation and Mavlynk shortlink preparation.",
  profiles: "Webshare IP state, IXBrowser profile capacity, and comment-limit handling.",
  operations: "Prepared output, daily tracking, registers, jobs, and local event history.",
  system: "Security audit, schedule window, worker limits, prompt memory, and safety triggers.",
};
const SECRET_CLEAR_IDS = [
  "openaiClearKey",
  "openrouterClearKey",
  "webshareClearKey",
  "proxyProviderClearKey",
  "ixbrowserClearKey",
  "shopyourlikesClearKey",
  "shortlinkClearKey",
  "firecrawlClearKey",
  "affiliateProxyClearKey",
];
const BUTTON_TOOLTIPS = {
  sidebarToggle: "Opens the left command panel on smaller screens.",
  saveAllTop: "Saves all dashboard settings and local workflow state.",
  queueBtn: "Queues a manual Hermes todo from the Overview task box.",
  refreshMonitorBtn: "Reloads current jobs, progress, and event logs.",
  clearBtnMonitor: "Removes finished jobs from the visible queue.",
  refreshApprovalsBtn: "Reloads pending approvals and queued tasks.",
  approveAllQueuedBtn: "Approves all queued Hermes tasks so Run Next can start them.",
  saveSecretsBtn: "Saves API keys and service URLs locally.",
  checkIntegrationHealthBtn: "Checks saved service configuration without publishing.",
  testWebshareBtn: "Tests the Webshare API connection.",
  loadWebshareProxiesBtn: "Loads available Webshare proxy options.",
  testIxBtn: "Tests the local IXBrowser API session.",
  loadIxProfilesBtn: "Loads IXBrowser profiles into dashboard selectors.",
  openIxProfileBtn: "Opens the selected IXBrowser profile.",
  openIxAssignedGroupBtn: "Opens the selected profile to its assigned Facebook group.",
  closeIxProfileBtn: "Closes the selected IXBrowser profile unless it is the dedicated SYL profile.",
  applyProxyToProfileBtn: "Applies the selected Webshare proxy to the selected IXBrowser profile.",
  applyOneAttemptProxyBtn: "Records the one allowed proxy correction attempt for this profile.",
  saveShopYourLikesIxProfileBtn: "Saves the selected IXBrowser profile as the fixed ShopYourLikes profile.",
  openShopYourLikesIxProfileBtn: "Opens the dedicated ShopYourLikes IXBrowser profile.",
  openShopYourLikesBrowserBtn: "Opens the legacy local Edge ShopYourLikes browser.",
  closeShopYourLikesBrowserBtn: "Closes the legacy local Edge ShopYourLikes browser.",
  testShopYourLikesProxyBtn: "Tests the dedicated ShopYourLikes proxy.",
  runSecurityAuditBtn: "Checks local dashboard ports, token gate, and process exposure.",
  preparePostingPlanBtn: "Builds the full local posting plan for approval.",
  runLiveFullPostingPlanBtn: "Publishes the approved full posting plan live, capped by the configured IXBrowser profile limit; default is four at a time.",
  addGroupUrlBtn: "Adds a Facebook group URL to the posting input list.",
  runRandomE2eTestHandoffBtn: "Runs the full 1-post test with one random profile and one random group, then publishes the post, first comment, and pinned comment check.",
  clearTestRunBtn: "Stops the visible 1-post test run and clears its saved progress so a new test can start cleanly.",
  prepareTestPostBtn: "Runs the prep workflow and builds exactly one test posting-plan row.",
  openFacebookTestHandoffBtn: "Opens the planned Facebook group/profile without publishing.",
  runFullPrepPipelineBtn: "Runs discovery, assets, links, and full posting-plan prep.",
  recordPublishedPostUrlBtn: "Saves the final Facebook post URL after manual publish.",
  recoverFirstCommentBtn: "Runs comment-only recovery for the recorded Facebook post URL.",
  buildGroupAssignmentsBtn: "Builds the group/profile assignment matrix from saved group URLs.",
  evenGroupSplitBtn: "Splits profile assignment evenly across all group URLs.",
  percentGroupSplitBtn: "Distributes profiles by the percentage share for each group.",
  addAssignmentGroupUrlBtn: "Adds another Facebook group URL directly to the assignment matrix.",
  copyLoadedProfilesBtn: "Copies loaded IXBrowser profiles into the next-run profile list.",
  selectAllProfilesBtn: "Selects all visible profiles in the assignment matrix.",
  clearVisibleProfilesBtn: "Clears all visible profile selections in the matrix.",
  rebuildProductSourcesBtn: "Rebuilds Walmart/product source URLs from filters and search queries.",
  runProductDiscoveryBtn: "Discovers product URLs from generated source pages.",
  openBrowserDiscoveryBtn: "Opens local browser discovery for human checks.",
  openChatGptBrowserWizardBtn: "Opens the dedicated ChatGPT Edge profile used by the image HD workflow so you can log in or verify it.",
  captureBrowserDiscoveryBtn: "Captures the currently visible local browser discovery page.",
  queueHermesBrowserBtn: "Queues a Hermes plan for browser-based Walmart discovery.",
  queueDealBtn: "Queues a Hermes plan to review product filters.",
  prepareProductAssetsBtn: "Prepares review-image candidates and Facebook-safe JPG/PNG asset checks.",
  openProductAssetsFolderBtn: "Opens the local product asset folder.",
  queueProductImagesBtn: "Queues a Hermes plan for product image workflow.",
  clearWorkflowOutputBtn: "Clears the current workflow output preview.",
  queueTextRotationBtn: "Queues a Hermes check for text/comment rotation.",
  assignAffiliateProxyBtn: "Assigns a valid US Webshare proxy for ShopYourLikes.",
  testAffiliateProxyBtn: "Tests the configured affiliate proxy.",
  generateShopYourLikesExtensionLinksBtn: "Generates SYL links in the dedicated profile and shortens them with Mavlynk.",
  markIpFailedBtn: "Adds the current IP to failed IP tracking.",
  queueIpBtn: "Queues a Hermes plan for IP/profile health.",
  recordIpAttemptBtn: "Records the one allowed IP/proxy retry attempt.",
  markOneAttemptFailedBtn: "Marks the one retry as failed and moves toward review.",
  markCommentLimitedBtn: "Quarantines a profile that cannot comment.",
  queueExtensionBtn: "Queues a Hermes plan for ShopYourLikes extension setup.",
  clearBtn: "Clears finished jobs from the operations list.",
  setupWizardClose: "Closes the setup wizard.",
};
const OPERATOR_TOGGLE_GROUPS = {
  approvalRequired: ["approvalRequiredRail"],
  autopilotEnabled: ["autopilotEnabledRail"],
  armedForExternalActions: ["armedForExternalActionsRail"],
};
const WALMART_DISCOVERY_FILTERS = [
  ["discoveryIncludeClearance", "special_offers:Clearance"],
  ["discoveryIncludeReducedPrice", "special_offers:Reduced Price"],
  ["discoveryIncludeRollback", "special_offers:Rollback"],
  ["discoveryRequireProSeller", "retailer_type:Pro Sellers"],
];
const WIZARD_STEPS = ["safety", "apis", "profiles", "products", "images", "links", "posting", "review"];
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
const LIVE_TEST_CONFIRMATION = "PUBLISH TEST";
const LIVE_FULL_CONFIRMATION = "PUBLISH FULL PLAN";
let activeWizardStep = "safety";
let lastWizardFocus = null;
let testPipelineState = {};
let lastTestRunResult = {};
let lastTestProgress = {
  title: "Idle",
  percent: 0,
  detail: "Click Run 1-Post Full Test to start the workflow.",
  tone: "idle",
};
let lastTestTiming = {
  startedAt: "",
  finishedAt: "",
};
let lastTestRunUpdatedAt = "";
let testProgressSaveTimer = null;
let testProgressSaving = false;
let restoringTestRun = false;
let activeTestAbortController = null;

async function api(path, options = {}) {
  const controller = new AbortController();
  const externalSignal = options.signal || null;
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  const timer = window.setTimeout(() => controller.abort(), options.timeoutMs || 35000);
  let response;
  try {
    response = await fetch(path, {
      ...options,
      signal: controller.signal,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-dashboard-token": DASHBOARD_TOKEN,
        ...(options.headers || {}),
      },
    });
  } catch (err) {
    const cancelled = err.name === "AbortError" && externalSignal?.aborted;
    const wrapped = new Error(cancelled ? "Request cancelled." : err.name === "AbortError" ? "Dashboard API request timed out." : err.message);
    wrapped.status = 0;
    wrapped.cancelled = cancelled;
    wrapped.payload = { error: cancelled ? "request_cancelled" : "network_error" };
    throw wrapped;
  } finally {
    window.clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
  }
  if (!response.ok) {
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch {}
    const err = new Error(payload?.message || `${response.status} ${text}`);
    err.status = response.status;
    err.payload = payload;
    throw err;
  }
  return response.json();
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => { toast.hidden = true; }, 3200);
}

function requestTypedLiveConfirmation(expected, message) {
  const entered = prompt(`${message}\n\nType ${expected} to continue.`);
  if (entered === null) return "";
  if (String(entered || "").trim().toUpperCase() === expected) return expected;
  showToast(`Live action cancelled. Typed confirmation must be ${expected}.`);
  return "";
}

function setBusy(value) {
  requestBusy = value;
  document.querySelectorAll("button").forEach((button) => {
    if (button.id === "stopBtn") return;
    if (button.id === "clearTestRunBtn") return;
    button.disabled = value;
  });
}

function markDirty() {
  dirtyVersion += 1;
  dirty = true;
  renderDirtyStatus();
  scheduleAutoSave();
}

function clearDirty() {
  dirty = false;
  renderDirtyStatus();
}

// ── Auto-save (no Save button) + global Ctrl+Z undo ──────────────────────────────────────────
let __autoSaveTimer = null;
let __undoStack = [];
let __lastSnapshot = null;
let __undoBusy = false;
function scheduleAutoSave() {
  if (__autoSaveTimer) clearTimeout(__autoSaveTimer);
  __autoSaveTimer = setTimeout(() => {
    __autoSaveTimer = null;
    if (dirty) saveAll({ quiet: true }).catch(() => {});
  }, 850);
}
async function undoLastChange() {
  if (!__undoStack.length) { showToast("Nothing left to undo."); return; }
  const prev = __undoStack.pop();
  __undoBusy = true;
  try {
    const st = JSON.parse(prev);
    __lastSnapshot = prev;
    renderState(st);
    await saveAll({ quiet: true });
    showToast("Reverted last change (Ctrl+Z).");
  } catch (e) { showToast("Undo failed."); } finally { __undoBusy = false; }
}
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || String(e.key || "").toLowerCase() !== "z" || e.shiftKey) return;
  const t = e.target;
  // let the browser's native per-character undo handle focused text fields
  if (t && t.matches && t.matches("input:not([type=checkbox]):not([type=radio]):not([type=range]), textarea")) return;
  e.preventDefault();
  undoLastChange();
});

function renderDirtyStatus() {
  const el = $("dirtyStatus");
  el.textContent = dirty ? "Saving…" : "Auto-saved";
  el.className = `saveState ${dirty ? "dirty" : "clean"}`;
}

function setActiveView(view) {
  const requested = view || DEFAULT_VIEW;
  const known = Array.from(document.querySelectorAll("[data-view-target]")).some((item) => item.dataset.viewTarget === requested);
  const activeView = known ? requested : DEFAULT_VIEW;
  document.querySelectorAll("[data-view]").forEach((panel) => {
    const views = String(panel.dataset.view || "").split(/\s+/).filter(Boolean);
    panel.classList.toggle("viewVisible", views.includes(activeView));
  });
  document.querySelectorAll("[data-view-target]").forEach((button) => {
    const selected = button.dataset.viewTarget === activeView;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-current", selected ? "page" : "false");
  });
  document.body.dataset.activeView = activeView;
  const subtitle = $("topSubtitle");
  if (subtitle) subtitle.textContent = VIEW_SUBTITLES[activeView] || VIEW_SUBTITLES[DEFAULT_VIEW];
  document.body.classList.add("viewsReady");
  document.body.classList.remove("sidebarOpen");
  $("sidebarToggle")?.setAttribute("aria-expanded", "false");
  try { localStorage.setItem(VIEW_STORAGE_KEY, activeView); } catch {}
  if (window.location.hash !== `#${activeView}`) {
    history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${activeView}`);
  }
  updateDashboardUxFilters();
}

function dashboardPanelSearchText(panel) {
  const fieldText = Array.from(panel.querySelectorAll("input, textarea, select"))
    .map((el) => [el.id, el.name, el.placeholder, el.value, el.textContent].filter(Boolean).join(" "))
    .join(" ");
  return `${panel.textContent || ""} ${fieldText}`.toLowerCase();
}

function updateDashboardUxFilters() {
  const search = $("dashboardSearch")?.value.trim().toLowerCase() || "";
  const showAdvanced = Boolean($("showAdvancedUi")?.checked);
  document.body.classList.toggle("showAdvanced", showAdvanced);
  document.body.classList.toggle("uxSearching", Boolean(search));
  document.querySelectorAll("[data-view]").forEach((panel) => {
    const isVisibleView = panel.classList.contains("viewVisible");
    const matchesSearch = !search || dashboardPanelSearchText(panel).includes(search);
    panel.classList.toggle("uxSearchHidden", isVisibleView && !matchesSearch);
  });
  try { localStorage.setItem(ADVANCED_UI_STORAGE_KEY, showAdvanced ? "1" : "0"); } catch {}
}

function markSecretDirty() {
  const el = $("secretStatus");
  el.textContent = "Secrets unsaved";
  el.className = "saveState dirty";
}

function clearSecretDirty() {
  const el = $("secretStatus");
  el.textContent = "Secrets saved";
  el.className = "saveState clean";
}

async function control(action) {
  if (!(await ensureSavedBeforeAction())) return false;
  if (action === "clear-done" && !confirm("Clear all finished jobs from the dashboard?")) return false;
  if (action === "stop-active" && !confirm("Stop the active Hermes job?")) return false;
  if (action === "enable" && !confirm("Enable the worker queue?")) return false;
  setBusy(true);
  try {
    await api("/api/control", { method: "POST", body: JSON.stringify({ action }) });
    await refresh({ force: true });
    return true;
  } finally {
    setBusy(false);
  }
}

async function queueJob(title, text, mode = "plan") {
  if (!text.trim()) return false;
  if (!(await ensureSavedBeforeAction())) return false;
  if (mode === "execute" && !confirm("Execute mode is only for safe local work. Queue this task?")) return false;
  setBusy(true);
  try {
  await api("/api/jobs", { method: "POST", body: JSON.stringify({ title, text, mode }) });
  showToast("Todo queued for Hermes.");
    await refresh({ force: true });
    return true;
  } finally {
    setBusy(false);
  }
}

async function queueFromForm() {
  const title = $("jobTitle").value.trim() || "Facebook agent task";
  const text = $("jobText").value.trim();
  const mode = $("jobMode").value;
  const queued = await queueJob(title, text, mode);
  if (queued) $("jobText").value = "";
}

function fmtTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const hours = Math.floor(minutes / 60);
  if (hours) return `${hours}h ${minutes % 60}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function renderStatus(status) {
  const hb = status.heartbeat || {};
  const enabled = Boolean(status.enabled);
  $("heartbeat").textContent = fmtTime(hb.lastBeat);
  $("activeJob").textContent = hb.activeJobId || "-";
  $("statusText").textContent = hb.status || "idle";
  $("statusDot").className = `dot ${hb.status || "idle"}`;
  setRuntimePower(enabled);
}

function renderJobs(jobs) {
  lastJobs = Array.isArray(jobs) ? jobs : [];
  renderAnalytics(lastJobs);
  renderRunMonitor(lastJobs, lastEvents);
  if (!$("jobs")) return;
  $("jobs").innerHTML = lastJobs.map((job, index) => renderJobCard(job, index, lastJobs, { compact: false })).join("") || "<p>No jobs yet.</p>";
}

function renderAnalytics(jobs = []) {
  if (!$("analyticsGrid") || !workflowState) return;
  const counts = jobs.reduce((acc, job) => {
    acc[job.status] = (acc[job.status] || 0) + 1;
    return acc;
  }, {});
  const totalJobs = jobs.length || 1;
  const productUrlCount = countLines(workflowState.productAssets.productUrls || workflowState.posting.sourceUrls);
  const discoveryUrlCount = countLines(workflowState.productDiscovery?.generatedSourceUrls);
  const imageCounts = reviewImageApprovalCounts(workflowState.productAssets.selectedReviewImages);
  const postTextCount = countLines(workflowState.contentRotation.postTexts);
  const commentLeadCount = countLines(workflowState.contentRotation.commentLeadIns);
  const groupCount = countLines(workflowState.posting.groups);
  const profilesForRun = countLines(workflowState.ixbrowser.profilesForNextRun);
  const maxProfiles = Number(workflowState.ixbrowser.maxProfilesPerRun || 1);
  const securityFresh = Boolean(workflowState.security.lastAuditAt);
  const locked = !workflowState.operator.armedForExternalActions;
  const metrics = [
    ["Queue", counts.queued || 0, `${counts.running || 0} running, ${counts.done || 0} done`, Math.min(100, ((counts.queued || 0) / totalJobs) * 100), (counts.failed || 0) ? "danger" : "ok"],
    ["Security", locked ? "Locked" : "Armed", securityFresh ? `Audit ${fmtTime(workflowState.security.lastAuditAt)}` : "Audit not run", securityFresh ? 100 : 35, locked ? "ok" : "warn"],
    ["IX Capacity", `${profilesForRun}/${maxProfiles}`, `${workflowState.ixbrowser.maxConcurrentProfiles} concurrent max`, Math.min(100, (profilesForRun / maxProfiles) * 100), profilesForRun > maxProfiles ? "danger" : "ok"],
    ["Sources", discoveryUrlCount, `${workflowState.productDiscovery?.primaryStore || "store"} discovery URLs`, discoveryUrlCount ? 100 : 20, discoveryUrlCount ? "ok" : "warn"],
    ["Products", productUrlCount, `${imageCounts.approved} approved / ${imageCounts.pending} pending review images`, productUrlCount && imageCounts.approved >= productUrlCount ? 100 : 35, productUrlCount && imageCounts.approved >= productUrlCount ? "ok" : "warn"],
    ["Post Texts", postTextCount, `${workflowState.contentRotation.postTextCursor || 0} next line index`, postTextCount ? 100 : 20, postTextCount ? "ok" : "warn"],
    ["Comment Leads", commentLeadCount, `${workflowState.contentRotation.commentLeadInCursor || 0} next line index`, commentLeadCount ? 100 : 20, commentLeadCount ? "ok" : "warn"],
    ["Groups", groupCount, "Facebook group URLs loaded", groupCount ? 100 : 20, groupCount ? "ok" : "warn"],
    ["Memory", `${workflowState.memory.maxJobRuntimeMinutes}m`, `${workflowState.memory.maxPromptTextLines} text lines in prompt`, 80, "ok"],
    ["Schedule", workflowState.operator.scheduleEnabled ? "On" : "Off", `${workflowState.operator.startTime || "--:--"} to ${workflowState.operator.stopTime || "--:--"}`, workflowState.operator.scheduleEnabled ? 100 : 35, workflowState.operator.scheduleEnabled ? "ok" : "warn"],
    ["Autopilot", workflowState.operator.autopilotEnabled ? "On" : "Off", workflowState.triggers.autoStartQueuedJobs ? "queue auto-start enabled" : "manual start", workflowState.operator.autopilotEnabled ? 80 : 35, workflowState.operator.autopilotEnabled ? "warn" : "ok"],
  ];
  $("analyticsGrid").innerHTML = metrics.map(([title, value, detail, percent, status]) => `
    <div class="metricCard ${escapeHtml(status)}">
      <strong>${escapeHtml(title)}</strong>
      <b>${escapeHtml(value)}</b>
      <span>${escapeHtml(detail)}</span>
      <div class="metricBar" style="--value:${Math.max(0, Math.min(100, Number(percent) || 0))}%"><i></i></div>
    </div>
  `).join("");
  $("analyticsUpdated").textContent = `updated ${new Date().toLocaleTimeString()}`;
}

function emojiLikeCount(text = "") {
  let count = 0;
  for (const char of String(text || "")) {
    const cp = char.codePointAt(0);
    if (
      (cp >= 0x1f000 && cp <= 0x1faff)
      || (cp >= 0x2600 && cp <= 0x27bf)
      || (cp >= 0x2300 && cp <= 0x23ff)
    ) count += 1;
  }
  return count;
}

function textEmojiDiagnostics(text = "") {
  const questionRuns = String(text || "").match(/\?\?+/g) || [];
  const emojiCount = emojiLikeCount(text);
  return {
    emojiCount,
    questionRunCount: questionRuns.length,
    suspicious: emojiCount === 0 && questionRuns.length > 0,
  };
}

function renderTextEmojiStatus() {
  if (!$("textEmojiStatus") || !workflowState) return;
  const diagnostics = textEmojiDiagnostics(workflowState.contentRotation?.postTexts || "");
  if (diagnostics.suspicious) {
    $("textEmojiStatus").textContent = `Warning: no real emoji characters are saved, but ${diagnostics.questionRunCount} "??" sequence(s) exist. Re-paste real emojis in the dashboard before running posts.`;
    $("textEmojiStatus").className = "hint span2 dangerText";
    return;
  }
  $("textEmojiStatus").textContent = diagnostics.emojiCount
    ? `${diagnostics.emojiCount} emoji character(s) are saved and will be used from the dashboard text bank.`
    : "No emoji characters detected in the saved post text bank.";
  $("textEmojiStatus").className = "hint span2";
}

function jobCounts(jobs = []) {
  return jobs.reduce((acc, job) => {
    const status = job.status || "unknown";
    acc[status] = (acc[status] || 0) + 1;
    acc.total += 1;
    return acc;
  }, { total: 0, queued: 0, running: 0, done: 0, failed: 0, stopped: 0 });
}

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = String(value);
}

function setRuntimePower(enabled) {
  runtimeEnabled = Boolean(enabled);
  setValue("systemPowerToggleRail", enabled);
  setText("systemPowerTitleRail", enabled ? "System on" : "System off");
  setText("systemPowerBadge", enabled ? "system on" : "system off");
  setText("systemPowerBadgeRail", enabled ? "worker enabled" : "worker stopped");
  $("systemPowerBadge")?.classList.toggle("danger", enabled);
  $("systemPowerBadge")?.classList.toggle("safe", !enabled);
  renderSafetySnapshot();
}

function firstAvailableValue(ids, fallback = false) {
  for (const id of ids) {
    if ($(id)) return getValue(id);
  }
  return fallback;
}

function operatorToggleValue(key) {
  return firstAvailableValue(OPERATOR_TOGGLE_GROUPS[key] || [], Boolean(workflowState?.operator?.[key]));
}

function renderOperatorToggleLabels() {
  const approvalRequired = operatorToggleValue("approvalRequired");
  const autopilotEnabled = operatorToggleValue("autopilotEnabled");
  const externalArmed = operatorToggleValue("armedForExternalActions");
  setText("approvalRequiredRailBadge", approvalRequired ? "required" : "not required");
  setText("autopilotEnabledRailBadge", autopilotEnabled ? "enabled" : "off");
  setText("armedForExternalActionsRailBadge", externalArmed ? "armed" : "locked");
}

function renderSafetySnapshot() {
  if (!$("safetySnapshotGrid") || !workflowState) return;
  const approvalRequired = operatorToggleValue("approvalRequired");
  const autopilotEnabled = operatorToggleValue("autopilotEnabled");
  const externalArmed = operatorToggleValue("armedForExternalActions");
  const cards = [
    ["Worker", runtimeEnabled ? "On" : "Off", runtimeEnabled ? "Queue can process tasks" : "Queue is paused", runtimeEnabled ? "warn" : "ok"],
    ["Human Approval", approvalRequired ? "Required" : "Off", approvalRequired ? "Manual confirmation gate is active" : "Manual gate is disabled", approvalRequired ? "ok" : "warn"],
    ["Autopilot", autopilotEnabled ? "On" : "Off", autopilotEnabled ? "Autonomous mode is enabled" : "Manual operation", autopilotEnabled ? "warn" : "ok"],
    ["External Actions", externalArmed ? "Armed" : "Locked", externalArmed ? "Browser/proxy actions can run" : "Browser/proxy actions blocked", externalArmed ? "danger" : "ok"],
  ];
  $("safetySnapshotGrid").innerHTML = cards.map(([title, value, detail, tone]) => `
    <div class="safetyCard ${escapeHtml(tone)}">
      <strong>${escapeHtml(title)}</strong>
      <b>${escapeHtml(value)}</b>
      <span>${escapeHtml(detail)}</span>
    </div>
  `).join("");
}

function jobProgress(job) {
  const status = job.status || "queued";
  if (status === "done") return 100;
  if (status === "failed" || status === "stopped") return 100;
  if (status === "running") {
    const startedAt = Date.parse(job.startedAt || job.createdAt || "");
    const maxRuntimeMs = Math.max(1, Number(workflowState?.memory?.maxJobRuntimeMinutes || 30)) * 60 * 1000;
    if (!Number.isFinite(startedAt)) return 12;
    return Math.max(8, Math.min(96, ((Date.now() - startedAt) / maxRuntimeMs) * 100));
  }
  return 0;
}

function jobStatusTone(status) {
  if (status === "done") return "ok";
  if (status === "failed" || status === "stopped") return "danger";
  if (status === "running") return "running";
  return "queued";
}

function jobStatusRank(job) {
  const ranks = { running: 0, queued: 1, failed: 2, stopped: 3, done: 4 };
  return ranks[job.status] ?? 5;
}

function jobRuntimeText(job) {
  const start = Date.parse(job.startedAt || "");
  const finish = Date.parse(job.finishedAt || "");
  if (job.status === "queued") return "waiting";
  if (Number.isFinite(start) && Number.isFinite(finish)) return fmtDuration(finish - start);
  if (Number.isFinite(start)) return fmtDuration(Date.now() - start);
  return "not started";
}

function queuePosition(job, jobs) {
  if (job.status !== "queued") return "";
  const queued = jobs.filter((item) => item.status === "queued");
  const index = queued.findIndex((item) => item.id === job.id);
  return index >= 0 ? `queue #${index + 1} of ${queued.length}` : "queued";
}

function renderProgress(percent, tone, label) {
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  return `
    <div class="taskProgress ${escapeHtml(tone)}" aria-label="${escapeHtml(label)}">
      <span style="--value:${value}%"><i></i></span>
      <b>${Math.round(value)}%</b>
    </div>
  `;
}

function updateProgressBox(ids, title, value, detail, tone) {
  const box = $(ids.box);
  if (!box) return;
  box.className = `${ids.baseClass || "currentProgress"} ${tone || "running"}`;
  setText(ids.title, title || "Running");
  setText(ids.percent, `${Math.round(value)}%`);
  setText(ids.detail, detail || "");
  $(ids.fill)?.style.setProperty("--value", `${value}%`);
}

function defaultTestPipelineState() {
  return Object.fromEntries(TEST_PIPELINE_STEPS.map(([id, label]) => [id, { label, status: "waiting", detail: "" }]));
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function testElapsedMs(now = Date.now()) {
  const started = Date.parse(lastTestTiming.startedAt || "");
  if (!Number.isFinite(started)) return 0;
  const finished = Date.parse(lastTestTiming.finishedAt || "");
  return Math.max(0, (Number.isFinite(finished) ? finished : now) - started);
}

function testElapsedText() {
  return lastTestTiming.startedAt ? `Elapsed: ${formatDuration(testElapsedMs())}` : "";
}

function withTestElapsedDetail(detail = "") {
  const elapsed = testElapsedText();
  return [detail, elapsed].filter(Boolean).join(" | ");
}

function touchTestRun() {
  lastTestRunUpdatedAt = new Date().toISOString();
}

function setTestRunProgress(title, percent, detail = "", tone = "running", options = {}) {
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  const now = new Date().toISOString();
  if (tone === "running" && !lastTestTiming.startedAt) {
    lastTestTiming.startedAt = now;
    lastTestTiming.finishedAt = "";
  }
  if (["ok", "warn", "danger"].includes(tone || "") && lastTestTiming.startedAt && !lastTestTiming.finishedAt && value >= 100) {
    lastTestTiming.finishedAt = now;
  }
  lastTestProgress = {
    title: title || "Running",
    percent: value,
    detail: detail || "",
    tone: tone || "running",
    updatedAt: now,
  };
  touchTestRun();
  updateProgressBox({
    box: "testPostProgress",
    title: "testPostProgressTitle",
    percent: "testPostProgressPercent",
    detail: "testPostProgressDetail",
    fill: "testPostProgressFill",
    baseClass: "currentProgress panelProgress",
  }, lastTestProgress.title, value, withTestElapsedDetail(lastTestProgress.detail), lastTestProgress.tone);
  if (!options.skipPersist) scheduleTestRunPersist();
}

function renderTestRunProgress() {
  const progress = lastTestProgress || {};
  updateProgressBox({
    box: "testPostProgress",
    title: "testPostProgressTitle",
    percent: "testPostProgressPercent",
    detail: "testPostProgressDetail",
    fill: "testPostProgressFill",
    baseClass: "currentProgress panelProgress",
  }, progress.title || "Idle", Math.max(0, Math.min(100, Number(progress.percent) || 0)), withTestElapsedDetail(progress.detail || "Click Run 1-Post Full Test to start the workflow."), progress.tone || "idle");
}

function idleTestRunPayload() {
  const now = new Date().toISOString();
  return {
    status: "idle",
    active: false,
    updatedAt: now,
    progress: {
      title: "Idle",
      percent: 0,
      detail: "Click Run 1-Post Full Test to start the workflow.",
      tone: "idle",
      updatedAt: now,
    },
    timing: {
      startedAt: "",
      finishedAt: "",
      elapsedMs: 0,
    },
    steps: defaultTestPipelineState(),
    result: {
      profile: "",
      groupUrl: "",
      planId: "",
      postUrl: "",
    },
  };
}

async function clearTestRun() {
  if (activeTestAbortController) {
    activeTestAbortController.abort();
    activeTestAbortController = null;
  }
  // The Stop button must clear BOTH the 1-post test AND the N-parallel test. Hard-stop the
  // parallel run server-side (clears its flush timer + marks lanes stopped + active=false).
  try { await api("/api/posting/stop-test-parallel", { method: "POST", body: "{}", timeoutMs: 15000 }); } catch (e) { /* best-effort */ }
  const lanesHost = $("testParallelLanes"); if (lanesHost) lanesHost.innerHTML = "";
  window.clearTimeout(testProgressSaveTimer);
  window.clearTimeout(localProgressClearTimer);
  restoringTestRun = true;
  try {
    const idle = idleTestRunPayload();
    testPipelineState = idle.steps;
    lastTestRunResult = {};
    lastTestProgress = idle.progress;
    lastTestTiming = idle.timing;
    lastTestRunUpdatedAt = idle.updatedAt;
    renderTestPipelineSteps();
    renderTestRunResult({}, { persist: false });
    renderTestRunProgress();
    setValue("publishedPostUrlInput", "");
    setValue("publishedPostPlanIdInput", "");
    setValue("publishedPostProfileInput", "");
    setValue("publishedPostGroupInput", "");
    const status = $("publishedPostUrlStatus");
    if (status) {
      status.className = "inlineNotice neutral";
      status.textContent = "No Facebook post URL recorded in this browser session.";
    }
    localProgressActive = false;
    renderCurrentProgressFromJobs(lastJobs);
    workflowOutput("No workflow action has run in this browser session.");
    const result = await api("/api/test-progress", {
      method: "POST",
      body: JSON.stringify({ testRun: idle }),
      timeoutMs: 15000,
    });
    if (result.state) workflowState = { ...workflowState, updatedAt: result.state.updatedAt, testRun: result.state.testRun };
  } finally {
    restoringTestRun = false;
    setBusy(false);
  }
  showToast("1-post test progress cleared.");
}

function setCurrentProgress(title, percent, detail = "", tone = "running", options = {}) {
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  if (options.local) {
    localProgressActive = true;
    window.clearTimeout(localProgressClearTimer);
  }
  updateProgressBox({
    box: "currentProgress",
    title: "currentProgressTitle",
    percent: "currentProgressPercent",
    detail: "currentProgressDetail",
    fill: "currentProgressFill",
  }, title, value, detail, tone);
  if (options.testRun) setTestRunProgress(title, value, detail, tone);
}

function finishLocalProgress(title, detail = "", tone = "ok", options = {}) {
  setCurrentProgress(title, 100, detail, tone, { local: true, testRun: Boolean(options.testRun) });
  window.clearTimeout(localProgressClearTimer);
  localProgressClearTimer = window.setTimeout(() => {
    localProgressActive = false;
    renderCurrentProgressFromJobs(lastJobs);
  }, 4200);
}

function renderCurrentProgressFromJobs(jobs = []) {
  if (localProgressActive) return;
  const activeJob = (Array.isArray(jobs) ? jobs : []).find((job) => job.status === "running");
  if (activeJob) {
    setCurrentProgress(activeJob.title || "Hermes task running", jobProgress(activeJob), jobRuntimeText(activeJob), "running");
    return;
  }
  const queued = (Array.isArray(jobs) ? jobs : []).filter((job) => job.status === "queued").length;
  setCurrentProgress(queued ? "Waiting for approval / queue" : "Idle", 0, queued ? `${queued} queued task(s).` : "No workflow is running.", queued ? "warn" : "idle");
}

function testRunSnapshot() {
  const stepStatuses = Object.values(testPipelineState || {}).map((step) => step.status);
  const active = stepStatuses.includes("running");
  const failed = stepStatuses.includes("failed");
  if (lastTestTiming.startedAt && !active && (failed || lastTestRunResult?.postUrl) && !lastTestTiming.finishedAt) {
    lastTestTiming.finishedAt = new Date().toISOString();
  }
  const touched = stepStatuses.some((status) => status && status !== "waiting")
    || Object.values(lastTestRunResult || {}).some(Boolean)
    || (lastTestProgress?.title && lastTestProgress.title !== "Idle");
  const status = active ? "running"
    : failed ? "blocked"
      : lastTestRunResult?.postUrl ? "done"
        : touched ? "ready"
          : "idle";
  return {
    status,
    active,
    updatedAt: lastTestRunUpdatedAt || new Date().toISOString(),
    progress: {
      title: lastTestProgress?.title || "Idle",
      percent: Math.max(0, Math.min(100, Number(lastTestProgress?.percent) || 0)),
      detail: lastTestProgress?.detail || "",
      tone: lastTestProgress?.tone || "idle",
      updatedAt: lastTestProgress?.updatedAt || lastTestRunUpdatedAt || "",
    },
    timing: {
      startedAt: lastTestTiming.startedAt || "",
      finishedAt: lastTestTiming.finishedAt || "",
      elapsedMs: testElapsedMs(),
    },
    steps: testPipelineState || defaultTestPipelineState(),
    result: {
      profile: lastTestRunResult?.profile || "",
      groupUrl: lastTestRunResult?.groupUrl || "",
      planId: lastTestRunResult?.planId || "",
      postUrl: lastTestRunResult?.postUrl || "",
      candidatePostUrls: Array.isArray(lastTestRunResult?.candidatePostUrls) ? lastTestRunResult.candidatePostUrls : [],
    },
  };
}

function scheduleTestRunPersist() {
  if (restoringTestRun || !workflowState) return;
  window.clearTimeout(testProgressSaveTimer);
  testProgressSaveTimer = window.setTimeout(() => {
    persistTestRunNow().catch((err) => console.warn("test_progress_save_failed", err));
  }, 350);
}

async function persistTestRunNow() {
  if (restoringTestRun || testProgressSaving || !workflowState) return;
  testProgressSaving = true;
  try {
    const result = await api("/api/test-progress", {
      method: "POST",
      body: JSON.stringify({ testRun: testRunSnapshot() }),
      timeoutMs: 15000,
    });
    if (result.state) workflowState = { ...workflowState, updatedAt: result.state.updatedAt, testRun: result.state.testRun };
  } finally {
    testProgressSaving = false;
  }
}

function resetTestPipelineSteps(options = {}) {
  testPipelineState = defaultTestPipelineState();
  lastTestTiming = {
    startedAt: options.keepTiming ? (lastTestTiming.startedAt || "") : new Date().toISOString(),
    finishedAt: "",
  };
  touchTestRun();
  renderTestPipelineSteps();
  if (options.persist !== false && !restoringTestRun) scheduleTestRunPersist();
}

function updateTestPipelineStep(id, status, detail = "", options = {}) {
  if (!testPipelineState[id]) resetTestPipelineSteps({ persist: false });
  const prev = testPipelineState[id] || {};
  const next = {
    ...prev,
    status,
    detail,
  };
  // Track wall-clock duration per step. Start timer when first entering a
  // "running" state; finalize duration when transitioning to a terminal status.
  const now = Date.now();
  if (status === "running" && !prev.startedAtMs) {
    next.startedAtMs = now;
    next.elapsedMs = undefined;
  } else if (status === "done" || status === "failed" || status === "skipped") {
    if (prev.startedAtMs && !prev.elapsedMs) {
      next.elapsedMs = now - prev.startedAtMs;
    } else if (!prev.startedAtMs && status === "skipped") {
      next.elapsedMs = 0;
    }
  }
  testPipelineState[id] = next;
  touchTestRun();
  renderTestPipelineSteps();
  if (options.persist !== false && !restoringTestRun) scheduleTestRunPersist();
}

function formatStepDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "";
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(sec / 60);
  const remainder = Math.round(sec - minutes * 60);
  return `${minutes}m ${remainder}s`;
}

function liveValidationErrors(result = {}) {
  return Array.isArray(result.validation?.errors) ? result.validation.errors.map(String) : [];
}

function liveValidationWarnings(result = {}) {
  return Array.isArray(result.validation?.warnings) ? result.validation.warnings.map(String) : [];
}

function liveCommentSuccessDetail(result = {}) {
  const fallbackProfile = result.commentProfile && result.commentProfile !== result.profile
    ? `First comment verified with fallback profile ${result.commentProfile}. `
    : "";
  const warnings = liveValidationWarnings(result);
  if (warnings.some((warning) => /comment_pin_not_available/i.test(warning))) {
    return `${fallbackProfile}Pin option not available in this group/profile.`;
  }
  if (warnings.some((warning) => /comment_pin_not_verified/i.test(warning))) {
    return `${fallbackProfile}Facebook did not confirm the pin.`;
  }
  return fallbackProfile || (result.validation?.pinRequired === false ? "First comment verified; pin not required." : "First comment and pin verified.");
}

function liveCommentBlockDetail(result = {}) {
  const errors = liveValidationErrors(result);
  const blocked = errors.find((error) => /^comment_blocked:/i.test(error));
  const reason = blocked ? blocked.replace(/^comment_blocked:/i, "").replace(/[_-]+/g, " ") : "";
  const logRows = Array.isArray(result.liveLog) ? result.liveLog : [];
  const commentStep = [...logRows].reverse().find((item) => item?.step === "comment_attempted" && (item.blocked || item.restrictionText));
  const restriction = String(commentStep?.restrictionText || "").replace(/\s+/g, " ").trim();
  if (!blocked && !restriction) return "";
  return [
    "Facebook blocked the first comment",
    reason ? `reason: ${reason}` : "",
    restriction ? `message: ${restriction.slice(0, 260)}` : "",
    result.liveLogFile ? `log: ${result.liveLogFile}` : "",
  ].filter(Boolean).join(". ");
}

function liveValidationDetail(result = {}) {
  const commentBlock = liveCommentBlockDetail(result);
  if (commentBlock) return commentBlock;
  const errors = liveValidationErrors(result);
  if (errors.length) return `Facebook verification failed: ${errors.join(", ")}${result.liveLogFile ? ` (log: ${result.liveLogFile})` : ""}`;
  const warnings = liveValidationWarnings(result);
  if (warnings.length) return `Facebook verification warning: ${warnings.join(", ")}${result.liveLogFile ? ` (log: ${result.liveLogFile})` : ""}`;
  return result.message || "";
}

function livePostValidationFailed(errors = []) {
  return errors.some((error) => {
    const text = String(error || "");
    if (/comment|pin|ufi/i.test(text)) return false;
    return /image|post_media|upload|post_image|post_not/i.test(text);
  });
}

function liveCommentValidationFailed(errors = []) {
  return errors.some((error) => /comment|pin/i.test(error));
}

let testPipelineLiveTickerTimer = null;
function scheduleTestPipelineLiveTicker() {
  if (testPipelineLiveTickerTimer) return;
  testPipelineLiveTickerTimer = setInterval(() => {
    const stillRunning = Object.values(testPipelineState).some((step) => step?.status === "running" && step?.startedAtMs);
    if (!stillRunning) {
      clearInterval(testPipelineLiveTickerTimer);
      testPipelineLiveTickerTimer = null;
      return;
    }
    renderTestPipelineSteps({ fromTicker: true });
  }, 1000);
}

function renderTestPipelineSteps() {
  const box = $("testPipelineSteps");
  if (!box) return;
  const labelForStatus = (status) => {
    if (status === "done") return "✓";
    if (status === "failed") return "×";
    if (status === "running") return "RUN";
    if (status === "skipped") return "SKIP";
    return "WAIT";
  };
  const nowMs = Date.now();
  box.innerHTML = TEST_PIPELINE_STEPS.map(([id, fallbackLabel]) => {
    const step = testPipelineState[id] || { label: fallbackLabel, status: "waiting", detail: "" };
    let durationText = "";
    if (step.status === "running" && step.startedAtMs) {
      durationText = formatStepDuration(nowMs - step.startedAtMs);
    } else if ((step.status === "done" || step.status === "failed" || step.status === "skipped") && step.elapsedMs != null) {
      durationText = formatStepDuration(step.elapsedMs);
    }
    return `
      <div class="pipelineStep ${escapeHtml(step.status)}">
        <strong>${escapeHtml(step.label || fallbackLabel)}</strong>
        <b>${escapeHtml(labelForStatus(step.status))}</b>
        ${durationText ? `<i class="pipelineStepDuration" title="Step duration">${escapeHtml(durationText)}</i>` : ""}
        <span>${escapeHtml(step.detail || "Waiting")}</span>
      </div>
    `;
  }).join("");
  // Keep running-step duration ticking once per second so the user sees live elapsed time
  scheduleTestPipelineLiveTicker();
}

function renderTestRunResult(update = {}, options = {}) {
  lastTestRunResult = { ...lastTestRunResult, ...update };
  const box = $("testRunResult");
  if (!box) {
    if (options.persist !== false && !restoringTestRun) scheduleTestRunPersist();
    return;
  }
  const postUrl = lastTestRunResult.postUrl || "";
  const profile = lastTestRunResult.profile || "";
  const groupUrl = lastTestRunResult.groupUrl || "";
  const planId = lastTestRunResult.planId || "";
  const candidatePostUrls = Array.isArray(lastTestRunResult.candidatePostUrls) ? lastTestRunResult.candidatePostUrls.filter(Boolean) : [];
  const pieces = [
    profile ? `Profile: ${profile}` : "",
    groupUrl ? `Group: ${groupUrl}` : "",
    planId ? `Plan: ${planId}` : "",
    postUrl ? `Post URL: ${postUrl}` : "",
    !postUrl && candidatePostUrls[0] ? `Candidate URL: ${candidatePostUrls[0]}` : "",
    lastTestTiming.startedAt ? `${lastTestTiming.finishedAt ? "Total time" : "Elapsed"}: ${formatDuration(testElapsedMs())}` : "",
  ].filter(Boolean);
  box.className = `testRunResult inlineNotice ${postUrl ? "ok" : pieces.length ? "warn" : "neutral"}`;
  box.textContent = pieces.length ? pieces.join(" | ") : "No 1-post test result yet.";
  if (postUrl) setValue("publishedPostUrlInput", postUrl);
  else if (candidatePostUrls[0]) setValue("publishedPostUrlInput", candidatePostUrls[0]);
  if (planId) setValue("publishedPostPlanIdInput", planId);
  if (profile) setValue("publishedPostProfileInput", profile);
  if (groupUrl) setValue("publishedPostGroupInput", groupUrl);
  const urlStatus = $("publishedPostUrlStatus");
  if (urlStatus && postUrl) {
    urlStatus.className = "inlineNotice ok";
    urlStatus.textContent = `Recorded Facebook post URL: ${postUrl}`;
  }
  if (!restoringTestRun) touchTestRun();
  if (options.persist !== false && !restoringTestRun) scheduleTestRunPersist();
}

function restoreTestRunState(testRun = {}) {
  const incomingAt = Date.parse(testRun?.updatedAt || testRun?.progress?.updatedAt || "");
  const localAt = Date.parse(lastTestRunUpdatedAt || "");
  if (testProgressSaveTimer && Number.isFinite(incomingAt) && Number.isFinite(localAt) && incomingAt < localAt) return;
  restoringTestRun = true;
  try {
    const restoredSteps = defaultTestPipelineState();
    const sourceSteps = testRun?.steps && typeof testRun.steps === "object" ? testRun.steps : {};
    const incomingStatus = String(testRun?.status || "").toLowerCase();
    const preserveLocalProgress = incomingStatus && incomingStatus !== "idle";
    for (const [id, fallbackLabel] of TEST_PIPELINE_STEPS) {
      const step = sourceSteps[id] || {};
      const localStep = testPipelineState?.[id] || {};
      const incomingStepStatus = ["waiting", "running", "done", "failed", "skipped"].includes(step.status) ? step.status : "waiting";
      const shouldPreserveLocalStep = preserveLocalProgress
        && incomingStepStatus === "waiting"
        && !step.detail
        && ["running", "done", "failed", "skipped"].includes(localStep.status);
      restoredSteps[id] = {
        label: step.label || localStep.label || fallbackLabel,
        status: shouldPreserveLocalStep ? localStep.status : incomingStepStatus,
        detail: shouldPreserveLocalStep ? (localStep.detail || "") : (step.detail || ""),
      };
    }
    testPipelineState = restoredSteps;
    lastTestRunResult = {
      profile: testRun?.result?.profile || "",
      groupUrl: testRun?.result?.groupUrl || "",
      planId: testRun?.result?.planId || "",
      postUrl: testRun?.result?.postUrl || "",
      candidatePostUrls: Array.isArray(testRun?.result?.candidatePostUrls) ? testRun.result.candidatePostUrls : [],
    };
    const progress = testRun?.progress || {};
    lastTestProgress = {
      title: progress.title || "Idle",
      percent: Math.max(0, Math.min(100, Number(progress.percent) || 0)),
      detail: progress.detail || "Click Run 1-Post Full Test to start the workflow.",
      tone: progress.tone || "idle",
      updatedAt: progress.updatedAt || testRun?.updatedAt || "",
    };
    const timing = testRun?.timing && typeof testRun.timing === "object" ? testRun.timing : {};
    lastTestTiming = {
      startedAt: timing.startedAt || testRun?.startedAt || "",
      finishedAt: timing.finishedAt || testRun?.finishedAt || "",
    };
    lastTestRunUpdatedAt = testRun?.updatedAt || progress.updatedAt || "";
    renderTestPipelineSteps();
    renderTestRunResult({}, { persist: false });
    renderTestRunProgress();
  } finally {
    restoringTestRun = false;
  }
}

function inferButtonTooltip(button) {
  if (button.dataset.tooltip) return button.dataset.tooltip;
  if (button.dataset.viewTarget) return `Opens the ${button.textContent.trim()} tab.`;
  if (button.dataset.wizardStep) return `Shows the ${button.textContent.trim().replace(/\s+/g, " ")} wizard step.`;
  if (button.dataset.wizardNext) return "Moves to the next setup wizard step.";
  if (button.dataset.wizardOpen) return `Opens the ${button.dataset.wizardOpen} tab from the wizard.`;
  if (button.dataset.wizardAction) return `Runs the ${button.textContent.trim()} wizard action.`;
  if (button.dataset.template) return `Queues a Hermes planning task for ${button.textContent.trim()}.`;
  const text = button.textContent.trim();
  if (/refresh/i.test(text)) return "Reloads the latest dashboard data.";
  if (/save/i.test(text)) return "Saves the current dashboard settings.";
  if (/clear/i.test(text)) return "Clears the matching visible list or output.";
  if (/open/i.test(text)) return "Opens the matching tab, browser, folder, or workflow target.";
  if (/load/i.test(text)) return "Loads the matching data into this dashboard.";
  if (/test|check/i.test(text)) return "Runs a local check and shows the result.";
  if (/next/i.test(text)) return "Moves to the next step.";
  return "";
}

function applyButtonTooltips() {
  document.querySelectorAll("button").forEach((button) => {
    const tooltip = BUTTON_TOOLTIPS[button.id] || inferButtonTooltip(button);
    if (!tooltip) return;
    button.dataset.tooltip = tooltip;
    button.title = tooltip;
    if (!button.getAttribute("aria-label")) button.setAttribute("aria-label", button.textContent.trim() || tooltip);
  });
}

function renderJobCard(job, index, jobs, options = {}) {
  const progress = jobProgress(job);
  const tone = jobStatusTone(job.status);
  const queueText = queuePosition(job, jobs);
  const text = [
    job.error ? `ERROR\n${job.error}` : "",
    job.output || "",
    options.compact ? "" : job.text || "",
  ].filter(Boolean).join("\n\n");
  const meta = [
    job.mode || "plan",
    `created ${fmtTime(job.createdAt)}`,
    job.startedAt ? `started ${fmtTime(job.startedAt)}` : "",
    job.finishedAt ? `finished ${fmtTime(job.finishedAt)}` : "",
    queueText,
    `runtime ${jobRuntimeText(job)}`,
  ].filter(Boolean).join(" | ");
  return `
    <article class="taskCard ${escapeHtml(tone)}">
      <div class="jobHead">
        <div>
          <strong>${escapeHtml(job.title || "Untitled task")}</strong>
          <p>${escapeHtml(meta)}</p>
        </div>
        <span class="badge ${escapeHtml(job.status || "queued")}">${escapeHtml(job.status || "queued")}</span>
      </div>
      ${renderProgress(progress, tone, `${job.title || "Task"} progress`)}
      <div class="taskMeta">
        <span>${escapeHtml(job.id || `task-${index + 1}`)}</span>
        <span>${escapeHtml(queueText || jobRuntimeText(job))}</span>
      </div>
      ${text ? `<pre>${escapeHtml(text.slice(0, options.compact ? 2400 : 9000))}</pre>` : ""}
    </article>
  `;
}

function renderRunMonitor(jobs = [], events = []) {
  if (!$("runMonitorSummary")) return;
  const counts = jobCounts(jobs);
  const finalCount = (counts.done || 0) + (counts.failed || 0) + (counts.stopped || 0);
  const issueCount = (counts.failed || 0) + (counts.stopped || 0);
  const overallProgress = counts.total ? (finalCount / counts.total) * 100 : 100;
  const activeJobs = jobs.filter((job) => job.status === "running");
  const activeJob = activeJobs[0];
  setText("monitorRunningCount", counts.running || 0);
  setText("monitorQueuedCount", counts.queued || 0);
  setText("monitorFinishedCount", finalCount);
  setText("monitorIssueCount", issueCount);
  setText("queueUpdated", `updated ${new Date().toLocaleTimeString()}`);
  renderCurrentProgressFromJobs(jobs);
  const cards = [
    ["Overall", `${Math.round(overallProgress)}%`, `${finalCount}/${counts.total} final`, overallProgress, issueCount ? "danger" : "ok"],
    ["Active", counts.running || 0, activeJob ? activeJob.title : "No active task", activeJob ? jobProgress(activeJob) : 0, activeJob ? "running" : "queued"],
    ["Queued", counts.queued || 0, `${counts.queued || 0} waiting one by one`, counts.total ? ((counts.total - (counts.queued || 0)) / counts.total) * 100 : 100, "queued"],
    ["Done", counts.done || 0, "completed successfully", counts.total ? ((counts.done || 0) / counts.total) * 100 : 0, "ok"],
    ["Issues", issueCount, "failed or stopped", counts.total ? (issueCount / counts.total) * 100 : 0, issueCount ? "danger" : "ok"],
  ];
  $("runMonitorSummary").innerHTML = cards.map(([title, value, detail, percent, tone]) => `
    <div class="monitorCard ${escapeHtml(tone)}">
      <strong>${escapeHtml(title)}</strong>
      <b>${escapeHtml(value)}</b>
      <span>${escapeHtml(detail)}</span>
      ${renderProgress(percent, tone, `${title} progress`)}
    </div>
  `).join("");
  $("activeJobPanel").innerHTML = activeJob
    ? `
      <div class="activeRunHead">
        <span class="badge running">running now</span>
        <strong>${escapeHtml(activeJob.title)}</strong>
        <small>${escapeHtml(jobRuntimeText(activeJob))}</small>
      </div>
      ${renderJobCard(activeJob, 0, jobs, { compact: true })}
    `
    : `
      <div class="emptyRun">
        <strong>No task is running</strong>
        <span>${counts.queued ? `${counts.queued} task(s) waiting in queue.` : "Queue is idle."}</span>
      </div>
    `;
  const ordered = [...jobs].sort((a, b) => {
    const rank = jobStatusRank(a) - jobStatusRank(b);
    if (rank) return rank;
    return Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0);
  });
  $("jobTimeline").innerHTML = ordered.map((job, index) => renderJobCard(job, index, ordered, { compact: true })).join("") || `
    <div class="emptyRun">
      <strong>No tasks yet</strong>
      <span>Queue a Hermes todo from Overview to see it here.</span>
    </div>
  `;
  renderEventTimeline(events);
}

function eventTone(event) {
  const message = String(event.message || "");
  if (/failed|error|invalid|timeout|blocked/i.test(message)) return "danger";
  if (/warning|needs|missing|disabled|stopped/i.test(message)) return "warn";
  if (/ok|saved|loaded|started|queued|finished|enabled|completed/i.test(message)) return "ok";
  return "neutral";
}

function isDashboardAuthEvent(event) {
  return event?.message === "request_failed" && String(event.error || "").includes("Dashboard token is missing or invalid");
}

function compactEventsForDisplay(events) {
  const newestFirst = Array.isArray(events) ? [...events].reverse() : [];
  let authCount = 0;
  let latestAuthAt = "";
  const filtered = [];
  newestFirst.forEach((event) => {
    if (isDashboardAuthEvent(event)) {
      authCount += 1;
      if (!latestAuthAt) latestAuthAt = event.at;
      return;
    }
    filtered.push(event);
  });
  if (authCount) {
    filtered.push({
      at: latestAuthAt,
      message: "dashboard_token_invalid",
      collapsed: authCount,
      note: "Collapsed repeated stale-browser-token API requests after dashboard restart.",
    });
  }
  return filtered
    .sort((a, b) => Date.parse(b.at || 0) - Date.parse(a.at || 0))
    .slice(0, 120);
}

function renderEventTimeline(events = []) {
  if (!$("eventTimeline")) return;
  const visible = compactEventsForDisplay(events);
  $("eventCountBadge").textContent = `${visible.length} event${visible.length === 1 ? "" : "s"}`;
  $("eventTimeline").innerHTML = visible.map((event) => {
    const { at, message, ...rest } = event;
    const extra = Object.keys(rest).length ? JSON.stringify(rest) : "";
    const tone = eventTone(event);
    return `
      <article class="eventItem ${escapeHtml(tone)}">
        <div>
          <strong>${escapeHtml(message || "event")}</strong>
          <span>${escapeHtml(fmtTime(at))}</span>
        </div>
        ${extra ? `<code>${escapeHtml(extra)}</code>` : ""}
      </article>
    `;
  }).join("") || `
    <div class="emptyRun">
      <strong>No events yet</strong>
      <span>Local dashboard events will appear here.</span>
    </div>
  `;
}

function approvalTone(status) {
  if (status === "approved") return "ok";
  if (status === "rejected") return "danger";
  return "warn";
}

function renderApprovalSummary(approvals = lastApprovals) {
  if (!$("approvalSummaryGrid")) return;
  const items = Array.isArray(approvals.items) ? approvals.items : [];
  const pending = Array.isArray(approvals.pending) ? approvals.pending : [];
  const queuedJobs = Array.isArray(approvals.queuedJobs) ? approvals.queuedJobs : [];
  const history = Array.isArray(approvals.history) ? approvals.history : [];
  const approvedCount = items.filter((item) => item.status === "approved").length;
  const rejectedCount = items.filter((item) => item.status === "rejected").length;
  const approvedQueuedCount = queuedJobs.filter((job) => job.queueApprovalStatus === "approved").length;
  const pendingQueuedCount = queuedJobs.length - approvedQueuedCount;
  setText("approvalStatusBadge", `${pending.length} pending`);
  setText("pendingApprovalBadge", `${pending.length} item${pending.length === 1 ? "" : "s"}`);
  setText("approvalQueuedBadge", `${pendingQueuedCount} need approval / ${queuedJobs.length} queued`);
  setText("approvalHistoryBadge", `${history.length} decision${history.length === 1 ? "" : "s"}`);
  setText("approvalPendingCountRail", pending.length);
  setText("approvalQueuedCountRail", queuedJobs.length);
  setText("approvalHistoryCountRail", history.length);
  setText("commandApprovalPending", pending.length);
  setText("commandApprovalQueued", queuedJobs.length);
  setText("monitorApprovalPending", pending.length);
  setText("monitorApprovalQueued", queuedJobs.length);
  const cards = [
    ["Needs validation", pending.length, "Approve or reject before treating accepted", pending.length ? "warn" : "ok"],
    ["Queued Hermes", queuedJobs.length, `${approvedQueuedCount} approved, ${pendingQueuedCount} waiting approval`, pendingQueuedCount ? "warn" : "ok"],
    ["Approved", approvedCount, "Validated by local operator", "ok"],
    ["Rejected", rejectedCount, "Sent back or blocked", rejectedCount ? "danger" : "ok"],
  ];
  $("approvalSummaryGrid").innerHTML = cards.map(([title, value, detail, tone]) => `
    <div class="approvalMetric ${escapeHtml(tone)}">
      <strong>${escapeHtml(title)}</strong>
      <b>${escapeHtml(value)}</b>
      <span>${escapeHtml(detail)}</span>
    </div>
  `).join("");
}

function renderApprovalQueue(approvals = lastApprovals) {
  if (!$("approvalQueue")) return;
  const pending = Array.isArray(approvals.pending) ? approvals.pending : [];
  if (!pending.length) {
    $("approvalQueue").innerHTML = `
      <div class="emptyRun">
        <strong>No pending validation</strong>
        <span>When Hermes outputs a plan or a profile/proxy issue needs review, it will appear here.</span>
      </div>
    `;
    return;
  }
  $("approvalQueue").innerHTML = pending.map((item) => `
    <article class="approvalItem ${escapeHtml(approvalTone(item.status))}">
      <div class="approvalHead">
        <div>
          <strong>${escapeHtml(item.title || "Approval item")}</strong>
          <p>${escapeHtml(item.subtitle || item.type || "pending")}</p>
        </div>
        <span class="badge queued">pending</span>
      </div>
      <pre>${escapeHtml(item.detail || item.raw || "")}</pre>
      <div class="approvalMeta">
        <span>${escapeHtml(item.type || "approval")}</span>
        <span>${escapeHtml(item.createdAt ? fmtTime(item.createdAt) : item.id)}</span>
      </div>
      <div class="approvalActions">
        <button class="primary" data-approval-id="${escapeHtml(item.id)}" data-approval-action="approve">Approve</button>
        <button class="danger" data-approval-id="${escapeHtml(item.id)}" data-approval-action="reject">Reject</button>
      </div>
    </article>
  `).join("");
}

function renderApprovalTaskQueue(approvals = lastApprovals) {
  if (!$("approvalTaskQueue")) return;
  const queued = Array.isArray(approvals.queuedJobs) ? approvals.queuedJobs : [];
  if (!queued.length) {
    $("approvalTaskQueue").innerHTML = `
      <div class="emptyRun">
        <strong>No queued Hermes tasks</strong>
        <span>Queue a todo from Overview or Content to see it here.</span>
      </div>
    `;
    return;
  }
  $("approvalTaskQueue").innerHTML = queued.map((job, index) => `
    <article class="approvalItem ${job.queueApprovalStatus === "approved" ? "ok" : "queued"}">
      <div class="approvalHead">
        <div>
          <strong>${escapeHtml(job.title || "Queued task")}</strong>
          <p>${escapeHtml(`queue #${index + 1} | ${job.mode || "plan"} | ${fmtTime(job.createdAt)}`)}</p>
        </div>
        <span class="badge ${job.queueApprovalStatus === "approved" ? "done" : "queued"}">${job.queueApprovalStatus === "approved" ? "approved to run" : "needs approval"}</span>
      </div>
      <pre>${escapeHtml(job.text || "")}</pre>
      <div class="approvalMeta">
        <span>${job.approvalRequired ? "Human approval required" : "Approval not required"}</span>
        <span>${job.approvedAt ? `Approved ${escapeHtml(fmtTime(job.approvedAt))}` : "Not approved yet"}</span>
      </div>
      <div class="approvalActions">
        ${job.queueApprovalStatus === "approved"
          ? `<button disabled>Approved</button>`
          : `<button class="primary" data-job-approval-id="${escapeHtml(job.id)}" data-job-approval-action="approve">Approve</button>`}
        <button class="danger" data-job-approval-id="${escapeHtml(job.id)}" data-job-approval-action="reject">Reject</button>
      </div>
    </article>
  `).join("");
}

function renderApprovalHistory(approvals = lastApprovals) {
  if (!$("approvalHistory")) return;
  const history = Array.isArray(approvals.history) ? approvals.history : [];
  if (!history.length) {
    $("approvalHistory").innerHTML = `
      <div class="emptyRun">
        <strong>No decisions yet</strong>
        <span>Approvals and rejections are recorded locally here.</span>
      </div>
    `;
    return;
  }
  $("approvalHistory").innerHTML = history.map((item) => `
    <article class="approvalItem ${escapeHtml(approvalTone(item.status))}">
      <div class="approvalHead">
        <div>
          <strong>${escapeHtml(item.title || item.id)}</strong>
          <p>${escapeHtml(`${item.status || "decision"} | ${fmtTime(item.decidedAt)}`)}</p>
        </div>
        <span class="badge ${item.status === "approved" ? "done" : "failed"}">${escapeHtml(item.status || "decision")}</span>
      </div>
      ${item.note ? `<pre>${escapeHtml(item.note)}</pre>` : ""}
    </article>
  `).join("");
}

function renderApprovals(approvals) {
  lastApprovals = {
    items: Array.isArray(approvals?.items) ? approvals.items : [],
    pending: Array.isArray(approvals?.pending) ? approvals.pending : [],
    queuedJobs: Array.isArray(approvals?.queuedJobs) ? approvals.queuedJobs : [],
    history: Array.isArray(approvals?.history) ? approvals.history : [],
  };
  renderApprovalSummary(lastApprovals);
  renderApprovalQueue(lastApprovals);
  renderApprovalTaskQueue(lastApprovals);
  renderApprovalHistory(lastApprovals);
}

async function decideApproval(id, action) {
  const label = action === "reject" ? "Reject" : "Approve";
  const note = prompt(`${label} this item? Optional note:`, "");
  if (note === null) return;
  setBusy(true);
  try {
    const result = await api("/api/approvals/decision", {
      method: "POST",
      body: JSON.stringify({ id, action, note }),
    });
    renderApprovals(result.approvals);
    showToast(`Approval ${action === "reject" ? "rejected" : "approved"}.`);
    await refresh({ force: true });
  } finally {
    setBusy(false);
  }
}

async function approveQueuedJobs({ jobIds = [], allQueued = false, action = "approve" } = {}) {
  const count = allQueued ? lastApprovals.queuedJobs.filter((job) => job.queueApprovalStatus !== "approved").length : jobIds.length;
  if (!count) return showToast("No queued task needs approval.");
  if (action === "reject" && !confirm("Reject this queued task and stop it from running?")) return;
  if (allQueued && !confirm(`Approve all ${count} queued task(s)?`)) return;
  setBusy(true);
  try {
    const result = await api("/api/jobs/approval", {
      method: "POST",
      body: JSON.stringify({ jobIds, allQueued, action }),
    });
    renderApprovals(result.approvals);
    renderJobs(result.jobs);
    showToast(action === "reject" ? "Queued task rejected." : `${result.changed} queued task(s) approved.`);
    await refresh({ force: true });
  } finally {
    setBusy(false);
  }
}

function renderEvents(events) {
  lastEvents = Array.isArray(events) ? events : [];
  renderEventTimeline(lastEvents);
  renderRunMonitor(lastJobs, lastEvents);
  if (!$("events")) return;
  $("events").textContent = lastEvents.map((event) => {
    const { at, message, ...rest } = event;
    const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : "";
    return `${fmtTime(at)} ${message}${extra}`;
  }).join("\n");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function setValue(id, value) {
  const el = $(id);
  if (!el) return;
  if (el.type === "checkbox") el.checked = Boolean(value);
  else el.value = value ?? "";
}

function maskHostForDisplay(value) {
  const text = String(value || "");
  const ipParts = text.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipParts) return `${ipParts[1]}.${ipParts[2]}.*.${ipParts[4]}`;
  if (text.length <= 10) return text;
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

function getValue(id) {
  const el = $(id);
  return el.type === "checkbox" ? el.checked : el.value;
}

function renderState(state) {
  workflowState = state;
  if (__lastSnapshot === null && state) { try { __lastSnapshot = JSON.stringify(state); } catch (e) {} }
  $("stateUpdated").textContent = fmtTime(state.updatedAt);
  renderAnalytics();
  renderTestParallelLanes(state);

  setValue("approvalRequiredRail", state.operator.approvalRequired);
  setValue("armedForExternalActionsRail", state.operator.armedForExternalActions);
  setValue("autopilotEnabledRail", state.operator.autopilotEnabled);
  renderOperatorToggleLabels();
  renderSafetySnapshot();
  renderIncompleteRunBanner(state);
  setValue("scheduleEnabled", state.operator.scheduleEnabled);
  setValue("scheduleTimezone", state.operator.scheduleTimezone);
  setValue("runDays", state.operator.runDays);
  setValue("startTime", state.operator.startTime);
  setValue("stopTime", state.operator.stopTime);

  setValue("minutesBetweenPosts", state.rules.minutesBetweenPosts);
  setValue("randomMinutesBetweenPosts", state.rules.randomMinutesBetweenPosts);
  setValue("minMinutesBetweenPosts", state.rules.minMinutesBetweenPosts);
  setValue("maxMinutesBetweenPosts", state.rules.maxMinutesBetweenPosts);
  setValue("commentsBeforeAccountMove", state.rules.commentsBeforeAccountMove);
  setValue("maxCommentsBeforeAccountSave", state.rules.maxCommentsBeforeAccountSave);
  setValue("postsPerProfilePerDay", state.rules.postsPerProfilePerDay);
  setValue("commentCooldownMinutes", state.rules.commentCooldownMinutes);
  // Read-only machine auto-parallel cap (Step 1): show "N of CAP max" for posting + harvest, plus the box specs.
  {
    const __mc = Number(state.operator?.machineParallelCap);
    const __mp = Number(state.ixbrowser?.maxConcurrentProfiles);
    const __mh = Number(state.posting?.contentSources?.harvestProfilesPerGroup);
    const __postNow = __mc ? Math.min(__mc, isFinite(__mp) && __mp ? __mp : __mc) : null;
    const __harvNow = __mc ? Math.min(Math.min(6, __mc), isFinite(__mh) && __mh ? __mh : __mc) : null;
    setText("machineCapPosting", __mc ? (__postNow + " of " + __mc + " max") : "–");
    setText("machineCapHarvest", __mc ? (__harvNow + " of " + Math.min(6, __mc) + " max") : "–");
    const __cm = state.operator?.machineParallelCapMeta;
    setText("machineCapMeta", __cm ? ("(" + __cm.cores + " vCPU, " + __cm.totalGB + "GB)") : "");
    // same numbers, surfaced prominently in the Production control center
    setText("ccCapPosting", __mc ? String(__postNow) : "–");
    setText("ccCapHarvest", __mc ? String(__harvNow) : "–");
    setText("ccCapMeta", __cm ? ("(" + __cm.cores + " vCPU, " + __cm.totalGB + "GB)") : "");
  }
  setValue("peakHoursTimezone", state.rules.peakHoursTimezone);
  setValue("peakStartTime", state.rules.peakStartTime);
  setValue("peakStopTime", state.rules.peakStopTime);
  setValue("requireDealSignal", state.rules.requireDealSignal);
  setValue("linkPlacement", state.rules.linkPlacement);
  setValue("pinFirstComment", state.rules.pinFirstComment);
  setValue("postBodyLinkAllowed", state.rules.postBodyLinkAllowed);
  setValue("pauseOnErrors", state.rules.pauseOnErrors);
  setValue("pauseOnInvalidProxy", state.rules.pauseOnInvalidProxy);
  setValue("pauseOnLimitedAccount", state.rules.pauseOnLimitedAccount);

  setValue("groups", state.posting.groups);
  setValue("groupProfileAssignments", state.posting.groupProfileAssignments || "");
  groupAssignmentDraft = Array.isArray(state.posting.groupAssignmentData) ? structuredClone(state.posting.groupAssignmentData) : [];
  setValue("equalSplitAssignments", state.posting.equalSplitAssignments === true);
  $("groupAssignmentBuilder")?.classList.toggle("equalSplitOn", state.posting.equalSplitAssignments === true);
  setValue("sourceUrls", state.posting.sourceUrls);
  setValue("shortlinks", state.posting.shortlinks);
  setValue("readyDescriptionsPath", state.posting.readyDescriptionsPath);
  setValue("readyImagesPath", state.posting.readyImagesPath);
  setValue("moderatorAccountNotes", state.posting.moderatorAccountNotes);
  setValue("commentTemplate", state.posting.commentTemplate);
  setValue("postTextsList", state.posting.postTextsList);
  setValue("ownedGroupsByProfile", state.posting.ownedGroupsByProfile);
  setValue("facebookProfileStatus", state.posting.facebookProfileStatus);
  setValue("contentSourcesEnabled", state.posting.contentSources?.enabled);
  setValue("contentSourcesExclusive", state.posting.contentSources?.exclusive);
  setValue("contentSourcesReserveAuto", state.posting.contentSources?.reserveAuto !== false);
  setValue("contentSourcesReserveTarget", state.posting.contentSources?.reserveTarget);
  setValue("contentSourcesReserveRefillAt", state.posting.contentSources?.reserveRefillAt);
  setValue("contentSourcesProfilesPerGroup", state.posting.contentSources?.harvestProfilesPerGroup);
  setValue("contentSourcesPostCta", state.posting.contentSources?.postCta);
  setValue("contentSourcesReuseHours", state.posting.contentSources?.reuseHours);
  setValue("contentSourcesImageRetentionDays", state.posting.contentSources?.imageRetentionDays);
  setValue("contentSourceGroupsText", state.posting.contentSources?.groupsText);
  setValue("contentSourcesNotes", state.posting.contentSources?.notes);
  if (typeof updateContentSourceBranch === "function") updateContentSourceBranch(); // show copy vs scrape branch per saved method
  renderGroupAssignmentBuilder();

  setValue("productAssetsEnabled", state.productAssets.enabled);
  setValue("productUrls", state.productAssets.productUrls);
  setValue("reviewImagesPerProduct", state.productAssets.reviewImagesPerProduct);
  setValue("reviewCandidateCount", state.productAssets.reviewCandidateCount || 5);
  setValue("requireCustomerReviewImages", state.productAssets.requireCustomerReviewImages);
  setValue("requireRealisticImages", state.productAssets.requireRealisticImages);
  setValue("requirePositiveReviewsOnly", state.productAssets.requirePositiveReviewsOnly);
  setValue("productAssetsApprovalRequired", state.productAssets.approvalRequired);
  setValue("reviewImageCandidates", state.productAssets.reviewImageCandidates);
  setValue("selectedReviewImages", state.productAssets.selectedReviewImages);
  setValue("minReviewRating", state.productAssets.minReviewRating);
  setValue("preferredReviewRating", state.productAssets.preferredReviewRating);
  setValue("productAssetsOutputPath", state.productAssets.outputPath);
  setValue("chatgptHdEnabled", state.productAssets.chatgptHdEnabled !== false);
  const hdChecked = state.productAssets.chatgptHdEnabled !== false;
  const labelText = hdChecked ? "ChatGPT HD image step: ON (slow)" : "ChatGPT HD image step: OFF (fast)";
  const hdMirrors = [
    { input: document.getElementById("chatgptHdEnabledRail"), label: document.getElementById("chatgptHdEnabledRailLabel") },
    { input: document.getElementById("chatgptHdEnabledTest"), label: document.getElementById("chatgptHdEnabledTestLabel") },
  ];
  for (const { input, label } of hdMirrors) {
    if (input) input.checked = hdChecked;
    if (label) label.textContent = labelText;
  }
  setValue("chatgptEdgeCdp", state.productAssets.chatgptEdgeCdp || "http://127.0.0.1:9334");
  setValue("chatgptEdgeUserDataDir", state.productAssets.chatgptEdgeUserDataDir || "");
  setValue("chatgptEdgeProfileDirectory", state.productAssets.chatgptEdgeProfileDirectory || "Default");
  setValue("productAssetsNotes", state.productAssets.notes);

  setValue("usePostTextsInOrder", state.contentRotation.usePostTextsInOrder);
  setValue("avoidPostTextReuse", state.contentRotation.avoidPostTextReuse);
  setValue("postTexts", state.contentRotation.postTexts);
  setValue("postTextCursor", state.contentRotation.postTextCursor);
  setValue("useCommentLeadInsInOrder", state.contentRotation.useCommentLeadInsInOrder);
  setValue("avoidCommentLeadInReuse", state.contentRotation.avoidCommentLeadInReuse);
  setValue("commentLeadIns", state.contentRotation.commentLeadIns);
  setValue("commentLeadInCursor", state.contentRotation.commentLeadInCursor);
  setValue("contentRotationNotes", state.contentRotation.notes);

  setValue("dealSourceName", state.dealSource.source);
  setValue("allowedRetailers", state.dealSource.allowedRetailers);
  setValue("selectedFilters", state.dealSource.selectedFilters);
  setValue("priceFilter", state.dealSource.priceFilter);
  setValue("brandFilter", state.dealSource.brandFilter);
  setValue("colorFilter", state.dealSource.colorFilter);
  setValue("categoryFilter", state.dealSource.categoryFilter);
  setValue("dealNotes", state.dealSource.notes);

  const discovery = state.productDiscovery || {};
  setValue("productDiscoveryEnabled", discovery.enabled);
  setValue("discoveryPrimaryStore", discovery.primaryStore);
  setValue("discoveryDailyRefreshEnabled", discovery.dailyRefreshEnabled);
  setValue("discoveryRequireProSeller", discovery.requireProSeller);
  setValue("discoveryIncludeClearance", discovery.includeClearance);
  setValue("discoveryIncludeReducedPrice", discovery.includeReducedPrice);
  setValue("discoveryIncludeRollback", discovery.includeRollback);
  setValue("discoveryAllowedRetailers", discovery.allowedRetailers);
  setValue("walmartCategorySources", discovery.walmartCategorySources);
  setValue("walmartSearchQueries", discovery.walmartSearchQueries);
  setValue("otherStoreSourceUrls", discovery.otherStoreSourceUrls);
  setValue("generatedSourceUrls", discovery.generatedSourceUrls);
  setValue("discoveryMinActivitySignal", discovery.minActivitySignal);
  setValue("discoveryAssignedProfileCount", discovery.assignedProfileCount || 0);
  setValue("discoveryDailyPostTarget", discovery.dailyPostTarget || 0);
  setValue("discoveryCandidateBufferPercent", discovery.candidateBufferPercent ?? 20);
  setValue("discoveryTargetCandidateCount", discovery.targetCandidateCount || 0);
  setValue("discoveryRankingRules", discovery.rankingRules);
  setValue("productDiscoveryNotes", discovery.notes);
  if ($("browserDiscoverySourceUrl") && !getValue("browserDiscoverySourceUrl")) {
    setValue("browserDiscoverySourceUrl", nonCommentLines(discovery.generatedSourceUrls || "")[0] || "");
  }
  syncDiscoverySummaryFields({ mark: false });

  setValue("affiliateEnabled", state.affiliate.enabled);
  setValue("affiliateService", state.affiliate.service);
  setValue("affiliateApiRequestsUseDedicatedProxy", state.affiliate.apiRequestsUseDedicatedProxy);
  setValue("useDedicatedIxProfile", state.affiliate.useDedicatedIxProfile);
  setValue("dedicatedIxProfileId", state.affiliate.dedicatedIxProfileId);
  setValue("dedicatedIxProfileName", state.affiliate.dedicatedIxProfileName);
  setValue("dedicatedIxProfileFixedIp", state.affiliate.dedicatedIxProfileFixedIp);
  setValue("rotateDedicatedProfileIp", state.affiliate.rotateDedicatedProfileIp);
  setValue("generateShortlinksInDedicatedProfile", state.affiliate.generateShortlinksInDedicatedProfile);
  setValue("shopyourlikesBrowserProfilePath", state.affiliate.browserProfilePath || "data/shopyourlikes-browser-profile");
  setValue("shopyourlikesBrowserStartUrl", state.affiliate.browserStartUrl || "https://www.shopyourlikes.com/");
  setValue("shopyourlikesBrowserUseProxy", state.affiliate.browserUseDedicatedProxy !== false);
  if ($("shopYourLikesBrowserStatus")) {
    $("shopYourLikesBrowserStatus").textContent = `SYL browser: ${state.affiliate.browserStatus || "not opened"}${state.affiliate.browserLastOpenedAt ? ` · last opened ${fmtTime(state.affiliate.browserLastOpenedAt)}` : ""}`;
  }
  renderProfileSelect();
  renderShopYourLikesProxySelect();
  setValue("cleanExistingAffiliateLinks", state.affiliate.cleanExistingAffiliateLinks);
  setValue("shortenAfterAffiliate", state.affiliate.shortenAfterAffiliate);
  setValue("affiliateOriginalLinks", state.affiliate.originalLinks);
  setValue("affiliateCleanedLinks", state.affiliate.cleanedLinks);
  setValue("shopyourlikesLinks", state.affiliate.shopyourlikesLinks);
  setValue("finalShortlinks", state.affiliate.finalShortlinks);
  setValue("affiliateNotes", state.affiliate.notes);
  setValue("shortlinkProvider", state.shortlink.provider);
  setValue("shortlinkEnabled", state.shortlink.enabled);
  setValue("shortlinkUseAffiliateDedicatedIxProfile", state.shortlink.useAffiliateDedicatedIxProfile);
  setValue("shortlinkApiRequestsUseAffiliateProxy", state.shortlink.apiRequestsUseAffiliateProxy);
  setValue("shortlinkNotes", state.shortlink.notes);

  setValue("affiliateProxyEnabled", state.affiliateProxy.enabled);
  setValue("affiliateProxyRequiredCountry", state.affiliateProxy.requiredCountry);
  setValue("affiliateProxyStaticOnly", state.affiliateProxy.staticOnly);
  setValue("affiliateProxyLockedToSelectedProxy", state.affiliateProxy.lockedToSelectedProxy);
  setValue("affiliateProxyApiRequestsMustUseProxy", state.affiliateProxy.apiRequestsMustUseProxy);
  setValue("affiliateProxyStatus", state.affiliateProxy.status);
  setValue("affiliateProxySelectedProxyId", maskHostForDisplay(state.affiliateProxy.selectedProxyId));
  setValue("affiliateProxyAddress", maskHostForDisplay(state.affiliateProxy.proxyAddress));
  setValue("affiliateProxyPortState", state.affiliateProxy.proxyPort);
  setValue("affiliateProxyLastObservedIp", maskHostForDisplay(state.affiliateProxy.lastObservedIp));
  setValue("affiliateProxyLastObservedCountry", state.affiliateProxy.lastObservedCountry);

  setValue("webshareEnabled", state.webshare.enabled);
  setValue("webshareApiStatus", state.webshare.apiStatus);
  setValue("currentIp", state.webshare.currentIp);
  setValue("failedIps", state.webshare.failedIps);
  setValue("webshareNotes", state.webshare.notes);
  setValue("proxyProvider", state.proxyProvider.provider);
  setValue("proxyProviderEnabled", state.proxyProvider.enabled);
  setValue("requiredProxyLocation", state.proxyProvider.requiredLocation);
  setValue("proxyProviderApiStatus", state.proxyProvider.apiStatus);
  setValue("proxyProviderNotes", state.proxyProvider.notes);

  setValue("ixbrowserEnabled", state.ixbrowser.enabled);
  setValue("accountSelector", state.ixbrowser.accountSelector);
  setValue("maxProfilesPerRun", state.ixbrowser.maxProfilesPerRun);
  setValue("maxConcurrentProfiles", state.ixbrowser.maxConcurrentProfiles);
  setValue("profilesForNextRun", state.ixbrowser.profilesForNextRun);
  setValue("activeProfiles", state.ixbrowser.activeProfiles);
  setValue("blockedProfiles", state.ixbrowser.blockedProfiles);
  setValue("moderatorProfiles", state.ixbrowser.moderatorProfiles);
  setValue("failedProfiles", state.ixbrowser.failedProfiles);
  setValue("profileIpMap", state.ixbrowser.profileIpMap);
  setValue("profileRunNotes", state.ixbrowser.profileRunNotes);
  setValue("ixbrowserNotes", state.ixbrowser.notes);
  $("activeProfileCount").textContent = `${countLines(state.ixbrowser.activeProfiles)} active`;

  setValue("compactHermesPrompts", state.memory.compactHermesPrompts);
  setValue("includeMiroContext", state.memory.includeMiroContext);
  setValue("maxPromptUrlLines", state.memory.maxPromptUrlLines);
  setValue("maxPromptTextLines", state.memory.maxPromptTextLines);
  setValue("maxPromptTextLineLength", state.memory.maxPromptTextLineLength);
  setValue("maxJobRuntimeMinutes", state.memory.maxJobRuntimeMinutes);
  setValue("maxQueuedJobs", state.memory.maxQueuedJobs);
  setValue("memoryNotes", state.memory.notes);

  setValue("heartbeatSeconds", state.triggers.heartbeatSeconds);
  setValue("autoStartQueuedJobs", state.triggers.autoStartQueuedJobs);
  setValue("pauseWhenSecurityWarnings", state.triggers.pauseWhenSecurityWarnings);
  setValue("pauseWhenExternalPortsChange", state.triggers.pauseWhenExternalPortsChange);
  setValue("triggerNotes", state.triggers.notes);

  $("securityDashboardHost").textContent = `${state.security.dashboardHost}:${state.security.dashboardPort}`;
  $("securityLastAuditAt").textContent = fmtTime(state.security.lastAuditAt);
  $("securityTokenGate").textContent = state.security.requireDashboardToken ? "required" : "missing";
  $("securityOriginGate").textContent = state.security.rejectCrossOriginRequests ? "rejected" : "not enforced";

  setValue("dailyActionLog", state.tracking.dailyActionLog);
  setValue("trackingNotes", state.tracking.notes);

  setValue("extensionEnabled", state.extension.enabled);
  setValue("extensionName", state.extension.name);
  setValue("extensionSource", state.extension.source);
  setValue("shopifyUrlWorkflow", state.extension.shopifyUrlWorkflow);
  setValue("extensionNotes", state.extension.notes);
  restoreTestRunState(state.testRun);

  $("fileGrid").innerHTML = Object.entries(state.files).map(([key, value]) => `
    <div class="fileItem">
      <strong>${escapeHtml(labelize(key))}</strong>
      <code>${escapeHtml(value)}</code>
    </div>
  `).join("");
}

function renderRegisters(registers) {
  workflowRegisters = registers || {};
  $("registerGrid").innerHTML = Object.entries(workflowState.files).map(([key]) => `
    <label>${escapeHtml(labelize(key))}
      <textarea data-register="${escapeHtml(key)}">${escapeHtml(workflowRegisters[key] || "")}</textarea>
    </label>
  `).join("");
}

function renderSecrets(secrets) {
  loadedSecrets = secrets;
  SECRET_CLEAR_IDS.forEach((id) => setValue(id, false));
  setValue("openaiApiKey", "");
  setValue("openaiNotes", secrets.openai.notes);
  $("openaiApiKey").placeholder = secrets.openai.hasApiKey ? "Saved key present - leave blank to keep" : "Optional - leave blank to keep saved";
  setValue("openrouterApiKey", "");
  setValue("openrouterNotes", secrets.openrouter.notes);
  $("openrouterApiKey").placeholder = secrets.openrouter.hasApiKey ? "Saved key present - leave blank to keep" : "Optional - leave blank to keep saved";
  setValue("webshareApiKey", "");
  $("webshareApiKey").placeholder = secrets.webshare.hasApiKey ? "Saved key present - leave blank to keep" : "Token from Webshare - leave blank to keep saved";
  setValue("webshareBaseUrl", secrets.webshare.baseUrl);
  setValue("webshareMode", secrets.webshare.mode);
  setValue("webshareSecretNotes", secrets.webshare.notes);
  setValue("proxyProviderName", secrets.proxyProvider.providerName || "Webshare");
  setValue("proxyProviderApiKey", "");
  $("proxyProviderApiKey").placeholder = secrets.proxyProvider.hasApiKey ? "Saved key present - leave blank to keep" : "Usually same as Webshare if used";
  setValue("ixbrowserApiKey", "");
  $("ixbrowserApiKey").placeholder = secrets.ixbrowser.hasApiKey ? "Saved token present - leave blank to keep" : "Leave blank for local API";
  setValue("ixbrowserBaseUrl", secrets.ixbrowser.baseUrl);
  setValue("shopyourlikesApiKey", "");
  setValue("shopyourlikesPublisherId", secrets.shopyourlikes.publisherId);
  setValue("shopyourlikesBaseUrl", secrets.shopyourlikes.baseUrl);
  setValue("shortlinkProviderName", secrets.shortlink.providerName || "Mavlynk");
  setValue("shortlinkApiKey", "");
  $("shortlinkApiKey").placeholder = secrets.shortlink.hasApiKey ? "Saved key present - leave blank to keep" : "Mavlynk API key";
  setValue("shortlinkBaseUrl", secrets.shortlink.baseUrl);
  setValue("firecrawlApiKey", "");
  $("firecrawlApiKey").placeholder = secrets.firecrawl?.hasApiKey ? "Saved key present - leave blank to keep" : "Firecrawl key for review-image extraction";
  setValue("firecrawlBaseUrl", secrets.firecrawl?.baseUrl || "https://api.firecrawl.dev/");
  setValue("affiliateProxyHost", "");
  $("affiliateProxyHost").placeholder = secrets.affiliateProxy.hasProxy ? `Saved: ${secrets.affiliateProxy.host}` : "Static proxy host/IP";
  setValue("affiliateProxyPort", "");
  $("affiliateProxyPort").placeholder = secrets.affiliateProxy.hasProxy ? `Saved port: ${secrets.affiliateProxy.port || ""}` : "Proxy port";
  setValue("affiliateProxyUsername", "");
  $("affiliateProxyUsername").placeholder = secrets.affiliateProxy.hasUsername ? "Saved username present - leave blank to keep" : "Proxy username";
  setValue("affiliateProxyPassword", "");
  $("affiliateProxyPassword").placeholder = secrets.affiliateProxy.hasPassword ? "Saved password present - leave blank to keep" : "Proxy password";
  renderSecretSummary(secrets);
  clearSecretDirty();
}

function renderSecretSummary(secrets) {
  const items = [
    ["OpenAI", secrets.openai.hasApiKey ? "key saved" : "no key stored"],
    ["OpenRouter", secrets.openrouter.hasApiKey ? "key saved" : "no key stored"],
    ["Webshare", secrets.webshare.hasApiKey ? `${secrets.webshare.mode} key saved` : "missing key"],
    ["Proxy", secrets.proxyProvider.hasApiKey ? `${secrets.proxyProvider.providerName || "Webshare"} key saved` : "Webshare key field ready"],
    ["IXBrowser", secrets.ixbrowser.baseUrl || "missing URL"],
    ["ShopYourLikes", workflowState?.affiliate?.dedicatedIxProfileId ? `IX profile ${workflowState.affiliate.dedicatedIxProfileId}` : "extension login uses dedicated IXBrowser profile"],
    ["Mavlynk", secrets.shortlink.hasApiKey ? "key saved" : "missing key"],
    ["Firecrawl", secrets.firecrawl?.hasApiKey ? "key saved; JPG/PNG extractor ready" : "missing key; Jina fallback only"],
    ["Affiliate proxy", secrets.affiliateProxy.hasProxy ? `${secrets.affiliateProxy.host}:${secrets.affiliateProxy.port}` : "not configured"],
  ];
  $("secretSummary").innerHTML = items.map(([title, value]) => `
    <div class="secretItem">
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(value)}</span>
    </div>
  `).join("");
}

function collectSecrets() {
  return {
    openai: {
      apiKey: getValue("openaiApiKey"),
      clearApiKey: getValue("openaiClearKey"),
      notes: getValue("openaiNotes"),
    },
    openrouter: {
      apiKey: getValue("openrouterApiKey"),
      clearApiKey: getValue("openrouterClearKey"),
      notes: getValue("openrouterNotes"),
    },
    webshare: {
      apiKey: getValue("webshareApiKey"),
      clearApiKey: getValue("webshareClearKey"),
      baseUrl: getValue("webshareBaseUrl"),
      mode: getValue("webshareMode"),
      notes: getValue("webshareSecretNotes"),
    },
    proxyProvider: {
      apiKey: getValue("proxyProviderApiKey"),
      clearApiKey: getValue("proxyProviderClearKey"),
      providerName: getValue("proxyProviderName"),
      baseUrl: getValue("webshareBaseUrl"),
      notes: "Webshare is the confirmed proxy provider.",
    },
    ixbrowser: {
      apiKey: getValue("ixbrowserApiKey"),
      clearApiKey: getValue("ixbrowserClearKey"),
      baseUrl: getValue("ixbrowserBaseUrl"),
      notes: loadedSecrets?.ixbrowser?.notes || "",
    },
    shopyourlikes: {
      apiKey: getValue("shopyourlikesApiKey"),
      clearApiKey: getValue("shopyourlikesClearKey"),
      publisherId: getValue("shopyourlikesPublisherId"),
      baseUrl: getValue("shopyourlikesBaseUrl"),
      notes: loadedSecrets?.shopyourlikes?.notes || "ShopYourLikes is handled through the browser extension/login in the dedicated IXBrowser profile.",
    },
    shortlink: {
      apiKey: getValue("shortlinkApiKey"),
      clearApiKey: getValue("shortlinkClearKey"),
      providerName: getValue("shortlinkProviderName"),
      baseUrl: getValue("shortlinkBaseUrl"),
      notes: "Mavlynk is the confirmed shortlink provider.",
    },
    firecrawl: {
      apiKey: getValue("firecrawlApiKey"),
      clearApiKey: getValue("firecrawlClearKey"),
      providerName: "Firecrawl",
      baseUrl: getValue("firecrawlBaseUrl"),
      notes: "Primary extractor for one high-quality customer review image per product, converted to Facebook-safe JPG/PNG.",
    },
    affiliateProxy: {
      clearApiKey: getValue("affiliateProxyClearKey"),
      host: getValue("affiliateProxyHost"),
      port: getValue("affiliateProxyPort"),
      username: getValue("affiliateProxyUsername"),
      password: getValue("affiliateProxyPassword"),
      proxyType: "http",
      provider: "Webshare",
      notes: "Dedicated fixed US proxy for ShopYourLikes and Mavlynk API requests.",
    },
  };
}

function renderReadiness() {
  if (!workflowState) return;
  renderTextEmojiStatus();
  const blockedCommentCount = commentLimitedEntries().length;
  const productUrlCount = countLines(workflowState.productAssets.productUrls || workflowState.posting.sourceUrls);
  const imageCounts = reviewImageApprovalCounts(workflowState.productAssets.selectedReviewImages);
  const postTextEmoji = textEmojiDiagnostics(workflowState.contentRotation?.postTexts || "");
  const assignedGroupCount = Array.isArray(workflowState.posting.groupAssignmentData)
    ? workflowState.posting.groupAssignmentData.filter((entry) => entry?.url && Array.isArray(entry.profiles) && entry.profiles.length).length
    : 0;
  const discoveryTarget = workflowState.productDiscovery?.targetCandidateCount || 0;
  const dailyPostTarget = workflowState.productDiscovery?.dailyPostTarget || 0;
  const checks = [
    ["Post delay", workflowState.rules.randomMinutesBetweenPosts, `${workflowState.rules.minMinutesBetweenPosts}-${workflowState.rules.maxMinutesBetweenPosts} min random`, `${workflowState.rules.minutesBetweenPosts} min fixed`],
    ["Deal signal", Boolean(workflowState.rules.requireDealSignal), workflowState.rules.requireDealSignal || "Missing deal signal", "Missing deal signal"],
    ["Current IP", Boolean(workflowState.webshare.currentIp), workflowState.webshare.currentIp || "No IP set", "No IP set"],
    ["IXBrowser", workflowState.ixbrowser.enabled, "IXBrowser enabled", "IXBrowser not enabled"],
    ["ShopYourLikes mode", true, workflowState.affiliate.dedicatedIxProfileId ? "Dedicated IXBrowser extension profile selected" : "Select a dedicated IXBrowser profile for the ShopYourLikes extension/login", ""],
    ["Discovery target", discoveryTarget >= dailyPostTarget && discoveryTarget > 0, `${discoveryTarget} candidates for ${dailyPostTarget} daily posts`, "Daily discovery target not calculated"],
    ["Walmart filters", workflowState.productDiscovery?.requireProSeller && workflowState.productDiscovery?.includeClearance && workflowState.productDiscovery?.includeReducedPrice && workflowState.productDiscovery?.includeRollback, "Pro Sellers + deal filters on", "Review Walmart filters"],
    ["Product discovery", workflowState.productDiscovery?.enabled && Boolean(String(workflowState.productDiscovery?.generatedSourceUrls || "").trim()), `${countLines(workflowState.productDiscovery?.generatedSourceUrls)} filter/source URL(s) ready`, "No filter/source URLs"],
    ["Group assignment", assignedGroupCount > 0, `${assignedGroupCount} group(s) assigned to profiles`, "No group/profile assignments"],
    ["Registers", Object.keys(workflowRegisters).length > 0, "Registers loaded", "Registers not loaded"],
    ["Webshare key", loadedSecrets?.webshare?.hasApiKey, "Webshare key saved", "Webshare key missing"],
    ["IX API", Boolean(loadedSecrets?.ixbrowser?.baseUrl), loadedSecrets?.ixbrowser?.baseUrl || "IXBrowser URL missing", "IXBrowser URL missing"],
    ["ShopYourLikes", workflowState.affiliate.enabled, "Affiliate pipeline on", "Affiliate pipeline off"],
    ["SYL profile", Boolean(workflowState.affiliate.dedicatedIxProfileId.trim() || workflowState.affiliate.dedicatedIxProfileName.trim()), "Dedicated profile set", "Dedicated SYL IXBrowser profile missing"],
    ["SYL browser proxy", !workflowState.affiliate.browserUseDedicatedProxy || (workflowState.affiliateProxy.enabled && loadedSecrets?.affiliateProxy?.hasProxy), workflowState.affiliate.browserUseDedicatedProxy ? `${workflowState.affiliateProxy.requiredCountry} proxy configured` : "Dedicated proxy not required by current setting", "Dedicated ShopYourLikes proxy missing"],
    ["Mavlynk", workflowState.shortlink.enabled, "Shortlink pipeline on", "Shortlink pipeline off"],
    ["Product images", workflowState.productAssets.enabled && Number(workflowState.productAssets.reviewCandidateCount || 5) === 5 && Number(workflowState.productAssets.reviewImagesPerProduct) === 1 && workflowState.productAssets.requirePositiveReviewsOnly && productUrlCount > 0 && imageCounts.approved >= productUrlCount, `${imageCounts.approved} approved JPG/PNG image(s) for ${productUrlCount} product(s) after 5-candidate review`, `${imageCounts.approved} approved / ${imageCounts.pending} pending JPG/PNG image(s)`],
    ["Product URLs", Boolean(workflowState.productAssets.productUrls.trim() || workflowState.posting.sourceUrls.trim()), "Product URL area ready", "No product URLs"],
    ["Post texts", Boolean(workflowState.contentRotation.postTexts.trim()), "Post text bank ready", "No post text lines"],
    ["Emoji text", !postTextEmoji.suspicious, postTextEmoji.emojiCount ? `${postTextEmoji.emojiCount} emoji character(s) saved` : "No emoji characters saved", "Possible emoji loss: saved text contains ?? instead of real emojis"],
    ["Comment lead-ins", Boolean(workflowState.contentRotation.commentLeadIns.trim()), "Comment lead-in bank ready", "No comment lead-ins"],
    ["IX profile limit", Number(workflowState.ixbrowser.maxProfilesPerRun) > 0, `${workflowState.ixbrowser.maxProfilesPerRun} profiles/run`, "Missing IX profile limit"],
    ["Comment blocks", blockedCommentCount === 0, "No blocked comment profiles", `${blockedCommentCount} profile(s) need review`],
    ["Job timeout", Number(workflowState.memory.maxJobRuntimeMinutes) > 0, `${workflowState.memory.maxJobRuntimeMinutes} min timeout`, "Missing job timeout"],
    ["Security audit", Boolean(workflowState.security.lastAuditAt), `Last: ${fmtTime(workflowState.security.lastAuditAt)}`, "Run local audit"],
  ];
  $("readinessGrid").innerHTML = checks.map(([title, ok, okText, warnText]) => `
    <div class="readyItem ${ok ? "ok" : "warn"}">
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(ok ? okText : warnText)}</span>
    </div>
  `).join("");
  renderCommentLimitOverview();
  updateSetupWizard();
}

function wizardCheck(label, ok, detail) {
  return { label, ok: Boolean(ok), detail: detail || "" };
}

function assignedGroupCount() {
  if (!Array.isArray(workflowState?.posting?.groupAssignmentData)) return 0;
  return workflowState.posting.groupAssignmentData
    .filter((entry) => entry?.url && Array.isArray(entry.profiles) && entry.profiles.length)
    .length;
}

function wizardStepChecks() {
  if (!workflowState) {
    return Object.fromEntries(WIZARD_STEPS.map((step) => [step, [wizardCheck("Dashboard state", false, "Loading current workflow state.")]]));
  }
  const productUrlCount = countLines(workflowState.productAssets?.productUrls || workflowState.posting?.sourceUrls);
  const sourceUrlCount = countLines(workflowState.productDiscovery?.generatedSourceUrls);
  const profilesForRun = countLines(workflowState.ixbrowser?.profilesForNextRun);
  const groupCount = countLines(workflowState.posting?.groups);
  const shortlinkCount = countLines(workflowState.posting?.shortlinks || workflowState.affiliate?.finalShortlinks);
  const postingPlanCount = countLines(workflowRegisters.postingPlan);
  const imageCounts = reviewImageApprovalCounts(workflowState.productAssets?.selectedReviewImages);
  const maxConcurrent = Number(workflowState.ixbrowser?.maxConcurrentProfiles || 0);
  const hasSylProfile = Boolean(String(workflowState.affiliate?.dedicatedIxProfileId || "").trim()
    || String(workflowState.affiliate?.dedicatedIxProfileName || "").trim());
  const needsAffiliateProxy = Boolean(workflowState.affiliate?.browserUseDedicatedProxy || workflowState.affiliateProxy?.apiRequestsMustUseProxy);
  const checks = {
    safety: [
      wizardCheck("Human approval is required", workflowState.operator?.approvalRequired, "Approvals stay on before risky steps continue."),
      wizardCheck("External actions are locked", !workflowState.operator?.armedForExternalActions, "Keep locked during setup; arm only when intentionally running live browser/proxy work."),
      wizardCheck("Autopilot is off", !workflowState.operator?.autopilotEnabled, "Manual start keeps bulk runs controlled."),
      wizardCheck("Parallel profile cap is 3", maxConcurrent > 0 && maxConcurrent <= 3, `${maxConcurrent || 0} configured; server hard-cap is 3.`),
    ],
    apis: [
      wizardCheck("Webshare key saved", loadedSecrets?.webshare?.hasApiKey, "Needed for proxy inventory and posting IP control."),
      wizardCheck("IXBrowser API URL saved", Boolean(loadedSecrets?.ixbrowser?.baseUrl), loadedSecrets?.ixbrowser?.baseUrl || "Set local IXBrowser API URL."),
      wizardCheck("Mavlynk key saved", loadedSecrets?.shortlink?.hasApiKey, "Needed to shorten final posting links."),
      wizardCheck("Firecrawl key saved", loadedSecrets?.firecrawl?.hasApiKey, "Preferred extractor for customer review image checks."),
      wizardCheck("Dedicated proxy ready when required", !needsAffiliateProxy || loadedSecrets?.affiliateProxy?.hasProxy, needsAffiliateProxy ? "SYL/Mavlynk proxy credentials must be saved." : "Current settings do not require the dedicated proxy."),
    ],
    profiles: [
      wizardCheck("IXBrowser enabled", workflowState.ixbrowser?.enabled, "Posting profiles are managed through IXBrowser."),
      wizardCheck("Profiles selected for next run", profilesForRun > 0, `${profilesForRun} profile(s) listed.`),
      wizardCheck("Max 4 parallel profiles", maxConcurrent > 0 && maxConcurrent <= MAX_NORMAL_IX_CONCURRENT_PROFILES, `${maxConcurrent || 0} configured.`),
      wizardCheck("Dedicated ShopYourLikes profile set", hasSylProfile, "This profile is reserved for SYL link generation and is not closed by normal profile cleanup."),
    ],
    products: [
      wizardCheck("Discovery workflow enabled", workflowState.productDiscovery?.enabled, "Product discovery must be on."),
      wizardCheck("Walmart deal filters enabled", workflowState.productDiscovery?.requireProSeller && workflowState.productDiscovery?.includeClearance && workflowState.productDiscovery?.includeReducedPrice && workflowState.productDiscovery?.includeRollback, "Use Pro Sellers, Clearance, Reduced Price, and Rollback."),
      wizardCheck("Filter/source URLs generated", sourceUrlCount > 0, `${sourceUrlCount} source URL(s) ready.`),
      wizardCheck("Product URLs collected", productUrlCount > 0, `${productUrlCount} product URL(s) ready for assets and links.`),
    ],
    images: [
      wizardCheck("Product image workflow enabled", workflowState.productAssets?.enabled, "Required before posting product media."),
      wizardCheck("Review 5 candidates, keep 1 image", Number(workflowState.productAssets?.reviewCandidateCount || 5) === 5 && Number(workflowState.productAssets?.reviewImagesPerProduct) === 1, "Hermes image review compares up to 5 candidates, then the workflow keeps one approved image per product."),
      wizardCheck("Positive review images only", workflowState.productAssets?.requirePositiveReviewsOnly && workflowState.productAssets?.requireCustomerReviewImages, "Reject negative-review, stock, or duplicate-looking images."),
      wizardCheck("ChatGPT HD Edge profile configured", workflowState.productAssets?.chatgptHdEnabled && workflowState.productAssets?.chatgptEdgeCdp && workflowState.productAssets?.chatgptEdgeUserDataDir && workflowState.productAssets?.chatgptEdgeProfileDirectory, "The configured Edge profile must be opened with CDP; normal Edge profiles are left open after HD work."),
      wizardCheck("Approved JPG/PNG images ready", productUrlCount > 0 && imageCounts.approved >= productUrlCount, `${imageCounts.approved} approved / ${productUrlCount} product(s), ${imageCounts.pending} pending.`),
    ],
    links: [
      wizardCheck("ShopYourLikes enabled", workflowState.affiliate?.enabled, "SYL extension/profile workflow is active."),
      wizardCheck("Dedicated SYL profile selected", hasSylProfile, "Use the fixed SYL profile for affiliate link generation."),
      wizardCheck("Mavlynk enabled", workflowState.shortlink?.enabled, "Mavlynk is the final shortlink provider."),
      wizardCheck("Mavlynk key saved", loadedSecrets?.shortlink?.hasApiKey, "Required for automatic shortening."),
      wizardCheck("Final shortlinks ready", shortlinkCount > 0, `${shortlinkCount} shortlink(s) available for posting.`),
    ],
    posting: [
      wizardCheck("Facebook groups added", groupCount > 0, `${groupCount} group URL(s) saved.`),
      wizardCheck("Groups assigned to profiles", assignedGroupCount() > 0, `${assignedGroupCount()} group assignment(s) saved.`),
      wizardCheck("Post text bank ready", countLines(workflowState.contentRotation?.postTexts) > 0, "Use one post text per line."),
      wizardCheck("Comment lead-ins ready", countLines(workflowState.contentRotation?.commentLeadIns) > 0, "Use one lead-in before the Mavlynk link."),
      wizardCheck("Posting plan prepared", postingPlanCount > 0, `${postingPlanCount} posting plan row(s) in registers.`),
    ],
    review: [],
  };
  const preReviewReady = ["safety", "apis", "profiles", "products", "images", "links", "posting"]
    .every((step) => checks[step].every((item) => item.ok));
  const pendingApprovals = Number(lastApprovals.pending?.length || 0) + Number(lastApprovals.queuedJobs?.length || 0);
  checks.review = [
    wizardCheck("All setup steps pass", preReviewReady, preReviewReady ? "No setup warnings remain." : "Fix the warning steps before production."),
    wizardCheck("No unsaved dashboard edits", !dirty, dirty ? "Save Everything before running." : "Dashboard state is saved."),
    wizardCheck("Approvals reviewed", pendingApprovals === 0, pendingApprovals ? `${pendingApprovals} pending approval item(s).` : "No pending approval items."),
    wizardCheck("No comment-limited profiles active", commentLimitedEntries().length === 0, `${commentLimitedEntries().length} profile(s) need review.`),
    wizardCheck("Security audit has run", Boolean(workflowState.security?.lastAuditAt), workflowState.security?.lastAuditAt ? `Last audit: ${fmtTime(workflowState.security.lastAuditAt)}` : "Run local audit before production."),
  ];
  return checks;
}

function renderWizardChecks(id, checks) {
  const el = $(id);
  if (!el) return;
  el.innerHTML = checks.map((item) => `
    <div class="wizardCheck ${item.ok ? "ok" : "warn"}">
      <div>
        <strong>${escapeHtml(item.label)}</strong>
        <span>${escapeHtml(item.detail)}</span>
      </div>
    </div>
  `).join("");
}

function updateSetupWizard() {
  if (!$("setupWizard")) return;
  const checks = wizardStepChecks();
  const statusTargets = {
    safety: "wizardSafetyChecks",
    apis: "wizardApiChecks",
    profiles: "wizardProfileChecks",
    products: "wizardProductChecks",
    images: "wizardImageChecks",
    links: "wizardLinkChecks",
    posting: "wizardPostingChecks",
    review: "wizardReviewChecks",
  };
  WIZARD_STEPS.forEach((step) => {
    const items = checks[step] || [];
    const ok = items.length > 0 && items.every((item) => item.ok);
    document.querySelectorAll(`[data-wizard-step="${step}"]`).forEach((button) => {
      button.classList.toggle("done", ok);
      button.classList.toggle("warn", !ok);
      button.classList.toggle("active", step === activeWizardStep);
    });
    document.querySelectorAll(`[data-wizard-status="${step}"]`).forEach((el) => {
      el.textContent = ok ? "Ready" : "Needs";
    });
    renderWizardChecks(statusTargets[step], items);
  });
  document.querySelectorAll("[data-wizard-panel]").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.wizardPanel === activeWizardStep);
  });
}

function firstPendingWizardStep() {
  const checks = wizardStepChecks();
  return WIZARD_STEPS.find((step) => !(checks[step] || []).every((item) => item.ok)) || "review";
}

function setWizardStep(step) {
  if (!WIZARD_STEPS.includes(step)) return;
  activeWizardStep = step;
  updateSetupWizard();
  document.querySelector(`[data-wizard-step="${step}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function setSetupWizardOpen(open) {
  const wizard = $("setupWizard");
  if (!wizard) return;
  if (open) {
    lastWizardFocus = document.activeElement;
    wizard.hidden = false;
    setWizardStep(firstPendingWizardStep());
    $("setupWizardClose")?.focus();
  } else {
    wizard.hidden = true;
    lastWizardFocus?.focus?.();
  }
}

function openDashboardTarget(view, focusId) {
  setSetupWizardOpen(false);
  setActiveView(view);
  window.setTimeout(() => {
    const target = focusId ? $(focusId) : null;
    if (!target) return;
    target.scrollIntoView({ block: "center", inline: "nearest" });
    if (typeof target.focus === "function") target.focus({ preventScroll: true });
  }, 80);
}

function applyWizardSafeDefaults() {
  setValue("approvalRequiredRail", true);
  setValue("autopilotEnabledRail", false);
  setValue("armedForExternalActionsRail", false);
  setValue("maxConcurrentProfiles", MAX_NORMAL_IX_CONCURRENT_PROFILES);
  renderOperatorToggleLabels();
  syncPreviewStateFromForm();
  markDirty();
  updateSetupWizard();
  showToast("Safe defaults applied. Save when ready.");
}

async function runWizardAction(action) {
  try {
    if (action === "safe-defaults") return applyWizardSafeDefaults();
    if (action === "save-all") return await saveAll();
    if (action === "check-api") return await checkIntegrationHealth();
    if (action === "load-ix") return await loadIxProfilesQuiet();
    if (action === "rebuild-products") return await rebuildProductDiscoveryUrls();
    if (action === "discover-products") return await runWorkflowAction("/api/products/discover", "Product discovery finished.");
    if (action === "open-chatgpt-browser") return await openDedicatedChatGptBrowser();
    if (action === "prepare-assets") return await runWorkflowAction("/api/products/prepare-assets", "Product asset checks prepared.");
    if (action === "open-assets-folder") return await openProductAssetsFolder();
    if (action === "generate-links") return await generateShopYourLikesExtensionLinks();
    if (action === "prepare-posting") return await runWorkflowAction("/api/posting/prepare-plan", "Posting plan prepared.");
    if (action === "open-approvals") return openDashboardTarget("approvals", "approvalQueue");
  } finally {
    updateSetupWizard();
  }
}

function commentLimitedEntries() {
  const sources = [
    workflowRegisters.limitedAccounts,
    workflowRegisters.downFacebookProfiles,
    workflowRegisters.accountsToReview,
    workflowState?.ixbrowser?.failedProfiles,
  ];
  const seen = new Set();
  return sources.flatMap((source) => String(source || "").split(/\r?\n/))
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && /comment|cannot|limited|blocked|manual review|quarantine/i.test(line))
    .filter((line) => {
      const key = line.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function renderCommentLimitOverview() {
  const box = $("commentLimitOverview");
  if (!box) return;
  const entries = commentLimitedEntries();
  $("commentLimitCount").textContent = `${entries.length} blocked`;
  if (!entries.length) {
    box.innerHTML = "<p>No comment-limited profiles are in review.</p>";
    return;
  }
  box.innerHTML = entries.slice(-8).reverse().map((entry) => `
    <div class="reviewItem">
      <strong>Manual review required</strong>
      <span>${escapeHtml(entry)}</span>
    </div>
  `).join("");
}

// Blocked / restricted profiles auto-blacklisted from posting (server computes the
// list at GET /api/profiles/blocked; we just render it + offer a manual unblock).
function renderBlockedProfilesPanel(blocked, cooldown) {
  const box = $("blockedProfilesPanel");
  if (!box) return;
  const list = Array.isArray(blocked) ? blocked : [];
  const cool = Array.isArray(cooldown) ? cooldown : [];
  const countEl = $("blockedProfilesCount");
  if (countEl) countEl.textContent = `${list.length} blocked · ${cool.length} cooldown`;
  if (!list.length && !cool.length) {
    box.innerHTML = "<p>No blocked, restricted, or cooling-down profiles. All eligible profiles are healthy.</p>";
    return;
  }
  const blockedHtml = list.map((p) => {
    let since = "";
    try { since = p.since ? new Date(p.since).toLocaleString() : ""; } catch (_e) { since = String(p.since || ""); }
    const kind = p.type === "account_blocked_or_restricted" ? "Account blocked / restricted" : (p.type === "manual_blacklist" ? "Manual blacklist" : "Repeated post failures");
    const tag = p.auto ? "auto-blocked" : "manual";
    return `<div class="reviewItem" style="border-left:3px solid #cf222e">
      <strong>Profile ${escapeHtml(String(p.profileId))}${p.label ? " · " + escapeHtml(String(p.label)) : ""}</strong>
      <span style="color:#cf222e;font-weight:600">${escapeHtml(kind)} (${escapeHtml(tag)})${since ? " · since " + escapeHtml(since) : ""}</span>
      <span style="color:#57606a;font-size:.8rem">${escapeHtml(String(p.reason || ""))}</span>
      <button type="button" class="ghost" onclick="window.unblockProfile(${Number(p.profileId) || 0})">Unblock</button>
    </div>`;
  }).join("");
  const coolHtml = cool.map((p) => {
    let retry = "";
    try { retry = p.retryAt ? new Date(p.retryAt).toLocaleString() : ""; } catch (_e) { retry = String(p.retryAt || ""); }
    return `<div class="reviewItem" style="border-left:3px solid #9a6700">
      <strong>Profile ${escapeHtml(String(p.profileId))}${p.label ? " · " + escapeHtml(String(p.label)) : ""}</strong>
      <span style="color:#9a6700;font-weight:600">Comment cooldown — benched 48h${retry ? " · retries " + escapeHtml(retry) : ""}</span>
      <span style="color:#57606a;font-size:.8rem">${escapeHtml(String(p.reason || ""))}</span>
    </div>`;
  }).join("");
  box.innerHTML = (list.length ? `<div style="font-weight:600;margin:.2rem 0 .15rem">Blocked / restricted (${list.length})</div>${blockedHtml}` : "")
    + (cool.length ? `<div style="font-weight:600;margin:.5rem 0 .15rem">Comment cooldown — 48h, auto-retries (${cool.length})</div>${coolHtml}` : "");
}

async function unblockProfile(profileId) {
  const pid = Number(profileId) || 0;
  if (!pid) return;
  if (!window.confirm(`Unblock profile ${pid}? It will be eligible to post again. Only do this AFTER you've re-logged-in / fixed the profile in ixBrowser.`)) return;
  try {
    await api("/api/ixbrowser/profile-unblock", {
      method: "POST",
      body: JSON.stringify({ profileId: String(pid), reason: "Operator cleared from dashboard after fixing the profile" }),
    });
    showToast(`Profile ${pid} unblocked`);
    refresh({ force: true });
  } catch (e) {
    showToast("Unblock failed: " + ((e && e.message) || e));
  }
}
if (typeof window !== "undefined") window.unblockProfile = unblockProfile;

function syncPreviewStateFromForm() {
  if (!workflowState) return;
  try {
    workflowState = collectState();
    workflowRegisters = collectRegisters();
    $("activeProfileCount").textContent = `${countLines(workflowState.ixbrowser.activeProfiles)} active`;
    renderAnalytics();
    renderReadiness();
  } catch (err) {
    console.warn("preview_sync_failed", err);
  }
}

async function saveSecrets() {
  const clearLabels = [
    ["openaiClearKey", "OpenAI"],
    ["openrouterClearKey", "OpenRouter"],
    ["webshareClearKey", "Webshare"],
    ["proxyProviderClearKey", "Proxy provider"],
    ["ixbrowserClearKey", "IXBrowser"],
    ["shopyourlikesClearKey", "ShopYourLikes"],
    ["shortlinkClearKey", "Mavlynk"],
    ["firecrawlClearKey", "Firecrawl"],
    ["affiliateProxyClearKey", "Affiliate proxy"],
  ].filter(([id]) => getValue(id)).map(([, label]) => label);
  if (clearLabels.length && !confirm(`Clear saved API keys for: ${clearLabels.join(", ")}?`)) return;
  setBusy(true);
  try {
    const result = await api("/api/secrets", {
      method: "PUT",
      body: JSON.stringify({ secrets: collectSecrets() }),
    });
    renderSecrets(result.secrets);
    renderReadiness();
    autoIntegrationRan = false;
    await autoVerifyIntegrations({ force: true });
    showToast("Secrets saved locally.");
  } finally {
    setBusy(false);
  }
}

function collectState() {
  const state = structuredClone(workflowState || {});
  // Spread the existing operator first so fields the main form does NOT manage — autopilotMaxPostsPerRun,
  // autopilotDryRun, autopilotPostsThisRun, autopilotTickSeconds, etc. — survive a save (the Prod run-mode
  // control relies on autopilotMaxPostsPerRun persisting).
  state.operator = Object.assign({}, state.operator, {
    approvalRequired: operatorToggleValue("approvalRequired"),
    armedForExternalActions: operatorToggleValue("armedForExternalActions"),
    autopilotEnabled: operatorToggleValue("autopilotEnabled"),
    scheduleEnabled: getValue("scheduleEnabled"),
    scheduleTimezone: getValue("scheduleTimezone"),
    runDays: getValue("runDays"),
    startTime: getValue("startTime"),
    stopTime: getValue("stopTime"),
  });
  // Collect ONLY the rules still in use. The removed/dead fields (minutes-between-posts, account-move,
  // deal-signal, link-placement, pause-on-* etc.) are hidden in the DOM and NOT collected here — sending
  // their empty/default values would overwrite the saved config. writeState merges over existing, so any
  // field we omit keeps its on-disk value. Peak window is managed by the Run-mode controls.
  state.rules = {
    commentCooldownMinutes: Number(getValue("commentCooldownMinutes") || 5),
    postsPerProfilePerDay: Number(getValue("postsPerProfilePerDay") || 0),
    peakHoursTimezone: getValue("peakHoursTimezone"),
    peakStartTime: getValue("peakStartTime"),
    peakStopTime: getValue("peakStopTime"),
    pinFirstComment: getValue("pinFirstComment"),
  };
  state.posting = {
    groups: getValue("groups"),
    groupAssignmentMode: "percentage_manual_review",
    groupProfileAssignments: getValue("groupProfileAssignments"),
    groupAssignmentData: collectGroupAssignmentData(),
    equalSplitAssignments: ($("equalSplitAssignments") ? Boolean(getValue("equalSplitAssignments")) : (workflowState?.posting?.equalSplitAssignments === true)),
    groupFallbackPolicy: workflowState?.posting?.groupFallbackPolicy || "if a profile cannot post in its selected group, try the next available group URL from this run; if no group works, skip that profile and record the issue with profile id/name",
    profileGroupIssueLogEndpoint: "/api/posting/profile-group-issue",
    publishedPostUrls: workflowState?.posting?.publishedPostUrls || "",
    sourceUrls: getValue("sourceUrls"),
    shortlinks: getValue("shortlinks"),
    readyDescriptionsPath: getValue("readyDescriptionsPath"),
    readyImagesPath: getValue("readyImagesPath"),
    moderatorAccountNotes: getValue("moderatorAccountNotes"),
    commentTemplate: getValue("commentTemplate"),
    postTextsList: getValue("postTextsList"),
    ownedGroupsByProfile: getValue("ownedGroupsByProfile"),
    facebookProfileStatus: getValue("facebookProfileStatus"),
    contentSources: {
      enabled: getValue("contentSourcesEnabled") === true,
      exclusive: getValue("contentSourcesExclusive") === true,
      reserveAuto: getValue("contentSourcesReserveAuto") !== false,
      reserveTarget: Number(getValue("contentSourcesReserveTarget")) || 20,
      reserveRefillAt: Number(getValue("contentSourcesReserveRefillAt")) || 10,
      harvestProfilesPerGroup: Number(getValue("contentSourcesProfilesPerGroup")) || 3,
      postCta: getValue("contentSourcesPostCta"),
      reuseHours: Number(getValue("contentSourcesReuseHours")) || 26,
      imageRetentionDays: Number(getValue("contentSourcesImageRetentionDays")) || 7,
      groupsText: getValue("contentSourceGroupsText"),
      notes: getValue("contentSourcesNotes"),
    },
  };
  state.productAssets = {
    enabled: getValue("productAssetsEnabled"),
    productUrls: getValue("productUrls"),
    reviewImagesPerProduct: 1,
    reviewCandidateCount: 5,
    useHermesImageReview: true,
    imageSelectionModel: "hermes_default_llm",
    minReviewRating: Number(getValue("minReviewRating") || 0),
    preferredReviewRating: Number(getValue("preferredReviewRating") || 0),
    requireCustomerReviewImages: getValue("requireCustomerReviewImages"),
    requireRealisticImages: getValue("requireRealisticImages"),
    requirePositiveReviewsOnly: getValue("requirePositiveReviewsOnly"),
    approvalRequired: getValue("productAssetsApprovalRequired"),
    chatgptHdEnabled: getValue("chatgptHdEnabled"),
    chatgptHdConversationLimit: Number(state.productAssets?.chatgptHdConversationLimit || 15),
    chatgptEdgeCdp: getValue("chatgptEdgeCdp") || "http://127.0.0.1:9334",
    chatgptEdgeUserDataDir: getValue("chatgptEdgeUserDataDir"),
    chatgptEdgeProfileDirectory: getValue("chatgptEdgeProfileDirectory") || "Default",
    reviewImageCandidates: getValue("reviewImageCandidates"),
    selectedReviewImages: getValue("selectedReviewImages"),
    outputPath: getValue("productAssetsOutputPath"),
    notes: getValue("productAssetsNotes"),
  };
  state.contentRotation = {
    usePostTextsInOrder: getValue("usePostTextsInOrder"),
    avoidPostTextReuse: getValue("avoidPostTextReuse"),
    postTexts: getValue("postTexts"),
    postTextCursor: Number(getValue("postTextCursor") || 0),
    useCommentLeadInsInOrder: getValue("useCommentLeadInsInOrder"),
    avoidCommentLeadInReuse: getValue("avoidCommentLeadInReuse"),
    commentLeadIns: getValue("commentLeadIns"),
    commentLeadInCursor: Number(getValue("commentLeadInCursor") || 0),
    notes: getValue("contentRotationNotes"),
  };
  state.dealSource = {
    source: getValue("dealSourceName"),
    allowedRetailers: getValue("allowedRetailers"),
    selectedFilters: getValue("selectedFilters"),
    priceFilter: getValue("priceFilter"),
    brandFilter: getValue("brandFilter"),
    colorFilter: getValue("colorFilter"),
    categoryFilter: getValue("categoryFilter"),
    notes: getValue("dealNotes"),
  };
  state.productDiscovery = {
    enabled: getValue("productDiscoveryEnabled"),
    primaryStore: getValue("discoveryPrimaryStore"),
    dailyRefreshEnabled: getValue("discoveryDailyRefreshEnabled"),
    requireProSeller: getValue("discoveryRequireProSeller"),
    includeClearance: getValue("discoveryIncludeClearance"),
    includeReducedPrice: getValue("discoveryIncludeReducedPrice"),
    includeRollback: getValue("discoveryIncludeRollback"),
    allowedRetailers: getValue("discoveryAllowedRetailers"),
    walmartCategorySources: getValue("walmartCategorySources"),
    walmartSearchQueries: getValue("walmartSearchQueries"),
    otherStoreSourceUrls: getValue("otherStoreSourceUrls"),
    generatedSourceUrls: getValue("generatedSourceUrls"),
    minActivitySignal: getValue("discoveryMinActivitySignal"),
    targetMode: workflowState?.productDiscovery?.targetMode || "assigned_profiles_x_posts_per_day",
    assignedProfileCount: Number(getValue("discoveryAssignedProfileCount") || 0),
    dailyPostTarget: Number(getValue("discoveryDailyPostTarget") || 0),
    candidateBufferPercent: Number(getValue("discoveryCandidateBufferPercent") || 20),
    targetCandidateCount: Number(getValue("discoveryTargetCandidateCount") || 0),
    rankingRules: getValue("discoveryRankingRules"),
    notes: getValue("productDiscoveryNotes"),
  };
  state.affiliate = {
    service: getValue("affiliateService"),
    enabled: getValue("affiliateEnabled"),
    apiRequestsUseDedicatedProxy: getValue("affiliateApiRequestsUseDedicatedProxy"),
    useDedicatedIxProfile: getValue("useDedicatedIxProfile"),
    dedicatedIxProfileId: getValue("dedicatedIxProfileId"),
    dedicatedIxProfileName: getValue("dedicatedIxProfileName"),
    dedicatedIxProfileFixedIp: getValue("dedicatedIxProfileFixedIp"),
    rotateDedicatedProfileIp: getValue("rotateDedicatedProfileIp"),
    generateShortlinksInDedicatedProfile: getValue("generateShortlinksInDedicatedProfile"),
    browserProfilePath: getValue("shopyourlikesBrowserProfilePath") || "data/shopyourlikes-browser-profile",
    browserStartUrl: getValue("shopyourlikesBrowserStartUrl") || "https://www.shopyourlikes.com/",
    browserUseDedicatedProxy: getValue("shopyourlikesBrowserUseProxy"),
    browserSelectedProxyId: getValue("shopyourlikesBrowserProxySelect") || workflowState?.affiliate?.browserSelectedProxyId || workflowState?.affiliateProxy?.selectedProxyId || "",
    browserLastOpenedAt: workflowState?.affiliate?.browserLastOpenedAt || "",
    browserStatus: workflowState?.affiliate?.browserStatus || "not opened",
    lastExtensionRunAt: workflowState?.affiliate?.lastExtensionRunAt || "",
    cleanExistingAffiliateLinks: getValue("cleanExistingAffiliateLinks"),
    shortenAfterAffiliate: getValue("shortenAfterAffiliate"),
    originalLinks: getValue("affiliateOriginalLinks"),
    cleanedLinks: getValue("affiliateCleanedLinks"),
    shopyourlikesLinks: getValue("shopyourlikesLinks"),
    finalShortlinks: getValue("finalShortlinks"),
    linkMappings: Array.isArray(workflowState?.affiliate?.linkMappings) ? workflowState.affiliate.linkMappings : [],
    notes: getValue("affiliateNotes"),
  };
  state.shortlink = {
    provider: getValue("shortlinkProvider"),
    enabled: getValue("shortlinkEnabled"),
    apiStatus: workflowState?.shortlink?.apiStatus || "not configured",
    useAffiliateDedicatedIxProfile: getValue("shortlinkUseAffiliateDedicatedIxProfile"),
    apiRequestsUseAffiliateProxy: getValue("shortlinkApiRequestsUseAffiliateProxy"),
    notes: getValue("shortlinkNotes"),
  };
  state.affiliateProxy = {
    enabled: getValue("affiliateProxyEnabled"),
    provider: workflowState?.affiliateProxy?.provider || "Webshare",
    requiredCountry: getValue("affiliateProxyRequiredCountry"),
    staticOnly: getValue("affiliateProxyStaticOnly"),
    lockedToSelectedProxy: getValue("affiliateProxyLockedToSelectedProxy"),
    apiRequestsMustUseProxy: getValue("affiliateProxyApiRequestsMustUseProxy"),
    selectedProxyId: workflowState?.affiliateProxy?.selectedProxyId || getValue("affiliateProxySelectedProxyId"),
    proxyAddress: workflowState?.affiliateProxy?.proxyAddress || getValue("affiliateProxyAddress"),
    proxyPort: workflowState?.affiliateProxy?.proxyPort || getValue("affiliateProxyPortState"),
    lastAssignedAt: workflowState?.affiliateProxy?.lastAssignedAt || "",
    lastTestAt: workflowState?.affiliateProxy?.lastTestAt || "",
    lastObservedIp: workflowState?.affiliateProxy?.lastObservedIp || getValue("affiliateProxyLastObservedIp"),
    lastObservedCountry: getValue("affiliateProxyLastObservedCountry"),
    status: getValue("affiliateProxyStatus"),
    notes: workflowState?.affiliateProxy?.notes || "",
  };
  state.webshare = {
    enabled: getValue("webshareEnabled"),
    apiStatus: getValue("webshareApiStatus"),
    currentIp: getValue("currentIp"),
    failedIps: getValue("failedIps"),
    notes: getValue("webshareNotes"),
  };
  state.proxyProvider = {
    provider: getValue("proxyProvider"),
    enabled: getValue("proxyProviderEnabled"),
    apiStatus: getValue("proxyProviderApiStatus"),
    requiredLocation: getValue("requiredProxyLocation"),
    notes: getValue("proxyProviderNotes"),
  };
  state.ixbrowser = {
    enabled: getValue("ixbrowserEnabled"),
    apiStatus: workflowState?.ixbrowser?.apiStatus || "not configured",
    maxProfilesPerRun: Number(getValue("maxProfilesPerRun") || 0),
    maxConcurrentProfiles: Number(getValue("maxConcurrentProfiles") || 0),
    profilesForNextRun: getValue("profilesForNextRun"),
    activeProfiles: getValue("activeProfiles"),
    blockedProfiles: getValue("blockedProfiles"),
    moderatorProfiles: getValue("moderatorProfiles"),
    failedProfiles: getValue("failedProfiles"),
    profileIpMap: getValue("profileIpMap"),
    accountSelector: getValue("accountSelector"),
    profileRunNotes: getValue("profileRunNotes"),
    notes: getValue("ixbrowserNotes"),
  };
  state.memory = {
    compactHermesPrompts: getValue("compactHermesPrompts"),
    includeMiroContext: getValue("includeMiroContext"),
    maxPromptUrlLines: Number(getValue("maxPromptUrlLines") || 0),
    maxPromptTextLines: Number(getValue("maxPromptTextLines") || 0),
    maxPromptTextLineLength: Number(getValue("maxPromptTextLineLength") || 0),
    maxJobRuntimeMinutes: Number(getValue("maxJobRuntimeMinutes") || 0),
    maxQueuedJobs: Number(getValue("maxQueuedJobs") || 0),
    notes: getValue("memoryNotes"),
  };
  state.triggers = {
    heartbeatSeconds: Number(getValue("heartbeatSeconds") || 0),
    autoStartQueuedJobs: getValue("autoStartQueuedJobs"),
    pauseWhenSecurityWarnings: getValue("pauseWhenSecurityWarnings"),
    pauseWhenExternalPortsChange: getValue("pauseWhenExternalPortsChange"),
    notes: getValue("triggerNotes"),
  };
  state.security = workflowState?.security || {};
  state.tracking = {
    dailyActionLog: getValue("dailyActionLog"),
    notes: getValue("trackingNotes"),
  };
  state.extension = {
    enabled: getValue("extensionEnabled"),
    name: getValue("extensionName"),
    apiStatus: workflowState?.extension?.apiStatus || "not configured",
    source: getValue("extensionSource"),
    shopifyUrlWorkflow: getValue("shopifyUrlWorkflow"),
    notes: getValue("extensionNotes"),
  };
  state.testRun = testRunSnapshot();
  return state;
}

function collectRegisters() {
  const registers = {};
  document.querySelectorAll("[data-register]").forEach((field) => {
    registers[field.getAttribute("data-register")] = field.value;
  });
  return registers;
}

async function saveState() {
  const state = collectState();
  const result = await api("/api/state", {
    method: "PUT",
    body: JSON.stringify({ state }),
  });
  renderState(result.state);
  renderReadiness();
  showToast("Workflow state saved.");
}

async function saveRegisters() {
  const registers = collectRegisters();
  const result = await api("/api/registers", {
    method: "PUT",
    body: JSON.stringify({ registers }),
  });
  renderRegisters(result.registers);
  renderReadiness();
  showToast("Registers saved.");
}

function scheduleGeneratedAssignmentAutosave() {
  window.clearTimeout(autoAssignmentSaveTimer);
  autoAssignmentSaveTimer = window.setTimeout(() => {
    saveGeneratedAssignmentState().catch((err) => {
      integrationLog({ ok: false, error: "assignment_autosave_failed", message: err.message });
    });
  }, 600);
}

async function saveGeneratedAssignmentState() {
  if (autoAssignmentSaving || requestBusy || !workflowState) return;
  autoAssignmentSaving = true;
  const saveVersion = dirtyVersion;
  try {
    const state = collectState();
    const result = await api("/api/state", {
      method: "PUT",
      body: JSON.stringify({ state }),
    });
    renderState(result.state);
    renderReadiness();
    if (dirtyVersion === saveVersion) clearDirty();
  } finally {
    autoAssignmentSaving = false;
  }
}

async function saveAll(opts) {
  if (__autoSaveTimer) { clearTimeout(__autoSaveTimer); __autoSaveTimer = null; }
  const quiet = opts && opts.quiet;
  setBusy(true);
  try {
    const prevSnapshot = __lastSnapshot;
    const state = collectState();
    const registers = collectRegisters();
    const [stateResult, registerResult] = await Promise.all([
      api("/api/state", { method: "PUT", body: JSON.stringify({ state }) }),
      api("/api/registers", { method: "PUT", body: JSON.stringify({ registers }) }),
    ]);
    // undo history: remember the state BEFORE this save (skip while undoing)
    if (!__undoBusy && prevSnapshot !== null) { __undoStack.push(prevSnapshot); if (__undoStack.length > 60) __undoStack.shift(); }
    try { __lastSnapshot = JSON.stringify(stateResult.state); } catch (e) {}
    if (quiet) {
      // auto-save: keep state fresh WITHOUT re-rendering the form (no caret jump mid-edit)
      workflowState = stateResult.state;
      renderRegisters(registerResult.registers);
    } else {
      renderState(stateResult.state);
      renderRegisters(registerResult.registers);
    }
    clearDirty();
    renderReadiness();
    if (!quiet) showToast("Everything saved.");
  } finally {
    setBusy(false);
  }
}

async function ensureSavedBeforeAction() {
  if (!dirty) return true;
  if (!confirm("You have unsaved dashboard edits. Save them before continuing?")) return false;
  await saveAll();
  return true;
}

function labelize(value) {
  return value.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

function countLines(value) {
  return String(value || "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#")).length;
}

function nonCommentLines(value) {
  return String(value || "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
}

function reviewImageStatusFromLine(line) {
  const statusMatch = String(line || "").match(/(?:^|\|)\s*status=([^|]+)/i);
  if (statusMatch) return statusMatch[1].trim().toLowerCase();
  const statusPart = String(line || "")
    .split("|")
    .map((part) => part.trim())
    .find((part) => /^(approved|human_approved|selected_(?:webp|image)_approved|approved_for_posting|selected_(?:webp|image)_ready_pending_human_approval|pending|rejected|failed)/i.test(part));
  return statusPart ? statusPart.toLowerCase() : "approval_status_missing";
}

function isApprovedReviewImageStatus(status) {
  const normalized = String(status || "").toLowerCase();
  if (!normalized || /pending|reject|denied|fail|needs/.test(normalized)) return false;
  return /(^|[_-])approved($|[_-])|human_approved|approved_for_posting|selected_(?:webp|image)_approved/.test(normalized);
}

function reviewImageApprovalCounts(value) {
  return nonCommentLines(value).reduce((acc, line) => {
    acc.total += 1;
    const status = reviewImageStatusFromLine(line);
    if (isApprovedReviewImageStatus(status)) acc.approved += 1;
    else if (/reject|denied|fail/.test(status)) acc.blocked += 1;
    else acc.pending += 1;
    return acc;
  }, { total: 0, approved: 0, pending: 0, blocked: 0 });
}

function walmartFacetValue() {
  return WALMART_DISCOVERY_FILTERS
    .filter(([id]) => getValue(id))
    .map(([, value]) => value)
    .join("||");
}

function extractUrlFromSourceLine(line) {
  const match = String(line || "").match(/https?:\/\/\S+/i);
  return match ? match[0] : "";
}

function withWalmartDiscoveryFacet(rawUrl) {
  const facet = walmartFacetValue();
  if (!facet) return rawUrl;
  try {
    const url = new URL(rawUrl);
    if (!/(^|\.)walmart\.com$/i.test(url.hostname)) return rawUrl;
    url.searchParams.set("facet", facet);
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function buildWalmartSearchUrl(query) {
  const url = new URL("https://www.walmart.com/search");
  url.searchParams.set("q", query);
  const facet = walmartFacetValue();
  if (facet) url.searchParams.set("facet", facet);
  return url.toString();
}

function discoveryFilterLabels() {
  return WALMART_DISCOVERY_FILTERS
    .filter(([id]) => getValue(id))
    .map(([, value]) => value.split(":").pop());
}

function discoveryCategoryLabels() {
  return [
    ...nonCommentLines(getValue("walmartCategorySources")).map((line) => line.split("|")[0].trim()).filter(Boolean),
    ...nonCommentLines(getValue("walmartSearchQueries")),
  ];
}

function syncDiscoverySummaryFields(options = {}) {
  if ($("discoveryAllowedRetailers")) setValue("allowedRetailers", getValue("discoveryAllowedRetailers"));
  setValue("selectedFilters", discoveryFilterLabels().join(", "));
  setValue("categoryFilter", discoveryCategoryLabels().join(", "));
  setValue("dealSourceName", [getValue("discoveryPrimaryStore") || "walmart", "Amazon", "Target"].join(", "));
  setValue("dealNotes", [
    `Daily product discovery enabled=${getValue("productDiscoveryEnabled") ? "yes" : "no"}.`,
    `Minimum signal: ${getValue("discoveryMinActivitySignal") || "not set"}.`,
    "Use generated discovery URLs to shortlist product pages before affiliate/link/post workflow.",
  ].join("\n"));
  if (options.mark) {
    markDirty();
    syncPreviewStateFromForm();
  }
}

function rebuildProductDiscoveryUrls(options = {}) {
  const urls = [];
  const seen = new Set();
  const addUrl = (value) => {
    const clean = String(value || "").trim();
    if (!clean) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    urls.push(clean);
  };
  nonCommentLines(getValue("walmartCategorySources")).forEach((line) => {
    const sourceUrl = extractUrlFromSourceLine(line);
    if (sourceUrl) addUrl(withWalmartDiscoveryFacet(sourceUrl));
  });
  nonCommentLines(getValue("walmartSearchQueries")).forEach((line) => {
    const sourceUrl = extractUrlFromSourceLine(line);
    addUrl(sourceUrl ? withWalmartDiscoveryFacet(sourceUrl) : buildWalmartSearchUrl(line));
  });
  nonCommentLines(getValue("otherStoreSourceUrls")).forEach(addUrl);
  setValue("generatedSourceUrls", urls.join("\n"));
  syncDiscoverySummaryFields();
  markDirty();
  syncPreviewStateFromForm();
  if (!options.quiet) showToast(`${urls.length} product discovery source URL(s) ready.`);
}

function profileCandidatesForAssignments() {
  const candidates = [];
  const add = (label, source = "manual") => {
    const clean = String(label || "").trim();
    if (!clean) return;
    if (!isAllowedNormalIxBrowserProfileLabel(clean)) return;
    const key = clean.toLowerCase();
    if (candidates.some((item) => item.key === key)) return;
    candidates.push({ key, label: clean, source });
  };
  integrationProfiles.forEach((profile) => {
    const id = profile.profile_id || profile.id || "";
    const name = profile.name || profile.title || "";
    add(`${id}${name ? ` - ${name}` : ""}`.trim(), "ixbrowser");
  });
  nonCommentLines(workflowState?.ixbrowser?.profilesForNextRun).forEach((line) => add(line, "next run"));
  nonCommentLines(workflowState?.ixbrowser?.activeProfiles).forEach((line) => add(line, "active"));
  nonCommentLines(getValue("profilesForNextRun")).forEach((line) => add(line, "next run"));
  nonCommentLines(getValue("activeProfiles")).forEach((line) => add(line, "active"));
  groupAssignmentDraft.forEach((entry) => {
    (entry.profiles || []).forEach((profile) => add(profile, "assigned"));
  });
  (workflowState?.posting?.groupAssignmentData || []).forEach((entry) => {
    (entry.profiles || []).forEach((profile) => add(profile, "assigned"));
  });
  return candidates;
}

function groupUrlsForAssignments() {
  return nonCommentLines(getValue("groups"));
}

function initializeGroupAssignmentDraft() {
  const existing = groupAssignmentDraft.length ? groupAssignmentDraft : (Array.isArray(workflowState?.posting?.groupAssignmentData) ? workflowState.posting.groupAssignmentData : []);
  const byUrl = new Map(existing.map((entry) => [String(entry.url || "").trim(), entry]));
  const groups = groupUrlsForAssignments();
  const defaultShare = groups.length ? Math.floor(100 / groups.length) : 0;
  let remainder = groups.length ? 100 - (defaultShare * groups.length) : 0;
  groupAssignmentDraft = groups.map((url) => {
    const previous = byUrl.get(url) || {};
    const share = previous.sharePercent ?? (defaultShare + (remainder-- > 0 ? 1 : 0));
    return {
      url,
      sharePercent: Number(share) || 0,
      profiles: Array.isArray(previous.profiles) ? previous.profiles.map(String).filter(isAllowedNormalIxBrowserProfileLabel) : [],
    };
  });
}

function collectGroupAssignmentData() {
  const builder = $("groupAssignmentBuilder");
  if (!builder || !builder.children.length) return groupAssignmentDraft;
  const entries = [];
  builder.querySelectorAll("[data-assignment-card]").forEach((card) => {
    const index = Number(card.getAttribute("data-assignment-card"));
    const draft = groupAssignmentDraft[index];
    if (!draft) return;
    const profiles = Array.from(card.querySelectorAll("[data-assignment-profile]:checked"))
      .map((input) => input.value)
      .filter(isAllowedNormalIxBrowserProfileLabel);
    entries.push({
      url: draft.url,
      sharePercent: Number(card.querySelector("[data-assignment-share]")?.value || 0),
      profiles,
    });
  });
  groupAssignmentDraft = entries;
  return entries;
}

function renderGroupAssignmentBuilder() {
  const builder = $("groupAssignmentBuilder");
  if (!builder) return;
  initializeGroupAssignmentDraft();
  const profiles = profileCandidatesForAssignments();
  const eligibleCount = profiles.filter((p) => isAllowedNormalIxBrowserProfileLabel(p.label)).length;
  autoAssignGroupProfilesIfEmpty(profiles.map((profile) => profile.label));
  const groups = groupAssignmentDraft;
  $("groupAssignmentSummary").textContent = groups.length
    ? `${groups.length} group URL(s), ${profiles.length} profile option(s). Use percentages for auto-split or tick profiles manually.`
    : "Add Facebook group URLs in Posting Inputs, then build the assignment matrix.";
  $("groupAssignmentSummary").className = `inlineNotice ${groups.length && profiles.length ? "ok" : "warn"}`;
  if (!groups.length) {
    builder.innerHTML = "";
    syncGroupAssignmentOutput();
    return;
  }
  builder.innerHTML = groups.map((entry, index) => `
    <article class="assignmentCard" data-assignment-card="${index}">
      <div class="assignmentMeta">
        <div class="assignmentHeader">
          <div class="assignmentHeaderTitle">
            <strong>Group ${index + 1}</strong>
            <small>${escapeHtml(entry.url)}</small>
          </div>
          <button class="iconButton dangerIcon hasTooltip" type="button" data-remove-assignment-group="${index}" data-tooltip="Remove this group URL from Posting Inputs and the assignment matrix." aria-label="Remove group ${index + 1}">&times;</button>
        </div>
        <div class="shareSliderRow">
          <div class="shareSliderHead"><span>Profile share</span><b data-share-label>${Number(entry.sharePercent) || 0}%</b></div>
          <input data-assignment-share class="shareSlider" type="range" min="0" max="100" step="5" value="${Number(entry.sharePercent) || 0}" style="--fill:${Number(entry.sharePercent) || 0}%">
          <div class="shareSliderFoot">
            <button type="button" class="chipButton" data-share-quick="0">None</button>
            <button type="button" class="chipButton" data-share-quick="50">Half</button>
            <button type="button" class="chipButton" data-share-quick="100">All eligible</button>
          </div>
        </div>
        <small><span data-selected-count>${entry.profiles.length}</span> of ${eligibleCount} eligible profile(s) selected</small>
      </div>
      <div class="profileChecklist">
        ${profiles.map((profile) => `
          <label class="profileCheck">
            <input data-assignment-profile type="checkbox" value="${escapeHtml(profile.label)}" ${entry.profiles.includes(profile.label) ? "checked" : ""}>
            <span>${escapeHtml(profile.label)} <small>${escapeHtml(profile.source)}</small></span>
          </label>
        `).join("") || "<div class=\"inlineNotice warn\">No profiles yet. Load IXBrowser profiles or add profiles in Profiles for next run / Active profiles.</div>"}
      </div>
    </article>
  `).join("");
  syncGroupAssignmentOutput();
}

function syncGroupAssignmentOutput() {
  if (!$("groupProfileAssignments")) return;
  const entries = collectGroupAssignmentData();
  document.querySelectorAll("[data-assignment-card]").forEach((card, index) => {
    const count = card.querySelectorAll("[data-assignment-profile]:checked").length;
    const target = card.querySelector("[data-selected-count]");
    if (target) target.textContent = String(count);
    if (groupAssignmentDraft[index]) groupAssignmentDraft[index].profiles = Array.from(card.querySelectorAll("[data-assignment-profile]:checked"))
      .map((input) => input.value)
      .filter(isAllowedNormalIxBrowserProfileLabel);
  });
  const lines = [
    "# Facebook group/profile assignment plan",
    "# Generated locally from group URLs, profile checklists, and percentage split.",
  ];
  entries.forEach((entry, index) => {
    lines.push("");
    lines.push(`GROUP ${index + 1} | share=${Number(entry.sharePercent) || 0}% | url=${entry.url}`);
    if (entry.profiles.length) {
      entry.profiles.forEach((profile) => lines.push(`- ${profile}`));
    } else {
      lines.push("- no profiles selected");
    }
  });
  $("groupProfileAssignments").value = lines.join("\n").trim() + (entries.length ? "\n" : "");
}

// EQUAL-SPLIT TOGGLE (operator option): when ON, profiles are dispatched EQUALLY between all
// groups and each profile lives in EXACTLY ONE group (assignProfilesByPercent partitions by
// slicing — it can never duplicate a profile across groups, unlike the per-card share slider).
function equalSplitEnabled() {
  const el = $("equalSplitAssignments");
  return el ? Boolean(el.checked) : (workflowState?.posting?.equalSplitAssignments === true);
}

function applyEqualUniqueSplit() {
  const groups = groupUrlsForAssignments();
  if (!groups.length) return showToast("Add group URLs first.");
  initializeGroupAssignmentDraft();
  if (!groupAssignmentDraft.length) return;
  const base = Math.floor(100 / groupAssignmentDraft.length);
  let remainder = 100 - (base * groupAssignmentDraft.length);
  groupAssignmentDraft.forEach((entry) => { entry.sharePercent = base + (remainder-- > 0 ? 1 : 0); });
  const profiles = profileCandidatesForAssignments().map((profile) => profile.label);
  if (!profiles.length) return showToast("Load or type profiles first.");
  assignProfilesByPercent(profiles); // partitions: each profile in exactly ONE group
  renderGroupAssignmentBuilder();
  markDirty();
  showToast("Profiles split equally — each profile in exactly one group ✓");
}

function applyEvenGroupSplit() {
  if (equalSplitEnabled()) return applyEqualUniqueSplit();
  const groups = groupUrlsForAssignments();
  if (!groups.length) return showToast("Add group URLs first.");
  initializeGroupAssignmentDraft();
  const base = Math.floor(100 / groupAssignmentDraft.length);
  let remainder = 100 - (base * groupAssignmentDraft.length);
  groupAssignmentDraft.forEach((entry) => {
    entry.sharePercent = base + (remainder-- > 0 ? 1 : 0);
  });
  applyPercentGroupSplit();
}

function normalizedGroupShares(entries) {
  const shares = entries.map((entry) => Math.max(0, Number(entry.sharePercent) || 0));
  const total = shares.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return entries.map(() => 1 / entries.length);
  if (total < 100) {
    const zeroIndexes = shares.map((value, index) => value === 0 ? index : -1).filter((index) => index >= 0);
    if (zeroIndexes.length) {
      const remainder = 100 - total;
      zeroIndexes.forEach((index) => { shares[index] = remainder / zeroIndexes.length; });
    }
  }
  const nextTotal = shares.reduce((sum, value) => sum + value, 0) || 1;
  return shares.map((value) => value / nextTotal);
}

function applyPercentGroupSplit() {
  if (equalSplitEnabled()) return applyEqualUniqueSplit();
  collectGroupAssignmentData();
  if (!groupAssignmentDraft.length) return showToast("Add group URLs first.");
  const cards = document.querySelectorAll("[data-assignment-card]");
  if (!cards.length) return showToast("Load or type profiles first.");
  cards.forEach((card) => applyShareSliderToCard(card));
  showToast("Applied each group's share slider.");
}

function autoAssignGroupProfilesIfEmpty(profiles) {
  if (!groupAssignmentDraft.length || !profiles.length) return;
  const hasAnySelection = groupAssignmentDraft.some((entry) => Array.isArray(entry.profiles) && entry.profiles.length);
  if (hasAnySelection) return;
  const hadDirtyEdits = dirty;
  assignProfilesByPercent(profiles);
  markDirty();
  if (!hadDirtyEdits) scheduleGeneratedAssignmentAutosave();
}

function assignProfilesByPercent(profiles) {
  profiles = profiles.filter(isAllowedNormalIxBrowserProfileLabel);
  const ratios = normalizedGroupShares(groupAssignmentDraft);
  const rawCounts = ratios.map((ratio) => ratio * profiles.length);
  const counts = rawCounts.map(Math.floor);
  let remaining = profiles.length - counts.reduce((sum, value) => sum + value, 0);
  rawCounts
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction)
    .forEach((item) => {
      if (remaining-- > 0) counts[item.index] += 1;
    });
  let cursor = 0;
  groupAssignmentDraft.forEach((entry, index) => {
    entry.profiles = profiles.slice(cursor, cursor + counts[index]);
    cursor += counts[index];
  });
}

// Live per-group share slider: selects the first pct% of ELIGIBLE (allowed-normal) profiles for
// THIS group, independently of other groups — so 100% = ALL eligible profiles for the group.
function applyShareSliderToCard(card) {
  if (!card) return;
  const slider = card.querySelector("[data-assignment-share]");
  if (!slider) return;
  const pct = Math.max(0, Math.min(100, Number(slider.value) || 0));
  slider.style.setProperty("--fill", pct + "%");
  const label = card.querySelector("[data-share-label]");
  if (label) label.textContent = pct + "%";
  const eligible = Array.from(card.querySelectorAll("[data-assignment-profile]"))
    .filter((box) => isAllowedNormalIxBrowserProfileLabel(box.value));
  const n = Math.round(eligible.length * pct / 100);
  eligible.forEach((box, i) => { box.checked = i < n; });
  syncGroupAssignmentOutput();
  markDirty();
}

function addGroupUrlToAssignments(value) {
  const url = String(value || "").trim();
  if (!url) return false;
  const current = groupUrlsForAssignments();
  if (!current.map((item) => item.toLowerCase()).includes(url.toLowerCase())) {
    appendLine("groups", url);
  }
  groupAssignmentDraft = [];
  renderGroupAssignmentBuilder();
  return true;
}

function removeGroupUrlFromAssignments(index) {
  collectGroupAssignmentData();
  const entry = groupAssignmentDraft[index];
  if (!entry?.url) return false;
  const target = normalizedFacebookGroupKey(entry.url) || String(entry.url).trim().toLowerCase();
  const nextLines = String(getValue("groups") || "").split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return true;
      const key = normalizedFacebookGroupKey(trimmed) || trimmed.toLowerCase();
      return key !== target;
    });
  setValue("groups", nextLines.join("\n"));
  groupAssignmentDraft = groupAssignmentDraft.filter((_, itemIndex) => itemIndex !== index);
  renderGroupAssignmentBuilder();
  markDirty();
  showToast("Removed group URL from posting inputs and assignments.");
  return true;
}

function copyLoadedProfilesToNextRun() {
  if (!integrationProfiles.length) return showToast("Load IXBrowser profiles first.");
  const labels = integrationProfiles.map((profile) => {
    const id = profile.profile_id || profile.id || "";
    const name = profile.name || profile.title || "";
    return `${id}${name ? ` - ${name}` : ""}`.trim();
  }).filter(isAllowedNormalIxBrowserProfileLabel);
  const current = nonCommentLines(getValue("profilesForNextRun"));
  const seen = new Set(current.map((line) => line.toLowerCase()));
  const merged = [...current];
  labels.forEach((label) => {
    const key = label.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(label);
    }
  });
  setValue("profilesForNextRun", merged.join("\n"));
  renderGroupAssignmentBuilder();
  markDirty();
  showToast(`${labels.length} loaded IXBrowser profile(s) available for assignment.`);
}

function setVisibleAssignmentChecks(checked) {
  const inputs = Array.from(document.querySelectorAll("[data-assignment-profile]"));
  if (!inputs.length) return showToast("No visible profile checkboxes yet.");
  inputs.forEach((input) => { input.checked = checked; });
  syncGroupAssignmentOutput();
  markDirty();
}

function appendLine(id, line) {
  const field = $(id);
  const prefix = field.value.trim() ? `${field.value.trimEnd()}\n` : "";
  field.value = `${prefix}${line}`;
  markDirty();
}

function appendRegisterLine(key, line) {
  const register = document.querySelector(`[data-register="${key}"]`);
  if (!register) return;
  const prefix = register.value.trim() ? `${register.value.trimEnd()}\n` : "";
  register.value = `${prefix}${line}`;
  workflowRegisters[key] = register.value;
}

function removeProfileFromTextarea(id, profile) {
  const field = $(id);
  if (!field || !profile) return;
  const needle = String(profile).trim().toLowerCase();
  field.value = field.value.split(/\r?\n/)
    .filter((line) => !line.toLowerCase().includes(needle))
    .join("\n");
}

function selectedCommentProfile() {
  const selectedId = $("ixProfileSelect")?.value || "";
  const selectedProfile = integrationProfiles.find((profile) => String(profile.profile_id || profile.id) === String(selectedId));
  const typed = getValue("commentLimitProfile").trim();
  const selectedName = selectedProfile?.name || selectedProfile?.title || "";
  const selectedLabel = selectedId ? `${selectedId}${selectedName ? ` - ${selectedName}` : ""}` : "";
  return {
    profile: typed || selectedLabel || selectedId || selectedName || "",
    profileId: selectedId,
    profileName: selectedName,
    selectedProfile,
  };
}

function syncCommentLimitProfileFromSelected(options = {}) {
  const field = $("commentLimitProfile");
  const select = $("ixProfileSelect");
  if (!field || !select?.value) return;
  if (!options.overwrite && field.value.trim()) return;
  const selectedProfile = integrationProfiles.find((profile) => String(profile.profile_id || profile.id) === String(select.value));
  const name = selectedProfile?.name ? ` - ${selectedProfile.name}` : "";
  field.value = `${select.value}${name}`;
}

function profileHasOneIpAttempt(profile) {
  const needle = String(profile || "").trim().toLowerCase();
  if (!needle) return false;
  const idMatch = needle.match(/^(\d{1,20})(?:\s*[-: ]|$)/);
  const tokens = [`profile=${needle}`];
  if (idMatch) tokens.push(`profile_id=${idMatch[1]}`);
  return [
    workflowRegisters.pendingApprovals,
    workflowRegisters.accountsToReview,
    workflowRegisters.failedIps,
    workflowState?.ixbrowser?.failedProfiles,
  ].join("\n").toLowerCase().split(/\r?\n/)
    .some((line) => line.includes("one_ip_attempt=1/1") && tokens.some((token) => line.includes(token)));
}

function integrationLog(payload) {
  $("integrationOutput").textContent = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
}

function workflowOutput(payload) {
  const el = $("workflowActionOutput");
  if (!el) return;
  el.textContent = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
}

function parsePostingPlanRows(value) {
  return String(value || "").split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

async function latestPostingPlanRows() {
  let rows = parsePostingPlanRows(workflowRegisters.postingPlan);
  if (!rows.length) {
    const registers = await api("/api/registers");
    renderRegisters(registers.registers);
    rows = parsePostingPlanRows(registers.registers?.postingPlan);
  }
  return rows;
}

function postHandoffText(row) {
  return [
    "FACEBOOK TEST POST HANDOFF",
    "",
    `Plan: ${row.planId || "-"}`,
    `Profile: ${row.profile || row.profileId || "-"}`,
    `Group: ${row.groupUrl || "-"}`,
    "",
    "Post body:",
    row.postText || "(missing post text)",
    "",
    "First comment:",
    row.commentTextPreview || row.link || "(missing comment/link)",
    "",
    `Image: ${row.image || "(missing approved image)"}`,
    "",
    "Fallback groups:",
    ...((row.fallbackGroupUrls || []).length ? row.fallbackGroupUrls : ["(none)"]),
  ].join("\n");
}

async function openFacebookTestHandoff(options = {}) {
  if (!(await ensureSavedBeforeAction())) return;
  const rows = await latestPostingPlanRows();
  const row = rows.find((item) => item.runType === "one_post_test") || rows[0];
  if (!row) {
    showToast("Run 1-Post Full Test first.");
    return;
  }
  const profileId = row.profileId || String(row.profile || "").match(/^\s*(\d{1,20})/)?.[1] || "";
  if (!profileId || !row.groupUrl) {
    workflowOutput(postHandoffText(row));
    showToast("The test plan is missing profile ID or group URL.");
    return;
  }
  if (!options.skipConfirm && !confirm("Open the planned Facebook group in the planned IXBrowser profile? This opens the handoff only; you still publish manually.")) return;
  setCurrentProgress("Facebook test handoff", 72, `Opening profile ${profileId} to planned group...`, "running", { local: true, testRun: true });
  setBusy(true);
  try {
    const result = await api("/api/integrations/ixbrowser/open-assigned-group", {
      method: "POST",
      body: JSON.stringify({ profileId, groupUrl: row.groupUrl }),
      timeoutMs: IXBROWSER_DASHBOARD_WAIT_MS,
    });
    setValue("publishedPostPlanIdInput", row.planId || "");
    setValue("publishedPostProfileInput", row.profile || profileId);
    setValue("publishedPostGroupInput", result.groupUrl || row.groupUrl || "");
    renderTestRunResult({ planId: row.planId || "", profile: row.profile || profileId, groupUrl: result.groupUrl || row.groupUrl || "" });
    updateTestPipelineStep("post", "done", `Opened ${result.groupUrl || row.groupUrl}.`);
    updateTestPipelineStep("comment", "waiting", "Manual publish/comment not started.");
    const handoff = postHandoffText(row);
    workflowOutput(`${handoff}\n\nOpened IXBrowser profile ${result.profileId} to ${result.groupUrl}.\nManual final step: publish the Facebook post, then paste the final post URL above and click Record Facebook Post URL.`);
    const status = $("publishedPostUrlStatus");
    if (status) {
      status.className = "inlineNotice warn";
      status.textContent = `Opened profile ${result.profileId}. Publish manually, then record the Facebook post URL here.`;
    }
    try { await navigator.clipboard.writeText(handoff); } catch {}
    finishLocalProgress("Facebook handoff opened", "Publish manually, then record the post URL.", "warn", { testRun: true });
    showToast("Facebook handoff opened. Final publish is manual.");
    return true;
  } catch (err) {
    updateTestPipelineStep("post", "failed", err.message);
    finishLocalProgress("Facebook handoff blocked", err.message, "danger", { testRun: true });
    throw err;
  } finally {
    setBusy(false);
  }
}

async function runFacebookLiveTestPost(options = {}) {
  if (!(await ensureSavedBeforeAction())) return false;
  const rows = await latestPostingPlanRows();
  const row = rows.find((item) => item.runType === "one_post_test");
  if (!row) {
    showToast("Run 1-Post Full Test first.");
    return false;
  }
  const profileId = row.profileId || String(row.profile || "").match(/^\s*(\d{1,20})/)?.[1] || "";
  if (!profileId || !row.groupUrl) {
    workflowOutput(postHandoffText(row));
    showToast("The test plan is missing profile ID or group URL.");
    return false;
  }
  if (!String(row.liveExecution || "").startsWith("ready")) {
    const detail = `Posting row is not ready for live publish: ${row.liveExecution || "unknown"}`;
    updateTestPipelineStep("plan", "failed", detail);
    setCurrentProgress("1-post test: plan blocked", 83, detail, "danger", { local: true, testRun: true });
    showToast(detail);
    return false;
  }
  const confirmedHere = !options.skipConfirm;
  const liveConfirmation = options.liveConfirmation || LIVE_TEST_CONFIRMATION;
  setCurrentProgress("Facebook post publish", 86, `Posting text + HD image with profile ${profileId}...`, "running", { local: true, testRun: true });
  updateTestPipelineStep("post", "running", `Publishing text + HD image in ${row.groupUrl}.`);
  updateTestPipelineStep("postUrl", "waiting", "Waiting for Facebook permalink before first comment.");
  updateTestPipelineStep("comment", "waiting", "Waiting for verified post URL.");
  setBusy(true);
  try {
    const result = await api("/api/posting/run-live-test-post", {
      method: "POST",
      body: JSON.stringify({
        planId: row.planId,
        sequence: row.sequence,
        operatorApprovedLive: Boolean(options.operatorApprovedLive || confirmedHere || liveConfirmation === LIVE_TEST_CONFIRMATION),
        liveConfirmation,
      }),
      timeoutMs: 700000,
      signal: options.signal,
    });
    if (result.state) renderState(result.state);
    if (result.registers) renderRegisters(result.registers);
    setValue("publishedPostPlanIdInput", result.planId || row.planId || "");
    setValue("publishedPostProfileInput", result.profile || row.profile || profileId);
    setValue("publishedPostGroupInput", result.groupUrl || row.groupUrl || "");
    const status = $("publishedPostUrlStatus");
    if (result.postUrl && result.ok !== false) {
      setValue("publishedPostUrlInput", result.postUrl);
      updateTestPipelineStep("select", "done", `${result.profile || row.profile || profileId} ${result.groupUrl || row.groupUrl || ""}`.trim(), { persist: false });
      if (testPipelineState.discovery?.status === "waiting") {
        updateTestPipelineStep("discovery", "done", "Fresh product discovery completed.", { persist: false });
      }
      renderTestRunResult({
        postUrl: result.postUrl,
        planId: result.planId || row.planId || "",
        profile: result.profile || row.profile || profileId,
        groupUrl: result.groupUrl || row.groupUrl || "",
      });
      const validation = result.validation || {};
      updateTestPipelineStep("post", "done", `Post + HD image verified in ${result.groupUrl || row.groupUrl}.`);
      updateTestPipelineStep("postUrl", "done", result.postUrl);
      updateTestPipelineStep("comment", "done", liveCommentSuccessDetail(result));
      const detail = liveValidationDetail(result) || result.postUrl;
      setCurrentProgress("1-post test: published", 100, detail, liveValidationWarnings(result).length ? "warn" : "ok", { local: true, testRun: true });
      if (status) {
        status.className = `inlineNotice ${liveValidationWarnings(result).length ? "warn" : "ok"}`;
        status.textContent = `${liveValidationWarnings(result).length ? "Published with warning" : "Published and recorded"}: ${result.postUrl}`;
      }
    } else if (result.postUrl) {
      setValue("publishedPostUrlInput", result.postUrl);
      updateTestPipelineStep("select", "done", `${result.profile || row.profile || profileId} ${result.groupUrl || row.groupUrl || ""}`.trim(), { persist: false });
      if (testPipelineState.discovery?.status === "waiting") {
        updateTestPipelineStep("discovery", "done", "Fresh product discovery completed.", { persist: false });
      }
      renderTestRunResult({
        postUrl: result.postUrl,
        planId: result.planId || row.planId || "",
        profile: result.profile || row.profile || profileId,
        groupUrl: result.groupUrl || row.groupUrl || "",
      });
      const errors = liveValidationErrors(result);
      const detail = liveValidationDetail(result) || result.message || "Facebook publish verification failed.";
      updateTestPipelineStep("post", livePostValidationFailed(errors) ? "failed" : "done", livePostValidationFailed(errors) ? detail : `Post URL captured: ${result.postUrl}`);
      updateTestPipelineStep("postUrl", "done", result.postUrl);
      updateTestPipelineStep("comment", liveCommentValidationFailed(errors) ? "failed" : "done", liveCommentValidationFailed(errors) ? detail : "First comment/pin did not report an error.");
      setCurrentProgress("Facebook verification failed", 100, detail || result.postUrl, "danger", { local: true, testRun: true });
      if (status) {
        status.className = "inlineNotice danger";
        status.textContent = detail || `Post URL captured but image/comment verification failed: ${result.postUrl}`;
      }
    } else {
      updateTestPipelineStep("select", "done", `${result.profile || row.profile || profileId} ${result.groupUrl || row.groupUrl || ""}`.trim(), { persist: false });
      if (testPipelineState.discovery?.status === "waiting") {
        updateTestPipelineStep("discovery", "done", "Fresh product discovery completed.", { persist: false });
      }
      renderTestRunResult({
        planId: result.planId || row.planId || "",
        profile: result.profile || row.profile || profileId,
        groupUrl: result.groupUrl || row.groupUrl || "",
        candidatePostUrls: result.candidatePostUrls || [],
      });
      const detail = liveValidationDetail(result) || result.message || "Live connector finished without a post URL.";
      updateTestPipelineStep("post", result.posted ? "done" : "failed", detail);
      updateTestPipelineStep("postUrl", "failed", result.message || "Post URL was not captured.");
      updateTestPipelineStep("comment", "failed", liveCommentValidationFailed(liveValidationErrors(result)) ? detail : (result.posted ? "Post URL was not captured, so comment/pin could not be verified." : "Post did not complete."));
      setCurrentProgress("1-post test: URL capture needed", 96, detail || "The live connector did not capture a Facebook post URL.", "warn", { local: true, testRun: true });
      if (status) {
        status.className = "inlineNotice warn";
        status.textContent = detail || "Published state is uncertain; post URL was not captured.";
      }
    }
    workflowOutput({
      facebookLivePost: {
        ok: result.ok,
        posted: result.posted,
        postUrl: result.postUrl || "",
        planId: result.planId,
        profile: result.profile || profileId,
        commentProfile: result.commentProfile || "",
        commentProfileId: result.commentProfileId || "",
        groupUrl: result.groupUrl,
        attemptedGroups: result.attemptedGroups || [],
        attemptedCommentProfiles: result.attemptedCommentProfiles || [],
        candidatePostUrls: result.candidatePostUrls || [],
        closeResults: result.closeResults || [],
        script: result.script,
        payloadFile: result.payloadFile,
        liveLogFile: result.liveLogFile || "",
        validation: result.validation || null,
        message: result.message || "",
      },
      liveLog: result.liveLog || [],
    });
    await refresh({ force: true });
    showToast(result.postUrl && result.ok !== false ? "Facebook post published and URL recorded." : result.message || "Facebook connector finished without a captured URL.");
    return Boolean(result.postUrl && result.ok !== false);
  } catch (err) {
    if (options.signal?.aborted || err.cancelled) return false;
    if (err.payload?.state) renderState(err.payload.state);
    if (err.payload?.registers) renderRegisters(err.payload.registers);
    const payloadResult = { ...(err.payload || {}), message: err.message };
    const detail = liveValidationDetail(payloadResult) || err.message;
    renderTestRunResult({
      planId: payloadResult.planId || row.planId || "",
      profile: payloadResult.profile || row.profile || profileId,
      groupUrl: payloadResult.groupUrl || row.groupUrl || "",
      postUrl: payloadResult.postUrl || "",
      candidatePostUrls: payloadResult.candidatePostUrls || [],
    });
    updateTestPipelineStep("post", "failed", detail);
    updateTestPipelineStep("postUrl", payloadResult.postUrl ? "done" : "failed", payloadResult.postUrl || (payloadResult.candidatePostUrls?.[0] ? `Candidate permalink captured but not verified: ${payloadResult.candidatePostUrls[0]}` : "No verified Facebook post URL was captured before the comment step."));
    updateTestPipelineStep("comment", liveCommentValidationFailed(liveValidationErrors(payloadResult)) ? "failed" : "waiting", liveCommentValidationFailed(liveValidationErrors(payloadResult)) ? detail : "Post failed before comment step.");
    setCurrentProgress("Facebook live publish blocked", 100, detail, "danger", { local: true, testRun: true });
    workflowOutput({
      facebookLivePostBlocked: {
        message: err.message,
        validation: err.payload?.validation || null,
        liveLogFile: err.payload?.liveLogFile || "",
        candidatePostUrls: err.payload?.candidatePostUrls || [],
      },
      liveLog: err.payload?.liveLog || [],
    });
    showToast(detail);
    return false;
  } finally {
    setBusy(false);
  }
}

async function runLiveFullPostingPlan() {
  if (!(await ensureSavedBeforeAction())) return false;
  const rows = await latestPostingPlanRows();
  const fullRows = rows.filter((item) => item.runType === "full_posting_plan");
  if (!fullRows.length) {
    showToast("Prepare the full posting plan first.");
    return false;
  }
  const planId = fullRows[0].planId || "";
  const readyCount = fullRows.filter((row) => String(row.liveExecution || "").startsWith("ready")).length;
  if (!readyCount) {
    showToast("No full-plan rows are ready for live posting.");
    workflowOutput({ fullLiveRunBlocked: "No rows have ready_for_manual_or_official_connector_after_approval.", planId });
    return false;
  }
  if (!workflowState?.operator?.approvalRequired) {
    const message = "Full production runs require Human approval to be enabled before live posting starts.";
    showToast(message);
    workflowOutput({ fullLiveRunBlocked: message, planId });
    return false;
  }
  const maxConcurrentProfiles = Math.min(MAX_NORMAL_IX_CONCURRENT_PROFILES, Math.max(1, Number(workflowState?.ixbrowser?.maxConcurrentProfiles || MAX_NORMAL_IX_CONCURRENT_PROFILES)));
  const liveConfirmation = requestTypedLiveConfirmation(
    LIVE_FULL_CONFIRMATION,
    `Start live full run for ${readyCount} ready row(s)? This publishes real Facebook posts/comments with up to ${maxConcurrentProfiles} IXBrowser profiles at a time.`,
  );
  if (!liveConfirmation) return false;
  setCurrentProgress("Full live run", 5, `${readyCount} ready row(s), max ${maxConcurrentProfiles} parallel profile(s).`, "running", { local: true });
  setBusy(true);
  try {
    const result = await api("/api/posting/run-live-full-plan", {
      method: "POST",
      body: JSON.stringify({ planId, maxConcurrentProfiles, operatorApprovedLive: true, liveConfirmation }),
      timeoutMs: 3600000,
    });
    if (result.state) renderState(result.state);
    if (result.registers) renderRegisters(result.registers);
    workflowOutput({
      fullLiveRun: {
        ok: result.ok,
        planId: result.planId,
        attempted: result.attempted,
        posted: result.posted,
        captured: result.captured,
        failed: result.failed,
        maxConcurrentProfiles: result.maxConcurrentProfiles,
      },
      results: (result.results || []).slice(0, 50),
    });
    const tone = result.failed ? "warn" : "ok";
    finishLocalProgress("Full live run finished", `${result.posted || 0} posted, ${result.captured || 0} URL(s) captured, ${result.failed || 0} failed.`, tone);
    await refresh({ force: true });
    showToast("Full live run finished.");
    return Boolean(result.ok);
  } catch (err) {
    finishLocalProgress("Full live run blocked", err.message, "danger");
    showToast(err.message);
    return false;
  } finally {
    setBusy(false);
  }
}

async function runE2eTestHandoff() {
  activeTestAbortController?.abort();
  activeTestAbortController = new AbortController();
  setCurrentProgress("E2E test handoff", 4, "Starting workflow...", "running", { local: true, testRun: true });
  try {
    const prepared = await runPostingPrepPipeline({ testPost: true, skipConfirm: true, signal: activeTestAbortController.signal });
    if (!prepared) return;
    await runFacebookLiveTestPost({ skipConfirm: true, operatorApprovedLive: true, signal: activeTestAbortController.signal });
  } finally {
    activeTestAbortController = null;
  }
}

function randomChoice(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function profileIdFromLabelLocal(value) {
  return String(value || "").trim().match(/^\s*(\d{1,20})(?:\s*[-: ]|$)/)?.[1] || "";
}

function isDedicatedShopYourLikesProfileLabel(value) {
  const label = String(value || "").trim();
  if (!label) return false;
  const profileId = profileIdFromLabelLocal(label);
  const dedicatedId = String(workflowState?.affiliate?.dedicatedIxProfileId || getValue("dedicatedIxProfileId") || "").trim();
  const dedicatedName = String(workflowState?.affiliate?.dedicatedIxProfileName || getValue("dedicatedIxProfileName") || "").trim().toLowerCase();
  if (dedicatedId && profileId && profileId === dedicatedId) return true;
  if (dedicatedName && label.toLowerCase().includes(dedicatedName)) return true;
  return false;
}

function blockedIxBrowserProfileLines() {
  const source = workflowState?.ixbrowser?.blockedProfiles ?? getValue("blockedProfiles") ?? "";
  return String(source || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+#.*$/, "").trim())
    .filter(Boolean);
}

function moderatorIxBrowserProfileLines() {
  const source = [
    workflowState?.ixbrowser?.moderatorProfiles,
    getValue("moderatorProfiles"),
    workflowState?.posting?.ownedGroupsByProfile,
    getValue("ownedGroupsByProfile"),
    workflowState?.posting?.moderatorAccountNotes,
    getValue("moderatorAccountNotes"),
  ].filter(Boolean).join("\n");
  return String(source || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+#.*$/, "").trim())
    .filter(Boolean);
}

function blockedProfileIdFromLine(line) {
  const explicit = String(line || "").match(/\bprofile[_ -]?id\s*=\s*(\d{1,20})\b/i);
  if (explicit) return explicit[1];
  return profileIdFromLabelLocal(line);
}

function escapeRegExpLocal(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isBlockedIxBrowserProfileLabel(value) {
  const label = String(value || "").trim();
  if (!label) return false;
  const profileId = profileIdFromLabelLocal(label);
  const lower = label.toLowerCase();
  const namePart = lower.replace(/^\s*\d{1,20}\s*[-: ]\s*/, "").trim();
  for (const line of blockedIxBrowserProfileLines()) {
    const blockedId = blockedProfileIdFromLine(line);
    const blockedLower = line.toLowerCase();
    const blockedName = blockedLower.replace(/^\s*\d{1,20}\s*[-: ]\s*/, "").trim();
    if (blockedId && profileId && blockedId === profileId) return true;
    if (blockedLower === lower || (blockedName && blockedName === namePart)) return true;
    if (blockedName && new RegExp(`\\b${escapeRegExpLocal(blockedName)}\\b`, "i").test(label)) return true;
    if (!blockedId && blockedLower && new RegExp(`\\b${escapeRegExpLocal(blockedLower)}\\b`, "i").test(label)) return true;
  }
  return false;
}

function isModeratorApprovalProfileLabel(value) {
  const label = String(value || "").trim();
  if (!label) return false;
  const profileId = profileIdFromLabelLocal(label);
  const lower = label.toLowerCase();
  if (/\b(admin|administrator|moderator|mod|owner|approve|approval)\b/i.test(lower)) return true;
  for (const line of moderatorIxBrowserProfileLines()) {
    const lineProfileId = profileIdFromLabelLocal(line);
    const lineLower = line.toLowerCase();
    if (profileId && lineProfileId && profileId === lineProfileId) return true;
    if (lineLower.includes(lower) || lower.includes(lineLower)) return true;
  }
  return false;
}

function isAllowedNormalIxBrowserProfileLabel(value) {
  const label = String(value || "").trim();
  return Boolean(label && !isDedicatedShopYourLikesProfileLabel(label) && !isBlockedIxBrowserProfileLabel(label) && !isModeratorApprovalProfileLabel(label));
}

function normalizedFacebookGroupKey(value) {
  return String(value || "").trim().toLowerCase().replace(/[?#].*$/g, "").replace(/\/+$/g, "");
}

function isTransientPostingProfileFailureLineLocal(line = "") {
  const text = String(line || "").toLowerCase();
  if (!text) return false;
  if (/post published but required first comment was not verified|comment_profile_cannot_access_post_permalink|comment_not_submitted|comment_not_verified|comment_blocked/i.test(text)) return true;
  return /reason=(image_upload_not_confirmed|automation_image_confirmation_false_negative)/i.test(text) ||
    /reason=.*(could not open composer|could not type post|could not click post|post was not verified|no permalink was captured|permalink was not captured|previous facebook post was not found|profile start timeout|ixbrowser.*timeout|browser.*timeout|cdp.*timeout|timeout)/i.test(text) ||
    /error=.*(could not open composer|could not type post|could not click post|post was not verified|no permalink was captured|permalink was not captured|timeout)/i.test(text);
}

function knownBadPostingPair(profile, groupUrl) {
  const profileText = String(profile || "").trim();
  const profileId = profileIdFromLabelLocal(profileText);
  const groupKey = normalizedFacebookGroupKey(groupUrl);
  if (!profileText || !groupKey) return false;
  const sources = [
    workflowState?.posting?.facebookProfileStatus,
    getValue("facebookProfileStatus"),
    workflowState?.ixbrowser?.failedProfiles,
    getValue("failedProfiles"),
  ].join("\n").toLowerCase().split(/\r?\n/);
  const matching = sources.filter((line) => {
    if (!/status=(cannot_post_in_group|resolved|approved|cleared|ignored)|action=(profile_unblocked|profile_group_unblocked)/i.test(line)) return false;
    const lineGroup = normalizedFacebookGroupKey((line.match(/group_url=([^|]+)/i) || [])[1] || "");
    if (lineGroup !== groupKey) return false;
    if (profileId && line.includes(`profile_id=${profileId}`)) return true;
    return profileText.length > 2 && line.includes(profileText.toLowerCase());
  });
  const latest = matching[matching.length - 1] || "";
  if (!latest) return false;
  if (/status=(resolved|approved|cleared|ignored)|action=(profile_unblocked|profile_group_unblocked)/i.test(latest)) return false;
  if (isTransientPostingProfileFailureLineLocal(latest)) return false;
  return /status=cannot_post_in_group/i.test(latest);
}

function chooseRandomOnePostAssignment() {
  const groups = groupUrlsForAssignments();
  const profiles = profileCandidatesForAssignments().map((profile) => profile.label).filter(isAllowedNormalIxBrowserProfileLabel);
  if (!groups.length) {
    showToast("Add at least one Facebook group URL first.");
    return null;
  }
  if (!profiles.length) {
    showToast("Load IXBrowser profiles or add profiles for next run first.");
    return null;
  }
  const validPairs = [];
  groups.forEach((groupUrl) => {
    profiles.forEach((profile) => {
      if (!knownBadPostingPair(profile, groupUrl)) validPairs.push({ groupUrl, profile });
    });
  });
  if (!validPairs.length) {
    showToast("All known profile/group pairs are blocked. Add another group or profile first.");
    return null;
  }
  const { groupUrl, profile } = randomChoice(validPairs);
  lastTestRunResult = { profile, groupUrl, planId: "", postUrl: "" };
  const existingEntries = groupAssignmentDraft.length
    ? groupAssignmentDraft
    : (Array.isArray(workflowState?.posting?.groupAssignmentData) ? workflowState.posting.groupAssignmentData : []);
  const sameGroupEntry = existingEntries.find((entry) => normalizedFacebookGroupKey(entry?.url) === normalizedFacebookGroupKey(groupUrl));
  const availableProfiles = Array.isArray(sameGroupEntry?.profiles)
    ? sameGroupEntry.profiles.map((item) => String(item || "").trim()).filter(isAllowedNormalIxBrowserProfileLabel)
    : profiles;
  const orderedProfiles = [
    profile,
    ...availableProfiles.filter((candidate) => String(candidate || "").trim().toLowerCase() !== String(profile || "").trim().toLowerCase()),
  ];
  groupAssignmentDraft = [{
    url: groupUrl,
    sharePercent: 100,
    profiles: orderedProfiles,
  }];
  renderGroupAssignmentBuilder();
  syncGroupAssignmentOutput();
  resetTestPipelineSteps();
  updateTestPipelineStep("select", "done", `${profile} | ${groupUrl}`);
  renderTestRunResult({ profile, groupUrl, planId: "", postUrl: "" });
  markDirty();
  return { groupUrl, profile };
}

async function runRandomE2eTestHandoff() {
  activeTestAbortController?.abort();
  activeTestAbortController = new AbortController();
  const selection = chooseRandomOnePostAssignment();
  if (!selection) {
    activeTestAbortController = null;
    return;
  }
  try {
    setCurrentProgress("Random E2E test", 4, `Selected ${selection.profile}`, "running", { local: true, testRun: true });
    const prepared = await runPostingPrepPipeline({ testPost: true, skipConfirm: true, signal: activeTestAbortController.signal });
    if (!prepared) return;
    await runFacebookLiveTestPost({ skipConfirm: true, operatorApprovedLive: true, signal: activeTestAbortController.signal });
  } finally {
    activeTestAbortController = null;
  }
}

function compactWorkflowResult(result) {
  if (!result || typeof result !== "object") return result;
  const {
    state,
    registers,
    candidates,
    sample,
    errors,
    ...summary
  } = result;
  if (Array.isArray(candidates)) summary.candidates = candidates.slice(0, 8);
  if (Array.isArray(sample)) summary.sample = sample.slice(0, 8);
  if (Array.isArray(errors)) summary.errors = errors.slice(0, 8);
  return summary;
}

async function runWorkflowAction(path, label, body = {}) {
  if (!(await ensureSavedBeforeAction())) return;
  setCurrentProgress(label.replace(/\.$/, ""), 8, "Starting workflow action...", "running", { local: true });
  setBusy(true);
  try {
    const result = await api(path, {
      method: "POST",
      body: JSON.stringify(body),
      timeoutMs: path.includes("/api/products/prepare-assets") ? PREPARE_ASSETS_TIMEOUT_MS : undefined,
    });
    setCurrentProgress(label.replace(/\.$/, ""), 82, "Rendering workflow results...", "running", { local: true });
    workflowOutput(compactWorkflowResult(result));
    if (result.state) renderState(result.state);
    if (result.registers) renderRegisters(result.registers);
    const approvals = await api("/api/approvals");
    renderApprovals(approvals);
    renderReadiness();
    clearDirty();
    finishLocalProgress(label.replace(/\.$/, ""), "Completed. Review approvals before live action.", "ok");
    showToast(label);
  } catch (err) {
    finishLocalProgress("Workflow blocked", err.message, "danger");
    throw err;
  } finally {
    setBusy(false);
  }
}

async function prepareTestPostPlan() {
  return runPostingPrepPipeline({ testPost: true });
}

async function runFullPrepPipeline() {
  return runPostingPrepPipeline({ testPost: false });
}

function ensureDiscoverySourceUrls() {
  if (nonCommentLines(getValue("generatedSourceUrls")).length) return;
  const hasSources = [
    getValue("walmartCategorySources"),
    getValue("walmartSearchQueries"),
    getValue("otherStoreSourceUrls"),
  ].some((value) => nonCommentLines(value).length);
  if (hasSources) rebuildProductDiscoveryUrls({ quiet: true });
}

function renderWorkflowStepResult(result) {
  if (result?.state) renderState(result.state);
  if (result?.registers) renderRegisters(result.registers);
}

function summarizeImagePrepFailure(assets = {}) {
  const failure = Array.isArray(assets.failures) ? assets.failures[0] : null;
  const attempts = Array.isArray(failure?.attempts) ? failure.attempts : [];
  const candidateCount = Number(failure?.candidateCount || 0) || attempts.reduce((max, attempt) => Math.max(max, Number(attempt.candidateCount || 0)), 0);
  const triedCount = attempts.filter((attempt) => attempt.candidateIndex).length;
  const lastError = [...attempts].reverse().find((attempt) => attempt.error)?.error || "";
  const countText = candidateCount || triedCount
    ? `Tried ${candidateCount || triedCount} candidate image(s).`
    : "No candidate image reached the converter.";
  return `${countText}${lastError ? ` Last error: ${String(lastError).slice(0, 220)}` : ""}`;
}

async function runPostingPrepPipeline(options = {}) {
  const testPost = Boolean(options.testPost);
  if (testPost) rebuildProductDiscoveryUrls({ quiet: true });
  else ensureDiscoverySourceUrls();
  if (!(await ensureSavedBeforeAction())) return;
  if (!options.skipConfirm && !confirm(testPost
    ? "Run the 1-post test workflow? It will discover products from filters, prepare a review/HD image, reuse an existing ShopYourLikes link when mapped, generate only missing SYL links, shorten with Mavlynk, then publish one Facebook post."
    : "Run the full prep pipeline now? This prepares discovery/assets/links/posting plan only. It does not publish to Facebook.")) return;
  const steps = new Map();
  const stepOrder = [];
  const pipelineTotal = 6;
  let parallelPrepActive = false;
  const parallelPrepStepKeys = new Set(["product images", "shopyourlikes", "shortlink provider"]);
  const parallelPrepDetail = () => {
    const imageStep = steps.get("product images");
    const sylStep = steps.get("shopyourlikes");
    const shortlinkStep = steps.get("shortlink provider");
    const line = (label, step, fallback) => `${label}: ${step?.status || "waiting"}${step?.detail ? ` - ${step.detail}` : ` - ${fallback}`}`;
    return [
      line("Images/ChatGPT HD", imageStep, "review image, HD upgrade, and rotation branch is starting"),
      line("ShopYourLikes", sylStep, "affiliate link branch is starting"),
      line("Mavlynk", shortlinkStep, "shortlink waits for SYL output"),
      "Plan waits until both parallel lanes finish.",
    ].join(" | ");
  };
  const recordStep = (name, status, detail = "") => {
    const key = String(name || "").toLowerCase();
    if (!steps.has(key)) stepOrder.push(key);
    steps.set(key, { name, status, detail });
    const pipeline = stepOrder.map((id) => steps.get(id)).filter(Boolean);
    const runningSteps = pipeline.filter((step) => step.status === "running");
    workflowOutput({ pipeline, running: runningSteps.map((step) => step.name) });
    const completed = pipeline.filter((step) => ["done", "skipped"].includes(step.status)).length;
    const blocked = status === "blocked";
    const percent = blocked ? 100 : Math.min(98, (completed / pipelineTotal) * 100 + (runningSteps.length ? 8 : 0));
    const tone = blocked ? "danger" : status === "skipped" ? "warn" : "running";
    const titleName = runningSteps.length > 1
      ? runningSteps.map((step) => step.name).join(" + ")
      : name;
    const showParallelPrep = parallelPrepActive && (parallelPrepStepKeys.has(key) || runningSteps.some((step) => parallelPrepStepKeys.has(String(step.name || "").toLowerCase())));
    setCurrentProgress(
      showParallelPrep
        ? `${testPost ? "1-post test" : "Full prep"}: Images/ChatGPT HD + ShopYourLikes/Mavlynk`
        : `${testPost ? "1-post test" : "Full prep"}: ${titleName}`,
      percent,
      showParallelPrep ? parallelPrepDetail() : detail || status,
      tone,
      { local: true, testRun: testPost },
    );
  };
  setBusy(true);
  try {
    if (testPost) {
      resetTestPipelineSteps();
      updateTestPipelineStep("select", "done", lastTestRunResult.profile || lastTestRunResult.groupUrl ? "Profile/group selected." : "Using saved assignment.");
    }
    recordStep("Product discovery", "running");
    if (testPost) updateTestPipelineStep("discovery", "running", "Finding product URLs.");
    const discovery = await api("/api/products/discover", {
      method: "POST",
      body: JSON.stringify(testPost ? {
        testPost: true,
        includeExistingCandidates: true,
        includeUsedProducts: false,
        strictFresh: true,
        targetCandidateCount: 24,
      } : {}),
      timeoutMs: 90000,
      signal: options.signal,
    });
    renderWorkflowStepResult(discovery);
    const discoveredCount = Number(discovery.discovered || 0);
    if (!discoveredCount && testPost) {
      const detail = discovery.message || "No product candidate was selected from the configured filters/search sources.";
      recordStep("Product discovery", "blocked", detail);
      updateTestPipelineStep("discovery", "failed", detail);
      setCurrentProgress("1-post test: product selection needed", 28, detail, "danger", { local: true, testRun: true });
      showToast("No product was selected from filters/search. Review Product Source Finder filters/search.");
      return false;
    }
    recordStep("Product discovery", "done", `${discoveredCount} candidate(s)`);
    if (testPost) updateTestPipelineStep("discovery", "done", `${discoveredCount} candidate(s).`);

    const discoveredCandidateUrls = [...new Set((discovery.candidates || [])
      .map((candidate) => String(candidate.url || candidate.productUrl || "").trim())
      .filter(Boolean))];
    const fallbackCandidateUrls = testPost ? [] : selectedShopYourLikesProductUrls({ preferDiscovered: true });
    const candidateUrlsForPrep = discoveredCandidateUrls.length ? discoveredCandidateUrls : fallbackCandidateUrls;
    if (testPost && !candidateUrlsForPrep.length) {
      const detail = "Product discovery did not return any usable product URL for this test run.";
      updateTestPipelineStep("discovery", "failed", detail);
      setCurrentProgress("1-post test: product selection needed", 28, detail, "danger", { local: true, testRun: true });
      throw new Error(detail);
    }
    const { profileId, profileName } = selectedShopYourLikesIxProfile();

    // Test parity: reuse a buffer-ready product (approved image + shortlink) so
    // the 1-post test skips ChatGPT regeneration, exactly like production.
    let testBufferReadyUrl = "";
    if (testPost) {
      try {
        const buf = await api("/api/products/asset-buffer-status", { signal: options.signal });
        const ready = Array.isArray(buf?.buffer?.readyUrls) ? buf.buffer.readyUrls : [];
        testBufferReadyUrl = ready.find((u) => candidateUrlsForPrep.includes(u)) || ready[0] || "";
      } catch (_) { /* buffer status optional; fall back to fresh prep */ }
    }

    const prepareAssetsTask = async () => {
      recordStep("Product images", "running", testPost ? "Selecting review image, ChatGPT HD, and rotation in parallel with link creation." : "Running in parallel with ShopYourLikes links.");
      if (testPost) {
        updateTestPipelineStep("assets", "running", "Collecting up to 2 review images for this test; Hermes/local selector chooses the product-visible base JPG/PNG.");
        updateTestPipelineStep("hdImages", getValue("chatgptHdEnabled") ? "running" : "skipped", getValue("chatgptHdEnabled") ? "Opening ChatGPT HD in a new Edge window after image selection." : "ChatGPT HD disabled.");
      }
      const reuseBuffered = Boolean(testPost && testBufferReadyUrl);
      const prepUrls = reuseBuffered
        ? [testBufferReadyUrl, ...candidateUrlsForPrep.filter((u) => u !== testBufferReadyUrl)]
        : candidateUrlsForPrep;
      const assets = await api("/api/products/prepare-assets", {
        method: "POST",
        body: JSON.stringify({
          ...(testPost ? { limit: 1, testPost: true, forceFresh: !reuseBuffered, disableCachedFallback: !reuseBuffered } : {}),
          ...(prepUrls.length ? { productUrls: prepUrls } : {}),
        }),
        timeoutMs: PREPARE_ASSETS_TIMEOUT_MS,
        signal: options.signal,
      });
      renderWorkflowStepResult(assets);
      const selectedImageCount = assets.selected || assets.selectedWebp || 0;
      const hdImageCount = Number(assets.hdUpgraded || 0);
      recordStep("Product images", selectedImageCount ? "done" : "blocked", selectedImageCount ? `${selectedImageCount} prepared` : summarizeImagePrepFailure(assets));
      if (testPost) {
        const selectedImage = assets.selectedImages?.[0] || null;
        const reviewedCount = selectedImage?.candidateCount || selectedImage?.candidateOptions?.length || 0;
        const selector = selectedImage?.selection?.selector || "image selector";
        const imageDetail = selectedImageCount
          ? `${selectedImageCount} base image(s) ready. ${reviewedCount ? `${reviewedCount} candidate(s) reviewed by ${selector}.` : ""}`
          : `0 base image(s) ready. ${summarizeImagePrepFailure(assets)}`;
        updateTestPipelineStep("assets", selectedImageCount ? "done" : "failed", imageDetail);
        if (assets.hdEnabled === false) {
          updateTestPipelineStep("hdImages", "skipped", "ChatGPT HD disabled.");
        } else {
          const facebookImagePath = assets.selectedImages?.find((image) => image.chatgptHd)?.localPath || "";
          const hdError = assets.selectedImages?.find((image) => image.chatgptHd && !image.chatgptHd.ok)?.chatgptHd?.error || "";
          const loginWindowLeftOpen = assets.chatGptBrowserClose?.status === "left_open_for_chatgpt_login";
          updateTestPipelineStep("hdImages", hdImageCount ? "done" : "failed", hdImageCount
            ? `${hdImageCount}/${selectedImageCount || 1} HD image(s) downloaded for Facebook.${facebookImagePath ? ` ${facebookImagePath}` : ""}`
            : `HD failed: ${hdError || `${hdImageCount}/${selectedImageCount || 1} HD image(s) ready.`}${loginWindowLeftOpen ? " Isolated ChatGPT window is open; log in there once, then rerun." : ""}`);
        }
        if (!selectedImageCount || (assets.hdEnabled !== false && !hdImageCount)) {
          const hdError = assets.selectedImages?.find((image) => image.chatgptHd && !image.chatgptHd.ok)?.chatgptHd?.error || "";
          const loginWindowLeftOpen = assets.chatGptBrowserClose?.status === "left_open_for_chatgpt_login";
          const detail = !selectedImageCount ? "No base review image was prepared." : `ChatGPT HD image was not prepared.${hdError ? ` ${hdError}` : ""}${loginWindowLeftOpen ? " Isolated ChatGPT window is open; log in there once, then rerun." : ""}`;
          setCurrentProgress("1-post test: image prep blocked", 48, detail, "danger", { local: true, testRun: true });
          throw new Error(detail);
        }
      }
      return assets;
    };

    const prepareLinksTask = async (urls = candidateUrlsForPrep, detailPrefix = "") => {
      const uniqueUrls = [...new Set((urls || []).map((url) => String(url || "").trim()).filter(Boolean))];
      const forceFreshLinks = options.forceFreshLinks === true;
      const mappingSplit = splitProductUrlsByAffiliateMapping(uniqueUrls);
      const existingMapped = forceFreshLinks ? [] : mappingSplit.mapped;
      const missingUrls = forceFreshLinks ? uniqueUrls : mappingSplit.missing;
      const existingSylUrls = existingMapped.map((item) => item.mapping.sylLink).filter(Boolean);
      const existingShortCount = existingMapped.filter((item) => item.mapping.shortUrl).length;
      if (!uniqueUrls.length) {
        recordStep("ShopYourLikes", "skipped", "No product URLs.");
        recordStep("Shortlink provider", "skipped", "No ShopYourLikes URL to shorten.");
        if (testPost) {
          updateTestPipelineStep("syl", "skipped", "No product URLs.");
          updateTestPipelineStep("shortlink", "skipped", "No SYL URL to shorten.");
        }
        return { skipped: true, requestedUrls: uniqueUrls, generatedSylUrls: [], shortOkCount: 0, existingMappedUrls: [] };
      }
      if (!missingUrls.length) {
        let reuseCheck = null;
        let verifiedReuseCount = existingMapped.length;
        let verifiedShortCount = existingShortCount;
        if (testPost && profileId) {
          recordStep("ShopYourLikes", "running", `${detailPrefix}verifying existing SYL/Mavlynk mapping; no new SYL link will be generated.`);
          updateTestPipelineStep("syl", "running", "Verifying selected product through the ShopYourLikes endpoint; existing mapping will be reused.");
          updateTestPipelineStep("shortlink", "running", "Verifying existing Mavlynk shortlink for selected product.");
          reuseCheck = await api("/api/integrations/shopyourlikes-extension/generate", {
            method: "POST",
            body: JSON.stringify({ profileId, urls: uniqueUrls, shortenAfter: false, forceFresh: false, maxNewLinks: 1 }),
            timeoutMs: 60000,
            signal: options.signal,
          });
          renderWorkflowStepResult(reuseCheck);
          integrationLog(reuseCheck);
          const reusedResults = reuseCheck.results || [];
          verifiedReuseCount = reusedResults.filter((item) => item.success && item.sylLink && item.reused).length || existingMapped.length;
          verifiedShortCount = reusedResults.filter((item) => item.success && item.shortUrl).length || existingShortCount;
        }
        recordStep("ShopYourLikes", "done", `${detailPrefix}${verifiedReuseCount}/${uniqueUrls.length} existing SYL URL(s) reused; 0 new generated.`);
        recordStep("Shortlink provider", "done", `${verifiedShortCount}/${uniqueUrls.length} existing Mavlynk shortlink(s) reused.`);
        if (testPost) {
          updateTestPipelineStep("syl", "done", `${verifiedReuseCount}/${uniqueUrls.length} existing SYL URL(s) reused; 0 new generated.`);
          updateTestPipelineStep("shortlink", "done", `${verifiedShortCount}/${uniqueUrls.length} existing Mavlynk shortlink(s) reused.`);
        }
        return { skipped: false, sylLinks: reuseCheck, requestedUrls: uniqueUrls, generatedSylUrls: existingSylUrls, shortOkCount: verifiedShortCount, existingMappedUrls: existingMapped };
      }
      if (profileId) {
        recordStep("ShopYourLikes", "running", `${detailPrefix}${forceFreshLinks ? "fresh " : ""}${missingUrls.length}/${uniqueUrls.length} URL(s) need SYL, profile ${profileId}${profileName ? ` - ${profileName}` : ""}`);
        if (testPost) {
          updateTestPipelineStep("syl", "running", `Preparing SYL URL for ${missingUrls.length} selected product URL(s); existing links are reused first.`);
          updateTestPipelineStep("shortlink", "waiting", "Waiting for SYL URL.");
        }
        const sylLinks = await api("/api/integrations/shopyourlikes-extension/generate", {
          method: "POST",
          body: JSON.stringify({ profileId, urls: missingUrls, shortenAfter: false, forceFresh: forceFreshLinks, maxNewLinks: testPost ? 1 : 0 }),
          timeoutMs: 180000 + Math.max(0, missingUrls.length - 1) * 45000,
          signal: options.signal,
        });
        renderWorkflowStepResult(sylLinks);
        integrationLog(sylLinks);
        const sylResults = sylLinks.results || [];
        const generatedSylUrls = sylResults.filter((item) => item.success && item.sylLink).map((item) => item.sylLink);
        const reusedResponseCount = sylResults.filter((item) => item.success && item.sylLink && item.reused).length;
        const newSylCount = Math.max(0, generatedSylUrls.length - reusedResponseCount);
        const totalSylCount = existingMapped.length + generatedSylUrls.length;
        recordStep("ShopYourLikes", totalSylCount ? "done" : "blocked", `${totalSylCount}/${uniqueUrls.length} SYL URL(s) (${existingMapped.length + reusedResponseCount} reused, ${newSylCount} new)`);
        if (testPost) updateTestPipelineStep("syl", totalSylCount ? "done" : "failed", `${totalSylCount}/${uniqueUrls.length} SYL URL(s).`);

        if (generatedSylUrls.length) {
          recordStep("Shortlink provider", "running", `Shortening ${generatedSylUrls.length} SYL URL(s) with Mavlynk.`);
          if (testPost) updateTestPipelineStep("shortlink", "running", "Shortening SYL URL(s) with Mavlynk.");
          const shortlinks = await api("/api/integrations/shortlink/shorten-batch", {
            method: "POST",
            body: JSON.stringify({ urls: generatedSylUrls, saveToPosting: true }),
            timeoutMs: 90000 + Math.max(0, generatedSylUrls.length - 1) * 20000,
            signal: options.signal,
          });
          renderWorkflowStepResult(shortlinks);
          integrationLog(shortlinks);
          const shortOkCount = (shortlinks.results || []).filter((item) => item.success && item.shortUrl).length;
          const totalShortOkCount = existingShortCount + shortOkCount;
          recordStep("Shortlink provider", totalShortOkCount ? "done" : "blocked", `${totalShortOkCount}/${uniqueUrls.length} Mavlynk shortlink(s) (${existingShortCount} existing, ${shortOkCount} new)`);
          if (testPost) updateTestPipelineStep("shortlink", totalShortOkCount ? "done" : "failed", `${totalShortOkCount}/${uniqueUrls.length} Mavlynk shortlink(s).`);
          if (testPost && !totalShortOkCount) {
            const detail = "Mavlynk did not return a shortlink.";
            setCurrentProgress("1-post test: shortlink blocked", 74, detail, "danger", { local: true, testRun: true });
            throw new Error(detail);
          }
          return { skipped: false, sylLinks, shortlinks, generatedSylUrls: [...existingSylUrls, ...generatedSylUrls], shortOkCount: totalShortOkCount, requestedUrls: uniqueUrls, existingMappedUrls: existingMapped };
        }
        recordStep("Shortlink provider", existingShortCount ? "done" : "skipped", existingShortCount ? `${existingShortCount}/${uniqueUrls.length} existing Mavlynk shortlink(s).` : "No ShopYourLikes URL to shorten.");
        if (testPost) updateTestPipelineStep("shortlink", existingShortCount ? "done" : "skipped", existingShortCount ? `${existingShortCount}/${uniqueUrls.length} existing Mavlynk shortlink(s).` : "No SYL URL to shorten.");
        if (testPost && !existingShortCount) {
          const detail = "No ShopYourLikes URL was generated.";
          setCurrentProgress("1-post test: ShopYourLikes blocked", 66, detail, "danger", { local: true, testRun: true });
          throw new Error(detail);
        }
        return { skipped: !existingShortCount, sylLinks, generatedSylUrls: existingSylUrls, shortOkCount: existingShortCount, requestedUrls: uniqueUrls, existingMappedUrls: existingMapped };
      } else {
        recordStep("ShopYourLikes", "skipped", "Missing dedicated SYL profile for unmapped product URLs.");
        recordStep("Shortlink provider", existingShortCount ? "done" : "skipped", existingShortCount ? `${existingShortCount}/${uniqueUrls.length} existing Mavlynk shortlink(s).` : "No ShopYourLikes URL to shorten.");
        if (testPost) {
          updateTestPipelineStep("syl", "skipped", "Missing dedicated SYL profile for unmapped product URLs.");
          updateTestPipelineStep("shortlink", existingShortCount ? "done" : "skipped", existingShortCount ? `${existingShortCount}/${uniqueUrls.length} existing Mavlynk shortlink(s).` : "No SYL URL to shorten.");
          const detail = "Missing dedicated ShopYourLikes profile for product URLs that are not mapped yet.";
          setCurrentProgress("1-post test: link setup missing", 64, detail, "danger", { local: true, testRun: true });
          throw new Error(detail);
        }
        return { skipped: true, requestedUrls: uniqueUrls, generatedSylUrls: existingSylUrls, shortOkCount: existingShortCount, existingMappedUrls: existingMapped };
      }
    };

    let assets;
    let selectedAssetProductUrls = [];
    {
      const parallelDetail = testPost
        ? "Running ChatGPT HD image and ShopYourLikes/Mavlynk in parallel for the candidate product(s)."
        : "Running product images/HD and ShopYourLikes/Mavlynk in parallel; plan waits for both.";
      setCurrentProgress(
        testPost ? "1-post test: parallel assets + links" : "Full prep: parallel assets + links",
        testPost ? 36 : 42,
        parallelDetail,
        "running",
        { local: true, testRun: Boolean(testPost) },
      );
      parallelPrepActive = true;
      recordStep("Product images", "running", "Review image selection, ChatGPT HD, and rotation branch started.");
      recordStep("ShopYourLikes", "running", "SYL/Mavlynk link branch started.");
      if (testPost) {
        updateTestPipelineStep("assets", "running", "Collecting review images for one final product.");
        updateTestPipelineStep("hdImages", getValue("chatgptHdEnabled") ? "running" : "skipped", getValue("chatgptHdEnabled") ? "ChatGPT HD/rotation will run after base image selection." : "ChatGPT HD disabled.");
        updateTestPipelineStep("syl", "running", "Preparing SYL link for the candidate product(s) in parallel with image step.");
        updateTestPipelineStep("shortlink", "running", "Shortlink will be generated once SYL responds.");
      }
      const [assetsOutcome, linksOutcome] = await Promise.allSettled([
        prepareAssetsTask(),
        prepareLinksTask(),
      ]);
      parallelPrepActive = false;
      if (assetsOutcome.status === "rejected") throw assetsOutcome.reason;
      if (linksOutcome.status === "rejected") throw linksOutcome.reason;
      assets = assetsOutcome.value;
      selectedAssetProductUrls = [...new Set((assets.selectedImages || []).map((image) => String(image.productUrl || "").trim()).filter(Boolean))];
      if (testPost) {
        if (!selectedAssetProductUrls.length) throw new Error("No fresh selected product URL was returned by image prep.");
        const repaired = await api("/api/state", { signal: options.signal });
        if (repaired.state) renderState(repaired.state);
        let selectedShortlinkCount = selectedAssetProductUrls.filter((url) => mappedAffiliateForProductUrl(url)?.shortUrl).length;
        if (selectedShortlinkCount < selectedAssetProductUrls.length) {
          // Parallel SYL ran across all candidates but the picked product
          // didn't end up with a shortlink (race or no candidate match) —
          // run the targeted selected-product SYL as a safety net.
          updateTestPipelineStep("syl", "running", "Generating SYL link for the selected product (parallel batch missed it).");
          updateTestPipelineStep("shortlink", "running", "Completing Mavlynk shortlink for the selected product.");
          await prepareLinksTask(selectedAssetProductUrls, "selected product safety net: ");
          const repaired2 = await api("/api/state", { signal: options.signal });
          if (repaired2.state) renderState(repaired2.state);
          selectedShortlinkCount = selectedAssetProductUrls.filter((url) => mappedAffiliateForProductUrl(url)?.shortUrl).length;
        }
        if (selectedShortlinkCount < selectedAssetProductUrls.length) {
          const detail = `Shortlink dependency incomplete after selected-product retry: ${selectedShortlinkCount}/${selectedAssetProductUrls.length} selected product(s) have Mavlynk shortlinks.`;
          updateTestPipelineStep("shortlink", "failed", detail);
          setCurrentProgress("1-post test: shortlink blocked", 74, detail, "danger", { local: true, testRun: true });
          throw new Error(detail);
        }
      }
    }

    const planStepName = testPost ? "1-post test plan" : "Posting plan";
    recordStep(planStepName, "running");
    if (testPost) updateTestPipelineStep("plan", "running", "Creating one posting-plan row.");
    const plan = await api(testPost ? "/api/posting/prepare-test-post" : "/api/posting/prepare-plan", {
      method: "POST",
      body: JSON.stringify(testPost ? { limit: 1, testPost: true, productUrls: selectedAssetProductUrls } : {}),
      timeoutMs: testPost ? IXBROWSER_DASHBOARD_WAIT_MS : 90000,
      signal: options.signal,
    });
    renderWorkflowStepResult(plan);
    if (testPost) {
      if (!Number(plan.itemCount || 0) || !Number(plan.readyForLiveConnector || 0)) {
        const detail = `Posting plan is not ready: ${plan.itemCount || 0} item(s), ${plan.readyForLiveConnector || 0} ready.`;
        recordStep(planStepName, "blocked", detail);
        updateTestPipelineStep("plan", "failed", detail);
        setCurrentProgress("1-post test: plan blocked", 83, detail, "danger", { local: true, testRun: true });
        throw new Error(detail);
      }
      recordStep(planStepName, "done", `${plan.itemCount || 0} item(s), ${plan.readyForLiveConnector || 0} ready`);
      updateTestPipelineStep("plan", "done", `${plan.itemCount || 0} item(s), ${plan.readyForLiveConnector || 0} ready.`);
      renderTestRunResult({
        planId: plan.planId || "",
        profile: plan.sample?.[0]?.profile || lastTestRunResult.profile || "",
        groupUrl: plan.sample?.[0]?.groupUrl || lastTestRunResult.groupUrl || "",
      });
    } else if (!Number(plan.readyForLiveConnector || 0)) {
      const detail = `Full prep produced no ready rows: ${plan.itemCount || 0} item(s), 0 ready.`;
      recordStep(planStepName, "blocked", detail);
      throw new Error(detail);
    } else {
      recordStep(planStepName, "done", `${plan.itemCount || 0} item(s), ${plan.readyForLiveConnector || 0} ready`);
    }

    const approvals = await api("/api/approvals", { signal: options.signal });
    renderApprovals(approvals);
    renderReadiness();
    clearDirty();
    finishLocalProgress(testPost ? "1-post test workflow ready" : "Full prep pipeline ready", "Review approvals before any Facebook publish.", "ok", { testRun: testPost });
    showToast(testPost ? "1-post test workflow finished. Review approvals before Facebook publish." : "Full prep pipeline finished. Review approvals before any Facebook publish.");
    return true;
  } catch (err) {
    if (testPost && (options.signal?.aborted || err.cancelled)) return false;
    recordStep("Pipeline", "blocked", err.message);
    if (testPost) {
      const runningSteps = TEST_PIPELINE_STEPS
        .map(([id]) => id)
        .filter((id) => testPipelineState[id]?.status === "running");
      if (runningSteps.length) {
        runningSteps.forEach((id) => updateTestPipelineStep(id, "failed", err.message, { persist: false }));
        touchTestRun();
        renderTestPipelineSteps();
        scheduleTestRunPersist();
      } else {
        updateTestPipelineStep("plan", "failed", err.message);
      }
    }
    finishLocalProgress("Pipeline blocked", err.message, "danger", { testRun: testPost });
    showToast(err.message);
    return false;
  } finally {
    setBusy(false);
  }
}

async function recordPublishedPostUrl() {
  const postUrl = getValue("publishedPostUrlInput").trim();
  if (!postUrl) return showToast("Paste the Facebook post URL first.");
  setBusy(true);
  try {
    const result = await api("/api/posting/record-post-url", {
      method: "POST",
      body: JSON.stringify({
        postUrl,
        planId: getValue("publishedPostPlanIdInput"),
        profile: getValue("publishedPostProfileInput"),
        groupUrl: getValue("publishedPostGroupInput"),
      }),
    });
    if (result.state) renderState(result.state);
    const status = $("publishedPostUrlStatus");
    if (status) {
      status.className = "inlineNotice ok";
      status.textContent = `Recorded Facebook post URL: ${result.postUrl}`;
    }
    renderTestRunResult({
      postUrl: result.postUrl,
      planId: result.planId || lastTestRunResult.planId || "",
      profile: result.profile || lastTestRunResult.profile || "",
      groupUrl: result.groupUrl || lastTestRunResult.groupUrl || "",
    });
    updateTestPipelineStep("postUrl", "done", result.postUrl);
    setCurrentProgress("1-post test: post URL recorded", 100, result.postUrl, "ok", { local: true, testRun: true });
    workflowOutput({ facebookPostUrl: result.postUrl, planId: result.planId, profile: result.profile, groupUrl: result.groupUrl, recordedAt: result.recordedAt });
    await refresh({ force: true });
    showToast("Facebook post URL recorded.");
  } finally {
    setBusy(false);
  }
}

async function recoverFirstCommentForPostUrl() {
  const postUrl = getValue("publishedPostUrlInput").trim();
  if (!postUrl) return showToast("Paste the Facebook post URL first.");
  if (!confirm("Run live first-comment recovery on this Facebook post URL?")) return false;
  setBusy(true);
  updateTestPipelineStep("postUrl", "done", postUrl);
  updateTestPipelineStep("comment", "running", "Running comment-only recovery on the recorded permalink.");
  setCurrentProgress("First-comment recovery", 92, "Opening a different approved profile for the same group...", "running", { local: true, testRun: true });
  try {
    const result = await api("/api/posting/recover-first-comment", {
      method: "POST",
      body: JSON.stringify({
        postUrl,
        planId: getValue("publishedPostPlanIdInput") || lastTestRunResult.planId || "",
        profile: getValue("publishedPostProfileInput") || lastTestRunResult.profile || "",
        groupUrl: getValue("publishedPostGroupInput") || lastTestRunResult.groupUrl || "",
        operatorApprovedLive: true,
        liveConfirmation: LIVE_TEST_CONFIRMATION,
      }),
      timeoutMs: 700000,
    });
    if (result.state) renderState(result.state);
    if (result.registers) renderRegisters(result.registers);
    const detail = result.ok
      ? liveCommentSuccessDetail(result)
      : liveValidationDetail(result) || result.message || "First-comment recovery failed.";
    updateTestPipelineStep("comment", result.ok ? "done" : "failed", detail);
    setCurrentProgress(result.ok ? "First comment recovered" : "First-comment recovery failed", 100, detail, result.ok ? "ok" : "danger", { local: true, testRun: true });
    renderTestRunResult({
      postUrl: result.postUrl || postUrl,
      planId: result.planId || lastTestRunResult.planId || "",
      profile: result.profile || lastTestRunResult.profile || "",
      groupUrl: result.groupUrl || lastTestRunResult.groupUrl || "",
    });
    const status = $("publishedPostUrlStatus");
    if (status) {
      status.className = `inlineNotice ${result.ok ? "ok" : "danger"}`;
      status.textContent = result.ok ? `First comment recovered: ${postUrl}` : detail;
    }
    workflowOutput({
      facebookFirstCommentRecovery: {
        ok: result.ok,
        postUrl: result.postUrl || postUrl,
        planId: result.planId,
        profile: result.profile,
        commentProfile: result.commentProfile || "",
        commentProfileId: result.commentProfileId || "",
        groupUrl: result.groupUrl,
        attemptedCommentProfiles: result.attemptedCommentProfiles || [],
        validation: result.validation || null,
        liveLogFile: result.liveLogFile || "",
        message: result.message || "",
      },
      liveLog: result.liveLog || [],
    });
    await refresh({ force: true });
    showToast(result.ok ? "First comment recovered." : detail);
    return Boolean(result.ok);
  } catch (err) {
    const detail = liveValidationDetail(err.payload || {}) || err.message;
    updateTestPipelineStep("comment", "failed", detail);
    setCurrentProgress("First-comment recovery blocked", 100, detail, "danger", { local: true, testRun: true });
    workflowOutput({
      facebookFirstCommentRecoveryBlocked: {
        message: err.message,
        validation: err.payload?.validation || null,
        liveLogFile: err.payload?.liveLogFile || "",
      },
      liveLog: err.payload?.liveLog || [],
    });
    showToast(detail);
    return false;
  } finally {
    setBusy(false);
  }
}

async function openProductAssetsFolder() {
  if (!(await ensureSavedBeforeAction())) return;
  setBusy(true);
  try {
    const result = await api("/api/products/open-assets-folder", { method: "POST", body: JSON.stringify({}) });
    workflowOutput({ openedFolder: result.path, windowsPath: result.windowsPath });
    showToast("Image folder opened.");
  } finally {
    setBusy(false);
  }
}

function selectedBrowserDiscoverySourceUrl() {
  return (getValue("browserDiscoverySourceUrl") || nonCommentLines(getValue("generatedSourceUrls"))[0] || "").trim();
}

async function runBrowserDiscovery(captureOnly = false) {
  if (!(await ensureSavedBeforeAction())) return;
  const sourceUrl = selectedBrowserDiscoverySourceUrl();
  if (!captureOnly && !sourceUrl) {
    showToast("Choose a generated source URL first.");
    return;
  }
  if (!confirm(captureOnly
    ? "Capture the currently visible Walmart page in the local browser?"
    : "Open this source URL in the local browser? If a human check appears, solve it manually, then use Capture Local Page.")) {
    return;
  }
  setBusy(true);
  try {
    const result = await api("/api/products/discover-local-browser", {
      method: "POST",
      body: JSON.stringify({ sourceUrl, captureOnly }),
      timeoutMs: 70000,
    });
    workflowOutput(compactWorkflowResult(result));
    if (result.state) renderState(result.state);
    if (result.registers) renderRegisters(result.registers);
    const approvals = await api("/api/approvals");
    renderApprovals(approvals);
    renderReadiness();
    clearDirty();
    showToast(result.status === "needs_human_verification" ? "Human check detected. Solve it in the local browser, then capture." : "Local browser capture finished.");
  } finally {
    setBusy(false);
  }
}

function setIxSessionStatus(kind, message) {
  const el = $("ixSessionStatus");
  if (!el) return;
  el.className = `inlineNotice ${kind || "neutral"}`;
  el.textContent = message;
}

async function integrationPost(path, body = {}, options = {}) {
  const manageBusy = options.busy !== false;
  if (manageBusy) setBusy(true);
  try {
    if (path.includes("/ixbrowser/")) {
      setIxSessionStatus("warn", "Checking IXBrowser. If a login window is shown, log in there; the dashboard will keep waiting.");
    }
    const result = await api(path, {
      method: "POST",
      body: JSON.stringify(body),
      timeoutMs: options.timeoutMs || (path.includes("/ixbrowser/") ? IXBROWSER_DASHBOARD_WAIT_MS : undefined),
      signal: options.signal,
    });
    if (!options.quiet) integrationLog(result);
    return result;
  } catch (err) {
    const ixAutoOpened = Boolean(err.payload?.ixBrowserDesktopOpened);
    const payload = {
      ok: false,
      status: err.status || "error",
      error: err.payload?.error || "request_failed",
      message: err.message,
      nextStep: err.payload?.error === "ixbrowser_login_required"
        ? ixAutoOpened
          ? "IXBrowser desktop was opened automatically. Finish login there if prompted, keep it running, then click Test IXBrowser or Load Profiles again."
          : "Open IXBrowser desktop, log in again, confirm the local API is enabled, then click Test IXBrowser."
        : "Check the service status and retry.",
      ixBrowserDesktopOpened: ixAutoOpened,
    };
    if (!options.quiet) integrationLog(payload);
    if (path.includes("/ixbrowser/") || err.payload?.error === "ixbrowser_login_required") {
      setIxSessionStatus("danger", err.payload?.error === "ixbrowser_login_required"
        ? ixAutoOpened
          ? "IXBrowser desktop was opened automatically. Finish login there if prompted, keep it running, then click Test IXBrowser or Load Profiles again."
          : "IXBrowser is reachable, but the IXBrowser account/session is logged out. Open IXBrowser desktop, log in again, keep it running, then click Test IXBrowser."
        : err.message);
    }
    throw err;
  } finally {
    if (manageBusy) setBusy(false);
  }
}

async function autoVerifyIntegrations(options = {}) {
  if (autoIntegrationRunning) return;
  if (autoIntegrationRan && !options.force) return;
  if (!loadedSecrets || !workflowState) return;
  autoIntegrationRan = true;
  autoIntegrationRunning = true;
  const report = [];
  const externalLocked = !workflowState.operator.armedForExternalActions;
  const run = async (name, fn) => {
    try {
      const detail = await fn();
      report.push({ name, ok: true, detail: detail || "ok" });
    } catch (err) {
      report.push({
        name,
        ok: false,
        error: err.payload?.error || "request_failed",
        message: err.message,
      });
    }
  };
  setIxSessionStatus("neutral", externalLocked
    ? "Auto-checking local configuration. External browser and proxy checks are skipped while locked."
    : "Auto-checking configured APIs and loading read-only lists...");
  try {
    await run("API configuration", async () => {
      const health = await api("/api/integrations/health");
      const requiredMissing = Number(health.summary?.requiredMissing || 0);
      if (requiredMissing) {
        const missing = (health.services || [])
          .filter((service) => service.required !== false && !service.ok)
          .map((service) => service.label);
        const err = new Error(`Missing required API configuration: ${missing.join(", ") || requiredMissing}`);
        err.payload = { error: "api_config_missing", missing };
        throw err;
      }
      return health.summary;
    });
    if (loadedSecrets.webshare?.hasApiKey && !externalLocked) {
      await run("Webshare account", () => integrationPost("/api/integrations/webshare/test", {}, { busy: false, quiet: true }));
      await run("Webshare proxy list", async () => {
        const result = await integrationPost("/api/integrations/webshare/proxies", {}, { busy: false, quiet: true });
        integrationProxies = result.proxies || [];
        renderProxySelect();
        renderIntegrationLists();
        return `${integrationProxies.length} proxies loaded`;
      });
    } else if (loadedSecrets.webshare?.hasApiKey) {
      report.push({ name: "Webshare account", ok: true, detail: "skipped while external actions are locked" });
      report.push({ name: "Webshare proxy list", ok: true, detail: "skipped while external actions are locked" });
    }
    if (loadedSecrets.affiliateProxy?.hasProxy && !externalLocked) {
      await run("Affiliate proxy", () => integrationPost("/api/integrations/affiliate-proxy/test", {}, { busy: false, quiet: true }));
    } else if (loadedSecrets.affiliateProxy?.hasProxy) {
      report.push({ name: "Affiliate proxy", ok: true, detail: "skipped while external actions are locked" });
    }
    if (loadedSecrets.ixbrowser?.baseUrl && !externalLocked) {
      await run("IXBrowser session", () => integrationPost("/api/integrations/ixbrowser/test", {}, { busy: false, quiet: true }));
      await run("IXBrowser profile list", async () => {
        const result = await integrationPost("/api/integrations/ixbrowser/profiles", {}, { busy: false, quiet: true });
        integrationProfiles = result.profiles || [];
        renderProfileSelect();
        renderIntegrationLists();
        renderGroupAssignmentBuilder();
        return `${integrationProfiles.length} profiles loaded`;
      });
    } else if (loadedSecrets.ixbrowser?.baseUrl) {
      report.push({ name: "IXBrowser session", ok: true, detail: "skipped while external actions are locked" });
      report.push({ name: "IXBrowser profile list", ok: true, detail: "skipped while external actions are locked" });
    }
    const failures = report.filter((item) => !item.ok);
    integrationLog({ autoVerifiedAt: new Date().toISOString(), results: report });
    if (failures.length) {
      const ixLogin = failures.find((item) => item.error === "ixbrowser_login_required");
      setIxSessionStatus("warn", ixLogin
        ? "Auto-check finished. IXBrowser is reachable but needs desktop login before profiles can load."
        : `Auto-check finished. Needs attention: ${failures.map((item) => item.message || item.name).join("; ")}`);
    } else {
      setIxSessionStatus("ok", externalLocked
        ? "Auto-check finished. External browser and proxy checks were skipped while locked."
        : `Auto-check finished. Loaded ${integrationProfiles.length} IXBrowser profile(s) and ${integrationProxies.length} Webshare proxy option(s).`);
    }
  } finally {
    autoIntegrationRunning = false;
  }
}

async function checkIntegrationHealth() {
  setBusy(true);
  try {
    const result = await api("/api/integrations/health");
    integrationLog(result);
    const requiredIssues = (result.services || []).filter((service) => service.required !== false && !service.ok);
    const optionalIssues = (result.services || []).filter((service) => service.required === false && !service.ok);
    setIxSessionStatus(requiredIssues.length ? "warn" : "ok", requiredIssues.length
      ? `${requiredIssues.length} required API configuration item(s) still need setup. See the JSON report on the left.`
      : `Required API configuration is ready. ${optionalIssues.length} optional API item(s) are not configured and will use fallback workflow.`);
  } finally {
    setBusy(false);
  }
}

function renderIntegrationLists() {
  $("proxyProfileLists").innerHTML = `
    <div class="miniList">
      <strong>IXBrowser profiles (${integrationProfiles.length})</strong>
      ${integrationProfiles.slice(0, 20).map((profile) => `
        <div><span>${escapeHtml(profile.profile_id || profile.id || "-")}</span><span>${escapeHtml(profile.name || profile.title || "Profile")}</span></div>
      `).join("") || "<p>No profiles loaded.</p>"}
    </div>
    <div class="miniList">
      <strong>Webshare proxies (${integrationProxies.length})</strong>
      ${integrationProxies.slice(0, 20).map((proxy) => `
        <div><span>${escapeHtml(maskHostForDisplay(proxy.proxy_address || "-"))}</span><span>${escapeHtml(`${proxy.port || ""} ${proxy.country_code || ""} ${proxy.valid ? "valid" : "unknown"}`)}</span></div>
      `).join("") || "<p>No proxies loaded.</p>"}
    </div>
  `;
}

function renderProfileSelect() {
  const normalOptions = integrationProfiles.map((profile) => {
    const id = profile.profile_id || profile.id;
    const name = profile.name || profile.title || `Profile ${id}`;
    const label = `${id} - ${name}`;
    if (!isAllowedNormalIxBrowserProfileLabel(label)) return "";
    return `<option value="${escapeHtml(id)}">${escapeHtml(`${id} - ${name}`)}</option>`;
  }).filter(Boolean).join("") || "<option value=\"\">Click Load Profiles first. Blocked names are hidden.</option>";
  const allAllowedOptions = integrationProfiles.map((profile) => {
    const id = profile.profile_id || profile.id;
    const name = profile.name || profile.title || `Profile ${id}`;
    const label = `${id} - ${name}`;
    if (isBlockedIxBrowserProfileLabel(label)) return "";
    return `<option value="${escapeHtml(id)}">${escapeHtml(label)}</option>`;
  }).filter(Boolean).join("") || "<option value=\"\">Click Load Profiles first. Blocked names are hidden.</option>";
  $("ixProfileSelect").innerHTML = normalOptions;
  if ($("browserDiscoveryProfileSelect")) $("browserDiscoveryProfileSelect").innerHTML = normalOptions;
  if ($("shopyourlikesIxProfileSelect")) {
    $("shopyourlikesIxProfileSelect").innerHTML = allAllowedOptions;
    const saved = workflowState?.affiliate?.dedicatedIxProfileId || "";
    if (saved) $("shopyourlikesIxProfileSelect").value = saved;
  }
  syncCommentLimitProfileFromSelected({ overwrite: false });
  renderProdRoleSelects();
}

// ── Prod tab "Profile roles" selectors (moderators / ShopYourLikes / excluded) ──────────────
// UI mirrors of the canonical textareas (#moderatorProfiles, #blockedProfiles) + the affiliate SYL
// id/name. Populated from the live integrationProfiles list; SAVED through setValue + saveAll so
// they route through collectState -> PUT /api/state and can never desync. Selects are
// [data-transient] so the dirty tracker ignores them. Non-numeric manual lines (e.g. "wise") in
// the textareas are preserved on save.
function prodRoleIdsFromText(text) {
  const set = new Set();
  String(text || "").split(/\r?\n/).forEach(function (line) {
    const m = String(line).trim().match(/^(\d+)/);
    if (m) set.add(m[1]);
  });
  return set;
}
function prodRoleKeepNonId(text) {
  return String(text || "").split(/\r?\n/).map(function (s) { return s.trim(); }).filter(function (l) { return l && !/^\d/.test(l); });
}
function prodRoleLabelFor(id) {
  const p = integrationProfiles.find(function (x) { return String(x.profile_id || x.id) === String(id); });
  const name = (p && (p.name || p.title)) || "";
  return name ? (id + " - " + name) : String(id);
}
function renderProdRoleSelects() {
  const mod = $("prodModeratorProfileSelect");
  const exc = $("prodExcludedProfileSelect");
  const syl = $("prodSylProfileSelect");
  if (!mod && !exc && !syl) return;
  const hasProfiles = Array.isArray(integrationProfiles) && integrationProfiles.length > 0;
  const ix = (workflowState && workflowState.ixbrowser) || {};
  const modSet = prodRoleIdsFromText(ix.moderatorProfiles);
  const excSet = prodRoleIdsFromText(ix.blockedProfiles);
  const savedSyl = String((workflowState && workflowState.affiliate && workflowState.affiliate.dedicatedIxProfileId) || "");
  const build = function (container, single, checkedSet) {
    if (!container) return;
    if (container.contains(document.activeElement)) return; // don't clobber a click in progress
    if (!hasProfiles) { container.innerHTML = '<div class="profileCheckEmpty">Open this tab (or click Load Profiles) to list your live IXBrowser profiles.</div>'; return; }
    const t = single ? "radio" : "checkbox";
    const nm = single ? ' name="prodSylRadio"' : '';
    let html = integrationProfiles.map(function (p) {
      const id = String(p.profile_id || p.id);
      const name = p.name || p.title || ("Profile " + id);
      const checked = single ? (id === savedSyl) : checkedSet.has(id);
      return '<label class="profileCheck"><input type="' + t + '" data-transient="true"' + nm + ' value="' + escapeHtml(id) + '"' + (checked ? ' checked' : '') + '> <span>' + escapeHtml(id + " - " + name) + '</span></label>';
    }).join("");
    if (single) html += '<label class="profileCheck"><input type="radio" data-transient="true" name="prodSylRadio" value=""' + (savedSyl ? '' : ' checked') + '> <span>&#8212; none &#8212;</span></label>';
    container.innerHTML = html;
  };
  build(mod, false, modSet);
  build(exc, false, excSet);
  build(syl, true, null);
}
async function saveProdRoles() {
  if (!workflowState) return;
  const checkedIds = function (c) { return c ? Array.prototype.slice.call(c.querySelectorAll('input:checked')).map(function (i) { return i.value; }).filter(Boolean) : []; };
  const mod = $("prodModeratorProfileSelect");
  const exc = $("prodExcludedProfileSelect");
  const syl = $("prodSylProfileSelect");
  // CLOBBER GUARD: until the live profile list has loaded, the checklists show only a placeholder
  // (zero inputs) — saving in that state would silently ERASE every saved moderator/excluded/SYL
  // selection (this is how selections "disappeared" after a server restart). Refuse to save.
  const rolesLoaded = Array.isArray(integrationProfiles) && integrationProfiles.length > 0
    && ((mod && mod.querySelector("input")) || (exc && exc.querySelector("input")) || (syl && syl.querySelector("input")));
  if (!rolesLoaded) {
    if (typeof showToast === "function") showToast("Profiles not loaded yet — roles NOT saved. Click Load Profiles first.");
    return;
  }
  const ix = workflowState.ixbrowser || {};
  const modIds = checkedIds(mod), excIds = checkedIds(exc);
  const modLines = prodRoleKeepNonId(ix.moderatorProfiles).concat(modIds.map(prodRoleLabelFor));
  const excLines = prodRoleKeepNonId(ix.blockedProfiles).concat(excIds.map(prodRoleLabelFor));
  setValue("moderatorProfiles", modLines.join("\n"));
  setValue("blockedProfiles", excLines.join("\n"));
  const sylSel = syl ? syl.querySelector('input:checked') : null;
  const sylId = sylSel ? sylSel.value : "";
  if (sylId) {
    setValue("dedicatedIxProfileId", sylId);
    setValue("dedicatedIxProfileName", prodRoleLabelFor(sylId).replace(/^\d+\s*-\s*/, ""));
    setValue("useDedicatedIxProfile", true);
    setValue("dedicatedIxProfileFixedIp", true);
    setValue("rotateDedicatedProfileIp", false);
  }
  markDirty();
  await saveAll();
  const status = $("prodRolesStatus");
  if (status) { status.className = "inlineNotice ok"; status.textContent = "Saved: " + modIds.length + " moderator(s), " + excIds.length + " excluded" + (sylId ? (", SYL profile " + sylId) : "") + "."; }
  renderProfileSelect();
  showToast("Saved profile roles.");
}

function proxyOptionHtml(proxy) {
  const displayAddress = maskHostForDisplay(proxy.proxy_address || "");
  const label = `${proxy.id || displayAddress} - ${displayAddress}:${proxy.port} ${proxy.country_code || ""} ${proxy.valid ? "valid" : ""}`;
  return `<option value="${escapeHtml(proxy.id || proxy.proxy_address)}">${escapeHtml(label)}</option>`;
}

function renderProxySelect() {
  $("webshareProxySelect").innerHTML = integrationProxies.map(proxyOptionHtml).join("") || "<option value=\"\">Load proxies first</option>";
  renderShopYourLikesProxySelect();
}

function renderShopYourLikesProxySelect() {
  const select = $("shopyourlikesBrowserProxySelect");
  if (!select) return;
  const selected = workflowState?.affiliate?.browserSelectedProxyId || workflowState?.affiliateProxy?.selectedProxyId || "";
  select.innerHTML = integrationProxies.map(proxyOptionHtml).join("") || (selected ? `<option value="${escapeHtml(selected)}">Saved affiliate proxy: ${escapeHtml(maskHostForDisplay(selected))}</option>` : "<option value=\"\">Load proxies first or use saved affiliate proxy</option>");
  if (selected) select.value = selected;
}

async function testWebshare() {
  await integrationPost("/api/integrations/webshare/test");
}

async function loadWebshareProxies() {
  const result = await integrationPost("/api/integrations/webshare/proxies");
  integrationProxies = result.proxies || [];
  renderProxySelect();
  renderIntegrationLists();
}

async function testIxBrowser() {
  const result = await integrationPost("/api/integrations/ixbrowser/test");
  setIxSessionStatus("ok", `IXBrowser local API is ready. ${result.total || result.sampleCount || 0} profile(s) visible to the API.`);
}

async function loadIxProfiles() {
  const result = await integrationPost("/api/integrations/ixbrowser/profiles");
  integrationProfiles = result.profiles || [];
  renderProfileSelect();
  renderIntegrationLists();
  renderGroupAssignmentBuilder();
  setIxSessionStatus("ok", `Detected ${integrationProfiles.length} IXBrowser profile(s). Use the profile dropdown here, then manage active/failed profiles in the Profiles menu.`);
}

// Non-blocking profile load (busy:false) — used by the auto-load + Prod/Integrations role pickers
// so the dashboard is NEVER disabled while IXBrowser responds. A slow/hung IXBrowser must not
// freeze the UI (that locked the whole Prod tab).
async function loadIxProfilesQuiet() {
  const result = await integrationPost("/api/integrations/ixbrowser/profiles", {}, { busy: false });
  integrationProfiles = result.profiles || [];
  renderProfileSelect();
  renderIntegrationLists();
  renderGroupAssignmentBuilder();
  setIxSessionStatus("ok", `Detected ${integrationProfiles.length} IXBrowser profile(s).`);
  return integrationProfiles;
}

async function openIxProfile() {
  if (!confirm("Open this IXBrowser profile? External actions must be armed.")) return;
  const profileId = $("ixProfileSelect").value;
  await integrationPost("/api/integrations/ixbrowser/open", { profileId });
}

async function openIxAssignedGroup() {
  if (!(await ensureSavedBeforeAction())) return;
  if (!confirm("Open the selected IXBrowser profile to its assigned Facebook group URL? This only opens/navigates the profile; it does not post.")) return;
  const profileId = $("ixProfileSelect").value;
  const result = await integrationPost("/api/integrations/ixbrowser/open-assigned-group", { profileId });
  setIxSessionStatus("ok", `Opened profile ${result.profileId} to ${result.groupUrl}`);
}

async function closeIxProfile() {
  if (!confirm("Close this IXBrowser profile? External actions must be armed.")) return;
  const profileId = $("ixProfileSelect").value;
  await integrationPost("/api/integrations/ixbrowser/close", { profileId });
}

async function applyProxyToProfile() {
  const profileId = $("ixProfileSelect").value;
  const proxyId = $("webshareProxySelect").value;
  if (!profileId || !proxyId) {
    showToast("Load/select both an IXBrowser profile and a Webshare proxy first.");
    return false;
  }
  if (!(await ensureSavedBeforeAction())) return false;
  if (!confirm("Apply selected Webshare proxy to selected IXBrowser profile? External actions must be armed.")) return false;
  const proxy = integrationProxies.find((item) => String(item.id || item.proxy_address) === String(proxyId));
  await integrationPost("/api/integrations/ixbrowser/apply-webshare-proxy", {
    profileId,
    proxyId: proxy?.id,
    proxyAddress: proxy?.proxy_address || proxyId,
  });
  return true;
}

async function applyOneAttemptProxyToProfile() {
  const { profile } = selectedCommentProfile();
  if (!profile) {
    showToast("Load/select an IXBrowser profile or type a profile ID/name first.");
    return;
  }
  if (profileHasOneIpAttempt(profile)) {
    showToast("This profile already used its one IP correction attempt.");
    return;
  }
  const applied = await applyProxyToProfile();
  if (!applied) return;
  await recordOneIpAttempt({ skipConfirm: true });
}

async function markCommentLimited() {
  const { profile, profileId, profileName } = selectedCommentProfile();
  if (!profile) {
    showToast("Load/select an IXBrowser profile or type a profile ID/name first.");
    return;
  }
  if (!confirm("Mark this profile as unable to comment and stop using it until manual review?")) return;
  if (!(await ensureSavedBeforeAction())) return;
  const reason = getValue("commentLimitReason").trim() || "Facebook comment limit or IP/account review required";
  const result = await integrationPost("/api/comment-limit/quarantine", {
    profileLabel: profile,
    profileId,
    profileName,
    reason,
  });
  renderState(result.state);
  renderRegisters(result.registers);
  setValue("commentLimitProfile", "");
  setValue("commentLimitReason", "");
  clearDirty();
  renderReadiness();
  renderCommentLimitOverview();
  showToast("Profile quarantined for manual review.");
}

async function recordOneIpAttempt(options = {}) {
  const { profile, profileId, profileName } = selectedCommentProfile();
  if (!profile) {
    showToast("Load/select an IXBrowser profile or type a profile ID/name first.");
    return;
  }
  if (profileHasOneIpAttempt(profile)) {
    showToast("This profile already used its one IP correction attempt.");
    return;
  }
  if (!options.skipConfirm && !confirm("Record the single allowed IP correction attempt for this profile? Manual comment verification is still required.")) return;
  if (!(await ensureSavedBeforeAction())) return;
  const reason = getValue("commentLimitReason").trim() || "Facebook comment limit suspected from current IP";
  const result = await integrationPost("/api/comment-limit/one-ip-attempt", {
    profileLabel: profile,
    profileId,
    profileName,
    reason,
  });
  renderState(result.state);
  renderRegisters(result.registers);
  clearDirty();
  renderReadiness();
  renderCommentLimitOverview();
  showToast("One IP correction attempt recorded.");
}

async function markOneAttemptFailed() {
  if (!getValue("commentLimitReason").trim()) {
    setValue("commentLimitReason", "One IP correction attempt failed; profile still cannot comment");
  }
  await markCommentLimited();
}

async function assignAffiliateProxy() {
  if (!(await ensureSavedBeforeAction())) return;
  if (!confirm("Assign the first valid US Webshare proxy as the fixed affiliate API proxy?")) return;
  const result = await integrationPost("/api/integrations/webshare/assign-affiliate-proxy");
  integrationLog(result);
  loadedSecrets = null;
  await refresh({ force: true });
}

async function testAffiliateProxy() {
  if (!(await ensureSavedBeforeAction())) return;
  const result = await integrationPost("/api/integrations/affiliate-proxy/test");
  integrationLog(result);
  loadedSecrets = null;
  await refresh({ force: true });
}

function selectedShopYourLikesIxProfile() {
  const profileId = getValue("shopyourlikesIxProfileSelect") || getValue("dedicatedIxProfileId");
  const profile = integrationProfiles.find((item) => String(item.profile_id || item.id || "") === String(profileId));
  const profileName = profile?.name || profile?.title || getValue("dedicatedIxProfileName") || "";
  return { profileId, profileName };
}

async function saveShopYourLikesIxProfile() {
  if (!workflowState) return;
  const { profileId, profileName } = selectedShopYourLikesIxProfile();
  if (!profileId) {
    showToast("Load IXBrowser profiles, then select the ShopYourLikes profile first.");
    return;
  }
  setValue("dedicatedIxProfileId", profileId);
  setValue("dedicatedIxProfileName", profileName);
  setValue("useDedicatedIxProfile", true);
  setValue("dedicatedIxProfileFixedIp", true);
  setValue("rotateDedicatedProfileIp", false);
  markDirty();
  await saveAll();
  showToast(`Saved ShopYourLikes IX profile ${profileId}.`);
}

async function openShopYourLikesIxProfile() {
  if (!(await ensureSavedBeforeAction())) return;
  const { profileId, profileName } = selectedShopYourLikesIxProfile();
  if (!profileId) {
    showToast("Load/select the dedicated ShopYourLikes IXBrowser profile first.");
    return;
  }
  if (!confirm(`Open IXBrowser profile ${profileId}${profileName ? ` - ${profileName}` : ""} for ShopYourLikes? Extensions will load so you can install/login.`)) return;
  await integrationPost("/api/integrations/ixbrowser/open", { profileId });
  setIxSessionStatus("ok", `Opened dedicated ShopYourLikes IX profile ${profileId}. Install the extension and log in inside that browser.`);
}

async function openShopYourLikesBrowser() {
  if (!(await ensureSavedBeforeAction())) return;
  if (!confirm("Open the dedicated local Edge ShopYourLikes browser using the selected/saved affiliate proxy? Install/login manually if needed. External actions must be armed.")) return;
  const proxyId = getValue("shopyourlikesBrowserProxySelect");
  const result = await integrationPost("/api/integrations/shopyourlikes-browser/open", {
    proxyId,
    url: getValue("shopyourlikesBrowserStartUrl"),
  });
  integrationLog(result);
  renderState(result.state);
  renderReadiness();
  showToast("Local Edge ShopYourLikes browser opened.");
}

async function openDedicatedChatGptBrowser() {
  if (dirty) await saveAll();
  const result = await integrationPost("/api/integrations/chatgpt-browser/open", {}, { quiet: true });
  if (result.state) {
    renderState(result.state);
    renderReadiness();
  }
  const status = result.login?.status || "unknown";
  showToast(status === "logged_in"
    ? "Dedicated ChatGPT profile opened and logged in."
    : "Dedicated ChatGPT profile opened. Log in there once, then rerun the check.");
  updateSetupWizard();
  return result;
}

async function closeShopYourLikesBrowser() {
  if (!confirm("Close the dedicated ShopYourLikes browser? External actions must be armed.")) return;
  const result = await integrationPost("/api/integrations/shopyourlikes-browser/close");
  integrationLog(result);
  renderState(result.state);
  renderReadiness();
}

function selectedShopYourLikesProductUrls(options = {}) {
  const pools = options.preferDiscovered
    ? [getValue("productUrls"), getValue("sourceUrls"), getValue("affiliateOriginalLinks")]
    : [getValue("affiliateOriginalLinks"), getValue("productUrls"), getValue("sourceUrls")];
  return nonCommentLines(pools.find((value) => String(value || "").trim()) || "");
}

function normalizedProductUrlForComparison(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.hash = "";
    url.search = "";
    url.hostname = url.hostname.toLowerCase();
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return raw.replace(/\s+/g, "").replace(/\/$/, "").toLowerCase();
  }
}

function productIdFromRetailUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    const path = url.pathname;
    const walmart = path.match(/\/ip\/(?:[^/]+\/)?(\d{5,})(?:\/|$)/i);
    if (walmart) return walmart[1].toLowerCase();
    const amazon = path.match(/\/(?:dp|gp\/product)\/([a-z0-9]{10})(?:\/|$)/i);
    if (amazon) return amazon[1].toLowerCase();
    const target = path.match(/A-(\d{5,})(?:\/|$)/i);
    if (target) return target[1].toLowerCase();
  } catch {
    const walmart = String(value || "").match(/\/ip\/(?:[^/\s]+\/)?(\d{5,})(?:[/?#\s]|$)/i);
    if (walmart) return walmart[1].toLowerCase();
  }
  return "";
}

function mappedAffiliateForProductUrl(productUrl) {
  const normalizedUrl = normalizedProductUrlForComparison(productUrl);
  const productId = productIdFromRetailUrl(productUrl);
  const mappings = Array.isArray(workflowState?.affiliate?.linkMappings) ? workflowState.affiliate.linkMappings : [];
  return mappings.find((entry) => {
    const entryUrl = normalizedProductUrlForComparison(entry?.productUrl || entry?.originalProductUrl || entry?.originalUrl || "");
    const entryProductId = String(entry?.productId || productIdFromRetailUrl(entry?.productUrl || "") || "").trim().toLowerCase();
    const sylLink = String(entry?.sylLink || entry?.shopYourLikesUrl || entry?.shopyourlikesUrl || "").trim();
    const shortUrl = String(entry?.shortUrl || entry?.mavlynkUrl || entry?.finalShortlink || "").trim();
    return Boolean(sylLink && shortUrl && ((productId && entryProductId === productId) || (normalizedUrl && entryUrl === normalizedUrl)));
  }) || null;
}

function splitProductUrlsByAffiliateMapping(urls = []) {
  const mapped = [];
  const missing = [];
  for (const url of urls) {
    const mapping = mappedAffiliateForProductUrl(url);
    if (mapping) mapped.push({ url, mapping });
    else missing.push(url);
  }
  return { mapped, missing };
}

async function generateShopYourLikesExtensionLinks() {
  if (!(await ensureSavedBeforeAction())) return;
  const urls = selectedShopYourLikesProductUrls();
  if (!urls.length) {
    showToast("Add product URLs first in Affiliate Original/source links or Product URLs.");
    return;
  }
  const { profileId, profileName } = selectedShopYourLikesIxProfile();
  if (!profileId) {
    showToast("Save/select the dedicated ShopYourLikes IXBrowser profile first.");
    return;
  }
  if (!confirm(`Prepare ShopYourLikes links for ${urls.length} product URL(s) in IX profile ${profileId}${profileName ? ` - ${profileName}` : ""}. Existing product mappings will be reused; only missing SYL links will open the extension, then Mavlynk shortens the SYL links.`)) return;
  setBusy(true);
  try {
    const result = await api("/api/integrations/shopyourlikes-extension/generate", {
      method: "POST",
      body: JSON.stringify({ profileId, urls, forceFresh: false }),
      timeoutMs: 180000,
    });
    integrationLog(result);
    if (result.state) renderState(result.state);
    renderReadiness();
    const okCount = (result.results || []).filter((item) => item.success).length;
    const status = $("shopyourlikesExtensionStatus");
    if (status) {
      status.className = `inlineNotice ${okCount ? "ok" : "warn"} span2`;
      status.textContent = `${okCount}/${urls.length} SYL extension link(s) generated and shortened with Mavlynk. Posting uses only Mavlynk shortlinks mapped to ShopYourLikes URLs.`;
    }
    clearDirty();
    showToast(`${okCount} ShopYourLikes extension link(s) shortened with Mavlynk.`);
  } finally {
    setBusy(false);
  }
}

async function runSecurityAudit() {
  const result = await integrationPost("/api/security/audit");
  const report = result.report || {};
  const warnings = report.warnings || [];
  $("securityAuditOutput").textContent = [
    `Audit time: ${fmtTime(report.at)}`,
    `Dashboard: ${report.dashboard?.url || "-"} localOnly=${Boolean(report.dashboard?.localOnly)}`,
    `Warnings: ${warnings.length}`,
    "",
    ...warnings.map((warning) => `${String(warning.severity || "info").toUpperCase()} ${warning.port ? `port ${warning.port} ` : ""}${warning.processName ? `${warning.processName} - ` : ""}${warning.message || JSON.stringify(warning)}`),
    "",
    "Listening ports:",
    ...(report.listeners || []).map((item) => `${item.LocalAddress}:${item.LocalPort} ${item.ProcessName || ""} pid=${item.OwningProcess || ""}`),
  ].join("\n");
  await refresh({ force: true });
}

function templateText(type) {
  const base = "Use the injected Miro schema and current dashboard workflow state. Do not perform Facebook or external API actions.";
  const browserSourceUrl = selectedBrowserDiscoverySourceUrl() || "<source-url>";
  const templates = {
    audit: `${base}\nAudit the full workflow state for missing setup, risky settings, and the next 5 implementation steps.`,
    posting: `${base}\nCreate an approval-gated posting checklist covering moderator account, groups, shortlinks, descriptions, images, timing, and account rotation.`,
    ip: `${base}\nCreate a safe Webshare and IXBrowser health-check plan. Include failed IP/profile tracking and what needs API credentials.`,
    files: `${base}\nDesign exact local text file formats for inactive accounts, invalid proxies, limited accounts, review accounts, failed IPs, and errors.`,
    deal: `${base}\nReview productDiscovery and dealSource. Use the generated Walmart/store source URLs, require enabled filters, and discover enough unique product candidates for assigned profiles x posts per profile per day plus buffer. Rank daily deal candidates by freshness, Pro Seller status when enabled, discount signal, 5-star reviews first then 4-star if needed, positive-review image availability, and affiliate compatibility. Reject products already present in the used-products register. Return a shortlist plan only; do not post or scrape behind login walls.`,
    "walmart-browser": [
      "Use the local Walmart autopilot discovery helper. It tries direct Walmart filter extraction first, then the normal local browser if direct extraction is blocked.",
      "Do not solve or automate Walmart Robot/Human, CAPTCHA, anti-bot, or platform-limit checks.",
      "Normal browsing/page capture is allowed only when the page is already accessible.",
      "Do not use IXBrowser for Walmart discovery. IXBrowser is reserved for Facebook profile work.",
      "If the helper returns needs_human_verification, stop and tell the operator to solve it manually in the local browser.",
      "After successful capture the local browser must close automatically.",
      "",
      "Autopilot extraction command:",
      `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\Administrator\\Desktop\\facbeook agent\\scripts\\walmart-autopilot-discovery.ps1" -SourceUrl "${browserSourceUrl}" -AllowBrowser`,
      "",
      "Summarize discovered products, review-image candidates, and pending approvals. Do not post to Facebook.",
    ].join("\n"),
    extension: `${base}\nCreate a safe setup plan for ShopYourLikes link generation through the dedicated IXBrowser profile and browser extension/login. The product page must stay open in that IX profile; generate/copy the affiliate link from the ShopYourLikes extension; then shorten that generated SYL link with Mavlynk. The posting planner must use only the Mavlynk shortlink mapped to that SYL link and product. Keep the dedicated ShopYourLikes profile on one fixed proxy/IP.`,
    affiliate: `${base}\nCreate the exact link pipeline: clean old affiliate/tracking links, open the retailer product page in the dedicated ShopYourLikes IXBrowser extension/login profile, generate the ShopYourLikes affiliate link from the extension, then shorten that SYL link with Mavlynk. Use only the Mavlynk shortlink mapped to the same product and SYL URL for posting. Do not change any dedicated ShopYourLikes profile IP or proxy IP.`,
    "product-images": `${base}\nDesign the product page asset workflow. For each product URL, detect up to 5 realistic public customer review image candidates from positive 4-5 star reviews, prioritize 5-star review images, reject images from negative reviews, reject duplicate/stock-looking images, let Hermes visually choose the best candidate, rename the selected image with a descriptive SEO-safe filename, convert it to JPG/PNG for Facebook upload, and require human approval before Facebook posting when the HD image is not already approved.`,
    "text-rotation": `${base}\nValidate the ordered text rotation. Use one post text line per Facebook post body with no link, and one comment lead-in line before the Mavlynk shortlink in the pinned first comment. Prevent reuse until the list cycles with approval.`,
  };
  return templates[type] || base;
}

async function refresh(options = {}) {
  if (dirty && !options.force) return;
  if (requestBusy && !options.force) return;
  const [status, jobs, state, secrets, approvals, blocked] = await Promise.all([
    api("/api/status"),
    api("/api/jobs"),
    api("/api/state"),
    loadedSecrets ? Promise.resolve({ secrets: loadedSecrets }) : api("/api/secrets"),
    api("/api/approvals"),
    api("/api/profiles/blocked").catch(() => ({ blocked: [], cooldown: [] })),
  ]);
  renderStatus(status);
  renderJobs(jobs.jobs);
  renderEvents(jobs.events);
  renderApprovals(approvals);
  renderBlockedProfilesPanel(blocked && blocked.blocked, blocked && blocked.cooldown);
  if (!workflowState || state.state.updatedAt !== workflowState.updatedAt) {
    renderState(state.state);
    const registers = await api("/api/registers");
    renderRegisters(registers.registers);
    renderReadiness();
  }
  if (!loadedSecrets) {
    renderSecrets(secrets.secrets);
    renderReadiness();
  }
  autoVerifyIntegrations().catch((err) => {
    integrationLog({ ok: false, error: "auto_integration_check_failed", message: err.message });
    setIxSessionStatus("warn", "Automatic API check failed. See the JSON report on the left.");
  });
}

async function runParallelTest() {
  const input = $("parallelPostsInput");
  const n = Math.max(1, Math.min(6, parseInt((input && input.value) || "4", 10) || 4));
  if (!window.confirm(`Publish ${n} posts in PARALLEL to the group right now? (uses ready products, posts simultaneously)`)) return;
  setBusy(true);
  // Poll the live lanes every 1.5s so each profile's progress + steps show DURING the run.
  // (The endpoint blocks ~2 min; without this the lanes only appeared after it returned.)
  const laneTimer = setInterval(async () => {
    try { const s = await api("/api/state"); const st = s && (s.state || s); if (st) renderTestParallelLanes(st); } catch (e) { /* keep polling */ }
  }, 1500);
  try {
    const result = await api("/api/posting/run-live-test-post-parallel", {
      method: "POST",
      body: JSON.stringify({ parallelPosts: n }),
      timeoutMs: 900000,
    });
    if (result && result.state) renderState(result.state);
    if (result && result.ok === false) {
      showToast("Parallel test: " + (result.error || "no ready rows") + (result.detail ? " — " + result.detail : ""));
    } else if (result) {
      const landed = (result.outcomes || []).filter((o) => o.ok || o.postUrl).length;
      showToast(`Parallel test done: ${landed}/${result.workers} landed`);
    }
  } finally {
    clearInterval(laneTimer);
    setBusy(false);
  }
}

// Live lanes for the N parallel test posts (state.testParallel.lanes, polled).
function renderTestParallelLanes(state) {
  const host = $("testParallelLanes");
  if (!host) return;
  const tp = (state && state.testParallel) || {};
  const lanes = Array.isArray(tp.lanes) ? tp.lanes : [];
  if (!lanes.length) { host.innerHTML = ""; return; }
  const color = (s) => (s === "done" ? "#1a7f37" : s === "failed" ? "#cf222e" : s === "running" ? "#9a6700" : "#57606a");
  const rows = lanes.map((l) => {
    const secs = l.elapsedMs ? Math.round(l.elapsedMs / 1000) + "s" : "";
    const right = l.postUrl
      ? `<a href="${escapeHtml(l.postUrl)}" target="_blank" rel="noopener" style="color:#0969da">post ↗</a>`
      : (l.error ? `<span style="color:#cf222e">${escapeHtml(String(l.error).slice(0, 90))}</span>` : escapeHtml(l.step || ""));
    return `<div style="display:flex;gap:.6rem;align-items:center;padding:.35rem .55rem;border-left:3px solid ${color(l.status)};background:#f6f8fa;margin:.2rem 0;border-radius:4px;font-size:.85rem">
      <strong style="min-width:8rem">#${(l.workerIndex ?? 0) + 1} · profile ${escapeHtml(String(l.profileId || "?"))}</strong>
      <span style="color:${color(l.status)};font-weight:600;min-width:3.5rem">${escapeHtml(String(l.status || "").toUpperCase())}</span>
      <span style="color:#57606a;min-width:2.5rem">${secs}</span>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${right}</span>
    </div>`;
  }).join("");
  const landed = lanes.filter((l) => l.status === "done").length;
  // TOTAL batch time: from the earliest lane start to the latest finish (or now if still running).
  const starts = lanes.map((l) => Date.parse(l.startedAt)).filter((n) => !isNaN(n));
  const ends = lanes.map((l) => (l.finishedAt ? Date.parse(l.finishedAt) : Date.now())).filter((n) => !isNaN(n));
  const totalS = (starts.length && ends.length) ? Math.max(0, Math.round((Math.max.apply(null, ends) - Math.min.apply(null, starts)) / 1000)) : 0;
  host.innerHTML = `<div style="font-weight:600;margin:.6rem 0 .25rem">Parallel posts — ${landed}/${lanes.length} landed · total ${totalS}s${tp.active ? " · running…" : " · done"}</div>${rows}`;
}

function bindAsync(id, handler) {
  const el = $(id);
  if (!el) return;
  el.addEventListener("click", () => handler().catch((err) => showToast(err.message)));
}

bindAsync("startBtn", () => control("start-next"));
bindAsync("stopBtn", async () => { try { await api("/api/operator/stop-all", { method: "POST", body: JSON.stringify({}) }); } catch (_) {} return control("stop-active"); }); // STOP = kill in-flight posting/harvest/comment work too, not just the job
bindAsync("clearBtn", () => control("clear-done"));
bindAsync("clearBtnMonitor", () => control("clear-done"));
bindAsync("refreshMonitorBtn", () => refresh({ force: true }));
bindAsync("refreshApprovalsBtn", () => refresh({ force: true }));
bindAsync("approveAllQueuedBtn", () => approveQueuedJobs({ allQueued: true, action: "approve" }));
bindAsync("queueBtn", queueFromForm);
bindAsync("saveAllBtn", saveAll);
bindAsync("saveAllTop", saveAll);
bindAsync("saveSecretsBtn", saveSecrets);
bindAsync("queueDealBtn", () => queueJob("Plan deal filters", templateText("deal"), "plan"));
bindAsync("queueIpBtn", () => queueJob("Plan IP/profile health check", templateText("ip"), "plan"));
bindAsync("queueExtensionBtn", () => queueJob("Plan ShopYourLikes extension setup", templateText("extension"), "plan"));
bindAsync("queueProductImagesBtn", () => queueJob("Plan product review image workflow", templateText("product-images"), "plan"));
bindAsync("queueTextRotationBtn", () => queueJob("Check text rotation workflow", templateText("text-rotation"), "plan"));
bindAsync("runSecurityAuditBtn", runSecurityAudit);
bindAsync("checkIntegrationHealthBtn", checkIntegrationHealth);
bindAsync("testWebshareBtn", testWebshare);
bindAsync("loadWebshareProxiesBtn", loadWebshareProxies);
bindAsync("testIxBtn", testIxBrowser);
bindAsync("loadIxProfilesBtn", loadIxProfiles);
bindAsync("openIxProfileBtn", openIxProfile);
bindAsync("openIxAssignedGroupBtn", openIxAssignedGroup);
bindAsync("closeIxProfileBtn", closeIxProfile);
bindAsync("saveShopYourLikesIxProfileBtn", saveShopYourLikesIxProfile);
bindAsync("openShopYourLikesIxProfileBtn", openShopYourLikesIxProfile);
bindAsync("openShopYourLikesBrowserBtn", openShopYourLikesBrowser);
bindAsync("closeShopYourLikesBrowserBtn", closeShopYourLikesBrowser);
bindAsync("generateShopYourLikesExtensionLinksBtn", generateShopYourLikesExtensionLinks);
bindAsync("testShopYourLikesProxyBtn", testAffiliateProxy);
bindAsync("applyProxyToProfileBtn", applyProxyToProfile);
bindAsync("applyOneAttemptProxyBtn", applyOneAttemptProxyToProfile);
bindAsync("assignAffiliateProxyBtn", assignAffiliateProxy);
bindAsync("testAffiliateProxyBtn", testAffiliateProxy);
bindAsync("markCommentLimitedBtn", markCommentLimited);
bindAsync("recordIpAttemptBtn", recordOneIpAttempt);
bindAsync("markOneAttemptFailedBtn", markOneAttemptFailed);
bindAsync("runProductDiscoveryBtn", () => runWorkflowAction("/api/products/discover", "Product discovery finished."));
bindAsync("openBrowserDiscoveryBtn", () => runBrowserDiscovery(false));
bindAsync("captureBrowserDiscoveryBtn", () => runBrowserDiscovery(true));
bindAsync("queueHermesBrowserBtn", () => queueJob("Hermes Walmart browser discovery", templateText("walmart-browser"), "plan"));
bindAsync("prepareProductAssetsBtn", () => runWorkflowAction("/api/products/prepare-assets", "Product asset checks prepared."));
bindAsync("openProductAssetsFolderBtn", openProductAssetsFolder);
bindAsync("preparePostingPlanBtn", () => runWorkflowAction("/api/posting/prepare-plan", "Posting plan prepared."));
bindAsync("runLiveFullPostingPlanBtn", runLiveFullPostingPlan);
bindAsync("runRandomE2eTestHandoffBtn", runRandomE2eTestHandoff);
bindAsync("runParallelTestBtn", runParallelTest);
(function () {
  const inp = $("parallelPostsInput");
  const lbl = $("parallelTestCountLabel");
  if (inp && lbl) inp.addEventListener("input", () => { lbl.textContent = String(Math.max(1, Math.min(6, parseInt(inp.value, 10) || 4))); });
})();
bindAsync("clearTestRunBtn", clearTestRun);
bindAsync("runE2eTestHandoffBtn", runE2eTestHandoff);
bindAsync("prepareTestPostBtn", prepareTestPostPlan);
bindAsync("openFacebookTestHandoffBtn", openFacebookTestHandoff);
bindAsync("runFullPrepPipelineBtn", runFullPrepPipeline);
bindAsync("recordPublishedPostUrlBtn", recordPublishedPostUrl);
bindAsync("recoverFirstCommentBtn", recoverFirstCommentForPostUrl);
bindAsync("clearWorkflowOutputBtn", async () => workflowOutput("No workflow action has run in this browser session."));
bindAsync("buildGroupAssignmentsBtn", async () => {
  groupAssignmentDraft = [];
  renderGroupAssignmentBuilder();
});
bindAsync("evenGroupSplitBtn", async () => applyEvenGroupSplit());
bindAsync("percentGroupSplitBtn", async () => applyPercentGroupSplit());
bindAsync("addAssignmentGroupUrlBtn", async () => {
  if (addGroupUrlToAssignments($("assignmentGroupUrlInput").value)) {
    $("assignmentGroupUrlInput").value = "";
  }
});
bindAsync("copyLoadedProfilesBtn", async () => copyLoadedProfilesToNextRun());
bindAsync("selectAllProfilesBtn", async () => setVisibleAssignmentChecks(true));
bindAsync("clearVisibleProfilesBtn", async () => setVisibleAssignmentChecks(false));
bindAsync("rebuildProductSourcesBtn", async () => rebuildProductDiscoveryUrls());

document.querySelectorAll("[data-system-power-toggle]").forEach((toggle) => {
  toggle.addEventListener("change", async (event) => {
    const desired = event.currentTarget.checked;
    setRuntimePower(desired);
    try {
      const changed = await control(desired ? "enable" : "disable");
      if (!changed) setRuntimePower(!desired);
    } catch (err) {
      setRuntimePower(!desired);
      showToast(err.message);
    }
  });
});

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-approval-id][data-approval-action]");
  if (!button) return;
  event.preventDefault();
  decideApproval(button.dataset.approvalId, button.dataset.approvalAction).catch((err) => showToast(err.message));
});

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-job-approval-id][data-job-approval-action]");
  if (!button) return;
  event.preventDefault();
  approveQueuedJobs({
    jobIds: [button.dataset.jobApprovalId],
    action: button.dataset.jobApprovalAction,
  }).catch((err) => showToast(err.message));
});

function syncMirroredOperatorToggle(sourceId) {
  const group = Object.values(OPERATOR_TOGGLE_GROUPS).find((ids) => ids.includes(sourceId));
  if (!group) return false;
  const value = getValue(sourceId);
  group.forEach((id) => setValue(id, value));
  renderOperatorToggleLabels();
  renderSafetySnapshot();
  return true;
}

document.querySelectorAll("[data-view-target]").forEach((button) => {
  button.addEventListener("click", () => setActiveView(button.dataset.viewTarget));
});

$("dashboardSearch")?.addEventListener("input", updateDashboardUxFilters);
$("showAdvancedUi")?.addEventListener("change", updateDashboardUxFilters);

$("sidebarToggle")?.addEventListener("click", () => {
  const open = !document.body.classList.contains("sidebarOpen");
  document.body.classList.toggle("sidebarOpen", open);
  $("sidebarToggle").setAttribute("aria-expanded", open ? "true" : "false");
});

$("setupWizardLauncher")?.addEventListener("click", () => setSetupWizardOpen(true));
$("setupWizardClose")?.addEventListener("click", () => setSetupWizardOpen(false));
$("setupWizard")?.addEventListener("click", (event) => {
  if (event.target === event.currentTarget) setSetupWizardOpen(false);
});

document.querySelectorAll("[data-wizard-step]").forEach((button) => {
  button.addEventListener("click", () => setWizardStep(button.dataset.wizardStep));
});

document.addEventListener("click", (event) => {
  const openButton = event.target.closest("[data-wizard-open]");
  if (openButton) {
    event.preventDefault();
    openDashboardTarget(openButton.dataset.wizardOpen, openButton.dataset.wizardFocus);
    return;
  }
  const nextButton = event.target.closest("[data-wizard-next]");
  if (nextButton) {
    event.preventDefault();
    setWizardStep(nextButton.dataset.wizardNext);
    return;
  }
  const actionButton = event.target.closest("[data-wizard-action]");
  if (!actionButton) return;
  event.preventDefault();
  runWizardAction(actionButton.dataset.wizardAction).catch((err) => showToast(err.message));
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("setupWizard")?.hidden) setSetupWizardOpen(false);
});

$("addGroupUrlBtn").addEventListener("click", () => {
  const value = $("groupUrlInput").value.trim();
  if (!value) return;
  appendLine("groups", value);
  $("groupUrlInput").value = "";
  groupAssignmentDraft = [];
  renderGroupAssignmentBuilder();
});

$("groups")?.addEventListener("input", () => {
  groupAssignmentDraft = [];
  renderGroupAssignmentBuilder();
});

// STEP 2 SOURCE METHOD: copy-from-group vs traditional web scraping — show only the active branch.
function updateContentSourceBranch() {
  const copy = !!($("contentSourcesEnabled") && $("contentSourcesEnabled").checked);
  const cp = $("sourceCopyFields"), sc = $("sourceScrapeFields");
  if (cp) cp.style.display = copy ? "" : "none";
  if (sc) sc.style.display = copy ? "none" : ""; // scrape branch holds ALL manual-scraping inputs (urls + comment + post texts)
  // COPY MODE always runs only-copied-products + auto-sized reserve — force both ON (the checkboxes are hidden).
  if (copy) {
    const ex = $("contentSourcesExclusive"); if (ex && !ex.checked) ex.checked = true;
    const ra = $("contentSourcesReserveAuto"); if (ra && !ra.checked) ra.checked = true;
  }
  // reflect the prominent method switch (Manual scraping <-> Easy copy from group)
  document.querySelectorAll(".methodOpt").forEach((b) => b.classList.toggle("active", (b.dataset.method === "copy") === copy));
  if (!copy) { try { renderManualScrapeStatus(); if (__ixLiveOk === null) liveCheckIxBrowser(); } catch (_) {} } // refresh badges + live-ping IXBrowser once when manual scraping is shown
}

// MANUAL-SCRAPING setup panel: connection badges for everything research/images/links need, with a
// "Set up ->" jump to the exact field in the right tab. IXBrowser is a LIVE ping (it runs on the default
// local API, so a saved-field check would wrongly show red); the rest are key-saved / config signals.
let __ixLiveOk = null; // live IXBrowser local-API result: null=checking, true=connected, false=down
function renderManualScrapeStatus() {
  const grid = $("scrapeCredStatus");
  if (!grid) return;
  const ws = (typeof workflowState !== "undefined" && workflowState) || {};
  const sec = (typeof loadedSecrets !== "undefined" && loadedSecrets) || {};
  const af = ws.affiliate || {}, sl = ws.shortlink || {}, pa = ws.productAssets || {};
  const mk = (name, ok, msgOk, msgBad, tab, focus) => ({ name, state: ok ? "ok" : "bad", msg: ok ? msgOk : msgBad, tab, focus });
  const ix = __ixLiveOk === null ? { name: "IXBrowser API", state: "checking", msg: "checking…", tab: "credentials", focus: "ixbrowserBaseUrl" }
    : __ixLiveOk ? { name: "IXBrowser API", state: "ok", msg: "connected (live)", tab: "credentials", focus: "ixbrowserBaseUrl" }
    : { name: "IXBrowser API", state: "bad", msg: "local API not reachable", tab: "credentials", focus: "ixbrowserBaseUrl" };
  const rows = [
    ix,
    mk("Firecrawl (research/images)", !!(sec.firecrawl && sec.firecrawl.hasApiKey), "key saved", "add API key", "credentials", "firecrawlApiKey"),
    mk("ChatGPT HD images", pa.enabled === true, "on", "enable + log in via the button", "content", "chatgptHdEnabled"),
    mk("ShopYourLikes profile", !!(String(af.dedicatedIxProfileId || "").trim() || String(af.dedicatedIxProfileName || "").trim()), "profile set", "set SYL profile", "affiliate", "affiliateEnabled"),
    mk("Mavlynk shortlinks", sl.enabled === true && !!(sec.shortlink && sec.shortlink.hasApiKey), "ready", "enable + add key", "affiliate", "shortlinkEnabled"),
    mk("Webshare proxy", !!(sec.webshare && sec.webshare.hasApiKey), "key saved", "add API key (optional)", "credentials", "webshareApiKey"),
  ];
  grid.innerHTML = rows.map((r) => `
    <div class="msCred ${r.state}">
      <span class="msDot"></span>
      <span class="msName">${escapeHtml(r.name)}</span>
      <span class="msState">${escapeHtml(r.msg)}</span>
      ${r.state === "bad" ? `<a class="msFix" href="#" data-ms-tab="${r.tab}" data-ms-focus="${r.focus}">Set up &rarr;</a>` : ""}
    </div>`).join("");
}
// LIVE IXBrowser check: ping the same local-API test the rest of the app uses. Cached in __ixLiveOk so it
// runs once on panel-show + on Re-check (not on every render).
async function liveCheckIxBrowser() {
  try { await integrationPost("/api/integrations/ixbrowser/test", {}, { busy: false, quiet: true }); __ixLiveOk = true; }
  catch (_) { __ixLiveOk = false; }
  try { renderManualScrapeStatus(); } catch (_) {}
}
// "Set up ->" jumps to the right tab and focuses the exact field (delegated, bound once).
$("scrapeCredStatus")?.addEventListener("click", (e) => {
  const a = e.target.closest("a.msFix"); if (!a) return; e.preventDefault();
  const nav = document.querySelector(`[data-view-target="${a.dataset.msTab}"]`); if (nav) nav.click();
  setTimeout(() => { const el = $(a.dataset.msFocus); if (el) { try { el.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (_) {} try { el.focus(); } catch (_) {} const lab = el.closest("label"); if (lab) { lab.classList.add("flash"); setTimeout(() => lab.classList.remove("flash"), 1400); } } }, 280);
});
// Action buttons.
$("scrapeOpenGptBtn")?.addEventListener("click", async () => {
  const out = $("scrapeSetupResult"); if (out) out.textContent = "Opening ChatGPT browser…";
  try { if (typeof openDedicatedChatGptBrowser === "function") { await openDedicatedChatGptBrowser(); if (out) out.textContent = "ChatGPT browser opened — log in / verify, then close it when done."; } }
  catch (e) { if (out) out.textContent = "Could not open ChatGPT browser: " + ((e && e.message) || e); }
});
$("scrapeTestResearchBtn")?.addEventListener("click", async () => {
  const out = $("scrapeSetupResult"); if (out) out.textContent = "Running a product-research test…";
  try { if (typeof runWorkflowAction === "function") { await runWorkflowAction("/api/products/discover", "Product research test finished — see Saved Products / workflow output."); if (out) out.textContent = "Product research test finished. Check Saved Products for results."; } }
  catch (e) { if (out) out.textContent = "Research test failed: " + ((e && e.message) || e); }
});
$("scrapeRefreshCredsBtn")?.addEventListener("click", async () => {
  const out = $("scrapeSetupResult"); if (out) out.textContent = "Re-checking connections…";
  try { const r = await api("/api/secrets"); if (r && r.secrets) loadedSecrets = r.secrets; } catch (_) {}
  __ixLiveOk = null; renderManualScrapeStatus(); // show "checking…"
  try { await liveCheckIxBrowser(); } catch (_) {}
  if (out) out.textContent = "Connection status refreshed.";
});
$("contentSourcesEnabled")?.addEventListener("change", updateContentSourceBranch);
// PROMINENT METHOD SWITCH: the two big buttons drive the contentSourcesEnabled state (copy vs scrape).
document.querySelectorAll(".methodOpt").forEach((btn) => btn.addEventListener("click", () => {
  const cb = $("contentSourcesEnabled");
  if (!cb) return;
  cb.checked = btn.dataset.method === "copy";
  cb.dispatchEvent(new Event("change", { bubbles: true })); // updates branches + triggers the dashboard auto-save
  cb.dispatchEvent(new Event("input", { bubbles: true }));
}));
// Quick-add a SOURCE group (to copy products FROM) — mirrors the posting-group adder.
$("addSourceGroupUrlBtn")?.addEventListener("click", () => {
  const el = $("sourceGroupUrlInput");
  const value = (el && el.value || "").trim();
  if (!value) return;
  appendLine("contentSourceGroupsText", value);
  if (el) el.value = "";
});

$("assignmentGroupUrlInput")?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  if (addGroupUrlToAssignments(event.currentTarget.value)) {
    event.currentTarget.value = "";
  }
});

$("profilesForNextRun")?.addEventListener("input", renderGroupAssignmentBuilder);
$("activeProfiles")?.addEventListener("input", renderGroupAssignmentBuilder);
$("moderatorProfiles")?.addEventListener("input", renderGroupAssignmentBuilder);

$("groupAssignmentBuilder")?.addEventListener("input", (event) => {
  if (!event.target.matches("[data-assignment-share]")) return;
  if (equalSplitEnabled()) return; // equal-split mode: shares are managed automatically
  applyShareSliderToCard(event.target.closest("[data-assignment-card]"));
});

$("groupAssignmentBuilder")?.addEventListener("click", (event) => {
  const quick = event.target.closest("[data-share-quick]");
  if (quick) {
    event.preventDefault();
    if (equalSplitEnabled()) return; // equal-split mode: shares are managed automatically
    const card = quick.closest("[data-assignment-card]");
    const slider = card && card.querySelector("[data-assignment-share]");
    if (slider) { slider.value = quick.getAttribute("data-share-quick"); applyShareSliderToCard(card); }
    return;
  }
  const button = event.target.closest("[data-remove-assignment-group]");
  if (!button) return;
  event.preventDefault();
  removeGroupUrlFromAssignments(Number(button.getAttribute("data-remove-assignment-group")));
});

$("groupAssignmentBuilder")?.addEventListener("change", (event) => {
  if (!event.target.matches("[data-assignment-profile]")) return;
  // EQUAL-SPLIT uniqueness: a profile may live in only ONE group — checking it here unchecks it
  // in every other group card.
  if (equalSplitEnabled() && event.target.checked) {
    const value = event.target.value;
    document.querySelectorAll("[data-assignment-card]").forEach((card) => {
      if (card.contains(event.target)) return;
      card.querySelectorAll("[data-assignment-profile]").forEach((box) => {
        if (box.value === value && box.checked) box.checked = false;
      });
    });
  }
  syncGroupAssignmentOutput();
  markDirty();
});

$("equalSplitAssignments")?.addEventListener("change", () => {
  const on = Boolean(getValue("equalSplitAssignments"));
  $("groupAssignmentBuilder")?.classList.toggle("equalSplitOn", on);
  if (on) applyEqualUniqueSplit();
  else showToast("Equal split OFF — manual sliders re-enabled.");
  markDirty();
});

$("markIpFailedBtn").addEventListener("click", () => {
  const ip = $("currentIp").value.trim();
  if (!ip) return showToast("Current IP is empty.");
  const stamp = new Date().toLocaleString();
  const line = `${ip} - marked failed ${stamp}`;
  appendLine("failedIps", line);
  appendRegisterLine("failedIps", line);
  markDirty();
});

$("ixProfileSelect")?.addEventListener("change", () => syncCommentLimitProfileFromSelected({ overwrite: true }));

document.querySelectorAll("[data-template]").forEach((button) => {
  button.addEventListener("click", () => {
    const type = button.getAttribute("data-template");
    queueJob(button.textContent.trim(), templateText(type), "plan").catch((err) => showToast(err.message));
  });
});

let savedView = window.location.hash ? window.location.hash.slice(1) : DEFAULT_VIEW;
try { savedView = savedView || localStorage.getItem(VIEW_STORAGE_KEY) || DEFAULT_VIEW; } catch {}
try { setValue("showAdvancedUi", localStorage.getItem(ADVANCED_UI_STORAGE_KEY) === "1"); } catch {}
applyButtonTooltips();
resetTestPipelineSteps({ persist: false });
renderTestRunResult({}, { persist: false });
renderTestRunProgress();
setActiveView(savedView);
refresh().catch((err) => showToast(err.message));
setInterval(() => refresh().catch((err) => showToast(err.message)), 3000);

document.addEventListener("input", (event) => {
  if (!event.target.matches("input, textarea, select")) return;
  if (event.target.matches("[data-runtime-control]")) return;
  if (event.target.matches("[data-transient]")) return;
  if (event.target.matches("[data-secret]")) markSecretDirty();
  else {
    markDirty();
    syncPreviewStateFromForm();
  }
});

document.addEventListener("change", (event) => {
  if (!event.target.matches("input, textarea, select")) return;
  if (event.target.matches("[data-runtime-control]")) return;
  if (event.target.matches("[data-transient]")) return;
  if (syncMirroredOperatorToggle(event.target.id)) markDirty();
  if (event.target.matches("[data-discovery-filter], [data-discovery-source]")) rebuildProductDiscoveryUrls({ quiet: true });
  if (event.target.matches("[data-secret]")) return;
  syncPreviewStateFromForm();
});

window.addEventListener("beforeunload", (event) => {
  if (!dirty) return;
  event.preventDefault();
  event.returnValue = "";
});

renderDirtyStatus();
renderIntegrationLists();
updateSetupWizard();

// Bidirectional sync: ChatGPT HD toggles on Posting tab (rail) and Test tab
// mirror the canonical toggle on the Content tab. Any one updates state.
(function bindHdMirrorToggle() {
  const original = document.getElementById("chatgptHdEnabled");
  const railMirror = document.getElementById("chatgptHdEnabledRail");
  const testMirror = document.getElementById("chatgptHdEnabledTest");
  if (!original) return;
  const railLabel = document.getElementById("chatgptHdEnabledRailLabel");
  const testLabel = document.getElementById("chatgptHdEnabledTestLabel");
  const refreshLabels = () => {
    const text = original.checked ? "ChatGPT HD image step: ON (slow)" : "ChatGPT HD image step: OFF (fast)";
    if (railLabel) railLabel.textContent = text;
    if (testLabel) testLabel.textContent = text;
  };
  const mirrors = [railMirror, testMirror].filter(Boolean);
  for (const m of mirrors) m.checked = original.checked;
  refreshLabels();
  for (const m of mirrors) {
    m.addEventListener("change", () => {
      original.checked = m.checked;
      for (const other of mirrors) { if (other !== m) other.checked = m.checked; }
      refreshLabels();
      original.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  original.addEventListener("change", () => {
    for (const m of mirrors) m.checked = original.checked;
    refreshLabels();
  });
})();

/* ==========================================================================
 * Operator UX overhaul: collapsible panels, bulk actions, confirm guards
 * ========================================================================== */
const PANEL_COLLAPSED_STORAGE_KEY = "facebook-agent-dashboard-collapsed-panels";

function uxPanelId(panel) {
  const h2 = panel.querySelector(".panelHead h2") || panel.querySelector(":scope > h2");
  const title = (h2?.textContent || "").trim();
  const view = panel.getAttribute("data-view") || "";
  return `${view}::${title}`.toLowerCase().replace(/\s+/g, "_");
}

function uxLoadCollapsedPanels() {
  try {
    const raw = localStorage.getItem(PANEL_COLLAPSED_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch { return new Set(); }
}

function uxSaveCollapsedPanels(set) {
  try { localStorage.setItem(PANEL_COLLAPSED_STORAGE_KEY, JSON.stringify([...set])); } catch {}
}

function uxInitCollapsiblePanels() {
  const collapsed = uxLoadCollapsedPanels();
  document.querySelectorAll("section.panel").forEach((panel) => {
    if (panel.classList.contains("command")) return;
    if (panel.classList.contains("noCollapse")) return;
    const head = panel.querySelector(".panelHead");
    if (!head) return;
    panel.classList.add("collapsible");
    head.setAttribute("role", "button");
    head.setAttribute("tabindex", "0");
    const id = uxPanelId(panel);
    const startCollapsed = collapsed.has(id);
    if (startCollapsed) panel.classList.add("collapsed");
    head.setAttribute("aria-expanded", startCollapsed ? "false" : "true");
    const toggle = (event) => {
      if (event.target.closest("button, input, textarea, select, a")) return;
      panel.classList.toggle("collapsed");
      const isCollapsed = panel.classList.contains("collapsed");
      head.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
      const next = uxLoadCollapsedPanels();
      if (isCollapsed) next.add(id); else next.delete(id);
      uxSaveCollapsedPanels(next);
    };
    head.addEventListener("click", toggle);
    head.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(event); }
    });
  });
}

function uxSetAllPanels(collapsed) {
  const next = new Set();
  document.querySelectorAll("section.panel.collapsible").forEach((panel) => {
    const id = uxPanelId(panel);
    const head = panel.querySelector(".panelHead");
    if (collapsed) {
      panel.classList.add("collapsed");
      head?.setAttribute("aria-expanded", "false");
      next.add(id);
    } else {
      panel.classList.remove("collapsed");
      head?.setAttribute("aria-expanded", "true");
    }
  });
  uxSaveCollapsedPanels(next);
}

function uxAttachConfirmGuards() {
  // Comment-cooldown input: CHANGE-based 'not advised' confirm that REVERTS on cancel (not the generic
  // click-guard, which would nag on every focus). Marked guarded so the generic loop below skips it.
  const cd = $("commentCooldownMinutes");
  if (cd && cd.dataset.confirmGuardAttached !== "1") {
    cd.dataset.confirmGuardAttached = "1";
    let prior = cd.value;
    cd.addEventListener("focus", () => { prior = cd.value; });
    cd.addEventListener("change", () => {
      if (String(cd.value) === String(prior)) return;
      if (!window.confirm(cd.dataset.confirm || "Changing this is not advised. Continue?")) {
        cd.value = prior;
        cd.dispatchEvent(new Event("input", { bubbles: true })); // keep auto-save on the reverted value
        return;
      }
      prior = cd.value;
    });
  }
  document.querySelectorAll("[data-confirm]").forEach((el) => {
    if (el.dataset.confirmGuardAttached === "1") return;
    el.dataset.confirmGuardAttached = "1";
    el.addEventListener("click", (event) => {
      if (event.altKey) return;
      const message = el.dataset.confirm;
      if (!message) return;
      if (!window.confirm(message)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
  });
  const fullBtn = $("runLiveFullPostingPlanBtn");
  if (fullBtn && !fullBtn.dataset.confirm) {
    fullBtn.dataset.confirm = "Start the LIVE full production posting plan? Multiple Facebook posts will be published to real groups.";
    fullBtn.dataset.confirmGuardAttached = "1";
    fullBtn.addEventListener("click", (event) => {
      if (event.altKey) return;
      if (!window.confirm(fullBtn.dataset.confirm)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
  }
}

function uxAttachClearFailedProfiles() {
  const btn = $("clearFailedProfilesBtn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      const result = await api("/api/ixbrowser/clear-failed-profiles", {
        method: "POST",
        body: JSON.stringify({}),
      });
      showToast(`Cleared ${result?.cleared || 0} profile failure(s). Profiles are eligible again.`);
      try { await refresh({ force: true }); } catch {}
    } catch (err) {
      showToast(err.message || "Failed to clear profile failures");
    } finally {
      btn.disabled = false;
    }
  });
  const refreshBtn = $("refreshFailedProfilesBtn");
  refreshBtn?.addEventListener("click", async () => {
    refreshBtn.disabled = true;
    try { await refresh({ force: true }); }
    catch (err) { showToast(err.message || "Refresh failed"); }
    finally { refreshBtn.disabled = false; }
  });
}

function uxAttachCollapseControls() {
  $("collapseAllPanelsBtn")?.addEventListener("click", () => uxSetAllPanels(true));
  $("expandAllPanelsBtn")?.addEventListener("click", () => uxSetAllPanels(false));
}

function uxAttachScrapedProducts() {
  const list = $("scrapedProductsList");
  if (!list) return;
  let allItems = [];
  let filter = "all";
  async function load() {
    try {
      const [hv, wd] = await Promise.all([
        api("/api/content-sources/harvested").catch(() => ({ harvested: [] })),
        api("/api/products/discovered").catch(() => ({ discovered: [] })),
      ]);
      const rv = hv && hv.reserve;
      const wrap = $("reserveProgressWrap");
      if (wrap && rv && rv.target) {
        wrap.style.display = "";
        const pct = Math.max(0, Math.min(100, rv.pct || 0));
        const bar = $("reserveProgressBar"); if (bar) bar.style.width = pct + "%";
        const pe = $("reserveProgressPct"); if (pe) pe.textContent = pct + "%" + (rv.full ? " ✓ full" : "");
        const le = $("reserveProgressLabel"); if (le) le.textContent = "Reserve: " + rv.ready + " / " + rv.target + " ready" + (rv.full ? "" : " — harvesting…");
      } else if (wrap) { wrap.style.display = "none"; }
      const copied = ((hv && hv.harvested) || []).map((r) => ({
        source: "copied", productKey: r.productKey, title: r.text || "", url: r.firstCommentUrl || "",
        hasImage: r.hasImage, imageDeleted: r.imageDeleted, posted: r.posted, postUrl: r.postUrl || "",
        status: r.posted ? "posted" : "pending", harvestedAt: r.harvestedAt, sourceGroupUrl: r.sourceGroupUrl,
      }));
      const web = ((wd && wd.discovered) || []).map((r) => ({
        source: "web", productKey: r.productKey, title: r.title || "", url: r.url || "",
        imageUrl: r.imageUrl || "", status: r.used ? "used" : (r.status || "candidate"), store: r.store, lastSeenAt: r.lastSeenAt,
      }));
      allItems = [...copied, ...web];
      render();
    } catch (err) { list.innerHTML = '<div style="opacity:.6">Could not load saved products.</div>'; }
  }
  function render() {
    const items = allItems.filter((it) => filter === "all" || it.source === filter);
    const countEl = $("scrapedProductsCount");
    if (countEl) countEl.textContent = String(items.length);
    if (!items.length) { list.innerHTML = '<div style="opacity:.6">No saved products in this view.</div>'; return; }
    list.innerHTML = "";
    for (const it of items) {
      const card = document.createElement("div");
      card.className = "scrapedCard";
      const srcBadge = '<span class="sp-card-src ' + it.source + '">' + (it.source === "copied" ? "copied" : "web") + '</span>';
      const statusCls = (it.status === "posted" || it.status === "used") ? "posted" : "pending";
      const statusBadge = '<span class="sp-badge ' + statusCls + '">' + it.status + '</span>';
      card.innerHTML = '<button class="sp-del" type="button" title="Remove from dashboard" aria-label="Remove">&times;</button><div class="sp-text"></div><div class="sp-meta">' + srcBadge + statusBadge + '</div>';
      card.querySelector(".sp-text").textContent = (it.title || "(no text)").slice(0, 160);
      card.querySelector(".sp-del").addEventListener("click", (e) => { e.stopPropagation(); deleteItem(it); });
      card.addEventListener("click", () => openModal(it));
      list.appendChild(card);
    }
  }
  async function deleteItem(it) {
    const label = String(it.title || it.url || "this product").slice(0, 60);
    if (!confirm('Remove "' + label + '" from saved products?' + (it.source === "copied" ? "\n(deletes the saved record + its image)" : "\n(deletes the saved record)"))) return;
    try {
      await api("/api/content-sources/saved-product/delete", { method: "POST", body: JSON.stringify({ productKey: it.productKey, firstCommentUrl: it.url, source: it.source }) });
      close();
      await load();
    } catch (e) { alert("Could not remove: " + ((e && e.message) || e)); }
  }
  async function openModal(it) {
    const modal = $("scrapedModal"); if (!modal) return;
    const img = $("scrapedModalImg");
    img.removeAttribute("src"); img.style.display = "none";
    if (it.source === "copied" && it.hasImage && !it.imageDeleted) {
      try {
        const res = await fetch("/api/content-sources/harvested-image?key=" + encodeURIComponent(it.productKey), { headers: { "x-dashboard-token": DASHBOARD_TOKEN } });
        if (res.ok) { img.src = URL.createObjectURL(await res.blob()); img.style.display = ""; }
      } catch {}
    } else if (it.source === "web" && it.imageUrl) {
      img.src = it.imageUrl; img.style.display = "";
    }
    $("scrapedModalText").textContent = it.title || "(no text)";
    const link = $("scrapedModalLink");
    link.textContent = it.url || "(no link)";
    link.href = it.url || "#";
    const status = [it.source === "copied" ? "Source: copied from group" : ("Source: web scraping" + (it.store ? " (" + it.store + ")" : ""))];
    status.push("Status: " + it.status);
    if (it.imageDeleted) status.push("Image deleted after posting (text + link kept).");
    if (it.harvestedAt) status.push("Harvested: " + it.harvestedAt);
    if (it.sourceGroupUrl) status.push("From: " + it.sourceGroupUrl);
    if (it.lastSeenAt) status.push("Last seen: " + it.lastSeenAt);
    const st = $("scrapedModalStatus");
    st.textContent = status.join("  •  ");
    if (it.postUrl) { const a = document.createElement("a"); a.href = it.postUrl; a.target = "_blank"; a.rel = "noopener"; a.style.color = "#f0a93b"; a.style.display = "block"; a.style.marginTop = "6px"; a.textContent = "View live post ↗"; st.appendChild(a); }
    const delBtn = $("scrapedModalDelete"); if (delBtn) delBtn.onclick = () => deleteItem(it);
    modal.style.display = "flex";
  }
  function close() { const m = $("scrapedModal"); if (m) m.style.display = "none"; }
  for (const btn of document.querySelectorAll(".sp-filter")) {
    btn.addEventListener("click", () => {
      filter = btn.dataset.spfilter || "all";
      for (const b of document.querySelectorAll(".sp-filter")) b.classList.toggle("sp-active", b === btn);
      render();
    });
  }
  $("refreshScrapedBtn")?.addEventListener("click", () => load());
  $("scrapedModalClose")?.addEventListener("click", close);
  $("scrapedModal")?.addEventListener("click", (e) => { if (e.target === $("scrapedModal")) close(); });
  load();
}

function uxAttachDisconnectedProfiles() {
  const list = $("disconnectedProfilesList");
  if (!list) return;
  async function load() {
    try {
      const data = await api("/api/profiles/disconnected");
      const rows = (data && data.disconnected) || [];
      const c = $("disconnectedProfilesCount"); if (c) c.textContent = String(rows.length);
      if (!rows.length) { list.innerHTML = '<div style="opacity:.6">No disconnected profiles — all accounts logged in. ✓</div>'; return; }
      list.innerHTML = "";
      for (const r of rows) {
        const row = document.createElement("div"); row.className = "discRow";
        const info = document.createElement("div"); info.className = "di-info";
        info.innerHTML = '<span class="di-id">Profile ' + (r.profileId || "?") + '</span>' + (r.label ? ' <span class="di-meta">' + r.label + '</span>' : '') + '<div class="di-meta">' + (r.reason || "not logged in") + (r.at ? ' · ' + r.at : '') + '</div>';
        const btn = document.createElement("button"); btn.type = "button"; btn.textContent = "Release";
        btn.addEventListener("click", async () => { btn.disabled = true; try { await api("/api/profiles/release?profileId=" + encodeURIComponent(r.profileId), { method: "POST", body: "{}" }); await load(); } catch (e) { btn.disabled = false; if (typeof showToast === "function") showToast("Release failed"); } });
        const sus = document.createElement("button"); sus.type = "button"; sus.textContent = "→ Suspended"; sus.title = "This account is suspended/banned — move it to the Suspended list & keep it blocked"; sus.style.background = "#5b2f2f"; sus.style.borderColor = "#6b3a3a";
        sus.addEventListener("click", async () => { sus.disabled = true; try { await api("/api/profiles/suspend?profileId=" + encodeURIComponent(r.profileId), { method: "POST", body: "{}" }); await load(); if (typeof uxAttachSuspendedProfiles === "function") uxAttachSuspendedProfiles(); } catch (e) { sus.disabled = false; if (typeof showToast === "function") showToast("Failed"); } });
        const wrap = document.createElement("div"); wrap.style.display = "flex"; wrap.style.gap = "6px"; wrap.appendChild(sus); wrap.appendChild(btn);
        row.appendChild(info); row.appendChild(wrap); list.appendChild(row);
      }
    } catch (e) { list.innerHTML = '<div style="opacity:.6">Could not load disconnected profiles.</div>'; }
  }
  $("refreshDisconnectedBtn")?.addEventListener("click", () => load());
  load();
}

function uxAttachErroredProfiles() {
  const list = $("erroredProfilesList");
  if (!list) return;
  async function load() {
    try {
      const data = await api("/api/profiles/errored");
      const rows = (data && data.errored) || [];
      const c = $("erroredProfilesCount"); if (c) c.textContent = String(rows.length);
      if (!rows.length) { list.innerHTML = '<div style="opacity:.6">No profiles with account errors. ✓</div>'; return; }
      list.innerHTML = "";
      for (const r of rows) {
        const row = document.createElement("div"); row.className = "discRow";
        const info = document.createElement("div"); info.className = "di-info";
        info.innerHTML = '<span class="di-id">Profile ' + (r.profileId || "?") + '</span>' + (r.label ? ' <span class="di-meta">' + r.label + '</span>' : '') + '<div class="di-meta">' + (r.reason || "account error") + (r.at ? ' · ' + r.at : '') + '</div>';
        const btn = document.createElement("button"); btn.type = "button"; btn.textContent = "Release";
        btn.addEventListener("click", async () => { btn.disabled = true; try { await api("/api/profiles/release?profileId=" + encodeURIComponent(r.profileId), { method: "POST", body: "{}" }); await load(); } catch (e) { btn.disabled = false; if (typeof showToast === "function") showToast("Release failed"); } });
        const sus = document.createElement("button"); sus.type = "button"; sus.textContent = "→ Suspended"; sus.title = "This account is suspended/banned — move it to the Suspended list & keep it blocked"; sus.style.background = "#5b2f2f"; sus.style.borderColor = "#6b3a3a";
        sus.addEventListener("click", async () => { sus.disabled = true; try { await api("/api/profiles/suspend?profileId=" + encodeURIComponent(r.profileId), { method: "POST", body: "{}" }); await load(); if (typeof uxAttachSuspendedProfiles === "function") uxAttachSuspendedProfiles(); } catch (e) { sus.disabled = false; if (typeof showToast === "function") showToast("Failed"); } });
        const wrap = document.createElement("div"); wrap.style.display = "flex"; wrap.style.gap = "6px"; wrap.appendChild(sus); wrap.appendChild(btn);
        row.appendChild(info); row.appendChild(wrap); list.appendChild(row);
      }
    } catch (e) { list.innerHTML = '<div style="opacity:.6">Could not load account-error profiles.</div>'; }
  }
  $("refreshErroredBtn")?.addEventListener("click", () => load());
  load();
}

function uxAttachSuspendedProfiles() {
  const list = $("suspendedProfilesList");
  if (!list) return;
  async function load() {
    try {
      const data = await api("/api/profiles/suspended");
      const rows = (data && data.suspended) || [];
      const c = $("suspendedProfilesCount"); if (c) c.textContent = String(rows.length);
      if (!rows.length) { list.innerHTML = '<div style="opacity:.6">No suspended accounts. ✓</div>'; return; }
      list.innerHTML = "";
      for (const r of rows) {
        const row = document.createElement("div"); row.className = "discRow";
        const info = document.createElement("div"); info.className = "di-info";
        info.innerHTML = '<span class="di-id">Profile ' + (r.profileId || "?") + '</span>' + (r.label ? ' <span class="di-meta">' + r.label + '</span>' : '') + '<div class="di-meta">' + (r.reason || "suspended") + (r.at ? ' · ' + r.at : '') + '</div>';
        const btn = document.createElement("button"); btn.type = "button"; btn.textContent = "Release";
        btn.addEventListener("click", async () => { btn.disabled = true; try { await api("/api/profiles/release?profileId=" + encodeURIComponent(r.profileId), { method: "POST", body: "{}" }); await load(); } catch (e) { btn.disabled = false; if (typeof showToast === "function") showToast("Release failed"); } });
        row.appendChild(info); row.appendChild(btn); list.appendChild(row);
      }
    } catch (e) { list.innerHTML = '<div style="opacity:.6">Could not load suspended accounts.</div>'; }
  }
  $("refreshSuspendedBtn")?.addEventListener("click", () => load());
  load();
}

// COMMENT-LIMITED (post-only) profiles: blocked from commenting, still posting. Release re-enables commenting.
function uxAttachCommentLimitedPostOnlyProfiles() {
  const list = $("commentLimitedPostOnlyList");
  if (!list) return;
  async function load() {
    try {
      const data = await api("/api/profiles/comment-limited");
      const rows = (data && data.commentLimited) || [];
      const c = $("commentLimitedCount"); if (c) c.textContent = String(rows.length);
      if (!rows.length) { list.innerHTML = '<div style="opacity:.6">No comment-limited profiles — all can comment. ✓</div>'; return; }
      list.innerHTML = "";
      for (const r of rows) {
        const row = document.createElement("div"); row.className = "discRow";
        const info = document.createElement("div"); info.className = "di-info";
        info.innerHTML = '<span class="di-id">Profile ' + (r.profileId || "?") + '</span>' + (r.label ? ' <span class="di-meta">' + r.label + '</span>' : '') + '<div class="di-meta">' + (r.reason || "comment-limited (still posting)") + (r.at ? ' · ' + r.at : '') + '</div>';
        const btn = document.createElement("button"); btn.type = "button"; btn.textContent = "Release";
        btn.addEventListener("click", async () => { btn.disabled = true; try { await api("/api/profiles/release?profileId=" + encodeURIComponent(r.profileId), { method: "POST", body: "{}" }); await load(); } catch (e) { btn.disabled = false; if (typeof showToast === "function") showToast("Release failed"); } });
        row.appendChild(info); row.appendChild(btn); list.appendChild(row);
      }
    } catch (e) { list.innerHTML = '<div style="opacity:.6">Could not load comment-limited profiles.</div>'; }
  }
  $("refreshCommentLimitedBtn")?.addEventListener("click", () => load());
  load();
}

// ── INTERRUPTED-RUN BANNER (Prod tab) ──────────────────────────────────────
// Shown when the server recorded operator.lastIncompleteRun at boot (a restart cut a live
// run short). Continue = arm for the remaining posts; Relaunch = arm for the full count
// again; Dismiss = clear the banner and stay disarmed.
function renderIncompleteRunBanner(state) {
  const banner = $("incompleteRunBanner");
  if (!banner) return;
  const run = state?.operator?.lastIncompleteRun;
  const pending = run && run.status === "pending";
  banner.style.display = pending ? "" : "none";
  if (!pending) return;
  const max = Number(run.max) || 0;
  const posted = Number(run.posted) || 0;
  const remaining = Math.max(0, max - posted);
  const when = run.at ? new Date(run.at).toLocaleString() : "";
  const txt = $("incompleteRunText");
  if (txt) txt.textContent = max > 0
    ? `The server restarted during a run: ${posted} of ${max} posts were published — ${remaining} remaining. (detected ${when})`
    : `The server restarted during an unlimited run (${posted} posts published so far). (detected ${when})`;
  const cont = $("incompleteRunContinueBtn");
  if (cont) cont.textContent = max > 0 ? `▶ Continue (${Math.max(1, remaining)} left)` : "▶ Continue";
}

function uxAttachIncompleteRunBanner() {
  const wire = (id, action, label) => {
    const btn = $(id);
    if (!btn) return;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await api("/api/autopilot/resume", { method: "POST", body: JSON.stringify({ action }) });
        const data = await api("/api/state");
        renderState(data.state);
        if (typeof showToast === "function") showToast(label);
      } catch (e) {
        if (typeof showToast === "function") showToast("Action failed: " + (e?.payload?.error || e.message || e));
      } finally { btn.disabled = false; }
    });
  };
  wire("incompleteRunContinueBtn", "continue", "Continuing the interrupted run ▶");
  wire("incompleteRunRelaunchBtn", "relaunch", "Relaunching the full run 🔄");
  wire("incompleteRunDismissBtn", "dismiss", "Interrupted run dismissed");
}

(function bootUxOverhaul() {
  const run = () => {
    try { uxInitCollapsiblePanels(); } catch (err) { console.warn("uxInitCollapsiblePanels failed", err); }
    try { uxAttachCollapseControls(); } catch (err) { console.warn("uxAttachCollapseControls failed", err); }
    try { uxAttachClearFailedProfiles(); } catch (err) { console.warn("uxAttachClearFailedProfiles failed", err); }
    try { uxAttachConfirmGuards(); } catch (err) { console.warn("uxAttachConfirmGuards failed", err); }
    try { uxAttachScrapedProducts(); } catch (err) { console.warn("uxAttachScrapedProducts failed", err); }
    try { uxAttachDisconnectedProfiles(); } catch (err) { console.warn("uxAttachDisconnectedProfiles failed", err); }
    try { uxAttachErroredProfiles(); } catch (err) { console.warn("uxAttachErroredProfiles failed", err); }
    try { uxAttachSuspendedProfiles(); } catch (err) { console.warn("uxAttachSuspendedProfiles failed", err); }
    try { uxAttachCommentLimitedPostOnlyProfiles(); } catch (err) { console.warn("uxAttachCommentLimitedPostOnlyProfiles failed", err); }
    try { uxAttachIncompleteRunBanner(); } catch (err) { console.warn("uxAttachIncompleteRunBanner failed", err); }
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run);
  } else {
    queueMicrotask(run);
  }
})();

// ============ PROD TAB — production control center ============
(function () {
  let prodPollTimer = null;
  async function renderProdTab() {
    try {
      populateProdRunMode((workflowState && workflowState.operator) || {}); // snappy + survives a failed status fetch
      const [statusRes, health, activity] = await Promise.all([
        api("/api/autopilot/status").catch(() => null),
        api("/api/prod/health").catch(() => null),
        api("/api/prod/activity").catch(() => null),
      ]);
      const ap = (statusRes && statusRes.autopilot) || {};
      const last = statusRes && statusRes.lastDecision;
      let st = (workflowState && workflowState.operator) ? workflowState : null;
      if (!st) { const r = await api("/api/state").catch(() => null); st = r ? (r.state || r) : {}; }
      const op = (st && st.operator) || {};
      const ix = (st && st.ixbrowser) || {};
      populateProdRunMode(op);
      const enabled = ap.enabled != null ? ap.enabled : op.autopilotEnabled;
      const dryRun = op.autopilotDryRun !== false;
      const live = Boolean(enabled) && !dryRun;
      // RUN GUARD: once a run is active (armed OR autopilot on), HIDE Start and show only Stop so a second
      // click can't launch an overlapping run. Driven by real server state, so it's correct on reload + in
      // every open tab (each tab's poll re-renders this).
      const runActive = Boolean(op.armedForExternalActions) || Boolean(enabled);
      const startBtnEl = $("prodLaunchAllBtn");
      const stopBtnEl = $("prodStopAllBtn");
      if (startBtnEl) startBtnEl.style.display = runActive ? "none" : "";
      if (stopBtnEl) stopBtnEl.style.display = runActive ? "" : "none";
      const buf = ap.buffer || {};
      const cap = ap.capacity || {};
      const hl = $("prodHeadline");
      if (hl) {
        hl.textContent = live ? "● LIVE — autopilot is posting autonomously"
          : enabled ? "❚❚ ENABLED but DRY-RUN (not posting) — click Go Live"
          : "○ DISABLED — autopilot is off";
        hl.className = "prodHeadline " + (live ? "isLive" : enabled ? "isDry" : "isOff");
      }
      const cells = [
        ["Mode", live ? "LIVE" : (enabled ? "dry-run" : "off")],
        ["Phase", ap.phase || "-"],
        ["Concurrency", String(ix.maxConcurrentProfiles != null ? ix.maxConcurrentProfiles : "-")],
        ["Buffer ready", (buf.readyCount != null ? buf.readyCount : "?") + " / " + (buf.target != null ? buf.target : "?")],
        ["Posted today", String(cap.totalPostedToday != null ? cap.totalPostedToday : "-")],
        ["Capacity left", String(cap.totalRemaining != null ? cap.totalRemaining : "-")],
        ["Run target", op.scheduleEnabled ? ("⏰ " + (op.startTime || "--:--") + "–" + (op.stopTime || "--:--")) : (Number(op.autopilotMaxPostsPerRun) > 0 ? ((op.autopilotPostsThisRun || 0) + "/" + op.autopilotMaxPostsPerRun + " posts") : "unlimited")],
        ["Tick", (ap.tickSeconds != null ? ap.tickSeconds : "?") + "s"],
        ["CPU governor", (op.cpuGovernorMaxPercent != null ? op.cpuGovernorMaxPercent : 85) + "%"],
        ["Box CPU", health ? (health.cpuPercent + "%") : "?"],
        ["Pinterest agent", health ? (health.pinterestUp ? "● up (safe)" : "✗ DOWN") : "?"],
        ["No-photo marks", health ? String(health.noPhotoMarks) : "?"],
        ["Last action", last ? ((last.action || "-") + (last.workers ? (" (w=" + last.workers + ")") : "")) : "-"],
      ];
      const grid = $("prodStatusGrid");
      if (grid) {
        grid.innerHTML = cells.map(function (kv) {
          const danger = /DOWN/.test(String(kv[1]));
          return '<div class="prodStatCard' + (danger ? ' down' : '') + '">'
            + '<span class="prodStatLabel">' + kv[0] + '</span>'
            + '<span class="prodStatValue">' + kv[1] + '</span></div>';
        }).join("");
      }
      const sel = $("prodConcurrency");
      if (sel && ix.maxConcurrentProfiles) sel.value = String(ix.maxConcurrentProfiles);
      // Live pipeline: current cycle + activity feed (latest steps) + recent landed posts
      const cyc = $("prodCurrentCycle");
      if (cyc) {
        const d = (activity && activity.lastDecision) || last || null;
        if (d && d.action) {
          const tg = Array.isArray(d.targets) ? d.targets.map((t) => "p" + (t.profileId || t.profile || "?")).join(", ") : "";
          cyc.textContent = "Current cycle: " + d.action + (d.workers ? (" · " + d.workers + " worker(s)") : "") + (tg ? (" · " + tg) : "");
        } else { cyc.textContent = "Idle / waiting for next tick."; }
      }
      const feedEl = $("prodActivityFeed");
      if (feedEl) {
        const fd = (activity && Array.isArray(activity.feed)) ? activity.feed.slice().reverse() : [];
        feedEl.innerHTML = fd.length ? fd.map(function (e) {
          const t = String(e.at || "").slice(11, 19);
          const who = e.profileId ? (" · p" + e.profileId) : "";
          const w = (e.workers !== "" && e.workers != null) ? (" (w=" + e.workers + ")") : "";
          return '<div class="prodFeedRow"><span class="prodFeedTime">' + t + "</span> " + escapeHtml(e.label) + escapeHtml(who) + w + "</div>";
        }).join("") : '<span class="muted">No recent activity.</span>';
      }
      const postsEl = $("prodRecentPosts");
      if (postsEl) {
        const ps = (activity && Array.isArray(activity.recentPosts)) ? activity.recentPosts : [];
        postsEl.innerHTML = ps.length ? ps.map(function (p) {
          const t = String(p.at || "").slice(11, 19);
          return '<div class="prodFeedRow"><span class="prodFeedTime">' + t + "</span> p" + escapeHtml(String(p.profile || "?")) + ' <a href="' + escapeHtml(p.postUrl) + '" target="_blank" rel="noopener" class="prodLink">post ↗</a></div>';
        }).join("") : '<span class="muted">No posts recorded yet.</span>';
      }
      if (typeof renderProdRoleSelects === "function") renderProdRoleSelects();
    } catch (e) { /* transient */ }
  }
  async function prodPatchState(patch) {
    const r = await api("/api/state");
    const st = (r && (r.state || r)) || {};
    st.operator = st.operator || {};
    st.ixbrowser = st.ixbrowser || {};
    st.rules = st.rules || {};
    if (patch.operator) Object.assign(st.operator, patch.operator);
    if (patch.ixbrowser) Object.assign(st.ixbrowser, patch.ixbrowser);
    if (patch.rules) Object.assign(st.rules, patch.rules);
    await api("/api/state", { method: "PUT", body: JSON.stringify({ state: st }) });
  }
  // ── Prod run mode: "stop after N posts" (count) OR "run between start & end time" (time) ─────
  let prodRunModeTouched = false;
  function prodRunModeValue() { const r = document.querySelector('input[name="prodRunMode"]:checked'); return r ? r.value : "count"; }
  function prodApplyRunModeVisibility() {
    const mode = prodRunModeValue();
    document.querySelectorAll('#prodRunMode .prodModeFields').forEach(function (el) { el.hidden = (el.getAttribute("data-mode-fields") !== mode); });
  }
  function populateProdRunMode(op) {
    if (prodRunModeTouched) return; // don't overwrite what the operator is actively setting
    op = op || (workflowState && workflowState.operator) || {};
    const radio = document.querySelector('input[name="prodRunMode"][value="' + (op.scheduleEnabled ? "time" : "count") + '"]');
    if (radio) radio.checked = true;
    const setIf = function (id, val) { const el = $(id); if (el && document.activeElement !== el) el.value = (val == null ? "" : String(val)); };
    const mp = Number(op.autopilotMaxPostsPerRun);
    setIf("prodMaxPosts", mp > 0 ? mp : "");
    setIf("prodStartTime", op.startTime || "");
    setIf("prodStopTime", op.stopTime || "");
    setIf("prodScheduleTimezone", op.scheduleTimezone || "");
    prodApplyRunModeVisibility();
  }
  function prodResult(msg) { const el = $("prodActionResult"); if (el) el.textContent = msg; }
  function prodOn(id, fn) { const el = $(id); if (el) el.addEventListener("click", async function () { try { await fn(); } catch (e) { prodResult("Error: " + ((e && e.message) || e)); } }); }
  function bindProd() {
    if (!$("prodStatusGrid")) return;
    prodOn("prodGoLiveBtn", async function () { prodResult("Going live…"); prodSyncFormAndCache({ autopilotEnabled: true, autopilotDryRun: false }); await prodPatchState({ operator: { autopilotEnabled: true, autopilotDryRun: false } }); prodResult("● LIVE — autopilot posting."); renderProdTab(); });
    prodOn("prodPauseBtn", async function () { prodResult("Pausing…"); prodSyncFormAndCache({ autopilotDryRun: true }); await prodPatchState({ operator: { autopilotDryRun: true } }); prodResult("Paused (dry-run) — not posting."); renderProdTab(); });
    prodOn("prodEnableBtn", async function () { await prodPatchState({ operator: { autopilotEnabled: true } }); prodResult("Autopilot enabled."); renderProdTab(); });
    prodOn("prodDisableBtn", async function () { await prodPatchState({ operator: { autopilotEnabled: false } }); prodResult("Autopilot disabled."); renderProdTab(); });
    const sel = $("prodConcurrency");
    if (sel) sel.addEventListener("change", async function () { try { const n = Number(sel.value); await prodPatchState({ ixbrowser: { maxConcurrentProfiles: n } }); prodResult("Concurrency set to " + n + " (governor still throttles to headroom)."); renderProdTab(); } catch (e) { prodResult("Error: " + ((e && e.message) || e)); } });
    prodOn("prodDiscoverBtn", async function () { prodResult("Running discovery…"); const r = await api("/api/products/discover", { method: "POST", body: "{}", timeoutMs: 600000 }); prodResult("Discovery: +" + (r && r.newCandidates != null ? r.newCandidates : "?") + " new candidates."); renderProdTab(); });
    prodOn("prodFillBtn", function () { prodResult("Filling buffer (runs in background, ~minutes)…"); api("/api/products/fill-asset-buffer", { method: "POST", body: JSON.stringify({ max: 10 }), timeoutMs: 1500000 }).then(function (r) { prodResult("Fill done: prepared " + (r && r.prepared != null ? r.prepared : "?") + ", ready=" + (r && r.readyCount != null ? r.readyCount : "?")); renderProdTab(); }).catch(function (e) { prodResult("Fill running/continuing server-side: " + ((e && e.message) || e)); }); });
    prodOn("prodTickBtn", async function () { prodResult("Running one tick (may take minutes)…"); const r = await api("/api/autopilot/tick", { method: "POST", body: "{}", timeoutMs: 1500000 }); const d = (r && r.decision) || {}; prodResult("Tick: " + (d.action || "-") + (d.posted != null ? (" — posted " + d.posted) : "")); renderProdTab(); });
    prodOn("prodRefreshBtn", renderProdTab);
    // Keep the (hidden) operator control toggles + cached workflowState in lock-step with what we
    // write directly, so the main form's auto-save (collectState) can NEVER silently revert an
    // arm/disarm or the run-mode fields. opPatch keys present here win in both the DOM and the cache.
    function prodSyncFormAndCache(opPatch, rulesPatch) {
      opPatch = opPatch || {};
      const chk = function (id, v) { const el = $(id); if (el) el.checked = !!v; };
      const inp = function (id, v) { const el = $(id); if (el && v != null) el.value = String(v); };
      if ("autopilotEnabled" in opPatch) chk("autopilotEnabledRail", opPatch.autopilotEnabled);
      if ("armedForExternalActions" in opPatch) chk("armedForExternalActionsRail", opPatch.armedForExternalActions);
      if ("scheduleEnabled" in opPatch) chk("scheduleEnabled", opPatch.scheduleEnabled);
      if ("startTime" in opPatch) inp("startTime", opPatch.startTime);
      if ("stopTime" in opPatch) inp("stopTime", opPatch.stopTime);
      if ("scheduleTimezone" in opPatch) inp("scheduleTimezone", opPatch.scheduleTimezone);
      if (rulesPatch && "peakStartTime" in rulesPatch) inp("peakStartTime", rulesPatch.peakStartTime || "");
      if (rulesPatch && "peakStopTime" in rulesPatch) inp("peakStopTime", rulesPatch.peakStopTime || "");
      if (typeof workflowState === "object" && workflowState) {
        workflowState.operator = Object.assign({}, workflowState.operator || {}, opPatch);
        if (rulesPatch) workflowState.rules = Object.assign({}, workflowState.rules || {}, rulesPatch);
      }
    }
    document.querySelectorAll('input[name="prodRunMode"]').forEach(function (r) { r.addEventListener("change", function () { prodRunModeTouched = true; prodApplyRunModeVisibility(); if (workflowState && workflowState.operator) workflowState.operator.scheduleEnabled = (r.value === "time"); }); });
    const prodMaxEl = $("prodMaxPosts");
    if (prodMaxEl) prodMaxEl.addEventListener("input", function () { prodRunModeTouched = true; const n = parseInt(prodMaxEl.value, 10); if (workflowState && workflowState.operator && n > 0) workflowState.operator.autopilotMaxPostsPerRun = n; });
    ["prodStartTime", "prodStopTime", "prodScheduleTimezone"].forEach(function (id) { const el = $(id); if (el) el.addEventListener("input", function () { prodRunModeTouched = true; }); });
    prodOn("prodLaunchAllBtn", async function () {
      const mode = prodRunModeValue();
      const base = { autopilotEnabled: true, autopilotDryRun: false, armedForExternalActions: true };
      let patch, msg;
      if (mode === "time") {
        const startT = (($("prodStartTime") || {}).value || "").trim();
        const stopT = (($("prodStopTime") || {}).value || "").trim();
        const tz = ((($("prodScheduleTimezone") || {}).value || "").trim()) || "America/New_York";
        if (!startT || !stopT) { prodResult("⚠ Set both a start and end time first."); return; }
        patch = { operator: Object.assign({}, base, { scheduleEnabled: true, startTime: startT, stopTime: stopT, scheduleTimezone: tz, autopilotMaxPostsPerRun: 0 }), ixbrowser: { maxConcurrentProfiles: 999 } }; // 999 = "machine max" — the server clamps to the auto machine cap
        msg = "● LIVE — posting between " + startT + " and " + stopT + " (" + tz + "); no post-count limit.";
      } else {
        const n = Math.max(0, Math.min(500, parseInt((($("prodMaxPosts") || {}).value || ""), 10) || 0));
        if (!n) { prodResult("⚠ Enter how many posts (1–500) first."); return; }
        patch = { operator: Object.assign({}, base, { scheduleEnabled: false, autopilotMaxPostsPerRun: n, autopilotPostsThisRun: 0 }), rules: { peakStartTime: "", peakStopTime: "" }, ixbrowser: { maxConcurrentProfiles: 999 } }; // 999 = "machine max" — the server clamps to the auto machine cap
        msg = "● LIVE — will post " + n + " then auto-stop.";
      }
      prodResult("Launching…");
      // OPTIMISTIC: hide Start / show Stop the instant we commit, so a fast double-click can't start a 2nd run
      // before the re-render. renderProdTab (driven by real state) corrects this if the launch fails.
      const _sb = $("prodLaunchAllBtn"); if (_sb) _sb.style.display = "none";
      const _xb = $("prodStopAllBtn"); if (_xb) _xb.style.display = "";
      prodSyncFormAndCache(patch.operator, patch.rules); // sync BEFORE the await so a concurrent auto-save is already consistent
      await prodPatchState(patch);
      prodResult(msg);
      prodRunModeTouched = false;
      renderProdTab();
    });
    prodOn("prodStopAllBtn", async function () { prodResult("Stopping everything…"); prodSyncFormAndCache({ armedForExternalActions: false, autopilotEnabled: false }); try { await api("/api/operator/stop-all", { method: "POST", body: JSON.stringify({}) }); } catch (_) {} await prodPatchState({ operator: { armedForExternalActions: false, autopilotEnabled: false } }); prodResult("Stopped — disarmed, in-flight posting/harvest/comment work killed, profiles closing."); renderProdTab(); });
    prodOn("prodLoadProfilesBtn", async function () { prodResult("Loading IXBrowser profiles…"); await loadIxProfilesQuiet(); renderProdRoleSelects(); const s = $("prodRolesStatus"); if (s) { s.className = "inlineNotice ok"; s.textContent = "Profiles loaded — choose roles (saves automatically)."; } });
    ["prodModeratorProfileSelect", "prodSylProfileSelect", "prodExcludedProfileSelect"].forEach(function (id) { const el = $(id); if (el) el.addEventListener("change", function () { if (typeof saveProdRoles === "function") saveProdRoles(); }); });
    prodOn("prodSaveRolesBtn", async function () { await saveProdRoles(); });
    if (typeof renderProdRoleSelects === "function") renderProdRoleSelects();
  }
  function prodActive() { return document.body.dataset.activeView === "prod"; }
  function startProdPoll() { if (prodPollTimer) return; renderProdTab(); prodPollTimer = window.setInterval(function () { if (prodActive()) renderProdTab(); else { window.clearInterval(prodPollTimer); prodPollTimer = null; } }, 4000); }
  function initProd() {
    bindProd();
    document.querySelectorAll("[data-view-target]").forEach(function (b) { b.addEventListener("click", function () { window.setTimeout(function () { if (prodActive()) { prodRunModeTouched = false; startProdPoll(); } }, 60); }); });
    if (prodActive()) startProdPoll();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initProd); else initProd();
})();

// ── Credential reveal (show/hide) toggles for masked secret key fields ───────────────────────
// Secrets stay server-side only (data/secrets.local.json, gitignored, never sent to Hermes); the
// UI never receives saved values. This only lets you SEE the new key you are typing before saving.
(function credentialRevealToggles() {
  const setup = () => {
    const fields = document.querySelectorAll('[data-view~="credentials"] input[data-secret][type="password"]');
    fields.forEach((input) => {
      if (input.dataset.revealReady) return;
      input.dataset.revealReady = "1";
      const wrap = document.createElement("span");
      wrap.className = "revealWrap";
      input.parentNode.insertBefore(wrap, input);
      wrap.appendChild(input);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "revealBtn";
      btn.setAttribute("aria-label", "Show or hide this key");
      btn.setAttribute("tabindex", "-1");
      btn.textContent = "Show";
      btn.addEventListener("click", () => {
        const reveal = input.type === "password";
        input.type = reveal ? "text" : "password";
        btn.classList.toggle("on", reveal);
        btn.textContent = reveal ? "Hide" : "Show";
        input.focus();
      });
      wrap.appendChild(btn);
    });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setup); else setup();
})();

// ── Integrations: auto-load LIVE IXBrowser profiles + step-by-step wiring ─────────────────────
(function integrationSetup() {
  let autoTried = false;
  let liveSyncBusy = false;
  const setState = (id, text, cls) => { const el = document.getElementById(id); if (el) { el.textContent = text; el.className = "setupState " + (cls || ""); } };
  // LIVE SYNC: profiles auto-load on tab open AND refresh every 5 minutes (operator setting) —
  // adding/removing profiles in ixBrowser shows up here without clicking "Load Profiles"
  // (server caches the ix call 45s, so polling can never hammer ixBrowser).
  async function autoLoadProfiles() {
    if (liveSyncBusy || typeof loadIxProfilesQuiet !== "function") return;
    const builder = document.getElementById("groupAssignmentBuilder");
    if (builder && builder.contains(document.activeElement)) return; // never clobber an edit in progress
    liveSyncBusy = true;
    const fingerprint = () => JSON.stringify((integrationProfiles || []).map((p) => String(p.profile_id || p.id) + "|" + (p.name || p.title || "")));
    const hadProfiles = Array.isArray(integrationProfiles) && integrationProfiles.length > 0;
    if (!hadProfiles) setState("setupState2", "loading from IXBrowser…", "warn");
    try {
      const before = fingerprint();
      await loadIxProfilesQuiet();
      setState("setupState2", (integrationProfiles.length || 0) + " profiles loaded", "ok");
      if (before !== fingerprint()) {
        if (typeof renderProdRoleSelects === "function") renderProdRoleSelects();
        const s = document.getElementById("prodRolesStatus");
        if (s) { s.className = "inlineNotice ok"; s.textContent = "Profiles live-synced from IXBrowser ✓ " + new Date().toLocaleTimeString(); }
      }
    } catch (e) {
      if (!hadProfiles) setState("setupState2", "IXBrowser not reachable — will keep retrying", "bad");
    } finally { liveSyncBusy = false; }
  }
  const onView = () => {
    const v = document.body.dataset.activeView;
    if (v === "integrations" || v === "prod") autoLoadProfiles();
  };
  document.querySelectorAll("[data-view-target]").forEach((b) => b.addEventListener("click", () => setTimeout(onView, 90)));
  window.setInterval(() => {
    if (document.visibilityState !== "visible") return;
    onView();
  }, 300000); // 5 minutes (operator: sync each 5 min, not each 1 min)
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener("click", fn); };
  on("setupStepTestIx", async () => { setState("setupState1", "checking…", "warn"); try { await testIxBrowser(); setState("setupState1", "connected", "ok"); } catch (e) { setState("setupState1", "not reachable", "bad"); } });
  on("setupStepLoadProfiles", async () => { setState("setupState2", "loading…", "warn"); try { await loadIxProfilesQuiet(); autoTried = true; setState("setupState2", (integrationProfiles.length || 0) + " profiles loaded", "ok"); } catch (e) { setState("setupState2", "not reachable", "bad"); } });
  on("setupStepRoles", () => { const p = document.querySelector(".prodRoles"); if (p) { p.scrollIntoView({ behavior: "smooth", block: "center" }); p.classList.add("flash"); setTimeout(() => p.classList.remove("flash"), 1200); } });
  on("setupStepWebshare", async () => { setState("setupState4", "testing…", "warn"); try { await testWebshare(); setState("setupState4", "Webshare OK", "ok"); } catch (e) { setState("setupState4", "check key", "bad"); } });
  on("setupStepLoadProxies", async () => { try { await loadWebshareProxies(); setState("setupState4", "proxies loaded", "ok"); } catch (e) { setState("setupState4", "check Webshare", "bad"); } });
  const boot = () => setTimeout(onView, 500);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();

