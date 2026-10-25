import { AppError, NotForYourPlan, SignInRequired } from './errors';
import type { Http } from './http';

/** What the App calls its credits: `{ name: 'credits', one: 'credit' }`. */
export interface CreditUnit {
  name: string;
  one: string;
}

/**
 * The person's credits in the App - one balance every action draws on. Whole numbers, never below 0, never money.
 * The plan's monthly credits are spent first, then credits they bought, which never expire.
 */
export interface CreditBalance {
  unit: CreditUnit;
  /** What they can use now: `monthly.left + bought.left`. */
  available: number;
  /** The plan's credits: `period` `month` (they start again on `resetsOn`) or `once` (starter credits). Nulls: no limit. */
  monthly: { left: number | null; total: number | null; period: 'month' | 'once'; resetsOn: string | null };
  /** Credits they bought and have not used. */
  bought: { left: number };
  /** `low` below `lowAt`; `empty` at 0. */
  state: 'ok' | 'low' | 'empty';
  lowAt?: number | null;
  /** Free quick changes when empty (not yet: always null). */
  whenEmpty?: { agents: string[]; leftToday: number } | null;
  /** The App's "about N" figures: `{ design: 25, picture: 3 }`. */
  hints?: Record<string, number>;
  plan?: string;
  /** Whole credits the action that said this took (a chat turn's `credits` event, a picture). */
  used?: number;
}

export interface CreditsOptions {
  /** Reuse an answer up to this old, in milliseconds. Default 30 seconds; 0 asks again. */
  maxAgeMs?: number;
}

/** About how many credits an action uses: `basis` `price` (a picture's price) or `hint` (the App's own figure). */
export interface CreditEstimate {
  action: 'picture' | 'design';
  credits: number;
  basis: 'price' | 'hint';
}

export interface CreditEstimateOptions {
  model?: string;
  size?: string;
  quality?: string;
}

/** One credit pack and what sells it here. `web.amount` is in the currency's minor unit. */
export interface CreditPack {
  id: string;
  credits: number;
  web?: { priceId: string; amount: number; currency: string };
  apple?: { productId: string };
  google?: { productId: string };
}

export type CreditPacksWhy = 'NOT_FOR_YOUR_PLAN' | 'PAYMENTS_NOT_SET_UP' | 'IN_APP_NOT_YET' | 'NO_PACKS';

export interface CreditPacks {
  unit: CreditUnit;
  packs: CreditPack[];
  canBuy: boolean;
  /** Why not, when `canBuy` is false; `message` is what to show. */
  why?: CreditPacksWhy | null;
  message?: string | null;
  /** Who may buy: plan ids (empty: everyone). */
  forPlans: string[];
  /** Credits the person bought and has not used. */
  bought: number;
  /** iOS in a link-out storefront: the website's page, where web prices apply. */
  linkOut?: { url: string } | null;
}

export interface CreditPacksOptions {
  platform?: 'web' | 'ios' | 'android';
  /** The store's storefront code (iOS alpha-3, Android alpha-2). */
  storefront?: string;
}

export interface BuyOptions {
  /** Where Stripe sends the person back; on the App's own web addresses (default its first). */
  successUrl?: string;
  cancelUrl?: string;
  /** Go to Checkout (default); false only returns the address. */
  redirect?: boolean;
  /** Packs are bought on the web for now; `ios` and `android` are refused (`IN_APP_NOT_YET`). */
  platform?: 'web' | 'ios' | 'android';
}

/** One line of the person's bought-credits history: a purchase, a refund, a day's use. */
export interface CreditHistoryEntry {
  id: string;
  at: string;
  kind: 'PURCHASE' | 'USE' | 'USE_REVERSED' | 'REFUND' | 'GRANT' | 'REVOKE' | string;
  /** Signed whole credits: + added, - taken. */
  credits: number;
  /** Words to show: "Bought 450", "Used 37". */
  label: string;
  packId?: string;
  /** PURCHASE bought on the website only: what was paid, in the currency's minor unit (999 = $9.99). */
  paid?: CreditMoney;
  /** PURCHASE bought on the website only: how much of it has been refunded so far (0 when none). */
  refunded?: CreditMoney;
  /** REFUND only: the `id` of the PURCHASE entry it refunded. */
  purchaseId?: string;
}

/** An amount in the currency's minor unit (999 = $9.99) and its ISO currency, lower case. */
export interface CreditMoney {
  amount: number;
  currency: string;
}

export interface CreditHistory {
  entries: CreditHistoryEntry[];
  /** Pass back as `cursor` for the next page; null at the end. */
  next: string | null;
}

/**
 * The person's credits: what they have, what things use, and buying more.
 *
 * - `balance()` asks the platform (cached 30 s); `onChange` hears every balance it says - after each chat turn,
 *   with each picture, and every `balance()` - so a pill at the top of the App counts down without polling.
 * - `estimate('picture')` and `estimate('design')` give "about N" for the buttons that start them.
 * - `packs()` and `buy()` sell credit packs (web: Stripe Checkout on the publisher's account).
 * - `history()` lists bought credits: purchases, refunds, a line per day of use.
 */
export class Credits {
  private cached: { credits: CreditBalance; at: number } | null = null;
  private inFlight: Promise<CreditBalance> | null = null;
  private readonly listeners = new Set<(c: CreditBalance) => void>();

  constructor(private readonly http: Http) {
    this.http.onCredits(raw => {
      const c = read(raw);
      if (c) this.seen(c);
    });
  }

