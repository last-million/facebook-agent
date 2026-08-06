"""
register_pointer.py — structured pointer-based operations over Facebook Agent register files.

Operates directly on flat text register files at
/mnt/c/Users/Administrator/Desktop/facbeook agent/data/

All functions return structured JSON, use const-ordering (read before write,
ask before destructive), and provide path-escape protection.

Registered tools (toolset='file'):
  register_read        — Read a register file with line count, preview, metadata
  register_append      — Append line(s) atomically to a register file
  register_prepend     — Prepend line(s) atomically (after header comments)
  register_remove      — Remove lines by content pattern with confirmation guard
  register_query       — Cross-register pattern search
  register_stats       — Stats overview across all register files
"""

import json
import logging
import os
import re
import shutil
import stat
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

from tools.registry import registry

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_DATA_DIR = Path(
    "/mnt/c/Users/Administrator/Desktop/facbeook agent/data"
)

# Canonical register filenames — used for validation, stats, and discovery.
_REGISTER_NAMES: List[str] = [
    "accounts-to-review.txt",
    "affiliate-links.txt",
    "down-facebook-profiles.txt",
    "errors.txt",
    "failed-ips.txt",
    "inactive-accounts.txt",
    "invalid-proxies.txt",
    "limited-accounts.txt",
    "pending-approvals.txt",
    "product-candidates.jsonl",
    "product-review-images.txt",
    "used-comment-leadins.txt",
    "used-post-texts.txt",
    "used-products.txt",
]

# Max lines returned in content_preview per operation.
_PREVIEW_MAX = 50


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _resolve_register(register_name: str) -> Path:
    """Resolve *register_name* to an absolute path under ``_DATA_DIR``.

    Raises ``ValueError`` on path-escape attempts (e.g. ``../../etc/passwd``).
    Returns the resolved path even if the file does not yet exist — callers
    must handle FileNotFoundError separately.
    """
    # Reject empty / None / non-string
    if not register_name or not isinstance(register_name, str):
        raise ValueError(
            f"register_name must be a non-empty string, got {type(register_name).__name__}"
        )

    if register_name not in _REGISTER_NAMES:
        raise ValueError(
            "Unknown register_name. Allowed values: " + ", ".join(_REGISTER_NAMES)
        )

    # Reject absolute paths
    if os.path.isabs(register_name):
        raise ValueError(
            f"Path escape blocked: absolute paths not allowed ({register_name})"
        )

    # Reject parent-directory traversal
    cleaned = Path(register_name).as_posix()
    if ".." in cleaned.split("/"):
        raise ValueError(
            f"Path escape blocked: '..' not allowed in register_name ({register_name})"
        )

    resolved = (_DATA_DIR / cleaned).resolve()

    # Double-check: resolved must be under _DATA_DIR
    try:
        resolved.relative_to(_DATA_DIR.resolve())
    except ValueError:
        raise ValueError(
            f"Path escape blocked: resolved path {resolved} is outside data directory"
        )

    return resolved


def _read_lines(path: Path) -> List[str]:
    """Read all lines from *path*, preserving trailing newlines only for
    round-trip semantics in append. Stripped lines are returned."""
    if not path.exists():
        raise FileNotFoundError(f"Register file not found: {path}")
    content = path.read_text(encoding="utf-8", errors="replace")
    return content.splitlines(keepends=False)  # stripped


def _classify_lines(lines: List[str]) -> Dict:
    """Split lines into header (comment) and data (non-comment)."""
    header = [l for l in lines if l.strip().startswith("#")]
    data = [l for l in lines if l.strip() and not l.strip().startswith("#")]
    return {"header": header, "data": data, "total": len(lines)}


def _file_metadata(path: Path) -> Dict:
    """Return size, mtime, permissions as a dict."""
    st = path.stat()
    mode = stat.filemode(st.st_mode)
    return {
        "size_bytes": st.st_size,
        "modified_utc": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat(),
        "permissions": mode,
        "path": str(path),
    }


def _content_preview(lines: List[str], max_lines: int = _PREVIEW_MAX) -> List[str]:
    """Return a preview of lines, with a truncation note if needed."""
    if len(lines) <= max_lines:
        return lines
    return lines[:max_lines] + [f"... (truncated, {len(lines)} total lines)"]


def _is_jsonl(path: Path) -> bool:
    """Return True if the register file has .jsonl extension."""
    return path.suffix.lower() == ".jsonl"


