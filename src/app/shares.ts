import { AppError } from './errors';
import type { Http } from './http';

/** What the guest said about a share: approved, or sent back for changes - once. */
export interface ShareDecision {
  decision: 'APPROVED' | 'CHANGES_REQUESTED';
  name: string | null;
  note: string | null;
  at: string;
}

export interface ShareComment {
  author: 'GUEST' | 'OWNER';
  /** The name the guest gave; null for the owner. */
  name: string | null;
  body: string;
  at: string;
}

/** A share as the person who made it sees it. */
export interface Share<T = Record<string, unknown>> {
  id: string;
  kind: string;
  /** The App's own reference for what was shared, when it gave one. */
  ref: string | null;
  title: string;
  /** Null in a list: read one share for what was shared. */
  payload: T | null;
  allowComments: boolean;
  allowDecision: boolean;
  decision: ShareDecision | null;
  views: number;
  lastViewedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  /** With {@link Shares.get} and after a reply; null in a list. */
  comments: ShareComment[] | null;
}

/** A share as a guest with its link sees it: what was shared, the conversation and any decision. */
export interface GuestShare<T = Record<string, unknown>> {
  kind: string;
  title: string;
  payload: T;
  allowComments: boolean;
  allowDecision: boolean;
  decision: ShareDecision | null;
  expiresAt: string | null;
  createdAt: string;
  comments: ShareComment[];
}

export interface NewShare<T = Record<string, unknown>> {
  /** What it is, in the App's words: "proposal". Lower case, digits, - and _. */
  kind: string;
  /** The App's own reference for what is shared (a record's key), to list shares of one thing. */
  ref?: string;
  title: string;
  /** Frozen as it is now; at most 512 KB of JSON - link to pictures rather than embedding them. */
  payload: T;
  /** Default true. */
  allowComments?: boolean;
  /** Let the guest approve it or ask for changes, once. Default false. */
  allowDecision?: boolean;
  /** 1-365, default 90. */
  expiresInDays?: number;
}

/**
 * Guest shares: a frozen copy of something the signed-in person made, opened by anyone they give the
 * link to - no account - who can comment and, when allowed, approve it or ask for changes. The App
 * draws it on its own page; the platform keeps it, guards the link and records what the guest did.
 *
 * The person: {@link create} (answers the link's token - said once; make the App's link from it),
 * {@link list}, {@link get}, {@link reply}, {@link withdraw}. The guest, on the App's page, with nobody
 * signed in: {@link open}, {@link comment}, {@link decide} - these need the App's `appId` in the config.
 */
export class Shares {
  constructor(private readonly http: Http) {}

  create<T = Record<string, unknown>>(share: NewShare<T>): Promise<{ share: Share<T>; token: string }> {
    return this.http.request('POST', this.http.api('/connection/end-users/me/shares'), share);
  }

  /** Newest first, without what was shared; of one thing with `ref`. */
  list<T = Record<string, unknown>>(options: { ref?: string; limit?: number } = {}): Promise<Share<T>[]> {
    const q = new URLSearchParams({ limit: String(options.limit ?? 50), ...(options.ref ? { ref: options.ref } : {}) });
    return this.http.request('GET', this.http.api(`/connection/end-users/me/shares?${q}`));
  }

  get<T = Record<string, unknown>>(id: string): Promise<Share<T>> {
    return this.http.request('GET', this.http.api(`/connection/end-users/me/shares/${encodeURIComponent(id)}`));
  }

  reply<T = Record<string, unknown>>(id: string, body: string): Promise<Share<T>> {
    return this.http.request('POST', this.http.api(`/connection/end-users/me/shares/${encodeURIComponent(id)}/comments`), { body });
  }

  /** The link stops working at once; the share and its conversation stay. */
  withdraw<T = Record<string, unknown>>(id: string): Promise<Share<T>> {
    return this.http.request('DELETE', this.http.api(`/connection/end-users/me/shares/${encodeURIComponent(id)}`));
  }

  /** As a guest: what the link shows. A link unknown, withdrawn, expired or another App's is a 404, all alike. */
  open<T = Record<string, unknown>>(token: string): Promise<GuestShare<T>> {
    return this.http.anonymous(this.guest('open'), 'POST', { token });
  }

  comment<T = Record<string, unknown>>(token: string, comment: { name: string; body: string }): Promise<GuestShare<T>> {
    return this.http.anonymous(this.guest('comments'), 'POST', { token, ...comment });
  }

  /** Once: a second decision is a 409. */
  decide<T = Record<string, unknown>>(
    token: string,
    decision: { decision: 'APPROVED' | 'CHANGES_REQUESTED'; name: string; note?: string },
  ): Promise<GuestShare<T>> {
    return this.http.anonymous(this.guest('decision'), 'POST', { token, ...decision });
  }

  /** Every guest call is a POST with the token in its body: never in an address that gets logged. */
  private guest(what: 'open' | 'comments' | 'decision'): string {
    const appId = this.http.config.appId;
    if (!appId) throw new AppError(0, 'Guest shares need the App id (appId) in the config.', 'NO_APP_ID');
    return `${this.http.config.apiUrl}/api/v1/public/apps/${encodeURIComponent(appId)}/shares/${what}`;
  }
}
