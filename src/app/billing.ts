import type { Auth } from './auth';
import type { Http } from './http';
import { billingError, StoreBilling } from './store';

/**
 * Where the plan in force comes from: paid on the website (the publisher's Stripe), the App Store or Google Play - or
 * `grant`, given by an invite for some months with no payment (`app.invites`).
 */
export type PlanSource = 'web' | 'apple' | 'google' | 'grant';

/**
 * A plan given by an invite, for some months, with no payment. `active`: it is the plan in force now; false while a
 * paid plan is (paid always wins - the grant keeps its dates underneath, and is back if the paid plan ends first).
 */
export interface PlanGrant {
  planId: string;
  planName: string | null;
  startsAt: string;
  /** When the grant ends and the person is on the App's free plan again, keeping everything. */
  endsAt: string;
  active: boolean;
  /**
   * A subscription to the SAME plan is waiting to take over at `endsAt`: the card was collected at Checkout and
   * nothing is charged until then (the first charge is at `endsAt`; Plan.next then says the plan, `at` = `endsAt`,
   * `source: 'web'`). The person stays on the plan with no gap. False after it was cancelled in the portal, or
   * when there is none.
   */
  keepsAfterGrant: boolean;
}

/**
 * Where the person manages the plan in force. `stripe_portal`: {@link Billing.manage}. `apple`: StoreKit's
 * `showManageSubscriptions`, with `url` the App Store's page as a fallback. `google`: open `url`, Play's page
 * for the subscription. `billing.store.manage(plan)` turns it into what to open.
 */
export interface ManageLink {
  kind: 'stripe_portal' | 'apple' | 'google';
  url?: string | null;
}

/** An amount in the currency's smallest unit (412 is $4.12), and the ISO 4217 currency, lower case. */
export interface Money {
  amount: number;
  currency: string;
}

/**
 * The person paid twice - on the website and in a store - and the platform put it right (or could not).
 * `auto_cancelled`: the website subscription was cancelled and `refund` given back (shown for 30 days;
 * no `refund` when it could not be refunded automatically). `failed`: still paying twice - offer
 * {@link Billing.resolvePaidTwice} ("Cancel the website subscription"). `coveredBy`: the store that now
 * holds the plan.
 */
export interface PaidTwiceNotice {
  resolution: 'auto_cancelled' | 'failed';
  refund?: Money | null;
  coveredBy: 'apple' | 'google';
  at: string;
}

/** A change made in the store that takes effect at renewal: "Plus from <date>". */
export interface PlanChange {
  plan: string;
  name: string | null;
  from: string;
  /** `plan` again, under the name the App Kit reads. */
  planId?: string;
  /** `from` again: when the change takes effect - for a subscription waiting after a grant, the grant's `endsAt`. */
  at?: string;
  /** The new plan's interval, when known. */
  interval?: 'month' | 'year' | null;
  /** Where it was made: `web`, `apple` or `google`. A same-plan subscription waiting after a grant is `web`. */
  source?: 'web' | 'apple' | 'google' | null;
  /** The App can undo it (POST /plan/change/cancel): a website change the platform made. */
  canUndo?: boolean;
}

/** One way to pay for a plan: a Stripe price on the App publisher's account. */
export interface PlanPrice {
  /** The Stripe price id, `price_...` - what {@link Billing.checkout} takes. */
  id: string;
  interval: 'month' | 'year';
  /** In the currency's smallest unit: 799 is $7.99. */
  amountCents: number;
  /** ISO 4217, lower case: `usd`. */
  currency: string;
}

/** One of the App's plans. A plan with no prices is free. */
export interface PlanOption {
  id: string;
  name: string;
  /** The monthly AI allowance on this plan, in US dollars. */
  monthlyBudgetUsd: number;
  prices: PlanPrice[];
  /** What the plan unlocks in the App, in the App's own words (`full_plans`, `proposals`). */
  features?: string[];
  /** The free trial a checkout of this plan starts with, in days; null when the plan has none. */
  trialDays?: number | null;
  /**
   * Whether this person can still start that trial: the plan has one and they never had a trial of this
   * App (one per person per App - a cancelled trial does not give another).
   */
  trialAvailable?: boolean;
}

/** Where a person's monthly AI limit comes from ({@link Plan.monthlyBudgetSource}). */
export type MonthlyBudgetSource = 'PLAN' | 'APP' | 'PLATFORM_DEFAULT' | 'UNLIMITED' | 'NONE';

