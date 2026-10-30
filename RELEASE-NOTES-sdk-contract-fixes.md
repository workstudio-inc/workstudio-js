# @workstudio-inc/sdk - contract fixes (branch `sdk-contract-fixes`, on 0.14.0)

Every public method of the embed client (`IntegrationsClient`), `@workstudio-inc/sdk/browser` and the App SDK
(`@workstudio-inc/sdk/app`) was checked against the server code on origin/main (2026-10-30): the route, the request
body, the response DTO and the credential. Every route exists and accepts the credential the SDK sends. The fixes
below are about response shapes and request semantics. No version bump was made; this is for the next release.

"Since" gives the SDK commit that introduced the code, its date, and the first `v*` tag that shipped it. Where the
server changed later, its commit is given too.

## Fixed: the SDK misread the server

### 1. `chat.reconnect()` resolved `null` for a turn that had already ended
- **What was wrong.** After a reload, the platform answers a reconnect for an ended turn with two events:
  `event:turn_outcome` (data: the bare `TurnOutcome` record, which has **no `type` field**), then `no_active_turn`
  (see ai-runtime `TurnOutcomes.reconnect`). The SDK only looked at `data.type`, so it never saw the outcome.
  It then reached `no_active_turn` and resolved `null` ("no turn on record").
- **Fix.** The SSE reader now takes an event's type from its `event:` line when the data has no `type`. This
  applies to both `send` and `reconnect`.
- **Since.** SDK `ee06e7f` (2026-10-27), first shipped in **v0.13.0**. The server event shape is ai-runtime
  `2b34a7cb` (2026-10-27).
- **What callers change.** Nothing.
- **Breaking?** No. Code that treated `null` as "unknown, ask `chat.turn()`" still works; it now gets the outcome
  straight away.

### 2. A stopped turn: `send()` returned the partial text as if complete, or threw 502
- **What was wrong.** `cancelled` is the last event of a stopped turn's stream, and no `done` or `error` follows
  it (ai-runtime `SessionStreamEventSender.sendCancelledEvent`). The SDK ignored it. `send()` then resolved the
  partial text as a normal reply, or threw `AppError(502, 'The answer stopped before it began.')` when nothing had
  streamed. `reconnect()` treated the end of the stream as a drop and asked again.
- **Fix.**
  - `send()` now resolves with `{ text: <what streamed>, cancelled: true, turnRef, notCharged, ... }`.
    `Reply.cancelled` is new.
  - `reconnect()` reads the outcome back (`status: 'cancelled'`).
- **Since.** The SDK parser dates from `58c89d4` (2026-10-16, **v0.3.0**). The server has sent `cancelled` since
  ai-runtime `c81015a5` (2026-10-28), so every SDK version is affected from that date.
- **What callers change.** Check `reply.cancelled` if you treat a stopped answer differently.
- **Breaking?** Only for one case. If nothing had streamed before the stop, `send()` used to throw 502. It now
  resolves with `text: ''` and `cancelled: true`. Code that relied on that 502 (catching it to mean "stopped")
  must check `reply.cancelled` instead.

### 3. `chat.history()` turns had no `role`
- **What was wrong.** The server returns base-ai-common `AgentTurn` objects:
  `{ type: 'USER_MESSAGE' | 'ASSISTANT_MESSAGE' | 'TOOL_CALL' | 'TOOL_RESULT' | 'ERROR' | 'SYSTEM' | 'SYSTEM_SUMMARY', content, toolCalls, timestamp, ... }`.
  There is no `role`, and `content` is `null` on tool turns. The SDK typed them as `{ role: string; content: string }`.
- **Fix.** Each turn now gets the `role` the type promised:
  - `user` and `assistant` are the messages to show;
  - `tool`, `error` and `system` are the agent's own working.

  `content` is `''` when the turn has none. Every server field is kept (`type`, `timestamp`, ...).
- **Since.** `58c89d4` (2026-10-16), **v0.3.0**.
- **What callers change.** Filter to `role === 'user' || role === 'assistant'` to show a chat.
- **Breaking?** No for anyone who read `type`: it is still there, unchanged, and the number and order of turns is
  unchanged. The only difference is that `role` and a non-null `content` are now set.

