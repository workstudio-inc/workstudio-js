import type { Http } from './http';

/**
 * Where a request stands. `open` -> `answered` (the owner replied) -> `accepted` | `declined` (by the
 * requester); `open`|`answered` -> `withdrawn` (requester) or `declined` (owner);
 * `open`|`answered`|`accepted` -> `closed` (owner). Messages are allowed while open, answered or accepted.
 */
export type RequestStatus = 'open' | 'answered' | 'accepted' | 'declined' | 'withdrawn' | 'closed';

/** The two sides of a request: who sent it, and the listing's owner. */
export type RequestParty = 'requester' | 'owner';

/** A guest share the owner attached to a reply - a priced proposal, say. */
export interface RequestShare {
  token: string;
  kind: string;
  title: string;
  /** False once the share is withdrawn or expired. */
  active: boolean;
}

/** One message of a request's thread. */
export interface RequestMessage {
  id: string;
  from: RequestParty;
  body: string;
  share?: RequestShare | null;
  at: string;
}

/** The listing a request was sent to. */
export interface RequestListing {
  id: string;
  kind: string;
  displayName: string;
  /** Shown to the requester once the owner has replied; null or absent before. */
  contact?: { email?: string | null; phone?: string | null; website?: string | null } | null;
}

/**
 * A small image the requester sent with a request (Crava: a photo of the space), as both sides read
 * it. Cleared by the platform when the request ends - withdrawn, declined or closed; kept while it is
 * accepted - and gone with a {@link Requests.delete}.
 */
export interface RequestAttachment {
  name: string;
  /** `image/jpeg`, `image/png` or `image/webp`. */
  contentType: string;
  /** Its bytes, decoded. */
  size: number;
  /** `data:<contentType>;base64,...` - usable as an `<img src>` as it is. */
  dataUrl: string;
}

/**
 * An attachment as {@link Requests.create} takes it: a base64 `data:` URL of a JPEG, PNG or WebP
 * (no SVG). `contentType` may be left out (it is read from the URL); a `name` left out is made up.
 */
export interface NewRequestAttachment {
  name?: string;
  contentType?: string;
  dataUrl: string;
}

/** Who sent a request: what they chose to share. */
export interface RequestRequester {
  name: string;
  email?: string | null;
  phone?: string | null;
}

/**
 * A request from one person to a listing, and its thread both ways - as either side sees it
 * (`role`). Named `ListingRequest` so it does not hide the global `Request` of fetch.
 */
export interface ListingRequest<T = Record<string, unknown>> {
  id: string;
  /** Which side the signed-in person is on. */
  role: RequestParty;
  kind: string;
  /** The App's own reference for what the request is about, when it gave one. */
  ref: string | null;
  title: string;
  status: RequestStatus;
  /** Who ended it (declined, withdrew, closed), while it is ended. */
  endedBy: RequestParty | null;
  listing: RequestListing;
  requester: RequestRequester;
  /** The owner's view only: whether the requester is blocked from the owner's listings. */
  blocked?: boolean;
  /** With one request ({@link Requests.get}, {@link Inbox.get} and the actions); absent in a list. */
  payload?: T;
  /**
   * The requester's attachments, seen by both sides. With one request (an empty list when there are
   * none, or once they were cleared); absent in a list.
   */
  attachments?: RequestAttachment[];
  /** With one request; absent in a list. */
  messages?: RequestMessage[];
  createdAt: string;
  updatedAt: string;
  answeredAt: string | null;
  lastMessageAt: string | null;
}

/** What {@link Requests.create} takes. */
export interface NewRequest<T = Record<string, unknown>> {
  /** The listing, from {@link ListingCard.id}. */
  listingId: string;
  kind: string;
  /** The App's own reference for what is asked about (a record's key). */
  ref?: string;
  /** At most 200 characters. */
  title: string;
  /** The first message; at most 5000 characters. */
  message: string;
  /** What the App sends along; at most 512 KB of JSON. */
  payload?: T;
  /**
   * What the owner sees of the requester. A field left out is the sign-in name or email; `""` means
   * "do not share".
   */
  contact?: { name?: string; email?: string; phone?: string };
  /**
   * Up to 3 small images for both sides to see - photos of the space, say - at most 512 KB of data URL
   * in all (three ~100 KB JPEGs fit). Kept apart from `payload`: the platform clears them when the
   * request ends (kept while accepted). Too many is a 400 `TOO_MANY_ATTACHMENTS`, too big
   * `ATTACHMENTS_TOO_BIG`, not a JPEG/PNG/WebP that is what it says `BAD_ATTACHMENT`.
   */
  attachments?: NewRequestAttachment[];
}

/**
 * One of the owner's blocks ({@link Inbox.blocks}): the block's own id - never the blocked person's -
 * the name they last gave on a request still between the two (null when none is left), and when.
 */
export interface RequestBlock {
  id: string;
  name: string | null;
  blockedAt: string;
}

export interface RequestListOptions {
  status?: RequestStatus;
  limit?: number;
}

/**
 * The listing owner's side of requests: what people sent to their listings.
 *
 * {@link list}, {@link get}, {@link reply} (with a guest share, e.g. a priced proposal),
 * {@link decline}, {@link close}, {@link block} and {@link unblock}; and, with no request needed,
 * {@link blocks} and {@link lift}.
 */
export class Inbox {
  constructor(private readonly http: Http) {}

  /** Newest first, without payload or messages. */
  list<T = Record<string, unknown>>(options: RequestListOptions = {}): Promise<ListingRequest<T>[]> {
    return this.http.request('GET', this.url(query(options)));
  }

