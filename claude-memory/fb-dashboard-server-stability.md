---
name: fb-dashboard-server-stability
description: "FB dashboard (port 9317) wedge root-cause, self-healing health-check watchdog, and manual recovery procedure"
metadata: 
  node_type: memory
  type: project
  originSessionId: 80639e48-5193-4896-84b0-c65946091867
---

The single-threaded Node dashboard server (`Desktop\facbeook agent\server.js`, port 9317) can wedge — *listening but unresponsive* → browser shows ERR_CONNECTION_REFUSED or hangs. Root cause (measured 2026-06-04): multi-tab dashboard polling saturates the event loop. The dashboard `refresh()` polls every 3s hitting `/api/state` (~36ms, returns the full 1.14 MB state) + `/api/approvals` (~120ms, `buildApprovalItems`), and the IXBrowser profile-list auto-load was ~650ms/call **uncached** — several open tabs × that = saturation.

**FIX shipped (commit 6ad6678):**
1. `server.js` `__ixProfilesCache` — 45s TTL + in-flight collapse on `POST /api/integrations/ixbrowser/profiles` (650ms cold → ~3ms cached).
2. `data\fb-server-watchdog.ps1` now **health-checks** instead of port-only: probes `GET /` (6s timeout); two consecutive fails 4s apart ⇒ kills the port-9317 owner **only** (never the Pinterest 59812 owner) and restarts. Task `FB-Server-Watchdog` interval tightened 3min→1min. Verified: no-op against a healthy server.

**Manual recovery if it ever wedges again:** kill every `node` process EXCEPT the Pinterest pid (port 59812 owner), confirm 9317 is free, then `Start-ScheduledTask FB-Server-Watchdog`. Give it ~15s, then ping `GET http://127.0.0.1:9317/` expecting HTTP 200.

Healthy baselines: idle CPU ≈ 0.7 CPU-sec / 14s (~5%, the 1s heartbeat parsing 1.14 MB state — normal, not a spin). A *real* spin = CPU climbing many sec/sec with the server not logging and not answering HTTP. NEVER touch Pinterest (port 59812). See [[fb-agent-highscale-pipeline]].