### 4. `push.preferences.set({ quietStart: null, quietEnd: null })` silently did nothing
- **What was wrong.** For the platform, an absent or `null` field means "unchanged" and `""` means "clear"
  (notification `AppPushDevices.quiet()` / `timezone()`). The SDK's type allowed `null`, so the call type-checked,
  returned 200, and changed nothing. A category could not be removed at all.
- **Fix.** A `null` for `quietStart`, `quietEnd` or `timezone` is now sent as `""`. A category may be set to `null`,
  which drops the person's choice for it. The input type is the new `PushPreferencesChange`.
- **Since.** `c29ae3f` (2026-10-23), **v0.9.0**.
- **What callers change.** Nothing; send `null` to clear. The two quiet-hour fields still go together.
- **Breaking?** No. Callers who already sent `""` still send `""`.

### 5. Sign-in refusal codes were dropped (`NOT_A_MEMBER`, `MEMBERSHIP_UNAVAILABLE`)
- **What was wrong.** The token exchange (connection `OAuthTokenExchangeController`) refuses a members-only App's
  outsider with `403 { error: 'invalid_target', error_description, code: 'NOT_A_MEMBER', organization }`, and an
  unreadable membership with `503 { error: 'temporarily_unavailable', code: 'MEMBERSHIP_UNAVAILABLE' }`. The SDK
  kept only `error` and `error_description`. So `completeSignIn()` threw `AppError(403, ..., 'invalid_target')`,
  and an App could not tell "not a member" from any other refusal.
- **Fix.** `AppError.code` is now the platform's `code` when it gives one, otherwise the RFC `error` as before.
  `AppError.details` is the whole refusal, including `error` and `organization`.
- **Since.** `4f13af8` (2026-10-26), **v0.10.1**. The server added `NOT_A_MEMBER` in connection `a461310e`
  (2026-10-26).
- **What callers change.** Check `e.code === 'NOT_A_MEMBER'`, and use `e.details.organization` to name the
  organization.
- **BREAKING for anyone who worked around it.** For these two refusals, `e.code` was `'invalid_target'` (403) or
  `'temporarily_unavailable'` (503); it is now `'NOT_A_MEMBER'` or `'MEMBERSHIP_UNAVAILABLE'`. Code that compared
  `e.code === 'invalid_target'` after `completeSignIn()` must also accept `NOT_A_MEMBER`, or compare
  `e.details?.error`. Other refusals keep their old code. Sign-out on a renewal refused with `invalid_target` is
  unchanged.

### 6. `images.make()`: every 402 became `AllowanceUsed`
- **What was wrong.** ai-runtime `EndUserImagesController` answers 402 for three different things:
  - `NO_ALLOWANCE`: "Pictures are not available in this app yet." This is set up by the App, not by the person.
  - `ALLOWANCE_USED`
  - `COST_POLICY_EXCEEDED`

  The SDK turned all of them into `AllowanceUsed` ("this month's allowance is used up").
- **Fix.** Only `ALLOWANCE_USED`, `COST_POLICY_EXCEEDED`, or a 402 with no code, is `AllowanceUsed`; this matches
  `chat.send`. `NO_ALLOWANCE` is an `AppError` with status 402 and code `NO_ALLOWANCE`. `Picture` gains `pictureId`,
  `redo` and `freeRedosLeft`, which the server already sent.
- **Since.** `73ba55c` (2026-10-18), **v0.5.0**. The server added `NO_ALLOWANCE` in ai-runtime `e05746b5`
  (2026-10-25).
- **Breaking?** Yes, for `NO_ALLOWANCE` only. A caller that caught `AllowanceUsed` for it now gets a plain
  `AppError` (`code: 'NO_ALLOWANCE'`).

### 7. `content.pack(...).page({ limit })` above 60 was a 400
- **What was wrong.** The platform refuses `limit` outside 1..60 (catalog `ContentPages.MAX_LIMIT`). The SDK sent
  the value as given, although its local paging clamps to 60.
