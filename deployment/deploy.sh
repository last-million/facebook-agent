#!/usr/bin/env bash
# =============================================================================
#  Facebook Agent - Linux / WSL / macOS deploy
# =============================================================================
#  Installs everything missing on THIS machine, skipping whatever is already
#  there: system packages -> Node.js -> npm deps -> Hermes agent -> data dir.
#
#  Usage (from anywhere):
#      bash deployment/deploy.sh              install what is missing
#      bash deployment/deploy.sh --check      report only, install NOTHING
#
#  Windows users: run deployment\deploy.bat instead. It installs the Windows
#  side (Node, Git, WSL, the watchdog) and then calls THIS script inside WSL to
#  do the Hermes half.
#
#  TWO MODES, one file:
#    full          (default) everything below - for running the agent on Linux
#    Hermes only   set FB_HERMES_ONLY=1 - used by bootstrap.ps1, because on a
#                  Windows install the dashboard runs on the WINDOWS Node, and
#                  installing a second Node inside WSL would be pure waste.
#
#  Hermes Agent = Nous Research, MIT licensed:
#    https://github.com/NousResearch/hermes-agent
# =============================================================================
set -uo pipefail   # NOT -e: this script decides for itself what is fatal, so a
                   # single optional package failing cannot abort the whole run.

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1
[ "${1:-}" = "-check" ] && CHECK_ONLY=1
HERMES_ONLY="${FB_HERMES_ONLY:-0}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Normally the repo is this script's parent. FB_REPO_DIR overrides that for the
# case where the caller runs a COPY of this file (bootstrap.ps1 copies it to /tmp
# so it can strip CRLF without modifying your checkout) - without the override,
# REPO_DIR would resolve to the copy's parent and every repo path would be wrong.
REPO_DIR="${FB_REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
HERMES_DIR="${HERMES_DIR:-$HOME/.hermes/hermes-agent}"
HERMES_REPO="https://github.com/NousResearch/hermes-agent.git"
HERMES_PIN="${HERMES_PIN:-}"   # optional: pin to a commit/tag (this box ran 0.13.0 / 3034eee38)

MISSING=""
step() { printf '\n[%s] %s\n' "$1" "$2"; }
ok()   { printf '    OK    %s\n' "$1"; }
info() { printf '          %s\n' "$1"; }
warn() { printf '    WARN  %s\n' "$1"; }
fail() { printf '    FAIL  %s\n' "$1"; }
need() { MISSING="$MISSING $1"; fail "$1 is missing"; [ -n "${2:-}" ] && info "$2"; return 0; }
have() { command -v "$1" >/dev/null 2>&1; }

# Only use sudo when we are not already root AND sudo exists. On WSL we run as
# root, and many minimal images have no sudo at all.
SUDO=""
if [ "$(id -u)" -ne 0 ]; then have sudo && SUDO="sudo"; fi

echo "=============================================================="
if [ "$CHECK_ONLY" = "1" ]; then
  echo " Facebook Agent - deploy (CHECK ONLY, installs nothing)"
else
  echo " Facebook Agent - deploy"
fi
echo " Repo:   $REPO_DIR"
[ "$HERMES_ONLY" = "1" ] && echo " Mode:   Hermes only (called from the Windows installer)"
echo "=============================================================="

# --- self-update ---------------------------------------------------------------
# A re-run must also mean "newest code" (the 2026-08-06 lesson: new files plus
# an old running process = 404s everywhere). Pull fast-forward only; if HEAD
# moved, re-exec this script from the fresh checkout, because bash would
# otherwise keep executing the old bytes mid-file. Skipped for --check, and
# guarded against re-exec loops via FB_DEPLOY_REPULLED.
if [ "$CHECK_ONLY" != "1" ] && [ "${FB_DEPLOY_REPULLED:-0}" != "1" ] && [ -d "$REPO_DIR/.git" ] && have git; then
  BEFORE="$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || echo none)"
  if git -C "$REPO_DIR" pull --ff-only >/dev/null 2>&1; then
    AFTER="$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || echo none)"
    if [ "$BEFORE" != "$AFTER" ]; then
      ok "pulled new code from GitHub - restarting this script on it"
      SELF="$REPO_DIR/deployment/deploy.sh"
      [ -f "$SELF" ] || SELF="$0"
      FB_DEPLOY_REPULLED=1 FB_REPO_DIR="$REPO_DIR" exec bash "$SELF" "$@"
    fi
    ok "code already up to date with GitHub"
  else
    warn "git pull did not apply cleanly - keeping local code as-is"
  fi
fi

