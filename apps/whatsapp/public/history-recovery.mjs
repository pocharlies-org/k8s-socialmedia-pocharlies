const structured = new Set(['POLL', 'EVENT', 'LOCATION', 'CONTACT']);
const capturedBusiness = new Set(['TEMPLATEMESSAGE', 'BUTTONSMESSAGE', 'TEMPLATEBUTTONREPLYMESSAGE', 'BUTTONSRESPONSEMESSAGE', 'LISTMESSAGE', 'LISTRESPONSEMESSAGE', 'INTERACTIVEMESSAGE', 'INTERACTIVERESPONSEMESSAGE']);
export const HISTORY_RECOVERY_WAIT_MS = 30000;

export function needsMessageRecovery(messages) {
  if (!messages.length) return true;
  return messages.some(message => !message.isDeleted && !structured.has(message.type) && !capturedBusiness.has(message.type)
    && !String(message.text || '').trim() && !message.attachments?.length);
}

export function recoveryLabel(status) {
  return {
    pending: 'Recuperando mensajes…',
    requested: 'Historial solicitado al teléfono. Esperando a WhatsApp…',
    recovered: 'Mensajes recuperados.',
    no_anchor: 'WhatsApp aún no ha facilitado el historial de este chat. Comprueba que tu teléfono esté conectado.',
    cooldown: 'La recuperación ya se ha solicitado. Esperando a WhatsApp…',
    failed: 'No se pudo solicitar el historial. Puedes volver a intentarlo.',
    timeout: 'WhatsApp no ha entregado nuevos mensajes durante la espera. El contenido no disponible sigue pendiente; puedes reintentar.',
  }[status] || '';
}
