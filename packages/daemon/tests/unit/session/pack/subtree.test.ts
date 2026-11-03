import { describe, it } from 'bun:test';
import { type BoardTask, type PrLink, SubtreeViewSchema } from '@ferretry/protocol';
import should from 'should';
import {
  lastLineOf,
  newestMessageTo,
  oneLine,
  prOf,
  type SentMessage,
  type SubtreePorts,
  SubtreeService,
  subtreeMembers,
  subtreeStateOf,
} from '../../../../src/lib/session/pack/subtree.ts';
import { card, lanes, PROJECT } from '../../board/support.ts';
import { sessionView } from '../../runtime/mounts/support.ts';

const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const minutesAgo = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
const lead = { kind: 'ferret', sessionId: 'lead' } as const;

const pr = (overrides: Partial<PrLink> = {}): PrLink => ({
  url: 'https://github.com/acme/app/pull/42',
  number: 42,
  repo: 'acme/app',
  state: 'open',
  draft: false,
  checks: 'passing',
  mergedAt: null,
  mergeSha: null,
  releasedIn: null,
  polledAt: minutesAgo(1),
  ...overrides,
});

const child = (id: string, parent: string, config: Record<string, unknown> = {}, state: Record<string, unknown> = {}) =>
  sessionView(id, { parent, teammate: id, ...config }, state);

const note = (seq: number, at: string, text: string) =>
  ({ seq, at, actor: lead, type: 'note', text }) as const satisfies BoardTask['history'][number];

const ids = (members: ReturnType<typeof subtreeMembers>): string[] => members.map(member => member.view.config.id);

describe('subtreeMembers', () => {
  it('should list descendants nested by depth, a ferret directly before its own children, siblings by callsign', () => {
    // Arrange
    const sessions = [
      sessionView('root'),
      child('zed', 'root'),
      child('ada', 'root'),
      child('ada-2', 'ada'),
      child('ada-1', 'ada'),
      child('ada-1-a', 'ada-1'),
      child('elsewhere', 'someone-else'),
    ];

    // Act
    const members = subtreeMembers(sessions, 'root', NOW);

    // Assert
    should(ids(members)).deepEqual(['ada', 'ada-1', 'ada-1-a', 'ada-2', 'zed']);
    should(members.map(member => member.depth)).deepEqual([1, 2, 3, 2, 1]);
  });

  it('should keep a session that ended inside the window and drop one that ended before it', () => {
    // Arrange
    const sessions = [
      sessionView('root'),
      child('fresh', 'root', {}, { status: 'completed', finishedAt: minutesAgo(30) }),
      child('stale', 'root', {}, { status: 'completed', finishedAt: minutesAgo(180) }),
      child('failed', 'root', {}, { status: 'failed', lastActivityAt: minutesAgo(119) }),
      child('undated', 'root', {}, { status: 'stopped', lastActivityAt: undefined }),
      child('live', 'root'),
    ];

    // Act
    const members = subtreeMembers(sessions, 'root', NOW);

    // Assert
    should(ids(members)).deepEqual(['failed', 'fresh', 'live']);
  });

  it('should still list a live grandchild of an ended child that has left the window', () => {
    // Arrange
    const sessions = [
      sessionView('root'),
      child('old', 'root', {}, { status: 'completed', finishedAt: minutesAgo(500) }),
      child('grand', 'old'),
    ];

    // Act
    const members = subtreeMembers(sessions, 'root', NOW);

    // Assert
    should(ids(members)).deepEqual(['grand']);
    should(members[0]?.depth).equal(2);
  });

  it('should terminate on a parent cycle and exclude the root itself', () => {
    // Arrange
    const sessions = [child('root', 'b'), child('b', 'root')];

    // Act
    const members = subtreeMembers(sessions, 'root', NOW);

    // Assert
    should(ids(members)).deepEqual(['b']);
  });
});

describe('subtreeStateOf', () => {
  it('should read ended, needs-you, waiting and running from the session state', () => {
    // Arrange / Act / Assert
    should(subtreeStateOf(sessionView('a', {}, { status: 'completed' }))).equal('ended');
    should(subtreeStateOf(sessionView('a', {}, { needsHuman: 'login' }))).equal('needs-you');
    should(subtreeStateOf(sessionView('a', {}, { status: 'awaiting_question' }))).equal('needs-you');
    should(
      subtreeStateOf(sessionView('a', {}, { agenda: { open: 1, first: 'A1', ask: 'ship?', latestAt: minutesAgo(1) } })),
    ).equal('needs-you');
    should(
      subtreeStateOf(
        sessionView(
          'a',
          {},
          { agenda: { open: 1, discussing: 1, first: 'A1', ask: 'ship?', latestAt: minutesAgo(1) } },
        ),
      ),
    ).equal('running');
    should(subtreeStateOf(sessionView('a', {}, { status: 'waiting' }))).equal('waiting');
    should(subtreeStateOf(sessionView('a', {}, { status: 'rate_limited' }))).equal('waiting');
    should(subtreeStateOf(sessionView('a', {}, { status: 'thinking' }))).equal('running');
  });
});

