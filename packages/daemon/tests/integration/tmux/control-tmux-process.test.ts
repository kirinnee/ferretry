import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  BunTmuxProcess,
  type ControlChild,
  type ControlModeOptions,
  ControlModeTmuxProcess,
} from '../../../src/adapters/index.ts';
import type { TmuxCommandPort, TmuxCommandResult } from '../../../src/lib/tmux/contracts.ts';
import type { TmuxControlNotification } from '../../../src/lib/tmux/control-protocol.ts';
import { waitFor } from '../support/wait-for.ts';

const TMUX = Bun.which('tmux');
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The spawn path, counted: every command that still costs a process passes through here. */
class CountingSpawn implements TmuxCommandPort {
  readonly commands: string[][] = [];
  constructor(private readonly inner: TmuxCommandPort) {}
  async execute(arguments_: readonly string[], stdin?: string): Promise<TmuxCommandResult> {
    this.commands.push([...arguments_]);
    return await this.inner.execute(arguments_, stdin);
  }
}

/** A private tmux server with sessions in it, and a control transport over the same socket. */
async function server(options: ControlModeOptions = {}) {
  if (TMUX === null) throw new Error('tmux is required for this test and was not found');
  const root = await mkdtemp(join(tmpdir(), 'fy-ctl-'));
  const socket = join(root, 's');
  const direct = new BunTmuxProcess(TMUX, socket);
  const spawned = new CountingSpawn(direct);
  const subject = new ControlModeTmuxProcess(TMUX, socket, spawned, options);
  cleanups.push(async () => {
    subject.close();
    await direct.execute(['kill-server']);
    await rm(root, { recursive: true, force: true });
  });
  return { direct, spawned, subject, socket };
}

/** Every control-mode client on `socket`, as `ps` lists it. */
function controlClients(socket: string): string[] {
  const listed = Bun.spawnSync(['ps', '-A', '-ww', '-o', 'pid=', '-o', 'args='], { stdout: 'pipe', stderr: 'ignore' });
  return listed.stdout
    .toString()
    .split('\n')
    .filter(line => line.includes(` -S ${socket} `) && line.includes(' -C attach-session '));
}

/** Read commands whose answers the two paths must agree on, byte for byte. */
const READS: readonly (readonly string[])[] = [
  ['has-session', '-t', 'work'],
  ['has-session', '-t', 'nope'],
  ['capture-pane', '-p', '-t', 'work'],
  ['capture-pane', '-p', '-e', '-t', 'work'],
  ['capture-pane', '-p', '-S', '-', '-t', 'work'],
  ['display-message', '-p', '-t', 'work', "#{pane_id}\t#{session_name} it's $HOME ~ a;b \\x é"],
  ['list-panes', '-a', '-F', '#{session_name} #{pane_id}'],
  ['list-sessions', '-F', '#{session_name}'],
  ['list-panes', '-Z'],
  ['display-message', '-p', '-t', 'missing', 'x'],
];

/** A pane that prints the control protocol's own lines, escapes, tabs and non-ASCII, then a long scrollback. */
const HOSTILE =
  "printf 'a\\tb é\\n%%end 1 2 1\\n%%begin 3 4 1\\n%%error 5 6 1\\n\\033[31mred\\033[0m \\\\x\\n'; seq 1 3000; sleep 600";

