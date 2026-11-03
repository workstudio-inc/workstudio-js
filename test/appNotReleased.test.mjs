// An App with no released version (step-2 gate (i)): the platform's token swap answers 403 invalid_target with
// code APP_NOT_RELEASED (connection OAuthTokenExchangeController). The person is still signed out, as for any
// invalid_target, but the SDK says why - AppNotReleased, and the reason on onChange - so the App can show "This App
// isn't available yet" rather than a silent sign-out. Every other refusal, and a released App's refresh, is unchanged.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError, AppNotReleased, Auth, SignInRequired } from '../dist/app.js';

const API = 'https://api.example.test';
const ISSUER = 'https://auth.example.test/realms/apps';
const KEY = 'ws.test';
const FAST = { retry: { baseMs: 1, capMs: 5 } };
const SWAP_URL = `${API}/api/v1/workflow/connection/oauth/token`;
const REALM_URL = `${ISSUER}/protocol/openid-connect/token`;
const LOGOUT_URL = `${ISSUER}/protocol/openid-connect/logout`;

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** What connection answers in enforce mode for an App with no APPROVED version. */
const notReleased = () =>
  json(403, {
    error: 'invalid_target',
    error_description: 'Draft App has not been released yet, so it cannot be used. Its publisher can test it with test end users.',
    code: 'APP_NOT_RELEASED',
  });

