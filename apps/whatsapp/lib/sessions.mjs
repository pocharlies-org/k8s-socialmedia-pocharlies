import { mkdir, readFile, writeFile, rename, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fail } from './security.mjs';
export class Sessions {
  constructor(dir) { this.dir = join(dir, 'ai-sessions'); this.locks = new Map(); }
  async init() { await mkdir(this.dir, { recursive: true, mode: 0o700 }); }
  path(id) { if (!/^[a-f0-9-]{36}$/.test(id)) throw fail(400, 'Invalid session'); return join(this.dir, `${id}.json`); }
  async read(id) { try { return JSON.parse(await readFile(this.path(id), 'utf8')); } catch (e) { if (e.code === 'ENOENT') throw fail(404, 'Session not found'); throw e; } }
  async save(session) { const path = this.path(session.id); const temp = `${path}.${randomUUID()}.tmp`; await writeFile(temp, JSON.stringify(session), { mode: 0o600 }); await rename(temp, path); }
  canonicalId(account, chat, global = false) {
    const hash = createHash('sha256').update(JSON.stringify(['whatsapp-ai', account, chat, global])).digest('hex');
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
  }
  async canonical(account, chat, global = false) {
    const id = this.canonicalId(account, chat, global);
    const existing = await this.list(account, chat, global);
    // Keep the most recently used legacy transcript when multiple exist.
    const chosen = existing.find(item => item.id === id) || existing.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))[0];
    if (chosen) return this.read(chosen.id);
    const session = { id, account, chat, global, title: '', messages: [] };
    try { await writeFile(this.path(id), JSON.stringify(session), { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const created = await this.read(id);
    if (created.account !== account || created.chat !== chat || created.global !== global) throw fail(409, 'Session scope conflict');
    return created;
  }
  async list(account, chat, global) {
    const result = [];
    for (const name of await readdir(this.dir)) {
      if (!name.endsWith('.json')) continue;
      const s = await this.read(name.slice(0, -5));
      if (s.account === account && s.chat === chat && s.global === global) result.push({ id: s.id, title: s.title, updatedAt: (await stat(this.path(s.id))).mtimeMs });
    }
    return result;
  }
  async serial(id, fn) {
    const previous = this.locks.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(fn); this.locks.set(id, next);
    try { return await next; } finally { if (this.locks.get(id) === next) this.locks.delete(id); }
  }
}
