// Internal Apps (sign-in for members of the publishing organization only), on the built package (npm test builds
// first): the token swap's NOT_A_MEMBER refusal is a NotAMember the App can show, MEMBERSHIP_UNAVAILABLE keeps its
// code, and an ordinary refusal is as it was.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError, createApp, NotAMember } from '../dist/app.js';

const API = 'https://api.example.test';
const ISSUER = 'https://auth.example.test/realms/apps';
const CLIENT = 'tools-web';

function memory() {
  const m = new Map();
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: k => void m.delete(k), m };
}

// A person coming back from the hosted page: the realm hands out its tokens, then the swap answers `swap`.
function returning(swap) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, body: init.body ? String(init.body) : undefined });
    if (url.endsWith('/protocol/openid-connect/token')) {
      return new Response(JSON.stringify({ access_token: 'realm.access.token', refresh_token: 'realm-refresh' }), { status: 200 });
    }
    if (url.endsWith('/protocol/openid-connect/logout')) return new Response('', { status: 204 });
    return new Response(JSON.stringify(swap.body), { status: swap.status, headers: { 'Content-Type': 'application/json' } });
  };
  const storage = memory();
  storage.setItem(`workstudio.app.${CLIENT}.pending`, JSON.stringify({ verifier: 'v', state: 's1' }));
  const app = createApp({ apiUrl: API, signInIssuer: ISSUER, clientId: CLIENT, redirectUri: 'https://tools.example.test/', storage, fetch });
  return { app, calls, storage, back: 'https://tools.example.test/?code=c1&state=s1' };
}

describe('internal Apps: NOT_A_MEMBER', () => {
  it('a person who is not a member gets NotAMember, with the organization and the platform\'s sentence', async () => {
    const { app, calls, storage, back } = returning({
      status: 403,
      body: { error: 'invalid_target', error_description: 'This app is only for Acme members.', code: 'NOT_A_MEMBER', organization: 'Acme' },
    });
    await assert.rejects(app.auth.completeSignIn(back), e => {
      assert.ok(e instanceof NotAMember);
      assert.ok(e instanceof AppError);
      assert.equal(e.status, 403);
      assert.equal(e.code, 'NOT_A_MEMBER');
      assert.equal(e.organization, 'Acme');
      assert.equal(e.message, 'This app is only for Acme members.');
      return true;
    });
    // Nothing kept, and the hosted sign-in is ended so another account can be tried.
    assert.equal(storage.getItem(`workstudio.app.${CLIENT}`), null);
    assert.ok(calls.some(c => c.url.endsWith('/protocol/openid-connect/logout')));
  });

  it('without a name or sentence it still says who the app is for', () => {
    assert.equal(new NotAMember().message, 'This app is only for members of the organization that publishes it.');
    assert.equal(new NotAMember('Acme').message, 'This app is only for Acme members.');
  });

  it('MEMBERSHIP_UNAVAILABLE keeps its code, as an AppError to retry', async () => {
    const { app, back } = returning({
      status: 503,
      body: { error: 'temporarily_unavailable', error_description: 'Please try again in a minute.', code: 'MEMBERSHIP_UNAVAILABLE' },
    });
    await assert.rejects(app.auth.completeSignIn(back), e => {
      assert.ok(e instanceof AppError);
      assert.ok(!(e instanceof NotAMember));
      assert.equal(e.status, 503);
      assert.equal(e.code, 'MEMBERSHIP_UNAVAILABLE');
      return true;
    });
  });

  it('any other refusal is as before: its OAuth error is the code', async () => {
    const { app, back } = returning({ status: 403, body: { error: 'invalid_target', error_description: 'This account is suspended.' } });
    await assert.rejects(app.auth.completeSignIn(back), e => e instanceof AppError && !(e instanceof NotAMember) && e.code === 'invalid_target');
  });
});
