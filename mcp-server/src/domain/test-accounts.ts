/**
 * Test seam for the account registry: specs declare the connector URLs they
 * expect and this writes a real registry file, so server specs exercise the
 * same registry path as production. Each call replaces the given channel maps
 * and keeps the others.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resetAccountRegistryCache } from './account-registry';

type UrlMap = Record<string, string>;

export function useTestAccounts(maps: {
  whatsapp?: UrlMap;
  telegram?: UrlMap;
  bridge?: UrlMap;
}): void {
  state = {
    whatsapp: maps.whatsapp ?? state.whatsapp,
    telegram: maps.telegram ?? state.telegram,
    bridge: maps.bridge ?? state.bridge,
  };
  const namespaces = new Set([...Object.keys(state.whatsapp), ...Object.keys(state.telegram)]);
  namespaces.add('personal');
  const entries: unknown[] = [];
  const wa = { personal: 'http://wa-personal', ...state.whatsapp };
  for (const [accountId, connectorUrl] of Object.entries(wa)) {
    if (accountId !== 'personal' && !(accountId in state.whatsapp)) continue;
    entries.push({
      channel: 'whatsapp',
      accountId,
      connectorUrl,
      requireInboundBeforeSend: accountId === 'professional',
    });
  }
  for (const [accountId, connectorUrl] of Object.entries(state.telegram)) {
    entries.push({
      channel: 'telegram',
      accountId,
      connectorUrl,
      ...(state.bridge[accountId] ? { bridgeUrl: state.bridge[accountId] } : {}),
    });
  }
  if (namespaces.has('professional')) {
    entries.push({ channel: 'instagram', accountId: 'skirmshop', namespace: 'professional' });
  }
  entries.push({ channel: 'instagram', accountId: 'barbelpapis', namespace: 'personal' });
  if (!file) {
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'test-accounts-')), 'accounts.json');
  }
  fs.writeFileSync(file, JSON.stringify(entries));
  process.env.SOCIAL_ACCOUNTS_FILE = file;
  resetAccountRegistryCache();
}

let file = '';
let state: { whatsapp: UrlMap; telegram: UrlMap; bridge: UrlMap } = {
  whatsapp: {},
  telegram: {},
  bridge: {},
};
