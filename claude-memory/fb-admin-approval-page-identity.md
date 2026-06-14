---
name: fb-admin-approval-page-identity
description: "Why FB admin approval never worked — moderator profiles act as the posting Page, not the personal admin; must switch identity first"
metadata: 
  node_type: memory
  type: project
  originSessionId: 80639e48-5193-4896-84b0-c65946091867
---

ROOT CAUSE (found 2026-06-11) of the long-standing "post approved but still pending / approval never clicks Approve" bug: the moderator ixBrowser profiles (42, 16, 1) all open Facebook **as the posting Page "Couponing for beginners"** (page id 61590707785162), NOT as the personal admin. Proof: `/me` → `profile.php?id=61590707785162` h1 "Manage Page"; the group "Walkmart Hidden Clearance Sales" (1098414320641851) shows **no Admin tools**; the pending queue as the Page has **0 Approve buttons** and shows only the Page's OWN pending posts.

The real group admin is the **personal profile behind the Page: "Sara Marouani" (vanity `omar.marouani.98`)**. Account menu (avatar → "Your profile") lists: row0 = active Page "Couponing for beginners", row1 = "Sara Marouani", then "See all profiles". After a real (trusted) click to switch to Sara, `/me` → "Sara Marouani" and the pending queue renders **6 real "Approve"/"Decline" text buttons**.

FIX (shipped): connector `tools/fb-post-test-capture-url.js`:
- `detectIdentityRows(page)` — reads the account-menu **popover** (climb to bounded-width container so feed ads behind it are excluded); returns identity names top-to-bottom. row0 = active Page, **row1 = personal admin** (no name hardcoded — auto-detects per profile).
- `ensureAdminIdentity(page)` — if `/me` h1 matches "Manage Page", open menu, real-click `names[1]`, verify `/me` flips to a person. Idempotent. Called as **STEP 0 of `approvePendingPost`**.
- `clickApproveForVisibleMarker` path (b) rewritten: the old "Actions for this post" menu path was WRONG (that menu only has Edit/Delete/Notifications). Replaced with **proximity click**: find the marker/author `[role="article"]`, click the visible "Approve" button closest below it (Approve is a SIBLING of the article, not a descendant).

FALSE-POSITIVE fix (was logging "approved_and_verified" while posts stayed pending): a pending post's own permalink renders fine, so "markerVisible" ≠ approved. Connector early-success now requires `!pendingDetected` and emits `notPending:true`. server.js `facebookAdminApprovalValidationFromLog`: if `!approvalButtonClicked && markerVisible && postMediaVerified` → ERROR `admin_approval_button_not_clicked_post_still_pending` UNLESS `resultStep.notPending===true`. Server restart required to load this.

EXACT-MATCH ONLY (operator rule 2026-06-11): approve ONLY our own posts, matched by the post's unique tag. The
real admin queue mixes our posts with real members' posts (Marlon, Rana, Acil, Amy…), and ALL our posts share
the same Page author — so approval must key on the unique **#fb<6hex> fingerprint** (extracted from `marker`),
never on author/position. clickApproveForVisibleMarker: `matchKey = #fb-fingerprint || marker`; if matchKey not
visible → `exact_marker_not_visible_no_approval` (approve NOTHING). REMOVED the author-match-by-publisher
fallback and the proximity author branch. The per-post Approve button has aria-label "Approve post by <author>"
(text "Approve"); NEVER click "Approve selected pending posts" (bulk). Approve matching is multilingual
(EN/ES/FR/PT/DE/IT/AR). PROVEN end-to-end: single-post approve of #fbfad11c left the queue.

One-time backlog clear (2026-06-11, operator said "approve all"): mass-approved 60 pending posts (all authors)
via a throwaway script — all our #fb-marker posts cleared. That script was DELETED; production never mass-approves.

BUG FOUND LIVE (2026-06-11): moderator profile **1** ("1 - moderator1") was used to PUBLISH a real post during
a prod run — because `isFacebookAdminApprovalProfileLabel` gated on `\b(moderator|mod|...)\b` and **`\bmoderator\b`
does NOT match "moderator1"** (no word boundary before the trailing digit), so 42/16 matched but 1 slipped
through and posted. FIX: in that function, a profileId match against `state.ixbrowser.moderatorProfiles` now
returns true by MEMBERSHIP (no keyword needed) — the explicit list is the source of truth. Caught it via
monitoring (autopilot_publishing target seq3=profile 1), STOPped the run (POST /api/operator/stop-all with header
`x-dashboard-token` = data/.dashboard-token), killed connectors, fixed, restarted. The errant post landed PENDING
in o1498765421290862 (not yet live/approved). Server STOP API needs the dashboard token header (plain curl → 403).

