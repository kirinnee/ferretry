import type { StartSessionRequestInput, TaskBoardAccess } from '@ferretry/protocol';
import { SessionCommandError } from './errors.ts';
import type { SessionEnvironment } from './ports.ts';

/**
 * A value at or below this many seconds looks like someone reaching for a readiness wait ("give it
 * a couple of minutes to come up") rather than a work ceiling — the exact misread that killed a
 * healthy session in the source system.
 */
export const TURN_TIMEOUT_HINT_SECONDS = 600;

/** The numeric `start` flags, kept together so one validator covers all of them. */
interface StartNumericFlags {
  readonly interval?: number;
  readonly turnTimeout?: number;
  readonly nudgeAfter?: number;
  readonly stallKillAfter?: number;
  readonly directMax?: number;
  readonly maxSnapshots?: number;
}

/** Every `start` flag, already parsed out of argv by the composition root. */
export interface StartFlags extends StartNumericFlags {
  readonly agent: string;
  readonly mode: 'auto' | 'interactive';
  readonly prompt?: string;
  readonly name?: string;
  readonly teammate?: string;
  readonly teammateFallback?: boolean;
  readonly label?: string;
  readonly parent?: string;
  readonly boardAccess?: TaskBoardAccess;
  readonly model?: string;
  /** Only set when the caller actually passed `--rc`/`--no-rc`; unset leaves the daemon default. */
  readonly remoteControl?: boolean;
  readonly harnessFlags?: readonly string[];
  readonly cwd?: string;
  readonly detach?: boolean;
  readonly attachments?: ReadonlyArray<{ filename: string; mime?: string; base64: string }>;
}

export interface StartPlan {
  readonly request: StartSessionRequestInput;
  readonly boardCapability?: string;
  /** Advisory notes for stderr — never a refusal, and never on stdout where `--json` would break. */
  readonly warnings: readonly string[];
}

/**
 * Which session, if any, becomes the parent.
 *
 * An `auto` teammate started from inside a pane inherits that pane, so delegated teammate trees
 * draw correctly in `ps` and in the lineage view. An `interactive` session does not: it is the
 * human's own terminal, and parenting it under whichever agent happened to type the command renders
 * the lineage backwards. An explicit `--parent` always wins.
 */
export function resolveParent(input: {
  explicit?: string;
  callerSessionId?: string;
  mode: 'auto' | 'interactive';
}): string | undefined {
  const explicit = input.explicit?.trim();
  if (explicit !== undefined && explicit !== '') return explicit;
  if (input.mode === 'interactive') return undefined;
  const caller = input.callerSessionId?.trim();
  return caller === undefined || caller === '' ? undefined : caller;
}

const NUMERIC_FLAG_NAMES: ReadonlyArray<[keyof StartNumericFlags, string, boolean]> = [
  ['interval', '--interval', true],
  ['turnTimeout', '--turn-timeout', true],
  ['nudgeAfter', '--nudge-after', false],
  ['stallKillAfter', '--stall-kill-after', false],
  ['directMax', '--direct-max', false],
  ['maxSnapshots', '--max-snapshots', true],
];

/**
 * Rejects numeric flags argv could not turn into a number.
 *
 * Commander hands back `NaN` for `--interval banana`, and the source passed it straight to the wire
 * where it surfaced as an opaque schema error naming a field the caller never typed.
 */
function assertNumericFlags(flags: StartNumericFlags): void {
  for (const [key, flag, positive] of NUMERIC_FLAG_NAMES) {
    const value = flags[key];
    if (value === undefined) continue;
    const floor = positive ? 1 : 0;
    if (!Number.isInteger(value) || value < floor)
      throw new SessionCommandError(`${flag} must be an integer of at least ${floor}`);
  }
}

