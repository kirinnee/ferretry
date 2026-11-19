import { createHash } from 'node:crypto';
import type { Log, StatePort } from '@ferretry/kernel/contract';
import type { GitAccountId } from '@ferretry/plugin-git-accounts/contract';
import {
  CacheEntrySchema,
  MAX_CACHE_BYTES_PER_PROJECT,
  MAX_CACHE_ENTRY_BYTES,
  PULLS_CACHE,
  type CacheEntry,
} from '../../../contract/index.ts';

/** What a caller hands over to keep: the answer's validator, its paging link and its body. */
export interface CachePut {
  readonly etag: string;
  readonly link?: string | undefined;
  readonly body: unknown;
}

interface Kept {
  bytes: number;
  at: number;
}

const nameOf = (account: GitAccountId, path: string): string =>
  `${account}-${createHash('sha256').update(path).digest('hex').slice(0, 32)}.json`;
const PROJECT_DIR = /^[A-Za-z0-9_][A-Za-z0-9._%~-]{0,200}$/u;

/**
 * The per-project cache of GitHub answers (`state/pulls/cache/<project>/…`). It holds private code, so:
 * - files are `0600` in `0700` folders (the state port's defaults for an opaque tree);
 * - a project keeps at most 32 MiB, oldest written out first, and one answer over 8 MiB is not kept;
 * - a project's folder goes when the project does, and an account's files go when the account does.
 * Nothing here ever sees a token: an entry is an ETag, a `Link` header and the answer's JSON.
 */
export class PullsCache {
  /** project → file name → size and write time. Built from disk the first time a project is touched. */
  readonly #index = new Map<string, Map<string, Kept>>();
  #chain: Promise<unknown> = Promise.resolve();
  /**
   * The fence. Each purge moves the epoch of what it removes (a project, an account) BEFORE it queues, so a read that
   * began earlier carries a stamp that no longer matches and its write is dropped; nothing recreates a purged cache.
   */
  readonly #epochs = new Map<string, number>();

  constructor(
    private readonly state: StatePort,
    private readonly nowMs: () => number,
    private readonly log: Log,
  ) {}

