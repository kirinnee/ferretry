import type { RestartQueued, RestartResult, RestartStatus } from '@ferretry/protocol';

export const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;
const label = (entry: { readonly id: string; readonly name?: string }): string =>
  entry.name === undefined ? entry.id : `${entry.name} (${entry.id})`;

const WHY: Readonly<Record<RestartQueued['reason'], string>> = {
  'mid-turn': 'it is working; it restarts at its next idle moment',
  'in-flight': 'it has work a restart would lose; it restarts once that is done',
  'own-session': 'it is the session that asked; it restarts when its own turn ends',
};

/** What a restart did, as lines a person reads: restarted now first, then waiting, left alone and failed. */
export function renderRestartResult(result: RestartResult): readonly string[] {
  const { restarted, queued, skipped, failed } = result;
  if (restarted.length + queued.length + skipped.length + failed.length === 0) return ['Nothing to restart.'];
  return [
    `Restarted now: ${restarted.length}`,
    ...restarted.map(entry => `  ${label(entry)}`),
    `Queued for their next idle moment: ${queued.length}`,
    ...queued.map(entry => `  ${label(entry)}: ${entry.detail ?? WHY[entry.reason]}`),
    ...(skipped.length === 0 ? [] : [`Left alone: ${skipped.length}`]),
    ...skipped.map(entry => `  ${label(entry)}: ${entry.reason.replaceAll('-', ' ')}`),
    ...(failed.length === 0 ? [] : [`Failed: ${failed.length}`]),
    ...failed.map(entry => `  ${label(entry)}: ${entry.reason}`),
  ];
}

/** The outdated ferrets and the waiting restarts, for `fy restart` with nothing to restart named. */
export function renderRestartStatus(status: RestartStatus): readonly string[] {
  if (status.outdated.length === 0 && status.queued.length === 0) return ['Every running ferret is up to date.'];
  return [
    `Out of date: ${status.outdated.length}`,
    ...status.outdated.map(entry => `  ${label(entry)}: ${entry.sections.join(', ')}`),
    `Waiting to restart: ${status.queued.length}`,
    ...status.queued.map(entry => `  ${label(entry)}: ${WHY[entry.reason]}`),
    ...(status.outdated.length === 0 ? [] : ['Run `fy restart --outdated` to restart them.']),
  ];
}
