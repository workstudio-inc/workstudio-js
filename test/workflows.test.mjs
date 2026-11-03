// app.workflows against a stubbed fetch. Runs on the built package (npm test builds first), so it checks what is
// published: the ./app entry, its exports and the requests it makes.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AiPaused, AppError, WaitTimeout, Workflows, createApp, isRunDone } from '../dist/app.js';

const API = 'https://api.example.test';
const BASE = `${API}/api/v1/workflow/connection/end-users/me`;

/**
 * A client whose fetch records each call and answers from `replies` in turn (default 200 `{}`). A reply may be a
 * function of the call number, or `{ throws: true }` for a network failure.
 */
function client(...replies) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers ?? {}, body: init.body === undefined ? undefined : JSON.parse(init.body), at: Date.now() });
    let r = replies.shift() ?? { status: 200, body: {} };
    if (typeof r === 'function') r = r(calls.length);
    if (r.throws) throw new TypeError('fetch failed');
    return new Response(r.status === 204 ? null : JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { 'Content-Type': 'application/json', ...(r.headers ?? {}) },
    });
  };
  const app = createApp({ apiUrl: `${API}/`, platformToken: () => 'person-token', fetch });
  return { app, calls };
}

function assertCall(call, method, url, body) {
  assert.equal(call.method, method);
  assert.equal(call.url, url);
  assert.equal(call.headers.Authorization, 'Bearer person-token');
  assert.deepEqual(call.body, body);
}

const run = (status, extra = {}) => ({
  body: { id: 'r1', workflow: 'export-report', status, done: ['FINISHED', 'FAILED', 'CANCELLED', 'TERMINATED'].includes(status),
    createdAt: '2026-10-26T10:00:00Z', ...extra },
});

