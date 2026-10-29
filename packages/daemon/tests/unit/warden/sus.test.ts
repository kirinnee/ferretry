import { describe, it } from 'bun:test';
import should from 'should';
import {
  ledgerAges,
  livenessLedgerOf,
  susFindings,
  type WardenLivenessLedger,
  type WardenSessionState,
  waitingOnOwner,
} from '../../../src/lib/warden/index.ts';

const NOW = Date.parse('2026-07-30T12:00:00.000Z');
const ago = (seconds: number): string => new Date(NOW - seconds * 1_000).toISOString();

const options = { susThinkingSeconds: 600, susSubprocessSeconds: 900, tickSeconds: 30 };

describe('liveness ledger ages', () => {
  it('should report seconds since each observed signal', () => {
    // Arrange
    const ledger: WardenLivenessLedger = {
      lastTranscriptAt: ago(120),
      lastCounterAdvanceAt: ago(10),
      lastTokenAdvanceAt: ago(45),
      lastSubprocessAt: ago(5),
      lastPaneChangeAt: ago(1),
    };

    // Act
    const ages = ledgerAges(ledger, NOW);

    // Assert
    should(ages).eql({
      transcript: 120,
      counterAdvance: 10,
      tokenAdvance: 45,
      subprocess: 5,
      paneChange: 1,
      meaningfulPane: Number.POSITIVE_INFINITY,
    });
  });

  it('should report Infinity for signals never seen and with no anchor', () => {
    // Arrange / Act
    const ages = ledgerAges({}, NOW);

    // Assert
    should(ages.transcript).eql(Number.POSITIVE_INFINITY);
    should(ages.paneChange).eql(Number.POSITIVE_INFINITY);
  });

  it('should floor unseen signals at the turn anchor so a fresh turn never reads as frozen', () => {
    // Arrange
    const anchorMs = NOW - 30_000;

    // Act
    const ages = ledgerAges({ lastTranscriptAt: ago(9_000) }, NOW, anchorMs);

    // Assert
    should(ages.transcript).eql(30);
    should(ages.subprocess).eql(30);
  });

  it('should never report a negative age for a signal in the future', () => {
    // Arrange / Act
    const ages = ledgerAges({ lastPaneChangeAt: new Date(NOW + 60_000).toISOString() }, NOW);

    // Assert
    should(ages.paneChange).eql(0);
  });

  it('should project a session state into a ledger', () => {
    // Arrange
    const state: WardenSessionState = {
      status: 'thinking',
      lastTranscriptAt: ago(5),
      lastCounterAdvanceAt: ago(4),
      lastTokenAdvanceAt: ago(3),
      lastSubprocessAt: ago(2),
      subprocessSince: ago(60),
      lastPaneAt: ago(1),
    };

    // Act
    const ledger = livenessLedgerOf(state);

    // Assert
    should(ledger.lastPaneChangeAt).eql(state.lastPaneAt);
    should(ledger.subprocessSince).eql(state.subprocessSince);
  });
});

