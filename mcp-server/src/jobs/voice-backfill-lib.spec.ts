import {
  backfillCountQuery,
  backfillMarkQuery,
  backfillReportQuery,
} from './voice-backfill-lib';

describe('backfillMarkQuery', () => {
  it('only touches never-transcribed rows (resumable + idempotent)', () => {
    const { text, params } = backfillMarkQuery({});
    expect(text).toContain("m.metadata->>'transcription_status' IS NULL");
    expect(text).toContain("m.platform = 'whatsapp'");
    expect(text).toContain("m.message_type IN ('AUDIO','PTT')");
    expect(text).toContain("btrim(COALESCE(m.content,'')) = ''");
    expect(text).toContain('"transcription_status": "pending"');
    expect(text).toContain('"needs_transcription": true');
    expect(text).toContain('ORDER BY m.wa_timestamp ASC');
    expect(text).not.toContain('LIMIT');
    expect(params).toEqual([]);
  });

  it('scopes by account and stages with a row cap', () => {
    const { text, params } = backfillMarkQuery({ account: 'professional', maxRows: 500 });
    expect(text).toContain('m.account = $1');
    expect(text).toContain('LIMIT $2');
    expect(params).toEqual(['professional', 500]);
  });

  it('ignores a zero/negative cap (no LIMIT clause)', () => {
    const { text, params } = backfillMarkQuery({ account: 'leila', maxRows: 0 });
    expect(text).not.toContain('LIMIT');
    expect(params).toEqual(['leila']);
  });
});

describe('backfillReportQuery', () => {
  it('censuses empty-content voice rows per account with a bytes check', () => {
    const { text, params } = backfillReportQuery();
    expect(text).toContain('GROUP BY m.account');
    expect(text).toContain('AS with_bytes');
    expect(text).toContain('AS recoverable');
    expect(text).toContain('LEFT JOIN LATERAL');
    expect(params).toEqual([]);
  });
  it('parameterizes the account filter', () => {
    const { text, params } = backfillReportQuery('personal');
    expect(text).toContain('m.account = $1');
    expect(params).toEqual(['personal']);
  });
});

describe('backfillCountQuery', () => {
  it('counts exactly what the mark query would touch', () => {
    const mark = backfillMarkQuery({ account: 'personal' });
    const count = backfillCountQuery('personal');
    // Same guards on both sides of the report/mark pair.
    for (const fragment of [
      "m.metadata->>'transcription_status' IS NULL",
      "m.message_type IN ('AUDIO','PTT')",
      "btrim(COALESCE(m.content,'')) = ''",
      'm.account = $1',
    ]) {
      expect(mark.text).toContain(fragment);
      expect(count.text).toContain(fragment);
    }
    expect(count.params).toEqual(['personal']);
  });
});
