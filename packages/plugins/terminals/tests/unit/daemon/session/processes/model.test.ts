import { describe, it } from 'bun:test';
import { SESSION_PROCESS_COMMAND_MAX } from '@ferretry/protocol';
import should from 'should';
import {
  cpuPercent,
  parseProcessId,
  processEntries,
  processIdOf,
  type ProcessView,
  stateOf,
  stopOrder,
} from '../../../../src/lib/session/processes/model.ts';
import type { ProcessDetailRow, ProcessStreamTarget } from '../../../../src/lib/session/processes/ports.ts';

/**
 * A PANE'S PROCESS TREE AS THE TAB LISTS IT, over hand-built process tables.
 *
 * Which process is what is the Warden's question (`classifyPaneProcesses`); what is asserted here is the
 * mapping onto the four words a person reads, the order they are listed in, and what Stop may signal.
 */

const NOW = 1_800_000_000_000;
const HARNESS = 100;

interface Spec {
  readonly pid: number;
  readonly ppid: number;
  readonly argv: string;
  readonly ageSeconds?: number;
  readonly state?: string;
  readonly cpuSeconds?: number;
  readonly stdout?: ProcessStreamTarget;
  readonly stderr?: ProcessStreamTarget;
}

const row = (spec: Spec): ProcessDetailRow => ({
  pid: spec.pid,
  ppid: spec.ppid,
  start: spec.pid * 1_000,
  startedAtMs: NOW - (spec.ageSeconds ?? 60) * 1000,
  argv: spec.argv,
  state: spec.state ?? 'S',
  ...(spec.cpuSeconds === undefined ? {} : { cpuSeconds: spec.cpuSeconds }),
  ...(spec.stdout === undefined ? {} : { stdout: spec.stdout }),
  ...(spec.stderr === undefined ? {} : { stderr: spec.stderr }),
});

const harness = row({ pid: HARNESS, ppid: 1, argv: 'claude --dangerously-skip-permissions', ageSeconds: 3_600 });
const mcp = row({ pid: 101, ppid: HARNESS, argv: '/usr/bin/fy mcp serve', ageSeconds: 3_599 });

function view(rows: readonly ProcessDetailRow[], overrides: Partial<ProcessView> = {}): ProcessView {
  return {
    rows,
    known: new Map([
      [HARNESS, { kind: 'harness' }],
      [101, { kind: 'ferretry-tools' }],
    ]),
    listening: new Set(),
    backgroundTaskIds: new Set(),
    nowMs: NOW,
    ...overrides,
  };
}

const claudeWrapper = (command: string): string =>
  `/usr/bin/zsh -c source /home/u/.claude/shell-snapshots/snapshot-zsh-1-a.sh 2>/dev/null || true && eval '${command}' < /dev/null && pwd -P >| /tmp/claude-d9b0-cwd`;
const taskFile = (id: string): ProcessStreamTarget => ({
  kind: 'file',
  path: `/tmp/claude-1000/proj/session/tasks/${id}.output`,
});

const byPid = (rows: ReturnType<typeof processEntries>, pid: number) => rows.find(entry => entry.row.pid === pid);

