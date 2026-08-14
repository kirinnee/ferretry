/**
 * The narrow face a fork route sees, and the one place daemon refusals become wire failures.
 *
 * WHY A FACADE AT ALL, when `SessionForkService` already does the work. Four jobs live between the
 * route and the orchestration, and each of them is a decision neither of those two should own:
 *
 *   1. The path parameter becomes a SESSION ID or it becomes a refusal. `tryParseSessionId` is the
 *      single owner of what a path-safe id is, and this is the last point before an id reaches a
 *      store that would turn it into a directory name.
 *   2. The wire request becomes a parsed command. `model` and `effort` arrive OPTIONAL on the wire
 *      and are NULLABLE in the durable payload, and collapsing the two spellings has to happen
 *      exactly once — two collapses would fingerprint one caller's retry two different ways.
 *   3. The daemon-local result becomes the strict public projection. The service must retain cwd,
 *      transcript evidence and transfer facets for restart replay; a remote caller must receive none
 *      of them.
 *   4. Every refusal this daemon can produce becomes one of the sixteen `ForkSessionFailure` arms.
 *
 * THE MAPPING IS EXHAUSTIVE BY CONSTRUCTION, not by review. The seam's `TransferPrepareFailure` and
 * `TransferImportFailure` are mapped through objects typed `{ [K in <that union>]: ForkSessionFailure }`,
 * which fails to compile in BOTH directions: an arm the seam adds and this file has not answered for
 * is a build error, and so is an arm here the seam no longer has. A `satisfies` list would have
 * proved only that every entry present is real, and stayed green for the missing one — which is the
 * direction that matters, because a missing arm falls silently through to `session_fork_failed` and
 * tells a caller "the daemon broke" about a refusal it could have acted on.
 *
 * THE NAMES COINCIDE ON PURPOSE, and that is a fact worth stating rather than a coincidence worth
 * exploiting. The wire taxonomy was written to name the seam's own refusals, so the tables below are
 * identity mappings today. They are still written out one arm at a time: the moment the wire needs a
 * different word for one of them, the change is a line here rather than a rename that has to happen
 * simultaneously in two packages.
 *
 * WHAT THIS DOES NOT DO. It does not re-validate the request id — the mount refuses an absent one
 * and is the single owner of that check. It does not re-derive the plan or count omissions: the
 * durable `plan.notCarried` remains the decision owner, and this boundary projects each row once
 * while removing the workspace path that only its daemon can act on.
 */

import {
  type ForkSessionFailure,
  type ForkSessionOutcome,
  ForkSessionOutcomeSchema,
  type ForkSessionRequest,
  type SessionTransferPlan,
  type TransferOmission,
} from '@ferretry/protocol';
import { SessionForkRefusal, type SessionForkSubsystem } from '../runtime/mounts/session-fork.ts';
import { tryParseSessionId } from '../session-id.ts';
import {
  TransferImportError,
  type TransferImportFailure,
  TransferPrepareError,
  type TransferPrepareFailure,
} from '../transfer/types.ts';
import { SessionForkRequestConflictError } from './failures.ts';
import type { SessionForkCommand, SessionForkKey } from './identity.ts';
import type { SessionForkResult } from './types.ts';

/**
 * Preparation's refusals, in the wire's words.
 *
 * Every arm is a condition of the SOURCE that the caller can usually act on, so each keeps its own
 * name rather than collapsing into a generic failure: "that message is not in the transcript" and
 * "the transcript cannot be read honestly" send a caller to two different remedies.
 */
const PREPARE_FAILURES: { readonly [K in TransferPrepareFailure]: ForkSessionFailure } = {
  source_not_found: 'source_not_found',
  selection_stale: 'selection_stale',
  incomplete_transcript: 'incomplete_transcript',
  target_not_found: 'target_not_found',
  target_not_message: 'target_not_message',
  conversation_unavailable: 'conversation_unavailable',
  lineage_untraceable: 'lineage_untraceable',
  plan_invalid: 'plan_invalid',
};

/**
 * The import's refusals, in the wire's words.
 *
 * `cut_unreadable` and `cut_rewritten` are the pair that makes a frozen plan safe: the importer
 * re-reads the pinned point before its first write, and a source that has moved under the plan is
 * refused rather than imported. They are NOT collapsed into `session_fork_failed`, because nothing
 * is broken — the daemon is behaving correctly by refusing, and the caller's remedy is to choose a
 * message again against a transcript that now reads differently.
 */
