# Final Miro Process Read

Source: https://miro.com/app/board/uXjVHVvn_gk=/

This read is based on the real Edge/Miro window plus saved close crops and upscaled crops. It is not based on guessing.

## Brutal Confidence

- Overall workflow confidence: high.
- Exact wording confidence for large notes: high.
- Exact wording confidence for tiny embedded images/links: medium/low because some screenshots are too small and blurred.
- Literal 100% confidence requires a Miro export/PDF or higher-zoom screenshots of each embedded image.

## Confirmed Goal

Build a local operator-controlled Hermes dashboard for a Facebook deal-posting workflow. The dashboard should manage todos, rules, account/profile/IP state, Webshare proxies, IXBrowser profiles, ShopYourLikes affiliate links, Mavlynk shortlinks, operational registers, autopilot controls, and human approval gates.

## Confirmed End-To-End Process

1. Find product/deal pages, likely Amazon-style pages; exact product URL source method is pending user confirmation.
2. Use filters such as selected filters, price, brand, color, and product category.
3. Prefer fresh/high-activity deals, specifically the visible signal `10+ bought since yesterday`.
4. Store or prepare the source URL / long product URL / shortlink.
5. If the source URL is already an affiliate link, clean affiliate/tracking parameters first.
6. Create a ShopYourLikes affiliate link from the clean retailer URL.
7. Shorten the final ShopYourLikes affiliate link with Mavlynk.
8. Prepare ready descriptions and images for posting, including exactly 1 realistic customer review image per product. The image must come from a positive review, not a negative review, and needs human approval before any Facebook post.
9. Each IXBrowser profile maps to one proxy and one Facebook account.
10. Detect which Facebook groups each profile/account owns or can post in.
11. Each profile/account should post only 5 times per day.
12. Posting should happen during US peak hours.
13. The Facebook post itself should not contain the affiliate link.
14. The affiliate shortlink should go in the first comment, with a short expression chosen from the ordered one-line first-comment lead-in bank before the Mavlynk shortlink, then that first comment should be pinned.
15. If profile/account/proxy fails, flag it down and do not use it until approval/fix.
16. Moderator account accepts pending posts from specific accounts.
17. Rules control minutes between posts, pause/run, scheduled start/stop, errors, limited accounts, inactive accounts, invalid proxies, and Facebook group URL posting area.
18. Webshare is the proxy provider and records IPs/proxies that did not work.
19. IXBrowser tracks how many profiles are running/active and which profile/IP combinations failed.
20. IXBrowser should open pages automatically when IP is working.
21. ShopYourLikes extension/API creates affiliate links. It should work from normal local IP context, not per-profile proxy context unless intentionally configured.
22. Autopilot should be optional: disabled requires approval; enabled can run approved workflow automatically inside configured limits.
23. Dashboard API keys are editable through local password fields, are not returned to the browser, and support blank equals keep saved plus explicit clear controls.
24. Dashboard maintains ordered one-line banks for Facebook post text and first-comment lead-ins.
25. Dashboard controls Hermes memory/context budgets, job timeout, queued-job limit, trigger behavior, and IXBrowser max profiles per run/concurrent profiles.
26. Dashboard includes a read-only security audit for local ports, firewall profiles, and local agent processes.
27. ShopYourLikes affiliate-link generation and Mavlynk shortlink generation both happen inside the same dedicated fixed-IP IXBrowser profile. That profile ID/name is operator-provided and its IP must not be rotated.
28. ShopYourLikes and Mavlynk API requests must use one dedicated static/private US Webshare proxy only. The proxy is selected/stored separately from normal posting proxies and must not rotate.

## Confirmed Board Notes

- `moderator account`: accepts pending posts of some specific accounts.
- `posting`: takes shortlinks to active accounts and comments on posts; each profile for each account and Facebook group; move ready description and images for posting.
- `rules`: control randomized minutes between each post, default 5-16 minutes for human-like pacing; pause and run button; Facebook groups URL posting area; errors area; limited accounts/comments/posts text file; inactive accounts area/text file; invalid proxies text file; save account names if comments are more than 10 times; put 5 comments and move to another account; add URL button for Facebook groups in the future; scheduled start/stop; scrape deals should be `10+ bought since yesterday`.
- `api/webshare`: need a button to control IP; change basic profile information; same IP can limit accounts based on same comments/actions every day; save bad IPs in text file for changing later.
- `ixbrowser`: need to know how many profiles are running/active; need exact profiles whose IPs did not work; example shown as profile/IP mapping; need ability to change API and use another IXBrowser account.
- `extension`: confirmed as ShopYourLikes. It creates affiliate links; use clean retailer URLs first. May also have API access through account Publisher ID/API key. Mavlynk is the shortlink provider after ShopYourLikes.

## Confirmed Images

- Product/deal screenshot: Amazon-style product card with price around `$9.97`, rating, coupon/subscribe style UI, and purchase/activity boxes.
- URL box: long Amazon URL/source link under the product screenshot.
- Filter screenshot: `All filters`, selected filters, price, brand, color, product category, and `View results`.
- Proxy/IP screenshot: IP `45.58.229.92`, with proxy check fields such as Google/WebRTC/protocol/DNS/timezone-style checks.
- IXBrowser note under proxy image: IXBrowser opens pages automatically when the IP is working.

## Still Not Fully Readable

- Exact product title in the Amazon screenshot.
- Exact long Amazon URL.
- Exact names of selected filters in the tiny filter screenshot.
- Exact wording around `one IP ... one profile ... untouchable` in the extension note.
- Exact ShopYourLikes API endpoint beyond public extension/link-generator docs.
- Exact Mavlynk API endpoint/auth details.
- Exact final file formats for each register.
- Product URL source method: user still needs to provide/confirm how source URLs are collected.

## Implementation Implication

The dashboard should stay local-only and operator-gated. Read-only checks can run anytime. Any browser/profile/proxy/post/comment/action change must require explicit human approval and the external-action arm switch.
