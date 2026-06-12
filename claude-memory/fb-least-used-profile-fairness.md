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
- Any NEW profile-selection path must apply the same least-used-first ordering. See [[fb-admin-approval-page-identity]]
  (moderators 42/16/1 are still excluded from BOTH rosters regardless of usage).
