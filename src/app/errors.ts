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

  constructor(init: { reason: AiPausedReason; scope?: 'day' | 'month'; resetAt?: string; plan?: string; message?: string }) {
    super(429, init.message || 'AI is paused in this app for now.', init.reason === 'pool' ? 'APP_FREE_POOL_PAUSED' : 'APP_AI_PAUSED');
    this.name = 'AiPaused';
    this.reason = init.reason;
    this.scope = init.scope;
    this.resetAt = init.resetAt;
    this.plan = init.plan;
    Object.setPrototypeOf(this, AiPaused.prototype);
  }

  /** The pause a refusal carries - an error event's or an HTTP answer's fields - or null when it is not one. */
  static from(fields: Record<string, unknown> | undefined | null, message?: string): AiPaused | null {
    if (!fields) return null;
    const code = String(fields.errorCode ?? fields.code ?? '');
    const text = typeof fields.message === 'string' ? fields.message : typeof fields.error === 'string' ? fields.error : message;
    if (code === 'APP_FREE_POOL_PAUSED' || code === 'APP_AI_PAUSED') {
      const scope = fields.scope === 'day' || fields.scope === 'month' ? fields.scope : undefined;
      return new AiPaused({
        reason: code === 'APP_FREE_POOL_PAUSED' ? 'pool' : 'app_budget',
        scope,
        resetAt: typeof fields.resetAt === 'string' ? fields.resetAt : undefined,
        plan: typeof fields.plan === 'string' ? fields.plan : undefined,
        message: text,
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
  static from(fields: Record<string, unknown> | undefined | null, message?: string): CreditsUsedUp | null {
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
