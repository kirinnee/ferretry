import { describe, it } from 'bun:test';
import should from 'should';
import { identifyAgentJobs } from '../../../../daemon/lib/moves/agent-jobs.ts';
import { identifyKnownProcesses } from '../../../../daemon/lib/moves/harness-provenance.ts';
import { describeInflight } from '../../../../daemon/lib/moves/inflight-describe.ts';
import { assembleInflightReport, gateInflight } from '../../../../daemon/lib/moves/inflight-report.ts';
import { markJobAttachments } from '../../../../daemon/lib/moves/job-attachments.ts';
import { withUnkeptJobs } from '../../../../daemon/lib/moves/preflight-service.ts';
import { codexAppServerJobs } from '../../../../daemon/adapters/moves/process-inventory.ts';
import { renderInflightCli, renderInflightReport } from '../../../../daemon/lib/moves/report-render.ts';
import { inventoryProcesses, type ProcRow } from '../../../../daemon/lib/moves/process-table.ts';

const ROOT = 5000;
const tool = (command: string): string =>
  `/usr/bin/zsh -c source /home/u/.claude/shell-snapshots/snapshot-zsh-1.sh 2>/dev/null || true && eval '${command}' < /dev/null && pwd -P >| /tmp/claude-1a2b-cwd`;
const row = (pid: number, ppid: number, argv: string, startedSecondsAgo = 600): ProcRow => ({
  pid,
  ppid,
  argv,
  startedSecondsAgo,
});

/** Runs the same steps the pane inventory runs, over rows the test writes. */
function inventory(
  rows: readonly ProcRow[],
  attachments: readonly { pid: number; jobId: string; jobName: string }[],
  taskIds: ReadonlyMap<number, string> = new Map(),
) {
  const recognised = identifyKnownProcesses(rows, {
    rootPid: ROOT,
    binaryName: 'fy',
    toolsServerArguments: ['mcp', 'serve'],
    statuslineSubcommand: 'statusline',
    configuredServers: [],
  });
  const jobs = identifyAgentJobs(rows, ROOT, recognised);
  const known = markJobAttachments(rows, recognised, jobs, attachments, 'fy');
  return inventoryProcesses(rows, new Map(), known, new Set(), jobs, {
    taskIds,
    codexJobs: codexAppServerJobs(rows, known),
  });
}

const pane = (...rows: ProcRow[]) => [row(5001, ROOT, 'claude --model m', 7200), ...rows.map(one => ({ ...one }))];
const report = (processes: ReturnType<typeof inventory>, extra: { codex?: number } = {}) =>
  assembleInflightReport({
    status: 'running',
    turnState: 'working',
    turn: 4,
    openTools: [],
    processes: { kind: 'observed', processes },
    codexBackgroundTerminals: extra.codex ?? 0,
  });

