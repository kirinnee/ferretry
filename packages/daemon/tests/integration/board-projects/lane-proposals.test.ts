/**
 * A FERRET'S LANE CHANGE WAITS FOR THE OWNER (docs/board.md § A ferret's lane change waits for the owner), over the
 * lane route: the lanes and the cards on their REAL file stores, the agenda on its real ledger, the route called
 * through the dispatcher the daemon mounts. It proves the two exploits a live ferret edit allowed are gone — a gate
 * made automatic, and a gate lane removed with its cards sent to Closed — and that the owner's Accept on the agenda
 * card is what makes the change live and moves the cards, as the owner.
 */
import { afterAll, describe, it } from 'bun:test';
import { join } from 'node:path';
import {
  type BoardProject,
  type BoardTask,
  LANE_PROPOSAL_ANSWERS,
  type LaneLayoutValue,
  type LaneSet,
  laneProposalReference,
  laneStage,
} from '@ferretry/protocol';
import should from 'should';
import { FileAgendaLedgerRepository } from '../../../src/adapters/agenda/file-agenda-ledger-repository.ts';
import { AgendaLaneAgenda } from '../../../src/adapters/board-projects/agenda-lane-agenda.ts';
import { FileLaneSetStore } from '../../../src/adapters/board-projects/file-lane-set-store.ts';
import { FileBoardStore } from '../../../src/adapters/board/file-board-store.ts';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { KeyedSerialExecutor } from '../../../src/adapters/system/keyed-serial-executor.ts';
import { AgendaService } from '../../../src/lib/agenda/index.ts';
import { ApiDispatcher, ApiRouter } from '../../../src/lib/api/index.ts';
import { LaneProposalAcceptance, LaneSetService } from '../../../src/lib/board-projects/index.ts';
import { BoardService } from '../../../src/lib/board/index.ts';
import { createFoundationPaths, resolveStateHome } from '../../../src/lib/index.ts';
import { boardProjectRoutes } from '../../../src/lib/runtime/mounts/board-projects.ts';
import { jsonBody, request } from '../../unit/api/support.ts';
import { world as boardPorts, card, NOW, templateLanes } from '../../unit/board/support.ts';
import { project } from '../../unit/board-projects/support.ts';
import {
  agentIn,
  CREDENTIALS,
  grantSubsystem,
  human,
  sessionDirectory,
  sessionView,
} from '../../unit/runtime/mounts/support.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

afterAll(cleanupTempDirectories);

const PROJECT = '11111111-1111-4111-8111-111111111111';
const FERRET = 'ms8-abcd1234';

/** One daemon over the files in a fresh home: Ferretry's lanes stored confirmed, two cards waiting at its gates. */
const daemon = async () => {
  const home = await tempDirectory('lane-proposals-');
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  const cards = new FileBoardStore(join(paths.state, 'board'), new StateFileSystem(paths), new KeyedSerialExecutor(), {
    warn: () => undefined,
  });
  const laneStore = new FileLaneSetStore(join(home, 'lanes'));
  const live: LaneSet = templateLanes(PROJECT);
  await laneStore.transact(PROJECT, () => ({ next: live, result: undefined }));
  let board: BoardService | undefined;
  let lanes: LaneSetService | undefined;
  const agenda = new AgendaService(
    new FileAgendaLedgerRepository(sessionId => join(home, 'sessions', sessionId)),
    { now: () => NOW },
    { has: async sessionId => sessionId === FERRET },
    { raised: async () => undefined },
    {
      changed: async (sessionId, change) =>
        await new LaneProposalAcceptance(lanes as LaneSetService).changed(sessionId, change),
    },
  );
  lanes = new LaneSetService(
    laneStore,
    { projects: async () => [{ ...project(PROJECT, '/work/ferretry'), name: 'Ferretry' }] },
    { projectOf: async () => PROJECT },
    new AgendaLaneAgenda({
      raise: async (...parameters) => await agenda.raise(...parameters),
      resolveSource: async (...parameters) => await agenda.resolveSource(...parameters),
    }),
    { relocate: async (projectId, moves, by, reason) => void (await board?.relocate(projectId, moves, reason, by)) },
  );
  board = new BoardService({ ...boardPorts(), store: cards, lanes });
  for (const each of [
    card({ id: 'F1', projectId: PROJECT, laneId: 'plan', workflow: 'design-first', owner: FERRET }),
    card({ id: 'F2', projectId: PROJECT, laneId: 'released' }),
  ] satisfies BoardTask[]) {
    await cards.write(each.id, async () => ({ task: each, result: undefined }));
  }
  const grants = grantSubsystem();
  await grants.refresh();
  const sessions = sessionDirectory([sessionView(FERRET, { label: 'Koen', teammate: 'koen' })]);
  const switches = {
    read: async () => ({ projectId: PROJECT, on: true, setBy: 'owner' as const, setAt: null }),
    set: async () => ({ projectId: PROJECT, on: true, setBy: 'owner' as const, setAt: null }),
  };
  const dispatcher = new ApiDispatcher(
    new ApiRouter(boardProjectRoutes(lanes, sessions, switches)),
    CREDENTIALS,
    grants,
  );
  return { agenda, board, lanes, live, dispatcher };
};

