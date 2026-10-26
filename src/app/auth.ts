import type { KeyValueStore, ResolvedConfig } from './config';
import { AppError, SignInRequired } from './errors';
import { refreshLock, type RefreshLock, type StorageLockOptions } from './refreshLock';

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

export type SignInMethod = 'google' | 'apple' | 'microsoft' | 'github' | 'email';

const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
const REFRESH_MARGIN_MS = 60_000;

/** How a refresh that could not reach the sign-in service is retried. */
export interface RefreshRetry {
  /** Tries in all, the first included. Default 5. */
  attempts?: number;
  /** The first wait; each one after doubles, with jitter. Default 500 ms. */
  baseMs?: number;
  /** The longest wait between tries. Default 8 s. */
  capMs?: number;
  /** A Retry-After longer than this ends the retries rather than being waited out. Default 30 s. */
  maxRetryAfterMs?: number;
}

/** @internal For tests: the refresh's retries and the storage lock's timings. */
export interface RefreshTuning {
  retry?: RefreshRetry;
  lock?: StorageLockOptions;
}

const DEFAULT_RETRY: Required<RefreshRetry> = { attempts: 5, baseMs: 500, capMs: 8_000, maxRetryAfterMs: 30_000 };

/** How a refresh ended: a token, signed out, or not reachable just now (still signed in). */
type Refreshed = { token: string } | { signedOut: true } | { unavailable: AppError };

interface RealmTokens {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
}

interface Pending {
  verifier: string;
  state: string;
  /** Where the person was when they left to sign in: the App takes them back there. */
  returnTo?: string;
}

/** How to send someone to the hosted page. */
export interface SignInOptions {
  /** Straight to that provider - Google, Apple, Microsoft or GitHub - skipping the hosted page. */
  method?: SignInMethod;
  /** Open on "create an account" rather than "sign in". */
  signUp?: boolean;
  /**
   * Where the person was - a path and hash, e.g. `/#custom/abc`; the current address in a browser
   * by default. It comes back from {@link Auth.completeSignIn} as `returnTo`.
   */
  returnTo?: string;
}

