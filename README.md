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

// Your regions, for a host that frames widgets itself instead of using <svx-region>
client.listRegionWidgets(regionKey, context, { contractVersion? }): Promise<RegionWidgets>
//   { widgets: [{ widgetId, name, layout, height, order, embedUrl, ... }], skipped: [{ widgetId, reason }], contractVersion? }
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
// A big pack a page at a time - a gallery that loads as people scroll. `fields` leaves heavy data out
// of the list, `tag` filters on the platform (several tags mean any), `facets: 'tags'` counts every
// tag over the whole pack (for filter tabs). Pass `nextCursor` back for the next page; it is null on
// the last. A cursor belongs to one pack version: a 409 means a new release landed - start again.
const gallery = app.content.pack<{ title: string; tags: string[] }>('crava_templates');
const first = await gallery.page({ limit: 12, tag: ['kitchen', 'dining room'], fields: ['title', 'tags', 'image'], facets: 'tags' });
const more = first.nextCursor ? await gallery.page({ limit: 12, tag: ['kitchen', 'dining room'], fields: ['title', 'tags', 'image'], cursor: first.nextCursor }) : null;
// One item, whole, without reading the rest of the pack (null when it is not there).
const one = await gallery.item('walnut-sideboard');   // { key, data, sortOrder, version }

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
  `AiPaused` (AI is paused in the App for everyone on the person's plan, or for everyone - see below),
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
- **Free trials**: a plan may start with a free trial (`plans[].trialDays`). `checkout` takes it when the
  person can still have one (`plans[].trialAvailable` - one trial per person per App; a cancelled trial
  does not give another), unless you pass `trial: false` to buy now. While it runs, `status` is
  `trialing` and `trialEndsAt` says when it ends. A trial the publisher lets start without a card
  ends there and the person drops back to the default plan (their data stays): when `hasPaymentMethod`
  is false, say "add a card to keep Pro" and send them to `manage()`.
- **Discount codes**: when the publisher allows them, Stripe Checkout shows a promotion code field.
- Deleting the account (`account.delete()`) cancels the person's website subscription at once. For App
  Store and Google Play subscriptions, see `account.deletionCheck()` below.
- The publisher sets the plans (`PUT .../catalog/integrations/{id}/end-user-access/billing`) and
  connects their Stripe account (`PUT .../end-user-access/billing/stripe-key`, write-only).
- Phone apps: don't offer `checkout` inside an iOS or Android build. Sell there through the App Store
  and Google Play with `billing.store` (next section).
- `checkout` refuses (`AppError` 409, `STORE_SUBSCRIPTION_LIVE`) while the person subscribes through the
  App Store or Google Play. The upgrade happens in the store where they subscribed.

### Plans in the iOS and Android apps (App Store and Google Play)

The same plans can be bought in the App's own phone apps, through the App Store and Google Play. Each
plan maps to a store product per interval; the publisher sets this in the manifest's `plans` step. The
SDK never touches StoreKit or Play Billing. The app buys with its own plugin (for example
`@capgo/native-purchases`) and hands the SDK what the store returned. The platform verifies every
purchase with Apple or Google; nothing the app says about a purchase is trusted. A person has one plan
however they bought it, on every device and on the web.

```ts
// 1. The paywall. Ask each time it opens: the publisher can change it without an app release.
const offer = await app.billing.store.offer({
  platform: 'ios',
  storefront: storefront.countryCode,         // iOS alpha-3 'USA'; Android alpha-2 'US'
  appTransactionId,                           // iOS: AppTransaction.shared.appTransactionID (optional)
});
// { storeAccountToken, canBuy, message?, cancelsCurrent, upgradeNotice?, trial?, current?, linkOut?,
//   plans: [{ id: 'pro', name: 'Crava Pro', canBuy: true,
//             products: [{ interval: 'month', apple: { productId: 'me.crava.pro.monthly',
//                                                     introductoryOfferEligibilityJws?: '...' },
//                          webPrice?: { amount: 4900, currency: 'usd', interval: 'month' } }] }] }
if (!offer.canBuy) showMessage(offer.message!);            // e.g. "You have Crava Plus. Manage it where you subscribed."
if (offer.cancelsCurrent) confirm(offer.upgradeNotice!);   // shown before buying: the website plan is cancelled and refunded

// 2. Buy with the plugin. Show the store's own localized price, never a catalog price.
//    iOS: appAccountToken = offer.storeAccountToken, and .introductoryOfferEligibility(compactJWS:) when given.
//    Android: obfuscatedAccountId = offer.storeAccountToken; the offer token of products[].google.offerId when
//    present, else the base plan's.
const tx = await buyWithYourPlugin(/* ... */);

// 3. Hand it over. The platform verifies it, makes it the person's, and the SDK gets a token with the new
//    allowance. Finish the transaction once this returns.
const plan = await app.billing.store.verify({ platform: 'ios', jws: tx.jwsRepresentation });
// Android: verify({ platform: 'android', purchaseToken })

// "Restore purchases" (Apple requires the button): everything the store has, in one call.
const { plan: restored, items } = await app.billing.store.restore({ platform: 'ios', jws: entitlements });
// Android: restore({ platform: 'android', purchaseTokens }); items: [{ id, result, purchase }]

// Managing: where the plan in force lives decides what to open.
const where = app.billing.store.manage(plan);
if (where?.kind === 'apple') await NativePurchases.manageSubscriptions();   // StoreKit; else open where.fallbackUrl
else if (where?.kind === 'google') await Browser.open({ url: where.url });
else if (where?.kind === 'stripe_portal') await app.billing.manage();
```

- **Link-out** (US App Store only, when the publisher turns it on): `offer.linkOut.url` is the website's
  plans page, to open in the system browser beside in-app purchase, never instead of it. Each product
  then carries `webPrice` ("$11.99 here, or $9.99 on crava.me"). Everywhere else there is no `linkOut`
  and no `webPrice`, and `message` and `upgradeNotice` never name the website. The server decides, so
  stale app copy can't break a store rule. Google Play link-out is not available yet.
- **Trials**: one free trial per person per App, across the web and both stores. On iOS pass
  `appTransactionId` so Apple is told (`trial.enforced`); on Android `offerId` is there only while the
  trial is unused.
- **Plan fields**: `source` (`web`, `apple`, `google`), `manage`, `otherPaying`, `paidTwice`,
  `paidTwiceNotice` and `next` (a downgrade made in the store: "Plus from <date>").
- **Paying twice** (the website and a store at once): the platform cancels the website subscription and
  refunds its unused part. `paidTwiceNotice` is the banner: `auto_cancelled` with the `refund`, or
  `failed`. With `failed`, offer "Cancel the website subscription": `app.billing.resolvePaidTwice()`.
- **Errors**:
  - `StorePurchaseOtherAccount` (409): the Apple ID or Google account's subscription belongs to another
    account in this App. Show its `message` ("Sign in with that account"); the other account is never
    named.
  - `TooManyTries` (429): more than 30 verifies or 6 restores in 10 minutes.
  - `TooManyPurchases` (400): more than 20 purchases in one restore.
  - `BillingUnavailable` (503, `UNAVAILABLE` or `STORE_UNAVAILABLE`): try again shortly. The store
    keeps the purchase, so verify it later.
  - `AppError` with `STORE_PURCHASE_INVALID`, `UNKNOWN_PRODUCT` or `NO_PURCHASE` otherwise.
- **Deleting the account**: call `app.account.deletionCheck()` first. With `appleSubscription`, tell the
  person Apple keeps billing until they cancel in the App Store, and offer
  `billing.store.manage(sub.manage)`, then delete if they confirm (Apple guideline 5.1.1(v)). The
  platform cancels Google Play subscriptions on deletion.

### Shared projects: an owner and a client on one piece of work

`app.sharedProjects` is a private space between two of the App's people: the **owner** side (a shop,
whose plan has the App's project feature) and the **client** side. Only the two of them can read it - the
platform enforces that in its database; the App's publisher sees counts only. (`app.projects` is still
the person's own projects.)

```ts
// The owner starts one from a request sent to their listing, optionally with revision 1
const job = await app.sharedProjects.startFromRequest(request.id, { kind: 'job' });
// ...or the client continues from the owner's proposal link
const same = await app.sharedProjects.continueFromShare(shareToken);

// The owner posts numbered, frozen revisions: the App's JSON, a price and a lead time
const r = await app.sharedProjects.postRevision(job.id, {
  payload: design, price: { amount: '1240.00', currency: 'USD' }, leadTime: '3-4 weeks',
  summary: 'wider, adjustable shelves, +$80', changes: whatChanged, answers: [changeRequestId],
});
// Either side talks and asks for changes; the owner declines one with a reason or answers it with a revision
await app.sharedProjects.message(job.id, 'Could it be 10 cm wider?');
await app.sharedProjects.requestChange(job.id, { body: '10 cm wider', revision: r.number });
// The client approves the latest revision at its price: the project is `agreed`; a later revision needs approving again
await app.sharedProjects.approve(job.id, { revision: r.number, hash: r.hash });
// Read state is per person, the same on every device
await app.sharedProjects.markRead(job.id);
const badge = await app.sharedProjects.unread();   // { projects, entries }
```

When the owner side's plan loses the feature, messages go on but new revisions and approvals are paused
(`paused: true`; 403 `FEATURE_PAUSED`). When one side deletes their account the other keeps a read-only
record with that person's messages and contact removed.

### Push notifications to the person's phone

A phone build can have the App's automations push to the person ("New quote request") - sent with the
App's own Apple and Firebase credentials, which the publisher sets in the App's Push settings. The SDK
does not touch the phone: the App asks for permission (at a moment the person sees why), gets the token,
and hands it over after sign-in, on every launch.

```ts
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';

PushNotifications.addListener('registration', t =>
  app.push.register(t.value, Capacitor.getPlatform() as 'ios' | 'android', { appVersion: '1.4.0' }));
PushNotifications.addListener('pushNotificationActionPerformed', async ({ notification }) => {
  // Only act on pushes for the person signed in here (a shared phone can hold someone else's), and only go to
  // a route in the App - routeOf is null for anything else (another site, a backslash, a space).
  if (!(await app.push.isForMe(notification.data))) return;
  const route = app.push.routeOf(notification.data);   // e.g. #inbox/<id>
  if (route) location.hash = route.startsWith('#') ? route : `#${route}`;
});
if ((await PushNotifications.requestPermissions()).receive === 'granted') await PushNotifications.register();

