/**
 * SC-1225 spec helpers: an in-memory credential store and a fake baileys
 * socket that the pool drives exactly like BaileysClient (same hooks, same
 * 'qr'/'connected' events, same loggedOut choreography: wipe the auth dir,
 * then call the session-invalidated hook).
 */
import { EventEmitter } from 'node:events';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CredentialChannel, CredentialStore, StoredCredential } from '@mcp-socialmedia/shared';
import type { PairingClient } from './session-pool';

export class MemoryStore implements CredentialStore {
  rows = new Map<string, StoredCredential>();
  gets = 0;
  async get(sessionKey: string, channel: CredentialChannel): Promise<StoredCredential | null> {
    this.gets += 1;
    return this.rows.get(`${sessionKey}/${channel}`) ?? null;
  }
  async put(
    sessionKey: string,
    channel: CredentialChannel,
    payload: Record<string, unknown>
  ): Promise<void> {
    this.rows.set(`${sessionKey}/${channel}`, {
      sessionKey,
      channel,
      payload: JSON.parse(JSON.stringify(payload)),
      updatedAt: new Date(),
    });
  }
  async delete(sessionKey: string, channel: CredentialChannel): Promise<void> {
    this.rows.delete(`${sessionKey}/${channel}`);
  }
  rowsFor(sessionKey: string): number {
    return [...this.rows.values()].filter(r => r.sessionKey === sessionKey).length;
  }
}

export class FakeBaileys extends EventEmitter implements PairingClient {
  connects = 0;
  disconnects = 0;
  private credsSaved: (() => void) | null = null;
  private invalidated: (() => Promise<void> | void) | null = null;

  constructor(
    readonly sessionPath: string,
    readonly sessionKey: string
  ) {
    super();
  }
  getAuthDir(): string {
    return join(this.sessionPath, 'baileys-auth');
  }
  setCredsSavedHook(hook: () => void): void {
    this.credsSaved = hook;
  }
  setSessionInvalidatedHook(hook: () => Promise<void> | void): void {
    this.invalidated = hook;
  }
  async connect(): Promise<void> {
    this.connects += 1;
    await mkdir(this.getAuthDir(), { recursive: true });
  }
  async disconnect(): Promise<void> {
    this.disconnects += 1;
  }

  // --- simulation of what WhatsApp does to the socket -----------------------
  emitQr(ref: string): void {
    this.emit('qr', ref);
  }
  /** Pre-pairing saveCreds (noise keys only, no `me`). */
  async saveCredsBeforeOpen(): Promise<void> {
    await writeFile(join(this.getAuthDir(), 'creds.json'), JSON.stringify({ noiseKey: 'n' }));
    this.credsSaved?.();
  }
  /** Phone scanned: creds gain `me`, saveCreds runs, connection opens. */
  async open(meId: string, name = 'Tester'): Promise<void> {
    await writeFile(
      join(this.getAuthDir(), 'creds.json'),
      JSON.stringify({ noiseKey: 'n', me: { id: meId, name } })
    );
    this.credsSaved?.();
    this.emit('connected');
  }
  /** User unlinked the device: baileys wipes the dir, then the hook fires. */
  async loggedOut(): Promise<void> {
    await rm(this.getAuthDir(), { recursive: true, force: true });
    await this.invalidated?.();
  }
}

export class FakeFactory {
  clients: FakeBaileys[] = [];
  create = (sessionPath: string, sessionKey: string): FakeBaileys => {
    const c = new FakeBaileys(sessionPath, sessionKey);
    this.clients.push(c);
    return c;
  };
  last(sessionKey: string): FakeBaileys {
    const found = [...this.clients].reverse().find(c => c.sessionKey === sessionKey);
    if (!found) throw new Error(`no client for ${sessionKey}`);
    return found;
  }
}

export class Clock {
  constructor(public t = Date.parse('2026-09-24T10:00:00Z')) {}
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}
