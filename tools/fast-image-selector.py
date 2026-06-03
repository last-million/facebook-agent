#!/usr/bin/env python3
"""Fast image-selector for the Facebook posting agent.

Bypasses the Hermes CLI (which has a ~60s cold-start) by calling the OpenAI-
compatible chat-completions endpoint directly via stdlib urllib. Reads the
prompt from argv[1] and prints the model's reply to stdout. The agent parses
the JSON object out of that reply, same as the previous Hermes path.

Env vars (read from Hermes's .env when running under WSL):
  OPENAI_API_KEY    - bearer token for the inference gateway
  OPENAI_BASE_URL   - base URL, e.g. https://inference-api.nousresearch.com/v1
  IMAGE_SELECTOR_MODEL - optional model override (default: openai/gpt-5.4-mini)

Exit codes:
  0  success (stdout contains the model reply)
  2  config error (missing key)
  3  HTTP / network error
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request


def main() -> int:
    if len(sys.argv) < 2:
        sys.stderr.write("usage: fast-image-selector.py <prompt>\n")
        return 2
    prompt = sys.argv[1]

    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    base_url = os.environ.get("OPENAI_BASE_URL", "").strip().rstrip("/")
    if not api_key:
        sys.stderr.write("OPENAI_API_KEY is not set\n")
        return 2
    if not base_url:
        base_url = "https://inference-api.nousresearch.com/v1"

    model = os.environ.get("IMAGE_SELECTOR_MODEL", "openai/gpt-4o-mini").strip() or "openai/gpt-4o-mini"
    timeout_s = int(os.environ.get("IMAGE_SELECTOR_TIMEOUT_S", "75"))

    payload = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": "You select the best customer-review image for a Facebook product post. Output strict JSON only.",
            },
            {"role": "user", "content": prompt},
        ],
        "max_tokens": 400,
        "temperature": 0,
        "response_format": {"type": "json_object"},
    }

    req = urllib.request.Request(
        f"{base_url}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": "fb-agent-image-selector/1.0",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            body = resp.read().decode("utf-8")
    except urllib.error.HTTPError as err:
        sys.stderr.write(f"http_error status={err.code} body={err.read().decode('utf-8', 'replace')[:400]}\n")
        return 3
    except (urllib.error.URLError, TimeoutError, OSError) as err:
        sys.stderr.write(f"network_error: {err}\n")
        return 3

    try:
        data = json.loads(body)
        content = data["choices"][0]["message"]["content"]
    except (json.JSONDecodeError, KeyError, IndexError, TypeError) as err:
        sys.stderr.write(f"parse_error: {err} body={body[:400]}\n")
        return 3

    # The model already returns JSON (response_format=json_object). Print as-is.
    sys.stdout.write(content)
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