/** A completed sign-in, and where the person was when they left for it. */
export type CompletedSignIn = SignedIn & { returnTo?: string };

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
  private refreshing: Promise<Refreshed> | null = null;
  private refreshingForced = false;
  /** Bumped by every sign-in and sign-out here, so a refresh that outlives one never writes over it. */
  private epoch = 0;
  private readonly listeners = new Set<(who: SignedIn | null) => void>();
  private readonly signingOut = new Set<() => Promise<void>>();
  private readonly retry: Required<RefreshRetry>;
  private readonly lock: RefreshLock;

  /** `tuning` is for tests: how often and how long a refresh is retried, and the storage lock's timings. */
  constructor(private readonly config: ResolvedConfig, tuning: RefreshTuning = {}) {
    this.store = config.storage ?? defaultStore();
    this.retry = { ...DEFAULT_RETRY, ...tuning.retry };
    // Shared by every tab on this origin with the same storage key: the same sign-in.
    this.lock = refreshLock(`${config.storageKey}.refresh`, tuning.lock);
  }

  /** @internal Where the sign-in is kept - other parts of the SDK keep their own few values beside it. */
  get storage(): KeyValueStore {
    return this.store;
  }

  /**
   * @internal Run before signing out, while the person is still signed in (push forgets this device).
   * Each is awaited but may not fail the sign-out; keep them short.
   */
  beforeSignOut(hook: () => Promise<void>): () => void {
    this.signingOut.add(hook);
    return () => this.signingOut.delete(hook);
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

  /** Store the sign-in, then hold it here and tell the listeners: nothing sees a token the store does not. */
  private async save(who: SignedIn | null) {
    await this.persist(who);
    this.adopt(who);
  }

  private async persist(who: SignedIn | null) {
    try {
      if (who) await this.store.setItem(this.key, JSON.stringify(who));
      else await this.store.removeItem(this.key);
    } catch {
      /* kept in memory only */
    }
  }

  /** Hold `who` here - already in the store - and tell the listeners when it changed. */
  private adopt(who: SignedIn | null) {
    const before = this.current;
    this.current = who;
    if (before?.platformToken !== who?.platformToken || (before === null) !== (who === null)) {
      this.listeners.forEach(l => l(who));
    }
  }

  /** The sign-in as stored now - another tab may have refreshed it, or signed out. */
  private async reread(): Promise<SignedIn | null> {
    try {
      const raw = await this.store.getItem(this.key);
      return raw ? (JSON.parse(raw) as SignedIn) : null;
    } catch {
      return this.current;
    }
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
  async signInUrl(options: SignInMethod | SignInOptions = {}): Promise<string> {
    const { method, signUp, returnTo } = typeof options === 'string' ? { method: options } as SignInOptions : options;
    const { signInIssuer, clientId } = this.config;
    if (!signInIssuer || !clientId) throw new Error('Sign-in is not set up: signInIssuer and clientId are required.');
    const verifier = randomString(48);
    const state = randomString(16);
    const back = returnTo ?? (typeof location !== 'undefined' ? location.pathname + location.hash : undefined);
    await this.store.setItem(`${this.key}.pending`, JSON.stringify({ verifier, state, returnTo: back } satisfies Pending));
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
    if (method && method !== 'email') params.set('kc_idp_hint', method);
    // The same page opened on "create an account": the hosted page's registration form, which hands
    // back exactly as signing in does.
    const endpoint = signUp && !method ? 'registrations' : 'auth';
    return `${signInIssuer}/protocol/openid-connect/${endpoint}?${params}`;
  }

  /** Send the person to the hosted sign-in page. */
  async signIn(options: SignInOptions = {}): Promise<void> {
    const url = await this.signInUrl(options);
    if (this.config.openUrl) await this.config.openUrl(url);
    else if (typeof location !== 'undefined') location.assign(url);
    else throw new Error('Pass openUrl to open the sign-in page outside a browser.');
  }

  /**
   * Finish a sign-in, if this address is the hosted page sending the person back - the page's own
   * address in a browser, the deep link on a phone. A no-op (null) otherwise; call it at start-up.
   */
  async completeSignIn(from?: string): Promise<CompletedSignIn | null> {
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
    let who: SignedIn;
    try {
      who = await this.swap(tokens);
    } catch (e) {
      // The hosted page signed them in, but the App would not have them (not invited, say). End that
      // sign-in there too: left open, the next sign-in - with another account - meets it and fails with
      // "already authenticated as a different user".
      this.endHostedSession(tokens.refresh_token);
      throw e;
    }
    this.epoch++;
    await this.save(who);
    return pending.returnTo ? { ...who, returnTo: pending.returnTo } : who;
  }

  /**
   * Sign out: forget the sign-in on this device and end it on the hosted page too, so the next "sign
   * in" asks again rather than letting the same person straight back in. Ending it there is best
   * effort - signing out here never waits on, or fails with, the network.
   */
  async signOut(): Promise<void> {
    await this.load();
    for (const hook of [...this.signingOut]) {
      try {
        await hook();
      } catch {
        /* never stops a sign-out */
      }
    }
    // The stored refresh token: another tab may have rotated the one held here, and the hosted page
    // only ends the sign-in for one that still works.
    const refreshToken = (await this.reread())?.refreshToken ?? this.current?.refreshToken;
    this.epoch++;
    await this.save(null);
    this.endHostedSession(refreshToken);
  }

  /** End the sign-in on the hosted page, best effort: never waits on, or fails with, the network. */
  private endHostedSession(refreshToken: string | undefined): void {
    const { signInIssuer, clientId } = this.config;
    if (refreshToken && signInIssuer && clientId) {
      void this.config.fetch(`${signInIssuer}/protocol/openid-connect/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, refresh_token: refreshToken }),
      }).catch(() => undefined);
    }
  }

  /**
   * A platform token good for at least another minute, refreshed when needed. When the refresh cannot
   * reach the sign-in service (offline, a timeout, the service busy or down) the sign-in is kept: the
   * token held is returned while it still works, and after that the error says why
   * (`AppError`, status 0 and code `NETWORK` when offline).
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
    if (lasts(who)) return who.platformToken;
    const out = await this.refreshOnce(false);
    if ('token' in out) return out.token;
    if ('signedOut' in out) throw new SignInRequired('Your sign-in has expired. Please sign in again.');
    // Not refreshed just now, but still signed in: the token held works until it expires.
    const held = this.current;
    if (held && held.platformTokenExpiresAt > Date.now()) return held.platformToken;
    throw out.unavailable;
  }

  /**
   * A fresh platform token now, whatever the current one's expiry - when something it carries has
   * changed, such as the person's plan and allowance after a checkout. False when nobody is signed in,
   * the App brings its own token, the sign-in service could not be reached (still signed in), or the
   * sign-in has lapsed (then the person must sign in again).
   */
  async renew(): Promise<boolean> {
    if (this.config.platformToken) return false;
    await this.load();
    if (!this.current) return false;
    return 'token' in (await this.refreshOnce(true));
  }

  /** Forget the sign-in after the platform refused it, so the App asks the person again. */
  async refused(): Promise<void> {
    if (!this.config.platformToken) {
      this.epoch++;
      await this.save(null);
    }
  }

  /**
   * One refresh at a time in this tab: concurrent calls share it. A forced one (renew) does not settle
   * for one that may only have re-read the store: it runs after it.
   */
  private refreshOnce(force: boolean): Promise<Refreshed> {
    if (this.refreshing && (this.refreshingForced || !force)) return this.refreshing;
    const prior = this.refreshing;
    const run: Promise<Refreshed> = (async () => {
      if (prior) await prior.catch(() => undefined);
      return this.coordinatedRefresh(force);
    })().finally(() => {
      if (this.refreshing === run) {
        this.refreshing = null;
        this.refreshingForced = false;
      }
    });
    this.refreshing = run;
    this.refreshingForced = force;
    return run;
  }

  /** One refresh at a time across tabs: under the lock, and only if no other tab just did it. */
  private async coordinatedRefresh(force: boolean): Promise<Refreshed> {
    const epoch = this.epoch;
    const seen = (await this.reread())?.platformToken;
    return this.lock(async () => {
      if (epoch !== this.epoch) return this.settled();
      // Another tab may have refreshed - or signed out - while this one waited for the lock.
      const stored = await this.reread();
      if (!stored) {
        this.adopt(null);
        return { signedOut: true };
      }
      const latest = newer(stored, this.current);
      if ((latest.platformToken !== seen || !force) && lasts(latest)) {
        this.adopt(latest);
        return { token: latest.platformToken };
      }
      return this.refreshWith(latest, epoch);
    });
  }

  /** What a refresh comes to when this tab signed in or out while it ran: whatever that left. */
  private settled(): Refreshed {
    return this.current ? { token: this.current.platformToken } : { signedOut: true };
  }

  /** Whether the sign-in ended while a refresh ran - here, or in another tab - so it must not be written back. */
  private async endedSince(epoch: number): Promise<boolean> {
    if (epoch !== this.epoch) return true;
    if (await this.reread()) return false;
    this.adopt(null);
    return true;
  }

  /**
   * Refresh with the refresh token, then swap the new sign-in token for a platform token. Signs out only
   * when the sign-in service says the refresh token is no good (400 invalid_grant) and the store holds
   * no newer one, or the platform refuses the person in this App (403 invalid_target from the swap) and
   * no other tab has a good token; network failures, timeouts, 429 and 5xx are retried with capped,
   * jittered backoff.
   */
  private async refreshWith(start: SignedIn, epoch: number): Promise<Refreshed> {
    let who = start;
    if (!who.refreshToken) {
      // Nothing to refresh with: the sign-in ends when its platform token does.
      if (who.platformTokenExpiresAt > Date.now()) {
        return { unavailable: new AppError(401, 'Your sign-in cannot be renewed here. Please sign in again.', 'NO_REFRESH_TOKEN') };
      }
      this.epoch++;
      await this.save(null);
      return { signedOut: true };
    }
    const { signInIssuer, clientId } = this.config;
    let realm: RealmTokens | null = null;
    for (let attempt = 1; ; attempt++) {
      const sent: string = who.refreshToken!;
      let failed: Failed;
      let phase: 'refresh' | 'swap' = 'refresh';
      const refreshed = realm
        ? null
        : await this.call(`${signInIssuer}/protocol/openid-connect/token`, { grant_type: 'refresh_token', refresh_token: sent, client_id: clientId! });
      if (refreshed && refreshed.ok) {
        realm = refreshed.body as unknown as RealmTokens;
        // Keep the refresh token we have when the answer carries none.
        const kept = realm.refresh_token || sent;
        if (kept !== sent) {
          // Rotated: the old one no longer works, so the new one is stored before anything else.
          if (await this.endedSince(epoch)) return this.settled();
          who = { ...who, refreshToken: kept };
          await this.persist(who);
          if (this.current) this.current = { ...this.current, refreshToken: kept };
        }
      }
      if (realm) {
        phase = 'swap';
        const swapped = await this.call(`${this.config.apiUrl}/api/v1/workflow/connection/oauth/token`, swapForm(realm));
        if (swapped.ok && typeof swapped.body.access_token === 'string') {
          if (await this.endedSince(epoch)) return this.settled();
          const fresh = signedInFrom(realm, swapped.body as unknown as SwapAnswer, who.refreshToken);
          // Stored before the caller sees the token.
          await this.save(fresh);
          return { token: fresh.platformToken };
        }
        failed = swapped.ok ? { ok: false, status: 502 } : swapped;
      } else {
        failed = refreshed as Failed;
      }

      if (failed.status === 400 && failed.error === 'invalid_grant') {
        if (phase === 'refresh') {
          // Dead - unless another tab rotated it after this one read the store: then use theirs.
          const latest = await this.reread();
          if (latest?.refreshToken && latest.refreshToken !== sent) {
            if (lasts(latest)) {
              this.adopt(latest);
              return { token: latest.platformToken };
            }
            if (attempt < this.retry.attempts) {
              who = latest;
              continue;
            }
          }
        }
        if (epoch === this.epoch) {
          this.epoch++;
          await this.save(null);
        }
        return { signedOut: true };
      }
      if (phase === 'swap' && failed.status === 403 && failed.error === 'invalid_target') {
        // The platform no longer lets this person into the App: a sign-in that can never work. Unless
        // another tab has just got a good token, end it.
        const latest = await this.reread();
        if (latest && latest.platformToken !== who.platformToken && lasts(latest)) {
          this.adopt(latest);
          return { token: latest.platformToken };
        }
        if (epoch === this.epoch) {
          this.epoch++;
          await this.save(null);
        }
        return { signedOut: true };
      }
      const error = asError(failed, phase);
      if (!transient(failed.status) || attempt >= this.retry.attempts) return { unavailable: error };
      const wait = failed.retryAfterMs ?? backoff(attempt, this.retry);
      if (wait > this.retry.maxRetryAfterMs) return { unavailable: error };
      await sleep(wait);
      if (epoch !== this.epoch) return this.settled();
    }
  }

  /** POST a form; never throws - a network failure is status 0. */
  private async call(url: string, form: Record<string, string>): Promise<Answer> {
    let res: Response;
    try {
      res = await this.config.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form),
      });
    } catch {
      return { ok: false, status: 0 };
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return { ok: true, body: body && typeof body === 'object' ? body : {} };
    return {
      ok: false,
      status: res.status,
      error: typeof body?.error === 'string' ? body.error : undefined,
      description: typeof body?.error_description === 'string' ? body.error_description : undefined,
      retryAfterMs: retryAfterMs(res.headers?.get?.('Retry-After') ?? null),
    };
  }

  private async realmToken(form: Record<string, string>): Promise<RealmTokens> {
    const answer = await this.call(`${this.config.signInIssuer}/protocol/openid-connect/token`, form);
    if (!answer.ok) throw new AppError(answer.status, 'Sign-in did not complete. Please try again.', answer.error ?? (answer.status === 0 ? 'NETWORK' : undefined));
    return answer.body as unknown as RealmTokens;
  }

  /** The sign-in token for a platform token: the one swap, after which the platform knows this person. */
  private async swap(tokens: RealmTokens): Promise<SignedIn> {
    const answer = await this.call(`${this.config.apiUrl}/api/v1/workflow/connection/oauth/token`, swapForm(tokens));
    if (!answer.ok || typeof answer.body.access_token !== 'string') {
      const failed = answer.ok ? undefined : answer;
      throw new AppError(failed?.status ?? 502, failed?.description ?? 'You could not be signed in just now. Please try again.', failed?.error);
    }
    return signedInFrom(tokens, answer.body as unknown as SwapAnswer, tokens.refresh_token);
  }
}

interface SwapAnswer {
  access_token: string;
  expires_in?: number;
}

type Answer = { ok: true; body: Record<string, unknown> } | Failed;

interface Failed {
  ok: false;
  /** 0 when there was no answer. */
  status: number;
  error?: string;
  description?: string;
  retryAfterMs?: number;
}

function swapForm(tokens: RealmTokens): Record<string, string> {
  return { grant_type: TOKEN_EXCHANGE, subject_token: tokens.access_token, subject_token_type: ACCESS_TOKEN_TYPE };
}

function signedInFrom(tokens: RealmTokens, body: SwapAnswer, refreshToken: string | undefined): SignedIn {
  const profile = claims(tokens.id_token ?? tokens.access_token);
  return {
    name: (profile.name as string | undefined) ?? (profile.given_name as string | undefined),
    email: profile.email as string | undefined,
    platformToken: body.access_token,
    platformTokenExpiresAt: Date.now() + (body.expires_in ?? 900) * 1000,
    refreshToken,
  };
}

/** Whether a platform token is good for at least another minute. */
function lasts(who: SignedIn): boolean {
  return who.platformTokenExpiresAt - Date.now() > REFRESH_MARGIN_MS;
}

/** The later of the stored sign-in and the one held here (the store wins a tie: another tab wrote it). */
function newer(stored: SignedIn, held: SignedIn | null): SignedIn {
  return held && held.platformTokenExpiresAt > stored.platformTokenExpiresAt ? held : stored;
}

/** Worth trying again: no answer, a timeout, too many requests, or the service failing. */
function transient(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

function backoff(attempt: number, retry: Required<RefreshRetry>): number {
  const ceiling = Math.min(retry.capMs, retry.baseMs * 2 ** (attempt - 1));
  return ceiling / 2 + Math.random() * (ceiling / 2);
}

/** Retry-After as milliseconds: seconds, or an HTTP date. */
function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const value = header.trim();
  if (/^\d+(\.\d+)?$/.test(value)) return Math.round(Number(value) * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

function asError(failed: Failed, phase: 'refresh' | 'swap'): AppError {
  if (failed.status === 0) return new AppError(0, 'Could not reach the service. Check the connection and try again.', 'NETWORK');
  const message =
    failed.description ??
    (transient(failed.status) ? 'Your sign-in could not be renewed just now. Please try again shortly.' : phase === 'swap' ? 'You could not be signed in just now. Please try again.' : 'Sign-in did not complete. Please try again.');
  return new AppError(failed.status, message, failed.error);
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
