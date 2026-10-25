import type { Http } from './http';

/**
 * Contacts, the App's own events, and what the person wants emailed.
 *
 * An App can tell its people things - "Asha cancelled Thursday's lesson", "your lesson is in an hour" -
 * through its automations (set in its manifest), which email or push them as the App. What it may never
 * do is message an address of its choosing: only the person themselves, or someone who accepted them as a
 * contact. So:
 *
 *   contacts       one person invites (`invite()` gives a token, shown once - put it in a link), the other
 *                  accepts (`accept(token)`); either can end it
 *   events         raise one of the App's own events (declared in its manifest's `events:`), now or at a
 *                  time, about the person (`to: 'me'`) or a contact (`to: contact.id`); `key` names it so it
 *                  can be replaced or taken back (`cancel(key)`) - "remind me of this lesson" moved or called off
 *   notifications  which of the App's emails the person gets; every such email also carries a link that
 *                  switches it off
 */

/** A contact: someone of the same App who agreed to hear from the person through it. */
export interface Contact {
  id: string;
  /** Their name in the App. Never their address. */
  name: string;
  /** What the person called them on the invite, when the person invited them; null otherwise. */
  label: string | null;
  /** Who sent the invite. */
  invitedBy: 'me' | 'them';
  since: string;
}

/** An invite: `token` only in what `invite()` answers - put it in a link for the other person. */
export interface ContactInvite {
  id: string;
  token?: string | null;
  label: string | null;
  expiresAt: string;
  createdAt: string;
}

export class Contacts {
  constructor(private readonly http: Http) {}

  /** The person's contacts, newest first. */
  list(): Promise<Contact[]> {
    return this.http.request('GET', this.url());
  }

  /**
   * Invite someone to be a contact. `label`: who it is for, in the person's words (only they see it).
   * The token works once, for 30 days; 50 invites a day.
   */
  invite(options: { label?: string } = {}): Promise<ContactInvite & { token: string }> {
    return this.http.request('POST', this.url('/invites'), { label: options.label ?? null });
  }

  /** Invites nobody has used yet (without their tokens). */
  invites(): Promise<ContactInvite[]> {
    return this.http.request('GET', this.url('/invites'));
  }

  /** Withdraw an invite nobody has used yet. */
  withdraw(inviteId: string): Promise<void> {
    return this.http.request('DELETE', this.url(`/invites/${encodeURIComponent(inviteId)}`));
  }

  /**
   * Accept an invite's token: the two are contacts. Accepting the same one again answers the same contact;
   * one used by someone else, withdrawn, expired or unknown is `AppError` 404 `INVITE_NOT_FOUND`; one's own,
   * 400 `OWN_INVITE`.
   */
  accept(token: string): Promise<Contact> {
    return this.http.request('POST', this.url('/accept'), { token });
  }

  /** Stop being contacts - for both. Whatever was scheduled between them is dropped. */
  remove(contactId: string): Promise<void> {
    return this.http.request('DELETE', this.url(`/${encodeURIComponent(contactId)}`));
  }

  private url(rest = ''): string {
    return this.http.api(`/connection/end-users/me/contacts${rest}`);
  }
}

/** A value of an event's field: as its declared type says (an id, one line, text, a number, a choice). */
export type EventFieldValue = string | number;

export interface EventSendOptions {
  /** Whom it is about: `'me'` (the default) or a contact's id. */
  to?: 'me' | string;
  /** The event's fields, as the App declared them. */
  fields?: Record<string, EventFieldValue>;
  /** When: a Date or ISO-8601 with its offset, up to 180 days ahead. Absent (or within 30 s): now. */
  at?: Date | string;
  /**
   * The App's name for it (<=100 letters, digits, `_ . : -`): sent again with the same key while it waits,
   * it replaces it - and `cancel(key)` takes it back.
   */
  key?: string;
}

export interface Sent {
  event: string;
  to: string;
  /** `sent`: to the App's automations now. `scheduled`: waiting until `dueAt`. */
  status: 'sent' | 'scheduled';
  id?: string | null;
  dueAt?: string | null;
  key?: string | null;
}

export interface Scheduled {
  id: string;
  event: string;
  to: string;
  key: string | null;
  dueAt: string;
  fields: Record<string, EventFieldValue>;
}

export class Events {
  constructor(private readonly http: Http) {}

  /**
   * Raise one of the App's own events - now, or `at` a time - about the person or a contact. The App's
   * automations decide what it becomes (an email, a push). 120 an hour, 500 a day, 40 a day to one contact.
   */
  send(event: string, options: EventSendOptions = {}): Promise<Sent> {
    const at = options.at instanceof Date ? options.at.toISOString() : options.at;
    return this.http.request('POST', this.url(), {
      event,
      to: options.to ?? 'me',
      fields: options.fields ?? {},
      ...(at ? { at } : {}),
      ...(options.key ? { key: options.key } : {}),
    });
  }

  /** Take back what was sent for later under this key. True when something was waiting. */
  async cancel(key: string): Promise<boolean> {
    const r = await this.http.request<{ cancelled: boolean }>('DELETE', this.url(`/scheduled/${encodeURIComponent(key)}`));
    return !!r?.cancelled;
  }

  /** What the person sent for later and is still waiting, soonest first. */
  scheduled(options: { limit?: number } = {}): Promise<Scheduled[]> {
    return this.http.request('GET', this.url(`/scheduled${options.limit ? `?limit=${options.limit}` : ''}`));
  }

  private url(rest = ''): string {
    return this.http.api(`/connection/end-users/me/events${rest}`);
  }
}

export interface NotificationEvent {
  event: string;
  description: string | null;
  /** Whether the person gets it by email. */
  email: boolean;
}

export interface NotificationSettings {
  /** Whether the App emails the person at all. */
  email: boolean;
  events: NotificationEvent[];
}

export class Notifications {
  constructor(private readonly http: Http) {}

  /** What the App emails the person: its own events and those its automations email to them. */
  get(): Promise<NotificationSettings> {
    return this.http.request('GET', this.url());
  }

  /** Change what is emailed: `{ email: false }` for none, `{ events: { 'lesson.reminder': false } }` per event. */
  set(change: { email?: boolean; events?: Record<string, boolean> }): Promise<NotificationSettings> {
    return this.http.request('PUT', this.url(), change);
  }

  private url(): string {
    return this.http.api('/connection/end-users/me/notifications');
  }
}
