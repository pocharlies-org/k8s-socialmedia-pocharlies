#!/usr/bin/env python3
"""Render a registry-driven Compose document using only the Python standard library."""
import argparse
import copy
import html
import json
import os
from urllib.parse import urlsplit
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
ID = re.compile(r'^[a-z][a-z0-9_-]*$')
ENV = re.compile(r'^[A-Z][A-Z0-9_]*$')
FIELDS = {'channel', 'accountId', 'label', 'connectorUrl', 'enabled', 'qrUrl', 'requireInboundBeforeSend', 'secretEnv', 'sessionPath'}


SUBSTITUTION = re.compile(r'\$\{([A-Z][A-Z0-9_]*)(?:(:-|:\?)([^{}]*))?\}')


def expand(value, settings):
    def substitute(match):
        name, operator, fallback = match.groups()
        found = settings.get(name)
        if found is not None and (found or operator is None):
            return found
        if operator == ':-':
            return fallback
        raise ValueError('missing environment variable: ' + name)
    for _ in range(30):
        if '${' not in value:
            return value
        updated = SUBSTITUTION.sub(substitute, value)
        if updated == value:
            raise ValueError('unresolved or cyclic environment expression')
        value = updated
    raise ValueError('environment expansion exceeds 30 levels')


def read_env(path):
    """Parse assignments as data. Never source a file or execute substitutions."""
    values = {}
    for number, line in enumerate(path.read_text().splitlines(), 1):
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('export '):
            line = line[7:].lstrip()
        key, sep, value = line.partition('=')
        key, value = key.strip(), value.strip()
        if not sep or not ENV.fullmatch(key):
            raise ValueError(f'{path}:{number}: expected UPPERCASE_NAME=value')
        if value.startswith(('"', "'")):
            quote = value[0]
            match = re.fullmatch(r"(['\"])(.*?)\1\s*(?:#.*)?", value)
            if not match:
                raise ValueError(f'{path}:{number}: invalid quoted value')
            value = match[2]
        else:
            value = re.split(r'\s+#', value, maxsplit=1)[0].rstrip()
        values[key] = value
    return values


def url(value, field, schemes=('http', 'https')):
    if not isinstance(value, str):
        raise ValueError(field + ' must be a URL string')
    parsed = urlsplit(value)
    if parsed.scheme not in schemes or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or any(c.isspace() or c in ";{}\\\"'$" for c in value):
        raise ValueError(field + ' must be an absolute URL without credentials')
    try:
        parsed.port
    except ValueError as exc:
        raise ValueError(field + ' has an invalid port') from exc
    return value


def prepare_accounts(accounts, settings):
    if not isinstance(accounts, list) or not accounts:
        raise ValueError('accounts must be a nonempty JSON array')
    result = copy.deepcopy(accounts)
    public = url(expand(settings.get('WHATSAPP_PUBLIC_BASE_URL', 'https://localhost'), settings), 'WHATSAPP_PUBLIC_BASE_URL').rstrip('/')
    for account in result:
        if not isinstance(account, dict):
            continue
        for key, value in account.items():
            if isinstance(value, str):
                account[key] = expand(value, settings)
        aid = account.get('accountId', '')
        prefix = 'WA_' + aid.upper().replace('-', '_')
        if account.get('channel') == 'whatsapp':
            account['connectorUrl'] = expand(settings.get(prefix + '_CONNECTOR_URL', account.get('connectorUrl', f'http://whatsapp-{aid}:3001')), settings)
            account['qrUrl'] = expand(settings.get(prefix + '_QR_PAGE_URL', account.get('qrUrl', public + f'/accounts/{aid}/qr/page')), settings)
            if prefix + '_SESSION_PATH' in settings:
                account['sessionPath'] = expand(settings[prefix + '_SESSION_PATH'], settings)
        else:
            account['connectorUrl'] = expand(settings.get('INSTAGRAM_CONNECTOR_URL', account.get('connectorUrl', 'http://instagram-connector:3003')), settings)
    return result


