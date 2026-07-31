import { describe, it } from 'bun:test';
import should from 'should';
import {
  ageLabel,
  compactQuota,
  displayModel,
  quotaLabel,
  renderSessionTable,
  renderSessionView,
  statusLabel,
  TERMINAL_STATUSES,
} from '../../../src/lib/session/display.ts';
import { sessionView } from './session-fixtures.ts';

const NOW = Date.parse('2026-01-01T00:10:00.000Z');

describe('displayModel', () => {
  const cases: readonly (readonly [
    string,
    { model?: string; modelHint: string },
    { observedModel?: string },
    string,
  ])[] = [
    ['what the harness reported wins', { model: 'opus', modelHint: 'sonnet' }, { observedModel: 'glm-5.2' }, 'glm-5.2'],
    ['a configured model beats the hint', { model: 'opus-5', modelHint: 'sonnet' }, {}, 'opus-5'],
    ['the hint is the fallback', { modelHint: 'sonnet' }, {}, 'sonnet'],
    ['blank values never win', { model: '  ', modelHint: 'sonnet' }, { observedModel: ' ' }, 'sonnet'],
    ['an empty hint degrades to default', { modelHint: '' }, {}, 'default'],
  ];

  for (const [name, config, state, expected] of cases) {
    it(`should report ${name}`, () => {
      // Arrange / Act
      const actual = displayModel(config, state);

      // Assert
      should(actual).equal(expected);
    });
  }
});

describe('quota rendering', () => {
  it('should report an authentication failure ahead of any percentage', () => {
    // Arrange / Act / Assert
    should(quotaLabel({ usageAuthOk: false, usage5hPercent: 10 })).equal('AUTH REQUIRED');
    should(compactQuota({ usageAuthOk: false, usage5hPercent: 10 })).equal('AUTH!');
  });

  it('should join the reported windows and mark a hard limit', () => {
    // Arrange
    const state = { usage5hPercent: 12, usageWeeklyPercent: 44, usageAtLimit: true };

    // Act / Assert
    should(quotaLabel(state)).equal('5h 12% · wk 44% · AT LIMIT');
    should(compactQuota(state)).equal('12%/44%!');
  });

  it('should say nothing when the daemon reported no usage at all', () => {
    // Arrange / Act / Assert
    should(quotaLabel({})).be.undefined();
    should(compactQuota({})).equal('—');
  });

  it('should render a partially reported window without inventing the other', () => {
    // Arrange / Act / Assert
    should(quotaLabel({ usageWeeklyPercent: 7 })).equal('wk 7%');
    should(compactQuota({ usage5hPercent: 7 })).equal('7%/—');
  });
});

describe('statusLabel', () => {
  it('should pass a plain status through', () => {
    // Arrange / Act / Assert
    should(statusLabel({ status: 'running' })).equal('running');
  });

  it('should mark a declared park so it is not read as a stuck session', () => {
    // Arrange / Act
    const actual = statusLabel({ status: 'waiting', waiting: { since: '2026-01-01T00:00:00.000Z' } });

    // Assert
    should(actual).equal('waiting PARKED');
  });

  it('should name the peer a park is waiting on, preferring the callsign', () => {
    // Arrange / Act
    const actual = statusLabel({
      status: 'waiting',
      waiting: { since: '2026-01-01T00:00:00.000Z', peer: 'ses-9', peerName: 'Hayden' },
    });

    // Assert
    should(actual).equal('waiting PARKED←Hayden');
  });

  it('should fall back to the peer id when it has no callsign', () => {
    // Arrange / Act
    const actual = statusLabel({ status: 'waiting', waiting: { since: '2026-01-01T00:00:00.000Z', peer: 'ses-9' } });

    // Assert
    should(actual).equal('waiting PARKED←ses-9');
  });
});

describe('ageLabel', () => {
  const cases: readonly (readonly [string, string | undefined, string])[] = [
    ['an observed instant as whole seconds', '2026-01-01T00:09:30.000Z', '30s'],
    ['a never-observed signal as a dash', undefined, '-'],
    ['an unparseable instant as a dash rather than NaN', 'not-a-time', '-'],
    ['a future instant clamped at zero rather than negative', '2026-01-01T00:11:00.000Z', '0s'],
  ];

  for (const [name, instant, expected] of cases) {
    it(`should render ${name}`, () => {
      // Arrange / Act
      const actual = ageLabel(NOW, instant);

      // Assert
      should(actual).equal(expected);
    });
  }
});

