import { FIX_UPDATE_SQL, asrTextOf, fixCandidatesQuery, fixCountQuery, unwrapAsrJson } from './voice-json-fix-lib';

describe('unwrapAsrJson', () => {
  it('unwraps the prod echo shape: marker + quoted raw body (unescaped inner quotes)', () => {
    // Real row 1254112 (telegram supergroup culturismo, 2026-09-21).
    expect(unwrapAsrJson('🎙️ "{"text":"La prueba de voz.","usage":null}"')).toBe(
      '🎙️ La prueba de voz.'
    );
  });

  it('unwraps the raw body and the escaped-JSON-string shapes', () => {
    expect(unwrapAsrJson('{"text":"hola","usage":null}')).toBe('hola');
    expect(unwrapAsrJson('"{\\"text\\":\\"hola\\"}"')).toBe('hola');
    expect(unwrapAsrJson('🎙️ {"text":"hola"}')).toBe('🎙️ hola');
  });

  it('joins verbose_json segments when there is no top-level text', () => {
    expect(unwrapAsrJson('{"segments":[{"text":"uno "},{"text":"dos"}],"language":"es"}')).toBe(
      'uno dos'
    );
  });

  it('returns null (never rewrite) for everything that is not the full shape', () => {
    for (const content of [
      'texto normal',
      // Prose that merely mentions the shape — real rows 1316039/1316221.
      'Porque dice 🎙️ "{"text":"No hay otro.","usage":null}" al final usage null',
      // Marker + prose — real row 829897 (OmniVoice evaluation).
      '🎙️ EVALUACIÓN OmniVoice — 28 audios (voz daniel_clean_16s).',
      // JSON-ish but no usable transcript.
      '{"usage":null}',
      '{"text":123}',
      '{"text":"   "}',
      '{not json at all}',
      // Code block mentioning "text": — real row 408737.
      '```{ "update_id": 851595339, "message": { "text": "hola" } }```',
    ]) {
      expect(unwrapAsrJson(content)).toBeNull();
    }
  });

  it('asrTextOf only accepts a full JSON object with text or segments', () => {
    expect(asrTextOf('{"text":"x"}')).toBe('x');
    expect(asrTextOf('{"text":"x"')).toBeNull(); // not a complete object
    expect(asrTextOf('[1,2]')).toBeNull();
    expect(asrTextOf('hola')).toBeNull();
  });
});

describe('fixCountQuery', () => {
  it('censuses never-fixed rows whose head matches the shape', () => {
    const { text, params } = fixCountQuery({});
    expect(text).toContain("metadata->>'transcription_fixed_at' IS NULL");
    expect(text).toContain("content LIKE '🎙%'");
    expect(text).toContain("content LIKE '{%'");
    expect(text).toContain('GROUP BY platform, account');
    expect(params).toEqual([]);
  });
  it('parameterizes the platform/account scope', () => {
    const { text, params } = fixCountQuery({ platform: 'telegram', account: 'personal' });
    expect(text).toContain('platform = $1');
    expect(text).toContain('account = $2');
    expect(params).toEqual(['telegram', 'personal']);
  });
});

describe('fixCandidatesQuery', () => {
  it('walks by id keyset with a bounded batch (resumable)', () => {
    const { text, params } = fixCandidatesQuery({ afterId: '1254112', limit: 100 });
    expect(text).toContain('id > $1');
    expect(text).toContain('ORDER BY id ASC');
    expect(text).toContain('LIMIT $2');
    expect(params).toEqual(['1254112', 100]);
  });
  it('skips the cursor on the first round', () => {
    const { text, params } = fixCandidatesQuery({ limit: 50 });
    expect(text).not.toContain('id >');
    expect(params).toEqual([50]);
  });
});

describe('FIX_UPDATE_SQL', () => {
  it('is guarded: exact old content + never fixed, and stamps the marker', () => {
    expect(FIX_UPDATE_SQL).toContain('content = $4');
    expect(FIX_UPDATE_SQL).toContain("metadata->>'transcription_fixed_at' IS NULL");
    expect(FIX_UPDATE_SQL).toContain("jsonb_build_object('transcription_fixed_at', $3::text)");
    expect(FIX_UPDATE_SQL).toContain('SET content = $2');
  });
});