describe('ControlModeTmuxProcess over a real tmux', () => {
  it('should answer every read exactly as a spawned tmux does, without spawning once connected', async () => {
    // Arrange
    const { direct, spawned, subject } = await server();
    await subject.execute(['new-session', '-d', '-s', 'work', '-x', '80', '-y', '8', HOSTILE]);
    await subject.execute(['new-session', '-d', '-s', 'other', 'sleep', '600']);
    await waitFor(
      async () => (await direct.execute(['capture-pane', '-p', '-t', 'work'])).stdout.includes('\n3000\n'),
      'the pane to print its last line',
    );
    await subject.execute(['has-session', '-t', 'work']);
    const before = spawned.commands.length;

    // Act — all at once, so the replies are pipelined through the one client.
    const actual = await Promise.all(READS.map(async command => await subject.execute(command)));
    const expected = await Promise.all(READS.map(async command => await direct.execute(command)));

    // Assert
    should(actual).deepEqual(expected);
    // tmux keeps 2000 lines of scrollback by default; the capture carries all of them.
    should(actual[4]?.stdout.split('\n').length).be.above(2_000);
    should(spawned.commands.length).equal(before);
  }, 30_000);

  it('should keep every mutation and every stdin payload on its own process', async () => {
    // Arrange
    const { spawned, subject } = await server();
    await subject.execute(['new-session', '-d', '-s', 'work', 'sleep', '600']);
    await subject.execute(['has-session', '-t', 'work']);
    spawned.commands.length = 0;

    // Act
    await subject.execute(['set-option', '-t', 'work', '@fy_probe', 'x']);
    await subject.execute(['load-buffer', '-b', 'fy-paste-work', '-'], 'payload');
    const shown = await subject.execute(['show-buffer', '-b', 'fy-paste-work']);
    await subject.execute(['display-message', '-t', 'work', 'not printed']);

    // Assert
    should(shown.stdout).equal('payload');
    should(spawned.commands.map(command => command[0])).deepEqual([
      'set-option',
      'load-buffer',
      'show-buffer',
      'display-message',
    ]);
    await should(subject.execute(['-S', '/tmp/elsewhere', 'kill-server'])).be.rejectedWith(/command name/);
  }, 30_000);

  it('should fall back while no server runs, wait before asking again, and connect once a command makes one', async () => {
    // Arrange
    let now = 1_000;
    const { spawned, subject } = await server({ nowMs: () => now, retryAfterMs: 5_000 });
    const listings = (): number => spawned.commands.filter(command => command[0] === 'list-sessions').length;

    // Act + Assert — no server: answered on the spawn path, then not redialled inside the wait.
    const absent = await subject.execute(['has-session', '-t', 'work']);
    should(absent.code).equal(1);
    should(absent.stderr).match(/error connecting to|no server running/);
    await subject.execute(['has-session', '-t', 'work']);
    should(listings()).equal(1);
    now += 5_000;
    await subject.execute(['has-session', '-t', 'work']);
    should(listings()).equal(2);

    // A command that creates a session ends the wait at once; the next read connects.
    await subject.execute(['new-session', '-d', '-s', 'work', 'sleep', '600']);
    await subject.execute(['has-session', '-t', 'work']);
    const connected = spawned.commands.length;
    await subject.execute(['has-session', '-t', 'work']);
    should(spawned.commands.length).equal(connected);
  }, 30_000);

  it('should never attach to a terminal, nor to a name it could not address', async () => {
    // Arrange
    let now = 0;
    const { direct, spawned, subject } = await server({ nowMs: () => now });
    await direct.execute(['new-session', '-d', '-s', 'fy-term-x', 'sleep', '600']);
    await direct.execute(['set-option', '-t', 'fy-term-x', '@fy_terminal_owner', 'owner']);
    await direct.execute(['new-session', '-d', '-s', 'Upper', 'sleep', '600']);
    const before = await direct.execute(['display-message', '-p', '-t', 'fy-term-x', '#{session_attached}']);

    // Act
    const answered = await subject.execute(['has-session', '-t', 'fy-term-x']);
    now += 20_000;
    await subject.execute(['has-session', '-t', 'fy-term-x']);

    // Assert — each read went to its own process, and the terminal was never attached.
    should(answered.code).equal(0);
    should(before.stdout).equal('0\n');
    should((await direct.execute(['display-message', '-p', '-t', 'fy-term-x', '#{session_attached}'])).stdout).equal(
      '0\n',
    );
    should(spawned.commands.filter(command => command[0] === 'has-session').length).equal(2);
  }, 30_000);

  it('should hand notifications to the subscribers that asked for them, and reconnect when its session ends', async () => {
    // Arrange
    const { spawned, subject } = await server();
    await subject.execute(['new-session', '-d', '-s', 'aaa', 'sleep', '600']);
    await subject.execute(['new-session', '-d', '-s', 'bbb', 'sleep', '600']);
    await subject.execute(['has-session', '-t', 'aaa']);
    const all: TmuxControlNotification[] = [];
    const paneEvents: TmuxControlNotification[] = [];
    const sessionEvents: TmuxControlNotification[] = [];
    subject.subscribe(() => {
      throw new Error('a broken listener');
    });
    const stop = subject.subscribe(notification => all.push(notification));
    subject.subscribe(notification => paneEvents.push(notification), { paneId: '%0' });
    subject.subscribe(notification => sessionEvents.push(notification), { sessionId: '$0' });

    // Act — copy mode in the attached session's pane, a new session elsewhere, then the attached one ends.
    await subject.execute(['copy-mode', '-t', 'aaa']);
    await subject.execute(['new-session', '-d', '-s', 'ccc', 'sleep', '600']);
    await waitFor(() => {
      const kinds = all.map(notification => notification.kind);
      return kinds.includes('pane-mode-changed') && kinds.includes('sessions-changed');
    }, 'the client to hear the copy mode and the new session');
    stop();
    await subject.execute(['kill-session', '-t', 'aaa']);
    await waitFor(() => !subject.connected, 'the client to notice its session ended');
    const listingsBefore = spawned.commands.filter(command => command[0] === 'list-sessions').length;
    const after = await subject.execute(['has-session', '-t', 'bbb']);

    // Assert
    should(all.map(notification => notification.kind)).containEql('pane-mode-changed');
    should(all.map(notification => notification.kind)).containEql('sessions-changed');
    should(paneEvents.length).be.above(0);
    should(paneEvents.every(notification => (notification as { paneId?: string }).paneId === '%0')).be.true();
    should(sessionEvents.every(notification => (notification as { sessionId?: string }).sessionId === '$0')).be.true();
    should(all.map(notification => notification.kind)).not.containEql('exit');
    should(after.code).equal(0);
    should(spawned.commands.filter(command => command[0] === 'list-sessions').length).equal(listingsBefore + 1);
  }, 30_000);

  it('should answer on the spawn path once closed, including a read already on its way', async () => {
    // Arrange
    const { spawned, subject } = await server();
    await subject.execute(['new-session', '-d', '-s', 'work', 'sleep', '600']);
    await subject.execute(['has-session', '-t', 'work']);
    const before = spawned.commands.length;

    // Act
    const racing = subject.execute(['has-session', '-t', 'work']);
    subject.close();
    const raced = await racing;
    const closed = await subject.execute(['has-session', '-t', 'work']);

    // Assert
    should([raced.code, closed.code]).deepEqual([0, 0]);
    should(spawned.commands.length).equal(before + 2);
  }, 30_000);

  it('should answer stop only once its client has exited, leaving nothing of it on the server', async () => {
    // Arrange
    const { direct, socket, subject } = await server();
    await subject.execute(['new-session', '-d', '-s', 'work', 'sleep', '600']);
    await subject.execute(['has-session', '-t', 'work']);
    should(controlClients(socket)).have.length(1);

    // Act
    const clean = await subject.stop();

    // Assert — gone the moment stop answers, without a wait of the test's own; the server is untouched.
    should(clean).be.true();
    should(controlClients(socket)).deepEqual([]);
    should((await direct.execute(['display-message', '-p', '-t', 'work', '#{session_attached}'])).stdout).equal('0\n');
    should((await subject.execute(['has-session', '-t', 'work'])).code).equal(0);
  }, 30_000);

  it('should refuse a relative executable or socket', () => {
    // Act + Assert
    should(() => new ControlModeTmuxProcess('tmux', '/tmp/s')).throw(/absolute/);
    should(() => new ControlModeTmuxProcess('/usr/bin/tmux', 's')).throw(/absolute/);
  });
});

