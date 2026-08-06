import { describe, it } from 'bun:test';
import should from 'should';
import {
  planWardenEscalations,
  planWardenRemedy,
  remedyPermitsEscalation,
  wardenEscalationSourceRef,
  type WardenAnomaly,
  type WardenEscalationBoard,
  type WardenEscalationInput,
  type WardenEscalationNode,
  type WardenEscalationVerdict,
  type WardenRemedyOutcome,
} from '../../../src/lib/warden/index.ts';

const NOW = Date.parse('2026-08-06T12:00:00.000Z');
const at = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();

const node = (
  overrides: {
    readonly id?: string;
    readonly teammate?: string;
    readonly agent?: string;
    readonly model?: string;
    readonly modelHint?: string;
    readonly status?: WardenEscalationNode['state']['status'];
  } = {},
): WardenEscalationNode => ({
  config: {
    id: overrides.id ?? 's1',
    ...(overrides.teammate === undefined ? {} : { teammate: overrides.teammate }),
    ...(overrides.agent === undefined ? {} : { agent: overrides.agent }),
    ...(overrides.model === undefined ? {} : { model: overrides.model }),
    ...(overrides.modelHint === undefined ? {} : { modelHint: overrides.modelHint }),
  },
  state: { status: overrides.status ?? 'thinking' },
});

const anomaly = (overrides: Partial<WardenAnomaly> = {}): WardenAnomaly => ({
  kind: 'sus_thinking',
  sessionId: 's1',
  status: 'thinking',
  detail: 'the transcript has not grown for 40m while counters advanced',
  since: at(-40),
  ...overrides,
});

const verdict = (overrides: Partial<WardenEscalationVerdict> = {}): WardenEscalationVerdict => ({
  at: at(-5),
  targetSession: 's1',
  anomalyKind: 'sus_thinking',
  verdict: 'needs_human',
  explicitNeedsHuman: true,
  reason: 'Stopping might destroy an hour of uncommitted work.',
  reportPath: '/state/warden/reports/r1.md',
  ...overrides,
});

const board = (
  sessionId: string,
  overrides: Partial<Omit<WardenEscalationBoard, 'sessionId'>> = {},
): WardenEscalationBoard => ({
  sessionId,
  items: overrides.items ?? [],
  resolved: overrides.resolved ?? [],
});

const FORBIDDEN: WardenRemedyOutcome = { disposition: 'forbidden', why: 'no remedy is permitted here' };

const plan = (overrides: Partial<WardenEscalationInput> = {}) =>
  planWardenEscalations({
    anomalies: [anomaly()],
    nodes: [node({ teammate: 'atlas', agent: 'claude-auto-a', model: 'sample-model-2' })],
    verdicts: [verdict()],
    boards: [board('s1')],
    remedy: FORBIDDEN,
    clientName: 'fy',
    ...overrides,
  });

describe('what a warden may do before waking a person', () => {
  it('should name the credential it does not hold when it may not act', () => {
    // Arrange / Act
    const outcome = planWardenRemedy({ mayAct: false });

    // Assert
    should(outcome.disposition).eql('forbidden');
    should(outcome.why).match(/holds no credential/u);
  });

  it('should name the missing policy when it could act but nothing authorises a remedy', () => {
    // Arrange / Act
    const outcome = planWardenRemedy({ mayAct: true });

    // Assert
    should(outcome.disposition).eql('forbidden');
    should(outcome.why).match(/no configured warden recovery policy/u);
  });

  it('should never claim a repair that was not attempted', () => {
    // Arrange / Act / Assert
    for (const mayAct of [true, false]) should(planWardenRemedy({ mayAct }).why).match(/No automatic repair/u);
  });

  it.each([
    { disposition: 'forbidden' as const, escalates: true },
    { disposition: 'failed' as const, escalates: true },
    { disposition: 'applied' as const, escalates: false },
  ])('should decide a $disposition remedy escalates: $escalates', ({ disposition, escalates }) => {
    // Arrange / Act / Assert
    should(remedyPermitsEscalation({ disposition, why: 'x' })).eql(escalates);
  });
});

