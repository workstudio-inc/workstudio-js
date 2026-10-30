/**
 * Browser-only helpers (OAuth popup handling).
 *
 * Import from `@workstudio-inc/sdk/browser`. These use `window`/`postMessage` and must run in
 * a browser. The core client (`@workstudio-inc/sdk`) stays isomorphic.
 */
import type { IntegrationsClient } from './client.js';
import type { Activation, InitiateOAuthOptions } from './types.js';

/**
 * postMessage type a Workstudio embed frame posts to its host when a connection OAuth flow completes. The OAuth popup
 * itself posts {@link CONNECTION_STATUS_MESSAGE}.
 */
export const OAUTH_CALLBACK_MESSAGE = 'svx:integration:oauth:callback';

/**
 * postMessage type the connection OAuth popup posts to its opener as it closes (connection MultiTenantSuccessHandler):
 * `{ type: 'connectionStatus', payload: 'success', connectionId, connectionInstanceId }`, or
 * `{ type: 'connectionStatus', payload: 'error', error }`. It is posted only to the flow's callback origin
 * (`initiateOAuth`'s `callbackOrigin`, which must be on the platform's allow-list) or the platform's default origin;
 * a page on any other origin never receives it and sees only the popup close.
 */
export const CONNECTION_STATUS_MESSAGE = 'connectionStatus';

export interface OpenOAuthPopupOptions {
  /** Popup window name. Default `svx_oauth`. */
  name?: string;
  /** Popup features string. Default `width=600,height=700`. */
  features?: string;
  /** Milliseconds before giving up waiting for the popup. Default 300000 (5 min). */
  timeoutMs?: number;
}

/**
 * Open an OAuth authorization URL in a popup and resolve when it posts the callback message or the
 * user closes it. Resolves with the callback payload if one was received, otherwise `undefined`.
 */
export function openOAuthPopup(
  authorizationUrl: string,
  options?: OpenOAuthPopupOptions,
): Promise<Record<string, unknown> | undefined> {
  const name = options?.name ?? 'svx_oauth';
  const features = options?.features ?? 'width=600,height=700';
  const timeoutMs = options?.timeoutMs ?? 300_000;

  return new Promise((resolve) => {
    const popup = window.open(authorizationUrl, name, features);
    if (!popup) {
      resolve(undefined);
      return;
    }

    let settled = false;
    const finish = (payload?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(payload);
    };

    const onMessage = (event: MessageEvent) => {
      const data = event?.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === OAUTH_CALLBACK_MESSAGE) {
        finish(data as Record<string, unknown>);
      } else if (data.type === CONNECTION_STATUS_MESSAGE && event.source === popup) {
        // What the popup itself posts; only from the popup this call opened.
        finish(data as Record<string, unknown>);
      }
    };

    const poll = setInterval(() => {
      if (popup.closed) finish(undefined);
    }, 500);
    const timer = setTimeout(() => finish(undefined), timeoutMs);

    window.addEventListener('message', onMessage);
  });
}

/**
 * One-call connect for a connector: initiate OAuth, open the popup, wait for completion, attach the connection the
 * popup reports to the activation's connector (`bindConnection`), then return the refreshed activation. Ideal for a
 * "Connect" button.
 *
 * When no result reaches this page - the person closed the popup, the flow failed, or this page's origin is not the
 * flow's callback origin (see {@link CONNECTION_STATUS_MESSAGE}) - it returns the activation as it stands, its
 * connector still in `pendingRequirements`.
 *
 * @example
 * ```ts
 * const updated = await connectConnector(client, activation.id, connectorGlobalId);
 * ```
 */
export async function connectConnector(
  client: IntegrationsClient,
  activationId: string,
  connectorGlobalId: string,
  options?: InitiateOAuthOptions & OpenOAuthPopupOptions,
): Promise<Activation> {
  const init = await client.initiateOAuth(activationId, connectorGlobalId, {
    callbackOrigin: options?.callbackOrigin,
    redirectUri: options?.redirectUri,
    state: options?.state,
    variables: options?.variables,
  });
  const result = await openOAuthPopup(init.authorizationUrl, options);
  const instanceId = result?.connectionInstanceId;
  if (result && result.payload !== 'error' && typeof instanceId === 'string' && instanceId) {
    // Nothing on the platform attaches the new connection to the activation: the opener does.
    return client.bindConnection(activationId, connectorGlobalId, instanceId);
  }
  return client.getActivation(activationId);
}
