import {
  TaskBoardChildGrantApprovalSchema,
  TaskBoardChildGrantRequestSchema,
  TaskBoardCreateRequestSchema,
  TaskBoardInvitationApprovalSchema,
  TaskBoardInvitationRequestSchema,
  type TaskBoardCreateResponse,
  type TaskBoardErrorCode,
  type TaskBoardGrantRequestView,
  type TaskBoardInvitationView,
  type TaskBoardMembership,
  type TaskBoardRelinquishResponse,
} from '@ferretry/protocol';
import { secretsMatch } from '../../api/authentication.ts';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { headerValue, type ApiRequest, type ApiResponse } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
// The board domain is imported MODULE BY MODULE rather than through its barrel, and deliberately.
// The barrel re-exports `exactWorkerAssignee`, which nothing calls: a board-scoped task mutation is
// the only caller it could have, and the task routes are not board-scoped yet. Importing the barrel
// would make that module reachable — satisfying the reachability gate — while leaving it exactly as
// absent from the product as it is today. Naming what this mount actually uses keeps the gate's
// answer true.
import { TaskBoardAuthorizationService } from '../../task-boards/authorization-service.ts';
import { childGrantView, TaskBoardChildGrantService } from '../../task-boards/child-grant-service.ts';
import { TaskBoardCreationService } from '../../task-boards/creation-service.ts';
import { membershipForGrant } from '../../task-boards/domain-helpers.ts';
import { isTaskBoardError, TaskBoardError } from '../../task-boards/error.ts';
import { TaskBoardInvitationService } from '../../task-boards/invitation-service.ts';
import { TaskBoardMembershipService } from '../../task-boards/membership-service.ts';
import type {
  TaskBoardCredential,
  TaskBoardCredentialIssuer,
  TaskBoardRepository,
  TaskBoardRepositoryState,
  TaskBoardSession,
  TaskBoardSessionDirectory,
} from '../../task-boards/types.ts';

/**
 * `fy task-board …` — the board membership lifecycle, over the reducers that were built, tested and
 * unmounted for five wiring units.
 *
 * WHAT MADE THIS MOUNTABLE. The recorded blocker was never the reducers: it was that every grant here
 * is keyed on `sessionCapabilityHash`, "the daemon-owned session credential", and no such credential
 * existed. It does now — `SessionLifecycleService.create` mints one for EVERY session, puts the
 * SHA-256 on the record and the plaintext in the session's own environment — so a grant finally has
 * an identity to hang off, and this mount supplies the four adapters the ports named.
 *
 * HOW A CALLER IS IDENTIFIED, AND WHY NO ROUTE HERE READS A SESSION ID. Every peer route derives WHO
 * is calling from the capability it presented: the presented secret is hashed, the binding holding
 * that hash names the session, and the live session directory supplies the runtime generation the
 * domain then re-checks. There is no `x-ferretry-session-id` on this surface and there must not be —
 * that header is an ATTRIBUTION a caller controls, and a board is the one place in this daemon where
 * a spoofed attribution would be a privilege escalation rather than a wrong name in a journal.
 *
 * HOW A REQUEST ID IS OBTAINED. Not one board request on the wire carries an idempotency key — the
 * CLI's eleven bodies are strict schemas and none of them has a field for one — while every reducer
 * here is written around one, because a retried grant must replay rather than duplicate. So the id is
 * DERIVED from the operation's own identity: the same create, requested twice, hashes to the same id
 * and replays to `created: false` instead of conflicting. A random id per call would have made every
 * retry a new operation, which is the outcome the reducers' replay ledgers exist to prevent.
 *
 * HOW A MINTED CAPABILITY REACHES THE SESSION IT WAS MINTED FOR, AND THE ONE LAG IN IT. The board
 * document holds the plaintext (that is what a binding is) and the response never carries it — the
 * CLI states in code that "the daemon should never send one" and strips anything capability-shaped as
 * a second lock. The delivery channel is therefore the session's environment store, the same seam
 * that carries `FY_SESSION_BOARD_CAPABILITY`, and a pane reads its environment AT LAUNCH. So a
 * session that is already running when its grant is issued sees `FY_BOARD_CAPABILITY` on its next
 * launch — a revive — rather than immediately. That is a real limitation and it is stated here rather
 * than papered over: the alternative channel, typing an export into a live pane, would write the
 * secret into the terminal transcript the agent later quotes back.
 *
 * WHAT IS DELIBERATELY NOT SERVED, all three for reasons upstream of wiring:
 *
 *   * `POST /mark-done` and `POST /grants/revoke` — THERE IS NO SERVICE. `TaskBoardOperationKind`
 *     names `mark-done.set` and `grant.revoke`, `TaskBoardAuditEvent` names their audit events, and
 *     the protocol declares both request and response schemas — but no reducer in
 *     `src/lib/task-boards` implements either one. `mark_done` is only ever granted at creation
 *     (`creatorMarkDone`), and the only revocations that exist are the ones relinquish and
 *     coordinator-replacement perform internally. Mounting these means WRITING the domain, which is a
 *     port rather than a wiring, and a hand-rolled revoke at the route layer would be an
 *     authorization decision made outside the only place that makes them.
 *   * `POST /coordinator/replace` — the service exists and its AUTHORITY MODEL does not fit the wire.
 *     `ReplaceCoordinatorCommand` takes an `administratorSessionId` checked by a
 *     `TaskBoardAdministrator` predicate, so the domain expects a SESSION to hold administrator
 *     authority. The command is authenticated by `FY_BOARD_ADMIN_CAPABILITY` — the human operator,
 *     who is not a session and has no id to put in that field or in the audit entry it becomes.
 *     Choosing what `canAdminister` returns, and whom the replacement is attributed to, is a
 *     deliberate decision about who may take a coordinator's authority away; it is not derivable from
 *     anything in this repository, so it is left rather than guessed.
 */

