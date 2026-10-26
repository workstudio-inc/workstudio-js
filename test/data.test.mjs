// app.data.collection against a stubbed fetch: the same calls for a collection of each person's own records and for one
// an internal App shares with its members; a shared record says who created and last changed it. Runs on the built
// package (npm test builds first).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApp } from '../dist/app.js';

const API = 'https://api.example.test';
const RECORDS = `${API}/api/v1/workflow/data/collections/records/records`;
const ALICE = 'enduser:customer:eu.alice/instance:tool';
const BOB = 'enduser:customer:eu.bob/instance:tool';

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

const shared = (id, data, source) => ({ id, data, scopeKey: 'app:6f1c2c1e-1111-4222-8333-444455556666', source });

describe('a shared collection', () => {
  it('lists the team\'s records with who created and last changed each', async () => {
    const { app, calls } = client([{ body: { records: [
      shared('1', { title: 'Renew lease' }, { createdBy: ALICE, createdByName: 'alice@example.com', updatedBy: BOB, updatedByName: 'bob@example.com' }),
      shared('2', { title: 'Order chairs' }, { createdBy: BOB, updatedBy: BOB }),
    ] } }]);
    const rows = await app.data.collection('records').find({ limit: 10 });
    assert.equal(calls[0].url, `${RECORDS}?limit=10`);
    assert.equal(rows[0].createdBy, ALICE);
    assert.equal(rows[0].createdByName, 'alice@example.com');
    assert.equal(rows[0].updatedBy, BOB);
    assert.equal(rows[0].updatedByName, 'bob@example.com');
    assert.equal(rows[1].createdByName, undefined);
    assert.equal(rows[1].data.title, 'Order chairs');
  });

  it('says who on what create, replace, update and get answer, and sends nothing about authorship', async () => {
    const mine = shared('9', { title: 'x' }, { createdBy: ALICE, createdByName: 'alice@example.com', updatedBy: ALICE, updatedByName: 'alice@example.com' });
    const theirs = shared('9', { title: 'y', status: 'done' }, { createdBy: ALICE, updatedBy: BOB, updatedByName: 'bob@example.com' });
    const { app, calls } = client([{ body: mine }, { body: theirs }, { body: mine }, { body: theirs }, { body: theirs }]);
    const records = app.data.collection('records');
    assert.equal((await records.create({ title: 'x' })).createdBy, ALICE);
    assert.deepEqual(calls[0].body, { record: { title: 'x' } });
    assert.equal((await records.replace('9', { title: 'y' })).updatedBy, BOB);
    const updated = await records.update('9', { status: 'done' });
    assert.equal(updated.updatedByName, 'bob@example.com');
    assert.deepEqual(calls[3].body, { record: { title: 'x', status: 'done' } });
    assert.equal((await records.get('9')).createdBy, ALICE);
  });
});

describe('a collection of each person\'s own records', () => {
  it('is unchanged: no authors, the record as the platform sent it', async () => {
    const own = { id: '3', data: { title: 'Mine' }, scopeKey: 'customer:eu.alice/instance:tool', createdAt: '2026-10-26T10:00:00Z' };
    const { app } = client([{ body: [own] }, { body: own }]);
    const [row] = await app.data.collection('notes').find();
    assert.deepEqual(row, own);
    assert.equal(row.createdBy, undefined);
    assert.deepEqual(await app.data.collection('notes').get('3'), own);
  });

  it('a missing record is still null', async () => {
    const { app } = client([{ status: 404, body: { error: 'Record not found' } }]);
    assert.equal(await app.data.collection('notes').get('nope'), null);
  });
});

describe('the declared collections', () => {
  it('say which one the members share', async () => {
    const { app, calls } = client([{ body: [{ name: 'records', shared: 'members' }, { name: 'notes' }] }]);
    const list = await app.data.collections();
    assert.equal(calls[0].url, `${API}/api/v1/workflow/data/collections`);
    assert.equal(list[0].shared, 'members');
    assert.equal(list[1].shared, undefined);
  });
});