def _parse_jsonl_lines(lines: List[str]) -> List[dict]:
    """Parse data lines of a JSONL file into a list of JSON objects.

    Header lines (starting with ``#``) and empty lines are skipped.
    Lines that fail JSON decoding are returned as ``{"__raw__": "<text>", "__parse_error__": "<msg>"}``
    so callers can inspect and fix them.
    """
    parsed: List[dict] = []
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        try:
            parsed.append(json.loads(stripped))
        except json.JSONDecodeError as e:
            parsed.append({"__raw__": stripped, "__parse_error__": str(e)})
    return parsed


def _atomic_append(path: Path, new_lines: List[str]) -> None:
    """Append *new_lines* to *path* atomically.

    Writes to a temp file in the same directory, then renames over the
    original. Preserves existing content if the file already exists.
    """
    # Read existing content (empty string if file doesn't exist yet)
    existing = ""
    if path.exists():
        existing = path.read_text(encoding="utf-8", errors="replace")

    # Build new content
    if existing and not existing.endswith("\n"):
        existing += "\n"

    new_content = "\n".join(new_lines)
    if new_lines:
        new_content += "\n"

    full_content = existing + new_content

    # Atomic write via tempfile + os.replace
    dir_path = path.parent
    dir_path.mkdir(parents=True, exist_ok=True)

    fd, tmp_path = tempfile.mkstemp(
        prefix=f"._tmp_{path.name}_",
        dir=str(dir_path),
    )
    closed = False
    try:
        os.write(fd, full_content.encode("utf-8"))
        os.close(fd)
        closed = True
        os.replace(tmp_path, str(path))
    except BaseException:
        # Clean up temp file on any failure
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        if not closed:
            try:
                os.close(fd)
            except OSError:
                pass
        raise


def _atomic_rewrite(path: Path, lines: List[str]) -> None:
    """Rewrite *path* with *lines* atomically.

    Each line gets a trailing newline. Writes via tempfile + os.replace.
    """
    dir_path = path.parent
    dir_path.mkdir(parents=True, exist_ok=True)

    content = "\n".join(lines)
    if lines:
        content += "\n"

    fd, tmp_path = tempfile.mkstemp(
        prefix=f"._tmp_{path.name}_",
        dir=str(dir_path),
    )
    closed = False
    try:
        os.write(fd, content.encode("utf-8"))
        os.close(fd)
        closed = True
        os.replace(tmp_path, str(path))
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        if not closed:
            try:
                os.close(fd)
            except OSError:
                pass
        raise


def _build_result(
    tool_name: str,
    success: bool = False,
    error: Optional[str] = None,
    **extra,
) -> str:
    """Build a standard JSON result dict."""
    result = {"tool": tool_name, "success": success}
    if error:
        result["error"] = str(error)
    result.update(extra)
    return json.dumps(result)


def _check_file_reqs() -> bool:
    """Check that the data directory exists and is readable."""
    try:
        return _DATA_DIR.exists() and _DATA_DIR.is_dir()
    except OSError:
        return False


def _create_backup(path: Path) -> Optional[Path]:
    """Create a timestamped backup of *path* in a ``.backups/`` subdirectory.

    Returns the backup path, or ``None`` if the source file doesn't exist.
    Used before any destructive write operation (remove, append, prepend).
    """
    if not path.exists():
        return None
    backup_dir = path.parent / ".backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    backup_path = backup_dir / f"{path.name}.{timestamp}.bak"
    shutil.copy2(str(path), str(backup_path))
    logger.debug("Backup created: %s -> %s", path, backup_path)
    return backup_path


# ---------------------------------------------------------------------------
# Tool: register_read
# ---------------------------------------------------------------------------

REGISTER_READ_SCHEMA = {
    "name": "register_read",
    "description": (
        "Read a Facebook Agent register file and return structured JSON with "
        "line count, content preview (header vs data), and file metadata. "
        "This is a READ-ONLY operation — no data is modified."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "register_name": {
                "type": "string",
                "description": (
                    "Name of the register file to read, e.g. "
                    "'accounts-to-review.txt', 'errors.txt', 'used-products.txt'. "
                    "The full canonical list includes: "
                    + ", ".join(_REGISTER_NAMES)
                ),
            },
            "max_preview_lines": {
                "type": "integer",
                "description": "Maximum lines to include in the content preview (default: 50, max: 200).",
                "default": 50,
            },
            "include_full_content": {
                "type": "boolean",
                "description": "If True, return the full file content instead of a truncated preview. Use cautiously with large files.",
                "default": False,
            },
        },
        "required": ["register_name"],
    },
}


