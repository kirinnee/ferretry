/**
 * Why a runtime that is switched off cannot start (docs/disabling.md): the switch that holds it
 * (its own `disabled` block, its login's, or both — or its login's spend budget, docs/budgets.md),
 * the runtime to use instead and how to turn it back on. Pure: the clock and the budget holds are the
 * caller's.
 */
import { type BudgetHold, budgetHoldPhrase } from './budget.ts';
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
  /** Its login's spend budget, when that holds it. */
  readonly budget?: BudgetHold;
  /** The runtime to use instead, when there is one. */
  readonly alternative?: string;
  /** The clauses of the refusal, in order. */
  readonly clauses: readonly string[];
}

/** The binary's name from the command that runs it (`/x/bin/fy` -> `fy`). */
export const binaryNameOf = (command: string): string => command.split('/').at(-1) || 'fy';

/** The logins their spend budget holds, by credential id. */
export type BudgetHolds = Readonly<Record<string, BudgetHold>>;

/** Whether a runtime is switched off at `now` (ms), by its own `disabled` block, its login's, or its login's budget. */
export const switchedOff = (
  model: AccountModel,
  runtime: ModelRuntime,
  now: number,
  holds: BudgetHolds = {},
): boolean =>
  activeDisable(runtime.disabled, now) !== undefined ||
  activeDisable(model.credentials[runtime.credential]?.disabled, now) !== undefined ||
  holds[runtime.credential] !== undefined;

/** `undefined` when runtime `name` is switched on at `now`. */
export function runtimeDisable(
  model: AccountModel,
  name: string,
  now: number,
  binary: string,
  holds: BudgetHolds = {},
): RuntimeDisable | undefined {
  const runtime = model.runtimes[name];
  if (runtime === undefined) return undefined;
  const own = activeDisable(runtime.disabled, now);
  const login = activeDisable(model.credentials[runtime.credential]?.disabled, now);
  const budget = holds[runtime.credential];
  if (own === undefined && login === undefined && budget === undefined) return undefined;
  const harness = runtimeHarness(model, runtime);
  const alternative = Object.entries(model.runtimes)
    .toSorted(([left], [right]) => (left < right ? -1 : 1))
    .find(
      ([other, peer]) =>
        other !== name &&
        peer.agent === runtime.agent &&
        runtimeHarness(model, peer) === harness &&
        !switchedOff(model, peer, now, holds),
    )?.[0];
  const clauses: string[] = [];
  if (own !== undefined) clauses.push(`runtime "${name}" is ${disabledPhrase(own)}`);
  if (login !== undefined) clauses.push(`its login "${runtime.credential}" is ${disabledPhrase(login)}`);
  if (budget !== undefined) clauses.push(`its login "${runtime.credential}" is ${budgetHoldPhrase(budget)}`);
  const instead = alternative === undefined ? 'No other runtime of this kind is on' : `Use "${alternative}" instead`;
  const moveOne = `move one with \`${binary} migrate <id> -a ${alternative ?? '<runtime>'}\``;
  if (own === undefined && login === undefined) {
    // Only the budget holds it: nothing to switch back on, it lifts by itself at the reset.
    clauses.push(`${instead}, or raise the login's budget. Ferrets already on it keep running; ${moveOne}`);
  } else {
    const turnOn =
      login !== undefined ? `\`${binary} login enable ${runtime.credential}\`` : `\`${binary} runtime enable ${name}\``;
    clauses.push(`${instead}, or turn it back on with ${turnOn}. Ferrets already on it keep running; ${moveOne}`);
  }
  return {
    ...(own === undefined ? {} : { own }),
    ...(login === undefined ? {} : { login }),
    ...(budget === undefined ? {} : { budget }),
    ...(alternative === undefined ? {} : { alternative }),
    clauses,
  };
}