def variable(name, required=False):
    return '${' + name + (':?set in .env' if required else ':-') + '}'


def validate(accounts):
    if not isinstance(accounts, list) or not accounts:
        raise ValueError('accounts must be a nonempty JSON array')
    seen = set()
    normalized = set()
    for a in accounts:
        if not isinstance(a, dict) or set(a) - FIELDS:
            raise ValueError('unknown account fields')
        for key in ('channel', 'accountId', 'label', 'connectorUrl', 'enabled'):
            if key not in a:
                raise ValueError('missing account field: ' + key)
        if a['channel'] not in ('whatsapp', 'instagram') or not isinstance(a['accountId'], str) or not ID.fullmatch(a['accountId']):
            raise ValueError('invalid channel or accountId')
        pair = (a['channel'], a['accountId'])
        if pair in seen:
            raise ValueError('duplicate account: ' + str(pair))
        seen.add(pair)
        env_pair = (a['channel'], a['accountId'].upper().replace('-', '_'))
        if env_pair in normalized:
            raise ValueError('accountIds collide after environment variable normalization')
        normalized.add(env_pair)
        if not isinstance(a['enabled'], bool) or not isinstance(a['label'], str) or not a['label'].strip():
            raise ValueError('invalid enabled or label')
        if 'requireInboundBeforeSend' in a and not isinstance(a['requireInboundBeforeSend'], bool):
            raise ValueError('requireInboundBeforeSend must be boolean')
        url(a['connectorUrl'], 'connectorUrl')
        if urlsplit(a['connectorUrl']).query or urlsplit(a['connectorUrl']).fragment:
            raise ValueError('connectorUrl must not contain a query or fragment')
        if not ENV.fullmatch(a.get('secretEnv', '')):
            raise ValueError('secretEnv must name an uppercase environment variable')
        if 'sessionPath' in a and (a['channel'] != 'whatsapp' or not isinstance(a['sessionPath'], str) or not Path(a['sessionPath']).is_absolute()):
            raise ValueError('sessionPath must be an absolute WhatsApp session path')
        if 'qrUrl' in a:
            url(a['qrUrl'], 'qrUrl', ('https',))
    return accounts


