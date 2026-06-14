---
name: fb-least-used-profile-fairness
description: Operator rule — always pick the least-used profile next so all profiles are used equally (posting + commenting)
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 80639e48-5193-4896-84b0-c65946091867
---

Operator rule (2026-06-11): **always prioritise the profiles that have been used the LEAST**, so usage spreads
evenly across all profiles (no profile gets over-used/burned).

**Why:** even rotation keeps accounts healthy; hammering the same few profiles burns them.

**How to apply:**
- POSTING already does this: `postingSlots` → `orderFreshFirst` sorts each group's profiles by least-posted-today,
  then least-lifetime-posts, before emitting slots (low slot indexes = freshest profiles). Verified in `server.js`.
- COMMENTING (added 2026-06-11): the comment candidate builder (`recoverFacebookCommentWithProfiles`) now sorts
  the ixBrowser profile list by `facebookCommentCountByProfile()` (total successful comments per profileId from the
  ledger) **least-used-first** before taking the top MAX_COMMENT_FALLBACK_PROFILES. Never-used profiles (count 0)
  come first; stable sort keeps ixBrowser order for ties.
- MODERATORS (added 2026-06-12): `facebookAdminApprovalProfilesForGroup` now sorts moderators least-used-first
  via `facebookApprovalCountByProfile()` (admin_approval_finished count per profileId from the ledger), so 42/16/1
  share approval load instead of 42 always going first. Needs server restart to load.
- Any NEW profile-selection path must apply the same least-used-first ordering. See [[fb-admin-approval-page-identity]]
  (moderators 42/16/1 are still excluded from BOTH posting/comment rosters regardless of usage).

