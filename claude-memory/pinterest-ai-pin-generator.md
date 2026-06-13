---
name: pinterest-ai-pin-generator
description: "Pinterest agent's ChatGPT-browser AI pin generator — daily auto-generated unique 1000x1500 infographic pins"
metadata: 
  node_type: memory
  type: project
  originSessionId: 80639e48-5193-4896-84b0-c65946091867
---

The Pinterest agent (`C:\Users\Administrator\Desktop\pinterest agent`, NSSM service **PinterestAgent**, port 59812 —
restart with `Restart-Service PinterestAgent`, NOT a manual kill; it's nssm-supervised) got a NEW feature
2026-06-13 (operator request): auto-generate UNIQUE 1000x1500 Pinterest pin infographics via **browser ChatGPT**
(the logged-in paid web session, no API cost), daily + on-demand, using a couponing/grocery/Dollar-General/cashback
prompt template. The "never touch the Pinterest agent" rule was for FB-work safety; the operator explicitly opened
it for development here.

ARCHITECTURE (all in the pinterest agent):
- `tools/chatgpt-pin-generator.js` — the ENGINE. Ported from the FB agent's `tools/chatgpt-hd-upgrade.js` but
  TEXT-TO-IMAGE (no upload): connects to ChatGPT Edge CDP, submits a prompt, waits for the generated image,
  downloads it. Reuses the FB agent's `playwright-core` by absolute path (the pinterest agent has no playwright).
  Output is native ~1024x1536 (the same 2:3 Pinterest ratio as 1000x1500); resizes to exact size only if `sharp`
  is present (it isn't — native 2:3 is fine).
- `tools/launch-chatgpt-edge.js` — launches Edge on the FB agent's logged-in ChatGPT profile
  (`facbeook agent\data\chatgpt-agent-edge-profile`) with `--remote-debugging-port=9334`, using Node `spawn(args[])`.
  CRITICAL: PowerShell `Start-Process -ArgumentList` MANGLES `--user-data-dir` because the path has a space
  ("facbeook agent") — that wasted 3 launch attempts; spawn(args[]) passes it correctly.
- `tools/ai-pin-run.js` — the RUNNER: `node ai-pin-run.js [count]`. Ensures CDP Edge is up; builds a VARIED prompt
  per pin (rotates 6 themes + a unique seed so every pin differs); runs the generator N times -> `output/ai-pins/`.
  No-arg run reads `state.aiPins.{enabled,perDay}` (for the daily task). KEY GOTCHA: Edge only binds CDP when NO
  other Edge is running (Edge delegates a new launch to the existing browser broker even with a different profile),
  so ensureEdge() closes all msedge + retries if the port won't bind.
- server.js: `state.aiPins.{enabled,perDay,cdpPort:9334}` (defaultState + normalizeState). Endpoints (need
  `x-dashboard-token` = the per-session SESSION_TOKEN injected into the served HTML `<meta name="dashboard-token">`):
  GET `/api/ai-pins` (settings + recent pins), POST `/api/ai-pins/generate?count=N` (spawns the runner detached),
  POST `/api/ai-pins/settings?enabled=&perDay=`, GET `/ai-pins/<file>` (serves the PNG).
- web/index.html + app.js: a self-contained "AI Pin Generator" panel (section id=aiPins, function uxAttachAiPins) —
  enable toggle, pins/day, Generate-now, Refresh, + a recent-pins gallery. Independent of the main state-save flow.
- Daily Windows scheduled task **"Pinterest AI Pins Daily"** (4 AM, SYSTEM) runs `ai-pin-run.js` (no arg) -> only
  generates when aiPins.enabled.
- Prompt template: `data/pin-prompt-template.txt`.

PROVEN LIVE 2026-06-13: generated a real pin (test-pin -> output/ai-pins/) — a clean, READABLE, on-brand viral
infographic at 1024x1536. Current ChatGPT 4o image-gen renders the dense text well (the text-garbling worry was a
non-issue). The ChatGPT profile is logged in + working. Dashboard: hard-refresh to see the panel.
