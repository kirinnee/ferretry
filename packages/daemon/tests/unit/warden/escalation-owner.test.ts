import { describe, it } from 'bun:test';
import type { WardenAction } from '@ferretry/protocol';
import should from 'should';
import {
  isWardenEscalationItem,
  parseWardenEscalationSourceRef,
  planWardenEscalations,
  UNSUPERVISED_FLEET_KEY,
  wardenEscalationSourceRef,
  wardenFleetEscalationSourceRef,
  type WardenAnomaly,
  type WardenEscalationBoard,
  type WardenEscalationInput,
  type WardenEscalationNode,
  type WardenInvestigationRecord,
  type WardenJevHandoff,
  type WardenLayersInEffect,
  type WardenOwnerRoute,
} from '../../../src/lib/warden/index.ts';

const NOW = Date.parse('2026-10-29T12:00:00.000Z');
const at = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();

const OFF: WardenLayersInEffect = {
  jev: { configured: false, active: false, reason: 'configured' },
  llm: { configured: false, active: false, reason: 'configured' },
};

const node = (
  id = 's1',
  status: WardenEscalationNode['state']['status'] = 'thinking',
  teammate?: string,
): WardenEscalationNode => ({
  config: { id, ...(teammate === undefined ? {} : { teammate }), agent: 'claude-auto-a', model: 'sample-model-2' },
  state: { status },
});

const anomaly = (overrides: Partial<WardenAnomaly> = {}): WardenAnomaly => ({
  kind: 'sus_thinking',
  sessionId: 's1',
  status: 'thinking',
  detail: 'the transcript has not grown for 40m',
  since: at(-40),
  ...overrides,
});

const handoff = (overrides: Partial<WardenJevHandoff> = {}): WardenJevHandoff => ({
  at: at(-5),
  status: 'thinking',
  why: 'unsure',
  confidence: 0.42,
  ...overrides,
});

const jevRoute = (overrides: Partial<WardenJevHandoff> = {}, layers = OFF, flag = anomaly()): WardenOwnerRoute => ({
  anomaly: flag,
  reason: { kind: 'jev', handoff: handoff(overrides), layers },
  evidenceAt: at(-5),
});

const held = (overrides: Partial<WardenAction> = {}): WardenAction => ({
  at: at(-3),
  sessionId: 's1',
  action: 'stop',
  outcome: 'held',
  by: 'jev',
  anomalyKind: 'sus_thinking',
  detail: 'Jev recommends stopping it (99% sure): looping. It waits for you.',
  ...overrides,
});

const record = (overrides: Partial<WardenInvestigationRecord> = {}): WardenInvestigationRecord => ({
  id: 'w1',
  scope: 'session',
  origin: 'sweep',
  targetId: 's1',
  anomalyKind: 'sus_thinking',
  startedAt: at(-20),
  finishedAt: at(-10),
  reportPath: '/r.md',
  agent: 'claude-auto-b',
  model: 'sample-model-9',
  ...overrides,
});

const board = (sessionId: string, items: WardenEscalationBoard['items'] = []): WardenEscalationBoard => ({
  sessionId,
  items,
});

const item = (sourceRef: string) => ({ source: 'agent-raised' as const, sourceRef, raisedBy: 'daemon' as const });

const plan = (overrides: Partial<WardenEscalationInput> = {}) =>
  planWardenEscalations({
    anomalies: [anomaly()],
    nodes: [node('s1', 'thinking', 'atlas')],
    verdicts: [],
    boards: [board('s1')],
    remedy: { disposition: 'forbidden', why: 'no remedy is permitted here' },
    clientName: 'fy',
    routes: [jevRoute()],
    machine: 'kirin-box',
    at: at(0),
    ...overrides,
  });

