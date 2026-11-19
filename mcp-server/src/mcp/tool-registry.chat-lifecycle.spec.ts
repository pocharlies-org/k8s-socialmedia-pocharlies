/**
 * social_manage_chat deleteChat / leaveChat (INFRA-278 C2/C4). The two
 * lifecycle actions carry the same guards and audit as social_moderate_members:
 * confirm=true and idempotencyKey are refused BEFORE the connector with
 * confirmation_required (zero connector calls), every attempt — successful or
 * failed — opens and closes one moderation_audit row under the verified caller,
 * and a failed audit INSERT denies the mutation with audit_unavailable.
 */
import { runWithRequestActor } from '@mcp-socialmedia/shared';
import { useTestAccounts } from '../domain/test-accounts';
import { expectCanonical } from './canonical-error-test-helper';
import { MCPServer } from './server';

function lifecycleServer() {
  const server = Object.create(MCPServer.prototype) as MCPServer;
  const anyServer = server as any;
  useTestAccounts({
    telegram: {
      personal: 'http://telegram-personal',
      professional: 'http://telegram-professional',
    },
  });
  anyServer.connectorCall = jest.fn(async () => ({ success: true }));
  anyServer.dbClient = { query: jest.fn(async () => ({ rows: [{ id: 11 }] })) };
  anyServer.logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };
  return {
    server: anyServer,
    manage: (args: Record<string, unknown>) =>
      runWithRequestActor({ sub: 'sub-1', name: 'dani' }, () =>
        anyServer.canonicalManageChat(args)
      ),
    connectorCall: anyServer.connectorCall as jest.Mock,
    dbQuery: anyServer.dbClient.query as jest.Mock,
  };
}

const baseArgs = {
  channel: 'telegram',
  accountId: 'personal',
  target: '-1001234567890',
};

describe('social_manage_chat deleteChat/leaveChat (INFRA-278)', () => {
  for (const action of ['deleteChat', 'leaveChat']) {
    describe(`C2: ${action} refuses before the connector`, () => {
      it('confirm ausente o false → confirmation_required, cero llamadas', async () => {
        for (const confirm of [undefined, false]) {
          const { manage, connectorCall, dbQuery } = lifecycleServer();
          await expectCanonical(
            manage({ ...baseArgs, action, idempotencyKey: 'k-1', confirm }),
            'confirmation_required'
          );
          expect(connectorCall).not.toHaveBeenCalled();
          expect(dbQuery).not.toHaveBeenCalled();
        }
      });

      it('idempotencyKey ausente o vacío → confirmation_required, cero llamadas', async () => {
        for (const idempotencyKey of [undefined, '', 42]) {
          const { manage, connectorCall, dbQuery } = lifecycleServer();
          await expectCanonical(
            manage({ ...baseArgs, action, confirm: true, idempotencyKey }),
            'confirmation_required'
          );
          expect(connectorCall).not.toHaveBeenCalled();
          expect(dbQuery).not.toHaveBeenCalled();
        }
      });

      it('target no numérico → invalid_target antes del conector', async () => {
        const { manage, connectorCall } = lifecycleServer();
        await expectCanonical(
          manage({ ...baseArgs, target: '@grupo', action, confirm: true, idempotencyKey: 'k-1' }),
          'invalid_target'
        );
        expect(connectorCall).not.toHaveBeenCalled();
      });
    });

    describe(`C4: ${action} audits every attempt`, () => {
      it('éxito: INSERT pending antes del conector y UPDATE ok después', async () => {
        const { manage, connectorCall, dbQuery } = lifecycleServer();
        await manage({ ...baseArgs, action, confirm: true, idempotencyKey: 'k-1' });
        const [insert, update] = dbQuery.mock.calls;
        expect(insert[0]).toContain('INSERT INTO moderation_audit');
        expect(insert[0]).toContain("'pending'");
        expect(insert[1]).toContain(action);
        expect(insert[1]).toContain('-1001234567890');
        expect(update[0]).toContain('UPDATE moderation_audit');
        expect(update[1]).toContain('ok');
        // the audit row opens BEFORE the mutation goes out
        expect(dbQuery.mock.invocationCallOrder[0]).toBeLessThan(
          connectorCall.mock.invocationCallOrder[0]
        );
        const [, method, path] = connectorCall.mock.calls[0];
        expect(method).toBe('POST');
        expect(path).toBe(
          action === 'deleteChat'
            ? '/api/v1/chats/-1001234567890/delete'
            : '/api/v1/chats/-1001234567890/leave'
        );
      });

      it('fallo del conector: la fila cierra con el código canónico y el error se propaga', async () => {
        const { manage, connectorCall, dbQuery } = lifecycleServer();
        connectorCall.mockRejectedValueOnce(
          new Error('Connector error 403: {"error":"no","failureClass":"not_admin"}')
        );
        await expectCanonical(
          manage({ ...baseArgs, action, confirm: true, idempotencyKey: 'k-1' }),
          'not_admin'
        );
        const [updateSql, updateParams] = dbQuery.mock.calls[1];
        expect(updateSql).toContain('UPDATE moderation_audit');
        expect(updateParams[1]).toBe('not_admin');
      });

      it('fallo del INSERT → audit_unavailable con cero llamadas a Telegram', async () => {
        const { manage, connectorCall, dbQuery } = lifecycleServer();
        dbQuery.mockRejectedValueOnce(new Error('db down'));
        await expectCanonical(
          manage({ ...baseArgs, action, confirm: true, idempotencyKey: 'k-1' }),
          'audit_unavailable'
        );
        expect(connectorCall).not.toHaveBeenCalled();
      });
    });
  }

  it('las cuatro acciones viejas siguen sin exigir confirm (contract-surface)', async () => {
    const { manage, connectorCall } = lifecycleServer();
    await manage({ ...baseArgs, action: 'setTitle', title: 'x' });
    expect(connectorCall).toHaveBeenCalled();
  });
});
