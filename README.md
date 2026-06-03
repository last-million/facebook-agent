# Facebook Agent Control

Local-only dark-mode operator dashboard for the Miro Facebook posting workflow. Hermes receives todos with the saved Miro schema and current dashboard state.

## Run

Double-click:

```bat
run-facebook-agent.bat
```

Dashboard:

```text
http://127.0.0.1:9317/
```

## Model Path

Jobs run through Hermes in WSL:

```text
OpenAI Codex / gpt-5.5 primary
OpenRouter free fallbacks configured in Hermes
```

## Safety

- Dashboard binds to `127.0.0.1` only.
- Jobs are queued locally in `data/jobs.json`.
- Workflow controls are stored in `data/workflow-state.json`.
- Outputs/events are stored locally in `data/`.
- Operational registers are editable from the dashboard and stored as text files in `data/`.
- Posting, commenting, DMs, account changes, ads, scraping, or irreversible actions require human approval.
- The dashboard does not store Facebook passwords, cookies, or tokens.

## Dashboard Sections

- Run Control: heartbeat, enable/disable, start next, stop active.
- Command Center: heartbeat, enable/disable, start next, stop active, save everything.
- Triggers & Memory: compact Hermes prompts, context caps, job timeout, queue limit, and auto-start control.
- Analytics: queue health, security posture, IX profile capacity, product/image readiness, text-bank readiness, group count, schedule, and autopilot state.
- Readiness: approval, external action lock, deal signal, current IP, IXBrowser, extension, source URLs, registers.
- Workflow Map: deal source, shortlinks, profiles, posting, moderator, registers.
- Integrations & API Keys: editable local password fields for OpenAI, OpenRouter, Webshare, IXBrowser, and extension credentials; blank values keep saved keys, with clear controls for removal.
- Browser & Proxy Control: test Webshare, load proxies, test IXBrowser, load profiles, open/close profile, apply selected Webshare proxy to selected IXBrowser profile.
- Security Audit: read-only local port/process/firewall audit with warnings for exposed RDP, SMB/RPC, dashboard, and dynamic service ports.
- Affiliate Pipeline: clean existing affiliate links, create ShopYourLikes affiliate links, then shorten with Mavlynk.
- ShopYourLikes/Mavlynk Profile: affiliate generation and final shortlink generation both use one dedicated IXBrowser profile with fixed IP; the dashboard stores its profile ID/name and blocks that profile from normal proxy rotation.
- Affiliate Proxy: ShopYourLikes and Mavlynk API requests use one dedicated static/private US Webshare proxy only; proxy credentials are stored in secrets and never sent to Hermes.
- Approvals: human approval, external action arm switch, schedule window.
- Quick Hermes Tasks: audit workflow, posting checklist, IP/profile plan, file formats.
- Posting Rules: randomized human-like post delay range, account rotation, deal signal, pause-on-risk settings.
- Posting Inputs: add group URL, groups, source URLs, shortlinks, descriptions/images paths, moderator notes.
- Product Page Assets: product URLs, 1 realistic image from a positive customer review per product, approval state, and output path.
- Posting Text Banks: ordered one-line post text bank and ordered one-line first-comment lead-in bank before the Mavlynk shortlink.
- Deal Source: Amazon, Walmart, Target filters, recent activity signal, filter-planning task.
- Webshare / IP: IP status, failed IP tracking, mark-IP-failed, IP check planning.
- IXBrowser Profiles: active/failed profile tracking, active count, max profiles per run, max concurrent profiles, selected next-run queue, profile/IP mapping, account selector.
- Daily Tracking: action/comment counts by day/account/profile/IP.
- Extension: ShopYourLikes setup, API fields, Publisher ID/API key, setup-planning task.
- Operational Files and Registers: inactive accounts, invalid proxies, limited accounts, accounts to review, failed IPs, errors.

## Hardening

- Malformed JSON returns API errors instead of crashing the server.
- Workflow and job files use atomic writes.
- Register paths are restricted to this project folder.
- Long job output is capped.
- Stopped jobs stay stopped instead of being overwritten by process exit.
- Running jobs are marked failed if the dashboard restarts mid-run.
- Execute-mode jobs are blocked until external actions are explicitly armed.
- The UI tracks unsaved edits and prevents auto-refresh from overwriting typing.
- Secrets are saved separately in `data/secrets.local.json`, are never returned to the browser, and are ignored by `.gitignore`.
- Blank secret fields keep saved values; explicit clear controls remove saved keys.
- API writes require a per-run dashboard token, and cross-origin browser requests are rejected.
- Register file reads/writes reject paths that escape this project, including symlink escapes.
- Free-text product/text rotation fields are summarized before Hermes prompts, with prompt-like instruction lines redacted.
- IXBrowser control is restricted to a localhost API URL by the backend.
- IXBrowser Local API uses `http://127.0.0.1:53200/api/v2/` by default. A token is normally not required; the IXBrowser desktop app must be running and Local API must be enabled.
- Hermes jobs have a dashboard-configurable runtime timeout and queue cap.
- Enable does not auto-run queued jobs unless `autoStartQueuedJobs` is turned on; `Start Next` runs the next queued job manually.
- Live 1-post tests launch from the dashboard test button; production full-plan live runs still require typed confirmation `PUBLISH FULL PLAN`.
- Live full production runs require Human approval enabled, all ready posting-plan rows approved, and typed confirmation `PUBLISH FULL PLAN` before any Facebook publish attempt.

## Security Audit

From PowerShell:

```powershell
.\scripts\security-audit.ps1
```

The script writes:

```text
output/security/security-audit-latest.json
```

The dashboard can also run the same read-only check from the Security Audit panel. The audit does not close ports automatically because closing RDP/SMB/firewall rules can lock out administration.

## Security References

- OWASP GenAI / LLM Top 10: prompt injection and insecure output handling are first-class risks.
- Anthropic `claude-code-security-review`: useful GitHub Action pattern for semantic, diff-aware security review.
- Promptfoo: local red-team scans for prompt injection, jailbreaks, data leakage, and OWASP LLM/API checks.
- Semgrep and Gitleaks: practical open-source choices for static analysis and secret scanning.

## Miro

The Miro board was visible through the normal Edge browser session. Schema understanding is saved here:

```text
MIRO_SCHEMA_UNDERSTANDING.md
```

Supporting screenshots are saved in this folder with `miro-*.png` names.
