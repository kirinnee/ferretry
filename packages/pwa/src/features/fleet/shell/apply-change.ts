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
import { FyHttpError, FyTransportError } from '@ferretry/protocol/client';
import { z } from 'zod';
import { appVersion } from '../../../lib/app-version.ts';
import { invalidRequestWords } from '../../../lib/request-refusal.ts';
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

/**
 * Errors whose own message is already the sentence a person needs — a revoked device, an app or a
 * machine that is out of date, a device key this browser cannot use. Matched by name, which each sets,
 * so this module does not import the carrier to recognise its refusals.
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

/**
 * One readable sentence for whatever went wrong — and it says WHAT went wrong.
 *
 * Every failure used to read "didn’t answer, so nothing was changed", which was wrong twice over: a
 * request that timed out may well have been applied, and a machine that answered in a shape this app
 * cannot read DID answer. An owner whose machine was up and whose log was clean could do nothing with
 * it. So each cause says its own sentence, and an unrecognised one carries its own message.
 */
export const changeRefusalSentence = (error: unknown): string => {
  // A 400 for a field this machine's version does not take reads as words, not as the daemon's schema text.
  const invalid = invalidRequestWords(error, appVersion());
  if (invalid !== undefined) return invalid.sentence;
  if (error instanceof FyHttpError)
    return error.message.trim() === '' ? `This machine refused the change (${String(error.status)}).` : error.message;
  if (error instanceof FyTransportError)
    return error.timedOut
      ? 'This machine didn’t answer in time, so this browser stopped waiting. It may still have made the change — check before trying again.'
      : `This browser couldn’t reach this machine${detail(error.cause)}. Check it is awake and online, then try again.`;
  if (error instanceof z.ZodError)
    return 'This machine answered in a form this copy of the app doesn’t understand, so the two are probably on different versions. Reload the app, and update Ferretry on the machine if it still happens.';
  if (!(error instanceof Error)) return NO_ANSWER;
  if (SELF_WORDED.has(error.name) && error.message.trim() !== '') return error.message;
  if (error.name === 'RelaySessionError')
    return `The connection to this machine broke before it answered${detail(error)}. It may still have made the change — check before trying again.`;
  return `This machine didn’t answer${detail(error)}. Check it is awake and try again.`;
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
export const applyStagedChange = async (client: FleetClient, staged: FleetAccountChangeView): Promise<ChangeResult> => {
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