describe('processEntries', () => {
  it('should leave the harness itself out of the list', () => {
    // Arrange
    const rows = [harness];

    // Act
    const entries = processEntries(view(rows));

    // Assert
    should(entries).deepEqual([]);
  });

  it('should list a known `fy mcp serve` as a helper that Stop never offers', () => {
    // Arrange
    const rows = [harness, mcp];

    // Act
    const entries = processEntries(view(rows));

    // Assert
    should(entries).have.length(1);
    should(entries[0]).have.properties({ kind: 'helper', stoppable: false, toolCommand: false });
    should(entries[0]?.id).equal(processIdOf(101, 101_000));
  });

  it('should list a shell the harness started as a command, labelled with what the agent wrote', () => {
    // Arrange
    const shell = row({ pid: 200, ppid: HARNESS, argv: claudeWrapper('bun test'), stdout: taskFile('fg1') });

    // Act
    const entries = processEntries(view([harness, shell]));

    // Assert
    should(entries).have.length(1);
    should(entries[0]).have.properties({
      kind: 'command',
      label: 'bun test',
      toolCommand: true,
      stoppable: true,
      taskId: 'fg1',
      outputPath: '/tmp/claude-1000/proj/session/tasks/fg1.output',
    });
    should(entries[0]?.output).deepEqual({ source: 'file' });
    should(entries[0]?.parentId).be.undefined();
  });

  it('should call a command background when its output task id is in `backgroundTaskIds`, and its children inherit that', () => {
    // Arrange — the shell holds the task file; the `sleep` below it has the terminal-less defaults.
    const shell = row({ pid: 200, ppid: HARNESS, argv: claudeWrapper('sleep 600'), stdout: taskFile('bg1') });
    const child = row({ pid: 201, ppid: 200, argv: 'sleep 600', stdout: taskFile('bg1') });
    const grandchild = row({ pid: 202, ppid: 201, argv: 'sleep 1' });
    const foreground = row({ pid: 300, ppid: HARNESS, argv: claudeWrapper('ls'), stdout: taskFile('fg2') });

    // Act
    const entries = processEntries(
      view([harness, shell, foreground, child, grandchild], { backgroundTaskIds: new Set(['bg1']) }),
    );

    // Assert
    should(byPid(entries, 200)?.kind).equal('background');
    should(byPid(entries, 201)?.kind).equal('background');
    should(byPid(entries, 202)?.kind).equal('background');
    should(byPid(entries, 300)?.kind).equal('command');
  });

  it('should mark only the top of a command as a tool command, so a child is not kept after it ends', () => {
    // Arrange
    const shell = row({ pid: 200, ppid: HARNESS, argv: claudeWrapper('make') });
    const child = row({ pid: 201, ppid: 200, argv: 'cc -c a.c' });

    // Act
    const entries = processEntries(view([harness, shell, child]));

    // Assert
    should(byPid(entries, 200)?.toolCommand).be.true();
    should(byPid(entries, 201)?.toolCommand).be.false();
  });

  it('should call a listening child a server, whose kind a background parent does not change', () => {
    // Arrange
    const shell = row({ pid: 200, ppid: HARNESS, argv: claudeWrapper('bun run dev'), stdout: taskFile('bg1') });
    const server = row({ pid: 201, ppid: 200, argv: 'bun run server.ts' });

    // Act
    const entries = processEntries(
      view([harness, shell, server], { listening: new Set([201]), backgroundTaskIds: new Set(['bg1']) }),
    );

    // Assert
    should(byPid(entries, 201)).have.property('kind', 'server');
    should(byPid(entries, 201)?.stoppable).be.true();
    should(byPid(entries, 200)).have.property('kind', 'background');
  });

  it('should link each child to its parent with the parent’s id, and a top-level entry to none', () => {
    // Arrange
    const shell = row({ pid: 200, ppid: HARNESS, argv: 'bash -lc sleep 5' });
    const child = row({ pid: 201, ppid: 200, argv: 'sleep 5' });

    // Act
    const entries = processEntries(view([harness, shell, child]));

    // Assert
    should(byPid(entries, 200)?.parentId).be.undefined();
    should(byPid(entries, 201)?.parentId).equal(processIdOf(200, 200_000));
  });

  it('should list parents before children, depth first, each parent’s children oldest first', () => {
    // Arrange — table order is breadth-first and not by age; the list must not be.
    const rows = [
      harness,
      row({ pid: 210, ppid: HARNESS, argv: 'bash -lc younger', ageSeconds: 10 }),
      row({ pid: 200, ppid: HARNESS, argv: 'bash -lc older', ageSeconds: 50 }),
      row({ pid: 212, ppid: 210, argv: 'child of younger, newer', ageSeconds: 2 }),
      row({ pid: 211, ppid: 210, argv: 'child of younger, older', ageSeconds: 5 }),
      row({ pid: 201, ppid: 200, argv: 'child of older', ageSeconds: 40 }),
      row({ pid: 202, ppid: 201, argv: 'grandchild of older', ageSeconds: 30 }),
    ];

    // Act
    const order = processEntries(view(rows)).map(entry => entry.row.pid);

    // Assert
    should(order).deepEqual([200, 201, 202, 210, 211, 212]);
  });

  it('should order siblings that started in the same instant by pid', () => {
    // Arrange
    const rows = [
      harness,
      row({ pid: 220, ppid: HARNESS, argv: 'bash -lc b', ageSeconds: 5 }),
      row({ pid: 219, ppid: HARNESS, argv: 'bash -lc a', ageSeconds: 5 }),
    ];

    // Act
    const order = processEntries(view(rows)).map(entry => entry.row.pid);

    // Assert
    should(order).deepEqual([219, 220]);
  });

  it('should not offer Stop for a zombie, and report it as one', () => {
    // Arrange
    const zombie = row({ pid: 200, ppid: HARNESS, argv: 'bash -lc exit', state: 'Z' });

    // Act
    const entries = processEntries(view([harness, zombie]));

    // Assert
    should(entries[0]).have.properties({ state: 'zombie', stoppable: false });
  });

  it('should keep everything below a helper a helper, a browser a helper, and none of them stoppable', () => {
    // Arrange
    const underMcp = row({ pid: 102, ppid: 101, argv: 'node playwright-server.js' });
    const browser = row({ pid: 103, ppid: 102, argv: '/opt/google/chrome/chrome --headless' });

    // Act
    const entries = processEntries(view([harness, mcp, underMcp, browser]));

    // Assert
    should(entries.map(entry => [entry.row.pid, entry.kind, entry.stoppable])).deepEqual([
      [101, 'helper', false],
      [102, 'helper', false],
      [103, 'helper', false],
    ]);
  });

  it('should treat a non-shell the harness started as a helper', () => {
    // Arrange
    const lsp = row({ pid: 104, ppid: HARNESS, argv: 'typescript-language-server --stdio' });

    // Act
    const entries = processEntries(view([harness, lsp]));

    // Assert
    should(entries[0]).have.properties({ kind: 'helper', stoppable: false });
  });

  it('should describe where each command’s output goes', () => {
    // Arrange
    const terminal = row({
      pid: 200,
      ppid: HARNESS,
      argv: 'bash -lc vim',
      stdout: { kind: 'terminal', path: '/dev/pts/4' },
    });
    const piped = row({
      pid: 201,
      ppid: HARNESS,
      argv: 'bash -lc ls',
      stdout: { kind: 'pipe' },
      stderr: { kind: 'pipe' },
    });

    // Act
    const entries = processEntries(view([harness, terminal, piped]));

    // Assert
    should(byPid(entries, 200)?.output.reason).match(/Console/u);
    should(byPid(entries, 201)?.output.source).equal('none');
    should(byPid(entries, 201)?.outputPath).be.undefined();
  });

  it('should keep an over-long label whole, leaving the cut to the service after it has scrubbed', () => {
    // Arrange
    const shell = row({ pid: 200, ppid: HARNESS, argv: claudeWrapper('x'.repeat(SESSION_PROCESS_COMMAND_MAX + 500)) });

    // Act
    const entries = processEntries(view([harness, shell]));

    // Assert
    should(entries[0]?.label).have.length(SESSION_PROCESS_COMMAND_MAX + 500);
  });
});

