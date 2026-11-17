import { describe, it } from 'bun:test';
import should from 'should';
import {
  type LedgerFate,
  type LedgerRecord,
  type SendLedger,
  type SendLedgerTail,
  type SendPageQuery,
  parseSessionId,
  sendPage,
  sendRecordView,
} from '../../../contract/index.ts';
import { SendsPager } from '../../../daemon/lib/delivery/sends-pager.ts';

/** One line of a fake log: a record, or the torn start of one the writer has not finished. */
type Line = { readonly record: LedgerRecord } | { readonly torn: number };

const BODY = 'x'.repeat(6_000);
const A = parseSessionId('ferret-a');
const B = parseSessionId('ferret-b');

const bytesOf = (line: Line): number => ('torn' in line ? line.torn : JSON.stringify(line.record).length + 1);

/** A ledger kept as a list of lines, which counts what the pager reads of it. */
class FakeLedger implements SendLedger {
  readonly logs = new Map<string, Line[]>();
  lists = 0;
  tailBytes = 0;
  constructor(withEnd = true) {
    // A ledger that cannot read its end has no `recent` at all (the method is the class's, so it is hidden on the instance).
    if (!withEnd) Object.defineProperty(this, 'recent', { value: undefined });
  }

  log(id: string): Line[] {
    const found = this.logs.get(id) ?? [];
    this.logs.set(id, found);
    return found;
  }

  append(id: string, record: LedgerRecord): void {
    this.log(id).push({ record });
  }

  async list(id: string): Promise<readonly LedgerRecord[]> {
    this.lists += 1;
    const latest = new Map<string, LedgerRecord>();
    for (const line of this.log(id)) if ('record' in line) latest.set(line.record.sendId, line.record);
    return [...latest.values()];
  }

  async recent(id: string, maxBytes: number): Promise<SendLedgerTail> {
    const lines = this.log(id);
    const size = lines.reduce((sum, line) => sum + bytesOf(line), 0);
    this.tailBytes += Math.min(maxBytes, size);
    // Whole lines only: a window starts in the middle of the one it cuts, and that one is dropped.
    const latest = new Map<string, LedgerRecord>();
    let used = 0;
    const inside: Line[] = [];
    for (const line of [...lines].reverse()) {
      used += bytesOf(line);
      if (used > maxBytes) break;
      inside.unshift(line);
    }
    for (const line of inside) if ('record' in line) latest.set(line.record.sendId, line.record);
    return { records: [...latest.values()], size };
  }

  // The rest of the port is not what a page reads.
  accept = async (): Promise<never> => await Promise.reject(new Error('not read by a page'));
  revise = async (): Promise<never> => await Promise.reject(new Error('not read by a page'));
  withdraw = async (): Promise<never> => await Promise.reject(new Error('not read by a page'));
  settle = async (): Promise<never> => await Promise.reject(new Error('not read by a page'));
}

const row = (n: number, fate: LedgerFate = 'delivered', more: Partial<LedgerRecord> = {}): LedgerRecord => ({
  sendId: `s-${String(n).padStart(5, '0')}`,
  acceptedAt: new Date(Date.UTC(2026, 10, 1) + n * 60_000).toISOString(),
  acceptedTurn: 1,
  path: 'direct',
  message: BODY,
  fate,
  ...more,
});

/** A ledger of `count` sends, each written as it was accepted and again as it settled; a few old ones never settle. */
function ledgerOf(count: number, withEnd = true): FakeLedger {
  const ledger = new FakeLedger(withEnd);
  for (let n = 0; n < count; n++) {
    ledger.append('ferret-a', row(n, 'accepted'));
    if (n % 97 === 5) ledger.append('ferret-a', row(n, 'timed_out'));
    else if (n % 89 === 3) ledger.append('ferret-a', row(n, 'accepted', { held: true }));
    else ledger.append('ferret-a', row(n, 'delivered'));
  }
  return ledger;
}

/** The answer before the pager existed: every send of the session, paged whole. */
async function wholePage(ledger: FakeLedger, id: string, query: SendPageQuery) {
  return sendPage((await ledger.list(id)).map(sendRecordView), query);
}

