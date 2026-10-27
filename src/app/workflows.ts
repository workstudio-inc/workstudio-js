import { AiPaused, AppError } from './errors';
import type { Http } from './http';

/**
 * Workflows the App lets its people start - "Build this month's report" - and the runs they started.
 *
 * Deny by default: only a workflow the App declares (its manifest's `workflows:`, or the designer) can be run,
 * by the key it is declared under, and only within its plans, features and daily limit. Each person sees and
 * follows only their own runs. The platform's live run stream is for members, so an App follows a run by
 * polling: {@link Workflows.wait}.
 */

/**
 * Where a run is. Terminal: `FINISHED`, `FAILED`, `CANCELLED`, `TERMINATED`. `WAITING_HUMAN`: the run is parked
 * (every pause reads so); `waiting.type` says on what.
 */
export type WorkflowRunStatus =
  | 'QUEUED' | 'PARSING' | 'PENDING' | 'RUNNING' | 'WAITING_HUMAN'
  | 'FINISHED' | 'FAILED' | 'CANCELLED' | 'TERMINATED';

/** What a parked run waits on: `HUMAN` (a person must answer), `AGENT`, `ETL`, `CALLBACK`, `TASK`, `OTHER`. */
export type WorkflowWaitingType = 'HUMAN' | 'AGENT' | 'ETL' | 'CALLBACK' | 'TASK' | 'OTHER';

/** One run of one of the App's workflows, started by the person. */
export interface WorkflowRun {
  id: string;
  /** The key the App declares the workflow under. */
  workflow: string;
  status: WorkflowRunStatus;
  /** The status is terminal. */
  done: boolean;
  /** ISO-8601. */
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** While `WAITING_HUMAN`: on what, and the platform's label for it. */
  waiting?: { type: WorkflowWaitingType; label?: string };
  /** FINISHED only, on {@link Workflows.get} (and on {@link Workflows.run} when it had already finished). Never in a list. */
  output?: unknown;
  /** FINISHED, but the output is over 256 KB and is not returned. */
  outputTooLarge?: boolean;
  /** FAILED / TERMINATED / CANCELLED: what went wrong, one line. */
  error?: string;
}

/** Why the person may not start a workflow now. */
export type WorkflowNotAllowedReason = 'NEEDS_PLAN' | 'DAILY_LIMIT' | 'DISABLED';

/** A workflow the App declares, as this person sees it now. */
export interface AvailableWorkflow {
  key: string;
  description?: string;
  /** The JSON Schema of the run's input, when the App declares one. */
  input?: Record<string, unknown>;
  /** The person may start it now. */
  allowed: boolean;
  /** When not allowed. */
  reason?: WorkflowNotAllowedReason;
  /** Runs per person per UTC day; `resetsAt` is the next UTC midnight (ISO). */
  limit: { perDay: number; usedToday: number; resetsAt: string };
}

export interface WorkflowRunOptions {
  /**
   * The App's name for this start (1-100 of `A-Z a-z 0-9 _ . : -`): sent again, it answers the run the first
   * request made and starts nothing - a retried tap never runs twice.
   */
  idempotencyKey?: string;
}

export interface WorkflowRunListOptions {
  /** Only runs of this workflow key. */
  workflow?: string;
  /** 1..100, default 20. */
  limit?: number;
  /** The `nextCursor` of the page before. */
  cursor?: string;
}

export interface WorkflowRunPage {
  /** Newest first; without `output` (get one run for it). */
  runs: WorkflowRun[];
  /** Absent on the last page. */
  nextCursor?: string;
}

export interface WaitOptions {
  /** Give up after this long: rejects with {@link WaitTimeout} (`code` `WAIT_TIMEOUT`). Default 120000. */
  timeoutMs?: number;
  /** The first wait between polls, in ms; each next is 1.5 times longer. Default 1000. */
  intervalMs?: number;
  /** The longest wait between polls, in ms. Default 5000. */
  maxIntervalMs?: number;
  /** Also stop when the run is parked (`WAITING_HUMAN`). Default true. */
  untilWaiting?: boolean;
  /** Stop waiting: rejects with the signal's reason (an `AbortError`). The run itself goes on. */
  signal?: AbortSignal;
  /** Called with the run each time its status changes (the first status seen counts as a change). */
  onUpdate?: (run: WorkflowRun) => void;
}

