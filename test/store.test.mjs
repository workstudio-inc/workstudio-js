// app.billing.store (App Store and Google Play) against a stubbed fetch. Runs on the built package (npm test builds
// first), so it checks what is published: the ./app entry, its exports and the requests it makes.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AppError, BillingUnavailable, SignInRequired, StoreBilling, StorePurchaseOtherAccount, TooManyPurchases, TooManyTries, createApp, manageTarget,
} from '../dist/app.js';

const API = 'https://api.example.test';
const ME = `${API}/api/v1/workflow/connection/end-users/me`;

/** A client whose fetch records each call and answers from `replies` in turn (default 200 `{}`). */
function client(replies = []) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const r = replies.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  };
  const app = createApp({ apiUrl: API, platformToken: () => 'person-token', fetch });
  return { app, calls };
}

const PLAN = {
  enabled: true, plan: 'pro', name: 'Crava Pro', monthlyBudgetUsd: 8, paid: true, status: 'active', renewsAt: '2026-11-23T00:00:00Z',
  endsAt: null, cancelAtPeriodEnd: false, canUpgrade: false, canManage: true, defaultPlan: 'free', plans: [], features: ['full_plans'],
  trialEndsAt: null, hasPaymentMethod: true, source: 'apple',
  manage: { kind: 'apple', url: 'https://apps.apple.com/account/subscriptions' }, otherPaying: [], paidTwice: false,
  paidTwiceNotice: null, next: null,
};

const OFFER = {
  platform: 'ios', storefront: 'USA', storeAccountToken: '6f1c2c1e-1111-4222-8333-444455556666', canBuy: true, cancelsCurrent: true,
  upgradeNotice: 'Your Crava Plus on crava.me will be cancelled, and the unused part refunded.',
  plans: [
    { id: 'plus', name: 'Crava Plus', monthlyBudgetUsd: 5, features: ['full_plans'], canBuy: false,
      products: [{ interval: 'month', apple: { productId: 'me.crava.plus.monthly' }, webPrice: { amount: 999, currency: 'usd', interval: 'month' } }] },
    { id: 'pro', name: 'Crava Pro', monthlyBudgetUsd: 8, features: ['full_plans'], canBuy: true,
      products: [{ interval: 'month', apple: { productId: 'me.crava.pro.monthly', introductoryOfferEligibilityJws: 'eyJelig' },
        webPrice: { amount: 4900, currency: 'usd', interval: 'month' } }] },
  ],
  trial: { eligible: true, days: 14, enforced: true },
  current: { plan: 'plus', name: 'Crava Plus', source: 'web', manage: { kind: 'stripe_portal' } },
  linkOut: { url: 'https://crava.me/plans?login_hint=pat%40example.com' },
};

