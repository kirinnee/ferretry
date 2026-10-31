import { describe, it } from 'bun:test';
import should from 'should';
import {
  detectOverdueReports,
  type ExchangeSend,
  type OverdueMemory,
  overdueCandidates,
  type ParentExchange,
  parentExchangeOf,
  planOverdueReports,
  REPORT_OVERDUE_MS,
  type WardenSessionView,
} from '../../../src/lib/warden/index.ts';

/**
 * A sub-ferret that never answered its lead (2026-10-31): one on a spent login whose every turn ended in
 * half a second, one whose turn a provider safety block cut off. Both sat `running` at `your-turn`.
 */

const NOW = Date.parse('2026-10-31T09:00:00.000Z');
const MINUTE = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const view = (
  id: string,
  over: {
    readonly parent?: string;
    readonly teammate?: string;
    readonly state?: Partial<WardenSessionView['state']>;
    readonly mode?: 'auto' | 'interactive';
    readonly hasDoneMarker?: boolean;
  } = {},
): WardenSessionView => ({
  config: {
    id,
    mode: over.mode ?? 'auto',
    ...(over.parent === undefined ? {} : { parent: over.parent }),
    ...(over.teammate === undefined ? {} : { teammate: over.teammate }),
  },
  state: { status: 'running', ...over.state },
  hasLiveMonitor: true,
  ...(over.hasDoneMarker === undefined ? {} : { hasDoneMarker: over.hasDoneMarker }),
});

const lead = view('lead', { teammate: 'lizzette', state: { turnState: 'working' } });
/** Its turn ended 30 minutes ago and has not moved since. */
const idleChild = (over: Partial<WardenSessionView['state']> = {}) =>
  view('child', {
    parent: 'lead',
    teammate: 'rebecca',
    state: { turnState: 'your-turn', turnStateAt: iso(NOW - 30 * MINUTE), ...over },
  });

const send = (from: string, at: number, over: Partial<ExchangeSend> = {}): ExchangeSend => ({
  from,
  acceptedAt: iso(at),
  fate: 'delivered',
  ...over,
});

describe('parentExchangeOf', () => {
  it('should read the newest message each way, ignoring other senders and messages never sent', () => {
    // Arrange
    const childSends = [
      send('lead', NOW - 90 * MINUTE),
      send('lead', NOW - 31 * MINUTE, { turn: 4, replyExpected: true }),
      send('lead', NOW - 5 * MINUTE, { fate: 'withdrawn' }),
      send('someone-else', NOW - MINUTE),
    ];
    const parentSends = [send('child', NOW - 80 * MINUTE), send('other', NOW - 2 * MINUTE)];

    // Act
    const exchange = parentExchangeOf(childSends, parentSends, 'child', 'lead');

    // Assert
    should(exchange).deepEqual({
      asked: { at: iso(NOW - 31 * MINUTE), turn: 4, replyExpected: true },
      answeredAt: iso(NOW - 80 * MINUTE),
    });
  });

  it('should read nothing from ledgers with no exchange', () => {
    should(parentExchangeOf([], [], 'child', 'lead')).deepEqual({});
  });
});

describe('overdueCandidates', () => {
  it('should take an autonomous sub-ferret whose turn ended long enough ago, idle or on its quota', () => {
    // Act
    const idle = overdueCandidates([lead, idleChild()], NOW);
    const limited = overdueCandidates([lead, idleChild({ status: 'rate_limited' })], NOW);

    // Assert
    should(idle.map(candidate => [candidate.child.config.id, candidate.parent.config.id])).eql([['child', 'lead']]);
    should(limited).have.length(1);
  });

  it('should leave out a ferret still working, waiting on purpose, done, fresh, interactive, top-level or orphaned', () => {
    // Arrange
    const finishedLead = view('lead', { state: { status: 'completed' } });
    const cases: readonly (readonly WardenSessionView[])[] = [
      [lead, idleChild({ turnState: 'working' })],
      [lead, idleChild({ waiting: { since: iso(NOW - 40 * MINUTE) } })],
      [lead, { ...idleChild(), hasDoneMarker: true }],
      [lead, idleChild({ turnStateAt: iso(NOW - 5 * MINUTE) })],
      [lead, { ...idleChild(), config: { ...idleChild().config, mode: 'interactive' } }],
      [view('solo', { state: { turnState: 'your-turn', turnStateAt: iso(NOW - 30 * MINUTE) } })],
      [finishedLead, idleChild()],
      [idleChild()],
    ];

    // Act / Assert
    for (const fleet of cases) should(overdueCandidates(fleet, NOW)).be.empty();
  });
});

