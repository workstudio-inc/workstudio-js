/**
 * The work.studio SDK for Apps people use directly - a web app, or a phone app in a web view.
 *
 * One client, as the signed-in person:
 *
 *   auth      hosted sign-in (Google, Apple, email) and the person's platform token
 *   account   who they are; delete their account and everything the App holds for them
 *   projects  their own projects
 *   chat      conversations with the agents the App bundles - one per project, metered against the
 *             person's monthly allowance
 *   data      records in the collections the App declares - only their own
 *   content   what the App ships - templates, featured designs - at the version their install runs
 *   files     their own photos and PDFs
 *   billing   their plan in the App - buying one (Stripe Checkout) and managing it, paid to the
 *             App's publisher; a plan sets their monthly AI allowance. `billing.store`: the same plans
 *             in the App's iOS and Android apps, through the App Store and Google Play
 *   credits   an App with credits: one balance every action draws on (monthly first, then bought ones,
 *             which never expire), "about N" estimates, credit packs and their history
 *   invites   a single-use link from the publisher that gives a paid plan for some months, no payment:
 *             what it gives (before sign-in), and using it
 *   ai        whether AI can be used right now - or is paused (their plan's shared pool, or the
 *             App's own budget, is spent) and until when
 *   shares    a frozen copy of something of theirs, opened by link by someone with no account, who
 *             can comment and approve it
 *   listings  the person's public profile of one kind ("shop"), found by others by ZIP code
 *   requests  asking a listing for something, and the thread both ways; the owner's side is
 *             `requests.inbox`
 *   sharedProjects  a private space with one other person of the App - an owner (a shop) and a
 *             client - with frozen, priced revisions, messages, change requests and an approval
 *             record only the two of them can read
 *   push      the person's phone, for the App's push notifications: register its token, forget it
 *             on sign-out, and their preferences (which kinds, quiet hours)
 *   contacts  people of the App who agreed to hear from the person through it - an invite one sends,
 *             the other accepts
 *   events    the App's own events ("lesson.cancelled"), now or at a time, about the person or a
 *             contact - which its automations email or push as the App
 *   notifications  which of the App's emails the person gets
 *
 * Isolation is the platform's, not the App's: every call carries the person's token, and the person
 * can only ever reach their own install of the App. See https://docs.work.studio.
 */
import { Ai } from './ai';
import { Auth } from './auth';
import { Billing } from './billing';
import { Credits } from './credits';
import { Chat } from './chat';
import { type AppConfig, resolve } from './config';
import { Http } from './http';
import { Invites } from './invites';
import { Listings } from './listings';
import { Contacts, Events, Notifications } from './notify';
import { Push } from './push';
import { Requests } from './requests';
import { Account, Content, Data, Files, Images, Projects } from './resources';
import { Shares } from './shares';
import { SharedProjects } from './sharedProjects';

export interface App {
  readonly auth: Auth;
  readonly account: Account;
  readonly projects: Projects;
  readonly chat: Chat;
  readonly data: Data;
  readonly content: Content;
  readonly files: Files;
  readonly images: Images;
  readonly billing: Billing;
  /** The person's credits (an App with credits): balance, "about N", packs and history. */
  readonly credits: Credits;
  /** Invite links that give a plan for some months: preview, redeem, the token in the address. */
  readonly invites: Invites;
  readonly ai: Ai;
  readonly shares: Shares;
  readonly listings: Listings;
  readonly requests: Requests;
  readonly sharedProjects: SharedProjects;
  readonly push: Push;
  readonly contacts: Contacts;
  readonly events: Events;
  readonly notifications: Notifications;
}

/** Create the client for one App. */
export function createApp(config: AppConfig): App {
  const resolved = resolve(config);
  const auth = new Auth(resolved);
  const http = new Http(resolved, auth);
  const push = new Push(http, auth.storage, resolved.storageKey, resolved.appId);
  auth.beforeSignOut(() => push.beforeSignOut());
  return {
    auth,
    account: new Account(http, () => auth.signOut()),
    projects: new Projects(http),
    chat: new Chat(http),
    data: new Data(http),
    content: new Content(http),
    files: new Files(http),
    images: new Images(http),
    billing: new Billing(http, auth),
    credits: new Credits(http),
    invites: new Invites(http, auth),
    ai: new Ai(http),
    shares: new Shares(http),
    listings: new Listings(http),
    requests: new Requests(http),
    sharedProjects: new SharedProjects(http),
    push,
    contacts: new Contacts(http),
    events: new Events(http),
    notifications: new Notifications(http),
  };
}

