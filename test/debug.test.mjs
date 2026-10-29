// The debug hook: with `debug` on, every request the SDK makes is reported once answered - method, URL path, status,
// time and a refusal's code - and never a header, a body or the query string. Runs on the built package.
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { createApp, describeRequest } from '../dist/app.js';

const API = 'https://api.example.test';
const TOKEN = 'person-token-abc123';

/** A fetch that answers from `replies` in turn (default 200 `{}`), or throws for `{ fail: true }`. */
function fetcher(replies = []) {
  return async () => {
    const r = replies.shift() ?? { status: 200, body: {} };
    if (r.fail) throw new TypeError('Failed to fetch');
    return new Response(r.text ?? JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  };
}

afterEach(() => {
  delete process.env.WORKSTUDIO_DEBUG;
  delete globalThis.localStorage;
});

describe('debug', () => {
  it('reports each data call with its method, path, status and time - not the query, a header or a body', async () => {
    const seen = [];
    const app = createApp({ apiUrl: API, platformToken: () => TOKEN, fetch: fetcher([{ body: { records: [{ id: '1', data: { text: 'secret note' } }] } }, { body: { id: '2', data: {} } }]), debug: e => seen.push(e) });
    await app.data.collection('notes').find({ limit: 5, where: { text: 'private words' } });
    await app.data.collection('notes').create({ text: 'more private words' });
    assert.equal(seen.length, 2);
    assert.deepEqual({ ...seen[0], ms: 0 }, { method: 'GET', url: `${API}/api/v1/workflow/data/collections/notes/records`, status: 200, ms: 0 });
    assert.equal(seen[1].method, 'POST');
    assert.equal(seen[1].url, `${API}/api/v1/workflow/data/collections/notes/records`);
    assert.equal(typeof seen[0].ms, 'number');
    const all = JSON.stringify(seen);
    for (const leak of [TOKEN, 'private words', 'secret note', 'limit=5', 'Bearer']) assert.equal(all.includes(leak), false, leak);
  });

  it('carries the platform\'s code on a refusal, and the SDK still reads the body and throws as before', async () => {
    const seen = [];
    const app = createApp({
      apiUrl: API, platformToken: () => TOKEN, debug: e => seen.push(e),
      fetch: fetcher([{ status: 409, body: { error: 'The store has no credentials', code: 'STORE_CREDENTIALS_NOT_CONFIGURED' } }, { status: 403, body: { error: "This App does not keep data in 'notes'" } }]),
    });
    await assert.rejects(app.data.collection('notes').find(), e => e.status === 409 && e.code === 'STORE_CREDENTIALS_NOT_CONFIGURED');
    await assert.rejects(app.data.collection('notes').find(), e => e.status === 403 && e.message === "This App does not keep data in 'notes'");
    assert.equal(seen[0].code, 'STORE_CREDENTIALS_NOT_CONFIGURED');
    assert.equal(seen[0].status, 409);
    // A message is not a code: only a short identifier is taken from `error`.
    assert.equal(seen[1].code, undefined);
  });

  it('reports a request that got no answer as status 0, and the SDK still says NETWORK', async () => {
    const seen = [];
    const app = createApp({ apiUrl: API, platformToken: () => TOKEN, fetch: fetcher([{ fail: true }]), debug: e => seen.push(e) });
    await assert.rejects(app.data.collection('notes').find(), e => e.code === 'NETWORK');
    assert.equal(seen[0].status, 0);
  });

  it('writes one console line per request with debug: true - a warning for a refusal', async () => {
    const lines = { debug: [], warn: [] };
    const original = { debug: console.debug, warn: console.warn };
    console.debug = l => lines.debug.push(l);
    console.warn = l => lines.warn.push(l);
    try {
      const app = createApp({ apiUrl: API, platformToken: () => TOKEN, fetch: fetcher([{}, { status: 404, text: 'Endpoint not found' }]), debug: true });
      await app.data.collection('notes').find();
      await assert.rejects(app.data.collection('notes').find());
    } finally {
      Object.assign(console, original);
    }
    assert.match(lines.debug[0], /^\[workstudio\] GET https:\/\/api\.example\.test\/api\/v1\/workflow\/data\/collections\/notes\/records -> 200 \(\d+ ms\)$/);
    assert.match(lines.warn[0], /-> 404 \(\d+ ms\)$/);
  });

  it('turns on with WORKSTUDIO_DEBUG=1 or localStorage workstudio:debug, and debug: false keeps it off', async () => {
    const lines = [];
    const original = console.debug;
    console.debug = l => lines.push(l);
    try {
      await createApp({ apiUrl: API, platformToken: () => TOKEN, fetch: fetcher() }).data.collection('a').find();
      assert.equal(lines.length, 0);
      process.env.WORKSTUDIO_DEBUG = '1';
      await createApp({ apiUrl: API, platformToken: () => TOKEN, fetch: fetcher() }).data.collection('b').find();
      assert.equal(lines.length, 1);
      await createApp({ apiUrl: API, platformToken: () => TOKEN, fetch: fetcher(), debug: false }).data.collection('c').find();
      assert.equal(lines.length, 1);
      delete process.env.WORKSTUDIO_DEBUG;
      globalThis.localStorage = { getItem: k => (k === 'workstudio:debug' ? '1' : null) };
      await createApp({ apiUrl: API, platformToken: () => TOKEN, fetch: fetcher() }).data.collection('d').find();
      assert.equal(lines.length, 2);
      assert.match(lines[1], /collections\/d\/records -> 200/);
    } finally {
      console.debug = original;
    }
  });

  it('never fails a call because the reporter threw', async () => {
    const app = createApp({ apiUrl: API, platformToken: () => TOKEN, fetch: fetcher([{ body: { records: [] } }]), debug: () => { throw new Error('reporter broke'); } });
    assert.deepEqual(await app.data.collection('notes').find(), []);
  });

  it('describes a request on one line', () => {
    assert.equal(describeRequest({ method: 'POST', url: `${API}/api/v1/workflow/connection/oauth/token`, status: 403, code: 'invalid_target', ms: 31 }),
      `[workstudio] POST ${API}/api/v1/workflow/connection/oauth/token -> 403 invalid_target (31 ms)`);
    assert.equal(describeRequest({ method: 'GET', url: `${API}/x`, status: 0, ms: 5 }), `[workstudio] GET ${API}/x -> no answer (5 ms)`);
  });
});
