import type { Http } from './http';

/**
 * Shared projects: a private space between exactly two of an App's people - the owner side (Crava: the
 * shop, the one whose plan has the App's project feature) and the client side - about one piece of work.
 * It holds numbered, frozen revisions (the App's JSON, a price and a lead time), a timeline (messages,
 * revisions, change requests, approvals, status changes), change requests in plain words, and an
 * append-only record of what the client approved. Only the two people in it can read any of it; the App's
 * publisher sees counts only.
 *
 * Named `sharedProjects` beside `projects` (the person's own projects, which conversations belong to).
 */

/** The two sides of a shared project. */
export type ProjectSide = 'owner' | 'client';

/** `open` -> `agreed` (the client approved a revision) -> `closed` (the owner; final, read-only). */
export type ProjectStatus = 'open' | 'agreed' | 'closed';

/** A price: `amount` a decimal string with at most 2 decimals ("1240.00"), `currency` ISO 4217 upper case. */
export interface ProjectPrice {
  amount: string;
  currency: string;
}

/** What a participant chose to share. */
export interface ProjectContact {
  name: string | null;
  email: string | null;
  phone: string | null;
  website?: string | null;
}

export interface ProjectParticipant {
  side: ProjectSide;
  /** The name they show; null once they deleted their account. */
  name: string | null;
  contact: ProjectContact;
  joinedAt: string;
  /** How far they have read: drives "Seen". */
  lastReadSeq: number;
  /** Their account was deleted: the project is read-only and their content removed. */
  departed: boolean;
  /** This participant is the signed-in person. */
  you: boolean;
}

/** A revision without its payload, as a project lists them. */
export interface ProjectRevisionMeta {
  number: number;
  price: ProjectPrice | null;
  /** "3-4 weeks" */
  leadTime: string | null;
  /** App-written: "wider, adjustable shelves, +$80" */
  summary: string | null;
  /** "sha256:<64 hex>" of the frozen revision. */
  hash: string;
  /** Change request ids this revision answers. */
  answers: string[];
  /** This is the agreed revision. */
  approved: boolean;
  createdAt: string;
  /** Its timeline entry. */
  seq: number;
}

/** A revision, whole. Revisions never change once posted. */
export interface ProjectRevision<T = Record<string, unknown>, C = Record<string, unknown>> extends ProjectRevisionMeta {
  /** The App's JSON (Crava: the design), as posted. */
  payload: T;
  /** The App's "what changed", as posted. */
  changes: C | null;
  note: string | null;
}

export type ProjectEntryType = 'started' | 'message' | 'revision' | 'change_request' | 'change_declined' | 'approval' | 'status';

/** One item of a project's timeline. */
export interface ProjectEntry {
  /** 1, 2, 3... per project, gap-free: the timeline's order. */
  seq: number;
  type: ProjectEntryType;
  /** Who did it; null for none. */
  side: ProjectSide | null;
  /** Message or change request text, or a decline's reason; null when removed. */
  body: string | null;
  /** Its author deleted their account: show "Message removed". */
  removed: boolean;
  /** Always empty in this version. */
  attachments: unknown[];
  revision: number | null;
  changeRequest: string | null;
  /** On `status` entries: the new status. */
  status: ProjectStatus | null;
  /** History carried over from where the project started. */
  imported: 'request' | 'share' | null;
  /** An imported request message that had a proposal attached (no link). */
  share: { kind: string; title: string } | null;
  at: string;
}

export interface ProjectChangeRequest {
  id: string;
  /** Who asked: either side may. */
  side: ProjectSide;
  /** Null when removed. */
  body: string | null;
  /** The revision it is about, when given. */
  revision: number | null;
  status: 'open' | 'answered' | 'declined';
  /** The revision that answered it. */
  answeredBy: number | null;
  declineReason: string | null;
  removed: boolean;
  createdAt: string;
  resolvedAt: string | null;
  seq: number;
}

/** The record of an approval: append-only, never edited (bar erasure). */
export interface ProjectApproval {
  id: string;
  revision: number;
  /** The revision's hash at the time. */
  hash: string;
  price: ProjectPrice | null;
  leadTime: string | null;
  approverSide: 'client';
  /** The name shown at the time; null once the client deleted their account ("a former client"). */
  approverName: string | null;
  /** Whom they agreed with: kept when the owner deletes their account. */
  ownerName: string | null;
  note: string | null;
  channel: ProjectChannel | null;
  /** The server's clock. */
  at: string;
  seq: number;
}

