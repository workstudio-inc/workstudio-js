// app.invites against a stubbed fetch, on the built package (npm test builds first): the requests it makes, the token
// refresh after a redeem, refusals as AppError codes, and reading the token from a link.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError, createApp, Invites } from '../dist/app.js';

const API = 'https://api.example.test';
const APP = 'c7a7a000-0000-4000-8000-000000000013';
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv_-';

function client(replies = [], config = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const r = replies.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  };
  const app = createApp({ apiUrl: API, appId: APP, platformToken: () => 'person-token', fetch, ...config });
  return { app, calls };
}

const PREVIEW = { app: { id: APP, name: 'Crava' }, plan: { id: 'pro', name: 'Pro' }, months: 3, status: 'ok', expiresAt: '2026-11-08T12:00:00Z', emailLocked: false };
const GRANT = { planId: 'pro', planName: 'Pro', startsAt: '2026-10-25T12:00:00Z', endsAt: '2027-01-25T12:00:00Z', active: true };
const PLAN = {
  enabled: true, plan: 'pro', name: 'Pro', monthlyBudgetUsd: 15, paid: false, status: 'grant', renewsAt: null, endsAt: GRANT.endsAt,
  cancelAtPeriodEnd: false, canUpgrade: true, canChange: false, canManage: false, defaultPlan: 'free', plans: [], features: ['full_plans'],
  trialEndsAt: null, hasPaymentMethod: false, source: 'grant', manage: null, otherPaying: [], paidTwice: false, paidTwiceNotice: null,
  next: null, grant: GRANT,
};

describe('app.invites', () => {
  it('is on the client', () => {
    assert.ok(client().app.invites instanceof Invites);
  });

  it('preview: a public POST with the token in its body - no credential, never in the address', async () => {
    const { app, calls } = client([{ body: PREVIEW }]);
    const p = await app.invites.preview(` ${TOKEN} `);
    assert.deepEqual(p, PREVIEW);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, `${API}/api/v1/public/apps/${APP}/invites/preview`);
    assert.deepEqual(calls[0].body, { token: TOKEN });
    assert.equal(calls[0].headers.Authorization, undefined);
    assert.ok(!calls[0].url.includes(TOKEN));
  });

  it('preview needs the App id', () => {
    const { app } = client([], { appId: undefined });
    assert.throws(() => app.invites.preview(TOKEN), e => e instanceof AppError && e.code === 'NO_APP_ID');
  });

  it('preview: an unknown token and too many looks come back as their codes', async () => {
    const { app } = client([
      { status: 404, body: { code: 'NO_SUCH_INVITE', message: 'This invite link is not valid.' } },
      { status: 429, body: { code: 'SLOW_DOWN', message: 'Too many tries.' } },
    ]);
    await assert.rejects(app.invites.preview(TOKEN), e => e instanceof AppError && e.status === 404 && e.code === 'NO_SUCH_INVITE');
    await assert.rejects(app.invites.preview(TOKEN), e => e instanceof AppError && e.status === 429 && e.code === 'SLOW_DOWN');
  });

  it('redeem: as the person, then a fresh token for the new allowance', async () => {
    const { app, calls } = client([{ body: { grant: GRANT, plan: PLAN } }]);
    let renewed = 0;
    app.auth.renew = async () => { renewed++; return true; };
    const r = await app.invites.redeem(TOKEN);
    assert.deepEqual(r.grant, GRANT);
    assert.equal(r.plan.source, 'grant');
    assert.equal(r.plan.paid, false);
    assert.equal(r.plan.endsAt, GRANT.endsAt);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, `${API}/api/v1/workflow/connection/end-users/me/invites/redeem`);
    assert.equal(calls[0].headers.Authorization, 'Bearer person-token');
    assert.deepEqual(calls[0].body, { token: TOKEN });
    assert.equal(renewed, 1);
  });

  it('redeem stands when the token refresh fails', async () => {
    const { app } = client([{ body: { grant: GRANT, plan: PLAN } }]);
    app.auth.renew = async () => { throw new Error('offline'); };
    assert.deepEqual((await app.invites.redeem(TOKEN)).grant, GRANT);
  });

  for (const [status, code] of [[409, 'INVITE_USED'], [410, 'INVITE_EXPIRED'], [410, 'INVITE_REVOKED'], [403, 'INVITE_EMAIL_MISMATCH'],
    [409, 'INVITE_ALREADY_HAD'], [409, 'PLAN_NOT_INVITABLE'], [404, 'NO_SUCH_INVITE'], [429, 'SLOW_DOWN'], [503, 'UNAVAILABLE']]) {
    it(`redeem refused: ${code} with its message, and no token refresh`, async () => {
      const { app } = client([{ status, body: { code, message: `said: ${code}` } }]);
      let renewed = 0;
      app.auth.renew = async () => { renewed++; return true; };
      await assert.rejects(app.invites.redeem(TOKEN),
        e => e instanceof AppError && e.status === status && e.code === code && e.message === `said: ${code}`);
      assert.equal(renewed, 0);
    });
  }

  it('an empty token is refused before anything is sent', async () => {
    const { app, calls } = client();
    await assert.rejects(app.invites.redeem('  '), e => e instanceof AppError && e.code === 'NO_SUCH_INVITE');
    assert.equal(calls.length, 0);
  });

  it('tokenFromUrl: the token after /i/ in the address, a hash route, or another path', () => {
    const inv = client().app.invites;
    assert.equal(inv.tokenFromUrl(`https://crava.me/i/${TOKEN}`), TOKEN);
    assert.equal(inv.tokenFromUrl(`https://crava.me/i/${TOKEN}/?utm_source=x#top`), TOKEN);
    assert.equal(inv.tokenFromUrl(`/i/${TOKEN}`), TOKEN);
    assert.equal(inv.tokenFromUrl(`https://crava.me/#/i/${TOKEN}`), TOKEN);
    assert.equal(inv.tokenFromUrl(`https://crava.me/invite/${TOKEN}`, '/invite'), TOKEN);
    assert.equal(inv.tokenFromUrl(`https://crava.me/invite/${TOKEN}`, 'invite/'), TOKEN);
    assert.equal(inv.tokenFromUrl('https://crava.me/i/'), null);
    assert.equal(inv.tokenFromUrl('https://crava.me/i/short'), null);
    assert.equal(inv.tokenFromUrl(`https://crava.me/xi/${TOKEN}`), null);
    assert.equal(inv.tokenFromUrl('https://crava.me/plans'), null);
    assert.equal(inv.tokenFromUrl('https://crava.me/i/<script>'), null);
  });
});

describe('the plan on a grant', () => {
  it('says source grant, not paid, when it ends, and the grant', async () => {
    const { app } = client([{ body: PLAN }]);
    const plan = await app.billing.plan();
    assert.equal(plan.source, 'grant');
    assert.equal(plan.status, 'grant');
    assert.equal(plan.paid, false);
    assert.equal(plan.canUpgrade, true);
    assert.equal(plan.canChange, false);
    assert.deepEqual(plan.grant, GRANT);
  });
});
