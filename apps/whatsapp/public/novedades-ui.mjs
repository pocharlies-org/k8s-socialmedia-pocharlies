/**
 * Novedades (Estados + Canales) viewer and account-scoped actions.
 *
 * Two catalogs (Estados, Canales) share one side panel: a list on the left
 * and a contextual viewer or empty state on the right; below 720px the
 * panel collapses into a single view with a back button. Every read comes
 * from the injected loaders (the /api/novedades proxy). Opening a status
 * never sends a read receipt; publishing and channel subscriptions require
 * an explicit confirmation through their dedicated API routes.
 *
 * The data contract is the proxied DTO as defined in lib/novedades-proxy.mjs:
 * authors carry {id, name, own, count, unseen, latestTimestamp}, status and
 * post items carry {id, kind, text, timestamp, remainingMs, mediaUrl}, and
 * channels carry {id, name, subscribers, avatarUrl}. Statuses are listed per
 * author: the API requires an explicit author, so the UI renders author
 * summaries first and only fetches that author's statuses when the queue is
 * opened — no N+1 fan-out and no bulk download. Expiry uses remainingMs
 * measured against a monotonic clock captured at receipt, so a skewed client
 * wall clock cannot keep dead statuses on screen or expire live ones early.
 *
 * Identity rules inherited from the directory: `@lid` is a privacy id, not a
 * phone. A missing name falls back to a readable number or "ID privado",
 * never to an invented name. Media URLs are accepted only when they are
 * same-origin authenticated paths under /api/novedades/ for the same
 * account; provider URLs and raw keys never render.
 */

export const NOVEDADES_MEDIA_PREFIX = '/api/novedades/'
const RENDERABLE_KINDS = new Set(['text', 'image', 'video'])
const TTL_TICK_MS = 1000

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

const moduleClock = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now())

/** Same-origin authenticated proxy under /api/novedades/ for this account only. */
export function novedadesMediaUrl(value, account, baseUrl = 'http://localhost/') {
  const candidate = text(value)
  if (!candidate) return ''
  try {
    const url = new URL(candidate, baseUrl)
    if (url.origin !== new URL(baseUrl, 'http://localhost/').origin) return ''
    if (!url.pathname.startsWith(NOVEDADES_MEDIA_PREFIX)) return ''
    if (url.searchParams.get('account') !== text(account)) return ''
    return `${url.pathname}${url.search}`
  } catch {
    return ''
  }
}

export function novedadesDate(value) {
  if (value === null || value === undefined || value === '') return null
  const date = value instanceof Date ? value : new Date(typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 1e12 ? value * (Math.abs(value) < 1e11 ? 1000 : 1) : value)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * A name is only shown when the provider stored one. Otherwise the identity
 * itself says what it is: a real number, a private id, or the raw address.
 */
export function readableAuthor(authorJid, storedName = '') {
  const name = text(storedName)
  if (name) return name
  const jid = text(authorJid)
  const [user = '', realm = ''] = jid.split('@')
  const digits = (user.split(':')[0] || '').replace(/\D/g, '')
  if ((realm === 'c.us' || realm === 's.whatsapp.net') && /^[0-9]{6,15}$/.test(digits)) return `+${digits}`
  if (realm === 'lid' && digits) return `ID privado ···${digits.slice(-3)}`
  return user || jid || 'Desconocido'
}

/**
 * Remaining lifetime in milliseconds. While the item is on screen the clock
 * is monotonic (elapsed time since receipt), never the client wall clock, so
 * a fast or drifting clock cannot resurrect expired rows or kill live ones.
 * The wall-clock fallback only applies when the proxy sent no remainingMs.
 */
export function statusRemainingMs(status, nowMonotonic, wallNow = Date.now()) {
  if (!status) return null
  if (typeof status.remainingMs === 'number' && status.ttlBase !== null) return status.remainingMs - (nowMonotonic - status.ttlBase)
  if (status.expiresAt) return status.expiresAt.getTime() - wallNow
  return null
}

/** Deleted, deactivated, unknown-freshness and expired rows never appear. */
export function statusIsVisible(status, nowMonotonic = moduleClock(), wallNow = Date.now()) {
  if (!status || status.deleted === true || status.freshnessUnknown === true || status.active !== true) return false
  const remaining = statusRemainingMs(status, nowMonotonic, wallNow)
  return remaining !== null && remaining > 0
}

/** Newest first; the viewer and section ordering share this queue order. */
export function visibleStatusQueue(statuses, nowMonotonic = moduleClock()) {
  const queue = []
  const seen = new Set()
  for (const status of statuses || []) {
    if (!status || seen.has(status.id) || !statusIsVisible(status, nowMonotonic)) continue
    seen.add(status.id)
    queue.push(status)
  }
  return queue.sort((a, b) => (b.timestamp?.getTime() || 0) - (a.timestamp?.getTime() || 0))
}

/** Windows grouping over the author summary: own · unseen · already seen. */
export function groupAuthors(authors) {
  const own = []
  const recent = []
  const viewed = []
  for (const author of authors || []) {
    if (!author) continue
    if (author.own) own.push(author)
    else if (author.unseen > 0) recent.push(author)
    else viewed.push(author)
  }
  const newestFirst = (a, b) => (b.latestTimestamp?.getTime() || 0) - (a.latestTimestamp?.getTime() || 0)
  return [
    { kind: 'own', title: 'Mis estados', items: own.sort(newestFirst) },
    { kind: 'recent', title: 'Actualizaciones recientes', items: recent.sort(newestFirst) },
    { kind: 'viewed', title: 'Vistos', items: viewed.sort(newestFirst) },
  ].filter(section => section.items.length)
}

/** Filter already loaded channels locally; provider lookup is a separate action. */
export function filterChannels(channels, query) {
  const needle = text(query).toLocaleLowerCase()
  const list = (channels || []).filter(Boolean)
  if (!needle) return list
  return list.filter(channel =>
    channel.name.toLocaleLowerCase().includes(needle) ||
    (channel.description || '').toLocaleLowerCase().includes(needle))
}

/** Only http(s) becomes a link; everything else stays plain text. */
export function safeNovedadesLink(url) {
  const candidate = text(url).replace(/[)\],.;:]+$/, '')
  if (!candidate) return null
  try {
    const parsed = new URL(candidate)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    return { href: parsed.toString(), rel: 'noopener noreferrer nofollow' }
  } catch {
    return null
  }
}

export function linkifyParts(value) {
  const parts = []
  const pattern = /https?:\/\/[^\s]+/g
  let rest = String(value || '')
  for (;;) {
    const match = pattern.exec(rest)
    if (!match) break
    if (match.index) parts.push({ text: rest.slice(0, match.index) })
    const link = safeNovedadesLink(match[0])
    parts.push(link ? { url: match[0], link } : { text: match[0] })
    rest = rest.slice(match.index + match[0].length)
    pattern.lastIndex = 0
  }
  if (rest) parts.push({ text: rest })
  return parts
}

export function normalizeNovedadesAuthor(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = text(raw.id)
  if (!id) return null
  return {
    id,
    name: text(raw.name),
    own: raw.own === true,
    count: Number.isFinite(raw.count) ? raw.count : 0,
    unseen: Number.isFinite(raw.unseen) ? raw.unseen : 0,
    latestTimestamp: novedadesDate(raw.latestTimestamp),
    latestStatusId: text(raw.latestStatusId),
    latestReceivedAt: text(raw.latestReceivedAt),
  }
}

export function normalizeNovedadesStatus(raw, account, baseUrl, monotonic = moduleClock) {
  if (!raw || typeof raw !== 'object') return null
  const id = text(raw.id)
  if (!id || !RENDERABLE_KINDS.has(raw.kind)) return null
  const remainingMs = typeof raw.remainingMs === 'number' && Number.isFinite(raw.remainingMs) ? raw.remainingMs : null
  return {
    id,
    author: text(raw.author),
    kind: raw.kind,
    text: text(raw.text),
    mediaUrl: raw.kind === 'text' ? '' : novedadesMediaUrl(raw.mediaUrl, account, baseUrl),
    timestamp: novedadesDate(raw.timestamp),
    expiresAt: novedadesDate(raw.expiresAt),
    remainingMs,
    ttlBase: remainingMs === null ? null : monotonic(),
    active: raw.active === true,
    freshnessUnknown: raw.freshnessUnknown === true,
    deleted: raw.deleted === true,
    seenAt: novedadesDate(raw.seenAt),
  }
}

export function normalizeNovedadesChannel(raw, account, baseUrl) {
  if (!raw || typeof raw !== 'object') return null
  const id = text(raw.id)
  if (!id) return null
  const name = text(raw.name)
  return {
    id,
    name: name || readableAuthor(id, ''),
    description: text(raw.description),
    subscribers: Number.isFinite(raw.subscribers) ? raw.subscribers : null,
    latestTimestamp: novedadesDate(raw.latestTimestamp),
    avatarUrl: raw.avatarAvailable === true ? novedadesMediaUrl(raw.avatarUrl, account, baseUrl) : '',
    verification: text(raw.verification),
    subscribed: raw.subscribed === true,
  }
}

export function normalizeNovedadesPost(raw, account, baseUrl) {
  if (!raw || typeof raw !== 'object') return null
  const id = text(raw.id)
  if (!id || !RENDERABLE_KINDS.has(raw.kind) || raw.deleted === true) return null
  return {
    id,
    kind: raw.kind,
    text: text(raw.text),
    timestamp: novedadesDate(raw.timestamp),
    mediaUrl: raw.kind === 'text' ? '' : novedadesMediaUrl(raw.mediaUrl, account, baseUrl),
  }
}

const dateTime = new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'short' })