def _handle_register_read(args: dict, **kwargs) -> str:
    """Handle register_read."""
    register_name = args.get("register_name")
    max_preview = min(int(args.get("max_preview_lines", 50)), 200)
    include_full = bool(args.get("include_full_content", False))

    try:
        path = _resolve_register(register_name)

        if not path.exists():
            return _build_result(
                "register_read",
                success=False,
                error=f"Register file not found: {register_name}",
            )

        lines = _read_lines(path)
        classified = _classify_lines(lines)
        meta = _file_metadata(path)

        if include_full:
            preview = lines
        else:
            preview = _content_preview(lines, max_preview)

        is_jsonl = _is_jsonl(path)

        # Parse JSONL data lines into structured objects if applicable
        parsed_objects = None
        parse_errors = 0
        if is_jsonl:
            parsed_objects = _parse_jsonl_lines(lines)
            parse_errors = sum(
                1 for p in parsed_objects if p.get("__parse_error__")
            )

        result = {
            "register_name": register_name,
            "file_path": str(path),
            "total_lines": classified["total"],
            "header_lines": len(classified["header"]),
            "data_lines": len(classified["data"]),
            "is_jsonl": is_jsonl,
            "empty": len(classified["data"]) == 0,
            "file_metadata": meta,
            "content_preview": preview,
        }

        if is_jsonl:
            result["parsed_objects"] = parsed_objects
            result["parsed_count"] = len(parsed_objects) if parsed_objects else 0
            result["parse_errors"] = parse_errors

        return _build_result("register_read", success=True, **result)

    except ValueError as e:
        return _build_result("register_read", success=False, error=str(e))
    except FileNotFoundError as e:
        return _build_result("register_read", success=False, error=str(e))
    except Exception as e:
        logger.exception("register_read failed: %s", e)
        return _build_result("register_read", success=False, error=f"Unexpected error: {e}")


# ---------------------------------------------------------------------------
# Tool: register_append
# ---------------------------------------------------------------------------

REGISTER_APPEND_SCHEMA = {
    "name": "register_append",
    "description": (
        "Append one or more lines to a Facebook Agent register file atomically. "
        "Uses a temp-file + rename pattern to prevent partial writes. "
        "Will NOT deduplicate lines — call register_remove first if needed. "
        "CONST ORDER: read-before-write pattern — call register_read first to "
        "understand the register structure before appending."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "register_name": {
                "type": "string",
                "description": "Name of the register file to append to, e.g. 'errors.txt'.",
            },
            "lines": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "One or more lines to append. Each line should follow the "
                    "register's field format (pipe-delimited). Do NOT include "
                    "the '#' comment prefix — this is for data lines only."
                ),
            },
            "confirmed": {
                "type": "boolean",
                "description": (
                    "CONST-ORDER SAFETY: Must be explicitly set to True to confirm "
                    "the append operation. If False or omitted, the tool returns "
                    "a preview of what would be appended without modifying anything."
                ),
                "default": False,
            },
        },
        "required": ["register_name", "lines", "confirmed"],
    },
}


def _handle_register_append(args: dict, **kwargs) -> str:
    """Handle register_append."""
    register_name = args.get("register_name")
    lines_to_add: List[str] = args.get("lines", [])
    confirmed = bool(args.get("confirmed", False))

    try:
        if not lines_to_add:
            return _build_result(
                "register_append",
                success=False,
                error="No lines provided to append",
            )

        path = _resolve_register(register_name)

        # Read current state (for preview and to check file exists)
        current_lines: List[str] = []
        if path.exists():
            current_lines = _read_lines(path)

        # Preview mode (const-ordering: ask before destructive)
        if not confirmed:
            return _build_result(
                "register_append",
                success=False,
                error="Confirmation required. Set confirmed=True to proceed.",
                preview_mode=True,
                register_name=register_name,
                current_line_count=len(current_lines),
                lines_to_append=lines_to_add,
                instruction=(
                    f"Will append {len(lines_to_add)} line(s) to '{register_name}'. "
                    "Review the lines above and call again with confirmed=True."
                ),
            )

        # Execute atomic append
        backup_path = _create_backup(path)
        _atomic_append(path, lines_to_add)

        # Re-read to confirm
        new_lines = _read_lines(path) if path.exists() else []

        return _build_result(
            "register_append",
            success=True,
            register_name=register_name,
            appended_count=len(lines_to_add),
            previous_line_count=len(current_lines),
            new_line_count=len(new_lines),
            appended_lines=lines_to_add,
            backup_path=str(backup_path) if backup_path else None,
        )

    except ValueError as e:
        return _build_result("register_append", success=False, error=str(e))
    except Exception as e:
        logger.exception("register_append failed: %s", e)
        return _build_result("register_append", success=False, error=f"Unexpected error: {e}")


