/**
 * One account-model change, from a click to the machine (docs/design/account-model.md §7).
 *
 * Every write on the Machines surface is the same three moves: stage ONE change
 * (`POST /v1/fleet/changes`), which writes nothing and answers with its preview, then apply exactly
 * that change (`POST /v1/fleet/changes/:id/apply`). A caller off the machine may owe the operator
 * password; it is typed ONCE and spent on both halves it is needed for — minted into an unlock when
 * this browser is locked out, and sent as the per-change confirmation when the daemon asks for one —
 * exactly as the old fleet panel spends it (`fleet-configuration-surface.tsx`).
 *
 * Every tab (Runtimes, Credentials, Profiles, Components, Settings) uses this module, so the rules
 * are written once:
 *
 * - **Nothing throws.** Each call answers `applied` or `refused`, and a refusal is ONE sentence a
 *   person can read, in the daemon's own words where it gave some. While the daemon's
 *   `accountModel.enabled` switch is off every change is refused with the sentence the daemon
 *   returns — never a broken screen.
 * - **The password is a parameter for the whole of its life.** It is never returned, never stored in
 *   a result, and never kept in a view's state past the click that typed it. What can be kept is the
 *   unlock token a mint produced, stamped with the daemon that minted it (`src/lib/grants.ts`).
 * - **The change is the daemon's to derive.** A caller names one intent; it never sends a document.
 */

import {
  type FleetAccountChange,
  type FleetAccountChangeOutcome,
  type FleetAccountChangeView,
  type FleetProposalApplyRequest,
  OperatorPasswordSchema,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import type { DaemonId } from '../../../lib/daemon-connection.ts';
import { type HeldUnlock, operatorUnlockFailure, usableUnlock } from '../../../lib/grants.ts';
import { unlockGrants } from '../../settings/grants-api.ts';
import { applyFleetChange, stageFleetChange } from '../catalog-api.ts';
import { type FleetClient, readFleetPermissions } from '../fleet-api.ts';
import { type FleetApplyAuthority, fleetApplyAuthority, fleetApplyNeedsPassword } from '../fleet-change-model.ts';

export type { FleetApplyAuthority } from '../fleet-change-model.ts';

/** What this browser may change on this machine, and whether it owes the operator password. Never throws. */
export const readChangeAuthority = async (client: FleetClient, unlock?: string): Promise<FleetApplyAuthority> => {
  try {
    return fleetApplyAuthority(await readFleetPermissions(client, unlock));
  } catch {
    return { kind: 'unreadable' };
  }
};

/** Whether a change on this machine asks for the operator password before it is sent. */
export const changeNeedsPassword = (authority: FleetApplyAuthority): boolean => fleetApplyNeedsPassword(authority);

export interface ChangeAttempt {
  /** The machine the client talks to, so an unlock minted by one daemon is never shown to another. */
  readonly daemonId: DaemonId;
  /** From {@link readChangeAuthority}. */
  readonly authority: FleetApplyAuthority;
  /** Typed for this one click, when {@link changeNeedsPassword} says so. */
  readonly operatorPassword?: string;
  /** An unlock an earlier change on this machine minted, reused rather than spending another attempt. */
  readonly held?: HeldUnlock | null;
  /** Supplied in tests so a held unlock's expiry is deterministic. */
  readonly now?: () => number;
}

export type ChangeResult =
  | {
      readonly kind: 'applied';
      /** The change as the daemon staged it: its summary and consequences. */
      readonly staged: FleetAccountChangeView;
      readonly outcome: FleetAccountChangeOutcome;
      /** The unlock to keep for the next change, or `null`. */
      readonly held: HeldUnlock | null;
    }
  | {
      readonly kind: 'refused';
      /** One sentence for the screen. */
      readonly sentence: string;
      /** The daemon's refusal code, for a caller that branches on cause (`fleet_change_disabled`). */
      readonly code?: string;
      /** The typed password was wrong or is being rate-limited: retype it, nothing else changed. */
      readonly passwordRejected: boolean;
      readonly held: HeldUnlock | null;
    };

export type StageResult =
  | { readonly kind: 'staged'; readonly staged: FleetAccountChangeView; readonly held: HeldUnlock | null }
  | Extract<ChangeResult, { kind: 'refused' }>;

/** The codes the unlock route answers when a password attempt was spent, rather than a capability refused. */
const PASSWORD_CODES: ReadonlySet<string> = new Set([
  'grant_wrong_password',
  'grant_rate_limited',
  'grant_no_password',
]);

const NO_ANSWER = 'This machine didn’t answer, so nothing was changed. Check it is awake and try again.';
const PASSWORD_FIRST = 'Type this machine’s operator password to make this change.';

/** One readable sentence for whatever went wrong. */
export const changeRefusalSentence = (error: unknown): string => {
  if (error instanceof FyHttpError) {
    if (PASSWORD_CODES.has(error.code ?? '')) return operatorUnlockFailure(error).message;
    return error.message.trim() === '' ? `This machine refused the change (${String(error.status)}).` : error.message;
  }
  return NO_ANSWER;
};

const refused = (error: unknown, held: HeldUnlock | null): Extract<ChangeResult, { kind: 'refused' }> => {
  const code = error instanceof FyHttpError ? error.code : undefined;
  return {
    kind: 'refused',
    sentence: changeRefusalSentence(error),
    ...(code === undefined ? {} : { code }),
    passwordRejected: PASSWORD_CODES.has(code ?? ''),
    held,
  };
};

/** The unlock this attempt sends, minting one with the typed password when the browser is locked out. */
const unlockFor = async (client: FleetClient, attempt: ChangeAttempt): Promise<HeldUnlock | null> => {
  const now = attempt.now ?? Date.now;
  const held = attempt.held ?? null;
  if (usableUnlock(held, attempt.daemonId, now()) !== undefined) return held;
  if (attempt.authority.kind !== 'locked') return null;
  const minted = await unlockGrants(client, String(attempt.operatorPassword));
  return { daemonId: attempt.daemonId, token: minted.token, expiresAtMs: Date.parse(minted.expiresAt) };
};

const hasUnlock = (attempt: ChangeAttempt, held: HeldUnlock | null): boolean =>
  usableUnlock(held, attempt.daemonId, (attempt.now ?? Date.now)()) !== undefined;

/** The per-change confirmation is owed on an apply: a `confirm` caller, or a locked one that also confirms. */
const confirms = (authority: FleetApplyAuthority): boolean =>
  authority.kind === 'confirm' || (authority.kind === 'locked' && authority.alsoConfirms);

const typed = (attempt: ChangeAttempt): boolean => (attempt.operatorPassword ?? '') !== '';

const passwordFirst = (held: HeldUnlock | null): Extract<ChangeResult, { kind: 'refused' }> => ({
  kind: 'refused',
  sentence: PASSWORD_FIRST,
  passwordRejected: false,
  held,
});

/** A typed password the daemon could never accept is said here, before anything is sent. */
const malformedPassword = (attempt: ChangeAttempt, held: HeldUnlock | null) => {
  if (!typed(attempt)) return null;
  const parsed = OperatorPasswordSchema.safeParse(attempt.operatorPassword);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0]?.message ?? 'that is not a valid operator password';
  return {
    kind: 'refused' as const,
    sentence: `${issue.charAt(0).toUpperCase()}${issue.slice(1)}.`,
    passwordRejected: true,
    held,
  };
};

