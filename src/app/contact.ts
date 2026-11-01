import { AppError } from './errors';
import type { Http } from './http';

/**
 * The App's public contact form: a visitor who has not signed in writes to the App's publisher, and the message
 * becomes a support ticket in the publisher's inbox (`POST /api/v1/public/apps/{appId}/contact`).
 *
 * Every message must carry a Cloudflare Turnstile token, checked by the platform (it fails closed). Where the check
 * runs depends on the page's address, and {@link ContactForm.mount} picks it for you:
 *
 * - On `<slug>.workstudio.run` the platform's "App contact forms" widget is rendered on the page itself
 *   (`mode: 'widget'`). The platform checks that the token was solved on the host the message comes from.
 * - On the App's own domain (`app.acme.com`) the widget cannot list every customer's hostname, so the check runs in
 *   the platform's challenge frame, `https://challenge.workstudio.run/turnstile`, embedded in the page
 *   (`mode: 'frame'`). The frame hands the token back by `postMessage`; the platform accepts it only for this App
 *   (`cdata`), this form (`action`) and a message from one of the App's own https sites.
 */

/** The platform's challenge frame. A message from any other origin is never read. */
export const CHALLENGE_ORIGIN = 'https://challenge.workstudio.run';
/** The platform's own App hosts: `<slug>.workstudio.run` renders the widget on the page. */
export const PLATFORM_APP_DOMAIN = 'workstudio.run';
/** The "App contact forms" Turnstile widget's site key. Public by nature: it is in every page that renders it. */
export const APP_CONTACT_SITE_KEY = '0x4AAAAAAFoNYlE1616eu6Bx';
/** Cloudflare's Turnstile script, rendered explicitly (widget mode). */
export const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/** The contact form's widget action; the platform refuses a token solved for another. */
const ACTION = 'app-contact';
/** The frame's message type (contract v1, infrastructure `cloudflare/workstudio-run/src/challenge.ts`). */
const MESSAGE_TYPE = 'workstudio:turnstile';
const EVENTS: ReadonlySet<string> = new Set(['ready', 'token', 'expired', 'timeout', 'error']);
const THEMES: ReadonlySet<string> = new Set(['auto', 'light', 'dark']);
const SIZES: ReadonlySet<string> = new Set(['normal', 'flexible', 'compact']);
const SITE_KEY = /^[A-Za-z0-9_-]{1,100}$/;
/** The frame's (and widget's) own box, per size. */
const FRAME_BOX: Record<ContactCheckSize, { width: string; height: string }> = {
  normal: { width: '300px', height: '65px' },
  flexible: { width: '100%', height: '65px' },
  compact: { width: '150px', height: '140px' },
};

/** What the form is about. `question` when not said. */
export type ContactCategory = 'bug' | 'feature' | 'question' | 'feedback' | 'billing' | 'security' | 'other';

/** A message from the contact form. Capped as the platform caps it. */
export interface ContactMessage {
  /** Where the reply goes. Required, at most 254 characters. */
  email: string;
  /** At most 120 characters. */
  name?: string;
  category?: ContactCategory;
  /** Required, at most 200 characters. */
  subject: string;
  /** Required, at most 5000 characters. */
  message: string;
  /**
   * Where the visitor was. Defaults to this page's origin and path (never its query or hash) and the browser's user
   * agent; `null` sends none.
   */
  context?: { page?: string; userAgent?: string } | null;
}

/** The ticket the message became. Replies go to the email given. */
export interface ContactReceipt {
  id: string;
  /** e.g. `TKT-261029-1001`: fit to show the visitor. */
  ticketNumber: string;
  message?: string;
}

/** `frame`: the platform's challenge frame (the App's own domain). `widget`: the widget on the page (workstudio.run). */
export type ContactCheckMode = 'frame' | 'widget';
export type ContactCheckTheme = 'auto' | 'light' | 'dark';
export type ContactCheckSize = 'normal' | 'flexible' | 'compact';

export interface ContactCheckOptions {
  /** Defaults to `auto`: `widget` on `*.workstudio.run`, `frame` anywhere else. */
  mode?: 'auto' | ContactCheckMode;
  theme?: ContactCheckTheme;
  size?: ContactCheckSize;
  /**
   * Widget mode only: another site key - Cloudflare's test key `1x00000000000000000000AA` for local development, say
   * (the platform then needs its test secret too). Defaults to {@link APP_CONTACT_SITE_KEY}. The frame always uses
   * the platform's.
   */
  siteKey?: string;
  /** How long the check may take to appear before `ready` fails with `CHECK_UNAVAILABLE`. Default 20 s. */
  readyTimeoutMs?: number;
  /** A token is ready: the form can be sent. */
  onToken?: (token: string) => void;
  /** The token lapsed (about 5 minutes) or the challenge timed out: the check runs again. */
  onExpired?: () => void;
  /** The check could not run: an `AppError` with code `CHECK_ERROR` (Turnstile's own in `details.turnstileCode`). */
  onError?: (error: AppError) => void;
}