# ---------------------------------------------------------------------------
# Tool: register_prepend
# ---------------------------------------------------------------------------

REGISTER_PREPEND_SCHEMA = {
    "name": "register_prepend",
    "description": (
        "Prepend one or more lines to the BEGINNING of a Facebook Agent register "
        "file atomically. Lines are inserted after any header/comment lines "
        "(lines starting with '#') so that the register's field header is "
        "preserved at the top. Uses a temp-file + rename pattern to prevent "
        "partial writes. "
        "CONST ORDER: read-before-write pattern — call register_read first to "
        "understand the register structure before prepending."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "register_name": {
                "type": "string",
                "description": "Name of the register file to prepend to, e.g. 'errors.txt'.",
            },
            "lines": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "One or more lines to prepend. Each line should follow the "
                    "register's field format (pipe-delimited). Do NOT include "
                    "the '#' comment prefix — this is for data lines only."
                ),
            },
            "confirmed": {
                "type": "boolean",
                "description": (
                    "CONST-ORDER SAFETY: Must be explicitly set to True to confirm "
                    "the prepend operation. If False or omitted, the tool returns "
                    "a preview of what would be prepended without modifying anything."
                ),
                "default": False,
            },
        },
        "required": ["register_name", "lines", "confirmed"],
    },
}


def _handle_register_prepend(args: dict, **kwargs) -> str:
    """Handle register_prepend."""
    register_name = args.get("register_name")
    lines_to_add: List[str] = args.get("lines", [])
    confirmed = bool(args.get("confirmed", False))

    try:
        if not lines_to_add:
            return _build_result(
                "register_prepend",
                success=False,
                error="No lines provided to prepend",
            )

        path = _resolve_register(register_name)

        # Read current state (for preview and to check file exists)
        current_lines: List[str] = []
        if path.exists():
            current_lines = _read_lines(path)

        # Preview mode (const-ordering: ask before destructive)
        if not confirmed:
            return _build_result(
                "register_prepend",
                success=False,
                error="Confirmation required. Set confirmed=True to proceed.",
                preview_mode=True,
                register_name=register_name,
                current_line_count=len(current_lines),
                lines_to_prepend=lines_to_add,
                instruction=(
                    f"Will prepend {len(lines_to_add)} line(s) to '{register_name}'. "
                    "Review the lines above and call again with confirmed=True."
                ),
            )

        # Separate header lines from data lines so we insert after headers
        header_lines = [l for l in current_lines if l.strip().startswith("#")]
        data_lines = [l for l in current_lines if l.strip() and not l.strip().startswith("#")]
        empty_or_other = [l for l in current_lines if not l.strip()]

        # Prepend: new lines go after headers, before existing data
        new_lines = list(header_lines) + list(lines_to_add) + list(empty_or_other) + list(data_lines)

        # Backup before destructive prepend
        backup_path = _create_backup(path)
        _atomic_rewrite(path, new_lines)

        # Re-read to confirm
        final_lines = _read_lines(path) if path.exists() else []

        return _build_result(
            "register_prepend",
            success=True,
            register_name=register_name,
            prepended_count=len(lines_to_add),
            previous_line_count=len(current_lines),
            new_line_count=len(final_lines),
            prepended_lines=lines_to_add,
            backup_path=str(backup_path) if backup_path else None,
        )

    except ValueError as e:
        return _build_result("register_prepend", success=False, error=str(e))
    except Exception as e:
        logger.exception("register_prepend failed: %s", e)
        return _build_result("register_prepend", success=False, error=f"Unexpected error: {e}")


# ---------------------------------------------------------------------------
# Tool: register_remove
# ---------------------------------------------------------------------------

