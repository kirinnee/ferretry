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

export type ChangeResult =
  | {
      readonly kind: 'applied';
      /** The change as the daemon staged it: its summary and consequences. */
      readonly staged: AccountChangeView;
      readonly outcome: AccountChangeOutcome;
    }
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

/** Apply exactly a change that was staged. */
export const applyStagedChange = async (client: RuntimesClient, staged: AccountChangeView): Promise<ChangeResult> => {
  try {
    return { kind: 'applied', staged, outcome: await applyChange(client, staged.id) };
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