describe('a Warden notification’s identity', () => {
  it('should key a ferret’s notification on the class and a machine one on the fault', () => {
    // Act / Assert
    should(wardenEscalationSourceRef('agent_frozen')).equal('warden:ask:agent_frozen');
    should(wardenFleetEscalationSourceRef('dead_monitor', UNSUPERVISED_FLEET_KEY)).equal(
      'warden:ask:fleet:dead_monitor:daemon:no-monitor-subsystem',
    );
  });

  it('should parse both identities back, every kind included', () => {
    // Act / Assert
    should(parseWardenEscalationSourceRef('warden:ask:agent_frozen')).deepEqual({
      scope: 'session',
      kind: 'agent_frozen',
    });
    should(parseWardenEscalationSourceRef('warden:ask:owner_request')).deepEqual({
      scope: 'session',
      kind: 'owner_request',
    });
    should(parseWardenEscalationSourceRef('warden:ask:fleet:dead_monitor:daemon:liveness-stalled')).deepEqual({
      scope: 'fleet',
      kind: 'dead_monitor',
      key: 'daemon:liveness-stalled',
    });
  });

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['another source', 'harness-prompt:1'],
    ['an old escalation item', 'warden:sus_thinking'],
    ['an unknown class', 'warden:ask:not_a_kind'],
    ['a machine ref with no key', 'warden:ask:fleet:dead_monitor:'],
    ['a machine ref with no kind', 'warden:ask:fleet::key'],
    ['a machine ref with no separator', 'warden:ask:fleet:dead_monitor'],
    ['a machine ref of an unknown kind', 'warden:ask:fleet:not_a_kind:key'],
  ])('should parse %s as no Warden notification', (_label, sourceRef) => {
    // Act / Assert
    should(parseWardenEscalationSourceRef(sourceRef)).be.undefined();
  });

  it('should only call a daemon’s row on the escalation source a Warden notification', () => {
    // Act / Assert
    should(isWardenEscalationItem(item('warden:ask:sus_thinking'))).be.true();
    should(isWardenEscalationItem({ ...item('warden:ask:sus_thinking'), raisedBy: 'agent' })).be.false();
    should(isWardenEscalationItem({ ...item('warden:ask:sus_thinking'), source: 'question' })).be.false();
    should(isWardenEscalationItem({ ...item('warden:ask:sus_thinking'), sourceRef: null })).be.false();
  });
});

