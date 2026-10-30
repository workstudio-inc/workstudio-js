import type { KeyValueStore } from './config';
import type { Http } from './http';

/** Which phone OS a token came from. */
export type PushPlatform = 'ios' | 'android';

/** Who carries the push: Apple's service for iPhone tokens, Firebase for Android ones. */
export type PushTransport = 'APNS' | 'FCM';

/** One phone (or tablet) of this person's that the App can reach by push. */
export interface PushDevice {
  id: string;
  platform: PushPlatform;
  transport: PushTransport;
  /** For an iPhone token: `sandbox` (a development build) or `production`; null to use the App's setting. */
  apnsEnvironment: string | null;
  deviceName: string | null;
  appVersion: string | null;
  /** Whether this device gets pushes (the person can turn one device off). */
  enabled: boolean;
  /** The token's last six characters, to tell devices apart - never the token. */
  tokenEnd: string;
  /** Who this device is registered to, as every push to it says (`data.scopeHash`). */
  scopeHash: string;
  createdAt: string;
  lastSeenAt: string | null;
  lastPushAt: string | null;
}

export interface RegisterOptions {
  /** Defaults to APNS on iPhone and FCM on Android - what `@capacitor/push-notifications` hands out. */
  transport?: PushTransport;
  /** For an iPhone token: `sandbox` for a development build (Xcode), `production` for TestFlight and the store. */
  apnsEnvironment?: 'sandbox' | 'production';
  /** Shown to the person in a list of their devices, e.g. "Jane's iPhone". */
  deviceName?: string;
  appVersion?: string;
}

/** What the person wants pushed to them by this App. The phone's own permission comes first. */
export interface PushPreferences {
  /** Off: no pushes from this App at all (its emails still come, where the App sends them). */
  enabled: boolean;
  /** By kind, as the App's automations name them (`requests`, `proposals`, `account`); absent means on. */
  categories: Record<string, boolean>;
  /** Quiet hours, `HH:mm` in `timezone`: nothing is pushed between them (an email may still come). */
  quietStart: string | null;
  quietEnd: string | null;
  /** IANA time zone, e.g. `America/New_York`. */
  timezone: string | null;
  scopeHash: string;
}

/** A change to {@link PushPreferences}: what is left out stays as it is. */
export interface PushPreferencesChange {
  enabled?: boolean;
  /** `null` for a kind removes the person's choice for it (it is then on). */
  categories?: Record<string, boolean | null>;
  /** Both together, `HH:mm`; both `null` for no quiet hours. */
  quietStart?: string | null;
  quietEnd?: string | null;
  /** `null` for none. */
  timezone?: string | null;
}

/**
 * The body the platform reads (`PreferencesInput`, notification AppPushDevices): an absent or `null` field there means
 * "unchanged" and `""` means "clear", so a `null` the App passes to clear is sent as `""`.
 */
function preferencesBody(changes: PushPreferencesChange): Record<string, unknown> {
  const body: Record<string, unknown> = { ...changes };
  for (const k of ['quietStart', 'quietEnd', 'timezone'] as const) if (k in changes && changes[k] === null) body[k] = '';
  return body;
}

/** What a push from the App carries besides its title and body (`notification.data`). */
export interface PushData {
  kind?: string;
  appId?: string;
  /** Who it is for: a push whose scopeHash is not the signed-in person's is not theirs - drop it. */
  scopeHash?: string;
  /** Where in the App to go on a tap: `#inbox/<id>`, an App-relative route. */
  open?: string;
  event?: string;
  automation?: string;
  [key: string]: unknown;
}

interface Remembered {
  token?: string;
  scopeHash?: string;
}

/** How long sign-out waits for the device to be forgotten before going on regardless. */
const SIGN_OUT_WAIT_MS = 3_000;

