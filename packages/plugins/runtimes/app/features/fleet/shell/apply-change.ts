/**
 * One account-model change, from a click to the machine (docs/design/account-model.md §7).
 *
 * Every write on the Machines surface is the same three moves: stage ONE change (`POST /v1/runtimes/proposals`),
 * which writes nothing and answers with its preview, then apply exactly that change
 * (`POST /v1/runtimes/proposals/:proposalId/apply`). A caller off the machine confirms with a passkey step-up: the
 * daemon refuses the request with `403 grant_step_up_required`, the carrier asks for the passkey and sends the same
 * request once more, so neither call needs anything extra from this module.
 *
 * Every tab (Runtimes, Profiles, Model sets) uses this module, so the rules are written once:
 *
 * - **Nothing throws.** Each call answers `applied` or `refused`, and a refusal is ONE sentence a person can read, in
 *   the daemon's own words where it gave some — never a broken screen.
 * - **The change is the daemon's to derive.** A caller names one intent; it never sends a document.
 */

import { z } from 'zod';
import {
  type AccountChange,
  type ApplyOutcome,
  AccountChangeOutcomeSchema,
  AccountChangeRequestSchema,
  type AccountChangeOutcome,
  type AccountChangeView,
  AccountChangeViewSchema,
  type MachineView,
  MachineViewSchema,
  type ProposalApplyRequest,
  ProposalApplyRequestSchema,
} from '../../../../contract/index.ts';
import { type CallFailure, callFailure, type RuntimesClient } from '../../../lib/client.ts';
import type { FleetApplyAuthority } from '../../../lib/shell-ports.ts';

export type { FleetApplyAuthority } from '../../../lib/shell-ports.ts';

const MACHINE_ROUTE = 'GET /v1/runtimes/machine' as const;
const PROPOSE_ROUTE = 'POST /v1/runtimes/proposals' as const;
const APPLY_ROUTE = 'POST /v1/runtimes/proposals/:proposalId/apply' as const;

/** Agent permissions, the tools installed, whether it is set up, and what this caller may change. */
export const readMachine = async (client: RuntimesClient): Promise<MachineView> =>
  MachineViewSchema.parse(await client.call(MACHINE_ROUTE));

/** Stage one change. Nothing is written: the answer is the preview a person approves. */
const stageChange = async (client: RuntimesClient, change: AccountChange): Promise<AccountChangeView> =>
  AccountChangeViewSchema.parse(
    await client.call(PROPOSE_ROUTE, { body: AccountChangeRequestSchema.parse({ change }) }),
  );

/** Apply exactly the change that was previewed. */
const applyChange = async (
  client: RuntimesClient,
  changeId: string,
  request: ProposalApplyRequest = {},
): Promise<AccountChangeOutcome> =>
  AccountChangeOutcomeSchema.parse(
    await client.call(APPLY_ROUTE, {
      params: { proposalId: changeId },
      body: ProposalApplyRequestSchema.parse(request),
    }),
  );

/** The machine's own answer, as the panel's authority. */
export const fleetApplyAuthority = (authority: MachineView['authority']): FleetApplyAuthority => {
  if (authority.mayApply) return { kind: 'open' };
  return authority.applyRefusal === 'step-up-required'
    ? { kind: 'step-up' }
    : { kind: 'refused', refusal: authority.applyRefusal };
};

/** What this browser may change on this machine. Never throws. */
export const readChangeAuthority = async (client: RuntimesClient): Promise<FleetApplyAuthority> => {
  try {
    return fleetApplyAuthority((await readMachine(client)).authority);
  } catch {
    return { kind: 'unreadable' };
  }
};

/**
 * An apply the daemon ANSWERED (200) but that did not finish: the fleet apply failed after the change was staged.
 *
 * - `rolled-back`: the fleet was put back. The configuration files the change wrote first are NOT undone by that
 *   (`landed`): they stay on disk and the next apply publishes them.
 * - `rollback-incomplete`: the fleet could not be fully put back. `unrestored` (and `displaced`) are the paths left
 *   partly changed; the host needs a look.
 *
 * Neither is a save. A caller never closes a form, or says "Saved" or "Deleted", for one; `sentence` is what the
 * screen shows instead, paths only, never a value.
 */
