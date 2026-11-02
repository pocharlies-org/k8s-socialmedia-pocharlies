"""SC-705 regression: the per-sub serving contract of the prod overlay.

Asserts on the RENDERED `k8s/overlays/prod` (what ArgoCD applies), not on the
patch sources, because the contract is about the result of base + generated +
patches:

  - SC-1144 C1 / SC-1145 C2 — each per-sub connector deployment carries
    CREDENTIAL_STORE_ENABLED=true and CREDENTIAL_SESSION_KEY = the owner's
    Keycloak sub, and that sub is the one declared for that user in
    k8s/base/social-identity-bindings.yaml (decision H5: the same sub in the
    overlay, the bindings CM and the pairing stamp).
  - SC-1145 C2 (H2, the adoption trap) — a per-sub TELEGRAM connector must
    pin TELEGRAM_SESSION_STRING to "" in its env: env beats the shared
    `whatsapp-mcp-secrets` envFrom, so without the empty value the resolver
    would adopt-on-first-use the HOUSE session into the sub's row and serve
    the wrong account.
  - SC-1144 C5 / SC-1145 C4 (zero regression at home) — the house
    `whatsapp-connector` keeps CREDENTIAL_STORE_ENABLED="false" and no
    session key; the house `telegram-connector` sets no session key and no
    store flag (absent = OFF, legacy envFrom path).
  - SC-1144 C1 — connector images are digest-pinned (@sha256), never a
    floating tag (the H1 ceiling is a per-release decision, the pin is not).

A generic sweep backs the explicit leila cases: ANY connector container that
carries a CREDENTIAL_SESSION_KEY must obey the same three rules, so a future
per-sub slot added without the H2 emptying fails here.

Run: python3 -m unittest scripts/test_prod_overlay_per_sub.py
Needs kustomize on PATH (or KUSTOMIZE_BIN / `kubectl kustomize`); the CI job
installs the pinned binary. Skips when no renderer is available.
"""
import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
OVERLAY = ROOT / "k8s" / "overlays" / "prod"
BINDINGS = ROOT / "k8s" / "base" / "social-identity-bindings.yaml"

LEILA_SUB = "66ec6f4f-5f2c-44f6-a3db-0dccba6e1748"


def kustomize_cmd() -> list[str] | None:
    """Renderer resolution order: KUSTOMIZE_BIN, `kustomize` on PATH,
    `kubectl kustomize`. None when no renderer exists (the test skips)."""
    env = os.environ.get("KUSTOMIZE_BIN")
    if env and shutil.which(env):
        return [env]
    if shutil.which("kustomize"):
        return ["kustomize"]
    if shutil.which("kubectl"):
        return ["kubectl", "kustomize"]
    return None


def rendered_docs() -> list[dict]:
    cmd = kustomize_cmd()
    assert cmd is not None
    out = subprocess.run(
        cmd + ["build", str(OVERLAY)],
        capture_output=True, text=True, check=True, cwd=ROOT,
    ).stdout
    return [d for d in yaml.safe_load_all(out) if d]


def deployment(docs: list[dict], name: str) -> dict:
    found = [d for d in docs if d["kind"] == "Deployment" and d["metadata"]["name"] == name]
    assert len(found) == 1, f"expected exactly one Deployment {name}, got {len(found)}"
    return found[0]


def container_env(deployment_doc: dict) -> tuple[dict, dict]:
    """(env name -> value, env name -> container) for the single container."""
    containers = deployment_doc["spec"]["template"]["spec"]["containers"]
    assert len(containers) == 1, f"{deployment_doc['metadata']['name']}: expected 1 container"
    env, owner = {}, {}
    for entry in containers[0].get("env") or []:
        env[entry["name"]] = entry.get("value")
        owner[entry["name"]] = containers[0]["name"]
    return env, owner


def declared_subs() -> set[str]:
    doc = yaml.safe_load(BINDINGS.read_text(encoding="utf-8"))
    return {entry["sub"] for entry in doc["bindings"]}


@unittest.skipIf(kustomize_cmd() is None, "no kustomize/kubectl kustomize on PATH")
class ProdOverlayPerSubTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.docs = rendered_docs()

    def env_of(self, name: str) -> dict:
        return container_env(deployment(self.docs, name))[0]

    def test_leila_whatsapp_connector_serves_by_sub(self):
        env = self.env_of("whatsapp-connector-leila")
        self.assertEqual(env.get("CREDENTIAL_STORE_ENABLED"), "true")
        self.assertEqual(env.get("CREDENTIAL_SESSION_KEY"), LEILA_SUB)
        self.assertEqual(env.get("CONNECTOR_ACCOUNT"), "leila")

    def test_leila_telegram_connector_serves_by_sub(self):
        env = self.env_of("telegram-connector-leila")
        self.assertEqual(env.get("CREDENTIAL_STORE_ENABLED"), "true")
        self.assertEqual(env.get("CREDENTIAL_SESSION_KEY"), LEILA_SUB)
        self.assertEqual(env.get("CONNECTOR_ACCOUNT"), "leila")

    def test_leila_telegram_connector_empties_house_session(self):
        # H2: the empty literal must be PRESENT (env beats the shared
        # whatsapp-mcp-secrets envFrom); absent, the resolver would adopt the
        # house session into Leila's sub row.
        env = self.env_of("telegram-connector-leila")
        self.assertIn("TELEGRAM_SESSION_STRING", env)
        self.assertEqual(env["TELEGRAM_SESSION_STRING"], "")

    def test_house_connectors_keep_legacy_path(self):
        wa = self.env_of("whatsapp-connector")
        self.assertEqual(wa.get("CREDENTIAL_STORE_ENABLED"), "false")
        self.assertNotIn("CREDENTIAL_SESSION_KEY", wa)
        tg = self.env_of("telegram-connector")
        self.assertNotIn("CREDENTIAL_SESSION_KEY", tg)
        self.assertNotEqual(tg.get("CREDENTIAL_STORE_ENABLED"), "true")

    def test_session_keys_are_declared_subs(self):
        # Decision H5: the overlay value and the bindings CM must be the same
        # sub — drift between the two files is the failure this pins.
        subs = declared_subs()
        self.assertIn(LEILA_SUB, subs)
        for doc in self.docs:
            if doc["kind"] != "Deployment":
                continue
            env, _owner = container_env(doc)
            key = env.get("CREDENTIAL_SESSION_KEY")
            if key is None:
                continue
            name = doc["metadata"]["name"]
            self.assertEqual(env.get("CREDENTIAL_STORE_ENABLED"), "true",
                             f"{name}: session key without the store flag")
            self.assertIn(key, subs, f"{name}: session key is not a declared bindings sub")
            image = doc["spec"]["template"]["spec"]["containers"][0]["image"]
            if "telegram-connector" in image:
                self.assertEqual(env.get("TELEGRAM_SESSION_STRING", None), "",
                                 f"{name}: per-sub Telegram connector without the H2 "
                                 "TELEGRAM_SESSION_STRING=\"\" pin")

    def test_connector_images_are_digest_pinned(self):
        for name in ("whatsapp-connector", "whatsapp-connector-leila",
                     "telegram-connector", "telegram-connector-leila"):
            image = deployment(self.docs, name)["spec"]["template"]["spec"]["containers"][0]["image"]
            self.assertIn("@sha256:", image, f"{name}: floating image tag, must be digest-pinned")


if __name__ == "__main__":
    unittest.main()