export function ttlLabel(status, nowMonotonic = moduleClock(), wallNow = Date.now()) {
  const remaining = statusRemainingMs(status, nowMonotonic, wallNow)
  if (remaining === null) return ''
  if (remaining <= 0) return 'Expirado'
  const hours = Math.floor(remaining / 3_600_000)
  const minutes = Math.floor((remaining % 3_600_000) / 60_000)
  return `Caduca en ${hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`}`
}

const dateLabel = date => (date ? dateTime.format(date) : '')

// ------------------------------------------------------------- publication
//
// Publishing is the one write this panel performs, and the server is the
// authority on what a write may contain: the app proxy accepts the five font
// ids the connector forwards, a 700-character text status, a 1024-character
// caption, one of a handful of media types and at most 256 direct JIDs. The
// composer applies the same rules before a byte is read so an unsupported
// file never becomes a request, and it never sends an empty audience: a
// missing recipient list is a mistake, not a request for "everyone".

export const STATUS_MEDIA_MAX_BYTES = 10 * 1024 * 1024
export const STATUS_TEXT_MAX = 700
export const STATUS_CAPTION_MAX = 1024
export const STATUS_RECIPIENTS_MAX = 256
export const STATUS_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp']
export const STATUS_VIDEO_MIME_TYPES = ['video/mp4', 'video/3gpp', 'video/quicktime']
export const STATUS_COLORS = [
  { id: 'bosque', label: 'Verde bosque', hex: '#0b3d2e' },
  { id: 'noche', label: 'Azul noche', hex: '#141c33' },
  { id: 'ciruela', label: 'Ciruela', hex: '#3b1535' },
  { id: 'teja', label: 'Teja', hex: '#59250f' },
  { id: 'grafito', label: 'Grafito', hex: '#22262b' },
  { id: 'arena', label: 'Arena', hex: '#6a5320' },
]
// The connector forwards five numeric font ids; the composer previews them with
// the closest local face and never claims WhatsApp's own typeface.
export const STATUS_FONTS = [
  { id: 1, css: 'var(--font)', weight: 400, style: 'normal' },
  { id: 2, css: 'Georgia, "Times New Roman", serif', weight: 400, style: 'normal' },
  { id: 3, css: 'ui-monospace, "SFMono-Regular", Menlo, monospace', weight: 500, style: 'normal' },
  { id: 4, css: 'var(--font)', weight: 700, style: 'normal' },
  { id: 5, css: '"Segoe Print", "Bradley Hand", cursive', weight: 400, style: 'italic' },
]

const STATUS_COLOR_HEXES = new Map(STATUS_COLORS.map(color => [color.id, color.hex]))
const STATUS_FONT_IDS = new Set(STATUS_FONTS.map(font => font.id))
const PHONE_JID = /^[0-9]{6,15}@s\.whatsapp\.net$/
const LID_KEY = /^lid:([0-9]{5,20})$/
const EXTENSION_MIMES = new Map([
  ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['png', 'image/png'],
  ['mp4', 'video/mp4'], ['m4v', 'video/mp4'], ['3gp', 'video/3gpp'], ['3gpp', 'video/3gpp'],
  ['mov', 'video/quicktime'], ['webp', 'image/webp'],
])

const STATUS_MIME_LABELS = new Map([
  ['image/jpeg', 'JPG'], ['image/png', 'PNG'], ['image/webp', 'WEBP'],
  ['video/mp4', 'MP4'], ['video/3gpp', '3GP'], ['video/quicktime', 'MOV'],
])

function statusFormatNames(type) {
  const names = (type === 'video' ? STATUS_VIDEO_MIME_TYPES : STATUS_IMAGE_MIME_TYPES)
    .map(item => STATUS_MIME_LABELS.get(item) || item)
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} o ${names.at(-1)}` : names[0]
}

/** What the file picker promises, written once so hint and error cannot drift. */
export function statusFormatHint(type) {
  return `${statusFormatNames(type)} · hasta ${mebibytes(STATUS_MEDIA_MAX_BYTES)}`
}

function mebibytes(bytes) {
  return `${(bytes / 1_048_576).toFixed(1).replace(/\.0$/, '')} MiB`
}

export function statusColorHex(id) {
  return STATUS_COLOR_HEXES.get(text(id)) || STATUS_COLORS[0].hex
}

/** Font ids are numeric (1..5); anything else falls back to the default face. */
export function statusFontId(value) {
  const id = Number(value)
  return STATUS_FONT_IDS.has(id) ? id : 1
}

export function statusTextLimit(type) {
  return type === 'image' || type === 'video' ? STATUS_CAPTION_MAX : STATUS_TEXT_MAX
}

/**
 * The directory key is the phone digits or `lid:<digits>`, and `phone` only
 * exists when a real number was synced. A status needs a reachable direct JID,
 * so a number always wins and a private identifier is used as `@lid` only when
 * it is a bare digit run with no phone behind it.
 */
export function statusRecipientFromContact(contact) {
  if (!contact || typeof contact !== 'object') return { jid: '', realm: '', digits: '', reason: 'Contacto sin datos.' }
  const rawPhone = text(contact.phone).replace(/[^+0-9]/g, '')
  const digits = rawPhone.startsWith('+') ? rawPhone.slice(1) : rawPhone
  if (PHONE_JID.test(`${digits}@s.whatsapp.net`)) {
    return { jid: `${digits}@s.whatsapp.net`, realm: 'phone', digits, reason: '' }
  }
  const keyLid = LID_KEY.exec(text(contact.key))?.[1] || ''
  const rawLid = text(contact.lid).replace(/[^\d]/g, '')
  const lid = keyLid || (LID_KEY.test(`lid:${rawLid}`) ? rawLid : '')
  if (lid) return { jid: `${lid}@lid`, realm: 'lid', digits: lid, reason: '' }
  if (digits) return { jid: '', realm: '', digits: '', reason: 'El número sincronizado no tiene un formato válido.' }
  return { jid: '', realm: '', digits: '', reason: 'Sin número ni identificador privado utilizable.' }
}

/** Contact avatars come from the authenticated directory proxy for this account. */
export function statusContactAvatarUrl(value, account = '', baseUrl = 'http://localhost/') {
  const candidate = text(value)
  if (!candidate) return ''
  try {
    const url = new URL(candidate, baseUrl)
    if (url.origin !== new URL(baseUrl, 'http://localhost/').origin) return ''
    if (!url.pathname.startsWith('/api/contacts/')) return ''
    if (url.searchParams.get('account') !== text(account)) return ''
    return `${url.pathname}${url.search}`
  } catch {
    return ''
  }
}

export function normalizeStatusContact(raw, { account = '', baseUrl = 'http://localhost/' } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const key = text(raw.key)
  if (!key) return null
  const recipient = statusRecipientFromContact(raw)
  const label = readableAuthor(recipient.jid || key, text(raw.label))
  const hint = recipient.realm === 'phone'
    ? `+${recipient.digits}`
    : recipient.realm === 'lid'
      ? `ID privado ···${recipient.digits.slice(-3)}`
      : recipient.reason
  return {
    key,
    label,
    hint,
    jid: recipient.jid,
    realm: recipient.realm,
    addressable: Boolean(recipient.jid),
    reason: recipient.reason,
    kind: text(raw.kind),
    avatarUrl: statusContactAvatarUrl(raw.avatarUrl, account, baseUrl),
  }
}

/** A declared MIME type wins; otherwise the extension is read, never invented. */
export function statusMediaMime(media) {
  const declared = text(media?.type).toLowerCase()
  if (declared) return declared
  const match = /\.([a-z0-9]+)$/.exec(text(media?.name).toLowerCase())
  return match ? EXTENSION_MIMES.get(match[1]) || '' : ''
}

export function statusMediaError(media, type) {
  if (!media) return type === 'video' ? 'Elige un vídeo para el estado.' : 'Elige una imagen para el estado.'
  const kind = type === 'video' ? 'vídeo' : 'imagen'
  const size = Number(media.size)
  if (!Number.isFinite(size) || size <= 0) return 'El archivo está vacío: no se puede publicar.'
  if (size > STATUS_MEDIA_MAX_BYTES) {
    return `El ${kind} pesa ${mebibytes(size)} y el límite por estado es ${mebibytes(STATUS_MEDIA_MAX_BYTES)}.`
  }
  if (!(type === 'video' ? STATUS_VIDEO_MIME_TYPES : STATUS_IMAGE_MIME_TYPES).includes(statusMediaMime(media))) {
    return `Formato no admitido para un ${kind}. Admitidos: ${statusFormatNames(type)}.`
  }
  return ''
}

/** Recipients may arrive as directory entries or as bare JIDs. */
export function statusDraftRecipients(draft) {
  const jids = []
  const seen = new Set()
  for (const item of draft?.recipients || []) {
    const jid = text(typeof item === 'string' ? item : item?.jid)
    if (!jid || seen.has(jid)) continue
    seen.add(jid)
    jids.push(jid)
  }
  return jids
}

/**
 * First reason the draft cannot be sent, in the order the owner needs to hear
 * it: nobody chosen, then the content, then the file itself.
 */
export function validateStatusDraft(draft) {
  const type = draft?.type === 'image' || draft?.type === 'video' ? draft.type : 'text'
  const recipients = statusDraftRecipients(draft)
  if (!recipients.length) return { field: 'recipients', message: 'Elige al menos un destinatario: el estado no se envía a toda la agenda.' }
  if (recipients.length > STATUS_RECIPIENTS_MAX) return { field: 'recipients', message: `Máximo ${STATUS_RECIPIENTS_MAX} destinatarios por estado.` }
  const body = text(draft?.text)
  const limit = statusTextLimit(type)
  if (body.length > limit) return { field: 'text', message: `El texto supera ${limit} caracteres.` }
  if (type === 'text') return body ? null : { field: 'text', message: 'Escribe un texto para el estado.' }
  if (!draft?.media) return { field: 'media', message: type === 'video' ? 'Elige un vídeo para el estado.' : 'Elige una imagen para el estado.' }
  const mediaError = statusMediaError(draft.media, type)
  return mediaError ? { field: 'media', message: mediaError } : null
}

/**
 * Exactly the fields the proxy reads. Media goes as plain base64 because the
 * data-URL prefix would only add bytes, and background plus font are pointless
 * once there is a photo or a clip on screen.
 */
export function statusPayload(draft) {
  const type = draft?.type === 'image' || draft?.type === 'video' ? draft.type : 'text'
  const recipients = statusDraftRecipients(draft)
  if (!recipients.length || recipients.length > STATUS_RECIPIENTS_MAX) return null
  const body = text(draft.text)
  const payload = { type, recipients }
  if (type === 'text') {
    if (!body || body.length > STATUS_TEXT_MAX) return null
    payload.text = body
    payload.backgroundColor = statusColorHex(draft.backgroundColor)
    payload.font = statusFontId(draft.font)
    return payload
  }
  const base64 = text(draft.media?.base64)
  const mimeType = statusMediaMime(draft.media)
  if (!base64 || !mimeType) return null
  if (body && body.length <= STATUS_CAPTION_MAX) payload.text = body
  payload.data = base64
  payload.mimeType = mimeType
  return payload
}

/** Who is about to receive the status, as lines for the confirmation step. */
export function statusAudienceSummary(recipients, limit = 6) {
  const entries = []
  const seen = new Set()
  for (const item of recipients || []) {
    const jid = text(typeof item === 'string' ? item : item?.jid)
    if (!jid || seen.has(jid)) continue
    seen.add(jid)
    const entry = typeof item === 'string'
      ? { jid, label: readableAuthor(jid, ''), hint: jid.endsWith('@lid') ? 'ID privado' : 'Número' }
      : { jid, label: text(item.label) || readableAuthor(jid, ''), hint: text(item.hint) }
    entries.push(entry)
  }
  const lines = entries.slice(0, Math.max(0, limit))
  return { total: entries.length, lines, hidden: entries.length - lines.length }
}

function failureMessage(error) {
  if (typeof error === 'string') return text(error)
  if (error && typeof error.message === 'string') return text(error.message)
  return ''
}

/**
 * Only a body that proves the send counts as success: the proxy answers
 * `confirmed: true` plus the provider `messageId`. An empty or partial body, a
 * `confirmed: false` and an answer that belongs to another account are all
 * uncertain, and none of them may clear the draft or claim a published status.
 */
export function statusSendOutcome(result, account = '') {
  if (!result || typeof result !== 'object') return 'uncertain'
  const responded = text(result.account)
  if (responded && text(account) && responded !== text(account)) return 'stale'
  if (result.confirmed !== true) return 'uncertain'
  return text(result.messageId) ? 'sent' : 'uncertain'
}

/**
 * Whether a failure leaves the outcome unknown. The default answer is
 * "unknown": a status that may already be with the audience must never be
 * reported as a clean failure, because the composer does not retry and the
 * owner would publish it twice. Ordered from the most specific signal down:
 * `outcomeUncertain` from the app proxy beats every other signal; a refusal the
 * app raised before the request left settles the outcome even when the status
 * is a 5xx; the connector's own codes say which side they fall on; any 5xx
 * after dispatch stays open, including a 5xx still labelled
 * `STATUS_PUBLISH_REJECTED`; an explicit 4xx settles it except 408 and 429,
 * which say nothing about dispatch; and a message that names neither a
 * validation nor a refusal — Safari's bare `Load failed`, a broken pipe,
 * anything unreadable — stays uncertain.
 */
