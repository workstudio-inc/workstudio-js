# Changelog

`@workstudio-inc/sdk`. Earlier versions were recorded only in their release commits and tags; this
file starts with 0.15.0. The full audit (routes, DTOs, history of each break) is in
`RELEASE-NOTES-sdk-contract-fixes.md`.

## 0.16.0 (unreleased)

### Added
- `Plan.monthlyBudgetSource` (`'PLAN' | 'APP' | 'PLATFORM_DEFAULT' | 'UNLIMITED' | 'NONE'`, exported as
  `MonthlyBudgetSource`) and `Plan.unlimited` (boolean): where the end user's monthly AI limit comes from, and
  whether there is none. Both are absent when talking to a server older than this release.

### Changed
- `ProjectListItem.settings` is typed `never`: the project list endpoint never returns settings; read a single
  project for them with `projects.get(id)`.
- `Plan.monthlyBudgetUsd` / `Allowance.monthlyBudgetUsd` now report the limit actually enforced for the end user:
  the plan's allowance, else the App's own per-person cap, else the platform default ($5 per end user per month).
  `null` now means only that no limit applies (`unlimited: true`); it no longer means "the App set none".

## 0.15.0 - 2026-10-30

A contract audit of every public method of the embed client, `@workstudio-inc/sdk/browser` and the
App SDK (`@workstudio-inc/sdk/app`) against the platform's code. Every route exists and accepts the
credential the SDK sends; these fixes are about reply shapes and request meaning.

### Fixed

- `chat.reconnect()` reads a finished turn's outcome. It resolved `null` because the outcome event
  has no `type` in its data; the SDK now takes the type from the SSE `event:` line.
- A stopped answer: `send()` resolves with the text written so far and `reply.cancelled === true`
  (new field), and `reconnect()` reads the outcome back as `cancelled`.
- `chat.history()` turns carry `role` (`user`, `assistant`, `tool`, `error`, `system`) and a
  non-null `content`; the server's `type` and `timestamp` are kept.
- `push.preferences.set()`: `null` clears `quietStart`, `quietEnd` and `timezone` (sent as `""`),
  and a category can be set to `null`. Before, `null` was a silent no-op. New type
  `PushPreferencesChange`.
- `images.make()`: a 402 `NO_ALLOWANCE` (pictures not set up in this App) is a plain `AppError`, not
  `AllowanceUsed`. `Picture` adds `pictureId`, `redo`, `freeRedosLeft`.
- `content.pack(...).page({ limit })` clamps the limit to 1..60 (the platform refused larger).
- `chat.send()` refused for the day (429 `DAILY_LIMIT`) keeps the platform's message, and `details`
  carries `resetAt`.
- Embed: `getIntegration().isActivated` and `listIntegrations()` `isPopular` / `isNew` are filled
  from the platform's `activated`, `popular`, `new` (always undefined before). The raw fields stay.
- Embed: `openOAuthPopup()` receives the popup's `connectionStatus` message (only from the popup it
  opened), and `connectConnector()` binds the reported connection with `bindConnection` and returns
  that activation. New export `CONNECTION_STATUS_MESSAGE`.
- Embed: `initiateOAuth()` takes `callbackOrigin` (a bare, allow-listed origin) and `variables`;
  `redirectUri` is deprecated and reduced to its origin, so a URL with a path no longer gets a 400.
- Types widened to what the platform sends: `Allowance.resetsOn` (nullable, plus `period`),
  `CreditEstimate.credits`, `CreditPack` prices, `Me.displayName`, `RequestShare.token`, request
  list fields, `Plan.price` and others (see the release notes).

### Changed (behaviour callers may notice)

- **Sign-in refusals:** `AppError.code` is the platform's code when it gives one, so a members-only
  App's outsider gets `NOT_A_MEMBER` (403) and an unreadable membership `MEMBERSHIP_UNAVAILABLE`
  (503), where 0.14.0 gave `invalid_target` / `temporarily_unavailable`. `AppError.details` holds the
  whole refusal, including `error` and `organization`. Code comparing `e.code === 'invalid_target'`
  after `completeSignIn()` must also accept `NOT_A_MEMBER` (or read `e.details?.error`).
- **`images.make()` `NO_ALLOWANCE`** is no longer an `AllowanceUsed`; catch `AppError` with
  `code === 'NO_ALLOWANCE'`.
- **A stop before any text streamed:** `send()` resolves with `text: ''` and `cancelled: true`,
  where it used to throw `AppError(502)`.
- **`openOAuthPopup()`** resolves with the popup's message where it used to resolve `undefined`;
  check its `type`. `connectConnector()` makes one more call (the bind), which needs
  `activation:create`.
- **TypeScript:** the widened types above can stop code compiling under `strictNullChecks`. No
  runtime change.

### Known platform limits (not SDK changes)

- `completeOAuth()` needs the `oauth:complete` scope on the embed key; after a popup, use
  `bindConnection`.
- The OAuth popup reports only to an allow-listed callback origin, so on a customer's own domain
  `connectConnector()` returns the activation unbound.
- `app.push.*` from an App's own web origin can fail the CORS preflight until the push paths are on
  the platform's App CORS list.