REGISTER_REMOVE_SCHEMA = {
    "name": "register_remove",
    "description": (
        "Remove lines from a Facebook Agent register file by content pattern "
        "(regex). Lines matching the pattern are removed. This is a "
        "DESTRUCTIVE operation — CONST ORDER requires confirming destructive "
        "operations explicitly. Removed lines are returned in the result so "
        "they can be reverted if needed."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "register_name": {
                "type": "string",
                "description": "Name of the register file to modify, e.g. 'errors.txt'.",
            },
            "pattern": {
                "type": "string",
                "description": (
                    "Regex pattern to match lines for removal. Only DATA lines "
                    "(non-comment, non-empty) are matched. Header/comment lines "
                    "and empty lines are NEVER removed. Anchored match — the "
                    "pattern is checked via re.search() against each data line."
                ),
            },
            "confirmed": {
                "type": "boolean",
                "description": (
                    "CONST-ORDER SAFETY: Must be explicitly set to True to confirm "
                    "the destructive removal. If False or omitted, the tool returns "
                    "a preview of which lines WOULD be removed without modifying anything."
                ),
                "default": False,
            },
            "max_remove": {
                "type": "integer",
                "description": "Maximum number of matching lines to remove (default: 0 = unlimited).",
                "default": 0,
            },
        },
        "required": ["register_name", "pattern"],
    },
}


def _handle_register_remove(args: dict, **kwargs) -> str:
    """Handle register_remove."""
    register_name = args.get("register_name")
    pattern = args.get("pattern", "")
    confirmed = bool(args.get("confirmed", False))
    max_remove = int(args.get("max_remove", 0))

    try:
        if not pattern:
            return _build_result(
                "register_remove",
                success=False,
                error="No pattern provided for removal",
            )

        path = _resolve_register(register_name)

        if not path.exists():
            return _build_result(
                "register_remove",
                success=False,
                error=f"Register file not found: {register_name}",
            )

        lines = _read_lines(path)

        # Compile pattern
        try:
            compiled = re.compile(pattern)
        except re.error as e:
            return _build_result(
                "register_remove", success=False, error=f"Invalid regex pattern: {e}"
            )

        # Identify matching data lines and their indices
        matching_indices: List[int] = []
        matching_lines: List[str] = []

        for i, line in enumerate(lines):
            stripped = line.strip()
            if stripped and not stripped.startswith("#"):
                if compiled.search(stripped):
                    matching_indices.append(i)
                    matching_lines.append(line)

        if not matching_lines:
            return _build_result(
                "register_remove",
                success=True,
                register_name=register_name,
                pattern=pattern,
                matched_count=0,
                message="No matching data lines found for the given pattern",
            )

        # Apply max_remove truncation
        if max_remove > 0 and len(matching_indices) > max_remove:
            matching_indices = matching_indices[:max_remove]
            matching_lines = matching_lines[:max_remove]

        # Preview mode (const-ordering: ask before destructive)
        if not confirmed:
            return _build_result(
                "register_remove",
                preview_mode=True,
                register_name=register_name,
                pattern=pattern,
                matched_count=len(matching_lines),
                lines_to_remove=matching_lines,
                instruction=(
                    f"This would remove {len(matching_lines)} matching line(s) from "
                    f"'{register_name}'. Review the lines above and call again with "
                    "confirmed=True to proceed."
                ),
            )

        # Execute removal: keep non-matching lines (all header/comment lines and
        # non-matching data lines are preserved)
        remove_set = set(matching_indices)
        kept_lines = [line for i, line in enumerate(lines) if i not in remove_set]

        backup_path = _create_backup(path)
        _atomic_rewrite(path, kept_lines)
        removed_count = len(matching_indices)
        deleted_count = len(lines) - len(kept_lines)

        return _build_result(
            "register_remove",
            success=True,
            register_name=register_name,
            pattern=pattern,
            removed_count=removed_count,
            deleted_count=deleted_count,
            previous_line_count=len(lines),
            new_line_count=len(kept_lines),
            removed_lines=matching_lines,
            backup_path=str(backup_path) if backup_path else None,
        )

    except ValueError as e:
        return _build_result("register_remove", success=False, error=str(e))
    except Exception as e:
        logger.exception("register_remove failed: %s", e)
        return _build_result("register_remove", success=False, error=f"Unexpected error: {e}")


# ---------------------------------------------------------------------------
# Tool: register_query
# ---------------------------------------------------------------------------