/**
 * Why a start or a read was refused - each an {@link AppError} with this `code`, the HTTP status, a `message` fit
 * to show, and on a 429 `retryAfter` (seconds):
 * `NOT_AN_END_USER` (403), `WORKFLOW_NOT_FOUND` (404: the App declares no runnable workflow by that key),
 * `RUN_NOT_FOUND` (404), `NEEDS_PLAN` (403), `INPUT_TOO_LARGE` (400: over 64 KB), `INPUT_INVALID` (400: does not
 * match the declared schema), `BAD_IDEMPOTENCY_KEY` (400), `IDEMPOTENCY_CONFLICT` (409: the key was used for another
 * workflow), `DAILY_LIMIT` (429, until UTC midnight), `TOO_MANY_RUNNING` (429: 5 of the person's runs are not
 * finished), `APP_DAILY_LIMIT` (429), `APP_AI_PAUSED` / `APP_FREE_POOL_PAUSED` (429, as {@link AiPaused}),
 * `UNAVAILABLE` (503: try again).
 */
export type WorkflowRefusal =
  | 'NOT_AN_END_USER' | 'WORKFLOW_NOT_FOUND' | 'RUN_NOT_FOUND' | 'NEEDS_PLAN' | 'INPUT_TOO_LARGE' | 'INPUT_INVALID'
  | 'BAD_IDEMPOTENCY_KEY' | 'IDEMPOTENCY_CONFLICT' | 'DAILY_LIMIT' | 'TOO_MANY_RUNNING' | 'APP_DAILY_LIMIT'
  | 'APP_AI_PAUSED' | 'APP_FREE_POOL_PAUSED' | 'UNAVAILABLE';

/** {@link Workflows.wait} gave up before the run got there. `run` is the last state it read. The run itself goes on. */
export class WaitTimeout extends AppError {
  readonly run?: WorkflowRun;

  constructor(run: WorkflowRun | undefined, message = 'This is taking longer than expected. It carries on - check back in a moment.') {
    super(0, message, 'WAIT_TIMEOUT');
    this.name = 'WaitTimeout';
    this.run = run;
    Object.setPrototypeOf(this, WaitTimeout.prototype);
  }
}

const TERMINAL: ReadonlySet<string> = new Set(['FINISHED', 'FAILED', 'CANCELLED', 'TERMINATED']);

/** Whether a run has stopped for good: FINISHED, FAILED, CANCELLED or TERMINATED. */
export function isRunDone(run: Pick<WorkflowRun, 'status' | 'done'>): boolean {
  return run.done === true || TERMINAL.has(run.status);
}

export class Workflows {
  constructor(private readonly http: Http) {}

  /** The workflows the App declares, and whether this person may start each now (and if not, why). */
  async available(): Promise<AvailableWorkflow[]> {
    const r = await this.call<{ workflows?: AvailableWorkflow[] }>('GET', this.url('/workflows'));
    return r?.workflows ?? [];
  }

  /**
   * Start a run of the workflow the App declares under `key`, with `input` (checked against the declared schema).
   * Answers at once with the run, mostly `QUEUED` - follow it with {@link wait} or {@link get}. Refusals: see
   * {@link WorkflowRefusal}.
   */
  async run(key: string, input?: object, options: WorkflowRunOptions = {}): Promise<WorkflowRun> {
    const k = String(key ?? '').trim();
    if (!k) throw new AppError(404, 'Name the workflow to run.', 'WORKFLOW_NOT_FOUND');
    return this.call<WorkflowRun>('POST', this.url(`/workflows/${encodeURIComponent(k)}/runs`), {
      ...(input !== undefined ? { input } : {}),
      ...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
    });
  }

  /** One of the person's runs, with its `output` once FINISHED. Another person's, or none: 404 `RUN_NOT_FOUND`. */
  async get(runId: string): Promise<WorkflowRun> {
    const id = String(runId ?? '').trim();
    if (!id) throw new AppError(404, 'That run could not be found.', 'RUN_NOT_FOUND');
    return this.call<WorkflowRun>('GET', this.url(`/workflow-runs/${encodeURIComponent(id)}`));
  }