export interface ContactSendOptions {
  /** How long to wait for the check when no token is ready yet. Default 60 s; past it, `CHECK_TIMEOUT`. */
  waitMs?: number;
}

const LIMITS: Record<'email' | 'name' | 'subject' | 'message', number> = { email: 254, name: 120, subject: 200, message: 5000 };

/** Minimal Turnstile API used in widget mode. */
interface TurnstileApi {
  render(el: HTMLElement, options: Record<string, unknown>): string | null | undefined;
  reset(id?: string): void;
  remove(id?: string): void;
}

/**
 * `app.contactForm`: the App's public contact form, for visitors who have not signed in. Needs `appId` in the config.
 *
 * ```ts
 * const check = app.contactForm.mount(document.querySelector('#check')!);
 * form.onsubmit = async (e) => {
 *   e.preventDefault();
 *   const receipt = await check.send({ email, subject, message });
 *   show(`Thanks - your reference is ${receipt.ticketNumber}`);
 * };
 * // when the form goes away
 * check.unmount();
 * ```
 */
export class ContactForm {
  constructor(private readonly http: Http) {}

  /** Which check {@link mount} uses on `host` (default: this page's): `widget` on `*.workstudio.run`, else `frame`. */
  modeFor(host?: string): ContactCheckMode {
    const h = (host ?? (typeof location !== 'undefined' ? location.hostname : '')).toLowerCase().replace(/\.$/, '');
    return h === PLATFORM_APP_DOMAIN || h.endsWith(`.${PLATFORM_APP_DOMAIN}`) ? 'widget' : 'frame';
  }

  /**
   * Render the Turnstile check into `container` and keep its token. Throws `AppError` at once for what cannot work:
   * `NO_APP_ID`, `CHECK_NEEDS_BROWSER` (no page), `CHECK_NEEDS_HTTPS` (frame mode off https), `BAD_OPTION`. What goes
   * wrong later arrives through `ready`, `onError` and `send`.
   */
  mount(container: HTMLElement, options: ContactCheckOptions = {}): ContactCheck {
    const appId = this.appId();
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      throw new AppError(0, 'The contact form check runs in a browser page.', 'CHECK_NEEDS_BROWSER');
    }
    if (!container || typeof (container as Partial<HTMLElement>).appendChild !== 'function') {
      throw new AppError(0, 'mount needs the element to render the check into.', 'BAD_OPTION');
    }
    const mode = !options.mode || options.mode === 'auto' ? this.modeFor() : options.mode;
    if (mode !== 'frame' && mode !== 'widget') throw new AppError(0, `Unknown check mode "${String(options.mode)}".`, 'BAD_OPTION');
    const theme = options.theme ?? 'auto';
    const size = options.size ?? 'normal';
    if (!THEMES.has(theme)) throw new AppError(0, `Unknown theme "${String(theme)}": auto, light or dark.`, 'BAD_OPTION');
    if (!SIZES.has(size)) throw new AppError(0, `Unknown size "${String(size)}": normal, flexible or compact.`, 'BAD_OPTION');
    const siteKey = options.siteKey ?? APP_CONTACT_SITE_KEY;
    if (!SITE_KEY.test(siteKey)) throw new AppError(0, 'That is not a Turnstile site key.', 'BAD_OPTION');
    let origin = '';
    if (mode === 'frame') {
      origin = typeof location !== 'undefined' ? location.origin : '';
      if (!/^https:\/\/[^/]+$/.test(origin)) {
        throw new AppError(0, 'The contact form check on an App\'s own domain needs the page on https.', 'CHECK_NEEDS_HTTPS');
      }
    }
    return new ContactCheck(this, container, { ...options, mode, theme, size, siteKey }, appId, origin);
  }

  /**
   * Send a message with a Turnstile token you got yourself (your own widget, rendered with action `app-contact`).
   * With {@link mount}, use {@link ContactCheck.send} instead: it waits for the token and runs the check again after.
   *
   * Refusals are `AppError`s with the platform's codes: 400 `CAPTCHA_FAILED` (no token, or a spent, expired or
   * foreign one), 400 `INVALID_EMAIL`, 403 `FORBIDDEN_ORIGIN` (not sent from one of the App's sites), 404 `NOT_FOUND`
   * (the App is not released or not open to people), 413 `TOO_LARGE`, 429 `RATE_LIMITED`, 503 `CAPTCHA_UNAVAILABLE`
   * or `RATE_LIMIT_UNAVAILABLE` (try again later). A message that breaks the caps never leaves: `INVALID_MESSAGE`.
   */
  async send(message: ContactMessage, turnstileToken: string): Promise<ContactReceipt> {
    const appId = this.appId();
    const body = contactBody(message);
    if (typeof turnstileToken !== 'string' || !turnstileToken || turnstileToken.length > 2048) {
      throw new AppError(0, 'Please complete the check, then send again.', 'CHECK_NOT_DONE');
    }
    return this.http.anonymous<ContactReceipt>(
      `${this.http.config.apiUrl}/api/v1/public/apps/${encodeURIComponent(appId)}/contact`, 'POST',
      { ...body, turnstileToken });
  }

  private appId(): string {
    const appId = this.http.config.appId;
    if (!appId) throw new AppError(0, 'The contact form needs the App id (appId) in the config.', 'NO_APP_ID');
    return appId;
  }
}

