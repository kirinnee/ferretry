import { describe, it } from 'bun:test';
import should from 'should';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BunTmuxProcess, TmuxTerminalRuntime } from '../../../src/adapters/index.ts';
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

  it('should never report activity before creation when tmux rounds a fresh terminal to a whole second', async () => {
    // TWO CLOCKS AT TWO PRECISIONS. The creation stamp is our own ISO string with
    // MILLISECONDS; `#{session_activity}` is a UNIX time in WHOLE SECONDS. A
    // terminal opened at …:19.997 and not typed into since therefore reported
    // activity at …:19.000 — 997ms before it existed — and `TerminalViewSchema`
    // refuses exactly that pair, so ONE freshly opened shell made
    // `GET /v1/sessions/:id/terminals` unparseable for every reader of the
    // listing. Genuine later activity must still be reported as itself, so the
    // clamp is a floor at creation rather than a second truncation.
    // Arrange
    const createdAt = '2026-08-06T17:04:19.997Z';
    const createdAtMs = Date.parse(createdAt);
    const untouchedSeconds = Math.floor(createdAtMs / 1_000);
    const typedIntoSeconds = untouchedSeconds + 60;
    const row = (id: string, activitySeconds: number): string =>
      [
        `fy-webterm-${terminal.ownerId}-${id}`,
        terminal.ownerId,
        id,
        terminal.title,
        createdAt,
        terminal.root,
        '',
        String(activitySeconds),
        '100',
        '30',
      ].join('\t');
    const fake = new FakeTmux([
      ok(`${row('0123456789ab', untouchedSeconds)}\n${row('0123456789cd', typedIntoSeconds)}\n`),
    ]);
    const subject = new TmuxTerminalRuntime(fake, () => createdAtMs + 5_000);

    // Act
    const listed = await subject.list();

    // Assert
    // The drift the daemon really served, stated rather than assumed.
    should(untouchedSeconds * 1_000).be.below(createdAtMs);
    should(listed.map(record => [record.createdAtMs, record.lastActivityAtMs])).deepEqual([
      [createdAtMs, createdAtMs],
      [createdAtMs, typedIntoSeconds * 1_000],
    ]);
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
    const fake = new FakeTmux([ok(), ok(), ok(), ok(), ok('hello\n'), ok('2|3\n'), ok()]);
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

describe('TmuxTerminalRuntime with no private server', () => {
  // Measured on tmux 3.6a with `tmux -S <path> list-sessions`. The first is what a fresh daemon's
  // never-created socket says, and the listing used to throw on it — which made every managed
  // worktree unremovable, because the removal reads a throw as undetermined evidence of terminals.
  const ABSENT = [
    'error connecting to /tmp/fy-home/tmux.sock (No such file or directory)',
    'no server running on /tmp/fy-home/tmux.sock',
  ];

  it.each(ABSENT)('should list no terminals when tmux says %s', async stderr => {
    // Arrange
    const subject = new TmuxTerminalRuntime(new FakeTmux([{ code: 1, stdout: '', stderr }]));

    // Act + Assert
    should(await subject.list()).deepEqual([]);
  });

  it.each(ABSENT)('should treat closing a terminal as done when tmux says %s', async stderr => {
    // Act + Assert — the server's absence took the terminal with it.
    await new TmuxTerminalRuntime(new FakeTmux([{ code: 1, stdout: '', stderr }])).kill(terminal);
  });

  it('should keep a socket it may not open as an error, never as an empty listing', async () => {
    // Arrange — measured too: a live server whose socket this user cannot open. Reading this as "no
    // terminals" would let a removal proceed past terminals it could not see.
    const stderr = 'error connecting to /tmp/fy-home/tmux.sock (Permission denied)';

    // Act + Assert
    await should(new TmuxTerminalRuntime(new FakeTmux([{ code: 1, stdout: '', stderr }])).list()).be.rejectedWith(
      /could not list terminal sessions: error connecting to .*Permission denied/u,
    );
    await should(
      new TmuxTerminalRuntime(new FakeTmux([{ code: 1, stdout: '', stderr }])).kill(terminal),
    ).be.rejectedWith(/could not close terminal/u);
  });

  it('should list no terminals through the real tmux on a socket nothing has created', async () => {
    // Arrange — no fake: whatever this host's tmux prints for a missing server is what is read.
    const executable = Bun.which('tmux');
    if (executable === null) throw new Error('tmux is required for terminal integration coverage');
    const home = await mkdtemp(join(tmpdir(), 'fy-term-absent-'));
    try {
      const subject = new TmuxTerminalRuntime(new BunTmuxProcess(executable, join(home, 'never-started.sock')));

      // Act + Assert
      should(await subject.list()).deepEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
