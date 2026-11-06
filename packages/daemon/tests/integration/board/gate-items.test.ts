/**
 * CARD ASKS, through the agenda route (docs/board.md § Cards show progress): the board and the agenda on
 * their REAL file stores, the route handler called with the context the authorization boundary would have built.
 * It proves what the owner and a ferret can do over the wire — only the owner's answer moves the card, a device
 * only with the board's grant — and that a restart never raises a gate twice.
 */
import { afterAll, describe, it } from 'bun:test';
import { join } from 'node:path';
import {
  agendaState,
  type BoardTask,
  cardAgendaReference,
  cardAskReference,
  DAEMON_FEATURES,
  daemonFeatureList,
  type GrantRefusal,
  openCardAsks,
} from '@ferretry/protocol';
import should from 'should';
import { FileAgendaLedgerRepository } from '../../../src/adapters/agenda/file-agenda-ledger-repository.ts';
import { BoardGateCards } from '../../../src/adapters/board/board-gate-cards.ts';
import { FileBoardStore } from '../../../src/adapters/board/file-board-store.ts';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { KeyedSerialExecutor } from '../../../src/adapters/system/keyed-serial-executor.ts';
import { harnessQuestionRequest } from '../../../src/lib/agenda/harness-prompt.ts';
import { AgendaService } from '../../../src/lib/agenda/index.ts';
import type { AuthenticatedCredential } from '../../../src/lib/api/authentication.ts';
import type { CallerGovernance } from '../../../src/lib/api/capability.ts';
import { ApiError } from '../../../src/lib/api/error.ts';
import type { RouteContext } from '../../../src/lib/api/route.ts';
import { BoardService, GateItems, stageGateLanes } from '../../../src/lib/board/index.ts';
import { createFoundationPaths, resolveStateHome } from '../../../src/lib/index.ts';
import { agendaRoutes } from '../../../src/lib/runtime/index.ts';
import { jsonBody, request } from '../../unit/api/support.ts';
import { world as boardPorts, card, FakeDone, FakeReopen, NOW } from '../../unit/board/support.ts';
import { NO_HELD_REPLIES } from '../../unit/runtime/mounts/support.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

afterAll(cleanupTempDirectories);

/** `lead` started `child`, which started `grandchild`; the card is `child`'s, worked by `grandchild`. */
const LEADS: Readonly<Record<string, string>> = { child: 'lead', grandchild: 'child' };
const SESSIONS = new Set(['lead', 'child', 'grandchild', 'stranger']);

const external = (laneId: string, overrides: Partial<BoardTask> = {}): BoardTask =>
  card({
    laneId,
    owner: 'child',
    assignee: 'grandchild',
    createdBy: { kind: 'ferret', sessionId: 'child' },
    ask: { text: 'make the gates ask me', source: 'owner' },
    howToTest: '1. Open the Inbox',
    history: [{ seq: 1, at: NOW, actor: { kind: 'ferret', sessionId: 'child' }, type: 'created', laneId }],
    ...overrides,
  });

/** One daemon over the files in `home`; a second one over the same files is a restart. */
const daemonOver = (home: string) => {
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  const store = new FileBoardStore(join(paths.state, 'board'), new StateFileSystem(paths), new KeyedSerialExecutor(), {
    warn: () => undefined,
  });
  const ledgers = new FileAgendaLedgerRepository(sessionId => join(home, 'sessions', sessionId));
  const reopen = new FakeReopen();
  const done = new FakeDone();
  let gates: GateItems | undefined;
  const board = new BoardService({
    ...boardPorts({ reopen, done }),
    store,
    gates: { written: async id => await gates?.written(id) },
  });
  const agenda = new AgendaService(
    ledgers,
    { now: () => NOW },
    { has: async sessionId => SESSIONS.has(sessionId) },
    { raised: async () => undefined },
    undefined,
    undefined,
    { leadOf: async sessionId => LEADS[sessionId], addressOf: async sessionId => sessionId },
  );
  gates = new GateItems({
    agenda,
    board: new BoardGateCards(board, { project: async () => ({ name: 'Ferretry' }) }),
    lanes: stageGateLanes,
    homes: { of: async sessionId => sessionId },
    sessions: { all: async () => [...SESSIONS] },
    marker: { ran: async () => true, record: async () => undefined },
    now: () => NOW,
    words: { told: async () => undefined },
    diagnostics: { warn: () => undefined },
  });
  const route = agendaRoutes(agenda, { enrolledDevices: async () => 1 }, NO_HELD_REPLIES, undefined, gates).find(
    each => each.method === 'POST' && each.path === '/v1/sessions/:sessionId/agenda',
  );
  if (route === undefined) throw new Error('no agenda route');
  return { store, agenda, board, gates: gates as GateItems, reopen, done, route };
};

