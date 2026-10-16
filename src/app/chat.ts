import type { Http } from './http';
import { AllowanceUsed, AppError, SignInRequired } from './errors';

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
        if (event.type === 'token' && typeof event.content === 'string') {
          streamed += event.content;
          options.onText?.(event.content);
        } else if (event.type === 'done') {
          // A guardrail can rewrite the answer; what it says then is the answer.
          const text = event.contentReplaced === true && typeof event.content === 'string' ? event.content : streamed;
          return { text, usage: { input: num(event.promptTokens), output: num(event.completionTokens) } };
        } else if (event.type === 'error') {
          const code = String(event.errorCode ?? event.code ?? '');
          const msg = typeof event.message === 'string' ? event.message : undefined;
          if (code === 'BUDGET_EXCEEDED' || code === 'COST_POLICY_EXCEEDED') throw new AllowanceUsed(msg);
          throw new AppError(502, msg ?? 'The answer stopped partway through.', code || undefined);
        }
      }
    }
    if (streamed) return { text: streamed, usage: {} };
    throw new AppError(502, 'The answer stopped before it began.');
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
