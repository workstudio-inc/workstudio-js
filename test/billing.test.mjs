// `npm test` builds first, then runs node's own test runner against the built package.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../dist/app.js';

function appWith(answer) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const app = createApp({ apiUrl: 'https://api.example.test', platformToken: () => 'token', fetch });
  return { app, calls };
}

test('checkout sends trial: false when the person buys now', async () => {
  const { app, calls } = appWith({ url: 'https://checkout.stripe.com/c/pay/cs_1', trialDays: null });
  const url = await app.billing.checkout({ priceId: 'price_123', trial: false, open: false });
  assert.equal(url, 'https://checkout.stripe.com/c/pay/cs_1');
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].url, /\/api\/v1\/workflow\/connection\/end-users\/me\/checkout$/);
  assert.deepEqual(calls[0].body, { priceId: 'price_123', trial: false });
});

test('checkout leaves trial out unless asked, and never sends open', async () => {
  const { app, calls } = appWith({ url: 'https://checkout.stripe.com/c/pay/cs_2', trialDays: 14 });
  await app.billing.checkout({ priceId: 'price_123', successUrl: 'https://crava.me/#pro', open: false });
  assert.deepEqual(calls[0].body, { priceId: 'price_123', successUrl: 'https://crava.me/#pro' });
});

test('checkout sends trial: true when asked', async () => {
  const { app, calls } = appWith({ url: 'https://checkout.stripe.com/c/pay/cs_3', trialDays: 14 });
  await app.billing.checkout({ priceId: 'price_123', trial: true, open: false });
  assert.deepEqual(calls[0].body, { priceId: 'price_123', trial: true });
});

test('plan() exposes the trial fields', async () => {
  const answer = {
    enabled: true, plan: 'pro', name: 'Pro', monthlyBudgetUsd: 20, paid: true, status: 'trialing',
    renewsAt: '2026-11-06T12:00:00Z', endsAt: null, cancelAtPeriodEnd: false, canUpgrade: false, canManage: true,
    defaultPlan: 'free',
    plans: [
      { id: 'free', name: 'Free', monthlyBudgetUsd: 1, prices: [], features: [], trialDays: null, trialAvailable: false },
      { id: 'pro', name: 'Pro', monthlyBudgetUsd: 20, features: ['sell'], trialDays: 14, trialAvailable: false,
        prices: [{ id: 'price_pro', interval: 'month', amountCents: 4900, currency: 'usd' }] },
    ],
    features: ['sell'], trialEndsAt: '2026-11-06T12:00:00Z', hasPaymentMethod: false,
  };
  const { app, calls } = appWith(answer);
  const plan = await app.billing.plan();
  assert.match(calls[0].url, /\/connection\/end-users\/me\/plan$/);
  assert.equal(plan.trialEndsAt, '2026-11-06T12:00:00Z');
  assert.equal(plan.hasPaymentMethod, false);
  assert.equal(plan.plans[1].trialDays, 14);
  assert.equal(plan.plans[1].trialAvailable, false);
});

test('plan() carries the monthly AI limit as enforced: the platform default, and the publisher unlimited', async () => {
  const flat = { enabled: false, plan: null, name: null, paid: false, status: null, renewsAt: null, endsAt: null,
    cancelAtPeriodEnd: false, canUpgrade: false, canManage: false, defaultPlan: null, plans: [], features: [] };
  const byDefault = await appWith({ ...flat, monthlyBudgetUsd: 5, monthlyBudgetSource: 'PLATFORM_DEFAULT', unlimited: false })
    .app.billing.plan();
  assert.equal(byDefault.monthlyBudgetUsd, 5);
  assert.equal(byDefault.monthlyBudgetSource, 'PLATFORM_DEFAULT');
  assert.equal(byDefault.unlimited, false);
  const none = await appWith({ ...flat, monthlyBudgetUsd: null, monthlyBudgetSource: 'UNLIMITED', unlimited: true })
    .app.billing.plan();
  assert.equal(none.monthlyBudgetUsd, null);
  assert.equal(none.unlimited, true);
  // An older server says neither: the fields are simply absent.
  const older = await appWith({ ...flat, monthlyBudgetUsd: 7 }).app.billing.plan();
  assert.equal(older.monthlyBudgetSource, undefined);
  assert.equal(older.unlimited, undefined);
});