describe('stateOf', () => {
  it('should read the kernel’s first letter as one of the wire states', () => {
    // Arrange / Act
    const states = ['R', 'S', 'D', 'T', 't', 'Z', 'X', 'I', 'Sl', 'R+', '?'].map(stateOf);

    // Assert
    should(states).deepEqual([
      'running',
      'sleeping',
      'sleeping',
      'stopped',
      'stopped',
      'zombie',
      'zombie',
      'sleeping',
      'sleeping',
      'running',
      'sleeping',
    ]);
  });
});

describe('stopOrder', () => {
  const rows = [
    row({ pid: 10, ppid: 1, argv: 'a' }),
    row({ pid: 11, ppid: 10, argv: 'b' }),
    row({ pid: 12, ppid: 10, argv: 'c' }),
    row({ pid: 13, ppid: 11, argv: 'd' }),
    row({ pid: 20, ppid: 1, argv: 'unrelated' }),
    row({ pid: 21, ppid: 20, argv: 'unrelated child' }),
  ];

  it('should put the deepest descendants first and the process itself last', () => {
    // Arrange / Act
    const order = stopOrder(10, rows).map(entry => entry.pid);

    // Assert
    should(order).deepEqual([13, 12, 11, 10]);
  });

  it('should never reach a process outside the subtree', () => {
    // Arrange / Act
    const order = stopOrder(11, rows).map(entry => entry.pid);

    // Assert
    should(order).deepEqual([13, 11]);
  });

  it('should be just the process for a leaf, and empty for a pid that is not listed', () => {
    // Arrange / Act / Assert
    should(stopOrder(13, rows).map(entry => entry.pid)).deepEqual([13]);
    should(stopOrder(999, rows)).deepEqual([]);
  });
});

