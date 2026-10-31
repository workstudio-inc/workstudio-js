// app.data.collection against a stubbed fetch: the same calls for a collection of each person's own records and for one
// an internal App shares with its members; a shared record says who created and last changed it. Runs on the built
// package (npm test builds first).
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
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

describe('findPage', () => {
  const NOTES = `${API}/api/v1/workflow/data/collections/notes/records`;

  it('says how many match across every page, with the same query find sends', async () => {
    const own = { id: '3', data: { title: 'Mine' } };
    const { app, calls } = client([{ body: { records: [own], total: 42 } }, { body: { records: [own], total: 42 } }]);
    const notes = app.data.collection('notes');
    const options = { where: { stage: 'new' }, limit: 1, offset: 20, sortBy: 'title', ascending: true };

    const page = await notes.findPage(options);
    assert.deepEqual(page, { records: [own], total: 42, nextCursor: null });
    await notes.find(options);
    assert.equal(calls[0].url, `${NOTES}?stage=new&limit=1&offset=20&sortBy=title&ascending=true`);
    assert.equal(calls[0].url, calls[1].url);
  });

  it('reads a total of zero as zero, on an empty page', async () => {
    const { app } = client([{ body: { records: [], total: 0 } }]);
    assert.deepEqual(await app.data.collection('notes').findPage(), { records: [], total: 0, nextCursor: null });
  });

  it('does not make a total up when the platform sends none', async () => {
    const { app } = client([{ body: [{ id: '3', data: {} }] }]);
    assert.equal((await app.data.collection('notes').findPage()).total, null);
  });

  it('says who made a shared record, as find does', async () => {
    const { app } = client([{ body: { records: [shared('1', { title: 'x' }, { createdBy: ALICE })], total: 1 } }]);
    assert.equal((await app.data.collection('records').findPage()).records[0].createdBy, ALICE);
  });

  it('asks not to count only when told to, and then has no total', async () => {
    const { app, calls } = client([{ body: { records: [] } }, { body: { records: [], total: 0 } }]);
    const notes = app.data.collection('notes');
    assert.equal((await notes.findPage({ count: false })).total, null);
    assert.equal(calls[0].url, `${NOTES}?%24count=false`);
    await notes.findPage({ count: true });
    assert.equal(calls[1].url, NOTES);
  });

  it('leaves find as it was: the records, and no total', async () => {
    const own = { id: '3', data: { title: 'Mine' } };
    const { app } = client([{ body: { records: [own], total: 42 } }]);
    assert.deepEqual(await app.data.collection('notes').find(), [own]);
  });
});

describe('ranges, lists, sorts and cursors', () => {
  const NOTES = `${API}/api/v1/workflow/data/collections/notes/records`;
  const query = url => decodeURIComponent(url.slice(NOTES.length + 1));

  it('sends a range and a list as conditions', async () => {
    const { app, calls } = client([{ body: { records: [] } }]);
    await app.data.collection('notes').find({ filter: { amount: { gte: 5, lt: 9 }, stage: { in: ['new', 'a,b'] } } });
    assert.equal(query(calls[0].url), 'amount[gte]=5&amount[lt]=9&stage[in]=new&stage[in]=a,b');
  });

  it('refuses an empty list rather than matching every record', async () => {
    const { app, calls } = client();
    await assert.rejects(app.data.collection('notes').find({ filter: { stage: { in: [] } } }), /is empty/);
    assert.equal(calls.length, 0);
  });

  it('sends zero and false, which are values', async () => {
    const { app, calls } = client([{ body: { records: [] } }]);
    await app.data.collection('notes').find({ filter: { amount: { gte: 0 }, won: { in: [false] } } });
    assert.equal(query(calls[0].url), 'amount[gte]=0&won[in]=false');
  });

  it('sends a typed sort, newest or largest first unless told otherwise', async () => {
    const { app, calls } = client([{ body: { records: [] } }, { body: { records: [] } }]);
    await app.data.collection('notes').find({ sort: { by: 'amount' } });
    await app.data.collection('notes').find({ sort: { by: 'amount', ascending: true } });
    assert.equal(query(calls[0].url), '$sort=amount:desc');
    assert.equal(query(calls[1].url), '$sort=amount:asc');
  });

  it('walks pages by cursor from null', async () => {
    const { app, calls } = client([
      { body: { records: [{ id: '1', data: {} }], total: 2, nextCursor: 'c1' } },
      { body: { records: [{ id: '2', data: {} }], total: 2 } },
    ]);
    const notes = app.data.collection('notes');
    const first = await notes.findPage({ limit: 1, after: null });
    assert.equal(first.nextCursor, 'c1');
    const second = await notes.findPage({ limit: 1, after: first.nextCursor });
    assert.equal(second.nextCursor, null);
    assert.equal(query(calls[0].url), 'limit=1&$after=');
    assert.equal(query(calls[1].url), 'limit=1&$after=c1');
  });

  it('sends none of it to a call that asks for none of it', async () => {
    const { app, calls } = client([{ body: { records: [] } }]);
    await app.data.collection('notes').find({ where: { stage: 'new' }, limit: 5, sortBy: 'title' });
    assert.equal(query(calls[0].url), 'stage=new&limit=5&sortBy=title');
  });
});

