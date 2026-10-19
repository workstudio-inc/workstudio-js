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

// The customer's connections, independent of any App
client.listConnections(): Promise<ConnectionsList>          // offered connectors + status + MCP access
client.disconnect(connectorGlobalId): Promise<{ removed }>

// Call a connector with the customer's own connection
client.listOperations(connectorGlobalId): Promise<ConnectorOperation[]>
client.execute(connectorGlobalId, operation, input?): Promise<ExecuteResult>

// The customer's AI assistant (MCP)
client.getMcpAccess(): Promise<McpAccess>
client.createMcpUrl(): Promise<McpUrl>                      // url is returned once
client.revokeMcpUrl(): Promise<void>
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

## Your customer's AI assistant

A customer who has connected their systems can use them from Claude, ChatGPT or Cursor. Create a
private MCP URL for them and show it once; the assistant then sees their connections as tools, with
their own credentials, and nothing of anyone else's.

```ts
const { url } = await client.createMcpUrl();   // show this to the customer, once
// later
await client.revokeMcpUrl();                   // the URL stops working immediately
```

The embedded catalog's Connections tab does this for you ("Use with AI assistants"). Turn it off for
every customer in Designer → Marketplace → Embed.

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

## Apps people use directly (`@workstudio-inc/sdk/app`)

For an App whose users sign in themselves - a web app, or a phone app in a web view. Every call is
made as the signed-in person, and the platform keeps each person to their own install of the App:
their projects, conversations, data and files, and nobody else's.

```ts
import { createApp, AllowanceUsed, SignInRequired } from '@workstudio-inc/sdk/app';

const app = createApp({
  apiUrl: 'https://api.work.studio',
  signInIssuer: 'https://auth.work.studio/realms/apps',
  clientId: 'crava-web-01a14509',     // shown in the App's "Direct use" settings
  appId: '01a14509-a685-...',          // optional: lets visitors read the App's public content
});

// Sign in on the hosted page (Google, Apple, Microsoft, GitHub or email), then finish when it sends
// the person back. Naming a provider skips the hosted page and goes straight to it.
await app.auth.completeSignIn();      // at start-up; a no-op unless returning from sign-in
if (!(await app.auth.signedIn())) await app.auth.signIn({ method: 'google' });

// Their own projects
const project = await app.projects.create({ name: 'Kitchen side table' });

// A conversation with one of the App's agents. A project has one: starting again picks it up.
const chat = await app.chat.start({ agentId: DESIGNER_AGENT, projectId: project.id });
const reply = await chat.send('A walnut side table, 50cm square, with a lower shelf', {
  onText: piece => render(piece),
  attachments: [photo],               // photos or PDFs, optional
});
await app.chat.list({ projectId: project.id });
await app.chat.rename(chat.id, 'Side table');
// An answer the App cannot use (unparseable, empty, fails its checks): give the person back what
// that turn cost. Once per turn, within 10 minutes, a limited number of times a month. A turn that
// ended in an error was never counted (TurnFailed.notCharged).
if (!usable(reply) && reply.turnRef) await chat.waive(reply.turnRef, 'no proposals');

// Records in a collection the App declares - only this person's
const designs = app.data.collection<{ title: string; status: string }>('crava_designs');
const saved = await designs.create({ title: 'Side table', status: 'draft' });
await designs.update(saved.id, { status: 'checked' });     // merges; replace() replaces

// What the App ships - templates, featured designs - at the version their install runs. Read-only.
// Before anyone signs in, a pack the App lists in its publicContent, at its latest approved release
// (needs appId).
const templates = await app.content.pack<{ title: string }>('crava_templates').list();

// Their files
const file = await app.files.upload(photo);

// App stores require account deletion inside the app
await app.account.delete();
```

- **Phone apps**: pass `openUrl` (e.g. Capacitor's `Browser.open`) and `redirectUri` (your app's
  scheme), and call `completeSignIn(url)` with the deep link. Pass `storage` to keep the sign-in in
  secure storage.
- **Servers** acting for a signed-in person: pass `platformToken: () => token` instead of the sign-in
  settings.
- **Errors**: `SignInRequired` (sign in again), `AllowanceUsed` (this month's AI allowance is spent),
  `TurnFailed` (an answer that ended in an error; `notCharged` says it was not counted against the
  allowance), and `AppError` with `status` and a `message` fit to show.
- **What the App sets up on the platform**: its agents (bundled with the App), its data collections
  (`dataCollections` in its end-user access), its content packs (`contentReferences`, pinned when
  an App version is approved), the monthly AI allowance per person, sign-in methods and branding.

### Plans: paid tiers for the App's people

An App can sell plans - say Free with $1 of AI a month and Plus with $5 - paid to the App
publisher's own Stripe account through Stripe's hosted Checkout and customer portal (the App never
sees a card). A person's plan sets their monthly AI allowance; it comes with their next platform
token, so call `billing.refresh()` when they come back from paying.

```ts
const plan = await app.billing.plan();
// { enabled: true, plan: 'free', name: 'Free', monthlyBudgetUsd: 1, paid: false, canUpgrade: true,
//   plans: [{ id: 'free', ... }, { id: 'plus', name: 'Plus', monthlyBudgetUsd: 5,
//            prices: [{ id: 'price_...', interval: 'month', amountCents: 799, currency: 'usd' }, ...] }] }

// Buy: goes to Stripe Checkout (openUrl on a phone). The addresses must be on the App's own web origins.
await app.billing.checkout({ priceId: plus.prices[0].id, successUrl: 'https://crava.me/#plus-welcome' });

// Back at the success address: ask Stripe how it stands and get a token with the new allowance.
const now = await app.billing.refresh();      // now.plan === 'plus'

// Change the card, see invoices, cancel (the plan stays until the period's end).
if (now.canManage) await app.billing.manage({ returnUrl: 'https://crava.me/' });
```

- `renewsAt` / `endsAt` say when a paid plan renews, or - cancelled - when it ends; `past_due` keeps
  the plan for a few days while Stripe retries the payment.
- `checkout` refuses (`AppError` 409, `ALREADY_SUBSCRIBED`) while the person already pays: send them
  to `manage()` instead. Pass `open: false` to either to get the address without going there.
- `app.auth.renew()` gets a fresh platform token at any time.
- Deleting the account (`account.delete()`) cancels the person's subscription at once.
- The publisher sets the plans (`PUT .../catalog/integrations/{id}/end-user-access/billing`) and
  connects their Stripe account (`PUT .../end-user-access/billing/stripe-key`, write-only).
- Phone apps: app stores have their own rules for selling digital goods in an app; check them before
  offering `checkout` inside a phone build.

## Build

```
npm install
npm run build      # emits ESM + CJS + .d.ts to dist/
npm run typecheck
```
