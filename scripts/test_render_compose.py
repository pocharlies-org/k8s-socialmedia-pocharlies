import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('render_compose', Path(__file__).with_name('render-compose.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RenderTests(unittest.TestCase):
    def setUp(self):
        self.accounts = json.loads((module.ROOT / 'deploy/accounts.json').read_text())

    def render(self):
        return module.render(self.accounts, '/volume2/docker/social-media', module.ROOT, '/tmp/generated')

    def test_whatsapp_app_is_optional_and_account_driven(self):
        self.assertNotIn('whatsapp-app', self.render()[0]['services'])
        doc, _, _ = module.render(self.accounts, '/volume2/docker/social-media', module.ROOT,
                                  '/tmp/generated', {'WHATSAPP_APP_ENABLED': 'true'})
        app = doc['services']['whatsapp-app']
        self.assertEqual(app['user'], '${WHATSAPP_APP_UID:-1000}:${WHATSAPP_APP_GID:-10}')
        self.assertNotIn('ports', app)
        self.assertIn('WA_PERSONAL_SECRET', app['environment'])
        self.assertIn('WA_SECONDARY_SECRET', app['environment'])
        self.assertNotIn('INSTAGRAM_SECRET', app['environment'])
        self.assertEqual(app['environment']['APP_ENABLE_SENDING'], '${APP_ENABLE_SENDING:-false}')
        self.assertEqual(app['environment']['EMERGENCY_DISABLE_SENDING'], '${EMERGENCY_DISABLE_SENDING:-false}')
        self.assertEqual(app['environment']['HERMES_DEFAULT_MODEL'], '${HERMES_DEFAULT_MODEL:-${LLM_CHAT_MODEL}}')
        self.assertNotIn('whatsapp-hermes', doc['services'])
        self.assertEqual(doc['services']['whatsapp-personal']['environment']['EMERGENCY_DISABLE_SENDING'], '${EMERGENCY_DISABLE_SENDING:-false}')
        self.assertEqual(doc['services']['mcp-sse']['environment']['ENABLE_SENDING'], '${ENABLE_SENDING:-false}')

    def test_oidc_protects_app_without_changing_connector_auth(self):
        settings = {'WHATSAPP_APP_ENABLED': 'true', 'APP_AUTH_MODE': 'oidc',
                    'OIDC_ISSUER_URL': 'https://login.example.com/realms/private'}
        doc, _, _ = module.render(self.accounts, '/volume2/docker/social-media', module.ROOT,
                                  '/tmp/generated', settings)
        env = doc['services']['whatsapp-app']['environment']
        self.assertNotIn('UI_AUTH_PASSWORD', env)
        self.assertEqual(env['OIDC_ALLOWED_SUBJECTS'], '${OIDC_ALLOWED_SUBJECTS:?set in .env}')
        self.assertEqual(env['OIDC_CLIENT_SECRET'], '${OIDC_CLIENT_SECRET:?set in .env}')
        self.assertIn('UI_AUTH_PASSWORD', doc['services']['whatsapp-personal']['environment'])
        for invalid in ('', 'http://login.example.com/realms/private'):
            settings['OIDC_ISSUER_URL'] = invalid
            with self.assertRaises(ValueError):
                module.render(self.accounts, '/volume2/docker/social-media', module.ROOT,
                              '/tmp/generated', settings)

    def test_third_whatsapp_is_fully_generated(self):
        third = copy.deepcopy(self.accounts[1])
        third.update(accountId='business', connectorUrl='http://whatsapp-business:3001', secretEnv='WA_BUSINESS_SECRET')
        self.accounts.append(third)
        doc, registry, gateway = self.render()
        service = doc['services']['whatsapp-business']
        self.assertEqual(service['environment']['CONNECTOR_ACCOUNT'], 'business')
        self.assertEqual(service['environment']['WA_HISTORY_SYNC_ON_LOGIN'], '${WA_BUSINESS_HISTORY_SYNC_ON_LOGIN:-${WA_HISTORY_SYNC_ON_LOGIN:-false}}')
        self.assertEqual(service['environment']['S3_PREFIX'], '${WA_BUSINESS_S3_PREFIX:-whatsapp/business}')
        self.assertIn('/volume2/docker/social-media/data/whatsapp/business:/app/persistent-session', service['volumes'])
        self.assertIn('proxy_pass http://whatsapp-business:3001/', gateway)
        self.assertEqual(len(registry), 4)
        self.assertIn('WA_BUSINESS_SECRET', doc['services']['mcp-sse']['environment'])

    def test_duplicate_and_invalid_accounts_rejected(self):
        self.accounts.append(copy.deepcopy(self.accounts[0]))
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            self.render()
        self.accounts.pop()
        self.accounts[0]['accountId'] = '../bad'
        with self.assertRaises(ValueError):
            self.render()

    def test_ports_paths_and_existing_volume_identity(self):
        doc, registry, _ = self.render()
        for service in doc['services'].values():
            self.assertNotIn('ports', service)
        self.assertEqual(doc['volumes']['postgres_data']['name'], 'socialmedia_postgres_data')
        for name in ('postgres', 'redis', 'nats', 'minio'):
            self.assertIn('socialmedia-' + name, doc['services'][name]['networks']['default']['aliases'])
        env = doc['services']['mcp-sse']['environment']
        self.assertIn('${POSTGRES_HOST:-socialmedia-postgres}', env['DATABASE_URL'])
        self.assertEqual(env['REDIS_URL'], '${REDIS_URL:-rediss://socialmedia-redis:6379}')
        self.assertEqual(env['NATS_URL'], '${NATS_URL:-tls://socialmedia-nats:4222}')
        self.assertEqual(env['MINIO_ENDPOINT'], '${MINIO_ENDPOINT:-socialmedia-minio:9000}')
        for name in ('mcp-server', 'mcp-sse', 'whatsapp-personal', 'whatsapp-secondary', 'instagram-connector'):
            service = doc['services'][name]
            self.assertEqual(service['environment']['SOCIAL_ACCOUNTS_FILE'], '/config/accounts.json')
            self.assertIn('/tmp/generated/accounts.json:/config/accounts.json:ro', service['volumes'])
        self.assertNotIn('sessionPath', registry[0])
        self.assertIn('/volume2/docker/social-media/src/connectors/whatsapp-web/session-data:/app/persistent-session', doc['services']['whatsapp-personal']['volumes'])

    def test_isolated_secrets_and_literal_interpolation(self):
        doc, _, _ = self.render()
        personal = doc['services']['whatsapp-personal']['environment']
        secondary = doc['services']['whatsapp-secondary']['environment']
        self.assertEqual(personal['CONNECTOR_SHARED_SECRET'], '${WA_PERSONAL_SECRET:?set in .env}')
        self.assertEqual(secondary['CONNECTOR_SHARED_SECRET'], '${WA_SECONDARY_SECRET:?set in .env}')
        self.assertNotEqual(personal['SESSION_ENCRYPTION_KEY'], secondary['SESSION_ENCRYPTION_KEY'])
        self.assertEqual(personal['UI_BASE_PATH'], '/accounts/personal')
        self.assertEqual(personal['S3_PREFIX'], '${WA_PERSONAL_S3_PREFIX:-}')
        self.assertEqual(secondary['S3_PREFIX'], '${WA_SECONDARY_S3_PREFIX:-whatsapp/secondary}')
        self.assertNotIn('npm', doc['services']['whatsapp-personal']['networks'])
        self.assertNotIn('to_regclass', json.dumps(doc['services']['migrate']))

    def test_disabled_connector_has_no_gateway_route(self):
        self.accounts[1]['enabled'] = False
        doc, registry, gateway = self.render()
        self.assertNotIn('whatsapp-secondary', doc['services'])
        self.assertNotIn('/accounts/secondary/', gateway)
        self.assertFalse(registry[1]['enabled'])

    def test_unknown_fields_and_urls_rejected(self):
        self.accounts[0]['password'] = 'never allowed'
        with self.assertRaises(ValueError):
            self.render()
        del self.accounts[0]['password']
        self.accounts[0]['connectorUrl'] = 'file:///wrong'
        with self.assertRaises(ValueError):
            self.render()

    def test_domains_propagate_and_account_overrides(self):
        config = {'PUBLIC_BASE_URL': 'https://social.example.org', 'WHATSAPP_PUBLIC_BASE_URL': 'https://wa.example.org', 'WA_SECONDARY_QR_PAGE_URL': '${WHATSAPP_PUBLIC_BASE_URL}/custom/qr', 'WA_SECONDARY_CONNECTOR_URL': 'http://secondary.remote:3001'}
        doc, registry, gateway = module.render(self.accounts, '/tmp/stack', module.ROOT, '/tmp/out', config)
        self.assertEqual(registry[0]['qrUrl'], 'https://wa.example.org/accounts/personal/qr/page')
        self.assertEqual(registry[1]['qrUrl'], 'https://wa.example.org/custom/qr')
        self.assertEqual(doc['services']['whatsapp-secondary']['environment']['QR_PAGE_URL'], registry[1]['qrUrl'])
        self.assertEqual(doc['services']['mcp-sse']['environment']['PUBLIC_BASE_URL'], config['PUBLIC_BASE_URL'])
        self.assertIn('proxy_pass http://secondary.remote:3001/', gateway)
        self.assertIn('https://wa.example.org/custom/qr', gateway)
        self.assertNotIn('staticduo.com', json.dumps([doc, registry, gateway]))

    def test_env_file_is_data_and_secrets_are_not_rendered(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / '.env'
            path.write_text('PUBLIC_BASE_URL="https://social.example.org" # comment\nWHATSAPP_PUBLIC_BASE_URL=https://wa.example.org\nPOSTGRES_PASSWORD=secret-never-render\nWA_PERSONAL_SECRET=$(touch /tmp/never-run-render)\n')
            settings = module.read_env(path)
            self.assertEqual(settings['WA_PERSONAL_SECRET'], '$(touch /tmp/never-run-render)')
            output = module.render(self.accounts, '/tmp/stack', module.ROOT, '/tmp/out', settings)
            self.assertNotIn('secret-never-render', json.dumps(output))
            self.assertNotIn('$(touch', json.dumps(output))

    def test_https_upstream_verifies_certificate_and_sends_sni(self):
        settings = {'WA_PERSONAL_CONNECTOR_URL': 'https://connector.example.org:3443'}
        doc, _, gateway = module.render(self.accounts, '/tmp/stack', module.ROOT, '/tmp/out', settings)
        self.assertIn('proxy_ssl_server_name on;', gateway)
        self.assertIn('proxy_ssl_verify on;', gateway)
        self.assertIn('proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;', gateway)
        self.assertIn('proxy_set_header Host $proxy_host;', gateway)
        self.assertNotIn('proxy_set_header Host $host;', gateway)
        settings['GATEWAY_UPSTREAM_CA_FILE'] = '/tmp/private-ca.crt'
        doc, _, gateway = module.render(self.accounts, '/tmp/stack', module.ROOT, '/tmp/out', settings)
        self.assertIn('proxy_ssl_trusted_certificate /etc/nginx/upstream-ca.crt;', gateway)
        self.assertIn({'type': 'bind', 'source': '/tmp/private-ca.crt', 'target': '/etc/nginx/upstream-ca.crt', 'read_only': True}, doc['services']['gateway']['volumes'])
        settings['GATEWAY_UPSTREAM_CA_FILE'] = 'relative.crt'
        with self.assertRaisesRegex(ValueError, 'absolute host path'):
            module.render(self.accounts, '/tmp/stack', module.ROOT, '/tmp/out', settings)

    def test_certificate_paths_allow_explicit_system_trust(self):
        doc, _, _ = module.render(self.accounts, '/tmp/stack', module.ROOT, '/tmp/out', {'CERTS_DIR': '/tmp/certificates'})
        env = doc['services']['mcp-sse']['environment']
        for key in ('MINIO_CA_CERT', 'NATS_CA_CERT', 'REDIS_TLS_CA', 'NODE_EXTRA_CA_CERTS'):
            self.assertEqual(env[key], '${' + key + '-/certs/ca.crt}')
        self.assertIn('/tmp/certificates/ca.crt:/certs/ca.crt:ro', doc['services']['mcp-sse']['volumes'])

    def test_runtime_endpoint_and_provider_forwarding(self):
        doc, _, _ = self.render()
        mcp = doc['services']['mcp-sse']['environment']
        wa = doc['services']['whatsapp-personal']['environment']
        ig = doc['services']['instagram-connector']['environment']
        for key in ('S3_ENDPOINT', 'S3_BUCKET', 'AWS_ACCESS_KEY_ID', 'LEGACY_MINIO_ENDPOINT', 'WHATSAPP_LINK_BASE_URL'):
            self.assertEqual(mcp[key], '${' + key + ':-}')
            self.assertEqual(wa[key], '${' + key + ':-}')
        for key in ('S3_PUBLIC_ENDPOINT', 'WHATSAPP_WEBSOCKET_URL', 'WHATSAPP_ORIGIN'):
            self.assertIn(key, wa)
        for suffix in ('APP_ID', 'APP_SECRET', 'FB_ACCESS_TOKEN'):
            self.assertIn('INSTAGRAM_INSTAGRAM_' + suffix, ig)
        self.assertEqual(wa['DASHBOARD_URL'], '${DASHBOARD_URL:-}')

    def test_invalid_and_missing_env_values_fail(self):
        for settings in ({'PUBLIC_BASE_URL': ''}, {'WHATSAPP_PUBLIC_BASE_URL': '${MISSING}'}, {'WA_PERSONAL_CONNECTOR_URL': 'http://host/;bad'}):
            with self.assertRaises(ValueError):
                module.render(self.accounts, '/tmp/stack', module.ROOT, '/tmp/out', settings)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / '.env'
            path.write_text('BROKEN="unterminated\n')
            with self.assertRaisesRegex(ValueError, 'invalid quoted'):
                module.read_env(path)



if __name__ == '__main__':
    unittest.main()
