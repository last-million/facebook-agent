#!/usr/bin/env bash
# ============================================================
#  Facebook Agent - Hermes (WSL / Linux) deploy
#  Installs the Hermes Agent CLI that the dashboard shells out to
#  (server.js: HERMES_BIN=/root/.local/bin/hermes).
#  Hermes Agent = Nous Research, MIT licensed:
#    https://github.com/NousResearch/hermes-agent
#  Run inside WSL:  bash deployment/deploy.sh
# ============================================================
set -euo pipefail

# repo root = parent of this script's dir (works regardless of where it's cloned)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
HERMES_DIR="${HERMES_DIR:-$HOME/.hermes/hermes-agent}"
HERMES_REPO="https://github.com/NousResearch/hermes-agent.git"
HERMES_PIN="${HERMES_PIN:-}"   # optional: set to a commit/tag to pin (this machine ran 0.13.0 / 3034eee38)

echo "[1/5] Base packages (git, python3, uv)..."
if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update -y >/dev/null 2>&1 || true
  sudo apt-get install -y git python3 python3-pip python3-venv curl >/dev/null 2>&1 || true
fi
command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | sh || true

echo "[2/5] Clone Hermes Agent -> $HERMES_DIR ..."
if [ ! -d "$HERMES_DIR/.git" ]; then
  mkdir -p "$(dirname "$HERMES_DIR")"
  git clone "$HERMES_REPO" "$HERMES_DIR"
else
  echo "    already present; pulling latest"; git -C "$HERMES_DIR" pull --ff-only || true
fi
if [ -n "$HERMES_PIN" ]; then git -C "$HERMES_DIR" checkout "$HERMES_PIN" || true; fi

echo "[3/5] Install Hermes (its own setup script: venv + deps + 'hermes' CLI symlink)..."
cd "$HERMES_DIR"
bash setup-hermes.sh || pipx install ".[all]" || pip install --user ".[all]"

echo "[4/5] Restore Hermes brain (SOUL.md + skills) and scaffold .env ..."
mkdir -p ~/.hermes
[ -f "$REPO_DIR/hermes-config/SOUL.md" ] && cp "$REPO_DIR/hermes-config/SOUL.md" ~/.hermes/SOUL.md && echo "    restored SOUL.md"
[ -f "$REPO_DIR/hermes-config/skills_prompt_snapshot.json" ] && cp "$REPO_DIR/hermes-config/skills_prompt_snapshot.json" ~/.hermes/.skills_prompt_snapshot.json && echo "    restored skills snapshot"
if [ ! -f ~/.hermes/.env ]; then
  # setup-hermes.sh usually creates .env from template; ensure it exists
  printf '# Hermes env - fill in your own keys (NEVER commit). OpenAI/Codex auth per your setup.\nOPENROUTER_API_KEY=\nOPENAI_API_KEY=\n' > ~/.hermes/.env
  echo "    created ~/.hermes/.env (fill in your keys)"
fi

echo "[5/5] Verify..."
export PATH="$HOME/.local/bin:/root/.local/bin:$PATH"
if command -v hermes >/dev/null 2>&1; then hermes --version || true; echo "    Hermes OK."; else
  echo "    'hermes' not on PATH yet - ensure /root/.local/bin (or the symlink dir) is on PATH."; fi
echo "Done. Fill in ~/.hermes/.env with your OpenRouter/OpenAI keys + your OpenAI/Codex auth."
