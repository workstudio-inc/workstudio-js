import type { KeyValueStore, ResolvedConfig } from './config';
import { AppError, SignInRequired } from './errors';

/** Who is signed in. */
export interface SignedIn {
  name?: string;
  email?: string;
  /** The platform token: this person, in their own install of the App. Short-lived. */
  platformToken: string;
  platformTokenExpiresAt: number;
  /** For a fresh sign-in token - and from it a fresh platform token - without asking again. */
  refreshToken?: string;
}

export type SignInMethod = 'google' | 'apple' | 'email';

const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
const REFRESH_MARGIN_MS = 60_000;

interface RealmTokens {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
}

interface Pending {
  verifier: string;
  state: string;
}

function memoryStore(): KeyValueStore {
  const m = new Map<string, string>();
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: k => void m.delete(k) };
}

function defaultStore(): KeyValueStore {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.getItem('__probe__');
      return localStorage;
    }
  } catch {
    /* a private window may refuse storage */
  }
  return memoryStore();
}

function base64url(bytes: Uint8Array): string {
  let s = '';
  bytes.forEach(b => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64url(buf);
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** A token's claims, for display only - never trusted. */
function claims(jwt: string): Record<string, unknown> {
  try {
    const part = (jwt.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(
      Array.from(atob(part), c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''),
    );
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Signing in, for an App people use directly.
 *
 * The person signs in on the platform's hosted page for this App (Google, Apple or email) - never in
 * a form of the App's - with authorisation code and PKCE, as a public client: there is no secret to
 * ship. The sign-in token is swapped once for a platform token for this person's own install of the
 * App, which is all it can reach. It lasts minutes; the SDK refreshes it as needed.
 */
export class Auth {
  private readonly store: KeyValueStore;
  private current: SignedIn | null = null;
  private loaded: Promise<void> | null = null;
  private refreshing: Promise<string | null> | null = null;
  private readonly listeners = new Set<(who: SignedIn | null) => void>();

  constructor(private readonly config: ResolvedConfig) {
    this.store = config.storage ?? defaultStore();
  }

  private get key() {
    return this.config.storageKey;
  }

  private load(): Promise<void> {
    if (!this.loaded) {
      this.loaded = (async () => {
        try {
          const raw = await this.store.getItem(this.key);
          this.current = raw ? (JSON.parse(raw) as SignedIn) : null;
        } catch {
          this.current = null;
        }
      })();
    }
    return this.loaded;
  }

  private async save(who: SignedIn | null) {
    this.current = who;
    try {
      if (who) await this.store.setItem(this.key, JSON.stringify(who));
      else await this.store.removeItem(this.key);
    } catch {
      /* kept in memory only */
    }
    this.listeners.forEach(l => l(who));
  }

  /** Who is signed in, or null. */
  async signedIn(): Promise<SignedIn | null> {
    await this.load();
    return this.current;
  }

  /** Called whenever someone signs in or out, or their sign-in lapses. Returns an unsubscribe. */
  onChange(listener: (who: SignedIn | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private redirectUri(): string {
    if (this.config.redirectUri) return this.config.redirectUri;
    if (typeof location !== 'undefined') return `${location.origin}/`;
    throw new Error('Set redirectUri: there is no page origin to return to.');
  }

  /** The hosted sign-in page's address, for an App that opens it itself. */
  async signInUrl(method?: SignInMethod): Promise<string> {
    const { signInIssuer, clientId } = this.config;
    if (!signInIssuer || !clientId) throw new Error('Sign-in is not set up: signInIssuer and clientId are required.');
    const verifier = randomString(48);
    const state = randomString(16);
    await this.store.setItem(`${this.key}.pending`, JSON.stringify({ verifier, state } satisfies Pending));
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: this.redirectUri(),
      scope: 'openid profile email',
      state,
      code_challenge: await challengeFor(verifier),
      code_challenge_method: 'S256',
    });
    // Straight to that provider, when the person already chose one.
    if (method === 'google' || method === 'apple') params.set('kc_idp_hint', method);
    return `${signInIssuer}/protocol/openid-connect/auth?${params}`;
  }

  /** Send the person to the hosted sign-in page. */
  async signIn(options: { method?: SignInMethod } = {}): Promise<void> {
    const url = await this.signInUrl(options.method);
    if (this.config.openUrl) await this.config.openUrl(url);
    else if (typeof location !== 'undefined') location.assign(url);
    else throw new Error('Pass openUrl to open the sign-in page outside a browser.');
  }

  /**
   * Finish a sign-in, if this address is the hosted page sending the person back - the page's own
   * address in a browser, the deep link on a phone. A no-op (null) otherwise; call it at start-up.
   */
  async completeSignIn(from?: string): Promise<SignedIn | null> {
    const href = from ?? (typeof location !== 'undefined' ? location.href : '');
    if (!href) return null;
    const url = new URL(href);
    const code = url.searchParams.get('code');
    const failed = url.searchParams.get('error');
    if (!code && !failed) return null;
    if (!from && typeof history !== 'undefined') {
      // Take the code out of the address bar, so a reload or a shared link does not replay it.
      history.replaceState(null, '', url.pathname + url.hash);
    }
    const raw = await this.store.getItem(`${this.key}.pending`);
    await this.store.removeItem(`${this.key}.pending`);
    if (failed) throw new AppError(400, url.searchParams.get('error_description') ?? 'Sign-in was cancelled.', failed);
    const pending = raw ? (JSON.parse(raw) as Pending) : null;
    if (!pending || pending.state !== url.searchParams.get('state')) {
      throw new AppError(400, 'That sign-in link has expired. Please sign in again.', 'STALE_SIGN_IN');
    }
    const tokens = await this.realmToken({
      grant_type: 'authorization_code',
      code: code!,
      redirect_uri: this.redirectUri(),
      client_id: this.config.clientId!,
      code_verifier: pending.verifier,
    });
    const who = await this.swap(tokens);
    await this.save(who);
    return who;
  }

  /** Forget the sign-in on this device. */
  async signOut(): Promise<void> {
    await this.load();
    await this.save(null);
  }

  /**
   * A platform token good for at least another minute, refreshed when needed.
   * @throws SignInRequired when nobody is signed in or the sign-in has lapsed
   */
  async token(): Promise<string> {
    if (this.config.platformToken) {
      const own = await this.config.platformToken();
      if (!own) throw new SignInRequired();
      return own;
    }
    await this.load();
    const who = this.current;
    if (!who) throw new SignInRequired();
    if (who.platformTokenExpiresAt - Date.now() > REFRESH_MARGIN_MS) return who.platformToken;
    // One refresh at a time: concurrent calls share it.
    this.refreshing ??= this.refresh(who).finally(() => (this.refreshing = null));
    const fresh = await this.refreshing;
    if (!fresh) throw new SignInRequired('Your sign-in has expired. Please sign in again.');
    return fresh;
  }

  /** Forget the sign-in after the platform refused it, so the App asks the person again. */
  async refused(): Promise<void> {
    if (!this.config.platformToken) await this.save(null);
  }

  private async refresh(who: SignedIn): Promise<string | null> {
    if (!who.refreshToken) {
      await this.save(null);
      return null;
    }
    try {
      const tokens = await this.realmToken({ grant_type: 'refresh_token', refresh_token: who.refreshToken, client_id: this.config.clientId! });
      const fresh = await this.swap(tokens);
      await this.save(fresh);
      return fresh.platformToken;
    } catch {
      await this.save(null);
      return null;
    }
  }

  private async realmToken(form: Record<string, string>): Promise<RealmTokens> {
    const res = await this.config.fetch(`${this.config.signInIssuer}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
    });
    if (!res.ok) throw new AppError(res.status, 'Sign-in did not complete. Please try again.');
    return (await res.json()) as RealmTokens;
  }

  /** The sign-in token for a platform token: the one swap, after which the platform knows this person. */
  private async swap(tokens: RealmTokens): Promise<SignedIn> {
    const res = await this.config.fetch(`${this.config.apiUrl}/api/v1/workflow/connection/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: TOKEN_EXCHANGE, subject_token: tokens.access_token, subject_token_type: ACCESS_TOKEN_TYPE }),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !body.access_token) {
      throw new AppError(res.status, body.error_description ?? 'You could not be signed in just now. Please try again.', body.error);
    }
    const profile = claims(tokens.id_token ?? tokens.access_token);
    return {
      name: (profile.name as string | undefined) ?? (profile.given_name as string | undefined),
      email: profile.email as string | undefined,
      platformToken: body.access_token,
      platformTokenExpiresAt: Date.now() + (body.expires_in ?? 900) * 1000,
      refreshToken: tokens.refresh_token,
    };
  }
}
