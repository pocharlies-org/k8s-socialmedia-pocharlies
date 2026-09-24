"""Tests for scripts/render-connectors.py — run: python3 -m unittest scripts/test_render_connectors.py"""
import copy
import importlib.util
import json
import unittest
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("render_connectors", HERE / "render-connectors.py")
rc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rc)

REGISTRY = json.loads(rc.REGISTRY.read_text(encoding="utf-8"))


def kinds(manifest):
    return sorted((d["kind"], d["metadata"]["name"]) for d in yaml.safe_load_all(manifest) if d)


class RenderConnectorsTest(unittest.TestCase):
    def test_deterministic(self):
        first = rc.render(copy.deepcopy(REGISTRY))
        second = rc.render(copy.deepcopy(REGISTRY))
        self.assertEqual(first, second)

    def test_checked_in_files_are_fresh(self):
        self.assertEqual(rc.main(["--check"]), 0)

    def test_runtime_registry_drops_deploy_only(self):
        _, runtime = rc.render(copy.deepcopy(REGISTRY))
        expected = [{k: v for k, v in a.items() if k != "deploy"} for a in REGISTRY]
        self.assertEqual(json.loads(runtime), expected)

    def test_new_whatsapp_account_renders_full_set(self):
        account = {
            "channel": "whatsapp",
            "accountId": "acme",
            "label": "WhatsApp acme",
            "connectorUrl": "http://whatsapp-connector-acme.whatsapp-mcp.svc.cluster.local:3001",
        }
        manifest, _ = rc.render([account])
        self.assertEqual(
            kinds(manifest),
            [
                ("Deployment", "whatsapp-connector-acme"),
                ("IngressRoute", "whatsapp-acme-lan"),
                ("PersistentVolumeClaim", "whatsapp-session-data-acme"),
                ("Service", "whatsapp-connector-acme"),
            ],
        )
        dep = next(d for d in yaml.safe_load_all(manifest) if d and d["kind"] == "Deployment")
        env = {e["name"]: e.get("value") for e in dep["spec"]["template"]["spec"]["containers"][0]["env"]}
        self.assertEqual(env["CONNECTOR_ACCOUNT"], "acme")
        self.assertEqual(env["WA_QR_PUBLIC_URL"], "https://whatsapp-acme.lan.e-dani.com/qr/page")
        self.assertNotIn("ALLOW_WEB_RENEW", env)  # unauthenticated renew is opt-in

    def test_new_telegram_account_renders_pair(self):
        manifest, _ = rc.render([{"channel": "telegram", "accountId": "acme", "connectorUrl": None}])
        self.assertEqual(
            kinds(manifest),
            [
                ("Deployment", "telegram-connector-acme"),
                ("Deployment", "telegram-sync-acme"),
                ("Service", "telegram-connector-acme"),
                ("Service", "telegram-sync-acme"),
            ],
        )

    def test_disabled_and_instagram_render_nothing(self):
        manifest, _ = rc.render(
            [
                {"channel": "whatsapp", "accountId": "off", "enabled": False},
                {"channel": "telegram", "accountId": "off", "enabled": False},
                {"channel": "instagram", "accountId": "ig", "namespace": "personal"},
            ]
        )
        self.assertEqual(kinds(manifest), [])

    def test_connector_url_must_match_generated_service(self):
        with self.assertRaises(SystemExit):
            rc.render([{"channel": "whatsapp", "accountId": "acme", "connectorUrl": "http://elsewhere:3001"}])


if __name__ == "__main__":
    unittest.main()
