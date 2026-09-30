import type { ConversationMeta, WindowMessage } from '../window-builder';

export const META: ConversationMeta = {
  platform: 'whatsapp',
  account: 'personal',
  conversationId: 'c0a8f1d2-0000-4000-8000-000000000001',
  conversationName: 'Grupo familia',
  isGroup: true,
  kind: 'chat',
};

export const T0 = Date.UTC(2026, 8, 28, 9, 0, 0); // 2026-09-28T09:00:00Z

/** Message `sec` seconds after T0. */
export function msg(
  id: string | number,
  sec: number,
  content: string,
  extra: Partial<WindowMessage> = {}
): WindowMessage {
  return {
    id: String(id),
    waId: `wa-${id}`,
    ts: T0 + sec * 1000,
    sender: 'Ana',
    content,
    isVoice: false,
    replyToId: null,
    ...extra,
  };
}
