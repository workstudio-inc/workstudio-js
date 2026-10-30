// Contract tests for the embed client (@workstudio-inc/sdk) and the browser OAuth helpers (@workstudio-inc/sdk/browser).
// Each fixture is what the server's own DTO serialises to, cited by class (server repo, origin/main 2026-10-30). Runs on
// the built package (npm test builds first). Never calls a real server.
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { IntegrationsApiError, IntegrationsClient } from '../dist/index.js';
import { CONNECTION_STATUS_MESSAGE, connectConnector, openOAuthPopup } from '../dist/browser.js';

const ROOT = 'https://api.example.test/api/v1/workflow/embed';

function clientWith(route) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers ?? {}, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const answer = await route(url, init);
    const [status, json] = Array.isArray(answer) && answer.length === 2 && typeof answer[0] === 'number' ? answer : [200, answer];
    return new Response(status === 204 ? null : JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
  };
  const client = new IntegrationsClient({ apiKey: 'svx_ik_test', tenantId: 't1', scopeKey: 'customer:acme', baseUrl: 'https://api.example.test', fetch });
  return { client, calls };
}

// catalog src/main/java/com/svai/workflow/catalog/embed/EmbedActivationResponse.java
const ACTIVATION = {
  id: 'b7a1c2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d', integrationGlobalId: '8a1e4f2c-3d5b-4a6e-9f70-1b2c3d4e5f60',
  integrationName: 'ServiceNow Incident Sync', instanceKey: null, name: null, integrationLogoUrl: null, status: 'pending',
  pendingRequirements: [{ connectorGlobalId: '5e2f9a10-1111-4c2d-8e3f-222233334444', connectorName: 'ServiceNow', connectorLogoUrl: null,
    type: 'oauth', description: null, authorizationUrl: null, configFields: null }],
  connectors: [], createdAt: '2026-10-29T18:04:11.532Z', updatedAt: '2026-10-29T18:04:11.532Z',
};

