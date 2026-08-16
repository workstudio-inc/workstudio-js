# @workstudio-inc/sdk

Headless TypeScript SDK for the **WorkStudio embeddable integration marketplace**.

It wraps the `/embed` API with typed methods and carries **no UI** — build the catalog, activation, and connection experience however you want (React, Vue, Svelte, plain DOM). Your product team owns the pixels; the SDK owns the protocol.

```
npm install @workstudio-inc/sdk
```

---

## Quick start

```ts
import { IntegrationsClient } from '@workstudio-inc/sdk';

const client = new IntegrationsClient({
  apiKey: process.env.WS_EMBED_KEY,   // svx_ik_...  (server-side secret)
  tenantId: 'a8737fb0-0d10-4aab-809b-d54ef71dc8f1',
  scopeKey: 'customer:acme',          // which of YOUR customers this is for
});

// 1. List what's available
const { integrations } = await client.listIntegrations();

// 2. Activate one
const activation = await client.activate('servicenow');

// 3. Anything the customer still needs to do is in pendingRequirements
for (const req of activation.pendingRequirements ?? []) {
  console.log(req.type, req.connectorName, req.authorizationUrl);
}
```

---

## Authentication & scoping

There are two ways to authenticate, and they differ in **how the customer scope is trusted**:

| Mode | Use it | How to set the customer scope |
|---|---|---|
| **API key** (`apiKey`) | Server-side / backend-for-frontend | Pass `scopeKey` (sent as `X-Embed-Scope`). Trusted because the API key is a secret only your server holds — like Stripe's `Stripe-Account`. |
| **Custom JWT** (`token`) | Directly in the browser | The scope is a **claim inside the signed token** and cannot be forged. `scopeKey` in the config is ignored. |

> **Never ship an API key to a browser.** For browser embeds, mint a short-lived custom JWT per customer on your server and pass it as `token`.

```ts
// Browser embed — scope is inside the signed JWT
const client = new IntegrationsClient({ token: shortLivedCustomerJwt, tenantId });
```

You can also override the scope per call:

```ts
await client.activate('powerbi', { scopeKey: 'customer:globex' });
```

### Secure browser embeds — session tokens (recommended)

The cleanest way to auth a browser embed: your **backend** exchanges the API key for a **short-lived,
single-customer-scoped session token** (`svx_st_…`), and only that token reaches the browser. The API
key never leaves your server.

```ts
// 1. Server (your backend) — mint a scoped, short-lived token
const server = new IntegrationsClient({ apiKey: process.env.WS_KEY, tenantId });
const { token, expiresAt } = await server.mintSessionToken('customer:acme', { ttlSeconds: 900 });
// send `token` to the browser (it expires in ~15 min and is scoped to this one customer)

// 2. Browser — use the session token, never the API key
const client = new IntegrationsClient({ token, tenantId });
await client.listIntegrations();
```

The web component / iframe accept the same token (`<svx-integration-catalog token="svx_st_…">`), and
the web component injects it over `postMessage` so it never appears in the URL, history, or logs.

---

## API

All methods return typed promises and throw `IntegrationsApiError` on non-2xx responses.

```ts
// Catalog
client.listIntegrations({ category?, search? }): Promise<Catalog>
client.getIntegration(idOrSlug): Promise<IntegrationDetail>

// Activations
client.listActivations(): Promise<Activation[]>
client.getActivation(activationId): Promise<Activation>
client.activate(integrationIdOrSlug, { config?, metadata?, scopeKey? }): Promise<Activation>
client.deactivate(activationId): Promise<void>

// Connections
client.bindConnection(activationId, connectorGlobalId, connectionInstanceId): Promise<Activation>
client.disconnectConnection(activationId, connectorGlobalId): Promise<Activation>

// OAuth
client.initiateOAuth(activationId, connectorGlobalId, { redirectUri?, state? }): Promise<OAuthInitResult>
client.completeOAuth({ code, state, activationId?, connectorGlobalId?, connectionInstanceId? }): Promise<OAuthCallbackResult>
```

### Activation & connector state

`Activation.status` is `pending | active | failed | disabled`. Connector-level state lives in:

- `activation.connectors[]` — connected connectors (`status: connected | expired | error`)
- `activation.pendingRequirements[]` — connectors still needing OAuth/config

```ts
const total = integration.connectorCount;
const connected = activation.connectors?.filter(c => c.status === 'connected').length ?? 0;
render(`${connected}/${total} connected`);
```

---

## Connecting a connector (browser)

The browser entry point adds a popup-based OAuth helper so a "Connect" button is one call:

```ts
import { connectConnector } from '@workstudio-inc/sdk/browser';

async function onConnectClick(activationId: string, connectorGlobalId: string) {
  const updated = await connectConnector(client, activationId, connectorGlobalId);
  // `updated` is the refreshed activation with the connector now connected
}
```

Prefer to drive the flow yourself? Use the primitives:

```ts
import { openOAuthPopup } from '@workstudio-inc/sdk/browser';

const { authorizationUrl } = await client.initiateOAuth(activationId, connectorGlobalId);
await openOAuthPopup(authorizationUrl);
const activation = await client.getActivation(activationId);
```

---

## Example: a tiny React hook

The SDK ships no React dependency — a hook is a few lines on top of it:

```tsx
import { useEffect, useState, useMemo } from 'react';
import { IntegrationsClient, type Catalog } from '@workstudio-inc/sdk';

export function useCatalog(config) {
  const client = useMemo(() => new IntegrationsClient(config), [config]);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    client.listIntegrations().then(setCatalog).catch(setError);
  }, [client]);

  return { client, catalog, error };
}
```

---

## Configuration reference

```ts
new IntegrationsClient({
  apiKey?:   string,   // svx_ik_...  (server-side)
  token?:    string,   // JWT (browser)
  tenantId?: string,   // X-Embed-Tenant (required for API-key auth)
  envId?:    string,   // X-Embed-Env
  scopeKey?: string,   // X-Embed-Scope, e.g. "customer:acme" (API-key mode)
  origin?:   string,   // X-Embed-Origin (origin allowlist)
  baseUrl?:  string,   // default 'https://api.work.studio'
  basePath?: string,   // default '/api/v1/workflow/embed'
  fetch?:    typeof fetch, // custom fetch on older runtimes
});
```

If your gateway routes the embed API under a different prefix, override `basePath` (e.g. `/api/v1/workflow/catalog/embed`).

---

## Error handling

```ts
import { IntegrationsApiError } from '@workstudio-inc/sdk';

try {
  await client.activate('servicenow');
} catch (e) {
  if (e instanceof IntegrationsApiError) {
    if (e.isAuthError) { /* 401/403 — bad key or missing scope */ }
    console.error(e.status, e.body);
  }
}
```

---

## Build

```
npm install
npm run build      # emits ESM + CJS + .d.ts to dist/
npm run typecheck
```