// Signing out: the SDK forgets the device on the platform; the phone's own registration and the
// notifications already on screen are the App's to clear.
async function signOut() {
  await app.auth.signOut();
  await PushNotifications.removeAllDeliveredNotifications();
  await PushNotifications.unregister();
}

await app.push.preferences.set({ categories: { proposals: false }, quietStart: '22:00', quietEnd: '07:00',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
await app.push.devices();                 // their registered devices; setEnabled(id, false) silences one
```

- iPhone tokens go by Apple (APNs), Android tokens by Firebase (FCM); pass `apnsEnvironment: 'sandbox'`
  for a development build run from Xcode.
- `auth.signOut()` forgets the device first (best effort, a few seconds at most); `unregister()` does it
  by hand. If that cannot reach the platform (offline), the platform keeps the token until the next person
  registers it on that phone (the token then moves to them) - the SDK's later retry rarely helps, so the
  plugin's own unregister below is what actually stops the phone. Deleting the account removes the person's devices.
- A shared phone: the phone shows a push itself, before the App runs, so `scopeHash` only decides what a tap
  does. On sign-out also call the plugin's own `PushNotifications.unregister()` and clear delivered
  notifications, and always check `isForMe` (then `routeOf`) before acting on a tap.
- A lock screen is public: pushes carry names and titles, never what someone wrote. `data.open` is an
  App-relative route; `data.scopeHash` says whom it is for.
- On Android, the channel an automation names must exist in the app (`PushNotifications.createChannel`).
- No device, pushes turned off, or quiet hours: the automation's email goes instead, when it has one.

### When AI is paused

Besides each person's allowance, a publisher can cap what all the people on a plan spend together
(a shared pool: say the free plan's $20 a day and $200 a month), and its own AI budget can run out.
Then AI is paused in the App until a set time; everything else keeps working. Ask before starting:

```ts
const ai = await app.ai.status();          // cached 30 s; never throws; 2 s timeout
// { paused: true, reason: 'pool', code: 'APP_FREE_POOL_PAUSED', scope: 'day',
//   resetAt: '2026-10-21T00:00:00Z', plan: 'free', known: true }
if (ai.paused && ai.reason !== 'allowance') showPaused(new Date(ai.resetAt!));   // the person's local time
```

- `reason`: `pool` (their plan's shared pool - people on other plans are not affected), `app_budget`
  (the App's own budget - everyone), `allowance` (their own monthly allowance; a request would throw
  `AllowanceUsed`).
- A request refused anyway throws `AiPaused` with the same `reason`, `scope`, `resetAt` and `plan`
  (codes `APP_FREE_POOL_PAUSED`, `APP_AI_PAUSED`); `status()` then answers paused at once.
- It fails open: signed out, offline, slow, or a platform without the check answers
  `{ paused: false, known: false }`.
- A turn already running when the pool runs out is let finish, and so are up to two follow-up turns of
  the same conversation within 15 minutes, so a multi-round request is not cut off half done.

### Credits

An App with `plans.credits` shows one balance instead of dollars: the plan's monthly credits are spent
first, then credits the person bought, which never expire.

```ts
const c = await app.credits.balance();     // cached 30 s
// { available: 420, monthly: { left: 320, total: 500, period: 'month', resetsOn: '2026-11-01' },
//   bought: { left: 100 }, state: 'ok', hints: { design: 25, picture: 3 }, unit: { name: 'credits', one: 'credit' } }
app.credits.onChange(c => pill.set(c.available));   // after every chat turn and picture too
const { credits } = await app.credits.estimate('picture');   // "Uses about 3 credits"
const packs = await app.credits.packs();   // canBuy false with why: NOT_FOR_YOUR_PLAN on Free
await app.credits.buy('small', { successUrl: location.href });   // Stripe Checkout on the publisher's account
const { entries } = await app.credits.history();     // "Bought 450", "Used 37"
```

- An action starts only when enough credits are left, then runs to its end. Refused, it throws
  `CreditsUsedUp` (code `CREDITS_USED_UP`, `scope` `month` or `once`, `resetAt`); `ai.status()` answers
  `reason: 'credits'`. Show it as "out of credits", never as an error.
- Buying is web-only for now (`buy(..., { platform: 'ios' })` throws `IN_APP_NOT_YET`); `NotForYourPlan`
  when the person's plan does not sell packs. `account.deletionCheck()` carries `credits.bought`, which
  deleting the account removes.

### Invites

A publisher's invite is a single-use link, `<the App's site>/i/<token>`, that gives one of the App's paid plans
for some months - no payment, no card. The App's invite page:

```ts
const token = app.invites.tokenFromUrl();            // this page's address; null when it is not an invite link
const p = await app.invites.preview(token);          // public, before sign-in: { plan: { name: 'Pro' }, months: 3, status: 'ok', ... }
// ... the person signs up or signs in ...
const { grant, plan } = await app.invites.redeem(token);   // then a fresh token: the plan is theirs now
// plan.source === 'grant', plan.paid === false, plan.endsAt === grant.endsAt
```

- `preview` needs `appId` in the config; it never says who the invite was for or who used it.
- Refusals are `AppError` codes: `INVITE_USED`, `INVITE_EXPIRED`, `INVITE_REVOKED`, `INVITE_EMAIL_MISMATCH`
  (sign in with the address it was sent to), `INVITE_ALREADY_HAD` (one per person per App), `PLAN_NOT_INVITABLE`,
  `NO_SUCH_INVITE`, `SLOW_DOWN`.
- On a grant `billing.plan()` offers Subscribe (`canUpgrade`), never Switch (`canChange` is false), and no free
  trial. Subscribing to the SAME plan collects the card now and charges at the grant's end
  (`billing.checkoutLink()` answers `firstChargeAt`; then `plan.grant.keepsAfterGrant` and `plan.next`). A
  DIFFERENT plan starts at once and ends the grant. When a grant ends with nothing after it, the person is on the
  free plan again, keeping everything.

## Build

```
npm install
npm run build      # emits ESM + CJS + .d.ts to dist/
npm run typecheck
npm test           # builds, then runs test/*.test.mjs on dist/ (node:test)
```
