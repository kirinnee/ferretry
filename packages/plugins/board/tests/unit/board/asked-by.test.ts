import { describe, it } from 'bun:test';
import { type CardActor, type Card, type CardCreateRequestInput, CardCreateRequestSchema } from '../../../contract/index.ts';
import should from 'should';
import {
  type BoardCaller,
  BoardService,
  decideAskedBy,
  MIN_OWNER_MATCH,
  type OwnerWords,
  ownerWordsMatch,
  wordsFerretOf,
} from '../../../daemon/lib/board/index.ts';
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
    should(ownerWordsMatch(`# Assigned task\n\n${OWNER_ASK}\n\n---\nyou are a helper`, [OWNER_ASK])).be.true();
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

  it('should match an ask whose lines a ferret joined with punctuation (&B123)', () => {
    const said = 'problem -- inbox has TOO much cards\n\ntask cards -- only those that are NON agent created';
    should(ownerWordsMatch('problem -- inbox has TOO much cards. task cards -- only those', [said])).be.true();
  });

  it("should match an ask where a ferret mended the owner's split words", () => {
    const said = "what's happening, why do agents keep dying? can yo uhelp me check and debug?";
    should(ownerWordsMatch('why do agents keep dying? can you help me check and debug?', [said])).be.true();
  });

  it("should match an excerpt: the pieces between '...' each the owner's words", () => {
    const said =
      "I woke up to a broken ferretry! I can't even scroll. did you pull and run HMS? the top bar is mangled! jump to latest don't work too";
    should(
      ownerWordsMatch("I woke up to a broken ferretry! I can't even scroll ... the top bar is mangled!", [said]),
    ).be.true();
    should(ownerWordsMatch("I woke up to a broken ferretry! I can't even scroll … jump to latest", [said])).be.true();
  });

  it("should match pieces of two of the owner's messages joined by '...' or ' / '", () => {
    const first = 'can you make sure that auto ferrets CANNOT create agenda? i think task movement is the lead job';
    const answer = '[answer to !A77] Approve as described';
    should(
      ownerWordsMatch(
        'can you make sure that auto ferrets CANNOT create agenda? ... [answer to !A77] Approve as described',
        [first, answer],
      ),
    ).be.true();
    should(
      ownerWordsMatch('can you make sure that auto ferrets CANNOT create agenda / Approve as described', [
        first,
        answer,
      ]),
    ).be.true();
  });

  it('should not match an excerpt with a piece the owner never said, or with no piece long enough', () => {
    const said = "I woke up to a broken ferretry! I can't even scroll. the top bar is mangled!";
    should(ownerWordsMatch("I woke up to a broken ferretry! ... and the lead's own idea here", [said])).be.false();
    should(ownerWordsMatch('I woke up ... the top bar', [said])).be.false();
  });
});

describe('wordsFerretOf', () => {
  const of = (source: string, createdBy: CardActor = { kind: 'owner' }) =>
    wordsFerretOf({ createdBy, ask: { text: OWNER_ASK, source } });

  it('should read the session an ask source names, in any of the ways it is written', () => {
    should(of('session:mvgt2oz9-04e28935')).equal('mvgt2oz9-04e28935');
    should(of('session mvgt2oz9-04e28935')).equal('mvgt2oz9-04e28935');
    should(of('/home/kirin/.ferretry/state/sessions/mvgt2oz9-04e28935/turns/turn-001.md')).equal('mvgt2oz9-04e28935');
    should(of('lead ferret lizzette (mvgt2oz9-04e28935)')).equal('mvgt2oz9-04e28935');
  });

  it("should fall back to the recording ferret's own session, and to none for anyone else", () => {
    should(of('a brief', { kind: 'ferret', ferret: 'lead' })).equal('lead');
    should(of('board import', { kind: 'daemon' })).be.undefined();
    should(of('a brief')).be.undefined();
  });
});

