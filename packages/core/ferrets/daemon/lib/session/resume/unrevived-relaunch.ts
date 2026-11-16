import type { ResumeOutcome } from './service.ts';

/**
 * The record keys a move restamps onto the target before it relaunches. A rollback puts back
 * exactly these and nothing else, so a rename, a rotated session credential or any other write made
 * since stays as it is.
 */
export const RESTAMPED_RECORD_KEYS = [
  'agent',
  'harness',
  'model',
  'modelHint',
  'launchModelSource',
  'command',
  'incarnation',
  'runtimeGeneration',
  'move',
  'moves',
  'transcript',
  'conversion',
  'harnessFlags',
  'launchReasoningEffort',
  'launchFast',
  'launchSettings',
  'updatedAt',
] as const;

/**
 * The key a move writes into config.json in the SAME write that restamps it: where the ferret was going, when, and the
 * restamped keys as they stood. config.json and ferret.json (the record) cannot be written together, so a crash between
 * the two leaves config.json naming the target while the record and the live pane are still on the source. This key is
 * what lets the next boot tell (the record is the pane's truth) and put config.json back from it.
 */
export const MOVE_INTENT_KEY = 'pendingMove';

/** `current` with only the restamped keys put back to what `before` held (a key `before` lacked is dropped), and no intent left. */
export function restoreRestamped(
  before: Readonly<Record<string, unknown>>,
  current: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const restored: Record<string, unknown> = { ...current };
  for (const key of RESTAMPED_RECORD_KEYS) {
    if (key in before) restored[key] = before[key];
    else delete restored[key];
  }
  delete restored[MOVE_INTENT_KEY];
  return restored;
}

/** The intent a move writes beside its restamp: the restamped keys of `retained`, as they stood before it. */
export function moveIntentOf(
  retained: Readonly<Record<string, unknown>>,
  move: { readonly from: string; readonly to: string; readonly at: string },
): Record<string, unknown> {
  const before: Record<string, unknown> = {};
  for (const key of RESTAMPED_RECORD_KEYS) if (key in retained) before[key] = retained[key];
  return { from: move.from, to: move.to, at: move.at, before };
}

/** What a boot does with one config.json that carries a move intent. */
export type InterruptedMove =
  | { readonly kind: 'none' }
  /** The record agrees with the target (or with neither): config.json is right, only the intent is dropped. */
  | { readonly kind: 'cleared'; readonly document: Record<string, unknown> }
  /** The record is still on the source: config.json is put back to the source, the pane's truth. */
  | {
      readonly kind: 'rolled_back';
      readonly document: Record<string, unknown>;
      readonly from: string;
      readonly to: string;
    };

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Decides one config.json's move intent against the runtime the ferret's RECORD serves (`serving`, which is what its pane
 * was launched from). An intent made at or after `bootedAtMs` is this process's own move in flight and is left alone, as
 * is a ferret whose record cannot be read (`serving` undefined): nothing is changed on a doubt.
 */
export function settleInterruptedMove(
  config: Readonly<Record<string, unknown>>,
  serving: string | undefined,
  bootedAtMs: number,
): InterruptedMove {
  if (!(MOVE_INTENT_KEY in config)) return { kind: 'none' };
  const dropped = (): Record<string, unknown> => {
    const rest: Record<string, unknown> = { ...config };
    delete rest[MOVE_INTENT_KEY];
    return rest;
  };
  const intent = config[MOVE_INTENT_KEY];
  const fields = typeof intent === 'object' && intent !== null && !Array.isArray(intent) ? intent : undefined;
  const from = textOf((fields as Record<string, unknown> | undefined)?.['from']);
  const to = textOf((fields as Record<string, unknown> | undefined)?.['to']);
  const at = textOf((fields as Record<string, unknown> | undefined)?.['at']);
  const before = (fields as Record<string, unknown> | undefined)?.['before'];
  const snapshot = typeof before === 'object' && before !== null && !Array.isArray(before) ? before : undefined;
  // An intent this code did not write cannot be acted on; it is dropped so it cannot mislead a later boot.
  if (from === undefined || to === undefined || at === undefined || snapshot === undefined)
    return { kind: 'cleared', document: dropped() };
  if (serving === undefined || Date.parse(at) >= bootedAtMs) return { kind: 'none' };
  if (serving === from && from !== to)
    return {
      kind: 'rolled_back',
      document: restoreRestamped(snapshot as Record<string, unknown>, config),
      from,
      to,
    };
  return { kind: 'cleared', document: dropped() };
}

/**
 * What a move says, and does to its record, when the relaunch onto the new login did not come up.
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

/**
 * A resume that was refused or threw (a pending question, a pane that could not be stopped) before it
 * launched anything. The record is put back only while the registered pane is provably the one that
 * served before the move; a changed or unreadable pane identity leaves it, as above. Answers the sentence
 * to add to the failure, empty when the record was left.
 */
export async function settleRejectedRelaunch(input: {
  readonly from: string;
  readonly paneBefore: string | undefined;
  readonly paneNow: string | undefined;
  readonly rollBack: () => Promise<void>;
}): Promise<string> {
  if (input.paneBefore === undefined || input.paneBefore !== input.paneNow) return '';
  await input.rollBack();
  return `; the previous harness is still serving, so the record names ${input.from} again`;
}
