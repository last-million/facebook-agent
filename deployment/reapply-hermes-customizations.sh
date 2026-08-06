#!/usr/bin/env bash
# =============================================================================
#  Facebook Agent - re-apply OUR Hermes customizations
# =============================================================================
#  A Hermes update (git pull of hermes-agent, a fresh clone, a reinstall) wipes
#  the local changes this project depends on. This script puts them back:
#
#    ~/.hermes/SOUL.md                       <- hermes-config/SOUL.md
#    ~/.hermes/.skills_prompt_snapshot.json  <- hermes-config/skills_prompt_snapshot.json
#    ~/.hermes/config.yaml                   <- hermes-config/config.yaml
#                                               (only if missing; --force-config overwrites)
#    ~/.hermes/custom/facebook-agent/*       <- hermes-config/custom/facebook-agent/*
#    hermes-agent/tools/*.py                 <- hermes-config/tools/*
#    hermes-agent source fixes               <- hermes-config/patches/*.patch
#
#  Idempotent: safe to run after every Hermes update. deploy.sh runs it on
#  every deploy; run it by hand after a manual Hermes update:
#
#      bash deployment/reapply-hermes-customizations.sh
#
#  The pipx install of hermes-agent on our machines is EDITABLE (it points at
#  the ~/hermes-agent checkout), so patched Python files go live immediately -
#  no reinstall needed. If a patch touches web/ sources (the Hermes web UI),
#  that UI needs its own rebuild to pick the change up; the Facebook dashboard
#  (server.js) does not.
# =============================================================================
set -uo pipefail   # NOT -e: one bad file must not abort the rest.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# FB_REPO_DIR matters when deploy.sh runs a CRLF-stripped COPY of this script
# from /tmp - without it, REPO_DIR would resolve to the copy's parent.
REPO_DIR="${FB_REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
CFG="$REPO_DIR/hermes-config"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
HERMES_DIR="${HERMES_DIR:-$HERMES_HOME/hermes-agent}"
FORCE_CONFIG=0
[ "${1:-}" = "--force-config" ] && FORCE_CONFIG=1

ok()   { printf '    OK    %s\n' "$1"; }
info() { printf '          %s\n' "$1"; }
warn() { printf '    WARN  %s\n' "$1"; }

echo " Re-applying Facebook-Agent Hermes customizations"
echo "   from: $CFG"
echo "   to:   $HERMES_HOME  (+ $HERMES_DIR)"

if [ ! -d "$CFG" ]; then
  warn "no hermes-config/ in this repo - nothing to apply"
  exit 0
fi
mkdir -p "$HERMES_HOME"

# --- 1. ~/.hermes config files -------------------------------------------------
[ -f "$CFG/SOUL.md" ] && cp "$CFG/SOUL.md" "$HERMES_HOME/SOUL.md" && ok "SOUL.md"
if [ -f "$CFG/skills_prompt_snapshot.json" ]; then
  cp "$CFG/skills_prompt_snapshot.json" "$HERMES_HOME/.skills_prompt_snapshot.json" && ok "skills prompt snapshot"
fi
# config.yaml holds OUR model order / provider choices. Its api_key fields are
# EMPTY by design - keys live in ~/.hermes/.env, which is never touched here.
# Do not clobber an existing config.yaml: it may carry machine-specific edits.
if [ -f "$CFG/config.yaml" ]; then
  if [ ! -f "$HERMES_HOME/config.yaml" ] || [ "$FORCE_CONFIG" = "1" ]; then
    cp "$CFG/config.yaml" "$HERMES_HOME/config.yaml" && ok "config.yaml (ours)"
  else
    info "config.yaml exists - keeping it (--force-config overwrites with ours)"
  fi
fi

# --- 2. custom tool files -------------------------------------------------------
if [ -d "$CFG/custom" ]; then
  mkdir -p "$HERMES_HOME/custom"
  cp -r "$CFG/custom/." "$HERMES_HOME/custom/" && ok "custom/ -> ~/.hermes/custom/"
fi
shopt -s nullglob
TOOLFILES=("$CFG/tools/"*.py)
if [ ${#TOOLFILES[@]} -gt 0 ]; then
  if [ -d "$HERMES_DIR/tools" ]; then
    cp "${TOOLFILES[@]}" "$HERMES_DIR/tools/" && ok "tools: ${#TOOLFILES[@]} file(s) -> hermes-agent/tools/"
  else
    warn "no hermes-agent checkout at $HERMES_DIR - skipped tools: ${#TOOLFILES[@]} file(s)"
  fi
fi

# --- 3. source patches ----------------------------------------------------------
# Applied onto the hermes-agent checkout. Detects "already applied" so repeated
# runs are harmless. If Hermes upstream changed the same lines, the patch will
# not apply - warn loudly instead of silently half-patching.
PATCHES=("$CFG/patches/"*.patch)
if [ ${#PATCHES[@]} -gt 0 ]; then
  if [ ! -d "$HERMES_DIR/.git" ]; then
    warn "no hermes-agent checkout at $HERMES_DIR - cannot apply ${#PATCHES[@]} patch(es)"
  else
    for p in "${PATCHES[@]}"; do
      name="$(basename "$p")"
      [ -s "$p" ] || { info "$name is empty - skipped"; continue; }
      if git -C "$HERMES_DIR" apply --reverse --check "$p" >/dev/null 2>&1; then
        ok "$name already applied"
      elif git -C "$HERMES_DIR" apply --check "$p" >/dev/null 2>&1; then
        if git -C "$HERMES_DIR" apply "$p" >/dev/null 2>&1; then
          ok "$name applied"
          grep -q '^diff --git a/web/' "$p" && info "note: $name touches web/ - rebuild the Hermes web UI if you use it"
        else
          warn "$name checked clean but failed to apply - investigate $HERMES_DIR"
        fi
      else
        warn "$name DOES NOT APPLY cleanly - Hermes upstream changed these files."
        info "to regenerate: re-apply the intent by hand in $HERMES_DIR, then run:"
        info "  git -C \"$HERMES_DIR\" diff > \"$CFG/patches/$name\""
      fi
    done
  fi
fi

echo " Done."
exit 0
