/**
 * The live model list of one login (docs/model-catalog.md § Live model list): the model ids its provider said the key
 * can use, kept per login in `state/logins/model-lists/<login>.json`.
 *
 * IDS ONLY. No display name, price, owner, key or body of what the provider answered is kept or sent: a list is
 * identifiers a person could read off the provider's own page. A refresh is a request a person's own action causes
 * (Add login, Test, a picker open past a day, "Refresh list"); nothing here has a timer.
 */
import { defineState } from '@ferretry/kernel/contract';
import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';
import { LoginIdSchema } from './wire.ts';

/** The most ids one login's list keeps; a longer provider list is cut here and says so (`complete: false`). */
export const MODEL_LIST_MAX_IDS = 2_000;

/** One model id as a CLI takes it after `--model`: the catalog's own grammar, capped at 160 characters. */
export const MODEL_LIST_ID = /^[A-Za-z0-9~][A-Za-z0-9._:~/@+-]{0,159}$/u;

/** A held list older than this is read again when a picker opens. */
export const MODEL_LIST_FRESH_MS = 24 * 60 * 60 * 1_000;

/**
 * The least time between two attempts to read one login's list (the same login config), whatever the last attempt came
 * to: no caller, however many times it asks, reaches a provider more often than this. "Refresh list" is held to it.
 */
export const MODEL_LIST_FORCE_COOLDOWN_MS = 60 * 1_000;

/** The least time before a plain read (a picker opening on a stale list) follows an attempt that gave no list. */
export const MODEL_LIST_FAILED_COOLDOWN_MS = 15 * 60 * 1_000;

/**
 * The model ids a login's provider listed the last time it was asked, and when. `complete: false` says the provider
 * paged (or the list was cut), so an id missing from it proves nothing about the key.
 */
export const ModelListViewSchema = z.strictObject({
  fetchedAt: InstantSchema,
  complete: z.boolean(),
  ids: z.array(z.string().regex(MODEL_LIST_ID)).max(MODEL_LIST_MAX_IDS).readonly(),
});
export type ModelListView = z.infer<typeof ModelListViewSchema>;

/**
 * `POST /v1/logins/:loginId/model-list/refresh` (a picker opening, `fleet.use`) and `POST …/model-list/force` (the person's
 * "Refresh list", `fleet.configure`) take no body. The first reads only a list a day old or more; the second reads at
 * once. Both are held to the attempt cooldowns above.
 */
export const ModelListRefreshRequestSchema = z.strictObject({});
export type ModelListRefreshRequest = z.infer<typeof ModelListRefreshRequestSchema>;

/**
 * What a refresh came to. `current`: the held list is under a day old, nothing was sent. `refreshed`: a new list was
 * kept. `kept`: the provider did not give a usable list (down, 4xx/5xx, unparsable), so the last one stands, if any.
 * `unavailable`: this login has no way to list models (a sign-in, a preset whose Test is not a model list), or this
 * machine no longer has it. `cooling`: this login's list was attempted too lately to ask the provider again (a minute
 * after any attempt, fifteen after a failed one for a plain read), so nothing was sent and the held list is answered. A
 * provider that is down is an answer, never an error.
 */
export const ModelListRefreshResultSchema = z.strictObject({
  loginId: LoginIdSchema,
  outcome: z.enum(['current', 'refreshed', 'kept', 'unavailable', 'cooling']),
  list: ModelListViewSchema.optional(),
});
export type ModelListRefreshResult = z.infer<typeof ModelListRefreshResultSchema>;

/** `state/logins/model-lists/<login>.json`: the list and the format stamp. Never a credential. */
export const ModelListStateSchema = ModelListViewSchema.extend({ format: z.literal(1) });
export type ModelListState = z.infer<typeof ModelListStateSchema>;

export const LOGINS_MODEL_LISTS = defineState({
  name: 'model-lists',
  path: 'model-lists/*.json',
  store: 'json',
  format: 1,
  schema: ModelListStateSchema,
});
