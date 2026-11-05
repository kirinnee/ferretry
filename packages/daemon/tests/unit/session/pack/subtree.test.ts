import { describe, it } from 'bun:test';
import { type BoardTask, type PrLink, SubtreeRowSchema, SubtreeViewSchema } from '@ferretry/protocol';
import should from 'should';
import { mapBounded } from '../../../../src/lib/session/pack/bounded.ts';
import { newestMessageScanning, scanOutbox } from '../../../../src/lib/session/pack/outbox-scan.ts';
import {
  EXCERPT_WITHHELD,
  excerptEligible,
  excerptOf,
  newestLine,
  newestMessageTo,
  oneLine,
  prOf,
  type SentMessage,
  SUBTREE_LIMITS,
  type SubtreeLimits,
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

  it('should cut by the same character count the table schema checks, even with emoji at the limit', () => {
    // Arrange: emoji are one character but two UTF-16 units
    const exact = '🚀'.repeat(100);
    const over = `${'a'.repeat(99)}🚀🚀`;

    // Act
    const lines = [oneLine(exact), oneLine(over), oneLine('🚀'.repeat(300))];

    // Assert
    should(lines[0]).equal(exact);
    for (const text of lines) {
      should([...text].length).be.belowOrEqual(100);
      should(
        SubtreeRowSchema.safeParse({
          id: 's',
          callsign: 'c',
          depth: 1,
          model: 'm',
          state: 'running',
          status: 'thinking',
          last: { at: '2026-11-03T12:00:00.000Z', source: 'note', text },
        }).success,
      ).be.true();
    }
  });
});

const lastLineOf = (card: BoardTask | undefined, message: SentMessage | undefined) => {
  const newest = newestLine(card, message);
  return newest === undefined ? undefined : excerptOf(newest, newest.text);
};

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

