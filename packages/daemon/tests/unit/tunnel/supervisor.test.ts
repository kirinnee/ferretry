/**
 * The `cloudflared` child kept running: started with the token in its environment only, published while
 * an edge connection is registered, restarted with a capped jittered backoff when it exits, killed and
 * replaced when the token changes, and stopped with the daemon.
 */

import { beforeEach, describe, it } from 'bun:test';
import should from 'should';
import { CONNECTOR_RESTART_BACKOFF, ConnectorSupervisor } from '../../../src/lib/tunnel/supervisor.ts';
import { FakeConnectorProcesses, ManualScheduler, registered, unregistered } from './support.ts';

const TOKEN = 'fake-connector-token-ONE';
const NEXT_TOKEN = 'fake-connector-token-TWO';

let processes: FakeConnectorProcesses;
let scheduler: ManualScheduler;
let notices: string[];
let registrations: boolean[];
let supervisor: ConnectorSupervisor;

beforeEach(() => {
  processes = new FakeConnectorProcesses();
  scheduler = new ManualScheduler();
  notices = [];
  registrations = [];
  supervisor = new ConnectorSupervisor({
    executable: '/nix/store/cloudflared/bin/cloudflared',
    processes,
    scheduler,
    random: () => 0,
    notice: line => notices.push(line),
    registration: value => registrations.push(value),
  });
});

/** Lets every settled exit run its handlers. */
const settle = async () => {
  for (let round = 0; round < 5; round += 1) await Promise.resolve();
};

