import { describe, it } from 'bun:test';
import type { QueuedMessage, QueuedMessageState } from '@ferretry/protocol';
import should from 'should';
import { DEFAULT_SEND_PAGE } from '../../../../src/lib/session/send/page.ts';
import { isOpenMessage, queuePage } from '../../../../src/lib/session/queue/page.ts';

/** A message enqueued `minutes` after a fixed instant, read unless a case says otherwise. */
const message = (id: string, minutes: number, state: QueuedMessageState = 'read'): QueuedMessage => ({
  v: 1,
  id,
  sender: 'human',
  text: `message ${id} ${'words '.repeat(60)}`,
  attachmentIds: [],
  enqueuedAt: new Date(Date.UTC(2026, 9, 1, 0, minutes)).toISOString(),
  state,
  stateAt: new Date(Date.UTC(2026, 9, 1, 0, minutes, 5)).toISOString(),
  revision: 1,
});

const ids = (messages: readonly QueuedMessage[]) => messages.map(each => each.id);

const SESSION = 's1';

/** A page of session `s1` that must exist: every cursor these cases name is a message of theirs. */
const pageOf = (messages: readonly QueuedMessage[], query: Parameters<typeof queuePage>[1]) => {
  const page = queuePage(messages, query, SESSION);
  if (page === undefined) throw new Error('the cursor named no message');
  return page;
};

/**
 * The measured long-lived lead: 2,948 messages ever queued, 14 of them still waiting (the oldest of those
 * long ago), the rest finished.
 */
const longQueue = (): readonly QueuedMessage[] => {
  const waiting = new Set([3, 40, 41, 300, 301, 302, 900, 901, 1500, 2000, 2400, 2800, 2900, 2947]);
  return Array.from({ length: 2_948 }, (_, n) =>
    message(`m${String(n).padStart(4, '0')}`, n, waiting.has(n) ? 'queued' : 'read'),
  );
};

const bytes = (messages: readonly QueuedMessage[]) => JSON.stringify({ messages }).length;