type Daemon = Awaited<ReturnType<typeof daemon>>;

const post = async (world: Daemon, body: unknown, headers: Readonly<Record<string, string>>) => {
  const response = await world.dispatcher.dispatch(
    request({
      method: 'POST',
      path: `/v1/board/projects/${PROJECT}/lanes`,
      headers,
      loopback: true,
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: (await jsonBody(response)) as Record<string, unknown> };
};

const read = async (world: Daemon): Promise<BoardProject> => {
  const response = await world.dispatcher.dispatch(
    request({ path: `/v1/board/projects/${PROJECT}/lanes`, headers: human, loopback: true }),
  );
  return (await jsonBody(response)) as BoardProject;
};

const laneOf = async (world: Daemon, id: string): Promise<string> => (await world.board.task(id)).task.laneId;

const withoutReleased = (live: LaneSet): LaneLayoutValue => ({
  lanes: live.lanes.filter(lane => lane.id !== 'released'),
  variants: Object.fromEntries(
    Object.entries(live.variants).map(([workflow, ids]) => [workflow, (ids ?? []).filter(id => id !== 'released')]),
  ),
});

const planAutomatic = (live: LaneSet): LaneLayoutValue => ({
  lanes: live.lanes.map(lane =>
    lane.id === 'plan' ? { ...lane, ownerGate: false, stage: { kind: 'auto', triggers: ['work.started'] } } : lane,
  ),
  variants: live.variants,
});

/** The open lane-proposal card on the ferret's agenda for this version. */
const proposalCard = async (world: Daemon, version: number) => {
  const listed = await world.agenda.list(FERRET);
  if (!listed.ok) throw new Error('the agenda did not list');
  const found = listed.value.items.find(item => item.sourceRef === laneProposalReference(PROJECT, version));
  if (found === undefined) throw new Error(`no proposal card for version ${String(version)}`);
  return found;
};

describe('a ferret’s lane edit over the route', () => {
  it('should not let a ferret make a gate automatic: the gate holds and the card still waits (exploit a)', async () => {
    // Arrange
    const world = await daemon();

    // Act
    const edited = await post(
      world,
      { action: 'edit', version: 1, layout: planAutomatic(world.live), relocate: {} },
      agentIn(FERRET),
    );

    // Assert
    should(edited.status).equal(200);
    should(edited.body['agenda']).equal('raised');
    const board = await read(world);
    const plan = board.laneSet?.lanes.find(lane => lane.id === 'plan');
    should(plan === undefined ? undefined : laneStage(plan).kind).equal('gate');
    should(board.laneSet).containDeep({
      version: 1,
      confirmedBy: 'owner',
      pending: { version: 2, proposedBy: 'Koen' },
    });
    const moved = await world.board
      .act('F1', { action: 'move', to: 'implement' }, { kind: 'ferret', sessionId: FERRET })
      .then(
        () => 'moved',
        (error: unknown) => (error as { code?: string }).code,
      );
    should(moved).equal('owner-gate');
    should(await laneOf(world, 'F1')).equal('plan');
  });

  it('should not let a ferret remove a gate lane and close its cards (exploit b)', async () => {
    // Arrange
    const world = await daemon();

    // Act
    const edited = await post(
      world,
      { action: 'edit', version: 1, layout: withoutReleased(world.live), relocate: { released: 'closed' } },
      agentIn(FERRET),
    );

    // Assert
    should(edited.status).equal(200);
    should(await laneOf(world, 'F2')).equal('released');
    const board = await read(world);
    should(board.laneSet?.lanes.some(lane => lane.id === 'released')).be.true();
    should(board.laneSet?.pending?.relocate).deepEqual({ released: 'closed' });
    should((await proposalCard(world, 2)).why).containEql(
      'removes Released · to test, which waits for the owner, and sends its cards into the closed lane, which closes them',
    );
  });

  it('should refuse a ferret’s confirm of its own proposal, and the agenda its own Accept', async () => {
    // Arrange
    const world = await daemon();
    await post(
      world,
      { action: 'edit', version: 1, layout: withoutReleased(world.live), relocate: { released: 'closed' } },
      agentIn(FERRET),
    );

    // Act
    const confirmed = await post(world, { action: 'confirm', version: 2 }, agentIn(FERRET));
    const card = await proposalCard(world, 2);
    const answered = await world.agenda.answer(
      FERRET,
      card.id,
      { kind: 'multiple-choice', choice: LANE_PROPOSAL_ANSWERS.accept },
      { kind: 'agent', sessionId: FERRET, name: 'koen' },
    );

    // Assert
    should(confirmed.status).equal(403);
    should(answered.ok).be.false();
    should(await laneOf(world, 'F2')).equal('released');
    should((await read(world)).laneSet).containDeep({ version: 1, pending: { version: 2 } });
  });

  it('should make the proposal live and move its cards, as the owner, when the owner accepts it on the agenda', async () => {
    // Arrange
    const world = await daemon();
    await post(
      world,
      { action: 'edit', version: 1, layout: withoutReleased(world.live), relocate: { released: 'closed' } },
      agentIn(FERRET),
    );
    const card = await proposalCard(world, 2);

    // Act
    const answered = await world.agenda.answer(
      FERRET,
      card.id,
      { kind: 'multiple-choice', choice: LANE_PROPOSAL_ANSWERS.accept },
      { kind: 'human' },
    );

    // Assert
    should(answered.ok).be.true();
    const board = await read(world);
    should(board.laneSet).containDeep({ version: 2, confirmedBy: 'owner', proposedBy: 'Koen' });
    should(board.laneSet?.pending).be.undefined();
    should(board.laneSet?.lanes.some(lane => lane.id === 'released')).be.false();
    const closed = (await world.board.task('F2')).task;
    should(closed.laneId).equal('closed');
    should(closed.history.at(-1)).match({ type: 'moved', from: 'released', to: 'closed', actor: { kind: 'owner' } });
  });

  it('should close the card of a proposal a newer one replaced, saying so (probe P5)', async () => {
    // Arrange
    const world = await daemon();
    await post(world, { action: 'edit', version: 1, layout: planAutomatic(world.live), relocate: {} }, agentIn(FERRET));
    const first = await proposalCard(world, 2);

    // Act
    await post(
      world,
      { action: 'edit', version: 1, layout: withoutReleased(world.live), relocate: { released: 'closed' } },
      agentIn(FERRET),
    );

    // Assert: only the newer card is open; the first is closed with the reason, and its Accept is gone.
    const listed = await world.agenda.list(FERRET);
    if (!listed.ok) throw new Error('the agenda did not list');
    should(listed.value.items.filter(item => item.sourceRef?.startsWith('lanes:')).map(item => item.sourceRef)).eql([
      laneProposalReference(PROJECT, 3),
    ]);
    const closed = listed.value.resolved.find(item => item.id === first.id);
    should(JSON.stringify(closed)).containEql('A newer proposal replaced this one');
    should(await laneOf(world, 'F2')).equal('released');
  });

  it('should take the owner’s own edit live at once over the route, as before', async () => {
    // Arrange
    const world = await daemon();

    // Act
    const edited = await post(
      world,
      { action: 'edit', version: 1, layout: withoutReleased(world.live), relocate: { released: 'closed' } },
      human,
    );

    // Assert
    should(edited.status).equal(200);
    should(edited.body['agenda']).equal('not-needed');
    should((await read(world)).laneSet).containDeep({ version: 2, confirmedBy: 'owner' });
    should(await laneOf(world, 'F2')).equal('closed');
  });
});
