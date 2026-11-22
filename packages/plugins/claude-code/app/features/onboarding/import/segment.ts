/**
 * What the Claude import pages remember between them, in the step segment (O1: memory of THIS RUN only, never stored).
 * The segment holds scalars, so each kind's left-out ids and the ticked GitHub tokens are JSON text. Every read is total:
 * a value that is missing or does not parse is "nothing left out", and what comes back is checked against the kit's id
 * grammar before it is used, so a stale or hand-made value can never send an id the daemon would read differently.
 * After a reload the memory is empty (owner add 5): see `importModeOf`, which every page uses and never defaults.
 */
import { type ImportItemId, ImportItemIdSchema } from '@ferretry/plugin-runtimes/contract';
import { IMPORT_KINDS, type ImportKind } from '@ferretry/plugin-runtimes/import-kit';
import type { StepSegmentMemory } from '@ferretry/kernel/contract';

export const HARNESS = 'claude-code' as const;
/** The scan the Claude pages share: read once per onboarding run (the kit caches it by this key). */
export const SCAN_RUN = 'onboarding-claude-code';

const skipKey = (kind: ImportKind): string => `skip:${kind}`;
const TICKED_KEY = 'tickedEnv';

const stringsOf = (segment: StepSegmentMemory, key: string): readonly string[] => {
  const raw = segment[key];
  if (typeof raw !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
};

/** The ids left out on one kind's page. */
export const leftOf = (segment: StepSegmentMemory, kind: ImportKind): ReadonlySet<ImportItemId> =>
  new Set(
    stringsOf(segment, skipKey(kind)).flatMap(id => {
      const parsed = ImportItemIdSchema.safeParse(id);
      return parsed.success ? [parsed.data] : [];
    }),
  );

/** Every id left out on any page (the skip list the import sends). */
export const allLeft = (segment: StepSegmentMemory): ReadonlySet<ImportItemId> =>
  new Set(IMPORT_KINDS.flatMap(kind => [...leftOf(segment, kind)]));

const RUN_PICK_KEY = 'pickedRun';

/**
 * What the person unticked on the FINAL page of an "Import everything" run, kept apart from the kind pages' memory (that
 * route never shows them, so an earlier one-by-one detour must not leak into it). `null` = nothing was unticked here.
 */
export const runPickOf = (segment: StepSegmentMemory): ReadonlySet<ImportItemId> | null => {
  if (typeof segment[RUN_PICK_KEY] !== 'string') return null;
  return new Set(
    stringsOf(segment, RUN_PICK_KEY).flatMap(id => {
      const parsed = ImportItemIdSchema.safeParse(id);
      return parsed.success ? [parsed.data] : [];
    }),
  );
};

export const runPickPatch = (left: ReadonlySet<ImportItemId>): Record<string, string> => ({
  [RUN_PICK_KEY]: JSON.stringify([...left]),
});

export const tickedEnvOf = (segment: StepSegmentMemory): ReadonlySet<string> => new Set(stringsOf(segment, TICKED_KEY));

export const leftPatch = (kind: ImportKind, left: ReadonlySet<ImportItemId>): Record<string, string> => ({
  [skipKey(kind)]: JSON.stringify([...left]),
});
export const tickedPatch = (ticked: ReadonlySet<string>): Record<string, string> => ({
  [TICKED_KEY]: JSON.stringify([...ticked]),
});
