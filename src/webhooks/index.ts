/**
 * `@workstudio-inc/sdk/webhooks`: check that a request to your webhook endpoint really came from work.studio, and read
 * the App event in it. For your backend (Node 18+, Deno, Bun, Cloudflare Workers / App functions): it uses Web Crypto.
 *
 * The recipe is work.studio's documented one: `X-Webhook-Signature: sha256=<hex>` is the HMAC-SHA256 of
 * `<X-Webhook-Timestamp>.<raw body>` keyed with your endpoint's signing secret. During a secret rotation the header holds
 * two signatures, comma-separated; either matching is enough.
 */
export * from './events';
import type { AppWebhookEvent } from './events';

/** Headers as a `Headers`, or a plain object (Node's `req.headers`, Express, Fastify). */
export type HeadersLike =
  | { get(name: string): string | null }
  | Record<string, string | string[] | undefined>;

export type WebhookVerificationErrorCode =
  | 'MISSING_HEADERS'
  | 'BAD_TIMESTAMP'
  | 'STALE_TIMESTAMP'
  | 'BAD_SIGNATURE'
  | 'NO_SECRET'
  | 'BAD_BODY';

export class WebhookVerificationError extends Error {
  readonly code: WebhookVerificationErrorCode;

  constructor(code: WebhookVerificationErrorCode, message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
    this.code = code;
  }
}

export interface VerifyWebhookOptions {
  /** How far the timestamp may be from now, either way. Default 300 seconds (5 minutes). */
  toleranceSeconds?: number;
  /** For tests: the current time in Unix seconds. */
  now?: () => number;
}

export const SIGNATURE_HEADER = 'x-webhook-signature';
export const TIMESTAMP_HEADER = 'x-webhook-timestamp';
export const ID_HEADER = 'x-webhook-id';

const encoder = new TextEncoder();

function header(headers: HeadersLike, name: string): string | null {
  if (typeof (headers as { get?: unknown }).get === 'function') {
    return (headers as { get(name: string): string | null }).get(name);
  }
  const record = headers as Record<string, string | string[] | undefined>;
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === name) {
      const v = record[key];
      return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
    }
  }
  return null;
}

function bytesOf(body: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof body === 'string') return encoder.encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  throw new WebhookVerificationError('BAD_BODY', 'Pass the raw request body (a string or bytes), not parsed JSON.');
}

function subtle(): SubtleCrypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || !c.subtle) {
    throw new Error('Web Crypto is not available: use Node 18+ (or set globalThis.crypto = require("node:crypto").webcrypto).');
  }
  return c.subtle;
}

async function hmacHex(secret: string, timestamp: string, body: Uint8Array): Promise<string> {
  const key = await subtle().importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const prefix = encoder.encode(timestamp + '.');
  const message = new Uint8Array(prefix.length + body.length);
  message.set(prefix, 0);
  message.set(body, prefix.length);
  const mac = new Uint8Array(await subtle().sign('HMAC', key, message));
  let hex = '';
  for (const b of mac) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** Equal without leaking where they first differ. */
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Check a webhook request and return its event.
 *
 * @param rawBody the exact bytes received - read the body as text or bytes BEFORE any JSON parsing; a re-serialised
 *                body has different bytes and never verifies
 * @param headers the request's headers
 * @param secret  your endpoint's signing secret (`whsec_...`), or several (during your own rotation)
 * @throws WebhookVerificationError when the request is not signed by work.studio or is too old (a replay)
 */
export async function verifyWebhook<T extends AppWebhookEvent = AppWebhookEvent>(
  rawBody: string | Uint8Array | ArrayBuffer,
  headers: HeadersLike,
  secret: string | readonly string[],
  options: VerifyWebhookOptions = {},
): Promise<T> {
  const secrets = (Array.isArray(secret) ? secret : [secret]).filter((s): s is string => typeof s === 'string' && s.length > 0);
  if (secrets.length === 0) {
    throw new WebhookVerificationError('NO_SECRET', 'No signing secret given.');
  }
  const signature = header(headers, SIGNATURE_HEADER);
  const timestamp = header(headers, TIMESTAMP_HEADER);
  if (!signature || !timestamp) {
    throw new WebhookVerificationError('MISSING_HEADERS', 'X-Webhook-Signature and X-Webhook-Timestamp are required.');
  }
  const ts = timestamp.trim();
  if (!/^\d{1,12}$/.test(ts)) {
    throw new WebhookVerificationError('BAD_TIMESTAMP', 'X-Webhook-Timestamp is not Unix seconds.');
  }
  const tolerance = options.toleranceSeconds ?? 300;
  const now = options.now ? options.now() : Math.floor(Date.now() / 1000);
  if (tolerance > 0 && Math.abs(now - Number(ts)) > tolerance) {
    throw new WebhookVerificationError('STALE_TIMESTAMP', 'The request is older than ' + tolerance + ' seconds (or from the future).');
  }
  const bytes = bytesOf(rawBody);
  const offered = signature
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .map((s) => (s.startsWith('sha256=') ? s.slice(7) : s))
    .filter((s) => /^[0-9a-f]{64}$/.test(s));
  let ok = false;
  for (const s of secrets) {
    const expected = await hmacHex(s, ts, bytes);
    for (const candidate of offered) {
      // No early return: every comparison runs.
      ok = sameHex(expected, candidate) || ok;
    }
  }
  if (!ok) {
    throw new WebhookVerificationError('BAD_SIGNATURE', 'The signature does not match: wrong secret, or the body was changed.');
  }
  let event: unknown;
  try {
    event = JSON.parse(typeof rawBody === 'string' ? rawBody : new TextDecoder().decode(bytes));
  } catch {
    throw new WebhookVerificationError('BAD_BODY', 'The body is not JSON.');
  }
  return event as T;
}

/**
 * Sign a body the way work.studio does - for testing your handler locally. Returns the two headers to send.
 */
export async function signWebhook(
  rawBody: string | Uint8Array,
  secret: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): Promise<{ 'X-Webhook-Timestamp': string; 'X-Webhook-Signature': string }> {
  const ts = String(timestamp);
  return {
    'X-Webhook-Timestamp': ts,
    'X-Webhook-Signature': 'sha256=' + (await hmacHex(secret, ts, bytesOf(rawBody))),
  };
}
