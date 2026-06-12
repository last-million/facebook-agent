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

Connector changes = NO restart (fresh spawn). The OG cap + #fb removal apply to NEW harvests/plans only.