/** A control client this test scripts line by line, to reach what a healthy tmux never does. */
class ScriptedChild implements ControlChild {
  readonly written: string[] = [];
  killed = false;
  writeFails = false;
  killFails = false;
  /** Every signal sent, in order. */
  readonly signals: string[] = [];
  /** Whether SIGTERM leaves this process running, as a client stuck on its server would be. */
  ignoresTerm = false;
  private readonly queue: (string | Error | null)[] = [];
  private wake: (() => void) | undefined;
  private exit: () => void = () => undefined;
  readonly exited = new Promise<void>(resolve => (this.exit = resolve));

  readonly stdin = {
    write: (text: string): void => {
      if (this.writeFails) throw new Error('EPIPE');
      this.written.push(text);
      this.onWrite?.(text);
    },
    flush: (): void => undefined,
  };

  readonly stdout: AsyncIterable<Uint8Array>;

  constructor(private readonly onWrite?: (text: string) => void) {
    const encoder = new TextEncoder();
    const self = this;
    this.stdout = {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (self.queue.length === 0) await new Promise<void>(resolve => (self.wake = resolve));
          const next = self.queue.shift();
          if (next === null || next === undefined) return;
          if (next instanceof Error) throw next;
          yield encoder.encode(next);
        }
      },
    };
  }

  /** The nonces of every command written so far, in order. */
  nonces(): string[] {
    return [...this.written.join('').matchAll(/^display-message -p ([0-9a-f]+)$/gmu)].map(match => match[1] as string);
  }

  emit(text: string | Error | null): void {
    this.queue.push(text);
    this.wake?.();
  }

  kill(signal?: 'SIGKILL'): void {
    this.killed = true;
    this.signals.push(signal ?? 'SIGTERM');
    if (this.killFails) throw new Error('no such process');
    this.emit(null);
    if (signal === 'SIGKILL' || !this.ignoresTerm) this.exit();
  }
}

