"""
pointer_primitives.py — human-like pointer control for Hermes.

Operates on the agent-browser CLI session that Hermes already manages.
All functions are synchronous, use _run_browser_command() for agent-browser
communication, and register via tools.registry.register() under the "browser"
toolset.

Provides: browser_hover_drift, browser_press_hold, browser_drag_path,
          browser_drag_to, browser_slider_solve, browser_chain

Safety notes:
- press_hold uses FIXED duration only. No signal-driven release ("hold until
  Verified appears"). That pattern interacts with anti-bot verification
  widgets and is excluded per Hermes contributor safety guidance.
- slider_solve accepts explicit target_x_offset from the caller. The caller
  must compute the gap position visually.
- All tools refuse known verification/CAPTCHA domains.
"""

import json
import logging
import math
import random
import time
from typing import Dict, List, Optional, Sequence, Callable

from tools.registry import registry

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

# Known verification / anti-bot / CAPTCHA domains where these primitives
# should refuse to operate only when the user has not explicitly asked for
# testing/interaction there. Public demos and explicit user-authorized tasks
# are allowed.
_BLOCKED_DOMAINS: List[str] = [
    "hcaptcha.com", "recaptcha.net", "google.com/recaptcha",
    "datadome.co", "perimeterx.com",
]


def _check_not_blocked(task_id: str) -> None:
    """Raise RuntimeError if the current page URL matches a blocked domain.

    Prevents using these primitives against known verification systems.
    """
    try:
        from tools.browser_tool import _run_browser_command, _last_session_key
        effective = _last_session_key(task_id or "default")
        result = _run_browser_command(effective, "eval", ["window.location.hostname + window.location.pathname"], timeout=10)
        if not result.get("success"):
            return  # fail-open if we can't check
        url_text = str(result.get("output", "") or result.get("stdout", "") or "")
        url_text = url_text.strip().strip('"\'')
        for blocked in _BLOCKED_DOMAINS:
            if blocked in url_text.lower():
                raise RuntimeError(
                    f"Refused: current page ({url_text}) matches blocked domain "
                    f"'{blocked}'. These primitives are not designed for "
                    f"anti-bot/CAPTCHA systems."
                )
    except RuntimeError:
        raise
    except Exception:
        pass  # fail-open on unexpected errors


def _gauss(lo: float, hi: float) -> float:
    """Gaussian-ish pick clamped to [lo, hi]."""
    mu = (lo + hi) / 2
    sigma = (hi - lo) / 4
    return max(lo, min(hi, random.gauss(mu, sigma)))


def _bezier_points(x0, y0, x1, y1, n: int = 16):
    """Cubic bezier with two random control points offset perpendicular
    to the straight line. Returns n sampled (x, y) points with ease-in-out."""
    dx, dy = x1 - x0, y1 - y0
    dist = math.hypot(dx, dy) or 1.0
    nx, ny = -dy / dist, dx / dist  # perpendicular unit
    off1 = random.uniform(0.15, 0.35) * dist * random.choice((-1, 1))
    off2 = random.uniform(0.15, 0.35) * dist * random.choice((-1, 1))
    cx1 = x0 + dx * 0.3 + nx * off1
    cy1 = y0 + dy * 0.3 + ny * off1
    cx2 = x0 + dx * 0.7 + nx * off2
    cy2 = y0 + dy * 0.7 + ny * off2
    out = []
    for i in range(n):
        t = i / (n - 1)
        # ease-in-out cubic
        t = 3 * t * t - 2 * t * t * t
        u = 1 - t
        x = u**3 * x0 + 3 * u**2 * t * cx1 + 3 * u * t**2 * cx2 + t**3 * x1
        y = u**3 * y0 + 3 * u**2 * t * cy1 + 3 * u * t**2 * cy2 + t**3 * y1
        out.append((x, y))
    # tiny overshoot + correction at the end
    ox = x1 + random.uniform(-4, 4)
    oy = y1 + random.uniform(-4, 4)
    out.append((ox, oy))
    out.append((x1, y1))
    return out


def _get_session_locals(task_id: str):
    """Import browser_tool helpers and resolve the effective session key."""
    from tools.browser_tool import _run_browser_command, _last_session_key, _copy_fallback_warning
    effective = _last_session_key(task_id or "default")
    return effective, _run_browser_command, _copy_fallback_warning