describe('a notification the Warden’s own state raises', () => {
  it('should write a plain notification: a title, a one-line summary, the ferret and machine, why now, the remedy', () => {
    // Act
    const actual = plan().raise[0];

    // Assert
    should(actual).match({
      sessionId: 's1',
      anomalyKind: 'sus_thinking',
      subjectKey: 's1|warden:ask:sus_thinking',
      source: 'agent-raised',
      sourceRef: 'warden:ask:sus_thinking',
      title: 'atlas may be stuck thinking',
      subject: ':atlas may be stuck thinking. Open it and decide what it needs.',
      why: 'Jev looked and was not sure what to do (42% sure).',
      notice: true,
      ping: true,
      reason: 'jev',
      waitingSince: at(-40),
    });
    should(actual?.premise).equal(
      '- Ferret: :atlas on kirin-box — session s1, CLI claude-auto-a, model sample-model-2, status thinking.\n' +
        `- Seen (sus_thinking): the transcript has not grown for 40m. Anomalous since ${at(-40)}.`,
    );
    should(actual?.context).equal(
      '- Jev looked and was not sure what to do (42% sure).\n' +
        '- No investigation follows: investigations are switched off.\n' +
        '- Open it and decide what it needs.',
    );
    should(actual?.terms).match([{ term: 'Jev' }]);
    should(actual?.howToResolve).containEql('`fy send s1 <message>`');
    should(actual).not.have.property('reportPath');
  });

  it('should leave the machine out when it has no name', () => {
    // Act / Assert
    should(plan({ machine: undefined }).raise[0]?.premise).startWith('- Ferret: :atlas — session s1');
  });

  it('should keep the title and the summary inside a push, however long the name', () => {
    // Act
    const actual = plan({ nodes: [node('s1', 'thinking', 'a-very-long-teammate-callsign-indeed-x')] }).raise[0];

    // Assert
    should(actual?.title.length).be.belowOrEqual(40);
    should(actual?.title.endsWith('…')).be.true();
    should(actual?.subject.length).be.belowOrEqual(120);
  });

  it.each([
    [{ why: 'not_sure_enough', confidence: 0.61 }, 'Jev leaned one way but was only 61% sure, below your bar.'],
    [
      { why: 'never_alone', confidence: 0.97, recommends: 'stop' },
      'Jev would stop it (97% sure), but the Warden may not do that alone.',
    ],
    [{ why: 'not_allowed', confidence: 0.9 }, 'Jev would act on it (90% sure), but the Warden may not do that alone.'],
    [{ why: 'no_message', confidence: 0.8 }, 'Jev would nudge it but had no message it was sure of (80% sure).'],
    [
      { why: 'cannot_choose_login', confidence: 0.9 },
      'Jev thinks it needs another login (90% sure) and cannot choose which.',
    ],
    [{ why: 'not_offered' }, 'Jev chose an act that does not fit this flag, so it was not carried out.'],
    [{ why: 'failed', failure: 'rate_limited', confidence: 0 }, 'Jev could not answer (rate limited).'],
    [{ why: 'failed', confidence: 0 }, 'Jev could not answer.'],
    [{ why: 'already_acted' }, 'Jev already acted on this once and it is still flagged.'],
    [{ why: 'not_judgeable' }, 'Jev does not judge this kind of flag.'],
    [{ why: 'some_new_reason' }, 'Jev handed it on (some new reason).'],
  ] as const)('should say why Jev handed it on: %o', (patch, expected) => {
    // Act / Assert
    should(plan({ routes: [jevRoute(patch)] }).raise[0]?.why).equal(expected);
  });

  it('should quote what Jev said', () => {
    // Act / Assert
    should(plan({ routes: [jevRoute({ reason: 'it  keeps\nretrying' })] }).raise[0]?.context).containEql(
      '- Jev said: “it keeps retrying”',
    );
  });

  it.each([
    [{ ...OFF, llm: { configured: true, active: false, reason: 'disabled' } }, 'the Warden is off'],
    [
      { ...OFF, llm: { configured: true, active: false, reason: 'investigation_cap' } },
      'today’s investigation budget is spent',
    ],
    [{ ...OFF, llm: { configured: true, active: false, reason: 'no_login' } }, 'no investigation login is set up'],
    [{ ...OFF, llm: { configured: true, active: false, reason: 'configured' } }, 'investigations are not running'],
  ] as const)('should say why no investigation follows: %s', (layers, expected) => {
    // Act / Assert
    should(plan({ routes: [jevRoute({}, layers as WardenLayersInEffect)] }).raise[0]?.context).containEql(expected);
  });

  it('should say nothing could look at a flag, naming why each layer is off', () => {
    // Arrange
    const layers: WardenLayersInEffect = {
      jev: { configured: true, active: false, reason: 'jev_cap' },
      llm: { configured: false, active: false, reason: 'configured' },
    };
    const route: WardenOwnerRoute = { anomaly: anomaly(), reason: { kind: 'untriaged', layers } };

    // Act
    const actual = plan({ routes: [route] }).raise[0];

    // Assert
    should(actual?.why).equal(
      'Nothing could look at it: investigations are switched off, and today’s Jev budget is spent (until midnight UTC).',
    );
    should(actual?.reason).equal('untriaged');
    should(actual).not.have.property('terms');
    should(
      plan({ routes: [{ anomaly: anomaly(), reason: { kind: 'untriaged', layers: OFF } }] }).raise[0]?.why,
    ).containEql('Jev is switched off');
  });

  it('should put a held act in front of the owner, recommending it in plain words', () => {
    // Act
    const actual = plan({
      routes: [{ anomaly: anomaly(), reason: { kind: 'held', action: held() }, evidenceAt: at(-3) }],
    }).raise[0];

    // Assert
    should(actual?.why).equal('Jev recommends stopping it (99% sure): looping. It waits for you.');
    should(actual?.subject).equal(':atlas may be stuck thinking. The Warden recommends stopping it.');
    should(actual?.context).containEql('Settings › Warden › “Act alone”');
    should(actual?.terms).match([{ term: 'Jev' }]);
  });

  it('should name the report a held verdict act came from, and leave Jev out of it', () => {
    // Arrange
    const action = held({
      by: 'warden',
      action: 'restart',
      reportPath: '/r.md',
      detail: 'The Warden recommends restarting it.',
    });

    // Act
    const actual = plan({ routes: [{ anomaly: anomaly(), reason: { kind: 'held', action } }] }).raise[0];

    // Assert
    should(actual?.context).containEql('- Report: /r.md');
    should(actual?.howToResolve).containEql('The Warden recommends restarting it, with its conversation intact.');
    should(actual).not.have.property('terms');
  });

  it.each([
    ['bless', 'The Warden thinks it can be left alone.'],
    ['nudge', 'The Warden recommends a nudge.'],
    ['resume', 'The Warden recommends resuming it.'],
    ['failover', 'The Warden recommends moving it to another login.'],
  ] as const)('should say what a held %s recommends', (action, expected) => {
    // Act / Assert
    should(
      plan({ routes: [{ anomaly: anomaly(), reason: { kind: 'held', action: held({ action }) } }] }).raise[0]?.subject,
    ).containEql(expected);
  });

  it('should say what Jev recommends, and nothing it does not know', () => {
    // Act / Assert
    should(plan({ routes: [jevRoute({ recommends: 'nudge' })] }).raise[0]?.subject).containEql(
      'The Warden recommends a nudge.',
    );
    should(plan({ routes: [jevRoute({ recommends: 'dance' })] }).raise[0]?.subject).containEql(
      'Open it and decide what it needs.',
    );
  });

  it('should say an investigation failed, and who ran it', () => {
    // Act
    const full = plan({ routes: [{ anomaly: anomaly(), reason: { kind: 'investigation_failed', record: record() } }] })
      .raise[0];
    const agentOnly = plan({
      routes: [{ anomaly: anomaly(), reason: { kind: 'investigation_failed', record: record({ model: undefined }) } }],
    }).raise[0];
    const anonymous = plan({
      routes: [
        {
          anomaly: anomaly(),
          reason: { kind: 'investigation_failed', record: record({ agent: undefined, finishedAt: undefined }) },
        },
      ],
    }).raise[0];

    // Assert
    should(full?.why).equal('The Warden’s investigation finished without a verdict it could read.');
    should(full?.context).containEql(`Warden session w1, claude-auto-b / sample-model-9, finished ${at(-10)}.`);
    should(full?.context).containEql('- Report: /r.md');
    should(agentOnly?.context).containEql('Warden session w1, claude-auto-b, finished');
    should(anonymous?.context).containEql('Warden session w1, finished unknown.');
  });

  it('should date an undated flag by its evidence, then the sweep, then the beginning of time', () => {
    // Arrange
    const undated = anomaly({ since: undefined });
    const untriaged: WardenOwnerRoute = { anomaly: undated, reason: { kind: 'untriaged', layers: OFF } };

    // Act / Assert
    should(plan({ anomalies: [undated], routes: [jevRoute({}, OFF, undated)] }).raise[0]?.waitingSince).equal(at(-5));
    should(plan({ anomalies: [undated], routes: [untriaged] }).raise[0]?.waitingSince).equal(at(0));
    should(plan({ anomalies: [undated], at: undefined, routes: [untriaged] }).raise[0]?.waitingSince).equal(
      new Date(0).toISOString(),
    );
  });

  it('should raise nothing for a flag that has no reason to reach the owner', () => {
    // Act / Assert
    should(plan({ routes: [] }).raise).deepEqual([]);
    should(plan({ routes: undefined }).raise).deepEqual([]);
  });

  it('should raise nothing when an allowed repair already fixed the node', () => {
    // Act / Assert
    should(plan({ remedy: { disposition: 'applied', why: 'fixed' } }).raise).deepEqual([]);
  });

  it('should raise nothing for a ferret that has finished or that it cannot see, and still count it standing', () => {
    // Act
    const finished = plan({ nodes: [node('s1', 'completed')] });
    const unseen = plan({ nodes: [] });

    // Assert
    should(finished.raise).deepEqual([]);
    should(unseen.raise).deepEqual([]);
    should(unseen.standing).deepEqual(['s1|warden:ask:sus_thinking']);
  });

  it('should prefer an investigation’s explicit verdict over the Warden’s own reason', () => {
    // Arrange
    const verdict = {
      at: at(-2),
      targetSession: 's1',
      anomalyKind: 'sus_thinking' as const,
      verdict: 'needs_human' as const,
      explicitNeedsHuman: true,
      reason: 'It may destroy work.',
      reportPath: '/v.md',
      recommendation: { action: 'leave' as const, reason: 'it is fine' },
    };
    const migrate = { ...verdict, recommendation: { action: 'migrate' as const, reason: 'quota', agent: 'claude-b' } };

    // Act
    const actual = plan({ verdicts: [verdict] }).raise[0];
    const moved = plan({ verdicts: [migrate] }).raise[0];

    // Assert
    should(actual).match({ reason: 'needs_human', reportPath: '/v.md', why: 'It may destroy work.' });
    should(actual?.subject).containEql('The Warden thinks it can be left alone.');
    should(actual?.context).containEql('Remedy: no remedy is permitted here');
    should(moved?.subject).containEql('The Warden recommends moving it to claude-b.');
  });
});