describe('sus classifiers', () => {
  it('should flag a silent think when the work indicator is active and the transcript is stale', () => {
    // Arrange
    const ledger: WardenLivenessLedger = { lastCounterAdvanceAt: ago(5), lastTranscriptAt: ago(1_200) };

    // Act
    const findings = susFindings(ledger, NOW, options);

    // Assert
    should(findings).have.length(1);
    should(findings[0]?.kind).eql('sus_thinking');
    should(findings[0]?.forSeconds).eql(1_200);
    should(findings[0]?.detail).containEql('20m');
  });

  it('should exempt a think whose token counter is still climbing', () => {
    // Arrange
    const ledger: WardenLivenessLedger = {
      lastCounterAdvanceAt: ago(5),
      lastTokenAdvanceAt: ago(5),
      lastTranscriptAt: ago(5_000),
    };

    // Act
    const findings = susFindings(ledger, NOW, options);

    // Assert
    should(findings).be.empty();
  });

  it('should not flag a think whose indicator went quiet more than two ticks ago', () => {
    // Arrange
    const ledger: WardenLivenessLedger = { lastCounterAdvanceAt: ago(61), lastTranscriptAt: ago(5_000) };

    // Act
    const findings = susFindings(ledger, NOW, options);

    // Assert
    should(findings).be.empty();
  });

  it('should describe a never-grown transcript as the whole turn rather than a negative age', () => {
    // Arrange
    const ledger: WardenLivenessLedger = { lastCounterAdvanceAt: ago(5) };

    // Act
    const findings = susFindings(ledger, NOW, options);

    // Assert
    should(findings).have.length(1);
    should(findings[0]?.forSeconds).be.undefined();
    should(findings[0]?.detail).containEql('the whole turn');
  });

  it('should flag a long continuous subprocess episode that is still alive', () => {
    // Arrange
    const ledger: WardenLivenessLedger = { lastSubprocessAt: ago(10), subprocessSince: ago(1_800) };

    // Act
    const findings = susFindings(ledger, NOW, options);

    // Assert
    should(findings).have.length(1);
    should(findings[0]?.kind).eql('sus_subprocess');
    should(findings[0]?.forSeconds).eql(1_800);
  });

  it('should not flag a subprocess episode shorter than the threshold', () => {
    // Arrange
    const ledger: WardenLivenessLedger = { lastSubprocessAt: ago(10), subprocessSince: ago(60) };

    // Act
    const findings = susFindings(ledger, NOW, options);

    // Assert
    should(findings).be.empty();
  });

  it('should not flag a stale subprocess sighting even when the episode start is ancient', () => {
    // Arrange
    const ledger: WardenLivenessLedger = { lastSubprocessAt: ago(600), subprocessSince: ago(9_000) };

    // Act
    const findings = susFindings(ledger, NOW, options);

    // Assert
    should(findings).be.empty();
  });

  it('should ignore a live subprocess with no recorded episode start', () => {
    // Arrange
    const ledger: WardenLivenessLedger = { lastSubprocessAt: ago(5) };

    // Act
    const findings = susFindings(ledger, NOW, options);

    // Assert
    should(findings).be.empty();
  });

  it('should default the tick to thirty seconds when the caller omits it', () => {
    // Arrange
    const ledger: WardenLivenessLedger = { lastCounterAdvanceAt: ago(59), lastTranscriptAt: ago(5_000) };

    // Act
    const findings = susFindings(ledger, NOW, {
      susThinkingSeconds: options.susThinkingSeconds,
      susSubprocessSeconds: options.susSubprocessSeconds,
    });

    // Assert
    should(findings.map(finding => finding.kind)).eql(['sus_thinking']);
  });

  it('should report both classes when a session is silently thinking and running a long subprocess', () => {
    // Arrange
    const ledger: WardenLivenessLedger = {
      lastCounterAdvanceAt: ago(5),
      lastTranscriptAt: ago(1_200),
      lastSubprocessAt: ago(5),
      subprocessSince: ago(1_200),
    };

    // Act
    const findings = susFindings(ledger, NOW, options);

    // Assert
    should(findings.map(finding => finding.kind)).eql(['sus_thinking', 'sus_subprocess']);
  });
});

