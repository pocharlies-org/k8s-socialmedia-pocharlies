import { findAccount, type AccountChannel } from '../domain/account-registry';

/**
 * Connector base URL for an account, from the account registry. `undefined`
 * account means the default (`personal`). Returns `undefined` when the account
 * is unknown or disabled; callers decide how to report it (the MCP server maps
 * it to a canonical `unsupported_capability`, jobs throw).
 */
export function connectorUrlFor(channel: AccountChannel, account?: string): string | undefined {
  const entry = findAccount(channel, account === undefined ? 'personal' : account);
  return entry?.connectorUrl;
}

/** WhatsApp connector URL (every account is a Baileys instance). */
export function whatsappConnectorUrl(account?: string): string | undefined {
  return connectorUrlFor('whatsapp', account);
}
