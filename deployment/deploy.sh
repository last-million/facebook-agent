#!/usr/bin/env bash
# ============================================================
#  Facebook Agent - Hermes (WSL / Linux) deploy
#  Installs the Hermes AI CLI that the dashboard shells out to
#  (server.js: HERMES_BIN=/root/.local/bin/hermes).
#  Run inside WSL:  bash deployment/deploy.sh
# ============================================================
set -euo pipefail

echo "[1/4] Base packages (curl, git, python3)..."
if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update -y >/dev/null 2>&1 || true
  sudo apt-get install -y curl git python3 python3-pip >/dev/null 2>&1 || true
fi

echo "[2/4] Installing Hermes CLI -> /root/.local/bin/hermes ..."
# >>> SET THIS to your real Hermes install command(s). <<<
# It can be exported before running, e.g.:
#   HERMES_INSTALL_CMD="pip install --user hermes-cli" bash deploy.sh
# or pasted directly below.
HERMES_INSTALL_CMD="${HERMES_INSTALL_CMD:-}"
if [ -n "$HERMES_INSTALL_CMD" ]; then
  eval "$HERMES_INSTALL_CMD"
else
  echo "    !! HERMES_INSTALL_CMD not set."
  echo "    !! Edit this file (or export HERMES_INSTALL_CMD) with your Hermes install command,"
  echo "    !! then re-run. Target binary: /root/.local/bin/hermes"
fi

echo "[3/4] Hermes config (~/.hermes/.env)..."
mkdir -p ~/.hermes
if [ ! -f ~/.hermes/.env ]; then
  cat > ~/.hermes/.env <<'EOF'
# Hermes environment - fill in your own keys (do NOT commit this file)
# OpenAI / Codex auth is configured outside this file per your setup.
OPENROUTER_API_KEY=
OPENAI_API_KEY=
EOF
  echo "    created ~/.hermes/.env (fill in your keys)"
else
  echo "    ~/.hermes/.env already exists - leaving as-is"
fi

echo "[4/4] Verify..."
export PATH="$HOME/.local/bin:/root/.local/bin:$PATH"
if command -v hermes >/dev/null 2>&1; then
  hermes --version || true
  echo "    Hermes OK."
else
  echo "    'hermes' not on PATH yet - ensure /root/.local/bin is in PATH and HERMES_INSTALL_CMD ran."
fi
echo "Done. Re-enter OpenAI/Codex auth + OpenRouter fallback key in ~/.hermes/.env"
