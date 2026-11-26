import type { HookDecision } from '@ferretry/kernel/contract';
import type { FerretDetails, LaunchSpec, StartDecideInput } from '../../../contract/index.ts';

/** What a launch was told about fast mode: the verified answer for a resume, `undefined` where the start's own stands. */
export interface DecidedFast {
  readonly value: boolean | undefined;
}

/** A move keeps the other start options, replaces model/effort, and drops the old runtime's fast mode. */
export function movedLaunchOptions(
  before: FerretDetails['options'],
  target: { readonly model?: string; readonly effort?: string },
): NonNullable<FerretDetails['options']> {
  const { effort: _effort, fast: _fast, ...kept } = before ?? {};
  return {
    ...kept,
    ...(target.model === undefined ? {} : { model: target.model }),
    ...(target.effort === undefined ? {} : { effort: target.effort }),
  };
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
 * model cannot serve it (`unservable_model`) explicitly switches fast off instead of refusing the revive — a relaunch never passes
 * an unverified paid tier, and never strands a session over one.
 */
export async function decideResume(
  decide: (input: StartDecideInput) => Promise<HookDecision>,
  base: StartDecideInput,
  keeps:
    | { readonly live: Promise<boolean | undefined> | undefined; readonly recorded: FerretDetails['options'] }
    | undefined,
): Promise<{ readonly decision: HookDecision; readonly fast: boolean | undefined; readonly notice?: string }> {
  // What the session is ON (a live `/fast` after the start wins), else what the start recorded; a move keeps nothing.
  const fast = keeps === undefined ? undefined : ((await keeps.live?.catch(() => undefined)) ?? keeps.recorded?.fast);
  if (fast !== true) return { decision: await decide(base), fast };
  const model = keeps?.recorded?.model;
  const first = await decide({ ...base, fast, ...(model === undefined ? {} : { model }) });
  if (first.allow) return { decision: first, fast };
  if (first.code !== 'unservable_model' && first.code !== 'fast_unverified')
    return { decision: first, fast: undefined };
  return {
    decision: await decide({ ...base, fast: false, ...(model === undefined ? {} : { model }) }),
    fast: false,
    notice: first.code === 'fast_unverified' ? first.reason : `Started without Fast: ${first.reason}`,
  };
}

/**
 * A START's answer from `start.decide`, with one downgrade: a taker that cannot VERIFY fast mode for the model
 * (`fast_unverified`) does not fail the start. It is asked again with fast explicitly off, the request records that, and the
 * taker's sentence comes back as `notice` for the start's answer to show. Any other refusal, and a start that did not ask
 * for fast, is exactly the taker's answer.
 */
export async function decideStart<R extends { readonly options?: { readonly fast?: boolean } }>(
  decide: (input: StartDecideInput) => Promise<HookDecision>,
  input: StartDecideInput,
  request: R,
): Promise<{ readonly decision: HookDecision; readonly request: R; readonly notice?: string }> {
  const first = await decide(input);
  if (first.allow || first.code !== 'fast_unverified') return { decision: first, request };
  return {
    decision: await decide({ ...input, fast: false }),
    request: { ...request, options: { ...request.options, fast: false } },
    notice: first.reason,
  };
}

/** The last launch's outcome, persisted beside its effective options; a later ordinary launch clears the notice. */
export function launchDetails(
  before: FerretDetails | undefined,
  fast: boolean | undefined,
  notice?: string,
): FerretDetails | undefined {
  // An ordinary relaunch has no outcome to record; leave all existing details writers and events alone.
  if (notice === undefined && before?.notice === undefined) return undefined;
  const { notice: _previous, ...kept } = before ?? {};
  return {
    ...kept,
    ...(fast === undefined ? {} : { options: { ...kept.options, fast } }),
    ...(notice === undefined ? {} : { notice }),
  };
}
