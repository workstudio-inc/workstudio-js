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

/**
 * Push notifications to the person's phone, from the App's own automations ("a new quote request").
 *
 * The App gets the device token from the phone (for example `@capacitor/push-notifications`) and hands it
 * here after sign-in, on every launch; the platform keeps it for this person in this App only, and sends with
 * the App's own Apple and Firebase credentials. Signing out forgets it. Nothing here asks the phone for
 * permission - that is the App's to do, at a moment the person understands why.
 */
export class Push {
  private readonly key: string;

  constructor(private readonly http: Http, private readonly store: KeyValueStore, storageKey: string, private readonly appId?: string) {
    this.key = `${storageKey}.push`;
  }

  /** This person's preferences for pushes from this App. */
  readonly preferences = {
    get: (): Promise<PushPreferences> => this.http.request<PushPreferences>('GET', this.url('/preferences')).then(p => this.noted(p)),
    /** Change some of them; the rest stay. Answers all of them. */
    set: (changes: Partial<Omit<PushPreferences, 'scopeHash'>>): Promise<PushPreferences> =>
      this.http.request<PushPreferences>('PUT', this.url('/preferences'), changes).then(p => this.noted(p)),
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
    await this.http.request<void>('DELETE', this.url(`/devices?token=${encodeURIComponent(which)}`));
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

  /** Forget this device before signing out: best effort, and never longer than a few seconds. */
  async beforeSignOut(): Promise<void> {
    const { token } = await this.remembered();
    if (!token) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<void>(done => (timer = setTimeout(done, SIGN_OUT_WAIT_MS)));
    try {
      await Promise.race([this.unregister(token).catch(() => undefined), waited]);
    } finally {
      if (timer) clearTimeout(timer);
      await this.forget();
    }
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

  private async remembered(): Promise<Remembered> {
    try {
      const raw = await this.store.getItem(this.key);
      return raw ? (JSON.parse(raw) as Remembered) : {};
    } catch {
      return {};
    }
  }

  private async remember(r: Remembered): Promise<void> {
    try {
      await this.store.setItem(this.key, JSON.stringify(r));
    } catch {
      /* storage refused: the device stays registered on the platform, sign-out just cannot forget it */
    }
  }

  private async forget(): Promise<void> {
    try {
      await this.store.removeItem(this.key);
    } catch {
      /* nothing to do */
    }
  }
}
