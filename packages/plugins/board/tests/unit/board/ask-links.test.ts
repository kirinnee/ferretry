import { describe, it } from 'bun:test';
import should from 'should';
import { CardAskLinks, type CardAskReader, type OpenCardAsk } from '../../../daemon/lib/board/index.ts';
import { card } from './support.ts';

const ask = (ferret: string, id: string, cardId: string, extra: Partial<OpenCardAsk> = {}): OpenCardAsk => ({
  ferret,
  id,
  cardId,
  ...extra,
});

class FakeAsks implements CardAskReader {
  reads = 0;

  constructor(
    private readonly asks: readonly OpenCardAsk[],
    private readonly failing = false,
  ) {}

  async open(): Promise<readonly OpenCardAsk[]> {
    this.reads += 1;
    if (this.failing) throw new Error('the ledger is damaged');
    return this.asks;
  }
}

const links = (asks: FakeAsks, warnings: string[] = []) =>
  new CardAskLinks(asks, { warn: message => warnings.push(message) });

describe("Asks' link to cards", () => {
  it('should group the open card asks by the card each names, every one of them asking', async () => {
    // Arrange
    const asks = new FakeAsks([
      ask('lead', 'A1', 'F2'),
      ask('child', 'A1', 'F2'),
      ask('child', 'A2', 'F1'),
      ask('child', 'A3', 'F9'),
    ]);
    const cards = [card({ id: 'F1' }), card({ id: 'F2', owner: 'lead', assignee: 'child' })];

    // Act
    const found = await links(asks).asksFor(cards);

    // Assert
    should(found.get('F2')).deepEqual({
      open: [
        { ferret: 'lead', id: 'A1' },
        { ferret: 'child', id: 'A1' },
      ],
      asking: [
        { ferret: 'lead', id: 'A1' },
        { ferret: 'child', id: 'A1' },
      ],
    });
    should(found.get('F1')).deepEqual({
      open: [{ ferret: 'child', id: 'A2' }],
      asking: [{ ferret: 'child', id: 'A2' }],
    });
    should(found.has('F9')).be.false();
  });

  it('should show a gate ask on a ledger no card of the board names, because it reads every ledger', async () => {
    const asks = new FakeAsks([ask('stranger', 'A7', 'F1')]);

    const found = await links(asks).asksFor([card({ id: 'F1', owner: 'lead', assignee: 'child' })]);

    should(found.get('F1')?.open).eql([{ ferret: 'stranger', id: 'A7' }]);
  });

  it('should never count a notice: it is context, not an ask', async () => {
    const asks = new FakeAsks([ask('lead', 'A1', 'F1', { notice: true })]);

    const found = await links(asks).asksFor([card({ id: 'F1', owner: 'lead' })]);

    should(found.size).equal(0);
  });

  it('should make ONE Asks read per derivation, whatever the number of cards and ferrets on the board', async () => {
    // Arrange: 600 cards over 600 distinct ferrets; the read used to be one ledger per ferret
    const cards = Array.from({ length: 600 }, (_, i) =>
      card({ id: `F${String(i + 1)}`, owner: `owner${String(i)}`, assignee: `helper${String(i)}` }),
    );
    const asks = new FakeAsks([ask('owner3', 'A1', 'F4')]);

    // Act
    const found = await links(asks).asksFor(cards);

    // Assert
    should(asks.reads).equal(1);
    should(found.get('F4')?.open).eql([{ ferret: 'owner3', id: 'A1' }]);
  });

  it('should cost the cards their asks, not the read, when Asks cannot be read', async () => {
    const warnings: string[] = [];
    const asks = new FakeAsks([], true);

    const found = await links(asks, warnings).asksFor([card({ id: 'F1', owner: 'lead' })]);

    should(found.size).equal(0);
    should(warnings).have.length(1);
    should(warnings[0]).containEql('could not read the asks of the cards');
  });

  it('should stop with its signal, before and after the one read', async () => {
    const controller = new AbortController();
    const asks = new FakeAsks([ask('lead', 'A1', 'F1')]);
    const reading: CardAskReader = {
      open: async () => {
        const read = await asks.open();
        controller.abort();
        return read;
      },
    };

    await new CardAskLinks(reading, { warn: () => undefined }).asksFor([card({ id: 'F1' })], controller.signal).then(
      () => should.fail(undefined, undefined, 'a stopped read must not complete'),
      (error: unknown) => should((error as Error).name).equal('AbortError'),
    );
    should(asks.reads).equal(1);
  });
});
