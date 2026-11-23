import type { CompactionExtras, LaunchPart, LaunchPartSource } from '@ferretry/core-ferrets/contract';

/**
 * WHAT BOARD ADDS TO A FERRET'S COMPACTION TEXTS, in Board's own words. A ferret's task is Board's, so the lines that name
 * it (its id and sitrep to keep, the re-read step with its editable form, the board-status fallback) live here and reach a
 * launch only while Board is on (the `work` switch): core's compaction text (`core-ferrets` `compaction-text.ts`) holds
 * the frame and takes these through the `compaction` launch part, so neither harness carries a second copy.
 *
 * The verbs are Board's own (`task show`, `board status`); a unit test reads the manifest and fails on one it does not
 * declare. The words hold no `'` and no `%`: Claude prints them through `printf '…'`.
 */
export const BOARD_COMPACTION: CompactionExtras = {
  reabsorb:
    'Your board task, if you have one: `fy task show <task id>` (add --yaml for the editable form); if you do not know the id, `fy board status` says whether the board is on.',
  keep: 'your task id and its status (now, done so far, next)',
  reread: 'the task',
};

/** What Board adds to every launch's compaction texts: the same lines for a lead and a sub-ferret. */
export const boardCompactionParts = (): LaunchPartSource => ({
  parts: async (): Promise<readonly LaunchPart[]> => [{ kind: 'compaction', ...BOARD_COMPACTION }],
});
