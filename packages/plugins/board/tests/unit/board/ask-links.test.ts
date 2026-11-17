import { describe, it } from 'bun:test';
import should from 'should';
import { TaskAskLinks, type TaskAskReader, type OpenTaskAsk } from '../../../daemon/lib/board/index.ts';
import { boardTask } from './support.ts';

const ask = (ferret: string, id: string, taskId: string, extra: Partial<OpenTaskAsk> = {}): OpenTaskAsk => ({
  ferret,
  id,
  cardId: taskId,
  ...extra,
});

class FakeAsks implements TaskAskReader {
  reads = 0;

  constructor(
    private readonly asks: readonly OpenTaskAsk[],
    private readonly failing = false,
    private readonly mentions: readonly OpenTaskAsk[] = [],
  ) {}

  async mentioned(): Promise<readonly OpenTaskAsk[]> {
    return this.mentions;
  }

  async open(): Promise<readonly OpenTaskAsk[]> {
    this.reads += 1;
    if (this.failing) throw new Error('the ledger is damaged');
    return this.asks;
  }
}

const links = (asks: FakeAsks, warnings: string[] = []) =>
  new TaskAskLinks(asks, { warn: message => warnings.push(message) });

describe("Asks' link to cards", () => {
  it('should group the open card asks by the card each names, every one of them asking', async () => {
    // Arrange
    const asks = new FakeAsks([
      ask('lead', 'A1', 'F2'),
      ask('child', 'A1', 'F2'),
      ask('child', 'A2', 'F1'),
      ask('child', 'A3', 'F9'),
    ]);
    const tasks = [boardTask({ id: 'F1' }), boardTask({ id: 'F2', owner: 'lead', assignee: 'child' })];

    // Act
    const found = await links(asks).asksFor(tasks);

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

    const found = await links(asks).asksFor([boardTask({ id: 'F1', owner: 'lead', assignee: 'child' })]);

    should(found.get('F1')?.open).eql([{ ferret: 'stranger', id: 'A7' }]);
  });

  it('should never count a notice: it is context, not an ask', async () => {
    const asks = new FakeAsks([ask('lead', 'A1', 'F1', { notice: true })]);

    const found = await links(asks).asksFor([boardTask({ id: 'F1', owner: 'lead' })]);

    should(found.size).equal(0);
  });

  it('should make ONE Asks read per derivation, whatever the number of cards and ferrets on the board', async () => {
    // Arrange: 600 cards over 600 distinct ferrets; the read used to be one ledger per ferret
    const tasks = Array.from({ length: 600 }, (_, i) =>
      boardTask({ id: `F${String(i + 1)}`, owner: `owner${String(i)}`, assignee: `helper${String(i)}` }),
    );
    const asks = new FakeAsks([ask('owner3', 'A1', 'F4')]);

    // Act
    const found = await links(asks).asksFor(tasks);

    // Assert
    should(asks.reads).equal(1);
    should(found.get('F4')?.open).eql([{ ferret: 'owner3', id: 'A1' }]);
  });

  it('should list an ask a ferret raised about a card beside the gate ask, and only the gate ask is asking', async () => {
    const asks = new FakeAsks([ask('lead', 'A1', 'F1')], false, [ask('lead', 'A3', 'F1'), ask('lead', 'A4', 'F2')]);

    const found = await links(asks).asksFor([boardTask({ id: 'F1', owner: 'lead' })]);

    should(found.get('F1')).deepEqual({
      open: [
        { ferret: 'lead', id: 'A1' },
        { ferret: 'lead', id: 'A3' },
      ],
      asking: [{ ferret: 'lead', id: 'A1' }],
    });
    should(found.has('F2')).be.false();
  });

  it('should list a card carried by a ferret-raised ask alone, and an ask that is also its gate once', async () => {
    const asks = new FakeAsks([ask('lead', 'A1', 'F1')], false, [ask('lead', 'A1', 'F1'), ask('child', 'A2', 'F2')]);

    const found = await links(asks).asksFor([boardTask({ id: 'F1' }), boardTask({ id: 'F2' })]);

    should(found.get('F1')?.open).eql([{ ferret: 'lead', id: 'A1' }]);
    should(found.get('F2')).deepEqual({ open: [{ ferret: 'child', id: 'A2' }], asking: [] });
  });

  it('should keep the gate asks when the ferret-raised asks cannot be read, and say so', async () => {
    const warnings: string[] = [];
    const asks = new FakeAsks([ask('lead', 'A1', 'F1')]);
    const reading: TaskAskReader = {
      open: async () => await asks.open(),
      mentioned: async () => Promise.reject(new Error('the boards are unreadable')),
    };

    const found = await new TaskAskLinks(reading, { warn: message => warnings.push(message) }).asksFor([
      boardTask({ id: 'F1', owner: 'lead' }),
    ]);

    should(found.get('F1')?.asking).eql([{ ferret: 'lead', id: 'A1' }]);
    should(warnings).have.length(1);
    should(warnings[0]).containEql('the boards are unreadable');
  });

  it('should cost the cards their asks, not the read, when Asks cannot be read', async () => {
    const warnings: string[] = [];
    const asks = new FakeAsks([], true);

    const found = await links(asks, warnings).asksFor([boardTask({ id: 'F1', owner: 'lead' })]);

    should(found.size).equal(0);
    should(warnings).have.length(1);
    should(warnings[0]).containEql('could not read the asks of the tasks');
  });

  it('should stop with its signal, before and after the one read', async () => {
    const controller = new AbortController();
    const asks = new FakeAsks([ask('lead', 'A1', 'F1')]);
    const reading: TaskAskReader = {
      open: async () => {
        const read = await asks.open();
        controller.abort();
        return read;
      },
      mentioned: async () => [],
    };

    await new TaskAskLinks(reading, { warn: () => undefined })
      .asksFor([boardTask({ id: 'F1' })], controller.signal)
      .then(
        () => should.fail(undefined, undefined, 'a stopped read must not complete'),
        (error: unknown) => should((error as Error).name).equal('AbortError'),
      );
    should(asks.reads).equal(1);
  });
});
