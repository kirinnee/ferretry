import { defineHook, type FerretId } from '@ferretry/kernel/contract';
import type { Result } from '@ferretry/std';
import { z } from 'zod';
import { SurfaceKeySchema } from './targets.ts';

/**
 * APPROVE ON YOUR PHONE, as the Vault sees it (docs/input-requests.md, "Approve on your phone"). The Vault owns how a
 * ferret asks (`input_request` with `push: true`, then `input_wait`); ACCOUNTS owns the approval itself (its card, its
 * number gates, its security-log entries), so the dependency is inverted: the Vault declares the hook below, Accounts
 * PROVIDES it, and the Vault never imports Accounts. No provider bound: nothing is raised and the ferret is told
 * {@link PHONE_APPROVAL_UNAVAILABLE}.
 *
 * Nothing here can carry a number, a code or a value: a raise names where and hints, and the view says only where the
 * approval stands.
 */

/** The one sentence a ferret is told when no approval service is bound (a refusal that fails closed). */
export const PHONE_APPROVAL_UNAVAILABLE = 'Approving a sign-in on the phone is not available on this machine.';

/** A phone approval's id: `pa_` and 24 hex digits (Accounts mints them; `input_wait` tells them from an input card's). */
export const PHONE_APPROVAL_ID_PATTERN = /^pa_[0-9a-f]{24}$/u;

/**
 * Exactly what a ferret may say when it asks for a phone approval: where, and hints. The same strict object as the
 * ferret's own tool input; Accounts parses it again with its own contract before anything is shown.
 */
export const PhoneApprovalAskSchema = z.strictObject({
  target: z.strictObject({ kind: z.enum(['browser', 'terminal']), key: SurfaceKeySchema }),
  secretHint: z.string().min(1).max(128).optional(),
  factor: z.string().min(1).max(128).optional(),
  waitSeconds: z.number().int().min(30).max(300).optional(),
});
export type PhoneApprovalAsk = z.infer<typeof PhoneApprovalAskSchema>;

/** Where an approval stands, as a ferret is told: never the number, the account or anything on the card. */
export const PhoneApprovalAgentViewSchema = z.strictObject({
  id: z.string().regex(PHONE_APPROVAL_ID_PATTERN),
  state: z.enum(['waiting', 'moved-on', 'timed-out', 'refused', 'gone']),
  secondFactor: z.literal('push').optional(),
});
export type PhoneApprovalAgentView = z.infer<typeof PhoneApprovalAgentViewSchema>;

/** What Accounts provides under `input.phone-approval:phone`. Total: a refusal is a sentence, never a throw. */
export interface PhoneApprovalProvider {
  /** A ferret asks (`push: true`). Refused with the sentence the ferret reads. */
  raise(ferret: FerretId, ask: PhoneApprovalAsk): Promise<Result<PhoneApprovalAgentView, string>>;
  /** The ferret waits on its OWN approval (`input_wait` with a `pa_` id), up to `waitMs`. */
  agentView(ferret: FerretId, id: string, waitMs: number): Promise<Result<PhoneApprovalAgentView, string>>;
}

/** The one key `input.phone-approval` is provided under. */
export const PHONE_APPROVAL_KEY = 'phone' as const;

/** Provided by Accounts and nobody else (`takers`): an approval is a sign-in's, and a sign-in is Accounts'. */
export const InputPhoneApprovals = defineHook('input.phone-approval', {
  mode: 'provide',
  key: z.literal(PHONE_APPROVAL_KEY),
  value: z.custom<PhoneApprovalProvider>(),
  takers: ['accounts'],
});
