#!/usr/bin/env python3
"""SC-1144 C2 guardrail (live): per-sub isolation on the /social MCP route.

What it measures, through the REAL gateway path (no shortcuts):
  1. mints a machine token (Keycloak realm `edani`, client_credentials for the
     `agentgateway-mcp` client — the same identity Open WebUI's bearer uses
     today; its `sub` is the operator-machines entry of
     k8s/base/social-identity-bindings.yaml),
  2. opens an MCP session on the AgentGateway `/social` route,
  3. `tools/call social_list_accounts` must succeed (route alive, role gate
     INFRA-142 satisfied — a 403 here means the caller lost
     `agentgateway-read:social`, the C4 prerequisite),
  4. for every account B of the registry that is NOT bound to A (the machine
     sub), `tools/call social_list_conversations {"accountId": B}` must come
     back as an EXPLICIT rejection — JSON-RPC error or isError result whose
     text names the identity binding (mcp-server/src/domain/identity-bindings.ts,
     canonicalCode 'forbidden') — and must never carry B's conversation data.

Red/green contract (the plan's test rojo, committed not improvised):
  - TODAY (SOCIAL_IDENTITY_BINDING=off): step 4 FAILS — with the flag off the
    bindings file is never read and any verified caller is served any account
    (ok:true, possibly empty because the account is unpaired — data-shaped
    success, not a binding rejection). This is the expected red.
  - AFTER the P1 flip: step 4 PASSES — resolveBoundAccount rejects B's account
    fail-closed before the connector is ever called.

Spec-wording deviation, stated on purpose: the story says "social_list_accounts
returns only A's accounts". mcp-server deliberately does NOT actor-filter that
tool — it has no `accountId` in its schema and the gate skips account-less
tools (mcp-server/src/mcp/server.ts, applyIdentityBinding; pinned by
mcp-server/src/mcp/server.identity-binding.spec.ts "tools that take no account
parameter are not gated"). The enforced isolation guarantee — the one this
check pins — is that no account-routed tool serves B's data to A. If the list
itself must be actor-filtered, that is an mcp-server code change, not a
manifest change, and belongs to its own story.

A/B here uses the machine token as A and the unbound human accounts (leila,
daniel) as B: it needs no human credentials and no pairings, so it is runnable
before the QR gestures. The A/B with real pairings per human is measured at the
epic close (spec C2, last line).

SC-1145 C3 (Telegram por sub): the B probe runs per (channel, accountId)
registry entry, not per deduplicated accountId — an id can live on two channels
(whatsapp:daniel and telegram:daniel share accountId `daniel`, N2 of the P0
note) — and the telegram entries are probed with the explicit `channel`
argument so the Telegram route is exercised, not just the first account the
bare id resolves to. The gate (identity-bindings.ts) rejects by accountId
before routing, so an unbound telegram account must come back as the same
explicit `forbidden` rejection, never data; whatsapp probes stay byte-identical
to P1 (bare accountId) so the green P1 result cannot drift.

Usage:
  python3 scripts/check-social-isolation.py            # live against prod
Env overrides: GATEWAY_MCP_URL (default https://agentgateway-mcp.lan.e-dani.com/social),
  KC_TOKEN_URL (default https://auth-next.e-dani.com/realms/edani/protocol/openid-connect/token),
  KC_CLIENT_SECRET (if set, used directly; otherwise read via kubectl from
  secret agentgateway/agentgateway-oidc-client — never printed).
Exit 0 = isolation holds. Exit 1 = FAIL (binding off, role gate closed, or B's
data served). Exit 2 = cannot run (kubectl/curl missing, gateway unreachable).
"""
from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
BINDINGS_FILE = ROOT / "k8s/base/social-identity-bindings.yaml"
RUNTIME_REGISTRY = ROOT / "k8s/base/generated/social-accounts.json"

GATEWAY_MCP_URL = os.environ.get(
    "GATEWAY_MCP_URL", "https://agentgateway-mcp.lan.e-dani.com/social"
)
KC_TOKEN_URL = os.environ.get(
    "KC_TOKEN_URL",
    "https://auth-next.e-dani.com/realms/edani/protocol/openid-connect/token",
)
PROTOCOL_VERSION = "2025-06-18"

