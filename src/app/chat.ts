import type { Http } from './http';
import { AiPaused, AllowanceUsed, AppError, CreditsUsedUp, DesignRunRefused, refusalOf, SignInRequired } from './errors';
import { read as readCredits, type CreditBalance } from './credits';
import { checkDesignRunId, DESIGN_RUN_MAX_FIX_TURNS } from './designRuns';

/** One of the person's conversations, as listed. */
export interface ConversationSummary {
  id: string;
  title?: string;
  agentId?: string;
  /** What the conversation belongs to, e.g. `project:<id>`. */
  contextRef?: string;
  status?: string;
  turnCount?: number;
  createdAt?: string;
  lastMessageAt?: string;
}

/**
 * One turn of a conversation's history, as the platform keeps it (`AgentTurn`): `type` is the platform's own kind -
 * `USER_MESSAGE`, `ASSISTANT_MESSAGE`, `TOOL_CALL`, `TOOL_RESULT`, `ERROR`, `SYSTEM`, `SYSTEM_SUMMARY`.
 *
 * `role` is derived from it by the SDK (the platform sends none): `user` and `assistant` are the messages to show;
 * `tool`, `error` and `system` are the agent's own working, which a chat screen usually leaves out. `content` is
 * `''` for a turn that has no text (a tool call).
 */
export interface Turn {
  role: 'user' | 'assistant' | 'tool' | 'error' | 'system' | (string & {});
  content: string;
  /** The platform's kind of turn; see above. */
  type?: string;
  /** Epoch milliseconds. */
  timestamp?: number;
  attachmentIds?: string[] | null;
  [key: string]: unknown;
}

/** The SDK's `role` for one of the platform's turn kinds. */
function roleOf(type: unknown): string {
  switch (type) {
    case 'USER_MESSAGE': return 'user';
    case 'ASSISTANT_MESSAGE': return 'assistant';
    case 'TOOL_CALL':
    case 'TOOL_RESULT': return 'tool';
    case 'ERROR': return 'error';
    case 'SYSTEM':
    case 'SYSTEM_SUMMARY': return 'system';
    default: return typeof type === 'string' ? type.toLowerCase() : 'assistant';
  }
}

/** A history turn as the platform sends it, with the `role` and `content` the SDK promises. */
function turnOf(raw: Record<string, unknown>): Turn {
  const role = typeof raw.role === 'string' ? raw.role : roleOf(raw.type);
  return { ...raw, role, content: typeof raw.content === 'string' ? raw.content : '' };
}

export interface StartOptions {
  /** One of the agents the App bundles. */
  agentId: string;
  /**
   * The person's project this conversation belongs to. A project has one conversation: starting
   * again with the same project picks it up where it was left.
   */
  projectId?: string;
  /** What the conversation belongs to, when not a project. Defaults to `project:<projectId>`. */
  contextRef?: string;
  /** Pick up this earlier conversation instead. */
  resume?: string;
}

export interface SendOptions {
  /** Called with each piece of the reply as it arrives. */
  onText?: (piece: string) => void;
  /** Files to show the agent with this message: photos, PDFs. */
  attachments?: Array<Blob | File>;
  signal?: AbortSignal;
  /** The person's language, e.g. `navigator.language`. */
  locale?: string;
  /**
   * The design run this turn belongs to, in an App with credits: round 0 of a design and its fix rounds send the same
   * `id`. The first turn naming a new id opens the run and holds the credits the whole design needs (round 0 and
   * `fixTurns` fix rounds), so its fix rounds are not refused half way; later turns naming it run on that hold. Close
   * the run when the design is done or abandoned (`credits.designRuns.close`). A platform from before design runs
   * ignores it, and the turn is admitted on its own as always.
   */
  designRun?: DesignRunOptions;
}

/** A turn's design run: see {@link SendOptions.designRun}. */
export interface DesignRunOptions {
  /** The App's own id for the design: a UUID (`crypto.randomUUID()`) is best; any 8-64 of `[A-Za-z0-9_-]`. */
  id: string;
  /**
   * Fix turns the run holds for besides round 0 - a whole number from 0 to {@link DESIGN_RUN_MAX_FIX_TURNS}. Read only by
   * the turn that opens the run. Default: the platform's (3). The platform may hold for fewer.
   */
  fixTurns?: number;
}

