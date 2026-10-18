/** Somewhere to keep the sign-in between visits. `localStorage` fits the browser; a phone app may pass secure storage. */
export interface KeyValueStore {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

export interface AppConfig {
  /** The platform API, e.g. `https://api.work.studio`. */
  apiUrl: string;
  /** The hosted sign-in for Apps, e.g. `https://auth.work.studio/realms/apps`. */
  signInIssuer?: string;
  /** The sign-in client the platform assigned this build of the App (web, iPhone or Android). */
  clientId?: string;
  /**
   * The App's id on work.studio. With it, people who have not signed in yet can read the content the
   * App made public (`content.pack(name)`) - featured designs, templates - before being asked to join.
   */
  appId?: string;
  /** Where the hosted sign-in sends the person back. Defaults to this page's origin. */
  redirectUri?: string;
  /** Where conversations stream from, when not `apiUrl`. The platform also says, per conversation. */
  aiRuntimeUrl?: string;
  /** Where the App's data lives, when not `apiUrl`. */
  dataUrl?: string;
  /** Opens the hosted sign-in. Defaults to navigating this page; a phone app opens the system browser. */
  openUrl?: (url: string) => void | Promise<void>;
  /** Keeps the sign-in. Defaults to `localStorage`, else memory. */
  storage?: KeyValueStore;
  /** The storage key prefix. Defaults to `workstudio.app.<clientId>`. */
  storageKey?: string;
  /**
   * Bring your own token: a function returning the person's platform token, for a server acting for
   * a signed-in person. When set, the hosted sign-in is not used.
   */
  platformToken?: () => Promise<string | null> | string | null;
  /** The fetch to use. Defaults to the global one. */
  fetch?: typeof fetch;
}

export interface ResolvedConfig extends AppConfig {
  apiUrl: string;
  aiRuntimeUrl: string;
  dataUrl: string;
  storageKey: string;
  fetch: typeof fetch;
}

const trim = (url: string) => url.trim().replace(/\/+$/, '');

export function resolve(config: AppConfig): ResolvedConfig {
  if (!config || !config.apiUrl) throw new Error('createApp needs apiUrl: the platform API, e.g. https://api.work.studio');
  if (!config.platformToken && (!config.signInIssuer || !config.clientId)) {
    throw new Error('createApp needs signInIssuer and clientId for sign-in (or a platformToken function).');
  }
  const apiUrl = trim(config.apiUrl);
  const f = config.fetch ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : undefined);
  if (!f) throw new Error('No fetch available: pass one in the config.');
  return {
    ...config,
    apiUrl,
    signInIssuer: config.signInIssuer ? trim(config.signInIssuer) : undefined,
    aiRuntimeUrl: config.aiRuntimeUrl ? trim(config.aiRuntimeUrl) : apiUrl,
    dataUrl: config.dataUrl ? trim(config.dataUrl) : apiUrl,
    storageKey: config.storageKey ?? `workstudio.app.${config.clientId ?? 'custom'}`,
    fetch: f,
  };
}