  /** The person's credits now. */
  async balance(options: CreditsOptions = {}): Promise<CreditBalance> {
    const maxAge = options.maxAgeMs ?? 30_000;
    if (this.cached && Date.now() - this.cached.at <= maxAge) return this.cached.credits;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.http
      .request<Record<string, unknown>>('GET', `${this.http.config.aiRuntimeUrl}/api/v1/workflow/ai-runtime/sessions/mine/credits`)
      .then(raw => {
        const c = read(raw);
        if (!c) throw new AppError(502, 'Your credits could not be read just now.', 'UNAVAILABLE');
        this.seen(c);
        return c;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /** Hear every balance the platform says. Returns a function that stops listening. */
  onChange(listener: (c: CreditBalance) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Forget the cached balance, e.g. back from buying a pack. */
  forget(): void {
    this.cached = null;
  }

  /** About how many credits a picture or a new design uses. */
  async estimate(action: 'picture' | 'design', options: CreditEstimateOptions = {}): Promise<CreditEstimate> {
    const q = new URLSearchParams({ action });
    for (const k of ['model', 'size', 'quality'] as const) if (options[k]) q.set(k, options[k]!);
    return this.http.request<CreditEstimate>('GET', `${this.http.config.aiRuntimeUrl}/api/v1/workflow/ai-runtime/sessions/mine/credits/estimate?${q}`);
  }

  /** The App's credit packs, and whether this person can buy one here. */
  async packs(options: CreditPacksOptions = {}): Promise<CreditPacks> {
    const q = new URLSearchParams({ platform: options.platform ?? 'web' });
    if (options.storefront) q.set('storefront', options.storefront);
    const body = await this.http.request<CreditPacks>('GET', this.http.api(`/connection/end-users/me/credits/packs?${q}`));
    return { ...body, packs: body?.packs ?? [], forPlans: body?.forPlans ?? [], bought: body?.bought ?? 0 };
  }

  /**
   * Buy a pack: Stripe Checkout on the website (goes there unless `redirect: false`) and returns its address. The
   * credits arrive once Stripe says it is paid - `forget()` and `balance()` on coming back.
   * @throws NotForYourPlan when the person's plan does not sell packs
   */
  async buy(packId: string, options: BuyOptions = {}): Promise<{ url: string }> {
    const platform = options.platform ?? 'web';
    if (platform !== 'web') {
      throw new AppError(409, 'Credit packs can’t be bought in this app just now.', 'IN_APP_NOT_YET');
    }
    let url: string;
    try {
      ({ url } = await this.http.request<{ url: string }>('POST', this.http.api('/connection/end-users/me/credits/checkout'), {
        packId,
        ...(options.successUrl ? { successUrl: options.successUrl } : {}),
        ...(options.cancelUrl ? { cancelUrl: options.cancelUrl } : {}),
      }));
    } catch (e) {
      if (!(e instanceof SignInRequired) && e instanceof AppError && e.code === 'NOT_FOR_YOUR_PLAN') throw new NotForYourPlan(e.message, e.details);
      throw e;
    }
    this.cached = null;
    if (options.redirect !== false) {
      if (this.http.config.openUrl) await this.http.config.openUrl(url);
      else if (typeof location !== 'undefined') location.assign(url);
    }
    return { url };
  }

  /** The person's bought credits, newest first. */
  async history(options: { cursor?: string; limit?: number } = {}): Promise<CreditHistory> {
    const q = new URLSearchParams();
    if (options.cursor) q.set('cursor', options.cursor);
    if (options.limit) q.set('limit', String(options.limit));
    const body = await this.http.request<CreditHistory>('GET', this.http.api(`/connection/end-users/me/credits/history${q.size ? `?${q}` : ''}`));
    return { entries: body?.entries ?? [], next: body?.next ?? null };
  }

  private seen(c: CreditBalance) {
    this.cached = { credits: c, at: Date.now() };
    for (const l of this.listeners) {
      try {
        l(c);
      } catch {
        // A listener's own failure is its own.
      }
    }
  }
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const whole = (v: unknown) => Math.max(0, Math.floor(num(v) ?? 0));

/** A balance as the platform said it - the /credits answer, a stream event, a picture's `credits` - or null. */
export function read(raw: Record<string, unknown> | null | undefined): CreditBalance | null {
  if (!raw || typeof raw !== 'object' || typeof raw.available !== 'number') return null;
  const unit = (raw.unit ?? {}) as Record<string, unknown>;
  const m = (raw.monthly ?? {}) as Record<string, unknown>;
  const b = (raw.bought ?? {}) as Record<string, unknown>;
  const available = whole(raw.available);
  const state = raw.state === 'low' || raw.state === 'empty' || raw.state === 'ok' ? raw.state : available === 0 ? 'empty' : 'ok';
  return {
    unit: { name: typeof unit.name === 'string' ? unit.name : 'credits', one: typeof unit.one === 'string' ? unit.one : 'credit' },
    available,
    monthly: {
      left: num(m.left) === null ? null : whole(m.left),
      total: num(m.total) === null ? null : whole(m.total),
      period: m.period === 'once' ? 'once' : 'month',
      resetsOn: typeof m.resetsOn === 'string' ? m.resetsOn : null,
    },
    bought: { left: whole(b.left) },
    state,
    lowAt: num(raw.lowAt),
    whenEmpty: (raw.whenEmpty as CreditBalance['whenEmpty']) ?? null,
    hints: raw.hints && typeof raw.hints === 'object' ? (raw.hints as Record<string, number>) : undefined,
    plan: typeof raw.plan === 'string' ? raw.plan : undefined,
    used: num(raw.used) === null ? undefined : whole(raw.used),
  };
}