interface Waiter {
  resolve: (token: string) => void;
  reject: (e: AppError) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

type Mounted = Required<Pick<ContactCheckOptions, 'theme' | 'size' | 'siteKey'>> & ContactCheckOptions & { mode: ContactCheckMode };

/**
 * One mounted check: its current token, a wait for the next one, a reset and an unmount. Tokens are single-use:
 * {@link send} takes the current one and the check runs again for the next message.
 */
export class ContactCheck {
  readonly mode: ContactCheckMode;
  /** Settles once the check is on the page; fails with `CHECK_UNAVAILABLE` if it does not appear in time. */
  readonly ready: Promise<void>;

  private current: string | null = null;
  private waiters: Waiter[] = [];
  private done = false;
  private isReady = false;
  private readyResolve!: () => void;
  private readyReject!: (e: AppError) => void;
  private readyTimer: ReturnType<typeof setTimeout> | undefined;
  private lastError: AppError | null = null;
  private teardown: () => void = () => {};
  private resetter: () => void = () => {};
  /** The nonce this mount sent the frame; every message must echo it. */
  private readonly nonce: string;

  constructor(
    private readonly form: ContactForm,
    container: HTMLElement,
    private readonly options: Mounted,
    private readonly appId: string,
    origin: string,
  ) {
    this.mode = options.mode;
    this.nonce = nonce();
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // A page that never awaits `ready` must not see an unhandled rejection.
    this.ready.catch(() => {});
    const wait = options.readyTimeoutMs ?? 20_000;
    this.readyTimer = setTimeout(() => this.unavailable(
      this.mode === 'frame'
        ? 'The check did not load. On the App\'s own domain it needs the domain live for this App on work.studio.'
        : 'The check did not load. The page\'s Content-Security-Policy must allow https://challenges.cloudflare.com.'), wait);
    if (this.mode === 'frame') this.mountFrame(container, origin);
    else this.mountWidget(container);
  }

  /** The token ready to send now, or null. */
  get token(): string | null {
    return this.current;
  }

  /** False once unmounted. */
  get mounted(): boolean {
    return !this.done;
  }

