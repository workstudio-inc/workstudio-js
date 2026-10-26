// app.auth's token refresh, on the built package (npm test builds first): one refresh across tabs (Web Locks, else a
// storage lock), a rotated refresh token stored before anything else, the old one kept when none comes back, retries
// without signing out, signing out only on invalid_grant - and not when another tab had just rotated it - and the
// in-process fallback outside a browser.
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { AppError, Auth, SignInRequired } from '../dist/app.js';

const API = 'https://api.example.test';
const ISSUER = 'https://auth.example.test/realms/apps';
const KEY = 'ws.test';
const FAST = { retry: { baseMs: 1, capMs: 5 } };

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** The sign-in realm and the platform's token swap. `realm`/`swap` may answer a call; otherwise they succeed. */
function backend({ realm, swap, delayMs = 0 } = {}) {
  const calls = { realm: [], swap: [], logout: [] };
  let n = 0;
  const fetch = async (url, init) => {
    const form = Object.fromEntries(new URLSearchParams(String(init.body)));
    if (delayMs) await sleep(delayMs);
    if (url === `${ISSUER}/protocol/openid-connect/token`) {
      calls.realm.push(form);
      const answer = realm && (await realm(form, calls.realm.length));
      if (answer) return answer;
      n++;
      return json(200, { access_token: `realm-at-${n}`, refresh_token: `rt-${n}` });
    }
    if (url === `${API}/api/v1/workflow/connection/oauth/token`) {
      calls.swap.push(form);
      const answer = swap && (await swap(form, calls.swap.length));
      if (answer) return answer;
      return json(200, { access_token: `pt-for-${form.subject_token}`, expires_in: 900 });
    }
    if (url === `${ISSUER}/protocol/openid-connect/logout`) {
      calls.logout.push(form);
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected ${url}`);
  };
  return { fetch, calls };
}

/** A store like Keychain or AsyncStorage: every call async. */
function asyncStore(log = []) {
  const m = new Map();
  return {
    m,
    log,
    getItem: async k => m.get(k) ?? null,
    setItem: async (k, v) => {
      await sleep(1);
      m.set(k, v);
      log.push(['set', k, v]);
    },
    removeItem: async k => {
      m.delete(k);
      log.push(['remove', k]);
    },
  };
}

/** A synchronous store like localStorage. */
function syncStore() {
  const m = new Map();
  return { m, getItem: k => m.get(k) ?? null, setItem: (k, v) => void m.set(k, String(v)), removeItem: k => void m.delete(k) };
}

const held = (store, k = KEY) => {
  const raw = store.m.get(k);
  return raw ? JSON.parse(raw) : null;
};

/** A sign-in whose platform token needs refreshing (inside the one-minute margin), or `expiresInMs` from now. */
function seed(store, { platformToken = 'pt-old', refreshToken = 'rt-0', expiresInMs = 10_000 } = {}) {
  store.m.set(KEY, JSON.stringify({ email: 'p@example.test', platformToken, platformTokenExpiresAt: Date.now() + expiresInMs, refreshToken }));
}

function tab(store, fetch, tuning = FAST) {
  return new Auth({ apiUrl: API, signInIssuer: ISSUER, clientId: 'crava-web', storageKey: KEY, storage: store, fetch, aiRuntimeUrl: API, dataUrl: API }, tuning);
}

// ── globals: a page, Web Locks ──────────────────────────────────────────────────────────────────────────────────────
const saved = new Map();
function setGlobal(name, value) {
  if (!saved.has(name)) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: true });
}
afterEach(() => {
  for (const [name, d] of saved) {
    if (d) Object.defineProperty(globalThis, name, d);
    else delete globalThis[name];
  }
  saved.clear();
});

/** navigator.locks as a browser gives it: one holder per name, the rest queue. */
function fakeLocks() {
  const tails = new Map();
  const locks = {
    granted: 0,
    request(name, _options, callback) {
      const run = (tails.get(name) ?? Promise.resolve()).then(() => {
        locks.granted++;
        return callback({ name, mode: 'exclusive' });
      });
      tails.set(name, run.catch(() => undefined));
      return run;
    },
  };
  return locks;
}

describe('auth refresh: one refresh across tabs', () => {
  it('two tabs, one refresh (Web Locks): the tab that waited re-reads the store and uses those tokens', async () => {
    const locks = fakeLocks();
    setGlobal('navigator', { locks });
    const store = asyncStore();
    seed(store);
    const { fetch, calls } = backend({ delayMs: 20 });
    const [a, b] = [tab(store, fetch), tab(store, fetch)];
    const [ta, tb] = await Promise.all([a.token(), b.token()]);
    assert.equal(calls.realm.length, 1, 'one refresh-token grant');
    assert.equal(calls.swap.length, 1);
    assert.equal(ta, 'pt-for-realm-at-1');
    assert.equal(tb, ta);
    assert.equal(locks.granted, 2, 'both tabs went through the lock');
    assert.equal(held(store).refreshToken, 'rt-1');
    assert.equal((await b.signedIn()).platformToken, ta, 'the waiting tab holds the new sign-in too');
  });

  it('two tabs, one refresh (no Web Locks: a localStorage lock, woken over BroadcastChannel)', async () => {
    const ls = syncStore();
    setGlobal('navigator', {});
    setGlobal('window', {});
    setGlobal('localStorage', ls);
    seed(ls);
    const { fetch, calls } = backend({ delayMs: 20 });
    const [a, b, c] = [tab(ls, fetch), tab(ls, fetch), tab(ls, fetch)];
    const tokens = await Promise.all([a.token(), b.token(), c.token()]);
    assert.equal(calls.realm.length, 1, 'one refresh-token grant');
    assert.deepEqual(tokens, ['pt-for-realm-at-1', 'pt-for-realm-at-1', 'pt-for-realm-at-1']);
    assert.equal(ls.m.get(`${KEY}.refresh.lock`), undefined, 'the lock is let go');
  });

  it('a lock record left by a tab that closed mid-refresh lapses after its timeout', async () => {
    const ls = syncStore();
    setGlobal('navigator', {});
    setGlobal('window', {});
    setGlobal('localStorage', ls);
    seed(ls);
    ls.m.set(`${KEY}.refresh.lock`, JSON.stringify({ id: 'closed-tab', until: Date.now() + 150 }));
    const { fetch, calls } = backend();
    const started = Date.now();
    assert.equal(await tab(ls, fetch, { ...FAST, lock: { ttlMs: 150, pollMs: 20 } }).token(), 'pt-for-realm-at-1');
    assert.ok(Date.now() - started >= 120, 'waited for the record to lapse');
    assert.equal(calls.realm.length, 1);
  });

  it('a tab that waited finds the sign-in gone (signed out in another tab): no refresh, SignInRequired', async () => {
    const locks = fakeLocks();
    setGlobal('navigator', { locks });
    const store = asyncStore();
    seed(store);
    const { fetch, calls } = backend();
    const auth = tab(store, fetch);
    await auth.signedIn();
    await store.removeItem(KEY);
    await assert.rejects(auth.token(), SignInRequired);
    assert.equal(calls.realm.length, 0);
  });
});

describe('auth refresh: tokens kept', () => {
  it('the rotated refresh token is stored before the swap, and the new tokens before any caller sees them', async () => {
    const log = [];
    const store = asyncStore(log);
    seed(store);
    let storedAtSwap;
    const { fetch } = backend({
      swap: () => {
        storedAtSwap = held(store);
        return null;
      },
    });
    const auth = tab(store, fetch);
    let storedAtNotice;
    auth.onChange(() => (storedAtNotice = held(store)));
    const token = await auth.token();
    assert.equal(storedAtSwap.refreshToken, 'rt-1', 'rotated refresh token stored before the swap');
    assert.equal(storedAtSwap.platformToken, 'pt-old');
    assert.equal(storedAtNotice.platformToken, token, 'stored before listeners hear of it');
    assert.equal(held(store).platformToken, token);
    assert.equal(held(store).refreshToken, 'rt-1');
  });

  it('a rotated refresh token survives a swap that keeps failing, and the next refresh uses it', async () => {
    const store = asyncStore();
    seed(store, { expiresInMs: 30_000 });
    let swapDown = true;
    const { fetch, calls } = backend({ swap: () => (swapDown ? json(503, { error: 'temporarily_unavailable' }) : null) });
    const auth = tab(store, fetch, { retry: { attempts: 3, baseMs: 1, capMs: 2 } });
    assert.equal(await auth.token(), 'pt-old', 'the token held still works, so it is used');
    assert.equal(calls.realm.length, 1, 'the realm refresh is not repeated while the swap retries');
    assert.equal(calls.swap.length, 3);
    assert.equal(held(store).refreshToken, 'rt-1', 'the rotated refresh token is not lost');
    swapDown = false;
    assert.equal(await auth.token(), 'pt-for-realm-at-2');
    assert.equal(calls.realm.at(-1).refresh_token, 'rt-1');
  });

  it('keeps the old refresh token when the answer has none', async () => {
    const store = asyncStore();
    seed(store, { refreshToken: 'rt-keep' });
    const { fetch } = backend({ realm: () => json(200, { access_token: 'realm-at-x' }) });
    const auth = tab(store, fetch);
    assert.equal(await auth.token(), 'pt-for-realm-at-x');
    assert.equal(held(store).refreshToken, 'rt-keep');
    assert.equal((await auth.signedIn()).refreshToken, 'rt-keep');
  });
});

describe('auth refresh: failures', () => {
  it('a network error, a 503 and a 429 are retried, never signing out', async () => {
    const store = asyncStore();
    seed(store);
    const { fetch, calls } = backend({
      realm: (_f, n) => {
        if (n === 1) throw new TypeError('Failed to fetch');
        if (n === 2) return json(503, { error: 'temporarily_unavailable' });
        if (n === 3) return json(429, { error: 'slow_down' }, { 'Retry-After': '0' });
        if (n === 4) return json(408, {});
        return null;
      },
    });
    const auth = tab(store, fetch);
    const changes = [];
    auth.onChange(who => changes.push(who));
    assert.equal(await auth.token(), 'pt-for-realm-at-1');
    assert.equal(calls.realm.length, 5);
    assert.ok(changes.every(who => who !== null), 'never signed out');
    assert.ok(calls.realm.every(f => f.refresh_token === 'rt-0'));
  });

  it("honours a 429's Retry-After", async () => {
    const store = asyncStore();
    seed(store);
    const { fetch, calls } = backend({ realm: (_f, n) => (n === 1 ? json(429, { error: 'slow_down' }, { 'Retry-After': '1' }) : null) });
    const started = Date.now();
    assert.equal(await tab(store, fetch).token(), 'pt-for-realm-at-1');
    assert.ok(Date.now() - started >= 950, 'waited the second it asked for');
    assert.equal(calls.realm.length, 2);
  });

  it('a Retry-After past the cap ends the retries, still signed in', async () => {
    const store = asyncStore();
    seed(store, { expiresInMs: -1000 });
    const { fetch, calls } = backend({ realm: () => json(429, {}, { 'Retry-After': '3600' }) });
    const auth = tab(store, fetch);
    await assert.rejects(auth.token(), e => e instanceof AppError && !(e instanceof SignInRequired) && e.status === 429);
    assert.equal(calls.realm.length, 1);
    assert.ok(held(store), 'still signed in');
  });

  it('offline through every try: the held token while it works, then NETWORK - never SignInRequired', async () => {
    const store = asyncStore();
    seed(store, { expiresInMs: 30_000 });
    const { fetch, calls } = backend({ realm: () => Promise.reject(new TypeError('Failed to fetch')) });
    const auth = tab(store, fetch, { retry: { attempts: 3, baseMs: 1, capMs: 2 } });
    assert.equal(await auth.token(), 'pt-old');
    assert.equal(calls.realm.length, 3);

    const expired = asyncStore();
    seed(expired, { expiresInMs: -1000 });
    const offline = tab(expired, fetch, { retry: { attempts: 2, baseMs: 1, capMs: 2 } });
    await assert.rejects(offline.token(), e => e instanceof AppError && !(e instanceof SignInRequired) && e.status === 0 && e.code === 'NETWORK');
    assert.ok(held(expired), 'the sign-in is kept for when the connection is back');
    assert.ok(await offline.signedIn());
    assert.equal(await offline.renew(), false);
    assert.ok(held(expired));
  });

  it('400 invalid_grant signs out', async () => {
    const store = asyncStore();
    seed(store);
    const { fetch, calls } = backend({ realm: () => json(400, { error: 'invalid_grant', error_description: 'Token is not active' }) });
    const auth = tab(store, fetch);
    const changes = [];
    auth.onChange(who => changes.push(who));
    await assert.rejects(auth.token(), SignInRequired);
    assert.equal(calls.realm.length, 1, 'not retried');
    assert.equal(held(store), null);
    assert.deepEqual(changes, [null]);
    assert.equal(await auth.signedIn(), null);
  });

  it('invalid_grant after another tab rotated the refresh token: uses theirs, does not sign out', async () => {
    const store = asyncStore();
    seed(store);
    const { fetch, calls } = backend({
      realm: async (_f, n) => {
        if (n !== 1) return null;
        // Another tab (no shared lock: a timed-out storage lock, or none) rotated it a moment ago.
        await store.setItem(KEY, JSON.stringify({ platformToken: 'pt-other-tab', platformTokenExpiresAt: Date.now() + 900_000, refreshToken: 'rt-other' }));
        return json(400, { error: 'invalid_grant', error_description: 'Stale token' });
      },
    });
    const auth = tab(store, fetch);
    assert.equal(await auth.token(), 'pt-other-tab');
    assert.equal(calls.realm.length, 1);
    assert.equal(held(store).refreshToken, 'rt-other');
  });

  it("invalid_grant after another tab rotated it, theirs already running out: refreshes with theirs", async () => {
    const store = asyncStore();
    seed(store);
    const { fetch, calls } = backend({
      realm: async (_f, n) => {
        if (n !== 1) return null;
        await store.setItem(KEY, JSON.stringify({ platformToken: 'pt-other-tab', platformTokenExpiresAt: Date.now() + 5_000, refreshToken: 'rt-other' }));
        return json(400, { error: 'invalid_grant' });
      },
    });
    const auth = tab(store, fetch);
    assert.equal(await auth.token(), 'pt-for-realm-at-1');
    assert.deepEqual(calls.realm.map(f => f.refresh_token), ['rt-0', 'rt-other']);
    assert.equal(held(store).refreshToken, 'rt-1');
  });

  it('other refusals (400 invalid_client from the realm, 403 from the swap) keep the sign-in', async () => {
    for (const answers of [
      { realm: () => json(400, { error: 'invalid_client' }) },
      { swap: () => json(403, { error: 'invalid_target', error_description: 'Not invited' }) },
    ]) {
      const store = asyncStore();
      seed(store, { expiresInMs: -1000 });
      const { fetch } = backend(answers);
      const auth = tab(store, fetch);
      await assert.rejects(auth.token(), e => e instanceof AppError && !(e instanceof SignInRequired));
      assert.ok(held(store), 'still signed in');
    }
  });
});

describe('auth refresh: outside a browser', () => {
  it('Node (no window, no Web Locks): concurrent calls share one in-process refresh', async () => {
    assert.equal(typeof globalThis.window, 'undefined');
    assert.equal(globalThis.navigator?.locks, undefined);
    const store = asyncStore();
    seed(store);
    const { fetch, calls } = backend({ delayMs: 10 });
    const auth = tab(store, fetch);
    const tokens = await Promise.all(Array.from({ length: 5 }, () => auth.token()));
    assert.equal(calls.realm.length, 1);
    assert.ok(tokens.every(t => t === 'pt-for-realm-at-1'));
    assert.equal(held(store).refreshToken, 'rt-1');
  });

  it('React Native (a navigator without locks, async secure storage): the same', async () => {
    setGlobal('navigator', { product: 'ReactNative' });
    const store = asyncStore();
    seed(store);
    const { fetch, calls } = backend({ delayMs: 10 });
    const auth = tab(store, fetch);
    const [x, y] = await Promise.all([auth.token(), auth.token()]);
    assert.equal(x, 'pt-for-realm-at-1');
    assert.equal(y, x);
    assert.equal(calls.realm.length, 1);
  });

  it('renew() refreshes a token that is still good; a token() meanwhile shares it', async () => {
    const store = asyncStore();
    seed(store, { expiresInMs: 600_000 });
    const { fetch, calls } = backend({ delayMs: 10 });
    const auth = tab(store, fetch);
    const [renewed] = await Promise.all([auth.renew(), auth.token()]);
    assert.equal(renewed, true);
    assert.equal(calls.realm.length, 1);
    assert.equal(await auth.token(), 'pt-for-realm-at-1');
  });

  it('sign-out ends the hosted session with the stored (rotated) refresh token', async () => {
    const store = asyncStore();
    seed(store);
    const { fetch, calls } = backend();
    const a = tab(store, fetch);
    const b = tab(store, fetch);
    await b.signedIn();
    await a.token(); // a rotates rt-0 to rt-1; b still holds rt-0 in memory
    await b.signOut();
    assert.equal(calls.logout.at(-1).refresh_token, 'rt-1');
    assert.equal(held(store), null);
  });
});