describe('cpuPercent', () => {
  it('should be the rate since the previous look when there was one', () => {
    // Arrange — 5 more CPU seconds in the 10 seconds since the last look.
    const current = row({ pid: 1, ppid: 0, argv: 'x', ageSeconds: 100, cpuSeconds: 15 });

    // Act
    const percent = cpuPercent(current, { cpuSeconds: 10, atMs: NOW - 10_000 }, NOW);

    // Assert
    should(percent).equal(50);
  });

  it('should be the lifetime average when there was no previous look', () => {
    // Arrange — 10 CPU seconds in a 100 second life.
    const current = row({ pid: 1, ppid: 0, argv: 'x', ageSeconds: 100, cpuSeconds: 10 });

    // Act
    const percent = cpuPercent(current, undefined, NOW);

    // Assert
    should(percent).equal(10);
  });

  it('should fall back to the lifetime average when the counter went backwards, never going negative', () => {
    // Arrange — a previous sample ahead of the current one cannot belong to this process.
    const current = row({ pid: 1, ppid: 0, argv: 'x', ageSeconds: 100, cpuSeconds: 10 });

    // Act
    const percent = cpuPercent(current, { cpuSeconds: 20, atMs: NOW - 10_000 }, NOW);

    // Assert
    should(percent).equal(10);
  });

  it('should exceed 100 for a process using several cores', () => {
    // Arrange
    const current = row({ pid: 1, ppid: 0, argv: 'x', ageSeconds: 100, cpuSeconds: 40 });

    // Act
    const percent = cpuPercent(current, { cpuSeconds: 10, atMs: NOW - 10_000 }, NOW);

    // Assert
    should(percent).equal(300);
  });

  it('should round to one decimal place', () => {
    // Arrange — 1 CPU second in 3 seconds.
    const current = row({ pid: 1, ppid: 0, argv: 'x', ageSeconds: 3, cpuSeconds: 1 });

    // Act
    const percent = cpuPercent(current, undefined, NOW);

    // Assert
    should(percent).equal(33.3);
  });

  it('should say nothing when the host reports no CPU time or no time has passed', () => {
    // Arrange
    const unmeasured = row({ pid: 1, ppid: 0, argv: 'x' });
    const justStarted = row({ pid: 1, ppid: 0, argv: 'x', ageSeconds: 0, cpuSeconds: 1 });

    // Act / Assert
    should(cpuPercent(unmeasured, undefined, NOW)).be.undefined();
    should(cpuPercent(justStarted, undefined, NOW)).be.undefined();
    should(cpuPercent(justStarted, { cpuSeconds: 0, atMs: NOW }, NOW)).be.undefined();
  });
});

describe('process ids', () => {
  it('should round-trip a pid and its start through the wire id', () => {
    // Arrange / Act
    const id = processIdOf(4_242, 918_273);

    // Assert
    should(id).equal('4242.918273');
    should(parseProcessId(id)).deepEqual({ pid: 4_242, start: 918_273 });
  });

  it('should reject anything that is not `<pid>.<start>`', () => {
    // Arrange
    const junk = [
      '',
      '4242',
      '.5',
      '0.5',
      '01.5',
      '4242.',
      '4242.-1',
      '4242.1.2',
      '4242. 1',
      'a.b',
      '12345678901.1',
      `1.${'9'.repeat(21)}`,
      '1.99999999999999999999',
      '../etc.1',
    ];

    // Act
    const parsed = junk.map(parseProcessId);

    // Assert
    should(parsed).deepEqual(junk.map(() => undefined));
  });
});
