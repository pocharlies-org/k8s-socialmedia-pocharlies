import { randomBytes } from 'node:crypto';
import {
  aesEncryptGCM,
  decryptPollVote,
  generateMessageIDV2,
  getKeyAuthor,
  hmacSign,
  normalizeMessageContent,
  proto,
  sha256,
  type WAMessageContent,
  type WAMessageKey,
} from '@whiskeysockets/baileys';
import { CapabilityError } from './whatsapp-capabilities';

/**
 * WhatsApp poll voting on Baileys 7.0.0-rc13.
 *
 * rc13 ships poll CREATION (`sendMessage({ poll })`) but no vote helper:
 * `generateWAMessageContent` has no `pollUpdateMessage` branch, the automatic
 * inbound-vote decryption in `processMessage` is commented out upstream, and
 * there is no `getPollVotes`-style retrieval. What the library does export is
 * every primitive needed to do it ourselves: `decryptPollVote` (the exact
 * HMAC/AES-GCM scheme WA uses), `aesEncryptGCM`, `hmacSign`, `sha256`,
 * `getKeyAuthor`, `proto`, and `generateWAMessageFromContent`.
 *
 * Vote identity caveat we cannot verify offline: `getKeyAuthor` prefers the
 * `*Alt` (LID) fields, and WA validates a vote hash against the sender
 * identity the signer used. We sign with the same normalized self JID that
 * Baileys' own inbound path (and therefore our aggregation) uses, so our own
 * votes are self-consistent. Cross-device hash acceptance must be confirmed
 * with a live 1:1 vote; see connectors/whatsapp-web README notes.
 */

export interface PollCreationDetails {
  question: string;
  options: string[];
  /** 0 means "unlimited" (up to the number of options), like Baileys. */
  selectableCount: number;
}

export interface PollVoteBuildInput {
  pollCreationKey: WAMessageKey;
  pollEncKey: Uint8Array;
  optionNames: string[];
  /** Normalized JID of this connector account (author of the vote). */
  meJid: string;
  senderTimestampMs?: number;
  /** Injectable for deterministic tests; random when omitted. */
  iv?: Uint8Array;
}

export interface CapturedPollVote {
  voterJid: string;
  fromMe: boolean;
  senderTimestampMs: number;
  selectedHashes: string[];
}

export interface StoredPollUpdate {
  key: WAMessageKey;
  content: unknown;
}

export interface PollOptionResult {
  name: string;
  count: number;
  selectedByMe: boolean;
}

export interface AggregatePollResult {
  options: PollOptionResult[];
  totalVoters: number;
  capturedVotes: number;
}

export type PollAvailability = 'local_full' | 'local_partial' | 'unavailable';

export interface PollResultsEntry {
  pollMessageId: string;
  question: string | null;
  selectableCount: number | null;
  available: boolean;
  availability: PollAvailability;
  reason: string | null;
  totalVoters: number;
  capturedVotes: number;
  decryptionFailures: number;
  options: PollOptionResult[];
}

function storedMessageToContent(value: unknown): WAMessageContent | undefined {
  return value && typeof value === 'object' ? (value as WAMessageContent) : undefined;
}

function bytesFromStored(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value) && value.every(item => typeof item === 'number'))
    return new Uint8Array(value);
  if (typeof value === 'string' && value.length)
    return new Uint8Array(Buffer.from(value, 'base64'));
  if (value && typeof value === 'object') {
    const tagged = value as { type?: unknown; data?: unknown };
    if (tagged.type === 'Buffer' && Array.isArray(tagged.data))
      return new Uint8Array(tagged.data as number[]);
  }
  return null;
}

function coerceSenderTimestampMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim().length) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  if (value && typeof value === 'object') {
    const long = value as { low?: unknown; high?: unknown; unsigned?: unknown };
    if (typeof long.low === 'number' && typeof long.high === 'number') {
      const bits = (BigInt(long.high >>> 0) << 32n) | BigInt(long.low >>> 0);
      const signed = long.unsigned === false ? BigInt.asIntN(64, bits) : bits;
      const ms = Number(signed);
      if (Number.isFinite(ms) && ms >= 0) return ms;
    }
  }
  return 0;
}

