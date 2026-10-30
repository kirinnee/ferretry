import { describe, it } from 'bun:test';
import {
  type BoardAttachment,
  type BoardTask,
  type BoardTaskActionRequestInput,
  BoardTaskActionRequestSchema,
} from '@ferretry/protocol';
import should from 'should';
import {
  type BoardAttachmentSource,
  type BoardCaller,
  BoardError,
  BoardService,
  type ReopenDelivery,
  ReopenDeliveryLadder,
  type ReopenMessenger,
} from '../../../src/lib/board/index.ts';
import { card, MemoryBoardStore, NOW, type ServiceWorld, world } from './support.ts';

/** "Not good" with pictures: the files the owner sends with a move back reach the card's history and its ferret. */

const owner: BoardCaller = { kind: 'owner' };
const ferret = (sessionId: string): BoardCaller => ({ kind: 'ferret', sessionId });

const IMAGE = `att_${'a'.repeat(64)}`;
const SHOT = `att_${'b'.repeat(64)}`;

const action = (input: BoardTaskActionRequestInput) => BoardTaskActionRequestSchema.parse(input);

/** An attachment store holding `held` in each session, recording what it was asked. */
class FakeAttachments implements BoardAttachmentSource {
  readonly asked: Array<readonly [string, readonly string[]]> = [];

  constructor(private readonly held: Readonly<Record<string, readonly BoardAttachment[]>>) {}

  async describe(sessionId: string, ids: readonly string[]): Promise<readonly BoardAttachment[]> {
    this.asked.push([sessionId, ids]);
    const files = this.held[sessionId] ?? [];
    return ids.map(id => {
      const file = files.find(candidate => candidate.id === id);
      if (file === undefined) throw new Error(`no attachment ${id}`);
      return file;
    });
  }
}

const FILES: readonly BoardAttachment[] = [
  { id: IMAGE, filename: 'flicker.png', mime: 'image/png' },
  { id: SHOT, filename: 'after.jpg', mime: 'image/jpeg' },
];

const serviceWith = (cards: readonly BoardTask[], overrides: Partial<ServiceWorld> = {}) => {
  const ports = world({
    store: new MemoryBoardStore(cards),
    attachments: new FakeAttachments({ child: FILES }),
    ...overrides,
  });
  return { ports, service: new BoardService(ports) };
};

async function refusal(work: Promise<unknown>): Promise<BoardError> {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  should(error).be.instanceOf(BoardError);
  return error as BoardError;
}

const notGood = (extra: Partial<{ from: string; ids: readonly string[] }> = {}) =>
  action({
    action: 'move',
    to: 'implement',
    reason: 'the theme button still flickers',
    attachments: { from: extra.from ?? 'child', ids: [...(extra.ids ?? [IMAGE, SHOT])] },
  });