describe('newestMessageScanning', () => {
  const line = (entry: Record<string, unknown>): string => JSON.stringify(entry);
  const message = (to: string, text: string, at = '2026-11-03T10:00:00.000Z') =>
    line({ at, type: 'message', from: 'c', to, message: text });
  const sourceOf = (text: string) => {
    const bytes = Buffer.from(text, 'utf8');
    const reads: Array<readonly [number, number]> = [];
    return {
      reads,
      source: {
        size: bytes.length,
        read: async (offset: number, length: number) => {
          reads.push([offset, length]);
          return bytes.subarray(offset, offset + length);
        },
      },
    };
  };

  it('should find the newest message even when it is a single report much larger than the tail', async () => {
    // Arrange: an older note, then a 70 KB report, as the last record
    const huge = 'r'.repeat(70_000);
    const { source } = sourceOf(
      `${[message('lead', 'older note'), message('lead', huge, '2026-11-03T11:00:00.000Z')].join('\n')}\n`,
    );

    // Act
    const found = await newestMessageScanning(source, 'lead', 64 * 1024);

    // Assert
    should(found).deepEqual({ at: '2026-11-03T11:00:00.000Z', text: huge });
  });

  it('should reach back past a big report to the recipient it was not sent to, without reading the whole file', async () => {
    // Arrange: lead's message, then 200 KB of reports to someone else
    const text = [
      message('lead', 'for the lead'),
      message('other', 'x'.repeat(100_000)),
      message('other', 'y'.repeat(100_000)),
    ].join('\n');
    const { source, reads } = sourceOf(`${text}\n`);

    // Act
    const found = await newestMessageScanning(source, 'lead', 64 * 1024);
    const bounded = await newestMessageScanning(sourceOf(`${text}\n`).source, 'lead', 64 * 1024, 128 * 1024);

    // Assert
    should(found).deepEqual({ at: '2026-11-03T10:00:00.000Z', text: 'for the lead' });
    should(reads.length).be.above(1);
    should(bounded).be.undefined();
  });

  it('should decode a multi-byte character cut by a chunk edge and handle a file without a trailing newline', async () => {
    // Arrange
    const body = `${message('lead', 'first')}\n${message('lead', '🚀'.repeat(40))}`;
    const { source } = sourceOf(body);

    // Act: chunk sizes that land inside the emoji bytes
    const results = await Promise.all(
      [7, 13, 64, 1000].map(async chunk => await newestMessageScanning(source, 'lead', chunk)),
    );

    // Assert
    for (const found of results) should(found?.text).equal('🚀'.repeat(40));
  });

  it('should answer undefined for an empty file and for a recipient it never wrote to', async () => {
    should(await newestMessageScanning(sourceOf('').source, 'lead')).be.undefined();
    should(await newestMessageScanning(sourceOf(`${message('other', 'hi')}\n`).source, 'lead')).be.undefined();
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
    overrides: Partial<SubtreePorts> & { limits?: SubtreeLimits } = {},
  ) => {
    const reads = { board: 0, messages: [] as Array<readonly [string, string]> };
    const limits = overrides.limits ?? SUBTREE_LIMITS;
    const ports: SubtreePorts = {
      sessions: async () => sessions,
      board: async () => {
        reads.board += 1;
        return { cards, laneSets };
      },
      lastMessage: async (id, to) => {
        reads.messages.push([id, to]);
        return { message: messages[id], scanned: 0 };
      },
      redact: async texts => texts,
      nowMs: () => NOW,
      ...overrides,
    };
    return { reads, subject: new SubtreeService(ports, limits) };
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

  it('should show the messages sent to the asking caller, not to the root of the subtree', async () => {
    // Arrange: lead A asks for B's subtree; B's child wrote to A (the caller), and to B
    const { subject, reads } = service(
      [sessionView('a'), child('b', 'a'), child('kid', 'b')],
      {},
      {
        lastMessage: async (id, to) => ({
          message: id === 'kid' ? { at: minutesAgo(1), text: to === 'a' ? 'result for A' : 'status for B' } : undefined,
          scanned: 0,
        }),
      },
    );

    // Act
    const asked = await subject.view('b', 'a');
    const owner = await subject.view('b');

    // Assert
    should(asked?.rows[0]?.last?.text).equal('result for A');
    should(owner?.rows[0]?.last?.text).equal('status for B');
    should(reads.board).equal(0);
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

describe('SubtreeService redaction', () => {
  const SECRET = 'hunter2-s3cr3t-value';
  const mask = (text: string): string => text.replaceAll(SECRET, '[secret]');
  const redacting = async (texts: readonly string[]) => texts.map(mask);
  const ports = (sessions: ReturnType<typeof sessionView>[], overrides: Partial<SubtreePorts> = {}): SubtreePorts => ({
    sessions: async () => sessions,
    board: async () => ({
      cards: [card({ id: 'F1', history: [note(1, minutesAgo(5), `token is ${SECRET} ok`)] })],
      laneSets: new Map([[PROJECT, lanes()]]),
    }),
    lastMessage: async () => ({ message: undefined, scanned: 0 }),
    redact: redacting,
    nowMs: () => NOW,
    ...overrides,
  });
  const noteSessions = [sessionView('root'), child('ada', 'root', { focusTask: { id: 'F1' } })];

  it('should mask a secret quoted in a card note', async () => {
    // Act
    const view = await new SubtreeService(ports(noteSessions)).view('root');

    // Assert
    should(view?.rows[0]?.last?.text).equal('token is [secret] ok');
  });

  it('should mask a secret quoted in an outbox message', async () => {
    // Arrange
    const message = { at: minutesAgo(1), text: `the password is ${SECRET}` };
    const subject = new SubtreeService(
      ports([sessionView('root'), child('ada', 'root')], { lastMessage: async () => ({ message, scanned: 10 }) }),
    );

    // Act
    const view = await subject.view('root');

    // Assert
    should(view?.rows[0]?.last).deepEqual({ at: message.at, source: 'message', text: 'the password is [secret]' });
  });

  it('should redact before it cuts, so a secret straddling the cut-off is masked whole', async () => {
    // Arrange: the secret starts at character 90 and runs past the 100-character cut
    const text = `${'a'.repeat(90)}${SECRET} trailing`;
    const seen: string[] = [];
    const subject = new SubtreeService(
      ports([sessionView('root'), child('ada', 'root')], {
        lastMessage: async () => ({ message: { at: minutesAgo(1), text }, scanned: 1 }),
        redact: async texts => {
          seen.push(...texts);
          return texts.map(mask);
        },
      }),
    );

    // Act
    const view = await subject.view('root');

    // Assert
    should(seen).deepEqual([text]);
    should(view?.rows[0]?.last?.text).equal(`${'a'.repeat(90)}[secret]…`);
    should(view?.rows[0]?.last?.text).not.containEql(SECRET.slice(0, 8));
  });

  it('should redact every candidate of the table in one batch', async () => {
    // Arrange
    let batches = 0;
    const sessions = [sessionView('root'), child('ada', 'root', { focusTask: { id: 'F1' } }), child('bo', 'root')];
    const subject = new SubtreeService(
      ports(sessions, {
        lastMessage: async () => ({ message: { at: minutesAgo(1), text: 'hello' }, scanned: 1 }),
        redact: async texts => {
          batches += 1;
          return texts;
        },
      }),
    );

    // Act
    await subject.view('root');

    // Assert
    should(batches).equal(1);
  });

  it('should withhold the excerpt, never the raw text, when the redactor fails', async () => {
    // Arrange
    const subject = new SubtreeService(
      ports(noteSessions, {
        redact: async () => {
          throw new Error('vault locked');
        },
      }),
    );

    // Act
    const view = await subject.view('root');

    // Assert
    should(view?.rows[0]?.last).deepEqual({ at: minutesAgo(5), source: 'note', text: EXCERPT_WITHHELD });
    should(JSON.stringify(view)).not.containEql(SECRET);
    should(SubtreeViewSchema.parse(view)).deepEqual(view);
  });

  it('should withhold the excerpt when the redactor answers the wrong number of texts', async () => {
    // Act
    const view = await new SubtreeService(ports(noteSessions, { redact: async () => [] })).view('root');

    // Assert
    should(view?.rows[0]?.last?.text).equal(EXCERPT_WITHHELD);
  });

  it('should not call the redactor when no row has anything to say', async () => {
    // Arrange
    let calls = 0;
    const subject = new SubtreeService(
      ports([sessionView('root'), child('ada', 'root')], {
        redact: async texts => {
          calls += 1;
          return texts;
        },
      }),
    );

    // Act
    const view = await subject.view('root');

    // Assert
    should(calls).equal(0);
    should(view?.rows[0]?.last).be.undefined();
  });
});

describe('SubtreeService outbox bounds', () => {
  const many = (count: number, state: Record<string, unknown> = {}) => [
    sessionView('root'),
    ...Array.from({ length: count }, (_, index) => child(`c${String(index).padStart(3, '0')}`, 'root', {}, state)),
  ];
  const limits = (overrides: Partial<SubtreeLimits> = {}): SubtreeLimits => ({ ...SUBTREE_LIMITS, ...overrides });
  const portsFor = (sessions: ReturnType<typeof sessionView>[], lastMessage: SubtreePorts['lastMessage']) => ({
    sessions: async () => sessions,
    board: async () => ({ cards: [], laneSets: new Map() }),
    lastMessage,
    redact: async (texts: readonly string[]) => texts,
    nowMs: () => NOW,
  });
  const said = { at: minutesAgo(1), text: 'hi' };

  it('should never have more outbox reads in flight than the concurrency limit', async () => {
    // Arrange
    let inFlight = 0;
    let peak = 0;
    const subject = new SubtreeService(
      portsFor(many(40), async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise(resolve => setTimeout(resolve, 1));
        inFlight -= 1;
        return { message: said, scanned: 1 };
      }),
      limits({ concurrency: 3, excerptRows: 100 }),
    );

    // Act
    const view = await subject.view('root');

    // Assert
    should(peak).equal(3);
    should(view?.rows.every(row => row.last?.text === 'hi')).be.true();
  });

  it('should read no more rows than the row budget and list the rest without an excerpt', async () => {
    // Arrange
    const reads: string[] = [];
    const subject = new SubtreeService(
      portsFor(many(10), async id => {
        reads.push(id);
        return { message: said, scanned: 1 };
      }),
      limits({ excerptRows: 4 }),
    );

    // Act
    const view = await subject.view('root');

    // Assert
    should(reads).have.length(4);
    should(view?.rows).have.length(10);
    should(view?.rows.filter(row => row.last !== undefined)).have.length(4);
    should(view?.rows.slice(0, 4).every(row => row.last !== undefined)).be.true();
  });

  it('should cap recently ended rows and serve live rows first', async () => {
    // Arrange: the ended ones sort first by callsign, yet live rows must keep their budget
    const sessions = [
      sessionView('root'),
      ...Array.from({ length: 6 }, (_, index) =>
        child(`a-ended-${index}`, 'root', {}, { status: 'completed', finishedAt: minutesAgo(10) }),
      ),
      ...Array.from({ length: 3 }, (_, index) => child(`z-live-${index}`, 'root')),
    ];
    const reads: string[] = [];
    const subject = new SubtreeService(
      portsFor(sessions, async id => {
        reads.push(id);
        return { message: said, scanned: 1 };
      }),
      limits({ excerptRows: 4, endedRows: 2 }),
    );

    // Act
    const view = await subject.view('root');

    // Assert
    should(reads.filter(id => id.startsWith('z-live'))).have.length(3);
    should(reads.filter(id => id.startsWith('a-ended'))).have.length(1);
    should(view?.rows.filter(row => row.state === 'ended' && row.last !== undefined)).have.length(1);
    should(view?.rows).have.length(9);
  });

  it('should stop reading when the table byte budget is spent, and hand unused bytes back', async () => {
    // Arrange: 8 rows, budget for 3 full reads; each lookup reports it used all it was allowed
    const granted: number[] = [];
    const subject = new SubtreeService(
      portsFor(many(8), async (_id, _to, maxBytes) => {
        granted.push(maxBytes);
        return { message: said, scanned: maxBytes };
      }),
      limits({ concurrency: 1, outboxBytes: 300, rowBytes: 100 }),
    );

    // Act
    const view = await subject.view('root');

    // Assert
    should(granted).deepEqual([100, 100, 100]);
    should(view?.rows.filter(row => row.last !== undefined)).have.length(3);

    // Arrange: lookups that use only 10 bytes leave room for every row
    const cheap: number[] = [];
    const frugal = new SubtreeService(
      portsFor(many(8), async (_id, _to, maxBytes) => {
        cheap.push(maxBytes);
        return { message: said, scanned: 10 };
      }),
      limits({ concurrency: 1, outboxBytes: 300, rowBytes: 100 }),
    );

    // Act
    const all = await frugal.view('root');

    // Assert
    should(cheap).have.length(8);
    should(all?.rows.every(row => row.last !== undefined)).be.true();
  });

  it('should never grant more than the table budget in total, even with reads in flight', async () => {
    // Arrange
    let granted = 0;
    const subject = new SubtreeService(
      portsFor(many(30), async (_id, _to, maxBytes) => {
        granted += maxBytes;
        await new Promise(resolve => setTimeout(resolve, 1));
        return { message: undefined, scanned: maxBytes };
      }),
      limits({ concurrency: 5, outboxBytes: 1000, rowBytes: 300, excerptRows: 100 }),
    );

    // Act
    await subject.view('root');

    // Assert
    should(granted).equal(1000);
  });

  it('should keep the reservation of a read that fails after reading, so failures cannot exceed the table budget', async () => {
    // Arrange: every outbox yields one chunk and then fails, as a file that errors mid-scan does
    let bytesRead = 0;
    let attempts = 0;
    const subject = new SubtreeService(
      portsFor(many(8), async (_id, to, maxBytes) => {
        attempts += 1;
        let reads = 0;
        return await scanOutbox(
          {
            size: 1000,
            read: async (_offset, length) => {
              reads += 1;
              if (reads > 1) throw new Error('EIO');
              bytesRead += length;
              return Buffer.alloc(length, 0x61);
            },
          },
          to,
          40,
          maxBytes,
        );
      }),
      limits({ concurrency: 1, outboxBytes: 300, rowBytes: 100 }),
    );

    // Act
    const view = await subject.view('root');

    // Assert: 40 bytes were really read per row, but the whole 100 stays charged
    should(attempts).equal(3);
    should(bytesRead).be.belowOrEqual(300);
    should(view?.rows.every(row => row.last === undefined)).be.true();
  });

  it('should spend the byte budget on live rows before ended ones that sort ahead of them', async () => {
    // Arrange: eight ended rows come first in tree order and would each take a full read
    const sessions = [
      sessionView('root'),
      ...Array.from({ length: 8 }, (_, index) =>
        child(`a-ended-${index}`, 'root', {}, { status: 'completed', finishedAt: minutesAgo(10) }),
      ),
      child('z-live', 'root'),
    ];
    const reads: string[] = [];
    const subject = new SubtreeService(
      portsFor(sessions, async (id, _to, maxBytes) => {
        reads.push(id);
        return { message: said, scanned: maxBytes };
      }),
      limits({ concurrency: 1, excerptRows: 9, endedRows: 8, outboxBytes: 800, rowBytes: 100 }),
    );

    // Act
    const view = await subject.view('root');

    // Assert: the live row is read first and keeps its position as the last row
    should(reads[0]).equal('z-live');
    should(reads).have.length(8);
    should(view?.rows.at(-1)?.id).equal('z-live');
    should(view?.rows.at(-1)?.last?.text).equal('hi');
    should(view?.rows.filter(row => row.state === 'ended' && row.last !== undefined)).have.length(7);
  });

  it('should list a row whose outbox read fails, without an excerpt, rather than fail the table', async () => {
    // Arrange
    const subject = new SubtreeService(
      portsFor(many(3), async id => {
        if (id === 'c001') throw new Error('EMFILE');
        return { message: said, scanned: 1 };
      }),
    );

    // Act
    const view = await subject.view('root');

    // Assert
    should(view?.rows.map(row => row.last?.text)).deepEqual(['hi', undefined, 'hi']);
  });

  it('should keep the default budget generous for a lead with fifty live descendants', () => {
    // Arrange
    const members = subtreeMembers(many(50), 'root', NOW);

    // Act / Assert
    should(excerptEligible(members, SUBTREE_LIMITS).size).equal(50);
  });
});

describe('mapBounded', () => {
  it('should keep results in item order and never exceed the limit', async () => {
    // Arrange
    let inFlight = 0;
    let peak = 0;

    // Act
    const results = await mapBounded([5, 1, 4, 2, 3, 0], 2, async item => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, item));
      inFlight -= 1;
      return item * 10;
    });

    // Assert
    should(results).deepEqual([50, 10, 40, 20, 30, 0]);
    should(peak).equal(2);
  });

  it('should treat a non-positive limit as one and an empty list as empty', async () => {
    should(await mapBounded([1, 2], 0, async item => item)).deepEqual([1, 2]);
    should(await mapBounded([], 4, async item => item)).deepEqual([]);
  });
});

describe('scanOutbox', () => {
  const entry = (to: string, text: string) =>
    JSON.stringify({ at: '2026-11-03T10:00:00.000Z', type: 'message', from: 'c', to, message: text });

  it('should report the bytes it read, and never read past its budget even when a chunk is larger', async () => {
    // Arrange: 300 bytes of messages to someone else, none to the lead
    const bytes = Buffer.from(`${Array.from({ length: 4 }, () => entry('other', 'x'.repeat(40))).join('\n')}\n`);
    const reads: Array<readonly [number, number]> = [];
    const source = {
      size: bytes.length,
      read: async (offset: number, length: number) => {
        reads.push([offset, length]);
        return bytes.subarray(offset, offset + length);
      },
    };

    // Act
    const result = await scanOutbox(source, 'lead', 64 * 1024, 100);

    // Assert
    should(result.message).be.undefined();
    should(result.scanned).equal(100);
    should(reads.reduce((total, [, length]) => total + length, 0)).equal(100);
  });

  it('should report only what it read when it finds the message early', async () => {
    // Arrange
    const bytes = Buffer.from(`${entry('other', 'old')}\n${entry('lead', 'new')}\n`);

    // Act
    const result = await scanOutbox({ size: bytes.length, read: async (o, l) => bytes.subarray(o, o + l) }, 'lead');

    // Assert
    should(result.message?.text).equal('new');
    should(result.scanned).be.belowOrEqual(bytes.length);
  });
});
