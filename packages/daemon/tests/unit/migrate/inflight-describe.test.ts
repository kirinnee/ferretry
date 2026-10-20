import { describe, it } from 'bun:test';
import should from 'should';
import { describeInflight, refusalSentence } from '../../../src/lib/migrate/inflight-describe.ts';
import {
  assembleInflightReport,
  type AssembleInflightReportInput,
  type ProcessInfo,
} from '../../../src/lib/migrate/inflight-report.ts';

const report = (input: Partial<AssembleInflightReportInput>) =>
  assembleInflightReport({
    status: 'waiting',
    turn: 13,
    openTools: [],
    processes: { kind: 'observed', processes: [] },
    codexBackgroundTerminals: 0,
    ...input,
  });

const seen = (...processes: readonly ProcessInfo[]) => ({ kind: 'observed' as const, processes });

const ownTools: ProcessInfo = {
  pid: 26_965,
  argv: 'fy mcp serve',
  startedSecondsAgo: 86_400,
  verdict: 'safe_to_kill',
  known: { kind: 'ferretry-tools', label: 'The Ferretry tools server' },
};
const stranger: ProcessInfo = { pid: 7, argv: 'some-vendor-tool --watch', startedSecondsAgo: 120, verdict: 'unknown' };
const push: ProcessInfo = {
  pid: 8,
  argv: 'git push origin main',
  startedSecondsAgo: 5,
  verdict: 'destructive_to_interrupt',
};
const build: ProcessInfo = { pid: 9, argv: 'bun test', startedSecondsAgo: 30, verdict: 're_armable' };
const peek: ProcessInfo = { pid: 10, argv: 'sleep 1', startedSecondsAgo: 1, verdict: 'safe_to_kill' };

describe('the in-flight inventory, in plain words', () => {
  it('should list an unknown program as the blocker and count the agent’s own processes apart', () => {
    // Act
    const actual = describeInflight(report({ status: 'running', processes: seen(ownTools, stranger, build, peek) }));

    // Assert
    should(actual).deepEqual({
      status: 'running',
      turn: 13,
      blockedBy: 'unknown',
      restartsWithCli: 1,
      items: [
        {
          kind: 'process',
          verdict: 'unknown',
          title: 'A program Ferretry doesn’t recognise is running',
          detail: 'some-vendor-tool --watch',
          age: '2m',
          blocks: true,
        },
        {
          kind: 'process',
          verdict: 're_armable',
          title: 'A build, test or check is running — it can simply be run again',
          detail: 'bun test',
          age: '30s',
          blocks: false,
        },
        {
          kind: 'process',
          verdict: 'safe_to_kill',
          title: 'A short read-only command is running',
          detail: 'sleep 1',
          age: '1s',
          blocks: false,
        },
      ],
    });
  });

  it('should call destructive work destructive, ahead of anything merely unknown', () => {
    // Act
    const actual = describeInflight(report({ processes: seen(stranger, push) }));

    // Assert
    should(actual.blockedBy).equal('destructive');
    should(actual.items.map(item => item.title)).deepEqual([
      'A command that changes things is running — stopping it could leave work half-done',
      'A program Ferretry doesn’t recognise is running',
    ]);
  });

  it('should explain a blind spot without ps jargon, and keep the daemon’s reason as detail', () => {
    // Act
    const ps = describeInflight(
      report({ processes: { kind: 'unobservable', reason: 'the process table could not be read: ps exited 1' } }),
    );
    const quiet = describeInflight(report({ status: 'running' }));
    const other = describeInflight(report({ processes: { kind: 'unobservable', reason: 'tmux would not answer' } }));

    // Assert
    should(ps.blockedBy).equal('unreadable');
    should(ps.items[0]).match({
      kind: 'unreadable',
      title: 'Ferretry couldn’t list the agent’s processes on this machine (ps failed)',
      detail: 'the process table could not be read: ps exited 1',
    });
    should(quiet.items[0]?.title).equal('The agent says it is working, but Ferretry can’t see what it is running');
    should(other.items[0]?.title).equal('Ferretry couldn’t check what the agent is running');
  });

  it('should describe open tools and background terminals', () => {
    // Act
    const actual = describeInflight(
      report({
        openTools: [
          { toolUseId: 't1', name: 'Bash', summary: 'deploy.sh', verdict: 'unknown' },
          { toolUseId: 't2', name: 'Bash', summary: 'git commit -m x', verdict: 'destructive_to_interrupt' },
          { toolUseId: 't3', name: 'Read', summary: '/etc/hosts', verdict: 'safe_to_kill' },
        ],
        codexBackgroundTerminals: 1,
      }),
    );
    const plural = describeInflight(report({ codexBackgroundTerminals: 3 }));

    // Assert
    should(actual.items.map(item => item.title)).deepEqual([
      'The agent is in the middle of a Bash call that changes things',
      'The agent is in the middle of a Bash call Ferretry can’t classify',
      'Codex has 1 background terminal Ferretry can’t see into',
      'The agent is in the middle of a Read call',
    ]);
    should(plural.items[0]?.title).equal('Codex has 3 background terminals Ferretry can’t see into');
  });

  it('should say the blocker and how many more there are in one sentence', () => {
    // Act
    const one = refusalSentence(report({ processes: seen(stranger) }));
    const several = refusalSentence(report({ processes: seen(stranger, push, push) }));
    const none = refusalSentence(report({ processes: seen(peek) }));

    // Assert
    should(one).equal('A program Ferretry doesn’t recognise is running — some-vendor-tool --watch');
    should(several).equal(
      'A command that changes things is running — stopping it could leave work half-done — git push origin main (and 2 more)',
    );
    should(none).equal('something the agent is running could not be ruled out');
  });

  it('should let the agent’s own tools server through the gate on a busy session', () => {
    // Arrange — the owner's refusal: status running, turn 13, only `fy mcp serve` below the pane.
    const actual = report({ status: 'running', turn: 13, processes: seen(ownTools) });

    // Assert
    should(actual.worstVerdict).equal('safe_to_kill');
    should(describeInflight(actual).items).deepEqual([]);
    should(describeInflight(actual).restartsWithCli).equal(1);
  });
});
