/** A request the platform refused or could not complete. `message` is fit to show the person. */
export class AppError extends Error {
  /** HTTP status, or 0 when the request never got an answer. */
  readonly status: number;
  /** A machine-readable reason, when the platform gave one. */
  readonly code?: string;
  /** The platform's answer as it came, when it was an object: any fields besides code and message. */
  readonly details?: Record<string, unknown>;

  constructor(status: number, message: string, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

/**
 * A conditional write lost (409, code `VERSION_MISMATCH`, 0.13.0): someone changed the project since the version
 * you passed as `expectedVersion` - another device claimed the running design first, say. Nothing you sent was
 * written. `currentVersion` is the version it is at now: read it again (`projects.get`) and decide.
 */
export class VersionMismatchError extends AppError {
  /** The project's version now, when the platform said it. */
  readonly currentVersion?: number;
  /** The version the write named. */
  readonly expectedVersion?: number;

  constructor(init: { currentVersion?: number; expectedVersion?: number; message?: string; details?: Record<string, unknown> } = {}) {
    super(409, init.message || 'Someone else changed this first. Please try again.', 'VERSION_MISMATCH', init.details);
    this.name = 'VersionMismatchError';
    this.currentVersion = init.currentVersion;
    this.expectedVersion = init.expectedVersion;
    Object.setPrototypeOf(this, VersionMismatchError.prototype);
  }
}

/** Nobody is signed in, or their sign-in has lapsed: call `auth.signIn()`. */
export class SignInRequired extends AppError {
  constructor(message = 'Please sign in.') {
    super(401, message, 'SIGN_IN_REQUIRED');
    this.name = 'SignInRequired';
    Object.setPrototypeOf(this, SignInRequired.prototype);
  }
}

/** The person has used this month's AI allowance the App gives them; it resets on the 1st (UTC). */
export class AllowanceUsed extends AppError {
  constructor(message = 'This month’s AI allowance is used up.') {
    super(429, message, 'ALLOWANCE_USED');
    this.name = 'AllowanceUsed';
    Object.setPrototypeOf(this, AllowanceUsed.prototype);
  }
}

/** Why AI is paused in the App: its plan's shared pool is spent, or the App's own budget is. */
export type AiPausedReason = 'pool' | 'app_budget';

/**
 * AI is paused in the App for now - not the person's own allowance ({@link AllowanceUsed}), but the
 * App's: the shared pool of their plan is spent (`reason: 'pool'`, code `APP_FREE_POOL_PAUSED`), or
 * the App's own AI budget is (`'app_budget'`, code `APP_AI_PAUSED`). Nothing they do brings it back
 * sooner; `resetAt` says when it is back (ISO, UTC - show it in their own time). Everything in the App
 * that does not use AI goes on working.
 */
export class AiPaused extends AppError {
  readonly reason: AiPausedReason;
  /** Which limit: today's or this month's. */
  readonly scope?: 'day' | 'month';
  /** When AI is back, ISO 8601 in UTC, e.g. `2026-10-21T00:00:00Z`. */
  readonly resetAt?: string;
  /** The person's plan, when the platform said it. */
  readonly plan?: string;
  /**
   * True for "Temporarily unavailable. Try again in a minute." (code `APP_AI_PAUSED`, no `scope`, `resetAt` a minute
   * away): what the person may spend could not be counted just now, or they already have the most requests running at
   * once, or another conversation's turn of the same design run is running. Not a limit - send it again after
   * `retryAfterSeconds`; never show a paywall for it. False for a real pause, which lasts until `resetAt`.
   */
  readonly retryable: boolean;
  /** How long to wait before sending it again, in seconds, when the platform said it. */
  readonly retryAfterSeconds?: number;

  constructor(init: { reason: AiPausedReason; scope?: 'day' | 'month'; resetAt?: string; plan?: string; message?: string;
    retryable?: boolean; retryAfterSeconds?: number }) {
    super(429, init.message || 'AI is paused in this app for now.', init.reason === 'pool' ? 'APP_FREE_POOL_PAUSED' : 'APP_AI_PAUSED');
    this.name = 'AiPaused';
    this.reason = init.reason;
    this.scope = init.scope;
    this.resetAt = init.resetAt;
    this.plan = init.plan;
    this.retryable = init.retryable === true;
    this.retryAfterSeconds = init.retryAfterSeconds;
    Object.setPrototypeOf(this, AiPaused.prototype);
  }

  /** The pause a refusal carries - an error event's or an HTTP answer's fields - or null when it is not one. */
  static from(raw: Record<string, unknown> | undefined | null, message?: string): AiPaused | null {
    const fields = refusalFields(raw, message);
    if (!fields) return null;
    const code = String(fields.errorCode ?? fields.code ?? '');
    const text = typeof fields.message === 'string' ? fields.message : typeof fields.error === 'string' ? fields.error : message;
    if (code === 'APP_FREE_POOL_PAUSED' || code === 'APP_AI_PAUSED') {
      const scope = fields.scope === 'day' || fields.scope === 'month' ? fields.scope : undefined;
      // Said by the platform (an error event, an HTTP refusal); else, from a tag only, the "temporarily unavailable" one.
      const retryable = typeof fields.retryable === 'boolean' ? fields.retryable
        : code === 'APP_AI_PAUSED' && !scope && typeof text === 'string' && /^Temporarily unavailable/i.test(text);
      const wait = typeof fields.retryAfterSeconds === 'number' && Number.isFinite(fields.retryAfterSeconds) && fields.retryAfterSeconds >= 0
        ? fields.retryAfterSeconds : undefined;
      return new AiPaused({
        reason: code === 'APP_FREE_POOL_PAUSED' ? 'pool' : 'app_budget',
        scope,
        resetAt: typeof fields.resetAt === 'string' ? fields.resetAt : undefined,
        plan: typeof fields.plan === 'string' ? fields.plan : undefined,
        message: text,
        retryable,
        retryAfterSeconds: wait,
      });
    }
    // A platform from before the structured pause said the App's budget was used up in words only.
    if (text && /^This app's AI budget (for this month|for today) is used up/.test(text)) {
      const day = /for today/.test(text);
      return new AiPaused({ reason: 'app_budget', scope: day ? 'day' : 'month', resetAt: nextReset(day ? 'day' : 'month'), message: text });
    }
    return null;
  }
}

/** The next UTC midnight, or the 1st of next month (UTC). */
export function nextReset(scope: 'day' | 'month', now = new Date()): string {
  const d = scope === 'day'
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return d.toISOString().replace('.000Z', 'Z');
}

/**
 * The person's credits cannot start this right now (code `CREDITS_USED_UP`): a chat turn, a picture, or
 * `ai.status()` with `reason: 'credits'`. Their monthly credits come back on `resetAt` (ISO, UTC); `scope: 'once'`
 * means starter credits that do not come back. Show it as "out of credits" - never as an error - with "Get more
 * credits" ({@link Credits.packs}) or "Choose Plus". `credits` is the balance when the refusal carried it.
 */
export class CreditsUsedUp extends AppError {
  readonly reason = 'credits' as const;
  readonly scope?: 'month' | 'once';
  readonly resetAt?: string;
  readonly plan?: string;
  readonly credits?: Record<string, unknown>;

  constructor(init: { scope?: 'month' | 'once'; resetAt?: string; plan?: string; message?: string; credits?: Record<string, unknown> } = {}) {
    super(402, init.message || 'You’ve used your credits for now.', 'CREDITS_USED_UP');
    this.name = 'CreditsUsedUp';
    this.scope = init.scope;
    this.resetAt = init.resetAt;
    this.plan = init.plan;
    this.credits = init.credits;
    Object.setPrototypeOf(this, CreditsUsedUp.prototype);
  }

  /** The refusal a stream error event or an HTTP answer carries, or null when it is not one. */
  static from(raw: Record<string, unknown> | undefined | null, message?: string): CreditsUsedUp | null {
    const fields = refusalFields(raw, message);
    if (!fields) return null;
    const code = String(fields.errorCode ?? fields.code ?? '');
    if (code !== 'CREDITS_USED_UP') return null;
    const text = typeof fields.message === 'string' ? fields.message : typeof fields.error === 'string' ? fields.error : message;
    return new CreditsUsedUp({
      scope: fields.scope === 'month' || fields.scope === 'once' ? fields.scope : undefined,
      resetAt: typeof fields.resetAt === 'string' ? fields.resetAt : undefined,
      plan: typeof fields.plan === 'string' ? fields.plan : undefined,
      message: text,
      credits: fields.credits && typeof fields.credits === 'object' ? (fields.credits as Record<string, unknown>) : undefined,
    });
  }
}

/** Credit packs come with some plans only (`NOT_FOR_YOUR_PLAN`): show `message`, and the plans that have them. */
export class NotForYourPlan extends AppError {
  constructor(message = 'Credit packs come with a paid plan.', details?: Record<string, unknown>) {
    super(403, message, 'NOT_FOR_YOUR_PLAN', details);
    this.name = 'NotForYourPlan';
    Object.setPrototypeOf(this, NotForYourPlan.prototype);
  }
}

/** The design-run refusals (`DESIGN_*`): a design run's id that may not be used as asked. */
export type DesignRunCode =
  | 'DESIGN_HOLDS_BUSY'
  | 'DESIGN_RUN_NOT_YOURS'
  | 'DESIGN_RUN_CLOSED'
  | 'DESIGN_RUN_FIX_LIMIT'
  | 'DESIGN_RUN_EXPIRED'
  | 'DESIGN_RUN_INVALID';

/** Every {@link DesignRunCode}. */
export const DESIGN_RUN_CODES: readonly DesignRunCode[] = Object.freeze([
  'DESIGN_HOLDS_BUSY',
  'DESIGN_RUN_NOT_YOURS',
  'DESIGN_RUN_CLOSED',
  'DESIGN_RUN_FIX_LIMIT',
  'DESIGN_RUN_EXPIRED',
  'DESIGN_RUN_INVALID',
] as const);

const DESIGN_RUN_WORDS: Record<DesignRunCode, string> = {
  DESIGN_HOLDS_BUSY: 'You already have designs in progress. Finish one, then start this one.',
  DESIGN_RUN_NOT_YOURS: 'This design can’t be continued. Start a new design.',
  DESIGN_RUN_CLOSED: 'This design is finished. Start a new design to keep going.',
  DESIGN_RUN_FIX_LIMIT: 'This design has had all its fixes.',
  DESIGN_RUN_EXPIRED: 'This design was left too long and has ended. Start a new design.',
  DESIGN_RUN_INVALID: 'This design can’t be started.',
};

/** True for a {@link DesignRunCode}. */
export function isDesignRunCode(code: unknown): code is DesignRunCode {
  return typeof code === 'string' && (DESIGN_RUN_CODES as readonly string[]).includes(code);
}

/**
 * A chat turn (or `credits.designRuns`) named a design run that may not be used as asked - never a limit on the
 * person's credits (that is {@link CreditsUsedUp}), nor a pause ({@link AiPaused}). Not retryable as it is. By `code`:
 *
 * - `DESIGN_HOLDS_BUSY`: the person already has the most design runs open at once (2 by default). "Finish or close a
 *   design first"; close runs the App abandoned (`credits.designRuns.close`).
 * - `DESIGN_RUN_NOT_YOURS`: the id belongs to another person, App or tenant. Start a new run with a fresh id.
 * - `DESIGN_RUN_CLOSED`: the run was closed, by the App or because it finished. Ids are never reopened: start a new run.
 * - `DESIGN_RUN_FIX_LIMIT`: the run has had round 0 and all its fix turns. Keep the last checked design.
 * - `DESIGN_RUN_EXPIRED`: the run passed its time limit (45 min by default) and its hold was released. Keep the last
 *   checked design, or start a new run.
 * - `DESIGN_RUN_INVALID`: the id is not 8-64 of `[A-Za-z0-9_-]` - a bug in the App; send a UUID. The SDK refuses such an
 *   id itself, before sending anything.
 */
export class DesignRunRefused extends AppError {
  declare readonly code: DesignRunCode;
  readonly reason = 'design_run' as const;
  readonly retryable = false as const;

  constructor(code: DesignRunCode, init: { status?: number; message?: string; details?: Record<string, unknown> } = {}) {
    super(init.status ?? designRunStatus(code), init.message || DESIGN_RUN_WORDS[code], code, init.details);
    this.name = 'DesignRunRefused';
    Object.setPrototypeOf(this, DesignRunRefused.prototype);
  }

  /** The design-run refusal a stream error event or an HTTP answer carries, or null when it is not one. */
  static from(raw: Record<string, unknown> | undefined | null, message?: string, status?: number): DesignRunRefused | null {
    const fields = refusalFields(raw, message);
    if (!fields) return null;
    const code = fields.errorCode ?? fields.code;
    if (!isDesignRunCode(code)) return null;
    const text = typeof fields.message === 'string' ? fields.message : typeof fields.error === 'string' ? fields.error : message;
    return new DesignRunRefused(code, { status: status && status >= 400 ? status : undefined, message: text, details: raw ?? undefined });
  }
}

/** The HTTP status a design-run refusal has on the endpoints; on a stream (no status), the same by code. */
function designRunStatus(code: DesignRunCode): number {
  return code === 'DESIGN_RUN_INVALID' ? 400 : code === 'DESIGN_RUN_NOT_YOURS' ? 403 : 409;
}

const TAG = /\s*\[ws:(APP_FREE_POOL_PAUSED|APP_AI_PAUSED|CREDITS_USED_UP|DAILY_LIMIT|DESIGN_[A-Z_]+)((?:;[a-zA-Z]+=[^;\]]*)*)\]/;

/**
 * A refusal's fields, with what a `[ws:CODE;scope=..;resetAt=..;plan=..]` tag in its words says. The platform puts the
 * tag on a refusal raised inside the agent loop, and a path that only passes the words on (a generic error event, a
 * wrapper's "LLM call failed: ...") still carries it. The tag is the more exact: its code wins over the event's own, and
 * the words come back without the tag and without a wrapper's text before them.
 */
export function refusalFields(raw: Record<string, unknown> | undefined | null, message?: string): Record<string, unknown> | null {
  if (!raw) return null;
  const fields: Record<string, unknown> = { ...raw };
  for (const key of ['message', 'error'] as const) {
    const text = typeof fields[key] === 'string' ? (fields[key] as string) : key === 'message' ? message : undefined;
    const tag = text ? tagIn(text) : null;
    if (!tag) continue;
    fields.code = tag.code;
    delete fields.errorCode;
    for (const k of ['scope', 'resetAt', 'plan'] as const) if (tag[k] !== undefined) fields[k] = tag[k];
    fields.message = tag.message;
    if (typeof fields.error === 'string') fields.error = tag.message;
    break;
  }
  return fields;
}

/** What a `[ws:...]` tag in a text says, or null when it has none. */
export function tagIn(text: string): { code: string; scope?: string; resetAt?: string; plan?: string; message: string } | null {
  const m = TAG.exec(text);
  if (!m) return null;
  const out: { code: string; scope?: string; resetAt?: string; plan?: string; message: string } = { code: m[1]!, message: '' };
  for (const pair of (m[2] ?? '').split(';')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const k = pair.slice(0, eq).toLowerCase();
    const v = pair.slice(eq + 1).trim();
    if (!v) continue;
    if (k === 'scope') out.scope = v;
    else if (k === 'resetat') out.resetAt = v;
    else if (k === 'plan') out.plan = v;
  }
  const before = text.slice(0, m.index);
  const cut = before.lastIndexOf(': ');
  out.message = (cut >= 0 ? before.slice(cut + 2) : before).trim();
  if (!out.message) {
    out.message = isDesignRunCode(out.code) ? DESIGN_RUN_WORDS[out.code]
      : out.code === 'CREDITS_USED_UP' ? 'You’ve used your credits for now.' : 'AI is paused in this app for now.';
  }
  return out;
}

/**
 * The typed refusal a stream error event or an HTTP answer carries - {@link CreditsUsedUp}, {@link DesignRunRefused} or
 * {@link AiPaused} - or null when it is none of them. `message` is the words to use when the fields have none.
 */
export function refusalOf(raw: Record<string, unknown> | undefined | null, message?: string, status?: number):
  CreditsUsedUp | DesignRunRefused | AiPaused | null {
  return CreditsUsedUp.from(raw, message) ?? DesignRunRefused.from(raw, message, status) ?? AiPaused.from(raw, message);
}
