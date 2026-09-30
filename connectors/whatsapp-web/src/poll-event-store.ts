/**
 * WhatsApp poll votes and event responses (fase 3 / PR-7) — the DB side.
 *
 * One current state per (account, poll/event message, person) in
 * `whatsapp_poll_votes` / `whatsapp_event_responses` (mcp-server migration
 * 013, modelled on 011's reactions): a new vote replaces the previous one, a
 * retracted vote (empty selection) is marked `retracted` and keeps the last
 * selection, a cleared response is `unknown`; nothing is deleted. A replayed
 * older vote (history sync) never overwrites a newer one (`voted_at` /
 * `responded_at` = the WhatsApp time the voter stamped). The connector
 * records votes/responses of contacts, of our phone and the ones it sends.
 *
 * Rules (same as message-reactions.ts):
 *  - ids use the SAME namespacing as `messages` (accountKey); the DB files a
 *    phone-jid voter under its LID when social_contact_aliases knows it and
 *    moves the row to the conversation of the poll/event message;
 *  - the tables are created by the migration, never here. While one is
 *    missing (013 not applied) every write fails soft: 42P01 is logged once
 *    per table, re-probed every 5 minutes; sending a poll, a vote, an event or
 *    a response still works;
 *  - only a client with `ingest` on calls in here (the pairing pool never).
 */
import { accountKey, connectorAccount, getPool, stripAccountKey } from './db-writer';
import { whatsappAccountId } from './message-mutations';
import type { PollDefinition } from './poll-votes';
import type { EventDefinition, StoredEventResponse } from './event-responses';

const UNDEFINED_TABLE = '42P01';
const MISSING_TABLE_RECHECK_MS = 5 * 60 * 1000;

type Table = 'whatsapp_poll_votes' | 'whatsapp_event_responses';

const missingUntil: Record<Table, number> = {
  whatsapp_poll_votes: 0,
  whatsapp_event_responses: 0,
};
const missingLogged: Record<Table, boolean> = {
  whatsapp_poll_votes: false,
  whatsapp_event_responses: false,
};