describe('a page of a session queue', () => {
  it('should answer every open message and the newest page of a long queue, oldest first', () => {
    // Arrange
    const queue = longQueue();

    // Act
    const page = pageOf(queue, { limit: DEFAULT_SEND_PAGE });

    // Assert — the newest 100 (n 2848..2947, one of them open) plus the 12 older open ones (two of the 14 are in the newest page).
    should(page.messages).have.length(112);
    should(page.messages.filter(isOpenMessage)).have.length(14);
    should(ids(page.messages).slice(0, 3)).eql(['m0003', 'm0040', 'm0041']);
    should(page.messages.at(-1)?.id).equal('m2947');
    should(ids(page.messages)).eql([...ids(page.messages)].sort());
    should(page.nextCursor).endWith('~s1~m2848');
  });

  it('should answer a small fraction of the bytes the whole queue weighed', () => {
    // Arrange
    const queue = longQueue();

    // Act
    const before = bytes(queue);
    const after = bytes(pageOf(queue, { limit: DEFAULT_SEND_PAGE }).messages);

    // Assert — measured on the fixture: the unpaged answer is ~26x the window.
    should(after).be.below(before / 20);
  });

  it('should answer the whole queue, no cursor, when it fits one page', () => {
    // Arrange
    const queue = [message('a', 1), message('b', 2, 'queued')];

    // Act
    const page = pageOf(queue, { limit: DEFAULT_SEND_PAGE });

    // Assert
    should(ids(page.messages)).eql(['a', 'b']);
    should(page.nextCursor).be.null();
  });

  it('should walk the whole history exactly once, with no gap and no repeat', () => {
    // Arrange
    const queue = longQueue();
    const seen: string[] = [];

    // Act
    let page = pageOf(queue, { limit: DEFAULT_SEND_PAGE });
    seen.push(...ids(page.messages));
    let pages = 1;
    while (page.nextCursor !== null) {
      page = pageOf(queue, { limit: DEFAULT_SEND_PAGE, before: page.nextCursor });
      seen.push(...ids(page.messages));
      pages += 1;
    }

    // Assert
    should(pages).equal(30);
    should(seen).have.length(queue.length);
    should(new Set(seen).size).equal(queue.length);
    should([...seen].sort()).eql(ids(queue));
  });

  it('should keep the walk whole when new messages arrive between pages', () => {
    // Arrange
    let queue: readonly QueuedMessage[] = longQueue();
    const first = pageOf(queue, { limit: 500 });
    const seen = [...ids(first.messages)];
    const arrivals = ['n1', 'n2', 'n3'].map((id, n) => message(id, 5_000 + n, 'queued'));

    // Act — three arrive, one old waiting message is delivered, then the walk goes on from the same cursor.
    queue = [...queue, ...arrivals].map(each =>
      each.id === 'm0003'
        ? { ...each, state: 'delivered' as const, stateAt: new Date(Date.UTC(2027, 0, 1)).toISOString() }
        : each,
    );
    let page = pageOf(queue, { limit: 500, before: first.nextCursor ?? '' });
    seen.push(...ids(page.messages));
    while (page.nextCursor !== null) {
      page = pageOf(queue, { limit: 500, before: page.nextCursor });
      seen.push(...ids(page.messages));
    }

    // Assert — everything that existed when the walk began is met EXACTLY once, the one that finished
    // mid-walk included, and the arrivals (newer than the walk's start) are not part of it.
    should([...seen].sort()).eql(ids(longQueue()));
    should(seen.filter(id => id.startsWith('n'))).be.empty();
  });

  it('should meet a message once when it closes mid-walk, and answer its latest state where it was carried', () => {
    // Arrange — the reviewer's timeline: a is open and old, b and c are read; the first page of 1 carries a.
    const queue = [message('a', 1, 'queued'), message('b', 2), message('c', 3)];
    const first = pageOf(queue, { limit: 1 });

    // Act — a is cancelled after the first page, then the walk reads the rest.
    const cancelledAt = new Date(Date.UTC(2026, 9, 2)).toISOString();
    const later = queue.map(each =>
      each.id === 'a' ? { ...each, state: 'cancelled' as const, stateAt: cancelledAt } : each,
    );
    const older = pageOf(later, { limit: 5, before: first.nextCursor ?? '' });

    // Assert
    should(ids(first.messages)).eql(['a', 'c']);
    should(first.messages[0]?.state).equal('queued');
    should(ids(older.messages)).eql(['b']);
    should(older.nextCursor).be.null();
  });

  it('should not leave out a delivered message that was only read after the walk began', () => {
    // Arrange — b was delivered (not open) when the first page was cut, and is read afterwards.
    const queue = [message('a', 1), message('b', 2, 'delivered'), message('c', 3)];
    const first = pageOf(queue, { limit: 1 });

    // Act
    const readAt = new Date(Date.UTC(2026, 9, 2)).toISOString();
    const later = queue.map(each => (each.id === 'b' ? { ...each, state: 'read' as const, stateAt: readAt } : each));
    const older = pageOf(later, { limit: 5, before: first.nextCursor ?? '' });

    // Assert — b is on the older page, once; nothing was lost.
    should(ids(older.messages)).eql(['a', 'b']);
  });

  it('should carry the same snapshot down every older page of a walk', () => {
    // Arrange
    const queue = [message('a', 1), message('b', 2), message('c', 3), message('d', 4)];

    // Act
    const first = pageOf(queue, { limit: 1 });
    const second = pageOf(queue, { limit: 1, before: first.nextCursor ?? '' });

    // Assert
    const snapshot = (first.nextCursor ?? '').split('~')[0];
    should(second.nextCursor).equal(`${snapshot}~s1~c`);
  });

  it('should leave the open messages out of an older page, since the first page carried them', () => {
    // Arrange
    const queue = [message('a', 1, 'queued'), message('b', 2), message('c', 3), message('d', 4)];

    // Act
    const first = pageOf(queue, { limit: 1 });
    const older = pageOf(queue, { limit: 5, before: first.nextCursor ?? '' });

    // Assert
    should(ids(first.messages)).eql(['a', 'd']);
    should(ids(older.messages)).eql(['b', 'c']);
    should(older.nextCursor).be.null();
  });

  it('should name no page for a cursor that is none of the messages, and an empty one past the oldest', () => {
    // Arrange
    const queue = [message('a', 1), message('b', 2)];

    // Act
    const first = pageOf(queue, { limit: 10 });
    const unknown = queuePage(queue, { limit: 10, before: `${first.messages[0]?.enqueuedAt}~s1~nope` }, SESSION);
    const past = pageOf(queue, { limit: 10, before: `${queue[0]?.enqueuedAt}~s1~a` });

    // Assert
    should(unknown).be.undefined();
    should(past).eql({ messages: [], nextCursor: null });
  });

  it('should break a tie of enqueued instants by id, so one cursor names one place', () => {
    // Arrange
    const queue = [message('b', 1), message('a', 1), message('c', 1)];

    // Act
    const first = pageOf(queue, { limit: 2 });
    const rest = pageOf(queue, { limit: 2, before: first.nextCursor ?? '' });

    // Assert
    should([...ids(first.messages), ...ids(rest.messages)].sort()).eql(['a', 'b', 'c']);
    should(first.nextCursor).endWith('~s1~b');
  });
});

