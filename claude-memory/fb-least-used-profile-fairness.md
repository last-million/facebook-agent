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
3. **Dead profiles (1004) aren't auto-parked.** 1004 "Profile Open Failed" is INTENTIONALLY treated as transient
   infra, not account health (server.js ~L15535, isOpenInfraFailure) so a glitch doesn't park a healthy account —
   but a PERSISTENTLY-broken profile (84 failed 1004 6+ times/day) keeps getting picked as the freshest 4854
   profile and fails, so the 4854 post never LANDS. Manually parked 84 via POST /api/profiles/disconnect. OPEN
   follow-up: park a profile after N repeated 1004s in a window (threshold-based, careful — don't park on one).

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