describe('detectOverdueReports', () => {
  const exchanges = (exchange: ParentExchange) => new Map([['child', exchange]]);

  it('should flag a sub-ferret whose parent spoke last, anchored at its turn end', () => {
    // Arrange — re-review asked at 07:29, the turn cut off at 07:30, nothing sent since.
    const candidates = overdueCandidates([lead, idleChild()], NOW);
    const exchange = {
      asked: { at: iso(NOW - 31 * MINUTE), replyExpected: false },
      answeredAt: iso(NOW - 99 * MINUTE),
    };

    // Act
    const [anomaly, ...rest] = detectOverdueReports(candidates, exchanges(exchange), NOW);

    // Assert
    should(rest).be.empty();
    should(anomaly).containDeep({
      kind: 'report_overdue',
      sessionId: 'child',
      teammate: 'rebecca',
      status: 'running',
      since: iso(NOW - 30 * MINUTE),
      idleMinutes: 30,
      subject: `report:child|asked:${iso(NOW - 31 * MINUTE)}`,
    });
    should(anomaly?.detail).containEql(":lizzette's message");
  });

  it('should say a spent login is why, and that the message asked for a reply', () => {
    // Arrange
    const candidates = overdueCandidates([lead, idleChild({ status: 'rate_limited' })], NOW);
    const exchange = { asked: { at: iso(NOW - 45 * MINUTE), replyExpected: true } };

    // Act
    const [anomaly] = detectOverdueReports(candidates, exchanges(exchange), NOW);

    // Assert
    should(anomaly?.detail).containEql('which asked for a reply');
    should(anomaly?.detail).containEql('usage limit');
  });

  it('should not flag a sub-ferret that answered after the message, or a message too fresh to be overdue', () => {
    // Arrange
    const candidates = overdueCandidates([lead, idleChild()], NOW);
    const answered = {
      asked: { at: iso(NOW - 40 * MINUTE), replyExpected: false },
      answeredAt: iso(NOW - 35 * MINUTE),
    };
    // The turn ended 30m ago, but the message landed 5m ago and has had only that long.
    const fresh = { asked: { at: iso(NOW - 5 * MINUTE), replyExpected: false } };

    // Act / Assert
    should(detectOverdueReports(candidates, exchanges(answered), NOW)).be.empty();
    should(detectOverdueReports(candidates, exchanges(fresh), NOW)).be.empty();
    should(detectOverdueReports(candidates, exchanges({}), NOW)).be.empty();
    should(detectOverdueReports(candidates, new Map(), NOW)).be.empty();
  });
});

describe('planOverdueReports', () => {
  const asked = iso(NOW - 31 * MINUTE);
  const exchanges = new Map([['child', { asked: { at: asked, replyExpected: false } }]]);
  const flagged = (fleet: readonly WardenSessionView[]) =>
    detectOverdueReports(overdueCandidates(fleet, NOW), exchanges, NOW);
  const plan = (
    fleet: readonly WardenSessionView[],
    memory: OverdueMemory = {},
    over: Partial<{ enabled: boolean; mayNudge: boolean; nowMs: number }> = {},
  ) =>
    planOverdueReports({
      overdue: flagged(fleet),
      exchanges,
      fleet,
      memory,
      enabled: over.enabled ?? true,
      mayNudge: over.mayNudge ?? true,
      clientName: 'fy',
      nowMs: over.nowMs ?? NOW,
    });

  it('should nudge the sub-ferret first, saying whom to answer and how', () => {
    // Act
    const { tell } = plan([lead, idleChild()]);

    // Assert
    should(tell.map(item => [item.kind, item.sessionId])).eql([['nudge', 'child']]);
    should(tell[0]?.message).containEql('fy send lizzette "<result>"');
    should(tell[0]?.message).containEql('fy signal done');
  });

  it('should tell the parent once the nudge has had its time, and never again', () => {
    // Arrange
    const nudged = { child: { asked, nudgedAt: iso(NOW - REPORT_OVERDUE_MS) } };
    const told = { child: { asked, nudgedAt: iso(NOW - 2 * REPORT_OVERDUE_MS), toldParentAt: iso(NOW - MINUTE) } };

    // Act
    const parent = plan([lead, idleChild()], nudged);
    const again = plan([lead, idleChild()], told);
    const tooSoon = plan([lead, idleChild()], { child: { asked, nudgedAt: iso(NOW - MINUTE) } });

    // Assert
    should(parent.tell.map(item => [item.kind, item.sessionId])).eql([['parent', 'lead']]);
    should(parent.tell[0]?.message).containEql(':rebecca has not answered your last message');
    should(parent.tell[0]?.message).containEql('nudged it at');
    should(parent.tell[0]?.message).containEql('fy migrate child --agent <runtime>');
    should(again.tell).be.empty();
    should(tooSoon.tell).be.empty();
  });

  it('should tell the parent at once when a nudge cannot help: a spent login, or no leave to nudge', () => {
    // Act
    const limited = plan([lead, idleChild({ status: 'rate_limited' })]);
    const noLeave = plan([lead, idleChild()], {}, { mayNudge: false });

    // Assert
    should(limited.tell.map(item => [item.kind, item.sessionId])).eql([['parent', 'lead']]);
    should(limited.tell[0]?.message).containEql('usage limit');
    should(noLeave.tell.map(item => item.kind)).eql(['parent']);
  });

  it('should treat a new message from the parent as a new episode', () => {
    // Arrange — the parent told about an older message; this one is new.
    const older = {
      child: {
        asked: iso(NOW - 3 * 60 * MINUTE),
        nudgedAt: iso(NOW - 3 * 60 * MINUTE),
        toldParentAt: iso(NOW - 2 * 60 * MINUTE),
      },
    };

    // Act
    const { tell } = plan([lead, idleChild()], older);

    // Assert
    should(tell.map(item => item.kind)).eql(['nudge']);
  });

  it('should tell nobody while the Warden is off, and keep memory only for sub-ferrets still alive', () => {
    // Arrange
    const memory = {
      child: { asked, nudgedAt: iso(NOW - MINUTE) },
      gone: { asked, nudgedAt: iso(NOW - MINUTE) },
      finished: { asked, nudgedAt: iso(NOW - MINUTE) },
    };
    const finished = view('finished', { parent: 'lead', state: { status: 'completed' } });

    // Act
    const off = plan([lead, idleChild(), finished], memory, { enabled: false });

    // Assert
    should(off.tell).be.empty();
    should(Object.keys(off.memory)).eql(['child']);
  });
});
