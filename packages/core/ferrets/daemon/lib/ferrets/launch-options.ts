import type { HookDecision } from '@ferretry/kernel/contract';
import type { FerretDetails, LaunchSpec, StartDecideInput } from '../../../contract/index.ts';

/** What a launch was told about fast mode: the verified answer for a resume, `undefined` where the start's own stands. */
export interface DecidedFast {
  readonly value: boolean | undefined;
}

/**
 * The launch spec's share of a ferret's start options: `model` and `effort` on their own fields (where the harness
 * already reads them), and the rest whole, so a harness, runner or supervisor reads today's start fields from the spec.
 * A decided fast mode REPLACES the recorded one (absent drops it); none leaves the recorded options as they are.
 */
export function launchOptions(
  recorded: FerretDetails['options'],
  fast: DecidedFast | undefined,
): Pick<LaunchSpec, 'model' | 'effort' | 'options'> {
  const { fast: _recordedFast, ...rest } = recorded ?? {};
  const options = fast === undefined ? recorded : fast.value === undefined ? rest : { ...rest, fast: fast.value };
  if (options === undefined || (fast !== undefined && recorded === undefined && fast.value === undefined)) return {};
  return {
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.effort === undefined ? {} : { effort: options.effort }),
    options,
  };
}

/** The fast mode a launch asks for: the one a resume decided and verified, else the session's own (`live`), else none. */
export const launchFastOf = (decided: DecidedFast | undefined, live: boolean | undefined): DecidedFast | undefined =>
  decided ?? (live === undefined ? undefined : { value: live });

/**
 * A resume's answer from `start.decide`, with fast mode verified like a start's: the fast mode the relaunch would carry
 * goes to the decision WITH the model and login it will run on (a start's own refusal rule), and a decision that says the
 * model cannot serve it (`unservable_model`) drops the fast mode instead of refusing the revive — a relaunch never passes
 * an unverified paid tier, and never strands a session over one.
 */
export async function decideResume(
  decide: (input: StartDecideInput) => Promise<HookDecision>,
  base: StartDecideInput,
  keeps:
    | { readonly live: Promise<boolean | undefined> | undefined; readonly recorded: FerretDetails['options'] }
    | undefined,
): Promise<{ readonly decision: HookDecision; readonly fast: boolean | undefined }> {
  // What the session is ON (a live `/fast` after the start wins), else what the start recorded; a move keeps nothing.
  const fast = keeps === undefined ? undefined : ((await keeps.live?.catch(() => undefined)) ?? keeps.recorded?.fast);
  if (fast !== true) return { decision: await decide(base), fast };
  const model = keeps?.recorded?.model;
  const first = await decide({ ...base, fast, ...(model === undefined ? {} : { model }) });
  if (first.allow) return { decision: first, fast };
  if (first.code !== 'unservable_model') return { decision: first, fast: undefined };
  return { decision: await decide(base), fast: undefined };
}