export type ProjectChannel = 'web' | 'ios' | 'android';

/** A project as a list shows it. */
export interface SharedProjectSummary {
  id: string;
  /** Crava: "job" */
  kind: string;
  title: string;
  status: ProjectStatus;
  /** The signed-in person's side. */
  side: ProjectSide;
  other: { name: string | null; departed: boolean };
  /** 0 = none yet. */
  currentRevision: number;
  agreedRevision: number | null;
  /** The latest revision has a price and is not the agreed one. */
  needsApproval: boolean;
  /** Timeline entries after my lastReadSeq not written by me. */
  unread: number;
  /** New revisions and approvals are paused (the owner side's plan no longer has the feature). */
  paused: boolean;
  /** Closed, or the other side deleted their account. */
  readOnly: boolean;
  origin: { type: 'request' | 'share'; id: string };
  createdAt: string;
  lastActivityAt: string;
}

/** One project, whole. */
export interface SharedProject extends SharedProjectSummary {
  participants: ProjectParticipant[];
  /** Oldest first, without payload. */
  revisions: ProjectRevisionMeta[];
  changeRequests: ProjectChangeRequest[];
  /** The approval record, oldest first. */
  approvals: ProjectApproval[];
  /** The latest 100 entries, oldest first; page back with {@link SharedProjects.entries}. */
  entries: ProjectEntry[];
  hasEarlier: boolean;
  closedAt: string | null;
  closedBy: ProjectSide | null;
}

/** What {@link SharedProjects.postRevision} takes. */
export interface NewProjectRevision<T = Record<string, unknown>, C = Record<string, unknown>> {
  /** JSON object, at most 512 KB. */
  payload: T;
  /** Required for a revision the client can approve. >= 0, at most 2 decimals. */
  price: { amount: string | number; currency: string };
  /** At most 80 characters, one line. */
  leadTime?: string;
  /** At most 500 characters, one line. */
  summary?: string;
  /** The App's "what changed", at most 64 KB. */
  changes?: C;
  /** At most 2000 characters. */
  note?: string;
  /** Open change request ids this revision answers. */
  answers?: string[];
}

export interface SharedProjectListOptions {
  status?: ProjectStatus;
  /** 1-100, default 50. */
  limit?: number;
}

export interface ProjectEntriesOptions {
  /** Entries before this seq (paging back). */
  before?: number;
  /** Entries after this seq (new ones). */
  after?: number;
  /** 1-200, default 100. */
  limit?: number;
}

/**
 * Shared projects between two of the App's people. The owner side opens one from a request sent to their
 * listing ({@link startFromRequest}); the client continues from the owner's proposal link
 * ({@link continueFromShare}). Then: {@link message} and {@link requestChange} (either side),
 * {@link postRevision}, {@link declineChange} and {@link close} (the owner), {@link approve} (the client).
 *
 * Refusals are `AppError`s with `status` and `code` - e.g. 403 `FEATURE_PAUSED` (revisions and approvals
 * paused), 403 `OWNER_ONLY` / `CLIENT_ONLY`, 409 `READ_ONLY`, `NOT_LATEST`, `ALREADY_APPROVED`, 404
 * `PROJECT_NOT_FOUND`, 429 `SLOW_DOWN`.
 */
export class SharedProjects {
  constructor(private readonly http: Http) {}

  /** My projects, most recent activity first; those I removed from my list are left out. */
  list(options: SharedProjectListOptions = {}): Promise<SharedProjectSummary[]> {
    const q = new URLSearchParams();
    if (options.status) q.set('status', options.status);
    if (options.limit !== undefined) q.set('limit', String(options.limit));
    return this.http.request('GET', this.url(qs(q)));
  }

  /** How many of my projects have unread entries, and how many unread entries in all (a tab badge). */
  unread(): Promise<{ projects: number; entries: number }> {
    return this.http.request('GET', this.url('/unread'));
  }

  get(id: string): Promise<SharedProject> {
    return this.http.request('GET', this.url(`/${enc(id)}`));
  }

