---
name: fb-comment-cooldown-postonly
description: FB agent per-profile comment cooldown + comment-limited(post-only) state + post-pacing gate + Step-1 setting
metadata: 
  node_type: memory
  type: project
  originSessionId: 80639e48-5193-4896-84b0-c65946091867
---

Built 2026-06-11 (design workflow wu5v7hwha), all deployed + verified:

1. **Per-profile comment cooldown** — a profile can't post a 2nd first-comment within `rules.commentCooldownMinutes` (NEW, default 5) of its last. Enforced in `recoverFacebookCommentWithProfilesInner` (server.js ~12736): pre-loop builds `__cooldownMs`, `__lastCommentByPid = profileLastCommentTimeByProfileId()` (NEW helper near commentUsageCountByProfile ~12990, scans the durable `tracking.dailyActionLog` `type=facebook_first_comment_profile_used` lines — survives restart), `__commentLimitedIds`. In-loop: skip + `continue` (yield to next candidate, never abort) on cooldown or comment-limited.

2. **Comment-limited → POST-ONLY** — `state.posting.commentLimitedProfiles[]` (NEW; normalize clone of disconnectedProfiles). `markProfileCommentLimited()` (server.js ~2155) is the LIGHT mark: blocks commenting only, does NOT touch activeProfiles (unlike the heavy `writeCommentLimitQuarantine`). Auto-marked on a genuine non-transient `cannot_comment`/`action_blocked` in the live comment loop (~12836). MUST NOT be added to posting skip-sets (7242/8035) — that keeps them posting. Prod-tab section `data-prod-step="2h"` (commentLimitedPostOnlyList) + `uxAttachCommentLimitedPostOnlyProfiles()`; GET `/api/profiles/comment-limited`; Release via existing POST `/api/profiles/release` (releaseParkedProfile now filters this list too).

3. **Post-pacing gate** — `anyCommenterFreeForPost()` + gate at top of `runLiveFacebookPostFromPlan` (autopilot-only, skipped when post already published). If NO commenter is free within `POST_PACING_GRACE_MS` (120000), HOLD: return `{held:true}`, log `post_held_no_free_commenter`, DON'T publish/retire product/bump counter → re-runs next tick, self-clears when a cooldown elapses. Anti-starvation: hold is per-tick, grace window counts soon-to-free profiles, resweep is the backstop.

4. **Step-1 setting** — `#commentCooldownMinutes` input (default 5) with `data-confirm` 'not advised' disclaimer; CHANGE-based confirm in `uxAttachConfirmGuards` that REVERTS on cancel (added to collectState rules whitelist + setValue). See [[fb-no-live-post-without-ok]].