describe("the owner's move back with files", () => {
  it('should name the files in the reopen and hand them to the delivery', async () => {
    // Arrange
    const { ports, service } = serviceWith([card({ laneId: 'tested', assignee: 'child' })]);

    // Act
    const response = await service.act('F1', notGood(), owner);

    // Assert
    should(response.task.laneId).equal('implement');
    should(ports.store.cards.get('F1')?.history.at(-1)).match({
      type: 'reopened',
      reason: 'the theme button still flickers',
      attachments: FILES,
    });
    should(ports.reopen.notices).match([
      { from: 'tested', to: 'implement', attachments: { from: 'child', ids: [IMAGE, SHOT] } },
    ]);
  });

  it('should take files on a reopen request too', async () => {
    // Arrange
    const { ports, service } = serviceWith([card({ laneId: 'tested', assignee: 'child' })], {
      attachments: new FakeAttachments({ lead: FILES }),
    });

    // Act
    await service.act(
      'F1',
      action({
        action: 'reopen',
        to: 'implement',
        reason: 'still broken',
        ask: { text: 'still broken', source: 'owner' },
        attachments: { from: 'lead', ids: [IMAGE] },
      }),
      owner,
    );

    // Assert — the owner ferret's session is the other place a reopen is delivered
    should(ports.store.cards.get('F1')?.history.at(-1)).match({ type: 'reopened', attachments: [FILES[0]] });
  });

  it('should keep a reopen with no files exactly as before', async () => {
    // Arrange
    const { ports, service } = serviceWith([card({ laneId: 'tested', assignee: 'child' })]);

    // Act
    await service.act('F1', action({ action: 'move', to: 'implement', reason: 'no' }), owner);

    // Assert
    should(ports.store.cards.get('F1')?.history.at(-1)).not.have.property('attachments');
    should(ports.reopen.notices[0]).not.have.property('attachments');
  });

  it('should refuse files from anybody but the owner, before reading the store', async () => {
    // Arrange
    const store = new FakeAttachments({ child: FILES });
    const { ports, service } = serviceWith([card({ laneId: 'tested', assignee: 'child' })], { attachments: store });

    // Act
    const error = await refusal(service.act('F1', notGood(), ferret('lead')));

    // Assert
    should(error.code).equal('forbidden');
    should(error.allowed).eql(['owner-human']);
    should(store.asked).eql([]);
    should(ports.store.cards.get('F1')?.laneId).equal('tested');
  });

  it("should refuse files uploaded anywhere but the card's assignee or owner ferret", async () => {
    // Arrange
    const store = new FakeAttachments({ stranger: FILES });
    const { service } = serviceWith([card({ laneId: 'tested', assignee: 'child' })], { attachments: store });

    // Act
    const error = await refusal(service.act('F1', notGood({ from: 'stranger' }), owner));

    // Assert
    should(error.code).equal('invalid');
    should(error.message).containEql('uploaded to its ferret (child)');
    should(store.asked).eql([]);
  });

  it('should refuse a file the session does not hold, and write nothing', async () => {
    // Arrange
    const { ports, service } = serviceWith([card({ laneId: 'tested', assignee: 'child' })]);

    // Act
    const error = await refusal(service.act('F1', notGood({ ids: [`att_${'c'.repeat(64)}`] }), owner));

    // Assert
    should(error.code).equal('invalid');
    should(error.message).containEql("is not in its ferret's session");
    should(ports.store.cards.get('F1')?.laneId).equal('tested');
    should(ports.reopen.notices).eql([]);
  });

  it('should say what failed when the store throws something that is not an error', async () => {
    // Arrange
    const odd: BoardAttachmentSource = {
      describe: async () => {
        throw 'disk gone';
      },
    };
    const { service } = serviceWith([card({ laneId: 'tested', assignee: 'child' })], { attachments: odd });

    // Act
    const error = await refusal(service.act('F1', notGood(), owner));

    // Assert
    should(error.message).containEql('disk gone');
  });

  it('should refuse files on a daemon built without the attachment store', async () => {
    // Arrange
    const ports = world({ store: new MemoryBoardStore([card({ laneId: 'tested', assignee: 'child' })]) });
    const service = new BoardService(ports);

    // Act
    const error = await refusal(service.act('F1', notGood(), owner));

    // Assert
    should(error.message).equal('this daemon cannot carry files with a move back');
  });

  it('should refuse files on a move that sends nothing back', async () => {
    // Arrange
    const { ports, service } = serviceWith([card({ laneId: 'implement', assignee: 'child' })]);

    // Act
    const error = await refusal(
      service.act('F1', action({ action: 'move', to: 'review', attachments: { from: 'child', ids: [IMAGE] } }), owner),
    );

    // Assert
    should(error.code).equal('invalid');
    should(error.message).equal("files ride only the owner's move back; &F1 is not being sent back");
    should(ports.store.cards.get('F1')?.laneId).equal('implement');
  });
});

describe('delivering a reopen with files', () => {
  class Messenger implements ReopenMessenger {
    readonly sent: unknown[] = [];

    constructor(private readonly answers: Readonly<Record<string, ReopenDelivery>>) {}

    async deliver(sessionId: string, message: string, key: string, attachments?: unknown): Promise<ReopenDelivery> {
      this.sent.push([sessionId, message, key, attachments]);
      return this.answers[sessionId] ?? 'absent';
    }
  }

  it('should offer the files to every rung it tries', async () => {
    // Arrange
    const messenger = new Messenger({ lead: 'delivered' });
    const ladder = new ReopenDeliveryLadder(messenger, { warn: () => undefined });
    const files = { from: 'child', ids: [IMAGE] };
    const task = card({
      id: 'F7',
      laneId: 'implement',
      assignee: 'child',
      history: [{ seq: 4, at: NOW, actor: { kind: 'owner' }, type: 'created', laneId: 'todo' }],
    });

    // Act
    const delivered = await ladder.deliver({
      task,
      from: 'tested',
      to: 'implement',
      reason: 'no',
      by: { kind: 'owner' },
      attachments: files,
    });

    // Assert — the assignee was gone, so its lead got the line and the files
    should(delivered).eql({ to: 'lead', how: 'delivered' });
    should(messenger.sent).eql([
      ['child', '&F7 was reopened by the owner: no', 'board-reopen-F7-4', files],
      ['lead', '&F7 was reopened by the owner: no', 'board-reopen-F7-4', files],
    ]);
  });
});