REGISTER_QUERY_SCHEMA = {
    "name": "register_query",
    "description": (
        "Search across one or more Facebook Agent register files for lines "
        "matching a pattern. Supports single-register and multi-register "
        "(cross-register) queries. Returns a structured summary of matches "
        "per register. This is a READ-ONLY operation."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "pattern": {
                "type": "string",
                "description": "Regex pattern to search for in register data lines (non-comment lines only).",
            },
            "register_names": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "Optional: specific register file(s) to search. If omitted, "
                    "all register files are searched (cross-register query)."
                ),
                "default": [],
            },
            "include_context": {
                "type": "boolean",
                "description": "If True, include surrounding header context for each match.",
                "default": True,
            },
            "max_matches_per_register": {
                "type": "integer",
                "description": "Maximum matches to return per register file (default: 50).",
                "default": 50,
            },
        },
        "required": ["pattern"],
    },
}


def _handle_register_query(args: dict, **kwargs) -> str:
    """Handle register_query."""
    pattern = args.get("pattern", "")
    register_names: List[str] = args.get("register_names", []) or []
    include_context = bool(args.get("include_context", True))
    max_per = int(args.get("max_matches_per_register", 50))

    try:
        if not pattern:
            return _build_result(
                "register_query", success=False, error="No pattern provided for query"
            )

        try:
            compiled = re.compile(pattern, re.IGNORECASE)
        except re.error as e:
            return _build_result(
                "register_query", success=False, error=f"Invalid regex pattern: {e}"
            )

        # Determine which files to search
        if register_names:
            search_names = register_names
        else:
            search_names = _REGISTER_NAMES

        results: Dict[str, Dict] = {}

        for rname in search_names:
            try:
                path = _resolve_register(rname)
            except ValueError:
                continue

            if not path.exists():
                results[rname] = {
                    "exists": False,
                    "match_count": 0,
                    "matches": [],
                }
                continue

            lines = _read_lines(path)
            classified = _classify_lines(lines)

            matches = []
            for line in classified["data"]:
                if compiled.search(line):
                    matches.append(line)
                    if len(matches) >= max_per:
                        break

            # Build context-aware match results
            if include_context:
                # Find which header lines precede each match
                match_with_context: List[Dict] = []
                remaining_data = list(classified["data"])
                for m in matches:
                    try:
                        idx = remaining_data.index(m)
                        # Get relevant headers from original file
                        hdr_lines = [
                            l for l in classified["header"]
                            if l.strip().startswith("# fields")
                            or l.strip().startswith("# allowed")
                        ]
                        match_with_context.append({
                            "line": m,
                            "field_headers": hdr_lines[:3] if hdr_lines else [],
                        })
                        remaining_data[idx] = None  # mark used
                    except ValueError:
                        match_with_context.append({"line": m, "field_headers": []})
                matches_out = match_with_context
            else:
                matches_out = matches

            meta = _file_metadata(path)

            results[rname] = {
                "exists": True,
                "total_lines": len(lines),
                "data_lines": len(classified["data"]),
                "match_count": len(matches),
                "truncated": len(matches) >= max_per,
                "matches": matches_out,
                "file_metadata": meta,
            }

        total_matches = sum(r.get("match_count", 0) for r in results.values())
        registers_searched = len([r for r in results.values() if r.get("exists")])

        return _build_result(
            "register_query",
            success=True,
            pattern=pattern,
            total_matches=total_matches,
            registers_searched=registers_searched,
            registers_with_matches=sum(
                1 for r in results.values() if r.get("match_count", 0) > 0
            ),
            results=results,
        )

    except ValueError as e:
        return _build_result("register_query", success=False, error=str(e))
    except Exception as e:
        logger.exception("register_query failed: %s", e)
        return _build_result("register_query", success=False, error=f"Unexpected error: {e}")


# ---------------------------------------------------------------------------
# Tool: register_stats
# ---------------------------------------------------------------------------

REGISTER_STATS_SCHEMA = {
    "name": "register_stats",
    "description": (
        "Return a structured overview of all Facebook Agent register files: "
        "line counts (header vs data), file sizes, modification times, "
        "and data-to-header ratio. Helps operators understand the current "
        "state of all operational registers at a glance."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "register_names": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "Optional: specific register files to stat. If omitted, "
                    "all known register files are included."
                ),
                "default": [],
            },
        },
        "required": [],
    },
}