describe('an attachment to a kept job, as the gate sees it', () => {
  it('should be known only when the keeper’s registry lists its pid: the argv alone proves nothing', () => {
    // Arrange — two processes both spelled `fy job attach`; the keeper vouches for one.
    const rows = pane(
      row(6001, 5001, tool('fy job attach build')),
      row(6002, 6001, 'fy job attach build'),
      row(6011, 5001, tool('fy job attach lookalike')),
      row(6012, 6011, 'fy job attach lookalike'),
    );

    // Act
    const processes = inventory(rows, [{ pid: 6002, jobId: 'abc123abc123', jobName: 'build' }]);
    const byPid = new Map(processes.map(entry => [entry.pid, entry]));

    // Assert
    should(byPid.get(6002)?.known?.kind).equal('job-attachment');
    should(byPid.get(6002)?.known?.attachment).deepEqual({ jobId: 'abc123abc123', jobName: 'build' });
    should(byPid.get(6002)?.verdict).equal('safe_to_kill');
    should(byPid.get(6012)?.known).be.undefined();
  });

  it('should treat the tool shell that carries only the attachment as safe too, and the card lists the attachment once', () => {
    // Arrange
    const rows = pane(row(6001, 5001, tool('fy job attach build')), row(6002, 6001, 'fy job attach build'));
    const processes = inventory(rows, [{ pid: 6002, jobId: 'abc123abc123', jobName: 'build' }]);

    // Act
    const decision = gateInflight(report(processes));
    const items = describeInflight(report(processes));

    // Assert
    should(processes.find(entry => entry.pid === 6001)?.verdict).equal('safe_to_kill');
    should(decision.proceed).be.true();
    should(items.items.filter(one => one.kind === 'process')).deepEqual([
      {
        kind: 'process',
        verdict: 'safe_to_kill',
        title: 'attachment to job build (kept; re-attach after the move)',
        detail: 'fy job attach abc123abc123',
        age: '10m',
        blocks: false,
      },
    ]);
    should(items.restartsWithCli).equal(1); // the harness itself; attachments are not "restarted with the CLI"
  });

  it('should keep a tool shell that runs other things on its own verdict', () => {
    // Arrange — the shell started the attachment AND a `git push`.
    const rows = pane(
      row(6001, 5001, tool('fy job attach build & git push origin main')),
      row(6002, 6001, 'fy job attach build'),
      row(6003, 6001, 'git push origin main'),
    );

    // Act
    const processes = inventory(rows, [{ pid: 6002, jobId: 'abc123abc123', jobName: 'build' }]);

    // Assert
    should(processes.find(entry => entry.pid === 6002)?.verdict).equal('safe_to_kill');
    should(processes.find(entry => entry.pid === 6001)?.known).be.undefined();
    should(gateInflight(report(processes)).proceed).be.false();
  });

  it('should not know an attachment outside this pane, because only the pane’s own rows are looked at', () => {
    const rows = pane(row(6001, 5001, tool('sleep 5')));
    const processes = inventory(rows, [{ pid: 9999, jobId: 'abc123abc123', jobName: 'build' }]);
    should(processes.every(entry => entry.known?.kind !== 'job-attachment')).be.true();
  });
});

describe('a background job Ferretry is not keeping', () => {
  const shell = row(6001, 5001, tool('bash /tmp/merge-all.sh 765'));
  const child = row(6002, 6001, 'bash /tmp/merge-all.sh 765');

  it('should be named on the card with the plain sentence, and keep the classifier’s verdict', () => {
    // Arrange
    const processes = inventory(pane(shell, child), [], new Map([[6001, 'task1']]));
    const marked = withUnkeptJobs({ kind: 'observed', processes }, []);
    const view = describeInflight(
      assembleInflightReport({
        status: 'running',
        turnState: 'working',
        turn: 4,
        openTools: [],
        processes: marked,
        codexBackgroundTerminals: 0,
      }),
    );

    // Assert
    const item = view.items.find(one => one.pid === 6001);
    should(item?.title).equal(
      'bash /tmp/merge-all.sh 765 — a background job Ferretry is not keeping; it stops when the ferret moves. Start long jobs with `fy job run` so they survive.',
    );
    should(item?.blocks).equal(item?.verdict === 'unknown' || item?.verdict === 'destructive_to_interrupt');
    should(item?.backgroundJob).be.true();
  });

  it('should not name the tool call that is still running: an open Bash call with the same command is that call', () => {
    // Arrange
    const processes = inventory(pane(shell, child), [], new Map([[6001, 'task1']]));
    const open = [
      { toolUseId: 't1', name: 'Bash', summary: 'bash /tmp/merge-all.sh 765', verdict: 'unknown' as const },
    ];

    // Act
    const marked = withUnkeptJobs({ kind: 'observed', processes }, open);

    // Assert
    should(marked.kind === 'observed' && marked.processes.some(entry => entry.unkeptJob === true)).be.false();
  });

  it('should not name a shell whose stdout is not a Claude task file (a foreground call of another harness)', () => {
    const processes = inventory(pane(shell, child), []);
    const marked = withUnkeptJobs({ kind: 'observed', processes }, []);
    should(marked.kind === 'observed' && marked.processes.some(entry => entry.unkeptJob === true)).be.false();
  });

  it('should be listed in the forensic report and the terminal table', () => {
    // Arrange
    const processes = inventory(pane(shell, child), [], new Map([[6001, 'task1']]));
    const marked = withUnkeptJobs({ kind: 'observed', processes }, []);
    const subject = assembleInflightReport({
      status: 'running',
      turnState: 'working',
      turn: 4,
      openTools: [],
      processes: marked,
      codexBackgroundTerminals: 0,
    });

    // Act
    const text = renderInflightReport(subject, {
      sessionId: 's',
      targetAgent: 'a',
      forced: false,
      at: '2026-11-16T00:00:00Z',
    });
    const table = renderInflightCli(subject);

    // Assert
    should(text).containEql('### Background jobs Ferretry is not keeping');
    should(text).containEql('`bash /tmp/merge-all.sh 765`');
    should(table).containEql('a background job Ferretry is not keeping');
  });

  it('should list kept jobs in the forensic report as nothing lost', () => {
    // Arrange
    const processes = inventory(
      pane(row(6001, 5001, tool('fy job attach build')), row(6002, 6001, 'fy job attach build')),
      [{ pid: 6002, jobId: 'abc123abc123', jobName: 'build' }],
    );

    // Act
    const text = renderInflightReport(report(processes), {
      sessionId: 's',
      targetAgent: 'a',
      forced: false,
      at: '2026-11-16T00:00:00Z',
    });

    // Assert
    should(text).containEql('### Kept jobs (attachments)');
    should(text).containEql('`fy job attach abc123abc123`');
    should(renderInflightCli(report(processes))).containEql('attachment to job build (kept; re-attach after the move)');
  });

  it('should be what a Codex app-server’s own commands are, and nothing else under it', () => {
    // Arrange
    const rows = [
      row(5100, 5001, 'codex app-server --managed-daemon'),
      row(5101, 5100, 'sleep 3000'),
      row(5102, 5101, 'sleep 1'),
      row(5200, 5001, 'sleep 4'),
    ];

    // Act
    const found = codexAppServerJobs(rows, new Map());

    // Assert
    should([...found]).deepEqual([5101]);
  });

  it('should reword the Codex background-terminal count as an un-kept job', () => {
    const view = describeInflight(report(inventory(pane(), []), { codex: 2 }));
    should(view.items[0]?.title).equal(
      'Codex has 2 background terminals Ferretry can’t see into — background jobs Ferretry is not keeping; they stop when the ferret moves. Start long jobs with `fy job run` so they survive.',
    );
    should(view.items[0]?.blocks).be.true();
  });
});

