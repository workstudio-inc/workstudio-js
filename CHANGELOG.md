# Changelog

All notable changes to `@workstudio-inc/sdk` are recorded here.

## 0.15.0

### Added
- `Plan.monthlyBudgetSource` (`'PLAN' | 'APP' | 'PLATFORM_DEFAULT' | 'UNLIMITED' | 'NONE'`, exported as
  `MonthlyBudgetSource`) and `Plan.unlimited` (boolean): where the end user's monthly AI limit comes from, and
  whether there is none. Both are absent when talking to a server older than this release.

### Changed
- `ProjectListItem.settings` is typed `never`: the project list endpoint never returns settings; read a single project for them.
- `Plan.monthlyBudgetUsd` / `Allowance.monthlyBudgetUsd` now report the limit actually enforced for the end user:
  the plan's allowance, else the App's own per-person cap, else the platform default ($5 per end user per month).
  `null` now means only that no limit applies (`unlimited: true`); it no longer means "the App set none".
