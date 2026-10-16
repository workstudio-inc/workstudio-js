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
 *
 * Isolation is the platform's, not the App's: every call carries the person's token, and the person
 * can only ever reach their own install of the App. See https://docs.work.studio.
 */
import { Auth } from './auth';
import { Chat } from './chat';
import { type AppConfig, resolve } from './config';
import { Http } from './http';
import { Account, Content, Data, Files, Projects } from './resources';

export interface App {
  readonly auth: Auth;
  readonly account: Account;
  readonly projects: Projects;
  readonly chat: Chat;
  readonly data: Data;
  readonly content: Content;
  readonly files: Files;
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
  };
}

export { Auth } from './auth';
export type { SignedIn, SignInMethod } from './auth';
export { Chat, Conversation } from './chat';
export type { ConversationSummary, Reply, SendOptions, StartOptions, Turn } from './chat';
export type { AppConfig, KeyValueStore } from './config';
export { AllowanceUsed, AppError, SignInRequired } from './errors';
export { Account, Collection, Content, ContentPackReader, Data, Files, Projects } from './resources';
export type { ContentItem, ContentPack, DataRecord, FindOptions, Me, Project, ProjectInput, StoredFile } from './resources';
