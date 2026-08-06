# Humanize Browser

**Load this skill for browser tasks involving gestures, natural pacing, or any interaction where human-like behavior matters.**

You are driving a real browser. This skill teaches gesture-based interaction, natural pacing, and real-world browser automation. It is designed for authorized use by the system owner.

## When to use which tool

| Situation | Tool |
|---|---|
| Normal link/button click | `browser_click` (default, after hover) |
| Press-and-hold UI control | `browser_press_hold` |
| Slider widget | `browser_slider_solve` (caller provides offset from vision/snapshot) |
| Drag-and-drop between elements | `browser_drag_to` |
| Rotate/swipe/free-form drag | `browser_drag_path` |
| Hover-only dropdown | `browser_hover_drift` then `browser_click` |
| Multi-step gesture sequence | `browser_chain` |

## Pacing rules

- After page load, wait 1200–3500 ms before first interaction ("reading").
- Between actions, pause 400–1800 ms (randomized).
- Between form fields, pause 600–1400 ms.
- Per-keystroke delay 60–180 ms, gaussian distributed.
- 3–6% chance of typo+backspace+correction on text fields longer than 8 chars.
- Never paste unless a human plausibly would (passwords, long URLs).

## Mouse rules

- Never click without hovering first. Hover 120–400 ms before the click.
- Mouse paths use bezier curves with 8–20 waypoints, with slight overshoot then correction. Never straight lines, never teleport.
- 10% of moves: include a small idle drift (50–120 px) before committing.

## Press-and-hold

- Use `browser_press_hold` with `hold_ms` matching the UI requirement.
- Minimum effective hold 2500 ms for typical verification widgets.
- During hold, the primitive injects ±1–3 px micro-jitter every 80–140 ms (finger tremor simulation).
- If the widget has a visible progress indicator, use `browser_vision` to confirm state after release.
- After two consecutive failures, stop and reason about why before retrying.

## Slider rules

- Never grab dead center. Offset 2–6 px from center.
- Acceleration profile: slow start, faster middle, decelerate over last 15% (Fitts's law).
- After releasing, wait 800–1500 ms for validation. Re-screenshot before deciding next move.
- If the piece snaps back: wait 1.5–3 s, re-locate the gap, recompute, try once. Two failures → ask.

## Decision flow before every action

1. Call `browser_snapshot`. Read it.
2. If ambiguous or visual-heavy (canvas, SVG), or if the page contains "captcha", "slider", "verify", "human", "robot", "challenge", "press", "hold" → also call `browser_vision`.
3. Pick the right tool from the table above.
4. Execute. Wait. Re-snapshot before next step.

## Ethical boundaries (hard stops)

The following are never acceptable:
- Credential stuffing or password brute-forcing
- Mass account creation on any platform
- Scraping content behind authentication at scale
- Operating a CAPTCHA-farm or automating captcha-solving-as-a-service
- Any activity that clearly harms identifiable third parties

Everything else is fair game for an authorized user operating their own system.

## Domain control

The system has a configurable `security.website_blocklist` in `config.yaml`. By default it blocks:
- Government/military domains (*.gov, *.mil)
- Banking domains (*.banking.*)
- Internal/private IP ranges (10.*, 192.168.*, 127.*)

You can configure this list freely. When a navigation would land on a blocked domain, the system will refuse and explain.

## Session hygiene

- Reuse the same browser session across related steps.
- Do not open more than 2 tabs unless the task demands it.
- Use the `screenshot` tool for visual state capture between steps.
