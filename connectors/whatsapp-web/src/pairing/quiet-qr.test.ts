/**
 * SC-1225 criterion 3: with `quietQr` the QR appears neither on stdout nor
 * on disk — only on the in-memory 'qr' event. The control case (default
 * options, the house connectors) proves the probe would catch a leak.
 */
import '../test-env';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BaileysClient } from '../baileys-client';

const QR = '2@QUIETQRPROBE0123456789,noisekey=,identity=,adv=';

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  );
}

/** Capture everything written to stdout/console while `fn` runs. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  const log = console.log;
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    chunks.push(String(chunk));
    const cb = rest.find(r => typeof r === 'function') as (() => void) | undefined;
    cb?.();
    return true;
  }) as typeof process.stdout.write;
  console.log = (...args: unknown[]) => {
    chunks.push(args.map(String).join(' '));
  };
  try {
    await fn();
  } finally {
    process.stdout.write = write;
    console.log = log;
  }
  return chunks.join('');
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('quietQr: el QR no sale por stdout ni se escribe qr.png; solo el evento qr en memoria', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quiet-qr-'));
  const client = new BaileysClient(dir, 'k'.repeat(16), { quietQr: true, ingest: false });
  const events: string[] = [];
  client.on('qr', (qr: string) => events.push(qr));

  const out = await captureStdout(async () => {
    (client as unknown as { handleQR(qr: string): void }).handleQR(QR);
    await sleep(300); // QRCode.toFile would have landed by now
  });

  assert.deepEqual(events, [QR]);
  assert.equal(out.includes('QUIETQRPROBE'), false);
  assert.equal(out.includes('▄') || out.includes('█'), false, 'no terminal QR render');
  assert.equal(await exists(join(dir, 'qr.png')), false);
  assert.equal(client.getStatus().state, 'QR');
});

test('control (opciones por defecto, conectores de la casa): el QR sí se pinta y se escribe qr.png', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loud-qr-'));
  const client = new BaileysClient(dir, 'k'.repeat(16));
  const out = await captureStdout(async () => {
    (client as unknown as { handleQR(qr: string): void }).handleQR(QR);
    for (let i = 0; i < 40 && !(await exists(join(dir, 'qr.png'))); i++) await sleep(50);
  });
  assert.equal(out.includes('▄') || out.includes('█'), true, 'terminal QR rendered');
  assert.equal(await exists(join(dir, 'qr.png')), true);
});