/** Extract question/options/selectableCount from any poll creation variant (V1/V2/V3/V5). */
export function parsePollCreationContent(storedMessage: unknown): PollCreationDetails | null {
  const normalized = normalizeMessageContent(storedMessageToContent(storedMessage));
  if (!normalized) return null;
  const creation =
    normalized.pollCreationMessage ??
    normalized.pollCreationMessageV2 ??
    normalized.pollCreationMessageV3 ??
    normalized.pollCreationMessageV5;
  if (!creation) return null;
  const options = (creation.options ?? [])
    .map(option => String(option?.optionName ?? ''))
    .filter(option => option.length > 0);
  if (!options.length) return null;
  const rawCount = Number(
    (creation as { selectableOptionsCount?: unknown }).selectableOptionsCount ?? 0
  );
  const selectableCount =
    Number.isFinite(rawCount) && rawCount >= 1 ? Math.min(Math.floor(rawCount), options.length) : 0;
  return { question: String(creation.name ?? ''), options, selectableCount };
}

/**
 * The poll encKey equals the creation message's messageSecret. For polls this
 * account created it is inside the persisted raw payload (Baileys writes it
 * into the content before sending); some inbound 1:1 copies carry it too.
 * Group polls only have it when the sender key chain was captured, hence the
 * honest availability contract instead of guessing.
 */
export function pollEncKeyFromStoredMessage(storedMessage: unknown): Uint8Array | null {
  const raw = storedMessageToContent(storedMessage);
  if (!raw) return null;
  const topSecret = bytesFromStored(
    (raw as { messageContextInfo?: { messageSecret?: unknown } }).messageContextInfo?.messageSecret
  );
  if (topSecret && topSecret.length === 32) return topSecret;
  const normalized = normalizeMessageContent(raw);
  for (const variant of [
    normalized?.pollCreationMessage,
    normalized?.pollCreationMessageV2,
    normalized?.pollCreationMessageV3,
    normalized?.pollCreationMessageV5,
  ]) {
    const secret = bytesFromStored(
      (variant as { messageContextInfo?: { messageSecret?: unknown } } | undefined)
        ?.messageContextInfo?.messageSecret
    );
    if (secret && secret.length === 32) return secret;
  }
  return null;
}

/**
 * Mirror of Baileys' exported decryptPollVote, so its own decryption (and any
 * future upstream path) can read what we send.
 */
export function buildPollVoteContent(input: PollVoteBuildInput): WAMessageContent {
  const pollMsgId = String(input.pollCreationKey.id ?? '');
  if (!pollMsgId)
    throw new CapabilityError('INVALID_CAPABILITY_INPUT', 'Poll creation message id is required');
  if (!input.meJid)
    throw new CapabilityError('INVALID_CAPABILITY_INPUT', 'Account JID is required to sign a vote');
  if (!Array.isArray(input.optionNames) || input.optionNames.length === 0)
    throw new CapabilityError('INVALID_CAPABILITY_INPUT', 'At least one option name is required');
  const creatorJid = getKeyAuthor(input.pollCreationKey, input.meJid);
  const sign = Buffer.concat([
    Buffer.from(pollMsgId),
    Buffer.from(creatorJid),
    Buffer.from(input.meJid),
    Buffer.from('Poll Vote'),
    new Uint8Array([1]),
  ]);
  const key0 = hmacSign(Buffer.from(input.pollEncKey), new Uint8Array(32), 'sha256');
  const voteKey = hmacSign(sign, key0, 'sha256');
  const aad = Buffer.from(`${pollMsgId}\u0000${input.meJid}`);
  const plaintext = proto.Message.PollVoteMessage.encode({
    selectedOptions: input.optionNames.map(name => new Uint8Array(sha256(Buffer.from(name)))),
  }).finish();
  const iv = input.iv ?? randomBytes(8);
  const encPayload = aesEncryptGCM(plaintext, voteKey, iv, aad);
  return {
    pollUpdateMessage: {
      pollCreationMessageKey: {
        remoteJid: input.pollCreationKey.remoteJid,
        fromMe: input.pollCreationKey.fromMe,
        id: pollMsgId,
        ...(input.pollCreationKey.participant
          ? { participant: input.pollCreationKey.participant }
          : {}),
      },
      vote: { encPayload, encIv: iv },
      senderTimestampMs: input.senderTimestampMs ?? Date.now(),
    },
  };
}

