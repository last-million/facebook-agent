---
name: fb-harvest-coupled-fresh
description: "FB harvest REVERSED from 24/7 deep-backlog to run-coupled + 2-day-fresh (2026-06-17): only harvests while a run posts, hourly, age-capped at 2 days, 2-day retention"
metadata:
  type: project
  node_type: memory
  originSessionId: 80639e48-5193-4896-84b0-c65946091867
---

**2026-06-17 — REVERSED the 24/7 continuous deep-backlog harvest.** Operator: "disable harvesting all day —
harvest at the SAME TIME as prod; check new products each hour; if none, go older but NO older than 1-2 days
(not 15); products saved removed after 2 days; for BOTH run modes (stop-after-N AND start/end schedule)."
Do NOT reintroduce the old all-day / deep-backlog harvest — this supersedes that design. Shipped + reviewed +
deployed (server PID restarted clean) + pushed (commits on top of d856f09, review-fix commit `8e12157`).

**R1 — run-coupled gate.** New `harvestShouldRunNow(state)` (server.js ~18919) = `contentSourcesEnabled===true
&& armedForExternalActions===true && autopilotPostingWindowOpen(state)`. Gates ALL three harvest triggers:
heartbeat driver (~19027), armed-tick driver (~9114), AND the manual `/api/content-sources/harvest-now`
endpoint (~20204, returns 409 `harvest_only_during_active_run` off-window). Posting REQUIRES armed in BOTH
modes (scheduler tick ~9570, live-post gate ~14297); in schedule mode armed STAYS true and the window gates
posting — so harvest ≡ "a run is actively posting". Verified: 0 harvest events while disarmed.

**R2 — hourly cadence.** `newCheckMinutes` (normalize ~1591, clamp 5..720 def 60). Every harvest round now sets
`__harvestNextAt = Date.now() + newCheckMs` (was: drain-immediately on progress / 15min on empty). `__harvestNextAt`
is reset to 0 in the __armTransition block (~19507) so the FIRST harvest fires at run START, not after a stale
cadence carried from the previous run.

**R3 — 2-day freshness cap (replaces the deep-resume cursor).** (a) Dropped the monotonic deep-resume cursor:
the connector call passes `resumeFromFbid:""` ALWAYS (server ~8548) — every round re-scans newest-first instead
of marching deeper; `resumeUpdates` no longer recorded (so cursorAdvanced/resumeMap/resumeUpdates are now
KNOWN-INERT dead code in harvestContentSourcesAsync — verified zero runtime impact; the harvestMembers write
at ~8621 is OUTSIDE the dead block and still runs; safe to delete later). (b) Connector age cap: `harvestMaxAgeDays`
(normalize, clamp 1..30 def 2; payload field). `fbTimestampToAgeDays(raw)` = coarse multilingual (en/es/fr/ar)
parse of a FB VISIBLE timestamp -> {days,confident}; `photoViewerPostAgeDays(page)` reads innerText of
anchor/abbr/time in [role=dialog] ONLY (NOT tooltip/title/aria — those hold the absolute date on EVERY post,
recent ones too -> would false-flag), skips comment articles, returns the FIRST confident parse in DOM order
(post header precedes comments). In the walk, for each UNSEEN post: if confident && days>maxAgeDays, break after
2 CONSECUTIVE too-old reads (one stray misread can't abort); else harvest. FAIL-OPEN on unknown (never false-stops
harvest). Grid fallback (deep /media scroll) DISABLED when maxAgeDays>0. Parser unit-tested 29/29 (keeps Just-now/
2h/1d/2d, stops 3d/1w/"June 15", fails-open "Marshalls"/"Yesterday").

**R4 — 2-day retention.** `imageRetentionDays` 15 -> 2 (normalize ~1590 default + live PUT + sweep fallback ~8949
7->2). Image-retention sweep now also guarded by `!isLivePostingInFlight()` (~9120) so a 2-day-old image can't be
unlinked while a live post reads it. **TRADEOFF (told operator):** retention(2d) ≈ reuseHours(48h) -> a product's
image is deleted about when it becomes reuse-eligible, so each product effectively posts ONCE then expires
(constantly refreshed by hourly harvest). To allow ONE reuse, raise imageRetentionDays to 3 (keep the 2-day
harvest cap). Sweep keys on harvestedAt (not lastPostedAt) — a never-posted product harvested >2d ago is evicted
(matches "remove after 2 days").

**2026-06-18 UPDATE — operator chose STRICT 2 days (NOT 5), accepts low volume.** Operator: "don't harvest posts
>2 days; if no fresh, wait 1h and re-check for new fresh listings." So harvestMaxAgeDays=2, imageRetentionDays=2,
newCheckMinutes=60. The run IDLING when the source has no ≤2-day posts is EXPECTED/desired, not broken.
HARD REALITY recorded: the source group's products mostly run 3-4 days old (~136 unique = supply ceiling), so
strict-2-day yields little — the run posts only genuinely-fresh deals + idles otherwise. DON'T re-suggest loosening
unless the operator asks. **HEAL fix shipped (uncommitted→auto-synced): in the harvest dedup branch (~8558) a
re-found product (connector only returns ≤maxAgeDays posts, so a re-find = a FRESH re-listing) whose image is GONE
gets its just-downloaded image RE-LINKED + harvestedAt refreshed (does NOT touch lastPostedAt → reuse window still
governs). Without this, fresh re-listings were skipped as URL-dupes and never posted — the bug that made the
fresh-only model unable to post.** My 2-day retention sweep had deleted ALL 136 images at once (they were 3-4d old);
under the strict-2-day rule those were too old to post anyway, so that was actually correct — the heal lets the ones
the source RE-LISTS fresh come back.

**INCIDENT — groups reverted on restart (2026-06-18).** After a restart, posting.groups loaded as the STALE
`1567661940074941 + o1498765421290862` (disk/committed all-day value) instead of the live `4854972804605257 +
1322293839675416` — the operator's groups were in server MEMORY but had NEVER reached disk (root cause not fully
explained; the b7541a5 preserve-fix protects groups going forward FROM disk, but can't recover a memory-only edit).
Recovery: DISARMED the run for safety, asked the operator, PUT groups=[4854972804605257, 1322293839675416] (full
URLs, groups+groupUrls) via allowOperatorConfig, and VERIFIED on the RAW DISK FILE (not just API/memory). LESSON:
after ANY restart or group edit, verify posting.groups against the RAW data/workflow-state.json on disk, not the
API. autopilotAutoResumeEnabled is ON (a crash/restart auto-resumes the run toward its remaining count).

**Adversarial review** (5-angle Workflow, 7 confirmed / 3 plausible / 8 refuted) caught + FIXED: manual endpoint
window bypass, __harvestNextAt-not-reset-on-arm, sweep-deletes-in-use-image, sweep fallback mismatch. Plausible-
but-left (fail-open, near-unreachable): comment-article empty-aria-label bypass + incomplete comment-word locale
list in photoViewerPostAgeDays. See [[fb-harvested-supply-ceiling]], [[fb-selfdrive-batch-fixes]],
[[fb-state-persistence-architecture]].