/** A transport whose control client is {@link ScriptedChild}, over a spawn path that always answers. */
function scripted(options: ControlModeOptions & { readonly child?: () => ControlChild } = {}) {
  const children: ControlChild[] = [];
  const spawned: string[][] = [];
  const fallback: TmuxCommandPort = {
    execute: async arguments_ => {
      spawned.push([...arguments_]);
      if (arguments_[0] === 'list-sessions') return { code: 0, stdout: 'Bad\nwork\t\n', stderr: '' };
      return { code: 0, stdout: 'spawned\n', stderr: '' };
    },
  };
  let counter = 0;
  const subject = new ControlModeTmuxProcess('/usr/bin/tmux', '/tmp/fy-scripted.sock', fallback, {
    nonce: () => `${String(++counter).padStart(16, '0')}abc`.replace(/[^0-9a-f]/gu, 'a'),
    replyTimeoutMs: 1_000,
    ...options,
    spawn: argv => {
      should(argv).deepEqual([
        '/usr/bin/tmux',
        '-u',
        '-N',
        '-S',
        '/tmp/fy-scripted.sock',
        '-C',
        'attach-session',
        '-t',
        '=work',
        '-f',
        'ignore-size,no-output',
      ]);
      const child = options.child?.() ?? new ScriptedChild();
      children.push(child);
      return child;
    },
  });
  const reads = (): number => spawned.filter(command => command[0] === 'has-session').length;
  return { subject, children, spawned, reads };
}

const HAS = ['has-session', '-t', 'work'] as const;

/** Answer the command whose nonce is `nonce` as tmux would, with `lines` of output. */
function reply(child: ScriptedChild, n: number, nonce: string, lines: string[], edge = 'end'): void {
  child.emit(`%begin 9 ${String(n)} 1\n${lines.map(line => `${line}\n`).join('')}%${edge} 9 ${String(n)} 1\n`);
  child.emit(`%begin 9 ${String(n + 1)} 1\n${nonce}\n%end 9 ${String(n + 1)} 1\n`);
}