/** The body fields a turn's design run is sent as: `designRunId`, and `designFixTurns` when given. */
function designRunFields(run: DesignRunOptions | undefined): { designRunId?: string; designFixTurns?: number } {
  if (!run) return {};
  const designRunId = checkDesignRunId(run.id);
  if (run.fixTurns === undefined || run.fixTurns === null) return { designRunId };
  if (!Number.isInteger(run.fixTurns) || run.fixTurns < 0 || run.fixTurns > DESIGN_RUN_MAX_FIX_TURNS) {
    throw new DesignRunRefused('DESIGN_RUN_INVALID', { message: `designRun.fixTurns is a whole number from 0 to ${DESIGN_RUN_MAX_FIX_TURNS}.` });
  }
  return { designRunId, designFixTurns: run.fixTurns };
}

export interface Reply {
  text: string;
  usage: { input?: number; output?: number };
  /**
   * This turn, for `waive()`: present on conversations held to a per-person AI allowance.
   * Pass it to `conversation.waive(turnRef)` when the answer turned out to be unusable.
   */
  turnRef?: string;
  /** True when nothing was counted against the person's allowance for this turn. */
  notCharged?: boolean;
  /** True when the App may still waive this turn's charge (for a few minutes after it). */
  waivable?: boolean;
  /** An App with credits: the balance after this turn (also handed to `credits.onChange`). */
  credits?: CreditBalance;
  /** Whole credits this turn used, after any refund. */
  creditsUsed?: number;
  /**
   * True when the person stopped the turn (`chat.stop`, from this page or another) before it finished: `text` is what
   * streamed until then. What it used so far is kept, as `turnRef` / `notCharged` say.
   */
  cancelled?: boolean;
}

/**
 * How a turn came out, as the platform kept it - readable after a page reload. The money fields are about the
 * person: what this turn cost them, and whether it was given back.
 */
export interface TurnOutcome {
  turnId: string;
  /** `running`, or how it ended. `cancelled` is the person's own Stop. */
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  /** A completed turn's answer - for the conversation's latest turn (the history holds every answer). */
  text?: string;
  /** Why it did not complete: `MODEL_TIMEOUT`, `CANCELLED`, `TURN_LOST`, a spending-limit code... Map it to your own words. */
  code?: string;
  /** The platform's own sentence for `code` - meant for its own screens, not necessarily yours. */
  message?: string;
  /** For a turn that did not complete: whether sending the message again may work. */
  retryable?: boolean;
  /** The turn's charge reference (what `waive()` takes), on conversations held to a per-person allowance. */
  turnRef?: string;
  /** What the turn cost the person when it was settled, in USD (before any give-back). */
  chargedUsd?: number;
  /** True when what it cost was given back: it failed or timed out, its answer reached nobody, or it was waived. */
  refunded: boolean;
  /** True while an answer that reached nobody waits to be given back unless it is read in time. */
  refundPending: boolean;
  /** True when the person is not paying anything for this turn - say so with confidence. */
  notCharged: boolean;
  startedAt?: number;
  endedAt?: number;
}

/**
 * What `stop()` did: `stopped` (at once), `stopping` (another server runs the turn and stops it within seconds -
 * `reconnect` or `turn` then reads `cancelled`), or `not_running`.
 */
export type StopResult = 'stopped' | 'stopping' | 'not_running';

export interface ReconnectOptions {
  /** Called with the reply's text as it arrives: first what streamed before the reload, then each new piece. */
  onText?: (piece: string) => void;
  signal?: AbortSignal;
  /**
   * How long to keep at it while the turn runs - reattaching, or asking how it is going when another server
   * runs it - before handing back the turn as it then stands (`status: 'running'`). Default 15 minutes.
   */
  maxWaitMs?: number;
}

/** The outcome of `waive()`. */
export interface Waived {
  /** True when the turn's charge was given back to the person's allowance. */
  waived: boolean;
  /** What was given back, in USD. */
  amountUsd?: number;
  /** Why not, when `waived` is false: `NOT_FOUND` (not theirs, too old, or already waived), `LIMIT_REACHED`, or `UNAVAILABLE`. */
  reason?: 'NOT_FOUND' | 'LIMIT_REACHED' | 'UNAVAILABLE';
}

/**
 * A turn that ended in an error. When the platform did not count it against the person's
 * allowance, `notCharged` is true and the App may say so.
 */
export class TurnFailed extends AppError {
  readonly turnRef?: string;
  readonly notCharged: boolean;