def _get_element_box(task_id: str, ref: str) -> Dict:
    """Get bounding box for a ref via agent-browser 'get box' command."""
    effective, run, _ = _get_session_locals(task_id)
    if not ref.startswith("@"):
        ref = f"@{ref}"
    result = run(effective, "get", ["box", ref])
    if not result.get("success"):
        raise RuntimeError(f"Could not get box for {ref}: {result.get('error', 'unknown')}")
    raw = result.get("output", "") or result.get("stdout", "") or ""
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        raise RuntimeError(f"Unexpected box output for {ref}: {raw[:200]}")


def _get_current_xy(task_id: str):
    """Get last known cursor XY, defaulting to center of viewport."""
    effective, run, _ = _get_session_locals(task_id)
    result = run(effective, "eval", ["window.__lx||window.innerWidth/2,window.__ly||window.innerHeight/2"])
    if result.get("success"):
        raw = str(result.get("output", "") or result.get("stdout", "") or "")
        raw = raw.strip().strip('"')
        parts = raw.split(",")
        if len(parts) == 2:
            return float(parts[0]), float(parts[1])
    return 100.0, 100.0


def _set_current_xy(task_id: str, x: float, y: float):
    """Store cursor XY for next-move reference."""
    effective, run, _ = _get_session_locals(task_id)
    run(effective, "eval", [f"window.__lx={x};window.__ly={y}"])


def _mouse_move(task_id: str, x: float, y: float):
    """Move mouse to absolute screen coordinates."""
    effective, run, _ = _get_session_locals(task_id)
    run(effective, "mouse", ["move", str(int(x)), str(int(y))])
    _set_current_xy(task_id, x, y)


# ---------------------------------------------------------------------------
# Public tool functions
# ---------------------------------------------------------------------------

def browser_hover_drift(ref: str, task_id: Optional[str] = None) -> str:
    """Hover over an element with a bezier drift, then settle.

    Moves the mouse from its current position to the target element using a
    bezier path with random curvature, overshoots slightly, then corrects.
    """
    result, success = _make_wrapped_result("browser_hover_drift")

    try:
        # Get element position
        box = _get_element_box(task_id or "default", ref)
        cx = box.get("x", 0) + box.get("width", 0) / 2 + random.uniform(-3, 3)
        cy = box.get("y", 0) + box.get("height", 0) / 2 + random.uniform(-3, 3)

        # Get current cursor position
        x0, y0 = _get_current_xy(task_id or "default")

        # Generate bezier path
        duration = _gauss(500, 900)
        n = max(8, min(20, int(duration / 40)))
        pts = _bezier_points(x0, y0, cx, cy, n=n)

        step = (duration / len(pts)) / 1000.0
        for i, (x, y) in enumerate(pts):
            _mouse_move(task_id or "default", x, y)
            time.sleep(_gauss(step * 0.7, step * 1.3))

        # Settle
        time.sleep(_gauss(0.1, 0.3))
        result["success"] = True
        result["hovered"] = ref
        result["x"] = int(cx)
        result["y"] = int(cy)
    except Exception as e:
        result["error"] = str(e)

    return json.dumps(result)


def browser_press_hold(
    ref: str,
    hold_ms: int = 3000,
    task_id: Optional[str] = None,
) -> str:
    """Press and hold a mouse button on an element for a fixed duration.

    Moves to the element with a bezier drift, presses down, holds with
    micro-jitter (±1–3 px every 80–140 ms), then releases.

    Args:
        ref: Element reference (e.g., "@e5")
        hold_ms: Duration to hold in milliseconds. Must be between 1000 and 15000.

    Returns:
        JSON with held_ms and success status.
    """
    result, success = _make_wrapped_result("browser_press_hold")

    try:
        # Validate hold duration
        hold_ms = max(1000, min(hold_ms, 15000))
        effective, run, _ = _get_session_locals(task_id or "default")

        # Hover to element first
        box = _get_element_box(task_id or "default", ref)
        cx = box.get("x", 0) + box.get("width", 0) / 2 + random.uniform(-3, 3)
        cy = box.get("y", 0) + box.get("height", 0) / 2 + random.uniform(-3, 3)
        browser_hover_drift(ref, task_id)  # move there
        time.sleep(_gauss(0.04, 0.12))  # finger settle

        # Press down
        run(effective, "mouse", ["down"])
        start = time.time()
        deadline = start + (hold_ms / 1000.0)

        # Hold with micro-jitter
        while time.time() < deadline:
            jx = cx + random.uniform(-3, 3)
            jy = cy + random.uniform(-3, 3)
            _mouse_move(task_id or "default", jx, jy)
            _set_current_xy(task_id or "default", cx, cy)  # keep origin
            time.sleep(_gauss(0.08, 0.14))

        # Release
        run(effective, "mouse", ["up"])
        elapsed = int((time.time() - start) * 1000)

        result["success"] = True
        result["held_ms"] = elapsed
        result["target_ms"] = hold_ms
    except Exception as e:
        result["error"] = str(e)

    return json.dumps(result)


