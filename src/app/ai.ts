import { AppError, SignInRequired } from './errors';
import type { Http } from './http';

/** Why AI cannot be used right now. */
export type AiStatusReason = 'allowance' | 'app_budget' | 'pool' | 'credits';

/** Whether the person can use AI in the App right now. */
export interface AiStatus {
  /** True when a new AI request would be refused. */
  paused: boolean;
  /**
   * Why: `allowance` - their own monthly allowance is used ({@link AllowanceUsed} on a request);
   * `pool` - their plan's shared pool is spent; `app_budget` - the App's own AI budget is
   * (both {@link AiPaused}); `credits` - the person's credits cannot start anything now ({@link CreditsUsedUp}).
   * Null when not paused.
   */
  reason: AiStatusReason | null;
  /** The code a refused request carries: ALLOWANCE_USED, APP_FREE_POOL_PAUSED, APP_AI_PAUSED or CREDITS_USED_UP. */
  code?: string;
  /** Which limit: today's or this month's; `once` for starter credits that do not come back. */
  scope?: 'day' | 'month' | 'once';
  /** When AI is back, ISO 8601 in UTC. Show it in the person's own time. */
  resetAt?: string;
  /** The person's plan in the App, when known. */
  plan?: string;
  /** The platform's own words for it. */
  message?: string;
  /**
   * False when the platform could not be asked (signed out, offline, slow, or a platform without this
   * check): then `paused` is false - a check that fails never stops anyone.
   */
  known: boolean;
}

export interface AiStatusOptions {
  /** Reuse an answer up to this old, in milliseconds. Default 30 seconds; 0 asks again. */
  maxAgeMs?: number;
  /** Give up and say "available" after this long, in milliseconds. Default 2 seconds. */
  timeoutMs?: number;
}

const AVAILABLE_UNKNOWN: AiStatus = { paused: false, reason: null, known: false };

/**
 * AI in the App: whether it can be used right now. Ask before starting an AI request so the App can
 * say "paused until 7 pm" up front instead of failing part way; a request refused anyway still throws
 * {@link AiPaused} or {@link AllowanceUsed}.
 *
 * Fails open: when the platform cannot be asked - signed out, offline, slow, mid-deploy, or a platform
 * from before this check - the answer is `{ paused: false, known: false }`.
 */
export class Ai {
  private cached: { status: AiStatus; at: number } | null = null;
  private inFlight: Promise<AiStatus> | null = null;

  constructor(private readonly http: Http) {}

  /** Whether AI can be used right now, and if not why and until when. Never throws. */
  async status(options: AiStatusOptions = {}): Promise<AiStatus> {
    const maxAge = options.maxAgeMs ?? 30_000;
    const now = Date.now();
    // A request that was just refused says so straight away, until its reset time.
    const refused = this.http.lastPause;
    if (refused) {
      const back = refused.resetAt ? Date.parse(refused.resetAt) : NaN;
      if (!Number.isNaN(back) && back > now) {
        return { paused: true, reason: refused.reason, code: refused.code, scope: refused.scope, resetAt: refused.resetAt,
          plan: refused.plan, message: refused.message, known: true };
      }
      this.http.lastPause = null;
    }
    if (this.cached && now - this.cached.at <= maxAge && !expired(this.cached.status, now)) return this.cached.status;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.ask(options.timeoutMs ?? 2_000).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Forget the cached answer, e.g. after the person bought a plan. */
  forget(): void {
    this.cached = null;
    this.http.lastPause = null;
  }

  private async ask(timeoutMs: number): Promise<AiStatus> {
    if (!(await this.http.signedIn().catch(() => false))) return AVAILABLE_UNKNOWN;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    try {
      const body = await Promise.race([
        this.http.request<Record<string, unknown>>('GET', `${this.http.config.aiRuntimeUrl}/api/v1/workflow/ai-runtime/sessions/mine/ai-status`),
        timeout,
      ]);
      if (!body || typeof body !== 'object') {
        // Timed out: available, and not kept, so the next ask tries again.
        return AVAILABLE_UNKNOWN;
      }
      const status = read(body);
      this.cached = { status, at: Date.now() };
      return status;
    } catch (e) {
      // Signed out, refused, not found (an older platform), offline: available. Kept for about ten
      // seconds, so a platform without the check is not asked on every tap.
      if (e instanceof SignInRequired || e instanceof AppError) this.cached = { status: AVAILABLE_UNKNOWN, at: Date.now() - 20_000 };
      return AVAILABLE_UNKNOWN;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function expired(status: AiStatus, now: number): boolean {
  if (!status.paused || !status.resetAt) return false;
  const back = Date.parse(status.resetAt);
  return !Number.isNaN(back) && back <= now;
}

function read(body: Record<string, unknown>): AiStatus {
  const reason = body.reason === 'allowance' || body.reason === 'app_budget' || body.reason === 'pool' || body.reason === 'credits'
    ? body.reason : null;
  const paused = body.paused === true && reason !== null;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  return {
    paused,
    reason: paused ? reason : null,
    code: str(body.code),
    scope: body.scope === 'day' || body.scope === 'month' || body.scope === 'once' ? body.scope : undefined,
    resetAt: str(body.resetAt),
    plan: str(body.plan),
    message: str(body.message),
    known: true,
  };
}