/** The environment variable the CLI reads a peer's board capability from. A wire contract with
 *  `packages/cli/src/adapters/tasks/task-environment.ts`, not a local choice. */
export const BOARD_CAPABILITY_VARIABLE = 'FY_BOARD_CAPABILITY';

/** The one-time invitation proof, read from the environment by `fy task-board invite-accept`. */
export const BOARD_INVITATION_CAPABILITY_VARIABLE = 'FY_BOARD_INVITATION_CAPABILITY';

/** Where a peer presents its own board capability. Never a body field, never argv. */
const BOARD_CAPABILITY_HEADER = 'x-fy-board-capability';

/** Where the human operator presents theirs. */
const BOARD_ADMIN_CAPABILITY_HEADER = 'x-fy-board-admin-capability';

/** Where an invitee presents the credential proving which live session it is. */
const SESSION_BOARD_CAPABILITY_HEADER = 'x-fy-session-board-capability';

/** Where an invitee presents the one-time proof the coordinator's approval minted. */
const BOARD_INVITATION_CAPABILITY_HEADER = 'x-fy-board-invitation-capability';

/**
 * How each domain refusal is reported.
 *
 * The staleness family is 409 rather than 403: the caller's capability was genuine and the board
 * moved underneath it, so a client can tell "you may not" from "you are behind". `unavailable` is 503
 * because it is what the repository raises over a document it refuses to read — a condition an
 * operator fixes, not a request a caller should rephrase.
 */
const TASK_BOARD_ERROR_STATUS: Readonly<Record<TaskBoardErrorCode, number>> = {
  invalid: 400,
  'not-found': 404,
  forbidden: 403,
  conflict: 409,
  'stale-epoch': 409,
  'stale-generation': 409,
  'read-only': 409,
  unavailable: 503,
};

/** Everything the board routes need from the world, behind one seam. */
export interface TaskBoardSubsystem {
  /** The authoritative board container. Its `transaction` is where every decision is made. */
  readonly repository: TaskBoardRepository;
  /** Every session a board may address, with the identity terms the domain checks. */
  readonly sessions: TaskBoardSessionDirectory;
  /** Ids, capabilities and the hash they are compared through. */
  readonly issuer: TaskBoardCredentialIssuer;
  /** The instant a mutation is stamped with. */
  now(): string;
  /** SHA-256 of the operator's board capability, minted into the state home on first use. */
  operatorCapabilityHash(): Promise<string>;
  /** Puts freshly minted board secrets where the session's next launch will read them. */
  deliver(sessionId: string, variables: Readonly<Record<string, string>>): Promise<void>;
}

