import { describe, it } from 'bun:test';
import should from 'should';
import {
  buildWardenAttentionView,
  fallbackRecommendation,
  verdictMatchForItem,
  WARDEN_ATTENTION_VERDICT_LIMIT,
  type AttentionBoardInput,
  type AttentionItem,
  type FleetSessionLike,
  type JudgedVerdict,
  type WardenAnomaly,
  type WardenAttentionInput,
  type WardenJudgement,
} from '../../../src/lib/warden/index.ts';

const NOW = Date.parse('2026-07-30T12:00:00.000Z');
const at = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();

const session = (
  id: string,
  overrides: Partial<FleetSessionLike['config']> = {},
  status = 'running',
): FleetSessionLike => ({
  config: { id, ...overrides },
  state: { status: status as FleetSessionLike['state']['status'] },
});

const boardItem = (overrides: Partial<AttentionItem> = {}): AttentionItem => ({
  id: 'A1',
  source: 'agent-raised',
  subject: 'Needs a decision',
  why: 'The teammate cannot proceed',
  waitingSince: at(-30),
  howToResolve: 'Answer in the session',
  ...overrides,
});

const board = (sessionId: string, items: readonly AttentionItem[], parseErrors = 0): AttentionBoardInput => ({
  sessionId,
  parseErrors,
  items,
});

const anomaly = (overrides: Partial<WardenAnomaly> = {}): WardenAnomaly => ({
  kind: 'sus_thinking',
  sessionId: 's1',
  status: 'thinking',
  detail: 'the transcript has not grown for 30m',
  since: at(-30),
  ...overrides,
});

const view = (overrides: Partial<WardenAttentionInput> = {}) =>
  buildWardenAttentionView({
    now: NOW,
    sessions: [session('s1', { teammate: 'atlas', label: 'batch-7' })],
    boards: [],
    verdicts: [],
    anomalies: [],
    wardenState: { lastSweepAt: at(-1) },
    ...overrides,
  });

describe('verdict selectors for a board row', () => {
  it('should judge a question row by the unattended-question class', () => {
    // Arrange / Act / Assert
    should(verdictMatchForItem(boardItem({ source: 'question' }))).eql({ anomalyKind: 'unattended_question' });
  });

  it('should judge a provider row by the provider-unavailable class', () => {
    // Arrange / Act
    const match = verdictMatchForItem(boardItem({ sourceRef: 'provider-unavailable:acme' }));

    // Assert
    should(match).eql({ anomalyKind: 'provider_unavailable' });
  });

  it('should read a warden reference into its exact identity', () => {
    // Arrange / Act
    const match = verdictMatchForItem(boardItem({ sourceRef: 'warden:/r/a.md#sus_thinking' }));

    // Assert
    should(match).eql({ reportPath: '/r/a.md', anomalyKind: 'sus_thinking' });
  });

  it.each([
    { label: 'a task row', item: boardItem({ source: 'task', sourceRef: 'warden:/r/a.md' }) },
    { label: 'an agent-raised row with no reference', item: boardItem({}) },
    { label: 'an agent-raised row with an unrelated reference', item: boardItem({ sourceRef: 'task:T3' }) },
  ])('should give $label no verdict selector at all', ({ item }) => {
    // Arrange / Act / Assert
    should(verdictMatchForItem(item)).be.undefined();
  });
});

