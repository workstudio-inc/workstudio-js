// A design turn survives a page reload: chat.isRunning / chat.reconnect / chat.turn. `npm test` builds first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, SignInRequired } from '../dist/app.js';

const MINE = /\/api\/v1\/workflow\/ai-runtime\/sessions\/mine\/s1/;

/** An App whose fetch answers by URL: a function (url, init, n) -> Response | [status, body] | body. */
function appWith(route) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', auth: init.headers?.Authorization });
    const answer = route(url, init, calls.length);
    if (answer instanceof Response) return answer;
    const [status, body] = Array.isArray(answer) ? answer : [200, answer];
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  const app = createApp({ apiUrl: 'https://api.example.test', platformToken: () => 'person-token', fetch });
  return { app, calls };
}

function sse(events) {
  const text = events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const COMPLETED = { turnId: 't1', sessionId: 's1', status: 'completed', startedAt: 1, endedAt: 2, content: 'the desk',
  turnRef: 'r1', chargedUsd: 0.21, refunded: false, refundPending: false, notCharged: false };

test('isRunning asks the platform as the person, by conversation id or object', async () => {
  const { app, calls } = appWith(url => (url.endsWith('/running') ? { running: true, turnId: 't1' } : [404, {}]));
  assert.equal(await app.chat.isRunning('s1'), true);
  assert.equal(await app.chat.isRunning({ id: 's1' }), true);
  assert.match(calls[0].url, /sessions\/mine\/s1\/running$/);
  assert.equal(calls[0].auth, 'Bearer person-token', 'the person\'s own token - no session token kept from before');
});

test('isRunning is false for a conversation that is not theirs (404)', async () => {
  const { app } = appWith(() => [404, { error: 'not found' }]);
  assert.equal(await app.chat.isRunning('s1'), false);
});

test('reconnect to a running turn streams the rest: the replay first, then new pieces, then the outcome', async () => {
  const { app } = appWith(url => {
    if (url.endsWith('/stream/reconnect')) {
      return sse([
        { type: 'reconnect', content: 'the ' },
        { type: 'token', content: 'desk' },
        { type: 'allowance', turnRef: 'r1' },
        { type: 'done' },
      ]);
    }
    if (url.endsWith('/turn')) return COMPLETED;
    return [404, {}];
  });
  const pieces = [];
  const outcome = await app.chat.reconnect('s1', { onText: p => pieces.push(p) });
  assert.deepEqual(pieces, ['the ', 'desk']);
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.text, 'the desk');
  assert.equal(outcome.turnRef, 'r1');
  assert.equal(outcome.chargedUsd, 0.21);
  assert.equal(outcome.notCharged, false);
});

test('reconnect after the turn finished ends at once with its outcome', async () => {
  const failed = { turnId: 't2', sessionId: 's1', status: 'failed', code: 'MODEL_TIMEOUT', message: 'No response came',
    retryable: true, turnRef: 'r2', chargedUsd: 0, refunded: true, refundPending: false, notCharged: true };
  const { app, calls } = appWith(url => (url.endsWith('/stream/reconnect')
    ? sse([{ type: 'turn_outcome', ...failed }, { type: 'no_active_turn' }]) : [404, {}]));
  const outcome = await app.chat.reconnect('s1');
  assert.equal(calls.length, 1);
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.code, 'MODEL_TIMEOUT');
  assert.equal(outcome.refunded, true);
  assert.equal(outcome.notCharged, true);
});

test('another server runs the turn: the SDK asks again until it ends, never sending the message again', async () => {
  let reconnects = 0;
  const { app, calls } = appWith(url => {
    if (url.endsWith('/stream/reconnect')) {
      reconnects++;
      return reconnects < 3
        ? sse([{ type: 'turn_running', turnId: 't1', pollAfterMs: 1 }])
        : sse([{ type: 'turn_outcome', ...COMPLETED }, { type: 'no_active_turn' }]);
    }
    return [404, {}];
  });
  const outcome = await app.chat.reconnect('s1');
  assert.equal(reconnects, 3);
  assert.equal(outcome.text, 'the desk');
  assert.ok(calls.every(c => !/messages\/stream$/.test(c.url)), 'never re-sends');
});

test('a stream dropped mid-reply is reattached, and nothing already shown is shown twice', async () => {
  let n = 0;
  const { app } = appWith(url => {
    if (url.endsWith('/stream/reconnect')) {
      n++;
      return n === 1
        ? sse([{ type: 'reconnect', content: 'the ' }, { type: 'token', content: 'de' }]) // closed with no ending
        : sse([{ type: 'reconnect', content: 'the de' }, { type: 'token', content: 'sk' }, { type: 'done' }]);
    }
    if (url.endsWith('/turn')) return COMPLETED;
    return [404, {}];
  });
  const pieces = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => realSetTimeout(fn, 0); // the 2 s wait between attempts, made instant
  try {
    const outcome = await app.chat.reconnect('s1', { onText: p => pieces.push(p) });
    assert.equal(outcome.text, 'the desk');
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(pieces.join(''), 'the desk');
});

test('no turn on record: null', async () => {
  const { app } = appWith(url => (url.endsWith('/stream/reconnect') ? sse([{ type: 'no_active_turn' }]) : [404, {}]));
  assert.equal(await app.chat.reconnect('s1'), null);
});

test('not their conversation: reconnect and turn give null (404), never another person\'s turn', async () => {
  const { app } = appWith(() => [404, { error: 'not found' }]);
  assert.equal(await app.chat.reconnect('s1'), null);
  assert.equal(await app.chat.turn('s1'), null);
});

test('turn() reads the latest turn, or one by id, with the charge and refund', async () => {
  const { app, calls } = appWith(url => {
    if (url.endsWith('/turns/t9')) {
      return { turnId: 't9', status: 'cancelled', code: 'CANCELLED', turnRef: 'r9', chargedUsd: 0.05,
        refunded: false, refundPending: false, notCharged: false };
    }
    if (url.endsWith('/turn')) return COMPLETED;
    return [404, {}];
  });
  const latest = await app.chat.turn('s1');
  assert.equal(latest.text, 'the desk');
  const one = await app.chat.turn('s1', 't9');
  assert.equal(one.status, 'cancelled');
  assert.equal(one.chargedUsd, 0.05);
  assert.match(calls[1].url, MINE);
});

test('a refused sign-in is SignInRequired, as everywhere else', async () => {
  const { app } = appWith(() => [401, {}]);
  await assert.rejects(app.chat.reconnect('s1'), SignInRequired);
});

test('stop() stops the turn as the person, wherever it runs, and says which', async () => {
  const answers = ['stopping', 'stopped', 'not_running'];
  const { app, calls } = appWith(url => (url.endsWith('/stop') ? { result: answers.shift() } : [404, {}]));
  assert.equal(await app.chat.stop('s1'), 'stopping');
  assert.equal(await app.chat.stop({ id: 's1' }), 'stopped');
  assert.equal(await app.chat.stop('s1'), 'not_running');
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].url, /sessions\/mine\/s1\/stop$/);
  assert.equal(calls[0].auth, 'Bearer person-token');
});

test('stop() on a conversation that is not theirs: not_running (404), nothing stopped', async () => {
  const { app } = appWith(() => [404, { error: 'not found' }]);
  assert.equal(await app.chat.stop('s1'), 'not_running');
});