const IMPORT_FAILURES: { readonly [K in TransferImportFailure]: ForkSessionFailure } = {
  edge_invalid: 'edge_invalid',
  cut_not_carried: 'cut_not_carried',
  cut_unreadable: 'cut_unreadable',
  cut_rewritten: 'cut_rewritten',
};

/**
 * The only two refusals a target resolver is allowed to state.
 *
 * Declared HERE, in the layer that owns the `SessionForkTargetResolver` port, rather than read from
 * whichever adapter implements it: what a resolver may refuse with is a property of the port, and a
 * `src/lib` module that imported an adapter to learn it would invert the dependency this package's
 * three-layer rule exists to keep pointing one way.
 */
const SESSION_FORK_RESOLUTION_FAILURES: readonly ForkSessionFailure[] = ['unknown_agent', 'agent_unavailable'];

/**
 * Whether a thrown value is a resolver stating one of those two arms.
 *
 * DELIBERATELY STRUCTURAL, and narrow in the safe direction. It matches only an error that names one
 * of the two declared arms, so anything else — including an adapter inventing a third — falls
 * through to `session_fork_failed` rather than being mapped to a code it did not claim. That keeps
 * the check sound while `src/adapters/fork/session-fork-target-resolver.ts` still declares its own
 * error class; when that class moves into `./failures.ts` beside the fork's other refusals, this
 * predicate becomes a plain `instanceof` and the resolver's arms become another mapped table.
 */
function resolutionFailure(error: unknown): ForkSessionFailure | undefined {
  if (!(error instanceof Error) || !('failure' in error)) return undefined;
  const stated = (error as { readonly failure: unknown }).failure;
  return SESSION_FORK_RESOLUTION_FAILURES.find(arm => arm === stated);
}

/**
 * The wire failure for anything this daemon can raise on a fork.
 *
 * The default is `session_fork_failed` and it is SAFE, unlike a migration's: a fork writes nothing
 * to its source and every step after the durable receipt is bound to the fresh target and
 * idempotent, so an unclassified failure leaves a re-drivable receipt rather than a half-destroyed
 * session. That is why a corrupt receipt, a phase regression and an unexpected I/O error can all
 * share one arm without lying to the caller about what it may do next.
 */
export function forkSessionFailure(error: unknown): ForkSessionFailure {
  // Already stated in the wire's own taxonomy — restating it would be a second translation.
  if (error instanceof SessionForkRefusal) return error.failure;
  if (error instanceof TransferPrepareError) return PREPARE_FAILURES[error.failure];
  if (error instanceof TransferImportError) return IMPORT_FAILURES[error.failure];
  // The one caller-caused conflict: the id is spent on a different payload, and only the caller can
  // decide which fork it meant. Checked before the resolver, whose match is structural.
  if (error instanceof SessionForkRequestConflictError) return 'request_id_reused';
  return resolutionFailure(error) ?? 'session_fork_failed';
}

const GENERIC_FORK_FAILURE_MESSAGE = 'the fork could not be completed';

/**
 * Which failure classes have producer prose that was deliberately written for a caller.
 *
 * Every 500 arm is generic. Its producer is describing a violated daemon invariant or an adapter
 * failure, and that prose can contain transcript, state-root or harness paths. Resolver refusals are
 * generic too: their upstream account/catalogue errors can name the manifest, executable or cwd.
 * Only audited caller-actionable producers keep their prose. Keeping this exhaustive makes a new
 * wire arm choose a policy before it can compile.
 */
const REFUSAL_MESSAGE_POLICY: {
  readonly [K in ForkSessionFailure]: 'producer' | 'generic';
} = {
  invalid_session_id: 'producer',
  source_not_found: 'producer',
  selection_stale: 'generic',
  incomplete_transcript: 'producer',
  target_not_found: 'producer',
  target_not_message: 'producer',
  conversation_unavailable: 'producer',
  lineage_untraceable: 'producer',
  plan_invalid: 'generic',
  edge_invalid: 'generic',
  cut_not_carried: 'generic',
  cut_unreadable: 'producer',
  cut_rewritten: 'producer',
  unknown_agent: 'generic',
  agent_unavailable: 'generic',
  request_id_reused: 'producer',
  session_fork_failed: 'generic',
};

/** The message the caller is given, after the failure class chooses what may cross the boundary. */
function refusalMessage(failure: ForkSessionFailure, error: unknown): string {
  if (REFUSAL_MESSAGE_POLICY[failure] === 'generic') return GENERIC_FORK_FAILURE_MESSAGE;
  return error instanceof Error && error.message !== '' ? error.message : GENERIC_FORK_FAILURE_MESSAGE;
}

