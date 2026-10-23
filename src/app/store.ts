import type { Auth } from './auth';
import type { ManageLink, Plan, PlanSource } from './billing';
import { AppError } from './errors';
import type { Http } from './http';

/**
 * The App's plans in its own iOS and Android apps, bought through the App Store and Google Play. The SDK
 * never touches StoreKit or Play Billing: the app buys with its own plugin and hands the SDK what the
 * store returned - a transaction's JWS on iOS, a purchase token on Android. The platform verifies every
 * purchase with Apple or Google itself; nothing the app says about a purchase is trusted.
 */

export type StorePlatform = 'ios' | 'android';

export interface StoreOfferOptions {
  platform: StorePlatform;
  /**
   * What the store says the person's storefront is: iOS `Storefront.current.countryCode` (alpha-3, `USA`),
   * Android Play Billing `getBillingConfigAsync().countryCode` (alpha-2, `US`). Without it, link-out never
   * applies and the paywall's words never name the website.
   */
  storefront?: string;
  /**
   * iOS: `AppTransaction.shared.appTransactionID`. With it, each Apple product comes with a signed
   * introductory-offer eligibility, so Apple gives the free trial only while the person's one trial
   * (across the web and both stores) is unused.
   */
  appTransactionId?: string;
}

/** The website's price for the same plan and interval, in the currency's smallest unit (4900 is $49.00). */
export interface WebPrice {
  amount: number;
  currency: string;
  interval: 'month' | 'year';
}

/** What sells one interval of a plan in this store. The store's own localized price is the one to show. */
export interface StoreProduct {
  interval: 'month' | 'year';
  /** iOS only. */
  apple?: {
    productId: string;
    /** Pass at purchase as `.introductoryOfferEligibility(compactJWS:)`; present only when `appTransactionId` was sent. */
    introductoryOfferEligibilityJws?: string;
  };
  /** Android only. */
  google?: {
    productId: string;
    basePlanId: string;
    /**
     * The free-trial offer to buy with, only while the person's trial is unused: pick the matching
     * `offerToken` from Play's `ProductDetails`. Absent: use the base plan's own offer token.
     */
    offerId?: string;
  };
  /** Only when link-out applies here (`linkOut` is set): "$11.99 here, or $9.99 on the website". */
  webPrice?: WebPrice;
}

export interface StoreOfferPlan {
  id: string;
  name: string;
  monthlyBudgetUsd?: number;
  features?: string[];
  /** False: show the plan without Buy - the same as, or lower than, the plan the person pays for elsewhere. */
  canBuy: boolean;
  products: StoreProduct[];
}

export interface StoreTrial {
  /** Whether the person may still have the free trial: one per person per App, across the web and both stores. */
  eligible: boolean;
  days?: number;
  /** iOS: false when there was nothing to sign for (no `appTransactionId`) - Apple then decides the trial on its own. */
  enforced?: boolean;
}

/** The plan in force, and where it is managed. */
export interface StoreCurrent {
  plan: string;
  name?: string;
  source?: PlanSource;
  manage?: ManageLink;
}

/** What the app's paywall shows. Prices are never in it: show StoreKit's or Play's localized price. */
export interface StoreOffer {
  platform: StorePlatform;
  storefront?: string;
  /** Pass at purchase as `appAccountToken` (iOS) or `obfuscatedAccountId` (Android). Never make one up. */
  storeAccountToken: string;
  /** Whether any plan can be bought here. False: hide Buy and show `message`. */
  canBuy: boolean;
  /** What to say instead of Buy, worded for the storefront (outside link-out it never names the website). */
  message?: string;
  /**
   * Buying here cancels the person's live website subscription and refunds its unused part (an upgrade
   * from the website). Show `upgradeNotice` before the purchase.
   */
  cancelsCurrent: boolean;
  upgradeNotice?: string;
  /** Empty when the App cannot sell in this store just now (then `canBuy` is false and `message` says so). */
  plans: StoreOfferPlan[];
  /** Absent when no plan has a trial. */
  trial?: StoreTrial;
  /** Absent on the default plan. */
  current?: StoreCurrent;
  /**
   * The website's plans page, to open in the system browser (never an in-app view) - only where link-out
   * applies (an App Store storefront the publisher turned it on for). Its address carries `login_hint`.
   */
  linkOut?: { url: string };
}

/** A purchase the app made, as the store returned it. */
export type StorePurchase =
  /** `Transaction.jwsRepresentation`. */
  | { platform: 'ios'; jws: string }
  /** The purchase's `purchaseToken`. */
  | { platform: 'android'; purchaseToken: string };

/** Everything the store has for this store account. */
export type StoreRestore =
  /** Every `Transaction.currentEntitlements`, after `AppStore.sync()`. */
  | { platform: 'ios'; jws: string[] }
  /** Every purchase from `queryPurchasesAsync`. */
  | { platform: 'android'; purchaseTokens: string[] };