# --- platform -----------------------------------------------------------------
OS="$(uname -s 2>/dev/null || echo unknown)"
IS_WSL=0
grep -qi microsoft /proc/version 2>/dev/null && IS_WSL=1
PKG=""
if   have apt-get; then PKG="apt"
elif have dnf;     then PKG="dnf"
elif have yum;     then PKG="yum"
elif have brew;    then PKG="brew"
fi
step 0 "Platform"
ok "$OS$([ "$IS_WSL" = "1" ] && echo ' (WSL)')  package manager: ${PKG:-none detected}"

# --- 1. base packages ---------------------------------------------------------
step 1 "Base packages (git, curl, python3, pip, venv)"
NEED_PKGS=""
for c in git curl python3; do have "$c" || NEED_PKGS="$NEED_PKGS $c"; done
# python3-venv has no binary of its own; probe the module instead.
python3 -c 'import venv' >/dev/null 2>&1 || NEED_PKGS="$NEED_PKGS python3-venv"
if [ -z "$NEED_PKGS" ]; then
  ok "all present"
elif [ "$CHECK_ONLY" = "1" ]; then
  need "base packages:$NEED_PKGS" "installed by this script"
elif [ -z "$PKG" ]; then
  warn "no known package manager; install by hand:$NEED_PKGS"
  MISSING="$MISSING base-packages"
else
  info "installing:$NEED_PKGS"
  case "$PKG" in
    apt) $SUDO apt-get update -y >/dev/null 2>&1
         $SUDO apt-get install -y git curl python3 python3-pip python3-venv >/dev/null 2>&1 ;;
    dnf) $SUDO dnf install -y git curl python3 python3-pip >/dev/null 2>&1 ;;
    yum) $SUDO yum install -y git curl python3 python3-pip >/dev/null 2>&1 ;;
    brew) brew install git curl python3 >/dev/null 2>&1 ;;
  esac
  STILL=""
  for c in git curl python3; do have "$c" || STILL="$STILL $c"; done
  if [ -z "$STILL" ]; then ok "installed"; else fail "still missing:$STILL"; MISSING="$MISSING base-packages"; fi
fi

# --- 2. uv (used by Hermes' own setup script) ---------------------------------
step 2 "uv (Python package manager used by Hermes)"
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
if have uv; then
  ok "$(uv --version 2>/dev/null || echo present)"
elif [ "$CHECK_ONLY" = "1" ]; then
  info "not present - Hermes' setup script falls back to pipx/pip, so this is optional"
else
  info "installing from astral.sh"
  curl -LsSf https://astral.sh/uv/install.sh 2>/dev/null | sh >/dev/null 2>&1
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
  if have uv; then ok "installed"; else warn "uv install did not take - Hermes will fall back to pipx/pip"; fi
fi

# --- 3 + 4. Node.js and npm deps (skipped in Hermes-only mode) ----------------
if [ "$HERMES_ONLY" = "1" ]; then
  step 3 "Node.js + npm dependencies"
  ok "skipped - the dashboard runs on the Windows Node (Hermes-only mode)"
else
  step 3 "Node.js 18+"
  NODE_OK=0
  if have node; then
    NODE_MAJOR="$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)"
    if [ -n "$NODE_MAJOR" ] && [ "$NODE_MAJOR" -ge 18 ] 2>/dev/null; then NODE_OK=1; fi
  fi
  if [ "$NODE_OK" = "1" ]; then
    ok "node $(node -v)"
  elif [ "$CHECK_ONLY" = "1" ]; then
    need "Node.js 18+" "https://nodejs.org or your distro's nodesource package"
  else
    info "installing Node.js LTS"
    case "$PKG" in
      apt) curl -fsSL https://deb.nodesource.com/setup_lts.x 2>/dev/null | $SUDO -E bash - >/dev/null 2>&1
           $SUDO apt-get install -y nodejs >/dev/null 2>&1 ;;
      dnf|yum) curl -fsSL https://rpm.nodesource.com/setup_lts.x 2>/dev/null | $SUDO -E bash - >/dev/null 2>&1
           $SUDO "$PKG" install -y nodejs >/dev/null 2>&1 ;;
      brew) brew install node >/dev/null 2>&1 ;;
      *)   warn "no package manager - install Node 18+ from https://nodejs.org" ;;
    esac
    if have node; then ok "node $(node -v)"; else fail "Node still missing"; MISSING="$MISSING Node.js"; fi
  fi

  step 4 "npm dependencies (cheerio + playwright-core)"
  # playwright-core ships NO browsers on purpose: the connector only ever calls
  # chromium.connectOverCDP() against ixBrowser's Chrome, so there is nothing
  # else to download here.
  if [ -d "$REPO_DIR/node_modules/playwright-core" ] && [ -d "$REPO_DIR/node_modules/cheerio" ]; then
    ok "already installed"
  elif [ ! -f "$REPO_DIR/package.json" ]; then
    warn "no package.json at $REPO_DIR - is this the repo?"
  elif [ "$CHECK_ONLY" = "1" ]; then
    need "node_modules" "npm install (in $REPO_DIR)"
  elif have npm; then
    ( cd "$REPO_DIR" && npm install --no-audit --no-fund >/dev/null 2>&1 ) \
      && ok "installed" || { fail "npm install failed"; MISSING="$MISSING node_modules"; }
  else
    fail "npm not available"; MISSING="$MISSING node_modules"
  fi
