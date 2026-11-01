import type { ResumeOutcome } from './service.ts';

/**
 * The record keys a migration restamps onto the target before it relaunches. A rollback puts back
 * exactly these and nothing else, so a rename, a rotated session credential or any other write made
 * since stays as it is.
 */
export const RESTAMPED_RECORD_KEYS = [
  'agent',
  'harness',
  'model',
  'modelHint',
  'command',
  'incarnation',
  'runtimeGeneration',
  'migration',
  'migrations',
  'transcript',
  'conversion',
  'harnessFlags',
  'launchReasoningEffort',
  'launchFast',
  'launchSettings',
] as const;

/** `current` with only the restamped keys put back to what `before` held (a key `before` lacked is dropped). */
export function restoreRestamped(
  before: Readonly<Record<string, unknown>>,
  current: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const restored: Record<string, unknown> = { ...current };
  for (const key of RESTAMPED_RECORD_KEYS) {
    if (key in before) restored[key] = before[key];
    else delete restored[key];
  }
  return restored;
}

/**
 * What a migration says, and does to its record, when the relaunch onto the new login did not come up.
 *
 * `preserved` only says a pane is alive. The resume kills the old pane before it launches the target,
 * so that pane is usually the NEW harness, whose first message failed to deliver. The record is put
 * back (`rollBack`) only when the registered pane is provably the one that served before the move
 * (`paneBefore` equals `paneNow`): then no replacement was ever registered and the previous login is
 * still serving. A changed pane is the target, so the record already tells the truth; an unreadable
 * identity proves nothing, so the record is left and the detail says to Restart. Any other outcome is a
 * retry already scheduled against the restamped record, which that retry needs, so the record stays.
 */
export async function settleUnrevivedRelaunch(input: {
  readonly disposition: Exclude<ResumeOutcome['disposition'], 'revived'>;
  readonly from: string;
  readonly to: string;
  readonly paneBefore: string | undefined;
  readonly paneNow: string | undefined;
  readonly rollBack: () => Promise<void>;
}): Promise<string> {
  if (input.disposition !== 'preserved')
    return `the relaunch failed and an automatic retry was scheduled; the session is still on ${input.from}`;
  if (input.paneBefore === undefined || input.paneNow === undefined)
    return (
      `the relaunch failed and a harness is still running, but which login it serves could not be proven, ` +
      `so the record still names ${input.to}; restart the session to settle it`
    );
  if (input.paneBefore !== input.paneNow)
    return (
      `the new harness on ${input.to} started but the hand-over message was not delivered; ` +
      `the session is serving ${input.to} and its record names it`
    );
  await input.rollBack();
  return (
    `the relaunch failed before a new harness was registered, so ${input.from} is still serving ` +
    `this session and its record names ${input.from} again`
  );
}