export { Ai } from './ai';
export type { AiStatus, AiStatusOptions, AiStatusReason } from './ai';
export { Auth } from './auth';
export type { CompletedSignIn, SignedIn, SignInMethod, SignInOptions } from './auth';
export { Billing } from './billing';
export type { CheckoutLink, CheckoutOptions, ManageLink, ManageOptions, Money, PaidTwiceNotice, Plan, PlanChange, PlanGrant, PlanOption, PlanPrice, PlanSource } from './billing';
export { Invites } from './invites';
export type { InvitePreview, InviteRedemption, InviteRefusal } from './invites';
export { APPLE_SUBSCRIPTIONS_URL, BillingUnavailable, GOOGLE_SUBSCRIPTIONS_URL, manageTarget, StoreBilling, StorePurchaseOtherAccount, TooManyPurchases, TooManyTries } from './store';
export type { DeletionCheck, ManageTarget, Restored, RestoredPurchase, RestoreResult, StoreCurrent, StoreOffer, StoreOfferOptions, StoreOfferPlan, StorePlatform, StoreProduct, StorePurchase, StoreRestore, StoreSubscriptionSummary, StoreTrial, WebPrice } from './store';
export { Credits } from './credits';
export type { BuyOptions, CreditBalance, CreditEstimate, CreditEstimateOptions, CreditHistory, CreditHistoryEntry, CreditMoney, CreditPack, CreditPacks, CreditPacksOptions, CreditPacksWhy, CreditsOptions, CreditUnit } from './credits';
export { Chat, Conversation, TurnFailed } from './chat';
export type { ConversationSummary, Reply, SendOptions, StartOptions, Turn, Waived } from './chat';
export type { AppConfig, KeyValueStore } from './config';
export { AiPaused, AllowanceUsed, AppError, CreditsUsedUp, NotForYourPlan, SignInRequired } from './errors';
export type { AiPausedReason } from './errors';
export { Listings } from './listings';
export type { Listing, ListingCard, ListingContact, ListingInput, ListingLocation, ListingNotSearchableReason, NearOptions, NearResult } from './listings';
export { Contacts, Events, Notifications } from './notify';
export type { Contact, ContactInvite, EventFieldValue, EventSendOptions, NotificationEvent, NotificationSettings, Scheduled, Sent } from './notify';
export { Push, routeOf } from './push';
export type { PushData, PushDevice, PushPlatform, PushPreferences, PushTransport, RegisterOptions } from './push';
export { Inbox, Requests } from './requests';
export type { ListingRequest, NewRequest, RequestListing, RequestListOptions, RequestMessage, RequestParty, RequestRequester, RequestShare, RequestStatus } from './requests';
export { Account, Collection, Content, ContentPackReader, Data, Files, Images, Projects } from './resources';
export { Shares } from './shares';
export { SharedProjects } from './sharedProjects';
export type { NewProjectRevision, ProjectApproval, ProjectChangeRequest, ProjectChannel, ProjectContact, ProjectEntriesOptions, ProjectEntry, ProjectEntryType, ProjectParticipant, ProjectPrice, ProjectRevision, ProjectRevisionMeta, ProjectSide, ProjectStatus, SharedProject, SharedProjectListOptions, SharedProjectSummary } from './sharedProjects';
export type { GuestShare, NewShare, Share, ShareComment, ShareDecision } from './shares';
export type { Allowance, ContentFacet, ContentItem, ContentPack, ContentPage, ContentPageOptions, DataRecord, FindOptions, Me, Picture, PictureOptions, Project, ProjectInput, PublishedContentItem, StoredFile } from './resources';
export { NotAMember } from './errors';