def _handle_register_stats(args: dict, **kwargs) -> str:
    """Handle register_stats."""
    register_names: List[str] = args.get("register_names", []) or []

    try:
        names_to_stat = register_names if register_names else _REGISTER_NAMES

        stats: List[Dict] = []
        total_lines_all = 0
        total_data_lines_all = 0
        total_size_bytes = 0
        existing_count = 0

        for rname in names_to_stat:
            try:
                path = _resolve_register(rname)
            except ValueError:
                continue

            entry = {
                "register_name": rname,
                "exists": False,
                "total_lines": 0,
                "header_lines": 0,
                "data_lines": 0,
                "size_bytes": 0,
                "is_jsonl": False,
            }

            if path.exists():
                lines = _read_lines(path)
                classified = _classify_lines(lines)
                meta = _file_metadata(path)
                existing_count += 1
                total_lines_all += classified["total"]
                total_data_lines_all += len(classified["data"])
                total_size_bytes += meta["size_bytes"]

                entry["exists"] = True
                entry["total_lines"] = classified["total"]
                entry["header_lines"] = len(classified["header"])
                entry["data_lines"] = len(classified["data"])
                entry["size_bytes"] = meta["size_bytes"]
                entry["modified_utc"] = meta["modified_utc"]
                entry["permissions"] = meta["permissions"]
                entry["is_jsonl"] = _is_jsonl(path)
                entry["empty"] = len(classified["data"]) == 0

            stats.append(entry)

        summary = {
            "total_registers_known": len(names_to_stat),
            "total_registers_existing": existing_count,
            "total_lines_across_all": total_lines_all,
            "total_data_lines_across_all": total_data_lines_all,
            "total_size_bytes": total_size_bytes,
            "average_data_lines_per_register": round(
                total_data_lines_all / max(existing_count, 1), 1
            ),
        }

        return _build_result(
            "register_stats",
            success=True,
            data_directory=str(_DATA_DIR.resolve()),
            summary=summary,
            registers=stats,
        )

    except Exception as e:
        logger.exception("register_stats failed: %s", e)
        return _build_result("register_stats", success=False, error=f"Unexpected error: {e}")


# ---------------------------------------------------------------------------
# Registry: register all tools under toolset='file'
# ---------------------------------------------------------------------------

registry.register(
    name="register_read",
    toolset="file",
    schema=REGISTER_READ_SCHEMA,
    handler=_handle_register_read,
    check_fn=_check_file_reqs,
    emoji="📋",
    description=(
        "Read a Facebook Agent register file and return structured JSON with "
        "line count, content preview, file metadata."
    ),
)

registry.register(
    name="register_append",
    toolset="file",
    schema=REGISTER_APPEND_SCHEMA,
    handler=_handle_register_append,
    check_fn=_check_file_reqs,
    emoji="📝",
    description=(
        "Append lines to a Facebook Agent register file atomically. "
        "Const-order: read before write — requires confirmed=True to proceed."
    ),
)

registry.register(
    name="register_prepend",
    toolset="file",
    schema=REGISTER_PREPEND_SCHEMA,
    handler=_handle_register_prepend,
    check_fn=_check_file_reqs,
    emoji="📌",
    description=(
        "Prepend lines to the beginning of a Facebook Agent register file "
        "atomically. Lines are inserted after header/comment lines. "
        "Const-order: read before write — requires confirmed=True to proceed."
    ),
)

registry.register(
    name="register_remove",
    toolset="file",
    schema=REGISTER_REMOVE_SCHEMA,
    handler=_handle_register_remove,
    check_fn=_check_file_reqs,
    emoji="🗑️",
    description=(
        "Remove lines from a register file by content pattern. "
        "Const-order: ask before destructive — requires confirmed=True."
    ),
)

registry.register(
    name="register_query",
    toolset="file",
    schema=REGISTER_QUERY_SCHEMA,
    handler=_handle_register_query,
    check_fn=_check_file_reqs,
    emoji="🔍",
    description=(
        "Search across one or more register files for lines matching a pattern. "
        "Supports cross-register queries. Read-only."
    ),
)

registry.register(
    name="register_stats",
    toolset="file",
    schema=REGISTER_STATS_SCHEMA,
    handler=_handle_register_stats,
    check_fn=_check_file_reqs,
    emoji="📊",
    description=(
        "Return structured stats overview across all Facebook Agent register "
        "files: line counts, sizes, modification times."
    ),
)
