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
    turnState: 'working',
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

  it('should say nothing special when the session was busy but only the harness’s own helper was below it', () => {
    // Arrange — the helper is relaunched with the CLI; it is not something the agent ran.
    const helper: ProcessInfo = {
      pid: 7,
      argv: 'fy mcp serve',
      verdict: 'safe_to_kill',
      known: { kind: 'ferretry-tools', label: 'The Ferretry tools server' },
    };
    const busy = report({ processes: { kind: 'observed', processes: [helper] } });

    // Act + Assert — it is mid-turn with nothing of the agent's open, and is told only that.
    should(busy.midTurn).be.true();
    for (const mode of ['interactive', 'auto'] as const)
      should(restartNotice(busy, REPORT, mode)).startWith(
        'Ferretry restarted you mid-turn, and nothing you were running was lost.',
      );
  });

  it('should never call the restart quiet when a read-only command the agent had started was stopped', () => {
    // Arrange — a lead blocked in `fy wait <child>` and a search: both safe_to_kill, both gone with the pane.
    const waiting: ProcessInfo = { pid: 901, argv: 'fy wait mwxq1234-abcd', verdict: 'safe_to_kill' };
    const searching: ProcessInfo = { pid: 902, argv: 'rg TODO packages', verdict: 'safe_to_kill' };
    const busy = report({ processes: { kind: 'observed', processes: [waiting, searching] } });

    for (const mode of ['interactive', 'auto'] as const) {
      // Act
      const notice = restartNotice(busy, REPORT, mode) ?? '';

      // Assert
      should(notice).not.containEql('nothing was interrupted');
      should(notice).not.containEql('nothing to re-run');
      should(notice).containEql('2 commands were stopped (fy wait mwxq1234-abcd, rg TODO packages)');
      should(notice).containEql('re-run them if you still need the output');
      should(notice).containEql('Wait again for `mwxq1234-abcd`');
      should(notice).containEql('Your previous turn was interrupted mid-way');
      should(notice).containEql(`read ${REPORT}`);
    }
  });

  it('should name the command of a tool shell and an open tool once, and stop a safe tool call too', () => {
    // Arrange — the same `rg` as an open tool call and as the tool shell's process: one command.
    const wrapped = (payload: string) =>
      `/usr/bin/zsh -c source /h/shell-snapshots/s.sh 2>/dev/null || true && eval '${payload}' < /dev/null && pwd -P >| /tmp/claude-99ff-cwd`;
    const busy = report({
      openTools: [{ toolUseId: 't1', name: 'Bash', summary: 'rg foo', verdict: 'safe_to_kill' }],
      processes: { kind: 'observed', processes: [{ pid: 5, argv: wrapped('rg foo'), verdict: 'safe_to_kill' }] },
    });

    // Act
    const notice = restartNotice(busy, REPORT, 'auto') ?? '';

    // Assert
    should(notice).containEql('1 command was stopped (rg foo); re-run it if you still need the output.');
  });

  it('should not name the stopped commands of a session that was not busy', () => {
    // Arrange
    const idle = report({
      status: 'waiting',
      processes: { kind: 'observed', processes: [{ pid: 9, argv: 'rg foo', verdict: 'safe_to_kill' }] },
    });

    // Act + Assert
    should(restartNotice(idle, REPORT, 'interactive')).be.undefined();
    should(restartNotice(idle, REPORT, 'auto') ?? '').startWith('Ferretry restarted you, and nothing was interrupted.');
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

describe('restartNotice — a session at its prompt is never told to continue', () => {
  const stray = (argv: string): ProcessInfo => ({ pid: 910, argv, verdict: 'safe_to_kill' });
  const MID_TURN_WORDS = /mid-turn|mid-way|continue from there/u;
  const atPrompt = (processes: readonly ProcessInfo[]) =>
    report({ status: 'running', turnState: 'your-turn', processes: { kind: 'observed', processes } });

  it('should say only that background commands were stopped for running + your-turn + a stray safe process', () => {
    for (const argv of ['eza --icons auto --git -la', 'sleep 30', 'fy wait mwxx1234']) {
      const idle = atPrompt([stray(argv)]);
      should(idle.working).be.false();
      for (const mode of ['interactive', 'auto'] as const) {
        const notice = restartNotice(idle, REPORT, mode) ?? '';
        should(notice).match(/1 background command was stopped/u);
        should(notice).match(/re-run it if you still need it/u);
        should(notice).not.match(MID_TURN_WORDS);
        should(notice).not.match(/nothing was interrupted/u);
      }
    }
  });

  it('should still ask the agent to wait again for a stopped fy wait, without the pick-up sentence', () => {
    const notice = restartNotice(atPrompt([stray('fy wait mwxx1234')]), REPORT, 'auto') ?? '';
    should(notice).match(/Wait again for `mwxx1234`/u);
    should(notice).not.match(MID_TURN_WORDS);
  });

  it('should say only that for an idle session with a re-armable background job', () => {
    const idle = atPrompt([{ pid: 911, argv: 'bun test', verdict: 're_armable' }]);
    const notice = restartNotice(idle, REPORT, 'interactive') ?? '';
    should(notice).match(/background command was stopped \(bun test\)/u);
    should(notice).not.match(MID_TURN_WORDS);
  });

  it('should give the quiet notice (auto) or nothing (interactive) for an idle session with nothing stopped', () => {
    const idle = atPrompt([]);
    should(restartNotice(idle, REPORT, 'auto')).startWith('Ferretry restarted you, and nothing was interrupted.');
    should(restartNotice(idle, REPORT, 'interactive')).be.undefined();
  });

  it('should still use the mid-turn wording for running + working + a stopped fy wait', () => {
    const working = report({
      status: 'running',
      turnState: 'working',
      processes: { kind: 'observed', processes: [stray('fy wait mwxx1234')] },
    });
    should(working.working).be.true();
    const notice = restartNotice(working, REPORT, 'auto') ?? '';
    should(notice).match(/mid-turn/u);
    should(notice).match(/continue from there/u);
    should(notice).match(/Wait again for `mwxx1234`/u);
  });

  it('should treat a session waiting on a tool-permission prompt as mid-turn, losing a pending tool call', () => {
    const waiting = report({
      status: 'running',
      turnState: 'needs-input',
      awaitingPermission: true,
      processes: { kind: 'observed', processes: [] },
    });
    should(waiting.midTurn).be.true();
    should(waiting.working).be.true();
    should(restartNotice(waiting, REPORT, 'auto')).match(/mid-turn/u);
    // needs-input WITHOUT a pending permission stays at its prompt.
    should(report({ status: 'running', turnState: 'needs-input' }).working).be.false();
  });
});
