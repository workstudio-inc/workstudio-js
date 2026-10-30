import { IntegrationsApiError, IntegrationsConfigError } from './errors.js';
import type {
  Activation,
  ActivateOptions,
  Catalog,
  CompleteOAuthInput,
  FetchLike,
  InitiateOAuthOptions,
  IntegrationDetail,
  OAuthCallbackResult,
  OAuthInitResult,
  RegionWidgets,
  SessionToken,
} from './types.js';

// Replaced at build time with the package version (tsup.config.ts); a constant under tooling that
// does not run the define, e.g. a type check.
declare const __SDK_VERSION__: string;
const SDK_VERSION: string = typeof __SDK_VERSION__ !== 'undefined' ? __SDK_VERSION__ : 'dev';

/**
 * Sent on the region render call. The server answers `{ widgets, skipped, contractVersion }` only to a
 * caller that says it reads that shape, and the bare array to everyone else.
 */
export const REGION_CLIENT = `workstudio-js/${SDK_VERSION}`;

/** Configuration for {@link IntegrationsClient}. */
export interface IntegrationsClientConfig {
  /**
   * Embed API key (`svx_ik_...`). A server-side secret — do NOT ship it to browsers.
   * Provide either `apiKey` or `token`.
   */
  apiKey?: string;

  /**
   * A JWT bearer token (custom-issued or a Workstudio session token). Use this for browser embeds
   * where the customer scope is baked into the signed token. Provide either `apiKey` or `token`.
   */
  token?: string;

  /** Your WorkStudio tenant id (sent as `X-Embed-Tenant`). Required for API-key auth. */
  tenantId?: string;

  /** Optional environment id (sent as `X-Embed-Env`). */
  envId?: string;

  /**
   * Customer scope for B2B2C, e.g. `"customer:acme"` (sent as `X-Embed-Scope`).
   *
   * - **API-key auth (server-side):** selects which of your customers you act on behalf of.
   * - **JWT auth:** ignored — the scope comes from the signed token.
   */
  scopeKey?: string;

  /** Origin of the embedding page (sent as `X-Embed-Origin`), used for the tenant origin allowlist. */
  origin?: string;

  /** API host origin. Default: `https://api.work.studio`. */
  baseUrl?: string;

  /** Embed API mount path. Default: `/api/v1/workflow/embed`. */
  basePath?: string;

  /** Custom `fetch` implementation (e.g. `node-fetch`). Defaults to the global `fetch`. */
  fetch?: FetchLike;
}

const DEFAULT_BASE_URL = 'https://api.work.studio';
const DEFAULT_BASE_PATH = '/api/v1/workflow/embed';

/**
 * Headless client for the WorkStudio integration marketplace.
 *
 * Every method maps to one embed API endpoint and returns typed data. It carries no UI and no
 * framework dependency — wrap it in React, Vue, Svelte, or plain DOM however you like.
 *
 * @example
 * ```ts
 * const client = new IntegrationsClient({ apiKey: process.env.WS_KEY, tenantId, scopeKey: 'customer:acme' });
 * const { integrations } = await client.listIntegrations();
 * const activation = await client.activate('servicenow');
 * ```
 */
export class IntegrationsClient {
  private readonly apiKey?: string;
  private readonly token?: string;
  private readonly tenantId?: string;
  private readonly envId?: string;
  private readonly scopeKey?: string;
  private readonly origin?: string;
  private readonly root: string;
  private readonly fetchImpl: FetchLike;

  constructor(config: IntegrationsClientConfig) {
    if (!config.apiKey && !config.token) {
      throw new IntegrationsConfigError('Provide either `apiKey` or `token`.');
    }
    const fetchImpl = config.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!fetchImpl) {
      throw new IntegrationsConfigError(
        'No `fetch` available. Pass `fetch` in the config (e.g. node-fetch) on older runtimes.',
      );
    }
    this.apiKey = config.apiKey;
    this.token = config.token;
    this.tenantId = config.tenantId;
    this.envId = config.envId;
    this.scopeKey = config.scopeKey;
    this.origin = config.origin;
    this.fetchImpl = fetchImpl;

