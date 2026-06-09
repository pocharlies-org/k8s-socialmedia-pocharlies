import {
  adapterForPlatform,
  instanceForAccount,
  replayCursorTableName,
  sourceId,
  toDoc,
  liveCursorTableName,
} from './brain-ingest-lib';

describe('brain ingest lib', () => {
  it('keeps source ids stable across live ingest and replay', () => {
    expect(sourceId('whatsapp', 'wa1')).toBe('wa:wa1');
    expect(sourceId('telegram', 'tg1')).toBe('tg:tg1');
    expect(sourceId('instagram', 'ig1')).toBe('ig:ig1');
  });

  it('routes account and platform to Brain instance and adapter', () => {
    expect(instanceForAccount('personal')).toBe('personal');
    expect(instanceForAccount('professional')).toBe('skirmshop');
    expect(adapterForPlatform('telegram')).toBe('telegram');
    expect(adapterForPlatform('instagram')).toBe('instagram');
    expect(adapterForPlatform('whatsapp')).toBe('whatsapp');
  });

  it('uses a separate cursor table for replay', () => {
    expect(liveCursorTableName()).toBe('brain_ingest_cursor');
    expect(replayCursorTableName()).toBe('brain_ingest_replay_cursor');
    expect(replayCursorTableName()).not.toBe(liveCursorTableName());
  });

  it('builds Brain docs with account and conversation metadata', () => {
    const doc = toDoc({
      id: '1',
      wa_message_id: 'tg1',
      content: 'hola',
      platform: 'telegram',
      account: 'personal',
      direction: 'inbound',
      message_type: 'text',
      metadata: { custom: 'value' },
      wa_timestamp: new Date('2026-06-01T10:00:00Z'),
      created_at: new Date('2026-06-01T10:00:01Z'),
      sender_wa_id: 'sender1',
      conversation_id: 'conv1',
      conversation_name: 'Familia',
    });

    expect(doc.source_id).toBe('tg:tg1');
    expect(doc.metadata.account).toBe('personal');
    expect(doc.metadata.conversation_id).toBe('conv1');
    expect(doc.metadata.custom).toBe('value');
  });
});
