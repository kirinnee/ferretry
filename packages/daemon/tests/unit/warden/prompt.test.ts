import { describe, it } from 'bun:test';
import should from 'should';
import {
  buildAssignedWardenPrompt,
  buildWardenSweepPrompt,
  provenancePath,
  type WardenAnomaly,
  type WardenPromptSession,
  type WardenPromptSettings,
} from '../../../src/lib/warden/index.ts';

const REPORT = '/state/warden/reports/2026-07-31T00-00-00-000Z.md';
const ACTING: WardenPromptSettings = { clientName: 'fy', mayAct: true };
const REPORTING: WardenPromptSettings = { clientName: 'fy', mayAct: false };

const session = (overrides: Partial<WardenPromptSession> = {}): WardenPromptSession => ({
  config: { id: 's1', mode: 'auto', teammate: 'scout', label: 'batch', agent: 'claude-auto-a' },
  state: { status: 'thinking', lastActivityAt: '2026-07-31T11:00:00.000Z' },
  directory: '/state/sessions/s1',
  cwd: '/home/dev/repo',
  turn: 4,
  ...overrides,
});

const anomaly = (overrides: Partial<WardenAnomaly> = {}): WardenAnomaly => ({
  kind: 'sus_thinking',
  sessionId: 's1',
  status: 'thinking',
  detail: 'the transcript has not grown',
  ...overrides,
});

describe('the assigned warden prompt', () => {
  it('should name the one session it may look at', () => {
    // Arrange / Act
    const actual = buildAssignedWardenPrompt(anomaly(), session(), REPORT, ACTING);

    // Assert
    should(actual).match(/ASSIGNED warden for exactly one session: s1 \(teammate :scout\)/u);
  });

  it('should say the teammate is unknown rather than printing nothing', () => {
    // Arrange
    const target = session({ config: { id: 's1', mode: 'auto', agent: 'claude-auto-a' } });

    // Act
    const actual = buildAssignedWardenPrompt(anomaly(), target, REPORT, ACTING);

    // Assert
    should(actual).match(/teammate unknown/u);
  });

  it('should embed the detector output verbatim as JSON', () => {
    // Arrange: a paraphrase would lose the timestamps the judgement turns on.
    const subject = anomaly({ idleMinutes: 22, ledger: { lastTranscriptAt: '2026-07-31T11:00:00.000Z' } });

    // Act
    const actual = buildAssignedWardenPrompt(subject, session(), REPORT, ACTING);

    // Assert
    should(actual).containEql(JSON.stringify(subject, null, 2));
  });

  it('should dictate the exact report path', () => {
    // Arrange / Act
    const actual = buildAssignedWardenPrompt(anomaly(), session(), REPORT, ACTING);

    // Assert
    should(actual).match(new RegExp(`Write your report to EXACTLY: ${REPORT}`, 'u'));
  });

  it('should name the daemon-owned provenance sidecar so the warden never writes into it', () => {
    // Arrange / Act
    const actual = buildAssignedWardenPrompt(anomaly(), session(), REPORT, ACTING);

    // Assert
    should(actual).containEql(provenancePath(REPORT));
  });

  it('should carry the machine-stable template the verdict parser reads', () => {
    // Arrange / Act
    const actual = buildAssignedWardenPrompt(anomaly(), session(), REPORT, ACTING);

    // Assert
    should(actual).containEql('Verdict: LEAVE|NUDGE|RESUME|KILL|NEEDS_HUMAN');
    should(actual).containEql('- **Anomaly kind:** sus_thinking');
    should(actual).containEql('- **Recommended action:**');
  });

  it('should print a dash for a session with no label', () => {
    // Arrange
    const target = session({ config: { id: 's1', mode: 'auto', teammate: 'scout', agent: 'claude-auto-a' } });

    // Act
    const actual = buildAssignedWardenPrompt(anomaly(), target, REPORT, ACTING);

    // Assert
    should(actual).match(/teammate :scout, -\)/u);
  });

  it('should offer the read-only workspace look when a working directory is known', () => {
    // Arrange / Act
    const actual = buildAssignedWardenPrompt(anomaly(), session(), REPORT, ACTING);

    // Assert
    should(actual).containEql('git -C /home/dev/repo diff --stat');
  });

  it('should omit the workspace look when no working directory is known', () => {
    // Arrange
    const target = session({ cwd: undefined });

    // Act
    const actual = buildAssignedWardenPrompt(anomaly(), target, REPORT, ACTING);

    // Assert
    should(actual).not.containEql('git -C');
  });

  it.each([
    { kind: 'sus_thinking' as const, expected: /work counters advancing/u },
    { kind: 'sus_subprocess' as const, expected: /background subprocess/u },
    { kind: 'unattended_question' as const, expected: /waiting on an unanswered question/u },
    { kind: 'peer_wait_unanswerable' as const, expected: /waiting on an unanswered question/u },
  ])('should explain what to weigh for $kind', ({ kind, expected }) => {
    // Arrange / Act
    const actual = buildAssignedWardenPrompt(anomaly({ kind }), session(), REPORT, ACTING);

    // Assert
    should(actual).match(expected);
  });

  it('should tell an authorized warden to answer only an unambiguous question', () => {
    // Arrange / Act
    const actual = buildAssignedWardenPrompt(anomaly({ kind: 'unattended_question' }), session(), REPORT, ACTING);

    // Assert
    should(actual).containEql('`fy answer`');
  });

  it('should ask an unauthorized warden to state the decision instead of answering', () => {
    // Arrange / Act
    const actual = buildAssignedWardenPrompt(anomaly({ kind: 'unattended_question' }), session(), REPORT, REPORTING);

    // Assert
    should(actual).not.containEql('`fy answer`');
    should(actual).containEql('State precisely what a human must decide');
  });
});

