// app.projects compare-and-set (0.13.0) against a stubbed fetch: `version` on reads, `expectedVersion` sent as
// If-Match, and a lost write thrown as VersionMismatchError with the current version. Runs on the built package
// (npm test builds first).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError, VersionMismatchError, createApp } from '../dist/app.js';

const API = 'https://api.example.test';
const PROJECTS = `${API}/api/v1/workflow/tech-projects`;
const ID = '019e0a4c-1111-7222-8333-444455556666';

/** A client whose fetch records each call (url, method, headers, body) and answers from `replies` in turn. */
function client(replies = []) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers ?? {}, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const r = replies.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  };
  const app = createApp({ apiUrl: API, platformToken: () => 'person-token', fetch });
  return { app, calls };
}

const project = (version, settings = {}) => ({ id: ID, name: 'Kitchen side table', settings, version });
const mismatch = (currentVersion) => ({
  status: 409,
  body: { status: 409, error: 'VERSION_MISMATCH', message: 'The project was changed by someone else (version 5, expected 3). Read it again and retry.', currentVersion, timestamp: '2026-10-27T10:00:00Z' },
});

describe('projects: version on reads', () => {
  it('get and list return the version', async () => {
    const { app } = client([{ body: project(7) }, { body: { content: [project(7)] } }]);
    assert.equal((await app.projects.get(ID)).version, 7);
    assert.equal((await app.projects.list())[0].version, 7);
  });
});

describe('projects.update', () => {
  it('without expectedVersion sends no If-Match - unconditional, as before', async () => {
    const { app, calls } = client([{ body: project(8, { theme: 'system' }) }]);
    const saved = await app.projects.update(ID, { settings: { designing: null } });
    assert.equal(calls[0].method, 'PUT');
    assert.equal(calls[0].url, `${PROJECTS}/${ID}`);
    assert.equal(calls[0].headers['If-Match'], undefined);
    assert.deepEqual(calls[0].body, { settings: { designing: null } }); // null is sent: the platform removes the key
    assert.equal(saved.version, 8);
  });

  it('with expectedVersion sends If-Match "<version>" and answers with the new version', async () => {
    const { app, calls } = client([{ body: project(4, { designing: { device: 'phone' } }) }]);
    const saved = await app.projects.update(ID, { settings: { designing: { device: 'phone' } } }, { expectedVersion: 3 });
    assert.equal(calls[0].headers['If-Match'], '"3"');
    assert.equal(calls[0].headers.Authorization, 'Bearer person-token');
    assert.deepEqual(calls[0].body, { settings: { designing: { device: 'phone' } } });
    assert.equal('expectedVersion' in calls[0].body, false);
    assert.equal(saved.version, 4);
  });

  it('expectedVersion 0 (a project never written) is still conditional', async () => {
    const { app, calls } = client([{ body: project(1) }]);
    await app.projects.update(ID, { name: 'x' }, { expectedVersion: 0 });
    assert.equal(calls[0].headers['If-Match'], '"0"');
  });

  it('a lost write throws VersionMismatchError with currentVersion - an AppError, status 409', async () => {
    const { app } = client([mismatch(5)]);
    await assert.rejects(app.projects.update(ID, { settings: { designing: { device: 'laptop' } } }, { expectedVersion: 3 }), (e) => {
      assert.ok(e instanceof VersionMismatchError);
      assert.ok(e instanceof AppError);
      assert.equal(e.name, 'VersionMismatchError');
      assert.equal(e.status, 409);
      assert.equal(e.code, 'VERSION_MISMATCH');
      assert.equal(e.currentVersion, 5);
      assert.equal(e.expectedVersion, 3);
      assert.match(e.message, /changed by someone else/);
      assert.equal(e.details.currentVersion, 5);
      return true;
    });
  });

  it('claims a running design from one device; the second device gets VersionMismatchError', async () => {
    const { app, calls } = client([
      { body: project(2) }, { body: project(2) },             // both devices read version 2
      { body: project(3, { designing: { device: 'phone' } }) }, // the phone claims first
      mismatch(3),                                               // the laptop, from the same read, loses
    ]);
    const phone = await app.projects.get(ID);
    const laptop = await app.projects.get(ID);
    await app.projects.update(ID, { settings: { designing: { device: 'phone' } } }, { expectedVersion: phone.version });
    const lost = await app.projects.update(ID, { settings: { designing: { device: 'laptop' } } }, { expectedVersion: laptop.version })
      .then(() => null, (e) => e);
    assert.ok(lost instanceof VersionMismatchError);
    assert.equal(lost.currentVersion, 3);
    assert.equal(calls[2].headers['If-Match'], '"2"');
    assert.equal(calls[3].headers['If-Match'], '"2"');
  });

  it('other refusals stay as they were: 409 CONCURRENT_UPDATE and 404 are plain AppErrors', async () => {
    const { app } = client([
      { status: 409, body: { status: 409, error: 'CONCURRENT_UPDATE', message: 'Data was modified by another request. Please retry.' } },
      { status: 404, body: { status: 404, error: 'NOT_FOUND', message: 'Project not found' } },
    ]);
    await assert.rejects(app.projects.update(ID, { name: 'x' }, { expectedVersion: 1 }), (e) => {
      assert.ok(e instanceof AppError);
      assert.ok(!(e instanceof VersionMismatchError));
      assert.equal(e.code, 'CONCURRENT_UPDATE');
      return true;
    });
    await assert.rejects(app.projects.update(ID, { name: 'x' }, { expectedVersion: 1 }), (e) => {
      assert.ok(!(e instanceof VersionMismatchError));
      assert.equal(e.status, 404);
      return true;
    });
  });

  it('a version that is not a whole number of 0 or more is refused before any request', async () => {
    const { app, calls } = client();
    for (const bad of [-1, 1.5, Number.NaN, '3']) {
      await assert.rejects(app.projects.update(ID, { name: 'x' }, { expectedVersion: bad }), TypeError);
    }
    assert.equal(calls.length, 0);
  });
});
