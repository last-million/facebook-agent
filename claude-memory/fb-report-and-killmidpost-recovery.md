---
name: fb-report-and-killmidpost-recovery
description: "FB agent auto run-report page (Prod tab, no AI) + the watchdog CPU-fix and kill-mid-post silent-loss recovery shipped 2026-06-15"
metadata: 
  node_type: memory
  type: project
  originSessionId: 80639e48-5193-4896-84b0-c65946091867
---

2026-06-15 wave on the FB agent (`C:\Users\Administrator\Desktop\facbeook agent`, port 9317). Built under brutal multi-agent verification (the verdicts repeatedly caught my own fixes being wrong — trust the verifier).

**AUTO RUN-REPORT (operator wants the last run + all runs ALWAYS in the Prod tab, from logs, NO AI):**
- `GET /api/reports/runs` → `buildRunReports()` in server.js: pure log parser (ledger `facebook-live-posts.jsonl` + governor events + `server-watchdog.log`), 60s cache, clusters posts into runs by >2h gap, per-group/comment/timing/chrome-peak/restart stats + a `reconcile` block.
- `web/report.html`: self-contained responsive page; served at `/report` via `serveReport()` which injects `__DASHBOARD_TOKEN__` (same trick as serveIndex) so its fetch to the token-gated API is authorized. Prod tab embeds it as an iframe + fullscreen link.
- GOTCHA: governor events store the name under `message`, NOT `event` (logEvent writes `{at,message,...fields}`); chrome count is field `chrome`. Merge the durable `data/audit/audit-YYYY-MM-DD.log` (events.log is a rolling 600-line buffer).

**WATCHDOG CPU-FIX (my earlier "alive-but-busy guard" was a NO-OP — events.log is written by SYNCHRONOUS fs.appendFileSync ON the event loop, so a CPU-wedged loop ALSO stops writing it; it fired 0/227 times while 4 real kills landed in a day):**
- `data/fb-server-watchdog.ps1` now decides busy-vs-frozen by OS-measured CPU (`Get-SystemCpuPercent` = Get-Counter '\Processor(_Total)\% Processor Time', 3-sample MAX so noise can't flip busy→frozen→kill; WMI fallback; 0 on double-fail→treated frozen). Unresponsive + CPU>=85% = BUSY→tolerate up to MAX_BUSY_TOLERATE=6 ticks (busy-count file); CPU<85% = FROZEN→restart. Known residual: a single-core/single-threaded main-loop wedge = ~11% total on the 9-core box → classed frozen → killed (a 3-min single-thread block IS a real freeze, so acceptable). Task `FB-Server-Watchdog` MultipleInstancesPolicy = IgnoreNew (verified — no count-file race).

**PREVENT SATURATION:** `runLiveFacebookPostScript` (the SOLE connector funnel for post/comment/approval/recovery) now gates on `waitForCpuHeadroom` (skippable via opts.skipCpuGate, never set yet) — no-op when healthy, brakes only when CPU/RAM pegged. CORES_PER_PROFILE=1.5 → machineParallelCap=3 (sticky; normalizeWorkflowState re-clamps maxConcurrentProfiles every write).

**FOLDED-COMMENT FALLBACK DISABLED** (`ENABLE_FOLDED_COMMENT_FALLBACK=false`, connector): it was 0/38 in prod (clicked a hashtag/related-post link → wrong post, safe but 0 comments + burned a profile-open each time). The proven `composerFocused` fast path handles folded posts. Pending-detection regex made multilingual (EN/FR/ES/PT/DE+Arabic).

**KILL-MID-POST SILENT-LOSS FIX (#1 hole: a watchdog kill between FB-publish and the in-process `published` record silently lost the post — uncounted/uncommented/unledgered, product claimed forever):**
- runWorker writes durable `publish_intent` BEFORE the post + `publish_intent_resolved` in a `finally` (only a hard kill skips it; intentId=random hex `key`, `message`=`<runId>|<claimHash>`).
- `reconcilePendingPublishIntentsAsync` (tick-hooked, armed-gated, single-flight, 5-min throttle, max 3/pass): for an unresolved intent, marker-scan via the EXISTING `recoverSubmittedFacebookPostUrl` (findOnly) → found = record `published` (resweep comments it, no loss); not-found = release the `post-claims/<runId>/<claimHash>.claim` to retry (no duplicate); row/group missing = `needs_manual_review` (NO blind release → no duplicate). NO connector change.
- Report surfaces `reconcile {pending,recovered,released,needsReview}` + banner.

OPERATOR DECISION (2026-06-15): chose "build the safety fix first, I will launch prod myself" — do NOT launch prod. See [[fb-no-live-post-without-ok]]. Brutal verdict on the FIRST wedge-fix round was NO-GO unattended-100; this fix closes the last data-loss hole. Box is SHARED with Pinterest (port 59812) — never touch it. Related: [[fb-admin-approval-page-identity]], [[fb-dashboard-server-stability]], [[fb-selfdrive-batch-fixes]].