RULE (operator, 2026-06-11): moderator accounts (42, 16, 1) are **approve-ONLY** — they must NEVER post or
comment. ENFORCED + verified in server.js: posting roster excludes them (isFacebookAdminApprovalProfileLabel,
~L7289) and a moderator used for posting hard-errors `facebook_moderator_profile_reserved_for_approval`
(~L10221); the comment candidate pool excludes them (~L10679). Detection is by ID: isFacebookAdminApprovalProfileId
matches each profile's leading id against `state.ixbrowser.moderatorProfiles` ("42 - moderator" / "16 - moderator 2"
/ "1 - moderator1") for ALL groups — so it catches them even if the real ixBrowser name isn't literally "moderator".
Never wire a moderator profile into any posting/comment path when adding features or running tests.

SPEED FIX — BATCH APPROVAL (operator: post→comment took 8–40 min, 2026-06-12): root cause = approvals are
SERIALIZED + each pending post got its OWN ~6-min moderator session (open profile + switch identity + load queue
+ wait-for-propagation + click + close), so post #3 waited behind #1/#2. The comment itself is ~1 min after
approval (NOT the slow part); the non-approval group 4854 has no delay. FIX: connector `batchApproveAllPublisherPosts(page,
gid, publisherId)` — once on the queue as admin, approve EVERY pending post by OUR publisher in the SAME session
(maps each per-post Approve to its nearest article, clicks only if that article's author link is /user/<pubId>/,
so members' posts are never touched). Wired in approvePendingPost right after the queue clickApproveForVisibleMarker
(BEFORE collectVerifiedUrls, which navigates to /user/). So one session drains the whole queue → later posts find
themselves already approved → comments fire fast. Connector = NO restart; UNVALIDATED live.

MEASURED LIVE (2026-06-12 run, 4 posts): pending-queue propagation = **10-30 min** (post published 17:42 →
appeared in queue ~18:12). The old flow burned 8-9 failed ~3-min moderator sessions (admin_approval_post_marker_
not_verified) waiting for it. FIX: openGroupReviewSurface retry passes now POLL IN ONE PATIENT SESSION (reload
queue every ~60-75s, up to ~14 min, attempts 2..14) + FACEBOOK_ADMIN_APPROVAL_TIMEOUT_MS raised 6→18 min
(1080000) so the patient session isn't killed mid-wait. Combined with batchApproveAllPublisherPosts (≤5/session)
one session approves everything the moment posts appear. Moderator least-used rotation PROVEN live (sequence
1,16,42,1,16,1,16,42,1,16,1,42 — even split). OUTDATED-then-FIXED (2026-06-12): moderator profiles 42/16/1 WERE all the same FB account (Sara). Operator since
re-logged them as DISTINCT real admin accounts — verified live: profile 16 = c_user 100024296195644, profile 1 =
c_user 100013874645334 (42 busy at check time, ix 111003). So the least-used moderator rotation now spreads
approval load across REAL separate accounts = true block-risk protection; no further accounts needed. (Note: both
opened to facebook.com/forced_account_switch with empty h1 on a fast /me — the hardened identity check skips the
switch safely in that state.) Warm-pool-of-2-always-open still SKIPPED: patient-session + batch removed the
bottleneck; revisit only if approval volume grows.

FORCED_ACCOUNT_SWITCH (2026-06-12, after moderators re-logged as distinct personal accounts): FB intercepts the
first navigation with facebook.com/forced_account_switch — "Switching accounts / You need to switch to <Name>
to continue." + ONE blue "Continue" button. Until clicked the session reaches NOTHING (queue never loads, h1
empty → that's the empty-h1 state seen on /me). FIX: connector `dismissForcedAccountSwitch(page)` (detect by
URL, click Continue multilingual, verify URL cleared) wired into ensureAdminIdentity (re-goto /me after) and
openGroupReviewSurface (retry target after). UPDATE 2026-06-13: posting/harvest/comment profiles DO hit it too
(operator observed it) — so dismissForcedAccountSwitch is now ALSO called in ensureFacebookLoggedIn (~L393, the
CENTRAL login fn every path uses: posting group_page, harvest, comment-only, approve), right after
dismissFacebookInterstitials. So ANY profile hitting "Switching accounts/Continue" clicks through it. No restart
(connector).

