// Design runs (platform note: ai-runtime docs/credit-design-hold.md): a turn's designRun, the DESIGN_* refusals,
// APP_AI_PAUSED "temporarily unavailable" (retryable), and credits.designRuns get/close. `npm test` builds first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createApp, AiPaused, AppError, CreditsUsedUp, DesignRunRefused, DESIGN_RUN_CODES, DESIGN_RUN_MAX_FIX_TURNS, isDesignRunCode,
  isDesignRunId, TurnFailed,
} from '../dist/app.js';

const RUN = '7f9c2b1e-3d4a-4c5b-8e6f-0a1b2c3d4e5f';
const RUNS = /\/api\/v1\/workflow\/ai-runtime\/sessions\/mine\/credits\/design-runs\//;

/** An App whose fetch answers by URL: a function (url, init) -> Response | [status, body] | body. */
function appWith(route) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
    const answer = route(url, init);
    if (answer instanceof Response) return answer;
    const [status, body] = Array.isArray(answer) ? answer : [200, answer];
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  const app = createApp({ apiUrl: 'https://api.example.test', platformToken: () => 'token', fetch });
  return { app, calls };
}

function sse(events) {
  const text = events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/** A conversation whose turn answers `stream` (a Response, [status, body], or events for an SSE stream). */
async function chatWith(stream) {
  const { app, calls } = appWith(url => {
    if (url.endsWith('/gateway/ai-sessions')) return { success: true, sessionId: 's1', sessionToken: 't1' };
    if (url.includes('/messages/stream')) return Array.isArray(stream) && typeof stream[0] === 'object' ? sse(stream) : stream;
    return [404, {}];
  });
  const conversation = await app.chat.start({ agentId: 'a1' });
  return { app, calls, conversation, turns: () => calls.filter(c => c.url.includes('/messages/stream')) };
}

const UNAVAILABLE = { code: 'APP_AI_PAUSED', reason: 'app_budget', resetAt: '2099-10-28T12:01:00Z', retryable: true,
  retryAfterSeconds: 60, message: 'Temporarily unavailable. Try again in a minute.' };

// ---- sending a turn with a design run ----

test('designRun is sent as designRunId and designFixTurns in the turn body', async () => {
  const { conversation, turns } = await chatWith([{ type: 'token', content: 'ok' }, { type: 'done' }]);
  await conversation.send('a desk', { designRun: { id: RUN, fixTurns: 4 } });
  assert.deepEqual(turns()[0].body, { message: 'a desk', designRunId: RUN, designFixTurns: 4 });
});

test('designRun without fixTurns sends only the id (the platform\'s default); no designRun sends neither', async () => {
  const { conversation, turns } = await chatWith([{ type: 'done' }, { type: 'token', content: 'x' }]);
  await conversation.send('round 1', { designRun: { id: '  run_0001-abc  ' } });
  await conversation.send('plain');
  assert.deepEqual(turns()[0].body, { message: 'round 1', designRunId: 'run_0001-abc' }, 'trimmed, as the platform does');
  assert.deepEqual(turns()[1].body, { message: 'plain' });
  assert.equal('designFixTurns' in turns()[0].body, false);
});

test('fixTurns 0 and the maximum are sent as they are', async () => {
  const { conversation, turns } = await chatWith([{ type: 'done' }]);
  await conversation.send('a', { designRun: { id: RUN, fixTurns: 0 } });
  await conversation.send('b', { designRun: { id: RUN, fixTurns: DESIGN_RUN_MAX_FIX_TURNS } });
  assert.equal(DESIGN_RUN_MAX_FIX_TURNS, 10);
  assert.deepEqual(turns().map(t => t.body.designFixTurns), [0, 10]);
});

test('a bad design run id or fixTurns is refused as DESIGN_RUN_INVALID before anything is sent', async () => {
  const { conversation, turns } = await chatWith([{ type: 'done' }]);
  const bad = [
    { id: 'short' },                       // under 8
    { id: 'x'.repeat(65) },                // over 64
    { id: 'has spaces in it' },
    { id: 'semi;colon;id' },
    { id: '' },
    { id: undefined },
    { id: RUN, fixTurns: 11 },
    { id: RUN, fixTurns: -1 },
    { id: RUN, fixTurns: 1.5 },
    { id: RUN, fixTurns: Number.NaN },
  ];
  for (const designRun of bad) {
    await assert.rejects(conversation.send('a desk', { designRun }), e => {
      assert.ok(e instanceof DesignRunRefused, JSON.stringify(designRun));
      assert.ok(e instanceof AppError);
      assert.equal(e.code, 'DESIGN_RUN_INVALID');
      assert.equal(e.status, 400);
      assert.equal(e.retryable, false);
      return true;
    });
  }
  assert.equal(turns().length, 0, 'nothing sent');
});

test('isDesignRunId: a UUID and 8-64 of [A-Za-z0-9_-]', () => {
  assert.equal(isDesignRunId(RUN), true);
  assert.equal(isDesignRunId('abcdefgh'), true);
  assert.equal(isDesignRunId('A_b-1234'), true);
  assert.equal(isDesignRunId('x'.repeat(64)), true);
  assert.equal(isDesignRunId('x'.repeat(65)), false);
  assert.equal(isDesignRunId('abcdefg'), false);
  assert.equal(isDesignRunId('abc.defgh'), false);
  assert.equal(isDesignRunId(42), false);
});

// ---- the refusals on the stream ----

test('every DESIGN_* error event on the stream throws DesignRunRefused with its code; not a pause', async () => {
  assert.deepEqual([...DESIGN_RUN_CODES], ['DESIGN_HOLDS_BUSY', 'DESIGN_RUN_NOT_YOURS', 'DESIGN_RUN_CLOSED',
    'DESIGN_RUN_FIX_LIMIT', 'DESIGN_RUN_EXPIRED', 'DESIGN_RUN_INVALID']);
  for (const code of DESIGN_RUN_CODES) {
    const { app, conversation } = await chatWith([{ type: 'error', code, reason: 'design_run', message: `words for ${code}`,
      retryable: false, retryAfterSeconds: 0 }]);
    await assert.rejects(conversation.send('fix it', { designRun: { id: RUN } }), e => {
      assert.ok(e instanceof DesignRunRefused, code);
      assert.equal(e.code, code);
      assert.equal(e.reason, 'design_run');
      assert.equal(e.retryable, false);
      assert.equal(e.message, `words for ${code}`);
      assert.equal(e.status, code === 'DESIGN_RUN_INVALID' ? 400 : code === 'DESIGN_RUN_NOT_YOURS' ? 403 : 409);
      assert.equal(e instanceof AiPaused || e instanceof TurnFailed || e instanceof CreditsUsedUp, false);
      return true;
    });
    const status = await app.ai.status();
    assert.equal(status.paused, false, `${code} does not pause AI`);
  }
});

test('a DESIGN_* tag in the words wins over the event\'s code; the words come back without it', async () => {
  const { conversation } = await chatWith([{ type: 'error', code: 'APP_AI_PAUSED', retryable: false,
    message: 'LLM call failed: This design is finished. Start a new design to keep going. [ws:DESIGN_RUN_CLOSED]' }]);
  await assert.rejects(conversation.send('fix it', { designRun: { id: RUN } }), e => {
    assert.ok(e instanceof DesignRunRefused);
    assert.equal(e.code, 'DESIGN_RUN_CLOSED');
    assert.equal(e.message, 'This design is finished. Start a new design to keep going.');
    return true;
  });
});

test('a tag on a generic error event is read too: CREDITS_USED_UP and DESIGN_HOLDS_BUSY', async () => {
  let r = await chatWith([{ type: 'error', code: 'STREAM_ERROR',
    message: 'Error: You’ve used your credits for now. [ws:CREDITS_USED_UP;scope=month;resetAt=2099-11-01T00:00:00Z;plan=plus]' }]);
  await assert.rejects(r.conversation.send('go'), e => e instanceof CreditsUsedUp && e.scope === 'month'
    && e.resetAt === '2099-11-01T00:00:00Z' && e.plan === 'plus' && e.message === 'You’ve used your credits for now.');
  r = await chatWith([{ type: 'error', code: 'STREAM_ERROR', message: '[ws:DESIGN_HOLDS_BUSY]' }]);
  await assert.rejects(r.conversation.send('go', { designRun: { id: RUN } }), e => e instanceof DesignRunRefused
    && e.code === 'DESIGN_HOLDS_BUSY' && /designs in progress/.test(e.message));
});

test('CREDITS_USED_UP for a design run\'s hold is CreditsUsedUp, as before', async () => {
  const { conversation } = await chatWith([{ type: 'error', code: 'CREDITS_USED_UP', reason: 'credits', scope: 'month',
    resetAt: '2099-11-01T00:00:00Z', message: 'You’ve used your credits for now.', retryable: false }]);
  await assert.rejects(conversation.send('a desk', { designRun: { id: RUN, fixTurns: 3 } }), e => e instanceof CreditsUsedUp
    && e.code === 'CREDITS_USED_UP' && !(e instanceof DesignRunRefused));
});

test('APP_AI_PAUSED "temporarily unavailable" on the stream is AiPaused with retryable and retryAfterSeconds', async () => {
  const { conversation } = await chatWith([{ type: 'error', ...UNAVAILABLE }]);
  await assert.rejects(conversation.send('fix it', { designRun: { id: RUN } }), e => {
    assert.ok(e instanceof AiPaused);
    assert.equal(e.code, 'APP_AI_PAUSED');
    assert.equal(e.retryable, true);
    assert.equal(e.retryAfterSeconds, 60);
    assert.equal(e.resetAt, '2099-10-28T12:01:00Z');
    assert.equal(e.scope, undefined);
    return true;
  });
});

test('APP_AI_PAUSED for the App\'s own budget stays not retryable', async () => {
  const { conversation } = await chatWith([{ type: 'error', code: 'APP_AI_PAUSED', reason: 'app_budget', scope: 'month',
    resetAt: '2099-11-01T00:00:00Z', retryable: false, retryAfterSeconds: 99999, message: 'This app’s AI is paused for now.' }]);
  await assert.rejects(conversation.send('go'), e => e instanceof AiPaused && e.retryable === false && e.scope === 'month');
});

test('an APP_AI_PAUSED tag alone: "Temporarily unavailable" reads as retryable', async () => {
  const { conversation } = await chatWith([{ type: 'error', code: 'STREAM_ERROR',
    message: 'LLM call failed: Temporarily unavailable. Try again in a minute. [ws:APP_AI_PAUSED;resetAt=2099-10-28T12:01:00Z]' }]);
  await assert.rejects(conversation.send('go'), e => e instanceof AiPaused && e.retryable === true
    && e.message === 'Temporarily unavailable. Try again in a minute.' && e.resetAt === '2099-10-28T12:01:00Z');
});

test('a turn refused before its stream began (HTTP 429) is AiPaused, retryable; a 403 DESIGN_* body is DesignRunRefused', async () => {
  let r = await chatWith([429, { ...UNAVAILABLE, error: UNAVAILABLE.message }]);
  await assert.rejects(r.conversation.send('go', { designRun: { id: RUN } }), e => e instanceof AiPaused && e.retryable === true
    && e.retryAfterSeconds === 60);
  r = await chatWith([403, { code: 'DESIGN_RUN_NOT_YOURS', message: 'This design can’t be continued. Start a new design.' }]);
  await assert.rejects(r.conversation.send('go', { designRun: { id: RUN } }), e => e instanceof DesignRunRefused
    && e.code === 'DESIGN_RUN_NOT_YOURS' && e.status === 403);
  r = await chatWith([500, { error: 'boom' }]);
  await assert.rejects(r.conversation.send('go'), e => e instanceof AppError && !(e instanceof AiPaused) && e.status === 500);
});

test('isDesignRunCode', () => {
  assert.equal(isDesignRunCode('DESIGN_RUN_EXPIRED'), true);
  assert.equal(isDesignRunCode('DESIGN_RUN_NOT_FOUND'), false, 'not a turn refusal: get() answers null');
  assert.equal(isDesignRunCode('APP_AI_PAUSED'), false);
});

// ---- credits.designRuns ----

test('designRuns.get reads one run as the person', async () => {
  const { app, calls } = appWith(() => ({ runId: RUN, state: 'open', heldCredits: 100, turns: 1, maxTurns: 4, turnsLeft: 3,
    expiresAt: '2026-10-28T13:00:00Z' }));
  const run = await app.credits.designRuns.get(RUN);
  assert.equal(calls[0].method, 'GET');
  assert.match(calls[0].url, new RegExp(`${RUNS.source}${RUN}$`));
  assert.deepEqual(run, { runId: RUN, state: 'open', heldCredits: 100, turns: 1, maxTurns: 4, turnsLeft: 3, expiresAt: '2026-10-28T13:00:00Z' });
});

test('designRuns.get: null for no such run (or an older platform); typed refusals otherwise', async () => {
  let answer = [404, { code: 'DESIGN_RUN_NOT_FOUND', message: 'There is no such design.' }];
  const { app, calls } = appWith(() => answer);
  assert.equal(await app.credits.designRuns.get(RUN), null);
  answer = [404, { error: 'Not Found' }];
  assert.equal(await app.credits.designRuns.get(RUN), null);
  answer = [403, { code: 'DESIGN_RUN_NOT_YOURS', message: 'This design can’t be continued. Start a new design.' }];
  await assert.rejects(app.credits.designRuns.get(RUN), e => e instanceof DesignRunRefused && e.code === 'DESIGN_RUN_NOT_YOURS' && e.status === 403);
  answer = [400, { code: 'DESIGN_RUN_INVALID', message: 'bad' }];
  await assert.rejects(app.credits.designRuns.get(RUN), e => e instanceof DesignRunRefused && e.status === 400);
  answer = [429, { ...UNAVAILABLE, error: UNAVAILABLE.message }];
  await assert.rejects(app.credits.designRuns.get(RUN), e => e instanceof AiPaused && e.retryable === true);
  answer = [404, { code: 'NO_CREDITS', message: 'This app doesn’t use credits.' }];
  await assert.rejects(app.credits.designRuns.get(RUN), e => e instanceof AppError && e.code === 'NO_CREDITS' && !(e instanceof DesignRunRefused));
  const before = calls.length;
  await assert.rejects(app.credits.designRuns.get('nope'), e => e instanceof DesignRunRefused && e.code === 'DESIGN_RUN_INVALID');
  assert.equal(calls.length, before, 'a bad id is never sent');
});

test('designRuns.close sends DELETE; closed, or not_found', async () => {
  let answer = { runId: RUN, state: 'closed' };
  const { app, calls } = appWith(() => answer);
  assert.equal(await app.credits.designRuns.close(RUN), 'closed');
  assert.equal(calls[0].method, 'DELETE');
  assert.match(calls[0].url, new RegExp(`${RUNS.source}${RUN}$`));
  answer = [404, { code: 'DESIGN_RUN_NOT_FOUND', message: 'There is no such design.' }];
  assert.equal(await app.credits.designRuns.close(RUN), 'not_found');
  answer = [429, { ...UNAVAILABLE }];
  await assert.rejects(app.credits.designRuns.close(RUN), e => e instanceof AiPaused && e.retryable === true);
  answer = [403, { code: 'DESIGN_RUN_NOT_YOURS', message: 'x' }];
  await assert.rejects(app.credits.designRuns.close(RUN), e => e instanceof DesignRunRefused && e.code === 'DESIGN_RUN_NOT_YOURS');
  await assert.rejects(app.credits.designRuns.close('bad id!'), e => e instanceof DesignRunRefused && e.code === 'DESIGN_RUN_INVALID');
});