describe('a ferret’s question that its board already asks', () => {
  const question = anomaly({ kind: 'unattended_question', status: 'awaiting_user' });
  const route: WardenOwnerRoute = { anomaly: question, reason: { kind: 'untriaged', layers: OFF } };
  const own = { source: 'question' as const, sourceRef: null, raisedBy: 'agent' as const };

  it('should raise no second notification when the ferret’s board already asks the owner', () => {
    // Act / Assert
    should(plan({ anomalies: [question], routes: [route], boards: [board('s1', [own])] }).raise).deepEqual([]);
  });

  it('should raise one when nothing on the board asks', () => {
    // Act / Assert
    should(plan({ anomalies: [question], routes: [route] }).raise).have.length(1);
  });

  it('should keep refreshing one it already raised', () => {
    // Act
    const actual = plan({
      anomalies: [question],
      routes: [route],
      boards: [board('s1', [own, item('warden:ask:unattended_question')])],
    });

    // Assert
    should(actual.raise).have.length(1);
    should(actual.resolve).deepEqual([]);
  });
});

describe('a fault that names several ferrets', () => {
  const ids = Array.from({ length: 15 }, (_, index) => `s${String(index + 1).padStart(2, '0')}`);
  const collapsed = anomaly({
    kind: 'dead_monitor',
    sessionId: 's01',
    since: undefined,
    fleetKey: UNSUPERVISED_FLEET_KEY,
    affectedSessionIds: ids,
    detail:
      'this daemon runs no per-session monitor subsystem, so no turn is watched — 15 active sessions unsupervised',
  });
  const route: WardenOwnerRoute = {
    anomaly: collapsed,
    reason: { kind: 'jev', handoff: handoff({ why: 'not_judgeable' }), layers: OFF },
  };
  const fleetPlan = (overrides: Partial<WardenEscalationInput> = {}) =>
    plan({
      anomalies: [collapsed],
      nodes: ids.map(id => node(id, 'running')),
      boards: ids.map(id => board(id)),
      routes: [route],
      ...overrides,
    });
  const fleetRef = wardenFleetEscalationSourceRef('dead_monitor', UNSUPERVISED_FLEET_KEY);

  it('should raise ONE notification for the machine, on the first ferret it names', () => {
    // Act
    const actual = fleetPlan();

    // Assert
    should(actual.raise).have.length(1);
    should(actual.raise[0]).match({
      sessionId: 's01',
      sourceRef: fleetRef,
      subjectKey: fleetRef,
      title: '15 ferrets are not being watched',
      notice: true,
      ping: true,
      reason: 'jev',
    });
    should(actual.raise[0]?.premise).startWith('- Ferrets on kirin-box: s01, s02, s03, s04, s05, s06 and 9 more.');
    should(actual.raise[0]?.howToResolve).containEql('about the machine, not one ferret');
    should(actual.raise[0]?.terms).match([{ term: 'Jev' }]);
    should(actual.standing).deepEqual([fleetRef]);
  });

  it('should keep it where the owner first saw it while that ferret still qualifies', () => {
    // Act
    const actual = fleetPlan({ boards: ids.map(id => board(id, id === 's07' ? [item(fleetRef)] : [])) });

    // Assert
    should(actual.raise.map(entry => entry.sessionId)).deepEqual(['s07']);
    should(actual.resolve).deepEqual([]);
  });

  it('should not move it once told: it clears the old one and stays quiet', () => {
    // Act
    const actual = fleetPlan({
      notified: new Set([fleetRef]),
      nodes: ids.map(id => node(id, id === 's07' ? 'completed' : 'running')),
      boards: ids.map(id => board(id, id === 's07' ? [item(fleetRef)] : [])),
    });

    // Assert
    should(actual.raise).deepEqual([]);
    should(actual.resolve).match([{ sessionId: 's07', sourceRef: fleetRef, note: /completed/u }]);
  });

  it('should move it off a ferret that has finished when the owner was not told yet', () => {
    // Act
    const actual = fleetPlan({
      nodes: ids.map(id => node(id, id === 's01' || id === 's07' ? 'completed' : 'running')),
      boards: ids.map(id => board(id, id === 's07' ? [item(fleetRef)] : [])),
    });

    // Assert
    should(actual.raise.map(entry => entry.sessionId)).deepEqual(['s02']);
    should(actual.resolve).match([{ sessionId: 's07', note: /completed/u }]);
  });

  it('should clear one on a ferret the fault no longer names', () => {
    // Act
    const actual = fleetPlan({
      nodes: [...ids, 's99'].map(id => node(id, 'running')),
      boards: [...ids, 's99'].map(id => board(id, id === 's99' ? [item(fleetRef)] : [])),
    });

    // Assert
    should(actual.raise.map(entry => entry.sessionId)).deepEqual(['s01']);
    should(actual.resolve).match([{ sessionId: 's99', note: /no longer waits on you/u }]);
  });

  it('should raise none when none of its ferrets is running', () => {
    // Act / Assert
    should(fleetPlan({ nodes: ids.map(id => node(id, 'completed')) }).raise).deepEqual([]);
  });

  it('should clear it once the fault is gone', () => {
    // Act
    const actual = fleetPlan({ anomalies: [], boards: ids.map(id => board(id, id === 's01' ? [item(fleetRef)] : [])) });

    // Assert
    should(actual.resolve).match([{ sessionId: 's01', anomalyKind: 'dead_monitor', note: /no longer detected/u }]);
    should(actual.standing).deepEqual([]);
  });

  it('should title a provider outage by its provider, and any other fault by its class', () => {
    // Arrange
    const outage = anomaly({ kind: 'provider_unavailable', provider: 'anthropic', affectedSessionIds: ['s1', 's2'] });
    const other = anomaly({ kind: 'agent_frozen', fleetKey: 'k', affectedSessionIds: ['s1'] });
    const nodes = [node('s1', 'thinking', 'atlas'), node('s2')];

    // Act
    const provider = plan({
      anomalies: [outage],
      nodes,
      boards: [board('s1'), board('s2')],
      routes: [jevRoute({}, OFF, outage)],
    });
    const generic = plan({ anomalies: [other], nodes, routes: [jevRoute({}, OFF, other)], machine: undefined });

    // Assert
    should(provider.raise[0]).match({
      title: '2 ferrets can’t reach anthropic',
      sourceRef: 'warden:ask:fleet:provider_unavailable:anthropic',
    });
    should(provider.raise[0]?.premise).startWith('- Ferrets on kirin-box: :atlas, s2.');
    should(generic.raise[0]).match({ title: '1 ferret: Session frozen', sourceRef: 'warden:ask:fleet:agent_frozen:k' });
    should(generic.raise[0]?.subject).containEql('on this machine');
  });

  it('should key an outage that names no provider on its first ferret, and list one it cannot see by id', () => {
    // Arrange
    const outage = anomaly({ kind: 'provider_unavailable', affectedSessionIds: ['s1', 'gone'] });

    // Act
    const actual = plan({ anomalies: [outage], routes: [jevRoute({}, OFF, outage)] }).raise[0];

    // Assert
    should(actual?.sourceRef).equal('warden:ask:fleet:provider_unavailable:s1');
    should(actual?.title).equal('2 ferrets: Provider is unavailable');
    should(actual?.premise).containEql(':atlas, gone.');
  });

  it('should carry the report of an explicit verdict on any ferret it names', () => {
    // Arrange
    const verdict = {
      at: at(-1),
      targetSession: 's03',
      anomalyKind: 'dead_monitor' as const,
      verdict: 'needs_human' as const,
      explicitNeedsHuman: true,
      reportPath: '/fleet.md',
    };
    const older = { ...verdict, at: at(-9), targetSession: 's02', reportPath: '/older.md' };

    // Act
    const actual = fleetPlan({ routes: [], verdicts: [older, verdict] }).raise[0];

    // Assert
    should(actual).match({
      reason: 'needs_human',
      reportPath: '/fleet.md',
      why: 'A warden judged this node and asked for a human.',
    });
  });
});

