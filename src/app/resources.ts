import { AiPaused, AllowanceUsed, AppError } from './errors';
import type { Http } from './http';
import type { DeletionCheck } from './store';

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
   * Before {@link Account.delete}: the person's live App Store and Google Play subscriptions. An Apple one
   * goes on billing after the account is gone until they cancel it in the App Store - say so, with its
   * manage link, before deleting. Google ones are cancelled by the platform on deletion.
   */
  deletionCheck(): Promise<DeletionCheck> {
    return this.http.request<DeletionCheck>('GET', this.http.api('/connection/end-users/me/delete'));
  }

  /**
   * Delete the person's account in this App and everything it holds for them - conversations,
   * files, data, usage - then sign out. App stores require this to be possible from inside the app.
   * Their Google, Apple or email sign-in is not the App's and stays. A website or Google Play subscription
   * is cancelled; an App Store one cannot be - see {@link Account.deletionCheck}.
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

/** What {@link ContentPackReader.page} asks for. All optional. */
export interface ContentPageOptions {
  /** Items per page, 1 to 60. Default 60. */
  limit?: number;
  /** The `nextCursor` of the page before; leave out for the first page. */
  cursor?: string | null;
  /** Only items whose `data.tags` holds this tag - or any of these - ignoring case. */
  tag?: string | string[];
  /** The top-level `data` keys to include - leave a heavy one (a design) out of a list. */
  fields?: string[];
  /** `'tags'`: how many items carry each tag, over the whole pack - for filter tabs. */
  facets?: 'tags' | Array<'tags'>;
}

/** How many items of the whole pack carry a tag. */
export interface ContentFacet {
  value: string;
  count: number;
}

/** One page of a content pack. */
export interface ContentPage<T = Record<string, unknown>> {
  items: ContentItem<T>[];
  /** Pass to the next `page()` call; null on the last page. */
  nextCursor: string | null;
  /** How many items match, across every page. */
  total: number;
  /** The pack version the page is from. A cursor only works with the version it came from. */
  version: number;
  facets?: { tags?: ContentFacet[] };
  name?: string;
  displayName?: string;
  description?: string;
}

/** One item of a content pack, whole, with the pack version it is from. */
export interface PublishedContentItem<T = Record<string, unknown>> extends ContentItem<T> {
  pack?: string;
  version: number;
}

/** How a reader reaches the platform: a path under the pack, as the person or as a visitor. */
type PackFetch = (suffix: string) => Promise<unknown>;

/**
 * What the App ships besides its logic - templates, featured designs, sample records - at the
 * version the person's install is pinned to. Read-only: the publisher writes it and releases it with
 * the App.
 */
export class Content {
  private readonly cache = new Map<string, Promise<unknown>>();
  /** Packs the platform answered whole when asked for a page - a platform from before paging. */
  private readonly unpaged = new Set<string>();

  constructor(private readonly http: Http) {}

  /** One of the App's content packs, read once per session. */
  pack<T = Record<string, unknown>>(name: string): ContentPackReader<T> {
    const fetch: PackFetch = async suffix => {
      // Signed in: the pack at the release the person's install runs. Not yet, and the App said who
      // it is (appId): the pack as the App's latest release made it public - or a 404 if it did not.
      const asSomeone = await this.http.signedIn();
      const appId = this.http.config.appId;
      const mine = asSomeone || !appId;
      const key = `${mine ? 'mine' : 'public'}:${name}${suffix}`;
      let pending = this.cache.get(key);
      if (!pending) {
        pending = mine
          ? this.http.request<unknown>('GET', this.http.api(`/catalog/app-content/${encodeURIComponent(name)}${suffix}`))
          : this.http.anonymous<unknown>(
              `${this.http.config.apiUrl}/api/v1/public/apps/${encodeURIComponent(appId!)}/content/${encodeURIComponent(name)}${suffix}`);
        // A failed read is not kept: the next call asks again.
        pending.catch(() => this.cache.delete(key));
        this.cache.set(key, pending);
      }
      return pending;
    };
    return new ContentPackReader<T>(() => fetch('') as Promise<ContentPack<T>>, fetch, {
      pages: () => !this.unpaged.has(name),
      answeredWhole: () => this.unpaged.add(name),
    });
  }
}

export class ContentPackReader<T> {
  constructor(
    private readonly load: () => Promise<ContentPack<T>>,
    private readonly fetch?: PackFetch,
    /** Whether the platform pages this pack; once it answers whole, every page comes from one read. */
    private readonly paging?: { pages(): boolean; answeredWhole(): void },
  ) {}

  /** The whole pack: its description, version and items. */
  read(): Promise<ContentPack<T>> {
    return this.load();
  }

  /** The items, in the publisher's order. */
  async list(): Promise<ContentItem<T>[]> {
    return (await this.load()).items;
  }

