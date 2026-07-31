import { describe, it } from 'bun:test';
import should from 'should';
import {
  classifyVerdict,
  classifyVerdictHeuristically,
  parseWardenAnomalyKind,
  parseWardenReports,
  parseWardenVerdictSourceRef,
  structuredVerdict,
  wardenVerdictSourceRef,
  type WardenReportFile,
} from '../../../src/lib/warden/index.ts';

const MTIME = Date.parse('2026-07-30T12:00:00.000Z');

const report = (content: string, overrides: Partial<WardenReportFile> = {}): WardenReportFile => ({
  path: '/state/warden/reports/2026-07-30T12-00-00-000Z.md',
  content,
  mtimeMs: MTIME,
  ...overrides,
});

describe('anomaly kind parsing', () => {
  it.each([
    { label: 'a known kind', value: 'sus_thinking', expected: 'sus_thinking' },
    { label: 'a padded known kind', value: '  dead_monitor  ', expected: 'dead_monitor' },
    { label: 'an unknown kind', value: 'vibes', expected: undefined },
    { label: 'an empty string', value: '', expected: undefined },
    { label: 'undefined', value: undefined, expected: undefined },
  ])('should map $label', ({ value, expected }) => {
    // Arrange / Act / Assert
    should(parseWardenAnomalyKind(value)).eql(expected);
  });
});

describe('verdict source references', () => {
  it.each([
    {
      label: 'a path and a kind',
      path: '/reports/a.md',
      kind: 'sus_thinking' as const,
      ref: 'warden:/reports/a.md#sus_thinking',
    },
    { label: 'a path alone', path: '/reports/a.md', kind: undefined, ref: 'warden:/reports/a.md' },
    { label: 'a kind alone', path: undefined, kind: 'dead_monitor' as const, ref: 'warden:dead_monitor' },
  ])('should round-trip $label', ({ path, kind, ref }) => {
    // Arrange / Act
    const built = wardenVerdictSourceRef(path, kind);

    // Assert
    should(built).eql(ref);
    should(parseWardenVerdictSourceRef(built)).eql({
      ...(path === undefined ? {} : { reportPath: path }),
      ...(kind === undefined ? {} : { anomalyKind: kind }),
    });
  });

  it('should produce no reference when neither identity is known', () => {
    // Arrange / Act / Assert
    should(wardenVerdictSourceRef(undefined, undefined)).be.undefined();
  });

  it.each([
    { label: 'undefined', value: undefined },
    { label: 'a reference for another source', value: 'attention:abc' },
    { label: 'an empty warden reference', value: 'warden:' },
  ])('should refuse to parse $label', ({ value }) => {
    // Arrange / Act / Assert
    should(parseWardenVerdictSourceRef(value)).be.undefined();
  });

  it('should treat a trailing hash of an unknown kind as part of the path', () => {
    // Arrange / Act
    const identity = parseWardenVerdictSourceRef('warden:/reports/a.md#vibes');

    // Assert
    should(identity).eql({ reportPath: '/reports/a.md#vibes' });
  });
});

describe('verdict classification', () => {
  it.each([
    { line: 'Verdict: KILL', expected: 'killed' },
    { line: '- Verdict: RESUME', expected: 'revived' },
    { line: '**Verdict:** NUDGE', expected: 'nudged' },
    { line: '* **verdict** LEAVE', expected: 'cleared' },
    { line: 'Verdict: NEEDS_HUMAN', expected: 'needs_human' },
    { line: 'Verdict: NEEDS HUMAN', expected: 'needs_human' },
    { line: 'Verdict: NEEDS-HUMAN', expected: 'needs_human' },
  ])('should read the marker in "$line"', ({ line, expected }) => {
    // Arrange / Act / Assert
    should(structuredVerdict(line)).eql(expected);
    should(classifyVerdict(line)).eql(expected);
  });

  it('should find no marker in prose that only discusses a verdict', () => {
    // Arrange / Act / Assert
    should(structuredVerdict('I considered a verdict of some kind.')).be.undefined();
  });

  it('should let the marker win over contradicting prose', () => {
    // Arrange
    const content = 'Verdict: LEAVE\n\nI nearly killed the session but decided against it.';

    // Act / Assert
    should(classifyVerdict(content)).eql('cleared');
  });

  it.each([
    { label: 'a stated need for a human', text: 'This needs a human to decide.', expected: 'needs_human' },
    { label: 'no safe action', text: 'There is no safe action here.', expected: 'needs_human' },
    { label: 'an explicit kill', text: 'I killed the session.', expected: 'killed' },
    { label: 'a stop command', text: 'Ran fy stop on the target.', expected: 'killed' },
    { label: 'a resume', text: 'I resumed the teammate.', expected: 'revived' },
    { label: 'a nudge', text: 'I nudged it back to work.', expected: 'nudged' },
    { label: 'leaving it alone', text: 'Left it alone; it is making progress.', expected: 'cleared' },
    { label: 'nothing recognisable', text: 'Observed the pane for a while.', expected: 'unknown' },
  ])('should fall back to prose for $label', ({ text, expected }) => {
    // Arrange / Act / Assert
    should(classifyVerdictHeuristically(text)).eql(expected);
  });

  it('should not read an incidental "stopped" as a kill', () => {
    // Arrange
    const content = 'The background subprocess stopped on its own, so nothing needed doing.';

    // Act / Assert
    should(classifyVerdictHeuristically(content)).eql('unknown');
  });

  it('should prefer the need for a human over the options it rejected', () => {
    // Arrange
    const content = 'A nudge would not help and a kill is too aggressive — this needs a human.';

    // Act / Assert
    should(classifyVerdictHeuristically(content)).eql('needs_human');
  });
});

