import { describe, it } from 'bun:test';
import {
  SESSION_PROCESS_COMMAND_MAX,
  SessionProcessListSchema,
  SessionProcessOutputSchema,
  SessionProcessStopResultSchema,
} from '@ferretry/protocol';
import should from 'should';
import { SessionProcessError } from '../../../../src/lib/session/processes/service.ts';
import type { ProcessDetailRow } from '../../../../src/lib/session/processes/ports.ts';
import {
  claudeWrapper,
  harnessMessage,
  HARNESS_PID,
  HARNESS_ROW,
  idOf,
  MCP_PID,
  MCP_ROW,
  NOW,
  PANE_PID,
  type ProcessWorld,
  processWorld,
  rowOf,
  SESSION,
  taskFile,
  taskNotification,
  taskPath,
  toolCall,
  toolResult,
} from './support.ts';

/**
 * A FERRET'S PROCESSES THROUGH THE SERVICE, over in-memory ports.
 *
 * What is asserted is what a person sees and what the daemon may do on their behalf: which rows are
 * listed, which bytes are served, which pids are signalled — and that no string leaves unscrubbed.
 */

const SECRET = new Map([['TOKEN', 'hunter2']]);
const MASKED = '‹secret:TOKEN›';

/** A shell the harness started, as Claude Code starts one, writing its output to a task file. */
const shell = (pid: number, command: string, extra: Partial<Parameters<typeof rowOf>[0]> = {}): ProcessDetailRow =>
  rowOf({ pid, ppid: HARNESS_PID, argv: claudeWrapper(command), stdout: taskFile(`t${pid}`), ...extra });

const child = (pid: number, ppid: number, argv = 'sleep 30'): ProcessDetailRow => rowOf({ pid, ppid, argv });

function show(world: ProcessWorld, ...rows: readonly ProcessDetailRow[]): void {
  world.tree.rows = [HARNESS_ROW, MCP_ROW, ...rows];
}

const failureOf = async (work: Promise<unknown>): Promise<string | undefined> =>
  work.then(
    () => undefined,
    (error: unknown) => (error instanceof SessionProcessError ? error.failure : `other: ${String(error)}`),
  );