fi

# --- 5. Hermes agent ----------------------------------------------------------
# server.js shells out to it at exactly $HOME/.local/bin/hermes (HERMES_BIN is
# /root/.local/bin/hermes, i.e. root's HOME), so that is what we verify - being
# on some other PATH entry is not good enough.
step 5 "Hermes agent"
HERMES_BIN="$HOME/.local/bin/hermes"
if [ -x "$HERMES_BIN" ]; then
  ok "$HERMES_BIN present"
elif [ "$CHECK_ONLY" = "1" ]; then
  need "Hermes agent" "installed by this script"
else
  info "clone -> $HERMES_DIR"
  if [ ! -d "$HERMES_DIR/.git" ]; then
    mkdir -p "$(dirname "$HERMES_DIR")"
    git clone "$HERMES_REPO" "$HERMES_DIR" >/dev/null 2>&1 || { fail "git clone of hermes-agent failed"; MISSING="$MISSING Hermes"; }
  else
    info "already cloned; pulling latest"
    git -C "$HERMES_DIR" pull --ff-only >/dev/null 2>&1 || true
  fi
  if [ -n "$HERMES_PIN" ]; then git -C "$HERMES_DIR" checkout "$HERMES_PIN" >/dev/null 2>&1 || true; fi
  if [ -d "$HERMES_DIR" ]; then
    info "building (its own setup script: venv + deps + the 'hermes' CLI)"
    ( cd "$HERMES_DIR" && bash setup-hermes.sh ) >/dev/null 2>&1 \
      || ( cd "$HERMES_DIR" && pipx install ".[all]" ) >/dev/null 2>&1 \
      || ( cd "$HERMES_DIR" && pip install --user ".[all]" ) >/dev/null 2>&1 \
      || true
  fi
  export PATH="$HOME/.local/bin:$PATH"
  if [ -x "$HERMES_BIN" ]; then ok "installed"; else fail "Hermes did not land at $HERMES_BIN"; MISSING="$MISSING Hermes"; fi
fi

# --- 5b. our Hermes customizations --------------------------------------------
# A Hermes update/reinstall wipes the local changes this project depends on
# (SOUL.md, config, custom tools, source patches) - put them back every deploy.
if [ "$CHECK_ONLY" != "1" ] && [ -f "$REPO_DIR/deployment/reapply-hermes-customizations.sh" ]; then
  step 5b "Our Hermes customizations (SOUL.md, config, tools, patches)"
  # Run a CRLF-stripped copy: this repo is often cloned on Windows, where the
  # checkout may carry CRLF endings that break bash. FB_REPO_DIR/HERMES_DIR keep
  # the copy pointed at the real repo and the real Hermes checkout.
  REAPPLY_TMP="$(mktemp)"
  sed 's/\r$//' "$REPO_DIR/deployment/reapply-hermes-customizations.sh" > "$REAPPLY_TMP"
  FB_REPO_DIR="$REPO_DIR" HERMES_DIR="$HERMES_DIR" bash "$REAPPLY_TMP" \
    || warn "customization re-apply reported problems (see above)"
  rm -f "$REAPPLY_TMP"
fi

# --- 6. Hermes brain + env ----------------------------------------------------
step 6 "Hermes config (SOUL.md, skills, .env)"
if [ "$CHECK_ONLY" = "1" ]; then
  [ -f "$HOME/.hermes/.env" ] && ok "~/.hermes/.env present" || need "~/.hermes/.env" "created by this script (you then add your keys)"
else
  mkdir -p "$HOME/.hermes"
  [ -f "$REPO_DIR/hermes-config/SOUL.md" ] && cp "$REPO_DIR/hermes-config/SOUL.md" "$HOME/.hermes/SOUL.md" && info "restored SOUL.md"
  [ -f "$REPO_DIR/hermes-config/skills_prompt_snapshot.json" ] && cp "$REPO_DIR/hermes-config/skills_prompt_snapshot.json" "$HOME/.hermes/.skills_prompt_snapshot.json" && info "restored skills snapshot"
  if [ ! -f "$HOME/.hermes/.env" ]; then
    printf '# Hermes env - your own keys. NEVER commit this file.\nOPENROUTER_API_KEY=\nOPENAI_API_KEY=\n' > "$HOME/.hermes/.env"
    info "created ~/.hermes/.env (fill in your keys)"
  fi
  ok "config in place"
