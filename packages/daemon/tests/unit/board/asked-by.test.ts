import { describe, it } from 'bun:test';
import {
  type BoardActor,
  type BoardTask,
  type BoardTaskCreateRequestInput,
  BoardTaskCreateRequestSchema,
} from '@ferretry/protocol';
import should from 'should';
import {
  type BoardCaller,
  BoardService,
  decideAskedBy,
  MIN_OWNER_MATCH,
  type OwnerWords,
  ownerWordsMatch,
} from '../../../src/lib/board/index.ts';
import { card, MemoryBoardStore, PROJECT, type ServiceWorld, world } from './support.ts';

const OWNER_ASK = 'Make the inbox show only cards a person asked for, with the project name next to the machine';

describe('ownerWordsMatch', () => {
  it('should match an ask the owner said, ignoring case and whitespace', () => {
    should(ownerWordsMatch(OWNER_ASK, [`  ${OWNER_ASK.toUpperCase().replace(/ /gu, '\n ')}  `])).be.true();
  });

  it("should match an ask inside the owner's longer message", () => {
    should(ownerWordsMatch(OWNER_ASK, [`hey, quick one. ${OWNER_ASK}. thanks!`])).be.true();
  });

  it('should match a message inside a longer ask (the first turn wraps the words)', () => {
    should(ownerWordsMatch(`# Assigned task\n\n${OWNER_ASK}\n\n---\nyou are a sub-ferret`, [OWNER_ASK])).be.true();
  });

  it('should not match a paraphrase', () => {
    should(ownerWordsMatch(OWNER_ASK, ['inbox should only list person-made cards and show their board'])).be.false();
  });

  it('should not match on words shorter than the minimum, on either side', () => {
    const short = 'x'.repeat(MIN_OWNER_MATCH - 1);
    should(ownerWordsMatch(short, [`before ${short} after`])).be.false();
    should(ownerWordsMatch(`before ${short} after`, [short])).be.false();
    should(ownerWordsMatch('x'.repeat(MIN_OWNER_MATCH), [`a ${'x'.repeat(MIN_OWNER_MATCH)} b`])).be.true();
  });

  it('should not match when the owner said nothing', () => {
    should(ownerWordsMatch(OWNER_ASK, [])).be.false();
    should(ownerWordsMatch('', [''])).be.false();
  });
});

const ferretActor = (sessionId: string): BoardActor => ({ kind: 'ferret', sessionId });
const ferretMade = (source: string, text = OWNER_ASK) =>
  ({ createdBy: ferretActor('lead'), ask: { text, source } }) as const;

describe('decideAskedBy', () => {
  const said = (words: readonly string[]) => async () => words;

  it('should say person for the owner app and for an owner-naming source without reading any words', async () => {
    const never = async (): Promise<readonly string[]> => {
      throw new Error('should not be read');
    };
    should(await decideAskedBy(ferretMade('session:lead'), true, never)).equal('person');
    should(await decideAskedBy(ferretMade('owner via lead jaeda'), false, never)).equal('person');
  });

  it('should say person when the ask matches what the owner said the session it came from', async () => {
    let asked = '';
    const outcome = await decideAskedBy(ferretMade('session:mvuc7tsf-0c3d50df, turn 2'), false, async id => {
      asked = id;
      return [OWNER_ASK];
    });
    should(outcome).equal('person');
    should(asked).equal('mvuc7tsf-0c3d50df');
  });

  it("should read the recording ferret's own session when the source names none", async () => {
    let asked = '';
    await decideAskedBy(ferretMade('lead message turn-003'), false, async id => {
      asked = id;
      return [];
    });
    should(asked).equal('lead');
  });

  it('should say agent when nothing matches, or the card has no session to look in', async () => {
    should(
      await decideAskedBy(ferretMade('session:lead'), false, said(['something else entirely, said long ago'])),
    ).equal('agent');
    should(
      await decideAskedBy(
        { createdBy: { kind: 'daemon' }, ask: { text: OWNER_ASK, source: 'board import' } },
        false,
        said([OWNER_ASK]),
      ),
    ).equal('agent');
  });
});