describe('writes that check first', () => {
  const NOTES = `${API}/api/v1/workflow/data/collections/notes/records`;
  const AT = '2026-10-31T10:00:00.123456Z';

  it('asks for a key only if it is free', async () => {
    const { app, calls } = client([{ body: { id: '1', data: {} } }]);
    await app.data.collection('notes').create({ title: 'x' }, { key: 'k', ifAbsent: true });
    assert.deepEqual(calls[0].body, { record: { title: 'x' }, key: 'k', ifAbsent: true });
  });

  it('says a key is taken', async () => {
    const { app } = client([{ status: 409, body: { error: 'A record with the key already exists', code: 'RECORD_EXISTS' } }]);
    await assert.rejects(app.data.collection('notes').create({}, { key: 'k', ifAbsent: true }), e => e.status === 409 && e.code === 'RECORD_EXISTS');
  });

  it('refuses ifAbsent with no key rather than making a duplicate', async () => {
    const { app, calls } = client();
    await assert.rejects(app.data.collection('notes').create({}, { ifAbsent: true }), /needs a `key`/);
    assert.equal(calls.length, 0);
  });

  it('replaces only if unchanged, sending the version it was told', async () => {
    const { app, calls } = client([{ body: { id: '1', data: {} } }]);
    await app.data.collection('notes').replace('1', { title: 'x' }, { ifUpdatedAt: AT });
    assert.deepEqual(calls[0].body, { record: { title: 'x' }, ifUpdatedAt: AT });
  });

  it('update can guard its own read', async () => {
    const { app, calls } = client([{ body: { id: '1', data: { title: 'x' }, updatedAt: AT } }, { body: { id: '1', data: {} } }]);
    await app.data.collection('notes').update('1', { status: 'done' }, { ifUnchanged: true });
    assert.deepEqual(calls[1].body, { record: { title: 'x', status: 'done' }, ifUpdatedAt: AT });
  });

  it('says a record changed, and what it is at now', async () => {
    const { app } = client([{ status: 409, body: { error: 'This record has changed since it was read', code: 'RECORD_CHANGED', currentUpdatedAt: AT } }]);
    await assert.rejects(app.data.collection('notes').replace('1', {}, { ifUpdatedAt: AT }),
      e => e.code === 'RECORD_CHANGED' && e.details.currentUpdatedAt === AT);
  });

  it('sends what it always sent when asked for neither', async () => {
    const { app, calls } = client([{ body: { id: '1', data: {} } }, { body: { id: '1', data: { a: 1 }, updatedAt: AT } }, { body: { id: '1', data: {} } }, { body: { id: '1', data: {} } }]);
    const notes = app.data.collection('notes');
    await notes.create({ a: 1 }, { key: 'k' });
    await notes.update('1', { b: 2 });
    await notes.replace('1', { c: 3 });
    assert.deepEqual(calls[0].body, { record: { a: 1 }, key: 'k' });
    assert.deepEqual(calls[2].body, { record: { a: 1, b: 2 } });
    assert.deepEqual(calls[3].body, { record: { c: 3 } });
    assert.equal(calls[3].url, `${NOTES}/1`);
  });
});

describe('aggregate', () => {
  const AGG = `${API}/api/v1/workflow/data/collections/notes/aggregate`;

  it('asks for a total and groups, narrowed as find is', async () => {
    const { app, calls } = client([{ body: { count: 2, sum: 12.5, groups: [{ value: 'new', count: 2, sum: 12.5 }] } }]);
    const out = await app.data.collection('notes').aggregate({ sum: 'amount', groupBy: 'stage', where: { won: true }, filter: { amount: { gte: 1 } }, limit: 5 });
    assert.equal(decodeURIComponent(calls[0].url.slice(AGG.length + 1)), 'won=true&amount[gte]=1&$sum=amount&$groupBy=stage&limit=5');
    assert.deepEqual(out, { count: 2, sum: 12.5, groups: [{ value: 'new', count: 2, sum: 12.5 }] });
  });

  it('says no sum as null, and a plain count needs no options', async () => {
    const { app, calls } = client([{ body: { count: 3 } }]);
    assert.deepEqual(await app.data.collection('notes').aggregate(), { count: 3, sum: null });
    assert.equal(calls[0].url, AGG);
  });

  it('refuses an empty list here too', async () => {
    const { app, calls } = client();
    await assert.rejects(app.data.collection('notes').aggregate({ filter: { stage: { in: [] } } }), /is empty/);
    assert.equal(calls.length, 0);
  });
});