- **Fix.** The limit is clamped to 1..60 before it is sent.
- **Since.** `9ce6acb` (2026-10-19), **v0.7.0**.
- **Breaking?** No.

### 8. `chat.send()` refused for the day (429 `DAILY_LIMIT`)
- **What was wrong.** The platform's sentence and its `resetAt` were dropped: the SDK threw
  `AppError(429, 'No answer just now...', 'DAILY_LIMIT')` with no details.
- **Fix.** The message is now the platform's own ("You've asked 20 questions today..."), and `details` is the body,
  including `resetAt`. A `TurnFailed` from a stream error event now carries that event as `details`.
- **Since.** `904c2d5` (2026-10-28), **v0.14.0**. The server added `DAILY_LIMIT` in ai-runtime `c2274961`
  (2026-10-26).
- **Breaking?** No, only `message` and `details` change. The code is still `DAILY_LIMIT`.

### 9. Embed: `getIntegration().isActivated` and `listIntegrations()` `isPopular` / `isNew` were always undefined
- **What was wrong.** These are Lombok `boolean isX` fields (catalog `EmbedIntegrationDetail`,
  `EmbedCatalogResponse`), which Jackson serialises as `activated`, `popular` and `new`.
- **Fix.** The client now sets `isActivated`, `isPopular` and `isNew` from those fields, and keeps the server's
  fields as well. `publisherName` and `publisherVerified` are now typed.
- **Since.** `4ee9e9b` (2026-08-16), **v0.2.0**.
- **Breaking?** No. Code that read the raw `activated` / `popular` / `new` still finds them. Note that the server
  currently always sends these as `false`, so the values are what the server says, not more.

### 10. Embed: `connectConnector` never bound the new connection; `openOAuthPopup` never received the result
- **What was wrong.** The OAuth popup posts `{ type: 'connectionStatus', payload: 'success', connectionId, connectionInstanceId }`
  (connection `MultiTenantSuccessHandler`). The SDK waited for `'svx:integration:oauth:callback'`, which only a
  Workstudio embed frame posts. So `openOAuthPopup` always resolved `undefined` when the popup closed.
  `connectConnector` then returned the activation still pending: nothing on the platform attaches the new
  connection; the opener must call `bindConnection`, which Designer's own embed modal does.
- **Fix.**
  - `openOAuthPopup` also accepts the popup's `connectionStatus` message, and only from the popup it opened.
  - `connectConnector` binds the reported `connectionInstanceId` (`bindConnection`) and returns that activation.
  - New export: `CONNECTION_STATUS_MESSAGE`.
- **Since.** `4ee9e9b` (2026-08-16), **v0.2.0**. The server's message shape dates from at least 2026-03-31.
- **Breaking?**
  - `openOAuthPopup` now resolves with the popup's message where it used to resolve `undefined`. Code that treated
    any non-undefined result as the old embed-frame payload should check `type`.
  - `connectConnector` makes one extra call (POST bind) and needs `activation:create`, which every
    Designer-generated key has.
- **Server-side limit, not fixable in the SDK.** The popup posts only to an allow-listed callback origin. The
  default allow-list is `https://work.studio`, `https://*.work.studio`, `http://localhost:*` and
  `http://127.0.0.1:*`, and `OAUTH_CALLBACK_ALLOWED_ORIGINS` is not set in infrastructure. A customer's page on its
  own domain therefore still never receives the message, and `connectConnector` returns the activation unchanged
  there. That needs a platform change, such as per-tenant embed origins on the callback allow-list.

### 11. Embed: `initiateOAuth({ redirectUri })` with a real redirect URL was a 400
- **What was wrong.** The server passes `redirectUri` on as the popup's **callback origin**
  (catalog `IntegrationEmbedService`, then connection `OAuthInitiationController`). That must be a bare,
  allow-listed origin: a URL with a path is `400 CALLBACK_ORIGIN_NOT_ALLOWED`. `state` is ignored. The
  per-customer-host `variables` (Zendesk subdomain, ServiceNow instance) could not be sent.
