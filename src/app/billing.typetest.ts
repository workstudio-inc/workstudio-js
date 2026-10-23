// Compile-time only (npm run typecheck; not exported, not bundled): the trial fields are public types.
import type { CheckoutOptions, Plan, PlanOption } from './billing';

export const trialOption: PlanOption = {
  id: 'pro', name: 'Pro', monthlyBudgetUsd: 20, prices: [], trialDays: 14, trialAvailable: true,
};
export const trialPlan: Pick<Plan, 'trialEndsAt' | 'hasPaymentMethod'> = { trialEndsAt: null, hasPaymentMethod: false };
export const buyNow: CheckoutOptions = { priceId: 'price_pro', trial: false };