  /** One item by its key, or null. Reads the whole pack - for one item alone, {@link item}. */
  async get(key: string): Promise<ContentItem<T> | null> {
    return (await this.load()).items.find(i => i.key === key) ?? null;
  }

  /**
   * A page of the pack, in the publisher's order: what a gallery reads as people scroll. Pass the
   * page's `nextCursor` back for the next one. A cursor belongs to one pack version: when the App
   * moves to a new release mid-scroll the answer is an {@link AppError} with `status` 409 - start
   * again from the first page.
   */
  async page(options: ContentPageOptions = {}): Promise<ContentPage<T>> {
    const q = new URLSearchParams();
    q.set('limit', String(options.limit ?? 60));
    if (options.cursor) q.set('cursor', options.cursor);
    for (const t of tagsOf(options.tag)) q.append('tag', t);
    if (options.fields?.length) q.set('fields', options.fields.join(','));
    const facets = options.facets === undefined ? [] : Array.isArray(options.facets) ? options.facets : [options.facets];
    if (facets.length) q.set('facets', facets.join(','));

    if (!this.fetch || this.paging?.pages() === false) return pageLocally(await this.load(), options);
    const body = (await this.fetch(`?${q}`)) as Partial<ContentPage<T>> & Partial<ContentPack<T>>;
    if (body && typeof body.total === 'number' && Array.isArray(body.items)) {
      return { ...body, items: body.items, nextCursor: body.nextCursor ?? null, total: body.total, version: body.version as number };
    }
    // A platform from before paging answers the whole pack whatever is asked: page it here, and read
    // the pack once (read() keeps it) for the pages after.
    this.paging?.answeredWhole();
    return pageLocally(body && Array.isArray(body.items) ? (body as ContentPack<T>) : await this.load(), options);
  }

  /** One item by its key, whole - without reading the rest of the pack - or null. */
  async item(key: string): Promise<PublishedContentItem<T> | null> {
    if (this.fetch) {
      try {
        return (await this.fetch(`/items/${key.split('/').map(encodeURIComponent).join('/')}`)) as PublishedContentItem<T>;
      } catch (e) {
        if (!(e instanceof AppError) || e.status !== 404) throw e;
        // Not there - or a platform from before item reads: the whole pack says which.
      }
    }
    const pack = await this.load();
    const found = pack.items.find(i => i.key === key);
    return found ? { ...found, pack: pack.name, version: pack.version } : null;
  }
}

function tagsOf(tag: string | string[] | undefined): string[] {
  return (Array.isArray(tag) ? tag : tag ? [tag] : []).map(t => t.trim()).filter(Boolean);
}

function itemTags(item: ContentItem<unknown>): string[] {
  const raw = (item.data as Record<string, unknown> | null)?.tags;
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  return list.filter((t): t is string => typeof t === 'string' && t.trim() !== '').map(t => t.trim());
}

/** The platform's paging, over a whole pack already read. Cursors made here are this SDK's own. */
function pageLocally<T>(pack: ContentPack<T>, options: ContentPageOptions): ContentPage<T> {
  const limit = Math.min(60, Math.max(1, options.limit ?? 60));
  const wanted = new Set(tagsOf(options.tag).map(t => t.toLowerCase()));
  const ordered = [...pack.items].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const matching = wanted.size ? ordered.filter(i => itemTags(i).some(t => wanted.has(t.toLowerCase()))) : ordered;
  const at = /^local:(\d+):(\d+)$/.exec(options.cursor ?? '');
  if (options.cursor && (!at || Number(at[1]) !== pack.version)) {
    throw new AppError(409, 'The content changed. Start again from the first page.');
  }
  const from = at ? Number(at[2]) : 0;
  const to = Math.min(from + limit, matching.length);
  const keep = options.fields?.length ? new Set(options.fields) : null;
  const items = matching.slice(from, to).map(i =>
    keep ? { ...i, data: Object.fromEntries(Object.entries(i.data as Record<string, unknown>).filter(([k]) => keep.has(k))) as T } : i,
  );
  const page: ContentPage<T> = {
    name: pack.name,
    displayName: pack.displayName,
    description: pack.description,
    version: pack.version,
    items,
    nextCursor: to < matching.length ? `local:${pack.version}:${to}` : null,
    total: matching.length,
  };
  if (options.facets) {
    const counts = new Map<string, ContentFacet>();
    for (const item of ordered) {
      const seen = new Set<string>();
      for (const tag of itemTags(item)) {
        const k = tag.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        const f = counts.get(k) ?? { value: tag, count: 0 };
        f.count++;
        counts.set(k, f);
      }
    }
    page.facets = { tags: [...counts.values()].sort((a, b) => b.count - a.count) };
  }
  return page;
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
 * @throws AiPaused when AI is paused in the App (its plan's shared pool, or the App's own budget)
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
      const paused = e instanceof AppError ? AiPaused.from(e.details ?? { code: e.code }, e.message) : null;
      if (paused) throw this.http.paused(paused);
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
