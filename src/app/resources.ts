import { AllowanceUsed, AppError } from './errors';
import type { Http } from './http';

// ---------------------------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------------------------

/** The person as this App knows them. */
export interface Me {
  accountId: string;
  /** What they are called in the App - theirs to change with {@link Account.update}. */
  displayName?: string;
  /** Their installs of the App, by instance. */
  apps?: string[];
  [key: string]: unknown;
}

/** This month's AI allowance in the App. */
export interface Allowance {
  usedUsd: number;
  /** Null when the App sets no monthly allowance. */
  monthlyBudgetUsd: number | null;
  /** The day it starts again, e.g. `2026-11-01`. */
  resetsOn: string;
}

/** The person's account in this App. */
export class Account {
  constructor(private readonly http: Http, private readonly signOut: () => Promise<void>) {}

  /** Who the platform knows the person as, in this App. */
  me(): Promise<Me> {
    return this.http.request<Me>('GET', this.http.api('/connection/end-users/me'));
  }

  /** Change what the person is called in the App. Their Google, Apple or email sign-in is not touched. */
  update(changes: { displayName: string }): Promise<Me> {
    return this.http.request<Me>('PATCH', this.http.api('/connection/end-users/me'), changes);
  }

  /** What the person has used of this month's AI allowance in the App, and when it resets. */
  allowance(): Promise<Allowance> {
    return this.http.request<Allowance>('GET', `${this.http.config.aiRuntimeUrl}/api/v1/workflow/ai-runtime/sessions/mine/allowance`);
  }

  /**
   * Delete the person's account in this App and everything it holds for them - conversations,
   * files, data, usage - then sign out. App stores require this to be possible from inside the app.
   * Their Google, Apple or email sign-in is not the App's and stays.
   */
  async delete(): Promise<void> {
    await this.http.request<unknown>('POST', this.http.api('/connection/end-users/me/delete'), { confirm: 'DELETE' });
    await this.signOut();
  }
}

// ---------------------------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------------------------

export interface Project {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  color?: string;
  status?: string;
  settings?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface ProjectInput {
  name: string;
  description?: string;
  icon?: string;
  color?: string;
  /** Anything the App wants to keep on the project. */
  settings?: Record<string, unknown>;
}

/** The person's own projects. Nobody else's are visible. */
export class Projects {
  constructor(private readonly http: Http) {}

  async list(options: { includeArchived?: boolean; page?: number; size?: number } = {}): Promise<Project[]> {
    const q = new URLSearchParams({
      includeArchived: String(options.includeArchived ?? false),
      page: String(options.page ?? 0),
      size: String(options.size ?? 50),
    });
    const body = await this.http.request<{ content?: Project[] } | Project[]>('GET', this.http.api(`/tech-projects?${q}`));
    return Array.isArray(body) ? body : body?.content ?? [];
  }

  get(id: string): Promise<Project> {
    return this.http.request<Project>('GET', this.http.api(`/tech-projects/${encodeURIComponent(id)}`));
  }

  create(input: ProjectInput): Promise<Project> {
    return this.http.request<Project>('POST', this.http.api('/tech-projects'), input);
  }

  update(id: string, changes: Partial<ProjectInput>): Promise<Project> {
    return this.http.request<Project>('PUT', this.http.api(`/tech-projects/${encodeURIComponent(id)}`), changes);
  }

  archive(id: string): Promise<Project> {
    return this.http.request<Project>('POST', this.http.api(`/tech-projects/${encodeURIComponent(id)}/archive`));
  }

  async delete(id: string): Promise<void> {
    await this.http.request<void>('DELETE', this.http.api(`/tech-projects/${encodeURIComponent(id)}`));
  }
}

// ---------------------------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------------------------

export interface DataRecord<T = Record<string, unknown>> {
  id: string;
  data: T;
  key?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface FindOptions {
  /** Equality filters on fields. */
  where?: Record<string, string | number | boolean>;
  limit?: number;
  offset?: number;
  sortBy?: string;
  ascending?: boolean;
}

/** One of the collections the App declares. The person reads and writes only their own records. */
export class Collection<T = Record<string, unknown>> {
  constructor(private readonly http: Http, readonly name: string) {}

  private url(suffix = '') {
    return `${this.http.config.dataUrl}/api/v1/workflow/data/collections/${encodeURIComponent(this.name)}/records${suffix}`;
  }

