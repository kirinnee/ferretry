import type {
  ForkedSessionSummary,
  ForkSessionOutcome,
  ForkSessionPlanSummary,
  ForkSessionRequest,
} from '../src/lib/session-fork.ts';

/**
 * The values a fork is described by, shared by BOTH tiers.
 *
 * A fork outcome carries the remote-safe projection of one durable decision. Spelling it out once
 * per test file would mean copies of one contract, and the copy that was not updated would keep
 * passing while describing a shape the schema no longer accepts. It sits beside `fixtures.ts` for
 * the same reason that file does: the unit tier proves the schema and the integration tier proves the
 * client, and they must be proving the same value.
 */

const AT = '2026-08-06T07:00:00.000Z';

/** The exact durable message a fork is cut through, with its optional block index stated. */
export const forkPoint = { v: 1 as const, byteOffset: 4_096, blockIndex: 2 };

/**
 * The opaque evidence the read surface issued for that exact message.
 *
 * Deliberately spelled with the characters a careless client would damage — padding, a plus, a
 * slash, and surrounding space — because the contract is byte-for-byte. A client that trimmed,
 * re-encoded or URL-escaped this value would present the daemon with a token it never issued, and
 * the honest refusal would be indistinguishable from tampering.
 */
export const forkSelectionBinding = ' sel/v1+AAAA==\tBBBB ';

/** A cross-harness fork: a claude source, a codex target, and the omissions that implies. */
export const forkPlan = {
  v: 1,
  planId: 'session-1:fork-request-1',
  preparedAt: AT,
  source: {
    sessionId: 'session-1',
    cutMessagePoint: forkPoint,
  },
  target: {
    agent: 'codex-auto-loge',
    harness: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
    contextWindow: 200_000,
  },
  notCarried: [
    {
      facet: 'workspace',
      subject: 'working tree',
      reason: 'not_implemented',
      detail: 'Conversation time was rewound but filesystem state was not restored to the chosen message.',
    },
  ],
} satisfies ForkSessionPlanSummary;

/** The only fresh-session fields a remote surface needs to label and open the fork. */
export const forkSession = {
  id: 'session-2',
  name: 'Session Two',
  agent: 'codex-auto-loge',
  harness: 'codex',
  model: 'gpt-5.6-sol',
  status: 'running',
} satisfies ForkedSessionSummary;

/**
 * What a caller asks for: one message, the evidence issued for it, one agent, and two runtime
 * choices. The binding travels beside `through` because a coordinate alone cannot prove the message
 * at it is still the one the caller read.
 */
export const forkRequest = {
  through: forkPoint,
  selectionBinding: forkSelectionBinding,
  agent: 'codex-auto-loge',
  model: 'gpt-5.6-sol',
  effort: 'high',
} satisfies ForkSessionRequest;

/** What a fork that happened answers with: the fresh session and the decision that built it. */
export const forkOutcome = { session: forkSession, plan: forkPlan } satisfies ForkSessionOutcome;