# Text of an explicit identity-binding rejection (identity-bindings.ts).
BINDING_REJECT = re.compile(
    r"no está ligado|no tiene entrada|IdentityBindingError|fail-closed|forbidden",
    re.IGNORECASE,
)
# Anything that would mean B's data leaked through.
DATA_KEYS = ("conversations", "messages", "structuredContent")


def die(code: int, msg: str) -> None:
    print(f"FAIL: {msg}", file=sys.stderr)
    sys.exit(code)


def machine_client_credentials() -> tuple[str, str]:
    """client_id/secret of the agentgateway-mcp client. KC_CLIENT_SECRET wins;
    otherwise read the k8s Secret (read-only) and never print the value."""
    secret = os.environ.get("KC_CLIENT_SECRET")
    if secret:
        return "agentgateway-mcp", secret
    try:
        out = subprocess.run(
            ["kubectl", "-n", "agentgateway", "get", "secret",
             "agentgateway-oidc-client", "-o", "json"],
            capture_output=True, text=True, check=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError) as error:
        die(2, f"cannot read secret agentgateway/agentgateway-oidc-client: {error}")
    data = json.loads(out)["data"]
    return (
        base64.b64decode(data["client_id"]).decode(),
        base64.b64decode(data["client_secret"]).decode(),
    )


