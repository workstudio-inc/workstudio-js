import type { Auth } from './auth';
import type { ResolvedConfig } from './config';
import { AiPaused, AppError, CreditsUsedUp, SignInRequired } from './errors';

/** Calls the platform as the signed-in person. */
export class Http {
  constructor(readonly config: ResolvedConfig, private readonly auth: Auth) {}

  /**
   * The last pause a request ran into, so `ai.status()` says paused straight away rather than after
   * its cache runs out. Disregarded once its `resetAt` has passed.
   */
  lastPause: AiPaused | CreditsUsedUp | null = null;

  /** Remember a pause a request ran into, and hand it back to throw. */
  paused<E extends AiPaused | CreditsUsedUp>(error: E): E {
    this.lastPause = error;
    if (error instanceof CreditsUsedUp && error.credits) this.creditsSeen(error.credits);
    return error;
  }

  private readonly creditListeners = new Set<(raw: Record<string, unknown>) => void>();

  /** Hear every credits balance the platform says - a chat turn's `credits` event, a picture's answer, a refusal. */
  onCredits(listener: (raw: Record<string, unknown>) => void): () => void {
    this.creditListeners.add(listener);
    return () => this.creditListeners.delete(listener);
  }

  /** A credits balance the platform said, as it said it. */
  creditsSeen(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    for (const l of this.creditListeners) {
      try {
        l(raw as Record<string, unknown>);
      } catch {
        // A listener's own failure is its own.
      }
    }
  }

  /** Whether calls go as someone: a person signed in here, or a token the App brings. */
  async signedIn(): Promise<boolean> {
    return Boolean(this.config.platformToken) || (await this.auth.signedIn()) !== null;
  }

  /** A call that needs nobody signed in - what an App made public, or a guest share's link. */
  async anonymous<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
    const init: RequestInit = { method, headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    }
    return this.send<T>(url, init, false);
  }

  async request<T>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const token = await this.auth.token();
    const init: RequestInit = { method, headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...headers } };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    }
    return this.send<T>(url, init, true);
  }

  /**
   * Open an event stream as the signed-in person (`Accept: text/event-stream`). The response is handed back as it
   * is, for the caller to read; a refused sign-in throws `SignInRequired` as `request` does.
   */
  async stream(url: string, signal?: AbortSignal): Promise<Response> {
    const token = await this.auth.token();
    let res: Response;
    try {
      res = await this.config.fetch(url, { method: 'GET', headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` }, signal });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new AppError(0, 'Could not reach the service. Check the connection and try again.', 'NETWORK');
    }
    if (res.status === 401) {
      await this.auth.refused();
      throw new SignInRequired('Your sign-in has expired. Please sign in again.');
    }
    return res;
  }

  private async send<T>(url: string, init: RequestInit, asSomeone: boolean): Promise<T> {
    let res: Response;
    try {
      res = await this.config.fetch(url, init);
    } catch {
      throw new AppError(0, 'Could not reach the service. Check the connection and try again.', 'NETWORK');
    }
    if (res.status === 401 && asSomeone) {
      await this.auth.refused();
      throw new SignInRequired('Your sign-in has expired. Please sign in again.');
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    if (!res.ok) {
      const details = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
      throw new AppError(res.status, messageOf(parsed, res.status), codeOf(parsed), details);
    }
    return parsed as T;
  }

  api(path: string) {
    return `${this.config.apiUrl}/api/v1/workflow${path}`;
  }
}

function messageOf(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    for (const k of ['message', 'error_description', 'errorMessage', 'detail', 'error']) {
      if (typeof b[k] === 'string' && b[k]) return b[k] as string;
    }
  }
  if (status === 403) return 'That is not available to you.';
  if (status === 404) return 'That could not be found.';
  return 'Something went wrong. Please try again.';
}

function codeOf(body: unknown): string | undefined {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const code = b.code ?? b.errorCode ?? (typeof b.error === 'string' && /^[A-Z_]+$/.test(b.error) ? b.error : undefined);
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}