  /** One writer at a time: the index and the disk move together. */
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(fn, fn);
    this.#chain = next.catch(() => undefined);
    return next;
  }

  #epoch(scope: string): number {
    return this.#epochs.get(scope) ?? 0;
  }

  #bump(scope: string): void {
    this.#epochs.set(scope, this.#epoch(scope) + 1);
  }

  /** What a read takes before it asks GitHub and hands back to `put`: valid only while neither side was purged. */
  stamp(project: string, account: GitAccountId): string {
    return `${this.#epoch(`p:${project}`)}.${this.#epoch(`a:${account}`)}`;
  }

  async get(project: string, account: GitAccountId, path: string): Promise<CacheEntry | undefined> {
    if (!PROJECT_DIR.test(project)) return undefined;
    const name = `${project}/${nameOf(account, path)}`;
    const read = await this.state.read(PULLS_CACHE, name);
    if (!read.ok || read.value === undefined) return undefined;
    try {
      const bytes = read.value as unknown;
      const text = bytes instanceof Uint8Array ? new TextDecoder().decode(bytes) : String(bytes);
      const entry = CacheEntrySchema.parse(JSON.parse(text));
      if (entry.path === path) return entry;
    } catch {
      // damaged or foreign: falls through and is dropped, the next read of GitHub refills it
    }
    await this.#serial(async () => await this.#drop(project, nameOf(account, path)));
    return undefined;
  }

  /** Keeps an answer. With a `stamp` (taken before the read), nothing is written if the project or account was purged since. */
  async put(
    project: string,
    account: GitAccountId,
    path: string,
    value: CachePut,
    stamp: string = this.stamp(project, account),
  ): Promise<void> {
    if (!PROJECT_DIR.test(project)) return;
    const entry: CacheEntry = {
      format: 1,
      path,
      etag: value.etag,
      ...(value.link === undefined ? {} : { link: value.link }),
      storedAt: new Date(this.nowMs()).toISOString(),
      body: value.body,
    };
    const text = JSON.stringify(entry);
    const bytes = Buffer.byteLength(text);
    if (bytes > MAX_CACHE_ENTRY_BYTES) return;
    await this.#serial(async () => {
      if (stamp !== this.stamp(project, account)) return;
      const files = await this.#load(project);
      const file = nameOf(account, path);
      // Room first, then the write: the folder is never over its bound, not even for a moment.
      if (!(await this.#reserve(project, files, file, bytes))) return;
      await this.state.write(PULLS_CACHE, text as never, `${project}/${file}`);
      files.set(file, { bytes, at: this.nowMs() });
    });
  }

  /** Deletes everything kept for a project, and its folder. A file that will not go is logged; the next sweep retries. */
  async purgeProject(project: string): Promise<void> {
    if (!PROJECT_DIR.test(project)) return;
    this.#bump(`p:${project}`);
    await this.#serial(async () => {
      try {
        for (const file of await this.state.entries(PULLS_CACHE, project))
          if (file.kind === 'file') await this.state.remove(PULLS_CACHE, `${project}/${file.name}`);
        await this.state.removeEmptyDirectory(PULLS_CACHE, project).catch(() => undefined);
        this.#index.delete(project);
      } catch (error) {
        this.log.warn("a removed project's cache could not be deleted; the next sweep retries", {
          reason: error instanceof Error ? error.name : 'error',
        });
      }
    });
  }

  /** Deletes every file kept for an account, in every project. */
  async purgeAccount(account: GitAccountId): Promise<void> {
    this.#bump(`a:${account}`);
    await this.#serial(async () => {
      for (const project of await this.state.list(PULLS_CACHE)) {
        for (const file of await this.state.entries(PULLS_CACHE, project))
          if (file.kind === 'file' && file.name.startsWith(`${account}-`)) await this.#drop(project, file.name);
        await this.state.removeEmptyDirectory(PULLS_CACHE, project).catch(() => undefined);
      }
    });
  }

  /**
   * Drops what belongs to a project or an account that no longer exists. Removal of an account has no event, so this
   * runs at boot and on a timer as well as on `projects.removed`.
   */
  async reconcile(projects: ReadonlySet<string>, accounts: ReadonlySet<string>): Promise<void> {
    await this.#serial(async () => {
      for (const project of await this.state.list(PULLS_CACHE)) {
        if (!projects.has(project)) {
          this.#bump(`p:${project}`);
          for (const file of await this.state.entries(PULLS_CACHE, project))
            if (file.kind === 'file') await this.state.remove(PULLS_CACHE, `${project}/${file.name}`);
          await this.state.removeEmptyDirectory(PULLS_CACHE, project).catch(() => undefined);
          this.#index.delete(project);
          continue;
        }
        for (const file of await this.state.entries(PULLS_CACHE, project)) {
          const owner = /^(gha_[0-9]{1,20})-/u.exec(file.name)?.[1];
          if (file.kind !== 'file' || owner === undefined || !accounts.has(owner)) {
            if (owner !== undefined) this.#bump(`a:${owner}`);
            await this.state.remove(PULLS_CACHE, `${project}/${file.name}`);
            this.#index.get(project)?.delete(file.name);
          }
        }
      }
    });
  }

  /** What a project's cache holds now (bytes and files), for a test and for a screen that wants to say so. */
  async usage(project: string): Promise<{ readonly bytes: number; readonly files: number }> {
    return await this.#serial(async () => {
      const files = await this.#load(project);
      let bytes = 0;
      for (const kept of files.values()) bytes += kept.bytes;
      return { bytes, files: files.size };
    });
  }

  async #drop(project: string, file: string): Promise<void> {
    await this.state.remove(PULLS_CACHE, `${project}/${file}`);
    this.#index.get(project)?.delete(file);
  }

  async #load(project: string): Promise<Map<string, Kept>> {
    const known = this.#index.get(project);
    if (known !== undefined) return known;
    const files = new Map<string, Kept>();
    for (const entry of await this.state.entries(PULLS_CACHE, project)) {
      if (entry.kind !== 'file') continue;
      const name = `${project}/${entry.name}`;
      const [version, stat] = await Promise.all([
        this.state.version(PULLS_CACHE, name),
        this.state.stat(PULLS_CACHE, name),
      ]);
      if (version !== undefined && stat !== undefined)
        files.set(entry.name, { bytes: version.size, at: stat.modifiedMs });
    }
    this.#index.set(project, files);
    return files;
  }

  /**
   * Makes room for one entry before it is written: oldest out first (the entry it replaces does not count) until the
   * project plus the new bytes fit. `false` when it will not fit, or a file will not go: then nothing is written.
   */
  async #reserve(project: string, files: Map<string, Kept>, replacing: string, incoming: number): Promise<boolean> {
    let total = incoming;
    for (const [name, kept] of files) if (name !== replacing) total += kept.bytes;
    const oldest = [...files.entries()].filter(([name]) => name !== replacing).toSorted((a, b) => a[1].at - b[1].at);
    for (const [name, kept] of oldest) {
      if (total <= MAX_CACHE_BYTES_PER_PROJECT) break;
      try {
        await this.#drop(project, name);
        total -= kept.bytes;
      } catch (error) {
        this.log.warn('a cache file could not be removed', {
          project,
          reason: error instanceof Error ? error.name : 'error',
        });
        return false;
      }
    }
    return total <= MAX_CACHE_BYTES_PER_PROJECT;
  }
}