describe('fallback recommendations', () => {
  it.each([
    { verdict: 'cleared' as const, reason: 'found the work healthy' },
    { verdict: 'nudged' as const, reason: 'already nudged' },
    { verdict: 'revived' as const, reason: 'already resumed' },
    { verdict: 'killed' as const, reason: 'already stopped' },
  ])('should recommend leaving a $verdict session alone', ({ verdict, reason }) => {
    // Arrange
    const judgement: WardenJudgement = { state: 'judged', verdict, reason: 'x' };

    // Act
    const recommendation = fallbackRecommendation(judgement, 'running', undefined);

    // Assert
    should(recommendation.action).eql('leave');
    should(recommendation.reason).containEql(reason);
  });

  it('should prefer the recommendation the report itself gave', () => {
    // Arrange
    const given = { action: 'migrate' as const, reason: 'move it', agent: 'reserve-account' };

    // Act
    const recommendation = fallbackRecommendation(
      { state: 'judged', reason: 'x', recommendation: given },
      'running',
      undefined,
    );

    // Assert
    should(recommendation).be.exactly(given);
  });

  it.each([
    { label: 'an interrupted session', status: 'interrupted', kind: undefined },
    { label: 'a session that lost its monitor', status: 'running', kind: 'dead_monitor' as const },
  ])('should recommend restarting $label', ({ status, kind }) => {
    // Arrange / Act
    const recommendation = fallbackRecommendation({ state: 'none', reason: 'x' }, status, kind);

    // Assert
    should(recommendation.action).eql('restart');
  });

  it('should soften the nudge while a warden is still investigating', () => {
    // Arrange / Act
    const recommendation = fallbackRecommendation({ state: 'pending', reason: 'x' }, 'running', 'sus_thinking');

    // Assert
    should(recommendation.action).eql('nudge');
    should(recommendation.reason).containEql('A warden is checking it');
  });

  it('should recommend a plain nudge when nothing else applies', () => {
    // Arrange / Act
    const recommendation = fallbackRecommendation({ state: 'none', reason: 'x' }, 'running', 'sus_thinking');

    // Assert
    should(recommendation.reason).containEql('restate its blocker');
  });

  it('should not treat an unclassifiable verdict as a reason to leave it alone', () => {
    // Arrange / Act
    const recommendation = fallbackRecommendation(
      { state: 'failed', verdict: 'unknown', reason: 'x' },
      'running',
      undefined,
    );

    // Assert
    should(recommendation.action).eql('nudge');
  });
});

describe('board rows in the fleet view', () => {
  it('should carry the session identity onto every row', () => {
    // Arrange / Act
    const result = view({ boards: [board('s1', [boardItem()])] });

    // Assert
    should(result.items).have.length(1);
    should(result.items[0]).match({
      sessionId: 's1',
      teammate: 'atlas',
      label: 'batch-7',
      sessionStatus: 'running',
      id: 'A1',
      source: 'agent-raised',
    });
  });

  it('should fall back to the session name when no teammate is set', () => {
    // Arrange / Act
    const result = view({ sessions: [session('s1', { name: 'Fix Scrolling' })], boards: [board('s1', [boardItem()])] });

    // Assert
    should(result.items[0]?.teammate).eql('Fix Scrolling');
  });

  it('should never resurrect a row belonging to a terminal session', () => {
    // Arrange / Act
    const result = view({ sessions: [session('s1', {}, 'stalled')], boards: [board('s1', [boardItem()])] });

    // Assert
    should(result.items).be.empty();
    should(result.outcome).eql('clean-sweep');
  });

  it('should surface the provider a provider-wide row belongs to', () => {
    // Arrange / Act
    const result = view({ boards: [board('s1', [boardItem({ sourceRef: 'provider-unavailable:acme' })])] });

    // Assert
    should(result.items[0]?.provider).eql('acme');
  });

  it('should carry the optional board fields through untouched', () => {
    // Arrange
    const item = boardItem({ context: 'background', raisedBy: 'agent', raisedByName: 'atlas' });

    // Act
    const result = view({ boards: [board('s1', [item])] });

    // Assert
    should(result.items[0]).match({ context: 'background', raisedBy: 'agent', raisedByName: 'atlas' });
  });

  it('should order the fleet oldest waiting first, breaking ties deterministically', () => {
    // Arrange
    const boards = [
      board('s2', [boardItem({ id: 'A1', waitingSince: at(-10) })]),
      board('s1', [boardItem({ id: 'A2', waitingSince: at(-10) }), boardItem({ id: 'A1', waitingSince: at(-90) })]),
    ];

    // Act
    const result = view({ sessions: [session('s1'), session('s2')], boards });

    // Assert
    should(result.items.map(item => `${item.sessionId}/${item.id}`)).eql(['s1/A1', 's1/A2', 's2/A1']);
  });
});

