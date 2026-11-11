import { ServerResponse } from 'node:http';

/**
 * Spec 2025-03-26 "Session Management" says how to answer a POST/GET/DELETE
 * that arrives without a live session:
 *
 *  - No `mcp-session-id` header at all (and not an `initialize`): 400 Bad
 *    Request (rule 2 — "SHOULD respond to requests without an Mcp-Session-Id
 *    header ... with HTTP 400").
 *  - Header present but the session is gone (idle-swept, max-age, restart):
 *    404 Not Found (rule 3 — "MUST respond to requests containing that session
 *    ID with HTTP 404"). 404 is also the ONLY signal that makes a compliant
 *    client re-initialize (rule 4); answering 400 here instead leaves the
 *    client POSTing a dead session id forever — a zombie connection that
 *    survives proxy restarts because the dead id lives in the client process.
 *
 * Same contract the federated brain/tts bridges ship (bridge >=v0.1.3 "answers
 * the spec 404 to reaped/unknown sessions, so SDK clients re-initialize
 * transparently" — k8s-agentgateway-pocharlies).
 */
export function writeNoSessionResponse(res: ServerResponse, sid: string | undefined): void {
  if (sid) {
    // Terminated/unknown session: spec-mandated 404, empty body.
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: no valid session id' },
      id: null,
    })
  );
}
