# Two-profile manual publish test plan

Status: BLOCKED for publishing preparation only. No Facebook publish, IXBrowser open, browser automation, Webshare/proxy mutation, or Facebook API use is allowed by this plan.

## Decisions

- Total IXBrowser profiles: 2.
- Planned posts: 1 per profile.
- Candidate manual sequence:
  1. Profile `20 - 17` -> Group 1: `https://www.facebook.com/groups/1567661940074941/`
  2. Profile `8 - 8` -> Group 2: `https://www.facebook.com/groups/1322293839675416`
- Operator must manually open/use IXBrowser outside Hermes if approved later.
- Profile 1 must be explicitly closed before starting profile 2.
- Profile 2 must be explicitly closed when finished.
- Facebook post body must not contain the link.
- Mavlynk final shortlink goes in the first comment after the selected lead-in, then operator pins the comment manually.

## Per-profile readiness

### Planned item 1: Profile `20 - 17`

- Post text: ready: `Deal of today`
- Comment lead-in: ready: `check it here:`
- Blocked: missing exact field `productAssets.productUrls.lines[0]` or `posting.sourceUrls` final product URL.
- Blocked: missing exact field `productAssets.selectedReviewImages.lines[0]` approved positive-review image.
- Blocked: missing exact field `affiliate.finalShortlinks` or `posting.shortlinks` final Mavlynk shortlink.

### Planned item 2: Profile `8 - 8`

- Post text: ready: `Special dea for today`
- Blocked: missing exact field `productAssets.productUrls.lines[1]` or `posting.sourceUrls` final product URL.
- Blocked: missing exact field `productAssets.selectedReviewImages.lines[1]` approved positive-review image.
- Blocked: missing exact field `affiliate.finalShortlinks` or `posting.shortlinks` final Mavlynk shortlink.
- Blocked: missing exact field `contentRotation.commentLeadIns.lines[1]` because only one lead-in exists and reuse is disabled.

## Manual operator steps after blockers are filled

1. Confirm external-action arm switch is enabled in the dashboard and this exact two-profile plan is approved.
2. For Profile `20 - 17`:
   - Manually open the IXBrowser profile.
   - Manually create one Facebook post in Group 1 using the approved post text and approved image only.
   - Manually add first comment as: `<comment lead-in> <final Mavlynk shortlink>`.
   - Manually pin the first comment.
   - Paste the resulting Facebook post URL into Dashboard -> Tracking / Daily action log, and into the matching local posting record in `data/posting-plan.jsonl` if the dashboard exposes the record editor.
   - Explicitly close IXBrowser profile `20 - 17`.
3. For Profile `8 - 8`:
   - Manually open the IXBrowser profile only after Profile `20 - 17` is closed.
   - Manually create one Facebook post in Group 2 using the approved post text and approved image only.
   - Manually add first comment as: `<comment lead-in> <final Mavlynk shortlink>`.
   - Manually pin the first comment.
   - Paste the resulting Facebook post URL into Dashboard -> Tracking / Daily action log, and into the matching local posting record in `data/posting-plan.jsonl` if the dashboard exposes the record editor.
   - Explicitly close IXBrowser profile `8 - 8`.

## Next steps

1. Add two final product URLs.
2. Add two approved positive-review images, exactly one per product.
3. Add two final Mavlynk shortlinks.
4. Add a second comment lead-in or temporarily approve reuse for this two-profile test.
5. Re-run readiness check before any manual publish.
