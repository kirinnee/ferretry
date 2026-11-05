import {
  RENDER_HOST_AUTHOR,
  RENDER_ID_MAX_LENGTH,
  RENDER_ID_MIN_LENGTH,
  RENDER_MAX_PENDING_SAVES,
  RENDER_QUOTAS,
  type RenderBody,
  type RenderMeta,
  type RenderSaveRequest,
  type RenderSaveResponse,
  type StoredRenderMeta,
  renderToken,
} from '@ferretry/protocol';
import { renderSaveRefusal } from '@ferretry/protocol/render-save';
import type { SerialExecutor } from '../ports.ts';
import { renderDigest, renderIdPrefix } from './digest.ts';
import { busyError, type RenderClock, RenderError, type RenderRepository } from './types.ts';

/** How far a "newer version" chain is followed. Links only ever point at an older render, so it ends; this is the bound anyway. */
const CHAIN_LIMIT = 64;

/** The quota bucket of a save: its session, or the machine's own for a save with none. Prefixed, so no session id can be mistaken for the machine bucket. */
const authorKey = (sessionId: string | undefined): string =>
  sessionId === undefined ? RENDER_HOST_AUTHOR : `session:${sessionId}`;

interface Usage {
  count: number;
  bytes: number;
}

/** What the store holds, in memory: rebuilt from the metas on first use and kept in step by every save. */
class RenderIndex {
  readonly byId = new Map<string, StoredRenderMeta>();
  /** Content digest -> the render holding it, so a retry finds its render at whatever length its id was given. */
  readonly bySha = new Map<string, StoredRenderMeta>();
  /** Older id -> the newest render that named it in `supersedes`. */
  readonly successor = new Map<string, StoredRenderMeta>();
  readonly byAuthor = new Map<string, Usage>();
  readonly machine: Usage = { count: 0, bytes: 0 };

  add(meta: StoredRenderMeta): void {
    this.byId.set(meta.id, meta);
    if (!this.bySha.has(meta.sha256)) this.bySha.set(meta.sha256, meta);
    const author = authorKey(meta.author.sessionId);
    const usage = this.byAuthor.get(author) ?? { count: 0, bytes: 0 };
    usage.count += 1;
    usage.bytes += meta.bytes;
    this.byAuthor.set(author, usage);
    this.machine.count += 1;
    this.machine.bytes += meta.bytes;
    const older = meta.supersedes;
    if (older === undefined) return;
    const current = this.successor.get(older);
    if (current === undefined || current.createdAt <= meta.createdAt) this.successor.set(older, meta);
  }

  /** The newest render in the chain after `id`, or `undefined` when nothing replaced it. */
  newest(id: string): string | undefined {
    let latest: string | undefined;
    let cursor = id;
    for (let hops = 0; hops < CHAIN_LIMIT; hops += 1) {
      const next = this.successor.get(cursor);
      if (next === undefined || next.id === id) break;
      latest = next.id;
      cursor = next.id;
    }
    return latest;
  }
}

/**
 * The render store (docs/renders.md): content-addressed pictures a ferret saves and cites.
 *
 * Every save is validated with the `fy-render` grammar before anything is written, then keyed by its
 * content, so a retry is the same render and an edit is a different one. Saves run one at a time: the
 * collision check and the quotas read the whole store, and two saves racing past them would each be
 * checked against a store the other had not yet changed.
 */
export class RenderService {
  #index: Promise<RenderIndex> | undefined;
  #inFlight = 0;

  constructor(
    private readonly repository: RenderRepository,
    private readonly clock: RenderClock,
    private readonly executor: SerialExecutor,
  ) {}

  /** Whether as many saves as the bound allows are in flight, so the next would be refused without being read. */
  saturated(): boolean {
    return this.#inFlight >= RENDER_MAX_PENDING_SAVES;
  }

  async save(request: RenderSaveRequest, authorSessionId?: string): Promise<RenderSaveResponse> {
    if (this.saturated()) throw busyError();
    const refusal = renderSaveRefusal(request);
    if (refusal !== null) throw new RenderError('invalid', refusal);
    this.#inFlight += 1;
    try {
      return await this.#saveExclusive(request, authorSessionId);
    } finally {
      this.#inFlight -= 1;
    }
  }