const owner: BoardCaller = { kind: 'owner' };
const adminOwner: BoardCaller = { kind: 'owner', via: 'admin-token' };
const lead: BoardCaller = { kind: 'ferret', sessionId: 'lead' };

const create = (input: Partial<BoardTaskCreateRequestInput> = {}) =>
  BoardTaskCreateRequestSchema.parse({
    kind: 'feature',
    title: 'Board store',
    ask: { text: OWNER_ASK, source: 'session:lead' },
    ...input,
  });

class FakeOwnerWords implements OwnerWords {
  readonly asked: string[] = [];
  constructor(private readonly bySession: Record<string, readonly string[] | Error>) {}
  async said(sessionId: string): Promise<readonly string[]> {
    this.asked.push(sessionId);
    const words = this.bySession[sessionId] ?? [];
    if (words instanceof Error) throw words;
    return words;
  }
}

const serviceWith = (cards: readonly BoardTask[], ownerWords?: OwnerWords, overrides: Partial<ServiceWorld> = {}) => {
  const ports = world({
    store: new MemoryBoardStore(cards),
    ...(ownerWords === undefined ? {} : { ownerWords }),
    ...overrides,
  });
  return { ports, service: new BoardService(ports) };
};

const stored = (ports: ServiceWorld, id: string): BoardTask => ports.store.cards.get(id) as BoardTask;

describe('creating a card decides who asked, once', () => {
  it("should store person when the ask is words the owner said the ferret's session", async () => {
    const { ports, service } = serviceWith([], new FakeOwnerWords({ lead: [OWNER_ASK] }));
    const { task } = await service.create(create(), lead);
    should(task.askedBy).equal('person');
    should(stored(ports, task.id).askedBy).equal('person');
  });

  it('should store agent when the ferret made the ask up', async () => {
    const { ports, service } = serviceWith(
      [],
      new FakeOwnerWords({ lead: ['unrelated owner words that are long enough'] }),
    );
    const { task } = await service.create(create(), lead);
    should(stored(ports, task.id).askedBy).equal('agent');
  });

  it('should store agent when the service has no owner words at all', async () => {
    const { ports, service } = serviceWith([]);
    const { task } = await service.create(create(), lead);
    should(stored(ports, task.id).askedBy).equal('agent');
  });

  it("should store person for the owner's own app without reading words", async () => {
    const words = new FakeOwnerWords({});
    const { ports, service } = serviceWith([], words);
    const { task } = await service.create(
      create({ ask: { text: 'a card from the app', source: 'board' }, assignee: 'lead', projectId: PROJECT }),
      owner,
    );
    should(stored(ports, task.id).askedBy).equal('person');
    should(words.asked).eql([]);
  });

  it('should not trust an owner-kind caller on the admin token: a ferret can hold it', async () => {
    const { ports, service } = serviceWith([], new FakeOwnerWords({}));
    const { task } = await service.create(
      create({ ask: { text: OWNER_ASK, source: 'session:lead' }, assignee: 'lead', projectId: PROJECT }),
      adminOwner,
    );
    should(stored(ports, task.id).askedBy).equal('agent');
  });

  it('should store person when the source names the owner', async () => {
    const { ports, service } = serviceWith([]);
    const { task } = await service.create(create({ ask: { text: 'do it', source: 'owner via lead jaeda' } }), lead);
    should(stored(ports, task.id).askedBy).equal('person');
  });

  it('should still make the card, as the agent’s, when the owner words cannot be read', async () => {
    const { ports, service } = serviceWith([], new FakeOwnerWords({ lead: new Error('queue torn') }));
    const { task } = await service.create(create(), lead);
    should(stored(ports, task.id).askedBy).equal('agent');
    should(ports.warnings.join('\n')).match(/queue torn/u);
  });
});