describe('watch', () => {
  const page = (records, total) => ({ body: { records, total } });
  const a = { id: '1', data: { title: 'a' }, updatedAt: '2026-10-31T10:00:00Z' };
  const b = { id: '2', data: { title: 'b' }, updatedAt: '2026-10-31T10:00:05Z' };
  /** Let the timer that is due fire, and everything it awaits finish. */
  const tick = async (ms) => {
    mock.timers.tick(ms);
    for (let i = 0; i < 40; i++) await Promise.resolve().then(() => new Promise(r => setImmediate(r)));
  };
  const watching = (fn) => async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      await fn();
    } finally {
      mock.timers.reset();
    }
  };

  it('gives the records straight away, then only when something changed', watching(async () => {
    const { app, calls } = client([page([a], 1), page([a], 1), page([a], 1), page([b], 2), page([b, a], 2)]);
    const heard = [];
    const stop = app.data.collection('notes').watch(r => heard.push(r.map(x => x.id)));

    await tick(0);
    assert.deepEqual(heard, [['1']]);
    assert.equal(calls.length, 2);

    await tick(10_000);
    assert.deepEqual(heard, [['1']], 'nothing changed, so no second list');
    assert.equal(calls.length, 3, 'and no fetch of the records');

    await tick(10_000);
    assert.deepEqual(heard, [['1'], ['2', '1']]);
    stop();
  }));

  it('notices a delete, which moves no timestamp', watching(async () => {
    const { app } = client([page([b], 2), page([b, a], 2), page([b], 1), page([b], 1)]);
    const heard = [];
    const stop = app.data.collection('notes').watch(r => heard.push(r.length));
    await tick(0);
    await tick(10_000);
    assert.deepEqual(heard, [2, 1]);
    stop();
  }));

  it('looks with the smallest read that can see a change, narrowed as asked', watching(async () => {
    const { app, calls } = client([page([a], 1), page([a], 1)]);
    const stop = app.data.collection('notes').watch(() => {}, { where: { stage: 'new' }, limit: 50 });
    await tick(0);
    const look = decodeURIComponent(calls[0].url);
    assert.match(look, /stage=new/);
    assert.match(look, /limit=1/);
    assert.match(look, /\$sort=updatedAt:desc/);
    assert.match(decodeURIComponent(calls[1].url), /limit=50/);
    stop();
  }));

  it('never looks more often than every five seconds', watching(async () => {
    const { app, calls } = client([page([a], 1), page([a], 1), page([a], 1)]);
    const stop = app.data.collection('notes').watch(() => {}, { intervalMs: 10 });
    await tick(0);
    assert.equal(calls.length, 2);
    await tick(4_999);
    assert.equal(calls.length, 2);
    await tick(1);
    assert.equal(calls.length, 3);
    stop();
  }));

  it('stops when told, and hears nothing after', watching(async () => {
    const { app, calls } = client([page([a], 1), page([a], 1)]);
    const stop = app.data.collection('notes').watch(() => {});
    await tick(0);
    stop();
    await tick(60_000);
    assert.equal(calls.length, 2);
  }));

  it('says a failed look, slows down, and carries on', watching(async () => {
    const { app, calls } = client([{ status: 429, body: { code: 'APP_RATE_LIMITED', error: 'too many' } }, page([a], 1), page([a], 1)]);
    const errors = [];
    const heard = [];
    const stop = app.data.collection('notes').watch(r => heard.push(r.length), { onError: e => errors.push(e.code) });
    await tick(0);
    assert.deepEqual(errors, ['APP_RATE_LIMITED']);
    await tick(10_000);
    assert.equal(calls.length, 1, 'twice the interval after a failure');
    await tick(10_000);
    assert.equal(calls.length, 3);
    assert.deepEqual(heard, [1]);
    stop();
  }));

  it('never looks while the page is hidden', watching(async () => {
    const before = globalThis.document;
    globalThis.document = { hidden: true };
    try {
      const { app, calls } = client([page([a], 1), page([a], 1)]);
      const stop = app.data.collection('notes').watch(() => {});
      await tick(0);
      await tick(30_000);
      assert.equal(calls.length, 0);
      globalThis.document.hidden = false;
      await tick(10_000);
      assert.equal(calls.length, 2);
      stop();
    } finally {
      globalThis.document = before;
    }
  }));
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
