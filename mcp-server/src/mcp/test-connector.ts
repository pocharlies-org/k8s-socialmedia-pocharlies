/**
 * Test seam for the connector HMAC gate (SKIRM-103, SKIRM-112): a local HTTP server that stands in
 * for a connector. `gated` answers 401 unless the request carries a valid signature, `open` is a
 * connector without the gate. The signature is checked with the shared verifyHMACSignature the gate
 * is built on: "<ts>:<JSON body>", where a request with no body carries `{}` (express.json leaves
 * req.body = {}).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { verifyHMACSignature } from '@mcp-socialmedia/shared';

export const TEST_CONNECTOR_SECRET = 'connector-secret-under-test';

export interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  signatureOk: boolean;
}

export async function connector(mode: 'gated' | 'open', reply = '{"chats":[],"messageId":"m1"}') {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : {};
      const signatureOk = verifyHMACSignature(
        body,
        Number(req.headers['x-connector-timestamp']),
        String(req.headers['x-connector-signature'] ?? ''),
        TEST_CONNECTOR_SECRET
      );
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        signatureOk,
      });
      if (mode === 'gated' && !signatureOk) {
        res
          .writeHead(401, { 'content-type': 'application/json' })
          .end('{"error":"Invalid signature"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(reply);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = () => new Promise<void>(resolve => server.close(() => resolve()));
  return { url, seen, close };
}