/** The reducers, built over one authorization service so every route shares one decision path. */
interface TaskBoardServices {
  readonly authorization: TaskBoardAuthorizationService;
  readonly creation: TaskBoardCreationService;
  readonly children: TaskBoardChildGrantService;
  readonly invitations: TaskBoardInvitationService;
  readonly membership: TaskBoardMembershipService;
}

/** The world plus the reducers built over it. Constructed once per mount, not once per request. */
type MountedTaskBoards = TaskBoardSubsystem & { readonly services: TaskBoardServices };

function services(issuer: TaskBoardCredentialIssuer): TaskBoardServices {
  const hash = (value: string): string => issuer.hash(value);
  const authorization = new TaskBoardAuthorizationService(hash);
  return {
    authorization,
    creation: new TaskBoardCreationService(),
    children: new TaskBoardChildGrantService(authorization),
    invitations: new TaskBoardInvitationService(authorization, hash),
    /**
     * NO SESSION ADMINISTERS A BOARD TODAY, and this mount serves no route that would need one: the
     * coordinator replacement is not mounted precisely because the wire authenticates an operator
     * while this predicate expects a session. Answering `false` is the fail-closed statement of that,
     * so the one method behind it can never be reached through a mounted route by accident.
     */
    membership: new TaskBoardMembershipService(authorization, () => false),
  };
}

/** Restates a domain refusal as the HTTP answer for its code. Anything else is a defect, not a
 *  refusal, and travels as a 500 rather than being flattened into a client error. */
function reraise(error: unknown): never {
  if (isTaskBoardError(error)) throw new ApiError(TASK_BOARD_ERROR_STATUS[error.code], error.message, error.code);
  throw error;
}

/** A presented secret, refused before any state is read when it is absent. */
function presented(request: ApiRequest, header: string, missing: string): string {
  const value = headerValue(request, header)?.trim();
  if (value === undefined || value === '') throw new ApiError(401, missing, 'missing_capability');
  return value;
}

/**
 * The caller's own board identity, derived from the capability it presented.
 *
 * The binding is found by HASH, never by any id the caller supplied, so the only way to be resolved as
 * a session is to hold that session's secret. The runtime generation comes from the LIVE directory
 * rather than the binding: `isCapabilityBoundToSession` compares the credential's generation against
 * both the session's and the grant's, so a capability that outlived its session's incarnation is
 * refused instead of quietly authorizing the next one.
 */
function peerCredential(
  state: TaskBoardRepositoryState,
  sessions: readonly TaskBoardSession[],
  capability: string,
  issuer: TaskBoardCredentialIssuer,
): TaskBoardCredential {
  const capabilityHash = issuer.hash(capability);
  const binding = state.bindings.find(candidate => issuer.hash(candidate.capability) === capabilityHash);
  const session = binding === undefined ? undefined : sessions.find(candidate => candidate.id === binding.sessionId);
  if (binding === undefined || session === undefined) {
    throw new TaskBoardError('forbidden', 'the presented board capability names no live membership');
  }
  return { sessionId: session.id, runtimeGeneration: session.runtimeGeneration, capabilityHash };
}

/**
 * The invitee's identity, derived from its SESSION credential rather than a board one.
 *
 * An invitee has no board membership yet — that is what it is asking for — so there is no binding to
 * find it by. `sessionCapabilityHash` is the identity the daemon minted at start, and the invitation
 * proof is bound to it, so matching against the directory is both the lookup and the authentication.
 */
function inviteeCredential(
  sessions: readonly TaskBoardSession[],
  sessionCapability: string,
  issuer: TaskBoardCredentialIssuer,
): TaskBoardCredential {
  const capabilityHash = issuer.hash(sessionCapability);
  const session = sessions.find(candidate => candidate.sessionCapabilityHash === capabilityHash);
  if (session === undefined) {
    throw new TaskBoardError('forbidden', 'the presented session credential names no live session');
  }
  return { sessionId: session.id, runtimeGeneration: session.runtimeGeneration, capabilityHash };
}

/**
 * Refuses anything but the human operator.
 *
 * Both sides are already digests, so the comparison is fixed-width by construction; it still goes
 * through `secretsMatch` rather than `===` so the daemon leaks no prefix oracle to a caller who can
 * time it.
 */
