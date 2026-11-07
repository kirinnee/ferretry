/**
 * Runtime ids — `<FY_HOME>/fleet/ids.json` (docs/design/account-model.md §3.5 R6, §5.4, §10.2.5).
 *
 * A runtime's id is opaque and lives in Ferretry's state, never in the configuration. That is what
 * lets every session record, task board and pricing row join on something a person can never edit
 * by accident: the configuration names a runtime by the word a person types, and this file maps that
 * word to the id the rest of Ferretry already knows it by.
 *
 * Each entry also carries the two facts a migrated runtime needs so nothing it had moves:
 *
 * - `formerNames` — the wrapper names it was launched as before, which keep resolving
 *   (`fy start --agent <old name>`), and
 * - `home` — where its config directory already is. Absent for a runtime made in version 2, whose
 *   config directory is simply `<homes>/<id>`.
 *
 * Pure: the file is read and written by the caller, and a new id is minted by an injected function,
 * so assigning ids is a value a test can assert on.
 */
import { z } from 'zod';
import { AccountIdSchema } from '../manifest.ts';
import { joinPath } from '../paths.ts';
import { RuntimeNameSchema } from './schema.ts';

/** The file, directly under the fleet directory, that holds every runtime's id. */
export const RUNTIME_IDS_FILE = 'ids.json';

/** `<fleet>/ids.json`. */
export const runtimeIdsPath = (fleetDirectory: string): string => joinPath(fleetDirectory, RUNTIME_IDS_FILE);

/** Bumped only when the on-disk shape changes incompatibly. */
export const RUNTIME_IDS_VERSION = 1 as const;

export const RuntimeIdEntrySchema = z.strictObject({
  id: AccountIdSchema,
  /** Wrapper names this runtime was launched as before, oldest first. They keep resolving. */
  formerNames: z.array(z.string().min(1)).default([]),
  /** Where its config directory already is, when that is not `<homes>/<id>`. Relative to the homes directory. */
  home: z.string().min(1).optional(),
});
export type RuntimeIdEntry = z.infer<typeof RuntimeIdEntrySchema>;

export const RuntimeIdsSchema = z
  .strictObject({
    version: z.literal(RUNTIME_IDS_VERSION),
    runtimes: z.record(RuntimeNameSchema, RuntimeIdEntrySchema).default({}),
  })
  .check(ctx => {
    // One id is one runtime, and one name resolves to one runtime: a repeat would make a join — or a
    // `fy start --agent <name>` — land on whichever entry happened to be read first.
    const owners = new Map<string, string>();
    for (const [name, entry] of Object.entries(ctx.value.runtimes)) {
      for (const [claim, what] of [[entry.id, 'id'], ...entry.formerNames.map(old => [old, 'former name'])] as const) {
        const key = `${what}:${claim}`;
        const owner = owners.get(key);
        if (owner !== undefined) {
          ctx.issues.push({
            code: 'custom',
            message: `runtimes "${owner}" and "${name}" both claim the ${what} "${claim}"`,
            input: claim,
            path: ['runtimes', name],
          });
        }
        owners.set(key, name);
      }
    }
  });
export type RuntimeIds = z.infer<typeof RuntimeIdsSchema>;

/** What a machine with no `ids.json` yet holds. */
export const EMPTY_RUNTIME_IDS: RuntimeIds = { version: RUNTIME_IDS_VERSION, runtimes: {} };

/** Read an untrusted `ids.json` document. Throws a `ZodError` naming what is wrong. */
export function parseRuntimeIds(raw: unknown): RuntimeIds {
  return RuntimeIdsSchema.parse(raw);
}

/** `ids.json`'s text, keys sorted, so re-writing an unchanged file is byte-identical. */
export function serializeRuntimeIds(ids: RuntimeIds): string {
  const runtimes = Object.fromEntries(
    Object.keys(ids.runtimes)
      .toSorted()
      .map(name => [name, ids.runtimes[name]]),
  );
  return `${JSON.stringify({ version: ids.version, runtimes }, null, 2)}\n`;
}

/** Raised when the injected generator keeps producing ids that are already taken. */
export class RuntimeIdExhaustedError extends Error {
  constructor(readonly runtime: string) {
    super(`could not mint an unused id for runtime "${runtime}"`);
    this.name = 'RuntimeIdExhaustedError';
  }
}

const MINT_ATTEMPTS = 8;

/**
 * The ids for exactly `names`: an existing entry is kept as it is, and a new name gets a freshly
 * minted id. An entry whose runtime is no longer configured is dropped — its config directory stays
 * on disk, and the name is free for a new runtime.
 */
export function assignRuntimeIds(names: readonly string[], existing: RuntimeIds, mint: () => string): RuntimeIds {
  const taken = new Set(Object.values(existing.runtimes).map(entry => entry.id));
  const runtimes: Record<string, RuntimeIdEntry> = {};
  for (const name of names) {
    const kept = existing.runtimes[name];
    if (kept !== undefined) {
      runtimes[name] = kept;
      continue;
    }
    let id = mint();
    for (let attempt = 1; taken.has(id) || !AccountIdSchema.safeParse(id).success; attempt++) {
      if (attempt >= MINT_ATTEMPTS) throw new RuntimeIdExhaustedError(name);
      id = mint();
    }
    taken.add(id);
    runtimes[name] = { id, formerNames: [] };
  }
  return parseRuntimeIds({ version: RUNTIME_IDS_VERSION, runtimes });
}

/**
 * `ids` with runtime `from` known as `to` from now on: the SAME entry — so its id, and with it its
 * config directory, every session record and every pricing row, stay — moved to the new name, with
 * `from` appended to its former names so `fy start --agent <from>` keeps starting it. Renaming back
 * to a name it had before takes that name out of the former names rather than claiming it twice.
 *
 * A runtime no apply has published yet has no entry, and the ids are answered unchanged: the apply
 * that publishes it under `to` mints its id then.
 */
export function renameRuntimeId(ids: RuntimeIds, from: string, to: string): RuntimeIds {
  const entry = ids.runtimes[from];
  if (entry === undefined || from === to) return ids;
  const { [from]: _moved, ...rest } = ids.runtimes;
  const formerNames = [...entry.formerNames.filter(name => name !== to && name !== from), from];
  return parseRuntimeIds({ ...ids, runtimes: { ...rest, [to]: { ...entry, formerNames } } });
}

/** A runtime found by {@link resolveRuntimeReference}, and which of its three spellings matched. */
export interface ResolvedRuntimeReference {
  readonly name: string;
  readonly entry: RuntimeIdEntry;
  readonly matched: 'name' | 'former-name' | 'id';
}

/**
 * The runtime a person or a record named: by its name, then by a name it was launched as before,
 * then by its id (§8.4). In that order, so a runtime's own name can never be shadowed by an older
 * one's former name.
 */
export function resolveRuntimeReference(ids: RuntimeIds, reference: string): ResolvedRuntimeReference | undefined {
  const entries = Object.entries(ids.runtimes);
  const byName = ids.runtimes[reference];
  if (byName !== undefined) return { name: reference, entry: byName, matched: 'name' };
  const former = entries.find(([, entry]) => entry.formerNames.includes(reference));
  if (former !== undefined) return { name: former[0], entry: former[1], matched: 'former-name' };
  const byId = entries.find(([, entry]) => entry.id === reference);
  return byId === undefined ? undefined : { name: byId[0], entry: byId[1], matched: 'id' };
}