describe('app.workflows', () => {
  it('is on the App client and exported', () => {
    const { app } = client();
    assert.ok(app.workflows instanceof Workflows);
    assert.equal(typeof WaitTimeout, 'function');
    assert.equal(isRunDone({ status: 'FAILED', done: false }), true);
    assert.equal(isRunDone({ status: 'WAITING_HUMAN', done: false }), false);
  });

  it('available: what this person may run now', async () => {
    const workflows = [
      { key: 'export-report', description: 'Monthly PDF', allowed: true, limit: { perDay: 20, usedToday: 3, resetsAt: '2026-10-27T00:00:00Z' } },
      { key: 'deep-audit', allowed: false, reason: 'NEEDS_PLAN', limit: { perDay: 50, usedToday: 0, resetsAt: '2026-10-27T00:00:00Z' } },
    ];
    const { app, calls } = client({ body: { workflows } });
    assert.deepEqual(await app.workflows.available(), workflows);
    assertCall(calls[0], 'GET', `${BASE}/workflows`, undefined);
  });

  it('run: the key in the path (encoded), input and idempotencyKey in the body', async () => {
    const { app, calls } = client({ status: 202, ...run('QUEUED') }, { status: 202, ...run('QUEUED') }, { status: 200, ...run('QUEUED') });
    const r = await app.workflows.run('export-report', { month: '2026-10' }, { idempotencyKey: 'tap-1' });
    assert.equal(r.id, 'r1');
    assert.equal(r.status, 'QUEUED');
    await app.workflows.run('a/b c');
    await app.workflows.run('export-report', { month: '2026-10' }, { idempotencyKey: 'tap-1' });
    assertCall(calls[0], 'POST', `${BASE}/workflows/export-report/runs`, { input: { month: '2026-10' }, idempotencyKey: 'tap-1' });
    assert.equal(calls[0].headers['Content-Type'], 'application/json');
    assertCall(calls[1], 'POST', `${BASE}/workflows/a%2Fb%20c/runs`, {});
    assertCall(calls[2], 'POST', `${BASE}/workflows/export-report/runs`, { input: { month: '2026-10' }, idempotencyKey: 'tap-1' });
  });

  it('run: an empty key is refused without a call', async () => {
    const { app, calls } = client();
    await assert.rejects(app.workflows.run('  '), e => e instanceof AppError && e.code === 'WORKFLOW_NOT_FOUND');
    await assert.rejects(app.workflows.get(''), e => e instanceof AppError && e.code === 'RUN_NOT_FOUND');
    assert.equal(calls.length, 0);
  });

  it('get: one run, with its output once FINISHED', async () => {
    const { app, calls } = client(run('FINISHED', { output: { url: 'https://x/report.pdf' }, finishedAt: '2026-10-26T10:01:00Z' }));
    const r = await app.workflows.get('run/1');
    assert.deepEqual(r.output, { url: 'https://x/report.pdf' });
    assert.equal(r.done, true);
    assertCall(calls[0], 'GET', `${BASE}/workflow-runs/run%2F1`, undefined);
  });

  it('list: query params only when given, and the page', async () => {
    const { app, calls } = client(
      { body: { runs: [run('RUNNING').body], nextCursor: 'c2' } },
      { body: { runs: [] } },
    );
    const page = await app.workflows.list({ workflow: 'export-report', limit: 10, cursor: 'c1' });
    assert.equal(page.runs.length, 1);
    assert.equal(page.nextCursor, 'c2');
    const last = await app.workflows.list();
    assert.deepEqual(last, { runs: [] });
    assertCall(calls[0], 'GET', `${BASE}/workflow-runs?workflow=export-report&limit=10&cursor=c1`, undefined);
    assertCall(calls[1], 'GET', `${BASE}/workflow-runs`, undefined);
  });

  it('a refusal is an AppError with its code; a 429 carries Retry-After', async () => {
    const { app } = client(
      { status: 429, headers: { 'Retry-After': '3600' }, body: { code: 'DAILY_LIMIT', message: 'You have run this 20 times today.' } },
      { status: 400, body: { code: 'INPUT_INVALID', message: 'month: does not match the pattern' } },
      { status: 404, body: { code: 'RUN_NOT_FOUND', message: 'No such run.' } },
      { status: 409, body: { code: 'IDEMPOTENCY_CONFLICT', message: 'That key was used for another workflow.' } },
    );
    await assert.rejects(app.workflows.run('export-report', {}), e =>
      e instanceof AppError && e.status === 429 && e.code === 'DAILY_LIMIT' && e.retryAfter === 3600 && e.message === 'You have run this 20 times today.');
    await assert.rejects(app.workflows.run('export-report', { month: 'x' }), e =>
      e instanceof AppError && e.status === 400 && e.code === 'INPUT_INVALID' && e.retryAfter === undefined);
    await assert.rejects(app.workflows.get('nope'), e => e instanceof AppError && e.status === 404 && e.code === 'RUN_NOT_FOUND');
    await assert.rejects(app.workflows.run('other', {}, { idempotencyKey: 'k' }), e => e.code === 'IDEMPOTENCY_CONFLICT' && e.status === 409);
  });

  it('Retry-After as an HTTP date is seconds from now', async () => {
    const at = new Date(Date.now() + 90_000).toUTCString();
    const { app } = client({ status: 429, headers: { 'Retry-After': at }, body: { code: 'TOO_MANY_RUNNING', message: 'Five runs are going.' } });
    await assert.rejects(app.workflows.run('export-report'), e => e.code === 'TOO_MANY_RUNNING' && e.retryAfter > 80 && e.retryAfter <= 90);
  });

  it('the App AI budget refusal is AiPaused, resetAt from Retry-After, and ai.status() says paused', async () => {
    const { app } = client({ status: 429, headers: { 'Retry-After': '600' }, body: { code: 'APP_AI_PAUSED', message: 'AI is paused in this app.' } });
    await assert.rejects(app.workflows.run('export-report'), e =>
      e instanceof AiPaused && e instanceof AppError && e.code === 'APP_AI_PAUSED' && e.reason === 'app_budget' && Date.parse(e.resetAt) > Date.now());
    const s = await app.ai.status();
    assert.equal(s.paused, true);
    assert.equal(s.code, 'APP_AI_PAUSED');
  });
});

