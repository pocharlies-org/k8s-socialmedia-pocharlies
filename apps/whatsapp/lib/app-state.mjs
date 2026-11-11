import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const STATE_VERSION = 1;

function emptyState() {
  return { version: STATE_VERSION, accounts: {} };
}

function accountState(state, account) {
  if (!state.accounts[account]) {
    state.accounts[account] = {
      favorites: [],
      lists: {},
      starred: [],
      localChatActions: {},
    };
  }
  return state.accounts[account];
}

function normalizeState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyState();
  const state = emptyState();
  if (value.accounts && typeof value.accounts === 'object' && !Array.isArray(value.accounts)) {
    for (const [account, raw] of Object.entries(value.accounts)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const target = accountState(state, account);
      if (Array.isArray(raw.favorites)) target.favorites = raw.favorites.filter(item => typeof item === 'string');
      if (Array.isArray(raw.starred)) target.starred = raw.starred.filter(item => typeof item === 'string');
      if (raw.lists && typeof raw.lists === 'object' && !Array.isArray(raw.lists)) {
        target.lists = Object.fromEntries(Object.entries(raw.lists).filter(([name, items]) =>
          typeof name === 'string' && Array.isArray(items) && items.every(item => typeof item === 'string')
        ));
      }
      if (raw.localChatActions && typeof raw.localChatActions === 'object' && !Array.isArray(raw.localChatActions)) {
        target.localChatActions = Object.fromEntries(Object.entries(raw.localChatActions).filter(([chat, actions]) =>
          typeof chat === 'string' && actions && typeof actions === 'object' && !Array.isArray(actions)
        ));
      }
    }
  }
  return state;
}

/** Small, account-keyed durable store for app-only concepts absent upstream. */
export class AppState {
  constructor(dataDir, fsImpl = {}) {
    this.dataDir = dataDir;
    this.file = join(dataDir, 'app-state.json');
    this.state = emptyState();
    this.fs = { mkdir, readFile, rename, writeFile, ...fsImpl };
    this.writeChain = Promise.resolve();
  }

  async init() {
    await this.fs.mkdir(this.dataDir, { recursive: true });
    try {
      this.state = normalizeState(JSON.parse(await this.fs.readFile(this.file, 'utf8')));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        if (error?.name === 'SyntaxError') throw new Error(`Invalid app state file: ${this.file}`, { cause: error });
        throw error;
      }
      this.state = emptyState();
    }
  }

  get(account) {
    return structuredClone(accountState(this.state, account));
  }

  async update(account, updater) {
    const operation = this.writeChain.then(async () => {
      const previous = structuredClone(accountState(this.state, account));
      const next = structuredClone(previous);
      const value = await updater(next);
      this.state.accounts[account] = value || next;
      const snapshot = JSON.stringify(this.state);
      const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      try {
        await this.fs.writeFile(temporary, `${snapshot}\n`, { mode: 0o600 });
        await this.fs.rename(temporary, this.file);
      } catch (error) {
        this.state.accounts[account] = previous;
        throw error;
      }
      return structuredClone(this.state.accounts[account]);
    });
    // Keep the queue usable after a failed updater or filesystem write. The
    // operation itself still rejects so callers cannot mistake it for a save.
    this.writeChain = operation.catch(() => {});
    return operation;
  }

  async close() {
    await this.writeChain;
  }
}

export function stateItemKey(chat, message) {
  return `${chat}:${message}`;
}