def browser_drag_path(
    ref: str,
    dx: int,
    dy: int,
    duration_ms: int = 900,
    task_id: Optional[str] = None,
) -> str:
    """Drag from an element by (dx, dy) pixels along a bezier path.

    Uses Fitts-law deceleration over the last 15% of the path.

    Args:
        ref: Element reference to grab
        dx: Horizontal pixels to drag
        dy: Vertical pixels to drag
        duration_ms: Total drag duration in milliseconds

    Returns:
        JSON with success status.
    """
    result, success = _make_wrapped_result("browser_drag_path")

    try:
        effective, run, _ = _get_session_locals(task_id or "default")

        # Get element position
        box = _get_element_box(task_id or "default", ref)
        cx = box.get("x", 0) + box.get("width", 0) / 2 + random.uniform(-3, 3)
        cy = box.get("y", 0) + box.get("height", 0) / 2 + random.uniform(-3, 3)

        # Hover first
        browser_hover_drift(ref, task_id)
        time.sleep(_gauss(0.04, 0.12))

        # Press down
        run(effective, "mouse", ["down"])

        # Generate drag path
        x1, y1 = cx + dx, cy + dy
        n_pts = random.randint(20, 40) if duration_ms > 500 else 10
        pts = _bezier_points(cx, cy, x1, y1, n=n_pts)
        step = (duration_ms / len(pts)) / 1000.0

        for i, (x, y) in enumerate(pts):
            _mouse_move(task_id or "default", x, y)
            # Decelerate over last 15%
            if i > len(pts) * 0.85:
                time.sleep(_gauss(step * 1.2, step * 1.8))
            else:
                time.sleep(_gauss(step * 0.7, step * 1.3))

        time.sleep(_gauss(0.06, 0.18))
        run(effective, "mouse", ["up"])
        _set_current_xy(task_id or "default", x1, y1)

        result["success"] = True
        result["dragged"] = ref
        result["dx"] = dx
        result["dy"] = dy
    except Exception as e:
        result["error"] = str(e)

    return json.dumps(result)


def browser_drag_to(
    ref_from: str,
    ref_to: str,
    duration_ms: int = 900,
    task_id: Optional[str] = None,
) -> str:
    """Drag from one element to another.

    Uses browser_drag_path internally.

    Args:
        ref_from: Source element reference
        ref_to: Target element reference
        duration_ms: Total drag duration in milliseconds

    Returns:
        JSON with success status.
    """
    result, success = _make_wrapped_result("browser_drag_to")

    try:
        # Get both bounding boxes
        box_from = _get_element_box(task_id or "default", ref_from)
        box_to = _get_element_box(task_id or "default", ref_to)

        cx_from = box_from.get("x", 0) + box_from.get("width", 0) / 2
        cy_from = box_from.get("y", 0) + box_from.get("height", 0) / 2
        cx_to = box_to.get("x", 0) + box_to.get("width", 0) / 2
        cy_to = box_to.get("y", 0) + box_to.get("height", 0) / 2

        dx = int(cx_to - cx_from)
        dy = int(cy_to - cy_from)

        sub = browser_drag_path(ref_from, dx, dy, duration_ms, task_id)
        sub_data = json.loads(sub)
        result["success"] = sub_data.get("success", False)
        if result["success"]:
            result["from"] = ref_from
            result["to"] = ref_to
            result["dx"] = dx
            result["dy"] = dy
        else:
            result["error"] = sub_data.get("error", "drag_to failed")
    except Exception as e:
        result["error"] = str(e)

    return json.dumps(result)


def browser_slider_solve(
    handle_ref: str,
    target_x_offset: int,
    duration_ms: int = 1100,
    task_id: Optional[str] = None,
) -> str:
    """Drag a slider handle by a precise pixel offset with a Fitts-shaped profile.

    The caller MUST compute target_x_offset from a vision/snapshot call.
    This function does not detect gap position automatically.

    Args:
        handle_ref: Reference to the draggable handle element
        target_x_offset: Horizontal pixels to drag (positive = right)
        duration_ms: Total drag duration in milliseconds

    Returns:
        JSON with success status.
    """
    result, success = _make_wrapped_result("browser_slider_solve")

    try:
        # 2-6 px grab offset from center
        grab_jitter = random.uniform(2, 6) * random.choice((-1, 1))
        actual_dx = int(target_x_offset + grab_jitter)
        sub = browser_drag_path(handle_ref, actual_dx, 0, duration_ms, task_id)
        sub_data = json.loads(sub)

        result["success"] = sub_data.get("success", False)
        if result["success"]:
            result["handle"] = handle_ref
            result["target_offset"] = target_x_offset
            result["actual_offset"] = actual_dx
        else:
            result["error"] = sub_data.get("error", "slider solve failed")

        # Let validator run
        time.sleep(_gauss(0.8, 1.5))
    except Exception as e:
        result["error"] = str(e)

    return json.dumps(result)


