import type { WASocket } from '@whiskeysockets/baileys';
import {
  decodePatches,
  decodeSyncdSnapshot,
  extractSyncdPatches,
  newLTHashState,
} from '@whiskeysockets/baileys/lib/Utils/chat-utils.js';

type ArchiveSocket = Pick<WASocket, 'query' | 'authState'>;
type SnapshotDeps = {
  extract: typeof extractSyncdPatches;
  decode: typeof decodeSyncdSnapshot;
  decodePatches: typeof decodePatches;
};

const defaultDeps: SnapshotDeps = {
  extract: extractSyncdPatches,
  decode: decodeSyncdSnapshot,
  decodePatches,
};

export async function readArchiveSnapshot(
  socket: ArchiveSocket,
  deps: SnapshotDeps = defaultDeps
): Promise<{ version: number; records: number; states: Map<string, boolean> }> {
  // A version-zero snapshot reads the current archive state without changing
  // the linked device's saved app-state versions or replaying its events.
  const getKey = async (id: string) =>
    (await socket.authState.keys.get('app-state-sync-key', [id]))[id];
  let state = newLTHashState();
  const states = new Map<string, boolean>();
  let records = 0;
  let more = true;
  let sawSnapshot = false;
  let decodeWarnings = 0;
  const strictLogger = {
    warn: () => {
      decodeWarnings++;
    },
  };
  for (let page = 0; page < 16 && more; page++) {
    const response = await socket.query(
      {
        tag: 'iq',
        attrs: { to: 's.whatsapp.net', xmlns: 'w:sync:app:state', type: 'set' },
        content: [
          {
            tag: 'sync',
            attrs: {},
            content: [
              {
                tag: 'collection',
                attrs: {
                  name: 'regular_low',
                  version: String(state.version),
                  return_snapshot: page === 0 ? 'true' : 'false',
                },
              },
            ],
          },
        ],
      },
      60_000
    );
    const collection = (await deps.extract(response, {})).regular_low;
    if (!collection) throw new Error('Complete WhatsApp archive snapshot is unavailable');
    const mutations = [];
    if (collection.snapshot) {
      if (sawSnapshot) throw new Error('Complete WhatsApp archive snapshot is unavailable');
      const decoded = await deps.decode(
        'regular_low',
        collection.snapshot,
        getKey,
        undefined,
        true,
        strictLogger as any
      );
      state = decoded.state;
      mutations.push(...Object.values(decoded.mutationMap));
      sawSnapshot = true;
      if (
        collection.snapshot.records &&
        Object.keys(decoded.state.indexValueMap || {}).length !== collection.snapshot.records.length
      ) {
        throw new Error('Complete WhatsApp archive snapshot is unavailable');
      }
    }
    if (collection.patches.length) {
      const decoded = await deps.decodePatches(
        'regular_low',
        collection.patches,
        state,
        getKey,
        {},
        undefined,
        strictLogger as any,
        true
      );
      state = decoded.state;
      mutations.push(...Object.values(decoded.mutationMap));
      const finalPatch = collection.patches.at(-1);
      if (
        finalPatch?.version?.version != null &&
        Number(finalPatch.version.version) !== state.version
      ) {
        throw new Error('Complete WhatsApp archive snapshot is unavailable');
      }
    }
    if (decodeWarnings) throw new Error('Complete WhatsApp archive snapshot is unavailable');
    for (const mutation of mutations) {
      const [type, jid] = mutation.index;
      if (typeof jid !== 'string' || !/@(?:g\.us|s\.whatsapp\.net|c\.us|lid)$/.test(jid)) continue;
      const action = mutation.syncAction.value?.archiveChatAction;
      if (action?.archived != null) states.set(jid, action.archived === true);
      else if (type === 'archive' || type === 'unarchive') states.set(jid, type === 'archive');
    }
    records += mutations.length;
    more = collection.hasMorePatches;
  }
  if (!sawSnapshot || more || decodeWarnings)
    throw new Error('Complete WhatsApp archive snapshot is unavailable');
  return { version: state.version, records, states };
}

export async function readCurrentArchiveSnapshot(
  socket: ArchiveSocket,
  currentSocket: () => ArchiveSocket | null,
  deps: SnapshotDeps = defaultDeps
): ReturnType<typeof readArchiveSnapshot> {
  const snapshot = await readArchiveSnapshot(socket, deps);
  if (currentSocket() !== socket)
    throw new Error('WhatsApp socket changed during archive snapshot');
  return snapshot;
}
