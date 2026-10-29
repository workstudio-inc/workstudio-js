/**
 * Seeing the App's requests: with `debug` on, every call the SDK makes to work.studio - sign-in, the token swap, data,
 * conversations, plans - is reported once it is answered, as its method, path, status, how long it took and, for a
 * refusal, the platform's `code`. That is enough to tell a wrong address from a missing collection from a lapsed
 * sign-in, without reading the bundle.
 *
 * Never reported: headers (the person's token), request or response bodies, and the query string (filter values are
 * the person's data). The path is reported as it is; it names a collection or a record id, nothing secret.
 *
 * On when the config says `debug: true` (or passes a function), when `WORKSTUDIO_DEBUG=1` is in the environment
 * (Node, a test runner, a server acting for a person), or when the page's `localStorage` has `workstudio:debug` set
 * to `1` - so it can be turned on in a deployed App from the browser console, with no rebuild.
 */

/** One answered request. */
export interface RequestLog {
  method: string;
  /** The URL's origin and path, without the query string. */
  url: string;
  /** The HTTP status; 0 when no answer came (the network, CORS, a Content Security Policy). */
  status: number;
  /** The platform's reason for a refusal (`code`, `errorCode`, or an OAuth `error`), when it gave one. */
  code?: string;
  /** From sending to the answer's headers, in milliseconds. */
  ms: number;
}

export type DebugOption = boolean | ((entry: RequestLog) => void);

/** Whether debugging is asked for outside the config: WORKSTUDIO_DEBUG=1, or localStorage `workstudio:debug` = 1. */
export function debugFromEnvironment(): boolean {
  try {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    if (env?.WORKSTUDIO_DEBUG === '1' || env?.WORKSTUDIO_DEBUG === 'true') return true;
  } catch {
    // No process here.
  }
  try {
    const store = (globalThis as { localStorage?: { getItem(key: string): string | null } }).localStorage;
    const value = store?.getItem('workstudio:debug');
    if (value === '1' || value === 'true') return true;
  } catch {
    // Storage refused (a private window, a sandboxed frame).
  }
  return false;
}

/** The line the default reporter writes: `[workstudio] GET https://api.../records -> 403 NOT_A_MEMBER (84 ms)`. */
export function describeRequest(entry: RequestLog): string {
  const answer = entry.status === 0 ? 'no answer' : String(entry.status);
  return `[workstudio] ${entry.method} ${entry.url} -> ${answer}${entry.code ? ` ${entry.code}` : ''} (${entry.ms} ms)`;
}

const defaultSink = (entry: RequestLog) => {
  // console.debug is hidden by default in some consoles; a failed call is worth seeing at once.
  if (entry.status === 0 || entry.status >= 400) console.warn(describeRequest(entry));
  else console.debug(describeRequest(entry));
};

/** The reporter `debug` asks for, or null when debugging is off. */
export function sinkFor(option: DebugOption | undefined): ((entry: RequestLog) => void) | null {
  if (typeof option === 'function') return option;
  if (option === true || (option === undefined && debugFromEnvironment())) return defaultSink;
  return null;
}

function urlOf(input: unknown): string {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as { url?: string })?.url ?? String(input);
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return raw.split(/[?#]/)[0] ?? raw;
  }
}

/** The refusal's reason from its body, or undefined. Reads a copy, so the caller still reads the body. */
async function codeOf(res: Response): Promise<string | undefined> {
  try {
    const text = await res.clone().text();
    const body = JSON.parse(text) as Record<string, unknown>;
    for (const value of [body.code, body.errorCode, body.error]) {
      if (typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value)) return value;
    }
  } catch {
    // Not JSON: no code.
  }
  return undefined;
}

/** `fetch`, reporting each request to `sink` once it is answered. The reporter's own failure never fails the call. */
export function loggedFetch(fetchImpl: typeof fetch, sink: (entry: RequestLog) => void, now: () => number = () => Date.now()): typeof fetch {
  const report = (entry: RequestLog) => {
    try {
      sink(entry);
    } catch {
      // The reporter is the App's; its failure is not the request's.
    }
  };
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? (input as { method?: string })?.method ?? 'GET').toUpperCase();
    const url = urlOf(input);
    const started = now();
    let res: Response;
    try {
      res = await fetchImpl(input, init);
    } catch (e) {
      report({ method, url, status: 0, ms: now() - started });
      throw e;
    }
    const entry: RequestLog = { method, url, status: res.status, ms: now() - started };
    if (!res.ok) entry.code = await codeOf(res);
    report(entry);
    return res;
  }) as typeof fetch;
}
