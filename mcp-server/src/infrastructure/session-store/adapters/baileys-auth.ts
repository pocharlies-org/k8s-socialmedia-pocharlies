/**
 * SC-552 channel adapter — WhatsApp / baileys.
 *
 * Baileys persists its session through `useMultiFileAuthState(authDir)`
 * (connectors/whatsapp-web/src/baileys-client.ts): a flat directory of small
 * files (creds.json, session-*, pre-key-*, app-state-sync-key-*, …). This
 * adapter serializes that directory to the store's opaque jsonb payload
 * (file name → base64 content) and back, so the channel keeps its on-disk
 * format and the store stays format-agnostic.
 *
 * Phase-1 note: nothing in the runtime writes this payload yet (the per-sub
 * client pool is phase 2); this module is the serialization contract plus its
 * tests.
 */
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

export interface BaileysAuthPayload {
  /** Auth-state file name → file content, base64 (binary-safe in jsonb). */
  files: Record<string, string>;
}

/** Read a baileys multi-file auth-state directory into the store payload. */
export async function serializeBaileysAuthDir(authDir: string): Promise<BaileysAuthPayload> {
  const files: Record<string, string> = {};
  for (const entry of await fsp.readdir(authDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const content = await fsp.readFile(join(authDir, entry.name));
    files[entry.name] = content.toString('base64');
  }
  return { files };
}

/** Validate an opaque payload as a BaileysAuthPayload (throws otherwise). */
export function deserializeBaileysAuthPayload(payload: unknown): BaileysAuthPayload {
  const files = (payload as BaileysAuthPayload | undefined)?.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    throw new Error('invalid baileys auth payload: missing `files` map');
  }
  for (const [name, content] of Object.entries(files)) {
    if (typeof content !== 'string') {
      throw new Error(`invalid baileys auth payload: file ${name} is not base64 text`);
    }
    assertSafeAuthFileName(name);
  }
  return { files: files as Record<string, string> };
}

function assertSafeAuthFileName(name: string): void {
  // Payloads come from the DB; never let a stored key escape the auth dir.
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new Error(`invalid baileys auth payload: unsafe file name ${JSON.stringify(name)}`);
  }
}

/** Write a store payload back into an auth-state directory (idempotent overwrite). */
export async function applyBaileysAuthDir(payload: unknown, authDir: string): Promise<void> {
  const validated = deserializeBaileysAuthPayload(payload);
  await fsp.mkdir(authDir, { recursive: true });
  for (const [name, content] of Object.entries(validated.files)) {
    await fsp.writeFile(join(authDir, name), Buffer.from(content, 'base64'));
  }
}