/**
 * Turns the `start` flags into a wire request.
 *
 * Three source defects are fixed here. `--timeout` and its `--kill-after-seconds` alias both meant
 * "kill a turn that overruns", while a separately spelled `--kill-after` meant "kill a session with
 * no life signs" — one letter apart, opposite subjects. They are now `--turn-timeout` and
 * `--stall-kill-after`, with the small-value hint kept. Numeric flags are validated here instead of
 * failing on the wire. And a board-access start states plainly that it needs a capability instead
 * of asking the client library to notice.
 */
export function buildStartRequest(flags: StartFlags, environment: SessionEnvironment): StartPlan {
  assertNumericFlags(flags);

  const prompt = flags.prompt?.trim() ?? '';
  // An interactive session is a terminal for a human: starting one bare is the normal case, and
  // nothing is typed into it. Auto mode still needs a task — an autonomous teammate with no
  // assignment can only misbehave.
  if (prompt === '' && flags.mode !== 'interactive')
    throw new SessionCommandError(
      'provide a prompt (arguments and/or --prompt-file), or use --mode interactive to start bare',
    );

  const boardAccess = flags.boardAccess ?? 'none';
  const boardCapability = environment.boardCapability?.trim();
  if (boardAccess !== 'none' && (boardCapability === undefined || boardCapability === ''))
    throw new SessionCommandError(
      `--board-access ${boardAccess} needs the caller's own board capability; run it from a session whose FY_BOARD_CAPABILITY is set`,
    );

  const warnings =
    flags.turnTimeout !== undefined && flags.turnTimeout < TURN_TIMEOUT_HINT_SECONDS
      ? [
          `note: --turn-timeout is a hard KILL timer — the session is terminated when a turn runs longer than ${flags.turnTimeout}s. It is not a readiness wait, and a value this small will kill healthy work early.`,
        ]
      : [];

  const parent = resolveParent({
    explicit: flags.parent,
    callerSessionId: environment.callerSessionId,
    mode: flags.mode,
  });
  const common = {
    agent: flags.agent,
    boardAccess,
    cwd: flags.cwd ?? environment.cwd,
    harnessFlags: [...(flags.harnessFlags ?? [])],
    ...(flags.name === undefined ? {} : { name: flags.name }),
    ...(flags.teammate === undefined ? {} : { teammate: flags.teammate }),
    ...(flags.teammateFallback === true ? { teammateFallback: true } : {}),
    ...(flags.label === undefined ? {} : { label: flags.label }),
    ...(parent === undefined ? {} : { parent }),
    ...(flags.model === undefined ? {} : { model: flags.model }),
    ...(flags.remoteControl === undefined ? {} : { remoteControl: flags.remoteControl }),
    ...(flags.interval === undefined ? {} : { intervalSeconds: flags.interval }),
    ...(flags.turnTimeout === undefined ? {} : { timeoutSeconds: flags.turnTimeout }),
    ...(flags.nudgeAfter === undefined ? {} : { nudgeAfterSeconds: flags.nudgeAfter }),
    ...(flags.stallKillAfter === undefined ? {} : { killAfterSeconds: flags.stallKillAfter }),
    ...(flags.directMax === undefined ? {} : { directSendMaxChars: flags.directMax }),
    ...(flags.maxSnapshots === undefined ? {} : { maxSnapshots: flags.maxSnapshots }),
    ...(flags.detach === true ? { detach: true } : {}),
    ...(flags.attachments === undefined || flags.attachments.length === 0
      ? {}
      : { initialAttachments: flags.attachments.map(attachment => ({ ...attachment })) }),
  };

  // The wire request is a discriminated union: `auto` carries a prompt, `interactive` may not.
  const request: StartSessionRequestInput =
    flags.mode === 'auto'
      ? { ...common, mode: 'auto', prompt }
      : { ...common, mode: 'interactive', ...(prompt === '' ? {} : { prompt }) };

  return { request, warnings, ...(boardAccess === 'none' ? {} : { boardCapability }) };
}