describe('waiting on the owner — no investigation', () => {
  const silentThink: WardenLivenessLedger = { lastCounterAdvanceAt: ago(5), lastTranscriptAt: ago(5_000) };
  const longCommand: WardenLivenessLedger = { lastSubprocessAt: ago(5), subprocessSince: ago(5_000) };

  it.each([
    ['needs-input', silentThink],
    ['needs-input', longCommand],
    ['your-turn', silentThink],
  ] as const)('should raise nothing while the turn state is %s', (turnState, ledger) => {
    // Act
    const findings = susFindings(ledger, NOW, { ...options, turnState });

    // Assert
    should(findings).be.empty();
  });

  it('should know the owner is the one who must move once the turn is over and nothing of its own runs', () => {
    // Act / Assert
    should(waitingOnOwner('your-turn', false)).be.true();
    should(waitingOnOwner('needs-input', true)).be.true();
    should(waitingOnOwner('your-turn', true)).be.false();
    should(waitingOnOwner('working', false)).be.false();
    should(waitingOnOwner(undefined, false)).be.false();
  });

  it('should resume by itself the moment the ferret works again', () => {
    // Act
    const findings = susFindings(silentThink, NOW, { ...options, turnState: 'working' });

    // Assert
    should(findings.map(finding => finding.kind)).eql(['sus_thinking']);
  });
});

describe('stuck mid-turn', () => {
  const stuck = { ...options, susSubprocessSeconds: 600, turnState: 'working' as const };

  it('should flag a command that ran ten minutes with nothing moving', () => {
    // Arrange
    const ledger: WardenLivenessLedger = {
      lastSubprocessAt: ago(5),
      subprocessSince: ago(660),
      lastTranscriptAt: ago(700),
      lastMeaningfulPaneAt: ago(650),
    };

    // Act
    const findings = susFindings(ledger, NOW, stuck);

    // Assert
    should(findings.map(finding => finding.kind)).eql(['sus_subprocess']);
    should(findings[0]?.detail).containEql('nothing moving for 10m');
  });

  it.each([
    ['the transcript grew', { lastTranscriptAt: ago(30) }],
    ['the token counter climbed', { lastTokenAdvanceAt: ago(30) }],
    ['the screen moved beyond the spinner', { lastMeaningfulPaneAt: ago(30) }],
  ] as const)('should not flag a long command while %s', (_name, moved) => {
    // Arrange
    const ledger: WardenLivenessLedger = {
      lastSubprocessAt: ago(5),
      subprocessSince: ago(5_000),
      lastTranscriptAt: ago(5_000),
      lastMeaningfulPaneAt: ago(5_000),
      ...moved,
    };

    // Act
    const findings = susFindings(ledger, NOW, stuck);

    // Assert
    should(findings).be.empty();
  });

  it('should ignore a pane that only repaints its spinner', () => {
    // Arrange — the raw pane changed seconds ago; nothing meaningful has for an hour.
    const ledger: WardenLivenessLedger = {
      lastSubprocessAt: ago(5),
      subprocessSince: ago(3_600),
      lastPaneChangeAt: ago(5),
      lastMeaningfulPaneAt: ago(3_600),
      lastCounterAdvanceAt: ago(5),
    };

    // Act
    const findings = susFindings(ledger, NOW, stuck);

    // Assert
    should(findings.map(finding => finding.kind)).containEql('sus_subprocess');
  });

  it('should still flag a command left running after the turn ended — a poll loop that can never finish', () => {
    // Arrange
    const ledger: WardenLivenessLedger = {
      lastSubprocessAt: ago(5),
      subprocessSince: ago(3_600),
      lastTranscriptAt: ago(3_600),
      lastMeaningfulPaneAt: ago(3_600),
    };

    // Act
    const findings = susFindings(ledger, NOW, { ...stuck, turnState: 'your-turn' });

    // Assert
    should(findings.map(finding => finding.kind)).eql(['sus_subprocess']);
    should(findings[0]?.detail).containEql('after its turn ended');
  });

  it('should not measure quiet from before the command began', () => {
    // Arrange — a ten-minute command after an hour of nothing: quiet is ten minutes, not seventy.
    const ledger: WardenLivenessLedger = {
      lastSubprocessAt: ago(5),
      subprocessSince: ago(300),
      lastTranscriptAt: ago(4_200),
    };

    // Act
    const findings = susFindings(ledger, NOW, stuck);

    // Assert
    should(findings).be.empty();
  });
});
