import type { Auth } from './auth';
import type { ResolvedConfig } from './config';
import { AppError, SignInRequired } from './errors';

/** Calls the platform as the signed-in person. */
export class Http {
  constructor(readonly config: ResolvedConfig, private readonly auth: Auth) {}

  /** Whether calls go as someone: a person signed in here, or a token the App brings. */
  async signedIn(): Promise<boolean> {
    return Boolean(this.config.platformToken) || (await this.auth.signedIn()) !== null;
  }

  /** A GET that needs nobody signed in - what an App made public. */
  async anonymous<T>(url: string): Promise<T> {
    return this.send<T>(url, { method: 'GET', headers: { Accept: 'application/json' } }, false);
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
    if (!res.ok) throw new AppError(res.status, messageOf(parsed, res.status), codeOf(parsed));
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