HARDENED (operator 2026-06-12, watching profile 16 "Laura Gomez" sit on /forced_account_switch: "why he dont
clique on continue"): the handler WAS working (logs showed detected→dismissed cleared=true→home.php every
session) — what the operator saw was the **2.2–3.6s humanPause that ran BEFORE the click** (the profile visibly
sat on the card). FIX (connector, NO restart): (1) ensureAdminIdentity now calls dismissForcedAccountSwitch
IMMEDIATELY after the /me goto (moved the long humanPause to AFTER), so Continue is clicked the moment the card
renders; (2) dismissForcedAccountSwitch now LOOPS up to 4 passes (waitFor the Continue button visible → click ASAP
→ verify URL cleared → if FB re-renders the card, click again), returns everCleared. Note: moderators DO still hit
forced_account_switch even though they default to the personal admin — it's FB's active-account confirmation on
first navigation (not a misconfig), and clicking Continue is the only path; it's auto-handled now. PROVEN LIVE 2026-06-12 (2-post validation run, server 8588): moderator 1
approved a real o-group post THROUGH forced_account_switch (facebook_admin_approval_finished id=1) — the queue
loaded (= switch cleared) and the post went live + got commented. No stuck card.

DEFAULT CHANGED (operator, 2026-06-12): moderator profiles now open Facebook **as the PERSONAL admin directly**
(no longer as the Page) — operator flipped the default identity in FB. ensureAdminIdentity auto-detects and
SKIPS the switch (reason already_personal_profile) → approvals faster. HARDENED for this: the switch now runs
ONLY when "Manage Page" is POSITIVELY detected; an unreadable/empty h1 SKIPS (identity_unreadable_skip_switch)
— blindly clicking row[1] would now flip personal→Page (wrong direction, 0 Approve buttons). Posting profiles
still post AS the Page (unchanged — posts authored by "Couponing for beginners"/61590707785162).

POST→COMMENT ~20-MIN GAP ROOT CAUSE + FIX (operator 2026-06-13, observed even on NON-pending/live posts):
the gap is NOT approval — measured live, non-pending posts counted then commented in ~1-2.5min (post 64→43s,
79→1m49s, 70→2m25s). The delay is the CROSS-PROFILE comment cycling: a DIFFERENT profile must comment, and a
just-published post often hasn't rendered its comment control for THAT other account yet, so the commenter hits
`marker_scoped_comment_button_not_found` (connector submitCommentOnVisiblePost ~L1451) and the server cycles to
the next profile (~15-30s each). 3-4 fails then success = ~1-2.5min; a long streak of failing profiles = the
~20-min worst case. FIX (connector, NO restart): the comment-button scan is now a PATIENT RETRY — re-scan up to
5x (~17s) with settles (ensureExpectedPostLoaded + humanPause) before giving up, so a live post gets commented on
the FIRST profile instead of burning 15-20. Operator set commentCooldownMinutes=1 (cooldown was never the
bottleneck). Applies to the next run's posts (connector = fresh spawn).

COMMENT-AFTER-APPROVAL PRIORITY (operator 2026-06-12, measured 7.2 min approve→comment gap): the post-approval
comment retry ran ONCE (server.js ~13464); a post FRESH from approval takes ~30-90s to go pending→live, so that
single retry often failed and the post fell to the slow periodic resweep (the 7-20 min gap). FIX: wrapped it in
a SETTLE+RETRY loop (4 attempts, 40s between) so the approved post is commented within ~2-3 min. server.js change
→ needs restart.

PARKED PROFILES NOW SKIPPED EVERYWHERE (operator 2026-06-13 "he uses disconnected profiles, he shouldn't"):
posting already skipped parked (disconnected/errored/suspended) but COMMENT-recovery + HARVEST did not.
FIXED (restart-loaded): (a) recoverFacebookCommentWithProfilesInner now skips parked ids (__parkedCommentIds)
— it's the chokepoint for every comment path; (b) the harvest profile selection (postingSlots-derived pool +
the proven-member set __harvestWorkingProfilesByGroup + any "url|pin") now filters __harvParked, so harvest stops
re-opening dead profiles (e.g. 65 went suspended). PROVEN: a 20-post run opened ZERO parked profiles in any path.

2-APPROVALS-PER-MODERATOR (operator 2026-06-13): connector batchApproveAllPublisherPosts MAX_EXTRA_PER_SESSION
4→1 (~2 total per moderator session, then the least-used-next moderator drains the rest). Spreads approval load
+ block-risk. Connector = no restart.