/** The person's plan in the App, and the App's plans. */
export interface Plan {
  /**
   * Whether the App sells plans. When false, everyone has the App's one allowance, `monthlyBudgetUsd` - its per-person
   * cap, or the platform default when it sets none.
   */
  enabled: boolean;
  /** The plan in force, e.g. `free` or `plus`; null when the App sells none. */
  plan: string | null;
  name: string | null;
  /**
   * The monthly AI limit the person is held to, in US dollars: their plan's; in an App that sells no plans, the App's
   * per-person cap, else the platform's default ($5 a month). Null only when no limit applies - `unlimited` is then
   * true, and `monthlyBudgetSource` says why.
   */
  monthlyBudgetUsd: number | null;
  /**
   * Where `monthlyBudgetUsd` comes from: `PLAN`, `APP` (the publisher's per-person cap), `PLATFORM_DEFAULT`,
   * `UNLIMITED` (the publisher chose no cap) or `NONE` (the App set none and gets no platform default). Absent from
   * servers before the platform default.
   */
  monthlyBudgetSource?: MonthlyBudgetSource;
  /** True when no monthly AI limit applies to the person (`monthlyBudgetUsd` is then null). Absent from older servers. */
  unlimited?: boolean;
  /** Whether it is a paid plan. False on a grant from an invite: nobody is paying. */
  paid: boolean;
  /**
   * The subscription's status: `active`, `trialing`, `past_due`, `canceled`... (a store subscription's too:
   * `grace` while the store retries a payment); `grant` on a plan given by an invite; null when nothing was bought.
   */
  status: string | null;
  /** When a paid plan renews (ISO time) - null when it is cancelling, and on a grant. */
  renewsAt: string | null;
  /** When a cancelled plan ends, or ended (ISO time); on a grant, when the grant ends. */
  endsAt: string | null;
  /** Cancelled in the portal: the plan stays until `endsAt`, then the default plan. */
  cancelAtPeriodEnd: boolean;
  /**
   * Whether {@link Billing.checkout} can be offered: the App takes payments and the person has no paid plan -
   * false too while an App Store or Google Play subscription is live. True on a grant: offer "Subscribe" (never
   * "Switch"). See {@link Plan.grant} for what subscribing during a grant does.
   */
  canUpgrade: boolean;
  /** Whether {@link Billing.manage} can be offered: the person has bought something. */
  canManage: boolean;
  /** The plan everyone starts on. */
  defaultPlan: string | null;
  plans: PlanOption[];
  /** What the person's plan unlocks in the App - also in their token, for the App's own server to check. */
  features?: string[];
  /** When the person's free trial ends (ISO time), while `status` is `trialing`; null otherwise. */
  trialEndsAt?: string | null;
  /**
   * Whether Stripe holds a card for the person's subscription. A trial started without one ends at
   * `trialEndsAt` and the person drops back to the default plan (their data stays) - say "add a card to
   * keep Plus" and send them to {@link Billing.manage}.
   */
  hasPaymentMethod?: boolean;
  /** Where the plan in force is paid; null on the default plan. */
  source?: PlanSource | null;
  /** Where to manage it - see `billing.store.manage(plan)`; null on the default plan. */
  manage?: ManageLink | null;
  /** Other places charging the person too: the website while live; a store while it actually charges. */
  otherPaying?: PlanSource[];
  /** The website and a store are both charging - the platform cancels the website one (see `paidTwiceNotice`). */
  paidTwice?: boolean;
  /** The banner to show about paying twice, or null. */
  paidTwiceNotice?: PaidTwiceNotice | null;
  /** A downgrade made in the store that starts at renewal, or null. */
  next?: PlanChange | null;
  /**
   * Whether the plan can be switched on the website now (`/plan/change`): a live website subscription in good
   * standing. Never on a grant - there is no subscription to switch; offer {@link Billing.checkout} instead.
   */
  canChange?: boolean;
  /**
   * The person's running grant from an invite, also while a paid plan wins (`active: false`); null when none.
   *
   * While a grant is in force no free trial is offered (`trialAvailable` is false on every plan). Subscribing never
   * cuts the grant short when it is the SAME plan: Checkout collects the card and the first charge is at the grant's
   * end (`firstChargeAt` from {@link Billing.checkoutLink}; then `grant.keepsAfterGrant` and `next`). Subscribing to
   * a DIFFERENT plan (or buying in the App Store or Google Play) starts and charges it at once and ENDS the grant -
   * say so before Checkout.
   */
  grant?: PlanGrant | null;
}

/** A Checkout page, as {@link Billing.checkoutLink} answers it. */
export interface CheckoutLink {
  /** Stripe Checkout's address. */
  url: string;
  /** The free trial it starts with, in days; null when none (always null during a grant). */
  trialDays: number | null;
  /**
   * When the first charge is (ISO time) when it is not now: the grant's end, for a subscription to the same plan
   * as the person's grant (card now, charged then). Null otherwise - charged at once, or after `trialDays`.
   */
  firstChargeAt: string | null;
}