describe('fleet-triage report parsing', () => {
  const triage = [
    '# Warden sweep (2026-07-30T11:59:00.000Z)',
    '',
    '## Anomaly: `s1` — atlas / batch-7',
    '- **Anomaly kind:** `sus_thinking`',
    '- **Reported reason:** transcript flat for 30m',
    '- **Recommended action:** NUDGE — Ask the session to restate its blocker.',
    'Verdict: NUDGE',
    '**Verdict:** NUDGE — asked it to restate the blocker',
    '',
    '## Anomaly: s2 — nova',
    '- **Anomaly kind:** `dead_monitor`',
    'Verdict: NEEDS_HUMAN',
    '**Verdict:** NEEDS_HUMAN — the pane is gone and the work is unclear',
    '',
    '## Anomaly: s3',
    '- **Reported reason:** parked on a peer that failed',
    '',
  ].join('\n');

  it('should split a triage report into one entry per anomaly', () => {
    // Arrange / Act
    const verdicts = parseWardenReports([report(triage)]);

    // Assert
    should(verdicts).have.length(3);
    should(verdicts.map(entry => entry.targetSession)).eql(['s1', 's2', 's3']);
  });

  it('should take the sweep instant from the report title rather than the mtime', () => {
    // Arrange / Act
    const verdicts = parseWardenReports([report(triage)]);

    // Assert
    should(verdicts[0]?.at).eql('2026-07-30T11:59:00.000Z');
  });

  it('should read the teammate and label out of the anomaly heading', () => {
    // Arrange / Act
    const verdicts = parseWardenReports([report(triage)]);

    // Assert
    should(verdicts[0]?.teammate).eql('atlas');
    should(verdicts[0]?.label).eql('batch-7');
    should(verdicts[1]?.teammate).eql('nova');
    should(verdicts[1]?.label).be.undefined();
  });

  it('should carry each block its own kind, verdict, reason and recommendation', () => {
    // Arrange / Act
    const verdicts = parseWardenReports([report(triage)]);

    // Assert
    should(verdicts[0]?.anomalyKind).eql('sus_thinking');
    should(verdicts[0]?.verdict).eql('nudged');
    should(verdicts[0]?.reason).eql('asked it to restate the blocker');
    should(verdicts[0]?.recommendation).eql({ action: 'nudge', reason: 'Ask the session to restate its blocker.' });
  });

  it('should mark an explicit needs-human block for attention', () => {
    // Arrange / Act
    const verdicts = parseWardenReports([report(triage)]);

    // Assert
    should(verdicts[1]?.verdict).eql('needs_human');
    should(verdicts[1]?.explicitNeedsHuman).be.true();
    should(verdicts[0]?.explicitNeedsHuman).be.undefined();
  });

  it('should leave an unmarked block in a multi-anomaly report explicitly unknown', () => {
    // Arrange / Act
    const verdicts = parseWardenReports([report(triage)]);

    // Assert
    should(verdicts[2]?.verdict).eql('unknown');
    should(verdicts[2]?.reason).eql('parked on a peer that failed');
  });

  it('should let a single-anomaly report keep its marker above the block', () => {
    // Arrange
    const content = ['Verdict: KILL', '', '## Anomaly: `s1` — atlas', 'The pane never recovered.'].join('\n');

    // Act
    const verdicts = parseWardenReports([report(content)]);

    // Assert
    should(verdicts).have.length(1);
    should(verdicts[0]?.verdict).eql('killed');
  });

  it('should treat a file-level needs-human marker on a single-anomaly report as explicit', () => {
    // Arrange
    const content = ['Verdict: NEEDS_HUMAN', '', '## Anomaly: `s1` — atlas', 'Nothing safe to do here.'].join('\n');

    // Act
    const verdicts = parseWardenReports([report(content)]);

    // Assert
    should(verdicts[0]?.explicitNeedsHuman).be.true();
  });

  it('should not treat a heuristic needs-human reading as explicit', () => {
    // Arrange
    const content = ['## Anomaly: `s1` — atlas', 'There is no safe action here.'].join('\n');

    // Act
    const verdicts = parseWardenReports([report(content)]);

    // Assert
    should(verdicts[0]?.verdict).eql('needs_human');
    should(verdicts[0]?.explicitNeedsHuman).be.undefined();
  });

  it('should ignore a heading that is not an anomaly block', () => {
    // Arrange
    const content = ['## Notes', 'general observations', '', '## Anomaly: s1', 'Verdict: LEAVE'].join('\n');

    // Act
    const verdicts = parseWardenReports([report(content)]);

    // Assert
    should(verdicts.map(entry => entry.targetSession)).eql(['s1']);
  });
});