async function requireOperator(subsystem: MountedTaskBoards, request: ApiRequest): Promise<void> {
  const capability = presented(
    request,
    BOARD_ADMIN_CAPABILITY_HEADER,
    'this is an operator command: it needs the board admin capability the daemon minted into its state home',
  );
  if (!secretsMatch(subsystem.issuer.hash(capability), await subsystem.operatorCapabilityHash())) {
    throw new ApiError(403, 'the board admin capability is not this daemon’s', 'forbidden');
  }
}

/**
 * A stable request id for an operation the wire gave no idempotency key.
 *
 * It is a hash of what the operation IS, so the same request retried is the same id and replays
 * through the reducer's own ledger. Two genuinely different operations cannot collide: every part
 * that distinguishes them is in the digest.
 */
function derivedRequestId(issuer: TaskBoardCredentialIssuer, parts: readonly (string | boolean)[]): string {
  return issuer.hash(JSON.stringify(parts));
}

/** The membership one grant projects, which is the whole of what a board tells a peer about itself. */
async function membership(subsystem: MountedTaskBoards, context: RouteContext): Promise<ApiResponse> {
  const capability = presented(
    context.request,
    BOARD_CAPABILITY_HEADER,
    'this session has no board membership: no board capability was presented',
  );
  const [state, sessions] = await Promise.all([subsystem.repository.snapshot(), subsystem.sessions.snapshot()]).catch(
    reraise,
  );
  const view = await (async (): Promise<TaskBoardMembership> => {
    const credential = peerCredential(state, sessions, capability, subsystem.issuer);
    const authorization = subsystem.services.authorization.authorize(state, sessions, credential, 'read');
    const board = state.boards.find(candidate => candidate.id === authorization.boardId);
    const grant = board?.grants.find(candidate => candidate.id === authorization.grantId);
    if (grant === undefined) throw new TaskBoardError('unavailable', 'the authorized grant is no longer readable');
    return membershipForGrant(grant);
  })().catch(reraise);
  return jsonResponse(view satisfies TaskBoardMembership);
}

/**
 * Creates a board over a live interactive top-level session and one of its descendants.
 *
 * Both memberships' capabilities are delivered AFTER the transaction commits, so a secret is only ever
 * handed to a session whose grant genuinely exists. The reverse order would put a working capability
 * in a pane for a board that a failed commit means nobody else can see.
 */
async function create(subsystem: MountedTaskBoards, context: RouteContext): Promise<ApiResponse> {
  await requireOperator(subsystem, context.request);
  const request = await parseBody(context.request, TaskBoardCreateRequestSchema);
  // `creatorMarkDone` CANNOT BE HONOURED, and finding out why is what mounting this surface was for.
  // The creation reducer adds `mark_done` to the creator's `top_agent` actions, and the protocol's own
  // membership projection refuses that membership: `TASK_BOARD_ROLE_ACTIONS` grants `mark_done` to NO
  // role at all, so `TaskBoardMembershipSchema` rejects every board created with this flag — the CLI
  // would refuse the very response it asked for. Serving it means deciding which role may mark a task
  // done, which is an authorization question the protocol has not answered, and `fy task-board
  // mark-done` has no reducer behind it either. Refusing here is the fail-closed statement of a
  // half-ported feature rather than a guess at the missing half.
  if (request.creatorMarkDone === true) {
    throw new ApiError(
      501,
      'creatorMarkDone is not mounted: no task-board role permits the mark_done action, so the membership it would create is one the protocol refuses to serve',
      'mark_done_not_mounted',
    );
  }
  const at = subsystem.now();
  const creatorCapability = subsystem.issuer.capability();
  const coordinatorCapability = subsystem.issuer.capability();
  const response = await subsystem.repository
    .transaction(async state => {
      const sessions = await subsystem.sessions.snapshot();
      return subsystem.services.creation.create(
        state,
        sessions,
        {
          ...request,
          requestId: derivedRequestId(subsystem.issuer, [
            'board.create',
            request.creatorSessionId,
            request.coordinatorSessionId,
            request.creatorMarkDone === true,
          ]),
          at,
        },
        {
          boardId: subsystem.issuer.id('board'),
          creatorGrantId: subsystem.issuer.id('grant'),
          creatorCapability,
          coordinatorGrantId: subsystem.issuer.id('grant'),
          coordinatorCapability,
        },
      );
    })
    .catch(reraise);
  // A replay created nothing, so it minted nothing worth delivering: the capabilities the earlier
  // create issued are the live ones, and overwriting a pane's environment with secrets that authorize
  // nothing would take a working member offline.
  if (response.created) {
    await subsystem.deliver(request.creatorSessionId, { [BOARD_CAPABILITY_VARIABLE]: creatorCapability.value });
    await subsystem.deliver(request.coordinatorSessionId, {
      [BOARD_CAPABILITY_VARIABLE]: coordinatorCapability.value,
    });
  }
  return jsonResponse(response satisfies TaskBoardCreateResponse, response.created ? 201 : 200);
}