describe('the stable identity of a node escalation', () => {
  it('should key on the anomaly class alone, so a later sweep refreshes one row', () => {
    // Arrange / Act / Assert
    should(wardenEscalationSourceRef('sus_thinking')).eql('warden:sus_thinking');
  });
});

describe('raising an escalation', () => {
  it('should raise for a suspicious node with an explicit needs-human verdict', () => {
    // Arrange / Act
    const result = plan();

    // Assert
    should(result.raise).have.length(1);
    should(result.raise[0]).match({
      sessionId: 's1',
      anomalyKind: 'sus_thinking',
      source: 'agent-raised',
      sourceRef: 'warden:sus_thinking',
      reportPath: '/state/warden/reports/r1.md',
    });
  });

  it('should carry the warden’s own reason as the why', () => {
    // Arrange / Act
    const result = plan();

    // Assert
    should(result.raise[0]?.why).eql('Stopping might destroy an hour of uncommitted work.');
  });

  it('should stand in for a verdict that recorded no reason at all', () => {
    // Arrange / Act
    const result = plan({ verdicts: [verdict({ reason: undefined })] });

    // Assert
    should(result.raise[0]?.why).match(/asked for a human/u);
  });

  it.each([
    { label: 'prose that only sounds worried', patch: { explicitNeedsHuman: undefined } },
    { label: 'a verdict of another kind', patch: { verdict: 'nudged' as const, explicitNeedsHuman: undefined } },
    { label: 'a report naming no session', patch: { targetSession: undefined } },
    { label: 'a report naming no anomaly class', patch: { anomalyKind: undefined } },
  ])('should refuse to escalate from $label', ({ patch }) => {
    // Arrange / Act
    const result = plan({ verdicts: [verdict(patch)] });

    // Assert
    should(result.raise).be.empty();
  });

  it('should refuse to escalate a class the warden judged on a different node', () => {
    // Arrange / Act
    const result = plan({ verdicts: [verdict({ targetSession: 's2' })] });

    // Assert
    should(result.raise).be.empty();
  });

  it('should refuse to escalate a class no longer in this sweep’s anomaly set', () => {
    // Arrange / Act — the report landed after the node recovered.
    const result = plan({ anomalies: [] });

    // Assert
    should(result.raise).be.empty();
  });

  it('should refuse a verdict written before the current episode began', () => {
    // Arrange — the node recovered, was flagged again, and nobody has re-judged the new episode.
    const recurrence = anomaly({ since: at(-10) });

    // Act
    const result = plan({ anomalies: [recurrence], verdicts: [verdict({ at: at(-90) })] });

    // Assert
    should(result.raise).be.empty();
  });

  it('should raise from a verdict written after the current episode began', () => {
    // Arrange / Act
    const result = plan({ anomalies: [anomaly({ since: at(-10) })], verdicts: [verdict({ at: at(-2) })] });

    // Assert
    should(result.raise).have.length(1);
  });

  it('should accept a verdict written in the very instant the episode began', () => {
    // Arrange / Act
    const result = plan({ anomalies: [anomaly({ since: at(-10) })], verdicts: [verdict({ at: at(-10) })] });

    // Assert
    should(result.raise).have.length(1);
  });

  it('should refuse the whole class when even the newest verdict predates the episode', () => {
    // Arrange / Act — the newest is still older than the episode, so no older one can cover it.
    const result = plan({
      anomalies: [anomaly({ since: at(-10) })],
      verdicts: [verdict({ at: at(-90) }), verdict({ at: at(-40) })],
    });

    // Assert
    should(result.raise).be.empty();
  });

  it('should fail closed when the episode anchor cannot be read', () => {
    // Arrange / Act — an anchor we cannot parse is not permission to assume the verdict is current.
    const result = plan({ anomalies: [anomaly({ since: 'not an instant' })] });

    // Assert
    should(result.raise).be.empty();
  });

  it('should fail closed when the verdict instant cannot be read', () => {
    // Arrange / Act
    const result = plan({ verdicts: [verdict({ at: 'not an instant' })] });

    // Assert
    should(result.raise).be.empty();
  });

  it('should still raise for a class that has no episode anchor to be stale against', () => {
    // Arrange — dead_monitor is a state, not an episode, so the detector anchors it to nothing.
    const unanchored = anomaly({ kind: 'dead_monitor', since: undefined, status: 'running' });

    // Act
    const result = plan({
      anomalies: [unanchored],
      verdicts: [verdict({ anomalyKind: 'dead_monitor', at: at(-90) })],
    });

    // Assert
    should(result.raise).have.length(1);
  });

  it('should refuse to escalate a different class from the one that was judged', () => {
    // Arrange / Act
    const result = plan({ anomalies: [anomaly({ kind: 'sus_subprocess' })] });

    // Assert
    should(result.raise).be.empty();
  });

  it('should never escalate merely because a session already has Attention', () => {
    // Arrange — a full board of ordinary rows, and no verdict anywhere.
    const busy = board('s1', {
      items: [
        { source: 'task', sourceRef: 'task:T7', raisedBy: 'agent' },
        { source: 'question', sourceRef: null, raisedBy: 'agent' },
        { source: 'agent-raised', sourceRef: null, raisedBy: 'human' },
      ],
    });

    // Act
    const result = plan({ verdicts: [], boards: [busy] });

    // Assert
    should(result.raise).be.empty();
    should(result.resolve).be.empty();
  });

  it.each(['completed', 'failed', 'stalled', 'stopped', 'kill_failed'] as const)(
    'should never raise against a %s node',
    status => {
      // Arrange / Act
      const result = plan({ nodes: [node({ status })] });

      // Assert
      should(result.raise).be.empty();
    },
  );

  it('should never raise against a node this daemon cannot see', () => {
    // Arrange / Act
    const result = plan({ nodes: [] });

    // Assert
    should(result.raise).be.empty();
  });

  it('should withhold the escalation when an allowed repair already fixed the node', () => {
    // Arrange / Act
    const result = plan({ remedy: { disposition: 'applied', why: 'the daemon resumed it and it continued' } });

    // Assert
    should(result.raise).be.empty();
  });

  it('should escalate when an allowed repair was attempted and failed', () => {
    // Arrange / Act
    const result = plan({ remedy: { disposition: 'failed', why: 'the resume was rejected by the harness' } });

    // Assert
    should(result.raise).have.length(1);
    should(result.raise[0]?.context).containEql('the resume was rejected by the harness');
  });

  it('should keep one node’s classes as separate items', () => {
    // Arrange / Act
    const result = plan({
      anomalies: [anomaly(), anomaly({ kind: 'sus_subprocess' })],
      verdicts: [verdict(), verdict({ anomalyKind: 'sus_subprocess' })],
    });

    // Assert
    should(result.raise.map(entry => entry.sourceRef)).eql(['warden:sus_subprocess', 'warden:sus_thinking']);
  });

  it('should keep two nodes’ escalations on their own boards', () => {
    // Arrange / Act
    const result = plan({
      anomalies: [anomaly(), anomaly({ sessionId: 's2' })],
      nodes: [node({ teammate: 'atlas' }), node({ id: 's2', teammate: 'boreas' })],
      verdicts: [verdict(), verdict({ targetSession: 's2' })],
      boards: [board('s1'), board('s2')],
    });

    // Assert
    should(result.raise.map(entry => entry.sessionId)).eql(['s1', 's2']);
    should(result.raise[1]?.subject).containEql(':boreas');
  });

  it('should give a fleet-wide anomaly an item on every node it names', () => {
    // Arrange
    const outage = anomaly({ kind: 'provider_unavailable', sessionId: 's1', affectedSessionIds: ['s1', 's2'] });

    // Act
    const result = plan({
      anomalies: [outage],
      nodes: [node(), node({ id: 's2' })],
      verdicts: [
        verdict({ anomalyKind: 'provider_unavailable' }),
        verdict({ targetSession: 's2', anomalyKind: 'provider_unavailable' }),
      ],
      boards: [board('s1'), board('s2')],
    });

    // Assert
    should(result.raise.map(entry => entry.sessionId)).eql(['s1', 's2']);
  });

  it('should read the newest of two verdicts for the same class', () => {
    // Arrange / Act
    const result = plan({
      verdicts: [verdict({ at: at(-50), reason: 'older' }), verdict({ at: at(-2), reason: 'newer' })],
    });

    // Assert
    should(result.raise[0]?.why).eql('newer');
  });

  it('should keep the newest verdict whatever order the reports arrive in', () => {
    // Arrange / Act
    const result = plan({
      verdicts: [verdict({ at: at(-2), reason: 'newer' }), verdict({ at: at(-50), reason: 'older' })],
    });

    // Assert
    should(result.raise[0]?.why).eql('newer');
  });

  it('should anchor the wait to the verdict when the anomaly carries no instant', () => {
    // Arrange / Act
    const result = plan({ anomalies: [anomaly({ since: undefined })] });

    // Assert
    should(result.raise[0]?.waitingSince).eql(at(-5));
  });
});

