import { describe, it } from 'bun:test';
import should from 'should';
import {
  type AssembleInflightReportInput,
  assembleInflightReport,
  type OpenToolInfo,
  type ProcessInfo,
} from '../../../../daemon/lib/moves/inflight-report.ts';
import { interruptedCount, restartNotice } from '../../../../daemon/lib/moves/restart-notice.ts';
import type { InflightVerdict } from '../../../../daemon/lib/moves/verdict.ts';

const REPORT = '/state/sessions/session-1/move-inflight.md';

const tool = (verdict: InflightVerdict): OpenToolInfo => ({
  toolUseId: `tool-${verdict}`,
  name: 'Bash',
  summary: 'bun test',
  verdict,
});

const proc = (verdict: InflightVerdict, pid = 900): ProcessInfo => ({ pid, argv: 'bun test', verdict });

const report = (overrides: Partial<AssembleInflightReportInput> = {}) =>
  assembleInflightReport({
    status: 'tool_running',
    turn: 4,
    openTools: [],
    processes: { kind: 'observed', processes: [] },
    codexBackgroundTerminals: 0,
    ...overrides,
  });

describe('restartNotice', () => {
  it('should say nothing when the session was not mid-turn', () => {
    // Arrange
    const idle = report({
      status: 'waiting',
      processes: { kind: 'observed', processes: [proc('destructive_to_interrupt')] },
    });

    // Act + Assert
    should(restartNotice(idle, REPORT, 'interactive')).be.undefined();
  });

  it('should say nothing when the session was busy but everything it ran is known safe', () => {
    // Arrange
    const safe = report({
      openTools: [tool('safe_to_kill')],
      processes: { kind: 'observed', processes: [proc('safe_to_kill')] },
    });

    // Act + Assert
    should(restartNotice(safe, REPORT, 'interactive')).be.undefined();
  });

  it('should tell a session that was mid-turn with nothing open that its turn was interrupted, to re-read and continue', () => {
    for (const mode of ['interactive', 'auto'] as const) {
      // Arrange
      const thinking = report({ status: 'thinking' });

      // Act
      const notice = restartNotice(thinking, REPORT, mode);

      // Assert
      should(thinking.midTurn).be.true();
      should(notice).equal(
        'Ferretry restarted you mid-turn, and nothing you were running was lost. Your previous turn was interrupted mid-way: re-read the end of the conversation to see where it stopped, then continue from there.',
      );
    }
  });

  it('should add the same pick-up sentence when commands were interrupted too', () => {
    // Act
    const notice = restartNotice(report({ openTools: [tool('destructive_to_interrupt')] }), REPORT, 'interactive');

    // Assert
    should(notice).match(/Your previous turn was interrupted mid-way: re-read the end of the conversation/);
    should(notice).match(/read \/state\/sessions\/session-1\/move-inflight\.md/);
  });

  it('should still tell an auto session, whose resume would otherwise type "continue the assigned task"', () => {
    // Arrange
    const idle = report({ status: 'waiting' });

    // Act
    const notice = restartNotice(idle, REPORT, 'auto') ?? '';

    // Assert
    should(notice).startWith('Ferretry restarted you, and nothing was interrupted.');
    should(notice).not.startWith('[');
    should(notice).not.containEql('not from the owner');
    should(restartNotice(report({ openTools: [tool('unknown')] }), REPORT, 'auto') ?? '').startWith(
      'Ferretry restarted you mid-turn',
    );
  });

  it('should send a Ferretry notice naming the one interrupted command', () => {
    // Arrange
    const busy = report({
      openTools: [tool('re_armable')],
      processes: { kind: 'observed', processes: [proc('re_armable')] },
    });

    // Act
    const notice = restartNotice(busy, REPORT, 'interactive') ?? '';

    // Assert
    should(notice).startWith('Ferretry restarted you mid-turn, and 1 command was interrupted.');
    should(notice).not.containEql('not from the owner');
    should(notice).containEql(`read ${REPORT}`);
  });

  it('should pluralise and count a tool call and its process once', () => {
    // Arrange
    const busy = report({
      openTools: [tool('re_armable'), tool('unknown')],
      processes: { kind: 'observed', processes: [proc('re_armable'), proc('unknown', 901), proc('safe_to_kill', 902)] },
      codexBackgroundTerminals: 1,
    });

    // Act + Assert
    should(interruptedCount(busy)).equal(3);
    should(restartNotice(busy, REPORT, 'interactive') ?? '').startWith(
      'Ferretry restarted you mid-turn, and 3 commands were interrupted.',
    );
  });

  it('should admit it could not tell what was running rather than stay silent', () => {
    // Arrange
    const blind = report({
      processes: { kind: 'unobservable', reason: 'the process table could not be read: ps failed' },
    });

    // Act + Assert
    should(interruptedCount(blind)).equal(0);
    should(restartNotice(blind, REPORT, 'interactive') ?? '').startWith(
      'Ferretry restarted you mid-turn, and what was running could not be checked.',
    );
  });
});
