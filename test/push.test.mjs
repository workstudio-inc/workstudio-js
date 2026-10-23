// app.push against a stubbed fetch. Runs on the built package (npm test builds first), so it checks what is
// published: the ./app entry, its exports and the requests it makes.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError, Push, createApp } from '../dist/app.js';

const API = 'https://api.example.test';
const BASE = `${API}/api/v1/workflow/notification/end-users/me/push`;
const HASH = 'a'.repeat(32);

function memory() {
  const m = new Map();
  return { m, getItem: k => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: k => void m.delete(k) };
}

/** A client whose fetch records each call and answers from `replies` in turn (default 200 `{}`). */
function client(replies = [], extra = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers ?? {}, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const r = replies.shift() ?? { status: 200, body: {} };
    if (r.hang) return new Promise(() => {});
    return new Response(r.status === 204 ? null : JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  };
  const storage = memory();
  const app = createApp({ apiUrl: `${API}/`, platformToken: () => 'person-token', fetch, storage, ...extra });
  return { app, calls, storage };
}

const DEVICE = {
  id: 'd1', platform: 'ios', transport: 'APNS', apnsEnvironment: null, deviceName: null, appVersion: '1.0.0', enabled: true,
  tokenEnd: 'abcdef', scopeHash: HASH, createdAt: '2026-10-23T00:00:00Z', lastSeenAt: '2026-10-23T00:00:00Z', lastPushAt: null,
};