/** A top agent asks the coordinator to grant one of its descendants a role on the board. */
async function requestChildGrant(subsystem: MountedTaskBoards, context: RouteContext): Promise<ApiResponse> {
  const capability = presented(
    context.request,
    BOARD_CAPABILITY_HEADER,
    'requesting a child grant needs the calling session’s own board capability',
  );
  const request = await parseBody(context.request, TaskBoardChildGrantRequestSchema);
  const at = subsystem.now();
  const view = await subsystem.repository
    .transaction(async state => {
      const sessions = await subsystem.sessions.snapshot();
      const source = peerCredential(state, sessions, capability, subsystem.issuer);
      return subsystem.services.children.request(state, sessions, {
        source,
        targetSessionId: request.targetSessionId,
        role: request.role,
        requestId: derivedRequestId(subsystem.issuer, [
          'grant.request',
          source.sessionId,
          request.targetSessionId,
          request.role,
        ]),
        at,
      });
    })
    .catch(reraise);
  return jsonResponse(view satisfies TaskBoardGrantRequestView);
}

/**
 * The current coordinator approves a pending child grant.
 *
 * The response is the grant REQUEST's view rather than the new membership, because that is the shape
 * the CLI parses this route into — so an approval and a refusal answer the same schema and a client
 * needs no second branch to read what happened.
 */
async function approveChildGrant(subsystem: MountedTaskBoards, context: RouteContext): Promise<ApiResponse> {
  const capability = presented(
    context.request,
    BOARD_CAPABILITY_HEADER,
    'approving a child grant needs the coordinator’s own board capability',
  );
  const request = await parseBody(context.request, TaskBoardChildGrantApprovalSchema);
  const at = subsystem.now();
  const grantCapability = subsystem.issuer.capability();
  const outcome = await subsystem.repository
    .transaction(async state => {
      const sessions = await subsystem.sessions.snapshot();
      const coordinator = peerCredential(state, sessions, capability, subsystem.issuer);
      const mutation = subsystem.services.children.approve(
        state,
        sessions,
        {
          coordinator,
          grantRequestId: request.grantRequestId,
          requestId: derivedRequestId(subsystem.issuer, ['grant.approve', request.grantRequestId]),
          at,
        },
        { grantId: subsystem.issuer.id('grant'), capability: grantCapability },
      );
      // The intent, as the transaction leaves it, is the answer this route reports — read from the
      // committed state rather than reconstructed, so a refusal reports the reducer's own reason.
      const intent = mutation.state.boards
        .flatMap(board => board.childGrantIntents)
        .find(candidate => candidate.requestId === request.grantRequestId);
      if (intent === undefined)
        throw new TaskBoardError('unavailable', 'the approved child grant intent is no longer readable');
      return { state: mutation.state, result: { approved: mutation.result.approved, intent } };
    })
    .catch(reraise);
  if (outcome.approved) {
    await subsystem.deliver(outcome.intent.targetSessionId, {
      [BOARD_CAPABILITY_VARIABLE]: grantCapability.value,
    });
  }
  return jsonResponse(childGrantView(outcome.intent) satisfies TaskBoardGrantRequestView);
}

