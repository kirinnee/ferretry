import { describe, expect, it } from 'bun:test';
import { nextStateOnFailure, readView, useWardenPoll, type WardenReadState } from '../../src/hooks/use-warden-poll.ts';
import { type DaemonConnection, daemonConnection } from '../../src/lib/daemon-connection.ts';
import { interact, mount } from '../support/dom.ts';

const alpha = daemonConnection({ daemonId: 'daemon-alpha', baseUrl: 'https://alpha.invalid', deviceId: 'alpha-token' });
const beta = daemonConnection({ daemonId: 'daemon-beta', baseUrl: 'https://beta.invalid', deviceId: 'beta-token' });

interface ProbeProps {
  readonly daemon: DaemonConnection;
  readonly read: (daemon: DaemonConnection) => Promise<string>;
  readonly hidden?: () => boolean;
  readonly pollMs?: number;
  readonly revision?: number;
}

const describeState = (state: WardenReadState<string>): string => {
  if (state.status === 'loading') return 'loading';
  if (state.status === 'error') return `error:${state.reason}`;
  if (state.status === 'stale') return `stale:${state.view}:${state.reason}`;
  return `ready:${state.view}`;
};

function Probe({ daemon, read, hidden, pollMs, revision }: ProbeProps) {
  const state = useWardenPoll(daemon, read, {
    ...(pollMs === undefined ? {} : { pollMs }),
    ...(hidden === undefined ? {} : { isHidden: hidden }),
    ...(revision === undefined ? {} : { revision }),
  });
  return <output>{describeState(state)}</output>;
}

const settle = async (): Promise<void> => {
  await interact(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('nextStateOnFailure and readView', () => {
  it('should keep a good answer as stale and turn anything else into an error', () => {
    // Arrange
    const ready: WardenReadState<string> = { status: 'ready', view: 'v' };
    const stale: WardenReadState<string> = { status: 'stale', view: 'v', reason: 'old' };

    // Act / Assert
    expect(nextStateOnFailure(ready, 'down')).toEqual({ status: 'stale', view: 'v', reason: 'down' });
    expect(nextStateOnFailure(stale, 'again')).toEqual({ status: 'stale', view: 'v', reason: 'again' });
    expect(nextStateOnFailure<string>({ status: 'loading' }, 'down')).toEqual({ status: 'error', reason: 'down' });
    expect(readView(ready)).toBe('v');
    expect(readView(stale)).toBe('v');
    expect(readView<string>({ status: 'error', reason: 'x' })).toBeUndefined();
  });
});

describe('useWardenPoll', () => {
  it('should read on mount and show the daemon’s answer', async () => {
    // Arrange / Act
    const view = await mount(<Probe daemon={alpha} read={async () => 'alpha-1'} />);
    await settle();

    // Assert
    expect(view.container.textContent).toBe('ready:alpha-1');
    await view.unmount();
  });

  it('should say a first failure out loud, with a non-Error reason too', async () => {
    // Arrange / Act
    const failing = await mount(
      <Probe
        daemon={alpha}
        read={async () => {
          throw new Error('404');
        }}
      />,
    );
    const odd = await mount(
      <Probe
        daemon={alpha}
        read={async () => {
          throw 'refused';
        }}
      />,
    );
    await settle();

    // Assert
    expect(failing.container.textContent).toBe('error:404');
    expect(odd.container.textContent).toBe('error:refused');
    await failing.unmount();
    await odd.unmount();
  });

  it('should keep the last answer as stale when a refresh fails, and read again on a revision bump', async () => {
    // Arrange
    let reads = 0;
    const read = async (): Promise<string> => {
      reads += 1;
      if (reads === 2) throw new Error('timed out');
      return `answer-${reads}`;
    };
    const view = await mount(<Probe daemon={alpha} read={read} revision={0} />);
    await settle();
    expect(view.container.textContent).toBe('ready:answer-1');

    // Act
    await view.render(<Probe daemon={alpha} read={read} revision={1} />);
    await settle();
    const afterFailure = view.container.textContent;
    await view.render(<Probe daemon={alpha} read={read} revision={2} />);
    await settle();

    // Assert
    expect(afterFailure).toBe('stale:answer-1:timed out');
    expect(view.container.textContent).toBe('ready:answer-3');
    await view.unmount();
  });

  it('should never show one daemon’s answer under another', async () => {
    // Arrange
    const read = async (daemon: DaemonConnection): Promise<string> =>
      daemon.daemonId === alpha.daemonId ? 'alpha' : await new Promise<string>(() => {});
    const view = await mount(<Probe daemon={alpha} read={read} />);
    await settle();

    // Act
    await view.render(<Probe daemon={beta} read={read} />);
    await settle();

    // Assert
    expect(view.container.textContent).toBe('loading');
    await view.unmount();
  });

  it('should start a failure on a new daemon from scratch, not from the old daemon’s answer', async () => {
    // Arrange
    const read = async (daemon: DaemonConnection): Promise<string> => {
      if (daemon.daemonId === alpha.daemonId) return 'alpha';
      throw new Error('beta down');
    };
    const view = await mount(<Probe daemon={alpha} read={read} />);
    await settle();

    // Act
    await view.render(<Probe daemon={beta} read={read} />);
    await settle();

    // Assert
    expect(view.container.textContent).toBe('error:beta down');
    await view.unmount();
  });

  it('should discard an answer or a failure that arrives after a switch', async () => {
    // Arrange
    let resolveAlpha: ((value: string) => void) | undefined;
    let rejectAlpha: ((cause: Error) => void) | undefined;
    let alphaReads = 0;
    const read = async (daemon: DaemonConnection): Promise<string> => {
      if (daemon.daemonId === beta.daemonId) return 'beta';
      alphaReads += 1;
      return await new Promise<string>((resolve, reject) => {
        if (alphaReads === 1) resolveAlpha = resolve;
        else rejectAlpha = reject;
      });
    };
    const first = await mount(<Probe daemon={alpha} read={read} />);
    await first.render(<Probe daemon={beta} read={read} />);
    await settle();
    const second = await mount(<Probe daemon={alpha} read={read} />);
    await second.unmount();

    // Act
    resolveAlpha?.('alpha-late');
    rejectAlpha?.(new Error('late failure'));
    await settle();

    // Assert
    expect(first.container.textContent).toBe('ready:beta');
    await first.unmount();
  });

  it('should skip the read while the tab is hidden', async () => {
    // Arrange
    let reads = 0;

    // Act
    const view = await mount(
      <Probe
        daemon={alpha}
        hidden={() => true}
        read={async () => {
          reads += 1;
          return 'x';
        }}
      />,
    );
    await settle();

    // Assert
    expect(reads).toBe(0);
    expect(view.container.textContent).toBe('loading');
    await view.unmount();
  });

  it('should keep polling on its cadence and stop on unmount', async () => {
    // Arrange
    let reads = 0;
    const view = await mount(
      <Probe
        daemon={alpha}
        pollMs={5}
        read={async () => {
          reads += 1;
          return `fp-${reads}`;
        }}
      />,
    );
    await settle();

    // Act
    await interact(async () => {
      await new Promise(resolve => setTimeout(resolve, 24));
    });
    const polled = reads;
    await view.unmount();
    await interact(async () => {
      await new Promise(resolve => setTimeout(resolve, 24));
    });

    // Assert
    expect(polled).toBeGreaterThan(1);
    expect(reads).toBe(polled);
  });
});
