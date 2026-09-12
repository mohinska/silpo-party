#!/usr/bin/env python3
"""Local-only observer for the canonical Silpo Family agent pipeline.

The token is held only in this process. The harness calls the development-only
agent endpoint and prints safe Intent, Supervisor and Silpo catalog traces.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import http.server
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from collections.abc import Mapping
from typing import Any

AUTHORIZE_URL = "https://mcp.silpo.ua/authorize"
TOKEN_URL = "https://mcp.silpo.ua/token"
REGISTER_URL = "https://mcp.silpo.ua/register"
RESOURCE = "https://mcp.silpo.ua"
HARNESS_TIMEOUT_SECONDS = 240
SENSITIVE_KEYS = {"access_token", "refresh_token", "authorization", "client_secret", "mcpaccesstoken", "raw"}


def code_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def authorization_url(*, client_id: str, redirect_uri: str, state: str, verifier: str) -> str:
    query = urllib.parse.urlencode({
        "response_type": "code", "client_id": client_id, "redirect_uri": redirect_uri,
        "state": state, "code_challenge": code_challenge(verifier),
        "code_challenge_method": "S256", "resource": RESOURCE,
    })
    return f"{AUTHORIZE_URL}?{query}"


def require_local_url(value: str) -> str:
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme != "http" or parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise ValueError("AGENT_HARNESS_URL must be an http://localhost URL.")
    if parsed.path != "/api/agent-harness":
        raise ValueError("AGENT_HARNESS_URL must target /api/agent-harness.")
    return value


def redact(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {key: redact(nested) for key, nested in value.items() if key.lower().replace("-", "_") not in SENSITIVE_KEYS}
    if isinstance(value, list):
        return [redact(item) for item in value]
    return value


def json_request(url: str, body: Mapping[str, Any], secret: str) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={"content-type": "application/json", "authorization": f"Bearer {secret}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=HARNESS_TIMEOUT_SECONDS) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            payload = json.loads(error.read().decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            payload = {}
        code = payload.get("code") if isinstance(payload, Mapping) else None
        suffix = f" · {code}" if isinstance(code, str) else ""
        raise RuntimeError(f"Harness HTTP {error.code}{suffix}") from error
    except urllib.error.URLError as error:
        raise RuntimeError("Не вдалося підключитися до локального dev-сервера. Запусти `npm run dev`.") from error
    if not isinstance(payload, dict):
        raise RuntimeError("Harness returned an invalid JSON object.")
    return payload


def register_client(redirect_uri: str) -> tuple[str, str | None]:
    request = urllib.request.Request(
        REGISTER_URL,
        data=json.dumps({
            "client_name": "Silpo Family local agent harness",
            "redirect_uris": [redirect_uri], "grant_types": ["authorization_code"],
            "response_types": ["code"], "token_endpoint_auth_method": "client_secret_post",
        }).encode("utf-8"),
        method="POST", headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))
    client_id = payload.get("client_id")
    if not isinstance(client_id, str) or not client_id:
        raise RuntimeError("Silpo registration returned no client_id.")
    secret = payload.get("client_secret")
    return client_id, secret if isinstance(secret, str) else None


def authenticate() -> str:
    with http.server.HTTPServer(("127.0.0.1", 0), http.server.BaseHTTPRequestHandler) as server:
        redirect_uri = f"http://127.0.0.1:{server.server_port}/callback"
        client_id, client_secret = register_client(redirect_uri)
        verifier = secrets.token_urlsafe(48)
        state = secrets.token_urlsafe(32)
        webbrowser.open(authorization_url(client_id=client_id, redirect_uri=redirect_uri, state=state, verifier=verifier))
        received: dict[str, str] = {}

        class CallbackHandler(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                received["code"] = query.get("code", [""])[0]
                received["state"] = query.get("state", [""])[0]
                self.send_response(200)
                self.send_header("content-type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write("<p>Silpo login finished. Return to the terminal.</p>".encode())

            def log_message(self, _format: str, *_args: object) -> None:
                return

        server.RequestHandlerClass = CallbackHandler
        deadline = time.monotonic() + 600
        while "code" not in received and time.monotonic() < deadline:
            server.handle_request()
        if received.get("state") != state or not received.get("code"):
            raise RuntimeError("Silpo OAuth callback was missing or invalid.")
        fields = {"grant_type": "authorization_code", "code": received["code"], "redirect_uri": redirect_uri, "client_id": client_id, "code_verifier": verifier, "resource": RESOURCE}
        if client_secret:
            fields["client_secret"] = client_secret
        request = urllib.request.Request(TOKEN_URL, data=urllib.parse.urlencode(fields).encode(), method="POST", headers={"content-type": "application/x-www-form-urlencoded"})
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
        token = payload.get("access_token")
        if not isinstance(token, str) or not token:
            raise RuntimeError("Silpo token exchange returned no access token.")
        return token


def money(cents: Any) -> str:
    if not isinstance(cents, int):
        return "—"
    return f"{cents / 100:,.2f}".replace(",", " ").replace(".", ",") + " ₴"


def print_result(payload: Mapping[str, Any]) -> None:
    safe = redact(payload)
    print(f"\n{'═' * 72}\n{safe.get('reply', '—')}\n{'─' * 72}\nAgent trace")
    for index, event in enumerate(safe.get("trace", []), start=1):
        if not isinstance(event, Mapping):
            continue
        status = "готово" if event.get("status") == "completed" else "помилка"
        print(f"\n{index}. {event.get('stage', 'unknown')} · {status} · {event.get('durationMs', '—')} мс")
        if isinstance(event.get("input"), Mapping):
            print(f"   input: {json.dumps(event['input'], ensure_ascii=False)}")
        output = event.get("output")
        if isinstance(output, Mapping):
            if event.get("stage") == "product_search":
                candidates = output.get("candidates", [])
                print(f"   query: {output.get('query', '—')} · candidates: {len(candidates) if isinstance(candidates, list) else 0}")
                for candidate in candidates if isinstance(candidates, list) else []:
                    if isinstance(candidate, Mapping):
                        print(f"   • {candidate.get('name', '—')} · {candidate.get('displayRatio', '—')} · {money(candidate.get('priceCents'))} · {candidate.get('productId', '—')}")
            else:
                print(f"   output: {json.dumps(output, ensure_ascii=False)}")
        if event.get("errorCode"):
            print(f"   error: {event['errorCode']}")
    print("═" * 72)


def run() -> int:
    parser = argparse.ArgumentParser(description="Observe the canonical Silpo Family agent locally.")
    parser.add_argument("command", choices=["run"])
    parser.parse_args()
    url = require_local_url(os.environ.get("AGENT_HARNESS_URL", "http://localhost:3000/api/agent-harness"))
    secret = os.environ.get("AI_AGENT_HARNESS_SECRET")
    if not secret:
        raise RuntimeError("Set AI_AGENT_HARNESS_SECRET before running the harness.")
    token = authenticate()
    session_id: str | None = None
    print("Авторизовано. Пиши запити або `exit`. Token не зберігається на диску.", flush=True)
    while True:
        try:
            message = input("> ").strip()
        except EOFError:
            break
        if message.lower() in {"exit", "quit", "вийти"}:
            break
        if not message:
            continue
        body: dict[str, Any] = {"message": message, "mcpAccessToken": token}
        if session_id:
            body["sessionId"] = session_id
        result = json_request(url, body, secret)
        received = result.get("sessionId")
        if isinstance(received, str):
            session_id = received
        print_result(result)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(run())
    except (RuntimeError, ValueError, urllib.error.URLError) as error:
        print(f"Помилка: {error}", file=sys.stderr)
        raise SystemExit(1) from error
