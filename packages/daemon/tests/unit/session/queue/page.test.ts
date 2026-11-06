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

/** A page that must exist: every cursor these cases name is a message of theirs. */
const pageOf = (...args: Parameters<typeof queuePage>) => {
  const page = queuePage(...args);
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
    should(page.nextCursor).equal('m2848');
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
    queue = [...queue, ...arrivals].map(each => (each.id === 'm0003' ? { ...each, state: 'read' as const } : each));
    let page = pageOf(queue, { limit: 500, before: first.nextCursor ?? '' });
    seen.push(...ids(page.messages));
    while (page.nextCursor !== null) {
      page = pageOf(queue, { limit: 500, before: page.nextCursor });
      seen.push(...ids(page.messages));
    }

    // Assert — everything that existed when the walk began is met once; m0003 closed in between and is met
    // in both places, which a reader merging by id folds into one.
    const began = ids(longQueue());
    should(began.every(id => seen.includes(id))).be.true();
    should(seen.filter(id => id.startsWith('n'))).be.empty();
    const repeats = seen.filter((id, at) => seen.indexOf(id) !== at);
    should(repeats).eql(['m0003']);
  });

  it('should leave the open messages out of an older page, since the first page carried them', () => {
    // Arrange
    const queue = [message('a', 1, 'queued'), message('b', 2), message('c', 3), message('d', 4)];

    // Act
    const first = pageOf(queue, { limit: 1 });
    const older = pageOf(queue, { limit: 5, before: 'd' });

    // Assert
    should(ids(first.messages)).eql(['a', 'd']);
    should(ids(older.messages)).eql(['b', 'c']);
    should(older.nextCursor).be.null();
  });

  it('should name no page for a cursor that is none of the messages, and an empty one past the oldest', () => {
    // Arrange
    const queue = [message('a', 1), message('b', 2)];

    // Act
    const unknown = queuePage(queue, { limit: 10, before: 'nope' });
    const past = pageOf(queue, { limit: 10, before: 'a' });

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
    should(first.nextCursor).equal('b');
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