describe('SessionProcessService.list', () => {
  it('should list a running tool command and the agent’s helper, and parse as the wire list', async () => {
    // Arrange
    const world = processWorld();
    show(world, shell(200, 'bun test', { rssBytes: 4096 }));

    // Act
    const list = await world.service.list(SESSION);

    // Assert
    should(SessionProcessListSchema.safeParse(list).success).be.true();
    should(list).have.properties({ sessionId: SESSION, available: true, observedAt: new Date(NOW).toISOString() });
    const command = list.processes.find(process => process.pid === 200);
    should(command).have.properties({
      id: idOf(shell(200, 'bun test')),
      kind: 'command',
      label: 'bun test',
      stoppable: true,
      rssBytes: 4096,
      output: { source: 'file' },
    });
    should(list.processes.find(process => process.pid === MCP_PID)).have.properties({
      kind: 'helper',
      stoppable: false,
    });
    should(list.processes.some(process => process.pid === HARNESS_PID)).be.false();
  });

  it('should walk only the pane the attach proof names', async () => {
    // Arrange
    const world = processWorld();

    // Act
    await world.service.list(SESSION);

    // Assert
    should(world.panes.asked).deepEqual([SESSION]);
    should(world.tree.walked).deepEqual([PANE_PID]);
    should(world.provenance.asked[0]?.rootPid).equal(PANE_PID);
  });

  it('should still list when the host cannot tell which processes are listening', async () => {
    // Arrange
    const world = processWorld();
    world.tree.listeningFails = true;
    show(world, shell(200, 'bun test'));

    // Act
    const list = await world.service.list(SESSION);

    // Assert
    should(list.available).be.true();
    should(list.processes.find(process => process.pid === 200)?.kind).equal('command');
  });

  it('should be unavailable with the consequence, not tmux’s own words, when the pane proof throws', async () => {
    // Arrange
    const world = processWorld();
    world.panes.refusal = new Error('tmux: no server running on /tmp/tmux.sock');

    // Act
    const list = await world.service.list(SESSION);

    // Assert
    should(SessionProcessListSchema.safeParse(list).success).be.true();
    should(list).have.properties({
      available: false,
      reason: "This ferret isn't running, so it has no processes right now.",
    });
    should(list.processes).deepEqual([]);
    should(world.tree.walked).deepEqual([]);
  });

  it('should be unavailable with the tree’s own reason when the process table cannot be read', async () => {
    // Arrange
    const world = processWorld();
    world.tree.unavailable = '/proc is not readable here';

    // Act
    const list = await world.service.list(SESSION);

    // Assert
    should(list).have.properties({ available: false, reason: '/proc is not readable here' });
  });

  it('should keep showing a command that has ended after the pane is gone', async () => {
    // Arrange
    const world = processWorld();
    show(world, shell(200, 'bun test'));
    await world.service.list(SESSION);
    world.clock.now = NOW + 5_000;
    world.panes.refusal = new Error('gone');

    // Act
    const list = await world.service.list(SESSION);

    // Assert
    should(list.available).be.false();
    should(list.processes).have.length(1);
    should(list.processes[0]).have.properties({
      pid: 200,
      state: 'exited',
      endedAt: new Date(NOW + 5_000).toISOString(),
      stoppable: false,
    });
    should(list.processes[0]).not.have.property('parentId');
  });

  it('should list a command that ended between looks once, as exited, after the live rows', async () => {
    // Arrange
    const world = processWorld();
    show(world, shell(200, 'bun test'), shell(201, 'bun lint'));
    await world.service.list(SESSION);
    show(world, shell(201, 'bun lint'));
    world.clock.now = NOW + 2_000;

    // Act
    const list = await world.service.list(SESSION);

    // Assert
    should(list.processes.map(process => [process.pid, process.state === 'exited'])).deepEqual([
      [MCP_PID, false],
      [201, false],
      [200, true],
    ]);
  });

  it('should compute CPU across the time since the previous look', async () => {
    // Arrange
    const world = processWorld();
    show(world, shell(200, 'bun test', { cpuSeconds: 10 }));
    await world.service.list(SESSION);
    show(world, shell(200, 'bun test', { cpuSeconds: 15 }));
    world.clock.now = NOW + 10_000;

    // Act
    const list = await world.service.list(SESSION);

    // Assert
    should(list.processes.find(process => process.pid === 200)?.cpuPercent).equal(50);
  });

  it('should fall back to CPU over the process’s whole life on the first look', async () => {
    // Arrange
    const world = processWorld();
    show(world, shell(200, 'bun test', { cpuSeconds: 30, ageSeconds: 60 }));

    // Act
    const list = await world.service.list(SESSION);

    // Assert
    should(list.processes.find(process => process.pid === 200)?.cpuPercent).equal(50);
  });

  it('should take an ended background command’s exit from its task notification', async () => {
    // Arrange
    const world = processWorld();
    const row = rowOf({ pid: 200, ppid: HARNESS_PID, argv: claudeWrapper('bun build'), stdout: taskFile('bg1') });
    world.transcript.events = [
      toolCall('c1', { command: 'bun build', run_in_background: true }),
      toolResult('c1', 'Command running in background with ID: bg1'),
      harnessMessage(taskNotification('bg1', 'failed', 'Background command "bun build" failed (exit code 2)')),
    ];
    show(world, row);
    await world.service.list(SESSION);
    show(world);
    world.clock.now = NOW + 1_000;

    // Act
    const list = await world.service.list(SESSION);

    // Assert
    const ended = list.processes.find(process => process.pid === 200);
    should(ended).have.properties({ state: 'exited', kind: 'background' });
    should(ended?.exit).deepEqual({ code: 2, failed: true });
  });

  it('should take an ended foreground command’s exit from the transcript’s recorded result', async () => {
    // Arrange
    const world = processWorld();
    world.transcript.events = [
      toolCall('c1', { command: 'bun test' }),
      toolResult('c1', 'Exit code 1\n3 tests failed', { isError: true, timestamp: new Date(NOW).toISOString() }),
    ];
    show(world, shell(200, 'bun test'));
    await world.service.list(SESSION);
    show(world);
    world.clock.now = NOW + 1_000;

    // Act
    const list = await world.service.list(SESSION);

    // Assert
    const ended = list.processes.find(process => process.pid === 200);
    should(ended?.exit).deepEqual({ code: 1, failed: true });
    should(ended?.output).deepEqual({ source: 'transcript' });
  });

  it('should say an ended command’s output is still in its file when the file can be read', async () => {
    // Arrange
    const world = processWorld();
    world.files.put(taskPath('t200'), 'done\n');
    show(world, shell(200, 'bun test'));
    await world.service.list(SESSION);
    show(world);

    // Act
    const list = await world.service.list(SESSION);

    // Assert
    should(list.processes.find(process => process.pid === 200)?.output).deepEqual({ source: 'file' });
  });

  it('should say an ended command’s output was not kept when its file is gone and nothing was recorded', async () => {
    // Arrange
    const world = processWorld();
    show(world, shell(200, 'bun test'));
    await world.service.list(SESSION);
    show(world);

    // Act
    const list = await world.service.list(SESSION);

    // Assert
    should(list.processes.find(process => process.pid === 200)?.output).deepEqual({
      source: 'none',
      reason: 'It ended before its output could be kept.',
    });
  });

  it('should survive a transcript that cannot be read, listing without exits', async () => {
    // Arrange
    const world = processWorld();
    world.transcript.failure = new Error('transcript store is down');
    show(world, shell(200, 'bun test'));
    await world.service.list(SESSION);
    show(world);

    // Act
    const list = await world.service.list(SESSION);

    // Assert
    const ended = list.processes.find(process => process.pid === 200);
    should(ended?.state).equal('exited');
    should(ended).not.have.property('exit');
  });

  it('should offer no output for a command writing under a refused root, and never open that file', async () => {
    // Arrange
    const world = processWorld();
    const secretPath = '/home/kirin/.ferretry/state/daemon/credentials.json';
    world.files.put(secretPath, '{"token":"x"}');
    show(
      world,
      rowOf({ pid: 200, ppid: HARNESS_PID, argv: claudeWrapper('tee'), stdout: { kind: 'file', path: secretPath } }),
    );

    // Act
    const list = await world.service.list(SESSION);
    const output = await world.service.output(
      SESSION,
      idOf(rowOf({ pid: 200, ppid: HARNESS_PID, argv: '' })),
      undefined,
    );

    // Assert
    should(list.processes.find(process => process.pid === 200)?.output.source).equal('none');
    should(output).have.properties({ source: 'none', text: '' });
    should(world.files.reads).deepEqual([]);
  });
});