def render(accounts, stack_dir, source_dir, output_dir, settings=None):
    settings = settings or {}
    accounts = prepare_accounts(accounts, settings)
    validate(accounts)
    public = url(expand(settings.get('PUBLIC_BASE_URL', 'https://localhost'), settings), 'PUBLIC_BASE_URL')
    wa_public = url(expand(settings.get('WHATSAPP_PUBLIC_BASE_URL', 'https://localhost'), settings), 'WHATSAPP_PUBLIC_BASE_URL')
    def configurable(name, default=''):
        return '${' + name + ':-' + default + '}'
    stack_dir, source_dir, output_dir = map(lambda p: Path(p).resolve(), (stack_dir, source_dir, output_dir))
    certs_dir = Path(expand(settings.get('CERTS_DIR', str(stack_dir / 'config' / 'certs')), settings))
    if not certs_dir.is_absolute():
        raise ValueError('CERTS_DIR must be an absolute host path')
    cert = lambda name, target=None: f'{certs_dir}/{name}:/certs/{target or name}:ro'
    health = lambda port, path='/health': {'test': ['CMD', 'node', '-e', f"require('http').get('http://127.0.0.1:{port}{path}',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"], 'interval': '30s', 'timeout': '5s', 'retries': 3, 'start_period': '60s'}
    logging = {'driver': 'json-file', 'options': {'max-size': '10m', 'max-file': '3'}}
    services = {}
    def base(image=None):
        s = {'restart': 'unless-stopped', 'networks': {'default': {}}, 'logging': copy.deepcopy(logging)}
        if image:
            s['image'] = image
        return s
    database = '${DATABASE_URL:-postgresql://${POSTGRES_USER:-whatsappmcp}:${POSTGRES_PASSWORD}@${POSTGRES_HOST:-socialmedia-postgres}:${POSTGRES_PORT:-5432}/${POSTGRES_DB:-whatsappmcp}?sslmode=${POSTGRES_SSLMODE:-disable}}'
    for name, image in [('postgres', 'pgvector/pgvector:pg16'), ('redis', 'redis:7-alpine'), ('nats', 'nats:2.10-alpine'), ('minio', 'quay.io/minio/minio:latest')]:
        services[name] = base(configurable(name.upper() + '_IMAGE', image))
        services[name]['networks']['default'] = {'aliases': ['socialmedia-' + name]}
    services['postgres'].update(environment={'POSTGRES_DB': configurable('POSTGRES_DB', 'whatsappmcp'), 'POSTGRES_USER': configurable('POSTGRES_USER', 'whatsappmcp'), 'POSTGRES_PASSWORD': variable('POSTGRES_PASSWORD', True)}, volumes=['postgres_data:/var/lib/postgresql/data', cert('postgres.crt', 'server.crt'), cert('postgres.key', 'server.key'), cert('ca.crt')], command=['bash', '-c', 'mkdir -p /var/lib/postgresql/certs\ncp /certs/server.crt /certs/server.key /certs/ca.crt /var/lib/postgresql/certs/\nchown -R postgres:postgres /var/lib/postgresql/certs\nchmod 600 /var/lib/postgresql/certs/server.key\nchmod 644 /var/lib/postgresql/certs/server.crt /var/lib/postgresql/certs/ca.crt\nexec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/var/lib/postgresql/certs/server.crt -c ssl_key_file=/var/lib/postgresql/certs/server.key -c ssl_ca_file=/var/lib/postgresql/certs/ca.crt'], healthcheck={'test': ['CMD-SHELL', 'pg_isready -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"'], 'interval': '10s', 'timeout': '5s', 'retries': 5})
    services['redis'].update(volumes=['redis_data:/data', f'{source_dir}/config/redis/redis.conf:/usr/local/etc/redis/redis.conf:ro', cert('redis.crt'), cert('redis.key'), cert('ca.crt')], command=['redis-server', '/usr/local/etc/redis/redis.conf'], healthcheck={'test': ['CMD', 'redis-cli', '--tls', '--cert', '/certs/redis.crt', '--key', '/certs/redis.key', '--cacert', '/certs/ca.crt', 'ping'], 'interval': '10s', 'timeout': '5s', 'retries': 5})
    services['nats'].update(volumes=['nats_data:/data', f'{source_dir}/config/nats/nats.conf:/etc/nats/nats.conf:ro', cert('nats.crt'), cert('nats.key'), cert('ca.crt')], command=['-c', '/etc/nats/nats.conf'], healthcheck={'test': ['CMD', 'wget', '--spider', '-q', 'http://127.0.0.1:8222/healthz'], 'interval': '10s', 'timeout': '5s', 'retries': 5})
    services['minio'].update(volumes=['minio_data:/data', cert('minio.crt', 'public.crt'), cert('minio.key', 'private.key'), cert('ca.crt', 'CAs/ca.crt')], environment={'MINIO_ROOT_USER': variable('MINIO_ROOT_USER', True), 'MINIO_ROOT_PASSWORD': variable('MINIO_ROOT_PASSWORD', True)}, command=['server', '/data', '--console-address', ':9001', '--certs-dir', '/certs'], healthcheck={'test': ['CMD', 'curl', '-k', '-f', 'https://localhost:9000/minio/health/live'], 'interval': '30s', 'timeout': '20s', 'retries': 3})
    common = {'DATABASE_URL': database, 'NATS_URL': configurable('NATS_URL', 'tls://socialmedia-nats:4222'), 'NATS_CA_CERT': '${NATS_CA_CERT-/certs/ca.crt}', 'NODE_EXTRA_CA_CERTS': '${NODE_EXTRA_CA_CERTS-/certs/ca.crt}', 'SOCIAL_ACCOUNTS_FILE': '/config/accounts.json'}
    minio = {'MINIO_ENDPOINT': configurable('MINIO_ENDPOINT', 'socialmedia-minio:9000'), 'MINIO_ACCESS_KEY': '${MINIO_ACCESS_KEY:-${MINIO_ROOT_USER}}', 'MINIO_SECRET_KEY': '${MINIO_SECRET_KEY:-${MINIO_ROOT_PASSWORD}}', 'MINIO_USE_SSL': configurable('MINIO_USE_SSL', 'true'), 'MINIO_CA_CERT': '${MINIO_CA_CERT-/certs/ca.crt}', 'MINIO_BUCKET': configurable('MINIO_BUCKET', 'socialmedia-media')}
    for key in ('S3_ENDPOINT', 'S3_BUCKET', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'LEGACY_MINIO_ENDPOINT', 'LEGACY_MINIO_BUCKET', 'LEGACY_MINIO_ACCESS_KEY', 'LEGACY_MINIO_SECRET_KEY'):
        minio[key] = variable(key)
    def app(folder, entry):
        s = base()
        s.update(build={'context': str(source_dir), 'dockerfile': folder + '/Dockerfile'}, command=['sh', '-c', f'cd {folder} && tsx {entry}'], environment=copy.deepcopy(common), volumes=[cert('ca.crt'), cert('client.crt'), cert('client.key'), f'{output_dir}/accounts.json:/config/accounts.json:ro'], depends_on={'migrate': {'condition': 'service_completed_successfully'}, 'nats': {'condition': 'service_healthy'}})
        return s
    migration = app('mcp-server', 'src/infrastructure/database/migrate.ts')
    migration.update(restart='no', depends_on={'postgres': {'condition': 'service_healthy'}}, environment={'DATABASE_URL': database}, volumes=[])
    services['migrate'] = migration
    for name, entry, port in [('mcp-server', 'src/main.ts', 3000), ('mcp-sse', 'src/mcp/sse-server.ts', 3010)]:
        s = app('mcp-server', entry)
        s['networks']['llm'] = {}
        if name == 'mcp-sse':
            s['networks']['npm'] = {'aliases': ['socialmedia-mcp-sse']}
            s['environment']['HERMES_CHAT_TOOL_SECRET'] = configurable('HERMES_CHAT_TOOL_SECRET')
            s['environment']['HERMES_CHAT_ALLOW_PROPOSALS'] = configurable('HERMES_CHAT_ALLOW_PROPOSALS', 'false')
            s['environment']['HERMES_CHAT_ALLOW_DIRECT_SEND'] = configurable('HERMES_CHAT_ALLOW_DIRECT_SEND', 'false')
        s['environment'].update(minio)
        s['environment'].update(PUBLIC_BASE_URL=public, WHATSAPP_PUBLIC_BASE_URL=wa_public, WHATSAPP_LINK_BASE_URL=variable('WHATSAPP_LINK_BASE_URL'), S3_PREFIX=variable('S3_PREFIX'))
        s['environment'].update({'REDIS_URL': configurable('REDIS_URL', 'rediss://socialmedia-redis:6379'), 'REDIS_TLS_CA': '${REDIS_TLS_CA-/certs/ca.crt}', 'ENCRYPTION_KEY': variable('ENCRYPTION_KEY', True), 'ENABLE_SENDING': '${ENABLE_SENDING:-false}', 'EMERGENCY_DISABLE_SENDING': '${EMERGENCY_DISABLE_SENDING:-false}', 'PORT': str(port), 'MCP_SSE_PORT': str(port), 'MCP_SSE_AUTH_TOKEN': variable('MCP_SSE_AUTH_TOKEN', True)})
        for key in ('OPENAI_API_KEY', 'EMBEDDING_BASE_URL', 'LLM_BASE_URL', 'LLM_CHAT_MODEL'):
            s['environment'][key] = variable(key)
        s['environment']['EMBEDDING_BASE_URL'] = '${EMBEDDING_BASE_URL:-http://litellm:4000/v1}'
        s['environment']['LLM_BASE_URL'] = '${LLM_BASE_URL:-http://litellm:4000/v1}'
        s['environment']['LLM_CHAT_MODEL'] = '${LLM_CHAT_MODEL:-gpt-5.6-luna}'
        s['environment'].update(EMBEDDING_MODEL='${EMBEDDING_MODEL:-qwen3-embedding-8b}', EMBEDDING_DIMENSION='${EMBEDDING_DIMENSION:-4096}')
        for a in accounts:
            if a['enabled']:
                s['environment'][a['secretEnv']] = variable(a['secretEnv'], True)
        s['depends_on'].update({n: {'condition': 'service_healthy'} for n in ('redis', 'minio')})
        s['healthcheck'] = health(port)
        services[name] = s
    wa = [a for a in accounts if a['enabled'] and a['channel'] == 'whatsapp']
    for a in wa:
        aid = a['accountId']
        s = app('connectors/whatsapp-web', 'src/main.ts')
        s['environment'].update(minio)
        s['environment'].update(CONNECTOR_ACCOUNT=aid, CONNECTOR_SHARED_SECRET=variable(a['secretEnv'], True), SESSION_ENCRYPTION_KEY=variable('WA_' + aid.upper().replace('-', '_') + '_SESSION_KEY', True), SESSION_PATH='/app/persistent-session', PORT='3001', ENABLE_SENDING='${WA_ENABLE_SENDING:-${ENABLE_SENDING:-false}}', EMERGENCY_DISABLE_SENDING='${EMERGENCY_DISABLE_SENDING:-false}', UI_AUTH_USERNAME=variable('UI_AUTH_USERNAME', True), UI_AUTH_PASSWORD=variable('UI_AUTH_PASSWORD', True), UI_BASE_PATH='/accounts/' + aid, QR_PAGE_URL=a['qrUrl'], DASHBOARD_URL=configurable('DASHBOARD_URL'))
        for key in ('WHATSAPP_WEBSOCKET_URL', 'WHATSAPP_ORIGIN', 'WHATSAPP_LINK_BASE_URL', 'S3_PUBLIC_ENDPOINT', 'S3_PRESIGN_EXPIRY_SECONDS', 'S3_USE_SSL', 'LEGACY_MINIO_USE_SSL'):
            s['environment'][key] = variable(key)
        # Keep existing personal object keys; isolate new accounts' avatar keys.
        s['environment']['S3_PREFIX'] = configurable('WA_' + aid.upper().replace('-', '_') + '_S3_PREFIX', '' if aid == 'personal' else 'whatsapp/' + aid)
        s['environment']['WA_HISTORY_SYNC_ON_LOGIN'] = '${WA_' + aid.upper().replace('-', '_') + '_HISTORY_SYNC_ON_LOGIN:-${WA_HISTORY_SYNC_ON_LOGIN:-false}}'
        s['volumes'].append(f"{a.get('sessionPath', str(stack_dir / 'data' / 'whatsapp' / aid))}:/app/persistent-session")
        s['depends_on']['minio'] = {'condition': 'service_healthy'}
        s['healthcheck'] = health(3001, '/api/v1/health')
        services['whatsapp-' + aid] = s
    ig = [a for a in accounts if a['enabled'] and a['channel'] == 'instagram']
    if ig:
        s = app('connectors/instagram', 'src/main.ts')
        for key in ('INSTAGRAM_GRAPH_BASE_URL', 'FACEBOOK_GRAPH_BASE_URL'):
            s['environment'][key] = variable(key)
        s['environment'].update(INSTAGRAM_ACCOUNTS=','.join(a['accountId'] for a in ig), PORT='3003')
        for a in ig:
            for suffix in ('ACCESS_TOKEN', 'BUSINESS_ACCOUNT_ID', 'APP_ID', 'APP_SECRET', 'FB_ACCESS_TOKEN'):
                key = 'INSTAGRAM_' + a['accountId'].upper().replace('-', '_') + '_' + suffix
                s['environment'][key] = variable(key)
            s['environment'][a['secretEnv']] = variable(a['secretEnv'], True)
        s['environment']['CONNECTOR_SHARED_SECRET'] = variable(ig[0]['secretEnv'], True)
        for key in ('FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET', 'INSTAGRAM_WEBHOOK_VERIFY_TOKEN'):
            s['environment']['WEBHOOK_VERIFY_TOKEN' if key == 'INSTAGRAM_WEBHOOK_VERIFY_TOKEN' else key] = variable(key)
        s['healthcheck'] = health(3003)
        services['instagram-connector'] = s
    if settings.get('WHATSAPP_APP_ENABLED', 'false').lower() == 'true':
        url(expand(settings.get('WHATSAPP_APP_PUBLIC_URL', 'https://localhost'), settings), 'WHATSAPP_APP_PUBLIC_URL')
        ui = base()
        ui.update(build={'context': str(source_dir / 'apps/whatsapp')},
                  user='${WHATSAPP_APP_UID:-1000}:${WHATSAPP_APP_GID:-10}',
                  networks={'default': {}, 'npm': {'aliases': ['socialmedia-whatsapp-app']}, 'llm': {}},
                  volumes=[f'{output_dir}/accounts.json:/config/accounts.json:ro',
                           f'{stack_dir}/data/whatsapp-app:/data', cert('ca.crt')],
                  environment={'PORT': '3080', 'DATA_DIR': '/data', 'TZ': '${TZ:-Europe/Madrid}',
                               'SOCIAL_ACCOUNTS_FILE': '/config/accounts.json',
                               'DATABASE_URL': database,
                               'APP_PUBLIC_URL': configurable('WHATSAPP_APP_PUBLIC_URL', 'https://localhost'),
                               'APP_ENABLE_SENDING': configurable('APP_ENABLE_SENDING', 'false'),
                               'EMERGENCY_DISABLE_SENDING': configurable('EMERGENCY_DISABLE_SENDING', 'false'),
                               'APP_AUTH_MODE': configurable('APP_AUTH_MODE', 'basic'),
                               'NODE_EXTRA_CA_CERTS': '/certs/ca.crt',
                               'LITELLM_BASE_URL': '${LITELLM_BASE_URL:-${LLM_BASE_URL:-http://litellm:4000/v1}}',
                               'LITELLM_API_KEY': '${LITELLM_API_KEY:-${OPENAI_API_KEY}}',
                               'HERMES_API_URL': variable('HERMES_API_URL'),
                               'HERMES_API_KEY': variable('HERMES_API_KEY'),
                               'HERMES_DEFAULT_MODEL': '${HERMES_DEFAULT_MODEL:-${LLM_CHAT_MODEL}}',
                               'HERMES_PROVIDER': configurable('HERMES_PROVIDER', 'socialmedia-litellm')},
                  healthcheck=health(3080))
        auth_mode = settings.get('APP_AUTH_MODE', 'basic')
        if auth_mode not in ('basic', 'oidc'):
            raise ValueError('APP_AUTH_MODE must be basic or oidc')
        if auth_mode == 'oidc':
            url(expand(settings.get('OIDC_ISSUER_URL', ''), settings), 'OIDC_ISSUER_URL', ('https',))
            for key in ('OIDC_ISSUER_URL', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_ALLOWED_SUBJECTS'):
                ui['environment'][key] = variable(key, True)
            ui['environment']['OIDC_SESSION_TTL_SECONDS'] = configurable('OIDC_SESSION_TTL_SECONDS', '2592000')
        else:
            for key in ('UI_AUTH_USERNAME', 'UI_AUTH_PASSWORD'):
                ui['environment'][key] = variable(key, True)
        ui['environment'].update(minio)
        ui['environment']['APP_AI_DEFAULT_MODEL'] = '${APP_AI_DEFAULT_MODEL:-${LLM_CHAT_MODEL}}'
        ui['environment']['APP_AI_MODELS'] = variable('APP_AI_MODELS')
        ui['environment']['MEDIA_ALLOWED_ORIGINS'] = variable('MEDIA_ALLOWED_ORIGINS')
        ui['environment']['HERMES_CHAT_TOOL_SECRET'] = configurable('HERMES_CHAT_TOOL_SECRET')
        ui['environment']['HERMES_CHAT_ALLOW_PROPOSALS'] = configurable('HERMES_CHAT_ALLOW_PROPOSALS', 'false')
        ui['environment']['HERMES_CHAT_ALLOW_DIRECT_SEND'] = configurable('HERMES_CHAT_ALLOW_DIRECT_SEND', 'false')
        ui['environment']['HERMES_CHAT_TOOL_INTERNAL_URL'] = 'http://mcp-sse:3010'
        for key, default in (
            ('APP_AVATAR_CACHE_TTL_MS', '30000'),
            ('APP_AVATAR_NEGATIVE_CACHE_TTL_MS', '5000'),
            ('APP_AVATAR_CACHE_MAX_ENTRIES', '256'),
            ('APP_AVATAR_CACHE_MAX_BYTES', '16777216'),
        ):
            ui['environment'][key] = configurable(key, default)
        ui['environment']['S3_USE_SSL'] = variable('S3_USE_SSL')
        for a in wa:
            ui['environment'][a['secretEnv']] = variable(a['secretEnv'], True)
        services['whatsapp-app'] = ui
        if settings.get('WHATSAPP_HERMES_ENABLED', 'false').lower() == 'true':
            agent = base()
            agent.update(build={'context': str(source_dir / 'apps/whatsapp/hermes')},
                         networks={'default': {}, 'llm': {}},
                         volumes=[f'{stack_dir}/data/whatsapp-hermes:/data'],
                         environment={'HERMES_HOME': '/data',
                                      'HERMES_API_KEY': variable('HERMES_API_KEY', True),
                                      'HERMES_DEFAULT_MODEL': '${HERMES_DEFAULT_MODEL:-${LLM_CHAT_MODEL}}',
                                      'LITELLM_BASE_URL': '${LITELLM_BASE_URL:-${LLM_BASE_URL:-http://litellm:4000/v1}}',
                                      'LITELLM_API_KEY': '${LITELLM_API_KEY:-${OPENAI_API_KEY}}',
                                      'MCP_URL': '${WHATSAPP_APP_MCP_URL:-http://mcp-sse:3010/mcp}',
                                      'MCP_TOKEN': variable('MCP_SSE_AUTH_TOKEN', True)},
                         healthcheck={'test': ['CMD', 'python', '-c', "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8642/health',timeout=4)"],
                                      'interval': '30s', 'timeout': '5s', 'retries': 3, 'start_period': '60s'})
            services['whatsapp-hermes'] = agent
    links = ''.join(f'<li><a href="{html.escape(a["qrUrl"], quote=True)}">{html.escape(a["label"])}</a></li>' for a in wa)
    # Escape quotes and backslashes for an nginx single-quoted return value.
    page = ('<!doctype html><title>WhatsApp accounts</title><h1>WhatsApp accounts</h1><ul>' + links + '</ul>').replace('\\', '\\\\').replace("'", "\\'").replace('$', '&#36;')
    upstream_ca = expand(settings.get('GATEWAY_UPSTREAM_CA_FILE', ''), settings)
    if upstream_ca and not Path(upstream_ca).is_absolute():
        raise ValueError('GATEWAY_UPSTREAM_CA_FILE must be an absolute host path')
    ca_target = '/etc/nginx/upstream-ca.crt' if upstream_ca else '/etc/ssl/certs/ca-certificates.crt'
    gateway = "server {\n  listen 80;\n  location = / { default_type text/html; return 200 '" + page + "'; }\n"
    for a in wa:
        aid = a['accountId']
        tls = ''
        if urlsplit(a['connectorUrl']).scheme == 'https':
            tls = f'    proxy_ssl_server_name on;\n    proxy_ssl_verify on;\n    proxy_ssl_trusted_certificate {ca_target};\n'
        gateway += f'  location /accounts/{aid}/ {{\n    proxy_pass {a["connectorUrl"].rstrip("/")}/;\n    proxy_http_version 1.1;\n    proxy_set_header Host $proxy_host;\n    proxy_set_header X-Forwarded-Proto $scheme;\n    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n    proxy_buffering off;\n{tls}  }}\n'
    gateway += '  location / { return 404; }\n}\n'
    s = base(configurable('GATEWAY_IMAGE', 'nginx:alpine'))
    s.update(networks={'default': {}, 'npm': {'aliases': ['socialmedia-wa']}}, volumes=[f'{output_dir}/gateway.conf:/etc/nginx/conf.d/default.conf:ro'], depends_on={'whatsapp-' + a['accountId']: {'condition': 'service_started'} for a in wa})
    if upstream_ca:
        s['volumes'].append({'type': 'bind', 'source': upstream_ca, 'target': ca_target, 'read_only': True})
    services['gateway'] = s
    registry = [{k: v for k, v in a.items() if k != 'sessionPath'} for a in accounts]
    return {'name': configurable('COMPOSE_PROJECT_NAME', 'socialmedia'), 'services': services, 'networks': {'default': {'name': configurable('STACK_NETWORK', 'socialmedia')}, 'npm': {'external': True, 'name': configurable('NPM_NETWORK', 'npm_npm-net')}, 'llm': {'external': True, 'name': configurable('LLM_NETWORK', 'llm-net')}}, 'volumes': {n + '_data': {'name': 'socialmedia_' + n + '_data'} for n in ('postgres', 'redis', 'nats', 'minio')}}, registry, gateway


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', type=Path, help='Private environment file also passed to docker compose')
    parser.add_argument('--accounts', type=Path, default=ROOT / 'deploy/accounts.json')
    parser.add_argument('--stack-dir', type=Path, default=Path('/volume2/docker/social-media'))
    parser.add_argument('--source-dir', type=Path, default=ROOT)
    parser.add_argument('--output', type=Path, default=ROOT / 'deploy/generated/docker-compose.json')
    args = parser.parse_args()
    try:
        settings = read_env(args.env_file) if args.env_file else {}
        settings.update(os.environ)
        stack_dir = expand(settings.get('STACK_DIR', str(args.stack_dir)), settings)
        source_dir = expand(settings.get('SOURCE_DIR', str(args.source_dir)), settings)
        result, registry, gateway = render(json.loads(args.accounts.read_text()), stack_dir, source_dir, args.output.parent, settings)
        if args.output.resolve() == args.accounts.resolve() or args.output.name in ('accounts.json', 'gateway.conf'):
            raise ValueError('output must not overwrite an input or sidecar file')
        if (args.output.parent / 'accounts.json').resolve() == args.accounts.resolve():
            raise ValueError('output directory must differ from input registry directory')
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, indent=2) + '\n')
        (args.output.parent / 'accounts.json').write_text(json.dumps(registry, indent=2) + '\n')
        (args.output.parent / 'gateway.conf').write_text(gateway)
    except (ValueError, OSError) as exc:
        parser.error(str(exc))


if __name__ == '__main__':
    main()
