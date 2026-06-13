---
name: fb-og-tags-and-needs-password
description: "Tags come from the link's OG title (not post text), no"
metadata: 
  node_type: memory
  type: project
  originSessionId: 80639e48-5193-4896-84b0-c65946091867
---

TWO operator rules implemented 2026-06-12 (during the long FB-agent session):

**1. Tags from the link's OpenGraph title — not the post text — and NO reference tag.**
- `harvestedHashtags()` (server.js ~9214) already builds tags from `row.title` + `row.ogDescription`; `row.title`
  is set to `harvestedRec.ogTitle` (the link's og:title) at the plan row (server.js ~9389). So tags already key on
  the OG title when it exists.
- The gap was the OG FETCH almost never succeeded: connector `harvestExtractPhoto` capped OG fetches at 4/round →
  ~all harvested records had empty ogTitle → tags fell back to caption words. FIXED: cap raised 4→60, goto timeout
  8s→15s + 4.5s settle (mavlynk shortlinks JS-redirect bizrate→skimresources→retailer), and added a URL-DECODE
  FALLBACK: when Walmart's bot wall blocks the og meta, recover the real product name from the FINAL url —
  walmart.com/blocked?url=<base64 of /ip/SLUG> (base64-decode the url= param) or a direct /ip/<slug>; slug → name
  (dashes→spaces, drop trailing numeric id). So tags now come from the OG/real product name "always".
- REMOVED the `#fb<hex>` reference/fingerprint tag from the visible tags (server.js, end of harvestedHashtags) —
  operator: no reference in the post. NOTE: post matching's matchKey preferred that fingerprint; it now falls back
  to the full tag-line/marker, and the /user/{pageId}/ surface is newest-first so a re-posted same product still
  resolves. Watch capture reliability without the fingerprint; if ambiguous, add a NON-visible per-post token.

**2. Profiles that need a password → list in Prod tab + manual release (ALREADY EXISTS).**
- When a profile is logged out / needs login, `markProfileDisconnected()` parks it in `state.posting.disconnectedProfiles`
  (triggers: isFacebookNotLoggedInError covers "enter your password"/"login required"/etc). Posting/comment slot
  builders skip parked profiles. Prod tab shows them: `uxAttachDisconnectedProfiles()` (web/app.js ~5782) →
  `#disconnectedProfilesList` / `#disconnectedProfilesCount`, GET /api/profiles/disconnected. Admin releases via the
  Release button → POST /api/profiles/release (releaseParkedProfile). So this is already built — just confirm the
  password-prompt connector signal lands as a not-logged-in error so it parks (vs the forced_account_switch case,
  which is auto-clicked, see [[fb-admin-approval-page-identity]]).

GAP FIX (2026-06-12): logged-out accounts that failed at the COMPOSER ("could not open composer") were NOT
flagged — that error isn't isFacebookNotLoggedInError, so the auto-park (server.js ~9074-9081: suspended→
markProfileSuspended, login→markProfileDisconnected, account-err→markProfileErrored) skipped them. FIX: connector
now calls ensureFacebookLoggedIn at the composer-open failure ('composer_open_failed_login_recheck') — a real
login wall throws facebook_login_required_for_profile → server parks it as DISCONNECTED (Prod tab list + skip);
a healthy-but-transient composer miss is a no-op (no false park). Disconnected section already exists:
uxAttachDisconnectedProfiles (web/app.js) + GET /api/profiles/disconnected + Release btn (POST /api/profiles/release).

AUTO DISCONNECT DETECTION — now FULLY AUTOMATIC (operator 2026-06-12: "all should be dynamic automatique to
detect disconnected accounts"). Root cause they hit: logged-out IDLE profiles (e.g. 50 = login wall "Alexandra
Gonzalez / Continue", 45) were NEVER flagged because the logout detection only fires when a profile is USED for a
post/comment — a profile not selected that cycle is never opened, never checked. `runProfileHealthSweep()`
(server.js ~8083) opens EVERY assigned profile (group→profile map), detects logout/suspension, and parks it
(markProfileDisconnected/Suspended → Prod-tab Disconnected list + skipped) — but it was MANUAL-ONLY (one endpoint
~18012, never auto-called). FIX (server.js heartbeat ~17828, needs restart — done, server PID 8588 2026-06-12):
auto-trigger every HEALTH_SWEEP_INTERVAL_MS (~2h) gated on `!active` (idle only, so it never fights a live run for
ixBrowser), single-flight + CPU-aware + concurrency 2; boot-grace back-dates `__lastHealthSweepAt` so the first
sweep is ~10min after boot (no boot storm). Used-but-logged-out profiles are still caught in-line by the
posting/comment path. To flag NOW without waiting: POST /api/profiles/disconnect?profileId=N&label=... (header
x-dashboard-token); Release via POST /api/profiles/release. Did this for 50+45 manually before the auto-fix. PROVEN
LIVE 2026-06-12 (2-post validation run): the in-line path auto-flagged profile 48 as disconnected and 65 as
suspended DURING the run (no manual action) — so disconnected list ended {50,45,48}, suspended {65}. The periodic
idle-sweep (every ~2h) is the complementary half for profiles never selected.

Connector changes = NO restart (fresh spawn). The OG cap + #fb removal apply to NEW harvests/plans only.
