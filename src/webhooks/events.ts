/**
 * The App events work.studio sends to a publisher's webhook endpoints (catalogue 2026-10-27).
 *
 * Every event has the same envelope; `data` depends on `type`. Fields may be added to a type without a new `version`;
 * a field removed or changed in meaning is a new version, announced first. Ignore fields you do not know.
 */

/** The catalogue version these types describe. */
export const WEBHOOK_CATALOG_VERSION = '2026-10-27';

/** A person, by the id the App's People view shows. */
export interface WebhookPerson {
  id: string;
}

export interface WebhookPlanRef {
  id: string | null;
  name: string | null;
}

/** Where a plan is paid: the website (Stripe), a store, or granted by an invite. */
export type WebhookPlanSource = 'stripe' | 'app_store' | 'google_play' | 'invite';

export interface AppWebhookEventDataMap {
  /** Someone signed in to the App for the first time. The only event with personal data: what the People view shows. */
  'person.signed_up': {
    person: WebhookPerson & { email: string | null; emailVerified: boolean; name: string | null; signInMethod: string | null };
  };
  /** A person deleted their account: delete what you keep about them. */
  'person.deleted': { person: WebhookPerson };
  'plan.started': {
    person: WebhookPerson;
    plan: WebhookPlanRef;
    source: WebhookPlanSource | null;
    trial: boolean;
    renewsAt: string | null;
    endsAt: string | null;
  };
  'plan.changed': {
    person: WebhookPerson;
    plan: WebhookPlanRef;
    previousPlan: WebhookPlanRef;
    direction: 'upgrade' | 'downgrade' | 'change';
    source: WebhookPlanSource | null;
  };
  'plan.cancelled': {
    person: WebhookPerson;
    plan: WebhookPlanRef;
    /** `period_end`: it ends at `endsAt`; `ended`: it has ended. */
    effective: 'period_end' | 'ended';
    endsAt: string | null;
    source: WebhookPlanSource | null;
  };
  'plan.renewed': { person: WebhookPerson; plan: WebhookPlanRef; renewsAt: string | null; source: WebhookPlanSource | null };
  'plan.payment_failed': { person: WebhookPerson; plan: WebhookPlanRef; source: WebhookPlanSource | null };
  'credits.purchased': {
    person: WebhookPerson;
    credits: number;
    balance: number;
    pack: { id: string | null };
    /** In the currency's smallest unit (cents). */
    amount: { value: number | null; currency: string | null };
  };
  'invite.redeemed': { person: WebhookPerson; invite: { id: string }; plan: WebhookPlanRef; endsAt: string | null };
  /** A record reference: read the record with your own credentials if you need its values. */
  'record.created': { collection: string; record: { id: string }; fields: string[]; person: WebhookPerson | null };
  'record.updated': { collection: string; record: { id: string }; fields: string[]; person: WebhookPerson | null };
  'record.deleted': { collection: string; record: { id: string }; person: WebhookPerson | null };
  /** The App's own event (app.events): only its `number` and `choice` fields. */
  'app.event': { name: string; fields: Record<string, string | number>; person: WebhookPerson };
  /**
   * A workflow run one of your App's people started from the App (`app.workflows.run`) ended. Read its output with
   * your own credentials if you need it; the input, output and error are never sent.
   */
  'app.workflow.run.finished': {
    runId: string;
    /** The workflow your App declares (its global id). */
    workflowId: string | null;
    /** Your App's own name for it (the key under `workflows:`). */
    workflowKey: string;
    status: 'FINISHED' | 'FAILED' | 'CANCELLED' | 'TERMINATED';
    /** ISO 8601. */
    finishedAt: string;
    person: WebhookPerson;
  };
  'deployment.live': {
    deployment: { id: string; url: string | null; message: string | null };
    environmentId: string;
    previousDeployment: { id: string } | null;
    rollback: boolean;
  };
  'usage.limit_reached': {
    limit: {
      kind: 'hosting.requests' | 'hosting.egress' | 'credits';
      /** 80: getting close; 100: reached. */
      threshold: 80 | 100;
      used?: number;
      max?: number;
      /** `2026-10-26` for a daily limit, `2026-10` for a monthly one. */
      period?: string;
    };
    /** For `credits`: whose credits ran out. */
    person?: WebhookPerson;
  };
  /** Sent only when you press "Send test event". */
  'webhook.test': { message: string };
}

export type AppWebhookEventType = keyof AppWebhookEventDataMap;

/** Every type an endpoint can select (`webhook.test` is always delivered on request). */
export const APP_WEBHOOK_EVENT_TYPES: readonly AppWebhookEventType[] = [
  'person.signed_up',
  'person.deleted',
  'plan.started',
  'plan.changed',
  'plan.cancelled',
  'plan.renewed',
  'plan.payment_failed',
  'credits.purchased',
  'invite.redeemed',
  'record.created',
  'record.updated',
  'record.deleted',
  'app.event',
  'app.workflow.run.finished',
  'deployment.live',
  'usage.limit_reached',
] as const;

/** One event as delivered. Narrow on `type`. */
export type AppWebhookEvent = {
  [K in AppWebhookEventType]: {
    /** The idempotency id: the same on every retry and replay of this event (also the `X-Webhook-Id` header). */
    id: string;
    type: K;
    /** The payload version of this type. */
    version: number;
    /** When it happened (ISO 8601). */
    createdAt: string;
    /** Increases with each event the platform records for your App; order by it (retries can arrive late). */
    sequence: number;
    app: { id: string; environmentId: string };
    /** True only for "Send test event". */
    test: boolean;
    data: AppWebhookEventDataMap[K];
  };
}[AppWebhookEventType];