describe('app.push', () => {
  it('is on the App client and exported', () => {
    const { app } = client();
    assert.ok(app.push instanceof Push);
  });

  it('register: POST the token, platform and the transport that platform uses', async () => {
    const { app, calls } = client([{ body: DEVICE }]);
    const d = await app.push.register('tok-ios-1', 'ios', { appVersion: '1.0.0' });
    assert.deepEqual(d, DEVICE);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, `${BASE}/devices`);
    assert.equal(calls[0].headers.Authorization, 'Bearer person-token');
    assert.deepEqual(calls[0].body, { token: 'tok-ios-1', platform: 'ios', transport: 'APNS', appVersion: '1.0.0' });
  });

  it('register: android goes by FCM; options pass through; platform case is forgiven', async () => {
    const { app, calls } = client([{ body: { ...DEVICE, platform: 'android', transport: 'FCM' } }, { body: DEVICE }]);
    await app.push.register('tok-a', 'ANDROID', { deviceName: 'Pixel' });
    assert.deepEqual(calls[0].body, { token: 'tok-a', platform: 'android', transport: 'FCM', deviceName: 'Pixel' });
    await app.push.register('tok-i', 'ios', { apnsEnvironment: 'sandbox' });
    assert.deepEqual(calls[1].body, { token: 'tok-i', platform: 'ios', transport: 'APNS', apnsEnvironment: 'sandbox' });
  });

  it('register: refuses a missing token or an unknown platform before calling', async () => {
    const { app, calls } = client();
    await assert.rejects(app.push.register('', 'ios'));
    await assert.rejects(app.push.register('t', 'web'));
    assert.equal(calls.length, 0);
  });

  it('register: a refusal is an AppError with its code', async () => {
    const { app } = client([{ status: 403, body: { code: 'NOT_AN_END_USER', message: 'Only a person signed in to the app.' } }]);
    await assert.rejects(app.push.register('t', 'ios'), e => e instanceof AppError && e.status === 403 && e.code === 'NOT_AN_END_USER');
  });

  it('unregister: DELETE the remembered token, encoded; then nothing more to forget', async () => {
    const { app, calls } = client([{ body: DEVICE }, { status: 204 }]);
    await app.push.register('tok/with+chars', 'ios');
    await app.push.unregister();
    assert.equal(calls[1].method, 'DELETE');
    assert.equal(calls[1].url, `${BASE}/devices?token=${encodeURIComponent('tok/with+chars')}`);
    assert.equal(calls[1].body, undefined);
    await app.push.unregister();
    assert.equal(calls.length, 2);
  });

  it('unregister: a given token; resolves when nothing was registered', async () => {
    const { app, calls } = client([{ status: 204 }]);
    await app.push.unregister();
    assert.equal(calls.length, 0);
    await app.push.unregister('other');
    assert.equal(calls[0].url, `${BASE}/devices?token=other`);
  });

  it('devices and setEnabled', async () => {
    const { app, calls } = client([{ body: [DEVICE] }, { body: { ...DEVICE, enabled: false } }]);
    assert.deepEqual(await app.push.devices(), [DEVICE]);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].url, `${BASE}/devices`);
    const off = await app.push.setEnabled('d 1', false);
    assert.equal(off.enabled, false);
    assert.equal(calls[1].method, 'POST');
    assert.equal(calls[1].url, `${BASE}/devices/d%201/enabled`);
    assert.deepEqual(calls[1].body, { enabled: false });
  });

  it('preferences: get, and set sends only the changes', async () => {
    const prefs = { enabled: true, categories: { requests: true }, quietStart: null, quietEnd: null, timezone: null, scopeHash: HASH };
    const { app, calls } = client([{ body: prefs }, { body: { ...prefs, quietStart: '22:00', quietEnd: '07:00', timezone: 'America/New_York' } }]);
    assert.deepEqual(await app.push.preferences.get(), prefs);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].url, `${BASE}/preferences`);
    const set = await app.push.preferences.set({ quietStart: '22:00', quietEnd: '07:00', timezone: 'America/New_York' });
    assert.equal(set.quietStart, '22:00');
    assert.equal(calls[1].method, 'PUT');
    assert.equal(calls[1].url, `${BASE}/preferences`);
    assert.deepEqual(calls[1].body, { quietStart: '22:00', quietEnd: '07:00', timezone: 'America/New_York' });
  });

  it('isForMe: only a push carrying this person\'s scopeHash (and this App, when known)', async () => {
    const { app } = client([{ body: DEVICE }], { appId: 'app-1' });
    assert.equal(await app.push.isForMe({ scopeHash: HASH }), false, 'nothing registered yet');
    await app.push.register('t', 'ios');
    assert.equal(await app.push.isForMe({ scopeHash: HASH, appId: 'app-1', open: '#inbox/1' }), true);
    assert.equal(await app.push.isForMe({ scopeHash: HASH }), true);
    assert.equal(await app.push.isForMe({ scopeHash: 'b'.repeat(32), appId: 'app-1' }), false);
    assert.equal(await app.push.isForMe({ scopeHash: HASH, appId: 'app-2' }), false);
    assert.equal(await app.push.isForMe(null), false);
  });

  it('isForMe: preferences tell the scopeHash too', async () => {
    const { app } = client([{ body: { enabled: true, categories: {}, quietStart: null, quietEnd: null, timezone: null, scopeHash: HASH } }]);
    await app.push.preferences.get();
    assert.equal(await app.push.isForMe({ scopeHash: HASH }), true);
  });

  it('auth.signOut unregisters the device first, then forgets it', async () => {
    const { app, calls, storage } = client([{ body: DEVICE }, { status: 204 }]);
    await app.push.register('tok-1', 'ios');
    await app.auth.signOut();
    assert.equal(calls[1].method, 'DELETE');
    assert.equal(calls[1].url, `${BASE}/devices?token=tok-1`);
    assert.equal(calls[1].headers.Authorization, 'Bearer person-token');
    assert.equal([...storage.m.keys()].some(k => k.endsWith('.push')), false);
    assert.equal(await app.push.isForMe({ scopeHash: HASH }), false);
  });

  it('auth.signOut still signs out when forgetting the device fails', async () => {
    const { app, calls } = client([{ body: DEVICE }, { status: 500, body: { message: 'down' } }]);
    await app.push.register('tok-1', 'ios');
    await app.auth.signOut();
    assert.equal(calls.length, 2);
    assert.equal(await app.push.isForMe({ scopeHash: HASH }), false);
  });

  it('auth.signOut does not wait long on a hanging network', async () => {
    const { app } = client([{ body: DEVICE }, { hang: true }]);
    await app.push.register('tok-1', 'ios');
    const started = Date.now();
    await app.auth.signOut();
    assert.ok(Date.now() - started < 4_500);
  });

  it('auth.signOut with nothing registered makes no call', async () => {
    const { app, calls } = client();
    await app.auth.signOut();
    assert.equal(calls.length, 0);
  });
});
