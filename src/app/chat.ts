import type { Http } from './http';
import { AiPaused, AllowanceUsed, AppError, CreditsUsedUp, SignInRequired } from './errors';
import { read as readCredits, type CreditBalance } from './credits';

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

/** One turn of a conversation's history. */
export interface Turn {
  role: string;
  content: string;
  [key: string]: unknown;
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

  constructor(status: number, message: string, code: string | undefined, turnRef: string | undefined, notCharged: boolean) {
    super(status, message, code);
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

  /** Send a message and stream the reply; resolves with the whole reply. */
  async send(message: string, options: SendOptions = {}): Promise<Reply> {
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
      body: JSON.stringify({ message, ...(attachmentIds.length ? { attachmentIds } : {}) }),
      signal: options.signal,
    });
    if (res.status === 401) throw new AppError(401, 'This conversation has ended. Start it again to carry on.', 'CONVERSATION_ENDED');
    if (!res.ok || !res.body) throw new AppError(res.status, 'No answer just now. Please try again.');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let streamed = '';
    let turn: { turnRef?: string; notCharged?: boolean; waivable?: boolean; credits?: CreditBalance; creditsUsed?: number } = {};
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
        } catch {
          continue;
        }
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
          // The App's AI paused (its plan's shared pool, or the App's own budget) - not the person's allowance.
          const paused = AiPaused.from(event, msg);
          if (paused) throw this.http.paused(paused);
          if (code === 'BUDGET_EXCEEDED' || code === 'COST_POLICY_EXCEEDED') throw new AllowanceUsed(msg);
          throw new TurnFailed(502, msg ?? 'The answer stopped partway through.', code || undefined, turn.turnRef, turn.notCharged === true);
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

/** Conversations with the App's agents. */
export class Chat {
  constructor(private readonly http: Http) {}

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
    const body = await this.http.request<{ success?: boolean; history?: { turns?: Turn[] }; error?: string }>(
      'GET', `${this.http.config.aiRuntimeUrl}/api/v1/workflow/ai-runtime/sessions/history/${encodeURIComponent(conversationId)}`);
    if (body && body.success === false) throw new AppError(404, body.error ?? 'That conversation could not be found.');
    return body?.history?.turns ?? [];
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
