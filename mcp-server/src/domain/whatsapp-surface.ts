/** Status and channel updates belong to Novedades, not conversational ingestion. */
export function isWhatsAppUpdate(conversationId: string): boolean {
  return conversationId.endsWith('@newsletter') || /(?:^|:)status@broadcast$/.test(conversationId);
}