describe('what the gate refuses to take on trust', () => {
  it('should keep blocking a program that is not `fy job attach` even when the registry lists its pid (a forged entry)', () => {
    // Arrange — the review's probe: an unrecognised leaf program in a Claude-shaped tool shell, registered by pid.
    const rows = pane(row(6001, 5001, tool('./mystery-tool --serve')), row(6002, 6001, './mystery-tool --serve'));

    // Act
    const processes = inventory(rows, [{ pid: 6002, jobId: 'abc123abc123', jobName: 'build' }]);

    // Assert
    should(processes.find(entry => entry.pid === 6002)?.known).be.undefined();
    should(processes.find(entry => entry.pid === 6002)?.verdict).equal('unknown');
    should(gateInflight(report(processes)).proceed).be.false();
  });

  it('should not mark a shell safe because its current child is the attachment while `make` is still to come', () => {
    // Arrange — `fy job attach x && make`: only the attach has started.
    const rows = pane(
      row(6001, 5001, tool('fy job attach build && make deploy')),
      row(6002, 6001, 'fy job attach build'),
    );

    // Act
    const processes = inventory(rows, [{ pid: 6002, jobId: 'abc123abc123', jobName: 'build' }]);

    // Assert
    should(processes.find(entry => entry.pid === 6002)?.known?.kind).equal('job-attachment');
    should(processes.find(entry => entry.pid === 6001)?.known).be.undefined();
    should(gateInflight(report(processes)).proceed).be.false();
  });

  it('should still treat a shell that only runs the attachment and harmless steps as safe', () => {
    const rows = pane(row(6001, 5001, tool('cd /work && fy job attach build')), row(6002, 6001, 'fy job attach build'));
    const processes = inventory(rows, [{ pid: 6002, jobId: 'abc123abc123', jobName: 'build' }]);
    should(gateInflight(report(processes)).proceed).be.true();
  });

  it('should not call an attachment to a job that has already ended "kept; re-attach after the move"', () => {
    const rows = pane(row(6001, 5001, tool('fy job attach build')), row(6002, 6001, 'fy job attach build'));
    const processes = inventory(rows, [
      { pid: 6002, jobId: 'abc123abc123', jobName: 'build', jobEnded: true } as never,
    ]);

    const items = describeInflight(report(processes)).items.filter(one => one.kind === 'process');

    should(items).have.length(1);
    should(items[0]?.title).equal(
      'attachment to job build (the job has already ended; this attachment is just exiting)',
    );
    should(renderInflightCli(report(processes))).not.containEql('re-attach after the move');
    should(
      renderInflightReport(report(processes), { sessionId: 's', targetAgent: 'a', forced: false, at: 'x' }),
    ).not.containEql('Kept jobs (attachments)');
  });
});