describe('the evidence an escalation carries', () => {
  it('should name the node by its teammate callsign, so a reader can link it', () => {
    // Arrange / Act
    const result = plan();

    // Assert
    should(result.raise[0]?.subject).containEql(':atlas');
    should(result.raise[0]?.context).containEql(':atlas');
  });

  it('should fall back to the bare session id when the node has no callsign', () => {
    // Arrange / Act
    const result = plan({ nodes: [node({ teammate: undefined })] });

    // Assert
    should(result.raise[0]?.subject).containEql('s1');
    should(result.raise[0]?.subject).not.containEql(':');
  });

  it('should title the item with the one name this anomaly class has', () => {
    // Arrange / Act
    const result = plan();

    // Assert
    should(result.raise[0]?.subject).containEql('Session may be stuck thinking');
  });

  it('should carry the detector’s own evidence, not a paraphrase', () => {
    // Arrange / Act
    const result = plan();

    // Assert
    should(result.raise[0]?.context).containEql('the transcript has not grown for 40m while counters advanced');
    should(result.raise[0]?.context).containEql(at(-40));
  });

  it('should carry how long the node has been idle when the detector measured it', () => {
    // Arrange / Act
    const result = plan({ anomalies: [anomaly({ idleMinutes: 40 })] });

    // Assert
    should(result.raise[0]?.context).containEql('Idle 40m');
  });

  it('should say which report the verdict came from', () => {
    // Arrange / Act
    const result = plan();

    // Assert
    should(result.raise[0]?.context).containEql('/state/warden/reports/r1.md');
    should(result.raise[0]?.context).containEql('explicit NEEDS_HUMAN');
  });

  it('should name the account and model that ran the check, from the daemon’s sidecar', () => {
    // Arrange
    const spawn = {
      v: 1 as const,
      at: at(-6),
      wardenSessionId: 'wd-1',
      agent: 'claude-auto-b',
      model: 'sample-model-9',
      modelSource: 'configured' as const,
      harness: 'claude' as const,
      policy: 'fallback' as const,
      selection: 'preferred' as const,
      configuredFirst: 'claude-auto-b',
      skipped: {},
      failedOver: false,
    };

    // Act
    const result = plan({ verdicts: [verdict({ spawn })] });

    // Assert
    should(result.raise[0]?.context).containEql('Judged by: claude-auto-b running sample-model-9');
    should(result.raise[0]?.context).containEql('wd-1');
  });

  it('should leave the judge unnamed when no sidecar was recorded', () => {
    // Arrange / Act
    const result = plan();

    // Assert
    should(result.raise[0]?.context).not.containEql('Judged by:');
  });

  it('should derive the node’s CLI and model from session metadata', () => {
    // Arrange / Act
    const result = plan();

    // Assert
    should(result.raise[0]?.context).containEql('CLI claude-auto-a, model sample-model-2');
  });

  it('should fall back to the model the start resolved when the account pinned none', () => {
    // Arrange / Act
    const result = plan({
      nodes: [node({ teammate: 'atlas', agent: 'claude-auto-a', model: undefined, modelHint: 'resolved-model-7' })],
    });

    // Assert
    should(result.raise[0]?.context).containEql('model resolved-model-7');
  });

  it('should say plainly when neither the CLI nor the model was recorded', () => {
    // Arrange / Act
    const result = plan({ nodes: [node({ teammate: 'atlas' })] });

    // Assert
    should(result.raise[0]?.context).containEql('CLI not recorded, model not recorded');
  });

  it('should state the prohibition rather than pretend a repair ran', () => {
    // Arrange / Act
    const result = plan({ remedy: planWardenRemedy({ mayAct: false }) });

    // Assert
    should(result.raise[0]?.context).containEql('holds no credential over any session');
  });

  it('should name a concrete human action in the client the person actually types', () => {
    // Arrange / Act
    const result = plan({ clientName: 'fy' });

    // Assert
    should(result.raise[0]?.howToResolve).containEql('`fy send s1 <message>`');
    should(result.raise[0]?.howToResolve).containEql('`fy resume s1`');
    should(result.raise[0]?.howToResolve).containEql('`fy stop s1`');
  });

  it('should pass on the step the warden recommended', () => {
    // Arrange
    const recommendation = { action: 'migrate' as const, reason: 'the account is out of quota', agent: 'claude-b' };

    // Act
    const result = plan({ verdicts: [verdict({ recommendation })] });

    // Assert
    should(result.raise[0]?.howToResolve).containEql('MIGRATE (claude-b): the account is out of quota');
  });

  it('should admit when the warden named no single next step', () => {
    // Arrange / Act
    const result = plan();

    // Assert
    should(result.raise[0]?.howToResolve).containEql('named no single next step');
  });

  it('should produce byte-identical text for the same evidence twice', () => {
    // Arrange / Act
    const first = plan();
    const second = plan();

    // Assert
    should(JSON.stringify(first)).eql(JSON.stringify(second));
  });

  it('should keep the subject inside one line, whatever the class name is', () => {
    // Arrange / Act
    const result = plan();

    // Assert
    should(result.raise[0]?.subject).not.match(/[\r\n]/u);
  });

  it('should trim a subject too long for the board rather than have the write refused', () => {
    // Arrange / Act
    const result = plan({ nodes: [node({ teammate: 'x'.repeat(400), agent: 'a' })] });

    // Assert
    should((result.raise[0]?.subject ?? '').length).be.belowOrEqual(240);
    should(result.raise[0]?.subject).endWith('…');
  });

  it('should trim an over-long context rather than have the write refused', () => {
    // Arrange / Act
    const result = plan({ anomalies: [anomaly({ detail: 'd'.repeat(4_000) })] });

    // Assert
    should((result.raise[0]?.context ?? '').length).be.belowOrEqual(2_048);
  });
});