fi

# --- 7. runtime data dir ------------------------------------------------------
if [ "$HERMES_ONLY" != "1" ]; then
  step 7 "Runtime data directory"
  if [ -d "$REPO_DIR/data" ]; then ok "exists"
  elif [ "$CHECK_ONLY" = "1" ]; then need "data directory" "created by this script"
  else mkdir -p "$REPO_DIR/data" && ok "created"; fi
fi

# --- 8. dashboard: start / restart onto the current code ------------------------
# A dashboard started BEFORE the files changed serves OLD code (the 2026-08-06
# 404 lesson). Stale -> restart it. Not running -> start it. Hermes-only mode
# skips this: there the dashboard lives on the WINDOWS side, and bootstrap.ps1
# runs the same restart logic there.
if [ "$HERMES_ONLY" != "1" ]; then
  step 8 "Dashboard (start / restart onto current code)"
  if [ "$CHECK_ONLY" = "1" ]; then
    : # reporting-only run - the summary below says how to start it by hand
  elif ! have node || [ ! -f "$REPO_DIR/server.js" ]; then
    warn "node or server.js missing - cannot start the dashboard"
  else
    DPID=""
    if have ss; then DPID="$(ss -ltnp 2>/dev/null | grep ':9317' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)"; fi
    [ -z "$DPID" ] && have lsof && DPID="$(lsof -ti tcp:9317 -s tcp:LISTEN 2>/dev/null | head -1)"
    RESTART=0
    if [ -n "$DPID" ]; then
      ELAPSED="$(ps -o etimes= -p "$DPID" 2>/dev/null | tr -d ' ')"
      MTIME="$(stat -c %Y "$REPO_DIR/server.js" 2>/dev/null || stat -f %m "$REPO_DIR/server.js" 2>/dev/null || echo 0)"
      FILE_AGE=$(( $(date +%s) - MTIME ))
      # server.js changed AFTER the process started -> it is serving old code
      if [ -z "$ELAPSED" ] || [ "$FILE_AGE" -lt "${ELAPSED:-0}" ]; then RESTART=1; fi
    fi
    if [ -n "$DPID" ] && [ "$RESTART" = "1" ]; then
      info "running server (pid $DPID) predates the files on disk - restarting it"
      kill "$DPID" 2>/dev/null; sleep 2; kill -9 "$DPID" 2>/dev/null
      DPID=""
    fi
    if [ -n "$DPID" ]; then
      ok "already running the current code (pid $DPID)"
    else
      mkdir -p "$REPO_DIR/data"
      ( cd "$REPO_DIR" && nohup node server.js >> data/dashboard-server.log 2>&1 & )
      UP=0
      for _ in $(seq 1 30); do
        curl -sf -o /dev/null --max-time 2 http://127.0.0.1:9317/ && { UP=1; break; }
        sleep 1
      done
      if [ "$UP" = "1" ]; then ok "dashboard is up: http://127.0.0.1:9317"
      else fail "dashboard did not answer within 30s"; MISSING="$MISSING dashboard"; fi
    fi
  fi
fi

# --- summary ------------------------------------------------------------------
echo ""
echo "=============================================================="
if [ -z "$MISSING" ]; then
  echo " ALL AUTOMATED PREREQUISITES ARE IN PLACE"
else
  echo " STILL MISSING:$MISSING"
fi
echo "=============================================================="
if [ "$HERMES_ONLY" != "1" ]; then
  echo ""
  echo " Manual steps (cannot be automated - they need your accounts):"
  echo "   1) Connect an LLM: open the dashboard - if Hermes has no credential,"
  echo "      the setup popup walks you through it (API key or OAuth sign-in)."
  echo "      Manual fallback: add keys to ~/.hermes/.env (OpenRouter / OpenAI)."
  echo "   2) Dashboard > Integrations: OpenAI / OpenRouter keys, Webshare proxy creds."
  echo "   3) Dashboard > Prod > Step 3: tick which profiles serve which group."
  echo "   4) ixBrowser (Windows/macOS desktop app) with your Facebook profiles"
  echo "      logged in, and its Local API enabled."
  if [ "$OS" = "Linux" ] && [ "$IS_WSL" = "0" ]; then
    echo ""
    echo " NOTE: ixBrowser has no native Linux build. On a pure Linux host this"
    echo "       installs the dashboard and Hermes, but the posting/commenting"
    echo "       side needs ixBrowser reachable over its Local API."
  fi
  echo ""
  echo " Dashboard:     http://127.0.0.1:9317  (started or restarted above when possible;"
  echo "                otherwise start it by hand:  node server.js)"
fi
echo ""

[ -n "$MISSING" ] && [ "$CHECK_ONLY" = "1" ] && exit 2
exit 0
