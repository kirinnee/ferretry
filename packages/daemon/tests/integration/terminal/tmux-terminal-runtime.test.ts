import { describe, it } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { BunTmuxProcess, TmuxTerminalRuntime } from '../../../src/adapters/index.ts';
import type { LoginShellPort, TmuxCommandPort, TmuxCommandResult } from '../../../src/lib/index.ts';
import { waitForValue } from '../support/wait-for.ts';

/** A fixed shell: these cases are about tmux commands, not about which shell is chosen. */
const plainShell: LoginShellPort = { shell: async () => '/bin/sh' };

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
      // No name either: a terminal opened without one, or before names existed.
      '',
      '2',
      '100',
      '30',
    ].join('\t');
    const fake = new FakeTmux([
      ok(`${line}\nother\t\t\t\t\t\t\t\t\t\n`),
      { code: 1, stdout: '', stderr: 'no server running' },
    ]);
    const subject = new TmuxTerminalRuntime(fake, () => 9_000, plainShell);

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
        '',
        String(activitySeconds),
        '100',
        '30',
      ].join('\t');
    const fake = new FakeTmux([
      ok(`${row('0123456789ab', untouchedSeconds)}\n${row('0123456789cd', typedIntoSeconds)}\n`),
    ]);
    const subject = new TmuxTerminalRuntime(fake, () => createdAtMs + 5_000, plainShell);

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
        'dev',
        '2',
        '100',
        '30',
      ].join('\t');
    const fake = new FakeTmux([ok(`${row('agent:mse7wwti')}\n`), ok(`${row('starfleet:picard')}\n`), ok()]);
    const subject = new TmuxTerminalRuntime(fake, () => 9_000, plainShell);

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
    should(owned[0]?.name).equal('dev');
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
    const subject = new TmuxTerminalRuntime(fake, () => 1_000, plainShell);

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
    const subject = new TmuxTerminalRuntime(
      new FakeTmux([{ code: 1, stdout: '', stderr: 'permission denied' }]),
      Date.now,
      plainShell,
    );

    // Act + Assert
    await should(subject.list()).be.rejectedWith(/could not list terminal sessions/u);
  });

  it('should create, update, write, redraw, and close a terminal through the injected tmux port', async () => {
    // Arrange
    const fake = new FakeTmux([ok(), ok(), ok(), ok(), ok('history\nhello\n2|1|100|1|1\n'), ok()]);
    const subject = new TmuxTerminalRuntime(fake, () => 1_000, plainShell);

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
    const captured = await subject.capture(created, 2_000);
    await subject.kill(created);

    // Assert
    should(created).match({ id: terminal.id, ownerId: terminal.ownerId, root: terminal.root, createdAtMs: 1_000 });
    should(captured).deepEqual({
      lines: ['history', 'hello'],
      cursorX: 2,
      cursorY: 1,
      cols: 100,
      rows: 1,
      historySize: 1,
    });
    should(fake.received.map(command => command[0])).deepEqual([
      'new-session',
      'set-option',
      'resize-window',
      'send-keys',
      'capture-pane',
      'kill-session',
    ]);
    should(fake.received[3]).deepEqual(['send-keys', '-H', '-t', `${created.tmuxSession}:0.0`, '03', '0d']);
    // ONE process for the rows and the geometry: tmux runs both commands in the same server turn.
    should(fake.received[4]).deepEqual([
      'capture-pane',
      '-p',
      '-e',
      '-N',
      '-S',
      '-2000',
      '-t',
      `${created.tmuxSession}:0.0`,
      ';',
      'display-message',
      '-p',
      '-t',
      `${created.tmuxSession}:0.0`,
      '#{cursor_x}|#{cursor_y}|#{pane_width}|#{pane_height}|#{history_size}',
    ]);
  });

  it('should clean up a partial create and surface mutation or capture failures', async () => {
    // Arrange
    const createFake = new FakeTmux([{ code: 1, stdout: '', stderr: 'create denied' }, ok()]);
    const create = new TmuxTerminalRuntime(createFake, Date.now, plainShell);
    const failed = new TmuxTerminalRuntime(
      new FakeTmux([
        { code: 1, stdout: '', stderr: 'gone' },
        { code: 1, stdout: '', stderr: 'gone' },
        { code: 1, stdout: '', stderr: 'gone' },
        { code: 1, stdout: '', stderr: 'gone' },
        ok(),
      ]),
      Date.now,
      plainShell,
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
    await should(failed.capture(terminal, 200)).be.rejectedWith(/terminal no longer exists/u);
    await should(failed.kill(terminal)).be.fulfilled();
  });

  it('should name a terminal on its pane, and read it as plain text and by its foreground program', async () => {
    // Arrange
    const fake = new FakeTmux([ok(), ok('$ bun dev\nready\n\n\n'), ok('node\n')]);
    const subject = new TmuxTerminalRuntime(fake, () => 1_000, plainShell);

    // Act
    const created = await subject.create({
      ownerId: terminal.ownerId,
      id: terminal.id,
      title: terminal.title,
      cwd: terminal.root,
      size: { cols: 100, rows: 30 },
      name: 'dev',
    });
    const text = await subject.text(created, 50);
    const foreground = await subject.foreground(created);

    // Assert
    should(created.name).equal('dev');
    should(fake.received[0]).containDeepOrdered(['set-option', '-t', created.tmuxSession, '@fy_terminal_name', 'dev']);
    // Plain text, wrapped lines joined, and the blank bottom of the screen dropped.
    should(fake.received[1]).deepEqual(['capture-pane', '-p', '-J', '-S', '-50', '-t', `${created.tmuxSession}:0.0`]);
    should(text).equal('$ bun dev\nready');
    should(foreground).equal('node');
  });

  it('should report a terminal that is gone when it is read or asked what is running', async () => {
    const gone = { code: 1, stdout: '', stderr: "can't find pane" };
    const subject = new TmuxTerminalRuntime(new FakeTmux([gone, gone]), Date.now, plainShell);
    await should(subject.text(terminal, 10)).be.rejectedWith(/terminal no longer exists/u);
    await should(subject.foreground(terminal)).be.rejectedWith(/terminal no longer exists/u);
  });

  it('should surface a real kill failure but accept a terminal already gone', async () => {
    // Arrange
    const subject = new TmuxTerminalRuntime(
      new FakeTmux([
        { code: 1, stdout: '', stderr: "can't find session" },
        { code: 1, stdout: '', stderr: 'permission denied' },
      ]),
      Date.now,
      plainShell,
    );

    // Act + Assert
    await should(subject.kill(terminal)).be.fulfilled();
    await should(subject.kill(terminal)).be.rejectedWith(/could not close terminal/u);
  });
});