describe('the page of sends cut from the end of the ledger', () => {
  it('should answer the same page as before for the first, every middle and the last page', async () => {
    // Arrange — 700 sends of 6 KB twice each: far more than one window of the log.
    const ledger = ledgerOf(700);
    const pager = new SendsPager(ledger);

    // Act + Assert — page through the whole session, comparing every page with the whole-ledger answer.
    let before: string | undefined;
    let pages = 0;
    for (;;) {
      const query: SendPageQuery = before === undefined ? { limit: 100 } : { limit: 100, before };
      const got = await pager.page(A, query);
      should(got).eql(await wholePage(ledger, A, query));
      pages += 1;
      if (got?.nextCursor === null || got === undefined) break;
      before = got.nextCursor;
    }
    should(pages).equal(7);
  });

  it('should carry every open send however old on the first page and read no more than the end of the log', async () => {
    // Arrange
    const ledger = ledgerOf(700);
    const pager = new SendsPager(ledger);
    await pager.page(A, { limit: 100 });
    const built = ledger.lists;
    ledger.tailBytes = 0;

    // Act — a second look finds the index built and reads only the log's end.
    const got = await pager.page(A, { limit: 10 });

    // Assert
    should(got).eql(await wholePage(ledger, A, { limit: 10 }));
    const oldOpen = got?.sends.filter(send => send.sendId < 's-00600') ?? [];
    should(oldOpen.length).be.above(5);
    should(built).equal(1);
    should(ledger.tailBytes).be.below(4 * 1024 * 1024);
  });

  it('should follow the log by what was appended, without reading it whole again', async () => {
    // Arrange
    const ledger = ledgerOf(300);
    const pager = new SendsPager(ledger);
    await pager.page(A, { limit: 20 });
    const built = ledger.lists;

    // Act — a new send, an old one settled and an open one withdrawn.
    ledger.append('ferret-a', row(300, 'accepted'));
    ledger.append('ferret-a', row(5, 'delivered'));
    ledger.append('ferret-a', row(3, 'accepted', { held: false, fate: 'withdrawn' }));
    const got = await pager.page(A, { limit: 20 });

    // Assert
    should(got).eql(await wholePage(ledger, A, { limit: 20 }));
    should(got?.sends[0]?.sendId).equal('s-00300');
    should(ledger.lists - 1).equal(built);
  });

  it('should answer only the session asked for, and refuse a cursor that is another session’s', async () => {
    // Arrange
    const ledger = ledgerOf(150);
    for (let n = 0; n < 40; n++) ledger.append('ferret-b', row(1_000 + n));
    const pager = new SendsPager(ledger);

    // Act
    const mine = await pager.page(B, { limit: 100 });
    const crossed = await pager.page(A, { limit: 10, before: 's-01010' });

    // Assert
    should(mine?.sends).have.length(40);
    should(mine?.sends.every(send => send.sendId >= 's-01000')).be.true();
    should(mine).eql(await wholePage(ledger, B, { limit: 100 }));
    should(crossed).be.undefined();
    should(await pager.page(A, { limit: 10, before: 's-00010' })).eql(
      await wholePage(ledger, A, { limit: 10, before: 's-00010' }),
    );
  });

  it('should leave a torn last line out, and take it in once it is whole', async () => {
    // Arrange
    const ledger = ledgerOf(120);
    const pager = new SendsPager(ledger);
    ledger.log('ferret-a').push({ torn: 900 });

    // Act
    const torn = await pager.page(A, { limit: 15 });
    const tornAnswer = await wholePage(ledger, A, { limit: 15 });
    ledger.log('ferret-a').pop();
    ledger.append('ferret-a', row(120));
    const whole = await pager.page(A, { limit: 15 });

    // Assert
    should(torn).eql(tornAnswer);
    should(torn?.sends[0]?.sendId).equal('s-00119');
    should(whole?.sends[0]?.sendId).equal('s-00120');
    should(whole).eql(await wholePage(ledger, A, { limit: 15 }));
  });

  it('should read the log again when it is shorter than the index has read', async () => {
    // Arrange
    const ledger = ledgerOf(200);
    const pager = new SendsPager(ledger);
    await pager.page(A, { limit: 10 });
    ledger.logs.set('ferret-a', ledger.log('ferret-a').slice(0, 100));

    // Act
    const got = await pager.page(A, { limit: 10 });

    // Assert
    should(got).eql(await wholePage(ledger, A, { limit: 10 }));
    should(ledger.lists).be.above(2);
  });

  it('should read the whole ledger for a row the end of the log does not hold', async () => {
    // Arrange — an end that answers nothing, as a window past the cap would.
    const ledger = ledgerOf(120);
    const empty = async (): Promise<SendLedgerTail> => ({ records: [], size: 10 });
    const pager = new SendsPager(
      Object.assign(Object.create(ledger) as FakeLedger, {
        recent: async (id: string, maxBytes: number) => (maxBytes === 1 ? await ledger.recent(id, 1) : await empty()),
      }),
    );

    // Act + Assert
    should(await pager.page(A, { limit: 25 })).eql(await wholePage(ledger, A, { limit: 25 }));
  });

  it('should keep the index of the sessions looked at last, and read a dropped one again', async () => {
    // Arrange — ten sessions, one more than the eight kept.
    const ledger = new FakeLedger();
    const ids = Array.from({ length: 10 }, (_, n) => `ferret-${n}`);
    for (const id of ids) ledger.append(id, row(1));
    const pager = new SendsPager(ledger);
    for (const id of ids) await pager.page(parseSessionId(id), { limit: 10 });
    const built = ledger.lists;

    // Act
    await pager.page(parseSessionId('ferret-9'), { limit: 10 });
    const kept = ledger.lists;
    await pager.page(parseSessionId('ferret-0'), { limit: 10 });

    // Assert
    should(kept).equal(built);
    should(ledger.lists).equal(built + 1);
  });

  it('should page from the whole ledger when it cannot read its end', async () => {
    // Arrange
    const ledger = ledgerOf(120, false);
    const pager = new SendsPager(ledger);

    // Act + Assert
    should((ledger as { recent?: unknown }).recent).be.undefined();
    should(await pager.page(A, { limit: 25 })).eql(await wholePage(ledger, A, { limit: 25 }));
  });
});