describe('app.billing.store', () => {
  it('is on the App client and exported', () => {
    const { app } = client();
    assert.ok(app.billing.store instanceof StoreBilling);
  });

  it('offer: GET with the platform, the storefront upper-cased, and the app transaction id', async () => {
    const { app, calls } = client([{ body: OFFER }]);
    const offer = await app.billing.store.offer({ platform: 'ios', storefront: 'usa', appTransactionId: '12345' });
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].url, `${ME}/store/offer?platform=ios&storefront=USA&appTransactionId=12345`);
    assert.deepEqual(offer, OFFER);
    assert.equal(offer.plans[1].products[0].apple.introductoryOfferEligibilityJws, 'eyJelig');
    assert.equal(offer.cancelsCurrent, true);
  });

  it('offer: storefront and app transaction id are optional; android is fine; anything else is refused before calling', async () => {
    const { app, calls } = client([{ body: { ...OFFER, platform: 'android' } }]);
    await app.billing.store.offer({ platform: 'android' });
    assert.equal(calls[0].url, `${ME}/store/offer?platform=android`);
    await assert.rejects(app.billing.store.offer({ platform: 'web' }), e => e instanceof AppError && e.code === 'BAD_PLATFORM');
    assert.equal(calls.length, 1);
  });

  it('verify (iOS): POSTs the JWS, answers the plan, and gets a fresh token', async () => {
    const { app, calls } = client([{ body: PLAN }]);
    const plan = await app.billing.store.verify({ platform: 'ios', jws: 'eyJtx' });
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, `${ME}/store/verify`);
    assert.deepEqual(calls[0].body, { platform: 'ios', jws: 'eyJtx' });
    assert.equal(plan.source, 'apple');
    assert.equal(plan.manage.kind, 'apple');
  });

  it('verify (Android): POSTs the purchase token only', async () => {
    const { app, calls } = client([{ body: { ...PLAN, source: 'google' } }]);
    await app.billing.store.verify({ platform: 'android', purchaseToken: 'tok-1' });
    assert.deepEqual(calls[0].body, { platform: 'android', purchaseToken: 'tok-1' });
  });

  it('verify: another account\'s subscription is a StorePurchaseOtherAccount, with the platform\'s words', async () => {
    const message = 'This subscription belongs to another account in this app. Sign in with that account.';
    const { app } = client([{ status: 409, body: { code: 'STORE_PURCHASE_OTHER_ACCOUNT', message } }]);
    await assert.rejects(app.billing.store.verify({ platform: 'ios', jws: 'x' }), e => {
      assert.ok(e instanceof StorePurchaseOtherAccount);
      assert.ok(e instanceof AppError);
      assert.equal(e.status, 409);
      assert.equal(e.code, 'STORE_PURCHASE_OTHER_ACCOUNT');
      assert.equal(e.message, message);
      return true;
    });
  });

  it('verify: 429 is TooManyTries; 503 UNAVAILABLE (the limit fails closed) and STORE_UNAVAILABLE are BillingUnavailable', async () => {
    const { app } = client([
      { status: 429, body: { code: 'SLOW_DOWN', message: 'Too many tries. Please wait a few minutes and try again.' } },
      { status: 503, body: { code: 'UNAVAILABLE', message: "This can't be done just now. Please try again in a moment." } },
      { status: 503, body: { code: 'STORE_UNAVAILABLE', message: 'The store could not be reached. Please try again.' } },
    ]);
    await assert.rejects(app.billing.store.verify({ platform: 'ios', jws: 'x' }), e => e instanceof TooManyTries && e.code === 'SLOW_DOWN' && e.status === 429);
    await assert.rejects(app.billing.store.verify({ platform: 'ios', jws: 'x' }), e => e instanceof BillingUnavailable && e.code === 'UNAVAILABLE');
    await assert.rejects(app.billing.store.verify({ platform: 'ios', jws: 'x' }), e => e instanceof BillingUnavailable && e.code === 'STORE_UNAVAILABLE');
  });

  it('verify: other refusals stay an AppError with their code', async () => {
    const { app } = client([{ status: 400, body: { code: 'UNKNOWN_PRODUCT', message: "That purchase is not one of this app's plans." } }]);
    await assert.rejects(app.billing.store.verify({ platform: 'android', purchaseToken: 't' }), e =>
      e.constructor === AppError && e.code === 'UNKNOWN_PRODUCT' && e.status === 400);
  });

  it('verify: a lapsed sign-in is still SignInRequired', async () => {
    const { app } = client([{ status: 401, body: {} }]);
    await assert.rejects(app.billing.store.verify({ platform: 'ios', jws: 'x' }), e => e instanceof SignInRequired);
  });

  it('restore (iOS): drops blanks and repeats as the platform does, and ties each answer to its purchase', async () => {
    const { app, calls } = client([{ body: { plan: PLAN, items: [{ id: '0', result: 'bound' }, { id: '1', result: 'STORE_PURCHASE_OTHER_ACCOUNT' }] } }]);
    const restored = await app.billing.store.restore({ platform: 'ios', jws: [' a ', '', 'b', 'a'] });
    assert.equal(calls[0].url, `${ME}/store/restore`);
    assert.deepEqual(calls[0].body, { platform: 'ios', jws: ['a', 'b'] });
    assert.deepEqual(restored.items, [{ id: '0', result: 'bound', purchase: 'a' }, { id: '1', result: 'STORE_PURCHASE_OTHER_ACCOUNT', purchase: 'b' }]);
    assert.equal(restored.plan.plan, 'pro');
  });

  it('restore (Android): sends purchaseTokens; too many is TooManyPurchases; all another account\'s is StorePurchaseOtherAccount', async () => {
    const { app, calls } = client([
      { body: { plan: PLAN, items: [] } },
      { status: 400, body: { code: 'TOO_MANY_PURCHASES', message: 'Send at most 20 purchases at once.' } },
      { status: 409, body: { code: 'STORE_PURCHASE_OTHER_ACCOUNT', message: 'm' } },
    ]);
    await app.billing.store.restore({ platform: 'android', purchaseTokens: [] });
    assert.deepEqual(calls[0].body, { platform: 'android', purchaseTokens: [] });
    await assert.rejects(app.billing.store.restore({ platform: 'android', purchaseTokens: ['t'] }), e => e instanceof TooManyPurchases && e.status === 400);
    await assert.rejects(app.billing.store.restore({ platform: 'android', purchaseTokens: ['t'] }), e => e instanceof StorePurchaseOtherAccount);
  });

  it('manage: says what to open - a kind for Apple (StoreKit), a URL for Google, the portal for the website', () => {
    const { app } = client();
    assert.deepEqual(app.billing.store.manage(PLAN),
      { kind: 'apple', open: 'showManageSubscriptions', fallbackUrl: 'https://apps.apple.com/account/subscriptions' });
    assert.deepEqual(app.billing.store.manage({ kind: 'apple' }),
      { kind: 'apple', open: 'showManageSubscriptions', fallbackUrl: 'https://apps.apple.com/account/subscriptions' });
    const play = 'https://play.google.com/store/account/subscriptions?sku=pro&package=me.crava.app';
    assert.deepEqual(manageTarget({ ...PLAN, manage: { kind: 'google', url: play } }), { kind: 'google', url: play });
    assert.deepEqual(manageTarget(OFFER.current), { kind: 'stripe_portal' });
    assert.equal(manageTarget({ ...PLAN, manage: null }), null);
    assert.equal(manageTarget(null), null);
    assert.equal(manageTarget({ kind: 'carrier_billing' }), null);
  });
});

