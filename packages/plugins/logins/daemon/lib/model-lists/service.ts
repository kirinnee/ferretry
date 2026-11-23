import type { Instant } from '@ferretry/std';
import { MODEL_LIST_FRESH_MS, type ModelListRefreshResult, type ModelListView } from '../../../contract/model-list.ts';
import { parseModelList } from './parse.ts';

/** Where a login's list is kept (`state/logins/model-lists/<login>.json`). A damaged or missing file reads as none. */
export interface ModelListStore {
  read(loginId: string): Promise<ModelListView | undefined>;
  write(loginId: string, list: ModelListView): Promise<void>;
  remove(loginId: string): Promise<void>;
  /** Every login that has a list. */
  logins(): Promise<readonly string[]>;
}

/**
 * What asking a login's provider for its list came to. `listed` carries the reply body (parsed JSON, never logged or
 * kept whole); every other word is "no usable list" (no way to list, the provider down, a 4xx or 5xx, an oversized or
 * unreadable body), and the last list stands.
 */
export type ModelListRead = { readonly kind: 'listed'; readonly payload: unknown } | { readonly kind: 'none' };

export interface ModelListServiceDeps {
  readonly store: ModelListStore;
  readonly now: () => Instant;
  readonly nowMs: () => number;
  /**
   * Ask the login's provider for its model list, with the login's own key on that one request (the Vault's
   * `authorizeFetch`, as a Test). `undefined` when the login has no way to list models (a sign-in; a preset whose Test
   * is not a list). Never throws.
   */
  readonly read: (loginId: string) => Promise<ModelListRead | undefined>;
  /** Run after a stored list differs from the one before it, so a picker offers it. It must never throw. */
  readonly onChanged?: () => Promise<void>;
}

/** Whether two lists name the same ids in the same state: a moved `fetchedAt` alone changes nothing a picker shows. */
const sameList = (left: ModelListView | undefined, right: ModelListView): boolean =>
  left !== undefined && left.complete === right.complete && left.ids.join('\n') === right.ids.join('\n');

/**
 * The live model list of each login (docs/model-catalog.md § Live model list).
 *
 * NOTHING HERE RUNS ON ITS OWN. A list is read when somebody's act causes it: Add login, Test, a picker that opens on a
 * list older than a day, and the person's "Refresh list". There is no timer and no retry, so a machine nobody looks at
 * asks no provider anything. The provider being down is an answer, not an error: the last list stands.
 *
 * A reply that is not a list (an error status, a body that is not a model list, a list with no usable id) is never
 * stored. Concurrent refreshes of one login share one request. Only ids are kept; the reply body is read and dropped,
 * and no line here logs it.
 *
 * It never reads or returns a secret: the key is put on the request by the Vault, which gives back only the body.
 */
export class ModelListService {
  readonly #reading = new Map<string, Promise<ModelListRefreshResult>>();

  constructor(private readonly deps: ModelListServiceDeps) {}

  /** The held list of one login. No IO beyond the file. */
  held(loginId: string): Promise<ModelListView | undefined> {
    return this.deps.store.read(loginId).catch(() => undefined);
  }

  /** Every held list, by login id. */
  async all(): Promise<Readonly<Record<string, ModelListView>>> {
    const logins = await this.deps.store.logins().catch(() => [] as readonly string[]);
    const entries = await Promise.all(logins.map(async id => [id, await this.held(id)] as const));
    return Object.fromEntries(entries.filter((entry): entry is [string, ModelListView] => entry[1] !== undefined));
  }

  /** Whether a picker opening now should read again: nothing held, or held for a day or more. */
  isStale(list: ModelListView | undefined): boolean {
    if (list === undefined) return true;
    const age = this.deps.nowMs() - Date.parse(list.fetchedAt);
    return !Number.isFinite(age) || age < 0 || age >= MODEL_LIST_FRESH_MS;
  }

  /**
   * Read this login's list when it is due, or whenever `force` says so ("Refresh list"). Callers that arrive while a
   * read of the same login is under way share its answer. Never throws.
   */
  refresh(loginId: string, options: { readonly force?: boolean } = {}): Promise<ModelListRefreshResult> {
    const running = this.#reading.get(loginId);
    if (running !== undefined) return running;
    const started = this.#refresh(loginId, options.force === true).finally(() => {
      this.#reading.delete(loginId);
    });
    this.#reading.set(loginId, started);
    return started;
  }

  /**
   * A Test already read the provider's reply: keep the ids in it when it is a model list, and otherwise leave the held
   * list alone. The reply is not kept, and nothing is thrown.
   */
  async record(loginId: string, payload: unknown): Promise<void> {
    try {
      await this.#store(loginId, payload);
    } catch {
      // A list that could not be kept is the list that was there; a Test's answer is unaffected.
    }
  }

  /** A removed login's list goes with it. */
  async forget(loginId: string): Promise<void> {
    await this.deps.store.remove(loginId).catch(() => undefined);
  }

  async #refresh(loginId: string, force: boolean): Promise<ModelListRefreshResult> {
    const held = await this.held(loginId);
    const answer = (outcome: ModelListRefreshResult['outcome'], list = held): ModelListRefreshResult => ({
      loginId: loginId as ModelListRefreshResult['loginId'],
      outcome,
      ...(list === undefined ? {} : { list }),
    });
    if (!force && !this.isStale(held)) return answer('current');
    let read: ModelListRead | undefined;
    try {
      read = await this.deps.read(loginId);
    } catch {
      read = { kind: 'none' };
    }
    if (read === undefined) return answer('unavailable');
    if (read.kind === 'none') return answer('kept');
    try {
      const stored = await this.#store(loginId, read.payload);
      return stored === undefined ? answer('kept') : answer('refreshed', stored);
    } catch {
      return answer('kept');
    }
  }

  /** Parse and keep; `undefined` when the reply is not a model list. */
  async #store(loginId: string, payload: unknown): Promise<ModelListView | undefined> {
    const parsed = parseModelList(payload);
    if (parsed === undefined) return undefined;
    const list: ModelListView = { fetchedAt: this.deps.now(), complete: parsed.complete, ids: parsed.ids };
    const before = await this.held(loginId);
    await this.deps.store.write(loginId, list);
    if (!sameList(before, list)) await this.deps.onChanged?.().catch(() => undefined);
    return list;
  }
}
