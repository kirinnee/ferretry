import { describe, it } from 'bun:test';
import {
  TaskBoardCreateResponseSchema,
  TaskBoardGrantRequestViewSchema,
  TaskBoardInvitationViewSchema,
  TaskBoardMembershipSchema,
  TaskBoardRelinquishResponseSchema,
} from '@ferretry/protocol';
import should from 'should';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import type { ApiResponse } from '../../../../src/lib/api/http.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import {
  BOARD_CAPABILITY_VARIABLE,
  BOARD_INVITATION_CAPABILITY_VARIABLE,
  childGrantRequester,
  taskBoardRoutes,
  taskBoardTaskActionAuthorizer,
} from '../../../../src/lib/runtime/mounts/task-boards.ts';
import { isTaskBoardError, TaskBoardError } from '../../../../src/lib/task-boards/error.ts';
import { jsonBody, request } from '../../api/support.ts';
import { boardSession, CREDENTIALS, FakeTaskBoards, human } from './support.ts';

/**
 * The board membership mount, driven through the real router over the real reducers.
 *
 * The document is in memory and the secrets are predictable; every decision above them — who may
 * create a board, which grants a coordinator may approve, whether a capability is still bound to its
 * session, and what a relinquish revokes — is production code. Each response is parsed with the
 * protocol schema the shipped `fy task-board` parses it with, so a shape the CLI would refuse fails
 * here rather than in somebody's terminal.
 *
 * THE POINT OF THIS FILE is that these routes did not exist. Eleven modules sat at 100% coverage and
 * `POST /v1/task-boards/create` answered `unknown_route`, so every case below is a capability the
 * product gains rather than a regression it is protected from.
 */

/** A creator (live, interactive, top-level) and one descendant to coordinate for it. */
const FLEET = [
  boardSession({ id: 'root' }),
  boardSession({ id: 'coordinator', parentSessionId: 'root', mode: 'auto' }),
  boardSession({ id: 'grandchild', parentSessionId: 'coordinator', mode: 'auto' }),
  boardSession({ id: 'outsider' }),
  boardSession({ id: 'successor', parentSessionId: 'outsider', mode: 'auto' }),
  boardSession({ id: 'successor-child', parentSessionId: 'outsider', mode: 'auto' }),
];

const PREFIX = '/v1/task-boards';

function dispatcher(world: FakeTaskBoards): ApiDispatcher {
  return new ApiDispatcher(new ApiRouter(taskBoardRoutes(world)), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD);
}