TEMPORARY BLOCKED-MODERATOR FEATURE — BUILT 2026-06-13, NOT YET ACTIVATED (needs a server restart + connector
fix-2; do this FIRST next session). Operator rule: a moderator FB walls on forced_account_switch that the Continue
loop CAN'T clear = temporarily blocked (~20min) → bench it 24min → AUTO-RETEST on its next approval turn → a
SUCCESSFUL approval auto-removes it (admin can Release early). Implemented: state.posting.blockedModerators
(timestamped) + blockedModeratorCooldownSet/markModeratorBlocked/releaseModeratorBlocked (server.js ~2191) +
default seed + normalizer + rotation skip in facebookAdminApprovalProfilesForGroup add() + GET
/api/profiles/blocked-moderators + shared release + connector emits step admin_approval_forced_account_switch_stuck
{cleared:false} in ensureAdminIdentity + facebookAdminApprovalValidationFromLog reads it (validation.moderatorStuckForcedSwitch)
+ orchestrator branch markModeratorBlocked+continue + releaseModeratorBlocked on success + web/app.js
uxAttachBlockedModerators + index.html Prod-tab panel. ADVERSARIAL REVIEW found + FIX-1 APPLIED: a stuck moderator
ALSO trips approverLacksAdminRole (re-walled review surface → adminSurfaceReachable:false) and that branch ran
first → bench was dead; gated it `&& !moderatorStuckForcedSwitch` (server.js orchestrator). STILL TODO (fix-2,
deferred — user stopped): short-circuit the connector's approveOnly flow when ensureAdminIdentity returns
forcedSwitchStuck (return BEFORE openGroupReviewSurface) so a stuck moderator benches INSTANTLY instead of burning
a ~14-min re-walled poll. Then restart to activate the whole feature.

CONFIRM-LIVE-BEFORE-MODERATOR (operator 2026-06-14: "posts are ALREADY published, he goes to moderator to look
for them but they're already live — when I open the group link I find them!"). FIX = **EDIT 1**, server.js ~L14500:
the pre-comment approval gate changed from `(!validation.ok && !liveEnoughToComment) || groupRequiresApproval` to
`!liveEnoughToComment && (!validation.ok || groupRequiresApproval)`. So a captured-live post in the o-group NO
LONGER opens a moderator pre-comment; it goes straight to the different-profile comment, which IS the public-
liveness oracle (a non-publisher member can't see/comment a still-pending post → comment fails
`comment_profile_cannot_access_post_permalink` / `comment_blocked:post_pending_or_unavailable` → the EXISTING
escalation at ~L13657-13663 fires the moderator + retries the comment 4x). Net: genuinely-pending posts STILL get
approved (fail-open), live posts get commented with ZERO wasted moderator opens. Truth-tabled + 3-verifier
adversarial SHIP (only the 2 rows where liveEnoughToComment=true AND groupRequiresApproval=true change; all 6 other
rows identical). Shipped + pushed (commit b6e60ad) + server restarted (PID 7432), saved-setup fingerprint byte-intact.
**EDIT 2 DELIBERATELY NOT BUILT** (the swarm's pre-moderator findOnly probe inside approvePendingFacebookPostWithAdminProfilesImpl):
it called `recoverSubmittedFacebookPostUrl({...profileUseAlreadyAcquired:false})`, but the publisher use-lock is
ALREADY HELD by the posting flow at that call site (PROOF: the existing call at server.js:14688 passes
`profileUseAlreadyAcquired:**true**` for exactly this reason) → re-acquiring would deadlock/throw across 5 call
sites. EDIT 2 was also marginal (approvePending already fast-bails when a moderator sees the post is live). Don't
re-attempt EDIT 2 without first proving lock ownership at ALL approve callers (13663/14350/14566/14714 + the gate).

RESTART PROCEDURE (validated 2026-06-14, the safe sequence): `Disable-ScheduledTask FB-Server-Watchdog` → kill ONLY
the 9317 owner after confirming it ≠ the 59812 (Pinterest) owner → `Start-Process node.exe server.js -WorkingDirectory
<proj> -WindowStyle Hidden -RedirectStandardOutput data\server-stdout.log -RedirectStandardError data\server-stderr.log`
→ poll `http://127.0.0.1:9317/` until 200 → re-fetch /api/state (header `x-dashboard-token` = data/.dashboard-token)
and SHA256-compare the saved-setup fields (posting.groups/groupAssignmentMode/equalSplit/groupProfileAssignments/
contentSources + operator.autopilotMaxPostsPerRun + productDiscovery.reusePostedProductAfterDays) → `Enable-ScheduledTask
FB-Server-Watchdog`. Node PIDs: 9317=FB server, 59812=Pinterest (NEVER touch), 8088=thumb-server (tools\thumb-server.js).
Auto-sync task FB-Agent-AutoSync commits+pushes every 30 min, so a fresh server.js edit is usually already committed.

Connector changes need NO restart (fresh-spawned per run). server.js validation guard loaded via restart
2026-06-11 (server PID 5040). See [[fb-agent-highscale-pipeline]] and [[fb-no-live-post-without-ok]].
