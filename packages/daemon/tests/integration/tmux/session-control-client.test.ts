/**
 * A SESSION WORKER'S OWN tmux CLIENT, over a real tmux: attached to its one session, read-only, and
 * refusing to run anything but a read.
 *
 * tmux's `read-only` flag guards keyboard input, NOT control commands — an in-band `send-keys` from a
 * read-only client still types into the pane (measured on 3.6a). A worker watches an agent and must
 * never type into it, so its client refuses every command that is not an allowlisted read itself, and
 * never hands one to a spawned tmux either. This holds it to that, command by command.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { BunTmuxProcess, ControlModeTmuxProcess } from '../../../src/adapters/index.ts';
import type { TmuxCommandPort, TmuxCommandResult } from '../../../src/lib/tmux/contracts.ts';
import { PANE_WATCH_FORMAT, parsePaneWatch } from '../../../src/lib/tmux/control-protocol.ts';

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
    attach: { target, flags: 'ignore-size,read-only,no-output' },
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
    await Bun.sleep(1_200);
    await direct.execute(['send-keys', '-t', 'agent', 'drawn', 'Enter']);
    await Bun.sleep(1_500);
    await direct.execute(['send-keys', '-t', 'agent', 'C-d']);
    for (let wait = 0; wait < 40 && !values.some(value => parsePaneWatch(value)?.dead === true); wait += 1)
      await Bun.sleep(100);

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
});
