import { describe, it } from 'bun:test';
import should from 'should';
import {
  ASK_READ_CONCURRENCY,
  CardAskLinks,
  type FerretAsksReader,
  type OpenAskFacts,
} from '../../../daemon/lib/board/index.ts';
import { card } from './support.ts';

const ask = (id: string, extra: Partial<OpenAskFacts> = {}): OpenAskFacts => ({ id, cards: [], gateOf: [], ...extra });

class FakeLedgers implements FerretAsksReader {
  readonly reads: string[] = [];

  constructor(
    private readonly ledgers: Readonly<Record<string, readonly OpenAskFacts[]>>,
    private readonly failing: ReadonlySet<string> = new Set(),
  ) {}

  async open(ferret: string): Promise<readonly OpenAskFacts[]> {
    this.reads.push(ferret);
    if (this.failing.has(ferret)) throw new Error('the ledger is damaged');
    return this.ledgers[ferret] ?? [];
  }
}

const links = (ledgers: FakeLedgers, warnings: string[] = []) =>
  new CardAskLinks(ledgers, { warn: message => warnings.push(message) });

describe("Asks' link to cards", () => {
  it('should count every open ask carrying a card, and the ones that are its gate obligation as asking', async () => {
    // Arrange
    const ledgers = new FakeLedgers({
      child: [
        ask('A1', { cards: ['F2'], gateOf: ['F2'] }),
        ask('A2', { cards: ['F2'] }),
        ask('A3', { cards: ['F1'] }),
        ask('A4', { cards: ['F9'], gateOf: ['F1'] }),
      ],
      lead: [ask('A1', { cards: ['F2'] })],
    });
    const cards = [card({ id: 'F1' }), card({ id: 'F2', owner: 'lead', assignee: 'child' })];

    // Act
    const asks = await links(ledgers).asksFor(cards);

    // Assert
    should(asks.get('F2')).deepEqual({
      open: [
        { ferret: 'lead', id: 'A1' },
        { ferret: 'child', id: 'A1' },
        { ferret: 'child', id: 'A2' },
      ],
      asking: [{ ferret: 'child', id: 'A1' }],
    });
    should(asks.get('F1')).deepEqual({
      open: [
        { ferret: 'child', id: 'A3' },
        { ferret: 'child', id: 'A4' },
      ],
      asking: [{ ferret: 'child', id: 'A4' }],
    });
  });

  it('should never count a notice: it is context, not an ask', async () => {
    const ledgers = new FakeLedgers({ lead: [ask('A1', { cards: ['F1'], notice: true })] });

    const asks = await links(ledgers).asksFor([card({ id: 'F1', owner: 'lead' })]);

    should(asks.size).equal(0);
  });

  it('should cost a card its asks, not the read, when one ledger cannot be read', async () => {
    // Arrange
    const warnings: string[] = [];
    const ledgers = new FakeLedgers({ child: [ask('A1', { cards: ['F1'] })] }, new Set(['lead']));

    // Act
    const asks = await links(ledgers, warnings).asksFor([card({ id: 'F1', owner: 'lead', assignee: 'child' })]);

    // Assert
    should(asks.get('F1')?.open).eql([{ ferret: 'child', id: 'A1' }]);
    should(warnings).have.length(1);
    should(warnings[0]).containEql('could not read the asks of lead');
  });

  it('should read the ledger of each ferret once, and a card’s ask lives on its ferret’s home too', async () => {
    // Arrange
    const ledgers = new FakeLedgers({ top: [ask('A7', { cards: ['F1'] })] });
    const homes = { of: async (ferret: string) => (ferret === 'child' ? 'top' : ferret) };

    // Act
    const asks = await new CardAskLinks(ledgers, { warn: () => undefined }, homes).asksFor([
      card({ id: 'F1', owner: 'child', assignee: 'child' }),
    ]);

    // Assert
    should(asks.get('F1')?.open).eql([{ ferret: 'top', id: 'A7' }]);
    should([...ledgers.reads].sort()).eql(['child', 'top']);
  });

  it('should read the ledgers in batches', () => {
    should(ASK_READ_CONCURRENCY).be.above(0);
  });

  it('should stop at the next batch once its signal aborts, reading no more ledgers', async () => {
    const owners = Array.from({ length: ASK_READ_CONCURRENCY * 4 }, (_, i) => `owner${String(i)}`);
    const ledgers = new FakeLedgers({});
    const controller = new AbortController();
    const cards = owners.map((owner, i) => card({ id: `F${String(i + 1)}`, owner, assignee: owner }));
    const seen = new FakeLedgers({});
    const stopping: FerretAsksReader = {
      open: async ferret => {
        const read = await seen.open(ferret);
        controller.abort();
        return read;
      },
    };

    await new CardAskLinks(stopping, { warn: () => undefined }).asksFor(cards, cards, controller.signal).then(
      () => should.fail(undefined, undefined, 'a stopped read must not complete'),
      (error: unknown) => should((error as Error).name).equal('AbortError'),
    );

    should(seen.reads.length).be.belowOrEqual(ASK_READ_CONCURRENCY);
    should(ledgers.reads).eql([]);
  });
});