describe('embed client contract (catalog IntegrationEmbedController)', () => {
  it('sends the embed credential as a Bearer token with the X-Embed-* headers', async () => {
    const { client, calls } = clientWith(() => [ACTIVATION]);
    await client.listActivations();
    assert.equal(calls[0].url, `${ROOT}/activations`);
    // catalog EmbedAuthenticationFilter: Authorization: Bearer svx_ik_..., X-Embed-Tenant, X-Embed-Scope
    assert.equal(calls[0].headers.Authorization, 'Bearer svx_ik_test');
    assert.equal(calls[0].headers['X-Embed-Tenant'], 't1');
    assert.equal(calls[0].headers['X-Embed-Scope'], 'customer:acme');
  });

  it('getIntegration: isActivated comes from the server\'s `activated`', async () => {
    // catalog EmbedIntegrationDetail (Lombok @Data, boolean isActivated -> JSON `activated`)
    const DETAIL = { id: '0c6b', globalId: '8a1e4f2c-3d5b-4a6e-9f70-1b2c3d4e5f60', slug: 'servicenow-incident-sync', name: 'ServiceNow Incident Sync',
      description: 'Sync incidents', longDescription: 'Sync incidents', category: 'ITSM', logoUrl: null, version: '1.2.0', tags: ['itsm'],
      connectors: [{ globalId: '5e2f', name: 'ServiceNow', description: null, logoUrl: null, authType: 'oauth2', isRequired: true, isConnected: false, connectionStatus: null }],
      configFields: [], features: [], documentationUrl: null, activated: true, activationStatus: 'active', activationId: 'b7a1' };
    const { client, calls } = clientWith(() => DETAIL);
    const d = await client.getIntegration('servicenow-incident-sync');
    assert.equal(calls[0].url, `${ROOT}/integrations/servicenow-incident-sync`);
    assert.equal(d.isActivated, true);
    assert.equal(d.activated, true, 'the server field is kept');
    assert.equal(d.connectors[0].isRequired, true);
  });

  it('listIntegrations: isPopular / isNew come from the server\'s `popular` / `new`', async () => {
    // catalog EmbedCatalogResponse (wrapper) + its summary (Lombok boolean isPopular/isNew -> `popular`/`new`)
    const CATALOG = { integrations: [{ id: '0c6b', globalId: '8a1e', slug: 'sn', name: 'ServiceNow Incident Sync', description: 'Sync incidents',
      shortDescription: 'Sync incidents', category: 'ITSM', logoUrl: null, version: '1.2.0', tags: ['itsm'], publisherName: 'Acme',
      publisherVerified: true, popular: true, new: false, requiresOAuth: false, connectorCount: 2 }],
      categories: ['ITSM'], displaySettings: {}, branding: {}, totalCount: 1 };
    const { client, calls } = clientWith(() => CATALOG);
    const c = await client.listIntegrations({ category: 'ITSM' });
    assert.equal(calls[0].url, `${ROOT}/catalog?category=ITSM`);
    assert.equal(c.integrations[0].isPopular, true);
    assert.equal(c.integrations[0].isNew, false);
    assert.equal(c.totalCount, 1);
  });

  it('initiateOAuth sends a bare callback origin (the server reads redirectUri as one) and variables', async () => {
    // catalog EmbedOAuthInitRequest {redirectUri, state, variables}; IntegrationEmbedService puts redirectUri in
    // callbackOrigin, which connection CallbackOrigins.normalize refuses when it has a path.
    // Answer: catalog EmbedOAuthInitResponse {authorizationUrl, state, connectorGlobalId, connectorName}.
    const INIT = { authorizationUrl: 'https://login.example/authorize?x=1', state: 'init-token', connectorGlobalId: '5e2f', connectorName: 'ServiceNow' };
    const { client, calls } = clientWith(() => INIT);
    const r = await client.initiateOAuth('b7a1', '5e2f', { redirectUri: 'https://app.work.studio/embed/return?x=1', variables: { instance: 'dev12345' } });
    assert.equal(calls[0].url, `${ROOT}/activations/b7a1/oauth/5e2f/initiate`);
    assert.deepEqual(calls[0].body, { redirectUri: 'https://app.work.studio', variables: { instance: 'dev12345' } });
    assert.equal(r.authorizationUrl, INIT.authorizationUrl);
    await client.initiateOAuth('b7a1', '5e2f', { callbackOrigin: 'http://localhost:5173' });
    assert.deepEqual(calls[1].body, { redirectUri: 'http://localhost:5173' });
  });

  it('a refused scope is a 400 with message (MonolithFallbackExceptionHandler)', async () => {
    const { client } = clientWith(() => [400, { status: 400, message: 'Missing required scope: oauth:complete', timestamp: 1761800000000 }]);
    await assert.rejects(client.completeOAuth({ state: 's', code: 'c' }),
      e => e instanceof IntegrationsApiError && e.status === 400 && e.message === 'Missing required scope: oauth:complete');
  });

  it('listRegionWidgets keeps skipped[].detail', async () => {
    // catalog SurfaceWidgets.Rendered {widgets, skipped: [Skipped(widgetId, reason, detail)], contractVersion}
    const RENDERED = { widgets: [{ widgetId: 'w1', name: 'Open incidents', description: null, layout: 'SIDEBAR', width: '100%', height: '240px', order: 0,
      embedUrl: 'https://embed.example/widget?w=w1#token=svx_st_x', badgeOnLoad: true }],
      skipped: [{ widgetId: 'w2', reason: 'CONTEXT_NOT_SENT', detail: 'Needs deviceId, which this render did not send.' }], contractVersion: 3 };
    const { client, calls } = clientWith(() => RENDERED);
    const r = await client.listRegionWidgets('ticket.sidebar', { ticketId: 'T-42' }, { contractVersion: 3 });
    assert.equal(calls[0].url, `${ROOT}/surfaces/ticket.sidebar/widgets`);
    assert.equal(calls[0].headers['X-Region-Contract-Version'], '3');
    assert.equal(r.widgets.length, 1);
    assert.deepEqual(r.skipped, [{ widgetId: 'w2', reason: 'CONTEXT_NOT_SENT', detail: 'Needs deviceId, which this render did not send.' }]);
    assert.equal(r.contractVersion, 3);
  });

  it('mintSessionToken and listConnections read the server DTOs', async () => {
    // catalog EmbedSessionTokenResponse {token, expiresAt, scopeKey}; EmbedConnectionsResponse {connectors, mcp}
    const TOKEN = { token: 'svx_st_abc', expiresAt: '2026-10-30T15:15:00Z', scopeKey: 'customer:acme' };
    const CONNECTIONS = { connectors: [{ connectorGlobalId: '5e2f', name: 'ServiceNow', description: 'ITSM', logoUrl: null, category: 'ITSM', authType: 'oauth2',
      status: 'CONNECTED', connectedAt: '2026-10-28T09:12:00Z', usedBy: ['Incident Sync'], connectionId: 'c1', instanceId: 'i1', account: 'default',
      accountLabel: null, authScope: 'SHARED' }],
      mcp: { enabled: true, active: false, keyPrefix: null, createdAt: null, lastUsedAt: null, endpoint: 'https://api.example.test/api/v1/workflow/embed/mcp',
        writeEnabled: true, automations: false, serverName: 'Acme' } };
    const { client, calls } = clientWith(url => (url.endsWith('/session-tokens') ? TOKEN : CONNECTIONS));
    assert.deepEqual(await client.mintSessionToken('customer:acme', { ttlSeconds: 900 }), TOKEN);
    // catalog EmbedSessionTokenRequest {String scopeKey; Long ttlSeconds}
    assert.deepEqual(calls[0].body, { scopeKey: 'customer:acme', ttlSeconds: 900 });
    assert.deepEqual(await client.listConnections(), CONNECTIONS);
  });
});

