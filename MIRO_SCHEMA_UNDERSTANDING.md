# Miro Schema Understanding

Source board: https://miro.com/app/board/uXjVHVvn_gk=/

Captured screenshots:
- `desktop-miro-visible.png`
- `miro-region-center.png`
- `miro-region-right.png`
- `miro-region-top.png`
- `miro-rules-close.png`
- `miro-api-close.png`
- `miro-ixbrowser-close.png`
- `miro-extension-close.png`
- `miro-after-pan-down.png`
- `miro-lower-center-close.png`
- `miro-lower-ixbrowser-close.png`
- `miro-lower-filter-close.png`
- `miro-printwindow-final.png`
- `miro-final-rules-upscaled.png`
- `miro-final-product-url-upscaled.png`
- `miro-final-webshare-upscaled.png`
- `miro-final-ixbrowser-upscaled.png`
- `miro-final-extension-upscaled.png`
- `miro-final-proxy-upscaled.png`
- `miro-final-filters-upscaled.png`

See also: `FINAL_MIRO_PROCESS_READ.md`.

## Goal

Build a local operator dashboard where Hermes receives todos and helps manage a Facebook posting workflow with human approval, heartbeat, stop/start controls, and local safety boundaries.

## Software And Services

- Hermes Agent: reasoning and todo execution.
- Local dashboard: operator UI, heartbeat, job queue, enable/disable, start/stop.
- WSL Ubuntu-24.04: runs Hermes from Windows.
- Facebook: target workflow for posting/commenting/group operations.
- Moderator account: accepts pending posts from specific accounts.
- Webshare: proxy/IP provider API.
- IXBrowser: browser profile manager and profile/IP state source.
- ShopYourLikes extension/API: creates affiliate links from clean retailer URLs; final affiliate links are shortened with Mavlynk.
- Text files/logs: store inactive accounts, invalid proxies, limited accounts/comments/posts, accounts needing review, and IPs that did not work.

## Visible Flow

1. Moderator account accepts pending posts from specific accounts.
2. Posting workflow takes shortlinks to active accounts.
3. It comments on posts.
4. It repeats per profile, per account, and per Facebook group.
5. Ready descriptions and images are moved/prepared for posting; each product must collect exactly 1 realistic image from a positive customer review for human approval before Facebook posting. Do not use images from negative reviews.
6. Rules control timing, pausing, stopping, errors, account limits, invalid proxies, and future group adding.
7. API/Webshare manages proxy/IP checks and rotation.
8. IXBrowser tracks which profiles are active/running and which profile/IP combinations failed.
9. ShopYourLikes handles affiliate link generation. Existing affiliate links should be cleaned before conversion. Mavlynk handles final shortlinks.
10. Product URL source method is still pending user confirmation.

## Rules Visible On Board

- Control randomized minutes between each post; default range is 5-16 minutes and can be changed in the dashboard.
- Pause and run button.
- Facebook groups URL posting area.
- Errors area.
- Limited accounts/comments/posts text file.
- Inactive accounts area/text file.
- Invalid proxies text file.
- Save accounts names in text file when comments are more than 10 times.
- Put about 5 comments, then move to another account.
- If there are fewer comments, move to another account; if less, move to another one until finding a good one.
- Add URL button where Facebook groups can be added in the future.
- Scheduled time when to start and stop.
- Scraped deals should be filtered by a strong recency/activity signal, shown as "10+ bought since yesterday" on the board.
- A product/deal source appears on the board, likely Amazon-style deal pages. The visible product card includes price/rating and an activity/recent-purchase signal.
- A long Amazon URL is shown under the product/deal screenshot. The workflow likely stores/copies source URLs or shortlinks for posting.
- A visible "All filters" panel includes selected filters, price, brand, color, product category, and a "View results" button. This suggests the deal/source discovery step may need filter presets or filter state tracking.

## API / Webshare Notes Visible On Board

- Need a button where the operator can control IP.
- Need ability to change basic information in each profile.
- Because sometimes accounts limit actions based on IP, the same action/comments from the same IP every day should be tracked.
- Save IPs that did not work to a text file so they can be changed.

## IXBrowser Notes Visible On Board

- Need to know how many profiles are running/active at the time the agent is watching.
- Need exact profiles that have not worked.
- Example profile/IP mapping is shown on board.
- Need ability to change API/account to use another IXBrowser account.
- Board shows an IXBrowser/proxy status screenshot with IP `45.58.229.92`.
- Board note says IXBrowser opens these pages automatically when the IP is working.
- Current API implementation uses ixBrowser Local API V2 default localhost URL `http://127.0.0.1:53200/api/v2/` for profile listing/open/close and proxy updates.
- Browser/profile control actions should remain locked behind the dashboard external-action arm switch.

## Extension Notes Visible On Board

- Can change API.
- If there are multiple accounts, it should be connected on one profile.
- ShopYourLikes and Mavlynk shortlink generation should use the same dedicated IXBrowser profile with fixed IP. The operator will provide that profile ID/name, and this profile must not be included in normal proxy rotation.
- ShopYourLikes and Mavlynk API requests should use one dedicated static/private US proxy only. This affiliate proxy is separate from normal Facebook posting proxy rotation and must not change.
- Board mentions "one IP fed/open profile untouchable" wording, exact meaning needs confirmation.
- Shopify URLs extension is mentioned.
- Should create IXBrowser setup/profile for only the extension.

## Credentials / API Key Handling

- API keys should be entered in the dashboard Integrations & API Keys area.
- API keys are editable through local password fields, are stored in `data/secrets.local.json`, are not returned to the browser, are ignored by `.gitignore`, and are not included in Hermes prompts.
- Saving a blank API-key field keeps the saved value; explicit clear controls remove saved keys.
- Webshare uses `Authorization: Token <TOKEN>` and can list proxies from `/proxy/list/?mode=direct`.
- IXBrowser local API should stay on localhost; do not expose it to LAN.

## Posting Text Banks

- Dashboard keeps an ordered one-line Facebook post text bank.
- Dashboard keeps an ordered one-line first-comment lead-in bank placed before the Mavlynk shortlink.

## Safety Requirements

- Do not store passwords, cookies, tokens, or session secrets in this project.
- Do not automate spam, mass messaging, private data scraping, platform limit evasion, or impersonation.
- Any post, comment, DM, account change, ad action, proxy rotation, profile edit, or irreversible action must produce a plan and wait for explicit human approval.
- The local dashboard must remain bound to `127.0.0.1`.
- Logs should avoid secrets and only keep operational state.

## Open Clarifications

- Exact ShopYourLikes API endpoint/auth method beyond the confirmed Chrome extension/account API-key concept.
- Exact Mavlynk API endpoint/auth method.
- Exact format for account/profile/proxy text files.
- Exact meaning of the extension note about "one IP fed/open profile untouchable."
- Exact deal source/filter rules beyond the visible "10+ bought since yesterday" signal.
- Whether the Amazon URL should be stored as a source URL, shortlink input, or generated output.
- Product URLs source method remains pending from the user.