export interface CheckoutOptions {
  /** One of the App's prices (`plans[].prices[].id`). */
  priceId: string;
  /** Where Stripe sends the person after paying - on one of the App's own web origins. Defaults to its first. */
  successUrl?: string;
  /** Where Stripe sends them if they go back - on one of the App's own web origins. */
  cancelUrl?: string;
  /**
   * Take the plan's free trial, if it has one and the person never had a trial of this App (the default),
   * or `false` to buy now with no trial.
   */
  trial?: boolean;
  /** Go to the page (default), or only return its address for the App to open itself. */
  open?: boolean;
}

export interface ManageOptions {
  /** Where the portal's "back" goes - on one of the App's own web origins. */
  returnUrl?: string;
  /** Go to the portal (default), or only return its address. */
  open?: boolean;
}

/**
 * The person's plan in the App - paid plans the App's publisher sells, through the publisher's own
 * Stripe account. Paying and managing happen on Stripe's hosted pages; the App never sees a card.
 *
 * A plan sets the person's monthly AI allowance. It comes with their next platform token, so after a
 * checkout call {@link Billing.refresh} when they come back.
 */
export class Billing {
  /** The plans in the App's own iOS and Android apps, bought through the App Store and Google Play. */
  readonly store: StoreBilling;

  constructor(private readonly http: Http, private readonly auth: Auth) {
    this.store = new StoreBilling(http, auth);
  }

  /** The person's plan, and the App's plans with their prices. `sync` first asks Stripe how things stand. */
  plan(options: { sync?: boolean } = {}): Promise<Plan> {
    return this.http.request<Plan>('GET', this.http.api(`/connection/end-users/me/plan${options.sync ? '?sync=true' : ''}`));
  }

  /**
   * Buy a plan: Stripe Checkout for one of the App's prices. Goes there (the system browser on a phone,
   * through `openUrl`) and also returns the address. A plan with a free trial starts with it, once per
   * person per App, unless `trial: false`.
   */
  async checkout(options: CheckoutOptions): Promise<string> {
    return (await this.checkoutLink(options)).url;
  }

  /**
   * {@link checkout}, answering the whole Checkout link: its `url`, the free trial it starts with (`trialDays`) and
   * when the first charge is when not now (`firstChargeAt`: the grant's end, for a same-plan subscription during a
   * grant) - so the App can say "Nothing to pay until Jan 25". Goes there too, unless `open: false`.
   */
  async checkoutLink(options: CheckoutOptions): Promise<CheckoutLink> {
    const { open = true, trial, ...rest } = options;
    const body: Record<string, unknown> = { ...rest };
    if (trial !== undefined) body.trial = trial;
    const answer = await this.http.request<{ url: string; trialDays?: number | null; firstChargeAt?: string | null }>(
      'POST',
      this.http.api('/connection/end-users/me/checkout'),
      body,
    );
    if (open) await this.go(answer.url);
    return { url: answer.url, trialDays: answer.trialDays ?? null, firstChargeAt: answer.firstChargeAt ?? null };
  }

  /** Stripe's customer portal: change the card, see invoices, cancel. Goes there and returns the address. */
  async manage(options: ManageOptions = {}): Promise<string> {
    const { open = true, ...body } = options;
    const { url } = await this.http.request<{ url: string }>('POST', this.http.api('/connection/end-users/me/billing-portal'), body);
    if (open) await this.go(url);
    return url;
  }

  /**
   * After a checkout (or the portal): ask Stripe how the person's plan stands, then get a fresh platform
   * token, which carries the new allowance. Returns the plan.
   */
  async refresh(): Promise<Plan> {
    const plan = await this.plan({ sync: true });
    await this.auth.renew();
    return plan;
  }

  /**
   * The banner's one tap when `paidTwiceNotice.resolution` is `failed`: cancel the website subscription
   * now and refund its unused part. Returns the plan. Refused (`AppError` 502, `PAID_TWICE_UNRESOLVED`)
   * while Stripe still refuses - the platform keeps trying meanwhile.
   */
  async resolvePaidTwice(): Promise<Plan> {
    try {
      return await this.http.request<Plan>('POST', this.http.api('/connection/end-users/me/plan/paid-twice/resolve'));
    } catch (e) {
      throw billingError(e);
    }
  }

  private async go(url: string) {
    if (this.http.config.openUrl) await this.http.config.openUrl(url);
    else if (typeof location !== 'undefined') location.assign(url);
  }
}