describe('judging a board row', () => {
  const verdict = (overrides: Partial<JudgedVerdict> = {}): JudgedVerdict => ({
    at: at(-5),
    targetSession: 's1',
    verdict: 'cleared',
    reportPath: '/r/a.md',
    reason: 'the build was genuinely running',
    ...overrides,
  });

  it('should attach the verdict written for that exact report block', () => {
    // Arrange
    const item = boardItem({ sourceRef: 'warden:/r/a.md#sus_thinking' });

    // Act
    const result = view({ boards: [board('s1', [item])], verdicts: [verdict({ anomalyKind: 'sus_thinking' })] });

    // Assert
    should(result.items[0]?.judgement).match({
      state: 'judged',
      verdict: 'cleared',
      reason: 'the build was genuinely running',
      reportPath: '/r/a.md',
    });
  });

  it('should name who ran the check when the sidecar recorded it', () => {
    // Arrange
    const spawn = { wardenSessionId: 'wd-1', agent: 'reserve-account', model: 'sample-model-2', harness: 'claude' };

    // Act
    const result = view({
      boards: [board('s1', [boardItem({ sourceRef: 'warden:/r/a.md' })])],
      verdicts: [verdict({ spawn })],
    });

    // Assert
    should(result.items[0]?.judgement.judgedBy).eql(spawn);
  });

  it('should leave the judge unnamed when the sidecar recorded nothing useful', () => {
    // Arrange / Act
    const result = view({
      boards: [board('s1', [boardItem({ sourceRef: 'warden:/r/a.md' })])],
      verdicts: [verdict({ spawn: {} })],
    });

    // Assert
    should(result.items[0]?.judgement.judgedBy).be.undefined();
  });

  it('should report an unclassifiable verdict as a failure rather than a clearance', () => {
    // Arrange / Act
    const result = view({
      boards: [board('s1', [boardItem({ sourceRef: 'warden:/r/a.md' })])],
      verdicts: [verdict({ verdict: 'unknown', reason: undefined })],
    });

    // Assert
    should(result.items[0]?.judgement).match({
      state: 'failed',
      verdict: 'unknown',
      reason: 'The warden report could not be classified.',
    });
  });

  it('should supply a reason when the report gave none', () => {
    // Arrange / Act
    const result = view({
      boards: [board('s1', [boardItem({ sourceRef: 'warden:/r/a.md' })])],
      verdicts: [verdict({ reason: undefined })],
    });

    // Assert
    should(result.items[0]?.judgement.reason).eql('A warden reached a verdict on this session.');
  });

  it('should mark a kind-matched verdict that predates the wait as stale', () => {
    // Arrange
    const item = boardItem({ source: 'question', waitingSince: at(-2) });

    // Act
    const result = view({
      boards: [board('s1', [item])],
      verdicts: [verdict({ at: at(-30), anomalyKind: 'unattended_question' })],
    });

    // Assert
    should(result.items[0]?.judgement.stale).be.true();
  });

  it('should not call a report-matched verdict stale for trailing by milliseconds', () => {
    // Arrange
    const item = boardItem({ sourceRef: 'warden:/r/a.md', waitingSince: at(-4) });

    // Act
    const result = view({ boards: [board('s1', [item])], verdicts: [verdict({ at: at(-5) })] });

    // Assert
    should(result.items[0]?.judgement.stale).be.undefined();
  });

  it('should prefer the needs-human block when one report holds several for a session', () => {
    // Arrange
    const verdicts = [
      verdict({ verdict: 'cleared', anomalyKind: 'sus_thinking' }),
      verdict({ verdict: 'needs_human', anomalyKind: 'dead_monitor', reason: 'nothing safe to do' }),
    ];

    // Act
    const result = view({ boards: [board('s1', [boardItem({ sourceRef: 'warden:/r/a.md' })])], verdicts });

    // Assert
    should(result.items[0]?.judgement.verdict).eql('needs_human');
  });

  it('should keep the newest verdict for a repeated anomaly class', () => {
    // Arrange
    const verdicts = [
      verdict({ at: at(-50), anomalyKind: 'unattended_question', reason: 'older' }),
      verdict({ at: at(-5), anomalyKind: 'unattended_question', reason: 'newer' }),
    ];

    // Act
    const result = view({ boards: [board('s1', [boardItem({ source: 'question' })])], verdicts });

    // Assert
    should(result.items[0]?.judgement.reason).eql('newer');
  });

  it('should ignore a verdict that names no target', () => {
    // Arrange / Act
    const result = view({
      boards: [board('s1', [boardItem({ sourceRef: 'warden:/r/a.md' })])],
      verdicts: [verdict({ targetSession: undefined })],
    });

    // Assert
    should(result.items[0]?.judgement.state).eql('none');
  });

  it('should say a warden is investigating when the anomaly is assigned', () => {
    // Arrange
    const wardenState = { lastSweepAt: at(-1), assignments: { s1: { kinds: ['unattended_question'] } } };

    // Act
    const result = view({ boards: [board('s1', [boardItem({ source: 'question' })])], wardenState });

    // Assert
    should(result.items[0]?.judgement).match({
      state: 'pending',
      reason: 'A warden is investigating this anomaly now.',
    });
  });

  it('should require both identities to match an assignment recorded with a report path', () => {
    // Arrange
    const item = boardItem({ sourceRef: 'warden:/r/a.md#sus_thinking' });
    const assigned = {
      lastSweepAt: at(-1),
      assignments: { s1: { reportPath: '/r/other.md', kinds: ['sus_thinking'] } },
    };

    // Act
    const result = view({ boards: [board('s1', [item])], wardenState: assigned });

    // Assert
    should(result.items[0]?.judgement.state).eql('none');
  });

  it('should ignore an assignment recording an unknown anomaly kind', () => {
    // Arrange
    const wardenState = { lastSweepAt: at(-1), assignments: { s1: { kinds: ['vibes'] } } };

    // Act
    const result = view({ boards: [board('s1', [boardItem({ source: 'question' })])], wardenState });

    // Assert
    should(result.items[0]?.judgement.state).eql('none');
  });

  it('should say an anomaly is queued when it is waiting for a slot', () => {
    // Arrange
    const wardenState = { lastSweepAt: at(-1), assignedQueue: [{ sessionId: 's1', kind: 'unattended_question' }] };

    // Act
    const result = view({ boards: [board('s1', [boardItem({ source: 'question' })])], wardenState });

    // Assert
    should(result.items[0]?.judgement).match({ state: 'queued' });
  });

  it('should ignore a queue entry missing a session or a readable kind', () => {
    // Arrange
    const wardenState = { lastSweepAt: at(-1), assignedQueue: [{ kind: 'unattended_question' }, { sessionId: 's1' }] };

    // Act
    const result = view({ boards: [board('s1', [boardItem({ source: 'question' })])], wardenState });

    // Assert
    should(result.items[0]?.judgement.state).eql('none');
  });

  it('should report exhaustion as the reason no judgement exists', () => {
    // Arrange
    const wardenState = { lastSweepAt: at(-1), exhaustedSince: at(-20) };

    // Act
    const result = view({ boards: [board('s1', [boardItem({ source: 'question' })])], wardenState });

    // Assert
    should(result.items[0]?.judgement).match({
      state: 'failed',
      reason: 'No warden could run — every warden account is exhausted.',
      at: at(-20),
    });
  });

  it('should admit the judgement may simply be outside the visible window', () => {
    // Arrange
    const coverage = { limit: 100, truncated: true };

    // Act
    const result = view({ boards: [board('s1', [boardItem({ source: 'question' })])], verdictCoverage: coverage });

    // Assert
    should(result.items[0]?.judgement.reason).containEql('recent 100-verdict window');
  });

  it('should never let an ordinary task row inherit fleet-wide warden state', () => {
    // Arrange
    const wardenState = { lastSweepAt: at(-1), exhaustedSince: at(-20) };

    // Act
    const result = view({ boards: [board('s1', [boardItem({ source: 'task' })])], wardenState });

    // Assert
    should(result.items[0]?.judgement).eql({
      state: 'none',
      reason: 'No matching warden judgement applies to this attention item.',
    });
  });

  it('should default the coverage window when the caller states none', () => {
    // Arrange / Act
    const result = view();

    // Assert
    should(result.verdictCoverage).eql({ limit: WARDEN_ATTENTION_VERDICT_LIMIT, truncated: false });
  });
});

