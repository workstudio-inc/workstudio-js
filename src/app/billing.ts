import type { Auth } from './auth';
import type { Http } from './http';

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
}

/** The person's plan in the App, and the App's plans. */
export interface Plan {
  /** Whether the App sells plans. When false, everyone has the App's one allowance, `monthlyBudgetUsd`. */
  enabled: boolean;
  /** The plan in force, e.g. `free` or `plus`; null when the App sells none. */
  plan: string | null;
  name: string | null;
  /** This plan's monthly AI allowance in US dollars; null when there is no limit. */
  monthlyBudgetUsd: number | null;
  /** Whether it is a paid plan. */
  paid: boolean;
  /** Stripe's subscription status: `active`, `trialing`, `past_due`, `canceled`...; null when nothing was bought. */
  status: string | null;
  /** When a paid plan renews (ISO time) - null when it is cancelling. */
  renewsAt: string | null;
  /** When a cancelled plan ends, or ended (ISO time). */
  endsAt: string | null;
  /** Cancelled in the portal: the plan stays until `endsAt`, then the default plan. */
  cancelAtPeriodEnd: boolean;
  /** Whether {@link Billing.checkout} can be offered: the App takes payments and the person has no paid plan. */
  canUpgrade: boolean;
  /** Whether {@link Billing.manage} can be offered: the person has bought something. */
  canManage: boolean;
  /** The plan everyone starts on. */
  defaultPlan: string | null;
  plans: PlanOption[];
}

export interface CheckoutOptions {
  /** One of the App's prices (`plans[].prices[].id`). */
  priceId: string;
  /** Where Stripe sends the person after paying - on one of the App's own web origins. Defaults to its first. */
  successUrl?: string;
  /** Where Stripe sends them if they go back - on one of the App's own web origins. */
  cancelUrl?: string;
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
  constructor(private readonly http: Http, private readonly auth: Auth) {}

  /** The person's plan, and the App's plans with their prices. `sync` first asks Stripe how things stand. */
  plan(options: { sync?: boolean } = {}): Promise<Plan> {
    return this.http.request<Plan>('GET', this.http.api(`/connection/end-users/me/plan${options.sync ? '?sync=true' : ''}`));
  }

  /**
   * Buy a plan: Stripe Checkout for one of the App's prices. Goes there (the system browser on a phone,
   * through `openUrl`) and also returns the address.
   */
  async checkout(options: CheckoutOptions): Promise<string> {
    const { open = true, ...body } = options;
    const { url } = await this.http.request<{ url: string }>('POST', this.http.api('/connection/end-users/me/checkout'), body);
    if (open) await this.go(url);
    return url;
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

  private async go(url: string) {
    if (this.http.config.openUrl) await this.http.config.openUrl(url);
    else if (typeof location !== 'undefined') location.assign(url);
  }
}
