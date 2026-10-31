import { afterEach, describe, expect, test } from 'bun:test';
import { useWardenStatuses } from '../../src/hooks/use-warden-statuses.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { interact, type Mounted, mount } from '../support/dom.ts';
import { wardenStatus } from '../support/warden.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const ec2 = daemonConnection({ daemonId: 'daemon-ec2', baseUrl: 'https://ec2.example.test', deviceId: 'a' });
const mbp = daemonConnection({ daemonId: 'daemon-mbp', baseUrl: 'https://mbp.example.test', deviceId: 'b' });
const DAEMONS = [ec2, mbp];
const OPTIONS = { isHidden: () => false, pollMs: 15 } as const;

const wait = async (ms: number): Promise<void> => {
  await interact(async () => {
    await new Promise(resolve => setTimeout(resolve, ms));
  });
};

describe('useWardenStatuses', () => {
  test('keeps each daemon under its own id, marks a failed refresh stale and a first failure an error', async () => {
    const reads: Record<string, number> = {};
    const read = async (daemon: { readonly daemonId: string }) => {
      reads[daemon.daemonId] = (reads[daemon.daemonId] ?? 0) + 1;
      if (daemon.daemonId === 'daemon-mbp') throw new Error('mbp is asleep');
      if (reads[daemon.daemonId] === 1) return wardenStatus();
      throw 'ec2 dropped';
    };
    let latest: ReturnType<typeof useWardenStatuses> = new Map();
    const Probe = () => {
      latest = useWardenStatuses(DAEMONS, read as never, OPTIONS);
      return null;
    };
    view = await mount(<Probe />);
    await wait(80);
    expect(latest.get('daemon-ec2' as never)).toMatchObject({ status: 'stale', reason: 'ec2 dropped' });
    expect(latest.get('daemon-mbp' as never)).toEqual({ status: 'error', reason: 'mbp is asleep' });
  });

  test('discards an answer that arrives after the page went away, and skips a hidden tab', async () => {
    let release: (() => void) | undefined;
    let calls = 0;
    const read = async () => {
      calls += 1;
      await new Promise<void>(resolve => {
        release = resolve;
      });
      throw new Error('late');
    };
    let latest: ReturnType<typeof useWardenStatuses> = new Map();
    const Probe = () => {
      latest = useWardenStatuses([ec2], read as never, { ...OPTIONS, pollMs: 3_600_000 });
      return null;
    };
    view = await mount(<Probe />);
    await view.unmount();
    view = null;
    release?.();
    await wait(10);
    expect(latest.size).toBe(0);

    let hiddenCalls = 0;
    const Hidden = () => {
      useWardenStatuses(
        [ec2],
        (async () => {
          hiddenCalls += 1;
          return wardenStatus();
        }) as never,
        { isHidden: () => true, pollMs: 3_600_000 },
      );
      return null;
    };
    view = await mount(<Hidden />);
    await wait(10);
    expect(hiddenCalls).toBe(0);
    expect(calls).toBe(1);
  });

  test('discards a successful answer that arrives after the page went away', async () => {
    let release: (() => void) | undefined;
    const read = async () => {
      await new Promise<void>(resolve => {
        release = resolve;
      });
      return wardenStatus();
    };
    let latest: ReturnType<typeof useWardenStatuses> = new Map();
    const Probe = () => {
      latest = useWardenStatuses([ec2], read as never, { ...OPTIONS, pollMs: 3_600_000 });
      return null;
    };
    view = await mount(<Probe />);
    await view.unmount();
    view = null;
    release?.();
    await wait(10);
    expect(latest.size).toBe(0);
  });
});
