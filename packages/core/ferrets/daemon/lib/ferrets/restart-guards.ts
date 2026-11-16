import type { FerretDetails } from '../../../contract/index.ts';

/**
 * What a resume refuses over a ferret whose LAST STOP was never confirmed (today's `authorizeResume`: the session
 * document says `kill_failed`). The old pane may still be alive and writing, so a second launch beside it would run two
 * writers on one conversation. A successful stop writes the document's `stopped`, which lifts it.
 */
export const STOP_UNCONFIRMED = (ferret: string): string =>
  `the previous terminal shutdown for ${ferret} was not confirmed; stop it successfully before resuming`;

/**
 * Whether a ferret's state document (`state.json`, as the session store reads it) says its last stop was not confirmed.
 * Only the exact status word counts: a document with no status, or one this build does not read, says nothing. Pure.
 */
export function stopUnconfirmedIn(state: unknown): boolean {
  return typeof state === 'object' && state !== null && (state as { status?: unknown }).status === 'kill_failed';
}

/**
 * The details a ferret's record holds once the label its session document was stamped with is carried to it, or
 * `undefined` when they already say it. The spawn stamp force-labels everything below the Warden (today's
 * `resolveSpawnLabel`) in the document; the registry kept only the label that was REQUESTED, so a reader of the record
 * (the Warden's own automatic-recovery guard reads the summary's label) saw a label the document did not hold. Pure.
 */
export function withStampedLabel(
  details: FerretDetails | undefined,
  label: string | undefined,
): FerretDetails | undefined {
  if (label === undefined || details?.options?.label === label) return undefined;
  return { ...details, options: { ...details?.options, label } };
}