async function post(
  world: FakeTaskBoards,
  path: string,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): Promise<ApiResponse> {
  return await dispatcher(world).dispatch(
    request({
      method: 'POST',
      path: `${PREFIX}${path}`,
      headers: { ...human, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
}

async function get(
  world: FakeTaskBoards,
  path: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<ApiResponse> {
  return await dispatcher(world).dispatch(request({ path: `${PREFIX}${path}`, headers: { ...human, ...headers } }));
}

const operator = (world: FakeTaskBoards) => ({ 'x-fy-board-admin-capability': world.operatorCapability });
const peer = (capability: string) => ({ 'x-fy-board-capability': capability });

/** Creates a board and returns the world, so every later case starts from a real membership. */
async function withBoard(): Promise<FakeTaskBoards> {
  const world = new FakeTaskBoards(FLEET);
  const created = await post(
    world,
    '/create',
    { creatorSessionId: 'root', coordinatorSessionId: 'coordinator' },
    operator(world),
  );
  should(created.status).equal(201);
  return world;
}

describe('the task board membership mount', () => {
  it('should create a board and deliver each member its own capability', async () => {
    // Arrange
    const world = new FakeTaskBoards(FLEET);

    // Act
    const response = await post(
      world,
      '/create',
      { creatorSessionId: 'root', coordinatorSessionId: 'coordinator' },
      operator(world),
    );

    // Assert
    should(response.status).equal(201);
    const body = TaskBoardCreateResponseSchema.parse(jsonBody(response));
    should(body.created).be.true();
    should(body.creator.role).equal('top_agent');
    should(body.coordinator.role).equal('coordinator');
    // Each secret went to the session it was minted for, and to nobody else.
    should(world.delivered).eql([
      ['root', { [BOARD_CAPABILITY_VARIABLE]: world.capabilityFor('root') ?? '' }],
      ['coordinator', { [BOARD_CAPABILITY_VARIABLE]: world.capabilityFor('coordinator') ?? '' }],
    ]);
  });

  it('should never put a capability in the response body', async () => {
    // Arrange
    const world = new FakeTaskBoards(FLEET);

    // Act
    const response = await post(
      world,
      '/create',
      { creatorSessionId: 'root', coordinatorSessionId: 'coordinator' },
      operator(world),
    );

    // Assert — the CLI redacts as a second lock; this is the first one.
    should(response.body).not.match(/capability-/u);
  });

  it('should replay a repeated create instead of conflicting or minting a second board', async () => {
    // Arrange
    const world = await withBoard();
    const deliveries = world.delivered.length;

    // Act — the same payload again, with no idempotency key on the wire.
    const response = await post(
      world,
      '/create',
      { creatorSessionId: 'root', coordinatorSessionId: 'coordinator' },
      operator(world),
    );

    // Assert
    should(response.status).equal(200);
    should(TaskBoardCreateResponseSchema.parse(jsonBody(response)).created).be.false();
    should(world.state.boards).have.length(1);
    // A replay minted nothing, so it delivered nothing: overwriting a live member's environment with
    // a capability that authorizes nothing would take that member offline.
    should(world.delivered).have.length(deliveries);
  });

  it('should refuse a create from anyone but the operator', async () => {
    // Arrange
    const world = new FakeTaskBoards(FLEET);

    // Act
    const missing = await post(world, '/create', { creatorSessionId: 'root', coordinatorSessionId: 'coordinator' });
    const wrong = await post(
      world,
      '/create',
      { creatorSessionId: 'root', coordinatorSessionId: 'coordinator' },
      { 'x-fy-board-admin-capability': 'guessed' },
    );

    // Assert
    should(missing.status).equal(401);
    should(wrong.status).equal(403);
    should(world.state.boards).be.empty();
  });

  it('should refuse a create whose creator is not a live interactive top-level session', async () => {
    // Arrange
    const world = new FakeTaskBoards(FLEET);

    // Act — `coordinator` is an auto-mode descendant, which the domain refuses as a creator.
    const response = await post(
      world,
      '/create',
      { creatorSessionId: 'coordinator', coordinatorSessionId: 'grandchild' },
      operator(world),
    );

    // Assert
    should(response.status).equal(403);
    should(jsonBody(response)).have.property('code', 'forbidden');
  });

  it('should report 404 for a create naming a session the daemon has never seen', async () => {
    // Arrange
    const world = new FakeTaskBoards(FLEET);

    // Act
    const response = await post(
      world,
      '/create',
      { creatorSessionId: 'root', coordinatorSessionId: 'ghost' },
      operator(world),
    );

    // Assert
    should(response.status).equal(404);
  });

  it('should refuse a create whose body is not the shape the protocol declares', async () => {
    // Arrange
    const world = new FakeTaskBoards(FLEET);

    // Act
    const response = await post(world, '/create', { creatorSessionId: 'root' }, operator(world));

    // Assert
    should(response.status).equal(400);
  });

  it('should report a member its own membership, derived from the capability it presented', async () => {
    // Arrange
    const world = await withBoard();

    // Act
    const response = await get(world, '/membership', peer(world.capabilityFor('root') ?? ''));

    // Assert
    const membership = TaskBoardMembershipSchema.parse(jsonBody(response));
    should(membership.sessionId).equal('root');
    should(membership.role).equal('top_agent');
  });

  it('should refuse a membership read that presents no capability', async () => {
    // Arrange
    const world = await withBoard();

    // Act
    const response = await get(world, '/membership');

    // Assert
    should(response.status).equal(401);
    should(jsonBody(response)).have.property('code', 'missing_capability');
  });

  it('should refuse a capability that names no membership, whatever session id the caller claims', async () => {
    // Arrange
    const world = await withBoard();

    // Act — a well-formed request carrying a secret the board never issued.
    const response = await get(world, '/membership', peer('not-a-real-capability'));

    // Assert
    should(response.status).equal(403);
  });

  it('should refuse a capability whose session has since stopped', async () => {
    // Arrange — the same board, read through a directory in which `root` is no longer live.
    const world = await withBoard();
    const capability = world.capabilityFor('root') ?? '';
    const stopped = new FakeTaskBoards([boardSession({ id: 'root', active: false }), ...FLEET.slice(1)]);
    stopped.state = world.state;

    // Act
    const response = await get(stopped, '/membership', peer(capability));

    // Assert
    should(response.status).equal(403);
  });

  it('should let a top agent request a child grant and the coordinator approve it', async () => {
    // Arrange
    const world = await withBoard();

    // Act
    const requested = await post(
      world,
      '/child-grants/request',
      { targetSessionId: 'grandchild', role: 'worker' },
      peer(world.capabilityFor('root') ?? ''),
    );
    const pending = TaskBoardGrantRequestViewSchema.parse(jsonBody(requested));
    const approved = await post(
      world,
      '/child-grants/approve',
      { grantRequestId: pending.requestId },
      peer(world.capabilityFor('coordinator') ?? ''),
    );
    const firstCapability = world.delivered.at(-1)?.[1][BOARD_CAPABILITY_VARIABLE] ?? '';
    const replayed = await post(
      world,
      '/child-grants/approve',
      { grantRequestId: pending.requestId },
      peer(world.capabilityFor('coordinator') ?? ''),
    );
    const replayedCapability = world.delivered.at(-1)?.[1][BOARD_CAPABILITY_VARIABLE] ?? '';

    // Assert
    should(pending.status).equal('pending');
    should(pending.requestedRole).equal('worker');
    const view = TaskBoardGrantRequestViewSchema.parse(jsonBody(approved));
    should(view.status).equal('approved');
    should(TaskBoardGrantRequestViewSchema.parse(jsonBody(replayed)).status).equal('approved');
    should(replayedCapability).equal(firstCapability);
    // The new member holds a working capability, delivered to its own environment.
    should(world.delivered.at(-1)).eql([
      'grandchild',
      { [BOARD_CAPABILITY_VARIABLE]: world.capabilityFor('grandchild') ?? '' },
    ]);
    const membership = TaskBoardMembershipSchema.parse(
      jsonBody(await get(world, '/membership', peer(replayedCapability))),
    );
    should(membership.role).equal('worker');
  });

  it('should give a start the same child grant the route would have made', async () => {
    // `POST /v1/sessions` with a `--board-access` other than `none` reaches the board through this
    // seam rather than through the route, and the two must converge: the request id is DERIVED from
    // the operation's own identity, so the protocol client's recovery re-ask replays the intent the
    // start created instead of opening a second one. A seam with its own id would make every
    // recovered start request a duplicate grant.
    // Arrange
    const world = await withBoard();
    const requester = childGrantRequester(world);

    // Act — the start's ask, then the recovery re-ask the client makes over the route.
    const atStart = await requester(world.capabilityFor('root') ?? '', 'grandchild', 'worker');
    const reAsked = TaskBoardGrantRequestViewSchema.parse(
      jsonBody(
        await post(
          world,
          '/child-grants/request',
          { targetSessionId: 'grandchild', role: 'worker' },
          peer(world.capabilityFor('root') ?? ''),
        ),
      ),
    );

    // Assert
    should(atStart.status).equal('pending');
    should(atStart.requestedRole).equal('worker');
    // One intent, not two: the second ask replayed the first.
    should(reAsked.requestId).equal(atStart.requestId);
    should(world.state.boards.flatMap(board => board.childGrantIntents)).have.length(1);
  });

  it('should recover child-grant delivery from its committed binding before the child starts', async () => {
    // Arrange
    const world = await withBoard();
    const pending = TaskBoardGrantRequestViewSchema.parse(
      jsonBody(
        await post(
          world,
          '/child-grants/request',
          { targetSessionId: 'grandchild', role: 'coordinator' },
          peer(world.capabilityFor('root') ?? ''),
        ),
      ),
    );
    world.deliveryFailure = new Error('the first pre-launch environment delivery failed');

    // Act
    const failed = await post(
      world,
      '/child-grants/approve',
      { grantRequestId: pending.requestId },
      peer(world.capabilityFor('coordinator') ?? ''),
    );
    const committedCapability = world.capabilityFor('grandchild') ?? '';
    const mintCountAfterCommit = world.capabilityMintCount;
    const committedState = world.state;
    world.deliveryFailure = undefined;
    world.state = {
      ...committedState,
      bindings: committedState.bindings.filter(binding => binding.sessionId !== 'grandchild'),
    };
    const missingBinding = await post(
      world,
      '/child-grants/approve',
      { grantRequestId: pending.requestId },
      peer(world.capabilityFor('coordinator') ?? ''),
    );
    world.state = committedState;
    const recovered = await post(
      world,
      '/child-grants/approve',
      { grantRequestId: pending.requestId },
      peer(world.capabilityFor('coordinator') ?? ''),
    );
    const deliveredCapability = world.delivered.at(-1)?.[1][BOARD_CAPABILITY_VARIABLE] ?? '';

    // Assert
    should(failed.status).equal(500);
    should(missingBinding.status).equal(503);
    should(recovered.status).equal(200);
    should(world.capabilityMintCount).equal(mintCountAfterCommit);
    should(deliveredCapability).equal(committedCapability);
    should((await get(world, '/membership', peer(deliveredCapability))).status).equal(200);
  });

  it('should raise the board’s own refusal when a start presents a capability naming no membership', async () => {
    // The composition root catches this to retire the session it had just created, and the mount
    // restates it through the same status table the route uses — neither can happen if the seam
    // swallows it.
    // Arrange
    const world = await withBoard();
    const requester = childGrantRequester(world);

    // Act
    const refused = await requester('not-anybody-s-capability', 'grandchild', 'worker').catch(error => error);

    // Assert
    should(isTaskBoardError(refused)).be.true();
    should((refused as TaskBoardError).code).equal('forbidden');
    should(world.state.boards.flatMap(board => board.childGrantIntents)).be.empty();
  });

  it('should refuse a child grant approval from a member who is not the coordinator', async () => {
    // Arrange
    const world = await withBoard();
    const requested = await post(
      world,
      '/child-grants/request',
      { targetSessionId: 'grandchild', role: 'read' },
      peer(world.capabilityFor('root') ?? ''),
    );
    const pending = TaskBoardGrantRequestViewSchema.parse(jsonBody(requested));

    // Act — the top agent tries to approve its own request.
    const response = await post(
      world,
      '/child-grants/approve',
      { grantRequestId: pending.requestId },
      peer(world.capabilityFor('root') ?? ''),
    );

    // Assert
    should(response.status).equal(403);
    should(world.capabilityFor('grandchild')).be.undefined();
  });

  it('should replay a repeated child-grant request rather than opening a second intent', async () => {
    // Arrange
    const world = await withBoard();
    const body = { targetSessionId: 'grandchild', role: 'worker' };

    // Act
    const first = TaskBoardGrantRequestViewSchema.parse(
      jsonBody(await post(world, '/child-grants/request', body, peer(world.capabilityFor('root') ?? ''))),
    );
    const second = TaskBoardGrantRequestViewSchema.parse(
      jsonBody(await post(world, '/child-grants/request', body, peer(world.capabilityFor('root') ?? ''))),
    );

    // Assert
    should(second.requestId).equal(first.requestId);
    should(world.state.boards[0]?.childGrantIntents).have.length(1);
  });

  it('should refuse a child grant request that presents no capability', async () => {
    // Arrange
    const world = await withBoard();

    // Act
    const response = await post(world, '/child-grants/request', { targetSessionId: 'grandchild', role: 'worker' });

    // Assert
    should(response.status).equal(401);
  });

  it('should refuse a child grant approval naming an intent that does not exist', async () => {
    // Arrange
    const world = await withBoard();

    // Act
    const response = await post(
      world,
      '/child-grants/approve',
      { grantRequestId: 'never-requested' },
      peer(world.capabilityFor('coordinator') ?? ''),
    );

    // Assert
    should(response.status).be.oneOf([403, 404]);
  });

  it('should carry an outside session onto the board through invite, approve and accept', async () => {
    // Arrange
    const world = await withBoard();

    // Act
    const invited = TaskBoardInvitationViewSchema.parse(
      jsonBody(
        await post(
          world,
          '/invitations/request',
          { targetSessionId: 'outsider' },
          peer(world.capabilityFor('root') ?? ''),
        ),
      ),
    );
    const approved = TaskBoardInvitationViewSchema.parse(
      jsonBody(
        await post(
          world,
          '/invitations/approve',
          { invitationRequestId: invited.requestId },
          peer(world.capabilityFor('coordinator') ?? ''),
        ),
      ),
    );
    // The one-time proof went to the INVITEE, never to the approving coordinator's terminal.
    const proof = world.delivered.at(-1);
    should(proof?.[0]).equal('outsider');
    const invitationCapability = proof?.[1][BOARD_INVITATION_CAPABILITY_VARIABLE] ?? '';
    const accepted = await post(
      world,
      '/invitations/accept',
      {},
      {
        'x-fy-session-board-capability': 'session:outsider',
        'x-fy-board-invitation-capability': invitationCapability,
      },
    );

    // Assert
    should(invited.status).equal('pending');
    should(approved.status).equal('approved');
    should(accepted.status).equal(201);
    const membership = TaskBoardMembershipSchema.parse(jsonBody(accepted));
    should(membership.sessionId).equal('outsider');
    should(membership.role).equal('top_agent');
  });

  it('should recover invitation-accept delivery from the committed binding after a crash', async () => {
    // Arrange
    const world = await withBoard();
    const invited = TaskBoardInvitationViewSchema.parse(
      jsonBody(
        await post(
          world,
          '/invitations/request',
          { targetSessionId: 'outsider' },
          peer(world.capabilityFor('root') ?? ''),
        ),
      ),
    );
    await post(
      world,
      '/invitations/approve',
      { invitationRequestId: invited.requestId },
      peer(world.capabilityFor('coordinator') ?? ''),
    );
    const invitationCapability = world.delivered.at(-1)?.[1][BOARD_INVITATION_CAPABILITY_VARIABLE] ?? '';
    const headers = {
      'x-fy-session-board-capability': 'session:outsider',
      'x-fy-board-invitation-capability': invitationCapability,
    };
    world.deliveryFailure = new Error('the first accepted-membership delivery failed after commit');

    // Act — the first route call commits, then crashes; the identical retry has no one-time proof on disk.
    const failed = await post(world, '/invitations/accept', {}, headers);
    const committedCapability = world.capabilityFor('outsider') ?? '';
    const mintCountAfterCommit = world.capabilityMintCount;
    const committedState = world.state;
    world.deliveryFailure = undefined;
    world.state = {
      ...committedState,
      bindings: committedState.bindings.filter(binding => binding.sessionId !== 'outsider'),
    };
    const missingBinding = await post(world, '/invitations/accept', {}, headers);
    world.state = committedState;
    const recovered = await post(world, '/invitations/accept', {}, headers);
    const deliveredCapability = world.delivered.at(-1)?.[1][BOARD_CAPABILITY_VARIABLE] ?? '';
    const authenticated = await get(world, '/membership', peer(deliveredCapability));

    // Assert — replay re-delivers the exact persisted binding, never the retry's newly minted material.
    should(failed.status).equal(500);
    should(missingBinding.status).equal(503);
    should(recovered.status).equal(201);
    should(world.capabilityMintCount).equal(mintCountAfterCommit);
    should(deliveredCapability).equal(committedCapability);
    should(authenticated.status).equal(200);
    should(JSON.stringify(jsonBody(recovered))).not.containEql(deliveredCapability);
    should(world.state.boards[0]?.invitations).match([{ requestId: invited.requestId, status: 'accepted' }]);
  });

  it('should refuse an acceptance that presents the wrong session credential', async () => {
    // Arrange
    const world = await withBoard();
    const invited = TaskBoardInvitationViewSchema.parse(
      jsonBody(
        await post(
          world,
          '/invitations/request',
          { targetSessionId: 'outsider' },
          peer(world.capabilityFor('root') ?? ''),
        ),
      ),
    );
    await post(
      world,
      '/invitations/approve',
      { invitationRequestId: invited.requestId },
      peer(world.capabilityFor('coordinator') ?? ''),
    );
    const invitationCapability = world.delivered.at(-1)?.[1][BOARD_INVITATION_CAPABILITY_VARIABLE] ?? '';

    // Act — a different live session presents the invitee's proof.
    const response = await post(
      world,
      '/invitations/accept',
      {},
      {
        'x-fy-session-board-capability': 'session:grandchild',
        'x-fy-board-invitation-capability': invitationCapability,
      },
    );

    // Assert
    should(response.status).equal(403);
  });

  it('should refuse an acceptance whose one-time proof is not the approved one', async () => {
    // Arrange
    const world = await withBoard();
    const invited = TaskBoardInvitationViewSchema.parse(
      jsonBody(
        await post(
          world,
          '/invitations/request',
          { targetSessionId: 'outsider' },
          peer(world.capabilityFor('root') ?? ''),
        ),
      ),
    );
    await post(
      world,
      '/invitations/approve',
      { invitationRequestId: invited.requestId },
      peer(world.capabilityFor('coordinator') ?? ''),
    );

    // Act
    const response = await post(
      world,
      '/invitations/accept',
      {},
      {
        'x-fy-session-board-capability': 'session:outsider',
        'x-fy-board-invitation-capability': 'forged-proof',
      },
    );

    // Assert
    should(response.status).equal(403);
  });

  it('should refuse an acceptance that presents no session credential at all', async () => {
    // Arrange
    const world = await withBoard();

    // Act
    const noSession = await post(world, '/invitations/accept', {}, { 'x-fy-board-invitation-capability': 'p' });
    const noProof = await post(
      world,
      '/invitations/accept',
      {},
      { 'x-fy-session-board-capability': 'session:outsider' },
    );

    // Assert
    should(noSession.status).equal(401);
    should(noProof.status).equal(401);
  });

  it('should refuse an invitation request that presents no capability', async () => {
    // Arrange
    const world = await withBoard();

    // Act
    const response = await post(world, '/invitations/request', { targetSessionId: 'outsider' });

    // Assert
    should(response.status).equal(401);
  });

  it('should refuse an invitation approval from a member who is not the coordinator', async () => {
    // Arrange
    const world = await withBoard();
    const invited = TaskBoardInvitationViewSchema.parse(
      jsonBody(
        await post(
          world,
          '/invitations/request',
          { targetSessionId: 'outsider' },
          peer(world.capabilityFor('root') ?? ''),
        ),
      ),
    );

    // Act
    const response = await post(
      world,
      '/invitations/approve',
      { invitationRequestId: invited.requestId },
      peer(world.capabilityFor('root') ?? ''),
    );

    // Assert
    should(response.status).equal(403);
  });

  it('should refuse to let the only membership root abandon the board', async () => {
    // Arrange
    const world = await withBoard();

    // Act
    const response = await post(world, '/membership/relinquish', {}, peer(world.capabilityFor('root') ?? ''));

    // Assert — a board with nobody left to own it is not a state the domain will enter.
    should(response.status).equal(403);
    should(jsonBody(response)).have.property(
      'error',
      'only a membership root with a verified accepted replacement root may relinquish access',
    );
  });

  it('should recover a committed relinquish after its response is lost', async () => {
    // Arrange — the invitation flow is what produces a second membership root.
    const world = await withBoard();
    const invited = TaskBoardInvitationViewSchema.parse(
      jsonBody(
        await post(
          world,
          '/invitations/request',
          { targetSessionId: 'outsider' },
          peer(world.capabilityFor('root') ?? ''),
        ),
      ),
    );
    await post(
      world,
      '/invitations/approve',
      { invitationRequestId: invited.requestId },
      peer(world.capabilityFor('coordinator') ?? ''),
    );
    await post(
      world,
      '/invitations/accept',
      {},
      {
        'x-fy-session-board-capability': 'session:outsider',
        'x-fy-board-invitation-capability': world.delivered.at(-1)?.[1][BOARD_INVITATION_CAPABILITY_VARIABLE] ?? '',
      },
    );
    const capability = world.capabilityFor('root') ?? '';

    // A grant on disk is not proof that the replacement harness received it. The old root must stay
    // live until the replacement itself uses the delivered capability.
    const beforeVerification = await post(world, '/membership/relinquish', {}, peer(capability));
    should(beforeVerification.status).equal(403);
    should(world.capabilityFor('root')).equal(capability);
    const replacementCapability = world.capabilityFor('outsider') ?? '';
    const verified = await post(world, '/invitations/verify', {}, peer(replacementCapability));
    should(verified.status).equal(200);
    const beforeCoordinatorMove = await post(world, '/membership/relinquish', {}, peer(capability));
    should(beforeCoordinatorMove.status).equal(403);
    should(jsonBody(beforeCoordinatorMove).error).match(/move the coordinator into a surviving membership tree first/u);
    const wrongTree = await post(
      world,
      '/coordinator/replace',
      {
        requestId: 'route-wrong-coordinator-tree',
        sessionId: 'root',
        replacementSessionId: 'grandchild',
        replacementRootSessionId: 'outsider',
      },
      operator(world),
    );
    should(wrongTree.status).equal(403);
    should(jsonBody(wrongTree).error).match(/expected live membership root/u);
    const coordinatorGrant = TaskBoardGrantRequestViewSchema.parse(
      jsonBody(
        await post(
          world,
          '/child-grants/request',
          { targetSessionId: 'successor', role: 'coordinator' },
          peer(replacementCapability),
        ),
      ),
    );
    await post(
      world,
      '/child-grants/approve',
      { grantRequestId: coordinatorGrant.requestId },
      peer(world.capabilityFor('coordinator') ?? ''),
    );
    const prelaunchCoordinatorCapability = world.delivered.at(-1)?.[1][BOARD_CAPABILITY_VARIABLE] ?? '';
    should((await get(world, '/membership', peer(prelaunchCoordinatorCapability))).status).equal(200);
    const moved = await post(
      world,
      '/coordinator/replace',
      {
        requestId: 'route-handover-coordinator',
        sessionId: 'root',
        replacementSessionId: 'successor',
        replacementRootSessionId: 'outsider',
      },
      operator(world),
    );
    should(moved.status).equal(200);
    should(world.delivered.at(-1)?.[1][BOARD_CAPABILITY_VARIABLE]).equal(prelaunchCoordinatorCapability);
    const proofIntent = TaskBoardGrantRequestViewSchema.parse(
      jsonBody(
        await post(
          world,
          '/child-grants/request',
          { targetSessionId: 'successor-child', role: 'read' },
          peer(replacementCapability),
        ),
      ),
    );
    const proved = await post(
      world,
      '/child-grants/approve',
      { grantRequestId: proofIntent.requestId },
      peer(prelaunchCoordinatorCapability),
    );
    should(proved.status).equal(200);
    world.transactionFailureAfterCommit = new Error('the relinquish committed before its HTTP receipt was lost');

    // Act — the first attempt commits and removes the source binding, then loses its response. The
    // identical retry must reach the durable operation through the retired grant rather than through
    // the live-binding authorization path that can no longer succeed.
    const failed = await post(world, '/membership/relinquish', {}, peer(capability));
    const committedGeneration = world.state.boards[0]?.mutationGeneration;
    const response = await post(world, '/membership/relinquish', {}, peer(capability));

    // Assert
    const body = TaskBoardRelinquishResponseSchema.parse(jsonBody(response));
    should(failed.status).equal(500);
    should(response.status).equal(200);
    should(body.relinquished).be.true();
    should(body.sessionId).equal('root');
    should(body.sessionStopped).be.false();
    should(world.state.boards[0]?.mutationGeneration).equal(committedGeneration);
    // The capability no longer authorizes anything: the grant behind it is revoked.
    should((await get(world, '/membership', peer(capability))).status).equal(403);
  });

  it('should issue mark_done only on the creator’s explicit top-agent grant', async () => {
    // Arrange
    const world = new FakeTaskBoards(FLEET);

    // Act
    const response = await post(
      world,
      '/create',
      { creatorSessionId: 'root', coordinatorSessionId: 'coordinator', creatorMarkDone: true },
      operator(world),
    );

    // Assert — this is a grant capability, not a UI permission. The coordinator does not inherit it.
    const body = TaskBoardCreateResponseSchema.parse(jsonBody(response));
    should(response.status).equal(201);
    should(body.creator.allowedActions).containEql('mark_done');
    should(body.coordinator.allowedActions).not.containEql('mark_done');
    should(world.state.boards).have.length(1);
  });

  it('should authorize mark_done only for the exact granted session and never around unavailable board state', async () => {
    // Arrange
    const world = new FakeTaskBoards(FLEET);
    const created = await post(
      world,
      '/create',
      { creatorSessionId: 'root', coordinatorSessionId: 'coordinator', creatorMarkDone: true },
      operator(world),
    );
    should(created.status).equal(201);
    const authorize = taskBoardTaskActionAuthorizer(world).authorize;
    const creatorCapability = world.capabilityFor('root');
    const coordinatorCapability = world.capabilityFor('coordinator');
    should(creatorCapability).be.a.String();
    should(coordinatorCapability).be.a.String();

    // Assert — a valid membership without this exact action is not enough.
    await authorize({ targetSessionId: 'root', capability: creatorCapability!, action: 'mark_done' });
    await should(
      authorize({ targetSessionId: 'root', capability: coordinatorCapability!, action: 'mark_done' }),
    ).be.rejectedWith(TaskBoardError);

    // A damaged authorization read is unavailable, not an implicit permission.
    Object.assign(world.repository, {
      snapshot: async () => {
        throw new TaskBoardError('unavailable', 'task-board state is unreadable');
      },
    });
    await should(
      authorize({ targetSessionId: 'root', capability: creatorCapability!, action: 'mark_done' }),
    ).be.rejectedWith(TaskBoardError);
  });

  it('should refuse a relinquish with no capability or no exact live-or-replay bearer', async () => {
    // Arrange
    const world = await withBoard();

    // Act
    const missing = await post(world, '/membership/relinquish', {});
    const unknown = await post(world, '/membership/relinquish', {}, peer('not-a-board-capability'));

    // Assert
    should(missing.status).equal(401);
    should(unknown.status).equal(403);
    should(jsonBody(unknown).error).equal('the presented board capability names no live membership or exact replay');
  });

  it('should report a document it refuses to read as unavailable rather than as no membership', async () => {
    // Arrange
    const world = await withBoard();
    const capability = world.capabilityFor('root') ?? '';
    const broken = new FakeTaskBoards(FLEET);
    broken.repository.snapshot = async () => {
      const { TaskBoardError } = await import('../../../../src/lib/task-boards/error.ts');
      throw new TaskBoardError('unavailable', 'refusing to serve an unreadable task-board document');
    };

    // Act
    const response = await get(broken, '/membership', peer(capability));

    // Assert
    should(response.status).equal(503);
  });

  it('should surface a delivery failure rather than reporting a membership nobody can use', async () => {
    // Arrange
    const world = new FakeTaskBoards(FLEET);
    world.deliveryFailure = new Error('the session directory is not writable');

    // Act
    const response = await post(
      world,
      '/create',
      { creatorSessionId: 'root', coordinatorSessionId: 'coordinator' },
      operator(world),
    );

    // Assert — the board exists, and the caller is told the secret did not arrive.
    should(response.status).equal(500);
    should(world.state.boards).have.length(1);
  });

  it('should refuse every route to a caller with no bearer token', async () => {
    // Arrange
    const world = await withBoard();

    // Act
    const response = await dispatcher(world).dispatch(
      request({ path: `${PREFIX}/membership`, headers: peer(world.capabilityFor('root') ?? '') }),
    );

    // Assert — the capability identifies a session; the bearer is what protects the surface it
    // travels on, and neither substitutes for the other.
    should(response.status).equal(401);
  });
});

describe('the task board membership mount, at its edges', () => {
  it('should refuse a session credential that names no live session', async () => {
    // Arrange — a well-formed secret matching NO session in the directory, as opposed to one matching
    // the wrong session. The two refusals are different paths.
    const world = await withBoard();

    // Act
    const response = await post(
      world,
      '/invitations/accept',
      {},
      {
        'x-fy-session-board-capability': 'session:never-started',
        'x-fy-board-invitation-capability': 'whatever',
      },
    );

    // Assert
    should(response.status).equal(403);
  });

  it('should report an expired invitation as a conflict rather than as a membership', async () => {
    // Arrange
    const world = await withBoard();
    const invited = TaskBoardInvitationViewSchema.parse(
      jsonBody(
        await post(
          world,
          '/invitations/request',
          { targetSessionId: 'outsider' },
          peer(world.capabilityFor('root') ?? ''),
        ),
      ),
    );
    await post(
      world,
      '/invitations/approve',
      { invitationRequestId: invited.requestId },
      peer(world.capabilityFor('coordinator') ?? ''),
    );
    const invitationCapability = world.delivered.at(-1)?.[1][BOARD_INVITATION_CAPABILITY_VARIABLE] ?? '';
    // The proof lives 24 hours; the invitee comes back a week later.
    world.instant = '2024-05-08T10:00:00.000Z';

    // Act
    const response = await post(
      world,
      '/invitations/accept',
      {},
      {
        'x-fy-session-board-capability': 'session:outsider',
        'x-fy-board-invitation-capability': invitationCapability,
      },
    );

    // Assert — the CLI parses this route into a membership, so an expiry travels as a refusal carrying
    // the board's own answer rather than as a shape the client cannot read.
    should(response.status).equal(409);
    should(jsonBody(response).error).match(/the invitation was not accepted: it is expired/u);
  });

  it('should let the operator move the coordinator key, and deliver it only to the new coordinator', async () => {
    // Arrange
    const world = await withBoard();
    const before = world.capabilityFor('coordinator');

    // Act — `root` names the board; `grandchild` is an unbound descendant of the same live root.
    const response = await post(
      world,
      '/coordinator/replace',
      {
        requestId: 'replace-grandchild',
        sessionId: 'root',
        replacementSessionId: 'grandchild',
        replacementRootSessionId: 'root',
      },
      operator(world),
    );

    // Assert
    should(response.status).equal(200);
    const body = TaskBoardMembershipSchema.parse(jsonBody(response));
    should(body).match({ sessionId: 'grandchild', role: 'coordinator' });
    // The secret went to the new coordinator's environment and to nobody else's, and the response
    // carries no capability at all.
    should(world.delivered.at(-1)?.[0]).equal('grandchild');
    should(JSON.stringify(body)).not.containEql(world.delivered.at(-1)?.[1][BOARD_CAPABILITY_VARIABLE]);
    should(JSON.stringify(body)).not.match(/[0-9a-f]{32}/u);
    // The old key is fenced: the previous coordinator can no longer approve anything.
    const refused = await post(world, '/child-grants/approve', { grantRequestId: 'anything' }, peer(before ?? ''));
    should(refused.status).equal(403);
  });

  it('should refuse a coordinator replacement that presents no operator capability', async () => {
    // Arrange
    const world = await withBoard();

    // Act — a member's own board capability is not the operator's, whatever its role.
    const missing = await post(world, '/coordinator/replace', {
      requestId: 'replace-grandchild',
      sessionId: 'root',
      replacementSessionId: 'grandchild',
      replacementRootSessionId: 'root',
    });
    const member = await post(
      world,
      '/coordinator/replace',
      {
        requestId: 'replace-grandchild',
        sessionId: 'root',
        replacementSessionId: 'grandchild',
        replacementRootSessionId: 'root',
      },
      { 'x-fy-board-admin-capability': world.capabilityFor('root') ?? '' },
    );

    // Assert
    should(missing.status).equal(401);
    should(member.status).equal(403);
  });

  it('should report a coordinator replacement naming an unknown member or replacement as not found', async () => {
    // Arrange
    const world = await withBoard();

    // Act
    const member = await post(
      world,
      '/coordinator/replace',
      {
        requestId: 'replace-grandchild',
        sessionId: 'outsider',
        replacementSessionId: 'grandchild',
        replacementRootSessionId: 'root',
      },
      operator(world),
    );
    const replacement = await post(
      world,
      '/coordinator/replace',
      {
        requestId: 'replace-ghost',
        sessionId: 'root',
        replacementSessionId: 'ghost',
        replacementRootSessionId: 'root',
      },
      operator(world),
    );

    // Assert
    should(member.status).equal(404);
    should(replacement.status).equal(404);
  });

  it('should replay a replacement by delivering byte-identical authenticating capability material', async () => {
    // Arrange
    const world = await withBoard();
    const body = {
      requestId: 'replace-retry',
      sessionId: 'root',
      replacementSessionId: 'grandchild',
      replacementRootSessionId: 'root',
    };

    // Act
    const first = await post(world, '/coordinator/replace', body, operator(world));
    const firstCapability = world.delivered.at(-1)?.[1][BOARD_CAPABILITY_VARIABLE] ?? '';
    const firstAuthentication = await get(world, '/membership', peer(firstCapability));
    const replay = await post(world, '/coordinator/replace', body, operator(world));
    const replayCapability = world.delivered.at(-1)?.[1][BOARD_CAPABILITY_VARIABLE] ?? '';
    const replayAuthentication = await get(world, '/membership', peer(replayCapability));

    // Assert — replay is also the recovery path, so delivery happens twice with the SAME working key.
    should(first.status).equal(200);
    should(replay.status).equal(200);
    should(replayCapability).equal(firstCapability);
    should(firstAuthentication.status).equal(200);
    should(replayAuthentication.status).equal(200);
    should(JSON.stringify(jsonBody(replay))).not.containEql(replayCapability);
  });

  it('should retry delivery successfully after the first delivery throws post-commit', async () => {
    // Arrange
    const world = await withBoard();
    const body = {
      requestId: 'replace-after-delivery-failure',
      sessionId: 'root',
      replacementSessionId: 'grandchild',
      replacementRootSessionId: 'root',
    };
    world.deliveryFailure = new Error('the environment store was temporarily unavailable');

    // Act — the mutation commits before delivery, then the exact operation is retried after recovery.
    const failed = await post(world, '/coordinator/replace', body, operator(world));
    const committedCapability = world.capabilityFor('grandchild');
    const mintCountAfterCommit = world.capabilityMintCount;
    const committedState = world.state;
    world.deliveryFailure = undefined;
    world.state = {
      ...committedState,
      bindings: committedState.bindings.filter(binding => binding.sessionId !== 'grandchild'),
    };
    const missingBinding = await post(world, '/coordinator/replace', body, operator(world));
    world.state = committedState;
    const retry = await post(world, '/coordinator/replace', body, operator(world));
    const deliveredCapability = world.delivered.at(-1)?.[1][BOARD_CAPABILITY_VARIABLE] ?? '';
    const authenticated = await get(world, '/membership', peer(deliveredCapability));

    // Assert
    should(failed.status).equal(500);
    should(committedCapability).not.be.undefined();
    should(missingBinding.status).equal(503);
    should(retry.status).equal(200);
    should(world.capabilityMintCount).equal(mintCountAfterCommit);
    should(deliveredCapability).equal(committedCapability);
    should(authenticated.status).equal(200);
  });

  it('should not disguise a defect as a domain refusal', async () => {
    // Arrange — anything that is not a `TaskBoardError` is a bug in the daemon rather than an answer a
    // client can act on, so it must not be flattened into a 4xx.
    const world = new FakeTaskBoards(FLEET);
    world.repository.snapshot = async () => {
      throw new TypeError('the repository was built wrongly');
    };

    // Act
    const response = await get(world, '/membership', peer('anything'));

    // Assert
    should(response.status).equal(500);
  });
});