const ferretActor = (ferret: string): CardActor => ({ kind: 'ferret', ferret });
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

  it('should read the words of the session the source names whoever wrote the card down', async () => {
    const asked: string[] = [];
    const words = async (id: string) => {
      asked.push(id);
      return [OWNER_ASK];
    };
    const source = 'session:mvgt2oz9-04e28935';
    should(await decideAskedBy({ createdBy: { kind: 'owner' }, ask: { text: OWNER_ASK, source } }, false, words)).equal(
      'person',
    );
    should(
      await decideAskedBy({ createdBy: { kind: 'daemon' }, ask: { text: OWNER_ASK, source } }, false, words),
    ).equal('person');
    should(asked).eql(['mvgt2oz9-04e28935', 'mvgt2oz9-04e28935']);
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
const lead: BoardCaller = { kind: 'ferret', ferret: 'lead' };

const create = (input: Partial<CardCreateRequestInput> = {}) =>
  CardCreateRequestSchema.parse({
    kind: 'feature',
    title: 'Board store',
    ask: { text: OWNER_ASK, source: 'session:lead' },
    ...input,
  });

class FakeOwnerWords implements OwnerWords {
  readonly asked: string[] = [];
  constructor(private readonly bySession: Record<string, readonly string[] | Error>) {}
  async said(ferret: string): Promise<readonly string[]> {
    this.asked.push(ferret);
    const words = this.bySession[ferret] ?? [];
    if (words instanceof Error) throw words;
    return words;
  }
}

const serviceWith = (cards: readonly Card[], ownerWords?: OwnerWords, overrides: Partial<ServiceWorld> = {}) => {
  const ports = world({
    store: new MemoryBoardStore(cards),
    ...(ownerWords === undefined ? {} : { ownerWords }),
    ...overrides,
  });
  return { ports, service: new BoardService(ports) };
};

const stored = (ports: ServiceWorld, id: string): Card => ports.store.cards.get(id) as Card;

describe('creating a card decides who asked, once', () => {
  it("should store person when the ask is words the owner said the ferret's session", async () => {
    const { ports, service } = serviceWith([], new FakeOwnerWords({ lead: [OWNER_ASK] }));
    const { card: task } = await service.create(create(), lead);
    should(task.askedBy).equal('person');
    should(stored(ports, task.id).askedBy).equal('person');
  });

  it('should store agent when the ferret made the ask up', async () => {
    const { ports, service } = serviceWith(
      [],
      new FakeOwnerWords({ lead: ['unrelated owner words that are long enough'] }),
    );
    const { card: task } = await service.create(create(), lead);
    should(stored(ports, task.id).askedBy).equal('agent');
  });

  it('should store agent when the service has no owner words at all', async () => {
    const { ports, service } = serviceWith([]);
    const { card: task } = await service.create(create(), lead);
    should(stored(ports, task.id).askedBy).equal('agent');
  });

  it("should store person for the owner's own app without reading words", async () => {
    const words = new FakeOwnerWords({});
    const { ports, service } = serviceWith([], words);
    const { card: task } = await service.create(
      create({ ask: { text: 'a card from the app', source: 'board' }, assignee: 'lead', projectId: PROJECT }),
      owner,
    );
    should(stored(ports, task.id).askedBy).equal('person');
    should(words.asked).eql([]);
  });

  it('should not trust an owner-kind caller on the admin token: a ferret can hold it', async () => {
    const { ports, service } = serviceWith([], new FakeOwnerWords({}));
    const { card: task } = await service.create(
      create({ ask: { text: OWNER_ASK, source: 'session:lead' }, assignee: 'lead', projectId: PROJECT }),
      adminOwner,
    );
    should(stored(ports, task.id).askedBy).equal('agent');
  });

  it('should store person when the source names the owner', async () => {
    const { ports, service } = serviceWith([]);
    const { card: task } = await service.create(create({ ask: { text: 'do it', source: 'owner via lead jaeda' } }), lead);
    should(stored(ports, task.id).askedBy).equal('person');
  });

  it('should still make the card, as the agent’s, when the owner words cannot be read', async () => {
    const { ports, service } = serviceWith([], new FakeOwnerWords({ lead: new Error('queue torn') }));
    const { card: task } = await service.create(create(), lead);
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
    should((await service.card('F1')).card.askedBy).equal('agent');
    should((await service.card('F2')).card.askedBy).equal('person');
    should((await service.card('F3')).card.askedBy).equal('person');
    should((await service.card('F4')).card.askedBy).equal('agent');
  });
});
