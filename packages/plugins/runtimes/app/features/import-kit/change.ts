/**
 * The one `setup.import` change a harness's onboarding pages end in. Pure: names only, never a value. The r9 wizard
 * and a plugin's own pages (Claude Code's, Codex's) build it here, so the same choices give the same change.
 */
import type { HarnessKey } from '@ferretry/core-ferrets/contract';
import { type AccountChange, type ImportItemId, ImportItemIdSchema } from '../../../contract/index.ts';

export interface ImportChangeExtras {
  /** The GitHub-token variables the person ticked (names). */
  readonly tickedEnv?: readonly string[];
  /** Changed sources the person chose to refresh (Import again). */
  readonly acceptedUpdates?: readonly string[];
}

/**
 * `include` is the harnesses being imported; `skip` is every item id the person left out, as pages accumulate them. An id of
 * a harness that is not in `include`, one the grammar refuses, and a repeat are dropped here, so a page can hand over its raw
 * list and the daemon never sees an id that could mean something else. `name` is the runtime name for `harness`.
 */
export function buildImportChange(
  harness: HarnessKey,
  include: readonly HarnessKey[],
  skip: Iterable<ImportItemId>,
  name: string,
  extras: ImportChangeExtras = {},
): AccountChange {
  const harnesses = include.includes(harness) ? include : [harness, ...include];
  const kept = [...new Set(skip)].filter(
    id => ImportItemIdSchema.safeParse(id).success && harnesses.some(entry => id.startsWith(`${entry}:`)),
  );
  const tickedEnv = extras.tickedEnv ?? [];
  const acceptedUpdates = extras.acceptedUpdates ?? [];
  return {
    kind: 'setup.import',
    include: [...harnesses],
    names: { [harness]: name.trim() },
    ...(kept.length === 0 ? {} : { skip: kept }),
    ...(tickedEnv.length === 0 ? {} : { tickedEnv: [...tickedEnv] }),
    ...(acceptedUpdates.length === 0 ? {} : { acceptedUpdates: [...acceptedUpdates] }),
  };
}
