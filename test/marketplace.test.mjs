// app.listings and app.requests against a stubbed fetch. Runs on the built package (npm test builds first),
// so it checks what is published: the ./app entry, its exports and the requests it makes.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError, Inbox, Listings, Requests, SignInRequired, createApp } from '../dist/app.js';

const API = 'https://api.example.test';
const BASE = `${API}/api/v1/workflow/connection/end-users/me`;

/** A client whose fetch records each call and answers from `replies` in turn (default 200 `{}`). */
function client(...replies) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers ?? {}, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const r = replies.shift() ?? { status: 200, body: {} };
    return new Response(r.status === 204 ? null : JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  };
  const app = createApp({ apiUrl: `${API}/`, platformToken: () => 'person-token', fetch });
  return { app, calls };
}

function assertCall(call, method, url, body) {
  assert.equal(call.method, method);
  assert.equal(call.url, url);
  assert.equal(call.headers.Authorization, 'Bearer person-token');
  assert.deepEqual(call.body, body);
  if (body === undefined) assert.equal(call.headers['Content-Type'], undefined);
  else assert.equal(call.headers['Content-Type'], 'application/json');
}

const LISTING = {
  id: 'l1', kind: 'shop', displayName: 'Oak & Iron', summary: 'Tables', tags: ['walnut'], logo: null,
  location: { zip: '02139', city: 'Cambridge', state: 'MA', lat: 42.36, lng: -71.1, radiusMiles: 25 },
  contact: { email: 'jane@example.com' }, listed: true, searchable: true, notSearchableReason: null,
  createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z',
};

const REQUEST = {
  id: 'r1', role: 'requester', kind: 'shop', ref: 'design-9', title: 'Quote for a table', status: 'open', endedBy: null,
  listing: { id: 'l1', kind: 'shop', displayName: 'Oak & Iron', contact: null }, requester: { name: 'Mike' },
  createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z', answeredAt: null, lastMessageAt: null,
};

describe('app.listings', () => {
  it('is on the App client and exported', () => {
    const { app } = client();
    assert.ok(app.listings instanceof Listings);
  });

  it('save: PUT the whole listing with the person\'s token', async () => {
    const { app, calls } = client({ body: LISTING });
    const input = { displayName: 'Oak & Iron', zip: '02139', tags: ['walnut'], contact: { email: 'jane@example.com' }, listed: true };
    const saved = await app.listings.save('shop', input);
    assert.deepEqual(saved, LISTING);
    assertCall(calls[0], 'PUT', `${BASE}/listings/shop`, input);
  });

  it('get: the listing', async () => {
    const { app, calls } = client({ body: LISTING });
    assert.deepEqual(await app.listings.get('shop'), LISTING);
    assertCall(calls[0], 'GET', `${BASE}/listings/shop`, undefined);
  });

  it('get: null when the person has none (404 LISTING_NOT_FOUND)', async () => {
    const { app } = client({ status: 404, body: { code: 'LISTING_NOT_FOUND', message: 'No listing.' } });
    assert.equal(await app.listings.get('shop'), null);
  });

  it('get: any other refusal throws, even a 404 without LISTING_NOT_FOUND', async () => {
    const { app } = client({ status: 404, body: { message: 'Not here.' } }, { status: 403, body: { code: 'LISTINGS_OFF', message: 'Listings are off.' } });
    await assert.rejects(app.listings.get('shop'), e => e instanceof AppError && e.status === 404 && e.code === undefined);
    await assert.rejects(app.listings.get('shop'), e => e instanceof AppError && e.status === 403 && e.code === 'LISTINGS_OFF' && e.message === 'Listings are off.');
  });

  it('save: a refusal is an AppError with its code and message', async () => {
    const { app } = client({ status: 403, body: { code: 'NEEDS_PLAN', message: 'Listing needs Pro.' } });
    await assert.rejects(app.listings.save('shop', { displayName: 'x', zip: '02139' }), e => {
      assert.ok(e instanceof AppError);
      assert.equal(e.status, 403);
      assert.equal(e.code, 'NEEDS_PLAN');
      assert.equal(e.message, 'Listing needs Pro.');
      return true;
    });
  });

  it('remove: DELETE, 204 answers undefined', async () => {
    const { app, calls } = client({ status: 204 });
    assert.equal(await app.listings.remove('shop'), undefined);
    assertCall(calls[0], 'DELETE', `${BASE}/listings/shop`, undefined);
  });

  it('near: the /me/ address, with zip, limit and page', async () => {
    const page = { zip: '02139', city: 'Cambridge', state: 'MA', page: 1, limit: 10, hasMore: false, results: [] };
    const { app, calls } = client({ body: page });
    assert.deepEqual(await app.listings.near('shop', { zip: '02139', limit: 10, page: 1 }), page);
    assertCall(calls[0], 'GET', `${BASE}/listings/shop/near?zip=02139&limit=10&page=1`, undefined);
  });

  it('near: only zip when limit and page are left to the platform', async () => {
    const { app, calls } = client();
    await app.listings.near('shop', { zip: '02139' });
    assert.equal(calls[0].url, `${BASE}/listings/shop/near?zip=02139`);
  });

  it('encodes the kind', async () => {
    const { app, calls } = client({}, {}, { status: 204 }, {});
    await app.listings.save('a/b c?', { displayName: 'x', zip: '02139' });
    await app.listings.get('a/b c?');
    await app.listings.remove('a/b c?');
    await app.listings.near('a/b c?', { zip: '02139' });
    for (const c of calls) assert.ok(c.url.startsWith(`${BASE}/listings/a%2Fb%20c%3F`), c.url);
    assert.equal(calls[3].url, `${BASE}/listings/a%2Fb%20c%3F/near?zip=02139`);
  });

  it('401 asks to sign in again', async () => {
    const { app } = client({ status: 401, body: {} });
    await assert.rejects(app.listings.near('shop', { zip: '02139' }), SignInRequired);
  });
});