describe('assigned report parsing', () => {
  it('should identify the session from the report header', () => {
    // Arrange
    const content = [
      '# Warden report — abc-123 (teammate atlas, batch-7)',
      '',
      '- **Anomaly kind:** `sus_subprocess`',
      '- **Recommended action:** MIGRATE (reserve-account) — Move it to an account with headroom.',
      'Verdict: RESUME',
      '',
      '## Summary',
      '- The build was genuinely running; it finished during the check.',
      '- Second line that must not leak into the row.',
    ].join('\n');

    // Act
    const verdicts = parseWardenReports([report(content)]);

    // Assert
    should(verdicts).have.length(1);
    should(verdicts[0]?.targetSession).eql('abc-123');
    should(verdicts[0]?.teammate).eql('atlas');
    should(verdicts[0]?.label).eql('batch-7');
    should(verdicts[0]?.verdict).eql('revived');
    should(verdicts[0]?.anomalyKind).eql('sus_subprocess');
    should(verdicts[0]?.reason).eql('The build was genuinely running; it finished during the check.');
    should(verdicts[0]?.recommendation).eql({
      action: 'migrate',
      agent: 'reserve-account',
      reason: 'Move it to an account with headroom.',
    });
  });

  it('should fall back to the session id in the filename when the header is missing', () => {
    // Arrange
    const content = 'Verdict: LEAVE\n\nNothing to do.';
    const path = '/state/warden/reports/2026-07-30T12-00-00-000Z-abc-1a2b3c.md';

    // Act
    const verdicts = parseWardenReports([report(content, { path })]);

    // Assert
    should(verdicts[0]?.targetSession).eql('abc-1a2b3c');
  });

  it('should leave the target unknown when neither header nor filename names one', () => {
    // Arrange / Act
    const verdicts = parseWardenReports([report('Verdict: LEAVE', { path: '/reports/plain.md' })]);

    // Assert
    should(verdicts[0]?.targetSession).be.undefined();
  });

  it('should fall back to the file mtime when the report has no title instant', () => {
    // Arrange / Act
    const verdicts = parseWardenReports([report('Verdict: LEAVE')]);

    // Assert
    should(verdicts[0]?.at).eql('2026-07-30T12:00:00.000Z');
  });

  it('should read a header with no teammate parenthetical', () => {
    // Arrange / Act
    const verdicts = parseWardenReports([report('# Warden report — abc-123\n\nVerdict: LEAVE')]);

    // Assert
    should(verdicts[0]?.targetSession).eql('abc-123');
    should(verdicts[0]?.teammate).be.undefined();
  });
});

describe('verdict reasons', () => {
  it.each([
    {
      label: 'a bold verdict line with an em dash',
      content: '**Verdict:** KILL — the harness never repainted',
      expected: 'the harness never repainted',
    },
    {
      label: 'a verdict word inside the bold',
      content: '**Verdict: LEAVE.** The subprocess is a legitimate build.',
      expected: 'The subprocess is a legitimate build.',
    },
    {
      label: 'an outcome bullet',
      content: '- **Outcome:** Nudged and the teammate replied.',
      expected: 'Nudged and the teammate replied.',
    },
    {
      label: 'the first summary line',
      content: '## Summary\n\nIt recovered on its own.\n\nMore evidence follows.',
      expected: 'It recovered on its own.',
    },
    {
      label: 'a bulleted summary line',
      content: '## Summary\n\n- It recovered on its own.',
      expected: 'It recovered on its own.',
    },
  ])('should take the reason from $label', ({ content, expected }) => {
    // Arrange / Act
    const verdicts = parseWardenReports([report(content)]);

    // Assert
    should(verdicts[0]?.reason).eql(expected);
  });

  it('should collapse a reason that wraps across lines', () => {
    // Arrange
    const content = '**Verdict:** KILL — the harness never repainted\n  and the pane was gone';

    // Act
    const verdicts = parseWardenReports([report(content)]);

    // Assert
    should(verdicts[0]?.reason).eql('the harness never repainted and the pane was gone');
  });

  it('should carry no reason when the report offers none', () => {
    // Arrange / Act
    const verdicts = parseWardenReports([report('Verdict: LEAVE')]);

    // Assert
    should(verdicts[0]?.reason).be.undefined();
  });

  it('should not read the next section heading as the summary', () => {
    // Arrange / Act
    const verdicts = parseWardenReports([report('Verdict: LEAVE\n\n## Summary\n\n\n## Evidence\n\nlots')]);

    // Assert
    should(verdicts[0]?.reason).be.undefined();
  });

  it('should skip a summary section that runs out of file before any prose', () => {
    // Arrange / Act
    const verdicts = parseWardenReports([report('Verdict: LEAVE\n\n## Summary\n\n   \n')]);

    // Assert
    should(verdicts[0]?.reason).be.undefined();
  });
});

