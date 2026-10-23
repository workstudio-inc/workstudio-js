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
 *             App's publisher; a plan sets their monthly AI allowance
 *   ai        whether AI can be used right now - or is paused (their plan's shared pool, or the
 *             App's own budget, is spent) and until when
 *   shares    a frozen copy of something of theirs, opened by link by someone with no account, who
 *             can comment and approve it
 *   listings  the person's public profile of one kind ("shop"), found by others by ZIP code
 *   requests  asking a listing for something, and the thread both ways; the owner's side is
 *             `requests.inbox`
 *
 * Isolation is the platform's, not the App's: every call carries the person's token, and the person
 * can only ever reach their own install of the App. See https://docs.work.studio.
 */
import { Ai } from './ai';
import { Auth } from './auth';
import { Billing } from './billing';
import { Chat } from './chat';
import { type AppConfig, resolve } from './config';
import { Http } from './http';
import { Listings } from './listings';
import { Requests } from './requests';
import { Account, Content, Data, Files, Images, Projects } from './resources';
import { Shares } from './shares';

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
  readonly ai: Ai;
  readonly shares: Shares;
  readonly listings: Listings;
  readonly requests: Requests;
}

/** Create the client for one App. */
export function createApp(config: AppConfig): App {
  const resolved = resolve(config);
  const auth = new Auth(resolved);
  const http = new Http(resolved, auth);
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
    ai: new Ai(http),
    shares: new Shares(http),
    listings: new Listings(http),
    requests: new Requests(http),
  };
}

export { Ai } from './ai';
export type { AiStatus, AiStatusOptions, AiStatusReason } from './ai';
export { Auth } from './auth';
export type { CompletedSignIn, SignedIn, SignInMethod, SignInOptions } from './auth';
export { Billing } from './billing';
export type { CheckoutOptions, ManageOptions, Plan, PlanOption, PlanPrice } from './billing';
export { Chat, Conversation, TurnFailed } from './chat';
export type { ConversationSummary, Reply, SendOptions, StartOptions, Turn, Waived } from './chat';
export type { AppConfig, KeyValueStore } from './config';
export { AiPaused, AllowanceUsed, AppError, SignInRequired } from './errors';
export type { AiPausedReason } from './errors';
export { Listings } from './listings';
export type { Listing, ListingCard, ListingContact, ListingInput, ListingLocation, ListingNotSearchableReason, NearOptions, NearResult } from './listings';
export { Inbox, Requests } from './requests';
export type { ListingRequest, NewRequest, RequestListing, RequestListOptions, RequestMessage, RequestParty, RequestRequester, RequestShare, RequestStatus } from './requests';
export { Account, Collection, Content, ContentPackReader, Data, Files, Images, Projects } from './resources';
export { Shares } from './shares';
export type { GuestShare, NewShare, Share, ShareComment, ShareDecision } from './shares';
export type { Allowance, ContentFacet, ContentItem, ContentPack, ContentPage, ContentPageOptions, DataRecord, FindOptions, Me, Picture, PictureOptions, Project, ProjectInput, PublishedContentItem, StoredFile } from './resources';
