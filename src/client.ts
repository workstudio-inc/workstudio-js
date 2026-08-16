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
  SessionToken,
} from './types.js';

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
  listIntegrations(params?: { category?: string; search?: string }): Promise<Catalog> {
    return this.request<Catalog>('GET', '/catalog', { query: params });
  }

  /** Get full detail for a single integration by global id or slug. */
  getIntegration(idOrSlug: string): Promise<IntegrationDetail> {
    return this.request<IntegrationDetail>('GET', `/integrations/${encodeURIComponent(idOrSlug)}`);
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

  /** Begin an OAuth flow for a connector; returns the provider authorization URL to open. */
  initiateOAuth(
    activationId: string,
    connectorGlobalId: string,
    options?: InitiateOAuthOptions,
  ): Promise<OAuthInitResult> {
    return this.request<OAuthInitResult>(
      'POST',
      `/activations/${encodeURIComponent(activationId)}/oauth/${encodeURIComponent(connectorGlobalId)}/initiate`,
      { body: { redirectUri: options?.redirectUri, state: options?.state } },
    );
  }

  /**
   * Complete an OAuth flow (usually called by your redirect handler with the provider's `code`
   * and `state`). When `activationId`/`connectorGlobalId`/`connectionInstanceId` are supplied the
   * server binds the connection and returns the refreshed activation.
   */
  completeOAuth(input: CompleteOAuthInput): Promise<OAuthCallbackResult> {
    return this.request<OAuthCallbackResult>('POST', '/oauth/callback', { body: input });
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
    opts?: { query?: Record<string, string | undefined>; body?: unknown; scopeKey?: string },
  ): Promise<T> {
    const url = this.buildUrl(path, opts?.query);
    const res = await this.fetchImpl(url, {
      method,
      headers: this.headers(opts?.scopeKey),
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
