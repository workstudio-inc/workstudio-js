import { AiPaused, AppError, DesignRunRefused } from './errors';
import type { Http } from './http';

/** The most fix turns a design run holds for (`SendOptions.designRun.fixTurns`). */
export const DESIGN_RUN_MAX_FIX_TURNS = 10;

const DESIGN_RUN_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** True when `id` can name a design run: 8-64 of `[A-Za-z0-9_-]` (a UUID is one). */
export function isDesignRunId(id: unknown): id is string {
  return typeof id === 'string' && DESIGN_RUN_ID.test(id);
}

/** A design run id, checked before anything is sent (trimmed, as the platform does). @throws DesignRunRefused `DESIGN_RUN_INVALID` */
export function checkDesignRunId(id: unknown): string {
  const trimmed = typeof id === 'string' ? id.trim() : id;
  if (!isDesignRunId(trimmed)) {
    throw new DesignRunRefused('DESIGN_RUN_INVALID', { message: 'A design run id is 8 to 64 letters, digits, - or _ (a UUID is one).' });
  }
  return trimmed;
}

/** One of the person's design runs, as the platform keeps it. */
export interface DesignRun {
  runId: string;
  /** `open` while it holds credits; `closed` (by the App, or its last turn ended) or `expired` (its time limit passed). */
  state: 'open' | 'closed' | 'expired';
  /** Whole credits its hold still holds for the turns to come; 0 once it is closed or expired. */
  heldCredits: number;
  /** Turns it has had, round 0 included. */
  turns: number;
  /** Turns it may have: round 0 plus its fix turns. */
  maxTurns: number;
  turnsLeft: number;
  /** When it expires (and what it holds is released), ISO 8601 in UTC. */
  expiresAt: string;
}

/** What `close()` did: `closed` (now, or it already was, finished or expired), or `not_found` (no such run). */
export type DesignRunCloseResult = 'closed' | 'not_found';

/**
 * The person's design runs, in an App with credits: a design's round 0 and its fix rounds, held for together - see
 * `SendOptions.designRun`. A run is opened by the first chat turn naming its id; here it is read and closed.
 *
 * Refusals: {@link DesignRunRefused} (`DESIGN_RUN_INVALID` - checked before anything is sent - or
 * `DESIGN_RUN_NOT_YOURS`), {@link AiPaused} with `retryable` true when the platform cannot be reached just now (a run
 * that is not closed then is still released by its time limit), and `AppError` `NO_CREDITS` in an App without credits.
 */
export class DesignRuns {
  constructor(private readonly http: Http) {}

  private url(id: string) {
    return `${this.http.config.aiRuntimeUrl}/api/v1/workflow/ai-runtime/sessions/mine/credits/design-runs/${encodeURIComponent(id)}`;
  }

  /** One of the person's design runs; null when there is no such run (or the platform is from before design runs). */
  async get(id: string): Promise<DesignRun | null> {
    const runId = checkDesignRunId(id);
    try {
      const raw = await this.http.request<Record<string, unknown>>('GET', this.url(runId));
      return raw ? read(raw, runId) : null;
    } catch (e) {
      if (notFound(e)) return null;
      throw refused(e);
    }
  }

  /**
   * Close a design run - when the design is done or abandoned in the App - releasing what is left of its hold now. Its
   * id is never used again. Closing one already closed, finished or expired is fine. A turn of the run still running
   * ends as any turn does: charged what it costs.
   */
  async close(id: string): Promise<DesignRunCloseResult> {
    const runId = checkDesignRunId(id);
    try {
      await this.http.request<unknown>('DELETE', this.url(runId));
      return 'closed';
    } catch (e) {
      if (notFound(e)) return 'not_found';
      throw refused(e);
    }
  }
}

/** A 404 that means "no such run": the platform's `DESIGN_RUN_NOT_FOUND`, or a platform without the endpoint. */
function notFound(e: unknown): boolean {
  return e instanceof AppError && e.status === 404 && e.code !== 'NO_CREDITS';
}

/** A refusal as its typed error, when it is one. */
function refused(e: unknown): unknown {
  if (!(e instanceof AppError)) return e;
  const fields = e.details ?? (e.code ? { code: e.code } : undefined);
  return DesignRunRefused.from(fields, e.message, e.status) ?? AiPaused.from(fields, e.message) ?? e;
}

const whole = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);

function read(raw: Record<string, unknown>, runId: string): DesignRun {
  const state = raw.state === 'open' || raw.state === 'closed' || raw.state === 'expired' ? raw.state : 'closed';
  return {
    runId: typeof raw.runId === 'string' ? raw.runId : runId,
    state,
    heldCredits: whole(raw.heldCredits),
    turns: whole(raw.turns),
    maxTurns: whole(raw.maxTurns),
    turnsLeft: whole(raw.turnsLeft),
    expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : '',
  };
}
