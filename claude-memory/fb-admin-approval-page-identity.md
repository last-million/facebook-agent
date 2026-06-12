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
openGroupReviewSurface (retry target after). Posting profiles (Pages) don't hit this.

DEFAULT CHANGED (operator, 2026-06-12): moderator profiles now open Facebook **as the PERSONAL admin directly**
(no longer as the Page) — operator flipped the default identity in FB. ensureAdminIdentity auto-detects and
SKIPS the switch (reason already_personal_profile) → approvals faster. HARDENED for this: the switch now runs
ONLY when "Manage Page" is POSITIVELY detected; an unreadable/empty h1 SKIPS (identity_unreadable_skip_switch)
— blindly clicking row[1] would now flip personal→Page (wrong direction, 0 Approve buttons). Posting profiles
still post AS the Page (unchanged — posts authored by "Couponing for beginners"/61590707785162).

COMMENT-AFTER-APPROVAL PRIORITY (operator 2026-06-12, measured 7.2 min approve→comment gap): the post-approval
comment retry ran ONCE (server.js ~13464); a post FRESH from approval takes ~30-90s to go pending→live, so that
single retry often failed and the post fell to the slow periodic resweep (the 7-20 min gap). FIX: wrapped it in
a SETTLE+RETRY loop (4 attempts, 40s between) so the approved post is commented within ~2-3 min. server.js change
→ needs restart.

Connector changes need NO restart (fresh-spawned per run). server.js validation guard loaded via restart
2026-06-11 (server PID 5040). See [[fb-agent-highscale-pipeline]] and [[fb-no-live-post-without-ok]].