def mint_token(client_id: str, client_secret: str) -> str:
    body = urllib.parse.urlencode(
        {"grant_type": "client_credentials", "client_id": client_id}
    ).encode()
    auth = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    request = urllib.request.Request(
        KC_TOKEN_URL,
        data=body,
        headers={
            "Authorization": f"Basic {auth}",
            "Content-Type": "application/x-www-form-urlencoded",
            # The edge 403s the default Python-urllib User-Agent (known gotcha,
            # skill keycloak-admin): send a real one.
            "User-Agent": "check-social-isolation/1.0",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.loads(response.read())["access_token"]
    except (urllib.error.URLError, KeyError, json.JSONDecodeError) as error:
        die(2, f"cannot mint the machine token from {KC_TOKEN_URL}: {error}")


def jwt_sub(token: str) -> str:
    payload = token.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    return str(json.loads(base64.urlsafe_b64decode(payload)).get("sub", ""))


def mcp_post(token: str, session_id: str | None, payload: dict) -> tuple[int, dict | None, str]:
    """One MCP POST; SSE frames are unwrapped to their JSON message.
    Returns (http_status, json_message_or_None, session_id_header)."""
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "MCP-Protocol-Version": PROTOCOL_VERSION,
        "User-Agent": "check-social-isolation/1.0",
    }
    if session_id:
        headers["Mcp-Session-Id"] = session_id
    request = urllib.request.Request(
        GATEWAY_MCP_URL, data=json.dumps(payload).encode(), headers=headers
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            sid = response.headers.get("mcp-session-id") or session_id
            body = response.read().decode()
            status = response.status
    except urllib.error.HTTPError as error:
        return error.code, None, session_id
    message = None
    for line in body.splitlines():
        if line.startswith("data: "):
            try:
                message = json.loads(line[6:])
            except json.JSONDecodeError:
                pass
    if message is None and body.strip():
        try:
            message = json.loads(body)
        except json.JSONDecodeError:
            pass
    return status, message, sid


def call_tool(token: str, session_id: str, name: str, arguments: dict) -> tuple[int, dict | None]:
    status, message, _ = mcp_post(
        token, session_id,
        {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
         "params": {"name": name, "arguments": arguments}},
    )
    return status, message


def rejection_text(message: dict | None) -> str:
    """Concatenated text an explicit rejection would carry (JSON-RPC error or
    isError tool result), empty when the call returned data."""
    if not isinstance(message, dict):
        return ""
    if "error" in message:
        return json.dumps(message["error"], ensure_ascii=False)
    result = message.get("result") or {}
    if not result.get("isError"):
        return ""
    parts = [str(item.get("text", "")) for item in result.get("content") or []]
    parts.append(json.dumps(result.get("structuredContent") or {}, ensure_ascii=False))
    return "\n".join(parts)


def serves_data(message: dict | None) -> bool:
    """True when the response is a data-shaped success (ok:true / data with
    conversation keys) — what B's account must NEVER be for A."""
    if not isinstance(message, dict) or "error" in message:
        return False
    result = message.get("result") or {}
    if result.get("isError"):
        return False
    text = json.dumps(result, ensure_ascii=False)
    return any(f'"{key}"' in text for key in DATA_KEYS)


def main() -> int:
    bindings = yaml.safe_load(BINDINGS_FILE.read_text(encoding="utf-8"))["bindings"]
    registry = json.loads(RUNTIME_REGISTRY.read_text(encoding="utf-8"))

    client_id, client_secret = machine_client_credentials()
    token = mint_token(client_id, client_secret)
    sub = jwt_sub(token)

    entry = next((b for b in bindings if b.get("sub") == sub), None)
    if entry is None:
        die(1, f"token sub {sub} has no entry in {BINDINGS_FILE.name}; the check "
               "identity (agentgateway-mcp service-account) must be bound")
    bound = set(entry.get("accounts") or [])
    # SC-1145 C3: one probe per (channel, accountId) registry entry — the same
    # accountId can be served on two channels (whatsapp:daniel, telegram:daniel).
    probes = [
        (a["channel"], a["accountId"])
        for a in registry
        if a.get("enabled", True) is not False and a["accountId"] not in bound
    ]
    if not probes:
        die(2, "every registry account is bound to the check identity: nothing to "
              "probe as B — the fixture is wrong")

    print(f"A = {entry['label']} (sub {sub}); bound accounts: {sorted(bound)}")
    print(f"B (unbound (channel, account) probes): {probes}")
    print(f"gateway: {GATEWAY_MCP_URL}")

    status, message, session_id = mcp_post(
        token, None,
        {"jsonrpc": "2.0", "id": 1, "method": "initialize",
         "params": {"protocolVersion": PROTOCOL_VERSION, "capabilities": {},
                    "clientInfo": {"name": "check-social-isolation", "version": "1"}}},
    )
    if status != 200 or not session_id:
        if status == 403:
            die(1, f"initialize -> 403: the caller lacks agentgateway-read:social "
                   f"(C4 prerequisite: grant it in Keycloak realm edani)")
        die(2, f"initialize -> HTTP {status}: gateway unreachable or route gone")
    mcp_post(token, session_id, {"jsonrpc": "2.0", "method": "notifications/initialized"})

    failures: list[str] = []

    # 3. the route is alive for this identity at all.
    status, message = call_tool(token, session_id, "social_list_accounts", {})
    if status != 200 or not isinstance(message, dict) or "error" in message:
        failures.append(
            f"social_list_accounts -> HTTP {status} "
            f"{json.dumps((message or {}).get('error', {}), ensure_ascii=False)} "
            "(route or role gate broken)"
        )
    else:
        print("PASS social_list_accounts answers for A")

    # 4. every B (channel, account) is an explicit rejection, never data.
    for channel, account in probes:
        arguments = {"accountId": account}
        if channel == "telegram":
            # SC-1145 C3: exercise the Telegram route explicitly; whatsapp
            # probes stay byte-identical to P1.
            arguments["channel"] = "telegram"
        status, message = call_tool(
            token, session_id, "social_list_conversations", arguments
        )
        label = f"social_list_conversations({arguments})"
        text = rejection_text(message)
        if status == 200 and serves_data(message):
            failures.append(
                f"{label} -> served data to A "
                f"(HTTP {status}). SOCIAL_IDENTITY_BINDING is OFF: the bindings file "
                "is never read and any verified caller is served any account. "
                "This is the expected RED before the flip."
            )
        elif BINDING_REJECT.search(text):
            print(f"PASS {label} -> explicit "
                  f"binding rejection: {text.splitlines()[0][:120]}")
        else:
            failures.append(
                f"{label} -> neither data nor "
                f"an identity-binding rejection (HTTP {status}): "
                f"{json.dumps(message, ensure_ascii=False)[:300] if message else '(no body)'}"
            )

    if failures:
        print()
        for failure in failures:
            print(f"FAIL {failure}")
        return 1
    print("\nOK: per-sub isolation holds (binding ON and enforced at the gateway path)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