interface UnfinishedApply {
  readonly kind: 'rolled-back' | 'rollback-incomplete';
  readonly staged: AccountChangeView;
  /** One alert-sized message: the outcome first, then the files and what the owner can do. */
  readonly sentence: string;
  /** Configuration files that stayed on disk and are live at the next apply. */
  readonly landed: readonly string[];
  /** Paths left partly changed (empty for `rolled-back`). */
  readonly unrestored: readonly string[];
}

export type ChangeResult =
  | {
      readonly kind: 'applied';
      /** The change as the daemon staged it: its summary and consequences. */
      readonly staged: AccountChangeView;
      readonly outcome: AccountChangeOutcome;
    }
  | UnfinishedApply
  | {
      readonly kind: 'refused';
      /** One sentence for the screen. */
      readonly sentence: string;
      /** The daemon’s refusal code, for a caller that branches on cause. */
      readonly code?: string;
    };

export type StageResult =
  | { readonly kind: 'staged'; readonly staged: AccountChangeView }
  | Extract<ChangeResult, { kind: 'refused' }>;

const NO_ANSWER = 'This machine didn’t answer, so nothing was changed. Check it is awake and try again.';

/**
 * Errors whose own message is already the sentence a person needs — a revoked device, an app or a machine that is
 * out of date, a device key this browser cannot use, a paused plugin. Matched by name, which each sets, so this
 * module does not import the carrier to recognise its refusals.
 */
const SELF_WORDED: ReadonlySet<string> = new Set([
  'DeviceNotAcceptedError',
  'DaemonOutdatedError',
  'AppOutdatedError',
  'DeviceKeyMissingError',
  'DeviceKeyUnreadableError',
  'DeviceKeyUnsupportedError',
]);

const detail = (value: unknown): string => {
  const text = value instanceof Error ? value.message.trim() : '';
  return text === '' ? '' : ` (${text.replace(/[.\s]+$/u, '')})`;
};

/** A refusal the daemon answered: a numeric status and a code, which the shell's client puts on what it throws. */
const daemonRefusal = (error: unknown): (CallFailure & { readonly status: number }) | null => {
  const failure = callFailure(error);
  return failure !== null && typeof failure.status === 'number' && typeof failure.code === 'string'
    ? (failure as CallFailure & { readonly status: number })
    : null;
};

/**
 * One readable sentence for whatever went wrong — and it says WHAT went wrong.
 *
 * Every failure used to read "didn’t answer, so nothing was changed", which was wrong twice over: a request that
 * timed out may well have been applied, and a machine that answered in a shape this app cannot read DID answer. An
 * owner whose machine was up and whose log was clean could do nothing with it. So each cause says its own sentence,
 * and an unrecognised one carries its own message.
 */
export const changeRefusalSentence = (error: unknown): string => {
  const refusal = daemonRefusal(error);
  if (refusal !== null) {
    const message = typeof refusal.message === 'string' ? refusal.message.trim() : '';
    return message === '' ? `This machine refused the change (${String(refusal.status)}).` : message;
  }
  if (error instanceof z.ZodError)
    return 'This machine answered in a form this copy of the app doesn’t understand, so the two are probably on different versions. Reload the app, and update Ferretry on the machine if it still happens.';
  if (!(error instanceof Error)) return NO_ANSWER;
  if (SELF_WORDED.has(error.name) && error.message.trim() !== '') return error.message;
  if (error.name === 'RelaySessionError')
    return `The connection to this machine broke before it answered${detail(error)}. It may still have made the change — check before trying again.`;
  return `This machine didn’t answer${detail(error)}. Check it is awake and try again.`;
};

const refused = (error: unknown): Extract<ChangeResult, { kind: 'refused' }> => {
  const code = daemonRefusal(error)?.code;
  return { kind: 'refused', sentence: changeRefusalSentence(error), ...(typeof code === 'string' ? { code } : {}) };
};

/**
 * Stage one change and stop: the answer is the preview a confirm card shows ("3 runtimes will need sign-in"). Use
 * {@link applyStagedChange} to apply it.
 */
export const stageAccountChange = async (client: RuntimesClient, change: AccountChange): Promise<StageResult> => {
  try {
    return { kind: 'staged', staged: await stageChange(client, change) };
  } catch (error) {
    return refused(error);
  }
};

