/**
 * A SESSION WORKER'S OWN tmux CLIENT, over a real tmux: attached to its one session and refusing to run
 * anything but a read.
 *
 * tmux's `read-only` flag is no guard for this: on 3.6a an in-band `send-keys` from a read-only client
 * still typed into the pane, and from 3.7 a read-only client makes tmux refuse the daemon's OWN
 * `send-keys` whenever it is picked as their target client. A worker watches an agent and must never type
 * into it, so its client refuses every command that is not an allowlisted read itself, and never hands one
 * to a spawned tmux either — while staying a client tmux lets the daemon type past. This holds it to both.
 */
import { afterEach, describe, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { BunTmuxProcess, ControlModeTmuxProcess } from '../../../src/adapters/index.ts';
import type { TmuxCommandPort, TmuxCommandResult } from '../../../src/lib/tmux/contracts.ts';
import {
  PANE_WATCH_FORMAT,
  parsePaneWatch,
  SESSION_WORKER_ATTACH_FLAGS,
} from '../../../src/lib/tmux/control-protocol.ts';
import { isTmuxServerAbsent } from '../../../src/lib/tmux/server-absent.ts';
import { waitFor } from '../support/wait-for.ts';

const TMUX = Bun.which('tmux');
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The spawn path, counted: a worker's client may spawn a read when it is not connected, never more. */
class CountingSpawn implements TmuxCommandPort {
  readonly commands: string[][] = [];
  constructor(private readonly inner: TmuxCommandPort) {}
  async execute(arguments_: readonly string[], stdin?: string): Promise<TmuxCommandResult> {
    this.commands.push([...arguments_]);
    return await this.inner.execute(arguments_, stdin);
  }
}

async function attached(target = 'agent') {
  if (TMUX === null) throw new Error('tmux is required for this test and was not found');
  const root = await mkdtemp(join(tmpdir(), 'fy-worker-ctl-'));
  const socket = join(root, 's');
  const direct = new BunTmuxProcess(TMUX, socket);
  await direct.execute(['new-session', '-d', '-s', 'agent', '-x', '80', '-y', '8', 'cat']);
  await direct.execute(['new-session', '-d', '-s', 'neighbour', '-x', '80', '-y', '8', 'cat']);
  const spawned = new CountingSpawn(direct);
  const subject = new ControlModeTmuxProcess(TMUX, socket, spawned, {
    attach: { target, flags: SESSION_WORKER_ATTACH_FLAGS },
    mutations: 'refuse',
  });
  cleanups.push(async () => {
    subject.close();
    await direct.execute(['kill-server']);
    await rm(root, { recursive: true, force: true });
  });
  return { direct, spawned, subject };
}

/** Every kind of command that changes the server, the pane or a client: none of them may run. */
const MUTATIONS: readonly (readonly string[])[] = [
  ['send-keys', '-t', 'agent', 'echo typed', 'Enter'],
  ['send-keys', '-l', '-t', 'agent', 'literal'],
  ['paste-buffer', '-t', 'agent'],
  ['set-buffer', 'secret'],
  ['kill-session', '-t', 'agent'],
  ['kill-pane', '-t', 'agent'],
  ['kill-server'],
  ['new-session', '-d', '-s', 'spawned'],
  ['new-window', '-t', 'agent'],
  ['rename-session', '-t', 'agent', 'renamed'],
  ['resize-window', '-t', 'agent', '-x', '10'],
  ['set-option', '-t', 'agent', 'status', 'off'],
  ['respawn-pane', '-k', '-t', 'agent'],
  ['detach-client'],
  ['run-shell', 'touch /tmp/never'],
  ['display-message', '-t', 'agent', 'not printed'],
  ['capture-pane', '-t', 'agent'],
];

describe('a session worker’s attached control client', () => {
  it('should answer its session’s reads in-band, without spawning once connected', async () => {
    // Arrange
    const { spawned, subject } = await attached();
    await subject.execute(['has-session', '-t', 'agent']);
    const before = spawned.commands.length;

    // Act
    const capture = await subject.execute(['capture-pane', '-p', '-t', 'agent']);
    const activity = await subject.execute(['display-message', '-p', '-t', 'agent', '#{session_name}']);

    // Assert
    should(capture.code).equal(0);
    should(activity.stdout).equal('agent\n');
    should(spawned.commands.length).equal(before);
  });

  it.each(MUTATIONS.map(command => [command]))('should refuse %p without running it anywhere', async command => {
    // Arrange
    const { direct, spawned, subject } = await attached();
    await subject.execute(['has-session', '-t', 'agent']);
    const before = spawned.commands.length;

    // Act
    const actual = await subject.execute(command);

    // Assert — refused, nothing spawned, and the server and the pane are exactly as they were.
    should(actual.code).equal(1);
    should(actual.stderr).match(/^refused: this client only reads/);
    should(spawned.commands.length).equal(before);
    should((await direct.execute(['list-sessions', '-F', '#{session_name}'])).stdout).equal('agent\nneighbour\n');
    should((await direct.execute(['capture-pane', '-p', '-t', 'agent'])).stdout.trim()).equal('');
  });

  it('should let the daemon’s own send-keys type into every pane while it is attached', async () => {
    // Arrange — the worker's client attached and connected; tmux takes the most recently active attached
    // client as the target client of a send-keys that names none, so it is this one.
    const { direct, subject } = await attached();
    await subject.execute(['has-session', '-t', 'agent']);
    should(subject.connected).be.true();

    // Act — the daemon's keystrokes, from a spawned tmux, into the watched pane and into another session's.
    const own = await direct.execute(['send-keys', '-t', 'agent', '-l', 'typed past the worker']);
    const other = await direct.execute(['send-keys', '-t', 'neighbour', '-l', 'typed next door']);
    for (let wait = 0; wait < 40; wait += 1) {
      const shown = await direct.execute(['capture-pane', '-p', '-t', 'agent']);
      if (shown.stdout.includes('typed past the worker')) break;
      await Bun.sleep(50);
    }

    // Assert — on tmux 3.7+ a read-only client here fails both with "client is read-only".
    should(own).deepEqual({ code: 0, stdout: '', stderr: '' });
    should(other).deepEqual({ code: 0, stdout: '', stderr: '' });
    should((await direct.execute(['capture-pane', '-p', '-t', 'agent'])).stdout).match(/typed past the worker/u);
  });

  it('should refuse a stdin payload too, and never accept a session it could not address', async () => {
    // Arrange
    const { subject } = await attached();

    // Act
    const loaded = await subject.execute(['load-buffer', '-'], 'payload');

    // Assert
    should(loaded.code).equal(1);
    should(
      () =>
        new ControlModeTmuxProcess('/usr/bin/tmux', '/tmp/s', undefined, { attach: { target: '=evil', flags: '' } }),
    ).throw(/is not a session a control client may attach to/);
  });
});

describe('a session worker’s pane subscription', () => {
  it('should hear its pane draw and die, with no pane bytes streamed, and refuse a name it cannot carry', async () => {
    // Arrange
    const { direct, subject } = await attached();
    await direct.execute(['set-option', '-t', 'agent', 'remain-on-exit', 'on']);
    const values: string[] = [];
    subject.subscribe(notification => {
      if (notification.kind === 'subscription-changed' && notification.name === 'fy-pane')
        values.push(notification.value);
      if (notification.kind === 'output') values.push('OUTPUT');
    });

    // Act
    const took = await subject.watch('fy-pane', PANE_WATCH_FORMAT);
    const connected = subject.connected;
    await waitFor(() => values.some(value => parsePaneWatch(value)?.dead === false), 'the first report of a live pane');
    await direct.execute(['send-keys', '-t', 'agent', 'drawn', 'Enter']);
    await waitFor(
      async () => (await direct.execute(['capture-pane', '-p', '-t', 'agent'])).stdout.includes('drawn'),
      'the pane to draw what was typed',
    );
    await direct.execute(['send-keys', '-t', 'agent', 'C-d']);
    await waitFor(() => values.some(value => parsePaneWatch(value)?.dead === true), 'the report that the pane died');

    // Assert
    should(took).be.true();
    should(connected).be.true();
    should(values).not.containEql('OUTPUT');
    should(values.some(value => parsePaneWatch(value)?.dead === false)).be.true();
    should(values.some(value => parsePaneWatch(value)?.dead === true)).be.true();
    await should(subject.watch('Not A Name', PANE_WATCH_FORMAT)).be.rejectedWith(/cannot be subscribed/);
  }, 20_000);

  it('should answer that a subscription did not take while no client can connect', async () => {
    // Arrange — a session that does not exist cannot be attached to.
    const { subject } = await attached('missing');

    // Act
    const took = await subject.watch('fy-pane', PANE_WATCH_FORMAT);

    // Assert
    should(took).be.false();
    should(subject.connected).be.false();
  });

  it('should start no tmux server where none runs, so nothing it dials can outlive the daemon', async () => {
    // Arrange — the daemon's socket before any pane was launched: nothing serves it.
    if (TMUX === null) throw new Error('tmux is required for this test and was not found');
    const root = await mkdtemp(join(tmpdir(), 'fy-worker-ctl-'));
    const socket = join(root, 's');
    const direct = new BunTmuxProcess(TMUX, socket);
    const subject = new ControlModeTmuxProcess(TMUX, socket, direct, {
      attach: { target: 'agent', flags: SESSION_WORKER_ATTACH_FLAGS },
      mutations: 'refuse',
    });
    cleanups.push(async () => {
      subject.close();
      await direct.execute(['kill-server']);
      await rm(root, { recursive: true, force: true });
    });

    // Act
    const took = await subject.watch('fy-pane', PANE_WATCH_FORMAT);
    const read = await subject.execute(['display-message', '-p', '-t', 'agent', '#{pane_id}']);

    // Assert — tmux makes the socket file when a server starts and leaves it behind when that server
    // exits, so a socket that never appeared is a server that never ran.
    should(took).be.false();
    should(read.code).equal(1);
    should(isTmuxServerAbsent(read.stderr)).be.true();
    should(existsSync(socket)).be.false();
  });
});
