import { describe, it } from 'bun:test';
import should from 'should';
import {
  assembleInflightReport,
  gateInflight,
  type OpenToolInfo,
  type ProcessInfo,
  type ProcessObservation,
} from '../../../src/lib/migrate/inflight-report.ts';

const tool = (verdict: OpenToolInfo['verdict']): OpenToolInfo => ({
  toolUseId: 'tool-1',
  name: 'Bash',
  summary: 'command',
  verdict,
});
const process = (verdict: ProcessInfo['verdict']): ProcessInfo => ({ pid: 42, argv: 'command', verdict });
const seen = (...processes: readonly ProcessInfo[]): ProcessObservation => ({ kind: 'observed', processes });
const blind = (reason: string): ProcessObservation => ({ kind: 'unobservable', reason });

describe('migration in-flight reporting', () => {
  it('should consider an inactive session with only safe work empty', () => {
    // Act
    const actual = assembleInflightReport({
      status: 'waiting',
      turn: 4,
      openTools: [],
      processes: seen(process('safe_to_kill')),
      codexBackgroundTerminals: -1,
    });

    // Assert
    should(actual.empty).be.true();
    should(actual.blindSpots).deepEqual([]);
    should(actual.codexBackgroundTerminals).equal(0);
    should(actual.worstVerdict).equal('safe_to_kill');
    should(gateInflight(actual)).deepEqual({ proceed: true, forced: false, reason: 'no in-flight work' });
  });

  it('should refuse an active session whose pane shows no work at all', () => {
    // Act
    const actual = assembleInflightReport({
      status: 'running',
      turn: 1,
      openTools: [],
      processes: seen(),
      codexBackgroundTerminals: 0,
    });

    // Assert — a running session with nothing visible is a blind spot, not an idle session.
    should(actual.empty).be.false();
    should(actual.blindSpots).deepEqual(['the session reports running work but nothing was observable in its pane']);
    should(actual.worstVerdict).equal('unknown');
    should(gateInflight(actual)).deepEqual({
      proceed: false,
      forced: false,
      reason: 'refused: the session reports running work but nothing was observable in its pane',
    });
    should(gateInflight(actual, { force: true })).deepEqual({
      proceed: true,
      forced: true,
      reason: 'forced past the session reports running work but nothing was observable in its pane',
    });
  });

  it('should refuse a session that reports a subprocess the pane walk cannot find', () => {
    // Act
    const actual = assembleInflightReport({
      status: 'waiting',
      turn: 2,
      openTools: [],
      processes: seen(),
      codexBackgroundTerminals: 0,
      subprocessSince: '2026-07-31T00:00:00.000Z',
    });

    // Assert
    should(actual.blindSpots).deepEqual(['the session reports waiting work but nothing was observable in its pane']);
    should(gateInflight(actual).proceed).be.false();
  });

  it('should refuse when the pane could not be inspected at all', () => {
    // Act
    const actual = assembleInflightReport({
      status: 'completed',
      turn: 3,
      openTools: [],
      processes: blind('ps exited 1: cannot allocate memory'),
      codexBackgroundTerminals: 0,
    });

    // Assert — a failed inspection must never read as a clean session.
    should(actual.empty).be.false();
    should(actual.processes).deepEqual([]);
    should(actual.blindSpots).deepEqual(['ps exited 1: cannot allocate memory']);
    should(actual.worstVerdict).equal('unknown');
    should(gateInflight(actual)).deepEqual({
      proceed: false,
      forced: false,
      reason: 'refused: ps exited 1: cannot allocate memory',
    });
  });

  it('should not raise a blind spot when an active session has visible safe work', () => {
    // Act
    const actual = assembleInflightReport({
      status: 'tool_running',
      turn: 8,
      openTools: [],
      processes: seen(process('safe_to_kill')),
      codexBackgroundTerminals: 0,
    });

    // Assert
    should(actual.blindSpots).deepEqual([]);
    should(actual.empty).be.false();
    should(gateInflight(actual)).deepEqual({ proceed: true, forced: false, reason: 'in-flight work is safe_to_kill' });
  });

  it('should fail closed on unaccountable background work', () => {
    // Act
    const actual = assembleInflightReport({
      status: 'waiting',
      turn: 5,
      openTools: [tool('re_armable')],
      processes: seen(process('safe_to_kill')),
      codexBackgroundTerminals: 2,
      subprocessSince: '2026-07-31T00:00:00.000Z',
    });

    // Assert
    should(actual).match({
      empty: false,
      discrepancy: 2,
      worstVerdict: 'unknown',
      subprocessSince: '2026-07-31T00:00:00.000Z',
    });
    should(actual.blindSpots).deepEqual([]);
    should(gateInflight(actual)).deepEqual({
      proceed: false,
      forced: false,
      reason: 'refused: in-flight work is unknown',
    });
    should(gateInflight(actual, { force: true })).deepEqual({
      proceed: true,
      forced: true,
      reason: 'forced past in-flight work is unknown',
    });
  });

  it('should refuse destructive work while allowing re-armable work', () => {
    // Arrange
    const rearmable = assembleInflightReport({
      status: 'waiting',
      turn: 6,
      openTools: [tool('re_armable')],
      processes: seen(),
      codexBackgroundTerminals: 0,
    });
    const destructive = assembleInflightReport({
      status: 'waiting',
      turn: 7,
      openTools: [],
      processes: seen(process('destructive_to_interrupt')),
      codexBackgroundTerminals: 0,
    });

    // Act + Assert
    should(gateInflight(rearmable)).deepEqual({ proceed: true, forced: false, reason: 'in-flight work is re_armable' });
    should(gateInflight(destructive)).deepEqual({
      proceed: false,
      forced: false,
      reason: 'refused: in-flight work is destructive_to_interrupt',
    });
  });
});