describe('a replay of a sweep that saw fifteen ferrets lose their monitor', () => {
  const ids = Array.from({ length: 15 }, (_, index) => `s${index + 1}`);
  const flags = ids.map(id =>
    anomaly({
      kind: 'dead_monitor',
      sessionId: id,
      status: 'running',
      since: undefined,
      detail: 'no live monitor handle',
    }),
  );
  const routes = flags.map((flag): WardenOwnerRoute => ({ anomaly: flag, reason: { kind: 'untriaged', layers: OFF } }));
  const replay = (boards: readonly WardenEscalationBoard[], notified?: ReadonlySet<string>) =>
    plan({
      anomalies: [...flags, ...flags],
      nodes: ids.map(id => node(id, 'running')),
      boards,
      routes,
      ...(notified === undefined ? {} : { notified }),
    });
  const keys = ids.map(id => `${id}|warden:ask:dead_monitor`);

  it('should raise at most one notification per ferret, however often a flag repeats in the sweep', () => {
    // Act
    const actual = replay(ids.map(id => board(id)));

    // Assert
    const subjects = actual.raise.map(entry => entry.subjectKey);
    should(new Set(subjects).size).equal(subjects.length);
    should(subjects.toSorted()).deepEqual(keys.toSorted());
    should(actual.standing).deepEqual(keys.toSorted());
  });

  it('should refresh those still open on the next sweep instead of adding rows, and clear none', () => {
    // Act
    const actual = replay(
      ids.map(id => board(id, [item('warden:ask:dead_monitor')])),
      new Set(keys),
    );

    // Assert
    should(actual.raise.map(entry => entry.sessionId).toSorted()).deepEqual(ids.toSorted());
    should(actual.resolve).deepEqual([]);
  });

  it('should not notify again about ones the owner read while they stood', () => {
    // Act / Assert
    should(
      replay(
        ids.map(id => board(id)),
        new Set(keys),
      ).raise,
    ).deepEqual([]);
  });
});

