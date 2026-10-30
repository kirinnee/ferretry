/**
 * Why a runtime that is switched off cannot start (docs/disabling.md): the switch that holds it
 * (its own `disabled` block, its login's, or both), the runtime to use instead and how to turn it
 * back on. Pure: the clock is the caller's.
 */
import { activeDisable, type Disabled, disabledPhrase } from './disabled.ts';
import type { AccountModel } from './schema.ts';
import { runtimeHarness } from './scope.ts';

type ModelRuntime = AccountModel['runtimes'][string];

/** What switches a runtime off, and the sentence that says so. */
export interface RuntimeDisable {
  /** The runtime's own block, when in effect. */
  readonly own?: Disabled;
  /** Its login's block, when in effect. */
  readonly login?: Disabled;
  /** The runtime to use instead, when there is one. */
  readonly alternative?: string;
  /** The clauses of the refusal, in order. */
  readonly clauses: readonly string[];
}

/** The binary's name from the command that runs it (`/x/bin/fy` -> `fy`). */
export const binaryNameOf = (command: string): string => command.split('/').at(-1) || 'fy';

/** Whether a runtime is switched off at `now` (ms), by its own `disabled` block or its login's. */
export const switchedOff = (model: AccountModel, runtime: ModelRuntime, now: number): boolean =>
  activeDisable(runtime.disabled, now) !== undefined ||
  activeDisable(model.credentials[runtime.credential]?.disabled, now) !== undefined;

/** `undefined` when runtime `name` is switched on at `now`. */
export function runtimeDisable(
  model: AccountModel,
  name: string,
  now: number,
  binary: string,
): RuntimeDisable | undefined {
  const runtime = model.runtimes[name];
  if (runtime === undefined) return undefined;
  const own = activeDisable(runtime.disabled, now);
  const login = activeDisable(model.credentials[runtime.credential]?.disabled, now);
  if (own === undefined && login === undefined) return undefined;
  const harness = runtimeHarness(model, runtime);
  const alternative = Object.entries(model.runtimes)
    .toSorted(([left], [right]) => (left < right ? -1 : 1))
    .find(
      ([other, peer]) =>
        other !== name &&
        peer.agent === runtime.agent &&
        runtimeHarness(model, peer) === harness &&
        !switchedOff(model, peer, now),
    )?.[0];
  const clauses: string[] = [];
  if (own !== undefined) clauses.push(`runtime "${name}" is ${disabledPhrase(own)}`);
  if (login !== undefined) clauses.push(`its login "${runtime.credential}" is ${disabledPhrase(login)}`);
  const turnOn =
    login !== undefined ? `\`${binary} login enable ${runtime.credential}\`` : `\`${binary} runtime enable ${name}\``;
  clauses.push(
    `${alternative === undefined ? 'No other runtime of this kind is on' : `Use "${alternative}" instead`}, or turn it back on with ${turnOn}. Ferrets already on it keep running; move one with \`${binary} migrate <id> -a ${alternative ?? '<runtime>'}\``,
  );
  return {
    ...(own === undefined ? {} : { own }),
    ...(login === undefined ? {} : { login }),
    ...(alternative === undefined ? {} : { alternative }),
    clauses,
  };
}