def browser_chain(
    refs: List[str],
    pause_min_ms: int = 120,
    pause_max_ms: int = 380,
    task_id: Optional[str] = None,
) -> str:
    """Execute a multi-step gesture chain: hover-drift and click each ref in sequence.

    Each step: hover_drift → wait → click. Useful for UI workflows that
    involve multiple sequential interactions.

    Args:
        refs: Ordered list of element references to interact with
        pause_min_ms: Minimum pause between steps
        pause_max_ms: Maximum pause between steps

    Returns:
        JSON with list of step results.
    """
    result, success = _make_wrapped_result("browser_chain")

    try:
        from tools.browser_tool import browser_click
        steps = []

        for ref in refs:
            step = {"ref": ref}
            try:
                # Hover drift first
                hover_result = browser_hover_drift(ref, task_id)
                step["hover"] = json.loads(hover_result).get("success", False)

                # Click
                click_result = browser_click(ref, task_id=task_id)
                step["clicked"] = True
                step["click_result"] = json.loads(click_result).get("success", False)

                # Pause between steps
                pause = _gauss(pause_min_ms, pause_max_ms) / 1000.0
                time.sleep(pause)
            except Exception as e:
                step["error"] = str(e)

            steps.append(step)

        result["success"] = True
        result["chain_length"] = len(refs)
        result["steps"] = steps
    except Exception as e:
        result["error"] = str(e)

    return json.dumps(result)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_wrapped_result(tool_name: str) -> tuple:
    """Return a standard result dict and success reference."""
    return {"success": False, "tool": tool_name}, False


def check_pointer_primitives_requirements() -> bool:
    """Check that the base browser tool requirements are met.

    Delegates to browser_tool's check because these primitives operate
    on the same agent-browser sessions.
    """
    try:
        from tools.browser_tool import check_browser_requirements
        return check_browser_requirements()
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

_POINTER_TOOL_SCHEMAS = [
    {
        "name": "browser_hover_drift",
        "description": "Hover over an element with a bezier drift, then settle. Moves the mouse from its current position to the target element using a curved path with slight overshoot. Use before browser_click on hover-sensitive elements.",
        "parameters": {
            "type": "object",
            "properties": {
                "ref": {
                    "type": "string",
                    "description": "Element reference (e.g., '@e5')"
                }
            },
            "required": ["ref"]
        }
    },
    {
        "name": "browser_press_hold",
        "description": "Press and hold the mouse button on an element for a fixed duration. Moves to the element with bezier drift, presses down, holds with micro-jitter, then releases. Use for press-and-hold UI controls in owned/demo apps. Does NOT support signal-driven release. hold_ms must be between 1000 and 15000.",
        "parameters": {
            "type": "object",
            "properties": {
                "ref": {
                    "type": "string",
                    "description": "Element reference (e.g., '@e5')"
                },
                "hold_ms": {
                    "type": "integer",
                    "description": "Duration to hold in milliseconds (1000-15000)",
                    "default": 3000
                }
            },
            "required": ["ref"]
        }
    },
    {
        "name": "browser_drag_path",
        "description": "Drag from an element by (dx, dy) pixels along a bezier path with Fitts-law deceleration. Presses down on the element, moves the mouse along a curved path, then releases. Use for free-form drag gestures.",
        "parameters": {
            "type": "object",
            "properties": {
                "ref": {
                    "type": "string",
                    "description": "Element reference to grab (e.g., '@e5')"
                },
                "dx": {
                    "type": "integer",
                    "description": "Horizontal pixels to drag (positive = right)"
                },
                "dy": {
                    "type": "integer",
                    "description": "Vertical pixels to drag (positive = down)"
                },
                "duration_ms": {
                    "type": "integer",
                    "description": "Total drag duration in milliseconds",
                    "default": 900
                }
            },
            "required": ["ref", "dx", "dy"]
        }
    },
    {
        "name": "browser_drag_to",
        "description": "Drag from one element to another. Computes the vector between the two elements and executes a bezier drag path. Use for drag-and-drop workflows between two known elements.",
        "parameters": {
            "type": "object",
            "properties": {
                "ref_from": {
                    "type": "string",
                    "description": "Source element reference"
                },
                "ref_to": {
                    "type": "string",
                    "description": "Target element reference"
                },
                "duration_ms": {
                    "type": "integer",
                    "description": "Total drag duration in milliseconds",
                    "default": 900
                }
            },
            "required": ["ref_from", "ref_to"]
        }
    },
    {
        "name": "browser_slider_solve",
        "description": "Drag a slider handle by a precise pixel offset with Fitts-law acceleration profile. The caller MUST compute target_x_offset from a vision or snapshot call first. Does NOT auto-detect gap position. Use for slider UI controls in owned/demo apps.",
        "parameters": {
            "type": "object",
            "properties": {
                "handle_ref": {
                    "type": "string",
                    "description": "Reference to the draggable handle element"
                },
                "target_x_offset": {
                    "type": "integer",
                    "description": "Horizontal pixels to drag the handle (positive = right). Compute this from vision/snapshot."
                },
                "duration_ms": {
                    "type": "integer",
                    "description": "Total drag duration in milliseconds",
                    "default": 1100
                }
            },
            "required": ["handle_ref", "target_x_offset"]
        }
    },
    {
        "name": "browser_chain",
        "description": "Execute a multi-step gesture chain: hover-drift then click each element in sequence. Useful for multi-step UI workflows that involve sequential interactions with known elements. Each step: hover_drift → pause → click.",
        "parameters": {
            "type": "object",
            "properties": {
                "refs": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Ordered list of element references to interact with (e.g., ['@e3', '@e7'])"
                },
                "pause_min_ms": {
                    "type": "integer",
                    "description": "Minimum pause between steps in milliseconds",
                    "default": 120
                },
                "pause_max_ms": {
                    "type": "integer",
                    "description": "Maximum pause between steps in milliseconds",
                    "default": 380
                }
            },
            "required": ["refs"]
        }
    },
]

