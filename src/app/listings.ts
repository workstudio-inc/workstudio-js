import { AppError } from './errors';
import type { Http } from './http';

/** Why a listing does not show in search right now; null when it does. */
export type ListingNotSearchableReason = 'NOT_LISTED' | 'NEEDS_PLAN' | 'LISTINGS_OFF' | 'UNAVAILABLE';

/** How people can reach the listing's owner. Never shown in search. */
export interface ListingContact {
  email?: string | null;
  phone?: string | null;
  website?: string | null;
}

/** Where the listing is, from its ZIP code. */
export interface ListingLocation {
  zip: string;
  city: string | null;
  state: string | null;
  lat: number;
  lng: number;
  radiusMiles: number;
}

/** The person's own listing of one kind, as they see it. */
export interface Listing {
  id: string;
  kind: string;
  displayName: string;
  summary: string;
  tags: string[];
  /** A `data:image/...;base64,` picture, or null. */
  logo: string | null;
  location: ListingLocation;
  contact: ListingContact;
  /** What the person asked for: listed, or kept as a draft. */
  listed: boolean;
  /** Whether it shows in search right now; when not, {@link notSearchableReason} says why. */
  searchable: boolean;
  notSearchableReason: ListingNotSearchableReason | null;
  createdAt: string;
  updatedAt: string;
}

/** What {@link Listings.save} takes: the whole listing, replacing what was there. */
export interface ListingInput {
  /** At most 80 characters. */
  displayName: string;
  /** At most 500 characters. */
  summary?: string;
  /** At most 10, each at most 30 characters. */
  tags?: string[];
  /** `data:image/(png|jpeg|webp|gif);base64,...`, at most 100 KB; null for none. */
  logo?: string | null;
  /** A US 5-digit ZIP code; an unknown one is a 400 `UNKNOWN_ZIP`. */
  zip: string;
  /** Used only when the platform's ZIP table has no city for the ZIP. */
  city?: string;
  /** 1-200, default 25. */
  radiusMiles?: number;
  contact?: { email?: string; phone?: string; website?: string };
  /**
   * Default true. Being listed needs the App's required plan feature (403 `NEEDS_PLAN`); a draft
   * (`false`) can be saved without it.
   */
  listed?: boolean;
}

/** A listing as search shows it: never its contact, exact place or owner. */
export interface ListingCard {
  id: string;
  kind: string;
  displayName: string;
  summary: string;
  tags: string[];
  logo: string | null;
  city: string | null;
  state: string | null;
  distanceMiles: number;
}

/** One page of listings near a ZIP code, nearest first. */
export interface NearResult {
  /** The ZIP code searched from, and where it is. */
  zip: string;
  city: string | null;
  state: string | null;
  /** 0-based. */
  page: number;
  limit: number;
  /** Whether a next page has more. */
  hasMore: boolean;
  results: ListingCard[];
}

export interface NearOptions {
  /** A US 5-digit ZIP code. */
  zip: string;
  /** 1-50, default 20. */
  limit?: number;
  /** 0-based, default 0. */
  page?: number;
}

/**
 * Listings: one public profile per person per `kind` (what it is in the App's words: "shop"), that
 * other signed-in people of the App find by ZIP code and send requests to ({@link Requests}).
 *
 * The person's own: {@link save}, {@link get}, {@link remove}. Anyone signed in: {@link near}.
 * The kinds an App may use, and the plan feature being listed needs, are the publisher's settings.
 */
export class Listings {
  constructor(private readonly http: Http) {}

  /** Create or replace the person's listing of this kind. */
  save(kind: string, listing: ListingInput): Promise<Listing> {
    return this.http.request('PUT', this.url(kind), listing);
  }

  /** The person's listing of this kind, or null when they have none. */
  async get(kind: string): Promise<Listing | null> {
    try {
      return await this.http.request<Listing>('GET', this.url(kind));
    } catch (e) {
      if (e instanceof AppError && e.status === 404 && e.code === 'LISTING_NOT_FOUND') return null;
      throw e;
    }
  }

  /** Delete the person's listing of this kind. */
  remove(kind: string): Promise<void> {
    return this.http.request('DELETE', this.url(kind));
  }

  /** Listings of this kind near a ZIP code, nearest first, a page at a time. Needs no plan feature. */
  near(kind: string, options: NearOptions): Promise<NearResult> {
    const q = new URLSearchParams({ zip: options.zip });
    if (options.limit !== undefined) q.set('limit', String(options.limit));
    if (options.page !== undefined) q.set('page', String(options.page));
    // The /me/ address: the one the platform lets App origins call from a browser.
    return this.http.request('GET', `${this.url(kind)}/near?${q}`);
  }

  private url(kind: string): string {
    return this.http.api(`/connection/end-users/me/listings/${encodeURIComponent(kind)}`);
  }
}