describe('renderSessionView', () => {
  it('should headline the identity, resolved model, lineage and turn', () => {
    // Arrange
    const view = sessionView(
      { teammate: 'Hayden', label: 'ui-batch', parent: 'ses-0' },
      { observedModel: 'glm-5.2', turn: 4 },
    );

    // Act
    const lines = renderSessionView(view, NOW);

    // Assert
    should(lines[0]).equal(
      'Hayden (ses-1)  running  claude-alpha  model=glm-5.2  label=ui-batch  parent=ses-0  auto  turn 4',
    );
    should(lines[1]).equal('  /work/repo');
    should(lines.at(-1)).equal('  /state/sessions/ses-1');
  });

  it('should omit the lineage fields a session does not have', () => {
    // Arrange / Act
    const lines = renderSessionView(sessionView(), NOW);

    // Assert
    should(lines[0]).equal('- (ses-1)  running  claude-alpha  model=opus  auto  turn 3');
    should(lines.some(line => line.includes('label='))).be.false();
  });

  it('should render the vitals row only when something was observed', () => {
    // Arrange
    const bare = renderSessionView(sessionView(), NOW);
    const observed = renderSessionView(
      sessionView({}, { contextPercent: 42, usage5hPercent: 10, lastToolStartedAt: '2026-01-01T00:09:00.000Z' }),
      NOW,
    );

    // Act / Assert
    should(bare.some(line => line.includes('context'))).be.false();
    should(observed[2]).equal('  context 42% used  quota 5h 10%  last tool started 2026-01-01T00:09:00.000Z');
  });

  it('should report the liveness ledger with a nudge marker', () => {
    // Arrange
    const view = sessionView(
      {},
      {
        lastTranscriptAt: '2026-01-01T00:09:00.000Z',
        lastCounterAdvanceAt: '2026-01-01T00:08:00.000Z',
        nudgedAt: '2026-01-01T00:07:00.000Z',
      },
    );

    // Act
    const lines = renderSessionView(view, NOW);

    // Assert
    should(lines).matchAny(
      /liveness: transcript 60s {2}counters 120s {2}tokens - {2}subprocess - {2}pane - {2}⚠ nudged/,
    );
  });

  it('should explain a peer park, an open-ended park, and a human escalation', () => {
    // Arrange
    const peerPark = renderSessionView(
      sessionView(
        {},
        {
          status: 'waiting',
          waiting: {
            since: '2026-01-01T00:00:00.000Z',
            peer: 'ses-9',
            peerName: 'Hayden',
            until: '2026-01-01T02:00:00.000Z',
          },
          needsHuman: 'credentials expired',
          reason: 'stopped by the operator',
        },
      ),
      NOW,
    );
    const conditionPark = renderSessionView(
      sessionView({}, { status: 'waiting', waiting: { since: '2026-01-01T00:00:00.000Z', condition: 'CI to finish' } }),
      NOW,
    );
    const barePark = renderSessionView(
      sessionView({}, { status: 'waiting', waiting: { since: '2026-01-01T00:00:00.000Z' } }),
      NOW,
    );

    // Act / Assert
    should(peerPark).matchAny(/DECLARED WAIT: reply from Hayden until 2026-01-01T02:00:00.000Z/);
    should(peerPark).matchAny(/🚨 NEEDS HUMAN: credentials expired/);
    should(peerPark).matchAny(/ {2}stopped by the operator/);
    should(conditionPark).matchAny(/DECLARED WAIT: CI to finish \(open-ended\)/);
    should(barePark).matchAny(/DECLARED WAIT: external condition \(open-ended\)/);
  });

  it('should list a pending question with its options', () => {
    // Arrange
    const view = sessionView(
      {},
      {
        status: 'awaiting_question',
        pendingQuestion: {
          toolUseId: 'tool-1',
          questions: [
            { question: 'Ship it?', options: [{ label: 'yes' }, { label: 'no' }], multiSelect: true },
            { question: 'Anything else?' },
          ],
        },
      },
    );

    // Act
    const lines = renderSessionView(view, NOW);

    // Assert
    should(lines).matchAny(/ {2}question: Ship it\?/);
    should(lines).matchAny(/ {2}options: yes, no \(choose one or more\)/);
    should(lines).matchAny(/ {2}question: Anything else\?/);
    should(lines.filter(line => line.startsWith('  options:'))).have.length(1);
  });
});

describe('renderSessionTable', () => {
  it('should size every column from the data and leave the last one unpadded', () => {
    // Arrange
    const views = [
      sessionView({ id: 'ses-1', teammate: 'Hayden', name: 'Short', label: 'batch' }, { usage5hPercent: 9 }),
      sessionView({ id: 'ses-longer-id', name: 'A much longer task title' }, { status: 'completed' }),
    ];

    // Act
    const [header, first, second] = renderSessionTable(views);

    // Assert
    should(header).startWith('TEAMMATE  ID             STATUS');
    should(first).startWith('Hayden    ses-1          running');
    should(second).startWith('-         ses-longer-id  completed');
    should(second?.endsWith('-')).be.true();
    should(first?.endsWith('batch')).be.true();
  });

  it('should render a header-only table when there is nothing to list', () => {
    // Arrange / Act
    const lines = renderSessionTable([]);

    // Assert
    should(lines).have.length(1);
    should(lines[0]).startWith('TEAMMATE  ID  STATUS');
  });
});

describe('TERMINAL_STATUSES', () => {
  it('should name exactly the statuses a session never leaves', () => {
    // Arrange / Act / Assert
    should([...TERMINAL_STATUSES]).deepEqual(['completed', 'failed', 'stalled', 'stopped']);
  });
});