/** Restates any fork failure as the refusal the route knows how to answer with. */
export function forkRefusal(error: unknown): SessionForkRefusal {
  const failure = forkSessionFailure(error);
  return error instanceof SessionForkRefusal && REFUSAL_MESSAGE_POLICY[failure] === 'producer'
    ? error
    : new SessionForkRefusal(failure, refusalMessage(failure, error));
}

/**
 * The single operation the facade drives.
 *
 * Narrower than `SessionForkService` on purpose: the facade's own behaviour — id validation, the
 * optional-to-nullable collapse, the failure mapping — is provable against this one method, with no
 * receipt store, binder or clock in sight. `SessionForkService` satisfies it structurally, so the
 * composition root hands over the real thing without an adapter in between.
 */
export interface SessionForkOperation {
  fork(key: SessionForkKey, command: SessionForkCommand): Promise<SessionForkResult>;
}

const PATH_FREE_WORKSPACE_DETAIL =
  'conversation time was rewound but filesystem state was not: this build cannot restore the working tree as it stood at the chosen message';
const PATH_FREE_RUNTIME_SUBJECT = 'source harness startup option';
const PATH_FREE_RUNTIME_DETAIL =
  'a source-harness startup option was not carried because the target harness cannot safely interpret it';

/**
 * Keeps the durable omission as the decision owner while removing its daemon-local workspace path.
 *
 * The workspace contributor necessarily measures a cwd and names it in both strings. A cross-family
 * runtime omission necessarily inventories an operator-supplied harness flag, which can itself hold
 * a path or credential. Both remain durable evidence, but neither value belongs on the public wire.
 */
function publicOmission(plan: SessionTransferPlan, omission: TransferOmission): TransferOmission {
  if (omission.facet === 'runtime')
    return {
      ...omission,
      subject: PATH_FREE_RUNTIME_SUBJECT,
      detail: PATH_FREE_RUNTIME_DETAIL,
    };

  if (omission.facet !== 'workspace') return omission;

  const cwd = plan.durable.cwd;
  const withoutCwd = (value: string, fallback: string): string => {
    if (!value.includes(cwd)) return value;
    if (value === cwd) return 'working tree';
    if (cwd === '/') return fallback;
    return value.replaceAll(cwd, 'the working tree');
  };

  return {
    ...omission,
    subject: withoutCwd(omission.subject, 'working tree'),
    detail: withoutCwd(omission.detail, PATH_FREE_WORKSPACE_DETAIL),
  };
}

export class SessionForkFacade implements SessionForkSubsystem {
  constructor(private readonly operation: SessionForkOperation) {}

  async fork(sessionId: string, request: ForkSessionRequest, requestId: string): Promise<ForkSessionOutcome> {
    const sourceSessionId = tryParseSessionId(sessionId);
    if (sourceSessionId === undefined)
      throw new SessionForkRefusal(
        'invalid_session_id',
        `${JSON.stringify(sessionId)} is not a usable session id, so no session can be read under it`,
      );

    /**
     * The one place the wire's optional fields become the payload's nullable ones. A caller that
     * omits `model` and one that could spell it `null` must reach the durable fingerprint as the
     * same fork, or a retry assembled by a different client would be refused for a conflict it
     * does not have.
     */
    const command: SessionForkCommand = {
      through: request.through,
      selectionBinding: request.selectionBinding,
      agent: request.agent,
      model: request.model ?? null,
      effort: request.effort ?? null,
    };

    const result = await this.operation.fork({ sourceSessionId, requestId }, command).catch((error: unknown) => {
      throw forkRefusal(error);
    });

    /**
     * Exactly the two public values the wire owns, assembled field by field. Spreading either the
     * session view or the durable plan would publish daemon-local cwd, directory and transcript
     * provenance. The operational import report stays daemon-side for the same reason.
     */
    return ForkSessionOutcomeSchema.parse({
      session: {
        id: result.session.config.id,
        name: result.session.config.name,
        agent: result.session.config.agent,
        harness: result.session.config.harness,
        model: result.session.config.model ?? null,
        status: result.session.state.status,
      },
      plan: {
        v: result.plan.v,
        planId: result.plan.planId,
        preparedAt: result.plan.preparedAt,
        source: {
          sessionId: result.plan.source.sessionId,
          cutMessagePoint: result.plan.source.cutMessagePoint,
        },
        target: {
          agent: result.plan.target.agent,
          harness: result.plan.target.harness,
          model: result.plan.target.model,
          effort: result.plan.target.effort,
          contextWindow: result.plan.target.contextWindow,
        },
        notCarried: result.plan.notCarried.map(omission => publicOmission(result.plan, omission)),
      },
    });
  }
}