EQUAL POSTS ACROSS GROUPS (operator rule 2026-06-12): with N groups defined (each with its OWN posting/comment
profiles in the Prod tab), posts must spread EQUALLY across ALL groups. The cluster ("4/0 to one group") is NOT
the interleave or worker-slice — it's the PICKER. FIX: in the autopilot publish picker (server.js ~L8917) added a
group-balance cap — first pass caps each group at ceil(maxWorkers / groupsWithReadyRows), second pass fills the
remainder. Dynamic for any group count; group key = row.groupUrl. PROVEN: split improved 4/0 → 3/1. REMAINING gap
to perfect 2/2 = supply: a group only gets its share if it has enough ELIGIBLE+READY rows that cycle — and a group
heavily used last run has most profiles in their per-profile posting-spacing cooldown (minGapMs), so few are
eligible. Also a STALE assignment entry (e.g. profile 8 in 4854 = deleted from ixBrowser → "profile-open error
2007"; fallback skips it but operator should remove it). True per-batch equality needs both groups to have rested
profiles. An existence-filter for the plan was attempted but preparePostingPlan is SYNC (can't await
filterExistingIxBrowserProfiles) — reverted; do it via a sync cached id-set if revisited.

EVEN-SPLIT ROOT CAUSE + FIX (2026-06-12, server PID 1104): a 2-post run kept landing 2/0 in the o-group despite
both groups being configured. THREE compounding causes, all fixed in server.js (restart-loaded):
1. **Comment failure wrongly blocked POSTING.** A post that PUBLISHED fine but whose first-comment verification
   failed was recorded `status=cannot_post_in_group` (reason "Post published but required first comment was not
   verified: comment_blocked:..."). `isProfileGroupBlockedForPosting` (~L7452) then fell that profile back to
   another group — so every comment hiccup in 4854 funnelled its profiles into the o-group, STARVING 4854's plan
   rows. FIX: that function now returns false (NOT blocked) when the line shows the post published / comment-only
   failure (`/post published|first comment was not verified|comment_blocked|comment_not_submitted|comment_profile_cannot_access/`).
   Proven: plan went from ~0 ready 4854 rows to 9.
2. **Run-limit trim discarded the balanced picks.** The picker balanced a batch sized to maxWorkers (machine cap
   ~4) → e.g. 2 o-group + 2 4854 — then `picked.length = remaining` (the hard run-limit trim, ~L8980) kept only
   the FIRST N (all o-group). FIX: a `__batchCap = min(maxWorkers, runLimitRemaining)` now sizes the per-group cap
   and pick loop (~L8932) so the balance is correct PRE-trim. Proven: a 2-post run then picked ONE profile per
   group (73 o-group + 84 4854).
3. **Dead profiles (1004) now auto-park (FIXED + adversarially reviewed).** 1004 "Profile Open Failed" stays
   transient infra by default (server.js isOpenInfraFailure) — but a PERSISTENTLY-dead profile (84 failed 1004 6+
   times/day) kept getting picked as the freshest 4854 profile and failed, so the 4854 post never LANDED. FIX
   (server.js, restart-loaded): in autoBlacklistProfileIfNeeded's isOpenInfraFailure branch, call
   maybeParkPersistentOpen1004 — it ALWAYS records an auto_open_strike=1 breadcrumb, then parks the profile
   (markProfileErrored -> Prod-tab errored list + Release) after OPEN_1004_PARK_THRESHOLD=4 strikes. Two-agent
   adversarial review caught + fixed: (a) reset-on-success via a per-pid last-success floor in
   recentProfileOpen1004Count; (b) 5-min MIN-SPACING so a fast-retry burst (4 in ~100s) collapses to ONE strike;
   (c) WEDGE GUARD distinctRecentOpen1004Profiles — if >=3 distinct profiles fail to open within 6min it's an
   ixBrowser WEDGE (infra), NOT dead profiles, so NEVER park (the old fleet-wide "recent post" guard was wrong:
   one lucky post masked a wedge, a slow night masked a real dead profile); (d) anchored profile_id match (8 must
   not match 80/84). Residual LOW (accepted): lastAtByProfile is today-only, so a profile whose last success was
   yesterday could count pre-success strikes across midnight — heavily mitigated by spacing+wedge guard.

PROVEN LANDED 1/1 (2026-06-13, server 8752): after all 3 fixes + 84 parked, a 2-post run picked 73 (o-group) + 12
(4854) and profile 12 LANDED in 4854 (post 26152622487746980) — first time the even split actually landed a post
in each group, not 2/0.

COMMENTING NOW RESPECTS PER-GROUP ATTRIBUTION (operator 2026-06-13 "each group has its attributed profiles that
work on it; all should be robust"). POSTING already respected it (plan rows are group+profile slots from
groupAssignmentData — verified live: o-group posters ∈ its 64-87 set, 4854 posters ∈ its set, no cross-leak). But
COMMENTING did NOT: both comment-pool builders (`commentRecoveryFallbackProfilesForGroup` ~L10746 and async
`ixBrowserCommentFallbackProfilesForGroup` ~L10798) pulled from ALL ixBrowser profiles (profile-list + other-group
"probe_same_group_access" fallbacks) → a 4854 profile (60) / o-group profile (80) commented cross-group (proven in
a live run). FIX (server.js, restart-loaded): new helper `attributedCommentProfileIdsForGroup(groupUrl, state)`
parses groupAssignmentData (match by normalizedFacebookGroupKey — the comment groupUrl IS the assignment form, NOT
the permalink) → Set of profileIds (profileIdFromLabel = the FIRST number in "87 - 53"). Gate added in BOTH pool
builders AND — the robust backstop — as a UNIVERSAL LAST-LINE GUARD in `runFacebookCommentRecoveryAttempt` (~L12277,
right beside the moderator-approve-only guard, the choke point EVERY comment funnels through): a profile not in the
group's attributed set is skipped with `comment_recovery_skipped` / error `profile_not_attributed_to_group`.
FAIL-OPEN: if a group has NO attribution (set size 0) it does NOT restrict, so commenting is never hard-blocked.
PROVEN LIVE 2026-06-13: a fresh run logged comments IN-GROUP=3, cross-group LEAKS=0. Also a member-only profile is
the only one that CAN comment, so this is more reliable too. See [[fb-admin-approval-page-identity]].
VANITY↔NUMERIC LEAK FOUND + FIXED (2026-06-13, same day): a follow-up run then leaked 1 comment — pid 60 (a 4854
profile) commented on an O-GROUP post. Root cause: `attributedCommentProfileIdsForGroup` matched the comment's
groupUrl to the assignment with plain `normalizedFacebookGroupKey === `, but the o-group's ASSIGNMENT uses its
VANITY url (o1498765421290862) while the post/comment carries the NUMERIC group id (1098414320641851) → no match →
empty set → FAIL-OPEN → the guard let 60 through. (4854 is numeric in both places, so it never leaked.) FIX: the
helper now uses `groupsMatchByAlias(groupUrl, entry.url)` (server.js ~11995) — vanity↔numeric aware, alias map built
dynamically from the ledger's groupUrl↔actualGroupUrl/postUrl pairs (`groupKeyAliasSet` ~11972, 5-min cache,
persists across restarts via the ledger file). LESSON: ANY group-matching for the o-group MUST use groupsMatchByAlias,
never a raw key compare — the vanity/numeric split is a recurring footgun (see [[fb-admin-approval-page-identity]]
vanity-gid gaps). Live-validation of THIS fix is still pending (applied via restart, server PID 10880, disarmed).

APPROVAL SCOPING HARDENED (operator 2026-06-12 "he should approve only our posts"): batchApproveAllPublisherPosts
already approved ONLY posts whose author link is our Page (byUs check), but it paired each Approve button to a post
by SCREEN POSITION (nearest article) — a dense queue could mis-pair with a neighbour. FIX (connector, no restart):
pair by DOM CONTAINMENT first (climb to the smallest ancestor holding exactly ONE article = the button's own post
cell), fall back to nearest-article only if ambiguous, then require byUs. Fail-safe: never approves nothing, never
mis-approves a member's post. See [[fb-admin-approval-page-identity]].

PERMALINK CAPTURE via /user surface (operator-requested 2026-06-12): connector `userSurfaceMarkerUrls(page, gid,
authorId, marker)` navigates to `/groups/{gid}/user/{pageId}/` (lists ONLY that page's posts, newest first — all
profiles post AS the Page 61590707785162), then matches the EXACT marker (post text + #fb tag) via the existing
extractMarkerScopedPostUrls. Wired as PRIMARY in approvePendingPost's collectVerifiedUrls, feed scan = fallback.
authorId = payload.publisherFacebookUserId || facebookUserId. Faster + safer than feed-sifting. Also: connector
`dismissGroupRulesDialog(page)` clears the first-time "Group Rules" acknowledgment dialog (multilingual) before
commenting/posting. Connector changes need NO restart. ALL still UNVALIDATED LIVE (next run proves them).
