// app.contacts, app.events and app.notifications against a stubbed fetch. Runs on the built package (npm test builds
// first), so it checks what is published: the ./app entry, its exports and the requests it makes.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError, Contacts, Events, Notifications, createApp } from '../dist/app.js';

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
}

describe('app.contacts', () => {
  it('is on the App client and exported', () => {
    const { app } = client();
    assert.ok(app.contacts instanceof Contacts);
    assert.ok(app.events instanceof Events);
    assert.ok(app.notifications instanceof Notifications);
  });

  it('invite, accept, list, withdraw, remove', async () => {
    const { app, calls } = client(
      { status: 201, body: { id: 'i1', token: 'tok', label: 'Ravi', expiresAt: '2026-11-24T00:00:00Z', createdAt: '2026-10-25T00:00:00Z' } },
      { body: { id: 'c1', name: 'Asha', label: null, invitedBy: 'them', since: '2026-10-25T00:00:00Z' } },
      { body: [] },
      { status: 204 },
      { status: 204 },
    );
    const invite = await app.contacts.invite({ label: 'Ravi' });
    assert.equal(invite.token, 'tok');
    const contact = await app.contacts.accept('tok');
    assert.equal(contact.name, 'Asha');
    await app.contacts.list();
    await app.contacts.withdraw('i/1');
    await app.contacts.remove('c1');
    assertCall(calls[0], 'POST', `${BASE}/contacts/invites`, { label: 'Ravi' });
    assertCall(calls[1], 'POST', `${BASE}/contacts/accept`, { token: 'tok' });
    assertCall(calls[2], 'GET', `${BASE}/contacts`, undefined);
    assertCall(calls[3], 'DELETE', `${BASE}/contacts/invites/i%2F1`, undefined);
    assertCall(calls[4], 'DELETE', `${BASE}/contacts/c1`, undefined);
  });

  it('a used invite is an AppError with its code', async () => {
    const { app } = client({ status: 404, body: { code: 'INVITE_NOT_FOUND', message: 'That invite does not work any more.' } });
    await assert.rejects(app.contacts.accept('old'), (e) => e instanceof AppError && e.status === 404 && e.code === 'INVITE_NOT_FOUND');
  });
});

describe('app.events', () => {
  it('send now: to me by default, with its fields', async () => {
    const { app, calls } = client({ body: { event: 'lesson.cancelled', to: 'me', status: 'sent' } });
    const r = await app.events.send('lesson.cancelled', { fields: { when: 'Thu 5 pm', minutes: 45 } });
    assert.equal(r.status, 'sent');
    assertCall(calls[0], 'POST', `${BASE}/events`, { event: 'lesson.cancelled', to: 'me', fields: { when: 'Thu 5 pm', minutes: 45 } });
  });

  it('send later: to a contact, at a Date, under a key; cancel and list what waits', async () => {
    const { app, calls } = client(
      { body: { event: 'lesson.reminder', to: 'c1', status: 'scheduled', id: 's1', dueAt: '2026-10-30T16:00:00Z', key: 'lesson-30' } },
      { body: { cancelled: true } },
      { body: [] },
    );
    await app.events.send('lesson.reminder', { to: 'c1', at: new Date('2026-10-30T16:00:00Z'), key: 'lesson-30' });
    assert.equal(await app.events.cancel('lesson-30'), true);
    await app.events.scheduled({ limit: 20 });
    assertCall(calls[0], 'POST', `${BASE}/events`, { event: 'lesson.reminder', to: 'c1', fields: {}, at: '2026-10-30T16:00:00.000Z', key: 'lesson-30' });
    assertCall(calls[1], 'DELETE', `${BASE}/events/scheduled/lesson-30`, undefined);
    assertCall(calls[2], 'GET', `${BASE}/events/scheduled?limit=20`, undefined);
  });
});

describe('app.notifications', () => {
  it('get and set what is emailed', async () => {
    const { app, calls } = client({ body: { email: true, events: [] } }, { body: { email: true, events: [] } });
    await app.notifications.get();
    await app.notifications.set({ events: { 'lesson.reminder': false } });
    assertCall(calls[0], 'GET', `${BASE}/notifications`, undefined);
    assertCall(calls[1], 'PUT', `${BASE}/notifications`, { events: { 'lesson.reminder': false } });
  });
});