  async find(options: FindOptions = {}): Promise<DataRecord<T>[]> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(options.where ?? {})) q.set(k, String(v));
    if (options.limit !== undefined) q.set('limit', String(options.limit));
    if (options.offset !== undefined) q.set('offset', String(options.offset));
    if (options.sortBy) q.set('sortBy', options.sortBy);
    if (options.ascending !== undefined) q.set('ascending', String(options.ascending));
    const body = await this.http.request<{ records?: DataRecord<T>[]; items?: DataRecord<T>[] } | DataRecord<T>[]>(
      'GET', this.url(q.toString() ? `?${q}` : ''));
    return Array.isArray(body) ? body : body?.records ?? body?.items ?? [];
  }

  /** One record, or null when the person has no such record. */
  async get(id: string): Promise<DataRecord<T> | null> {
    try {
      return await this.http.request<DataRecord<T>>('GET', this.url(`/${encodeURIComponent(id)}`));
    } catch (e) {
      if ((e as { status?: number }).status === 404) return null;
      throw e;
    }
  }

  /** Save a new record; with `key`, the record with that key is replaced instead of duplicated. */
  create(data: T, options: { key?: string } = {}): Promise<DataRecord<T>> {
    return this.http.request<DataRecord<T>>('POST', this.url(), { record: data, ...(options.key ? { key: options.key } : {}) });
  }

  /** Change some of a record's fields; the rest are kept. */
  async update(id: string, changes: Partial<T>): Promise<DataRecord<T>> {
    const current = await this.get(id);
    if (!current) throw new AppError(404, 'That record could not be found.');
    return this.replace(id, { ...(current.data as T), ...changes });
  }

  /** Replace a record's fields with these. */
  replace(id: string, data: T): Promise<DataRecord<T>> {
    return this.http.request<DataRecord<T>>('PUT', this.url(`/${encodeURIComponent(id)}`), { record: data });
  }

  async delete(id: string): Promise<boolean> {
    const body = await this.http.request<{ deleted?: boolean }>('DELETE', this.url(`/${encodeURIComponent(id)}`));
    return Boolean(body?.deleted);
  }
}

/** The App's declared data collections. */
export class Data {
  constructor(private readonly http: Http) {}

  /** One of the collections the App declares. */
  collection<T = Record<string, unknown>>(name: string): Collection<T> {
    return new Collection<T>(this.http, name);
  }

  /** The collections the App declares, as the platform defined them. */
  collections(): Promise<Array<{ name: string; displayName?: string; fields?: unknown[]; [key: string]: unknown }>> {
    return this.http.request('GET', `${this.http.config.dataUrl}/api/v1/workflow/data/collections`);
  }
}

// ---------------------------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------------------------

export interface ContentItem<T = Record<string, unknown>> {
  key: string;
  data: T;
  sortOrder?: number;
}

/** A content pack as the App ships it: one released version, the same for everyone using the App. */
export interface ContentPack<T = Record<string, unknown>> {
  name: string;
  displayName?: string;
  description?: string;
  version: number;
  fields?: unknown[];
  items: ContentItem<T>[];
}

/**
 * What the App ships besides its logic - templates, featured designs, sample records - at the
 * version the person's install is pinned to. Read-only: the publisher writes it and releases it with
 * the App.
 */
export class Content {
  private readonly cache = new Map<string, Promise<ContentPack<unknown>>>();

  constructor(private readonly http: Http) {}

  /** One of the App's content packs, read once per session. */
  pack<T = Record<string, unknown>>(name: string): ContentPackReader<T> {
    return new ContentPackReader<T>(async () => {
      // Signed in: the pack at the release the person's install runs. Not yet, and the App said who
      // it is (appId): the pack as the App's latest release made it public - or a 404 if it did not.
      const asSomeone = await this.http.signedIn();
      const appId = this.http.config.appId;
      const key = `${asSomeone || !appId ? 'mine' : 'public'}:${name}`;
      let pending = this.cache.get(key);
      if (!pending) {
        pending = asSomeone || !appId
          ? this.http.request<ContentPack<unknown>>('GET', this.http.api(`/catalog/app-content/${encodeURIComponent(name)}`))
          : this.http.anonymous<ContentPack<unknown>>(
              `${this.http.config.apiUrl}/api/v1/public/apps/${encodeURIComponent(appId)}/content/${encodeURIComponent(name)}`);
        // A failed read is not kept: the next call asks again.
        pending.catch(() => this.cache.delete(key));
        this.cache.set(key, pending);
      }
      return pending as Promise<ContentPack<T>>;
    });
  }
}

