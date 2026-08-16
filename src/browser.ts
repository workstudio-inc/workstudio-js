/**
 * Browser-only helpers (OAuth popup handling).
 *
 * Import from `@workstudio/integrations/browser`. These use `window`/`postMessage` and must run in
 * a browser. The core client (`@workstudio/integrations`) stays isomorphic.
 */
import type { IntegrationsClient } from './client.js';
import type { Activation, InitiateOAuthOptions } from './types.js';

/** postMessage type the connection OAuth popup posts back to the opener on completion. */
export const OAUTH_CALLBACK_MESSAGE = 'svx:integration:oauth:callback';

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
      if (data && typeof data === 'object' && data.type === OAUTH_CALLBACK_MESSAGE) {
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
 * One-call connect for a connector: initiate OAuth, open the popup, wait for completion, then
 * return the refreshed activation. Ideal for a "Connect" button.
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
    redirectUri: options?.redirectUri,
    state: options?.state,
  });
  await openOAuthPopup(init.authorizationUrl, options);
  return client.getActivation(activationId);
}
