import { describe, it } from 'bun:test';
import should from 'should';
import {
  assembleInflightReport,
  gateInflight,
  type OpenToolInfo,
  type ProcessInfo,
} from '../../../src/lib/migrate/inflight-report.ts';

const tool = (verdict: OpenToolInfo['verdict']): OpenToolInfo => ({
  toolUseId: 'tool-1',
  name: 'Bash',
  summary: 'command',
  verdict,
});
const process = (verdict: ProcessInfo['verdict']): ProcessInfo => ({ pid: 42, argv: 'command', verdict });

describe('migration in-flight reporting', () => {
  it('should consider an inactive session with only safe work empty', () => {
    // Act
    const actual = assembleInflightReport({
      status: 'waiting',
      turn: 4,
      openTools: [],
      processes: [process('safe_to_kill')],
      codexBackgroundTerminals: -1,
    });

    // Assert
    should(actual.empty).be.true();
    should(actual.codexBackgroundTerminals).equal(0);
    should(actual.worstVerdict).equal('safe_to_kill');
    should(gateInflight(actual)).deepEqual({ proceed: true, forced: false, reason: 'no in-flight work' });
  });

  it('should retain an active status even when no other signal is visible', () => {
    // Act
    const actual = assembleInflightReport({
      status: 'running',
      turn: 1,
      openTools: [],
      processes: [],
      codexBackgroundTerminals: 0,
    });

    // Assert
    should(actual.empty).be.false();
    should(gateInflight(actual)).deepEqual({ proceed: true, forced: false, reason: 'in-flight work is safe_to_kill' });
  });

  it('should fail closed on unaccountable background work', () => {
    // Act
    const actual = assembleInflightReport({
      status: 'waiting',
      turn: 5,
      openTools: [tool('re_armable')],
      processes: [process('safe_to_kill')],
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
    should(gateInflight(actual)).deepEqual({
      proceed: false,
      forced: false,
      reason: 'refused: in-flight work is unknown',
    });
    should(gateInflight(actual, { force: true })).deepEqual({
      proceed: true,
      forced: true,
      reason: 'forced past unknown in-flight work',
    });
  });

  it('should refuse destructive work while allowing re-armable work', () => {
    // Arrange
    const rearmable = assembleInflightReport({
      status: 'waiting',
      turn: 6,
      openTools: [tool('re_armable')],
      processes: [],
      codexBackgroundTerminals: 0,
    });
    const destructive = assembleInflightReport({
      status: 'waiting',
      turn: 7,
      openTools: [],
      processes: [process('destructive_to_interrupt')],
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