describe('what a warden is told about its own authority', () => {
  it('should hand an authorized warden the commands it can actually run', () => {
    // Arrange / Act
    const actual = buildAssignedWardenPrompt(anomaly(), session(), REPORT, ACTING);

    // Assert
    should(actual).containEql('`fy send s1 <message>`');
    should(actual).containEql('`fy stop s1`');
    should(actual).not.containEql('## Your authority');
  });

  it('should tell an unauthorized warden plainly that its report is the action', () => {
    // Arrange / Act
    const actual = buildAssignedWardenPrompt(anomaly(), session(), REPORT, REPORTING);

    // Assert
    should(actual).containEql('## Your authority');
    should(actual).containEql('You hold NO credential over any session');
    should(actual).not.containEql('`fy stop s1`');
  });

  it('should keep the verdict vocabulary identical either way, because the parser reads it', () => {
    // Arrange / Act
    const acting = buildAssignedWardenPrompt(anomaly(), session(), REPORT, ACTING);
    const reporting = buildAssignedWardenPrompt(anomaly(), session(), REPORT, REPORTING);

    // Assert
    for (const verdict of ['LEAVE', 'NUDGE', 'RESUME', 'KILL', 'NEEDS_HUMAN']) {
      should(acting).containEql(verdict);
      should(reporting).containEql(verdict);
    }
  });
});

describe('the fleet sweep prompt', () => {
  const sweep = (overrides: Partial<Parameters<typeof buildWardenSweepPrompt>[0]> = {}): string =>
    buildWardenSweepPrompt({
      anomalies: [anomaly()],
      sessions: [session()],
      reportPath: REPORT,
      at: '2026-07-31T00:00:00.000Z',
      settings: ACTING,
      ...overrides,
    });

  it('should state when the sweep ran', () => {
    // Arrange / Act / Assert
    should(sweep()).match(/A deterministic sweep at 2026-07-31T00:00:00.000Z/u);
  });

  it('should show per-session facts only for the anomalous sessions', () => {
    // Arrange
    const healthy = session({ config: { id: 's2', mode: 'auto', agent: 'claude-auto-b' }, directory: '/state/s2' });

    // Act
    const actual = sweep({ sessions: [session(), healthy] });

    // Assert
    should(actual).containEql('"id": "s1"');
    should(actual).not.containEql('"id": "s2"');
  });

  it('should show every session a fleet-wide anomaly names', () => {
    // Arrange: a fault corroborated across sessions must not be judged on a fraction of its evidence.
    const other = session({ config: { id: 's2', mode: 'auto', agent: 'claude-auto-b' }, directory: '/state/s2' });
    const fleet = anomaly({ kind: 'dead_monitor', sessionId: 's1', affectedSessionIds: ['s1', 's2'] });

    // Act
    const actual = sweep({ anomalies: [fleet], sessions: [session(), other] });

    // Assert
    should(actual).containEql('"id": "s2"');
  });

  it('should list migrate candidates when there are any', () => {
    // Arrange / Act
    const actual = sweep({
      migrateCandidates: [{ sessionId: 's1', currentAgent: 'claude-auto-a', candidates: ['claude-auto-b'] }],
    });

    // Assert
    should(actual).containEql('## Migrate candidates');
    should(actual).containEql('claude-auto-b');
  });

  it('should omit the migrate section entirely when none were computed', () => {
    // Arrange: the prompt forbids picking an account outside the list, so no list means no migration.
    should(sweep()).not.containEql('## Migrate candidates');
  });

  it('should allow the recovery commands when the warden is authorized', () => {
    // Arrange / Act
    const actual = sweep();

    // Assert
    should(actual).containEql('## ALLOWED actions');
    should(actual).containEql('`fy migrate <id> -a <agent>`');
  });

  it('should forbid acting at all when the warden is not authorized', () => {
    // Arrange / Act
    const actual = sweep({ settings: REPORTING });

    // Assert
    should(actual).not.containEql('## ALLOWED actions');
    should(actual).containEql('Do NOT act on any session; recommend, and let the operator act.');
  });

  it('should forbid git writes and new sessions whatever the authority', () => {
    // Arrange / Act / Assert
    for (const prompt of [sweep(), sweep({ settings: REPORTING })]) {
      should(prompt).containEql('Do NOT run any git operation');
      should(prompt).containEql('Do NOT start any non-warden session');
    }
  });

  it('should dictate one anomaly section per record so no verdict covers several sessions', () => {
    // Arrange / Act
    const actual = sweep();

    // Assert
    should(actual).containEql('Never use one fleet-wide verdict as the verdict for several sessions.');
  });
});
