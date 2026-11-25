/**
 * SKIRM-443: bounded in-memory caches for the telegram connector.
 *
 * mtcute's `MemoryStorage` keeps every peer it ever sees in plain `Map`s
 * (`peers.entities`, plus the username/phone indexes) and every message
 * reference in `refMessages.refs`. None of them evict, so a busy account's
 * working set grows until the pod OOMs (INFRA-928: the personal connector
 * needed its ceiling raised four times; the professional one, same code and
 * less traffic, stays flat). These subclasses cap each cache by entry count
 * with FIFO eviction — the limit in code, so the pod's memory limit stops
 * being the only ceiling.
 *
 * The three caches the spec names map onto: peers → `peers.entities`,
 * mensajes → `refMessages.refs`, dialogs → the dialogs snapshot the client
 * builds on connect/backfill (`capDialogs`, and `userNameCache`).
 */
import {
  MemoryStorageDriver,
  MemoryKeyValueRepository,
  MemoryAuthKeysRepository,
  MemoryPeersRepository,
  MemoryRefMessagesRepository,
} from '@mtcute/node';
import type { ITelegramStorageProvider } from '@mtcute/node';

/**
 * A `Map` that never holds more than `max` entries: when a `set` pushes it
 * over the cap, the oldest-inserted entry is dropped (FIFO). Re-storing an
 * existing key keeps its slot, so a peer that keeps arriving is still
 * evicted after `max` distinct peers have come through — acceptable for a
 * cache (a dropped peer is re-resolved from Telegram on the next use, which
 * is exactly what `resolve-peer` already does).
 */
export class BoundedMap<K, V> extends Map<K, V> {
  constructor(private readonly max: number, entries?: Iterable<readonly [K, V]>) {
    super(entries);
  }

  set(key: K, value: V): this {
    super.set(key, value);
    while (this.size > this.max) {
      const oldest = this.keys().next();
      if (oldest.done) break;
      super.delete(oldest.value);
    }
    return this;
  }
}

/** Peers repository whose entity + username + phone caches are capped. */
export class BoundedMemoryPeersRepository extends MemoryPeersRepository {
  constructor(driver: MemoryStorageDriver, max: number) {
    super(driver);
    this.state.entities = new BoundedMap(max);
    this.state.usernameIndex = new BoundedMap(max);
    this.state.phoneIndex = new BoundedMap(max);
  }
}

/** Ref-messages repository whose per-peer reference set is capped. */
export class BoundedMemoryRefMessagesRepository extends MemoryRefMessagesRepository {
  constructor(driver: MemoryStorageDriver, max: number) {
    super(driver);
    this.state.refs = new BoundedMap(max);
  }
}

/**
 * The bounded counterpart of `MemoryStorage`: same four repositories, but
 * peers and ref-messages evict past their caps. `kv` and `authKeys` stay
 * plain — they hold a handful of session keys, not per-peer data.
 */
export class BoundedMemoryStorage implements ITelegramStorageProvider {
  readonly driver: MemoryStorageDriver;
  readonly kv: MemoryKeyValueRepository;
  readonly authKeys: MemoryAuthKeysRepository;
  readonly peers: BoundedMemoryPeersRepository;
  readonly refMessages: BoundedMemoryRefMessagesRepository;

  constructor(peersMax: number, refMessagesMax: number, driver?: MemoryStorageDriver) {
    this.driver = driver ?? new MemoryStorageDriver();
    this.kv = new MemoryKeyValueRepository(this.driver);
    this.authKeys = new MemoryAuthKeysRepository(this.driver);
    this.peers = new BoundedMemoryPeersRepository(this.driver, peersMax);
    this.refMessages = new BoundedMemoryRefMessagesRepository(this.driver, refMessagesMax);
  }
}

/** Cap on the dialogs snapshot (the list built from `iterDialogs`). */
export function capDialogs<T>(dialogs: readonly T[], max: number): T[] {
  return dialogs.length > max ? dialogs.slice(0, max) : dialogs.slice();
}

function envInt(name: string, def: number): number {
  const raw = process.env[name];
  if (!raw) return def;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/** Cache ceilings, overridable per deployment; defaults bound the pod well under 3Gi. */
export const cacheLimits = {
  peersMax: () => envInt('TG_PEERS_CACHE_MAX', 50_000),
  refMessagesMax: () => envInt('TG_REFMSGS_CACHE_MAX', 50_000),
  dialogsMax: () => envInt('TG_DIALOGS_MAX', 10_000),
  userNameMax: () => envInt('TG_USERNAME_CACHE_MAX', 2_000),
};
