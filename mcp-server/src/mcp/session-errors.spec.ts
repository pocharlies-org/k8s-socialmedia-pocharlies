import { ServerResponse } from 'node:http';
import { writeNoSessionResponse } from './session-errors';

/** Minimal structural mock of ServerResponse — the helper only uses writeHead/end. */
function fakeRes(): {
  res: ServerResponse;
  writeHead: jest.Mock;
  end: jest.Mock;
} {
  const writeHead = jest.fn();
  const end = jest.fn();
  const res = { writeHead, end } as unknown as ServerResponse;
  return { res, writeHead, end };
}

describe('writeNoSessionResponse (MCP spec 2025-03-26 Session Management)', () => {
  it('answers 404 with an empty body when a session id was sent but is unknown — the signal clients re-initialize on (rule 3/4)', () => {
    const { res, writeHead, end } = fakeRes();
    writeNoSessionResponse(res, 'dead-session-uuid');
    expect(writeHead).toHaveBeenCalledWith(404);
    expect(end).toHaveBeenCalledWith();
  });

  it('answers 400 with a JSON-RPC error when no session id header was sent at all (rule 2)', () => {
    const { res, writeHead, end } = fakeRes();
    writeNoSessionResponse(res, undefined);
    expect(writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
    const body = JSON.parse(end.mock.calls[0][0]);
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.code).toBe(-32000);
  });

  it('treats an empty session id header as missing (400), not as a dead session (404)', () => {
    const { res, writeHead } = fakeRes();
    writeNoSessionResponse(res, '');
    expect(writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
  });
});
