/**
 * One token refresh at a time across every tab of this App on this device.
 *
 * WHY: the sign-in realm can rotate refresh tokens - each refresh hands back a new one and the old one
 * stops working. Two tabs refreshing at once with the same refresh token then end in `invalid_grant`
 * for one of them. Every tab shares one stored sign-in (localStorage), so they must take turns: the
 * tab that holds the lock refreshes; a tab that waited re-reads the store after it gets the lock and,
 * finding the tokens another tab just got, uses them instead of refreshing again.
 *
 * HOW, best first:
 *  - the Web Locks API (`navigator.locks`): an exclusive lock the browser grants to one tab at a time
 *    and releases when that tab closes;
 *  - else, in a page with localStorage: a lock record in localStorage with an expiry, kept alive while
 *    held, and a BroadcastChannel to wake the waiting tabs when it is let go (they also poll). A tab that
 *    closes mid-refresh leaves a record that lapses after `ttlMs`; a tab that waits longer than `waitMs`
 *    goes ahead unlocked (the re-read after an `invalid_grant` still keeps it from signing out wrongly);
 *  - else (Node, React Native, a worker without either): no other tab shares this store, so the caller's
 *    own in-process single flight is the whole story and the lock is a pass-through.
 *
 * No runtime imports, so `node --test` can load it from the build.
 */

/** Runs `fn` while holding the refresh lock. */
export type RefreshLock = <T>(fn: () => Promise<T>) => Promise<T>;

export interface StorageLockOptions {
  /** How long a lock record lasts without being kept alive. Default 10 s. */
  ttlMs?: number;
  /** How long a tab waits for the lock before going ahead without it. Default 30 s. */
  waitMs?: number;
  /** How often a waiting tab looks again, besides being woken. Default 100 ms. */
  pollMs?: number;
}

interface LockManagerLike {
  request<T>(name: string, options: { mode: 'exclusive' }, callback: () => Promise<T>): Promise<T>;
}

interface ChannelLike {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
}

interface SyncStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Which kind of lock this environment gets - for tests and diagnostics. */
export type LockKind = 'web-locks' | 'storage' | 'in-process';

function webLocks(): LockManagerLike | null {
  const nav = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator;
  return nav?.locks && typeof nav.locks.request === 'function' ? nav.locks : null;
}

/** The page's localStorage, when this is a page (one store shared by its tabs) and storage works. */
function sharedStorage(): SyncStorage | null {
  const g = globalThis as { window?: unknown; localStorage?: SyncStorage };
  if (typeof g.window === 'undefined') return null;
  try {
    const ls = g.localStorage;
    if (!ls) return null;
    ls.getItem('__probe__');
    return ls;
  } catch {
    return null;
  }
}

function openChannel(name: string): ChannelLike | null {
  const BC = (globalThis as { BroadcastChannel?: new (name: string) => ChannelLike }).BroadcastChannel;
  if (!BC) return null;
  try {
    return new BC(name);
  } catch {
    return null;
  }
}

function randomId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** The lock this environment supports, decided when asked (so a page that gains an API later uses it). */
export function lockKind(): LockKind {
  if (webLocks()) return 'web-locks';
  if (sharedStorage()) return 'storage';
  return 'in-process';
}

/** A lock named `name`, shared by every tab of this origin. */
export function refreshLock(name: string, options: StorageLockOptions = {}): RefreshLock {
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const locks = webLocks();
    if (locks) return locks.request(name, { mode: 'exclusive' }, () => fn());
    const ls = sharedStorage();
    if (ls) return withStorageLock(ls, name, options, fn);
    return fn();
  };
}

interface LockRecord {
  id: string;
  until: number;
}

function readRecord(ls: SyncStorage, key: string): LockRecord | null {
  try {
    const raw = ls.getItem(key);
    const rec = raw ? (JSON.parse(raw) as LockRecord) : null;
    return rec && typeof rec.id === 'string' && typeof rec.until === 'number' ? rec : null;
  } catch {
    return null;
  }
}

function writeRecord(ls: SyncStorage, key: string, rec: LockRecord): void {
  try {
    ls.setItem(key, JSON.stringify(rec));
  } catch {
    /* storage refused: the lock is best effort */
  }
}

async function withStorageLock<T>(ls: SyncStorage, name: string, options: StorageLockOptions, fn: () => Promise<T>): Promise<T> {
  const ttlMs = options.ttlMs ?? 10_000;
  const waitMs = options.waitMs ?? 30_000;
  const pollMs = options.pollMs ?? 100;
  const key = `${name}.lock`;
  const id = randomId();
  const channel = openChannel(name);
  let wake: (() => void) | null = null;
  if (channel) channel.onmessage = () => wake?.();
  const waitForWake = () =>
    new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, pollMs);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });

  let held = false;
  let beat: ReturnType<typeof setInterval> | null = null;
  try {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const current = readRecord(ls, key);
      if (!current || current.until <= Date.now() || current.id === id) {
        writeRecord(ls, key, { id, until: Date.now() + ttlMs });
        // Two tabs may write at once; the last write wins. Let a racing write land, then look again.
        await sleep(10 + Math.random() * 20);
        if (readRecord(ls, key)?.id === id) {
          held = true;
          break;
        }
      }
      if (Date.now() >= deadline) break;
      await waitForWake();
    }
    if (held) {
      beat = setInterval(() => {
        if (readRecord(ls, key)?.id === id) writeRecord(ls, key, { id, until: Date.now() + ttlMs });
      }, Math.max(1, Math.floor(ttlMs / 3)));
    }
    return await fn();
  } finally {
    if (beat) clearInterval(beat);
    if (held && readRecord(ls, key)?.id === id) {
      try {
        ls.removeItem(key);
      } catch {
        /* lapses on its own */
      }
    }
    try {
      channel?.postMessage({ t: 'released', id });
    } catch {
      /* the waiting tabs poll */
    }
    channel?.close();
  }
}