  constructor(status: number, message: string, code: string | undefined, turnRef: string | undefined, notCharged: boolean,
    details?: Record<string, unknown>) {
    super(status, message, code, details);
    this.name = 'TurnFailed';
    this.turnRef = turnRef;
    this.notCharged = notCharged;
    Object.setPrototypeOf(this, TurnFailed.prototype);
  }
}

interface Started {
  success?: boolean;
  errorMessage?: string;
  sessionId?: string;
  sessionToken?: string;
  aiRuntimeUrl?: string;
  tokenExpiresAt?: string;
}

/** A conversation with one of the App's agents, as the signed-in person. */
export class Conversation {
  constructor(
    private readonly http: Http,
    readonly id: string,
    private readonly sessionToken: string,
    private readonly runtimeUrl: string,
    readonly expiresAt: number,
  ) {}

  /** Whether a turn is running in this conversation now (on any server). */
  isRunning(): Promise<boolean> {
    return new Turns(this.http).isRunning(this.id);
  }

  /** Stop this conversation's running turn, on whichever server runs it - see `chat.stop`. */
  stop(): Promise<StopResult> {
    return new Turns(this.http).stop(this.id);
  }

  /** Reattach to this conversation's turn - see `chat.reconnect`. */
  reconnect(options: ReconnectOptions = {}): Promise<TurnOutcome | null> {
    return new Turns(this.http).reconnect(this.id, options);
  }

  /** How this conversation's latest turn - or the one named - came out; null when there is none. */
  turn(turnId?: string): Promise<TurnOutcome | null> {
    return new Turns(this.http).outcome(this.id, turnId);
  }