export class ContentPackReader<T> {
  constructor(private readonly load: () => Promise<ContentPack<T>>) {}

  /** The whole pack: its description, version and items. */
  read(): Promise<ContentPack<T>> {
    return this.load();
  }

  /** The items, in the publisher's order. */
  async list(): Promise<ContentItem<T>[]> {
    return (await this.load()).items;
  }

  /** One item by its key, or null. */
  async get(key: string): Promise<ContentItem<T> | null> {
    return (await this.load()).items.find(i => i.key === key) ?? null;
  }
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

export interface StoredFile {
  id: string;
  name: string;
  contentType?: string;
  size?: number;
  createdAt?: string;
}

/** The person's own files: photos and PDFs, under 25 MB each. */
export class Files {
  constructor(private readonly http: Http) {}

  upload(file: Blob | File, name?: string): Promise<StoredFile> {
    const form = new FormData();
    form.append('file', file, name ?? ((file as File).name || 'upload'));
    return this.http.request<StoredFile>('POST', this.http.api('/storage/my-files'), form);
  }

  async list(options: { page?: number; size?: number } = {}): Promise<StoredFile[]> {
    const q = new URLSearchParams({ page: String(options.page ?? 0), size: String(options.size ?? 50) });
    const body = await this.http.request<{ files?: StoredFile[] }>('GET', this.http.api(`/storage/my-files?${q}`));
    return body?.files ?? [];
  }

  /** A short-lived address to download or show the file. */
  async url(id: string): Promise<string> {
    const body = await this.http.request<{ url?: string }>('GET', this.http.api(`/storage/my-files/${encodeURIComponent(id)}/url`));
    if (!body?.url) throw new Error('No address for that file.');
    return body.url;
  }

  async delete(id: string): Promise<void> {
    await this.http.request<void>('DELETE', this.http.api(`/storage/my-files/${encodeURIComponent(id)}`));
  }
}

// ---------------------------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------------------------

export interface PictureOptions {
  /** One to three images - Blobs (a photo, a canvas) or data URLs. The first leads; the rest are references. */
  images: Array<Blob | string>;
  /** What to make of them: "photograph this design", "place the furniture from the second image into the room in the first". */
  prompt: string;
  size?: '1536x1024' | '1024x1536' | '1024x1024';
  quality?: 'low' | 'medium' | 'high';
  /** One of the models the platform allows Apps; its default when left out. */
  model?: string;
}

export interface Picture {
  /** A JPEG, as a data URL: show it, or save it with `files.upload`. */
  image: string;
  model: string;
  size: string;
  /** What it cost, charged to the person's monthly AI allowance in the App. */
  costUsd: number;
}

/**
 * Pictures made from the person's images by an image model: a render of their design made into a
 * photograph, the design set into a photo of their room. Each is charged to their allowance.
 * @throws AllowanceUsed when this month's allowance cannot pay for it
 */
export class Images {
  constructor(private readonly http: Http) {}

  async make(options: PictureOptions): Promise<Picture> {
    const images = await Promise.all(options.images.map(i => (typeof i === 'string' ? i : dataUrl(i))));
    try {
      return await this.http.request<Picture>('POST', `${this.http.config.aiRuntimeUrl}/api/v1/workflow/ai-runtime/sessions/mine/images`, {
        images,
        prompt: options.prompt,
        ...(options.size ? { size: options.size } : {}),
        ...(options.quality ? { quality: options.quality } : {}),
        ...(options.model ? { model: options.model } : {}),
      });
    } catch (e) {
      if (e instanceof AppError && (e.status === 402 || e.code === 'ALLOWANCE_USED')) throw new AllowanceUsed(e.message);
      throw e;
    }
  }
}

function dataUrl(blob: Blob): Promise<string> {
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }
  // No FileReader (a server): base64 by hand, in chunks so a large photo does not overflow the stack.
  return blob.arrayBuffer().then(buffer => {
    const bytes = new Uint8Array(buffer);
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${blob.type || 'image/png'};base64,${btoa(text)}`;
  });
}
