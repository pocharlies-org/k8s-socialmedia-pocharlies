/** Pins connector forwarding without mixing destination routing with source identity. */
export function expectProfessionalForward(connectorCall: jest.Mock, toChatId: string): void {
  expect(connectorCall).toHaveBeenCalledWith(
    'http://wa-professional',
    'POST',
    '/api/v1/messages/forward',
    {
      chatId: 'professional:source@s.whatsapp.net',
      messageId: 'm1',
      toChatId,
    }
  );
}