describe('when a tool shell is a background job and when it is only a command', () => {
  const shell = row(6001, 5001, tool('sleep 299'));
  const child = row(6002, 6001, 'sleep 299');
  const observed = () => ({
    kind: 'observed' as const,
    processes: inventory(pane(shell, child), [], new Map([[6001, 'task1']])),
  });
  const flags = (marked: ReturnType<typeof withUnkeptJobs>) =>
    marked.kind === 'observed' ? marked.processes.find(entry => entry.pid === 6001) : undefined;

  it('should not claim a background job while an open tool call is unidentified (the transcript tail is empty on this base)', () => {
    // Arrange — the foreground `sleep 299` writes to tasks/<id>.output too; its tool call is known only by id.
    const open = [
      { toolUseId: 't1', name: '?', summary: '(command not found in chat tail)', verdict: 'unknown' as const },
    ];

    // Act
    const entry = flags(withUnkeptJobs(observed(), open));

    // Assert
    should(entry?.unkeptJob).be.undefined();
    should(entry?.agentCommand).be.true();
  });

  it('should not claim it while an open Bash call has no command text', () => {
    const open = [{ toolUseId: 't1', name: 'Bash', summary: 'Bash', verdict: 'unknown' as const }];
    should(flags(withUnkeptJobs(observed(), open))?.unkeptJob).be.undefined();
  });

  it('should claim a background job only when every open tool is identified and none matches the shell', () => {
    const open = [{ toolUseId: 't1', name: 'Read', summary: '/work/a.ts', verdict: 'safe_to_kill' as const }];
    should(flags(withUnkeptJobs(observed(), open))?.unkeptJob).be.true();
  });

  it('should say "a command the agent is running" on the card, and never "background job", for the uncertain one', () => {
    const open = [
      { toolUseId: 't1', name: '?', summary: '(command not found in chat tail)', verdict: 'unknown' as const },
    ];
    const marked = withUnkeptJobs(observed(), open);
    const subject = assembleInflightReport({
      status: 'running',
      turnState: 'working',
      turn: 4,
      openTools: open,
      processes: marked,
      codexBackgroundTerminals: 0,
    });

    const item = describeInflight(subject).items.find(one => one.pid === 6001);

    should(item?.title).equal('sleep 299 — a command the agent is running; it stops when the ferret moves.');
    should(renderInflightCli(subject)).not.containEql('background job');
    should(renderInflightReport(subject, { sessionId: 's', targetAgent: 'a', forced: false, at: 'x' })).not.containEql(
      'Background jobs Ferretry is not keeping',
    );
  });
});

describe('Codex background terminals the tree already shows', () => {
  const rows = [row(5100, 5001, 'codex app-server --managed-daemon'), row(5101, 5100, 'sleep 3000')];
  const codexReport = (footer: number) => {
    const processes = inventory(rows, []);
    return report(processes, { codex: footer });
  };

  it('should not count the same job twice: the footer count less the children listed as processes', () => {
    const items = describeInflight(codexReport(2)).items;
    should(items.find(one => one.kind === 'terminal')?.title).equal(
      'Codex has 1 background terminal more Ferretry can’t see into — a background job Ferretry is not keeping; it stops when the ferret moves. Start long jobs with `fy job run` so they survive.',
    );
  });

  it('should word the terminal table and the forensic report the same way: no double count', () => {
    should(renderInflightCli(codexReport(1))).containEql('codex 1 background terminal, all listed above');
    should(renderInflightCli(codexReport(3))).containEql('codex 2 background terminals [UNKNOWN');
    const text = renderInflightReport(codexReport(1), { sessionId: 's', targetAgent: 'a', forced: false, at: 'x' });
    should(text).not.containEql('### Codex background terminals');
  });

  it('should keep the blocking item, worded as all listed, when the children cover the footer', () => {
    const item = describeInflight(codexReport(1)).items.find(one => one.kind === 'terminal');
    should(item?.title).equal('Codex counts 1 background terminal, all listed above');
    should(item?.blocks).be.true();
  });
});