describe('ControlModeTmuxProcess against a scripted client', () => {
  it('should skip the attach block, read lines split across chunks, and answer in order', async () => {
    // Arrange
    const child = new ScriptedChild();
    const { subject, reads } = scripted({ child: () => child });
    const seen: TmuxControlNotification[] = [];
    subject.subscribe(notification => seen.push(notification));

    // Act
    const first = subject.execute(HAS);
    const second = subject.execute(['display-message', '-p', 'x']);
    await waitFor(() => child.nonces().length >= 2, 'both commands to reach the client');
    const [one, two] = child.nonces();
    child.emit('%begin 9 1 0\n%end 9 1');
    child.emit(' 0\n%session-changed $0 work\n');
    reply(child, 2, one as string, []);
    child.emit('%sessions-changed\n');
    reply(child, 4, two as string, ['x'], 'error');

    // Assert
    should(await first).deepEqual({ code: 0, stdout: '', stderr: '' });
    should(await second).deepEqual({ code: 1, stdout: '', stderr: 'x\n' });
    should(seen).deepEqual([{ kind: 'session-changed', sessionId: '$0', name: 'work' }, { kind: 'sessions-changed' }]);
    should(reads()).equal(0);
  });

  it.each([
    ['text outside any block', (child: ScriptedChild) => child.emit('stray\n')],
    ['a reply nobody asked for', (child: ScriptedChild) => child.emit('%begin 9 1 1\n')],
    ['a broken frame', (child: ScriptedChild) => child.emit(`%begin 9 1 1\nx\n%begin 9 2 1\n${child.nonces()[0]}\n`)],
    ['a broken pipe', (child: ScriptedChild) => child.emit(new Error('EPIPE'))],
    ['a client that exits', (child: ScriptedChild) => child.emit(null)],
  ])('should answer on the spawn path after %s', async (_label, breakIt) => {
    // Arrange — the first read is answered in-band, so the client counts as having worked.
    const child = new ScriptedChild();
    const { subject, reads, children } = scripted({ child: () => child });
    const warm = subject.execute(HAS);
    await waitFor(() => child.nonces().length >= 1, 'the warm-up read to reach the client');
    reply(child, 1, child.nonces()[0] as string, []);
    await warm;
    child.written.length = 0;

    // Act — a read is in flight when the stream goes wrong.
    const pending = subject.execute(HAS);
    await waitFor(() => child.nonces().length >= 1, 'the in-flight read to reach the client');
    breakIt(child);
    const actual = await pending;

    // Assert
    should(actual.stdout).equal('spawned\n');
    should(reads()).equal(1);
    should(child.killed).be.true();
    // It had answered, so the next read dials again at once.
    void subject.execute(HAS);
    await waitFor(() => children.length === 2, 'the next read to dial a second client');
    should(children.length).equal(2);
  });

  it('should drop a client whose nonce block does not end, after answering the read it completed', async () => {
    // Arrange
    const child = new ScriptedChild();
    const { subject, reads, children } = scripted({ child: () => child });

    // Act
    const pending = subject.execute(HAS);
    await waitFor(() => child.nonces().length >= 1, 'the read to reach the client');
    child.emit(`%begin 9 1 1\n%end 9 1 1\n%begin 9 2 1\n${child.nonces()[0]}\n%end 9 3 1\n`);
    const actual = await pending;
    await waitFor(() => child.killed, 'the client with the stray line to be dropped');
    void subject.execute(HAS);
    await waitFor(() => children.length === 2, 'the next read to dial a second client');

    // Assert — the reply was whole before the stray line, so it stands; the client does not.
    should(actual).deepEqual({ code: 0, stdout: '', stderr: '' });
    should(reads()).equal(0);
    should(child.killed).be.true();
    should(children.length).equal(2);
  });

  it('should time out a read nobody answers, and wait before redialling a client that never answered', async () => {
    // Arrange
    let now = 0;
    const readsAtDial: number[] = [];
    const { subject, reads, children } = scripted({
      replyTimeoutMs: 30,
      nowMs: () => now,
      retryAfterMs: 1_000,
      // Counted as the client is dialled: the redialled client's own reply timeout is real time, and by the
      // time a poll saw it the read it dialled for could already have fallen back.
      child: () => {
        readsAtDial.push(reads());
        return new ScriptedChild();
      },
    });

    // Act
    const actual = await subject.execute(HAS);
    await subject.execute(HAS);
    now = 1_000;
    void subject.execute(HAS);
    await waitFor(() => children.length === 2, 'the read after the wait to dial a second client');

    // Assert
    should(actual.stdout).equal('spawned\n');
    should(readsAtDial).deepEqual([0, 2]);
    should(children.length).equal(2);
  });

  it('should survive a client it cannot start, write to or kill', async () => {
    // Arrange
    let now = 0;
    const unwritable = new ScriptedChild();
    unwritable.writeFails = true;
    unwritable.killFails = true;
    const broken: ControlChild = {
      stdin: { write: () => undefined, flush: () => undefined },
      stdout: {
        [Symbol.asyncIterator]: () => ({
          next: () => {
            throw new Error('no stream');
          },
        }),
      },
      exited: Promise.resolve(),
      kill: () => undefined,
    };
    const sequence: (() => ControlChild)[] = [
      () => {
        throw new Error('spawn failed');
      },
      () => unwritable,
      () => broken,
    ];
    const { subject, reads } = scripted({ child: () => (sequence.shift() as () => ControlChild)(), nowMs: () => now });

    // Act + Assert — each one answered on the spawn path.
    should((await subject.execute(HAS)).stdout).equal('spawned\n');
    now += 20_000;
    should((await subject.execute(HAS)).stdout).equal('spawned\n');
    should(unwritable.killed).be.true();
    now += 20_000;
    should((await subject.execute(HAS)).stdout).equal('spawned\n');
    should(reads()).equal(3);
  });

  it('should SIGKILL a client SIGTERM leaves running, and answer that it had to', async () => {
    // Arrange — a connection that ended long ago, and one still open, neither of which goes on SIGTERM.
    let now = 0;
    const stuck = [new ScriptedChild(), new ScriptedChild()];
    for (const child of stuck) child.ignoresTerm = true;
    const sequence = [...stuck];
    const { subject } = scripted({ child: () => sequence.shift() as ScriptedChild, nowMs: () => now });
    const first = subject.execute(HAS);
    await waitFor(() => (stuck[0] as ScriptedChild).nonces().length >= 1, 'the first read to reach its client');
    (stuck[0] as ScriptedChild).emit(null);
    await first;
    now += 20_000;
    void subject.execute(HAS);
    await waitFor(() => (stuck[1] as ScriptedChild).nonces().length >= 1, 'the second read to reach its client');

    // Act
    const clean = await subject.stop(20);

    // Assert
    should(clean).be.false();
    should(stuck.map(child => child.signals)).deepEqual([
      ['SIGTERM', 'SIGKILL'],
      ['SIGTERM', 'SIGKILL'],
    ]);
  });

  it('should answer stop at once when there is no client, and start none for a read already connecting', async () => {
    // Arrange
    const { subject, children, reads } = scripted();

    // Act
    const read = subject.execute(HAS);
    const clean = await subject.stop(20);

    // Assert
    should(clean).be.true();
    should((await read).stdout).equal('spawned\n');
    should(children).have.length(0);
    should(reads()).equal(1);
  });

  it('should give up on a client it cannot signal at all, after the same bounded waits', async () => {
    // Arrange
    const unkillable = new ScriptedChild();
    unkillable.killFails = true;
    const { subject } = scripted({ child: () => unkillable });
    void subject.execute(HAS);
    await waitFor(() => unkillable.nonces().length >= 1, 'the read to reach the client');

    // Act
    const clean = await subject.stop(10);

    // Assert
    should(clean).be.false();
    should(unkillable.signals).deepEqual(['SIGTERM', 'SIGKILL']);
  });

  it('should not dial at all when tmux will not list its sessions', async () => {
    // Arrange
    const refusing: TmuxCommandPort = {
      execute: async arguments_ =>
        arguments_[0] === 'list-sessions'
          ? Promise.reject(new Error('tmux missing'))
          : { code: 1, stdout: '', stderr: 'no server running on /tmp/x\n' },
    };
    let dialled = 0;
    const subject = new ControlModeTmuxProcess('/usr/bin/tmux', '/tmp/x', refusing, {
      spawn: () => {
        dialled += 1;
        return new ScriptedChild();
      },
    });

    // Act
    const actual = await subject.execute(HAS);

    // Assert
    should(actual.code).equal(1);
    should(dialled).equal(0);
  });
});

