import { describe, it } from 'bun:test';
import should from 'should';
import { TmuxTerminalRuntime } from '../../../src/adapters/index.ts';
import type { TmuxCommandPort, TmuxCommandResult } from '../../../src/lib/index.ts';

const ok = (stdout = ''): TmuxCommandResult => ({ code: 0, stdout, stderr: '' });

class FakeTmux implements TmuxCommandPort {
  readonly received: string[][] = [];

  constructor(private readonly results: TmuxCommandResult[]) {}

  async execute(arguments_: readonly string[]): Promise<TmuxCommandResult> {
    this.received.push([...arguments_]);
    return this.results.shift() ?? ok();
  }
}

const terminal = {
  id: '0123456789ab',
  ownerId: 'session-a',
  title: 'Terminal 1',
  root: '/tmp/worktree',
  tmuxSession: 'fy-webterm-session-a-deadbeef-0123456789ab',
  createdAtMs: 1_000,
  lastActivityAtMs: 1_000,
  cols: 100,
  rows: 30,
};

describe('TmuxTerminalRuntime', () => {
  it('should discover only well-formed Ferretry terminal sessions and tolerate an absent private server', async () => {
    // Arrange
    const line = [
      terminal.tmuxSession,
      terminal.ownerId,
      terminal.id,
      terminal.title,
      '1970-01-01T00:00:01.000Z',
      terminal.root,
      // A pane that predates the opener option answers with the empty string.
      '',
      '2',
      '100',
      '30',
    ].join('\t');
    const fake = new FakeTmux([
      ok(`${line}\nother\t\t\t\t\t\t\t\t\t\n`),
      { code: 1, stdout: '', stderr: 'no server running' },
    ]);
    const subject = new TmuxTerminalRuntime(fake, () => 9_000);

    // Act
    const found = await subject.list();
    const absent = await subject.list();

    // Assert
    should(found).deepEqual([{ ...terminal, lastActivityAtMs: 2_000 }]);
    should(absent).deepEqual([]);
  });

  it('should carry ownership on the pane itself, and read an unknown one as unrecorded', async () => {
    // Ownership has to survive a daemon restart to be worth reading, so it lives
    // in a tmux user option beside the terminal's own id rather than in daemon
    // memory. A value this build cannot read contributes NO opener rather than a
    // guessed one — a reader consults this before typing into a live shell.
    // Arrange
    const row = (openedBy: string): string =>
      [
        terminal.tmuxSession,
        terminal.ownerId,
        terminal.id,
        terminal.title,
        '1970-01-01T00:00:01.000Z',
        terminal.root,
        openedBy,
        '2',
        '100',
        '30',
      ].join('\t');
    const fake = new FakeTmux([ok(`${row('agent:mse7wwti')}\n`), ok(`${row('starfleet:picard')}\n`), ok()]);
    const subject = new TmuxTerminalRuntime(fake, () => 9_000);

    // Act
    const owned = await subject.list();
    const unknown = await subject.list();
    const created = await subject.create({
      ownerId: terminal.ownerId,
      id: terminal.id,
      title: terminal.title,
      cwd: terminal.root,
      size: { cols: 100, rows: 30 },
      openedBy: { by: 'agent', sessionId: 'mse7wwti' },
    });

    // Assert
    should(owned[0]?.openedBy).deepEqual({ by: 'agent', sessionId: 'mse7wwti' });
    should(unknown[0]).not.have.property('openedBy');
    should(created.openedBy).deepEqual({ by: 'agent', sessionId: 'mse7wwti' });
    // Written in the SAME tmux invocation as the pane, so no list can observe a
    // terminal that exists but claims no owner.
    should(fake.received[2]?.filter(argument => argument === '@fy_terminal_opened_by')).have.length(1);
    should(fake.received[2]).containEql('agent:mse7wwti');
  });

  it('should open a terminal with no opener when the caller could not be attested', async () => {
    // Arrange
    const fake = new FakeTmux([ok()]);
    const subject = new TmuxTerminalRuntime(fake, () => 1_000);

    // Act
    const created = await subject.create({
      ownerId: terminal.ownerId,
      id: terminal.id,
      title: terminal.title,
      cwd: terminal.root,
      size: { cols: 100, rows: 30 },
    });

    // Assert
    should(created).not.have.property('openedBy');
    should(fake.received[0]).not.containEql('@fy_terminal_opened_by');
  });

  it('should refuse an unexpected list failure instead of treating it as no terminal', async () => {
    // Arrange
    const subject = new TmuxTerminalRuntime(new FakeTmux([{ code: 1, stdout: '', stderr: 'permission denied' }]));

    // Act + Assert
    await should(subject.list()).be.rejectedWith(/could not list terminal sessions/u);
  });

  it('should create, update, write, redraw, and close a terminal through the injected tmux port', async () => {
    // Arrange
    const fake = new FakeTmux([ok(), ok(), ok(), ok(), ok('hello\n'), ok('2\t3\n'), ok()]);
    const subject = new TmuxTerminalRuntime(fake, () => 1_000);

    // Act
    const created = await subject.create({
      ownerId: terminal.ownerId,
      id: terminal.id,
      title: terminal.title,
      cwd: terminal.root,
      size: { cols: 100, rows: 30 },
    });
    await subject.rename(created, 'renamed');
    await subject.resize(created, { cols: 120, rows: 40 });
    await subject.write(created, new Uint8Array([3, 13]));
    const frame = await subject.capture(created);
    await subject.kill(created);

    // Assert
    should(created).match({ id: terminal.id, ownerId: terminal.ownerId, root: terminal.root, createdAtMs: 1_000 });
    should(new TextDecoder().decode(frame)).equal('\u001b[3J\u001b[2J\u001b[Hhello\u001b[4;3H');
    should(fake.received.map(command => command[0])).deepEqual([
      'new-session',
      'set-option',
      'resize-window',
      'send-keys',
      'capture-pane',
      'display-message',
      'kill-session',
    ]);
    should(fake.received[3]).deepEqual(['send-keys', '-H', '-t', `${created.tmuxSession}:0.0`, '03', '0d']);
  });

  it('should clean up a partial create and surface mutation or capture failures', async () => {
    // Arrange
    const createFake = new FakeTmux([{ code: 1, stdout: '', stderr: 'create denied' }, ok()]);
    const create = new TmuxTerminalRuntime(createFake);
    const failed = new TmuxTerminalRuntime(
      new FakeTmux([
        { code: 1, stdout: '', stderr: 'gone' },
        { code: 1, stdout: '', stderr: 'gone' },
        { code: 1, stdout: '', stderr: 'gone' },
        ok(),
        { code: 1, stdout: '', stderr: 'gone' },
      ]),
    );

    // Act + Assert
    await should(
      create.create({
        ownerId: terminal.ownerId,
        id: terminal.id,
        title: terminal.title,
        cwd: terminal.root,
        size: terminal,
      }),
    ).be.rejectedWith(/could not create terminal/u);
    should(createFake.received[1]).match(['kill-session', '-t']);
    await should(failed.rename(terminal, 'next')).be.rejectedWith(/terminal no longer exists/u);
    await should(failed.resize(terminal, terminal)).be.rejectedWith(/terminal no longer exists/u);
    await should(failed.write(terminal, Uint8Array.of(1))).be.rejectedWith(/terminal no longer exists/u);
    await should(failed.capture(terminal)).be.rejectedWith(/terminal no longer exists/u);
    await should(failed.kill(terminal)).be.fulfilled();
  });

  it('should surface a real kill failure but accept a terminal already gone', async () => {
    // Arrange
    const subject = new TmuxTerminalRuntime(
      new FakeTmux([
        { code: 1, stdout: '', stderr: "can't find session" },
        { code: 1, stdout: '', stderr: 'permission denied' },
      ]),
    );

    // Act + Assert
    await should(subject.kill(terminal)).be.fulfilled();
    await should(subject.kill(terminal)).be.rejectedWith(/could not close terminal/u);
  });
});