  /** The current token, or the next one. `CHECK_TIMEOUT` past `timeoutMs` (default 60 s), `CHECK_UNMOUNTED` after unmount. */
  waitForToken(timeoutMs = 60_000): Promise<string> {
    if (this.done) return Promise.reject(unmounted());
    if (this.current) return Promise.resolve(this.current);
    // The check never appeared: waiting longer will not bring a token.
    if (this.lastError?.code === 'CHECK_UNAVAILABLE') return Promise.reject(this.lastError);
    return new Promise<string>((resolve, reject) => {
      const w: Waiter = { resolve, reject, timer: undefined };
      w.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(this.lastError ?? new AppError(0, 'Please complete the check, then send again.', 'CHECK_TIMEOUT'));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  /**
   * Send the message with this check's token (waiting for it if need be), then run the check again: a token is good
   * for one message. Refusals as {@link ContactForm.send}.
   */
  async send(message: ContactMessage, options: ContactSendOptions = {}): Promise<ContactReceipt> {
    contactBody(message);
    const token = await this.waitForToken(options.waitMs ?? 60_000);
    // Spent by this send whatever the answer: never offered again.
    if (this.current === token) this.current = null;
    try {
      return await this.form.send(message, token);
    } finally {
      if (!this.done) this.reset();
    }
  }

  /** Run the check again (the current token is dropped). */
  reset(): void {
    if (this.done) return;
    this.current = null;
    this.lastError = null;
    this.resetter();
  }

  /** Take the check off the page: the frame or widget is removed, its listener too, and pending waits fail `CHECK_UNMOUNTED`. */
  unmount(): void {
    if (this.done) return;
    this.done = true;
    this.current = null;
    clearTimeout(this.readyTimer);
    const e = unmounted();
    if (!this.isReady) this.readyReject(e);
    this.rejectWaiters(e);
    try {
      this.teardown();
    } catch {
      // Already gone from the page.
    }
  }

  // --- what the frame or widget reports ----------------------------------------------------------------------

  private onReady(): void {
    if (this.done || this.isReady) return;
    this.isReady = true;
    clearTimeout(this.readyTimer);
    this.readyResolve();
  }

  private onToken(token: string): void {
    if (this.done) return;
    this.onReady();
    this.current = token;
    this.lastError = null;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.resolve(token);
    }
    safely(() => this.options.onToken?.(token));
  }

  private onExpired(timedOut: boolean): void {
    if (this.done) return;
    this.current = null;
    // A timed-out interactive challenge stays stuck until reset; a lapsed token refreshes by itself.
    if (timedOut) this.resetter();
    safely(() => this.options.onExpired?.());
  }

  private onError(code: string | undefined): void {
    if (this.done) return;
    this.current = null;
    const domain = code !== undefined && /^1102\d\d$/.test(code);
    const e = new AppError(0, domain
      ? 'The check is not set up for this site. Ask the App\'s publisher to check its address on work.studio.'
      : 'The check could not run. Please reload the page and try again.', 'CHECK_ERROR',
      code === undefined ? undefined : { turnstileCode: code });
    this.lastError = e;
    this.rejectWaiters(e);
    safely(() => this.options.onError?.(e));
  }

  private unavailable(message: string): void {
    if (this.done || this.isReady) return;
    const e = new AppError(0, message, 'CHECK_UNAVAILABLE');
    this.lastError = e;
    this.readyReject(e);
    this.rejectWaiters(e);
    safely(() => this.options.onError?.(e));
  }

  private rejectWaiters(e: AppError): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.reject(e);
    }
  }

  // --- frame mode ---------------------------------------------------------------------------------------------

  private mountFrame(container: HTMLElement, origin: string): void {
    const { theme, size } = this.options;
    const q = new URLSearchParams({ app: this.appId, origin, action: ACTION, theme, size, nonce: this.nonce });
    const iframe = document.createElement('iframe');
    iframe.src = `${CHALLENGE_ORIGIN}/turnstile?${q.toString()}`;
    iframe.title = 'Verification';
    const box = FRAME_BOX[size];
    iframe.setAttribute('style', `border:0;width:${box.width};height:${box.height};overflow:hidden;display:block;color-scheme:normal`);
    iframe.setAttribute('scrolling', 'no');

    const listener = (event: MessageEvent) => {
      const m = this.frameMessage(event, iframe);
      if (!m) return;
      if (m.event === 'ready') this.onReady();
      else if (m.event === 'token') this.onToken(m.token as string);
      else if (m.event === 'expired') this.onExpired(false);
      else if (m.event === 'timeout') this.onExpired(true);
      else if (m.event === 'error') this.onError(typeof m.code === 'string' ? m.code.slice(0, 32) : undefined);
    };
    window.addEventListener('message', listener);
    this.resetter = () => {
      iframe.contentWindow?.postMessage({ type: MESSAGE_TYPE, v: 1, event: 'reset', nonce: this.nonce }, CHALLENGE_ORIGIN);
    };
    this.teardown = () => {
      window.removeEventListener('message', listener);
      iframe.remove();
    };
    container.appendChild(iframe);
  }