describe('SessionProcessService.output', () => {
  const ID_200 = idOf(rowOf({ pid: 200, ppid: HARNESS_PID, argv: '' }));

  it('should serve the tail of a live file and parse as the wire output', async () => {
    // Arrange
    const world = processWorld();
    world.files.put(taskPath('t200'), 'one\ntwo\n');
    show(world, shell(200, 'bun test'));

    // Act
    const output = await world.service.output(SESSION, ID_200, undefined);

    // Assert
    should(SessionProcessOutputSchema.safeParse(output).success).be.true();
    should(output).have.properties({
      processId: ID_200,
      source: 'file',
      text: 'one\ntwo\n',
      start: 0,
      end: 8,
      size: 8,
      skipped: false,
      reset: false,
      complete: false,
    });
  });

  it('should follow from `after`, serving only what was appended', async () => {
    // Arrange
    const world = processWorld();
    world.files.put(taskPath('t200'), 'one\ntwo\n');
    show(world, shell(200, 'bun test'));
    world.files.append(taskPath('t200'), 'three\n');

    // Act
    const output = await world.service.output(SESSION, ID_200, 8);

    // Assert
    should(output).have.properties({ text: 'three\n', start: 8, end: 14, size: 14, reset: false });
  });

  it('should answer a follower already at the end with nothing and the same offset', async () => {
    // Arrange
    const world = processWorld();
    world.files.put(taskPath('t200'), 'one\n');
    show(world, shell(200, 'bun test'));

    // Act
    const output = await world.service.output(SESSION, ID_200, 4);

    // Assert
    should(output).have.properties({ text: '', start: 4, end: 4, size: 4, reset: false });
  });

  it('should hold back a half-written line of a running process until its newline arrives', async () => {
    // Arrange
    const world = processWorld();
    world.files.put(taskPath('t200'), 'done\nhalf wri');
    show(world, shell(200, 'bun test'));

    // Act
    const held = await world.service.output(SESSION, ID_200, undefined);
    world.files.append(taskPath('t200'), 'tten\n');
    const whole = await world.service.output(SESSION, ID_200, held.end);

    // Assert
    should(held).have.properties({ text: 'done\n', end: 5 });
    should(whole).have.properties({ text: 'half written\n', start: 5, end: 18 });
  });

  it('should tell a follower the file was replaced by something shorter', async () => {
    // Arrange
    const world = processWorld();
    world.files.put(taskPath('t200'), 'short\n');
    show(world, shell(200, 'bun test'));

    // Act
    const output = await world.service.output(SESSION, ID_200, 500);

    // Assert
    should(output).have.properties({ reset: true, text: 'short\n', start: 0 });
  });

  it('should say why there is no output when the process writes to a pipe, and never open anything', async () => {
    // Arrange
    const world = processWorld();
    show(world, rowOf({ pid: 200, ppid: HARNESS_PID, argv: claudeWrapper('make'), stdout: { kind: 'pipe' } }));

    // Act
    const output = await world.service.output(SESSION, ID_200, undefined);

    // Assert
    should(output.source).equal('none');
    should(output.reason).be.a.String().and.not.empty();
    should(output.complete).be.false();
    should(world.files.reads).deepEqual([]);
  });

  it('should pass on the file port’s refusal as the reason', async () => {
    // Arrange
    const world = processWorld();
    world.files.refused.set(taskPath('t200'), 'not a regular file');
    show(world, shell(200, 'bun test'));

    // Act
    const output = await world.service.output(SESSION, ID_200, undefined);

    // Assert
    should(output).have.properties({ source: 'none', reason: 'not a regular file', text: '' });
  });

  it('should say a live process’s output file is gone', async () => {
    // Arrange
    const world = processWorld();
    show(world, shell(200, 'bun test'));

    // Act
    const output = await world.service.output(SESSION, ID_200, undefined);

    // Assert
    should(output).have.properties({ source: 'none', reason: 'Its output file is gone.' });
  });

  it('should serve an ended command’s file whole, partial last line included, as complete', async () => {
    // Arrange
    const world = processWorld();
    world.files.put(taskPath('t200'), 'last line without newline');
    show(world, shell(200, 'bun test'));
    await world.service.list(SESSION);
    show(world);

    // Act
    const output = await world.service.output(SESSION, ID_200, undefined);

    // Assert
    should(output).have.properties({ source: 'file', text: 'last line without newline', complete: true });
  });

  it('should fall back to the transcript’s recorded result when an ended command’s file is gone', async () => {
    // Arrange
    const world = processWorld();
    world.transcript.events = [
      toolCall('c1', { command: 'bun test' }),
      toolResult('c1', 'Exit code 0\n12 pass', { timestamp: new Date(NOW).toISOString() }),
    ];
    show(world, shell(200, 'bun test'));
    await world.service.list(SESSION);
    show(world);

    // Act
    const output = await world.service.output(SESSION, ID_200, undefined);

    // Assert
    should(SessionProcessOutputSchema.safeParse(output).success).be.true();
    should(output).have.properties({
      source: 'transcript',
      text: 'Exit code 0\n12 pass',
      start: 0,
      complete: true,
      reset: false,
    });
    should(output.end).equal(output.size);
  });

  it('should find a command that ended since the list was drawn and serve its result', async () => {
    // Arrange
    const world = processWorld();
    world.transcript.events = [
      toolCall('c1', { command: 'bun test' }),
      toolResult('c1', 'ok', { timestamp: new Date(NOW).toISOString() }),
    ];
    show(world, shell(200, 'bun test'));
    await world.service.list(SESSION);
    show(world);

    // Act
    const output = await world.service.output(SESSION, ID_200, undefined);

    // Assert
    should(output).have.properties({ source: 'transcript', text: 'ok' });
  });

  it('should follow a recorded result from the offset already read rather than serving it again', async () => {
    // Arrange
    const world = processWorld();
    world.transcript.events = [
      toolCall('c1', { command: 'bun test' }),
      toolResult('c1', 'all 3 passed', { timestamp: new Date(NOW).toISOString() }),
    ];
    show(world, shell(200, 'bun test'));
    await world.service.list(SESSION);
    show(world);
    const first = await world.service.output(SESSION, ID_200, undefined);

    // Act
    const again = await world.service.output(SESSION, ID_200, first.end);
    const partway = await world.service.output(SESSION, ID_200, 4);

    // Assert
    should(again).have.properties({ source: 'transcript', text: '', start: first.end, end: first.end, reset: false });
    should(partway).have.properties({ text: '3 passed', start: 4, complete: true });
  });

  it('should say the file is gone, as complete, when an ended command’s file is gone and nothing was recorded', async () => {
    // Arrange
    const world = processWorld();
    show(world, shell(200, 'bun test'));
    await world.service.list(SESSION);
    show(world);

    // Act
    const output = await world.service.output(SESSION, ID_200, undefined);

    // Assert
    should(output).have.properties({
      source: 'none',
      reason: 'It ended before its output could be kept.',
      complete: true,
    });
  });

  it('should say it ended before its output could be kept when it never had a file and nothing was recorded', async () => {
    // Arrange
    const world = processWorld();
    show(world, rowOf({ pid: 200, ppid: HARNESS_PID, argv: claudeWrapper('make'), stdout: { kind: 'pipe' } }));
    await world.service.list(SESSION);
    show(world);

    // Act
    const output = await world.service.output(SESSION, ID_200, undefined);

    // Assert
    should(output).have.properties({
      source: 'none',
      reason: 'It ended before its output could be kept.',
      complete: true,
    });
  });

  it('should serve an ended command’s output while the pane itself is gone', async () => {
    // Arrange
    const world = processWorld();
    world.files.put(taskPath('t200'), 'kept\n');
    show(world, shell(200, 'bun test'));
    await world.service.list(SESSION);
    world.panes.refusal = new Error('gone');

    // Act
    const output = await world.service.output(SESSION, ID_200, undefined);

    // Assert
    should(output).have.properties({ source: 'file', text: 'kept\n', complete: true });
  });

  it('should refuse an id that is not one of this ferret’s processes', async () => {
    // Arrange
    const world = processWorld();
    show(world, shell(200, 'bun test'));

    // Act
    const failure = await failureOf(world.service.output(SESSION, '999.999000', undefined));

    // Assert
    should(failure).equal('not_found');
  });

  it('should refuse an id whose pid is live but with another start, never reading that pid’s file', async () => {
    // Arrange
    const world = processWorld();
    world.files.put(taskPath('t200'), 'someone else’s\n');
    show(world, shell(200, 'bun test'));

    // Act
    const failure = await failureOf(world.service.output(SESSION, '200.1', undefined));

    // Assert
    should(failure).equal('not_found');
    should(world.files.reads).deepEqual([]);
  });

  it('should refuse text that is not a process id', async () => {
    // Arrange
    const world = processWorld();

    // Act
    const failure = await failureOf(world.service.output(SESSION, '../etc/passwd', undefined));

    // Assert
    should(failure).equal('not_found');
    should(world.panes.asked).deepEqual([]);
  });
});

