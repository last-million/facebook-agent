---
name: fb-ixbrowser-sync-recovery
description: Recovery playbook when the FB agent run produces 0 posts / false-blacklists profiles after an ixBrowser profile reshuffle
metadata: 
  node_type: memory
  type: project
  originSessionId: 80639e48-5193-4896-84b0-c65946091867
---

When a prod run posts 0 and auto-blacklists profiles in sequence, the cause is usually NOT Facebook/account suspension. On 2026-06-09 a 200-run produced 0 posts with `IXBrowser profile-open error 1004: Profile Open Failed` and false-blacklisted p75/p72. Real root causes (in order of impact):

1. **Stale 2nd posting group.** `groupAssignmentData` had TWO groups — the user's `o1498765421290862` (=id 1098414320641851) AND a stale `4854972804605257`. Profiles assigned to the stale group hit `cannot_post_in_group`. Fix: consolidate `groupAssignmentData` to ONE entry for the user's group with all unique profiles merged (preserve `requiresAdminApproval`, set `sharePercent:100`). The autopilot builds slots fresh from `groupAssignmentData` each tick, so no plan re-prep needed.
2. **ixBrowser wedge** = orphaned chrome.exe sessions ixBrowser lost track of → 1004 on new opens. Fix: `POST /api/profiles/close-all`, then kill leftover `chrome.exe` (Pinterest is `msedge.exe` — never touch). Verify with a small armed test.
3. **Bloated over-bench blacklist.** `state.ixbrowser.failedProfiles` is append-only and grew to 735+ lines, but `currentlyBlockedProfilesSummary` (GET `/api/profiles/blocked`) is the ONLY authoritative blocked list — a raw line-scan double-counts stale entries. Fix: `POST /api/ixbrowser/clear-failed-profiles` (safe: un-benches automation failures, PRESERVES genuine FB suspensions) + `POST /api/ixbrowser/reconcile-profiles {force:true}` (run twice for the 2-miss removal debounce).

Ground-truth diagnostic: compare `POST /api/integrations/ixbrowser/test` (fresh total) + `/api/integrations/ixbrowser/profiles` (live ids) vs roster ids from `groupAssignmentData`. Removals ALREADY auto-sync via the per-tick reconcile (line ~8388); only profile 2 was stale, [40,41,42,43] are reserved.

PENDING durable feature (spec'd, NOT yet deployed — staged for a deliberate verified restart, not mid-unattended-run): (a) reconcile PASS-3 to auto-ADD live non-reserved profiles to the single configured group; (b) in `autoBlacklistProfileIfNeeded` (~14781), do NOT count a pure ixBrowser profile-OPEN failure (1004 / `profileRetryable`, not a FB block) toward the blacklist streak — infra ≠ account health; (c) compact `failedProfiles` on unblock/GONE to stop bloat. Backup before deploy: `server.js.bak_20260609_ixsync`. See [[fb-agent-highscale-pipeline]].
