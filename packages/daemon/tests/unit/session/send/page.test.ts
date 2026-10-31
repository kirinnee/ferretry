import { describe, it } from 'bun:test';
import type { SendRecord } from '@ferretry/protocol';
import should from 'should';
import {
  DEFAULT_SEND_PAGE,
  isOpenSend,
  sendPage,
  UnknownSendCursorError,
} from '../../../../src/lib/session/send/page.ts';

/** A send accepted `minutes` after a fixed instant, delivered unless a case says otherwise. */
const send = (id: string, minutes: number, overrides: Partial<SendRecord> = {}): SendRecord => ({
  v: 1,
  sendId: id,
  acceptedAt: new Date(Date.UTC(2026, 9, 31, 0, minutes)).toISOString(),
  acceptedTurn: 1,
  path: 'direct',
  message: `message ${id}`,
  attachmentIds: [],
  fate: 'delivered',
  ...overrides,
});

const ids = (sends: readonly SendRecord[]) => sends.map(each => each.sendId);

describe('a page of sends', () => {
  it('should answer the newest sends first and name where the older ones start', () => {
    // Arrange — out of order, as a ledger's map may hold them.
    const sends = [send('a', 1), send('c', 3), send('b', 2), send('d', 4)];

    // Act
    const page = sendPage(sends, { limit: 2 });

    // Assert
    should(ids(page.sends)).eql(['d', 'c']);
    should(page.nextCursor).equal('c');
  });

  it('should page older sends from a cursor until none are left', () => {
    // Arrange
    const sends = [send('a', 1), send('b', 2), send('c', 3), send('d', 4)];

    // Act
    const second = sendPage(sends, { limit: 2, before: 'c' });
    const last = sendPage(sends, { limit: 2, before: 'a' });

    // Assert
    should(ids(second.sends)).eql(['b', 'a']);
    should(second.nextCursor).be.null();
    should(last).eql({ sends: [], nextCursor: null });
  });

  it('should carry every open send past the first page, however old', () => {
    // Arrange
    const sends = [
      send('held', 1, { held: true }),
      send('waiting', 2, { fate: 'accepted' }),
      send('queued', 3, { fate: 'queued' }),
      send('unsure', 4, { fate: 'unaccounted' }),
      send('lost', 5, { fate: 'timed_out' }),
      send('gone', 6, { fate: 'accepted', withdrawn: true }),
      send('stopped', 7, { fate: 'cancelled' }),
      send('old', 8),
      ...Array.from({ length: DEFAULT_SEND_PAGE }, (_, n) => send(`new-${String(n)}`, 100 + n)),
    ];

    // Act
    const page = sendPage(sends, { limit: DEFAULT_SEND_PAGE });

    // Assert
    should(page.sends).have.length(DEFAULT_SEND_PAGE + 5);
    should(ids(page.sends.slice(DEFAULT_SEND_PAGE))).eql(['lost', 'unsure', 'queued', 'waiting', 'held']);
    should(page.nextCursor).equal(`new-0`);
  });

  it('should order sends accepted at the same instant by id, so a cursor names one place', () => {
    // Arrange
    const sends = [send('b', 1), send('a', 1), send('c', 1)];

    // Act
    const first = sendPage(sends, { limit: 1 });
    const rest = sendPage(sends, { limit: 5, before: first.nextCursor ?? '' });

    // Assert
    should(ids(first.sends)).eql(['a']);
    should(ids(rest.sends)).eql(['b', 'c']);
  });

  it('should refuse a cursor that names no send', () => {
    should(() => sendPage([send('a', 1)], { limit: 1, before: 'nope' })).throw(UnknownSendCursorError);
  });

  it('should call a send open while its fate can still change or it is held, never once withdrawn', () => {
    should(isOpenSend(send('a', 1, { fate: 'accepted' }))).be.true();
    should(isOpenSend(send('a', 1, { held: true }))).be.true();
    should(isOpenSend(send('a', 1))).be.false();
    should(isOpenSend(send('a', 1, { fate: 'cancelled' }))).be.false();
    should(isOpenSend(send('a', 1, { fate: 'accepted', withdrawn: true }))).be.false();
  });
});