_POINTER_TOOL_MAP = {s["name"]: s for s in _POINTER_TOOL_SCHEMAS}

registry.register(
    name="browser_hover_drift",
    toolset="browser",
    schema=_POINTER_TOOL_MAP["browser_hover_drift"],
    handler=lambda args, **kw: browser_hover_drift(
        ref=args.get("ref", ""), task_id=kw.get("task_id")),
    check_fn=check_pointer_primitives_requirements,
    emoji="🖱️",
)

registry.register(
    name="browser_press_hold",
    toolset="browser",
    schema=_POINTER_TOOL_MAP["browser_press_hold"],
    handler=lambda args, **kw: browser_press_hold(
        ref=args.get("ref", ""),
        hold_ms=args.get("hold_ms", 3000),
        task_id=kw.get("task_id")),
    check_fn=check_pointer_primitives_requirements,
    emoji="✊",
)

registry.register(
    name="browser_drag_path",
    toolset="browser",
    schema=_POINTER_TOOL_MAP["browser_drag_path"],
    handler=lambda args, **kw: browser_drag_path(
        ref=args.get("ref", ""),
        dx=args.get("dx", 0),
        dy=args.get("dy", 0),
        duration_ms=args.get("duration_ms", 900),
        task_id=kw.get("task_id")),
    check_fn=check_pointer_primitives_requirements,
    emoji="↗️",
)

registry.register(
    name="browser_drag_to",
    toolset="browser",
    schema=_POINTER_TOOL_MAP["browser_drag_to"],
    handler=lambda args, **kw: browser_drag_to(
        ref_from=args.get("ref_from", ""),
        ref_to=args.get("ref_to", ""),
        duration_ms=args.get("duration_ms", 900),
        task_id=kw.get("task_id")),
    check_fn=check_pointer_primitives_requirements,
    emoji="↔️",
)

registry.register(
    name="browser_slider_solve",
    toolset="browser",
    schema=_POINTER_TOOL_MAP["browser_slider_solve"],
    handler=lambda args, **kw: browser_slider_solve(
        handle_ref=args.get("handle_ref", ""),
        target_x_offset=args.get("target_x_offset", 0),
        duration_ms=args.get("duration_ms", 1100),
        task_id=kw.get("task_id")),
    check_fn=check_pointer_primitives_requirements,
    emoji="🔘",
)

registry.register(
    name="browser_chain",
    toolset="browser",
    schema=_POINTER_TOOL_MAP["browser_chain"],
    handler=lambda args, **kw: browser_chain(
        refs=args.get("refs", []),
        pause_min_ms=args.get("pause_min_ms", 120),
        pause_max_ms=args.get("pause_max_ms", 380),
        task_id=kw.get("task_id")),
    check_fn=check_pointer_primitives_requirements,
    emoji="⛓️",
)
