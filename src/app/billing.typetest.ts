// Compile-time only (npm run typecheck; not exported, not bundled): the trial fields are public types.
import type { CheckoutOptions, Plan, PlanOption } from './billing';
import type { InvitePreview, InviteRedemption } from './invites';
import type { DeletionCheck, ManageTarget, StoreOffer, StorePurchase, StoreRestore } from './store';
import { manageTarget } from './store';

export const trialOption: PlanOption = {
  id: 'pro', name: 'Pro', monthlyBudgetUsd: 20, prices: [], trialDays: 14, trialAvailable: true,
};
export const trialPlan: Pick<Plan, 'trialEndsAt' | 'hasPaymentMethod'> = { trialEndsAt: null, hasPaymentMethod: false };
export const buyNow: CheckoutOptions = { priceId: 'price_pro', trial: false };

// App Store and Google Play: the plan's new fields, the offer, purchases and the manage helper.

export const storePlan: Pick<Plan, 'source' | 'manage' | 'otherPaying' | 'paidTwice' | 'paidTwiceNotice' | 'next'> = {
  source: 'apple',
  manage: { kind: 'apple', url: 'https://apps.apple.com/account/subscriptions' },
  otherPaying: ['web'],
  paidTwice: true,
  paidTwiceNotice: { resolution: 'auto_cancelled', refund: { amount: 412, currency: 'usd' }, coveredBy: 'apple', at: '2026-10-23T00:00:00Z' },
  next: { plan: 'plus', name: 'Crava Plus', from: '2026-11-23T00:00:00Z' },
};
export const offer: StoreOffer = {
  platform: 'ios', storefront: 'USA', storeAccountToken: '6f1c2c1e-0000-4000-8000-000000000000', canBuy: true, cancelsCurrent: false,
  plans: [{ id: 'pro', name: 'Crava Pro', canBuy: true, products: [
    { interval: 'month', apple: { productId: 'me.crava.pro.monthly' }, webPrice: { amount: 4900, currency: 'usd', interval: 'month' } },
  ] }],
  linkOut: { url: 'https://crava.me/plans' },
};
export const iosPurchase: StorePurchase = { platform: 'ios', jws: 'eyJ...' };
export const androidPurchase: StorePurchase = { platform: 'android', purchaseToken: 'tok' };
export const restoreAndroid: StoreRestore = { platform: 'android', purchaseTokens: ['tok'] };
export const target: ManageTarget | null = manageTarget(storePlan as Plan);
export const deletion: DeletionCheck = { storeSubscriptions: [], appleSubscription: false, googleSubscription: false };
// @ts-expect-error - an iOS purchase is its JWS, not a purchase token
export const wrong: StorePurchase = { platform: 'ios', purchaseToken: 'tok' };

// Invites: a grant is a plan source, with its dates on the plan.

export const grantPlan: Pick<Plan, 'source' | 'status' | 'paid' | 'endsAt' | 'canUpgrade' | 'canChange' | 'grant'> = {
  source: 'grant', status: 'grant', paid: false, endsAt: '2027-01-25T12:00:00Z', canUpgrade: true, canChange: false,
  grant: { planId: 'pro', planName: 'Pro', startsAt: '2026-10-25T12:00:00Z', endsAt: '2027-01-25T12:00:00Z', active: true },
};
export const preview: InvitePreview = {
  app: { id: 'c7a7a000-0000-4000-8000-000000000013', name: 'Crava' }, plan: { id: 'pro', name: 'Pro' }, months: 3, status: 'ok',
  expiresAt: '2026-11-08T12:00:00Z', emailLocked: false,
};
export const redeemed: Pick<InviteRedemption, 'grant'> = { grant: grantPlan.grant! };
// @ts-expect-error - a preview's status is one of five words
export const badPreview: InvitePreview['status'] = 'valid';