describe('anomalies with no board row', () => {
  it('should surface an unjudged anomaly so nobody is silently stuck', () => {
    // Arrange / Act
    const result = view({ anomalies: [anomaly()] });

    // Assert
    should(result.items).have.length(1);
    should(result.items[0]).match({
      id: 'anomaly:sus_thinking:s1',
      source: 'warden-anomaly',
      subject: 'Session may be stuck thinking',
      why: 'the transcript has not grown for 30m',
      fromAnomaly: true,
    });
  });

  it('should stay quiet about an anomaly a current verdict cleared', () => {
    // Arrange
    const verdicts: JudgedVerdict[] = [
      { at: at(-1), targetSession: 's1', verdict: 'cleared', anomalyKind: 'sus_thinking', reportPath: '/r/a.md' },
    ];

    // Act
    const result = view({ anomalies: [anomaly()], verdicts });

    // Assert
    should(result.items).be.empty();
  });

  it('should surface an anomaly whose only verdict judged an earlier situation', () => {
    // Arrange
    const verdicts: JudgedVerdict[] = [
      { at: at(-90), targetSession: 's1', verdict: 'cleared', anomalyKind: 'sus_thinking', reportPath: '/r/a.md' },
    ];

    // Act
    const result = view({ anomalies: [anomaly()], verdicts });

    // Assert
    should(result.items).have.length(1);
    should(result.items[0]?.judgement.stale).be.true();
  });

  it('should keep surfacing an anomaly the warden explicitly escalated', () => {
    // Arrange
    const verdicts: JudgedVerdict[] = [
      { at: at(-1), targetSession: 's1', verdict: 'needs_human', anomalyKind: 'sus_thinking', reportPath: '/r/a.md' },
    ];

    // Act
    const result = view({ anomalies: [anomaly()], verdicts });

    // Assert
    should(result.items).have.length(1);
    should(result.items[0]?.judgement.verdict).eql('needs_human');
  });

  it('should not duplicate an anomaly that already has a board row', () => {
    // Arrange
    const boards = [board('s1', [boardItem({ source: 'question' })])];

    // Act
    const result = view({ boards, anomalies: [anomaly({ kind: 'unattended_question', status: 'awaiting_question' })] });

    // Assert
    should(result.items.map(item => item.id)).eql(['A1']);
  });

  it('should treat a report-referenced board row as covering the anomaly its verdict judged', () => {
    // Arrange
    const boards = [board('s1', [boardItem({ sourceRef: 'warden:/r/a.md' })])];
    const verdicts: JudgedVerdict[] = [
      { at: at(-1), targetSession: 's1', verdict: 'needs_human', anomalyKind: 'sus_thinking', reportPath: '/r/a.md' },
    ];

    // Act
    const result = view({ boards, verdicts, anomalies: [anomaly()] });

    // Assert
    should(result.items.map(item => item.id)).eql(['A1']);
  });

  it('should ignore an anomaly on a session that has already gone terminal', () => {
    // Arrange / Act
    const result = view({ sessions: [session('s1', {}, 'failed')], anomalies: [anomaly()] });

    // Assert
    should(result.items).be.empty();
  });

  it('should judge an anomaly by its own recorded status when the session is unknown', () => {
    // Arrange / Act
    const result = view({ sessions: [], anomalies: [anomaly({ status: 'stopped' })] });

    // Assert
    should(result.items).be.empty();
  });

  it('should fall back to the identity the anomaly itself carries', () => {
    // Arrange / Act
    const result = view({ sessions: [], anomalies: [anomaly({ teammate: 'nova', label: 'batch-2' })] });

    // Assert
    should(result.items[0]).match({ teammate: 'nova', label: 'batch-2', sessionStatus: 'thinking' });
  });

  it('should expand a provider outage to every session it affects, once each', () => {
    // Arrange
    const outage = anomaly({
      kind: 'provider_unavailable',
      sessionId: 's1',
      affectedSessionIds: ['s1', 's2'],
      provider: 'acme',
      status: 'failed',
    });

    // Act
    const result = view({
      sessions: [session('s1'), session('s2')],
      anomalies: [outage, outage],
    });

    // Assert
    should(result.items.map(item => item.sessionId)).eql(['s1', 's2']);
    should(result.items[0]?.provider).eql('acme');
  });

  it('should anchor an anomaly with no instant of its own to the last sweep', () => {
    // Arrange / Act
    const result = view({ anomalies: [anomaly({ since: undefined })] });

    // Assert
    should(result.items[0]?.waitingSince).eql(at(-1));
  });

  it('should anchor an anomaly to now when nothing else is known', () => {
    // Arrange / Act
    const result = view({ anomalies: [anomaly({ since: undefined })], wardenState: {} });

    // Assert
    should(result.items[0]?.waitingSince).eql(at(0));
  });
});

