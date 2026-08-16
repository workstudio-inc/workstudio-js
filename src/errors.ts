/** Error thrown when the embed API returns a non-2xx response. */
export class IntegrationsApiError extends Error {
  /** HTTP status code. */
  readonly status: number;
  /** Parsed response body (JSON object or raw text), when available. */
  readonly body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = 'IntegrationsApiError';
    this.status = status;
    this.body = body;
    // Restore prototype chain for instanceof across transpile targets.
    Object.setPrototypeOf(this, IntegrationsApiError.prototype);
  }

  /** True for 401/403 — authentication or scope problems. */
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/** Error thrown when the client is misconfigured (before any request is made). */
export class IntegrationsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrationsConfigError';
    Object.setPrototypeOf(this, IntegrationsConfigError.prototype);
  }
}