const STATUS_CERTAIN_CODES = new Set([
  'INVALID_RECIPIENT', 'INVALID_CAPABILITY_INPUT', 'INVALID_STATUS_INPUT',
  'STATUS_PUBLISH_REJECTED', 'MEDIA_TOO_LARGE', 'SENDING_DISABLED', 'AUTH_REQUIRED',
])
const STATUS_UNCERTAIN_CODES = new Set([
  'DELIVERY_UNCONFIRMED', 'UNSUPPORTED_UPSTREAM', 'UPSTREAM_UNAVAILABLE',
])
// Refusals raised before the publish is handed to the connector: the send gate
// and a missing account secret. The second one travels as a 503, which would
// otherwise read like an unanswered dispatch even though nothing left the app.
const STATUS_PREDISPATCH_REFUSAL = /(sending is disabled|env[ií]o desactivad|connector credentials unavailable|credenciales del conector)/iu
const STATUS_CERTAIN_WORDING = /(validaci|invalid|not valid|no v[aá]lido|formato no admitido|desactivad|disabled|unknown account|cuenta desconocida|too large|destinatario no|admite)/iu

export function statusFailureIsUncertain(error) {
  const message = failureMessage(error)
  const status = Number(error?.status ?? error?.statusCode)
  const code = text(error?.code).toUpperCase()
  if (error?.outcomeUncertain === true) return true
  if (STATUS_UNCERTAIN_CODES.has(code)) return true
  if (STATUS_PREDISPATCH_REFUSAL.test(message)) return false
  if (Number.isInteger(status) && status >= 500) return true
  if (Number.isInteger(status) && status >= 400 && status < 500 && status !== 408 && status !== 429) return false
  if (STATUS_CERTAIN_CODES.has(code)) return false
  return !STATUS_CERTAIN_WORDING.test(message)
}