describe('fleet outcome and degradation', () => {
  it('should report a clean sweep when a sweep ran and nothing is waiting', () => {
    // Arrange / Act
    const result = view();

    // Assert
    should(result.outcome).eql('clean-sweep');
    should(result.wardenDegraded).be.undefined();
    should(result.generatedAt).eql(at(0));
    should(result.lastSweepAt).eql(at(-1));
  });

  it('should distinguish "no sweep has run" from "nothing is waiting"', () => {
    // Arrange / Act
    const result = view({ wardenState: {} });

    // Assert
    should(result.outcome).eql('no-sweep');
    should(result.lastSweepAt).be.undefined();
  });

  it('should report items whenever any row exists', () => {
    // Arrange / Act
    const result = view({ boards: [board('s1', [boardItem()])] });

    // Assert
    should(result.outcome).eql('items');
  });

  it('should never call a sweep clean when a board could not be read', () => {
    // Arrange / Act
    const result = view({ boards: [board('s1', [], 3)] });

    // Assert
    should(result.outcome).eql('degraded');
    should(result.boardsWithParseErrors).eql([{ sessionId: 's1', parseErrors: 3 }]);
    should(result.wardenDegraded?.reason).containEql('attention boards could not be read');
  });

  it('should flag an overdue sweep', () => {
    // Arrange / Act
    const result = view({ wardenState: { lastSweepAt: at(-60) } });

    // Assert
    should(result.wardenDegraded).eql({
      since: at(-60),
      reason: 'Warden sweeps are overdue — judgements may be out of date.',
    });
  });

  it('should judge sweep staleness against the configured cadence', () => {
    // Arrange / Act
    const result = view({ wardenState: { lastSweepAt: at(-60) }, sweepIntervalMinutes: 30 });

    // Assert
    should(result.wardenDegraded).be.undefined();
  });

  it('should let exhaustion outrank an overdue sweep in the banner', () => {
    // Arrange / Act
    const result = view({ wardenState: { lastSweepAt: at(-60), exhaustedSince: at(-20) } });

    // Assert
    should(result.wardenDegraded).eql({
      since: at(-20),
      reason: 'All warden accounts are exhausted — new judgements are paused.',
    });
  });
});