function backend({ realm, swap } = {}) {
  const calls = { realm: [], swap: [], logout: [], urls: [] };
  let n = 0;
  const fetch = async (url, init) => {
    calls.urls.push(url);
    const form = Object.fromEntries(new URLSearchParams(String(init.body)));
    if (url === REALM_URL) {
      calls.realm.push(form);
      const answer = realm && (await realm(form, calls.realm.length));
      if (answer) return answer;
      n++;
      return json(200, { access_token: `realm-at-${n}`, refresh_token: `rt-${n}` });
    }
    if (url === SWAP_URL) {
      calls.swap.push(form);
      const answer = swap && (await swap(form, calls.swap.length));
      if (answer) return answer;
      return json(200, { access_token: `pt-for-${form.subject_token}`, expires_in: 900 });
    }
    if (url === LOGOUT_URL) {
      calls.logout.push(form);
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected ${url}`);
  };
  return { fetch, calls };
}

function store() {
  const m = new Map();
  return { m, getItem: async k => m.get(k) ?? null, setItem: async (k, v) => void m.set(k, v), removeItem: async k => void m.delete(k) };
}

const held = s => {
  const raw = s.m.get(KEY);
  return raw ? JSON.parse(raw) : null;
};

function seed(s, { expiresInMs = 10_000 } = {}) {
  s.m.set(KEY, JSON.stringify({ email: 'p@example.test', platformToken: 'pt-old', platformTokenExpiresAt: Date.now() + expiresInMs, refreshToken: 'rt-0' }));
}

/** A Crava-shaped App: its own web client on the shared Apps realm. */
function tab(s, fetch, clientId = 'crava-web') {
  return new Auth({ apiUrl: API, signInIssuer: ISSUER, clientId, redirectUri: 'https://app.example.test/', storageKey: KEY, storage: s, fetch,
    aiRuntimeUrl: API, dataUrl: API }, FAST);
}

/** Every onChange call, with all the arguments it got. */
function listen(auth) {
  const heard = [];
  auth.onChange((...args) => heard.push(args));
  return heard;
}

describe('APP_NOT_RELEASED on refresh', () => {
  it('token(): signs out and throws AppNotReleased (still a SignInRequired), with words the App can show', async () => {
    const s = store();
    seed(s);
    const { fetch, calls } = backend({ swap: notReleased });
    const auth = tab(s, fetch);
    const heard = listen(auth);
    let thrown;
    await assert.rejects(auth.token(), e => (thrown = e, true));
    assert.ok(thrown instanceof AppNotReleased, `AppNotReleased, got ${thrown?.name}`);
    assert.ok(thrown instanceof SignInRequired, 'existing SignInRequired handling still sees a sign-out');
    assert.ok(thrown instanceof AppError);
    assert.equal(thrown.name, 'AppNotReleased');
    assert.equal(thrown.code, 'APP_NOT_RELEASED');
    assert.equal(thrown.status, 403);
    assert.equal(thrown.reason, 'app_not_released');
    assert.equal(thrown.message, 'This App isn’t available yet.');
    assert.equal(thrown.details?.code, 'APP_NOT_RELEASED', 'the refusal as it came');
    assert.equal(calls.swap.length, 1, 'not retried');
    assert.equal(held(s), null, 'the sign-out is kept');
    assert.equal(await auth.signedIn(), null);
    assert.equal(heard.length, 1);
    assert.equal(heard[0][0], null);
    assert.ok(heard[0][1] instanceof AppNotReleased, 'listeners hear why');
  });

  it('renew() in the background: false, signed out, and the listener is told why', async () => {
    const s = store();
    seed(s, { expiresInMs: 600_000 });
    const { fetch } = backend({ swap: notReleased });
    const auth = tab(s, fetch);
    const heard = listen(auth);
    assert.equal(await auth.renew(), false);
    assert.equal(held(s), null);
    assert.equal(heard.length, 1);
    assert.equal(heard[0][0], null);
    assert.ok(heard[0][1] instanceof AppNotReleased);
    // Signed out now: the next call is the ordinary SignInRequired.
    await assert.rejects(auth.token(), e => e instanceof SignInRequired && !(e instanceof AppNotReleased));
  });

  it('the first sign-in refused the same way throws AppNotReleased, and ends the hosted sign-in', async () => {
    const s = store();
    s.m.set(`${KEY}.pending`, JSON.stringify({ verifier: 'v', state: 'st-1', returnTo: '/' }));
    const { fetch, calls } = backend({ swap: notReleased });
    const auth = tab(s, fetch);
    await assert.rejects(auth.completeSignIn('https://app.example.test/?code=c-1&state=st-1'),
      e => e instanceof AppNotReleased && e.code === 'APP_NOT_RELEASED' && e.status === 403);
    assert.equal(held(s), null);
    assert.equal(calls.logout.length, 1);
  });
});

describe('APP_NOT_RELEASED: everything else unchanged', () => {
  it('a plain 403 invalid_target still signs out with an ordinary SignInRequired, and no reason', async () => {
    const s = store();
    seed(s);
    const { fetch } = backend({ swap: () => json(403, { error: 'invalid_target', error_description: 'Not invited' }) });
    const auth = tab(s, fetch);
    const heard = listen(auth);
    await assert.rejects(auth.token(), e => e instanceof SignInRequired && !(e instanceof AppNotReleased) && e.code === 'SIGN_IN_REQUIRED');
    assert.equal(held(s), null);
    assert.deepEqual(heard, [[null]], 'one argument, as before');
  });

  it('NOT_A_MEMBER (403 invalid_target with its own code) is unchanged: a SignInRequired, not AppNotReleased', async () => {
    const s = store();
    seed(s);
    const { fetch } = backend({ swap: () => json(403, { error: 'invalid_target', code: 'NOT_A_MEMBER', organization: 'Acme' }) });
    const auth = tab(s, fetch);
    const heard = listen(auth);
    await assert.rejects(auth.token(), e => e instanceof SignInRequired && !(e instanceof AppNotReleased));
    assert.deepEqual(heard, [[null]]);
  });

  it('APP_NOT_RELEASED on a 403 that is not invalid_target keeps the sign-in, as any other 403 does', async () => {
    const s = store();
    seed(s, { expiresInMs: -1000 });
    const { fetch } = backend({ swap: () => json(403, { error: 'access_denied', code: 'APP_NOT_RELEASED' }) });
    const auth = tab(s, fetch);
    const heard = listen(auth);
    await assert.rejects(auth.token(), e => e instanceof AppError && !(e instanceof SignInRequired) && e.status === 403);
    assert.ok(held(s), 'still signed in');
    assert.deepEqual(heard, []);
  });

  it('a Crava-shaped APPROVED App: the refresh is exactly as before', async () => {
    const s = store();
    seed(s);
    const { fetch, calls } = backend();
    const auth = tab(s, fetch, 'crava-web');
    const heard = listen(auth);
    const before = held(s);
    assert.equal(await auth.token(), 'pt-for-realm-at-1');
    assert.deepEqual(calls.urls, [REALM_URL, SWAP_URL], 'one refresh grant, one swap, nothing else');
    assert.deepEqual(calls.realm[0], { grant_type: 'refresh_token', refresh_token: 'rt-0', client_id: 'crava-web' });
    assert.deepEqual(calls.swap[0], {
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: 'realm-at-1',
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    });
    const after = held(s);
    assert.deepEqual(Object.keys(after).sort(), ['name', 'email', 'platformToken', 'platformTokenExpiresAt', 'refreshToken'].filter(k => k in after).sort());
    assert.equal(after.platformToken, 'pt-for-realm-at-1');
    assert.equal(after.refreshToken, 'rt-1');
    assert.notEqual(after.platformToken, before.platformToken);
    assert.equal(heard.length, 1);
    assert.equal(heard[0].length, 1, 'listeners get only the sign-in, as before');
    assert.equal(heard[0][0].platformToken, 'pt-for-realm-at-1');
    assert.equal(await auth.renew(), true, 'and renews as before');
    assert.equal(await auth.token(), 'pt-for-realm-at-2');
  });
});