export function installNovedadesUI({
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  getAccount,
  loadAuthors = async () => ({ authors: [] }),
  loadStatuses = async () => ({ items: [] }),
  loadChannels = async () => ({ channels: [] }),
  lookupChannel = null,
  changeChannelSubscription = null,
  loadPosts = async () => ({ items: [] }),
  loadContacts = async () => ({ contacts: [] }),
  publishStatus = null,
  canPublish = () => true,
  onOpen = null,
  baseUrl = () => `${windowRef?.location?.origin || 'http://localhost/'}/`,
} = {}) {
  if (!documentRef || typeof getAccount !== 'function') return null

  const monotonicNow = () => (windowRef?.performance?.now?.() ?? moduleClock())

  const state = {
    closed: true,
    generation: 0,
    request: 0,
    tab: 'statuses',
    account: '',
    opener: null,
    root: null,
    panel: null,
    list: null,
    status: null,
    searchRow: null,
    searchInput: null,
    channelsMore: null,
    tabs: [],
    viewer: null,
    viewerRefs: null,
    viewerLabel: '',
    viewerAuthorId: '',
    viewerQueue: [],
    viewerIds: null,
    viewerIndex: -1,
    viewerCursor: null,
    viewerLoading: false,
    viewerTicker: null,
    timeline: null,
    timelineRefs: null,
    timelineChannel: null,
    timelineCursor: null,
    timelineLoading: false,
    timelineRequest: 0,
    channels: [],
    channelsCursor: null,
    channelsLoading: false,
    channelQuery: '',
    lookupChannel: null,
    lookupRequest: 0,
    subscriptionPending: false,
    subscriptionSerial: 0,
    composeRow: null,
    composeButton: null,
    composer: null,
    composerRefs: null,
    composerId: 0,
    composerSerial: 0,
    notice: '',
    confirm: null,
    confirmRefs: null,
    publishing: false,
    objectUrl: '',
    recipients: new Map(),
    draft: null,
    audience: { query: '', items: [], cursor: null, loading: false, serial: 0, timer: null, error: '' },
  }

  const isCurrent = token => !state.closed && token.generation === state.generation && token.account === state.account

  function node(tag, className = '', value = '') {
    const element = documentRef.createElement(tag)
    if (className) element.className = className
    if (value !== '') element.textContent = value
    return element
  }

  function button(className, label) {
    const element = documentRef.createElement('button')
    element.type = 'button'
    if (className) element.className = className
    element.setAttribute('aria-label', label)
    element.title = label
    return element
  }

  function clearMedia() {
    const media = state.viewerRefs?.media?.firstChild
    if (!media) return
    media.pause?.()
    media.removeAttribute?.('src')
  }

  function setStatus(message, kind = 'info') {
    if (!state.status) return
    // A pending notice outranks a routine list count: the refresh that follows a
    // publish must not erase the answer the owner is waiting for.
    if (state.notice && kind !== 'error') return
    state.status.textContent = message
    state.status.dataset.kind = kind === 'error' ? 'error' : 'info'
  }

  function setNotice(message) {
    state.notice = message
    if (!state.status) return
    state.status.textContent = message
    state.status.dataset.kind = 'info'
  }

  function errorPane(message, retry) {
    state.list.replaceChildren()
    const box = node('div', 'novedades-empty')
    box.append(node('p', '', message))
    const again = button('novedades-retry', 'Reintentar')
    again.textContent = 'Reintentar'
    again.onclick = () => void retry()
    box.append(again)
    state.list.append(box)
    setStatus('')
  }

  function emptyPane(message) {
    state.list.replaceChildren()
    state.list.append(node('p', 'novedades-empty', message))
  }

  function avatarNode(url, name) {
    const avatar = node('span', 'novedades-avatar')
    avatar.setAttribute('aria-hidden', 'true')
    if (url) {
      const image = documentRef.createElement('img')
      image.src = url
      image.alt = ''
      image.loading = 'lazy'
      image.addEventListener('error', () => image.remove())
      avatar.append(image)
    }
    avatar.append(node('span', 'novedades-initial', [...text(name)][0]?.toUpperCase() || '?'))
    return avatar
  }

  function rowButton(label, detail, onClick, { avatarUrl = '', avatarName = label, badge = '' } = {}) {
    const row = button('novedades-row', label)
    row.append(avatarNode(avatarUrl, avatarName))
    const copy = node('span', 'novedades-copy')
    copy.append(node('strong', '', label))
    if (detail) copy.append(node('span', 'novedades-detail', detail))
    row.append(copy)
    if (badge) row.append(node('span', 'novedades-unread', badge))
    row.onclick = onClick
    return row
  }

  // ---------------------------------------------------------------- statuses

  async function renderStatusesTab() {
    const token = { generation: state.generation, account: state.account }
    const requestId = ++state.request
    state.panel?.setAttribute('aria-busy', 'true')
    state.channelsMore.hidden = true
    try {
      const result = await loadAuthors()
      if (!isCurrent(token) || requestId !== state.request || state.tab !== 'statuses') return
      const authors = (Array.isArray(result?.authors) ? result.authors : [])
        .map(raw => normalizeNovedadesAuthor(raw))
        .filter(Boolean)
      state.list.replaceChildren()
      const sections = groupAuthors(authors)
      for (const section of sections) {
        state.list.append(node('h3', 'novedades-section-title', section.title))
        for (const author of section.items) state.list.append(authorRow(author))
      }
      if (!authors.length) emptyPane('No hay estados sincronizados en esta cuenta.')
      const total = authors.reduce((sum, author) => sum + author.count, 0)
      setStatus(authors.length ? `${total} ${total === 1 ? 'estado activo' : 'estados activos'}` : '')
    } catch {
      if (!isCurrent(token) || requestId !== state.request) return
      errorPane('No se pudieron cargar los estados. Comprueba la conexión del conector.', renderStatusesTab)
    } finally {
      if (isCurrent(token) && requestId === state.request) state.panel?.setAttribute('aria-busy', 'false')
    }
  }

  function authorRow(author) {
    const label = readableAuthor(author.id, author.name)
    const when = dateLabel(author.latestTimestamp)
    const detail = `${author.count} ${author.count === 1 ? 'estado' : 'estados'}${when ? ` · ${when}` : ''}`
    return rowButton(label, detail, () => void openAuthorStatuses(author), {
      avatarName: label,
      badge: author.unseen > 0 ? String(author.unseen) : '',
    })
  }

  async function openAuthorStatuses(author) {
    if (state.viewerLoading) return
    const token = { generation: state.generation, account: state.account }
    const label = readableAuthor(author.id, author.name)
    state.viewerLoading = true
    setStatus(`Cargando los estados de ${label}…`)
    try {
      const result = await loadStatuses(author.id, {})
      if (!isCurrent(token) || state.tab !== 'statuses') return
      const queue = visibleStatusQueue((Array.isArray(result?.items) ? result.items : [])
        .map(raw => normalizeNovedadesStatus(raw, token.account, baseUrl(), monotonicNow)), monotonicNow())
      if (!queue.length) {
        setStatus(`${label} ya no tiene estados activos.`)
        return
      }
      openViewer(label, author.id, queue, typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null)
      setStatus('')
    } catch {
      if (!isCurrent(token)) return
      setStatus(`No se pudieron cargar los estados de ${label}.`, 'error')
    } finally {
      state.viewerLoading = false
    }
  }

  function viewerChrome() {
    if (state.viewer) return state.viewer
    const viewer = node('div', 'novedades-viewer')
    viewer.setAttribute('role', 'region')
    viewer.setAttribute('aria-label', 'Visor de estados')
    const header = node('header', 'novedades-viewer-header')
    const back = button('novedades-back', 'Volver a la lista de estados')
    back.append(node('span', '', '←'))
    back.onclick = closeViewer
    const identity = node('div', 'novedades-viewer-identity')
    const author = node('strong', 'novedades-viewer-author')
    const meta = node('span', 'novedades-viewer-meta')
    identity.append(author, meta)
    const closeButton = button('novedades-viewer-close', 'Cerrar visor')
    closeButton.textContent = '×'
    closeButton.onclick = () => close({ restoreFocus: true })
    header.append(back, identity, closeButton)
    const media = node('div', 'novedades-viewer-media')
    const footer = node('div', 'novedades-viewer-footer')
    const previous = button('novedades-step', 'Estado anterior')
    previous.textContent = '‹'
    previous.onclick = () => void stepViewer(-1)
    const counter = node('span', 'novedades-counter')
    counter.setAttribute('aria-live', 'polite')
    const next = button('novedades-step', 'Estado siguiente')
    next.textContent = '›'
    next.onclick = () => void stepViewer(1)
    footer.append(previous, counter, next)
    viewer.append(header, media, footer)
    state.viewer = viewer
    state.viewerRefs = { author, meta, media, previous, counter, next }
    return viewer
  }

  function openViewer(label, authorId, queue, cursor) {
    // A send in flight owns the composer: navigating away now would hide the
    // only answer that says whether the audience already holds the status.
    if (state.publishing) return
    closeTimelineQuiet()
    closeViewerQuiet()
    closeComposer({ restoreFocus: false })
    state.viewerLabel = label
    state.viewerAuthorId = authorId
    state.viewerQueue = queue
    state.viewerIds = new Set(queue.map(status => status.id))
    state.viewerIndex = 0
    state.viewerCursor = cursor
    const viewer = viewerChrome()
    state.panel.classList.add('novedades-viewing')
    if (!viewer.parentNode) state.panel.append(viewer)
    showViewerItem()
    startViewerTicker()
  }

  function updateViewerMeta() {
    const refs = state.viewerRefs
    const status = state.viewerQueue[state.viewerIndex]
    if (!refs || !status) return
    refs.meta.textContent = [
      dateLabel(status.timestamp) || 'Fecha desconocida',
      ttlLabel(status, monotonicNow()),
    ].filter(Boolean).join(' · ')
  }

  function startViewerTicker() {
    if (state.viewerTicker) return
    const schedule = windowRef?.setInterval || globalThis.setInterval
    state.viewerTicker = schedule(() => {
      if (state.closed || !state.viewer) {
        stopViewerTicker()
        return
      }
      showViewerItem(true)
    }, TTL_TICK_MS)
  }

  function stopViewerTicker() {
    if (!state.viewerTicker) return
    ;(windowRef?.clearInterval || globalThis.clearInterval)(state.viewerTicker)
    state.viewerTicker = null
  }

  function showViewerItem(metaOnly = false) {
    const refs = state.viewerRefs
    if (!refs) return
    const currentId = state.viewerQueue[state.viewerIndex]?.id
    const previousIndex = state.viewerIndex
    state.viewerQueue = visibleStatusQueue(state.viewerQueue, monotonicNow())
    state.viewerIndex = state.viewerQueue.findIndex(status => status.id === currentId)
    if (state.viewerIndex < 0) state.viewerIndex = Math.min(previousIndex, state.viewerQueue.length - 1)
    if (!state.viewerQueue.length) {
      const hadViewerFocus = state.viewer?.contains(documentRef.activeElement)
      closeViewer()
      setStatus(`${state.viewerLabel} ya no tiene estados activos.`)
      if (hadViewerFocus) state.list?.focus?.()
      return
    }
    const status = state.viewerQueue[state.viewerIndex]
    if (metaOnly && status.id === currentId) {
      updateViewerMeta()
      return
    }
    clearMedia()
    refs.author.textContent = state.viewerLabel
    updateViewerMeta()
    const media = refs.media
    media.replaceChildren()
    if (status.kind === 'text') {
      const body = node('p', 'novedades-viewer-text')
      appendLinkedText(body, status.text || 'Sin texto')
      media.append(body)
    } else if (status.mediaUrl) {
      if (status.kind === 'image') {
        const image = documentRef.createElement('img')
        image.src = status.mediaUrl
        image.alt = 'Foto del estado'
        image.addEventListener('error', () => media.replaceChildren(node('p', 'novedades-media-error', 'No se pudo cargar este contenido.')))
        media.append(image)
      } else {
        const video = documentRef.createElement('video')
        video.setAttribute('src', status.mediaUrl)
        video.controls = true
        video.playsInline = true
        video.setAttribute('preload', 'metadata')
        video.setAttribute('aria-label', 'Vídeo del estado')
        media.append(video)
        video.play?.().catch(() => {})
      }
    } else {
      media.append(node('p', 'novedades-media-error', 'Este estado aún no tiene contenido sincronizado.'))
    }
    refs.previous.disabled = state.viewerIndex <= 0
    refs.next.disabled = state.viewerIndex >= state.viewerQueue.length - 1 && !state.viewerCursor
    refs.counter.textContent = `${state.viewerIndex + 1} de ${state.viewerQueue.length}`
  }

  function appendLinkedText(container, value) {
    for (const part of linkifyParts(value)) {
      if (part.link) {
        const anchor = documentRef.createElement('a')
        anchor.href = part.link.href
        anchor.rel = part.link.rel
        anchor.textContent = part.url
        container.append(anchor)
      } else {
        container.append(documentRef.createTextNode ? documentRef.createTextNode(part.text) : node('span', '', part.text))
      }
    }
  }

  async function stepViewer(delta) {
    const now = monotonicNow()
    let target = null
    for (let index = state.viewerIndex + delta; index >= 0 && index < state.viewerQueue.length; index += delta) {
      if (statusIsVisible(state.viewerQueue[index], now)) {
        target = state.viewerQueue[index]
        break
      }
    }
    if (target) {
      state.viewerIndex = state.viewerQueue.indexOf(target)
      showViewerItem()
      return
    }
    if (delta > 0 && state.viewerCursor) {
      if (!statusIsVisible(state.viewerQueue[state.viewerIndex], now)) {
        clearMedia()
        state.viewerRefs.media.replaceChildren()
      }
      await loadViewerNextPage()
      return
    }
    showViewerItem()
  }

  async function loadViewerNextPage() {
    if (state.viewerLoading || !state.viewerCursor) return
    const token = { generation: state.generation, account: state.account }
    const authorId = state.viewerAuthorId
    const cursor = state.viewerCursor
    state.viewerLoading = true
    try {
      const result = await loadStatuses(authorId, { cursor })
      if (!isCurrent(token) || state.viewerAuthorId !== authorId) return
      const fresh = visibleStatusQueue((Array.isArray(result?.items) ? result.items : [])
        .map(raw => normalizeNovedadesStatus(raw, token.account, baseUrl(), monotonicNow)), monotonicNow())
        .filter(status => !state.viewerIds.has(status.id))
      for (const status of fresh) state.viewerIds.add(status.id)
      state.viewerQueue = state.viewerQueue.concat(fresh)
      state.viewerCursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null
      if (!fresh.length) {
        state.viewerCursor = null
        showViewerItem()
        return
      }
      state.viewerIndex += 1
      showViewerItem()
    } catch {
      if (isCurrent(token)) setStatus('No se pudieron cargar más estados de este autor.', 'error')
    } finally {
      state.viewerLoading = false
    }
  }

  function closeViewer() {
    clearMedia()
    stopViewerTicker()
    state.viewer?.remove()
    state.viewer = null
    state.viewerRefs = null
    state.viewerQueue = []
    state.viewerIds = null
    state.viewerIndex = -1
    state.viewerCursor = null
    state.viewerAuthorId = ''
    state.panel?.classList.remove('novedades-viewing')
  }

  function closeViewerQuiet() {
    clearMedia()
    stopViewerTicker()
    state.viewer?.remove()
    state.viewer = null
    state.viewerRefs = null
    state.viewerQueue = []
    state.viewerIds = null
    state.viewerIndex = -1
    state.viewerCursor = null
    state.viewerAuthorId = ''
  }

  // ---------------------------------------------------------------- channels

  function renderChannelRows() {
    if (!state.list || state.tab !== 'channels') return
    const visible = filterChannels(state.channels, state.channelQuery)
    state.list.replaceChildren()
    if (state.lookupChannel) {
      const found = node('section', 'novedades-channel-found')
      found.append(node('strong', '', 'Resultado de WhatsApp'))
      const open = rowButton(state.lookupChannel.name, state.lookupChannel.description, () => openTimeline(state.lookupChannel), {
        avatarUrl: state.lookupChannel.avatarUrl, avatarName: state.lookupChannel.name,
      })
      open.setAttribute('aria-label', 'Abrir canal encontrado')
      const action = button('novedades-subscription', state.lookupChannel.subscribed ? 'Dejar de seguir' : 'Seguir canal')
      action.textContent = state.lookupChannel.subscribed ? 'Dejar de seguir' : 'Seguir canal'
      action.disabled = state.subscriptionPending || !changeChannelSubscription || !canPublish()
      action.onclick = () => void changeSubscription()
      found.append(open, action)
      state.list.append(found)
    }
    for (const channel of visible) {
      const detail = [
        channel.subscribers !== null ? `${channel.subscribers} ${channel.subscribers === 1 ? 'seguidor' : 'seguidores'}` : '',
        channel.verification === 'verified' ? 'Verificado' : '',
        dateLabel(channel.latestTimestamp),
      ].filter(Boolean).join(' · ')
      state.list.append(rowButton(channel.name, detail, () => openTimeline(channel), {
        avatarUrl: channel.avatarUrl,
        avatarName: channel.name,
      }))
    }
    if (!visible.length) {
      state.list.append(node('p', 'novedades-empty', state.channelQuery
        ? 'Ningún canal cargado coincide con esta búsqueda.'
        : 'Todavía no sigues ningún canal sincronizado en esta cuenta.'))
    }
    const total = state.channels.length
    setStatus(state.channelQuery && visible.length !== total
      ? `${visible.length} de ${total} ${total === 1 ? 'canal' : 'canales'}`
      : `${total} ${total === 1 ? 'canal' : 'canales'}`)
  }

  async function lookupCurrentChannel() {
    if (!lookupChannel || !state.channelQuery) return
    const token = { generation: state.generation, account: state.account }
    const query = state.channelQuery
    const request = ++state.lookupRequest
    state.lookupChannel = null
    setStatus('Consultando canal en WhatsApp…')
    try {
      const result = await lookupChannel(query)
      if (!isCurrent(token) || state.tab !== 'channels' || request !== state.lookupRequest || state.channelQuery !== query) return
      state.lookupChannel = normalizeNovedadesChannel(result?.channel, token.account, baseUrl())
      renderChannelRows()
      if (!state.lookupChannel) setStatus('No se encontró el canal.', 'error')
    } catch {
      if (isCurrent(token) && request === state.lookupRequest) setStatus('No se pudo consultar el canal.', 'error')
    }
  }

  async function changeSubscription() {
    const channel = state.lookupChannel
    if (!channel || state.subscriptionPending || !changeChannelSubscription) return
    const action = channel.subscribed ? 'unfollow' : 'follow'
    if (!windowRef.confirm(`¿${action === 'follow' ? 'Seguir' : 'Dejar de seguir'} el canal ${channel.name}?`)) return
    const token = { generation: state.generation, account: state.account }
    const serial = ++state.subscriptionSerial
    state.subscriptionPending = true
    renderChannelRows()
    try {
      const result = await changeChannelSubscription(channel.id, action)
      if (!isCurrent(token) || state.lookupChannel?.id !== channel.id) return
      if (result?.confirmed !== true || result.account !== token.account || result.channel?.id !== channel.id ||
          result.channel?.subscribed !== (action === 'follow')) throw new Error('unconfirmed')
      state.lookupChannel = normalizeNovedadesChannel(result.channel, token.account, baseUrl())
      setNotice(action === 'follow' ? 'Ahora sigues este canal.' : 'Has dejado de seguir este canal.')
    } catch {
      if (isCurrent(token)) state.notice = 'WhatsApp no confirmó el cambio. Consulta el canal antes de repetirlo.'
    } finally {
      if (serial === state.subscriptionSerial) state.subscriptionPending = false
      if (isCurrent(token) && serial === state.subscriptionSerial) {
        renderChannelRows()
        if (state.notice.startsWith('WhatsApp no confirmó')) {
          state.status.textContent = state.notice
          state.status.dataset.kind = 'error'
        }
      }
    }
  }

  async function renderChannelsTab() {
    const token = { generation: state.generation, account: state.account }
    const requestId = ++state.request
    state.panel?.setAttribute('aria-busy', 'true')
    state.channelsLoading = true
    try {
      const result = await loadChannels({ cursor: null })
      if (!isCurrent(token) || requestId !== state.request || state.tab !== 'channels') return
      state.channels = (Array.isArray(result?.channels) ? result.channels : [])
        .map(raw => normalizeNovedadesChannel(raw, token.account, baseUrl()))
        .filter(Boolean)
      state.channelsCursor = result?.hasMore === true && typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null
      renderChannelRows()
      state.channelsMore.hidden = !state.channelsCursor
    } catch {
      if (!isCurrent(token) || requestId !== state.request) return
      errorPane('No se pudieron cargar los canales. Comprueba la conexión del conector.', renderChannelsTab)
      state.channelsMore.hidden = true
    } finally {
      state.channelsLoading = false
      if (isCurrent(token) && requestId === state.request) state.panel?.setAttribute('aria-busy', 'false')
    }
  }

  async function loadChannelsMore() {
    if (!state.channelsCursor || state.channelsLoading) return
    const token = { generation: state.generation, account: state.account }
    state.channelsLoading = true
    state.channelsMore.disabled = true
    try {
      const result = await loadChannels({ cursor: state.channelsCursor })
      if (!isCurrent(token) || state.tab !== 'channels') return
      const fresh = (Array.isArray(result?.channels) ? result.channels : [])
        .map(raw => normalizeNovedadesChannel(raw, token.account, baseUrl()))
        .filter(Boolean)
      const known = new Set(state.channels.map(channel => channel.id))
      state.channels = state.channels.concat(fresh.filter(channel => !known.has(channel.id)))
      state.channelsCursor = result?.hasMore === true && typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null
      renderChannelRows()
      state.channelsMore.hidden = !state.channelsCursor
    } catch {
      if (isCurrent(token)) setStatus('No se pudieron cargar más canales.', 'error')
    } finally {
      state.channelsLoading = false
      state.channelsMore.disabled = false
    }
  }

  function openTimeline(channel) {
    if (state.publishing) return
    closeViewerQuiet()
    closeTimelineQuiet()
    closeComposer({ restoreFocus: false })
    state.timelineChannel = channel
    state.timelineCursor = null
    const view = node('div', 'novedades-viewer novedades-timeline')
    view.setAttribute('role', 'region')
    view.setAttribute('aria-label', `Publicaciones de ${channel.name}`)
    const header = node('header', 'novedades-viewer-header')
    const back = button('novedades-back', 'Volver a la lista de canales')
    back.append(node('span', '', '←'))
    back.onclick = closeTimeline
    const identity = node('div', 'novedades-viewer-identity')
    identity.append(
      node('strong', 'novedades-viewer-author', channel.name),
      node('span', 'novedades-viewer-meta', channel.subscribers !== null ? `${channel.subscribers} ${channel.subscribers === 1 ? 'seguidor' : 'seguidores'}` : ''),
    )
    header.append(back, identity)
    const list = node('div', 'novedades-post-list')
    list.setAttribute('aria-live', 'polite')
    const more = button('novedades-more', 'Cargar más publicaciones')
    more.textContent = 'Cargar más publicaciones'
    more.hidden = true
    more.onclick = () => void loadTimelinePage()
    view.append(header, list, more)
    state.panel.classList.add('novedades-viewing')
    state.panel.append(view)
    state.timeline = view
    state.timelineRefs = { list, more }
    void loadTimelinePage(true)
  }

  async function loadTimelinePage(replace) {
    if (!state.timelineChannel || state.timelineLoading) return
    const token = { generation: state.generation, account: state.account }
    const request = state.timelineRequest
    const channel = state.timelineChannel
    const cursor = replace ? null : state.timelineCursor
    state.timelineLoading = true
    try {
      const result = await loadPosts(channel.id, { cursor })
      if (!isCurrent(token) || request !== state.timelineRequest || state.timelineChannel?.id !== channel.id) return
      const posts = (Array.isArray(result?.items) ? result.items : [])
        .map(raw => normalizeNovedadesPost(raw, token.account, baseUrl()))
        .filter(Boolean)
      if (replace) state.timelineRefs.list.replaceChildren()
      for (const post of posts) state.timelineRefs.list.append(postNode(post, channel))
      state.timelineCursor = result?.hasMore === true && typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null
      state.timelineRefs.more.hidden = !state.timelineCursor
      if (replace && !posts.length) state.timelineRefs.list.append(node('p', 'novedades-empty', 'Este canal todavía no tiene publicaciones sincronizadas.'))
    } catch {
      if (!isCurrent(token) || request !== state.timelineRequest || state.timelineChannel?.id !== channel.id) return
      if (state.timelineRefs) state.timelineRefs.list.replaceChildren(node('p', 'novedades-empty', 'No se pudieron cargar las publicaciones de este canal.'))
      if (state.timelineRefs) state.timelineRefs.more.hidden = true
    } finally {
      if (request === state.timelineRequest) state.timelineLoading = false
    }
  }

  function postNode(post, channel) {
    const article = node('article', 'novedades-post')
    const head = node('header', 'novedades-post-head')
    head.append(
      avatarNode(channel.avatarUrl, channel.name),
      node('strong', '', channel.name),
      node('time', '', dateLabel(post.timestamp) || 'Fecha desconocida'),
    )
    article.append(head)
    if (post.text) {
      const body = node('p', 'novedades-post-text')
      appendLinkedText(body, post.text)
      article.append(body)
    }
    if (post.mediaUrl) {
      if (post.kind === 'image') {
        const image = documentRef.createElement('img')
        image.src = post.mediaUrl
        image.alt = 'Imagen de la publicación'
        image.loading = 'lazy'
        image.addEventListener('error', () => image.replaceWith?.(node('p', 'novedades-media-error', 'No se pudo cargar esta imagen.')))
        article.append(image)
      } else {
        const video = documentRef.createElement('video')
        video.setAttribute('src', post.mediaUrl)
        video.controls = true
        video.playsInline = true
        video.setAttribute('preload', 'metadata')
        video.setAttribute('aria-label', 'Vídeo de la publicación')
        article.append(video)
      }
    }
    return article
  }

  function closeTimeline() {
    state.timelineRequest += 1
    state.timelineLoading = false
    state.timeline?.remove()
    state.timeline = null
    state.timelineRefs = null
    state.timelineChannel = null
    state.timelineCursor = null
    state.panel?.classList.remove('novedades-viewing')
  }

  function closeTimelineQuiet() {
    state.timelineRequest += 1
    state.timelineLoading = false
    state.timeline?.remove()
    state.timeline = null
    state.timelineRefs = null
    state.timelineChannel = null
    state.timelineCursor = null
  }

  // ------------------------------------------------------------- composer
  //
  // Publishing keeps its own view so the list of states stays where it was, and
  // keeps its own token: an account switch or a closed panel invalidates every
  // in-flight contact page and every pending publish, so a late answer can
  // never clear a draft that no longer belongs to the account on screen.

  const emptyDraft = () => ({ type: 'text', text: '', media: null, backgroundColor: STATUS_COLORS[0].id, font: 1, recipients: [] })

  function publishAllowed() {
    if (typeof publishStatus !== 'function') return false
    try {
      return canPublish() !== false
    } catch {
      return false
    }
  }

  function composerToken() {
    return { generation: state.generation, account: state.account, composerId: state.composerId }
  }

  function composerIsCurrent(token) {
    return isCurrent(token) && state.composerId === token.composerId && Boolean(state.composer)
  }

  function renderComposeAvailability() {
    if (!state.composeRow) return
    state.composeRow.hidden = state.tab !== 'statuses' || !publishAllowed()
    if (!publishAllowed() && state.composer) closeComposer({ restoreFocus: false })
    renderFooterState()
  }

  function clearAudienceTimer() {
    if (!state.audience.timer) return
    ;(windowRef?.clearTimeout || globalThis.clearTimeout)(state.audience.timer)
    state.audience.timer = null
  }

  function revokeObjectUrl() {
    const revoke = windowRef?.URL?.revokeObjectURL || globalThis.URL?.revokeObjectURL
    if (state.objectUrl && revoke) revoke.call(windowRef?.URL || globalThis.URL, state.objectUrl)
    state.objectUrl = ''
  }

  function showComposerError(message = '', field = '') {
    const refs = state.composerRefs
    if (!refs) return
    refs.error.textContent = message
    refs.error.dataset.kind = message ? 'error' : 'info'
    if (message && field) refs.fields?.[field]?.focus?.()
  }

  function renderFooterState() {
    const refs = state.composerRefs
    if (!refs) return
    refs.review.disabled = state.publishing || !publishAllowed()
    refs.review.textContent = state.publishing ? 'Enviando estado…' : 'Revisar y enviar'
    refs.composer.setAttribute('aria-busy', String(state.publishing))
    // Leaving mid-send hides the answer without erasing the send, so the exit
    // controls are held closed until the outcome, settled or not, is on screen.
    for (const control of [refs.back, refs.discard]) {
      if (!control) continue
      control.disabled = state.publishing
      control.setAttribute('aria-disabled', String(state.publishing))
    }
  }

  function composerChrome() {
    if (state.composer) return state.composer
    const refs = { typeInputs: {}, colorInputs: {}, fontInputs: {}, fields: {} }
    const composer = node('div', 'novedades-composer')
    composer.setAttribute('role', 'region')
    composer.setAttribute('aria-label', 'Publicar un estado')

    const header = node('header', 'novedades-composer-header')
    const back = button('novedades-back', 'Volver a la lista de estados sin publicar')
    back.append(node('span', '', '←'))
    back.onclick = () => closeComposer({ restoreFocus: true })
    const title = node('h3', 'novedades-composer-title', 'Publicar estado')
    const discard = button('novedades-composer-discard', 'Descartar el borrador')
    discard.textContent = '×'
    // The refusal has to come first: discarding before a refused close would
    // empty a draft that the owner still needs while the send is undecided.
    discard.onclick = () => { if (closeComposer({ restoreFocus: true })) discardDraft() }
    header.append(back, title, discard)

    const body = node('div', 'novedades-composer-body')

    const typeField = node('div', 'novedades-field novedades-type')
    typeField.setAttribute('role', 'radiogroup')
    typeField.setAttribute('aria-label', 'Tipo de estado')
    for (const [value, label] of [['text', 'Texto'], ['image', 'Imagen'], ['video', 'Vídeo']]) {
      const option = documentRef.createElement('label')
      option.className = 'novedades-type-option'
      const input = documentRef.createElement('input')
      input.type = 'radio'
      input.name = 'novedades-status-type'
      input.value = value
      input.addEventListener('change', () => { if (input.checked) selectType(value) })
      option.append(input, node('span', '', label))
      refs.typeInputs[value] = input
      typeField.append(option)
    }

    const preview = node('div', 'novedades-preview')
    preview.setAttribute('aria-hidden', 'true')
    const previewText = node('p', 'novedades-preview-text', 'Vista previa')
    const previewImage = documentRef.createElement('img')
    previewImage.alt = 'Vista previa de la imagen elegida'
    previewImage.hidden = true
    const previewVideo = documentRef.createElement('video')
    previewVideo.controls = true
    previewVideo.playsInline = true
    previewVideo.setAttribute('preload', 'metadata')
    previewVideo.setAttribute('aria-label', 'Vista previa del vídeo elegido')
    previewVideo.hidden = true
    preview.append(previewText, previewImage, previewVideo)

    const mediaBlock = node('div', 'novedades-field novedades-media-block')
    const mediaLabel = node('span', 'novedades-field-label', 'Imagen del estado')
    const drop = node('div', 'novedades-drop')
    const choose = button('novedades-choose', 'Elegir un archivo del dispositivo')
    choose.textContent = 'Elegir archivo'
    choose.onclick = () => fileInput.click?.()
    const fileHint = node('p', 'novedades-file-hint', statusFormatHint('image'))
    const fileInput = documentRef.createElement('input')
    fileInput.type = 'file'
    fileInput.className = 'novedades-composer-file'
    fileInput.accept = STATUS_IMAGE_MIME_TYPES.join(',')
    fileInput.setAttribute('aria-label', 'Archivo del estado')
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0]
      fileInput.value = ''
      if (file) void pickMedia(file)
    })
    const removeMediaButton = button('novedades-media-remove', 'Quitar el archivo elegido')
    removeMediaButton.textContent = 'Quitar archivo'
    removeMediaButton.hidden = true
    removeMediaButton.onclick = () => removeMedia()
    drop.addEventListener('dragover', event => { event.preventDefault(); drop.classList.add('is-over') })
    drop.addEventListener('dragleave', () => drop.classList.remove('is-over'))
    drop.addEventListener('drop', event => {
      event.preventDefault()
      drop.classList.remove('is-over')
      const file = event.dataTransfer?.files?.[0]
      if (file) void pickMedia(file)
    })
    drop.append(choose, fileHint, fileInput, removeMediaButton)
    mediaBlock.append(mediaLabel, drop)

    const textField = node('div', 'novedades-field')
    const textLabel = node('label', 'novedades-field-label', 'Texto del estado')
    textLabel.htmlFor = 'novedades-status-text'
    const textarea = documentRef.createElement('textarea')
    textarea.id = 'novedades-status-text'
    textarea.className = 'novedades-composer-text'
    textarea.rows = 3
    textarea.maxLength = STATUS_TEXT_MAX
    textarea.placeholder = 'Escribe lo que quieres contar'
    textarea.addEventListener('input', () => {
      state.draft.text = textarea.value
      renderPreview()
      renderCounter()
      showComposerError('')
    })
    const counter = node('span', 'novedades-text-counter', `0/${STATUS_TEXT_MAX}`)
    textLabel.id = 'novedades-status-text-label'
    textarea.setAttribute('aria-describedby', 'novedades-status-text-counter')
    counter.id = 'novedades-status-text-counter'
    textField.append(textLabel, textarea, counter)

    const styleBlock = node('div', 'novedades-style-block')
    const colorField = node('div', 'novedades-field')
    const colorLabel = node('span', 'novedades-field-label', 'Color de fondo')
    colorLabel.id = 'novedades-color-label'
    const colors = node('div', 'novedades-swatches')
    colors.setAttribute('role', 'radiogroup')
    colors.setAttribute('aria-labelledby', 'novedades-color-label')
    for (const color of STATUS_COLORS) {
      const option = documentRef.createElement('label')
      option.className = 'novedades-swatch'
      const input = documentRef.createElement('input')
      input.type = 'radio'
      input.name = 'novedades-status-color'
      input.value = color.id
      input.setAttribute('aria-label', color.label)
      input.addEventListener('change', () => {
        if (!input.checked) return
        state.draft.backgroundColor = color.id
        renderPreview()
      })
      const chip = node('span', 'novedades-swatch-color')
      chip.style.background = color.hex
      option.append(input, chip)
      refs.colorInputs[color.id] = input
      colors.append(option)
    }
    colorField.append(colorLabel, colors)

    const fontField = node('div', 'novedades-field')
    const fontLabel = node('span', 'novedades-field-label', 'Fuente')
    fontLabel.id = 'novedades-font-label'
    const fonts = node('div', 'novedades-fonts')
    fonts.setAttribute('role', 'radiogroup')
    fonts.setAttribute('aria-labelledby', 'novedades-font-label')
    for (const fontOption of STATUS_FONTS) {
      const option = documentRef.createElement('label')
      option.className = 'novedades-font-option'
      const input = documentRef.createElement('input')
      input.type = 'radio'
      input.name = 'novedades-status-font'
      input.value = String(fontOption.id)
      input.setAttribute('aria-label', `Fuente ${fontOption.id}`)
      input.addEventListener('change', () => {
        if (!input.checked) return
        state.draft.font = fontOption.id
        renderPreview()
      })
      const sample = node('span', 'novedades-font-sample', 'Aa')
      sample.style.fontFamily = fontOption.css
      sample.style.fontWeight = String(fontOption.weight)
      sample.style.fontStyle = fontOption.style
      option.append(input, sample)
      refs.fontInputs[fontOption.id] = input
      fonts.append(option)
    }
    fontField.append(fontLabel, fonts)
    styleBlock.append(colorField, fontField)

    const audience = node('div', 'novedades-field novedades-audience')
    const audienceLabel = node('span', 'novedades-field-label', 'Destinatarios')
    // The composer chooses the recipient list, nothing more: whether a contact
    // actually sees the status is WhatsApp's call through its own privacy
    // settings, so the note must not read as a promise of delivery.
    const audienceNote = node('p', 'novedades-audience-note', 'Tú marcas a quién se lo envías. Quién llega a verlo depende del ajuste de privacidad de cada contacto en WhatsApp.')
    const chips = node('div', 'novedades-chips')
    chips.setAttribute('aria-label', 'Destinatarios elegidos')
    chips.setAttribute('aria-live', 'polite')
    const search = documentRef.createElement('input')
    search.type = 'search'
    search.className = 'novedades-audience-search'
    search.autocomplete = 'off'
    search.placeholder = 'Buscar por nombre o número'
    search.setAttribute('aria-label', 'Buscar contactos para el estado')
    search.addEventListener('input', () => queueAudienceSearch(search.value))
    const results = node('div', 'novedades-audience-results')
    results.setAttribute('role', 'group')
    results.setAttribute('aria-label', 'Contactos sincronizados')
    const more = button('novedades-more novedades-audience-more', 'Cargar más contactos')
    more.textContent = 'Cargar más contactos'
    more.hidden = true
    more.onclick = () => void loadAudience()
    const audienceCount = node('p', 'novedades-audience-count')
    audienceCount.setAttribute('role', 'status')
    audience.append(audienceLabel, audienceNote, chips, search, results, more, audienceCount)

    body.append(typeField, preview, mediaBlock, textField, styleBlock, audience)

    const footer = node('footer', 'novedades-composer-footer')
    const error = node('p', 'novedades-composer-error')
    error.setAttribute('role', 'alert')
    error.dataset.kind = 'info'
    const review = button('novedades-primary novedades-review', 'Revisar los destinatarios antes de enviar')
    review.textContent = 'Revisar y enviar'
    review.onclick = () => openConfirm()
    footer.append(error, review)

    composer.append(header, body, footer)
    refs.composer = composer
    refs.back = back
    refs.discard = discard
    refs.textarea = textarea
    refs.counter = counter
    refs.textLabel = textLabel
    refs.mediaBlock = mediaBlock
    refs.mediaLabel = mediaLabel
    refs.fileInput = fileInput
    refs.fileHint = fileHint
    refs.choose = choose
    refs.removeMediaButton = removeMediaButton
    refs.styleBlock = styleBlock
    refs.preview = preview
    refs.previewText = previewText
    refs.previewImage = previewImage
    refs.previewVideo = previewVideo
    refs.chips = chips
    refs.search = search
    refs.results = results
    refs.more = more
    refs.audienceCount = audienceCount
    refs.error = error
    refs.review = review
    refs.fields = { text: textarea, media: fileInput, recipients: search }
    state.composer = composer
    state.composerRefs = refs
    return composer
  }

  function openComposer() {
    if (state.composer) return
    if (!publishAllowed()) {
      setStatus('La publicación de estados está desactivada en el servidor.', 'error')
      return
    }
    closeViewerQuiet()
    closeTimelineQuiet()
    state.notice = ''
    state.draft ||= emptyDraft()
    state.composerSerial += 1
    state.composerId = state.composerSerial
    const composer = composerChrome()
    if (!composer.parentNode) state.panel.append(composer)
    state.panel.classList.add('novedades-composing')
    syncDraftToControls()
    void loadAudience({ replace: true })
    queueMicrotask(() => {
      const refs = state.composerRefs
      if (!refs) return
      ;(state.draft.type === 'text' ? refs.textarea : refs.choose).focus?.()
    })
  }

  function removeComposerElement() {
    closeConfirmDialog()
    clearAudienceTimer()
    state.audience.serial += 1
    state.audience.loading = false
    state.composer?.remove()
    state.composer = null
    state.composerRefs = null
  }

  /**
   * Closes the editor and reports whether it actually closed. While a send is
   * in flight it refuses, because the answer belongs to the composer that is on
   * screen: closing it there would leave the owner with no record of a status
   * that may already be with the audience.
   */
  function closeComposer({ restoreFocus = true } = {}) {
    if (!state.composer) return false
    if (state.publishing) return false
    removeComposerElement()
    state.panel?.classList.remove('novedades-composing')
    if (restoreFocus && state.composeButton?.isConnected !== false) state.composeButton.focus?.()
    return true
  }

  function closeComposerQuiet() {
    if (state.composer) removeComposerElement()
  }

  function discardDraft() {
    state.draft = emptyDraft()
    state.recipients.clear()
    revokeObjectUrl()
    state.audience.query = ''
    state.audience.error = ''
    if (state.composerRefs) {
      state.composerRefs.search.value = ''
      syncDraftToControls()
      renderChips()
      showComposerError('')
    }
  }

  function syncDraftToControls() {
    const refs = state.composerRefs
    const draft = state.draft
    if (!refs || !draft) return
    for (const [type, input] of Object.entries(refs.typeInputs)) input.checked = type === draft.type
    for (const [id, input] of Object.entries(refs.colorInputs)) input.checked = id === draft.backgroundColor
    for (const [id, input] of Object.entries(refs.fontInputs)) input.checked = Number(id) === statusFontId(draft.font)
    refs.textarea.value = draft.text
    refs.textarea.maxLength = statusTextLimit(draft.type)
    refs.textLabel.textContent = draft.type === 'text' ? 'Texto del estado' : 'Texto sobre el contenido (opcional)'
    refs.mediaLabel.textContent = draft.type === 'video' ? 'Vídeo del estado' : 'Imagen del estado'
    refs.fileHint.textContent = statusFormatHint(draft.type)
    refs.fileInput.accept = (draft.type === 'video' ? STATUS_VIDEO_MIME_TYPES : STATUS_IMAGE_MIME_TYPES).join(',')
    renderPreview()
    renderCounter()
    renderAudience()
    renderChips()
    renderFooterState()
  }

  function renderCounter() {
    const refs = state.composerRefs
    const draft = state.draft
    if (!refs || !draft) return
    refs.counter.textContent = `${draft.text.length}/${statusTextLimit(draft.type)}`
  }

  function renderPreview() {
    const refs = state.composerRefs
    const draft = state.draft
    if (!refs || !draft) return
    const isText = draft.type === 'text'
    refs.styleBlock.hidden = !isText
    refs.mediaBlock.hidden = isText
    const hasPreview = Boolean(draft.media && state.objectUrl)
    refs.previewText.hidden = !isText
    refs.previewImage.hidden = !(hasPreview && draft.type === 'image')
    refs.previewVideo.hidden = !(hasPreview && draft.type === 'video')
    if (isText) {
      refs.previewText.textContent = draft.text || 'Vista previa'
      refs.previewText.style.background = statusColorHex(draft.backgroundColor)
      const face = STATUS_FONTS.find(item => item.id === statusFontId(draft.font)) || STATUS_FONTS[0]
      refs.previewText.style.fontFamily = face.css
      refs.previewText.style.fontWeight = String(face.weight)
      refs.previewText.style.fontStyle = face.style
    }
    refs.removeMediaButton.hidden = !draft.media
  }

  function selectType(type) {
    const draft = state.draft
    if (!draft || draft.type === type) return
    draft.type = type
    let note = ''
    if (draft.media && statusMediaError(draft.media, type)) {
      note = 'El archivo elegido no sirve para este tipo de estado: vuelve a elegir uno.'
      removeMedia({ keepNote: true })
    }
    syncDraftToControls()
    showComposerError(note)
  }

  async function pickMedia(file) {
    const refs = state.composerRefs
    const draft = state.draft
    if (!refs || !draft || !file) return
    const problem = statusMediaError({ name: file.name, size: file.size, type: file.type }, draft.type)
    if (problem) {
      showComposerError(problem, 'media')
      return
    }
    const urlFactory = windowRef?.URL || globalThis.URL
    revokeObjectUrl()
    draft.media = { file, name: file.name, size: file.size, type: file.type }
    state.objectUrl = urlFactory?.createObjectURL ? urlFactory.createObjectURL(file) : ''
    if (state.objectUrl) {
      if (draft.type === 'image') refs.previewImage.setAttribute('src', state.objectUrl)
      else refs.previewVideo.setAttribute('src', state.objectUrl)
    }
    showComposerError('')
    renderPreview()
  }

  function removeMedia({ keepNote = false } = {}) {
    const draft = state.draft
    const refs = state.composerRefs
    if (!draft) return
    draft.media = null
    revokeObjectUrl()
    if (refs) {
      refs.previewImage.removeAttribute('src')
      refs.previewVideo.removeAttribute('src')
      refs.fileInput.value = ''
      if (!keepNote) showComposerError('')
      renderPreview()
    }
  }

  function queueAudienceSearch(value) {
    const audienceState = state.audience
    audienceState.query = text(value)
    clearAudienceTimer()
    const schedule = windowRef?.setTimeout || globalThis.setTimeout
    audienceState.timer = schedule(() => {
      audienceState.timer = null
      void loadAudience({ replace: true })
    }, 250)
  }

  function renderAudienceMore() {
    const refs = state.composerRefs
    if (!refs) return
    refs.more.hidden = !state.audience.cursor || state.audience.loading
    refs.more.disabled = state.audience.loading
  }

  async function loadAudience({ replace = false } = {}) {
    const refs = state.composerRefs
    if (!refs) return
    const audienceState = state.audience
    const token = composerToken()
    const serial = ++audienceState.serial
    const cursor = replace ? null : audienceState.cursor
    audienceState.loading = true
    audienceState.error = ''
    refs.results.setAttribute('aria-busy', 'true')
    renderAudienceMore()
    try {
      const result = await loadContacts({ q: audienceState.query, cursor })
      if (!composerIsCurrent(token) || serial !== audienceState.serial) return
      const items = (Array.isArray(result?.contacts) ? result.contacts : [])
        .map(raw => normalizeStatusContact(raw, { account: token.account, baseUrl: baseUrl() }))
        .filter(Boolean)
      const merged = replace ? [] : audienceState.items.slice()
      const seen = new Set(merged.map(item => item.key))
      for (const item of items) {
        if (seen.has(item.key)) continue
        seen.add(item.key)
        merged.push(item)
      }
      audienceState.items = merged
      audienceState.cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null
    } catch {
      if (composerIsCurrent(token) && serial === audienceState.serial) {
        audienceState.error = 'No se pudieron cargar los contactos. Comprueba la conexión del conector.'
      }
    } finally {
      if (composerIsCurrent(token) && serial === audienceState.serial) {
        audienceState.loading = false
        refs.results.removeAttribute('aria-busy')
        renderAudience()
        renderAudienceMore()
      }
    }
  }

  function audienceRow(entry) {
    const option = documentRef.createElement('label')
    option.className = 'novedades-audience-row'
    // A greyed-out checkbox alone does not say why the row cannot be chosen, and
    // the label still forwards clicks to it; the disabled state belongs on the
    // row so the styling and the announcement agree with the reason below it.
    if (!entry.addressable) {
      option.classList.add('is-disabled')
      option.setAttribute('aria-disabled', 'true')
    }
    const checkbox = documentRef.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.checked = Boolean(entry.jid) && state.recipients.has(entry.jid)
    checkbox.disabled = !entry.addressable
    checkbox.setAttribute('aria-disabled', String(!entry.addressable))
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) addRecipient(entry)
      else removeRecipient(entry.jid)
    })
    const copy = node('span', 'novedades-copy')
    copy.append(node('strong', '', entry.label))
    copy.append(node('span', 'novedades-detail', entry.addressable ? entry.hint : entry.reason))
    option.append(checkbox, avatarNode(entry.avatarUrl, entry.label), copy)
    return option
  }

  function renderAudience() {
    const refs = state.composerRefs
    if (!refs) return
    const audienceState = state.audience
    refs.results.replaceChildren()
    if (audienceState.error) {
      const box = node('div', 'novedades-empty')
      box.append(node('p', '', audienceState.error))
      const again = button('novedades-retry', 'Volver a cargar los contactos')
      again.textContent = 'Reintentar'
      again.onclick = () => void loadAudience({ replace: true })
      box.append(again)
      refs.results.append(box)
    } else if (!audienceState.items.length) {
      refs.results.append(node('p', 'novedades-empty', audienceState.query
        ? 'Ningún contacto sincronizado coincide con esta búsqueda.'
        : 'Todavía no hay contactos sincronizados en esta cuenta.'))
    } else {
      for (const entry of audienceState.items) refs.results.append(audienceRow(entry))
    }
    renderAudienceCount()
  }

  function renderAudienceCount() {
    const refs = state.composerRefs
    if (!refs) return
    const chosen = state.recipients.size
    const loaded = state.audience.items.length
    refs.audienceCount.textContent = `${chosen} ${chosen === 1 ? 'destinatario elegido' : 'destinatarios elegidos'} · ${loaded} ${loaded === 1 ? 'contacto disponible' : 'contactos disponibles'}`
  }

  function renderChips() {
    const refs = state.composerRefs
    if (!refs) return
    refs.chips.replaceChildren()
    const entries = [...state.recipients.values()]
    if (!entries.length) {
      refs.chips.append(node('span', 'novedades-chip-empty', 'Sin destinatarios: el estado no se enviará a nadie hasta que elijas uno.'))
    }
    for (const entry of entries) {
      const chip = node('span', 'novedades-chip')
      chip.append(node('span', 'novedades-chip-label', entry.hint ? `${entry.label} · ${entry.hint}` : entry.label))
      const removeChip = button('novedades-chip-remove', `Quitar a ${entry.label} de los destinatarios`)
      removeChip.textContent = '×'
      removeChip.onclick = () => removeRecipient(entry.jid)
      chip.append(removeChip)
      refs.chips.append(chip)
    }
    renderAudienceCount()
  }

  function addRecipient(entry) {
    if (!entry?.jid || state.recipients.has(entry.jid)) return
    if (state.recipients.size >= STATUS_RECIPIENTS_MAX) {
      showComposerError(`Máximo ${STATUS_RECIPIENTS_MAX} destinatarios por estado.`, 'recipients')
      renderAudience()
      return
    }
    state.recipients.set(entry.jid, { jid: entry.jid, label: entry.label, hint: entry.hint, key: entry.key })
    state.draft.recipients = [...state.recipients.keys()]
    showComposerError('')
    renderChips()
  }

  function removeRecipient(jid) {
    if (!state.recipients.delete(jid)) return
    state.draft.recipients = [...state.recipients.keys()]
    renderChips()
    renderAudience()
  }

  function contentSummaryLine() {
    const draft = state.draft
    if (!draft) return ''
    if (draft.type === 'text') {
      const body = text(draft.text)
      return `Texto: ${body.length > 90 ? `${body.slice(0, 90)}…` : body}`
    }
    const label = draft.type === 'video' ? 'Vídeo' : 'Imagen'
    const size = mebibytes(Number(draft.media?.size) || 0)
    return `${label}: ${draft.media?.name || 'sin archivo'} (${size})${text(draft.text) ? ' · con texto' : ''}`
  }

  function openConfirm() {
    const refs = state.composerRefs
    if (!refs || state.confirm || state.publishing) return
    if (!publishAllowed()) {
      showComposerError('La publicación de estados está desactivada en el servidor.')
      return
    }
    const problem = validateStatusDraft(state.draft)
    if (problem) {
      showComposerError(problem.message, problem.field)
      return
    }
    showComposerError('')
    const summary = statusAudienceSummary([...state.recipients.values()], 8)
    const overlay = node('div', 'novedades-confirm')
    const dialog = node('div', 'novedades-confirm-dialog')
    dialog.setAttribute('role', 'alertdialog')
    dialog.setAttribute('aria-modal', 'true')
    dialog.setAttribute('aria-labelledby', 'novedades-confirm-title')
    const title = node('h4', 'novedades-confirm-title', 'Confirmar destinatarios')
    title.id = 'novedades-confirm-title'
    const count = node('p', 'novedades-confirm-count', `Vas a enviar el estado a ${summary.total} ${summary.total === 1 ? 'contacto' : 'contactos'}:`)
    const list = node('ul', 'novedades-confirm-list')
    for (const line of summary.lines) list.append(node('li', '', line.hint ? `${line.label} · ${line.hint}` : line.label))
    const extras = node('p', 'novedades-confirm-hidden', summary.hidden > 0 ? `y ${summary.hidden} ${summary.hidden === 1 ? 'destinatario más' : 'destinatarios más'}` : '')
    const content = node('p', 'novedades-confirm-content', contentSummaryLine())
    const note = node('p', 'novedades-confirm-note', 'Revisa la lista: un estado publicado no se puede retirar, y WhatsApp decide quién lo ve según el ajuste de privacidad de cada contacto.')
    const actions = node('div', 'novedades-confirm-actions')
    const back = button('novedades-confirm-back', 'Volver al editor para revisar los destinatarios')
    back.textContent = 'Revisar destinatarios'
    back.onclick = () => closeConfirmDialog({ restoreFocus: true })
    const send = button('novedades-confirm-send', `Enviar el estado a ${summary.total} ${summary.total === 1 ? 'contacto' : 'contactos'}`)
    send.textContent = `Enviar a ${summary.total} ${summary.total === 1 ? 'contacto' : 'contactos'}`
    send.onclick = () => void publishConfirmed()
    actions.append(back, send)
    dialog.append(title, count, list)
    if (summary.hidden > 0) dialog.append(extras)
    dialog.append(content, note, actions)
    overlay.append(dialog)
    overlay.addEventListener('keydown', onConfirmKeydown)
    refs.composer.append(overlay)
    state.confirm = overlay
    state.confirmRefs = { dialog, back, send }
    queueMicrotask(() => send.focus?.())
  }

  function onConfirmKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeConfirmDialog({ restoreFocus: true })
      return
    }
    if (event.key !== 'Tab') return
    const controls = [state.confirmRefs?.back, state.confirmRefs?.send].filter(item => item && !item.disabled)
    if (!controls.length) return
    const index = controls.indexOf(documentRef.activeElement)
    if (index < 0 || (event.shiftKey && index === 0) || (!event.shiftKey && index === controls.length - 1)) {
      event.preventDefault()
      event.stopPropagation()
      ;(event.shiftKey ? controls.at(-1) : controls[0]).focus()
    }
  }

  function closeConfirmDialog({ restoreFocus = false } = {}) {
    if (!state.confirm) return
    const target = state.confirmRefs?.back
    state.confirm.remove()
    state.confirm = null
    state.confirmRefs = null
    if (restoreFocus && target?.isConnected) target.focus?.()
  }

  async function readMediaBase64(media) {
    if (!media) return ''
    if (media.base64) return media.base64
    const file = media.file
    if (!file?.arrayBuffer) return ''
    const bytes = new Uint8Array(await file.arrayBuffer())
    let binary = ''
    const chunk = 0x8000
    for (let offset = 0; offset < bytes.length; offset += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunk))
    }
    const toBase64 = windowRef?.btoa || globalThis.btoa
    return toBase64 ? toBase64(binary) : ''
  }

  async function publishConfirmed() {
    const refs = state.composerRefs
    if (!refs || state.publishing) return
    if (!publishAllowed()) {
      closeConfirmDialog({ restoreFocus: true })
      showComposerError('La publicación de estados está desactivada en el servidor.')
      return
    }
    const problem = validateStatusDraft(state.draft)
    if (problem) {
      closeConfirmDialog({ restoreFocus: true })
      showComposerError(problem.message, problem.field)
      return
    }
    const token = composerToken()
    const accountUsed = token.account
    state.publishing = true
    renderFooterState()
    if (state.confirmRefs) {
      state.confirmRefs.send.disabled = true
      state.confirmRefs.back.disabled = true
    }
    let payload = null
    let failure = null
    let outcome = 'sent'
    try {
      const media = state.draft.media ? { ...state.draft.media, base64: await readMediaBase64(state.draft.media) } : null
      payload = statusPayload({ ...state.draft, media, recipients: [...state.recipients.keys()] })
      if (!payload) throw new Error('El archivo todavía no se pudo leer entero.')
    } catch (error) {
      failure = error
    }
    if (!failure) {
      try {
        outcome = statusSendOutcome(await publishStatus(payload), accountUsed)
      } catch (error) {
        failure = error
      }
    }
    state.publishing = false
    if (!composerIsCurrent(token)) {
      // The panel closed or the account changed mid-request: whatever arrives
      // now belongs to a view that is gone, and the draft on screen stays.
      if (!failure && outcome === 'sent') setNotice(`El estado se publicó desde la cuenta ${accountUsed || 'anterior'}.`)
      else setStatus(`El estado iniciado desde ${accountUsed || 'la cuenta anterior'} no se pudo confirmar.`, 'error')
      return
    }
    renderFooterState()
    if (!failure && outcome === 'sent') {
      closeComposer({ restoreFocus: true })
      discardDraft()
      setNotice('Estado publicado.')
      void renderStatusesTab()
      return
    }
    closeConfirmDialog({ restoreFocus: true })
    if (failure) {
      const message = failureMessage(failure) || 'No se publicó el estado.'
      showComposerError(statusFailureIsUncertain(failure)
        ? `${message} El estado puede haberse publicado igualmente: comprueba la lista antes de reintentar.`
        : message, 'recipients')
      return
    }
    showComposerError(outcome === 'stale'
      ? 'La confirmación llegó de otra cuenta: el borrador se mantiene intacto.'
      : 'WhatsApp no confirmó la entrega. El estado puede haberse publicado: compruébalo antes de reintentar.', 'recipients')
  }

  // ------------------------------------------------------------------ shell

  function renderActive() {
    closeViewerQuiet()
    closeTimelineQuiet()
    closeComposerQuiet()
    state.panel?.classList.remove('novedades-viewing')
    renderComposeAvailability()
    if (state.tab === 'statuses') void renderStatusesTab()
    else void renderChannelsTab()
  }

  function switchTab(tab) {
    if (state.tab === tab) return
    state.tab = tab
    state.notice = ''
    for (const [name, element] of state.tabs) {
      element.setAttribute('aria-selected', String(name === tab))
      element.classList.toggle('is-active', name === tab)
    }
    state.list.setAttribute('aria-label', tab === 'statuses' ? 'Estados' : 'Canales')
    state.searchRow.hidden = tab !== 'channels'
    renderActive()
  }

  function focusBody() {
    queueMicrotask(() => {
      if (!state.closed) state.list.focus?.()
    })
  }

  function onKeyDown(event) {
    if (state.closed || event.defaultPrevented) return
    if (event.key === 'Tab') {
      const controls = [...(state.panel?.querySelectorAll('button, input, select, textarea, [tabindex]') || [])]
        .filter(element => !element.disabled && element.tabIndex >= 0 && element.getClientRects().length)
      if (!controls.length) return
      const index = controls.indexOf(documentRef.activeElement)
      if (index < 0 || (event.shiftKey && index === 0) || (!event.shiftKey && index === controls.length - 1)) {
        event.preventDefault()
        ;(event.shiftKey ? controls.at(-1) : controls[0]).focus()
      }
      return
    }
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    if (state.confirm) closeConfirmDialog({ restoreFocus: true })
    else if (state.viewer) closeViewer()
    else if (state.composer) closeComposer({ restoreFocus: true })
    else if (state.timeline) closeTimeline()
    else close({ restoreFocus: true })
  }

  function open({ opener = null, tab = 'statuses' } = {}) {
    const nextTab = tab === 'channels' ? 'channels' : 'statuses'
    onOpen?.()
    if (!state.closed) {
      if (opener) state.opener = opener
      switchTab(nextTab)
      focusBody()
      return
    }
    state.generation += 1
    state.closed = false
    state.tab = nextTab
    state.account = text(getAccount())
    state.opener = opener
    state.channelQuery = ''
    state.channels = []
    state.channelsCursor = null

    const overlay = node('div', 'novedades-overlay')
    overlay.setAttribute('role', 'presentation')
    overlay.addEventListener('click', event => {
      if (event.target === overlay) close({ restoreFocus: true })
    })
    const panel = node('aside', 'novedades-panel')
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-modal', 'true')
    panel.setAttribute('aria-labelledby', 'novedades-title')
    panel.setAttribute('aria-busy', 'true')

    const header = node('header', 'novedades-header')
    const title = node('h2', 'novedades-title', 'Novedades')
    title.id = 'novedades-title'
    const closeButton = button('novedades-close', 'Cerrar Novedades')
    closeButton.textContent = '×'
    closeButton.onclick = () => close({ restoreFocus: true })
    header.append(title, closeButton)

    const tabsNav = node('nav', 'novedades-tabs')
    tabsNav.setAttribute('role', 'tablist')
    state.tabs = [
      ['statuses', button('novedades-tab', 'Estados')],
      ['channels', button('novedades-tab', 'Canales')],
    ]
    for (const [name, element] of state.tabs) {
      element.setAttribute('role', 'tab')
      element.id = `novedades-tab-${name}`
      element.setAttribute('aria-controls', 'novedades-list')
      element.setAttribute('aria-selected', String(name === nextTab))
      element.classList.toggle('is-active', name === nextTab)
      element.append(node('span', '', name === 'statuses' ? 'Estados' : 'Canales'))
      element.onclick = () => switchTab(name)
      tabsNav.append(element)
    }

    state.searchRow = node('div', 'novedades-search')
    state.searchRow.hidden = nextTab !== 'channels'
    state.searchInput = documentRef.createElement('input')
    state.searchInput.type = 'search'
    state.searchInput.autocomplete = 'off'
    state.searchInput.placeholder = 'Buscar en los canales cargados'
    state.searchInput.setAttribute('aria-label', 'Buscar canales')
    state.searchInput.addEventListener('input', () => {
      state.channelQuery = text(state.searchInput.value)
      state.lookupRequest += 1
      state.lookupChannel = null
      renderChannelRows()
    })
    const lookup = button('novedades-lookup', 'Consultar en WhatsApp')
    lookup.textContent = 'Consultar en WhatsApp'
    lookup.onclick = () => void lookupCurrentChannel()
    state.searchRow.append(state.searchInput, lookup)

    state.composeRow = node('div', 'novedades-compose')
    state.composeButton = button('novedades-compose-button', 'Publicar un estado nuevo')
    state.composeButton.textContent = '+ Publicar estado'
    state.composeButton.onclick = () => openComposer()
    state.composeRow.append(state.composeButton)
    state.composeRow.hidden = nextTab !== 'statuses' || !publishAllowed()

    state.status = node('p', 'novedades-status')
    state.status.setAttribute('role', 'status')
    state.status.setAttribute('aria-live', 'polite')

    state.list = node('div', 'novedades-list')
    state.list.setAttribute('role', 'tabpanel')
    state.list.id = 'novedades-list'
    state.list.setAttribute('aria-labelledby', `novedades-tab-${nextTab}`)
    state.list.setAttribute('tabindex', '-1')

    state.channelsMore = button('novedades-more novedades-list-more', 'Cargar más canales')
    state.channelsMore.textContent = 'Cargar más canales'
    state.channelsMore.hidden = true
    state.channelsMore.onclick = () => void loadChannelsMore()

    panel.append(header, tabsNav, state.searchRow, state.composeRow, state.status, state.list, state.channelsMore)
    overlay.append(panel)
    documentRef.body.append(overlay)
    state.root = overlay
    state.panel = panel

    documentRef.addEventListener?.('keydown', onKeyDown)
    renderActive()
    focusBody()
  }

  function destroy() {
    stopViewerTicker()
    state.root?.remove()
    state.root = null
    state.panel = null
    state.list = null
    state.status = null
    state.searchRow = null
    state.searchInput = null
    state.channelsMore = null
    state.tabs = []
    state.composeRow = null
    state.composeButton = null
    state.composer = null
    state.composerRefs = null
    state.confirm = null
    state.confirmRefs = null
  }

  function resetViewers() {
    closeViewerQuiet()
    closeTimelineQuiet()
    state.request += 1
  }

  function close({ restoreFocus = true } = {}) {
    if (state.closed) return
    state.generation += 1
    state.closed = true
    removeComposerElement()
    state.publishing = false
    discardDraft()
    state.notice = ''
    resetViewers()
    stopViewerTicker()
    documentRef.removeEventListener?.('keydown', onKeyDown)
    destroy()
    if (restoreFocus && state.opener?.isConnected !== false) state.opener.focus?.()
    state.opener = null
  }

  return {
    open,
    close,
    isOpen: () => !state.closed,
    accountChanged() {
      if (state.closed) return
      const next = text(getAccount())
      if (next === state.account) return
      resetViewers()
      state.generation += 1
      state.account = next
      state.channelQuery = ''
      state.lookupRequest += 1
      state.lookupChannel = null
      state.subscriptionSerial += 1
      state.subscriptionPending = false
      if (state.searchInput) state.searchInput.value = ''
      state.channels = []
      state.channelsCursor = null
      removeComposerElement()
      state.publishing = false
      discardDraft()
      state.notice = ''
      state.audience.items = []
      state.audience.cursor = null
      renderActive()
    },
  }
}