describe('recommended actions', () => {
  it.each([
    { line: '- **Recommended action:** STOP — It is wedged.', action: 'stop' },
    { line: '- **Recommended action:** RESTART — Relaunch the turn.', action: 'restart' },
    { line: '* **Recommended action:** LEAVE - It is fine.', action: 'leave' },
  ])('should read $action out of a recommendation line', ({ line, action }) => {
    // Arrange / Act
    const verdicts = parseWardenReports([report(`Verdict: LEAVE\n${line}`)]);

    // Assert
    should(verdicts[0]?.recommendation?.action).eql(action);
  });

  it('should drop a migrate recommendation that names no account', () => {
    // Arrange / Act
    const verdicts = parseWardenReports([report('Verdict: LEAVE\n- **Recommended action:** MIGRATE — Move it.')]);

    // Assert
    should(verdicts[0]?.recommendation).be.undefined();
  });

  it('should ignore a recommendation with no reason', () => {
    // Arrange / Act
    const verdicts = parseWardenReports([report('Verdict: LEAVE\n- **Recommended action:** STOP —   ')]);

    // Assert
    should(verdicts[0]?.recommendation).be.undefined();
  });
});

describe('verdict batching', () => {
  it('should return the newest reports first', () => {
    // Arrange
    const older = report('# Warden report — old\n\nVerdict: LEAVE', { path: '/a.md', mtimeMs: MTIME - 60_000 });
    const newer = report('# Warden report — new\n\nVerdict: KILL', { path: '/b.md', mtimeMs: MTIME });

    // Act
    const verdicts = parseWardenReports([older, newer]);

    // Assert
    should(verdicts.map(entry => entry.targetSession)).eql(['new', 'old']);
  });

  it('should order same-instant reports by path so the output is deterministic', () => {
    // Arrange
    const first = report('# Warden report — b\n\nVerdict: LEAVE', { path: '/b.md' });
    const second = report('# Warden report — a\n\nVerdict: LEAVE', { path: '/a.md' });

    // Act / Assert
    should(parseWardenReports([first, second]).map(entry => entry.targetSession)).eql(['a', 'b']);
    should(parseWardenReports([second, first]).map(entry => entry.targetSession)).eql(['a', 'b']);
  });

  it('should cap the entries at the requested limit even mid-report', () => {
    // Arrange
    const content = ['## Anomaly: s1', 'Verdict: LEAVE', '', '## Anomaly: s2', 'Verdict: LEAVE'].join('\n');

    // Act
    const verdicts = parseWardenReports([report(content)], 1);

    // Assert
    should(verdicts.map(entry => entry.targetSession)).eql(['s1']);
  });

  it('should stop reading further files once the limit is reached', () => {
    // Arrange
    const newer = report('# Warden report — new\n\nVerdict: LEAVE', { path: '/b.md', mtimeMs: MTIME });
    const older = report('# Warden report — old\n\nVerdict: LEAVE', { path: '/a.md', mtimeMs: MTIME - 60_000 });

    // Act
    const verdicts = parseWardenReports([newer, older], 1);

    // Assert
    should(verdicts.map(entry => entry.targetSession)).eql(['new']);
  });

  it('should return nothing for a non-positive limit', () => {
    // Arrange / Act / Assert
    should(parseWardenReports([report('Verdict: LEAVE')], 0)).be.empty();
  });

  it('should return nothing when there are no reports', () => {
    // Arrange / Act / Assert
    should(parseWardenReports([])).be.empty();
  });

  it('should not mutate the caller list while sorting', () => {
    // Arrange
    const files = [
      report('# Warden report — old\n\nVerdict: LEAVE', { path: '/a.md', mtimeMs: MTIME - 60_000 }),
      report('# Warden report — new\n\nVerdict: LEAVE', { path: '/b.md' }),
    ];

    // Act
    parseWardenReports(files);

    // Assert
    should(files.map(file => file.path)).eql(['/a.md', '/b.md']);
  });
});