/** A top agent invites a session outside its own tree onto the board. */
async function requestInvitation(subsystem: MountedTaskBoards, context: RouteContext): Promise<ApiResponse> {
  const capability = presented(
    context.request,
    BOARD_CAPABILITY_HEADER,
    'inviting a session needs the calling session’s own board capability',
  );
  const request = await parseBody(context.request, TaskBoardInvitationRequestSchema);
  const at = subsystem.now();
  const view = await subsystem.repository
    .transaction(async state => {
      const sessions = await subsystem.sessions.snapshot();
      const source = peerCredential(state, sessions, capability, subsystem.issuer);
      return subsystem.services.invitations.request(state, sessions, {
        source,
        targetSessionId: request.targetSessionId,
        requestId: derivedRequestId(subsystem.issuer, [
          'invitation.request',
          source.sessionId,
          request.targetSessionId,
        ]),
        at,
      });
    })
    .catch(reraise);
  return jsonResponse(view satisfies TaskBoardInvitationView);
}

/**
 * The coordinator approves an invitation, which mints the one-time proof the invitee will accept with.
 *
 * That proof is delivered to the INVITEE and never returned: it is the one board secret whose holder
 * is not yet a member, so the only channel that does not put it through the approving coordinator's
 * terminal is the invitee's own environment.
 */
async function approveInvitation(subsystem: MountedTaskBoards, context: RouteContext): Promise<ApiResponse> {
  const capability = presented(
    context.request,
    BOARD_CAPABILITY_HEADER,
    'approving an invitation needs the coordinator’s own board capability',
  );
  const request = await parseBody(context.request, TaskBoardInvitationApprovalSchema);
  const at = subsystem.now();
  const acceptanceCapability = subsystem.issuer.capability();
  const outcome = await subsystem.repository
    .transaction(async state => {
      const sessions = await subsystem.sessions.snapshot();
      const coordinator = peerCredential(state, sessions, capability, subsystem.issuer);
      return subsystem.services.invitations.approve(
        state,
        sessions,
        {
          coordinator,
          invitationRequestId: request.invitationRequestId,
          requestId: derivedRequestId(subsystem.issuer, ['invitation.approve', request.invitationRequestId]),
          at,
        },
        { acceptanceCapability },
      );
    })
    .catch(reraise);
  if (outcome.approved) {
    await subsystem.deliver(outcome.invitation.targetSessionId, {
      [BOARD_INVITATION_CAPABILITY_VARIABLE]: outcome.acceptanceCapability,
    });
  }
  return jsonResponse(outcome.invitation satisfies TaskBoardInvitationView);
}

/**
 * The invitee accepts, presenting both its own session credential and the one-time proof.
 *
 * TWO secrets, because they answer different questions: the proof says an invitation was approved,
 * and the session credential says WHICH live session is accepting it — before that session has a
 * board capability of its own to be recognised by.
 */
async function acceptInvitation(subsystem: MountedTaskBoards, context: RouteContext): Promise<ApiResponse> {
  const sessionCapability = presented(
    context.request,
    SESSION_BOARD_CAPABILITY_HEADER,
    'accepting an invitation needs the session credential the daemon issued to this session',
  );
  const invitationCapability = presented(
    context.request,
    BOARD_INVITATION_CAPABILITY_HEADER,
    'accepting an invitation needs the one-time proof the coordinator’s approval issued',
  );
  const at = subsystem.now();
  const grantCapability = subsystem.issuer.capability();
  const outcome = await subsystem.repository
    .transaction(async state => {
      const sessions = await subsystem.sessions.snapshot();
      const target = inviteeCredential(sessions, sessionCapability, subsystem.issuer);
      return subsystem.services.invitations.accept(
        state,
        sessions,
        {
          target,
          invitationCapability,
          requestId: derivedRequestId(subsystem.issuer, [
            'invitation.accept',
            target.sessionId,
            String(target.runtimeGeneration),
          ]),
          at,
        },
        { grantId: subsystem.issuer.id('grant'), capability: grantCapability },
      );
    })
    .catch(reraise);
  if (!outcome.accepted) {
    // An expired invitation is not a membership, and the CLI parses this route into a membership. The
    // board's own answer travels as the refusal reason rather than as a shape the client cannot read.
    throw new ApiError(409, `the invitation was not accepted: it is ${outcome.invitation.status}`, 'conflict');
  }
  await subsystem.deliver(outcome.membership.sessionId, { [BOARD_CAPABILITY_VARIABLE]: grantCapability.value });
  return jsonResponse(outcome.membership satisfies TaskBoardMembership, 201);
}