  get<T = Record<string, unknown>>(id: string): Promise<ListingRequest<T>> {
    return this.http.request('GET', this.url(`/${encodeURIComponent(id)}`));
  }

  /**
   * Answer in the thread; the first reply makes an open request `answered`. `shareToken` attaches a
   * guest share of the same App the owner made ({@link Shares.create}); another's is a 400 `SHARE_NOT_YOURS`.
   */
  reply<T = Record<string, unknown>>(id: string, reply: { body: string; shareToken?: string }): Promise<ListingRequest<T>> {
    return this.http.request('POST', this.url(`/${encodeURIComponent(id)}/reply`), reply);
  }

  /** Turn an open or answered request down, with a last word if wanted. */
  decline<T = Record<string, unknown>>(id: string, body?: string): Promise<ListingRequest<T>> {
    return this.http.request('POST', this.url(`/${encodeURIComponent(id)}/decline`), body !== undefined ? { body } : {});
  }

  /** End an open, answered or accepted request: done, or going nowhere. */
  close<T = Record<string, unknown>>(id: string): Promise<ListingRequest<T>> {
    return this.http.request('POST', this.url(`/${encodeURIComponent(id)}/close`));
  }

  /** Keep the requester from sending to this owner's listings again; declines the request if still open. */
  block<T = Record<string, unknown>>(id: string): Promise<ListingRequest<T>> {
    return this.http.request('POST', this.url(`/${encodeURIComponent(id)}/block`));
  }

  unblock<T = Record<string, unknown>>(id: string): Promise<ListingRequest<T>> {
    return this.http.request('DELETE', this.url(`/${encodeURIComponent(id)}/block`));
  }

  /** The people the owner blocked in this App, newest first - liftable even once their requests are gone. */
  blocks(): Promise<RequestBlock[]> {
    return this.http.request('GET', this.http.api('/connection/end-users/me/blocks'));
  }

  /** Lift a block by its id from {@link blocks}; resolves with nothing (204). Another's is a 404 `BLOCK_NOT_FOUND`. */
  lift(blockId: string): Promise<void> {
    return this.http.request('DELETE', this.http.api(`/connection/end-users/me/blocks/${encodeURIComponent(blockId)}`));
  }

  private url(rest = ''): string {
    return this.http.api(`/connection/end-users/me/inbox${rest}`);
  }
}

/**
 * Requests: a signed-in person asks a listing ({@link Listings}) for something - a quote, say - and
 * the two talk it through in a thread, with no email addresses swapped unless they choose to.
 *
 * The requester: {@link create}, {@link list}, {@link get}, {@link message}, {@link withdraw},
 * {@link delete}, and - once the owner has answered - {@link accept} or {@link decline}. The listing's
 * owner: {@link inbox}.
 *
 * Limits: 3 open requests per thing asked about (`ref`, else `title`), 10 new requests a day, 30
 * messages an hour (429 `SLOW_DOWN`). Deleting a request does not give back the day's count.
 */
export class Requests {
  /** The owner's side: requests sent to the person's listings. */
  readonly inbox: Inbox;

  constructor(private readonly http: Http) {
    this.inbox = new Inbox(http);
  }

  /** Send a request to a listing. Not to one's own (400 `OWN_LISTING`). */
  create<T = Record<string, unknown>>(request: NewRequest<T>): Promise<ListingRequest<T>> {
    return this.http.request('POST', this.url(), request);
  }

  /** The person's requests, newest first, without payload or messages. */
  list<T = Record<string, unknown>>(options: RequestListOptions = {}): Promise<ListingRequest<T>[]> {
    return this.http.request('GET', this.url(query(options)));
  }

  /** One request with its payload and messages. */
  get<T = Record<string, unknown>>(id: string): Promise<ListingRequest<T>> {
    return this.http.request('GET', this.url(`/${encodeURIComponent(id)}`));
  }

  /** Add to the thread; at most 5000 characters. */
  message<T = Record<string, unknown>>(id: string, body: string): Promise<ListingRequest<T>> {
    return this.http.request('POST', this.url(`/${encodeURIComponent(id)}/messages`), { body });
  }

  /** Take back an open or answered request. */
  withdraw<T = Record<string, unknown>>(id: string): Promise<ListingRequest<T>> {
    return this.http.request('POST', this.url(`/${encodeURIComponent(id)}/withdraw`));
  }

  /**
   * Delete one of the person's requests for good, at any status: the request, its messages and its
   * attachments, for both sides (the listing's owner is not told; it leaves their inbox). Resolves
   * with nothing (204). Only the requester may; anyone else - the owner included - gets a 404
   * `REQUEST_NOT_FOUND`. It still counts against the day's new requests.
   */
  delete(id: string): Promise<void> {
    return this.http.request('DELETE', this.url(`/${encodeURIComponent(id)}`));
  }

  /** Take up the owner's answer; only while `answered` (else 409 `WRONG_STATUS`). */
  accept<T = Record<string, unknown>>(id: string): Promise<ListingRequest<T>> {
    return this.http.request('POST', this.url(`/${encodeURIComponent(id)}/accept`));
  }

  /** Turn the owner's answer down; only while `answered` (else 409 `WRONG_STATUS`). */
  decline<T = Record<string, unknown>>(id: string): Promise<ListingRequest<T>> {
    return this.http.request('POST', this.url(`/${encodeURIComponent(id)}/decline`));
  }

  private url(rest = ''): string {
    return this.http.api(`/connection/end-users/me/requests${rest}`);
  }
}

function query(options: RequestListOptions): string {
  const q = new URLSearchParams();
  if (options.status) q.set('status', options.status);
  if (options.limit !== undefined) q.set('limit', String(options.limit));
  const s = q.toString();
  return s ? `?${s}` : '';
}