describe('app.workflows.wait', () => {
  it('polls with backoff (x1.5, capped) and stops at a terminal status with the output', async () => {
    const { app, calls } = client(run('RUNNING'), run('RUNNING'), run('RUNNING'), run('RUNNING'), run('FINISHED', { output: { ok: true } }));
    const updates = [];
    const started = Date.now();
    const r = await app.workflows.wait(run('QUEUED').body, { intervalMs: 20, maxIntervalMs: 40, onUpdate: u => updates.push(u.status) });
    assert.equal(r.status, 'FINISHED');
    assert.deepEqual(r.output, { ok: true });
    assert.equal(calls.length, 5);
    for (const c of calls) assertCall(c, 'GET', `${BASE}/workflow-runs/r1`, undefined);
    // Waits 20, 30, 40, 40, 40 (cap): the first poll comes after the first interval.
    assert.ok(calls[0].at - started >= 15, `first poll after ${calls[0].at - started} ms`);
    const gaps = calls.slice(1).map((c, i) => c.at - calls[i].at);
    assert.ok(gaps[0] >= 25, `second gap ${gaps[0]}`);
    assert.ok(gaps.every(g => g < 200), `gaps ${gaps}`);
    // Only changes are reported: QUEUED (given) -> RUNNING -> FINISHED.
    assert.deepEqual(updates, ['RUNNING', 'FINISHED']);
  });

  it('by id: reads at once, and a FAILED run resolves with its error', async () => {
    const { app, calls } = client(run('FAILED', { error: 'The report service said no.' }));
    const updates = [];
    const r = await app.workflows.wait('r1', { intervalMs: 5000, onUpdate: u => updates.push(u.status) });
    assert.equal(r.status, 'FAILED');
    assert.equal(r.error, 'The report service said no.');
    assert.equal(calls.length, 1);
    assert.deepEqual(updates, ['FAILED']);
  });

  it('stops at WAITING_HUMAN by default', async () => {
    const { app, calls } = client(run('RUNNING'), run('WAITING_HUMAN', { waiting: { type: 'HUMAN', label: 'Approve the report' } }), run('FINISHED'));
    const r = await app.workflows.wait('r1', { intervalMs: 5 });
    assert.equal(r.status, 'WAITING_HUMAN');
    assert.equal(r.waiting.type, 'HUMAN');
    assert.equal(calls.length, 2);
  });

  it('untilWaiting: false goes on past WAITING_HUMAN', async () => {
    const { app, calls } = client(run('WAITING_HUMAN'), run('WAITING_HUMAN'), run('RUNNING'), run('FINISHED', { output: 1 }));
    const updates = [];
    const r = await app.workflows.wait('r1', { intervalMs: 5, untilWaiting: false, onUpdate: u => updates.push(u.status) });
    assert.equal(r.status, 'FINISHED');
    assert.equal(calls.length, 4);
    assert.deepEqual(updates, ['WAITING_HUMAN', 'RUNNING', 'FINISHED']);
  });

  it('a run handed over already done is answered without a poll; a list item FINISHED without output is read', async () => {
    const { app, calls } = client(run('FINISHED', { output: { ok: 1 } }));
    const failed = run('FAILED', { error: 'x' }).body;
    assert.equal(await app.workflows.wait(failed), failed);
    assert.equal(calls.length, 0);
    const r = await app.workflows.wait(run('FINISHED').body, { intervalMs: 5000 });
    assert.deepEqual(r.output, { ok: 1 });
    assert.equal(calls.length, 1);
  });

  it('a network failure or 5xx while polling is tried again; another refusal rejects', async () => {
    const { app, calls } = client({ throws: true }, { status: 503, body: { code: 'UNAVAILABLE', message: 'Try again.' } }, run('FINISHED', { output: 2 }));
    const r = await app.workflows.wait('r1', { intervalMs: 5 });
    assert.equal(r.output, 2);
    assert.equal(calls.length, 3);

    const other = client({ status: 404, body: { code: 'RUN_NOT_FOUND', message: 'No such run.' } });
    await assert.rejects(other.app.workflows.wait('r9', { intervalMs: 5 }), e => e instanceof AppError && e.code === 'RUN_NOT_FOUND');
  });

  it('out of time: WaitTimeout (code WAIT_TIMEOUT) carrying the last run', async () => {
    const replies = Array.from({ length: 100 }, () => run('RUNNING', { startedAt: '2026-10-26T10:00:01Z' }));
    const { app, calls } = client(...replies);
    const started = Date.now();
    await assert.rejects(app.workflows.wait('r1', { intervalMs: 10, maxIntervalMs: 20, timeoutMs: 120 }), e => {
      assert.ok(e instanceof WaitTimeout);
      assert.ok(e instanceof AppError);
      assert.equal(e.code, 'WAIT_TIMEOUT');
      assert.equal(e.run.id, 'r1');
      assert.equal(e.run.status, 'RUNNING');
      return true;
    });
    const took = Date.now() - started;
    assert.ok(took >= 110 && took < 1000, `took ${took} ms`);
    assert.ok(calls.length >= 3 && calls.length < 20, `${calls.length} polls`);
  });

  it('abort: rejects with the signal reason and polls no more', async () => {
    const { app, calls } = client(...Array.from({ length: 100 }, () => run('RUNNING')));
    const ac = new AbortController();
    const waiting = app.workflows.wait('r1', { intervalMs: 10, maxIntervalMs: 10, signal: ac.signal });
    setTimeout(() => ac.abort(), 35);
    await assert.rejects(waiting, e => e.name === 'AbortError');
    const polled = calls.length;
    await new Promise(r => setTimeout(r, 50));
    assert.equal(calls.length, polled);
    assert.ok(polled >= 1);

    const pre = new AbortController();
    pre.abort();
    await assert.rejects(app.workflows.wait('r1', { signal: pre.signal }), e => e.name === 'AbortError');
  });
});
