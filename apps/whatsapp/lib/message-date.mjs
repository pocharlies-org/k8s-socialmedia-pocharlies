import {MESSAGE_VISIBLE_SQL} from './chat-names.mjs';

export const MESSAGE_BY_DATE_SQL = `SELECT m.id, m.wa_message_id FROM messages m
  WHERE m.account=$1 AND m.conversation_id=ANY($2::text[])
    AND m.platform='whatsapp' AND NOT m.is_deleted AND ${MESSAGE_VISIBLE_SQL}
    AND m.wa_timestamp >= $3::timestamptz AND m.wa_timestamp < $4::timestamptz
  ORDER BY m.wa_timestamp ASC, m.id ASC LIMIT 1`;