/** Decrypt raw captured pollUpdateMessage payloads; never throws per-vote. */
export function decryptCapturedPollVotes(
  rows: StoredPollUpdate[],
  context: { pollMsgId: string; pollEncKey: Uint8Array; meJid: string | null }
): { votes: CapturedPollVote[]; undecryptable: number } {
  const votes: CapturedPollVote[] = [];
  let undecryptable = 0;
  for (const row of rows) {
    const normalized = normalizeMessageContent(storedMessageToContent(row.content));
    const update = normalized?.pollUpdateMessage;
    const encPayload = bytesFromStored(update?.vote?.encPayload);
    const encIv = bytesFromStored(update?.vote?.encIv);
    if (!update || !encPayload || !encIv) {
      undecryptable += 1;
      continue;
    }
    const fromMe = row.key.fromMe === true;
    if (fromMe && !context.meJid) {
      undecryptable += 1;
      continue;
    }
    const meId = context.meJid || 'me';
    const creationKey = (update.pollCreationMessageKey ?? undefined) as WAMessageKey | undefined;
    const voterJids = [
      ...new Set(
        [row.key.participant, getKeyAuthor(row.key, meId)].filter((jid): jid is string => !!jid)
      ),
    ];
    const creatorJids = [
      ...new Set(
        [creationKey?.participant, getKeyAuthor(creationKey, meId)].filter(
          (jid): jid is string => !!jid
        )
      ),
    ];
    try {
      let decrypted: ReturnType<typeof decryptPollVote> | undefined;
      let voterJid = '';
      for (const creator of creatorJids) {
        for (const voter of voterJids) {
          try {
            decrypted = decryptPollVote(
              { encPayload, encIv },
              {
                pollCreatorJid: creator,
                pollMsgId: String(update.pollCreationMessageKey?.id ?? context.pollMsgId),
                pollEncKey: context.pollEncKey,
                voterJid: voter,
              }
            );
            voterJid = voter;
            break;
          } catch {
            /* Try the alternate PN/LID identity. */
          }
        }
        if (decrypted) break;
      }
      if (!decrypted) throw new Error('Vote could not be decrypted with known identities');
      votes.push({
        voterJid,
        fromMe,
        senderTimestampMs: coerceSenderTimestampMs(update.senderTimestampMs),
        selectedHashes: (decrypted.selectedOptions ?? []).map(option =>
          Buffer.from(option).toString('hex')
        ),
      });
    } catch {
      undecryptable += 1;
    }
  }
  return { votes, undecryptable };
}

/** Latest complete vote per voter wins (WhatsApp semantics for re-voting). */
export function aggregateCapturedPollVotes(
  details: PollCreationDetails,
  votes: CapturedPollVote[]
): AggregatePollResult {
  const latestByVoter = new Map<string, CapturedPollVote>();
  for (const vote of votes) {
    const previous = latestByVoter.get(vote.voterJid);
    if (!previous || vote.senderTimestampMs >= previous.senderTimestampMs)
      latestByVoter.set(vote.voterJid, vote);
  }
  const hashToIndex = new Map(
    details.options.map((name, index) => [
      Buffer.from(sha256(Buffer.from(name))).toString('hex'),
      index,
    ])
  );
  const counts = details.options.map(() => 0);
  const selectedByMe = details.options.map(() => false);
  for (const vote of latestByVoter.values()) {
    for (const hash of vote.selectedHashes) {
      const index = hashToIndex.get(hash);
      if (index === undefined) continue;
      counts[index] += 1;
      if (vote.fromMe) selectedByMe[index] = true;
    }
  }
  return {
    options: details.options.map((name, index) => ({
      name,
      count: counts[index],
      selectedByMe: selectedByMe[index],
    })),
    totalVoters: latestByVoter.size,
    capturedVotes: votes.length,
  };
}

/**
 * Exact-match option validation. The app forwards user selections untouched,
 * so we must NOT trim: any string differing by whitespace is invalid.
 */
export function validatePollVoteSelection(
  details: PollCreationDetails,
  requested: unknown
): string[] {
  const invalid = (message: string, extra: Record<string, unknown> = {}): never => {
    throw new CapabilityError('INVALID_CAPABILITY_INPUT', message, {
      validOptions: details.options,
      ...extra,
    });
  };
  if (!Array.isArray(requested) || requested.length === 0)
    invalid('options must be a non-empty array of exact option names');
  const names = requested as unknown[];
  for (const name of names) {
    if (typeof name !== 'string' || name.trim().length === 0)
      invalid('options must contain non-empty strings');
  }
  const exact = names.map(name => name as string);
  if (new Set(exact).size !== exact.length) invalid('options must not repeat the same option');
  const known = new Set(details.options);
  const unknown = exact.filter(name => !known.has(name));
  if (unknown.length) invalid(`Unknown poll option: ${JSON.stringify(unknown[0])}`, { unknown });
  const max = details.selectableCount >= 1 ? details.selectableCount : details.options.length;
  if (exact.length > max)
    invalid(`This poll allows at most ${max} option(s)`, { maxSelectable: max });
  return exact;
}

export { generateMessageIDV2 };
