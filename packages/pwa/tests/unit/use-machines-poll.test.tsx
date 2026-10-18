import { afterEach, describe, expect, test } from 'bun:test';
import {
  BACKGROUND_POLL_MS,
  backgroundPollMs,
  browserFleetPollEnvironment,
  FLEET_POLL_MS,
  type FleetPollEnvironment,
  PHONE_BACKGROUND_POLL_MS,
  useMachinesPoll,
} from '../../src/hooks/use-machines-poll.ts';
import { type DaemonConnection, type DaemonId, daemonConnection } from '../../src/lib/daemon-connection.ts';
import '../support/dom.ts';
import { interact, type Mounted, mount } from '../support/dom.ts';

const alpha = daemonConnection({ daemonId: 'alpha', baseUrl: 'https://alpha.example.test', deviceId: 'alpha-device' });
const beta = daemonConnection({ daemonId: 'beta', baseUrl: 'https://beta.example.test', deviceId: 'beta-device' });

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

function Poller({
  fleet,
  machines,
  current,
  phone = false,
  environment,
}: {
  readonly fleet: { hydrate: (daemon: DaemonConnection) => Promise<readonly never[]> };
  readonly machines: readonly DaemonConnection[];
  readonly current: DaemonId | null;
  readonly phone?: boolean;
  readonly environment?: FleetPollEnvironment;
}) {
  useMachinesPoll(fleet as never, machines, current, phone, environment);
  return null;
}

const fakeEnvironment = () => {
  let visible = true;
  const ticks = new Map<number, () => void>();
  let onShow: (() => void) | undefined;
  const log: string[] = [];
  const environment: FleetPollEnvironment = {
    visible: () => visible,
    setInterval: (callback, milliseconds) => {
      log.push(`interval:${milliseconds}`);
      ticks.set(milliseconds, callback);
      return milliseconds;
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
    tick: (milliseconds: number) => ticks.get(milliseconds)?.(),
    show: () => {
      visible = true;
      onShow?.();
    },
    hide: () => {
      visible = false;
    },
  };
};

const recorder = () => {
  const reads: DaemonConnection[] = [];
  return { reads, fleet: { hydrate: async (daemon: DaemonConnection) => (reads.push(daemon), []) } };
};

describe('useMachinesPoll', () => {
  test('reads every machine on mount, the one on screen on the quick beat and the others on the slow one', async () => {
    const { reads, fleet } = recorder();
    const fake = fakeEnvironment();
    view = await mount(
      <Poller current={alpha.daemonId} environment={fake.environment} fleet={fleet} machines={[alpha, beta]} />,
    );
    expect(reads.map(read => String(read.daemonId))).toEqual(['alpha', 'beta']);
    expect(fake.log).toEqual([`interval:${FLEET_POLL_MS}`, `interval:${BACKGROUND_POLL_MS}`]);
    fake.tick(FLEET_POLL_MS);
    expect(String(reads.at(-1)?.daemonId)).toBe('alpha');
    fake.tick(BACKGROUND_POLL_MS);
    expect(String(reads.at(-1)?.daemonId)).toBe('beta');
    expect(reads).toHaveLength(4);

    // Hidden, nothing is read; back in sight, every machine at once.
    fake.hide();
    fake.tick(FLEET_POLL_MS);
    fake.tick(BACKGROUND_POLL_MS);
    expect(reads).toHaveLength(4);
    fake.show();
    expect(reads.slice(4).map(read => String(read.daemonId))).toEqual(['alpha', 'beta']);

    await view.unmount();
    view = null;
    expect(fake.log.slice(2)).toEqual([`clear:${FLEET_POLL_MS}`, `clear:${BACKGROUND_POLL_MS}`, 'released']);
  });

  test('a phone polls the machines not on screen at the slower beat', async () => {
    const { fleet } = recorder();
    const fake = fakeEnvironment();
    view = await mount(
      <Poller current={alpha.daemonId} environment={fake.environment} fleet={fleet} machines={[alpha]} phone />,
    );
    expect(fake.log).toEqual([`interval:${FLEET_POLL_MS}`, `interval:${PHONE_BACKGROUND_POLL_MS}`]);
    expect(backgroundPollMs(true)).toBe(PHONE_BACKGROUND_POLL_MS);
    expect(backgroundPollMs(false)).toBe(BACKGROUND_POLL_MS);
  });

  test('with no machine on screen every machine is a background one', async () => {
    const { reads, fleet } = recorder();
    const fake = fakeEnvironment();
    view = await mount(<Poller current={null} environment={fake.environment} fleet={fleet} machines={[alpha]} />);
    fake.tick(FLEET_POLL_MS);
    expect(reads).toHaveLength(1);
    fake.tick(BACKGROUND_POLL_MS);
    expect(reads).toHaveLength(2);
  });

  test('a new connection object for the same pairing does not restart the poll, but is the one read', async () => {
    const { reads, fleet } = recorder();
    const fake = fakeEnvironment();
    view = await mount(
      <Poller current={alpha.daemonId} environment={fake.environment} fleet={fleet} machines={[alpha]} />,
    );
    const replaced = daemonConnection({
      daemonId: 'alpha',
      baseUrl: 'https://alpha.example.test',
      deviceId: 'alpha-device',
    });
    await view.render(
      <Poller current={alpha.daemonId} environment={fake.environment} fleet={fleet} machines={[replaced]} />,
    );
    expect(reads).toHaveLength(1);
    fake.tick(FLEET_POLL_MS);
    expect(reads.at(-1)).toBe(replaced);
  });

  test('a failed read is swallowed: the slice already says so', async () => {
    const fake = fakeEnvironment();
    const fleet = { hydrate: async () => await Promise.reject(new Error('offline')) };
    view = await mount(
      <Poller current={alpha.daemonId} environment={fake.environment} fleet={fleet} machines={[alpha]} />,
    );
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