/**
 * Stage one change and stop: the answer is the preview a confirm card shows ("3 runtimes will need
 * sign-in"). Use {@link applyStagedChange} to apply it.
 */
export const stageAccountChange = async (
  client: FleetClient,
  change: FleetAccountChange,
  attempt: ChangeAttempt,
): Promise<StageResult> => {
  let held = attempt.held ?? null;
  // Staging already needs `fleet.configure`, so a locked-out browser unlocks first.
  if (attempt.authority.kind === 'locked' && !hasUnlock(attempt, held) && !typed(attempt)) return passwordFirst(held);
  const malformed = malformedPassword(attempt, held);
  if (malformed !== null) return malformed;
  try {
    held = await unlockFor(client, attempt);
    const staged = await stageFleetChange(client, change, held?.token);
    return { kind: 'staged', staged, held };
  } catch (error) {
    return refused(error, held);
  }
};

/** Apply exactly a change that was staged, spending the confirmation only where the daemon asks for it. */
export const applyStagedChange = async (
  client: FleetClient,
  staged: FleetAccountChangeView,
  attempt: ChangeAttempt,
): Promise<ChangeResult> => {
  let held = attempt.held ?? null;
  const owesConfirmation = confirms(attempt.authority);
  const owesUnlock = attempt.authority.kind === 'locked' && !hasUnlock(attempt, held);
  if ((owesConfirmation || owesUnlock) && !typed(attempt)) return passwordFirst(held);
  const malformed = malformedPassword(attempt, held);
  if (malformed !== null) return malformed;
  try {
    held = await unlockFor(client, attempt);
    const request: FleetProposalApplyRequest =
      owesConfirmation && attempt.operatorPassword !== undefined ? { operatorPassword: attempt.operatorPassword } : {};
    const outcome = await applyFleetChange(client, staged.id, request, held?.token);
    return { kind: 'applied', staged, outcome, held };
  } catch (error) {
    return refused(error, held);
  }
};

/** What a guarded act that is NOT a staged change sends: a sign-in start, a Check now. */
export type Authorization =
  | {
      readonly kind: 'authorized';
      /** The unlock header, when this browser holds one for this machine. */
      readonly unlock?: string;
      /** The per-change confirmation, when the machine asks for one. */
      readonly operatorPassword?: string;
      readonly held: HeldUnlock | null;
    }
  | Extract<ChangeResult, { kind: 'refused' }>;

/**
 * Gets this browser past the gate for one guarded act that is not a staged change (starting a
 * sign-in, a Check now): mints an unlock when it is locked out, and hands back the confirmation the
 * act should carry. The caller sends both with its own request.
 */
export const authorizeChange = async (client: FleetClient, attempt: ChangeAttempt): Promise<Authorization> => {
  const held = attempt.held ?? null;
  const owesConfirmation = confirms(attempt.authority);
  const owesUnlock = attempt.authority.kind === 'locked' && !hasUnlock(attempt, held);
  if ((owesConfirmation || owesUnlock) && !typed(attempt)) return passwordFirst(held);
  const malformed = malformedPassword(attempt, held);
  if (malformed !== null) return malformed;
  try {
    const next = await unlockFor(client, attempt);
    return {
      kind: 'authorized',
      ...(next === null ? {} : { unlock: next.token }),
      ...(owesConfirmation && attempt.operatorPassword !== undefined
        ? { operatorPassword: attempt.operatorPassword }
        : {}),
      held: next,
    };
  } catch (error) {
    return refused(error, held);
  }
};

/** Stage one change and apply it at once: the common case, one click and at most one password. */
export const applyAccountChange = async (
  client: FleetClient,
  change: FleetAccountChange,
  attempt: ChangeAttempt,
): Promise<ChangeResult> => {
  const stage = await stageAccountChange(client, change, attempt);
  if (stage.kind === 'refused') return stage;
  return await applyStagedChange(client, stage.staged, { ...attempt, held: stage.held });
};
