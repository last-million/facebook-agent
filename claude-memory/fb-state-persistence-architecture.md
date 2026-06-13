---
name: fb-state-persistence-architecture
description: "FB agent state-persistence root causes (selections wiped), the 2026-06-09 fixes, and the Prod-tab interrupted-run banner feature"
metadata: 
  node_type: memory
  type: project
  originSessionId: 80639e48-5193-4896-84b0-c65946091867
---

State = `data/workflow-state.json` via readState/writeState (server.js). The user's "dashboard loses selections after restart" had THREE proven root causes (multi-agent audit + git history of the auto-synced state file):

1. **writeState merged over `defaultState()`, not existing disk state** — any partial body (dashboard 850ms auto-save omits uncollected fields; sparse PUTs; stale snapshots) reset every unprotected field to factory defaults. A one-write wipe on 2026-06-08T15:03Z blanked SYL profile, posting.groups, contentSources, moderators. **FIXED**: `clean = deepMerge(deepMerge(defaultState(), existing), state)` — omitted keys keep on-disk values; explicit keys (incl "" / []) still win. Regression-tested: a tiny partial PUT now changes nothing else.
2. **readState returned pure defaults on transient read failure** (EBUSY race with the half-hourly git auto-sync) → next read-modify-write persisted defaults. **FIXED**: module-level `__lastGoodStateRaw` fail-safe cache; defaults only if never readable this process.
3. **Prod role checklists (moderators/SYL/excluded) render a placeholder until the live ixBrowser profile list loads** — after restart they LOOK empty (perception of loss), and Save Roles while unloaded really erased the saved lists. **FIXED**: saveProdRoles clobber guard (refuses to save until inputs render, toast).

**Dashboard stuck on "Saving…" = state outgrew the request-body cap (root-caused 2026-06-13).** The dashboard
PUTs the ENTIRE `workflow-state.json` on every save (prodPatchState GET-merge-PUT + main-form auto-save). `readBody`
(server.js ~17425) rejected bodies over a hard `2_000_000` byte cap with 413 "Request body too large." — and the live
state had grown to **1.94 MB** (posting ~1.05MB [99 groups] + ixbrowser ~690KB [profile list] = legit data, not a leak).
So EVERY save 413'd and the UI hung on "Saving…" forever (never reached "Auto-saved"); the events.log shows repeated
`request_failed Error: Request body too large.`. **FIXED**: raised the cap to `64_000_000` (localhost, token-gated,
single-operator → big cap is fine). Needs a server restart. FOLLOW-UP (not done): the whole-state PUT is wasteful at
this size — a field-level PATCH endpoint (operator-only patch) would make saves tiny/fast and avoid re-hitting any cap.
To check state size + biggest keys: `node -e "const s=require('./data/workflow-state.json');const sz=o=>Buffer.byteLength(JSON.stringify(o));for(const k of Object.keys(s))console.log(Math.round(sz(s[k])/1024),'KB',k)"`.

**Prod-tab run-mode settings now auto-save on change (fixed 2026-06-13).** "Stop after N posts" (prodMaxPosts), the
prodRunMode radio, and prodStartTime/StopTime/Timezone are SEPARATE from the main form (own ids) so collectState never
captured them — they only reached the server when the operator clicked Start (doProdStart). Switching mode / typing N
and NOT starting was lost on reload/restart. FIX (app.js, in bindProd): `prodPersistRunModeSoon()` debounced ~700ms,
wired to the radio change + the input listeners, POSTs `{operator:{scheduleEnabled, autopilotMaxPostsPerRun|startTime/
stopTime/scheduleTimezone}}` via prodPatchState (settings only — never arms, never resets autopilotPostsThisRun).
Frontend-only → applies on dashboard hard-refresh. (A full audit workflow found NO other controls of this class — the
main-form auto-save covers the rest.)

Also: groupAssignmentData regenerates from **`posting.groups`** (source-of-truth textarea) — to enforce "only 1 group" you must fix posting.groups, not just groupAssignmentData (the dashboard auto-fabricates assignments from it). The Prod "Launch" count-mode button clears rules.peakStartTime/StopTime BY DESIGN. Restarts truncate server-stdout/stderr logs.

**Step-3 equal-split toggle + profile live-sync (built+verified 2026-06-09, Playwright-screenshot proven)**: `posting.equalSplitAssignments` (normalize ~1459, default ~435). UI: `.pillSwitch` toggle in Step-3 (index.html, CSS at app.css tail). When ON: `applyEqualUniqueSplit()` partitions via `assignProfilesByPercent` (slices — never duplicates a profile across groups), sliders/chips disabled (`.equalSplitOn` class + handler early-returns), manual check in one group unchecks the profile elsewhere. KEY CONTRACT: `assignProfilesByPercent` partitions (no overlap) but the per-card slider path `applyShareSliderToCard` CAN overlap — that's why the toggle exists. Profile LIVE-SYNC: integrationSetup IIFE in app.js — auto-load on prod/integrations tab open + 60s visible-tab poll calling `loadIxProfilesQuiet()` (server caches ix call 45s w/ in-flight collapse, so polling is cheap); focus-guards skip renders mid-edit. Playwright-core works headless via Edge executablePath (no bundled browser; script must live inside the project for module resolution).

**Interrupted-run banner (built+verified 2026-06-09)**: `detectIncompleteRunAtBoot()` (called in server.listen before the scheduler) records `operator.lastIncompleteRun {at,posted,max,reason,status:"pending"}` and disarms (controlWrite) when a run was active at restart or counter mid-run; skips re-creating a resolved record with same counters. `POST /api/autopilot/resume {action: continue|relaunch|dismiss}` — continue arms for max-posted remaining, relaunch full max, dismiss just clears; 404 when none pending. UI: `#incompleteRunBanner` section atop Prod tab (index.html), `renderIncompleteRunBanner` in renderState + `uxAttachIncompleteRunBanner` in bootUxOverhaul (app.js). Note: a fresh arm via PUT /api/state resets autopilotPostsThisRun to 0 — set the counter in a SECOND PUT when simulating mid-run state. See [[fb-ixbrowser-sync-recovery]], [[fb-dashboard-server-stability]].
