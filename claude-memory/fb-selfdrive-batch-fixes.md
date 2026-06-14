---
name: fb-selfdrive-batch-fixes
description: "FB agent 2026-06-13 shipped fixes — count-run self-drive, durable forced-switch click, image-integrity, boot orphan cleanup — and the red-team list of fixes to NEVER implement"
metadata:
  node_type: memory
  type: project
  originSessionId: 80639e48-5193-4896-84b0-c65946091867
---

Shipped + pushed 2026-06-13 (commits da687fd, 3c73fd8) to github.com/last-million/facebook-agent. **Git is bundled at
`C:\Users\Administrator\Desktop\facbeook agent\.tooling\mingit\cmd\git.exe`** (NOT on PATH); remote `origin/main`,
credential.helper=manager. Push with `$env:GIT_TERMINAL_PROMPT='0';$env:GCM_INTERACTIVE='Never'` so it can't hang.
PowerShell mislabels git's normal "To <url>" stdout as a RemoteException — the `a..b main -> main` line = success.
All four below were adversarially verified SAFE-TO-SHIP (3 reviewers each) before ship; the saved dashboard setup was
fingerprinted (99 groups / 23+23 profiles / equalSplit) and confirmed byte-intact across the restart.

1. **COUNT-RUN SELF-DRIVE** — a "stop after N posts" (count) run PAUSED after batch 1 and needed ~9 manual
   `/api/autopilot/tick` kicks (TIME/scheduled runs were unaffected). TWO gaps fixed in server.js: (#1a) the
   scheduler `finally` (~9242-9252) only fast-retried (~25s vs ~120s) on `waitingOnAssets`, NOT on `published` —
   now also when `__justPublished && __countLimit>0 && !__countDone`; uses `op.autopilotPostsThisRun` (a bare
   `postsThisRun` there ReferenceErrors and strands the scheduler timer). GATED `__countLimit>0` so time/unlimited
   runs keep the proven ~120s cadence. (#1b) ARM (PUT /api/state `if(!wasEnabled&&nowEnabled)`) only flipped flags;
   added outer `let __armTransition` used AFTER `writeState` to `setTimeout(()=>autopilotTickAsync(),0)` (single-
   flight) so batch 1 fires instantly. PROVEN: first batch self-launched ~33s after arm, 0 kicks. NOTE: this removes
   the dead PAUSES but the o-group total pace is still gated by FB's ~15-20min approval queue (not fixable our side).

2. **forced_account_switch DURABLE CLICK** (connector tools/fb-post-test-capture-url.js ~2906) — language-independent:
   text-match (continue, all langs) → click the card's PRIMARY non-negative button (skip icon-only / Not-now/Cancel)
   regardless of wording → press Enter (default action) → verify URL left forced_account_switch. Can't be defeated by
   a new language or FB re-wording the button. Connector = no restart.

3. **IMAGE INTEGRITY** (server.js `imageFileLooksValid`, cached by path|size|mtime) — readiness gates
   (productHasReadyAssets + the `onDisk` arrow) now require a real image (size>=512 + JPEG/PNG/GIF/WEBP/BMP magic
   bytes), not just fs.existsSync, so a truncated/blank/corrupt harvested image is not-ready instead of posted.

4. **BOOT ORPHAN CLEANUP** (server.js `cleanOrphanIxBrowserChromeAtBoot`, called 4s after boot gated on NOT-armed) —
   kills ONLY chrome.exe whose cmdline matches `ixBrowser`. SAFE: the agent itself only ever launches msedge (Edge),
   so msedge/Pinterest(:59812)/operator-chrome can never match; runs only at idle boot so no live post exists.
   PROVEN live: `boot_orphan_ixbrowser_chrome_cleanup ok=True`, chrome→0.

**DO NOT IMPLEMENT (red-teamed — dangerous or chasing bugs that DON'T EXIST in the code):**
- state-bloat field-trim → would re-trigger "selections lost after restart". Real bloat = `facebookProfileStatus`
  (~1.06MB) + `ixbrowser.failedProfiles` (~707KB) append-only logs (protected-merge fields), NOT counters. The
  2MB→64MB request-body cap already absorbs it (the 1.94MB state was >2MB → every save 413'd → dashboard stuck on
  "Saving…"; cap raised in readBody).
- approval-throughput "raise the <=5/session cap" → NO such cap exists (only MAX_ADMIN_APPROVAL_ATTEMPTS=6 per single
  post). Approving faster is exactly what FB walls (forced_account_switch/temp blocks) → MORE blocked mods, less net.
- emoji/§§§ outbound gate → "§§§" exists only in a memory note; outbound path is already UTF-8-clean + guarded by
  shouldAvoidKeyboardType. Non-problem.
- `awaiting_approval`/stale-pending rescue → built on a ledger row + resweep branch that don't exist; resweep is
  published-only + runId-cutoff-scoped. Complex + touches live FB.
- orphan-reaping DURING a run → no reliable PID→ixBrowser-profile mapping; could kill a live publish. The boot-idle
  version (#4 above) is the only safe form.

Also live this session: per-group COMMENT attribution made vanity↔numeric alias-aware (`groupsMatchByAlias`) + a
universal choke-point guard in `runFacebookCommentRecoveryAttempt` (was leaking a 4854 profile's comment onto an
o-group post). See [[fb-least-used-profile-fairness]], [[fb-state-persistence-architecture]], [[fb-admin-approval-page-identity]].
