---
name: fb-multilang-composer-fix
description: "FB posting failed \"could not open composer\" on o1498765421290862 because profiles run FB in Spanish/Arabic; fixed with multilingual detection"
metadata: 
  node_type: memory
  type: project
  originSessionId: 80639e48-5193-4896-84b0-c65946091867
---

**2026-06-11 BREAKTHROUGH.** Posting to the approval group o1498765421290862 failed for weeks with `could not open composer` — root cause: the operator's ixBrowser profiles run Facebook UI in **Spanish/Arabic** (confirmed diagnostic: page member, composer prompt = **"Escribe algo…"**, dialogText Spanish/Arabic), but `tools/fb-post-test-capture-url.js` only matched **English/French** composer text. PROVEN FIXED: 2 posts landed in o1498765421290862 with emojis, `composer failures: 0`.

Fix in the connector (fresh-spawned, no server restart needed): added `COMPOSER_PROMPT_RE_SRC` / `COMPOSER_PROMPT_RE` module const (EN/FR/ES/PT/AR incl. "escribe algo", "crea una publicación", "publica algo", Arabic "اكتب شي"/"إنشاء منشور") feeding `composerIsOpen`, `openComposer` (locators + adaptive scorer, passed into page.evaluate as reSrc), `shouldRetryComposerOpen`. Submit button `clickPostButton`: added ES/PT **"Publicar"** + AR "نشر". Photo button: foto/فيديو. Diagnostics live in `data/fb-live-post-log-*.json` (stdout has `composer_open_attempted` with the full UI snapshot — buttons/boxes/dialogText). See [[fb-agent-highscale-pipeline]].

**STILL OPEN after this fix (downstream, found in the 2-post test):**
1. **Comment follow-through races the auto-stop**: when autopilotPostsThisRun hits autopilotMaxPostsPerRun the run auto-DISARMS, and the still-running comment recovery then fails with `"External actions are locked. Arm external actions first."` (ledger event comment_recovery_error / validation comment_recovery_connector_error). Pronounced on tiny maxPostsPerRun runs; a real longer run mostly completes comments inline. Likely real fix: don't gate comment-recovery on `armed`, OR delay the run-complete disarm until pending comments settle.
2. **A MODERATOR (ix 42 "42 - moderator") was used to COMMENT** (comment_recovery_finished profileId=42) — moderators must be approve-only; the commenter-pick exclusion (isFacebookAdminApprovalProfileId, ~server.js:10612) has a gap. Moderators 41/42 are NOT in groupAssignmentData.
3. **Moderator APPROVAL never fired** in the test (posts left pending) — partly because the run disarmed early. Approval flow = tasks #137/138.