/** Test hook: forget the "table missing" state between cases. */
export function resetPollEventStoreStateForTests(): void {
  for (const table of Object.keys(missingUntil) as Table[]) {
    missingUntil[table] = 0;
    missingLogged[table] = false;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUndefinedTable(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === UNDEFINED_TABLE;
}

/** true → skip the DB (table known missing, re-probe not due yet). */
function knownMissing(table: Table): boolean {
  return missingUntil[table] > Date.now();
}

function noteMissing(table: Table): void {
  missingUntil[table] = Date.now() + MISSING_TABLE_RECHECK_MS;
  if (!missingLogged[table]) {
    missingLogged[table] = true;
    console.warn(
      `${table} does not exist yet (mcp-server migration 013 not applied): ` +
        'poll votes / event responses are not recorded; sending still works'
    );
  }
}

function notePresent(table: Table): void {
  if (missingLogged[table]) {
    missingLogged[table] = false;
    console.info(`${table} is available: recording again`);
  }
  missingUntil[table] = 0;
}

/** Run a statement against a table that may not exist yet. undefined = unavailable. */
async function query(
  table: Table,
  sql: string,
  params: unknown[],
  what: string
): Promise<{ rows: Record<string, unknown>[] } | undefined> {
  if (knownMissing(table)) return undefined;
  try {
    const result = await getPool().query(sql, params);
    notePresent(table);
    return result as { rows: Record<string, unknown>[] };
  } catch (error) {
    if (isUndefinedTable(error)) {
      noteMissing(table);
      return undefined;
    }
    console.warn(`${what} failed: ${describeError(error)}`);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface PollVoteInput {
  /** Poll creation message, bare or namespaced id. */
  pollMessageId: string;
  /** Bare, normalised chat id (the one messages.conversation_id uses). */
  conversationId: string;
  /** Bare, normalised jid of the voter (this account's own jid for ours). */
  voterJid: string;
  /** Option names of the vote ([] = retracted). */
  selectedOptions: string[];
  /** Hex SHA-256 of what the vote carried (kept even for an unknown option). */
  selectedHashes: string[];
  fromMe?: boolean | null;
  voteMessageId?: string;
  votedAt?: Date;
}

/** Record the current vote of `voterJid`. Never throws; false when not written. */
export async function storePollVote(input: PollVoteInput): Promise<boolean> {
  const poll = String(input.pollMessageId || '').trim();
  const voter = String(input.voterJid || '').trim();
  const conversation = String(input.conversationId || '').trim();
  if (!poll || !voter || !conversation) return false;
  const retracted = input.selectedHashes.length === 0;
  // On the right-hand side of SET the table name is the row already stored.
  const result = await query(
    'whatsapp_poll_votes',
    `INSERT INTO whatsapp_poll_votes
       (account, poll_wa_message_id, voter_jid, conversation_id, vote_wa_message_id,
        selected_options, selected_hashes, retracted, from_me, voted_at)
     VALUES ($1, $2, $3, $4, $5, $6::text[], $7::text[], $8, $9, $10)
     ON CONFLICT (account, poll_wa_message_id, voter_jid) DO UPDATE SET
       voter_seen_jid = EXCLUDED.voter_seen_jid,
       vote_wa_message_id = COALESCE(EXCLUDED.vote_wa_message_id,
                                     whatsapp_poll_votes.vote_wa_message_id),
       selected_options = CASE WHEN EXCLUDED.retracted THEN whatsapp_poll_votes.selected_options
                               ELSE EXCLUDED.selected_options END,
       selected_hashes = CASE WHEN EXCLUDED.retracted THEN whatsapp_poll_votes.selected_hashes
                              ELSE EXCLUDED.selected_hashes END,
       retracted = EXCLUDED.retracted,
       from_me = COALESCE(EXCLUDED.from_me, whatsapp_poll_votes.from_me),
       voted_at = COALESCE(EXCLUDED.voted_at, whatsapp_poll_votes.voted_at),
       updated_at = now()
     WHERE EXCLUDED.voted_at IS NULL OR whatsapp_poll_votes.voted_at IS NULL
        OR EXCLUDED.voted_at >= whatsapp_poll_votes.voted_at
     RETURNING poll_wa_message_id`,
    [
      connectorAccount(),
      accountKey(poll),
      accountKey(voter),
      accountKey(conversation),
      input.voteMessageId ? accountKey(input.voteMessageId) : null,
      input.selectedOptions,
      input.selectedHashes,
      retracted,
      input.fromMe ?? null,
      input.votedAt || null,
    ],
    `poll vote store for ${poll}`
  );
  return !!result;
}

export interface EventResponseInput {
  eventMessageId: string;
  conversationId: string;
  responderJid: string;
  response: StoredEventResponse;
  extraGuestCount: number;
  fromMe?: boolean | null;
  responseMessageId?: string;
  respondedAt?: Date;
}

/** Record the current response of `responderJid`. Never throws; false when not written. */
export async function storeEventResponse(input: EventResponseInput): Promise<boolean> {
  const event = String(input.eventMessageId || '').trim();
  const responder = String(input.responderJid || '').trim();
  const conversation = String(input.conversationId || '').trim();
  if (!event || !responder || !conversation) return false;
  const result = await query(
    'whatsapp_event_responses',
    `INSERT INTO whatsapp_event_responses
       (account, event_wa_message_id, responder_jid, conversation_id, response_wa_message_id,
        response, extra_guest_count, from_me, responded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (account, event_wa_message_id, responder_jid) DO UPDATE SET
       responder_seen_jid = EXCLUDED.responder_seen_jid,
       response_wa_message_id = COALESCE(EXCLUDED.response_wa_message_id,
                                         whatsapp_event_responses.response_wa_message_id),
       response = EXCLUDED.response,
       extra_guest_count = EXCLUDED.extra_guest_count,
       from_me = COALESCE(EXCLUDED.from_me, whatsapp_event_responses.from_me),
       responded_at = COALESCE(EXCLUDED.responded_at, whatsapp_event_responses.responded_at),
       updated_at = now()
     WHERE EXCLUDED.responded_at IS NULL OR whatsapp_event_responses.responded_at IS NULL
        OR EXCLUDED.responded_at >= whatsapp_event_responses.responded_at
     RETURNING event_wa_message_id`,
    [
      connectorAccount(),
      accountKey(event),
      accountKey(responder),
      accountKey(conversation),
      input.responseMessageId ? accountKey(input.responseMessageId) : null,
      input.response,
      input.response === 'going' ? Math.max(0, Math.floor(input.extraGuestCount || 0)) : 0,
      input.fromMe ?? null,
      input.respondedAt || null,
    ],
    `event response store for ${event}`
  );
  return !!result;
}

// ---------------------------------------------------------------------------
// Reads (results)
// ---------------------------------------------------------------------------

function iso(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function textArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

export interface StoredPollVote {
  voterJid: string;
  options: string[];
  hashes: string[];
  fromMe: boolean;
  votedAt: string | null;
}

/**
 * Current (not retracted) votes of a poll, one per person (the view collapses
 * PN/LID again). `available: false` when 013 is not applied.
 */
export async function readPollVotes(
  pollMessageId: string
): Promise<{ available: boolean; votes: StoredPollVote[] }> {
  const result = await query(
    'whatsapp_poll_votes',
    `SELECT voter_jid, selected_options, selected_hashes, from_me, voted_at
       FROM whatsapp_poll_votes_current
      WHERE poll_wa_message_id = $1 AND account_id = $2
      ORDER BY voted_at NULLS LAST, voter_jid`,
    [accountKey(stripAccountKey(pollMessageId)), whatsappAccountId()],
    `poll votes read for ${pollMessageId}`
  );
  if (!result) return { available: false, votes: [] };
  return {
    available: true,
    votes: result.rows.map(row => ({
      voterJid: stripAccountKey(String(row.voter_jid)),
      options: textArray(row.selected_options),
      hashes: textArray(row.selected_hashes),
      fromMe: row.from_me === true,
      votedAt: iso(row.voted_at),
    })),
  };
}

export interface StoredEventResponseRow {
  responderJid: string;
  response: StoredEventResponse;
  extraGuestCount: number;
  fromMe: boolean;
  respondedAt: string | null;
}

/** Current responses of an event, one per person (cleared ones left out). */
export async function readEventResponses(
  eventMessageId: string
): Promise<{ available: boolean; responses: StoredEventResponseRow[] }> {
  const result = await query(
    'whatsapp_event_responses',
    `SELECT responder_jid, response, extra_guest_count, from_me, responded_at
       FROM whatsapp_event_responses_current
      WHERE event_wa_message_id = $1 AND account_id = $2
      ORDER BY responded_at NULLS LAST, responder_jid`,
    [accountKey(stripAccountKey(eventMessageId)), whatsappAccountId()],
    `event responses read for ${eventMessageId}`
  );
  if (!result) return { available: false, responses: [] };
  return {
    available: true,
    responses: result.rows.map(row => ({
      responderJid: stripAccountKey(String(row.responder_jid)),
      response: String(row.response) as StoredEventResponse,
      extraGuestCount: Number(row.extra_guest_count) || 0,
      fromMe: row.from_me === true,
      respondedAt: iso(row.responded_at),
    })),
  };
}

// ---------------------------------------------------------------------------
// Aggregation (pure)
// ---------------------------------------------------------------------------

export interface PollResults {
  question: string;
  selectableCount: number;
  options: Array<{ name: string; votes: number; voters: Array<{ jid: string; fromMe: boolean }> }>;
  /** People with at least one option selected. */
  totalVoters: number;
  /** Our current selection ([] = we have not voted or retracted). */
  myVote: string[];
}

/** Counts per option from the stored votes; an option the poll does not have is ignored. */
export function aggregatePollResults(
  definition: PollDefinition,
  votes: StoredPollVote[]
): PollResults {
  const options = definition.options.map(name => ({
    name,
    votes: 0,
    voters: [] as Array<{ jid: string; fromMe: boolean }>,
  }));
  const byName = new Map(options.map(option => [option.name, option]));
  let totalVoters = 0;
  let myVote: string[] = [];
  for (const vote of votes) {
    const chosen = vote.options.filter(name => byName.has(name));
    if (chosen.length) totalVoters += 1;
    if (vote.fromMe) myVote = chosen;
    for (const name of chosen) {
      const option = byName.get(name)!;
      option.votes += 1;
      option.voters.push({ jid: vote.voterJid, fromMe: vote.fromMe });
    }
  }
  return {
    question: definition.question,
    selectableCount: definition.selectableCount,
    options,
    totalVoters,
    myVote,
  };
}

export interface EventResults {
  counts: { going: number; maybe: number; not_going: number };
  /** Extra guests announced by the ones going. */
  extraGuests: number;
  responses: Array<{
    jid: string;
    response: StoredEventResponse;
    extraGuestCount: number;
    fromMe: boolean;
    respondedAt: string | null;
  }>;
  myResponse: StoredEventResponse | null;
}

export function aggregateEventResults(rows: StoredEventResponseRow[]): EventResults {
  const counts = { going: 0, maybe: 0, not_going: 0 };
  let extraGuests = 0;
  let myResponse: StoredEventResponse | null = null;
  const responses: EventResults['responses'] = [];
  for (const row of rows) {
    if (row.fromMe) myResponse = row.response;
    if (row.response === 'unknown') continue;
    counts[row.response] += 1;
    if (row.response === 'going') extraGuests += row.extraGuestCount;
    responses.push({
      jid: row.responderJid,
      response: row.response,
      extraGuestCount: row.extraGuestCount,
      fromMe: row.fromMe,
      respondedAt: row.respondedAt,
    });
  }
  return { counts, extraGuests, responses, myResponse };
}

/** Definition kept on the messages row (metadata.poll / metadata.event) — for results without a payload. */
export async function loadStructuredMetadata(
  messageId: string
): Promise<{ conversationId: string; poll?: PollDefinition; event?: EventDefinition } | undefined> {
  try {
    const result = await getPool().query(
      `SELECT m.conversation_id, m.metadata->'poll' AS poll, m.metadata->'event' AS event
         FROM messages m
        WHERE m.wa_message_id = $1 AND m.account_id = $2 AND m.platform = 'whatsapp'
        LIMIT 1`,
      [accountKey(stripAccountKey(messageId)), whatsappAccountId()]
    );
    const row = result.rows[0] as
      | { conversation_id?: string; poll?: PollDefinition | null; event?: EventDefinition | null }
      | undefined;
    if (!row) return undefined;
    return {
      conversationId: stripAccountKey(String(row.conversation_id || '')),
      ...(row.poll && Array.isArray(row.poll.options) ? { poll: row.poll } : {}),
      ...(row.event && typeof row.event.name === 'string' ? { event: row.event } : {}),
    };
  } catch (error) {
    console.warn(`structured metadata read failed for ${messageId}: ${describeError(error)}`);
    return undefined;
  }
}