describe('suppressing an escalation a person already answered', () => {
  const addressed = (resolvedAt: string): WardenEscalationBoard =>
    board('s1', { resolved: [{ source: 'agent-raised', sourceRef: 'warden:sus_thinking', resolvedAt }] });

  it('should not resurrect an item addressed after the verdict was written', () => {
    // Arrange / Act
    const result = plan({ boards: [addressed(at(-1))] });

    // Assert
    should(result.raise).be.empty();
  });

  it('should not resurrect an item addressed in the same instant as the verdict', () => {
    // Arrange / Act
    const result = plan({ boards: [addressed(at(-5))] });

    // Assert
    should(result.raise).be.empty();
  });

  it('should let a genuinely newer verdict raise again', () => {
    // Arrange / Act
    const result = plan({ boards: [addressed(at(-10))], verdicts: [verdict({ at: at(-1) })] });

    // Assert
    should(result.raise).have.length(1);
  });

  it('should ignore a resolution of some other class on the same board', () => {
    // Arrange
    const other = board('s1', {
      resolved: [{ source: 'agent-raised', sourceRef: 'warden:sus_subprocess', resolvedAt: at(-1) }],
    });

    // Act
    const result = plan({ boards: [other] });

    // Assert
    should(result.raise).have.length(1);
  });

  it('should ignore an addressed row that carries no source reference at all', () => {
    // Arrange
    const freeform = board('s1', { resolved: [{ source: 'agent-raised', sourceRef: null, resolvedAt: at(-1) }] });

    // Act
    const result = plan({ boards: [freeform] });

    // Assert
    should(result.raise).have.length(1);
  });

  it('should treat an unreadable resolution instant as the beginning of time', () => {
    // Arrange / Act
    const result = plan({ boards: [addressed('not an instant')] });

    // Assert
    should(result.raise).have.length(1);
  });

  it('should keep the newest of several resolutions of the same item', () => {
    // Arrange
    const twice = board('s1', {
      resolved: [
        { source: 'agent-raised', sourceRef: 'warden:sus_thinking', resolvedAt: at(-30) },
        { source: 'agent-raised', sourceRef: 'warden:sus_thinking', resolvedAt: at(-1) },
      ],
    });

    // Act
    const result = plan({ boards: [twice] });

    // Assert
    should(result.raise).be.empty();
  });
});

