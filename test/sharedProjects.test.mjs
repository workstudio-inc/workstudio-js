// app.sharedProjects against a stubbed fetch. Runs on the built package (npm test builds first), so it checks
// what is published: the ./app entry, its exports and the requests it makes.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError, Projects, SharedProjects, createApp } from '../dist/app.js';

const API = 'https://api.example.test';
const BASE = `${API}/api/v1/workflow/connection/end-users/me/projects`;

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

const PROJECT = { id: 'p1', kind: 'job', title: 'Bookcase', status: 'open', side: 'owner', currentRevision: 1, agreedRevision: null };
const REVISION = { payload: { width: 1000 }, price: { amount: '1240.00', currency: 'USD' }, leadTime: '3-4 weeks', summary: 'wider', answers: ['c1'] };

describe('app.sharedProjects', () => {
  it('is on the App client, beside the person\'s own projects', () => {
    const { app } = client();
    assert.ok(app.sharedProjects instanceof SharedProjects);
    assert.ok(app.projects instanceof Projects);
  });

  it('list and unread', async () => {
    const { app, calls } = client({ body: [PROJECT] }, { body: { projects: 1, entries: 3 } }, { body: [] });
    assert.deepEqual(await app.sharedProjects.list({ status: 'agreed', limit: 10 }), [PROJECT]);
    assertCall(calls[0], 'GET', `${BASE}?status=agreed&limit=10`, undefined);
    assert.deepEqual(await app.sharedProjects.unread(), { projects: 1, entries: 3 });
    assertCall(calls[1], 'GET', `${BASE}/unread`, undefined);
    await app.sharedProjects.list();
    assertCall(calls[2], 'GET', BASE, undefined);
  });

  it('get, entries and one revision', async () => {
    const { app, calls } = client({ body: PROJECT }, { body: { entries: [], hasEarlier: false } }, { body: { number: 2 } });
    assert.deepEqual(await app.sharedProjects.get('p 1'), PROJECT);
    assertCall(calls[0], 'GET', `${BASE}/p%201`, undefined);
    await app.sharedProjects.entries('p1', { before: 40, limit: 20 });
    assertCall(calls[1], 'GET', `${BASE}/p1/entries?before=40&limit=20`, undefined);
    await app.sharedProjects.revision('p1', 2);
    assertCall(calls[2], 'GET', `${BASE}/p1/revisions/2`, undefined);
  });

  it('opening: from a request (owner) or a share link (client)', async () => {
    const { app, calls } = client({ status: 201, body: PROJECT }, { status: 201, body: PROJECT });
    await app.sharedProjects.startFromRequest('r1', { kind: 'job', revision: REVISION });
    assertCall(calls[0], 'POST', BASE, { from: { request: 'r1' }, kind: 'job', revision: REVISION });
    await app.sharedProjects.continueFromShare('tok', { contact: { phone: '' }, channel: 'ios' });
    assertCall(calls[1], 'POST', BASE, { from: { shareToken: 'tok' }, contact: { phone: '' }, channel: 'ios' });
  });

  it('the writes, each to its route', async () => {
    const { app, calls } = client(...Array.from({ length: 8 }, () => ({ status: 200, body: {} })));
    await app.sharedProjects.message('p1', 'Hello');
    assertCall(calls[0], 'POST', `${BASE}/p1/messages`, { body: 'Hello' });
    await app.sharedProjects.postRevision('p1', REVISION);
    assertCall(calls[1], 'POST', `${BASE}/p1/revisions`, REVISION);
    await app.sharedProjects.requestChange('p1', { body: '10 cm wider?', revision: 1 });
    assertCall(calls[2], 'POST', `${BASE}/p1/change-requests`, { body: '10 cm wider?', revision: 1 });
    await app.sharedProjects.declineChange('p1', 'c1', 'It would sag');
    assertCall(calls[3], 'POST', `${BASE}/p1/change-requests/c1/decline`, { reason: 'It would sag' });
    await app.sharedProjects.approve('p1', { revision: 3, hash: 'sha256:ab', channel: 'web' });
    assertCall(calls[4], 'POST', `${BASE}/p1/approve`, { revision: 3, hash: 'sha256:ab', channel: 'web' });
    await app.sharedProjects.markRead('p1');
    assertCall(calls[5], 'POST', `${BASE}/p1/read`, {});
    await app.sharedProjects.markRead('p1', 12);
    assertCall(calls[6], 'POST', `${BASE}/p1/read`, { seq: 12 });
    await app.sharedProjects.close('p1', { reason: 'Fell through' });
    assertCall(calls[7], 'POST', `${BASE}/p1/close`, { reason: 'Fell through' });
  });

  it('remove: DELETE, nothing back', async () => {
    const { app, calls } = client({ status: 204 });
    assert.equal(await app.sharedProjects.remove('p1'), undefined);
    assertCall(calls[0], 'DELETE', `${BASE}/p1`, undefined);
  });

  it('a refusal is an AppError with its code', async () => {
    const { app } = client({ status: 403, body: { code: 'FEATURE_PAUSED', message: 'Oak & Pine can\'t send new revisions right now.' } });
    await assert.rejects(app.sharedProjects.postRevision('p1', REVISION), e => e instanceof AppError && e.status === 403 && e.code === 'FEATURE_PAUSED');
  });
});
