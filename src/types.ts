/**
 * Type definitions for the WorkStudio embeddable integration marketplace API.
 *
 * These mirror the server DTOs 1:1 (see the `com.svai.workflow.catalog.embed` package).
 */

/** A `fetch`-compatible function. Defaults to the global `fetch` in browsers / Node 18+. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Overall activation status (as surfaced to the embed). */
export type ActivationStatus = 'pending' | 'active' | 'failed' | 'disabled';

/** Per-connector connection status. */
export type ConnectorStatus = 'connected' | 'expired' | 'error';

/** A single integration as shown in the catalog list. */
export interface IntegrationSummary {
  id: string;
  globalId: string;
  slug: string;
  name: string;
  description?: string;
  shortDescription?: string;
  category?: string;
  logoUrl?: string;
  version?: string;
  tags?: string[];
  isPopular?: boolean;
  isNew?: boolean;
  requiresOAuth?: boolean;
  connectorCount: number;
}

/** Display settings configured by the tenant for the catalog. */
export interface DisplaySettings {
  [key: string]: unknown;
}

/** Branding configured by the tenant for the catalog. */
export interface BrandingConfig {
  [key: string]: unknown;
}

/** Response of `listIntegrations` / GET /embed/catalog. */
export interface Catalog {
  integrations: IntegrationSummary[];
  categories: string[];
  displaySettings?: DisplaySettings;
  branding?: BrandingConfig;
  totalCount: number;
}

/** A connector required by an integration. */
export interface ConnectorInfo {
  globalId: string;
  name: string;
  description?: string;
  logoUrl?: string;
  /** oauth2 | api_key | basic | none */
  authType?: string;
  isRequired: boolean;
  isConnected: boolean;
  connectionStatus?: string;
}

/** A configuration field the customer must fill (non-OAuth). */
export interface ConfigField {
  key: string;
  label: string;
  description?: string;
  /** text | password | select | toggle */
  type: string;
  required: boolean;
  defaultValue?: string;
  /** Options for `select` fields. */
  options?: string[];
  placeholder?: string;
}

/** Full detail for a single integration. */
export interface IntegrationDetail {
  id: string;
  globalId: string;
  slug: string;
  name: string;
  description?: string;
  longDescription?: string;
  category?: string;
  logoUrl?: string;
  version?: string;
  tags?: string[];
  connectors?: ConnectorInfo[];
  configFields?: ConfigField[];
  features?: string[];
  documentationUrl?: string;
  isActivated: boolean;
  activationStatus?: string;
  activationId?: string;
}

/** A connector still requiring the customer to authenticate / configure. */
export interface PendingRequirement {
  connectorGlobalId?: string;
  connectorName?: string;
  connectorLogoUrl?: string;
  /** oauth | api_key | config */
  type?: string;
  description?: string;
  /** For OAuth: the authorization URL. */
  authorizationUrl?: string;
  /** For config: the fields to fill. */
  configFields?: ConfigField[];
}

/** A connector that has been connected. */
export interface ConnectedConnector {
  connectorGlobalId?: string;
  connectorName?: string;
  connectorLogoUrl?: string;
  connectionName?: string;
  status: ConnectorStatus | string;
  connectedAt?: string;
  expiresAt?: string;
}

/** An activation of an integration for a customer scope. */
export interface Activation {
  id: string;
  integrationGlobalId: string;
  integrationName?: string;
  integrationLogoUrl?: string;
  status: ActivationStatus | string;
  pendingRequirements?: PendingRequirement[];
  connectors?: ConnectedConnector[];
  createdAt?: string;
  updatedAt?: string;
}

/** Options for `activate`. */
export interface ActivateOptions {
  /** Customer-provided configuration values (validated against the integration's config schema). */
  config?: Record<string, unknown>;
  /** Arbitrary metadata to attach to the activation. */
  metadata?: Record<string, string>;
  /** Override the client-level customer scope for this call only. */
  scopeKey?: string;
}

/** Options for `initiateOAuth`. */
export interface InitiateOAuthOptions {
  /** Where the OAuth provider should send the user back to (your embed page). */
  redirectUri?: string;
  /** Opaque state passed through the OAuth flow. */
  state?: string;
}

/** Result of `initiateOAuth`. */
export interface OAuthInitResult {
  authorizationUrl: string;
  state?: string;
  connectorGlobalId?: string;
  connectorName?: string;
}

/** Input for `completeOAuth`. */
export interface CompleteOAuthInput {
  code?: string;
  state: string;
  error?: string;
  errorDescription?: string;
  activationId?: string;
  connectorGlobalId?: string;
  connectionInstanceId?: string;
}

/** Result of `completeOAuth`. */
export interface OAuthCallbackResult {
  success: boolean;
  error?: string;
  activationId?: string;
  connectorGlobalId?: string;
  connectorName?: string;
  connectionName?: string;
  /** The refreshed activation, when the callback bound a connection. */
  activation?: Activation;
}

/** A short-lived, single-customer-scoped session token minted from an API key. */
export interface SessionToken {
  /** The token (prefix `svx_st_`). Give this to the browser embed — never the API key. */
  token: string;
  /** ISO-8601 expiry timestamp. */
  expiresAt: string;
  /** The customer scope the token is bound to. */
  scopeKey: string;
}
