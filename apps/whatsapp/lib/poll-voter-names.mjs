import { isJidPlaceholder } from './chat-names.mjs';

const jid = value => typeof value === 'string' && /^\d+(?::\d+)?@(lid|c\.us|s\.whatsapp\.net)$/.test(value)
  ? value.replace(/:\d+@/, '@').replace(/@c\.us$/, '@s.whatsapp.net') : null;

/** Resolve only identities captured in this account's poll, never contacts from another account. */
export async function pollVoterNames(query, account, polls) {
  const ids = [...new Set(polls.flatMap(poll => (poll.options || []).flatMap(option =>
    (Array.isArray(option.voters) ? option.voters : []).map(voter => jid(voter?.jid)).filter(Boolean))))].slice(0, 2000);
  if (!ids.length) return polls;
  const rows = await query(`WITH identities AS (
    SELECT id, id AS candidate FROM unnest($2::text[]) id
    UNION SELECT id, a.canonical_external_id FROM unnest($2::text[]) id
      JOIN social_contact_aliases a ON a.account_id='whatsapp:' || $1
        AND a.alias_external_id=id AND a.evidence<>'blocked'
    UNION SELECT id, a.alias_external_id FROM unnest($2::text[]) id
      JOIN social_contact_aliases a ON a.account_id='whatsapp:' || $1
        AND a.canonical_external_id=id AND a.evidence<>'blocked'
  ) SELECT i.id, c.name, c.push_name, 1 AS priority
      FROM identities i JOIN whatsapp_contacts c ON c.account=$1
        AND regexp_replace(c.jid, '@c\\.us$', '@s.whatsapp.net')=i.candidate
    UNION ALL SELECT i.id, p.name, p.push_name, 2 AS priority
      FROM identities i JOIN participants p ON p.account=$1
        AND regexp_replace(CASE WHEN starts_with(p.id,$1 || ':') THEN substr(p.id,length($1)+2) ELSE p.id END, '@c\\.us$', '@s.whatsapp.net')=i.candidate
    ORDER BY priority`, [account, ids]);
  const names = new Map();
  for (const row of rows) {
    const label = [row.name, row.push_name].find(value => typeof value === 'string' && value.trim()
      && !isJidPlaceholder(value, row.id) && !/^\d+$/.test(value.trim()));
    if (label && !names.has(row.id)) names.set(row.id, label.trim());
  }
  return polls.map(poll => ({ ...poll, options: (poll.options || []).map(option => ({ ...option,
    voters: (Array.isArray(option.voters) ? option.voters : []).flatMap(voter => {
      const id = jid(voter?.jid);
      if (!id) return [];
      const phone = id.match(/^(\d+)@s\.whatsapp\.net$/)?.[1];
      return [{ id, name: voter.fromMe === true ? 'Tú' : names.get(id) || (phone ? `+${phone}` : 'Contacto sin nombre') }];
    }),
  })) }));
}