describe('the cloudflared supervisor', () => {
  it('should start cloudflared with the token in its environment and never in its arguments', () => {
    // Act
    supervisor.run(TOKEN);

    // Assert
    const command = processes.latest.command;
    should(command.executable).equal('/nix/store/cloudflared/bin/cloudflared');
    should([...command.args]).deepEqual(['tunnel', '--no-autoupdate', 'run', '--protocol', 'quic']);
    should(command.args.some(argument => argument.includes(TOKEN))).be.false();
    should(command.environment).deepEqual({ TUNNEL_TOKEN: TOKEN });
  });

  it('should count as registered only while an edge connection is, across all four', () => {
    // Arrange
    supervisor.run(TOKEN);

    // Act
    processes.latest.say('INF Starting tunnel');
    const beforeEdge = supervisor.registered;
    processes.latest.say(registered(0));
    processes.latest.say(registered(1));
    processes.latest.say(unregistered(0));
    const withOneLeft = supervisor.registered;
    processes.latest.say(unregistered(1));

    // Assert — one change each way, not one per line.
    should([beforeEdge, withOneLeft, supervisor.registered]).deepEqual([false, true, false]);
    should(registrations).deepEqual([true, false]);
  });

  it('should restart an exited connector with a capped, jittered backoff, and withdraw it meanwhile', async () => {
    // Arrange
    supervisor.run(TOKEN);
    processes.latest.say(registered(0));

    // Act — it dies, twice, without ever registering again.
    processes.latest.exit(1);
    await settle();
    const firstWait = scheduler.armed;
    scheduler.fire();
    processes.latest.exit(null);
    await settle();
    const secondWait = scheduler.armed;

    // Assert
    should(registrations).deepEqual([true, false]);
    should(firstWait).deepEqual([CONNECTOR_RESTART_BACKOFF.baseMs / 2]);
    should(secondWait).deepEqual([CONNECTOR_RESTART_BACKOFF.baseMs]);
    should(processes.spawned.length).equal(2);
    should(notices).deepEqual([
      'tunnel connector down — cloudflared exited (code 1); restarting in 1s',
      'tunnel connector down — cloudflared exited (by a signal); restarting in 1s',
    ]);
  });

  it('should start the backoff over once a connector reaches the edge again', async () => {
    // Arrange — three failures in a row grow the wait.
    supervisor.run(TOKEN);
    for (let failure = 0; failure < 3; failure += 1) {
      processes.latest.exit(1);
      await settle();
      scheduler.fire();
    }
    // Act
    processes.latest.say(registered(0));
    processes.latest.exit(1);
    await settle();

    // Assert
    should(scheduler.armed).deepEqual([CONNECTOR_RESTART_BACKOFF.baseMs / 2]);
  });

  it('should say a connector it could not start and try again, without the token in the sentence', () => {
    // Arrange
    processes.failNext = new Error('ENOENT: no such file /nix/store/cloudflared/bin/cloudflared');

    // Act
    supervisor.run(TOKEN);

    // Assert
    should(processes.spawned.length).equal(0);
    should(notices).deepEqual([
      'tunnel connector down — cloudflared could not be started (ENOENT: no such file /nix/store/cloudflared/bin/cloudflared); restarting in 1s',
    ]);
    scheduler.fire();
    should(processes.spawned.length).equal(1);
    should(notices.join('\n').includes(TOKEN)).be.false();
  });

  it('should say a non-error thrown by a spawn as itself', () => {
    processes.failNext = 'spawn refused';
    supervisor.run(TOKEN);
    should(notices[0]).match(/could not be started \(spawn refused\)/u);
  });

  it('should keep the same connector for the same token', () => {
    // Act
    supervisor.run(TOKEN);
    supervisor.run(TOKEN);

    // Assert
    should(processes.spawned.length).equal(1);
  });

  it('should kill the connector on a new token and start the next only once the old one has gone', async () => {
    // Arrange
    processes.stubborn = true;
    supervisor.run(TOKEN);
    const old = processes.latest;
    old.say(registered(0));

    // Act
    supervisor.run(NEXT_TOKEN);
    const whileDying = processes.spawned.length;
    // The dying child's last words cannot register the tunnel the new one has not reached yet.
    old.say(registered(1));
    old.exit(null);
    await settle();

    // Assert
    should(old.terminated).be.true();
    should(whileDying).equal(1);
    should(processes.spawned.length).equal(2);
    should(processes.latest.command.environment).deepEqual({ TUNNEL_TOKEN: NEXT_TOKEN });
    should(registrations).deepEqual([true, false]);
    should(scheduler.armed).deepEqual([]);
  });

  it('should start only the newest of two quick token changes', async () => {
    // Arrange
    processes.stubborn = true;
    supervisor.run(TOKEN);
    const first = processes.latest;

    // Act
    supervisor.run(NEXT_TOKEN);
    supervisor.run('fake-connector-token-THREE');
    first.exit(null);
    await settle();

    // Assert
    should(processes.spawned.map(child => child.command.environment.TUNNEL_TOKEN)).deepEqual([
      TOKEN,
      'fake-connector-token-THREE',
    ]);
  });

  it('should cancel a pending restart when a new token arrives', async () => {
    // Arrange
    supervisor.run(TOKEN);
    processes.latest.exit(1);
    await settle();

    // Act
    supervisor.run(NEXT_TOKEN);

    // Assert — started now, on the new token, and the old restart is disarmed.
    should(processes.spawned.length).equal(2);
    should(scheduler.armed).deepEqual([]);
  });

  it('should stop for good, withdraw, and wait for the child', async () => {
    // Arrange
    supervisor.run(TOKEN);
    processes.latest.say(registered(0));

    // Act
    await supervisor.stop();
    supervisor.run(NEXT_TOKEN);

    // Assert
    should(processes.latest.terminated).be.true();
    should(processes.spawned.length).equal(1);
    should(registrations).deepEqual([true, false]);
    should(supervisor.registered).be.false();
  });

  it('should not restart a connector that exits after the stop, nor one whose timer fires late', async () => {
    // Arrange — a restart armed, then a stop.
    supervisor.run(TOKEN);
    processes.latest.exit(1);
    await settle();
    const late = scheduler.armed.length;

    // Act
    await supervisor.stop();
    scheduler.fire();

    // Assert
    should(late).equal(1);
    should(processes.spawned.length).equal(1);
    await supervisor.stop();
  });

  it('should not restart a child whose stop was asked while a new token waited for the old to die', async () => {
    // Arrange
    processes.stubborn = true;
    supervisor.run(TOKEN);
    const old = processes.latest;
    supervisor.run(NEXT_TOKEN);

    // Act
    const stopping = supervisor.stop();
    old.exit(null);
    await stopping;
    await settle();

    // Assert
    should(processes.spawned.length).equal(1);
  });

  it('should ignore an exit that lands after it was stopped', async () => {
    // Arrange — a stubborn child is asked to stop and only then exits.
    processes.stubborn = true;
    supervisor.run(TOKEN);
    const child = processes.latest;
    const stopping = supervisor.stop();

    // Act
    child.exit(0);
    await stopping;
    await settle();

    // Assert
    should(scheduler.armed).deepEqual([]);
    should(notices).deepEqual([]);
  });
});
