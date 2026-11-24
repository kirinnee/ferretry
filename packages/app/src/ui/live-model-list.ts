/**
 * What a login's LIVE model list (docs/model-catalog.md § Live model list) adds to a model picker, as ONE pure function
 * over what the picker already holds: the catalog's models and the ids the login's provider listed.
 *
 * - A curated model the list LACKS is marked "not offered to this key" and stays pickable (some providers hide models
 *   from `/models`). Only a COMPLETE list can say so: a paged or cut list proves nothing about a missing id.
 * - An id the list has that no curated model names is a "New from <provider>" row, in id order. It is offered, never
 *   adopted: nothing here reads or returns a default, so a refresh that adds a newer model cannot move one (D4).
 * - A list a day old or more is stale, said in words ("read 3 days ago"). The daemon reads it again when a picker opens
 *   and it is due; a provider that is down leaves the old list standing, and this is how a person sees that.
 *
 * Matching ignores a context suffix (`[1m]`) on a curated id and a dated snapshot suffix (`-20261101`) on a live one, so
 * `claude-opus-5-5-20261101` is the curated `claude-opus-5-5`, not a new model and not a missing one.
 *
 * Pure.
 */

/** A held list is read again when a picker opens and it is this old (the daemon's own `MODEL_LIST_FRESH_MS`). */
export const LIVE_MODEL_LIST_FRESH_MS = 24 * 60 * 60 * 1_000;

/** The model ids a login's provider listed, and when (the wire's `ModelListView`). */
export interface LiveModelList {
  readonly fetchedAt: string;
  readonly complete: boolean;
  readonly ids: readonly string[];
}

/** What a picker draws from a list. `undefined` pieces are simply not drawn. */
export interface LiveModelPicker {
  /** Curated ids the list lacks, to be marked "not offered to this key". Empty for a list that is not complete. */
  readonly notOffered: ReadonlySet<string>;
  /** Ids the list has that no curated model names, in id order: the "New from <provider>" rows. */
  readonly newIds: readonly string[];
  /** The list is a day old or more. */
  readonly stale: boolean;
  /** When the list was read, as a sentence fragment: `today`, `3 hours ago`, `2 days ago`. */
  readonly readAgo: string;
}

const CONTEXT_SUFFIX = /\[[a-z0-9]{1,8}\]$/u;
const SNAPSHOT_SUFFIX = /-\d{8}$/u;

const curatedKey = (id: string): string => id.replace(CONTEXT_SUFFIX, '');
const liveKey = (id: string): string => id.replace(SNAPSHOT_SUFFIX, '');

/** How long ago, in words a picker can put in a sentence. A time in the future or unreadable reads as `just now`. */
export function agoWords(fetchedAt: string, now: number): string {
  const read = Date.parse(fetchedAt);
  const ms = Number.isNaN(read) ? 0 : Math.max(0, now - read);
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return 'just now';
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${String(hours)} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day ago' : `${String(days)} days ago`;
}

/** The picker data for a catalog's models and a login's live list (module doc). `now` is epoch milliseconds. */
export function liveModelPicker(
  models: readonly { readonly id: string; readonly local?: true | undefined }[],
  list: LiveModelList,
  now: number,
): LiveModelPicker {
  const curated = models.filter(model => model.local !== true).map(model => curatedKey(model.id));
  const named = new Set(curated);
  const live = new Set(list.ids.flatMap(id => [id, liveKey(id)]));
  const read = Date.parse(list.fetchedAt);
  return {
    notOffered: new Set(
      list.complete
        ? models.filter(model => model.local !== true && !live.has(curatedKey(model.id))).map(model => model.id)
        : [],
    ),
    newIds: [...new Set(list.ids.filter(id => !named.has(id) && !named.has(liveKey(id))))].sort(),
    stale: !Number.isNaN(read) && now - read >= LIVE_MODEL_LIST_FRESH_MS,
    readAgo: agoWords(list.fetchedAt, now),
  };
}
