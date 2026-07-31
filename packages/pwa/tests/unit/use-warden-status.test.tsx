import { describe, expect, it } from 'bun:test';
import type { WardenStatusView } from '@ferretry/protocol';
import { useWardenStatus } from '../../src/hooks/use-warden-status.ts';
import { type DaemonConnection, daemonConnection } from '../../src/lib/daemon-connection.ts';
import { interact, mount } from '../support/dom.ts';
import { wardenStatus } from '../support/warden.ts';

const alpha = daemonConnection({
  daemonId: 'daemon-alpha',
  baseUrl: 'https://alpha.invalid',
  deviceToken: 'alpha-token',
});
const beta = daemonConnection({ daemonId: 'daemon-beta', baseUrl: 'https://beta.invalid', deviceToken: 'beta-token' });

interface Probe {
  readonly daemon: DaemonConnection;
  readonly read: (daemon: DaemonConnection) => Promise<WardenStatusView>;
  readonly hidden?: () => boolean;
  readonly pollMs?: number;
}

function Probe({ daemon, read, hidden, pollMs }: Probe) {
  const status = useWardenStatus(daemon, read, {
    ...(pollMs === undefined ? {} : { pollMs }),
    ...(hidden === undefined ? {} : { isHidden: hidden }),
  });
  return <output>{status === null ? 'unknown' : status.fingerprint}</output>;
}

const settle = async (): Promise<void> => {
  await interact(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('useWardenStatus', () => {
  it('reads once on mount and reports the daemon’s own fingerprint', async () => {
    const { container } = await mount(
      <Probe daemon={alpha} read={async () => wardenStatus({ fingerprint: 'alpha-1' })} />,
    );
    await settle();

    expect(container.textContent).toBe('alpha-1');
  });

  it('stays unknown when the daemon is too old to serve the route', async () => {
    const { container } = await mount(
      <Probe
        daemon={alpha}
        read={async () => {
          throw new Error('404');
        }}
      />,
    );
    await settle();

    expect(container.textContent).toBe('unknown');
  });

  it('never shows one daemon’s sweep under another daemon', async () => {
    // Beta never answers, so the only status this hook holds is alpha's. The
    // regression the multi-daemon rule exists for is showing THAT under beta.
    const read = async (daemon: DaemonConnection): Promise<WardenStatusView> =>
      daemon.daemonId === alpha.daemonId
        ? wardenStatus({ fingerprint: 'daemon-alpha-fp' })
        : new Promise<WardenStatusView>(() => {});
    const view = await mount(<Probe daemon={alpha} read={read} />);
    await settle();
    expect(view.container.textContent).toBe('daemon-alpha-fp');

    await view.render(<Probe daemon={beta} read={read} />);
    await settle();

    expect(view.container.textContent).toBe('unknown');
  });

  it('discards a response that arrives after the reader switched daemon', async () => {
    let release: ((status: WardenStatusView) => void) | undefined;
    const read = async (daemon: DaemonConnection): Promise<WardenStatusView> => {
      if (daemon.daemonId === alpha.daemonId) {
        return new Promise<WardenStatusView>(resolve => {
          release = resolve;
        });
      }
      return wardenStatus({ fingerprint: 'beta-fp' });
    };
    const view = await mount(<Probe daemon={alpha} read={read} />);
    await view.render(<Probe daemon={beta} read={read} />);
    await settle();

    release?.(wardenStatus({ fingerprint: 'alpha-late' }));
    await settle();

    expect(view.container.textContent).toBe('beta-fp');
  });

  it('skips the read entirely while the tab is hidden', async () => {
    let reads = 0;
    await mount(
      <Probe
        daemon={alpha}
        hidden={() => true}
        read={async () => {
          reads += 1;
          return wardenStatus();
        }}
      />,
    );
    await settle();

    expect(reads).toBe(0);
  });

  it('keeps polling on its cadence and stops on unmount', async () => {
    let reads = 0;
    const view = await mount(
      <Probe
        daemon={alpha}
        pollMs={5}
        read={async () => {
          reads += 1;
          return wardenStatus({ fingerprint: `fp-${reads}` });
        }}
      />,
    );
    await settle();
    expect(reads).toBe(1);

    await interact(async () => {
      await new Promise(resolve => setTimeout(resolve, 24));
    });
    const polled = reads;
    expect(polled).toBeGreaterThan(1);

    await view.unmount();
    await interact(async () => {
      await new Promise(resolve => setTimeout(resolve, 24));
    });

    expect(reads).toBe(polled);
  });
});