  async #saveExclusive(request: RenderSaveRequest, authorSessionId: string | undefined): Promise<RenderSaveResponse> {
    return await this.executor.runExclusive(async () => {
      const index = await this.#load();
      const digest = renderDigest(request.kind, request.alt, request.payload);
      const sha256 = digest.toString('hex');
      // Content already stored is found by its digest, whatever length its id was given: a shorter id freed since
      // (its meta lost) must never be re-issued for content that survives under a longer one.
      const stored = index.bySha.get(sha256);
      if (stored !== undefined) return this.#answer(index, stored, false);
      let id = '';
      for (let length = RENDER_ID_MIN_LENGTH; ; length = Math.min(length + 2, RENDER_ID_MAX_LENGTH)) {
        id = renderIdPrefix(digest, length);
        if (!index.byId.has(id)) break;
        // The whole digest is the id at 52 characters, so only a record that lies about its digest can hold it.
        if (length >= RENDER_ID_MAX_LENGTH) throw new RenderError('id_space_exhausted', 'no free id for this picture');
      }
      if (request.supersedes !== undefined && !index.byId.has(request.supersedes))
        throw new RenderError('supersedes_not_found', `the picture to replace (${request.supersedes}) is not saved`);
      const bytes = new TextEncoder().encode(request.payload).byteLength;
      this.#checkQuota(index, authorKey(authorSessionId), bytes);
      const meta: StoredRenderMeta = {
        v: 1,
        id,
        kind: request.kind,
        alt: request.alt,
        bytes,
        sha256,
        createdAt: this.clock.now(),
        author: authorSessionId === undefined ? {} : { sessionId: authorSessionId },
        ...(request.supersedes === undefined ? {} : { supersedes: request.supersedes }),
      };
      await this.repository.write(meta, request.payload);
      index.add(meta);
      return this.#answer(index, meta, true);
    });
  }

  /** One render's record, with the newest render that replaced it when there is one. */
  async meta(id: string): Promise<RenderMeta> {
    const index = await this.#load();
    const meta = index.byId.get(id);
    if (meta === undefined) throw notFound(id);
    return this.#withSuccessor(index, meta);
  }

  /** The stored payload, proved against its digest: bytes that no longer match are damage, never an answer. */
  async body(id: string): Promise<RenderBody> {
    const index = await this.#load();
    const meta = index.byId.get(id);
    if (meta === undefined) throw notFound(id);
    const payload = await this.repository.readPayload(id);
    if (payload === undefined) throw new RenderError('damaged', `the saved picture ${id} has lost its payload`);
    if (renderDigest(meta.kind, meta.alt, payload).toString('hex') !== meta.sha256)
      throw new RenderError('damaged', `the saved picture ${id} no longer matches what was saved`);
    return { meta, payload };
  }

  #answer(index: RenderIndex, meta: StoredRenderMeta, created: boolean): RenderSaveResponse {
    return { id: meta.id, token: renderToken(meta.kind, meta.id), created, meta: this.#withSuccessor(index, meta) };
  }

  #withSuccessor(index: RenderIndex, meta: StoredRenderMeta): RenderMeta {
    const supersededBy = index.newest(meta.id);
    return supersededBy === undefined ? meta : { ...meta, supersededBy };
  }

  #checkQuota(index: RenderIndex, author: string, bytes: number): void {
    const own = index.byAuthor.get(author) ?? { count: 0, bytes: 0 };
    const scope = author === authorKey(undefined) ? "the owner's own saves" : 'this session';
    const refuse = (limit: string): never => {
      throw new RenderError('quota_exceeded', `the quota is full: ${limit}`);
    };
    if (own.count + 1 > RENDER_QUOTAS.perSessionCount) refuse(`${RENDER_QUOTAS.perSessionCount} pictures for ${scope}`);
    if (own.bytes + bytes > RENDER_QUOTAS.perSessionBytes)
      refuse(`${RENDER_QUOTAS.perSessionBytes / (1024 * 1024)} MiB for ${scope}`);
    if (index.machine.count + 1 > RENDER_QUOTAS.machineCount)
      refuse(`${RENDER_QUOTAS.machineCount} pictures on this machine`);
    if (index.machine.bytes + bytes > RENDER_QUOTAS.machineBytes)
      refuse(`${RENDER_QUOTAS.machineBytes / (1024 * 1024 * 1024)} GiB on this machine`);
  }

  async #load(): Promise<RenderIndex> {
    this.#index ??= this.#build();
    try {
      return await this.#index;
    } catch (error) {
      // A failed listing is retried by the next request, never remembered as an empty store.
      this.#index = undefined;
      throw error;
    }
  }

  async #build(): Promise<RenderIndex> {
    const index = new RenderIndex();
    const metas = [...(await this.repository.listMetas())].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const meta of metas) index.add(meta);
    return index;
  }
}

const notFound = (id: string): RenderError => new RenderError('not_found', `no saved picture ${id}`);
