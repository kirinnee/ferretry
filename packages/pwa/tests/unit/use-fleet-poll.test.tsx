import { afterEach, describe, expect, test } from 'bun:test';
import {
  browserFleetPollEnvironment,
  FLEET_POLL_MS,
  type FleetPollEnvironment,
  useFleetPoll,
} from '../../src/hooks/use-fleet-poll.ts';
import { type DaemonConnection, daemonConnection } from '../../src/lib/daemon-connection.ts';
import '../support/dom.ts';
import { interact, type Mounted, mount } from '../support/dom.ts';

const alpha = daemonConnection({ daemonId: 'alpha', baseUrl: 'https://alpha.example.test', deviceId: 'alpha-device' });

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

function Poller({
  fleet,
  connection,
  environment,
}: {
  readonly fleet: { hydrate: (daemon: DaemonConnection) => Promise<readonly never[]> };
  readonly connection: DaemonConnection;
  readonly environment?: FleetPollEnvironment;
}) {
  useFleetPoll(fleet as never, connection, environment);
  return null;
}

const fakeEnvironment = () => {
  let visible = true;
  let tick: (() => void) | undefined;
  let onShow: (() => void) | undefined;
  const log: string[] = [];
  const environment: FleetPollEnvironment = {
    visible: () => visible,
    setInterval: (callback, milliseconds) => {
      log.push(`interval:${milliseconds}`);
      tick = callback;
      return 7;
    },
    clearInterval: handle => log.push(`clear:${String(handle)}`),
    onVisibility: callback => {
      onShow = callback;
      return () => log.push('released');
    },
  };
  return {
    environment,
    log,
    tick: () => tick?.(),
    show: () => {
      visible = true;
      onShow?.();
    },
    hide: () => {
      visible = false;
    },
  };
};

describe('useFleetPoll', () => {
  test('reads on mount, on every tick while visible, and at once on becoming visible', async () => {
    const reads: DaemonConnection[] = [];
    const fleet = { hydrate: async (daemon: DaemonConnection) => (reads.push(daemon), []) };
    const fake = fakeEnvironment();
    view = await mount(<Poller connection={alpha} environment={fake.environment} fleet={fleet} />);
    expect(reads).toHaveLength(1);
    expect(fake.log).toEqual([`interval:${FLEET_POLL_MS}`]);

    fake.tick();
    expect(reads).toHaveLength(2);
    fake.hide();
    fake.tick();
    expect(reads).toHaveLength(2);
    fake.show();
    expect(reads).toHaveLength(3);

    await view.unmount();
    view = null;
    expect(fake.log).toEqual([`interval:${FLEET_POLL_MS}`, 'clear:7', 'released']);
  });

  test('a new connection object for the same pairing does not restart the poll, but is the one read', async () => {
    const reads: DaemonConnection[] = [];
    const fleet = { hydrate: async (daemon: DaemonConnection) => (reads.push(daemon), []) };
    const fake = fakeEnvironment();
    view = await mount(<Poller connection={alpha} environment={fake.environment} fleet={fleet} />);
    const replaced = daemonConnection({
      daemonId: 'alpha',
      baseUrl: 'https://alpha.example.test',
      deviceId: 'alpha-device',
    });
    await view.render(<Poller connection={replaced} environment={fake.environment} fleet={fleet} />);
    expect(reads).toHaveLength(1);
    fake.tick();
    expect(reads.at(-1)).toBe(replaced);
  });

  test('a failed read is swallowed: the slice already says so', async () => {
    const fake = fakeEnvironment();
    const fleet = { hydrate: async () => await Promise.reject(new Error('offline')) };
    view = await mount(<Poller connection={alpha} environment={fake.environment} fleet={fleet} />);
    await interact(async () => await Promise.resolve());
  });

  test('the browser environment reads the document and the real timers', () => {
    expect(browserFleetPollEnvironment.visible()).toBe(document.visibilityState !== 'hidden');
    let fired = 0;
    const handle = browserFleetPollEnvironment.setInterval(() => (fired += 1), 60_000);
    browserFleetPollEnvironment.clearInterval(handle);
    let seen = 0;
    const release = browserFleetPollEnvironment.onVisibility(() => (seen += 1));
    document.dispatchEvent(new Event('visibilitychange'));
    release();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(seen).toBe(1);
    expect(fired).toBe(0);
  });
});