describe('TmuxTerminalRuntime against the real tmux', () => {
  it("should read a live pane's coloured rows, its cursor and its size in one combined capture", async () => {
    // Arrange — no fake: the combined `capture-pane ; display-message` is parsed as this tmux prints it.
    const executable = Bun.which('tmux');
    if (executable === null) throw new Error('tmux is required for terminal integration coverage');
    const home = await mkdtemp(join(tmpdir(), 'fy-term-capture-'));
    const tmux = new BunTmuxProcess(executable, join(home, 'tmux.sock'));
    const subject = new TmuxTerminalRuntime(tmux, () => Date.now(), plainShell);
    try {
      const created = await subject.create({
        ownerId: terminal.ownerId,
        id: terminal.id,
        title: terminal.title,
        cwd: home,
        size: { cols: 60, rows: 8 },
      });
      await subject.write(created, new TextEncoder().encode("PS1='$ '; printf '\\033[31mred\\033[0m\\n'\r"));

      // Act — wait for the shell to run the line it was given.
      const captured = await waitForValue(async () => {
        const seen = await subject.capture(created, 200);
        return seen.lines.some(line => line.endsWith('red\u001b[39m')) ? seen : undefined;
      }, 'the pane to show the red line');

      // Assert
      should(captured.cols).equal(60);
      should(captured.rows).equal(8);
      should(captured.lines.length).equal(8);
      should(captured.historySize).equal(0);
      // Each row carries its own colour codes and resets them at its end — which is what lets one row be
      // repainted alone.
      should(captured.lines.some(line => line.endsWith('\u001b[31mred\u001b[39m'))).be.true();
      should(captured.cursorY).be.within(0, 7);
      should(captured.lines[captured.cursorY]).startWith('$');
    } finally {
      await tmux.execute(['kill-server']).catch(() => undefined);
      await rm(home, { recursive: true, force: true });
    }
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
    const subject = new TmuxTerminalRuntime(new FakeTmux([{ code: 1, stdout: '', stderr }]), Date.now, plainShell);

    // Act + Assert
    should(await subject.list()).deepEqual([]);
  });

  it.each(ABSENT)('should treat closing a terminal as done when tmux says %s', async stderr => {
    // Act + Assert — the server's absence took the terminal with it.
    await new TmuxTerminalRuntime(new FakeTmux([{ code: 1, stdout: '', stderr }]), Date.now, plainShell).kill(terminal);
  });

  it('should keep a socket it may not open as an error, never as an empty listing', async () => {
    // Arrange — measured too: a live server whose socket this user cannot open. Reading this as "no
    // terminals" would let a removal proceed past terminals it could not see.
    const stderr = 'error connecting to /tmp/fy-home/tmux.sock (Permission denied)';

    // Act + Assert
    await should(
      new TmuxTerminalRuntime(new FakeTmux([{ code: 1, stdout: '', stderr }]), Date.now, plainShell).list(),
    ).be.rejectedWith(/could not list terminal sessions: error connecting to .*Permission denied/u);
    await should(
      new TmuxTerminalRuntime(new FakeTmux([{ code: 1, stdout: '', stderr }]), Date.now, plainShell).kill(terminal),
    ).be.rejectedWith(/could not close terminal/u);
  });

  it('should list no terminals through the real tmux on a socket nothing has created', async () => {
    // Arrange — no fake: whatever this host's tmux prints for a missing server is what is read.
    const executable = Bun.which('tmux');
    if (executable === null) throw new Error('tmux is required for terminal integration coverage');
    const home = await mkdtemp(join(tmpdir(), 'fy-term-absent-'));
    try {
      const subject = new TmuxTerminalRuntime(
        new BunTmuxProcess(executable, join(home, 'never-started.sock')),
        Date.now,
        plainShell,
      );

      // Act + Assert
      should(await subject.list()).deepEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('TmuxTerminalRuntime login shell', () => {
  const input = {
    ownerId: terminal.ownerId,
    id: terminal.id,
    title: terminal.title,
    cwd: terminal.root,
    size: { cols: 100, rows: 30 },
  };

  it('should start the resolved shell as a login shell instead of /bin/sh', async () => {
    // Arrange
    const fake = new FakeTmux([ok()]);
    const subject = new TmuxTerminalRuntime(fake, Date.now, { shell: async () => '/usr/bin/zsh' });

    // Act
    await subject.create(input);

    // Assert — the program tmux execs is the argv right after the size flags, before the first `;`.
    const argv = fake.received[0] ?? [];
    should(argv.slice(argv.indexOf('30') + 1, argv.indexOf(';'))).deepEqual(['/usr/bin/zsh', '-l']);
    should(argv).not.containEql('/bin/sh');
  });

  it("should run the resolved shell in the real pane, with -l, in the terminal's directory", async () => {
    // Arrange — a stand-in shell that records how it was launched, then becomes a plain shell.
    const executable = Bun.which('tmux');
    if (executable === null) throw new Error('tmux is required for terminal integration coverage');
    const home = await mkdtemp(join(tmpdir(), 'fy-term-shell-'));
    const marker = join(home, 'launched');
    const stand = join(home, 'owner-shell');
    await writeFile(stand, `#!/bin/sh\nprintf '%s|%s|%s\\n' "$0" "$*" "$PWD" > '${marker}'\nexec /bin/sh\n`);
    await chmod(stand, 0o755);
    const tmux = new BunTmuxProcess(executable, join(home, 'tmux.sock'));
    const subject = new TmuxTerminalRuntime(tmux, Date.now, { shell: async () => stand });
    try {
      // Act
      await subject.create({ ...input, cwd: home, size: { cols: 60, rows: 8 } });
      const launched = await waitForValue(async () => {
        const written = await readFile(marker, 'utf8').catch(() => '');
        return written === '' ? undefined : written;
      }, 'the stand-in shell to record how it was launched');

      // Assert
      should(launched.trim()).equal(`${stand}|-l|${home}`);
    } finally {
      await tmux.execute(['kill-server']).catch(() => undefined);
      await rm(home, { recursive: true, force: true });
    }
  });

  it('should open a real bash as a login shell, and still run a command typed into it', async () => {
    // Arrange — bash is the shell the owner's rc files are most likely written for; the command is typed
    // into the pane exactly as `terminal_open` with a `command` does, so it must not depend on the shell.
    const executable = Bun.which('tmux');
    const bash = Bun.which('bash');
    if (executable === null || bash === null) throw new Error('tmux and bash are required for terminal coverage');
    const home = await mkdtemp(join(tmpdir(), 'fy-term-bash-'));
    const tmux = new BunTmuxProcess(executable, join(home, 'tmux.sock'));
    const subject = new TmuxTerminalRuntime(tmux, Date.now, { shell: async () => bash });
    try {
      const created = await subject.create({ ...input, cwd: home, size: { cols: 80, rows: 8 } });

      // Act
      await subject.write(
        created,
        new TextEncoder().encode("PS1='$ '; shopt -q login_shell && echo login-yes; echo typed-$((6*7))\r"),
      );
      const text = await waitForValue(async () => {
        const seen = await subject.text(created, 20);
        return seen.includes('typed-42') ? seen : undefined;
      }, 'the pane to show typed-42');

      // Assert
      should(text).containEql('login-yes');
      should(text).containEql('typed-42');
    } finally {
      await tmux.execute(['kill-server']).catch(() => undefined);
      await rm(home, { recursive: true, force: true });
    }
  });
});