const stripStop = (text: string): string => text.trim().replace(/[.\s]+$/u, '');
const fileWord = (count: number, one: string, many: string): string => (count === 1 ? one : many);

/** The apply a change ended with, wherever the outcome carries one. */
const applyOf = (outcome: AccountChangeOutcome): ApplyOutcome | undefined => {
  if (outcome.outcome === 'applied') return outcome.apply;
  if (outcome.outcome === 'login-changed') return outcome.moved;
  return undefined;
};

const landedSentence = (landed: readonly string[], remedy: string): string =>
  landed.length === 0
    ? `No configuration file was left on disk. ${remedy}`.trimEnd()
    : `${fileWord(landed.length, 'This configuration file stayed', 'These configuration files stayed')} on disk and ${fileWord(landed.length, 'goes', 'go')} live at the next apply: ${landed.join(', ')}. ${remedy}`.trimEnd();

/**
 * What an apply that did not finish says, in the order a person reads it: the outcome first, then what failed, then
 * the files, then what they can do. Plain sentences, paths only.
 */
const unfinished = (
  staged: AccountChangeView,
  apply: Extract<ApplyOutcome, { outcome: 'rolled-back' | 'rollback-incomplete' }>,
): UnfinishedApply => {
  const landed = apply.configurationLanded ?? [];
  const failure = `${apply.failedOperation} failed: ${stripStop(apply.reason)}.`;
  if (apply.outcome === 'rolled-back')
    return {
      kind: 'rolled-back',
      staged,
      landed,
      unrestored: [],
      sentence: [
        'This change was not applied: the fleet apply failed and was rolled back.',
        failure,
        landedSentence(
          landed,
          landed.length === 0
            ? 'Fix the cause and apply again.'
            : `Fix the cause and apply again. To undo the change instead, put ${fileWord(landed.length, 'that file back as it was', 'those files back as they were')}.`,
        ),
      ].join(' '),
    };
  const unrestored = apply.unrestored.map(path => path.path);
  const left = apply.unrestored.map(path =>
    path.backup === undefined ? path.path : `${path.path} (the original is at ${path.backup})`,
  );
  const moved = (apply.displaced ?? []).map(state => `${state.path} (moved to ${state.movedTo})`);
  return {
    kind: 'rollback-incomplete',
    staged,
    landed,
    unrestored,
    sentence: [
      'This change was not applied, and the fleet could not be fully put back, so this machine needs a look.',
      failure,
      ...(left.length === 0
        ? []
        : [`${fileWord(left.length, 'This path was', 'These paths were')} left partly changed: ${left.join(', ')}.`]),
      ...(moved.length === 0 ? [] : [`Moved aside: ${moved.join(', ')}.`]),
      landedSentence(landed, ''),
      'Check these paths and files, fix the cause, then apply again.',
    ].join(' '),
  };
};

/**
 * What the daemon's answer means for the person. Only a finished apply (or a change that never needed one) is
 * `applied`; a rolled-back or rollback-incomplete apply is its own result, and an outcome this app does not know is
 * a refusal — an answer it cannot read is never a save.
 */
export const settleOutcome = (staged: AccountChangeView, outcome: AccountChangeOutcome): ChangeResult => {
  const apply = applyOf(outcome);
  if (apply === undefined) return { kind: 'applied', staged, outcome };
  switch (apply.outcome) {
    case 'committed':
    case 'committed-with-history-failure':
      return { kind: 'applied', staged, outcome };
    case 'rolled-back':
    case 'rollback-incomplete':
      return unfinished(staged, apply);
    default:
      return {
        kind: 'refused',
        sentence:
          'This machine answered in a form this copy of the app doesn’t understand, so it can’t tell whether the change was applied. Reload the app, and check the machine before you try again.',
      };
  }
};

/** Apply exactly a change that was staged. */
export const applyStagedChange = async (client: RuntimesClient, staged: AccountChangeView): Promise<ChangeResult> => {
  try {
    return settleOutcome(staged, await applyChange(client, staged.id));
  } catch (error) {
    return refused(error);
  }
};

/** Stage one change and apply it at once: the common case, one click. */
export const applyAccountChange = async (client: RuntimesClient, change: AccountChange): Promise<ChangeResult> => {
  const stage = await stageAccountChange(client, change);
  if (stage.kind === 'refused') return stage;
  return await applyStagedChange(client, stage.staged);
};