describe('browser OAuth popup contract (connection MultiTenantSuccessHandler)', () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'window');
  afterEach(() => {
    if (saved) Object.defineProperty(globalThis, 'window', saved);
    else delete globalThis.window;
  });

  /** A window whose popup posts `message` (as the connection service's success page does) once opened. */
  function fakeWindow(message, { fromPopup = true } = {}) {
    const listeners = new Set();
    const popup = { closed: false };
    const win = {
      open: () => {
        setTimeout(() => {
          for (const l of listeners) l({ data: message, source: fromPopup ? popup : {} });
          popup.closed = true;
        }, 5);
        return popup;
      },
      addEventListener: (t, l) => t === 'message' && listeners.add(l),
      removeEventListener: (t, l) => t === 'message' && listeners.delete(l),
    };
    Object.defineProperty(globalThis, 'window', { value: win, configurable: true, writable: true });
  }

  // connection MultiTenantSuccessHandler (success page script): the message the popup posts to its opener.
  const SUCCESS = { type: 'connectionStatus', payload: 'success', connectionId: '6f1d2c3a-0b4e-4c8f-9a51-2d7e8b0c9f11',
    connectionInstanceId: 'a3c9e1f0-5b2d-4e7a-8c6f-1d0b9e2a7c44' };

  it('openOAuthPopup resolves with the popup\'s connectionStatus message', async () => {
    assert.equal(CONNECTION_STATUS_MESSAGE, 'connectionStatus');
    fakeWindow(SUCCESS);
    assert.deepEqual(await openOAuthPopup('https://login.example/authorize'), SUCCESS);
  });

  it('openOAuthPopup ignores a connectionStatus message that is not from its popup', async () => {
    fakeWindow(SUCCESS, { fromPopup: false });
    assert.equal(await openOAuthPopup('https://login.example/authorize'), undefined);
  });

  it('connectConnector binds the connection instance the popup reported', async () => {
    fakeWindow(SUCCESS);
    const bound = { ...ACTIVATION, status: 'active', pendingRequirements: [],
      connectors: [{ connectorGlobalId: '5e2f', connectorName: 'ServiceNow', connectorLogoUrl: null, connectionName: 'sn-acme', status: 'connected', connectedAt: null, expiresAt: null }] };
    const { client, calls } = clientWith(url => (url.endsWith('/initiate')
      ? { authorizationUrl: 'https://login.example/authorize', state: 's', connectorGlobalId: '5e2f', connectorName: 'ServiceNow' }
      : bound));
    const a = await connectConnector(client, 'b7a1', '5e2f');
    assert.equal(calls[1].method, 'POST');
    assert.equal(calls[1].url, `${ROOT}/activations/b7a1/connections/5e2f`);
    assert.deepEqual(calls[1].body, { connectionInstanceId: SUCCESS.connectionInstanceId });
    assert.equal(a.status, 'active');
  });

  it('connectConnector after a failed flow returns the activation as it stands', async () => {
    fakeWindow({ type: 'connectionStatus', payload: 'error', error: 'The user denied access' });
    const { client, calls } = clientWith(url => (url.endsWith('/initiate') ? { authorizationUrl: 'https://login.example/authorize' } : ACTIVATION));
    const a = await connectConnector(client, 'b7a1', '5e2f');
    assert.equal(calls[1].method, 'GET');
    assert.equal(calls[1].url, `${ROOT}/activations/b7a1`);
    assert.equal(a.status, 'pending');
  });
});