describe('SessionProcessService.stop', () => {
  const ID_200 = idOf(rowOf({ pid: 200, ppid: HARNESS_PID, argv: '' }));

  it('should signal the whole subtree deepest first and count what it signalled', async () => {
    // Arrange
    const world = processWorld();
    show(world, shell(200, 'bun test'), child(201, 200), child(202, 201), child(203, 200), child(300, HARNESS_PID));

    // Act
    const result = await world.service.stop(SESSION, ID_200);

    // Assert
    should(SessionProcessStopResultSchema.safeParse(result).success).be.true();
    should(result).deepEqual({ processId: ID_200, signalled: 4 });
    should(world.signals.sent.at(-1)).equal(200);
    should(world.signals.sent.indexOf(202)).be.below(world.signals.sent.indexOf(201));
    should(world.signals.sent.indexOf(201)).be.below(world.signals.sent.indexOf(200));
    should([...world.signals.sent].sort()).deepEqual([200, 201, 202, 203]);
  });

  it('should never signal a sibling, the harness or the pane', async () => {
    // Arrange
    const world = processWorld();
    show(world, shell(200, 'bun test'), shell(300, 'bun lint'));

    // Act
    await world.service.stop(SESSION, ID_200);

    // Assert
    should(world.signals.sent).deepEqual([200]);
  });

  it('should not count a process that had already exited when signalled', async () => {
    // Arrange
    const world = processWorld();
    show(world, shell(200, 'bun test'), child(201, 200));
    world.signals.gone.add(201);

    // Act
    const result = await world.service.stop(SESSION, ID_200);

    // Assert
    should(world.signals.sent).deepEqual([201, 200]);
    should(result.signalled).equal(1);
  });

  it('should refuse an id whose pid is in the tree with a different start, signalling nothing', async () => {
    // Arrange
    const world = processWorld();
    show(world, shell(200, 'bun test'));

    // Act
    const failure = await failureOf(world.service.stop(SESSION, '200.1'));

    // Assert
    should(failure).equal('changed');
    should(world.signals.sent).deepEqual([]);
  });

  it('should refuse an id that is no longer in the tree, signalling nothing', async () => {
    // Arrange
    const world = processWorld();
    show(world);

    // Act
    const failure = await failureOf(world.service.stop(SESSION, ID_200));

    // Assert
    should(failure).equal('changed');
    should(world.signals.sent).deepEqual([]);
  });

  it('should refuse when the ferret has no pane any more', async () => {
    // Arrange
    const world = processWorld();
    show(world, shell(200, 'bun test'));
    world.panes.refusal = new Error('gone');

    // Act
    const failure = await failureOf(world.service.stop(SESSION, ID_200));

    // Assert
    should(failure).equal('changed');
    should(world.signals.sent).deepEqual([]);
  });

  it('should skip a descendant whose start changed between the look and the signal', async () => {
    // Arrange
    const world = processWorld();
    show(world, shell(200, 'bun test'), child(201, 200), child(202, 201));
    world.tree.startOverrides.set(201, 999_999);

    // Act
    const result = await world.service.stop(SESSION, ID_200);

    // Assert
    should(world.signals.sent).deepEqual([202, 200]);
    should(result.signalled).equal(2);
  });

  it('should skip a descendant that has already exited by the time of the signal', async () => {
    // Arrange
    const world = processWorld();
    show(world, shell(200, 'bun test'), child(201, 200));
    world.tree.startOverrides.set(201, undefined);

    // Act
    const result = await world.service.stop(SESSION, ID_200);

    // Assert
    should(world.signals.sent).deepEqual([200]);
    should(result.signalled).equal(1);
  });

  it('should skip the target itself when its pid was reused after the look', async () => {
    // Arrange
    const world = processWorld();
    show(world, shell(200, 'bun test'), child(201, 200));
    world.tree.startOverrides.set(200, 424_242);

    // Act
    const result = await world.service.stop(SESSION, ID_200);

    // Assert
    should(world.signals.sent).deepEqual([201]);
    should(result.signalled).equal(1);
  });

  it('should refuse to stop the agent’s own helper', async () => {
    // Arrange
    const world = processWorld();
    show(world, shell(200, 'bun test'));

    // Act
    const failure = await failureOf(world.service.stop(SESSION, idOf(MCP_ROW)));

    // Assert
    should(failure).equal('not_stoppable');
    should(world.signals.sent).deepEqual([]);
  });

  it('should refuse to stop a zombie', async () => {
    // Arrange
    const world = processWorld();
    show(world, shell(200, 'bun test', { state: 'Z' }));

    // Act
    const failure = await failureOf(world.service.stop(SESSION, ID_200));

    // Assert
    should(failure).equal('not_stoppable');
    should(world.signals.sent).deepEqual([]);
  });

  it('should refuse text that is not a process id before touching the pane', async () => {
    // Arrange
    const world = processWorld();

    // Act
    const failure = await failureOf(world.service.stop(SESSION, 'not-an-id'));

    // Assert
    should(failure).equal('not_found');
    should(world.panes.asked).deepEqual([]);
  });
});

