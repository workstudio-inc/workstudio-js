import { AppError } from './errors';
import type { Http } from './http';

// ---------------------------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------------------------

export interface Me {
  [key: string]: unknown;
}

/** The person's account in this App. */
export class Account {
  constructor(private readonly http: Http, private readonly signOut: () => Promise<void>) {}

  /** Who the platform knows the person as, in this App. */
  me(): Promise<Me> {
    return this.http.request<Me>('GET', this.http.api('/connection/end-users/me'));
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
    return new ContentPackReader<T>(() => {
      let pending = this.cache.get(name);
      if (!pending) {
        pending = this.http.request<ContentPack<unknown>>('GET', this.http.api(`/catalog/app-content/${encodeURIComponent(name)}`));
        // A failed read is not kept: the next call asks again.
        pending.catch(() => this.cache.delete(name));
        this.cache.set(name, pending);
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