describe('oneLine', () => {
  it('should take the first non-blank line, collapse whitespace and cut a long one with an ellipsis', () => {
    // Arrange / Act / Assert
    should(oneLine('\n\n  tests   are\tgreen  \nsecond line')).equal('tests are green');
    const cut = oneLine('x'.repeat(300));
    should([...cut].length).equal(100);
    should(cut.endsWith('…')).be.true();
    should(oneLine('y'.repeat(100))).equal('y'.repeat(100));
    should(oneLine('   \n  ')).equal('');
  });
});

describe('lastLineOf', () => {
  const withNotes = card({ history: [note(1, minutesAgo(30), 'older note'), note(2, minutesAgo(10), 'newest note')] });

  it('should choose the newest of the card’s last note and the last message', () => {
    // Arrange
    const newer: SentMessage = { at: minutesAgo(5), text: 'PR is up' };
    const older: SentMessage = { at: minutesAgo(20), text: 'starting' };

    // Act / Assert
    should(lastLineOf(withNotes, newer)).deepEqual({ at: newer.at, source: 'message', text: 'PR is up' });
    should(lastLineOf(withNotes, older)).deepEqual({ at: minutesAgo(10), source: 'note', text: 'newest note' });
  });

  it('should prefer the note on a tie, and use whichever exists alone', () => {
    // Arrange
    const tie: SentMessage = { at: minutesAgo(10), text: 'same instant' };

    // Act / Assert
    should(lastLineOf(withNotes, tie)?.source).equal('note');
    should(lastLineOf(undefined, tie)).deepEqual({ at: tie.at, source: 'message', text: 'same instant' });
    should(lastLineOf(withNotes, undefined)?.source).equal('note');
    should(lastLineOf(card(), undefined)).be.undefined();
    should(lastLineOf(undefined, undefined)).be.undefined();
  });

  it('should cut a multi-line message to its first line', () => {
    // Arrange
    const message: SentMessage = { at: minutesAgo(1), text: 'Result: done\n\nlong details follow' };

    // Act / Assert
    should(lastLineOf(undefined, message)?.text).equal('Result: done');
  });
});

describe('prOf', () => {
  it('should read state and CI straight off the card’s cached PR link', () => {
    // Arrange
    const failing = card({
      links: { prs: [pr({ checks: 'failing', draft: true })], branch: null, commits: [], docs: [] },
    });

    // Act / Assert
    should(prOf(failing)).deepEqual({
      number: 42,
      url: 'https://github.com/acme/app/pull/42',
      state: 'open',
      draft: true,
      checks: 'failing',
    });
  });

  it('should prefer the open PR over a newer closed one, else the newest, and none without a link', () => {
    // Arrange
    const first = pr({ number: 1, url: 'https://github.com/acme/app/pull/1', state: 'open' });
    const second = pr({ number: 2, url: 'https://github.com/acme/app/pull/2', state: 'closed' });
    const links = (prs: PrLink[]) => ({ prs, branch: null, commits: [], docs: [] });

    // Act / Assert
    should(prOf(card({ links: links([first, second]) }))?.number).equal(1);
    should(
      prOf(
        card({ links: links([second, pr({ number: 3, url: 'https://github.com/acme/app/pull/3', state: 'merged' })]) }),
      )?.number,
    ).equal(3);
    should(prOf(card())).be.undefined();
  });
});

describe('newestMessageTo', () => {
  const line = (entry: Record<string, unknown>): string => JSON.stringify(entry);

  it('should return the newest message to that recipient, skipping questions, other recipients and a torn first line', () => {
    // Arrange
    const tail = [
      'orn-line-from-the-middle","x":1}',
      line({ at: '2026-11-03T10:00:00.000Z', type: 'message', from: 'c', to: 'lead', message: 'first' }),
      line({ at: '2026-11-03T10:30:00.000Z', type: 'message', from: 'c', to: 'lead', message: 'second' }),
      line({ at: '2026-11-03T10:40:00.000Z', type: 'message', from: 'c', to: 'other', message: 'not for lead' }),
      line({ at: '2026-11-03T10:50:00.000Z', type: 'question', message: 'a question' }),
      '',
    ].join('\n');

    // Act / Assert
    should(newestMessageTo(tail, 'lead')).deepEqual({ at: '2026-11-03T10:30:00.000Z', text: 'second' });
    should(newestMessageTo(tail, 'nobody')).be.undefined();
    should(newestMessageTo('', 'lead')).be.undefined();
  });
});