  /** Send a message and stream the reply; resolves with the whole reply. */
  async send(message: string, options: SendOptions = {}): Promise<Reply> {
    // Checked first: a bad design run id is the App's bug, refused before any file is uploaded.
    const designRun = designRunFields(options.designRun);
    const attachmentIds: string[] = [];
    for (const [i, file] of (options.attachments ?? []).entries()) attachmentIds.push(await this.attach(file, i + 1));

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${this.sessionToken}`,
    };
    const locale = options.locale ?? (typeof navigator !== 'undefined' ? navigator.language : undefined);
    if (locale) headers['X-User-Locale'] = locale;
    const res = await this.http.config.fetch(`${this.runtimeUrl}/api/v1/workflow/ai-runtime/direct/sessions/${this.id}/messages/stream`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message, ...(attachmentIds.length ? { attachmentIds } : {}), ...designRun }),
      signal: options.signal,
    });
    if (res.status === 401) throw new AppError(401, 'This conversation has ended. Start it again to carry on.', 'CONVERSATION_ENDED');
    if (!res.ok) {
      // Refused before the stream began - a known-bad design run (400 / 403 / 409, or 429 DESIGN_HOLDS_BUSY), or 429
      // "temporarily unavailable" - whatever the status: the same typed refusals as on the stream, keeping the status.
      const body = await res.json().catch(() => null) as Record<string, unknown> | null;
      const refused = body && typeof body === 'object' ? refusalOf(body, undefined, res.status) : null;
      if (refused) throw refused instanceof DesignRunRefused ? refused : this.http.paused(refused);
      const code = typeof body?.code === 'string' ? body.code : undefined;
      // DAILY_LIMIT (429): the platform's own words say when to ask again; `details.resetAt` says it exactly.
      const words = code === 'DAILY_LIMIT' && typeof body?.message === 'string' ? body.message : 'No answer just now. Please try again.';
      throw new AppError(res.status, words, code, body && typeof body === 'object' ? body : undefined);
    }
    if (!res.body) throw new AppError(res.status, 'No answer just now. Please try again.');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let streamed = '';
    let turn: { turnRef?: string; notCharged?: boolean; waivable?: boolean; credits?: CreditBalance; creditsUsed?: number } = {};
    let name: string | undefined;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        name = eventName(line, name);
        if (!line.startsWith('data:')) continue;
        const event = eventOf(line, name);
        if (!event) continue;
        if (event.type === 'allowance') {
          // How the turn was settled against the person's allowance; arrives just before done/error.
          turn = {
            turnRef: typeof event.turnRef === 'string' ? event.turnRef : undefined,
            notCharged: event.notCharged === true,
            waivable: event.waivable === true,
          };
        } else if (event.type === 'credits') {
          // The person's credits after the turn (an App with credits); arrives just before done/error.
          const credits = readCredits(event);
          if (credits) {
            turn = { ...turn, credits, creditsUsed: credits.used };
            this.http.creditsSeen(event);
          }
        } else if (event.type === 'token' && typeof event.content === 'string') {
          streamed += event.content;
          options.onText?.(event.content);
        } else if (event.type === 'done') {
          // A guardrail can rewrite the answer; what it says then is the answer.
          const text = event.contentReplaced === true && typeof event.content === 'string' ? event.content : streamed;
          return { text, usage: { input: num(event.promptTokens), output: num(event.completionTokens) }, ...turn };
        } else if (event.type === 'error') {
          const code = String(event.errorCode ?? event.code ?? '');
          const msg = typeof event.message === 'string' ? event.message : undefined;
          // The person's credits cannot start a turn now: shown as "out of credits", never as an error.
          const outOfCredits = CreditsUsedUp.from(event, msg);
          if (outOfCredits) throw this.http.paused(outOfCredits);
          // The design run this turn named may not be used as asked (DESIGN_*): not a pause, nothing to wait for.
          const designRefused = DesignRunRefused.from(event, msg);
          if (designRefused) throw designRefused;
          // The App's AI paused (its plan's shared pool, or the App's own budget) - not the person's allowance - or,
          // `retryable`, "temporarily unavailable" for a minute.
          const paused = AiPaused.from(event, msg);
          if (paused) throw this.http.paused(paused);
          if (code === 'BUDGET_EXCEEDED' || code === 'COST_POLICY_EXCEEDED') throw new AllowanceUsed(msg);
          throw new TurnFailed(502, msg ?? 'The answer stopped partway through.', code || undefined, turn.turnRef, turn.notCharged === true,
            event);
        } else if (event.type === 'cancelled') {
          // The person stopped the turn: the stream's last event - no done and no error follow it.
          return {
            text: streamed,
            usage: {},
            ...turn,
            turnRef: typeof event.turnRef === 'string' ? event.turnRef : turn.turnRef,
            notCharged: event.notCharged === true || turn.notCharged === true,
            cancelled: true,
          };
        }
      }
    }
    if (streamed) return { text: streamed, usage: {}, ...turn };
    throw new AppError(502, 'The answer stopped before it began.');
  }

  /**
   * Give back what one of this conversation's recent turns cost the person, because the App could
   * not use its answer (it could not be read, had nothing in it, failed the App's own checks).
   * `turnRef` is `reply.turnRef`. Allowed once per turn, within minutes of it, for the person's own
   * turns, and a limited number of times a month. A turn that ended in an error was already not
   * counted (`TurnFailed.notCharged`). Never throws for a turn that cannot be waived: check `waived`.
   */
  async waive(turnRef: string, reason?: string): Promise<Waived> {
    try {
      const body = await this.http.request<{ turnRef?: string; waivedUsd?: number }>('POST',
        `${this.http.config.aiRuntimeUrl}/api/v1/workflow/ai-runtime/sessions/mine/${encodeURIComponent(this.id)}/turns/${encodeURIComponent(turnRef)}/waive`,
        reason ? { reason } : {});
      return { waived: true, amountUsd: typeof body?.waivedUsd === 'number' ? body.waivedUsd : undefined };
    } catch (e) {
      if (e instanceof SignInRequired) throw e;
      if (e instanceof AppError) {
        if (e.status === 404) return { waived: false, reason: 'NOT_FOUND' };
        if (e.status === 429) return { waived: false, reason: 'LIMIT_REACHED' };
        return { waived: false, reason: 'UNAVAILABLE' };
      }
      return { waived: false, reason: 'UNAVAILABLE' };
    }
  }

  private async attach(file: Blob | File, n: number): Promise<string> {
    const form = new FormData();
    const name = (file as File).name || `attachment-${n}`;
    form.append('file', file, name);
    const res = await this.http.config.fetch(`${this.runtimeUrl}/api/v1/workflow/ai-runtime/sessions/${this.id}/attachments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.sessionToken}` },
      body: form,
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string; message?: string };
    if (!res.ok || !body.id) throw new AppError(res.status, body.message ?? body.error ?? 'The file could not be attached.');
    return body.id;
  }
}

const num = (v: unknown) => (typeof v === 'number' ? v : undefined);

const RUNTIME = '/api/v1/workflow/ai-runtime/sessions/mine/';

/** The name an `event:` line gives the data lines after it, else the one in force (a blank line ends an event). */
function eventName(line: string, current: string | undefined): string | undefined {
  if (line.startsWith('event:')) return line.slice(6).trim() || undefined;
  if (line.trim() === '') return undefined;
  return current;
}

/**
 * One SSE data line as an event. Its `type` is the data's own when it has one, else the `event:` name: the platform
 * sends some events - `turn_outcome` - as a bare object, named only by the `event:` line.
 */
function eventOf(line: string, name: string | undefined): Record<string, unknown> | null {
  let event: unknown;
  try {
    event = JSON.parse(line.slice(5).trim());
  } catch {
    return null;
  }
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const e = event as Record<string, unknown>;
  return typeof e.type === 'string' || !name ? e : { ...e, type: name };
}

function idOf(conversation: Conversation | string): string {
  const id = typeof conversation === 'string' ? conversation : conversation?.id;
  if (!id) throw new AppError(400, 'Which conversation?');
  return id;
}

/** A turn outcome as the platform answers it (`/turn`, `/turns/{id}`, a `turn_outcome` event). */
function outcomeOf(raw: Record<string, unknown>): TurnOutcome {
  const status = String(raw.status ?? 'interrupted') as TurnOutcome['status'];
  return {
    turnId: String(raw.turnId ?? ''),
    status,
    text: typeof raw.content === 'string' ? raw.content : undefined,
    code: typeof raw.code === 'string' ? raw.code : undefined,
    message: typeof raw.message === 'string' ? raw.message : undefined,
    retryable: typeof raw.retryable === 'boolean' ? raw.retryable : undefined,
    turnRef: typeof raw.turnRef === 'string' ? raw.turnRef : undefined,
    chargedUsd: num(raw.chargedUsd),
    refunded: raw.refunded === true,
    refundPending: raw.refundPending === true,
    notCharged: raw.notCharged === true,
    startedAt: num(raw.startedAt),
    endedAt: num(raw.endedAt),
  };
}

const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const t = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
  const stop = () => { clearTimeout(t); reject(signal?.reason); };
  signal?.addEventListener('abort', stop, { once: true });
});

/** What one reconnect attempt came to. */
type Attempt =
  | { kind: 'ended'; outcome: TurnOutcome | null; text?: string }
  | { kind: 'elsewhere'; pollAfterMs: number }
  | { kind: 'dropped' };

/**
 * The reload-safe side of a conversation: is a turn running, how did it end, and reattach to it. Everything goes
 * as the signed-in person (their own conversations only), so it works after a reload with nothing kept from before.
 */
class Turns {
  constructor(private readonly http: Http) {}

  private url(id: string, path: string) {
    return `${this.http.config.aiRuntimeUrl}${RUNTIME}${encodeURIComponent(id)}${path}`;
  }

  async isRunning(id: string): Promise<boolean> {
    try {
      const body = await this.http.request<{ running?: boolean }>('GET', this.url(id, '/running'));
      return body?.running === true;
    } catch (e) {
      if (e instanceof AppError && e.status === 404) return false;
      throw e;
    }
  }

  async stop(id: string): Promise<StopResult> {
    try {
      const body = await this.http.request<{ result?: string }>('POST', this.url(id, '/stop'), {});
      return body?.result === 'stopped' || body?.result === 'stopping' ? body.result : 'not_running';
    } catch (e) {
      if (e instanceof AppError && e.status === 404) return 'not_running';
      throw e;
    }
  }

  async outcome(id: string, turnId?: string): Promise<TurnOutcome | null> {
    try {
      const raw = await this.http.request<Record<string, unknown>>('GET',
        this.url(id, turnId ? `/turns/${encodeURIComponent(turnId)}` : '/turn'));
      return raw ? outcomeOf(raw) : null;
    } catch (e) {
      if (e instanceof AppError && e.status === 404) return null;
      throw e;
    }
  }

  async reconnect(id: string, options: ReconnectOptions = {}): Promise<TurnOutcome | null> {
    const until = Date.now() + (options.maxWaitMs ?? 15 * 60_000);
    let shown = '';
    const show = (text: string) => {
      // A replay starts from the beginning: hand on only what the page has not had yet.
      if (text.length > shown.length && text.startsWith(shown)) options.onText?.(text.slice(shown.length));
      else if (!text.startsWith(shown)) options.onText?.(text);
      shown = text;
    };
    for (;;) {
      const attempt = await this.attempt(id, show, () => shown, options.signal);
      if (attempt.kind === 'ended') {
        if (attempt.outcome && attempt.text !== undefined && attempt.outcome.status === 'completed') {
          return { ...attempt.outcome, text: attempt.outcome.text ?? attempt.text };
        }
        return attempt.outcome;
      }
      if (Date.now() >= until) return this.outcome(id);
      // Another server runs the turn, or the stream dropped: wait, then reattach - which lands on the right
      // server or answers how the turn ended. Never asks the turn to run again.
      await wait(attempt.kind === 'elsewhere' ? attempt.pollAfterMs : 2_000, options.signal);
    }
  }

  private async attempt(id: string, show: (text: string) => void, shownSoFar: () => string,
    signal?: AbortSignal): Promise<Attempt> {
    let res: Response;
    try {
      res = await this.http.stream(this.url(id, '/stream/reconnect'), signal);
    } catch (e) {
      if (e instanceof SignInRequired || signal?.aborted) throw e;
      return { kind: 'dropped' };
    }
    if (res.status === 404) return { kind: 'ended', outcome: null };
    if (!res.ok || !res.body) return { kind: 'dropped' };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = shownSoFar();
    let outcome: TurnOutcome | null = null;
    let name: string | undefined;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          name = eventName(line, name);
          if (!line.startsWith('data:')) continue;
          const event = eventOf(line, name);
          if (!event) continue;
          if (event.type === 'reconnect') {
            text = typeof event.content === 'string' ? event.content : '';
            show(text);
          } else if (event.type === 'token' && typeof event.content === 'string') {
            text += event.content;
            show(text);
          } else if (event.type === 'credits') {
            this.http.creditsSeen(event);
          } else if (event.type === 'done') {
            if (event.contentReplaced === true && typeof event.content === 'string') text = event.content;
            // The turn ended on this stream: its settled outcome (charge, refund) is read back.
            return { kind: 'ended', outcome: await this.outcome(id), text };
          } else if (event.type === 'error' || event.type === 'cancelled') {
            // Failed, or stopped (`cancelled` is a stopped turn's last event): how it ended is read back.
            return { kind: 'ended', outcome: await this.outcome(id) };
          } else if (event.type === 'turn_running') {
            return { kind: 'elsewhere', pollAfterMs: num(event.pollAfterMs) ?? 3_000 };
          } else if (event.type === 'turn_outcome') {
            outcome = outcomeOf(event);
          } else if (event.type === 'no_active_turn') {
            return { kind: 'ended', outcome };
          }
        }
      }
    } catch (e) {
      if (signal?.aborted) throw e;
    }
    // Closed without an ending (a load balancer's idle limit, a network change): looked at again.
    return outcome ? { kind: 'ended', outcome } : { kind: 'dropped' };
  }
}

/** Conversations with the App's agents. */
export class Chat {
  private readonly turns: Turns;

  constructor(private readonly http: Http) {
    this.turns = new Turns(http);
  }

  /**
   * Whether a turn is running now in one of the person's conversations - on any server: the platform keeps a
   * heartbeat for every running turn, so this is right after a reload, and turns false within about 90 seconds
   * of a server that was running it stopping.
   */
  isRunning(conversation: Conversation | string): Promise<boolean> {
    return this.turns.isRunning(idOf(conversation));
  }

  /**
   * Pick a turn back up after a reload. A turn still running streams the rest of its reply to `onText` (first
   * what it said before the reload, then each new piece) and resolves when it ends; a turn that already ended
   * resolves at once. Either way with how it came out - `completed` with its `text`, or `failed` / `cancelled` /
   * `interrupted` with a `code` - and what it cost the person (`notCharged`, `refunded`). Resolves null when the
   * conversation has no turn on record.
   *
   * When another server runs the turn it cannot be streamed from here; the SDK then asks again every few
   * seconds - each time it may reach the right server and stream, or find the turn ended - for up to `maxWaitMs`.
   * Never sends the message again.
   */
  reconnect(conversation: Conversation | string, options: ReconnectOptions = {}): Promise<TurnOutcome | null> {
    return this.turns.reconnect(idOf(conversation), options);
  }

  /**
   * Stop the turn running in one of the person's conversations - on whichever server runs it, also after a
   * reload. Like pressing Stop: what the turn used so far is kept. `stopping` means another server runs it and
   * stops it within seconds; the turn then reads `cancelled`.
   */
  stop(conversation: Conversation | string): Promise<StopResult> {
    return this.turns.stop(idOf(conversation));
  }

  /**
   * How a turn came out: the conversation's latest (with its answer), or the one `turnId` names (kept 7 days;
   * the answer is in `history`). Null when there is no such turn.
   */
  turn(conversation: Conversation | string, turnId?: string): Promise<TurnOutcome | null> {
    return this.turns.outcome(idOf(conversation), turnId);
  }

  /** Start a conversation - or, for a project, pick up its conversation. */
  async start(options: StartOptions): Promise<Conversation> {
    const contextRef = options.contextRef ?? (options.projectId ? `project:${options.projectId}` : undefined);
    let body: Started;
    try {
      body = await this.http.request<Started>('POST', this.http.api('/gateway/ai-sessions'), {
        agentId: options.agentId,
        projectId: options.projectId,
        contextRef,
        resumeFromSessionId: options.resume,
      });
    } catch (e) {
      if (e instanceof SignInRequired) throw e;
      const outOfCredits = e instanceof AppError ? CreditsUsedUp.from(e.details ?? { code: e.code }, e.message) : null;
      if (outOfCredits) throw this.http.paused(outOfCredits);
      const paused = e instanceof AppError ? AiPaused.from(e.details, e.message) : null;
      if (paused) throw this.http.paused(paused);
      if (e instanceof AppError && /allowance/i.test(e.message)) throw new AllowanceUsed(e.message);
      throw e;
    }
    if (!body?.success || !body.sessionId || !body.sessionToken) {
      throw new AppError(502, body?.errorMessage ?? 'The conversation could not start just now.');
    }
    const runtime = (body.aiRuntimeUrl || this.http.config.aiRuntimeUrl).replace(/\/+$/, '');
    const expiresAt = body.tokenExpiresAt ? Date.parse(body.tokenExpiresAt) : Date.now() + 60 * 60 * 1000;
    return new Conversation(this.http, body.sessionId, body.sessionToken, runtime, expiresAt);
  }

  /** The person's conversations, newest first: all, one project's, or one context's. */
  async list(filter: { projectId?: string; contextRef?: string; agentId?: string; limit?: number } = {}): Promise<ConversationSummary[]> {
    const q = new URLSearchParams();
    const contextRef = filter.contextRef ?? (filter.projectId ? `project:${filter.projectId}` : undefined);
    if (contextRef) q.set('contextRef', contextRef);
    if (filter.agentId) q.set('agentId', filter.agentId);
    q.set('limit', String(filter.limit ?? 20));
    return this.http.request<ConversationSummary[]>('GET', `${this.http.config.aiRuntimeUrl}/api/v1/workflow/ai-runtime/sessions/mine?${q}`);
  }

  /** A conversation's turns so far. */
  async history(conversationId: string): Promise<Turn[]> {
    const body = await this.http.request<{ success?: boolean; history?: { turns?: unknown[] }; error?: string }>(
      'GET', `${this.http.config.aiRuntimeUrl}/api/v1/workflow/ai-runtime/sessions/history/${encodeURIComponent(conversationId)}`);
    if (body && body.success === false) throw new AppError(404, body.error ?? 'That conversation could not be found.');
    // The platform's turns (AgentTurn) carry `type`, not `role`: each is given the role the SDK promises.
    const turns = body?.history?.turns;
    return Array.isArray(turns)
      ? turns.filter((t): t is Record<string, unknown> => !!t && typeof t === 'object').map(turnOf)
      : [];
  }

  /** Rename one of the person's conversations. */
  async rename(conversationId: string, title: string): Promise<ConversationSummary> {
    return this.http.request<ConversationSummary>('PATCH',
      `${this.http.config.aiRuntimeUrl}/api/v1/workflow/ai-runtime/sessions/mine/${encodeURIComponent(conversationId)}`, { title });
  }

  /** Delete one of the person's conversations, with its history and the files sent in it. */
  async delete(conversationId: string): Promise<void> {
    await this.http.request<void>('DELETE',
      `${this.http.config.aiRuntimeUrl}/api/v1/workflow/ai-runtime/sessions/mine/${encodeURIComponent(conversationId)}`);
  }
}