/**
 * What became of one restored purchase: `bound` (now the person's), `already` (it was), `invalid` (not a
 * purchase of this app), `unknown_product` (not one of the App's plans), `unavailable` (the store could
 * not be reached - restore again later), or `STORE_PURCHASE_OTHER_ACCOUNT` (another account's in this App).
 */
export type RestoreResult = 'bound' | 'already' | 'invalid' | 'unknown_product' | 'unavailable' | 'STORE_PURCHASE_OTHER_ACCOUNT';

export interface RestoredPurchase {
  /** The purchase's place in the list sent (after blanks and repeats were dropped). */
  id: string;
  result: RestoreResult;
  /** The JWS or purchase token it was about. */
  purchase: string;
}

export interface Restored {
  plan: Plan;
  items: RestoredPurchase[];
}

/**
 * Where to send the person to manage the plan in force:
 *
 * - `apple`: call StoreKit's `AppStore.showManageSubscriptions(in:)` (a plugin's `manageSubscriptions()`);
 *   off an iPhone, or if that fails, open `fallbackUrl`;
 * - `google`: open `url`, Play's page for the subscription;
 * - `stripe_portal`: the website subscription - call `billing.manage()`.
 */
export type ManageTarget =
  | { kind: 'apple'; open: 'showManageSubscriptions'; fallbackUrl: string }
  | { kind: 'google'; url: string }
  | { kind: 'stripe_portal' };

export const APPLE_SUBSCRIPTIONS_URL = 'https://apps.apple.com/account/subscriptions';
export const GOOGLE_SUBSCRIPTIONS_URL = 'https://play.google.com/store/account/subscriptions';

/** A plan, an offer's `current`, or a `manage` itself: where to manage it, or null when there is nothing to manage. */
export function manageTarget(from: Plan | StoreCurrent | ManageLink | null | undefined): ManageTarget | null {
  const manage = !from ? null : 'kind' in from ? (from as ManageLink) : (from as { manage?: ManageLink | null }).manage ?? null;
  if (!manage) return null;
  if (manage.kind === 'apple') return { kind: 'apple', open: 'showManageSubscriptions', fallbackUrl: manage.url || APPLE_SUBSCRIPTIONS_URL };
  if (manage.kind === 'google') return { kind: 'google', url: manage.url || GOOGLE_SUBSCRIPTIONS_URL };
  if (manage.kind === 'stripe_portal') return { kind: 'stripe_portal' };
  return null;
}

/** One live App Store or Google Play subscription, as deleting the account will leave it. */
export interface StoreSubscriptionSummary {
  store: 'apple' | 'google';
  plan?: string;
  productId?: string;
  expiresAt?: string;
  autoRenew: boolean;
  manage?: ManageLink;
  /** Google: the platform cancels it when the account is deleted. Apple: it cannot - the person must, in the App Store. */
  cancelledByServerOnDeletion: boolean;
}

/**
 * Before deleting the account (Apple guideline 5.1.1(v)). With `appleSubscription`, tell the person Apple
 * keeps billing until they cancel in the App Store, offer its manage link (`billing.store.manage(sub.manage)`),
 * then delete at once if they confirm. Google subscriptions are cancelled by the platform on deletion.
 */
export interface DeletionCheck {
  storeSubscriptions: StoreSubscriptionSummary[];
  appleSubscription: boolean;
  googleSubscription: boolean;
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/**
 * The store subscription belongs to another account in this App - the same Apple ID or Google account
 * was used by someone else here first. Show `message` ("Sign in with that account"); the other account is
 * never named.
 */
export class StorePurchaseOtherAccount extends AppError {
  constructor(message = 'This subscription belongs to another account in this app. Sign in with that account.', details?: Record<string, unknown>) {
    super(409, message, 'STORE_PURCHASE_OTHER_ACCOUNT', details);
    this.name = 'StorePurchaseOtherAccount';
    Object.setPrototypeOf(this, StorePurchaseOtherAccount.prototype);
  }
}

/** Too many verifies or restores by this person just now (30 verifies, 6 restores in 10 minutes). Wait, then try again. */
export class TooManyTries extends AppError {
  constructor(message = 'Too many tries. Please wait a few minutes and try again.', details?: Record<string, unknown>) {
    super(429, message, 'SLOW_DOWN', details);
    this.name = 'TooManyTries';
    Object.setPrototypeOf(this, TooManyTries.prototype);
  }
}

/** A restore sent more than 20 different purchases. */
export class TooManyPurchases extends AppError {
  constructor(message = 'Send at most 20 purchases at once.', details?: Record<string, unknown>) {
    super(400, message, 'TOO_MANY_PURCHASES', details);
    this.name = 'TooManyPurchases';
    Object.setPrototypeOf(this, TooManyPurchases.prototype);
  }
}

/**
 * Not now: Apple or Google could not be reached (`STORE_UNAVAILABLE`), or the platform could not count
 * the person's tries and so refused rather than let them through (`UNAVAILABLE`). Nothing was changed;
 * try again in a moment. A purchase is kept by the store meanwhile - verify it again later.
 */
export class BillingUnavailable extends AppError {
  constructor(message = 'This can’t be done just now. Please try again in a moment.', code: 'UNAVAILABLE' | 'STORE_UNAVAILABLE' = 'UNAVAILABLE',
    details?: Record<string, unknown>) {
    super(503, message, code, details);
    this.name = 'BillingUnavailable';
    Object.setPrototypeOf(this, BillingUnavailable.prototype);
  }
}

/** The typed error for a billing refusal, or the error itself. */
export function billingError(e: unknown): unknown {
  if (!(e instanceof AppError) || e.constructor !== AppError) return e;
  if (e.code === 'STORE_PURCHASE_OTHER_ACCOUNT') return new StorePurchaseOtherAccount(e.message, e.details);
  if (e.code === 'TOO_MANY_PURCHASES') return new TooManyPurchases(e.message, e.details);
  if (e.status === 429 || e.code === 'SLOW_DOWN') return new TooManyTries(e.message, e.details);
  if (e.status === 503) return new BillingUnavailable(e.message, e.code === 'STORE_UNAVAILABLE' ? 'STORE_UNAVAILABLE' : 'UNAVAILABLE', e.details);
  return e;
}

// ---------------------------------------------------------------------------------------------

/** `app.billing.store`: the paywall's offer, purchases and restores in the App's iOS and Android apps. */
export class StoreBilling {
  constructor(private readonly http: Http, private readonly auth: Auth) {}

