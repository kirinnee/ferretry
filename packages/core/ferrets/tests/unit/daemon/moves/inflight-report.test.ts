import { describe, it } from 'bun:test';
import should from 'should';
import {
  assembleInflightReport,
  gateInflight,
  type OpenToolInfo,
  type ProcessInfo,
  type ProcessObservation,
} from '../../../../daemon/lib/moves/inflight-report.ts';

const tool = (verdict: OpenToolInfo['verdict']): OpenToolInfo => ({
  toolUseId: 'tool-1',
  name: 'Bash',
  summary: 'command',
  verdict,
});
const process = (verdict: ProcessInfo['verdict']): ProcessInfo => ({ pid: 42, argv: 'command', verdict });
const seen = (...processes: readonly ProcessInfo[]): ProcessObservation => ({ kind: 'observed', processes });
const blind = (reason: string): ProcessObservation => ({ kind: 'unobservable', reason });

describe('move in-flight reporting', () => {
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

  it('should let a busy session with nothing open through as re-armable — it is mid-turn, thinking', () => {
    // Act
    const actual = assembleInflightReport({
      status: 'thinking',
      turnState: 'working',
      turn: 1,
      openTools: [],
      processes: seen(),
      codexBackgroundTerminals: 0,
    });

    // Assert — the turn is interrupted and picked up again; nothing was observed to lose, and nothing is hidden.
    should(actual.midTurn).be.true();
    should(actual.empty).be.false();
    should(actual.blindSpots).deepEqual([]);
    should(actual.worstVerdict).equal('re_armable');
    should(gateInflight(actual)).deepEqual({ proceed: true, forced: false, reason: 'in-flight work is re_armable' });
  });

  it('should keep every busy status mid-turn, and an idle one not', () => {
    for (const status of ['starting', 'running', 'thinking', 'tool_running', 'retrying'] as const)
      should(
        assembleInflightReport({
          status,
          turnState: 'working',
          turn: 1,
          openTools: [],
          processes: seen(),
          codexBackgroundTerminals: 0,
        }).midTurn,
      ).be.true();
    should(
      assembleInflightReport({
        status: 'waiting',
        turn: 1,
        openTools: [],
        processes: seen(),
        codexBackgroundTerminals: 0,
      }).midTurn,
    ).be.false();
  });

  describe('mid-turn is decided by whose turn it is, over what the agent itself started', () => {
    // Every real ferret has `fy mcp serve` below its pane, and the harness's own helpers say nothing about the turn.
    const helper: ProcessInfo = {
      pid: 7,
      argv: 'fy mcp serve',
      verdict: 'safe_to_kill',
      known: { kind: 'ferretry-tools', label: 'The Ferretry tools server' },
    };
    const input = (
      turnState: 'working' | 'your-turn' | 'needs-input' | undefined,
      ...below: readonly ProcessInfo[]
    ) => ({
      status: 'running' as const,
      ...(turnState === undefined ? {} : { turnState }),
      turn: 3,
      openTools: [],
      processes: seen(...below),
      codexBackgroundTerminals: 0,
    });

    it('should be mid-turn with a known helper below the pane, when the turn is working', () => {
      const actual = assembleInflightReport(input('working', helper));

      should(actual.midTurn).be.true();
      should(actual.blindSpots).deepEqual([]);
      should(actual.worstVerdict).equal('re_armable');
      should(gateInflight(actual).proceed).be.true();
    });

    it('should NOT be mid-turn when the session sits at its prompt, though 5.0 calls that status running', () => {
      for (const turnState of ['your-turn', 'needs-input'] as const) {
        for (const below of [[], [helper]]) {
          const actual = assembleInflightReport(input(turnState, ...below));

          // Not told to "continue from there": nothing was in progress, and nothing is hidden either.
          should(actual.midTurn).be.false();
          should(actual.blindSpots).deepEqual([]);
          should(actual.worstVerdict).equal('safe_to_kill');
          should(gateInflight(actual).proceed).be.true();
        }
      }
    });

    it('should stay a blind spot when the turn watch has no answer, rather than guess the session is idle or working', () => {
      const actual = assembleInflightReport(input(undefined, helper));

      should(actual.midTurn).be.false();
      should(actual.blindSpots).deepEqual(['the session reports running work but nothing was observable in its pane']);
      should(gateInflight(actual).proceed).be.false();
    });

    it('should not be mid-turn when the agent started something, helper or not', () => {
      const actual = assembleInflightReport(input('working', helper, process('re_armable')));

      should(actual.midTurn).be.false();
      should(actual.blindSpots).deepEqual([]);
      should(actual.worstVerdict).equal('re_armable');
    });

    it('should still refuse a working session with a helper whose unknown command is below it', () => {
      const actual = assembleInflightReport(input('working', helper, process('unknown')));

      should(actual.midTurn).be.false();
      should(gateInflight(actual).proceed).be.false();
    });
  });

  it('should still refuse a busy session whose process table could not be read', () => {
    // Act
    const actual = assembleInflightReport({
      status: 'running',
      turn: 1,
      openTools: [],
      processes: blind('the process table could not be read: ps exited 1'),
      codexBackgroundTerminals: 0,
    });

    // Assert — "could not look" is never "nothing there".
    should(actual.midTurn).be.false();
    should(actual.worstVerdict).equal('unknown');
    should(gateInflight(actual).proceed).be.false();
  });

  it('should still refuse a busy session when a caller-supplied signal (tmux, the codex footer) failed', () => {
    // Act
    const actual = assembleInflightReport({
      status: 'running',
      turn: 1,
      openTools: [],
      processes: seen(),
      codexBackgroundTerminals: 0,
      blindSpots: ['the codex pane footer could not be read: no server running'],
    });

    // Assert
    should(actual.midTurn).be.false();
    should(gateInflight(actual).proceed).be.false();
  });

  it('should still refuse a busy session that has a codex background terminal', () => {
    // Act
    const actual = assembleInflightReport({
      status: 'running',
      turn: 1,
      openTools: [],
      processes: seen(),
      codexBackgroundTerminals: 1,
    });

    // Assert
    should(actual.midTurn).be.false();
    should(actual.worstVerdict).equal('unknown');
    should(gateInflight(actual).proceed).be.false();
  });

  it('should still refuse a busy session that reports a subprocess the pane walk cannot find', () => {
    // Act
    const actual = assembleInflightReport({
      status: 'running',
      turn: 1,
      openTools: [],
      processes: seen(),
      codexBackgroundTerminals: 0,
      subprocessSince: '2026-07-31T00:00:00.000Z',
    });

    // Assert
    should(actual.midTurn).be.false();
    should(actual.blindSpots).deepEqual(['the session reports running work but nothing was observable in its pane']);
    should(gateInflight(actual).proceed).be.false();
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
      reason: 'refused: Ferretry couldn’t check what the agent is running — ps exited 1: cannot allocate memory',
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
      reason:
        'refused: Codex has 2 background terminals Ferretry can’t see into — background jobs Ferretry is not keeping; they stop when the ferret moves. Start long jobs with `fy job run` so they survive.',
    });
    should(gateInflight(actual, { force: true })).deepEqual({
      proceed: true,
      forced: true,
      reason:
        'forced past Codex has 2 background terminals Ferretry can’t see into — background jobs Ferretry is not keeping; they stop when the ferret moves. Start long jobs with `fy job run` so they survive.',
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
      reason: 'refused: A command that changes things is running — stopping it could leave work half-done — command',
    });
  });
});