    const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const basePath = config.basePath ?? DEFAULT_BASE_PATH;
    this.root = baseUrl + (basePath.startsWith('/') ? basePath : '/' + basePath);
  }

  // ===========================================================================
  // Catalog
  // ===========================================================================

  /** List the integrations published to the customer, optionally filtered. */
  async listIntegrations(params?: { category?: string; search?: string }): Promise<Catalog> {
    const catalog = await this.request<Catalog>('GET', '/catalog', { query: params });
    if (!catalog || !Array.isArray(catalog.integrations)) return catalog;
    // The server names these `popular` / `new` (Lombok boolean getters); the SDK has always promised isPopular / isNew.
    return {
      ...catalog,
      integrations: catalog.integrations.map((i) => ({
        ...i,
        isPopular: i.isPopular ?? i.popular,
        isNew: i.isNew ?? i.new,
      })),
    };
  }

  /** Get full detail for a single integration by global id or slug. */
  async getIntegration(idOrSlug: string): Promise<IntegrationDetail> {
    const detail = await this.request<IntegrationDetail>('GET', `/integrations/${encodeURIComponent(idOrSlug)}`);
    if (!detail || typeof detail !== 'object') return detail;
    // The server names it `activated` (a Lombok boolean getter); the SDK has always promised isActivated.
    return { ...detail, isActivated: detail.isActivated ?? detail.activated ?? false };
  }

  // ===========================================================================
  // Activations
  // ===========================================================================

  /** List the current customer scope's activations. */
  listActivations(): Promise<Activation[]> {
    return this.request<Activation[]>('GET', '/activations');
  }

  /** Get a single activation's live status (connectors + pending requirements). */
  getActivation(activationId: string): Promise<Activation> {
    return this.request<Activation>('GET', `/activations/${encodeURIComponent(activationId)}`);
  }

  /**
   * Activate an integration for the current customer scope. The returned activation lists any
   * `pendingRequirements` (OAuth connectors, config fields) that must be satisfied.
   */
  activate(integrationIdOrSlug: string, options?: ActivateOptions): Promise<Activation> {
    return this.request<Activation>(
      'POST',
      '/activations',
      {
        body: {
          integrationIdOrSlug,
          config: options?.config,
          metadata: options?.metadata,
        },
        scopeKey: options?.scopeKey,
      },
    );
  }

  /** Deactivate (soft-delete) an activation for the current customer scope. */
  deactivate(activationId: string): Promise<void> {
    return this.request<void>('DELETE', `/activations/${encodeURIComponent(activationId)}`);
  }

  // ===========================================================================
  // Connections
  // ===========================================================================

  /** Bind an already-authorized connection instance to an activation's connector. */
  bindConnection(
    activationId: string,
    connectorGlobalId: string,
    connectionInstanceId: string,
  ): Promise<Activation> {
    return this.request<Activation>(
      'POST',
      `/activations/${encodeURIComponent(activationId)}/connections/${encodeURIComponent(connectorGlobalId)}`,
      { body: { connectionInstanceId } },
    );
  }

  /** Disconnect a connector from an activation (it will require re-authorization). */
  disconnectConnection(activationId: string, connectorGlobalId: string): Promise<Activation> {
    return this.request<Activation>(
      'DELETE',
      `/activations/${encodeURIComponent(activationId)}/connections/${encodeURIComponent(connectorGlobalId)}`,
    );
  }

  // ===========================================================================
  // OAuth
  // ===========================================================================

  /**
   * Begin an OAuth flow for a connector; returns the provider authorization URL to open. When the popup finishes it
   * posts `{ type: 'connectionStatus', payload: 'success', connectionInstanceId }` to `callbackOrigin` (or the
   * platform's default origin); bind that instance with {@link bindConnection} - `connectConnector` in
   * `@workstudio-inc/sdk/browser` does both.
   */
  initiateOAuth(
    activationId: string,
    connectorGlobalId: string,
    options?: InitiateOAuthOptions,
  ): Promise<OAuthInitResult> {
    // The server's field is called redirectUri but is used as the popup's callback origin (catalog
    // IntegrationEmbedService -> connection OAuthInitiationController), which must be a bare origin.
    const callbackOrigin = options?.callbackOrigin ?? originOf(options?.redirectUri);
    return this.request<OAuthInitResult>(
      'POST',
      `/activations/${encodeURIComponent(activationId)}/oauth/${encodeURIComponent(connectorGlobalId)}/initiate`,
      { body: { redirectUri: callbackOrigin, state: options?.state, variables: options?.variables } },
    );
  }

  /**
   * Complete an OAuth flow (usually called by your redirect handler with the provider's `code`
   * and `state`). When `activationId`/`connectorGlobalId`/`connectionInstanceId` are supplied the
   * server binds the connection and returns the refreshed activation.
   *
   * Needs a key (or session token) holding the `oauth:complete` scope, which keys generated in Designer do not
   * have: without it the answer is 400 "Missing required scope: oauth:complete". To attach the connection a popup
   * reported, use {@link bindConnection} (`activation:create`).
   */
  completeOAuth(input: CompleteOAuthInput): Promise<OAuthCallbackResult> {
    return this.request<OAuthCallbackResult>('POST', '/oauth/callback', { body: input });
  }

  // ===========================================================================
  // Connector operations
  // ===========================================================================

  /**
   * List the operations a connector exposes, with their input schemas, so you can discover what
   * `execute` accepts.
   */
  listOperations(connectorGlobalId: string): Promise<import('./types.js').ConnectorOperation[]> {
    return this.request<import('./types.js').ConnectorOperation[]>(
      'GET',
      `/connectors/${encodeURIComponent(connectorGlobalId)}/operations`,
    );
  }

  /**
   * Call one connector operation using the current customer's own connection.
   *
   * The customer must have connected the connector first (through the catalog, an activation, or
   * OAuth). Credentials never leave the platform: your app sends the input and receives the
   * upstream answer. The call is pinned to the client's customer scope, so it can only ever use
   * that customer's connection.
   *
   * @example
   * ```ts
   * const res = await client.execute('<servicenow-connector-id>', 'create_incident', {
   *   short_description: 'Disk full on web-01',
   *   urgency: '2',
   * });
   * if (res.ok) console.log(res.data);
   * ```
   */
  execute<T = unknown>(
    connectorGlobalId: string,
    operation: string,
    input?: Record<string, unknown>,
    options?: import('./types.js').ExecuteOptions,
  ): Promise<import('./types.js').ExecuteResult<T>> {
    return this.request<import('./types.js').ExecuteResult<T>>(
      'POST',
      // The operation travels in the body: names like GitHub's "repos/list-for-authenticated-user"
      // carry slashes that do not survive as a path segment.
      `/connectors/${encodeURIComponent(connectorGlobalId)}/execute`,
      { body: { operation, input: input ?? {} }, scopeKey: options?.scopeKey },
    );
  }

  // ===========================================================================
  // Connections
  // ===========================================================================

  /**
   * The connectors this customer is offered, whether each is connected, and the customer's AI
   * assistant (MCP) access. Offered means the list you set in Designer, or every connector your
   * published Apps need.
   */
  listConnections(): Promise<import('./types.js').ConnectionsList> {
    return this.request<import('./types.js').ConnectionsList>('GET', '/connections');
  }

  /**
   * Disconnect the customer from a connector: the credentials they entered are deleted and their
   * OAuth grants revoked. Automations that use it stop working for this customer until they connect
   * again.
   */
  disconnect(connectorGlobalId: string): Promise<{ connectorGlobalId: string; removed: number }> {
    return this.request<{ connectorGlobalId: string; removed: number }>(
      'DELETE',
      `/connectors/${encodeURIComponent(connectorGlobalId)}/connection`,
    );
  }

  // ===========================================================================
  // AI assistant access (MCP)
  // ===========================================================================

  /** Whether assistant access is on for your customers, and whether this customer has a live URL. */
  getMcpAccess(): Promise<import('./types.js').McpAccess> {
    return this.request<import('./types.js').McpAccess>('GET', '/mcp-key');
  }

  /**
   * Create this customer's MCP URL, replacing any they had. The URL carries the key and is returned
   * only here: the customer pastes it into Claude, ChatGPT or Cursor, and the assistant can then use
   * their own connections as tools, and nothing else.
   */
  createMcpUrl(): Promise<import('./types.js').McpUrl> {
    return this.request<import('./types.js').McpUrl>('POST', '/mcp-key', { body: {} });
  }

  /** Turn the customer's MCP URL off. It stops working on the assistant's next call. */
  revokeMcpUrl(): Promise<void> {
    return this.request<void>('DELETE', '/mcp-key');
  }

  // ===========================================================================
  // Regions
  // ===========================================================================

  /**
   * The widgets that belong in one of your regions, for a host that frames them itself rather than
   * using the `<svx-region>` element.
   *
   * `context` is what your page knows about what the person is looking at; a field your contract
   * marks required and you leave out is a 400 naming it. Frame each `widgets[].embedUrl` in order -
   * the URL carries a credential minted for this answer, so ask again rather than caching it.
   * `skipped` says why each placed widget is not shown. A session token needs `surface:read`, and
   * `widget:run` for its frames to run.
   *
   * @example
   * ```ts
   * const { widgets, skipped } = await client.listRegionWidgets('ticket.sidebar', { ticketId: 'T-42' }, { contractVersion: 3 });
   * ```
   *
   * @param regionKey the region's key in your contract
   * @param context the page's context values
   * @param options.contractVersion the contract version your page was built for, recorded in the region's health
   */
  async listRegionWidgets(
    regionKey: string,
    context: Record<string, unknown>,
    options?: { contractVersion?: number },
  ): Promise<RegionWidgets> {
    const headers: Record<string, string> = { 'X-Region-Client': REGION_CLIENT };
    if (options?.contractVersion !== undefined) {
      headers['X-Region-Contract-Version'] = String(options.contractVersion);
    }
    const answer = await this.request<unknown>(
      'POST',
      `/surfaces/${encodeURIComponent(regionKey)}/widgets`,
      { body: context ?? {}, headers },
    );
    return normaliseRegionWidgets(answer);
  }

  // ===========================================================================
  // Session tokens (secure browser-embed auth)
  // ===========================================================================

  /**
   * Mint a short-lived, single-customer-scoped session token from this client's API key.
   *
   * **Call this from your backend only** (the API key is a server-side secret). Hand the returned
   * `token` to the browser embed as its bearer `token` — never the API key itself.
   *
   * @example
   * ```ts
   * // server
   * const { token } = await client.mintSessionToken('customer:acme', { ttlSeconds: 900 });
   * // send `token` to the browser; the embed uses it as `new IntegrationsClient({ token, tenantId })`
   * ```
   */
  mintSessionToken(scopeKey: string, options?: { ttlSeconds?: number }): Promise<SessionToken> {
    return this.request<SessionToken>('POST', '/session-tokens', {
      body: { scopeKey, ttlSeconds: options?.ttlSeconds },
    });
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  private async request<T>(
    method: string,
    path: string,
    opts?: {
      query?: Record<string, string | undefined>;
      body?: unknown;
      scopeKey?: string;
      headers?: Record<string, string>;
    },
  ): Promise<T> {
    const url = this.buildUrl(path, opts?.query);
    const res = await this.fetchImpl(url, {
      method,
      headers: { ...this.headers(opts?.scopeKey), ...opts?.headers },
      body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

    if (!res.ok) {
      const body = await this.safeParse(res);
      const message =
        (body && typeof body === 'object' && 'message' in body && typeof (body as Record<string, unknown>).message === 'string'
          ? ((body as Record<string, unknown>).message as string)
          : undefined) ?? `Request failed with status ${res.status}`;
      throw new IntegrationsApiError(res.status, message, body);
    }

    if (res.status === 204) {
      return undefined as T;
    }
    return (await res.json()) as T;
  }

  private buildUrl(path: string, query?: Record<string, string | undefined>): string {
    let url = this.root + path;
    if (query) {
      const usp = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') usp.append(k, v);
      }
      const qs = usp.toString();
      if (qs) url += '?' + qs;
    }
    return url;
  }

  private headers(scopeKeyOverride?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey ?? this.token}`,
    };
    if (this.tenantId) headers['X-Embed-Tenant'] = this.tenantId;
    if (this.envId) headers['X-Embed-Env'] = this.envId;
    const scope = scopeKeyOverride ?? this.scopeKey;
    if (scope) headers['X-Embed-Scope'] = scope;
    if (this.origin) headers['X-Embed-Origin'] = this.origin;
    return headers;
  }

  private async safeParse(res: Response): Promise<unknown> {
    try {
      return await res.json();
    } catch {
      try {
        return await res.text();
      } catch {
        return undefined;
      }
    }
  }
}

/** The origin of a URL (`https://host[:port]`), or the value as it is when it is not an absolute http(s) URL. */
function originOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : value;
  } catch {
    return value;
  }
}

/**
 * Either answer the region render endpoint gives, as one shape. A bare array is a server from before
 * region contracts; it never reports skips or a version. Rows without a frame URL are dropped.
 */
export function normaliseRegionWidgets(body: unknown): RegionWidgets {
  const isWidget = (w: unknown): w is RegionWidgets['widgets'][number] =>
    !!w && typeof w === 'object'
    && typeof (w as { embedUrl?: unknown }).embedUrl === 'string'
    && (w as { widgetId?: unknown }).widgetId != null;
  if (Array.isArray(body)) {
    return { widgets: body.filter(isWidget), skipped: [] };
  }
  const obj = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const result: RegionWidgets = {
    widgets: Array.isArray(obj.widgets) ? obj.widgets.filter(isWidget) : [],
    skipped: Array.isArray(obj.skipped)
      ? obj.skipped
          .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
          .map((s) => ({
            widgetId: String(s.widgetId ?? ''),
            reason: String(s.reason ?? ''),
            ...(typeof s.detail === 'string' ? { detail: s.detail } : {}),
          }))
      : [],
  };
  if (typeof obj.contractVersion === 'number') result.contractVersion = obj.contractVersion;
  return result;
}