describe('a cursor of a session queue', () => {
  const queue = [message('a', 1), message('b', 2), message('c', 3)];

  it('should be refused at another session, even when its message ids coincide', () => {
    // Arrange
    const first = pageOf(queue, { limit: 1 });

    // Act
    const elsewhere = queuePage(queue, { limit: 5, before: first.nextCursor ?? '' }, 's2');

    // Assert
    should(elsewhere).be.undefined();
  });

  it('should carry a session id that holds the delimiter, and not mistake another for it', () => {
    // Arrange
    const odd = 'we~ird/session id';
    const first = queuePage(queue, { limit: 1 }, odd);

    // Act
    const same = queuePage(queue, { limit: 5, before: first?.nextCursor ?? '' }, odd);
    const other = queuePage(queue, { limit: 5, before: first?.nextCursor ?? '' }, 'we');

    // Assert
    should(ids(same?.messages ?? [])).eql(['a', 'b']);
    should(other).be.undefined();
  });

  it('should be refused when its snapshot is after anything the log has, or before the message it names', () => {
    // Arrange — c is the newest message, a the oldest; a real cursor is `<instant>~s1~<id>`.
    const future = '9999-12-31T23:59:59.999Z';
    const ancient = '2000-01-01T00:00:00.000Z';

    // Act
    const tooLate = queuePage(queue, { limit: 5, before: `${future}~s1~b` }, SESSION);
    const tooEarly = queuePage(queue, { limit: 5, before: `${ancient}~s1~b` }, SESSION);

    // Assert
    should(tooLate).be.undefined();
    should(tooEarly).be.undefined();
  });

  it('should be refused when it names no message, or is not shaped as a cursor at all', () => {
    // Arrange
    const real = (pageOf(queue, { limit: 1 }).nextCursor ?? '').split('~')[0] ?? '';

    // Act
    const refused = [
      `${real}~s1~nope`,
      `${real}~s1~%E0%A4%A`,
      `${real}~%E0%A4%A~b`,
      'garbage',
      '2026-XX~s1~b',
      '~s1~b',
      `${real}~s1~`,
    ].map(before => queuePage(queue, { limit: 5, before }, SESSION));

    // Assert
    should(refused.every(each => each === undefined)).be.true();
  });

  it('should refuse a bare message id, even one spelled exactly like a cursor of another session', () => {
    // Arrange — message ids are the sender's choice, so a cursor and an id can be the same string.
    const first = pageOf(queue, { limit: 1 });
    const cursor = first.nextCursor ?? '';
    const lookalike = [...queue, { ...message(cursor, 9), id: cursor }];
    const malformed = '2026-10-30Tbad~s1~a';

    // Act
    const bare = queuePage(queue, { limit: 5, before: 'c' }, SESSION);
    const elsewhere = queuePage(lookalike, { limit: 5, before: cursor }, 's2');
    const bad = queuePage([message('a', 1), message(malformed, 2)], { limit: 5, before: malformed }, SESSION);

    // Assert
    should(bare).be.undefined();
    should(elsewhere).be.undefined();
    should(bad).be.undefined();
  });
});

describe('which messages are open', () => {
  it('should hold exactly the ones that can still be waiting, typed or unproven', () => {
    // Arrange
    const states: readonly QueuedMessageState[] = [
      'queued',
      'typing',
      'delivered',
      'unconfirmed',
      'read',
      'cancelled',
      'failed',
    ];

    // Act
    const open = states.filter(state => isOpenMessage(message('x', 1, state)));

    // Assert
    should(open).eql(['queued', 'typing', 'unconfirmed']);
  });
});