  /**
   * What the paywall shows here: the plans sold in this store (product ids, Google's base plan and trial
   * offer), the person's `storeAccountToken`, the trial, the plan in force and where to manage it,
   * whether Buy is shown (`canBuy`, `message`), and link-out. Ask each time the paywall opens: the
   * publisher can change any of it without an app release.
   */
  async offer(options: StoreOfferOptions): Promise<StoreOffer> {
    const q = new URLSearchParams({ platform: platformOf(options.platform) });
    if (options.storefront) q.set('storefront', options.storefront.trim().toUpperCase());
    if (options.appTransactionId) q.set('appTransactionId', options.appTransactionId);
    return this.call<StoreOffer>('GET', `/store/offer?${q}`);
  }

  /**
   * After a purchase: the platform verifies it with Apple or Google, makes it the person's, and answers
   * their plan - then the SDK gets a fresh token with the new allowance. Finish the transaction (iOS) once
   * this returns; on a {@link BillingUnavailable} keep it and verify again later.
   *
   * Throws {@link StorePurchaseOtherAccount}, {@link TooManyTries}, {@link BillingUnavailable}, or an
   * `AppError` with `STORE_PURCHASE_INVALID` / `UNKNOWN_PRODUCT` / `NO_PURCHASE`.
   */
  async verify(purchase: StorePurchase): Promise<Plan> {
    const platform = platformOf(purchase.platform);
    const body = platform === 'ios'
      ? { platform, jws: (purchase as { jws?: string }).jws }
      : { platform, purchaseToken: (purchase as { purchaseToken?: string }).purchaseToken };
    const plan = await this.call<Plan>('POST', '/store/verify', body);
    await this.renew();
    return plan;
  }

  /**
   * "Restore purchases": everything the store has for this Apple ID or Google account, in one call (at
   * most 20 different ones). Each is verified and made the person's as a purchase is; `items` says how
   * each went. Throws {@link StorePurchaseOtherAccount} only when every one is another account's.
   */
  async restore(restore: StoreRestore): Promise<Restored> {
    const platform = platformOf(restore.platform);
    const given = platform === 'ios' ? (restore as { jws?: string[] }).jws : (restore as { purchaseTokens?: string[] }).purchaseTokens;
    // Dropped as the platform drops them, so each answer's id points back at the purchase it is about.
    const purchases = [...new Set((given ?? []).filter(p => typeof p === 'string' && p.trim()).map(p => p.trim()))];
    const body = platform === 'ios' ? { platform, jws: purchases } : { platform, purchaseTokens: purchases };
    const answer = await this.call<{ plan: Plan; items: Array<{ id: string; result: RestoreResult }> }>('POST', '/store/restore', body);
    await this.renew();
    return {
      plan: answer.plan,
      items: (answer.items ?? []).map(it => ({ ...it, purchase: purchases[Number(it.id)] ?? '' })),
    };
  }

  /** Where to manage the plan in force - see {@link ManageTarget}. Null when there is nothing to manage. */
  manage(from: Plan | StoreCurrent | ManageLink | null | undefined): ManageTarget | null {
    return manageTarget(from);
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    try {
      return await this.http.request<T>(method, this.http.api(`/connection/end-users/me${path}`), body);
    } catch (e) {
      throw billingError(e);
    }
  }

  /** A fresh token carries the new allowance; the purchase stands whether or not this works. */
  private async renew() {
    try {
      await this.auth.renew();
    } catch {
      // The next token refresh brings it.
    }
  }
}

function platformOf(platform: string): StorePlatform {
  const p = String(platform ?? '').trim().toLowerCase();
  if (p !== 'ios' && p !== 'android') throw new AppError(400, 'platform is ios or android.', 'BAD_PLATFORM');
  return p;
}
