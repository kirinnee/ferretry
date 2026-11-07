import { describe, expect, test } from 'bun:test';
import { instructionsReport, renderInstructionsReport } from '../../../../cli/lib/instructions/report.ts';

describe('which sections a ferret launched with', () => {
  test('V-instructions a section is on only when its variable is exactly 1', () => {
    const report = instructionsReport({
      FY_SESSION_ID: 'wren',
      FY_HYPERMEDIA: '1',
      FY_PACK: '0',
      FY_AGENDA: 'yes',
      FY_SESSION_MODE: 'auto',
    });
    expect(report).toMatchObject({ inFerret: true, known: true, sessionId: 'wren', mode: 'auto' });
    expect(report.sections.map(s => [s.id, s.on])).toEqual([
      ['hypermedia', true],
      ['pack', false],
      ['agenda', false],
      ['lessons', false],
    ]);
    expect(report.sections[1]?.turnOn).toContain('Settings › Pack mode');
  });

  test('V-instructions outside a ferret, or with no switches handed over, the answer says so rather than guessing "all off"', () => {
    expect(renderInstructionsReport(instructionsReport({}), 'fy')).toContain('not running inside a ferret');
    const unknown = instructionsReport({ FY_SESSION_ID: 'wren' });
    expect(unknown.known).toBe(false);
    expect(renderInstructionsReport(unknown, 'fy')).toContain('Run `fy instructions` in your own shell');
  });

  test('V-instructions the rendering lists each section and says the switches are fixed for the run', () => {
    const text = renderInstructionsReport(
      instructionsReport({ FY_SESSION_ID: 'wren', FY_HYPERMEDIA: '1', FY_PASSIVE: '' }),
      'fy',
    );
    expect(text).toContain('Sections ferret wren launched with:');
    expect(text).toContain('  ✓ Hypermedia: on');
    expect(text).toContain('  ✗ Lessons: off. The owner turns it on');
    expect(text).toContain('fixed for this run');
  });
});
