#!/usr/bin/env python3
"""Interactive, local-only OAuth smoke harness for the AI Debug catalog agent.

The temporary Silpo access token lives only in this process and is never
printed, persisted, or forwarded beyond the local development endpoint.
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
SENSITIVE_KEYS = {"access_token", "refresh_token", "authorization", "mcpaccesstoken", "client_secret", "raw"}


def code_challenge(verifier: str) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("utf-8")).digest()).rstrip(b"=").decode("ascii")


def authorization_url(*, client_id: str, redirect_uri: str, state: str, verifier: str) -> str:
    query = urllib.parse.urlencode({
        "response_type": "code", "client_id": client_id, "redirect_uri": redirect_uri,
        "state": state, "code_challenge": code_challenge(verifier), "code_challenge_method": "S256", "resource": RESOURCE,
    })
    return f"{AUTHORIZE_URL}?{query}"


def require_local_harness_url(value: str) -> str:
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme != "http" or parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise ValueError("AI_DEBUG_HARNESS_URL must be an http://localhost URL.")
    if not parsed.path.startswith("/api/ai-debug/harness"):
        raise ValueError("AI_DEBUG_HARNESS_URL must target /api/ai-debug/harness.")
    return value


def redact(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {key: redact(nested) for key, nested in value.items() if key.lower().replace("-", "_") not in SENSITIVE_KEYS}
    if isinstance(value, list):
        return [redact(item) for item in value]
    return value


def http_error_detail(error: urllib.error.HTTPError) -> str | None:
    """Read just the allowlisted local diagnostic code, never an upstream error body."""
    try:
        payload = json.loads(error.read().decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    code = payload.get("code") if isinstance(payload, Mapping) else None
    return code if isinstance(code, str) and code.startswith("HARNESS_") else None


def json_request(url: str, body: Mapping[str, Any], headers: Mapping[str, str] | None = None) -> dict[str, Any]:
    request = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), method="POST", headers={"content-type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            decoded = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = http_error_detail(error)
        suffix = f" · {detail}" if detail else ""
        raise RuntimeError(f"HTTP {error.code} from {urllib.parse.urlparse(url).netloc}{suffix}") from error
    if not isinstance(decoded, dict):
        raise RuntimeError("Expected a JSON object response.")
    return decoded


def register_client(redirect_uri: str) -> tuple[str, str | None]:
    response = json_request(REGISTER_URL, {
        "client_name": "Silpo Family AI Debug local harness",
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "client_secret_post",
    })
    client_id = response.get("client_id")
    if not isinstance(client_id, str) or not client_id:
        raise RuntimeError("Silpo registration returned no client_id.")
    client_secret = response.get("client_secret")
    return client_id, client_secret if isinstance(client_secret, str) else None


def exchange_code(*, code: str, client_id: str, client_secret: str | None, redirect_uri: str, verifier: str) -> str:
    fields = {"grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri, "client_id": client_id, "code_verifier": verifier, "resource": RESOURCE}
    if client_secret:
        fields["client_secret"] = client_secret
    request = urllib.request.Request(TOKEN_URL, data=urllib.parse.urlencode(fields).encode("utf-8"), method="POST", headers={"content-type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            decoded = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Silpo token exchange failed ({error.code}).") from error
    token = decoded.get("access_token") if isinstance(decoded, dict) else None
    if not isinstance(token, str) or not token:
        raise RuntimeError("Silpo token exchange returned no access token.")
    return token


def wait_for_callback(server: http.server.HTTPServer, expected_state: str) -> str:
    received: dict[str, str] = {}

    class CallbackHandler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            received["code"] = query.get("code", [""])[0]
            received["state"] = query.get("state", [""])[0]
            self.send_response(200)
            self.send_header("content-type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write("<p>Silpo login finished. Return to the terminal.</p>".encode("utf-8"))

        def log_message(self, _format: str, *_args: object) -> None:
            return

    server.RequestHandlerClass = CallbackHandler
    server.timeout = 1
    deadline = time.monotonic() + 10 * 60
    while "code" not in received and time.monotonic() < deadline:
        server.handle_request()
    if received.get("state") != expected_state or not received.get("code"):
        raise RuntimeError("Silpo OAuth callback was missing, expired, or had an invalid state.")
    return received["code"]


def authenticate() -> str:
    with http.server.HTTPServer(("127.0.0.1", 0), http.server.BaseHTTPRequestHandler) as server:
        redirect_uri = f"http://127.0.0.1:{server.server_port}/callback"
        client_id, client_secret = register_client(redirect_uri)
        verifier = secrets.token_urlsafe(48)
        state = secrets.token_urlsafe(32)
        url = authorization_url(client_id=client_id, redirect_uri=redirect_uri, state=state, verifier=verifier)
        print("Відкриваю Silpo login у браузері…", flush=True)
        webbrowser.open(url)
        code = wait_for_callback(server, state)
        return exchange_code(code=code, client_id=client_id, client_secret=client_secret, redirect_uri=redirect_uri, verifier=verifier)


def print_result(result: Mapping[str, Any]) -> None:
    """Render every safe trace detail for a human, never raw upstream data."""
    safe = redact(result)
    print(f"\n{'═' * 72}\nВідповідь агента\n{safe.get('reply', '—')}")
    print(f"{'─' * 72}\nКроки агента")
    events = safe.get("trace", [])
    if not isinstance(events, list) or not events:
        print("  Немає зафіксованих tool-кроків.")
    for index, event in enumerate(events, start=1):
        if not isinstance(event, Mapping):
            continue
        status = "готово" if event.get("status") == "completed" else "помилка"
        duration = event.get("durationMs")
        duration_text = f" · {duration} мс" if isinstance(duration, int) else ""
        print(f"\n{index}. {event.get('toolName', 'tool')} · {status}{duration_text}")
        search_trace = event.get("trace")
        if isinstance(search_trace, Mapping):
            tool = search_trace.get("mcpTool", "silpo_find_products_batch")
            print(f"   MCP: {tool}")
            queries = search_trace.get("queries")
            if isinstance(queries, list):
                print(f"   Запити: {' · '.join(str(query) for query in queries)}")
            preselection = search_trace.get("preselection")
            if isinstance(preselection, Mapping):
                labels = {"completed": "готово", "unavailable": "недоступний", "invalid": "некоректна відповідь"}
                status = labels.get(preselection.get("status"), "невідомо")
                intent = preselection.get("normalizedIntent")
                if isinstance(intent, Mapping):
                    kind = intent.get("productKind", "—")
                    exclusions = intent.get("exclusions")
                    exclusion_text = ", ".join(str(item) for item in exclusions) if isinstance(exclusions, list) and exclusions else "—"
                    print(f"   Preagent: {status} · тип: {kind} · виключено: {exclusion_text}")
                else:
                    print(f"   Preagent: {status}")
            candidates = search_trace.get("candidates")
            if isinstance(candidates, list):
                if candidates:
                    print(f"   Кандидати ({len(candidates)}):")
                    for candidate in candidates:
                        if not isinstance(candidate, Mapping):
                            continue
                        name = candidate.get("name", "—")
                        unit = candidate.get("unit", "—")
                        price = hryvnia(candidate.get("unitPriceCents"))
                        discount = candidate.get("discountCents")
                        saving = f" · економія {hryvnia(discount)}" if isinstance(discount, int) and discount > 0 else ""
                        availability = "в наявності" if candidate.get("available") is True else "немає в наявності"
                        print(f"   • {name} · {unit} · {price}{saving} · {availability}")
                        print(f"     productId: {candidate.get('productId', '—')}")
                        print(f"     evidenceId: {candidate.get('evidenceId', '—')}")
                        verdict = candidate.get("preselection")
                        if isinstance(verdict, Mapping):
                            print(f"     Відбір: {verdict.get('verdict', '—')} · {verdict.get('reason', '—')}")
                else:
                    print("   Кандидати: немає.")
        recipe = event.get("recipe")
        if isinstance(recipe, Mapping):
            title = recipe.get("title", "—")
            servings = recipe.get("servings", "—")
            print(f"   Рецепт: {title} · {servings} порц.")
            source_url = recipe.get("sourceUrl")
            if isinstance(source_url, str):
                print(f"   Джерело: {source_url}")
            ingredients = recipe.get("ingredients")
            if isinstance(ingredients, list):
                for ingredient in ingredients:
                    if not isinstance(ingredient, Mapping):
                        continue
                    optional = " · необов’язково" if ingredient.get("optional") is True else ""
                    unit = {"g": "г", "kg": "кг", "ml": "мл", "l": "л", "piece": "шт", "tbsp": "ст. л.", "tsp": "ч. л."}.get(ingredient.get("unit"), ingredient.get("unit", "—"))
                    print(f"   • {ingredient.get('name', '—')} · {ingredient.get('quantity', '—')} {unit}{optional}")
        selected = event.get("selectedEvidenceId")
        if isinstance(selected, str):
            print(f"   Обраний evidence: {selected}")
        error_code = event.get("errorCode")
        if isinstance(error_code, str):
            print(f"   Код помилки: {error_code}")
    print_cart(safe.get("cart"))


def hryvnia(cents: Any) -> str:
    if not isinstance(cents, int):
        return "—"
    return f"{cents / 100:,.2f}".replace(",", " ").replace(".", ",") + " ₴"


def print_cart(value: Any) -> None:
    if not isinstance(value, Mapping):
        print(f"{'─' * 72}\nКошик: недоступний\n{'═' * 72}")
        return
    revision = value.get("revision", "—")
    print(f"{'─' * 72}\nКошик · версія {revision} · разом {hryvnia(value.get('totalCents'))}")
    items = value.get("items")
    if not isinstance(items, list) or not items:
        print("  Порожній.")
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, Mapping):
            continue
        print(f"  • {item.get('name', '—')} · {item.get('unit', '—')} ×{item.get('quantity', '—')} · {hryvnia(item.get('unitPriceCents'))}")
        print(f"    productId: {item.get('productId', '—')} · evidenceId: {item.get('evidenceId', '—')}")
    print("═" * 72)


def run() -> int:
    parser = argparse.ArgumentParser(description="Run the local AI Debug Silpo MCP harness.")
    parser.add_argument("command", choices=["run"])
    parser.parse_args()
    harness_url = require_local_harness_url(os.environ.get("AI_DEBUG_HARNESS_URL", "http://localhost:3000/api/ai-debug/harness"))
    secret = os.environ.get("AI_DEBUG_HARNESS_SECRET")
    if not secret:
        raise RuntimeError("Set AI_DEBUG_HARNESS_SECRET before running the harness.")
    token = authenticate()
    session_id: str | None = None
    print("Авторизовано. Напиши запит (або `exit`). Token не зберігається.", flush=True)
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
        result = json_request(harness_url, body, {"authorization": f"Bearer {secret}"})
        received_id = result.get("sessionId")
        if isinstance(received_id, str):
            session_id = received_id
        print_result(result)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(run())
    except (RuntimeError, ValueError) as error:
        print(f"Помилка: {error}", file=sys.stderr)
        raise SystemExit(1) from error
