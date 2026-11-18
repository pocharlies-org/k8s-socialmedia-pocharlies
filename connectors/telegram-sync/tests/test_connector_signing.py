"""The connector HMAC of telegram-sync's calls (SKIRM-111).

The vectors are fixed: they are what the connector's own signer
(shared/src/crypto/encryption.ts generateHMACSignature, the one its
authMiddleware verifies) gives for the same secret, timestamp and body, and
connectors/telegram/src/api/public-routes.test.ts asserts the same literals on
the Node side. A Python signer that drifts (key order, spacing, escapes,
non-ASCII) fails here before the connector answers 401.
"""
import json
import unittest
from unittest.mock import patch

import httpx

from sync.connector_client import ConnectorClient, _compact

SECRET = 'vector-secret-not-a-real-key'
TIMESTAMP = 1760000000
VECTORS = [
    ({}, 'sha256=9c13b5d911180ca8afe1a2f4e6d7da93068aca9168ddb0d0e66781915f2a76af'),
    ({'text': 'hola'}, 'sha256=afcb691954c420b230066c0959302dd152b62921ec75013c6811b19b6f7f6ddc'),
    ({'text': 'ñandú ☃ "q" \\ \n\t línea', 'topicId': 42},
     'sha256=c92ca6dc3907aaa9cd70640b6a66253bde649d6476b9deadcb017a628e0fc44d'),
    ({'text': 'hola 👍🏽'}, 'sha256=267114fcccf55614d21e00f4b3b58281f134a9310c6179435a700740a03d56d6'),
]


class SigningTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.requests = []
        self.client = ConnectorClient('http://connector', SECRET)
        await self.client._client.aclose()
        self.client._client = httpx.AsyncClient(transport=httpx.MockTransport(self.handle))

    async def asyncTearDown(self):
        await self.client.aclose()

    def handle(self, request):
        self.requests.append(request)
        return httpx.Response(200, json={'success': True})

    def test_signature_matches_the_connectors_vectors(self):
        with patch('sync.connector_client.time.time', return_value=TIMESTAMP):
            for body, expected in VECTORS:
                headers = self.client._sign(body)
                self.assertEqual(headers['x-connector-signature'], expected, json.dumps(body))
                self.assertEqual(headers['x-connector-timestamp'], str(TIMESTAMP))

    async def test_send_signs_the_bytes_it_sends(self):
        with patch('sync.connector_client.time.time', return_value=TIMESTAMP):
            await self.client.send('-100123', 'ñandú ☃ "q" \\ \n\t línea', topic_id=42)
        request = self.requests[0]
        self.assertEqual((request.method, request.url.path), ('POST', '/api/public/send/-100123'))
        self.assertEqual(request.headers['content-type'], 'application/json')
        self.assertEqual(request.headers['x-connector-timestamp'], str(TIMESTAMP))
        self.assertEqual(request.headers['x-connector-signature'], VECTORS[2][1])
        # What the connector re-signs is its parser's reading of this body.
        self.assertEqual(request.content, _compact(json.loads(request.content)).encode())

    async def test_send_without_a_topic_signs_text_only(self):
        with patch('sync.connector_client.time.time', return_value=TIMESTAMP):
            await self.client.send('7', 'hola')
        request = self.requests[0]
        self.assertEqual(request.content, b'{"text":"hola"}')
        self.assertEqual(request.headers['x-connector-signature'], VECTORS[1][1])

    async def test_reads_still_sign_the_empty_body(self):
        with patch('sync.connector_client.time.time', return_value=TIMESTAMP):
            await self.client.get_dialogs()
        self.assertEqual(self.requests[0].headers['x-connector-signature'], VECTORS[0][1])
