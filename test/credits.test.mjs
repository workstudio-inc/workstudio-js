// App credits (contract: scratchpad app-credits/contract.md, section 6). `npm test` builds first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, CreditsUsedUp, NotForYourPlan, AppError } from '../dist/app.js';

const BALANCE = {
  unit: { name: 'credits', one: 'credit' }, available: 420,
  monthly: { left: 320, total: 500, period: 'month', resetsOn: '2026-11-01' }, bought: { left: 100 },
  state: 'ok', lowAt: 50, whenEmpty: null, hints: { design: 25, picture: 3 }, plan: 'plus',
};

/** An App whose fetch answers by URL: a function (url, init) -> [status, body] or a body. */
function appWith(route) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
    const answer = route(url, init);
    if (answer instanceof Response) return answer;
    const [status, body] = Array.isArray(answer) ? answer : [200, answer];
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  const opened = [];
  const app = createApp({ apiUrl: 'https://api.example.test', platformToken: () => 'token', fetch, openUrl: url => { opened.push(url); } });
  return { app, calls, opened };
}

function sse(events) {
  const text = events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

test('balance() reads the person\'s credits, caches them 30 s, and tells onChange', async () => {
  const { app, calls } = appWith(() => BALANCE);
  const heard = [];
  app.credits.onChange(c => heard.push(c.available));
  const c = await app.credits.balance();
  assert.match(calls[0].url, /\/api\/v1\/workflow\/ai-runtime\/sessions\/mine\/credits$/);
  assert.equal(c.available, 420);
  assert.deepEqual(c.monthly, { left: 320, total: 500, period: 'month', resetsOn: '2026-11-01' });
  assert.equal(c.bought.left, 100);
  assert.equal(c.state, 'ok');
  await app.credits.balance();
  assert.equal(calls.length, 1, 'cached');
  await app.credits.balance({ maxAgeMs: 0 });
  assert.equal(calls.length, 2);
  assert.deepEqual(heard, [420, 420]);
});

test('a chat turn\'s credits event reaches onChange, the reply and the cached balance', async () => {
  const { app } = appWith(url => {
    if (url.endsWith('/gateway/ai-sessions')) return { success: true, sessionId: 's1', sessionToken: 't1' };
    if (url.includes('/messages/stream')) {
      return sse([
        { type: 'token', content: 'Hi' },
        { type: 'credits', ...BALANCE, available: 413, used: 7 },
        { type: 'done' },
      ]);
    }
    return [404, {}];
  });
  const heard = [];
  app.credits.onChange(c => heard.push([c.available, c.used]));
  const conversation = await app.chat.start({ agentId: 'a1' });
  const reply = await conversation.send('hello');
  assert.equal(reply.text, 'Hi');
  assert.equal(reply.credits.available, 413);
  assert.equal(reply.creditsUsed, 7);
  assert.deepEqual(heard, [[413, 7]]);
  // What the stream says is the cached balance now.
  assert.equal((await app.credits.balance()).available, 413);
});

test('CREDITS_USED_UP on the stream throws CreditsUsedUp, and ai.status says paused for credits', async () => {
  const { app } = appWith(url => {
    if (url.endsWith('/gateway/ai-sessions')) return { success: true, sessionId: 's1', sessionToken: 't1' };
    if (url.includes('/messages/stream')) {
      return sse([{ type: 'error', code: 'CREDITS_USED_UP', reason: 'credits', scope: 'month', resetAt: '2099-11-01T00:00:00Z',
        plan: 'plus', message: 'You’ve used your credits for now.', retryable: false }]);
    }
    return [404, {}];
  });
  const conversation = await app.chat.start({ agentId: 'a1' });
  await assert.rejects(conversation.send('hello'), e => {
    assert.ok(e instanceof CreditsUsedUp);
    assert.equal(e.code, 'CREDITS_USED_UP');
    assert.equal(e.reason, 'credits');
    assert.equal(e.scope, 'month');
    assert.equal(e.resetAt, '2099-11-01T00:00:00Z');
    return true;
  });
  const status = await app.ai.status();
  assert.equal(status.paused, true);
  assert.equal(status.reason, 'credits');
  assert.equal(status.code, 'CREDITS_USED_UP');
});

test('ai.status reads reason credits and scope once from the platform', async () => {
  const { app } = appWith(() => ({ paused: true, reason: 'credits', code: 'CREDITS_USED_UP', scope: 'once', resetAt: null, plan: 'free',
    message: 'You’ve used your starter credits.' }));
  const s = await app.ai.status();
  assert.deepEqual([s.paused, s.reason, s.scope, s.plan], [true, 'credits', 'once', 'free']);
});

test('a picture says its credits; a picture refused for credits is CreditsUsedUp (402) and tells onChange', async () => {
  let refuse = false;
  const { app } = appWith(url => {
    if (url.endsWith('/sessions/mine/images')) {
      return refuse
        ? [402, { code: 'CREDITS_USED_UP', reason: 'credits', scope: 'month', resetAt: '2099-11-01T00:00:00Z', error: 'Out', message: 'Out',
            credits: { ...BALANCE, available: 0, monthly: { ...BALANCE.monthly, left: 0 }, bought: { left: 0 }, state: 'empty' } }]
        : { image: 'data:image/jpeg;base64,AA', model: 'm', size: '1536x1024', costUsd: 0.03, credits: { ...BALANCE, available: 417 }, creditsUsed: 3 };
    }
    return [404, {}];
  });
  const heard = [];
  app.credits.onChange(c => heard.push([c.available, c.state, c.used]));
  const pic = await app.images.make({ images: ['data:image/png;base64,AA'], prompt: 'a photo' });
  assert.equal(pic.creditsUsed, 3);
  refuse = true;
  await assert.rejects(app.images.make({ images: ['data:image/png;base64,AA'], prompt: 'a photo' }), e => e instanceof CreditsUsedUp && e.status === 402);
  assert.deepEqual(heard, [[417, 'ok', 3], [0, 'empty', undefined]]);
});

test('estimate() asks for about N credits', async () => {
  const { app, calls } = appWith(() => ({ action: 'picture', credits: 3, basis: 'price' }));
  const e = await app.credits.estimate('picture', { size: '1536x1024' });
  assert.equal(e.credits, 3);
  assert.match(calls[0].url, /\/sessions\/mine\/credits\/estimate\?action=picture&size=1536x1024$/);
});

test('packs() and buy(): web Checkout, opened unless redirect is false; Free is NotForYourPlan; native is not yet', async () => {
  const PACKS = { unit: BALANCE.unit, packs: [{ id: 'small', credits: 200, web: { priceId: 'price_s', amount: 499, currency: 'usd' } }],
    canBuy: true, why: null, message: null, forPlans: ['plus', 'pro'], bought: 100, linkOut: null };
  let plan = 'plus';
  const { app, calls, opened } = appWith((url, init) => {
    if (url.includes('/credits/packs')) return PACKS;
    if (url.endsWith('/credits/checkout')) {
      return plan === 'plus' ? { url: 'https://checkout.stripe.com/c/pay/cs_pack' }
        : [403, { code: 'NOT_FOR_YOUR_PLAN', message: 'Credit packs come with Plus and Pro.' }];
    }
    return [404, {}];
  });
  const packs = await app.credits.packs();
  assert.match(calls[0].url, /\/connection\/end-users\/me\/credits\/packs\?platform=web$/);
  assert.equal(packs.packs[0].web.amount, 499);
  const { url } = await app.credits.buy('small', { successUrl: 'https://crava.me/#credits' });
  assert.equal(url, 'https://checkout.stripe.com/c/pay/cs_pack');
  assert.deepEqual(calls[1].body, { packId: 'small', successUrl: 'https://crava.me/#credits' });
  assert.deepEqual(opened, ['https://checkout.stripe.com/c/pay/cs_pack']);
  await app.credits.buy('small', { redirect: false });
  assert.equal(opened.length, 1);
  plan = 'free';
  await assert.rejects(app.credits.buy('small'), e => e instanceof NotForYourPlan && e.message === 'Credit packs come with Plus and Pro.');
  await assert.rejects(app.credits.buy('small', { platform: 'ios' }), e => e instanceof AppError && e.code === 'IN_APP_NOT_YET');
});

test('history() pages the bought credits', async () => {
  const { app, calls } = appWith(() => ({ entries: [{ id: 'e1', at: '2026-10-24T18:02:11Z', kind: 'PURCHASE', credits: 450, label: 'Bought 450', packId: 'medium' }], next: 'c2' }));
  const h = await app.credits.history({ cursor: 'c1', limit: 10 });
  assert.match(calls[0].url, /\/credits\/history\?cursor=c1&limit=10$/);
  assert.equal(h.entries[0].label, 'Bought 450');
  assert.equal(h.next, 'c2');
});

test('the deletion check carries the unused bought credits', async () => {
  const { app } = appWith(() => ({ storeSubscriptions: [], appleSubscription: false, googleSubscription: false, credits: { bought: 340, name: 'credits' } }));
  const check = await app.account.deletionCheck();
  assert.deepEqual(check.credits, { bought: 340, name: 'credits' });
});
