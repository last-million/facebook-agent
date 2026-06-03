#!/usr/bin/env python3
"""Persistent HTTP image-selector for the Facebook posting agent.

Replaces the per-call `wsl ... python3 fast-image-selector.py` pattern
(which paid ~50-60s WSL cold-start every call) with a long-running server
inside WSL that server.js hits via http://127.0.0.1:9318.

Endpoints:
  GET  /health           - returns {"ok": true, "model": "..."}
  POST /select           - body: {"prompt": "..."} returns the model JSON

Env vars (read from /root/.hermes/.env):
  OPENAI_API_KEY         - bearer token for the OpenAI-compatible gateway
  OPENAI_BASE_URL        - default https://inference-api.nousresearch.com/v1
  IMAGE_SELECTOR_MODEL   - default openai/gpt-4o-mini
  IMAGE_SELECTOR_PORT    - default 9318
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def _load_env_file(path: str) -> None:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value
    except FileNotFoundError:
        pass


_load_env_file("/root/.hermes/.env")

API_KEY = os.environ.get("OPENAI_API_KEY", "").strip()
BASE_URL = (os.environ.get("OPENAI_BASE_URL", "").strip().rstrip("/")
            or "https://inference-api.nousresearch.com/v1")
MODEL = os.environ.get("IMAGE_SELECTOR_MODEL", "openai/gpt-4o-mini").strip() or "openai/gpt-4o-mini"
PORT = int(os.environ.get("IMAGE_SELECTOR_PORT", "9318"))
TIMEOUT_S = int(os.environ.get("IMAGE_SELECTOR_TIMEOUT_S", "75"))


def call_openai(prompt: str) -> str:
    if not API_KEY:
        raise RuntimeError("OPENAI_API_KEY is not set in /root/.hermes/.env")
    payload = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": "You select the best customer-review image for a Facebook product post. Output strict JSON only."},
            {"role": "user", "content": prompt},
        ],
        "max_tokens": 400,
        "temperature": 0,
        "response_format": {"type": "json_object"},
    }
    req = urllib.request.Request(
        f"{BASE_URL}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json",
            "User-Agent": "fb-agent-image-selector-server/1.0",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        body = resp.read().decode("utf-8")
    data = json.loads(body)
    return data["choices"][0]["message"]["content"]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):  # noqa: A002 - keep stdlib signature
        sys.stderr.write(f"[selector] {format % args}\n")
        sys.stderr.flush()

    def _send_json(self, status: int, body: dict) -> None:
        encoded = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:
        if self.path in ("/health", "/healthz", "/"):
            self._send_json(200, {"ok": True, "model": MODEL, "base_url": BASE_URL, "port": PORT})
        else:
            self._send_json(404, {"ok": False, "error": "not_found"})

    def do_POST(self) -> None:
        if self.path != "/select":
            self._send_json(404, {"ok": False, "error": "not_found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
            raw = self.rfile.read(length) if length else b""
            req = json.loads(raw.decode("utf-8") or "{}")
            prompt = str(req.get("prompt", "")).strip()
            if not prompt:
                self._send_json(400, {"ok": False, "error": "prompt_required"})
                return
            content = call_openai(prompt)
            self._send_json(200, {"ok": True, "content": content, "model": MODEL})
        except urllib.error.HTTPError as err:
            self._send_json(502, {"ok": False, "error": "openai_http_error", "status": err.code, "body": err.read().decode("utf-8", "replace")[:600]})
        except (urllib.error.URLError, TimeoutError, OSError) as err:
            self._send_json(503, {"ok": False, "error": "network_error", "message": str(err)[:600]})
        except Exception as err:  # noqa: BLE001 - return error to caller
            self._send_json(500, {"ok": False, "error": "internal_error", "message": str(err)[:600]})


def main() -> None:
    print(f"image-selector-server listening on http://127.0.0.1:{PORT} (model={MODEL}, base={BASE_URL})", flush=True)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
