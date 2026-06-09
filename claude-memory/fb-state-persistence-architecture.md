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

Also: groupAssignmentData regenerates from **`posting.groups`** (source-of-truth textarea) — to enforce "only 1 group" you must fix posting.groups, not just groupAssignmentData (the dashboard auto-fabricates assignments from it). The Prod "Launch" count-mode button clears rules.peakStartTime/StopTime BY DESIGN. Restarts truncate server-stdout/stderr logs.

**Interrupted-run banner (built+verified 2026-06-09)**: `detectIncompleteRunAtBoot()` (called in server.listen before the scheduler) records `operator.lastIncompleteRun {at,posted,max,reason,status:"pending"}` and disarms (controlWrite) when a run was active at restart or counter mid-run; skips re-creating a resolved record with same counters. `POST /api/autopilot/resume {action: continue|relaunch|dismiss}` — continue arms for max-posted remaining, relaunch full max, dismiss just clears; 404 when none pending. UI: `#incompleteRunBanner` section atop Prod tab (index.html), `renderIncompleteRunBanner` in renderState + `uxAttachIncompleteRunBanner` in bootUxOverhaul (app.js). Note: a fresh arm via PUT /api/state resets autopilotPostsThisRun to 0 — set the counter in a SECOND PUT when simulating mid-run state. See [[fb-ixbrowser-sync-recovery]], [[fb-dashboard-server-stability]].
