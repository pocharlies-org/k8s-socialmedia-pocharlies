jest.mock('../jobs/brain-windows-lib', () => ({
  chunkWindow: jest.fn(),
  loadWindowForLlm: jest.fn(),
}));

import { chunkMessageIds, resolveChunks } from './hindsight-chunks';
import { chunkWindow, loadWindowForLlm } from '../jobs/brain-windows-lib';

const win = (source_id: string) => ({
  source_id,
  account: 'personal',
  conversation_id: 'personal:c',
});

it('resuelve cada document_id a su ventana y número de chunk, solo dentro de la cuenta pedida', async () => {
  const query = jest.fn(async () => ({
    rows: [{ ...win('win:whatsapp:personal:c:1'), n: 2, document_id: 'writer:aa' }],
  }));
  const out = await resolveChunks({ query } as any, ['writer:aa', 'writer:zz'], 'personal', [
    'synapse-personal',
    'socialmedia-mensajes',
  ]);
  expect(query).toHaveBeenCalledWith(expect.stringContaining('sha256'), [
    ['synapse-personal', 'socialmedia-mensajes'],
    'personal',
    ['writer:aa', 'writer:zz'],
  ]);
  expect([...out.keys()]).toEqual(['writer:aa']);
  expect(out.get('writer:aa')).toMatchObject({
    index: 2,
    window: win('win:whatsapp:personal:c:1'),
  });
});

it('sin ids o sin identidades no consulta', async () => {
  const query = jest.fn();
  expect((await resolveChunks({ query } as any, [], 'personal', ['x'])).size).toBe(0);
  expect((await resolveChunks({ query } as any, ['writer:a'], 'personal', [])).size).toBe(0);
  expect(query).not.toHaveBeenCalled();
});

it('recalcula los message_ids con el constructor del job, una carga por ventana', async () => {
  (loadWindowForLlm as jest.Mock).mockResolvedValue({ built: true });
  (chunkWindow as jest.Mock).mockReturnValue([
    { index: 1, message_ids: ['A', 'B'] },
    { index: 2, message_ids: ['B', 'C'] },
  ]);
  const w = win('win:x') as any;
  const ids = await chunkMessageIds(
    {} as any,
    new Map([
      ['writer:1', { window: w, index: 1 }],
      ['writer:2', { window: w, index: 2 }],
    ])
  );
  expect(loadWindowForLlm).toHaveBeenCalledTimes(1);
  expect(ids.get('writer:1')).toEqual(['A', 'B']);
  expect(ids.get('writer:2')).toEqual(['B', 'C']);
});

it('una ventana que ya no existe no devuelve ids', async () => {
  (loadWindowForLlm as jest.Mock).mockResolvedValue(null);
  const ids = await chunkMessageIds(
    {} as any,
    new Map([['writer:1', { window: win('win:gone') as any, index: 1 }]])
  );
  expect(ids.get('writer:1')).toEqual([]);
});