describe('clearing a notification whose reason has gone', () => {
  it('should clear one the Warden is handling again, saying so', () => {
    // Act
    const actual = plan({ routes: [], boards: [board('s1', [item('warden:ask:sus_thinking')])] });

    // Assert
    should(actual.resolve).deepEqual([
      {
        sessionId: 's1',
        anomalyKind: 'sus_thinking',
        source: 'agent-raised',
        sourceRef: 'warden:ask:sus_thinking',
        note: 'Cleared by the Warden: this no longer waits on you — it was left alone, cleared, or is being looked at again.',
      },
    ]);
  });

  it('should treat a ferret’s notification as current only on its own board', () => {
    // Act
    const actual = plan({
      boards: [board('s1'), board('s2', [item('warden:ask:sus_thinking')])],
      nodes: [node(), node('s2')],
    });

    // Assert
    should(actual.resolve).match([{ sessionId: 's2', note: /no longer detected/u }]);
  });

  it('should leave rows that are not Warden notifications alone', () => {
    // Act
    const actual = plan({
      routes: [],
      boards: [
        board('s1', [{ ...item('warden:ask:sus_thinking'), raisedBy: 'agent' }, item('warden:/r.md#sus_thinking')]),
      ],
    });

    // Assert
    should(actual.resolve).deepEqual([]);
  });
});
