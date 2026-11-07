import { isAbsolute, resolve } from 'node:path';
import { SessionCommandError } from './errors.ts';
import type { SessionEnvironment, StartBody } from './ports.ts';

/**
 * Today's `fy start` flags whose value has no field in Ferrets' start (§2.2): the model, the supervision timers,
 * remote control and the rest are other plugins' launch parts now. A typed one is refused by name rather than sent
 * and dropped, because a flag that was accepted and ignored is worse than a refusal.
 */
export const START_FLAGS_ELSEWHERE: readonly string[] = [
  'model',
  'fast',
  'compact-at',
  'rc',
  'harness-flag',
  'file',
  'prompt-file',
  'interval',
  'turn-timeout',
  'nudge-after',
  'stall-kill-after',
  'direct-max',
  'max-snapshots',
  'detach',
  'request-id',
  'label',
  'card',
  'parent',
  'teammate-fallback',
];

/** Every `start` flag Ferrets' start takes, already read out of argv by the CLI half. */
export interface StartFlags {
  /** Omitted to use this machine's own default runtime for new agents, resolved daemon-side. */
  readonly agent?: string;
  readonly mode: 'auto' | 'interactive';
  readonly prompt?: string;
  /** The first name to give it (`--teammate`), else the daemon picks a free callsign. */
  readonly teammate?: string;
  readonly harness?: string;
  readonly login?: string;
  readonly pack?: string;
  readonly cwd?: string;
}

/**
 * Turns the `start` flags into Ferrets' start body.
 *
 * Auto mode still needs a task — an autonomous teammate with no assignment can only misbehave — while an interactive
 * one is a terminal for a human and may start bare. The folder is the one the command was typed in unless `--cwd`
 * names another (relative to it); a parent is never sent: a ferret's start is its own helper, from its token.
 */
export function buildStartRequest(flags: StartFlags, environment: SessionEnvironment): StartBody {
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
    ...(flags.harness === undefined ? {} : { harness: flags.harness }),
    ...(flags.login === undefined ? {} : { login: flags.login }),
    ...(flags.pack === undefined ? {} : { pack: flags.pack }),
    ...(prompt === '' ? {} : { prompt }),
  };
}