/** A member gives up its own membership, which revokes every grant beneath it. */
async function relinquish(subsystem: MountedTaskBoards, context: RouteContext): Promise<ApiResponse> {
  const capability = presented(
    context.request,
    BOARD_CAPABILITY_HEADER,
    'relinquishing membership needs the calling session’s own board capability',
  );
  const at = subsystem.now();
  const response = await subsystem.repository
    .transaction(async state => {
      const sessions = await subsystem.sessions.snapshot();
      const member = peerCredential(state, sessions, capability, subsystem.issuer);
      return subsystem.services.membership.relinquish(state, sessions, {
        member,
        requestId: derivedRequestId(subsystem.issuer, [
          'membership.relinquish',
          member.sessionId,
          String(member.runtimeGeneration),
        ]),
        at,
      });
    })
    .catch(reraise);
  return jsonResponse(response satisfies TaskBoardRelinquishResponse);
}

/**
 * `admin` scope throughout.
 *
 * The bearer token decides whether a request may be served at all; the capability headers above
 * decide who it is FROM. Both are required on every route here, and they are not redundant: the
 * bearer is shared by every pane on the host, so it identifies nobody, and the capability identifies
 * exactly one session but travels on a surface the bearer is what protects.
 *
 * `noStore` because every response is a membership decision, and a cached one is authority that has
 * already been revoked.
 *
 * The fixed literals register before the deeper patterns, matching the ordering rule the rest of the
 * table follows. Nothing here can shadow another subsystem: every path is under `/v1/task-boards`.
 */
export function taskBoardRoutes(world: TaskBoardSubsystem): readonly ApiRoute[] {
  // The reducers are built ONCE here, not per request: they are stateless, and one authorization
  // service shared by every route is what makes "the decision path" a single thing rather than eight.
  //
  // Each method is BOUND rather than spread. `{...world}` copies own enumerable properties only, so a
  // world supplied as a class instance — which the ports invite, and which the tests use — would
  // arrive with `now`, `deliver` and `operatorCapabilityHash` silently missing from the prototype they
  // live on. Naming them is what makes this mount indifferent to how its world was constructed.
  const subsystem: MountedTaskBoards = {
    repository: world.repository,
    sessions: world.sessions,
    issuer: world.issuer,
    now: () => world.now(),
    operatorCapabilityHash: async () => await world.operatorCapabilityHash(),
    deliver: async (sessionId, variables) => await world.deliver(sessionId, variables),
    services: services(world.issuer),
  };
  return [
    {
      method: 'GET',
      path: '/v1/task-boards/membership',
      scope: 'admin',
      noStore: true,
      handle: async context => await membership(subsystem, context),
    },
    {
      method: 'POST',
      path: '/v1/task-boards/create',
      scope: 'admin',
      noStore: true,
      handle: async context => await create(subsystem, context),
    },
    {
      method: 'POST',
      path: '/v1/task-boards/child-grants/request',
      scope: 'admin',
      noStore: true,
      handle: async context => await requestChildGrant(subsystem, context),
    },
    {
      method: 'POST',
      path: '/v1/task-boards/child-grants/approve',
      scope: 'admin',
      noStore: true,
      handle: async context => await approveChildGrant(subsystem, context),
    },
    {
      method: 'POST',
      path: '/v1/task-boards/invitations/request',
      scope: 'admin',
      noStore: true,
      handle: async context => await requestInvitation(subsystem, context),
    },
    {
      method: 'POST',
      path: '/v1/task-boards/invitations/approve',
      scope: 'admin',
      noStore: true,
      handle: async context => await approveInvitation(subsystem, context),
    },
    {
      method: 'POST',
      path: '/v1/task-boards/invitations/accept',
      scope: 'admin',
      noStore: true,
      handle: async context => await acceptInvitation(subsystem, context),
    },
    {
      method: 'POST',
      path: '/v1/task-boards/membership/relinquish',
      scope: 'admin',
      noStore: true,
      handle: async context => await relinquish(subsystem, context),
    },
  ];
}
