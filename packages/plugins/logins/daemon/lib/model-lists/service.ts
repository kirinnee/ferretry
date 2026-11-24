import type { Instant } from '@ferretry/std';
import {
  MODEL_LIST_FAILED_COOLDOWN_MS,
  MODEL_LIST_FORCE_COOLDOWN_MS,
  MODEL_LIST_FRESH_MS,
  type ModelListRefreshResult,
  type ModelListView,
} from '../../../contract/model-list.ts';
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
   * The login's configuration revision in effect now (a fingerprint of what its key and address are), or `undefined`
   * when this machine does not have the login. A read is tagged with the revision it began under and is kept only if
   * that revision is still the one in effect when its reply arrives. Synchronous, and never throws.
   */
  readonly revision: (loginId: string) => string | undefined;
  /**
   * Ask the login's provider for its model list, with the login's own key on that one request (the Vault's
   * `authorizeFetch`, as a Test). `undefined` when the login has no way to list models (a sign-in; a preset whose Test
   * is not a list). Never throws.
   */
  readonly read: (loginId: string) => Promise<ModelListRead | undefined>;
  /** Run after a stored list differs from the one before it, so a picker offers it. It must never throw. */
  readonly onChanged?: () => Promise<void>;
}

/** What a read began under: the login's configuration and how many times it had been removed. */
interface ReadTag {
  readonly revision: string;
  readonly removals: number;
}

const sameTag = (left: ReadTag, right: ReadTag): boolean =>
  left.revision === right.revision && left.removals === right.removals;

