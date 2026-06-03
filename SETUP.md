# Facebook Agent — Setup on a New Machine

This repo is the autonomous Facebook posting agent (Node dashboard + Playwright
posting/commenting via ixBrowser + ShopYourLikes affiliate links). Follow these
steps to bring it up on a fresh Windows machine so it behaves identically.

> **Secrets are NOT in this repo** (API keys, proxy credentials, the dashboard
> token, browser login sessions). You re-enter them on the new machine (Step 5).
> `data/workflow-state.json` IS included — it carries your config (rules, posting
> group, profile roster, affiliate link mappings) but contains **no credentials**.

---

## 1. Prerequisites
- **Windows 10/11 or Server 2022**, with an Administrator account.
- **Node.js 18+** (this build ran on Node 24) — https://nodejs.org → install.
- **ixBrowser** (desktop app) — https://www.ixbrowser.com — installed, with its
  **Local API enabled** (Settings → API). Default local API: `http://127.0.0.1:53200/api/v2`.
- The **Facebook accounts** you post/comment with, each as an ixBrowser profile,
  logged in. Plus the reserved profiles (see Step 6).
- (Paid) **ChatGPT** logged into a persistent Edge profile for HD image upgrades.

## 2. Clone the repo
```cmd
git clone https://github.com/last-million/facebook-agent.git "facbeook agent"
cd "facbeook agent"
```
> The folder name `facbeook agent` (with the original typo + space) is referenced
> by the helper scripts; keep it, or update the hardcoded paths (Step 7).

## 3. Install dependencies
```cmd
npm install
```

## 4. Start the dashboard
```cmd
node server.js
```
Then open **http://127.0.0.1:9317** in a browser (loopback only). A fresh
`data/.dashboard-token` is created automatically on first run.

## 5. Re-enter your secrets (Integrations tab)
In the dashboard → **Integrations**, fill in (these write `data/secrets.local.json`):
- **OpenAI** / **OpenRouter** API keys (content generation)
- **Firecrawl** key (product research), if used
- **Webshare** proxy credentials
- **ShopYourLikes** + **Mavlynk** (shortlink) credentials
- **ixBrowser Local API** URL (e.g. `http://127.0.0.1:53200/api/v2`) + key if set
- Dedicated **ShopYourLikes proxy** (affiliateProxy), if used

## 6. ixBrowser profiles
- Create/log-in your **normal posting profiles** in ixBrowser and add them to the
  group roster in the dashboard (**Posting** tab → Assign Profiles to Groups).
- **Reserved profiles (never post/comment)** — the agent excludes these by
  name/role automatically:
  - `wise` → in `ixbrowser.blockedProfiles`
  - `moderator` profiles (approval-only) → in `ixbrowser.moderatorProfiles`
  - `shopyourlikes` (link-gen only) → `affiliate.dedicatedIxProfileId`
- The posting group is in `posting.groups` (vanity URLs like
  `/groups/o1498765421290862` are supported — the connector resolves the numeric id).

## 7. Fix hardcoded paths (if the folder path differs)
Some helper scripts assume `C:\Users\Administrator\Desktop\facbeook agent`. If your
path differs, edit:
- `data/fb-server-watchdog.ps1` (`$proj`)
- `data/prod-autostop.js` (`PROJ`)
- `run-facebook-agent.bat` / `stop-facebook-agent.bat`

## 8. Keep-alive watchdog (optional, for 24/7)
`data/fb-server-watchdog.ps1` restarts `node server.js` if port 9317 stops
listening (it never kills anything, never touches other apps). Register it as a
Scheduled Task running as SYSTEM every 3 minutes:
```powershell
$proj = "C:\Users\Administrator\Desktop\facbeook agent"
$action  = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$proj\data\fb-server-watchdog.ps1`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 3)
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName "FB-Server-Watchdog" -Action $action -Trigger $trigger -Principal $principal -Force
```

## 9. Restore the agent "memory" (Hermes context)
The agent's persistent notes live in `claude-memory/` in this repo. On the new
machine, copy them into Claude Code's memory dir so Hermes/the assistant keeps the
same context:
```
copy claude-memory\*.md "%USERPROFILE%\.claude\projects\<your-project-id>\memory\"
```
(`MEMORY.md` is the index; `fb-agent-highscale-pipeline.md` is the project log.)

## 10. Operating notes
- Posting window: `rules.peakStartTime`–`peakStopTime` (ET). Armed autopilot only
  posts inside it.
- Pacing: `rules.minutesBetweenPosts` (+ min/max), `postsPerProfilePerDay` cap.
- Concurrency: `operator.autopilotConcurrentPosting` + `ixbrowser.maxConcurrentProfiles`
  (3 is the safe max on a no-GPU box).
- Arm for live posting: dashboard → enable autopilot + arm external actions
  (`autopilotDryRun=false`). The per-run limiter `autopilotMaxPostsPerRun` (0 =
  unlimited) auto-disarms after N posts.
- Reconciliation: the agent syncs its profile roster to live ixBrowser at run start
  (drops deleted profiles, keeps suspended ones benched).

---
**Security reminder:** never commit `data/secrets.local.json`, `data/.dashboard-token`,
or any `data/*-browser-profile/` session folder. The `.gitignore` already blocks them.