describe('clearing an escalation whose reason has gone', () => {
  const live = board('s1', {
    items: [{ source: 'agent-raised', sourceRef: 'warden:sus_thinking', raisedBy: 'daemon' }],
  });

  it('should clear it when the node stops being flagged for that class', () => {
    // Arrange / Act
    const result = plan({ anomalies: [], boards: [live] });

    // Assert
    should(result.resolve).have.length(1);
    should(result.resolve[0]).match({ sessionId: 's1', sourceRef: 'warden:sus_thinking', anomalyKind: 'sus_thinking' });
    should(result.resolve[0]?.note).match(/recovered/u);
  });

  it('should keep it while the node is still flagged for that class', () => {
    // Arrange / Act
    const result = plan({ boards: [live] });

    // Assert
    should(result.resolve).be.empty();
  });

  it('should clear it when the node reaches a terminal status', () => {
    // Arrange / Act
    const result = plan({ nodes: [node({ status: 'stopped' })], boards: [live] });

    // Assert
    should(result.resolve[0]?.note).match(/is stopped and is no longer running/u);
  });

  it('should clear it when the node has left the fleet entirely', () => {
    // Arrange / Act
    const result = plan({ nodes: [], boards: [live] });

    // Assert
    should(result.resolve[0]?.note).match(/no longer in the fleet/u);
  });

  it.each([
    { label: 'a row somebody else raised', patch: { raisedBy: 'agent' as const } },
    { label: 'a row on another source', patch: { source: 'task' as const } },
    { label: 'a row with no source reference', patch: { sourceRef: null } },
    { label: 'a reference that is not a warden one', patch: { sourceRef: 'task:T3' } },
    { label: 'a reference naming one exact report block', patch: { sourceRef: 'warden:/r/a.md#sus_thinking' } },
    { label: 'a reference naming a report and no class', patch: { sourceRef: 'warden:/r/a.md' } },
    { label: 'a reference naming no known class', patch: { sourceRef: 'warden:not_a_kind' } },
  ])('should leave $label alone', ({ patch }) => {
    // Arrange
    const foreign = board('s1', {
      items: [{ source: 'agent-raised', sourceRef: 'warden:sus_thinking', raisedBy: 'daemon', ...patch }],
    });

    // Act
    const result = plan({ anomalies: [], boards: [foreign] });

    // Assert
    should(result.resolve).be.empty();
  });

  it('should clear one class while another on the same node is raised', () => {
    // Arrange
    const both = board('s1', {
      items: [
        { source: 'agent-raised', sourceRef: 'warden:sus_thinking', raisedBy: 'daemon' },
        { source: 'agent-raised', sourceRef: 'warden:sus_subprocess', raisedBy: 'daemon' },
      ],
    });

    // Act
    const result = plan({ boards: [both] });

    // Assert
    should(result.resolve.map(entry => entry.anomalyKind)).eql(['sus_subprocess']);
    should(result.raise.map(entry => entry.anomalyKind)).eql(['sus_thinking']);
  });

  it('should clear in a deterministic order across nodes and classes', () => {
    // Arrange
    const boards = [
      board('s2', { items: [{ source: 'agent-raised', sourceRef: 'warden:sus_thinking', raisedBy: 'daemon' }] }),
      board('s1', {
        items: [
          { source: 'agent-raised', sourceRef: 'warden:sus_thinking', raisedBy: 'daemon' },
          { source: 'agent-raised', sourceRef: 'warden:dead_monitor', raisedBy: 'daemon' },
        ],
      }),
    ];

    // Act
    const result = plan({ anomalies: [], nodes: [node(), node({ id: 's2' })], boards });

    // Assert
    should(result.resolve.map(entry => `${entry.sessionId}/${entry.anomalyKind}`)).eql([
      's1/dead_monitor',
      's1/sus_thinking',
      's2/sus_thinking',
    ]);
  });
});