/** The last time a login's provider was asked, and whether that gave no list. */
interface Attempt {
  readonly tag: ReadTag;
  readonly atMs: number;
  failed: boolean;
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
  /** The read under way for each login, with the tag it began under (one login, one read per revision). */
  readonly #reading = new Map<string, { readonly tag: ReadTag; readonly promise: Promise<ModelListRefreshResult> }>();
  /** The last attempt to ask each login's provider, of any outcome: what the cooldowns count from. */
  readonly #attempts = new Map<string, Attempt>();
  /** How many times each login has been removed here: a read begun before a removal can never be kept after it. */
  readonly #removals = new Map<string, number>();
  /** The writes and removals of one login's file, in turn, so none interleaves with another. */
  readonly #turns = new Map<string, Promise<unknown>>();

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
    const tag = this.#tag(loginId);
    if (tag === undefined) return Promise.resolve(this.#answer(loginId, 'unavailable'));
    const running = this.#reading.get(loginId);
    // A read of the login as it is now is shared; a read of the login as it WAS (a key or address edited since) is not.
    if (running !== undefined && sameTag(running.tag, tag)) return running.promise;
    const promise = this.#refresh(loginId, tag, options.force === true).finally(() => {
      if (this.#reading.get(loginId)?.promise === promise) this.#reading.delete(loginId);
    });
    this.#reading.set(loginId, { tag, promise });
    return promise;
  }

  /**
   * A Test is about to ask the provider: the function that keeps the ids of its reply when it is a model list, and
   * otherwise leaves the held list alone. It is tagged with the login as it is NOW, so a reply that comes back after the
   * login was edited or removed is dropped. The reply is not kept, and nothing is thrown.
   */
  recorder(loginId: string): (payload: unknown) => Promise<void> {
    const tag = this.#tag(loginId);
    return async payload => {
      if (tag === undefined) return;
      try {
        const stored = await this.#store(loginId, tag, payload);
        if (stored !== undefined) this.#attempts.set(loginId, { tag, atMs: this.deps.nowMs(), failed: false });
      } catch {
        // A list that could not be kept is the list that was there; a Test's answer is unaffected.
      }
    };
  }

  /** A Test already read the provider's reply, now: {@link recorder} for a reply in hand. */
  async record(loginId: string, payload: unknown): Promise<void> {
    await this.recorder(loginId)(payload);
  }

  /**
   * A removed login's list goes with it. Every read that began before this can no longer be kept, and a login of the same
   * name added later starts with no attempt on record.
   */
  async forget(loginId: string): Promise<void> {
    this.#removals.set(loginId, (this.#removals.get(loginId) ?? 0) + 1);
    this.#attempts.delete(loginId);
    await this.#inTurn(loginId, async () => {
      await this.deps.store.remove(loginId).catch(() => undefined);
    });
  }

  #tag(loginId: string): ReadTag | undefined {
    const revision = this.deps.revision(loginId);
    return revision === undefined ? undefined : { revision, removals: this.#removals.get(loginId) ?? 0 };
  }

  /** Whether the login still is what a read began under: it exists, with that revision, and was not removed since. */
  #current(loginId: string, tag: ReadTag): boolean {
    const now = this.#tag(loginId);
    return now !== undefined && sameTag(now, tag);
  }

  #answer(loginId: string, outcome: ModelListRefreshResult['outcome'], list?: ModelListView): ModelListRefreshResult {
    return {
      loginId: loginId as ModelListRefreshResult['loginId'],
      outcome,
      ...(list === undefined ? {} : { list }),
    };
  }

  /** Run one step of a login's file in its turn. A failed step does not stop the next. */
  #inTurn<T>(loginId: string, step: () => Promise<T>): Promise<T> {
    const run = (this.#turns.get(loginId) ?? Promise.resolve()).catch(() => undefined).then(step);
    const turn = run.catch(() => undefined);
    this.#turns.set(loginId, turn);
    void turn.then(() => {
      if (this.#turns.get(loginId) === turn) this.#turns.delete(loginId);
    });
    return run;
  }

  async #refresh(loginId: string, tag: ReadTag, force: boolean): Promise<ModelListRefreshResult> {
    const held = await this.held(loginId);
    const answer = (outcome: ModelListRefreshResult['outcome'], list = held): ModelListRefreshResult =>
      this.#answer(loginId, outcome, list);
    if (!force && !this.isStale(held)) return answer('current');
    if (this.#cooling(loginId, tag, force)) return answer('cooling');
    // The attempt is on record before the request is sent, so nothing that asks while it is under way, or after it
    // fails, can send another.
    const attempt: Attempt = { tag, atMs: this.deps.nowMs(), failed: true };
    this.#attempts.set(loginId, attempt);
    let read: ModelListRead | undefined;
    try {
      read = await this.deps.read(loginId);
    } catch {
      read = { kind: 'none' };
    }
    if (read === undefined) {
      // Nothing was sent: there is no attempt to count from.
      if (this.#attempts.get(loginId) === attempt) this.#attempts.delete(loginId);
      return answer('unavailable');
    }
    if (read.kind === 'none') return answer('kept');
    try {
      const stored = await this.#store(loginId, tag, read.payload);
      if (stored === undefined) return answer('kept');
      attempt.failed = false;
      return answer('refreshed', stored);
    } catch {
      return answer('kept');
    }
  }

  /**
   * Whether this login's provider was asked too lately to be asked again: a minute after any attempt, and for a plain
   * read (nobody pressed anything) fifteen minutes after one that gave no list. An attempt under an older revision of
   * the login does not count: an edited login is a new login to ask.
   */
  #cooling(loginId: string, tag: ReadTag, force: boolean): boolean {
    const last = this.#attempts.get(loginId);
    if (last === undefined || !sameTag(last.tag, tag)) return false;
    const since = this.deps.nowMs() - last.atMs;
    // A clock that moved back reads as "just now": the safe side.
    const wait = !force && last.failed ? MODEL_LIST_FAILED_COOLDOWN_MS : MODEL_LIST_FORCE_COOLDOWN_MS;
    return since < wait;
  }

  /**
   * Parse and keep; `undefined` when the reply is not a model list, or when the login is not what the read began under
   * (edited, removed, or removed and added again): that reply says nothing about the login as it is.
   */
  async #store(loginId: string, tag: ReadTag, payload: unknown): Promise<ModelListView | undefined> {
    const parsed = parseModelList(payload);
    if (parsed === undefined) return undefined;
    const list: ModelListView = { fetchedAt: this.deps.now(), complete: parsed.complete, ids: parsed.ids };
    const written = await this.#inTurn(loginId, async () => {
      // Asked again inside the turn: a removal that came while this waited has already emptied the file.
      if (!this.#current(loginId, tag)) return false;
      const before = await this.held(loginId);
      await this.deps.store.write(loginId, list);
      return sameList(before, list) ? 'same' : 'changed';
    });
    if (written === false) return undefined;
    if (written === 'changed') await this.deps.onChanged?.().catch(() => undefined);
    return list;
  }
}