  /** A page of the timeline, oldest first. */
  entries(id: string, options: ProjectEntriesOptions = {}): Promise<{ entries: ProjectEntry[]; hasEarlier: boolean }> {
    const q = new URLSearchParams();
    if (options.before !== undefined) q.set('before', String(options.before));
    if (options.after !== undefined) q.set('after', String(options.after));
    if (options.limit !== undefined) q.set('limit', String(options.limit));
    return this.http.request('GET', this.url(`/${enc(id)}/entries${qs(q)}`));
  }

  /** One revision with its payload. */
  revision<T = Record<string, unknown>, C = Record<string, unknown>>(id: string, number: number): Promise<ProjectRevision<T, C>> {
    return this.http.request('GET', this.url(`/${enc(id)}/revisions/${enc(String(number))}`));
  }

  /**
   * The owner side opens a project from a request sent to their listing ("Start a job"); the requester
   * becomes the client. Optionally posts revision 1 in the same call. Again for the same request: the
   * existing project.
   */
  startFromRequest<T = Record<string, unknown>>(
    requestId: string,
    options: { kind?: string; title?: string; revision?: NewProjectRevision<T>; channel?: ProjectChannel } = {},
  ): Promise<SharedProject> {
    return this.http.request('POST', this.url(), { from: { request: requestId }, ...options });
  }

  /**
   * The signed-in person continues from another person's proposal link ("Continue in Crava"): its owner
   * becomes the owner side, the share's payload revision 1. `contact`: what the owner sees of me (a field
   * left out is my sign-in's, "" is not shared).
   */
  continueFromShare(
    shareToken: string,
    options: { kind?: string; title?: string; contact?: { name?: string; email?: string; phone?: string }; channel?: ProjectChannel } = {},
  ): Promise<SharedProject> {
    return this.http.request('POST', this.url(), { from: { shareToken }, ...options });
  }

  /** A message, 1-5000 characters. */
  message(id: string, body: string): Promise<ProjectEntry> {
    return this.http.request('POST', this.url(`/${enc(id)}/messages`), { body });
  }

  /** The owner side posts the next revision; numbered by the platform, frozen once posted. */
  postRevision<T = Record<string, unknown>, C = Record<string, unknown>>(id: string, revision: NewProjectRevision<T, C>): Promise<ProjectRevision<T, C>> {
    return this.http.request('POST', this.url(`/${enc(id)}/revisions`), revision);
  }

  /** Ask for a change in plain words, optionally about one revision. */
  requestChange(id: string, change: { body: string; revision?: number }): Promise<ProjectChangeRequest> {
    return this.http.request('POST', this.url(`/${enc(id)}/change-requests`), change);
  }

  /** The owner side declines an open change request, with a reason. */
  declineChange(id: string, changeRequestId: string, reason: string): Promise<ProjectChangeRequest> {
    return this.http.request('POST', this.url(`/${enc(id)}/change-requests/${enc(changeRequestId)}/decline`), { reason });
  }

  /**
   * The client approves the latest revision at its price, which makes the project `agreed`. Pass the
   * revision's `hash` to refuse (409 `REVISION_CHANGED`) if it is not what the person saw. There is no
   * withdraw: ask for a change instead.
   */
  approve(id: string, approval: { revision: number; hash?: string; note?: string; channel?: ProjectChannel }): Promise<ProjectApproval> {
    return this.http.request('POST', this.url(`/${enc(id)}/approve`), approval);
  }

  /** Mark read up to `seq` (default: the latest). Same on every device. */
  markRead(id: string, seq?: number): Promise<{ lastReadSeq: number; unread: number }> {
    return this.http.request('POST', this.url(`/${enc(id)}/read`), seq === undefined ? {} : { seq });
  }

  /** The owner side closes it, with a last message if wanted. Final. */
  close(id: string, options: { reason?: string } = {}): Promise<SharedProject> {
    return this.http.request('POST', this.url(`/${enc(id)}/close`), options);
  }

  /** Remove it from my list - once it is read-only. When both have, it is deleted. */
  remove(id: string): Promise<void> {
    return this.http.request('DELETE', this.url(`/${enc(id)}`));
  }

  private url(rest = ''): string {
    return this.http.api(`/connection/end-users/me/projects${rest}`);
  }
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

function qs(q: URLSearchParams): string {
  const s = q.toString();
  return s ? `?${s}` : '';
}
