/**
 * Where a durable send row sits relative to the transcript currently loaded.
 *
 * The placement ALGORITHM (kteam's `placeLedgerBlocks`) is not ported yet; this
 * is its answer and the reading of it, which the row must show so a reader never
 * mistakes a boundary row for a chronological one.
 */
export type LedgerBlockPlacement = 'chronological' | 'before-loaded' | 'after-loaded' | 'unknown-time';

export const ledgerPlacementCopy = (placement: LedgerBlockPlacement): string | undefined => {
  if (placement === 'before-loaded') return 'older than the loaded transcript · shown at the history boundary';
  if (placement === 'after-loaded') return 'newer than the loaded transcript · shown at the history boundary';
  if (placement === 'unknown-time') return 'time position unavailable · shown at the loaded-history boundary';
  return undefined;
};