describe('SessionProcessService redaction', () => {
  const ID_200 = idOf(rowOf({ pid: 200, ppid: HARNESS_PID, argv: '' }));

  it('should scrub a stored secret from the command, the label and the output text', async () => {
    // Arrange
    const world = processWorld({ secrets: SECRET });
    world.files.put(taskPath('t200'), 'connected with hunter2\n');
    show(world, shell(200, 'curl -H "Authorization: hunter2" https://example.test'));

    // Act
    const list = await world.service.list(SESSION);
    const output = await world.service.output(SESSION, ID_200, undefined);

    // Assert
    const process = list.processes.find(candidate => candidate.pid === 200);
    should(process?.command).containEql(MASKED).and.not.containEql('hunter2');
    should(process?.label).containEql(MASKED).and.not.containEql('hunter2');
    should(output.text).equal(`connected with ${MASKED}\n`);
    should(JSON.stringify(list)).not.containEql('hunter2');
  });

  it('should scrub the transcript-sourced output of an ended command', async () => {
    // Arrange
    const world = processWorld({ secrets: SECRET });
    world.transcript.events = [
      toolCall('c1', { command: 'env' }),
      toolResult('c1', 'TOKEN=hunter2', { timestamp: new Date(NOW).toISOString() }),
    ];
    show(world, shell(200, 'env'));
    await world.service.list(SESSION);
    show(world);

    // Act
    const output = await world.service.output(SESSION, ID_200, undefined);

    // Assert
    should(output).have.properties({ source: 'transcript', text: `TOKEN=${MASKED}` });
  });

  it('should scrub the rows of an ended command listed after the pane is gone', async () => {
    // Arrange
    const world = processWorld({ secrets: SECRET });
    show(world, shell(200, 'echo hunter2'));
    await world.service.list(SESSION);
    world.panes.refusal = new Error('gone');

    // Act
    const list = await world.service.list(SESSION);

    // Assert
    should(JSON.stringify(list)).not.containEql('hunter2');
  });

  it('should scrub a secret that begins just before the command length limit, not leave its prefix', async () => {
    // Arrange
    const world = processWorld({ secrets: SECRET });
    const argv = `${'x'.repeat(SESSION_PROCESS_COMMAND_MAX - 6)} hunter2 tail`;
    show(world, rowOf({ pid: 200, ppid: HARNESS_PID, argv, stdout: taskFile('t200') }));

    // Act
    const list = await world.service.list(SESSION);

    // Assert
    const process = list.processes.find(candidate => candidate.pid === 200);
    should(process?.command).not.containEql('hun');
    should(process?.command.length).be.belowOrEqual(SESSION_PROCESS_COMMAND_MAX);
    should(process?.commandTruncated).be.true();
  });

  it('should scrub a secret that begins just before the label length limit, not leave its prefix', async () => {
    // Arrange
    const world = processWorld({ secrets: SECRET });
    show(world, shell(200, `${'y'.repeat(SESSION_PROCESS_COMMAND_MAX - 4)}hunter2 tail`));

    // Act
    const list = await world.service.list(SESSION);

    // Assert
    const process = list.processes.find(candidate => candidate.pid === 200);
    should(process?.label).be.a.String();
    should(process?.label).not.containEql('hun');
    should(process?.label?.length).be.belowOrEqual(SESSION_PROCESS_COMMAND_MAX);
  });

  it('should fail the list closed when the redactor cannot open the vault', async () => {
    // Arrange
    const world = processWorld();
    world.redactor.failure = new Error('vault is locked');
    show(world, shell(200, 'bun test'));

    // Act
    const failing = world.service.list(SESSION);

    // Assert
    await should(failing).be.rejectedWith(/vault is locked/u);
  });

  it('should fail an unavailable list closed too', async () => {
    // Arrange
    const world = processWorld();
    world.redactor.failure = new Error('vault is locked');
    world.panes.refusal = new Error('gone');

    // Act
    const failing = world.service.list(SESSION);

    // Assert
    await should(failing).be.rejectedWith(/vault is locked/u);
  });

  it('should fail output closed, serving no unscrubbed bytes', async () => {
    // Arrange
    const world = processWorld();
    world.files.put(taskPath('t200'), 'hunter2\n');
    world.redactor.failure = new Error('vault is locked');
    show(world, shell(200, 'bun test'));

    // Act
    const failing = world.service.output(SESSION, ID_200, undefined);

    // Assert
    await should(failing).be.rejectedWith(/vault is locked/u);
  });

  it('should not need the vault to stop a process', async () => {
    // Arrange
    const world = processWorld();
    world.redactor.failure = new Error('vault is locked');
    show(world, shell(200, 'bun test'));

    // Act
    const result = await world.service.stop(SESSION, ID_200);

    // Assert
    should(result.signalled).equal(1);
  });
});