/** Who is calling, as the authorization boundary resolved it. */
interface Caller {
  readonly actor: string;
  readonly credential: AuthenticatedCredential;
  readonly governed: boolean;
  /** What the device's grants say about using the fleet; granted unless named. */
  readonly refusal?: GrantRefusal;
}

const HOST: Caller = {
  actor: 'admin-cli',
  credential: { kind: 'authenticated', tokenClass: 'admin' },
  governed: false,
};
const DEVICE: Caller = {
  actor: 'device:phone',
  credential: { kind: 'authenticated', tokenClass: 'device', deviceId: 'phone' },
  governed: true,
};
const DEVICE_WITHOUT_FLEET: Caller = { ...DEVICE, refusal: 'not-granted' };
const peer = (sessionId: string): Caller => ({
  actor: `peer:${sessionId}`,
  credential: { kind: 'authenticated', tokenClass: 'admin' },
  governed: false,
});

const post = async (
  daemon: ReturnType<typeof daemonOver>,
  caller: Caller,
  body: unknown,
  sessionId = 'grandchild',
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> => {
  const governance: CallerGovernance = {
    governed: caller.governed,
    decide: () => {
      const refusal = caller.refusal ?? 'granted';
      return { allowed: refusal === 'granted', refusal };
    },
  };
  const context: RouteContext = {
    request: request({
      method: 'POST',
      path: `/v1/sessions/${sessionId}/agenda`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params: new Map([['sessionId', sessionId]]),
    actor: caller.actor,
    credential: caller.credential,
    governance,
  };
  try {
    const response = await daemon.route.handle(context);
    return { status: response.status, body: jsonBody(response) as Record<string, unknown> };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { status: error.status, body: { error: error.message, code: error.code } };
  }
};

const choose = (id: string, choice: string, note?: string, cardAsk?: string) => ({
  action: 'resolve',
  id,
  response: { kind: 'multiple-choice', choice },
  ...(note === undefined ? {} : { note }),
  ...(cardAsk === undefined ? {} : { cardAsk }),
});

const openItems = async (daemon: ReturnType<typeof daemonOver>, sessionId = 'grandchild') => {
  const listed = await daemon.agenda.list(sessionId);
  if (!listed.ok) throw new Error(listed.error.message);
  return listed.value;
};

const laneOf = async (daemon: ReturnType<typeof daemonOver>, id = 'F1') => (await daemon.board.task(id)).task.laneId;

/** A card at its gate, and the card agenda the daemon opened for it on its ferret's behalf. */
const atGate = async (laneId = 'tested', overrides: Partial<BoardTask> = {}) => {
  const home = await tempDirectory('gate-items');
  const daemon = daemonOver(home);
  await daemon.store.write('F1', async () => ({ task: external(laneId, overrides), result: undefined }));
  await daemon.gates.backfill();
  const [item] = (await openItems(daemon)).items;
  const ask = item === undefined ? undefined : openCardAsks(item)[0];
  if (item === undefined || ask === undefined) throw new Error('expected a card agenda with an open card ask');
  return { home, daemon, item, reference: cardAskReference(ask) };
};

/** The one open agenda of the card's ferret, as it is now. */
const theAgenda = async (daemon: ReturnType<typeof daemonOver>, id: string) => {
  const found = (await openItems(daemon)).items.find(each => each.id === id);
  if (found === undefined) throw new Error(`expected !${id} to be open`);
  return found;
};

describe('answering a card ask over the agenda route', () => {
  it('opens one card agenda that asks, mirrored as gateAttached for an older app', async () => {
    // Arrange + Act
    const { daemon, item } = await atGate();

    // Assert
    should((await openItems(daemon)).items).have.length(1);
    should(item.sourceRef).equal(cardAgendaReference('F1'));
    should(item.gate).be.undefined();
    should(item.cardAsks?.[0]).match({
      gate: { cardId: 'F1', laneId: 'tested' },
      howToTest: 'There is no preview for this one. Try it for real: the steps below say where.\n\n1. Open the Inbox',
    });
    should(item.gateAttached).match({ cardId: 'F1', laneId: 'tested' });
  });

  it('moves the card when the owner at the machine answers Done, then RESTS the agenda for its ferret', async () => {
    // Arrange
    const { daemon, item, reference } = await atGate();

    // Act
    const answer = await post(daemon, HOST, choose(item.id, 'Done', undefined, reference));

    // Assert
    should(answer.status).equal(200);
    should(await laneOf(daemon)).equal('closed');
    const after = (await daemon.board.task('F1')).task.history.at(-1);
    should(after).match({
      type: 'moved',
      to: 'closed',
      reason: 'Done (from the Inbox)',
      actor: { kind: 'owner' },
      actorVia: 'admin-token',
    });
    const agenda = await theAgenda(daemon, item.id);
    should(agenda.cardAsks?.[0]?.answer?.receipt).match(/^[0-9a-f]{64}$/u);
    should(openCardAsks(agenda)).be.empty();
    should(agenda.gateAttached).be.undefined();
    should(daemon.done.notices).have.length(1);
  });

  it('moves the card for a paired device the fleet grant lets use the board', async () => {
    // Arrange
    const { daemon, item, reference } = await atGate();

    // Act
    const answer = await post(daemon, DEVICE, choose(item.id, 'Done', undefined, reference));

    // Assert
    should(answer.status).equal(200);
    should(await laneOf(daemon)).equal('closed');
    should((await daemon.board.task('F1')).task.history.at(-1)?.actorVia).be.undefined();
  });

  it('refuses a paired device without the fleet grant, and moves nothing', async () => {
    // Arrange
    const { daemon, item, reference } = await atGate();

    // Act
    const answer = await post(daemon, DEVICE_WITHOUT_FLEET, choose(item.id, 'Done', undefined, reference));

    // Assert
    should(answer.status).equal(403);
    should(await laneOf(daemon)).equal('tested');
    should(openCardAsks(await theAgenda(daemon, item.id))).have.length(1);
  });

  it('refuses the card’s ferret, its lead and a stranger, on every verb that would pass the ask', async () => {
    // Arrange
    const { daemon, item, reference } = await atGate();
    const callers = [peer('grandchild'), peer('child'), peer('lead'), peer('stranger')];

    // Act
    const answers = [];
    for (const caller of callers) {
      answers.push(await post(daemon, caller, choose(item.id, 'Done', undefined, reference)));
      answers.push(await post(daemon, caller, choose(item.id, 'Done')));
      answers.push(await post(daemon, caller, { action: 'resolve', id: item.id, note: 'tested it' }));
      answers.push(await post(daemon, caller, { action: 'dismiss', id: item.id }));
    }

    // Assert
    for (const answer of answers) should(answer.status >= 400 && answer.status < 500).be.true();
    should(await laneOf(daemon)).equal('tested');
    should(openCardAsks(await theAgenda(daemon, item.id))).have.length(1);
  });

  it('refuses a ferret’s raise that carries a gate or a card ask', async () => {
    // Arrange
    const { daemon, item } = await atGate();
    const add = {
      action: 'add',
      title: 'Try it',
      subject: 'Try it: open the Board',
      why: 'It shipped.',
      howToResolve: 'Choose.',
      premise: 'It shipped.',
      context: 'On the Mac.',
      kind: 'choice',
      ask: { kind: 'multiple-choice', options: [{ label: 'Not good' }, { label: 'Done' }] },
    };

    // Act
    const withGate = await post(daemon, peer('child'), { ...add, gate: item.cardAsks?.[0]?.gate }, 'child');
    const withAsks = await post(daemon, peer('child'), { ...add, cardAsks: item.cardAsks }, 'child');

    // Assert
    should(withGate.status).equal(400);
    should(withAsks.status).equal(400);
    should((await openItems(daemon, 'child')).items).be.empty();
  });

  it('Not good with the owner’s words reopens the card once, and opens no second item', async () => {
    // Arrange
    const { daemon, item, reference } = await atGate();

    // Act
    const answer = await post(daemon, HOST, choose(item.id, 'Not good', 'the badge counts twice', reference));
    const again = await post(daemon, HOST, choose(item.id, 'Not good', 'the badge counts twice', reference));

    // Assert
    should(answer.status).equal(200);
    should(again.status).equal(200);
    should(await laneOf(daemon)).equal('implement');
    should(daemon.reopen.notices).have.length(1);
    should((await openItems(daemon)).items.map(each => each.id)).eql([item.id]);
  });

  it('Not good without words is refused, and the ask stays open', async () => {
    // Arrange
    const { daemon, item, reference } = await atGate();

    // Act
    const answer = await post(daemon, HOST, choose(item.id, 'Not good', undefined, reference));

    // Assert
    should(answer.status).equal(400);
    should(await laneOf(daemon)).equal('tested');
    should(openCardAsks(await theAgenda(daemon, item.id))).have.length(1);
  });

  it('lets the owner say Not needed: the card stays and the gate never asks again for that entry', async () => {
    // Arrange
    const { home, daemon, item } = await atGate();

    // Act
    const answer = await post(daemon, HOST, { action: 'dismiss', id: item.id });
    const restarted = daemonOver(home);
    const raised = await restarted.gates.backfill();

    // Assert
    should(answer.status).equal(200);
    should(raised).equal(0);
    should(await laneOf(restarted)).equal('tested');
    should((await openItems(restarted)).items).be.empty();
  });
});

describe('card asks across writes and restarts', () => {
  it('opens nothing new for the same entry after a restart', async () => {
    // Arrange
    const { home, daemon } = await atGate();

    // Act
    const restarted = daemonOver(home);
    const raised = await restarted.gates.backfill();

    // Assert
    should(raised).equal(0);
    should((await openItems(restarted)).items).have.length(1);
    should((await openItems(daemon)).items).have.length(1);
  });

  it('withdraws the open ask when the card leaves the gate on the board, and closes the card agenda nobody talked on', async () => {
    // Arrange
    const { daemon, item } = await atGate();

    // Act — the owner drags it back on the Board
    await daemon.board.act('F1', { action: 'move', to: 'implement', reason: 'one more fix' }, { kind: 'owner' });

    // Assert — nothing is left to answer, so nothing is left in Needs you
    const listed = await openItems(daemon);
    should(listed.items.map(each => each.id)).not.containEql(item.id);
    should(listed.resolved.map(each => each.id)).containEql(item.id);
  });

  it('withdraws the open ask and rests the card agenda, keeping it, when the owner talked on it', async () => {
    // Arrange — the owner said something on the card's agenda
    const { daemon, item } = await atGate();
    const talked = await daemon.agenda.answer(
      'grandchild',
      item.id,
      { kind: 'open-question', answer: 'looks odd' },
      { kind: 'human' },
    );
    if (!talked.ok) throw new Error(talked.error.message);

    // Act
    await daemon.board.act('F1', { action: 'move', to: 'implement', reason: 'one more fix' }, { kind: 'owner' });

    // Assert — it stays, with no ask, resting on its ferret
    const after = await theAgenda(daemon, item.id);
    should(after.cardAsks).be.undefined();
    should(after.gateAttached).be.undefined();
    should(agendaState(after).state).equal('resting');
  });

  it('stays silent for an internal card, and its lead passes the gate itself', async () => {
    // Arrange
    const home = await tempDirectory('gate-items');
    const daemon = daemonOver(home);
    await daemon.store.write('F1', async () => ({
      task: external('tested', { ask: { text: 'tidy the logs', source: 'session:child' } }),
      result: undefined,
    }));

    // Act
    const raised = await daemon.gates.backfill();
    await daemon.board.act('F1', { action: 'move', to: 'closed' }, { kind: 'ferret', sessionId: 'lead' });

    // Assert
    should(raised).equal(0);
    should((await openItems(daemon)).items).be.empty();
    should((await openItems(daemon, 'child')).items).be.empty();
    should(await laneOf(daemon)).equal('closed');
  });

  it('advertises gate items and card asks on health', () => {
    should(daemonFeatureList()).containEql(DAEMON_FEATURES.boardGateItems);
    should(daemonFeatureList()).containEql(DAEMON_FEATURES.agendaCardAsks);
  });
});

describe('the board as the gate items read it', () => {
  it('reads a card that is not there as none, and lets any other failure through', async () => {
    // Arrange
    const home = await tempDirectory('gate-items');
    const daemon = daemonOver(home);
    const unavailable = new BoardGateCards(
      {
        task: async () => {
          throw new Error('the board store is unreadable');
        },
        sweepBoard: async () => await daemon.board.sweepBoard(),
        act: async (id, request, caller) => await daemon.board.act(id, request, caller),
        audienceOf: async card => await daemon.board.audienceOf(card),
        closeWhereNothingToTry: async (id, expect, reason) =>
          await daemon.board.closeWhereNothingToTry(id, expect, reason),
      },
      { project: async () => undefined },
    );

    // Act
    const missing = await new BoardGateCards(daemon.board, { project: async () => undefined }).card('F404');
    const failed = await unavailable.card('F1').then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should(missing).be.undefined();
    should(failed).be.instanceOf(Error);
    should((failed as Error).message).equal('the board store is unreadable');
  });
});

/**
 * A FORGED QUESTION IS NO GATE ITEM (docs/agenda.md § Reserved sourceRefs): nakita's probe of PR F's review, kept. The
 * harness refuses such a question at the door; these prove that even one raised anyway moves no card and suppresses
 * no real item, because a gate item is the gate producer's own (source `task`, carrying its `gate`).
 */
describe('a question that names a gate', () => {
  /** What a forged question file would turn into: a daemon `question` item under a reference the ferret chose. */
  const forge = async (daemon: ReturnType<typeof daemonOver>, sourceRef: string, sessionId = 'grandchild') => {
    const request = harnessQuestionRequest({
      toolUseId: sourceRef,
      questions: [
        {
          question: 'Is the release OK?',
          header: 'Release',
          options: [{ label: 'Done' }, { label: 'Not good' }],
          multiSelect: false,
        },
      ],
    } as never);
    const raised = await daemon.agenda.raise(sessionId, request, { kind: 'daemon', cause: 'harness-prompt' });
    if (!raised.ok || raised.item === undefined) throw new Error('the forged question was not raised');
    return raised.item;
  };

  it('moves no card when the owner answers Done on it, and leaves the real card ask open', async () => {
    // Arrange
    const { daemon, item, reference } = await atGate();
    const forged = await forge(daemon, reference);

    // Act
    await post(daemon, HOST, choose(forged.id, 'Done'));

    // Assert
    should(forged.gate).be.undefined();
    should(forged.cardAsks).be.undefined();
    should(await laneOf(daemon)).equal('tested');
    should(openCardAsks(await theAgenda(daemon, item.id))).have.length(1);
  });

  it('raised and closed before the card arrives, does not stop the real card ask', async () => {
    // Arrange — the reference the card will get, learned from a throwaway daemon
    const { reference } = await atGate();
    const daemon = daemonOver(await tempDirectory('gate-forge'));
    const forged = await forge(daemon, reference);
    await post(daemon, HOST, choose(forged.id, 'Done'));

    // Act
    await daemon.store.write('F1', async () => ({ task: external('tested'), result: undefined }));
    await daemon.gates.backfill();

    // Assert
    const open = (await openItems(daemon)).items;
    should(open.some(each => openCardAsks(each).some(ask => cardAskReference(ask) === reference))).be.true();
  });
});
