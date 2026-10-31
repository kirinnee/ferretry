import { describe, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import should from 'should';
import {
  agentJobsMessage,
  agentJobsMessageId,
  blockingAgentJobs,
  identifyAgentJobs,
} from '../../../src/lib/migrate/agent-jobs.ts';
import { identifyKnownProcesses } from '../../../src/lib/migrate/harness-provenance.ts';
import { describeInflight } from '../../../src/lib/migrate/inflight-describe.ts';
import { assembleInflightReport } from '../../../src/lib/migrate/inflight-report.ts';
import {
  descendantsOf,
  inventoryProcesses,
  type ProcRow,
  parseProcessTable,
} from '../../../src/lib/migrate/process-table.ts';

const fixture = (name: string): string => readFileSync(`${import.meta.dir}/../../fixtures/ps/${name}`, 'utf8');

function inventoryOf(rows: readonly ProcRow[], rootPid: number) {
  const known = identifyKnownProcesses(rows, { rootPid, binaryName: 'fy', configuredServers: [] });
  const jobs = identifyAgentJobs(rows, rootPid, known);
  return { jobs, processes: inventoryProcesses(rows, new Map(), known, new Set(), jobs) };
}

const fromFixture = (name: string, rootPid: number) =>
  inventoryOf(descendantsOf(rootPid, parseProcessTable(fixture(name))), rootPid);

const reportOf = (processes: ReturnType<typeof inventoryOf>['processes']) =>
  assembleInflightReport({
    status: 'waiting',
    turn: 3,
    openTools: [],
    processes: { kind: 'observed', processes },
    codexBackgroundTerminals: 0,
  });

/** The owner's refusal, as a pane: Claude, its tools server, and a Bash-tool job running a script. */
const OWNER_PANE = `
  5000     4999  2:00:00 claude --model claude-opus-5-5
  5010     5000  2:00:00 fy mcp serve
  5100     5000    04:10 /usr/bin/zsh -c source /home/user/.claude/shell-snapshots/snapshot-zsh-1.sh 2>/dev/null || true && eval 'bash /tmp/merge-all.sh 765' < /dev/null
  5101     5100    04:10 bash /tmp/merge-all.sh 765
  5102     5101    00:05 sleep 5
`;

describe('the agent’s own background jobs', () => {
  it('should trace a Bash-tool shell and everything under it to that shell, from a real Linux listing', () => {
    // Act
    const { jobs, processes } = fromFixture('linux-claude-pane.txt', 66_601);

    // Assert
    should(jobs.get(66_901)).equal(66_901);
    should(jobs.get(66_902)).equal(66_901);
    should(processes.find(entry => entry.pid === 66_902)).match({ argv: 'sleep 600', toolShell: 66_901 });
    // The harness's own helpers are not jobs: the restart relaunches them.
    should(jobs.has(66_728)).be.false();
    should(jobs.has(66_740)).be.false();
  });

  it('should find the jobs under a macOS wrapper, where the CLI is the wrapper’s child', () => {
    // Act — the pane runs a bash wrapper (412), which runs the node CLI (413).
    const { jobs } = fromFixture('macos-claude-pane.txt', 412);

    // Assert
    should([...jobs.keys()].sort()).deepEqual([611, 612, 620, 621]);
    should(jobs.get(621)).equal(620);
  });

  it('should treat a codex exec shell as the agent’s own', () => {
    // Act
    const { jobs } = fromFixture('linux-codex-pane.txt', 678_504);

    // Assert
    should(jobs.get(710_800)).equal(710_800);
    should(jobs.has(710_700)).be.false();
  });

  it('should not count a shell the pane launched the agent THROUGH', () => {
    // Arrange — the pane's process is a login shell that runs the CLI from `bash -c`.
    const rows = parseProcessTable(`
  7000  6999  1:00:00 zsh
  7001  7000  1:00:00 bash -c exec claude --model opus
  7002  7001  1:00:00 claude --model opus
  7003  7002    01:00 /bin/zsh -c eval 'sleep 1800'
`);

    // Act
    const { jobs } = inventoryOf(descendantsOf(7000, rows), 7000);

    // Assert — the wrapper is not a job, and nothing under it is: asking the agent to stop it would be
    // asking the agent to stop itself. No offer is the fail-closed answer.
    should(jobs.size).equal(0);
  });

  it('should not count Claude’s status line, or the person’s own command it chains, as a job', () => {
    // Arrange — the live shape: Claude runs `statusLine.command` through `sh -c` after every turn.
    const rows = parseProcessTable(`
  6001  6000    00:01 /bin/sh -c 'fy' statusline --then '/bin/zsh ~/.config/claude-statusline.zsh'
  6002  6001    00:01 fy statusline --then /bin/zsh ~/.config/claude-statusline.zsh
  6003  6002    00:01 /bin/zsh /home/user/.config/claude-statusline.zsh
  6010  6000    00:01 /bin/sh -c '/nix/store/abc-ferretry/bin/fy' statusline
  6020  6000    00:30 /usr/bin/zsh -c source /home/user/.claude/shell-snapshots/snapshot.sh && eval 'sleep 600'
`);

    // Act
    const { jobs, processes } = inventoryOf(rows, 6000);
    const refusal = describeInflight(reportOf(processes));

    // Assert — the status line is the harness's own and restarts with it; the Bash-tool shell is still a job.
    should([...jobs.keys()]).deepEqual([6020]);
    should(processes.find(entry => entry.pid === 6003)).match({
      verdict: 'safe_to_kill',
      known: { kind: 'status-line' },
    });
    should(processes.find(entry => entry.pid === 6010)?.known?.kind).equal('status-line');
    should(refusal.items.filter(item => item.blocks).map(item => item.pid)).deepEqual([6020]);
  });

  it('should leave a status-line command the AGENT typed into its own shell as its job', () => {
    // Arrange — `fy statusline` run through the Bash tool is parented by the tool shell, not by Claude.
    const rows = parseProcessTable(`
  6101  6100    00:10 /usr/bin/zsh -c eval 'fy statusline'
  6102  6101    00:10 fy statusline
`);

    // Act
    const { jobs } = inventoryOf(rows, 6100);

    // Assert
    should(jobs.get(6102)).equal(6101);
  });

  it('should not count a shell that runs no command line, or a non-shell child', () => {
    // Arrange
    const rows = parseProcessTable(`
  8001  8000    01:00 /bin/bash
  8002  8000    01:00 some-vendor-tool --watch
  8003  8000    01:00 bash --norc -lc 'make watch'
`);

    // Act
    const { jobs } = inventoryOf(rows, 8000);

    // Assert
    should(jobs.has(8001)).be.false();
    should(jobs.has(8002)).be.false();
    should(jobs.get(8003)).equal(8003);
  });

  it('should list the owner’s case as jobs, and leave the safe ones and the tools server out of the ask', () => {
    // Arrange
    const { processes } = inventoryOf(descendantsOf(5000, parseProcessTable(OWNER_PANE)), 5000);
    const report = reportOf(processes);

    // Act
    const jobs = blockingAgentJobs(report);
    const refusal = describeInflight(report);

    // Assert
    should(jobs.map(job => job.pid)).deepEqual([5100, 5101]);
    should(jobs[1]).deepEqual({ pid: 5101, command: 'bash /tmp/merge-all.sh 765', age: '4m' });
    const blockers = refusal.items.filter(item => item.blocks);
    should(blockers).have.length(2);
    should(blockers.every(item => item.backgroundJob === true)).be.true();
    should(blockers.map(item => item.pid)).deepEqual([5100, 5101]);
    // `sleep 5` is listed but does not block, and is not something the agent is asked about.
    should(refusal.items.find(item => item.detail === 'sleep 5')).match({ blocks: false, backgroundJob: true });
  });

  it('should leave a process the agent did not start through its shell unmarked', () => {
    // Arrange — the stranger hangs off the pane process itself, not off a tool shell.
    const { processes } = inventoryOf(parseProcessTable('  9001  9000    01:00 some-vendor-tool --watch\n'), 9000);

    // Act
    const refusal = describeInflight(reportOf(processes));

    // Assert
    should(refusal.items[0]).match({ blocks: true });
    should(refusal.items[0]).not.have.property('backgroundJob');
    should(refusal.items[0]).not.have.property('pid');
    should(blockingAgentJobs(reportOf(processes))).be.empty();
  });
});

describe('the message the agent is sent', () => {
  const jobs = [
    { pid: 5101, command: 'bash /tmp/merge-all.sh 765', age: '4m' },
    { pid: 5100, command: '/usr/bin/zsh -c source …' },
  ];

  it('should name every pid and command, with no sender tag in the words', () => {
    // Act
    const text = agentJobsMessage(jobs);

    // Assert
    should(text).containEql('- pid 5101 (running 4m): bash /tmp/merge-all.sh 765');
    should(text).containEql('- pid 5100: /usr/bin/zsh -c source …');
    should(text).match(/say why instead/);
    // Who sent it is the queue entry's `by`, never a prefix.
    should(text).match(/^Ferretry could not move this session/);
  });

  it('should name the same jobs by the same id, whatever order they came in', () => {
    // Act
    const forward = agentJobsMessageId(jobs);
    const backward = agentJobsMessageId([...jobs].reverse());

    // Assert
    should(forward).equal('migrate-jobs-5100-5101');
    should(backward).equal(forward);
    should(agentJobsMessageId(jobs.slice(0, 1))).not.equal(forward);
  });

  it('should keep a long list inside the queue’s id limit', () => {
    // Arrange
    const many = Array.from({ length: 60 }, (_, index) => ({ pid: 100_000 + index, command: 'sleep 1' }));

    // Act
    const id = agentJobsMessageId(many);

    // Assert
    should(id.length).be.belowOrEqual(128);
    should(id).match(/^migrate-jobs-h[0-9a-f]{8}$/);
    should(agentJobsMessageId([...many].reverse())).equal(id);
  });
});