  /**
   * A message from this mount's frame, or null. All of it must hold: the challenge origin exactly, sent by this
   * iframe's window, the v1 shape, this App and form, and this mount's nonce. Anything else is ignored.
   */
  private frameMessage(event: MessageEvent, iframe: HTMLIFrameElement): Record<string, unknown> | null {
    if (this.done || event.origin !== CHALLENGE_ORIGIN) return null;
    if (!iframe.contentWindow || event.source !== iframe.contentWindow) return null;
    const m = event.data as unknown;
    if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
    const d = m as Record<string, unknown>;
    if (d.type !== MESSAGE_TYPE || d.v !== 1 || typeof d.event !== 'string' || !EVENTS.has(d.event)) return null;
    if (d.appId !== this.appId || d.action !== ACTION || d.nonce !== this.nonce) return null;
    if (d.event === 'token' && (typeof d.token !== 'string' || d.token.length === 0 || d.token.length > 2048)) return null;
    return d;
  }

  // --- widget mode --------------------------------------------------------------------------------------------

  private mountWidget(container: HTMLElement): void {
    const holder = document.createElement('div');
    container.appendChild(holder);
    let id: string | null | undefined = null;
    let api: TurnstileApi | null = null;
    this.teardown = () => {
      if (api && id) {
        try {
          api.remove(id);
        } catch {
          // Already removed.
        }
      }
      holder.remove();
    };
    this.resetter = () => {
      if (api && id) api.reset(id);
    };
    loadTurnstile().then((t) => {
      if (this.done) return;
      api = t;
      id = t.render(holder, {
        sitekey: this.options.siteKey,
        action: ACTION,
        cdata: this.appId,
        theme: this.options.theme,
        size: this.options.size,
        callback: (token: string) => this.onToken(token),
        'expired-callback': () => this.onExpired(false),
        'timeout-callback': () => this.onExpired(true),
        'error-callback': (code: unknown) => {
          this.onError(code === undefined || code === null ? undefined : String(code).slice(0, 32));
          return true;
        },
      });
      this.onReady();
    }, () => this.unavailable(
      'The check could not load. The page\'s Content-Security-Policy must allow https://challenges.cloudflare.com.'));
  }
}

let loading: Promise<TurnstileApi> | null = null;

/** Cloudflare's script, once per page. */
function loadTurnstile(): Promise<TurnstileApi> {
  const existing = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
  if (existing) return Promise.resolve(existing);
  if (loading) return loading;
  loading = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT;
    script.async = true;
    script.onload = () => {
      const t = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
      if (t) resolve(t);
      else reject(new Error('turnstile missing'));
    };
    script.onerror = () => reject(new Error('turnstile did not load'));
    document.head.appendChild(script);
  });
  // A failed load may be tried again by the next mount.
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

/** The request body, checked against the platform's caps first. */
function contactBody(message: ContactMessage): Record<string, unknown> {
  if (!message || typeof message !== 'object') throw invalid('message', 'Please write a message.');
  for (const field of ['email', 'subject', 'message'] as const) {
    if (typeof message[field] !== 'string' || !message[field].trim()) {
      throw invalid(field, field === 'email' ? 'Please give an email address for the reply.' : `Please fill in the ${field}.`);
    }
  }
  for (const field of ['email', 'name', 'subject', 'message'] as const) {
    const v = message[field];
    if (v !== undefined && (typeof v !== 'string' || v.length > LIMITS[field])) {
      throw invalid(field, `The ${field} must be ${LIMITS[field]} characters or less.`);
    }
  }
  const body: Record<string, unknown> = { email: message.email.trim(), subject: message.subject, message: message.message };
  if (message.name !== undefined) body.name = message.name;
  if (message.category !== undefined) body.category = message.category;
  const context = message.context === undefined ? pageContext() : message.context;
  if (context) {
    const c: Record<string, string> = {};
    if (typeof context.page === 'string') c.page = context.page.slice(0, 500);
    if (typeof context.userAgent === 'string') c.userAgent = context.userAgent.slice(0, 500);
    body.context = c;
  }
  return body;
}

/** This page's origin and path (never its query or hash, which may hold tokens) and the browser's user agent. */
function pageContext(): { page?: string; userAgent?: string } | null {
  const c: { page?: string; userAgent?: string } = {};
  if (typeof location !== 'undefined' && location.origin) c.page = `${location.origin}${location.pathname ?? ''}`;
  if (typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string') c.userAgent = navigator.userAgent;
  return c.page || c.userAgent ? c : null;
}

function invalid(field: string, message: string): AppError {
  return new AppError(0, message, 'INVALID_MESSAGE', { field });
}

function unmounted(): AppError {
  return new AppError(0, 'The contact form check was taken off the page.', 'CHECK_UNMOUNTED');
}

function safely(f: () => void): void {
  try {
    f();
  } catch {
    // A callback's own failure is its own.
  }
}

/** 16 random bytes, base64url: unguessable by any other frame on the page. */
function nonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