  /** The person's runs in this App, newest first, a page at a time (without `output`). */
  async list(options: WorkflowRunListOptions = {}): Promise<WorkflowRunPage> {
    const q = new URLSearchParams();
    if (options.workflow) q.set('workflow', options.workflow);
    if (options.limit !== undefined) q.set('limit', String(options.limit));
    if (options.cursor) q.set('cursor', options.cursor);
    const qs = q.toString();
    const r = await this.call<WorkflowRunPage>('GET', this.url(`/workflow-runs${qs ? `?${qs}` : ''}`));
    return { runs: r?.runs ?? [], ...(r?.nextCursor ? { nextCursor: r.nextCursor } : {}) };
  }

  /**
   * Follow a run until it is done - or, by default, parked waiting on someone (`WAITING_HUMAN`) - by polling
   * {@link get}: first after `intervalMs` (at once when given only an id), then 1.5 times longer each time, up to
   * `maxIntervalMs`. Answers the run as last read (with `output` when FINISHED). A FAILED run resolves too - read
   * `status` and `error`. A poll that cannot reach the platform, or meets a 5xx, is tried again until the timeout;
   * any other refusal rejects. Out of time: {@link WaitTimeout}, which carries the last run. The run itself is never
   * stopped by giving up or aborting.
   */
  async wait(runOrId: string | WorkflowRun, options: WaitOptions = {}): Promise<WorkflowRun> {
    const id = typeof runOrId === 'string' ? runOrId.trim() : runOrId?.id;
    if (!id) throw new AppError(404, 'That run could not be found.', 'RUN_NOT_FOUND');
    const timeoutMs = options.timeoutMs ?? 120_000;
    const maxInterval = Math.max(1, options.maxIntervalMs ?? 5_000);
    let interval = Math.min(Math.max(0, options.intervalMs ?? 1_000), maxInterval);
    const untilWaiting = options.untilWaiting ?? true;
    const { signal, onUpdate } = options;
    const deadline = Date.now() + timeoutMs;

    const stops = (run: WorkflowRun) => isRunDone(run) || (untilWaiting && run.status === 'WAITING_HUMAN');
    let last: WorkflowRun | undefined = typeof runOrId === 'object' ? runOrId : undefined;
    let seen: WorkflowRunStatus | undefined = last?.status;
    // A run handed over already settled needs no poll - unless it FINISHED without its output (a list item).
    if (last && stops(last) && !(last.status === 'FINISHED' && !('output' in last) && !last.outputTooLarge)) return last;

    throwIfAborted(signal);
    // Only an id (or a finished run missing its output): read it at once. A fresh run: give it a moment first.
    let first = !last || stops(last);
    for (;;) {
      if (!first) {
        const left = deadline - Date.now();
        if (left <= 0) throw new WaitTimeout(last);
        await sleep(Math.min(interval, left), signal);
        interval = Math.min(interval * 1.5, maxInterval);
      }
      first = false;
      let run: WorkflowRun | undefined;
      try {
        run = await abortable(this.get(id), signal);
      } catch (e) {
        if (!(e instanceof AppError) || !(e.status === 0 || e.status >= 500)) throw e;
        // Not reachable just now: try again on the next round.
      }
      if (run) {
        last = run;
        if (run.status !== seen) {
          seen = run.status;
          try {
            onUpdate?.(run);
          } catch {
            // A listener's own failure is its own.
          }
        }
        if (stops(run)) return run;
      }
      if (Date.now() >= deadline) throw new WaitTimeout(last);
    }
  }

  private async call<T>(method: string, url: string, body?: unknown): Promise<T> {
    try {
      return await this.http.request<T>(method, url, body);
    } catch (e) {
      if (e instanceof AppError && (e.code === 'APP_AI_PAUSED' || e.code === 'APP_FREE_POOL_PAUSED')) {
        const fields: Record<string, unknown> = { ...(e.details ?? {}), code: e.code };
        if (fields.resetAt === undefined && e.retryAfter !== undefined) {
          fields.resetAt = new Date(Date.now() + e.retryAfter * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
        }
        const paused = AiPaused.from(fields, e.message);
        if (paused) throw this.http.paused(paused);
      }
      throw e;
    }
  }

  private url(rest: string): string {
    return this.http.api(`/connection/end-users/me${rest}`);
  }
}

function abortError(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const e = new Error('The wait was aborted.');
  e.name = 'AbortError';
  return e;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      v => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      e => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}