describe('app.requests (the requester)', () => {
  it('is on the App client, with the inbox', () => {
    const { app } = client();
    assert.ok(app.requests instanceof Requests);
    assert.ok(app.requests.inbox instanceof Inbox);
  });

  it('create: POST the request', async () => {
    const { app, calls } = client({ status: 201, body: REQUEST });
    const ask = { listingId: 'l1', kind: 'shop', ref: 'design-9', title: 'Quote for a table', message: 'How much?', payload: { width: 50 }, contact: { phone: '' } };
    assert.deepEqual(await app.requests.create(ask), REQUEST);
    assertCall(calls[0], 'POST', `${BASE}/requests`, ask);
  });

  it('list: status and limit when given, none otherwise', async () => {
    const { app, calls } = client({ body: [REQUEST] }, { body: [] });
    assert.deepEqual(await app.requests.list({ status: 'answered', limit: 5 }), [REQUEST]);
    await app.requests.list();
    assertCall(calls[0], 'GET', `${BASE}/requests?status=answered&limit=5`, undefined);
    assert.equal(calls[1].url, `${BASE}/requests`);
  });

  it('get, message, withdraw, accept, decline', async () => {
    const { app, calls } = client();
    await app.requests.get('r1');
    await app.requests.message('r1', 'Walnut, please.');
    await app.requests.withdraw('r1');
    await app.requests.accept('r1');
    await app.requests.decline('r1');
    assertCall(calls[0], 'GET', `${BASE}/requests/r1`, undefined);
    assertCall(calls[1], 'POST', `${BASE}/requests/r1/messages`, { body: 'Walnut, please.' });
    assertCall(calls[2], 'POST', `${BASE}/requests/r1/withdraw`, undefined);
    assertCall(calls[3], 'POST', `${BASE}/requests/r1/accept`, undefined);
    assertCall(calls[4], 'POST', `${BASE}/requests/r1/decline`, undefined);
  });

  it('encodes the id', async () => {
    const { app, calls } = client();
    await app.requests.get('r/1 ?');
    await app.requests.message('r/1 ?', 'x');
    assert.equal(calls[0].url, `${BASE}/requests/r%2F1%20%3F`);
    assert.equal(calls[1].url, `${BASE}/requests/r%2F1%20%3F/messages`);
  });

  it('delete: DELETE the request, 204 answers undefined; the id is encoded', async () => {
    const { app, calls } = client({ status: 204 }, { status: 204 });
    assert.equal(await app.requests.delete('r1'), undefined);
    await app.requests.delete('r/1 ?');
    assertCall(calls[0], 'DELETE', `${BASE}/requests/r1`, undefined);
    assert.equal(calls[1].url, `${BASE}/requests/r%2F1%20%3F`);
  });

  it('delete: not the person\'s request is a 404 REQUEST_NOT_FOUND, never a 403', async () => {
    const { app } = client({ status: 404, body: { code: 'REQUEST_NOT_FOUND', message: 'You have no such request.' } });
    await assert.rejects(app.requests.delete('r9'), e => e instanceof AppError && e.status === 404 && e.code === 'REQUEST_NOT_FOUND'
      && e.message === 'You have no such request.');
  });

  it('create: attachments go in the body beside the payload, as given; one request reads them back', async () => {
    const photo = { name: 'wall.jpg', contentType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,/9j/4A==' };
    const read = { ...REQUEST, payload: { width: 50 }, attachments: [{ name: 'wall.jpg', contentType: 'image/jpeg', size: 4, dataUrl: photo.dataUrl }], messages: [] };
    const { app, calls } = client({ status: 201, body: read }, { body: read }, { body: [REQUEST] });
    const ask = { listingId: 'l1', kind: 'shop', title: 'Quote for a table', message: 'How much?', payload: { width: 50 }, attachments: [photo, { dataUrl: 'data:image/png;base64,iVBORw==' }] };
    const made = await app.requests.create(ask);
    assertCall(calls[0], 'POST', `${BASE}/requests`, ask);
    assert.equal(made.attachments[0].size, 4);
    const one = await app.requests.get('r1');
    assert.equal(one.attachments[0].dataUrl, photo.dataUrl);
    // A list leaves them out.
    const [listed] = await app.requests.list();
    assert.equal(listed.attachments, undefined);
  });

  it('create: attachment refusals carry their code', async () => {
    const { app } = client(
      { status: 400, body: { code: 'ATTACHMENTS_TOO_BIG', message: 'Attachments are at most 512 KB in all.' } },
      { status: 400, body: { code: 'TOO_MANY_ATTACHMENTS', message: 'At most 3.' } },
      { status: 400, body: { code: 'BAD_ATTACHMENT', message: 'Not an image.' } },
    );
    const ask = { listingId: 'l1', kind: 'shop', title: 't', message: 'm', attachments: [{ dataUrl: 'data:image/jpeg;base64,/9j/' }] };
    await assert.rejects(app.requests.create(ask), e => e instanceof AppError && e.status === 400 && e.code === 'ATTACHMENTS_TOO_BIG');
    await assert.rejects(app.requests.create(ask), e => e instanceof AppError && e.code === 'TOO_MANY_ATTACHMENTS');
    await assert.rejects(app.requests.create(ask), e => e instanceof AppError && e.code === 'BAD_ATTACHMENT');
  });

  it('refusals carry their code: WRONG_STATUS, SLOW_DOWN, REQUEST_NOT_FOUND', async () => {
    const { app } = client(
      { status: 409, body: { code: 'WRONG_STATUS', message: 'Not answered yet.' } },
      { status: 429, body: { code: 'SLOW_DOWN', message: 'Too many messages.' } },
      { status: 404, body: { code: 'REQUEST_NOT_FOUND', message: 'No such request.' } },
    );
    await assert.rejects(app.requests.accept('r1'), e => e instanceof AppError && e.status === 409 && e.code === 'WRONG_STATUS' && e.message === 'Not answered yet.');
    await assert.rejects(app.requests.message('r1', 'x'), e => e instanceof AppError && e.status === 429 && e.code === 'SLOW_DOWN');
    await assert.rejects(app.requests.get('r9'), e => e instanceof AppError && e.status === 404 && e.code === 'REQUEST_NOT_FOUND');
  });
});

describe('app.requests.inbox (the listing owner)', () => {
  it('list and get', async () => {
    const { app, calls } = client({ body: [] }, { body: [] }, {});
    await app.requests.inbox.list({ status: 'open', limit: 20 });
    await app.requests.inbox.list();
    await app.requests.inbox.get('r1');
    assertCall(calls[0], 'GET', `${BASE}/inbox?status=open&limit=20`, undefined);
    assert.equal(calls[1].url, `${BASE}/inbox`);
    assertCall(calls[2], 'GET', `${BASE}/inbox/r1`, undefined);
  });

  it('reply, with and without a share', async () => {
    const { app, calls } = client();
    await app.requests.inbox.reply('r1', { body: 'Here is a quote.', shareToken: 'shr_tok' });
    await app.requests.inbox.reply('r1', { body: 'Thanks!' });
    assertCall(calls[0], 'POST', `${BASE}/inbox/r1/reply`, { body: 'Here is a quote.', shareToken: 'shr_tok' });
    assertCall(calls[1], 'POST', `${BASE}/inbox/r1/reply`, { body: 'Thanks!' });
  });

  it('decline, with and without a last word', async () => {
    const { app, calls } = client();
    await app.requests.inbox.decline('r1', 'Fully booked.');
    await app.requests.inbox.decline('r1');
    assertCall(calls[0], 'POST', `${BASE}/inbox/r1/decline`, { body: 'Fully booked.' });
    assertCall(calls[1], 'POST', `${BASE}/inbox/r1/decline`, {});
  });

  it('close, block, unblock', async () => {
    const { app, calls } = client();
    await app.requests.inbox.close('r1');
    await app.requests.inbox.block('r1');
    await app.requests.inbox.unblock('r1');
    assertCall(calls[0], 'POST', `${BASE}/inbox/r1/close`, undefined);
    assertCall(calls[1], 'POST', `${BASE}/inbox/r1/block`, undefined);
    assertCall(calls[2], 'DELETE', `${BASE}/inbox/r1/block`, undefined);
  });

  it('encodes the id', async () => {
    const { app, calls } = client();
    await app.requests.inbox.reply('a#b', { body: 'x' });
    await app.requests.inbox.unblock('a#b');
    assert.equal(calls[0].url, `${BASE}/inbox/a%23b/reply`);
    assert.equal(calls[1].url, `${BASE}/inbox/a%23b/block`);
  });

  it('a share that is not the owner\'s is refused with SHARE_NOT_YOURS', async () => {
    const { app } = client({ status: 400, body: { code: 'SHARE_NOT_YOURS', message: 'That share is not yours.' } });
    await assert.rejects(app.requests.inbox.reply('r1', { body: 'x', shareToken: 'other' }), e => e instanceof AppError && e.status === 400 && e.code === 'SHARE_NOT_YOURS');
  });
});
