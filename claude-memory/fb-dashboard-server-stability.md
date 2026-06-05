---
name: fb-dashboard-server-stability
description: "FB dashboard (port 9317) wedge root-cause, self-healing health-check watchdog, and manual recovery procedure"
metadata: 
  node_type: memory
  type: project
  originSessionId: 80639e48-5193-4896-84b0-c65946091867
---

The single-threaded Node dashboard server (`Desktop\facbeook agent\server.js`, port 9317) can wedge — *listening but unresponsive* → browser shows ERR_CONNECTION_REFUSED or hangs.

**TRUE root cause (measured + CPU-profiled 2026-06-04 night):** `/api/autopilot/status` + `/api/products/asset-buffer-status` became pathologically slow (~12s and ~6.8s PER CALL). `autopilotStatus`/`assetBufferStatus` fan out into `isProfileBlockedForPosting`/`isFacebookProfileQuarantinedForFacebook` which re-parse the whole `posting.facebookProfileStatus` + `ixbrowser.failedProfiles` logs **per-profile × per-product**, calling the pure `sanitizeFacebookGroupUrlList` on the SAME lines thousands of times. As those logs grew (500+ lines) the cost exploded. An **open Edge dashboard tab** (msedge, not node) polling those two endpoints then pinned the event loop → every fresh boot spun to ~2.5 cores and never served. (Diagnosed with `node --prof`: 90% in V8 regex engine; client found via `Get-NetTCPConnection -RemotePort 9317`.)

**FIXES shipped (commits 6ad6678, a0c5792, b3b5213):**
1. **Memoize `sanitizeFacebookGroupUrlList`** (pure fn, module-level Map) → autopilot/asset status ~12s → **~1.4s (9×)**. This was the real cure.
2. **Cache** `/api/autopilot/status` + `/api/products/asset-buffer-status` (`STATUS_CACHE_TTL_MS=300s`) so polling can't re-trigger the heavy compute.
3. **Dedup the status logs** (`data/_trimstate.js`): collapse `facebookProfileStatus`/`failedProfiles` to the latest line per (profile_id, group_url) — behavior-preserving (functions only use the latest). Backup at `data/workflow-state.prelaunch.bak.json`.
4. `__ixProfilesCache` (45s TTL + in-flight collapse) on `POST /api/integrations/ixbrowser/profiles` (650ms→3ms).
5. `data\fb-server-watchdog.ps1` now **health-checks** (`GET /`, 6s timeout, 2 fails 4s apart ⇒ kill the 9317-owner only, never Pinterest 59812, + restart); task interval 1min. NOTE: it correctly kills a genuinely-wedged server, so it will kill-LOOP if the server can't stay up — disable it (`Disable-ScheduledTask FB-Server-Watchdog`) while debugging a boot spin, re-enable after.

**Manual recovery if it ever wedges again:** kill every `node` process EXCEPT the Pinterest pid (port 59812 owner), confirm 9317 is free, then `Start-ScheduledTask FB-Server-Watchdog`. Give it ~15s, then ping `GET http://127.0.0.1:9317/` expecting HTTP 200.

Healthy baselines: idle CPU ≈ 0.7 CPU-sec / 14s (~5%, the 1s heartbeat parsing 1.14 MB state — normal, not a spin). A *real* spin = CPU climbing many sec/sec with the server not logging and not answering HTTP. NEVER touch Pinterest (port 59812). See [[fb-agent-highscale-pipeline]].