describe('paying twice, and deleting the account', () => {
  it('resolvePaidTwice: POSTs the one-tap retry and answers the plan; a refusal keeps its code', async () => {
    const notice = { resolution: 'auto_cancelled', refund: { amount: 412, currency: 'usd' }, coveredBy: 'apple', at: '2026-10-23T10:00:00Z' };
    const { app, calls } = client([
      { body: { ...PLAN, paidTwice: false, paidTwiceNotice: notice } },
      { status: 502, body: { code: 'PAID_TWICE_UNRESOLVED', message: "We couldn't cancel the website subscription yet." } },
    ]);
    const plan = await app.billing.resolvePaidTwice();
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, `${ME}/plan/paid-twice/resolve`);
    assert.deepEqual(plan.paidTwiceNotice, notice);
    await assert.rejects(app.billing.resolvePaidTwice(), e => e instanceof AppError && e.status === 502 && e.code === 'PAID_TWICE_UNRESOLVED');
  });

  it('plan() carries where the plan is paid and the paid-twice banner', async () => {
    const { app } = client([{ body: { ...PLAN, source: 'web', manage: { kind: 'stripe_portal' }, otherPaying: ['apple'], paidTwice: true,
      paidTwiceNotice: { resolution: 'failed', coveredBy: 'apple', at: '2026-10-23T10:00:00Z' } } }]);
    const plan = await app.billing.plan();
    assert.equal(plan.paidTwice, true);
    assert.deepEqual(plan.otherPaying, ['apple']);
    assert.equal(plan.paidTwiceNotice.resolution, 'failed');
  });

  it('account.deletionCheck: GETs the pre-check before deleting', async () => {
    const check = {
      storeSubscriptions: [{ store: 'apple', plan: 'plus', productId: 'me.crava.plus.monthly', expiresAt: '2026-11-23T00:00:00Z', autoRenew: true,
        manage: { kind: 'apple', url: 'https://apps.apple.com/account/subscriptions' }, cancelledByServerOnDeletion: false }],
      appleSubscription: true, googleSubscription: false,
    };
    const { app, calls } = client([{ body: check }]);
    const answer = await app.account.deletionCheck();
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].url, `${ME}/delete`);
    assert.deepEqual(answer, check);
    assert.equal(manageTarget(answer.storeSubscriptions[0].manage).kind, 'apple');
  });
});