/** A route in the App: # or / and then a route character - never another site (`//host`, `https:`) or a backslash. */
const ROUTE = /^[#/][A-Za-z0-9_-]/;

/**
 * Where a push wants a tap to go, when that is a route in the App - `data.open` such as `#inbox/123` - or null.
 * Anything else (`//evil.example`, `https://...`, `javascript:`, a backslash, spaces, over 200 characters) is null,
 * so the App never navigates off-site because of a push. Check {@link Push.isForMe} first.
 */
export function routeOf(data: PushData | Record<string, unknown> | null | undefined): string | null {
  const open = data && typeof data === 'object' ? data.open : undefined;
  if (typeof open !== 'string' || open.length > 200 || !ROUTE.test(open)) return null;
  if (/[\s\\]/.test(open) || /[\u0000-\u001f\u007f]/.test(open)) return null;
  return open;
}

/**
 * Push notifications to the person's phone, from the App's own automations ("a new quote request").
 *
 * The App gets the device token from the phone (for example `@capacitor/push-notifications`) and hands it
 * here after sign-in, on every launch; the platform keeps it for this person in this App only, and sends with
 * the App's own Apple and Firebase credentials. Signing out forgets it. Nothing here asks the phone for
 * permission - that is the App's to do, at a moment the person understands why.
 *
 * A shared phone: the phone shows a push itself, before the App runs - `scopeHash` only decides what the App does
 * when it is tapped. So on sign-out the App should also call its push plugin's own unregister
 * (`PushNotifications.unregister()` in Capacitor) and clear delivered notifications
 * (`PushNotifications.removeAllDeliveredNotifications()`), and check {@link Push.isForMe} - then {@link routeOf} -
 * before acting on a tap. When forgetting the device fails at sign-out (offline), the next {@link Push.register}
 * tries again for that old token first.
 */
export class Push {
  private readonly key: string;
  private readonly pendingKey: string;

  constructor(private readonly http: Http, private readonly store: KeyValueStore, storageKey: string, private readonly appId?: string) {
    this.key = `${storageKey}.push`;
    this.pendingKey = `${storageKey}.push.pending`;
  }

  /** This person's preferences for pushes from this App. */
  readonly preferences = {
    get: (): Promise<PushPreferences> => this.http.request<PushPreferences>('GET', this.url('/preferences')).then(p => this.noted(p)),
    /**
     * Change some of them; the rest stay. Answers all of them. `null` clears quiet hours (send `quietStart` and
     * `quietEnd` together) or the time zone; a category set to `null` goes back to its default (on).
     */
    set: (changes: PushPreferencesChange): Promise<PushPreferences> =>
      this.http.request<PushPreferences>('PUT', this.url('/preferences'), preferencesBody(changes)).then(p => this.noted(p)),
  };

  /**
   * Register this device's token for the signed-in person. Call it after sign-in and on every launch -
   * tokens change without notice, and registering the same one again only marks it seen.
   */
  async register(token: string, platform: PushPlatform, options: RegisterOptions = {}): Promise<PushDevice> {
    if (!token || typeof token !== 'string') throw new Error('push.register needs the device token.');
    const os = String(platform ?? '').toLowerCase();
    if (os !== 'ios' && os !== 'android') throw new Error(`push.register: platform is ios or android, not ${platform}.`);
    const body: Record<string, string> = {
      token,
      platform: os,
      transport: options.transport ?? (os === 'ios' ? 'APNS' : 'FCM'),
    };
    if (options.apnsEnvironment) body.apnsEnvironment = options.apnsEnvironment;
    if (options.deviceName) body.deviceName = options.deviceName;
    if (options.appVersion) body.appVersion = options.appVersion;
    await this.retryPending(token);
    const device = await this.http.request<PushDevice>('POST', this.url('/devices'), body);
    await this.remember({ token, scopeHash: device?.scopeHash });
    return device;
  }

  /**
   * Stop pushes to this device: the token given, or the one last registered here. Resolves when there is
   * nothing to forget. Sign-out does this itself.
   */
  async unregister(token?: string): Promise<void> {
    const remembered = await this.remembered();
    const which = token ?? remembered.token;
    if (!which) return;
    // In the body, never the address: a token in a URL ends up in access logs.
    await this.http.request<void>('POST', this.url('/devices/unregister'), { token: which });
    if (!token || token === remembered.token) await this.forget();
  }

  /** The person's devices registered for pushes from this App. */
  devices(): Promise<PushDevice[]> {
    return this.http.request<PushDevice[]>('GET', this.url('/devices'));
  }

  /** Turn pushes to one device on or off, keeping it registered. */
  setEnabled(id: string, enabled: boolean): Promise<PushDevice> {
    return this.http.request<PushDevice>('POST', this.url(`/devices/${encodeURIComponent(id)}/enabled`), { enabled: Boolean(enabled) });
  }

  /**
   * Whether a push that arrived is for the person signed in here (and for this App, when `appId` was
   * configured). A shared phone can hold a push meant for someone who has since signed out: act only on
   * those this says yes to. False when nothing was registered here yet.
   */
  async isForMe(data: PushData | Record<string, unknown> | null | undefined): Promise<boolean> {
    if (!data || typeof data !== 'object') return false;
    const { scopeHash } = await this.remembered();
    if (!scopeHash || data.scopeHash !== scopeHash) return false;
    if (this.appId && data.appId !== undefined && data.appId !== this.appId) return false;
    return true;
  }

  /** Where a push wants a tap to go, when that is a route in the App; null otherwise. See {@link routeOf}. */
  routeOf(data: PushData | Record<string, unknown> | null | undefined): string | null {
    return routeOf(data);
  }

  /**
   * Forget this device before signing out: best effort, and never longer than a few seconds. When that does not
   * finish, the token is kept aside and the next {@link register} tries again.
   */
  async beforeSignOut(): Promise<void> {
    const { token } = await this.remembered();
    if (!token) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let forgotten = false;
    const waited = new Promise<void>(done => (timer = setTimeout(done, SIGN_OUT_WAIT_MS)));
    try {
      await Promise.race([this.unregister(token).then(() => (forgotten = true), () => undefined), waited]);
    } finally {
      if (timer) clearTimeout(timer);
      await this.forget();
      if (!forgotten) await this.write(this.pendingKey, { token });
    }
  }

  /**
   * A token sign-out could not forget: try once more before registering a different one - best effort (it only
   * works while the same person is signed in, and is harmless otherwise) - then drop it. The same token is simply
   * registered again, to whoever is signed in now.
   */
  private async retryPending(token: string): Promise<void> {
    const pending = (await this.read(this.pendingKey)).token;
    if (!pending) return;
    if (pending !== token) {
      try {
        await this.http.request<void>('POST', this.url('/devices/unregister'), { token: pending });
      } catch {
        /* someone else is signed in now, or still offline: let it go */
      }
    }
    await this.remove(this.pendingKey);
  }

  private url(path: string) {
    return this.http.api(`/notification/end-users/me/push${path}`);
  }

  private async noted(p: PushPreferences): Promise<PushPreferences> {
    if (p?.scopeHash) {
      const r = await this.remembered();
      if (r.scopeHash !== p.scopeHash) await this.remember({ ...r, scopeHash: p.scopeHash });
    }
    return p;
  }

  private remembered(): Promise<Remembered> {
    return this.read(this.key);
  }

  private remember(r: Remembered): Promise<void> {
    return this.write(this.key, r);
  }

  private forget(): Promise<void> {
    return this.remove(this.key);
  }

  private async read(key: string): Promise<Remembered> {
    try {
      const raw = await this.store.getItem(key);
      return raw ? (JSON.parse(raw) as Remembered) : {};
    } catch {
      return {};
    }
  }

  private async write(key: string, r: Remembered): Promise<void> {
    try {
      await this.store.setItem(key, JSON.stringify(r));
    } catch {
      /* storage refused: the device stays registered on the platform, sign-out just cannot forget it */
    }
  }

  private async remove(key: string): Promise<void> {
    try {
      await this.store.removeItem(key);
    } catch {
      /* nothing to do */
    }
  }
}
