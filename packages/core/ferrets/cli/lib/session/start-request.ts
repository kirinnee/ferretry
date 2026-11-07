import { isAbsolute, resolve } from 'node:path';
import { FERRET_CARD_ID_PATTERN } from '../../../contract/index.ts';
import { SessionCommandError } from './errors.ts';
import type { SessionEnvironment, StartBody } from './ports.ts';

/**
 * Today's `fy start` flags whose value has no field in Ferrets' start (§2.2): where a conversation compacts and the
 * opening attachments are the Conversation's, a prompt file and a detached start are not this CLI half's to read, a
 * start's idempotency key is the shell's header. A typed one is
 * refused by name rather than sent and dropped, because a flag that was accepted and ignored is worse than a refusal.
 */
export const START_FLAGS_ELSEWHERE: readonly string[] = ['compact-at', 'file', 'prompt-file', 'detach', 'request-id'];

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

/** Every `start` flag Ferrets' start takes, already read out of argv by the CLI half. */
export interface StartFlags extends StartNumericFlags {
  /** Omitted to use this machine's own default runtime for new agents, resolved daemon-side. */
  readonly agent?: string;
  readonly mode: 'auto' | 'interactive';
  readonly prompt?: string;
  /** The ferret to start it under (`--parent`): the owner may name any; a ferret only itself (the daemon decides). */
  readonly parent?: string;
  /** The first name to give it (`--teammate`), else the daemon picks a free callsign. */
  readonly teammate?: string;
  /** With `--teammate`: take a free callsign instead of failing on a collision. */
  readonly teammateFallback?: boolean;
  /** A task title (`--name <title>`), free-form, kept verbatim. */
  readonly title?: string;
  readonly label?: string;
  /** An existing card the new ferret takes over (`--card`): `&F21`, or `F21`. */
  readonly card?: string;
  readonly model?: string;
  readonly effort?: string;
  /** Only set when the caller typed `--fast`/`--no-fast`; unset leaves the harness's own default (off). */
  readonly fast?: boolean;
  /** Only set when the caller actually passed `--rc`/`--no-rc`; unset leaves the daemon default. */
  readonly remoteControl?: boolean;
  readonly harnessFlags?: readonly string[];
  /** `fy new --auto`: let Ferretry choose the runtime. */
  readonly auto?: boolean;
  readonly harness?: string;
  readonly login?: string;
  readonly pack?: string;
  readonly cwd?: string;
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
 * A card reference a person or ferret typed: `&F412` or a bare `F412`, in any case (today's `parseTaskRef`). Anything
 * that is not exactly one card id is refused in today's words.
 */
function cardId(value: string): string {
  const trimmed = value.trim();
  const id = (trimmed.startsWith('&') ? trimmed.slice(1) : trimmed).toUpperCase();
  if (!FERRET_CARD_ID_PATTERN.test(id)) throw new SessionCommandError(`expected a card id like &F21, got "${value}"`);
  return id;
}

/** Advisory notes for stderr — never a refusal, and never on stdout where `--json` would break. */
export function startWarnings(flags: StartNumericFlags): readonly string[] {
  return flags.turnTimeout !== undefined && flags.turnTimeout < TURN_TIMEOUT_HINT_SECONDS
    ? [
        `note: --turn-timeout is a hard KILL timer — the session is terminated when a turn runs longer than ${flags.turnTimeout}s. It is not a readiness wait, and a value this small will kill healthy work early.`,
      ]
    : [];
}

/**
 * Turns the `start` flags into Ferrets' start body.
 *
 * Auto mode still needs a task — an autonomous teammate with no assignment can only misbehave — while an interactive
 * one is a terminal for a human and may start bare. The folder is the one the command was typed in unless `--cwd`
 * names another (relative to it). `--parent` is sent as typed; a ferret naming another parent is refused by the daemon.
 *
 * Today's renamed timers are kept: `--turn-timeout` (kill a turn that overruns) and `--stall-kill-after` (kill a
 * ferret with no life signs), validated here instead of failing on the wire.
 */
export function buildStartRequest(flags: StartFlags, environment: SessionEnvironment): StartBody {
  assertNumericFlags(flags);
  const prompt = flags.prompt?.trim() ?? '';
  if (prompt === '' && flags.mode !== 'interactive')
    throw new SessionCommandError('provide a prompt, or use --mode interactive to start bare');
  const base = environment.cwd;
  const typed = flags.cwd?.trim();
  const folder =
    typed !== undefined && typed !== ''
      ? isAbsolute(typed)
        ? typed
        : base === undefined
          ? undefined
          : resolve(base, typed)
      : base;
  if (folder === undefined) throw new SessionCommandError('name the folder to start in with --cwd <absolute path>');
  return {
    folder,
    ...(flags.agent === undefined ? {} : { runtime: flags.agent }),
    ...(flags.teammate === undefined ? {} : { name: flags.teammate }),
    ...(flags.parent === undefined ? {} : { parent: flags.parent }),
    ...(flags.harness === undefined ? {} : { harness: flags.harness }),
    ...(flags.login === undefined ? {} : { login: flags.login }),
    ...(flags.pack === undefined ? {} : { pack: flags.pack }),
    ...(prompt === '' ? {} : { prompt }),
    mode: flags.mode,
    ...(flags.teammateFallback === true ? { teammateFallback: true } : {}),
    ...(flags.title === undefined ? {} : { title: flags.title }),
    ...(flags.label === undefined ? {} : { label: flags.label }),
    ...(flags.card === undefined ? {} : { card: cardId(flags.card) }),
    ...(flags.model === undefined ? {} : { model: flags.model }),
    ...(flags.effort === undefined ? {} : { effort: flags.effort }),
    ...(flags.fast === undefined ? {} : { fast: flags.fast }),
    ...(flags.remoteControl === undefined ? {} : { remoteControl: flags.remoteControl }),
    ...(flags.auto === true ? { auto: true } : {}),
    ...(flags.harnessFlags === undefined || flags.harnessFlags.length === 0
      ? {}
      : { harnessFlags: [...flags.harnessFlags] }),
    ...(flags.interval === undefined ? {} : { intervalSeconds: flags.interval }),
    ...(flags.turnTimeout === undefined ? {} : { timeoutSeconds: flags.turnTimeout }),
    ...(flags.nudgeAfter === undefined ? {} : { nudgeAfterSeconds: flags.nudgeAfter }),
    ...(flags.stallKillAfter === undefined ? {} : { killAfterSeconds: flags.stallKillAfter }),
    ...(flags.directMax === undefined ? {} : { directSendMaxChars: flags.directMax }),
    ...(flags.maxSnapshots === undefined ? {} : { maxSnapshots: flags.maxSnapshots }),
  };
}
