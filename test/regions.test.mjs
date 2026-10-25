// IntegrationsClient.listRegionWidgets against a stubbed fetch. Runs on the built package (npm test
// builds first), so it checks what is published: the export, the request it makes, and that both
// shapes the render endpoint answers in come back as one.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { IntegrationsApiError, IntegrationsClient, normaliseRegionWidgets } from '../dist/index.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function client(reply, config = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers ?? {}, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  };
  const c = new IntegrationsClient({ token: 'svx_st_abc', baseUrl: 'https://api.example.test/', origin: 'https://host.example', fetch, ...config });
  return { c, calls };
}

const WIDGET = {
  widgetId: 'w1', name: 'Open incidents', description: '', layout: 'INLINE', width: '100%', height: '240px',
  order: 0, embedUrl: 'https://embed.example/embed/widget?tenant=t&widget=w1#token=svx_st_f&p.ticketId=T-42', badgeOnLoad: true,
};

describe('listRegionWidgets', () => {
  it('POSTs the context to the region with the client, version and embed headers', async () => {
    const { c, calls } = client({ body: { widgets: [WIDGET], skipped: [], contractVersion: 3 } });
    await c.listRegionWidgets('ticket.sidebar', { ticketId: 'T-42' }, { contractVersion: 3 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, 'https://api.example.test/api/v1/workflow/embed/surfaces/ticket.sidebar/widgets');
    assert.deepEqual(calls[0].body, { ticketId: 'T-42' });
    assert.equal(calls[0].headers.Authorization, 'Bearer svx_st_abc');
    assert.equal(calls[0].headers['Content-Type'], 'application/json');
    assert.equal(calls[0].headers['X-Embed-Origin'], 'https://host.example');
    assert.equal(calls[0].headers['X-Region-Client'], `workstudio-js/${version}`);
    assert.equal(calls[0].headers['X-Region-Contract-Version'], '3');
  });

  it('leaves the contract version off when not given, and encodes the key', async () => {
    const { c, calls } = client({ body: [] });
    await c.listRegionWidgets('a b/c', {});
    assert.match(calls[0].url, /\/surfaces\/a%20b%2Fc\/widgets$/);
    assert.equal(calls[0].headers['X-Region-Contract-Version'], undefined);
    assert.equal(calls[0].headers['X-Region-Client'], `workstudio-js/${version}`);
  });

  it('sends the API-key headers too when used server-side', async () => {
    const { c, calls } = client({ body: [] }, { token: undefined, apiKey: 'svx_ik_k', tenantId: 't1', scopeKey: 'customer:acme' });
    await c.listRegionWidgets('ticket.sidebar', {});
    assert.equal(calls[0].headers.Authorization, 'Bearer svx_ik_k');
    assert.equal(calls[0].headers['X-Embed-Tenant'], 't1');
    assert.equal(calls[0].headers['X-Embed-Scope'], 'customer:acme');
  });

  it('returns the new shape as it is', async () => {
    const skipped = [{ widgetId: 'w2', reason: 'NEEDS_CONTEXT:accountId' }];
    const { c } = client({ body: { widgets: [WIDGET], skipped, contractVersion: 4 } });
    assert.deepEqual(await c.listRegionWidgets('ticket.sidebar', {}), { widgets: [WIDGET], skipped, contractVersion: 4 });
  });

  it('normalises the old array shape', async () => {
    const { c } = client({ body: [WIDGET] });
    assert.deepEqual(await c.listRegionWidgets('ticket.sidebar', {}), { widgets: [WIDGET], skipped: [] });
  });

  it('throws IntegrationsApiError with the server message on a 400', async () => {
    const { c } = client({ status: 400, body: { message: 'Region ticket.sidebar requires ticketId' } });
    await assert.rejects(c.listRegionWidgets('ticket.sidebar', {}), (e) =>
      e instanceof IntegrationsApiError && e.status === 400 && e.message === 'Region ticket.sidebar requires ticketId');
  });
});

describe('normaliseRegionWidgets', () => {
  it('drops rows without a frame URL and tolerates nonsense', () => {
    assert.deepEqual(normaliseRegionWidgets([WIDGET, { widgetId: 'x' }, null]), { widgets: [WIDGET], skipped: [] });
    assert.deepEqual(normaliseRegionWidgets(null), { widgets: [], skipped: [] });
    assert.deepEqual(normaliseRegionWidgets({ widgets: 'no', skipped: [{ widgetId: 'a' }] }), { widgets: [], skipped: [{ widgetId: 'a', reason: '' }] });
  });
});
