import type { WAMessageKey } from '@whiskeysockets/baileys';
import { serializeDurableValue, toDurablePayload } from '../durable-message-store';

/** Model the JSONB row used to recover provider keys from persisted history. */
export function durableMessageFixture(
  key: WAMessageKey,
  content: Record<string, unknown>,
  at: Date
) {
  return {
    message_key: JSON.parse(serializeDurableValue(key)) as unknown,
    message_payload: JSON.parse(serializeDurableValue(toDurablePayload(content))) as unknown,
    wa_timestamp: at,
    push_name: null,
  };
}