- **Fix.**
  - New `callbackOrigin` option.
  - `redirectUri` is deprecated and reduced to its origin before it is sent.
  - `state` is documented as ignored (still sent, harmless).
  - New `variables` option.
  - `completeOAuth` is documented as needing the `oauth:complete` scope, which no Designer-generated key has
    (400 "Missing required scope: oauth:complete"). Use `bindConnection` instead.
- **Since.** `4ee9e9b` (2026-08-16), **v0.2.0**. The 400 dates from connection `f4d27cba` (2026-10-20); before
  that, the value was taken unchecked.
- **Breaking?** No. A `redirectUri` that worked was already a bare origin and is sent unchanged. One that had a
  path was refused before and is now sent as its origin.

## Type-only corrections

These match what the server already sends. They are compile-time changes, with no runtime change. Each one
widens a type to include `null`, so TypeScript code under `strictNullChecks` that used the value directly may no
longer compile. That is the intended signal.

| Type | Change | Server source |
|---|---|---|
| `Allowance.resetsOn` | `string` becomes `string \| null`; `period?: 'month' \| 'once'` added | ai-runtime `EndUserConversationsController.Allowance` (ai-runtime `34e9ca68`, 2026-10-22; SDK `f27aa37`, **v0.3.0**) |
| `CreditEstimate.credits` | `number` becomes `number \| null` (design with no hint) | ai-runtime `EndUserCreditsController.estimate` (`2fe45315`, 2026-10-24; SDK `8461a3a`, **v0.10.0**) |
| `CreditPack.web/apple/google` | each may be `null`; `web.amount` and `web.currency` may be `null` | connection `AppCredits.PackOffer` / `WebPrice` (SDK `8461a3a`, **v0.10.0**) |
| `Me.displayName` | may be `null` | connection `EndUserAccountController.Me` (SDK `58c89d4`, **v0.3.0**) |
| `RequestShare.token` | may be `null` (withdrawn or expired share) | connection `AppRequests.ShareRef` (SDK `cf2da0f`, **v0.9.0**) |
| `ListingRequest.blocked/payload/attachments/messages` | `null` in a list (was "absent"); `projectId` added | connection `AppRequests.RequestView` |
| `Plan.price` | added | connection `AppBillingService.PlanView` |
| `ShareComment.id`, `ProjectEntry.name` | added | connection `AppShares.Comment`, `AppProjects.Entry` |
| Embed `RegionSkip.detail`, `Connection.*`, `McpAccess.*`, `McpUrl.*`, `Activation.instanceKey/name` | added | catalog `SurfaceWidgets.Skipped`, `EmbedConnectionsResponse`, `EmbedActivationResponse` |
| `Turn` | `type`, `timestamp`, `attachmentIds` added | base-ai-common `AgentTurn` |

## Not SDK bugs: server-side gaps found by the audit

These were left for the owning lanes. The SDK cannot fix them.

- **Push from an App's own web origin.** The `/api/v1/workflow/notification/end-users/me/push/*` paths are missing
  from base-http `CorsConfig` `cors.app-paths` (matched by prefix in `AppAwareCorsConfigurationSource`). So
  `app.push.*` called with `fetch` from an App's own registered origin that the general CORS list does not already
  allow (a custom domain, or a Capacitor WebView at `capacitor://localhost`) fails the CORS preflight. Native HTTP
  is not affected.
  Fix: add the path to `cors.app-paths`.
- **Embed OAuth callback allow-list.** See fix 10: a customer's own domain never receives the popup's result.
- **Embed scope errors are 400, not 403.** For example "Missing required scope", via the monolith's fallback
  exception handler. Callers should not branch on 403 for scope refusals.
- **`completeOAuth` cannot be authorised with a Designer-generated key.** The key has no `oauth:complete` scope.

## Tests

`test/contract.test.mjs` and `test/embedContract.test.mjs` are new. Each fixture is what a server DTO serialises
to, with the DTO cited in a comment. Before these fixes, 9 of the 21 App contract tests failed on 0.14.0. The
embed tests use an export that is new in this branch.
