/**
 * The wire contract for authorizing one reviewed fleet change.
 *
 * A paired browser may inspect a daemon's fleet and may compose a change, but pairing alone never
 * provisions a host. The gap is closed by a code the *host* mints for one exact proposal: the
 * person runs a command on the machine, reads a short code, and types it into the surface that is
 * waiting for it. Possession of the code proves someone with host access looked at this change and
 * agreed to it — nothing more, and nothing that outlives it.
 *
 * This lives in the protocol package because three consumers have to agree on it: the daemon that
 * mints it, the command line that prints it, and the browser that submits it. A copy in each is how
 * the three quietly stop describing the same thing.
 */
import { z } from 'zod';
import { InstantSchema } from './common.ts';

/**
 * How long an approval stays usable, and how many wrong codes one proposal tolerates.
 *
 * Policy, not a daemon detail: the command line prints both to the person reading the code, and the
 * browser tells them how long they have and how many tries are left. Three copies of a number that
 * has to agree is three chances for it to stop agreeing, so the number lives here and the mint
 * response is pinned to it — a daemon that changed one without changing the contract fails its own
 * outbound parse rather than quietly telling clients something untrue.
 */
export const FLEET_APPROVAL_TTL_SECONDS = 120 as const;
export const FLEET_APPROVAL_MAX_ATTEMPTS = 5 as const;

/** Crockford-like symbols with the visually ambiguous 0, 1, I, L, O and U removed. */
export const FLEET_APPROVAL_CODE_PATTERN = /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/u;

/**
 * A code as a person may type it: any case, spaces or dashes wherever they fell.
 *
 * Normalising before checking is the difference between a grammar and an exam. The daemon
 * normalises again on receipt, so a client that skips this is not letting anything through.
 */
export const FleetApprovalCodeSchema = z
  .string()
  .transform(value => {
    const compact = value.trim().toUpperCase().replaceAll(/[\s-]/gu, '');
    return compact.length === 8 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact;
  })
  .pipe(z.string().regex(FLEET_APPROVAL_CODE_PATTERN, 'invalid fleet approval code'));
export type FleetApprovalCode = z.infer<typeof FleetApprovalCodeSchema>;

/** A non-secret handle for one proposal. Safe in a path and in a log; the code never is. */
export const FleetProposalIdSchema = z.string().regex(/^fy_fprop_[A-Za-z0-9_-]{22}$/u, 'invalid fleet proposal id');
export type FleetProposalId = z.infer<typeof FleetProposalIdSchema>;

/**
 * What the host minted.
 *
 * `mutation` is a plain string rather than an enum on purpose. It is a label a reader is shown, never
 * a value anything switches on, so an older client meeting a daemon that has learned a fourth kind
 * of change should print the new word — not refuse to show a person the approval for a change their
 * browser is already displaying. Widening a printed label is not a compatibility event; refusing a
 * host's own approval is.
 */
export const FleetApprovalMintSchema = z.strictObject({
  proposalId: FleetProposalIdSchema,
  /**
   * Canonical form, not the forgiving one. A mint is what the daemon produced, so it either matches
   * the grammar or the daemon is broken and the client should say so; normalising is for what a
   * person types, and accepting a loose code here would let a malformed response through unnoticed.
   */
  code: z.string().regex(FLEET_APPROVAL_CODE_PATTERN, 'invalid fleet approval code'),
  /**
   * The policy as this daemon enforces it. Read as a positive integer rather than pinned to the
   * constant above, for the same reason `mutation` is a string: a client only ever displays these,
   * so a daemon whose policy has moved should have the new number printed — not have a person
   * refused sight of an approval their own browser is showing them, over a figure they were only
   * going to read. `fy` and `fyd` are separately installed, so that skew is ordinary, not exotic.
   *
   * The contract is still closed where closing it belongs: see `FleetApprovalMintPolicySchema`.
   */
  ttlSeconds: z.number().int().positive(),
  expiresAt: InstantSchema,
  maxAttempts: z.number().int().positive(),
  mutation: z.string().min(1),
  /**
   * One line naming what is being approved, so a person reading a terminal can confirm it is the
   * change they expect. Bounded and single-line because it is promised as one: it carries a name a
   * caller chose, and a summary that could wrap or contain a newline could push the code off screen
   * or forge a second line of output. Render it as text, never as markup.
   */
  summary: z
    .string()
    .min(1)
    .max(120)
    .refine(value => !/[\p{Cc}\p{Cf}]/u.test(value), 'summary contains a control character'),
});
export type FleetApprovalMint = z.infer<typeof FleetApprovalMintSchema>;

/**
 * The producing side's obligation: a mint must advertise exactly the policy declared here.
 *
 * Strict in what is sent, liberal in what is accepted. A daemon parses its own response through
 * this on the way out, so changing a policy number without changing the contract fails loudly at
 * the daemon — which is what "the numbers are a contract, not a daemon detail" has to mean. Doing
 * the same check in a client would instead gate an older one out of a change it could otherwise
 * complete, which is a different and much worse thing.
 */
export const FleetApprovalMintPolicySchema = FleetApprovalMintSchema.extend({
  ttlSeconds: z.literal(FLEET_APPROVAL_TTL_SECONDS),
  maxAttempts: z.literal(FLEET_APPROVAL_MAX_ATTEMPTS),
});

/**
 * The mint request carries nothing. The proposal is named by the path, and the code must never
 * travel in a URL: a URL reaches the daemon's access log, and a code in a log outlives its minutes.
 */
export const FleetApprovalMintRequestSchema = z.strictObject({});
export type FleetApprovalMintRequest = z.infer<typeof FleetApprovalMintRequestSchema>;