describe('SubtreeService', () => {
  const laneSets = new Map([[PROJECT, lanes()]]);
  const cards = [
    card({
      id: 'F1',
      laneId: 'implement',
      links: { prs: [pr()], branch: null, commits: [], docs: [] },
      history: [note(1, minutesAgo(20), 'wiring the route')],
    }),
    card({ id: 'F2', laneId: 'todo' }),
  ];

  const service = (
    sessions: ReturnType<typeof sessionView>[],
    messages: Record<string, SentMessage> = {},
    overrides: Partial<SubtreePorts> = {},
  ) => {
    const reads = { board: 0, messages: [] as Array<readonly [string, string]> };
    const ports: SubtreePorts = {
      sessions: async () => sessions,
      board: async () => {
        reads.board += 1;
        return { cards, laneSets };
      },
      lastMessage: async (id, to) => {
        reads.messages.push([id, to]);
        return messages[id];
      },
      nowMs: () => NOW,
      ...overrides,
    };
    return { reads, subject: new SubtreeService(ports) };
  };

  it('should build one row per descendant with card, lane, PR, CI and the newest last line', async () => {
    // Arrange
    const { subject, reads } = service(
      [
        sessionView('root', { teammate: 'rhett' }),
        child('ada', 'root', { focusTask: { id: 'F1' }, model: 'claude-sonnet-5-5' }, { status: 'thinking' }),
        child('bo', 'root', { focusTask: { id: 'F2' } }, { needsHuman: 'login' }),
        child('cy', 'root'),
        child('ada-kid', 'ada', {}, { status: 'completed', finishedAt: minutesAgo(10) }),
      ],
      { ada: { at: minutesAgo(2), text: 'PR open, CI running\nmore' }, cy: { at: minutesAgo(3), text: 'hello' } },
    );

    // Act
    const view = await subject.view('root');

    // Assert
    should(SubtreeViewSchema.parse(view)).deepEqual(view);
    should(view?.root).deepEqual({ id: 'root', callsign: 'rhett' });
    should(view?.rows.map(row => [row.callsign, row.depth, row.state])).deepEqual([
      ['ada', 1, 'running'],
      ['ada-kid', 2, 'ended'],
      ['bo', 1, 'needs-you'],
      ['cy', 1, 'running'],
    ]);
    const [ada, kid, bo, cy] = view?.rows ?? [];
    should(ada?.model).equal('claude-sonnet-5-5');
    should(ada?.card).deepEqual({ ref: '&F1', lane: 'Implement' });
    should(ada?.pr).deepEqual({
      number: 42,
      url: 'https://github.com/acme/app/pull/42',
      state: 'open',
      draft: false,
      checks: 'passing',
    });
    should(ada?.last).deepEqual({ at: minutesAgo(2), source: 'message', text: 'PR open, CI running' });
    should(kid?.endedAt).equal(minutesAgo(10));
    should(bo?.card?.ref).equal('&F2');
    should(bo?.pr).be.undefined();
    should(bo?.last).be.undefined();
    should(cy?.card).be.undefined();
    should(cy?.last?.text).equal('hello');
    should(reads.board).equal(1);
    should(reads.messages.every(([, to]) => to === 'root')).be.true();
  });

  it('should take the note when it is newer than the message', async () => {
    // Arrange
    const { subject } = service([sessionView('root'), child('ada', 'root', { focusTask: { id: 'F1' } })], {
      ada: { at: minutesAgo(45), text: 'old message' },
    });

    // Act
    const view = await subject.view('root');

    // Assert
    should(view?.rows[0]?.last).deepEqual({ at: minutesAgo(20), source: 'note', text: 'wiring the route' });
  });

  it('should not read the board when no descendant works on a card, and answer an empty table for a leaf', async () => {
    // Arrange
    const { subject, reads } = service([sessionView('root'), child('cy', 'root')]);
    const leaf = service([sessionView('root')]);

    // Act
    const view = await subject.view('root');
    const empty = await leaf.subject.view('root');

    // Assert
    should(reads.board).equal(0);
    should(view?.rows).have.length(1);
    should(empty?.rows).deepEqual([]);
  });

  it('should keep a row whose card is not on the board, with the ref and no lane', async () => {
    // Arrange
    const { subject } = service([sessionView('root'), child('ada', 'root', { focusTask: { id: 'F99' } })]);

    // Act
    const view = await subject.view('root');

    // Assert
    should(view?.rows[0]?.card).deepEqual({ ref: '&F99' });
  });

  it('should answer undefined for a session the registry does not hold', async () => {
    // Arrange
    const { subject } = service([sessionView('root')]);

    // Act / Assert
    should(await subject.view('ghost')).be.undefined();
  });
});
