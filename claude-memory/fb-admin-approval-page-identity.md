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

Connector changes need NO restart (fresh-spawned per run). server.js validation guard still needs a restart. See
[[fb-agent-highscale-pipeline]] and [[fb-no-live-post-without-ok]].
