/**
 * One account-model change, from a click to the machine (docs/design/account-model.md §7).
 *
 * Every write on the Machines surface is the same three moves: stage ONE change
 * (`POST /v1/fleet/proposals`), which writes nothing and answers with its preview, then apply exactly
 * that change (`POST /v1/fleet/proposals/:id/apply`). A caller off the machine confirms with a passkey
 * step-up: the daemon refuses the request with `403 grant_step_up_required`, the carrier asks for the
 * passkey and sends the same request once more, so neither call needs anything extra from this module.
 *
 * Every tab (Runtimes, Credentials, Profiles, Components, Settings) uses this module, so the rules
 * are written once:
 *
 * - **Nothing throws.** Each call answers `applied` or `refused`, and a refusal is ONE sentence a
 *   person can read, in the daemon’s own words where it gave some — never a broken screen.
 * - **The change is the daemon's to derive.** A caller names one intent; it never sends a document.
 */

import type {
  FleetAccountChange,
  FleetAccountChangeOutcome,
  FleetAccountChangeView,
  FleetMachineView,
  GrantRefusal,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { applyFleetChange, readFleetMachine, stageFleetChange } from '../catalog-api.ts';
import type { FleetClient } from '../fleet-client.ts';

/** What this browser may do with a change on this machine, from the machine view's `authority`. */
export type FleetApplyAuthority =
  /** Apply now, and nothing else is asked. */
  | { readonly kind: 'open' }
  /** Allowed once this device confirms with its passkey, which the carrier asks for when the daemon does. */
  | { readonly kind: 'step-up' }
  /** Refused for a reason a passkey would not fix — switched off, an unreadable grant document. */
  | { readonly kind: 'refused'; readonly refusal: GrantRefusal }
  /**
   * This browser never learned what it may do here, because the machine read itself failed.
   *
   * DELIBERATELY NOT `refused`: that would put a sentence about the operator's decisions on screen on
   * the strength of no answer at all.
   */
  | { readonly kind: 'unreadable' };

/** The machine's own answer, as the panel's authority. */
export const fleetApplyAuthority = (authority: FleetMachineView['authority']): FleetApplyAuthority => {
  if (authority.mayApply) return { kind: 'open' };
  return authority.applyRefusal === 'step-up-required'
    ? { kind: 'step-up' }
    : { kind: 'refused', refusal: authority.applyRefusal };
};

/** What this browser may change on this machine. Never throws. */
export const readChangeAuthority = async (client: FleetClient): Promise<FleetApplyAuthority> => {
  try {
    return fleetApplyAuthority((await readFleetMachine(client)).authority);
  } catch {
    return { kind: 'unreadable' };
  }
};

export type ChangeResult =
  | {
      readonly kind: 'applied';
      /** The change as the daemon staged it: its summary and consequences. */
      readonly staged: FleetAccountChangeView;
      readonly outcome: FleetAccountChangeOutcome;
    }
  | {
      readonly kind: 'refused';
      /** One sentence for the screen. */
      readonly sentence: string;
      /** The daemon’s refusal code, for a caller that branches on cause. */
      readonly code?: string;
    };

export type StageResult =
  | { readonly kind: 'staged'; readonly staged: FleetAccountChangeView }
  | Extract<ChangeResult, { kind: 'refused' }>;

const NO_ANSWER = 'This machine didn’t answer, so nothing was changed. Check it is awake and try again.';

/** One readable sentence for whatever went wrong. */
export const changeRefusalSentence = (error: unknown): string => {
  if (error instanceof FyHttpError)
    return error.message.trim() === '' ? `This machine refused the change (${String(error.status)}).` : error.message;
  return NO_ANSWER;
};

const refused = (error: unknown): Extract<ChangeResult, { kind: 'refused' }> => {
  const code = error instanceof FyHttpError ? error.code : undefined;
  return { kind: 'refused', sentence: changeRefusalSentence(error), ...(code === undefined ? {} : { code }) };
};

/**
 * Stage one change and stop: the answer is the preview a confirm card shows ("3 runtimes will need
 * sign-in"). Use {@link applyStagedChange} to apply it.
 */
export const stageAccountChange = async (client: FleetClient, change: FleetAccountChange): Promise<StageResult> => {
  try {
    return { kind: 'staged', staged: await stageFleetChange(client, change) };
  } catch (error) {
    return refused(error);
  }
};

/** Apply exactly a change that was staged. */
export const applyStagedChange = async (
  client: FleetClient,
  staged: FleetAccountChangeView,
): Promise<ChangeResult> => {
  try {
    return { kind: 'applied', staged, outcome: await applyFleetChange(client, staged.id) };
  } catch (error) {
    return refused(error);
  }
};

/** Stage one change and apply it at once: the common case, one click. */
export const applyAccountChange = async (client: FleetClient, change: FleetAccountChange): Promise<ChangeResult> => {
  const stage = await stageAccountChange(client, change);
  if (stage.kind === 'refused') return stage;
  return await applyStagedChange(client, stage.staged);
};