describe('ControlModeTmuxProcess construction', () => {
  it('should refuse a relative executable or socket even when the spawn path is injected', () => {
    // Arrange — the default spawn path refuses relative paths itself, before the transport can; an
    // injected one must not let a relative path reach the control client.
    const injected: TmuxCommandPort = { execute: async () => ({ code: 0, stdout: '', stderr: '' }) };

    // Act / Assert
    should(() => new ControlModeTmuxProcess('tmux', '/run/fy/tmux.sock', injected)).throw(/must both be absolute/u);
    should(() => new ControlModeTmuxProcess('/usr/bin/tmux', 'tmux.sock', injected)).throw(/must both be absolute/u);
  });

  it('should refuse to attach read-only, and accept the same attach without it', () => {
    // Arrange — tmux 3.7+ refuses a send-keys whose target client is read-only, and picks any attached
    // client as that target: one such client would refuse the daemon's keystrokes into every agent.
    const injected: TmuxCommandPort = { execute: async () => ({ code: 0, stdout: '', stderr: '' }) };
    const attach = (flags: string) => () =>
      new ControlModeTmuxProcess('/usr/bin/tmux', '/run/fy/tmux.sock', injected, {
        attach: { target: 'agent', flags },
        mutations: 'refuse',
      });

    // Act / Assert
    should(attach('ignore-size,read-only,no-output')).throw(/must not attach read-only/u);
    should(attach('ignore-size,no-output')).not.throw();
  });
});