describe('a view reads who asked from the card', () => {
  it('should prefer the stored answer over the ask source, and fall back to the source for an old card', async () => {
    const asked = { text: 'x', source: 'owner (board)' };
    const { service } = serviceWith([
      card({ id: 'F1', ask: asked, askedBy: 'agent' }),
      card({ id: 'F2', ask: { text: 'x', source: 'session:lead' }, askedBy: 'person' }),
      card({ id: 'F3', ask: asked }),
      card({ id: 'F4', ask: { text: 'x', source: 'session:lead' } }),
    ]);
    should((await service.task('F1')).task.askedBy).equal('agent');
    should((await service.task('F2')).task.askedBy).equal('person');
    should((await service.task('F3')).task.askedBy).equal('person');
    should((await service.task('F4')).task.askedBy).equal('agent');
  });
});

describe('backfilling who asked', () => {
  const old = (id: string, source: string, text = OWNER_ASK, createdBy: BoardActor = ferretActor('lead')) =>
    card({ id, createdBy, ask: { text, source } });

  it('should store the answer on each card that lacks one, and leave the rest alone', async () => {
    const decided = card({ id: 'F9', askedBy: 'agent', ask: { text: OWNER_ASK, source: 'owner (board)' } });
    const { ports, service } = serviceWith(
      [
        old('F1', 'session:lead'),
        old('F2', 'session:lead', 'a ferret idea that the owner never voiced out loud'),
        old('F3', 'owner (board)', 'filed by the owner', { kind: 'owner' }),
        old('F4', 'session:lead', OWNER_ASK, { kind: 'owner' }),
        decided,
      ],
      new FakeOwnerWords({ lead: [OWNER_ASK] }),
    );

    should(await service.backfillAskedBy()).equal(4);

    should(['F1', 'F2', 'F3', 'F4', 'F9'].map(id => stored(ports, id).askedBy)).eql([
      'person',
      'agent',
      'person',
      'agent',
      'agent',
    ]);
  });

  it('should write no history and change nothing else about the card', async () => {
    const before = old('F1', 'session:lead');
    const { ports, service } = serviceWith([before], new FakeOwnerWords({ lead: [OWNER_ASK] }));
    await service.backfillAskedBy();
    should(stored(ports, 'F1')).eql({ ...before, askedBy: 'person' });
  });

  it('should be idempotent: a second run stores nothing', async () => {
    const { ports, service } = serviceWith([old('F1', 'session:lead')], new FakeOwnerWords({ lead: [OWNER_ASK] }));
    should(await service.backfillAskedBy()).equal(1);
    const writes = (ports.store as MemoryBoardStore).writes.length;
    should(await service.backfillAskedBy()).equal(0);
    should((ports.store as MemoryBoardStore).writes.length).equal(writes);
  });

  it('should leave a card it cannot settle for the next boot and carry on with the others', async () => {
    const broken = old('F1', 'session:flaky');
    const { ports, service } = serviceWith(
      [broken, old('F2', 'session:lead')],
      new FakeOwnerWords({ flaky: new Error('queue torn'), lead: [OWNER_ASK] }),
    );

    should(await service.backfillAskedBy()).equal(1);

    should(stored(ports, 'F1').askedBy).be.undefined();
    should(stored(ports, 'F2').askedBy).equal('person');
    should(ports.warnings.join('\n')).match(/F1.*queue torn/u);
  });

  it('should leave a card whose write the store refuses, and carry on', async () => {
    const memory = new MemoryBoardStore([old('F1', 'session:lead'), old('F2', 'session:lead')]);
    const write = memory.write.bind(memory);
    memory.write = async (id, decide) => {
      if (id === 'F1') throw new Error('quarantined');
      return await write(id, decide);
    };
    const { ports, service } = serviceWith([], new FakeOwnerWords({ lead: [OWNER_ASK] }), { store: memory });

    should(await service.backfillAskedBy()).equal(1);

    should(stored(ports, 'F2').askedBy).equal('person');
    should(ports.warnings.join('\n')).match(/F1.*quarantined/u);
  });
});
