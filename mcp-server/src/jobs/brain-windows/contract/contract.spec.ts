// Copia vendorizada del contrato conversation-window v1 (INFRA-366).
// Fuente: skirmshop-brain-v2 docs/conversation-window-contract.md, docs/conversation-window.schema.json
// y tests/fixtures/conversation_windows/. Cambiar el contrato = pedir al architect; un cambio roto es v2 al lado.
import { createHash } from 'crypto';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

const DIR = __dirname;
const CHECKSUM_FILE = 'contract.sha256';

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? listFiles(p) : [p];
  });
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('conversation-window contract (vendored copy)', () => {
  it('matches contract.sha256 byte for byte, with no extra or missing files', () => {
    const expected = new Map<string, string>();
    for (const line of readFileSync(join(DIR, CHECKSUM_FILE), 'utf8').trim().split('\n')) {
      const m = /^([0-9a-f]{64})  (.+)$/.exec(line);
      if (!m) throw new Error(`bad line in ${CHECKSUM_FILE}: ${line}`);
      expected.set(m[2].replace(/^\.\//, ''), m[1]);
    }
    const actual = new Map<string, string>();
    for (const p of listFiles(DIR)) {
      const rel = relative(DIR, p);
      if (rel === CHECKSUM_FILE || rel.endsWith('.spec.ts')) continue;
      actual.set(rel, sha256(p));
    }
    expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [file, hash] of expected) {
      expect({ file, hash: actual.get(file) }).toEqual({ file, hash });
    }
  });

  describe('schema vs fixtures', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(JSON.parse(readFileSync(join(DIR, 'conversation-window.schema.json'), 'utf8')));
    const fixtures = readdirSync(join(DIR, 'fixtures')).filter((f) => f.endsWith('.json'));

    it('has the 6 valid and 7 invalid fixtures', () => {
      expect(fixtures.filter((f) => f.startsWith('valid_'))).toHaveLength(6);
      expect(fixtures.filter((f) => f.startsWith('invalid_'))).toHaveLength(7);
    });

    it.each(fixtures)('%s', (f) => {
      const doc = JSON.parse(readFileSync(join(DIR, 'fixtures', f), 'utf8'));
      expect(validate(doc)).toBe(f.startsWith('valid_'));
    });
  });
});
