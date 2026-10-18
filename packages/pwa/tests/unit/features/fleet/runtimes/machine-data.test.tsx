import { describe, expect, it } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import type { FleetClient } from '../../../../../src/features/fleet/fleet-client.ts';
import {
  type MachineData,
  machineDetailFromHash,
  machineDetailHash,
  readMachineData,
  type UseMachineData,
  useMachineData,
  useMachineDetail,
} from '../../../../../src/features/fleet/runtimes/machine-data.ts';
import { type DaemonConnection, daemonConnection } from '../../../../../src/lib/daemon-connection.ts';
import { interact, mount, must } from '../../../../support/dom.ts';
import { CREDENTIALS, DATA, READS, STUDIO, scripted } from '../account-support.ts';
import { configChangeHarness } from '../../../config-change-support.tsx';

const OTHER = daemonConnection({ daemonId: 'other', baseUrl: 'https://other.example.test', deviceId: 'u' });

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  });
};

const OLD: MachineData = { ...DATA, credentials: { ...CREDENTIALS, machine: 'old-mac' } };

const FAILING = (error: Error) => ({ ...READS(), 'GET /v1/fleet/runtimes': error });

/** A client that holds every request until released, then answers from `routes`. */
const gated = (routes: Record<string, unknown>) => {
  let release: () => void = () => undefined;
  const open = new Promise<void>(resolve => {
    release = resolve;
  });
  const inner = scripted(routes);
  const client: FleetClient = {
    request: async (path, schema, init) => {
      await open;
      return await inner.request(path, schema, init);
    },
  };
  return { client, release };
};

describe('readMachineData', () => {
  it('reads the four answers together', async () => {
    const data = await readMachineData(async () => scripted(READS()), STUDIO);
    expect(data.credentials.machine).toBe('studio-mac');
    expect(data.runtimes.runtimes.map(entry => entry.name)).toContain('claude-default');
    expect(data.profiles.profiles.map(entry => entry.name)).toContain('Default');
    expect(data.components?.kinds.map(entry => entry.kind)).toContain('instructions');
  });

  it('hands the connection to the client factory', async () => {
    const seen: DaemonConnection[] = [];
    await readMachineData(async connection => {
      seen.push(connection);
      return scripted(READS());
    }, OTHER);
    expect(seen).toEqual([OTHER]);
  });

  it('throws what the failing read threw', async () => {
    const boom = new FyHttpError('The machine said no.', 500, undefined);
    await expect(readMachineData(async () => scripted(FAILING(boom)), STUDIO)).rejects.toBe(boom);
  });

  it('keeps the other three answers when only the parts catalog fails, with no parts', async () => {
    const data = await readMachineData(
      async () => scripted({ ...READS(), 'GET /v1/fleet/components': new FyHttpError('No parts.', 500, undefined) }),
      STUDIO,
    );
    expect(data.components).toBeNull();
    expect(data.credentials.machine).toBe('studio-mac');
    expect(data.runtimes.runtimes.length).toBeGreaterThan(0);
    expect(data.profiles.profiles.length).toBeGreaterThan(0);
  });

  it('keeps the parts catalog when it answers', async () => {
    const data = await readMachineData(async () => scripted(READS()), STUDIO);
    expect(data.components).toEqual(DATA.components);
  });

  it('still fails when a read other than the parts catalog fails', async () => {
    const boom = new FyHttpError('Profiles gone.', 500, undefined);
    await expect(
      readMachineData(
        async () =>
          scripted({ ...READS(), 'GET /v1/fleet/profiles': boom, 'GET /v1/fleet/components': new Error('x') }),
        STUDIO,
      ),
    ).rejects.toBe(boom);
  });

  it('throws when the client cannot be made', async () => {
    await expect(
      readMachineData(async () => {
        throw new Error('offline');
      }, STUDIO),
    ).rejects.toThrow('offline');
  });
});

interface Probe {
  current: UseMachineData | null;
}

function DataHost({
  connection,
  factory,
  probe,
}: {
  readonly connection: DaemonConnection;
  readonly factory: (connection: DaemonConnection) => Promise<FleetClient>;
  readonly probe: Probe;
}) {
  const result = useMachineData(connection, factory);
  probe.current = result;
  return (
    <p data-state={result.state.kind} data-machine={result.data?.credentials.machine ?? ''}>
      {result.state.kind === 'failed' ? result.state.sentence : ''}
    </p>
  );
}

const dataView = async (factory: (connection: DaemonConnection) => Promise<FleetClient>) => {
  const probe: Probe = { current: null };
  const view = await mount(<DataHost connection={STUDIO} factory={factory} probe={probe} />);
  await settle();
  const hooks = () => must(probe.current, 'hook');
  const attr = (name: string) => view.container.querySelector('p')?.getAttribute(name);
  return { view, probe, hooks, attr };
};

describe('useMachineData', () => {
  it('starts loading, then holds the answer', async () => {
    const probe: Probe = { current: null };
    const gate = gated(READS());
    const view = await mount(<DataHost connection={STUDIO} factory={async () => gate.client} probe={probe} />);
    expect(view.container.querySelector('p')?.getAttribute('data-state')).toBe('loading');
    expect(must(probe.current, 'hook').data).toBeNull();
    gate.release();
    await settle();
    expect(view.container.querySelector('p')?.getAttribute('data-state')).toBe('ready');
    expect(must(probe.current, 'hook').data?.credentials.machine).toBe('studio-mac');
    await view.unmount();
  });

  it('reloads on request and resolves with the new answer', async () => {
    let reads = 0;
    const host = await dataView(async () => {
      reads += 1;
      return scripted(reads === 1 ? READS(OLD) : READS());
    });
    expect(host.attr('data-machine')).toBe('old-mac');
    let result: MachineData | null = null;
    await interact(async () => {
      result = await host.hooks().reload();
    });
    expect((result as MachineData | null)?.credentials.machine).toBe('studio-mac');
    expect(host.attr('data-machine')).toBe('studio-mac');
    expect(reads).toBe(2);
    await host.view.unmount();
  });

  it('keeps the last answer beside the sentence when a later read fails', async () => {
    let reads = 0;
    const host = await dataView(async () => {
      reads += 1;
      if (reads === 1) return scripted(READS());
      return scripted(FAILING(new FyHttpError('The machine said no.', 500, undefined)));
    });
    expect(host.attr('data-state')).toBe('ready');
    let result: MachineData | null | undefined;
    await interact(async () => {
      result = await host.hooks().reload();
    });
    expect(result).toBeNull();
    expect(host.attr('data-state')).toBe('failed');
    expect(host.view.container.querySelector('p')?.textContent).toBe('The machine said no.');
    expect(host.attr('data-machine')).toBe('studio-mac');
    const state = host.hooks().state;
    expect(state.kind === 'failed' ? state.last?.credentials.machine : undefined).toBe('studio-mac');
    await host.view.unmount();
  });

  it('has nothing to keep when the first read fails, and says the machine did not answer', async () => {
    const host = await dataView(async () => {
      throw new Error('offline');
    });
    expect(host.attr('data-state')).toBe('failed');
    expect(host.view.container.querySelector('p')?.textContent).toBe(
      'This machine didn’t answer (offline). Check it is awake and try again.',
    );
    expect(host.hooks().data).toBeNull();
    const state = host.hooks().state;
    expect(state.kind === 'failed' ? state.last : 'ready').toBeNull();
    await host.view.unmount();
  });

  it('hands a stale successful read back to its caller without showing it', async () => {
    const slow = gated(READS(OLD));
    let reads = 0;
    const host = await dataView(async () => {
      reads += 1;
      return reads === 2 ? slow.client : scripted(READS());
    });
    expect(host.attr('data-machine')).toBe('studio-mac');
    let stale: Promise<MachineData | null> | undefined;
    await interact(() => {
      stale = host.hooks().reload();
    });
    await interact(async () => {
      await host.hooks().reload();
    });
    slow.release();
    let result: MachineData | null | undefined;
    await interact(async () => {
      result = await stale;
    });
    expect(result?.credentials.machine).toBe('old-mac');
    expect(host.attr('data-machine')).toBe('studio-mac');
    expect(host.attr('data-state')).toBe('ready');
    await host.view.unmount();
  });

  it('does not let a stale failure replace a newer answer', async () => {
    const slow = gated(FAILING(new FyHttpError('Too late.', 500, undefined)));
    let reads = 0;
    const host = await dataView(async () => {
      reads += 1;
      return reads === 2 ? slow.client : scripted(READS());
    });
    let stale: Promise<MachineData | null> | undefined;
    await interact(() => {
      stale = host.hooks().reload();
    });
    await interact(async () => {
      await host.hooks().reload();
    });
    slow.release();
    let result: MachineData | null | undefined;
    await interact(async () => {
      result = await stale;
    });
    expect(result).toBeNull();
    expect(host.attr('data-state')).toBe('ready');
    expect(host.view.container.querySelector('p')?.textContent).toBe('');
    await host.view.unmount();
  });

  it('forgets the last answer and reads again when the machine changes', async () => {
    const probe: Probe = { current: null };
    const connections: DaemonConnection[] = [];
    const factory = async (connection: DaemonConnection): Promise<FleetClient> => {
      connections.push(connection);
      if (connection === STUDIO) return scripted(READS());
      return scripted(FAILING(new FyHttpError('Other is asleep.', 503, undefined)));
    };
    const view = await mount(<DataHost connection={STUDIO} factory={factory} probe={probe} />);
    await settle();
    expect(view.container.querySelector('p')?.getAttribute('data-machine')).toBe('studio-mac');
    await view.render(<DataHost connection={OTHER} factory={factory} probe={probe} />);
    await settle();
    expect(connections).toEqual([STUDIO, OTHER]);
    expect(view.container.querySelector('p')?.getAttribute('data-state')).toBe('failed');
    expect(view.container.querySelector('p')?.textContent).toBe('Other is asleep.');
    expect(view.container.querySelector('p')?.getAttribute('data-machine')).toBe('');
    await view.unmount();
  });
});

function RuntimeNamesHost({
  factory,
  probe,
}: {
  readonly factory: (connection: DaemonConnection) => Promise<FleetClient>;
  readonly probe: Probe;
}) {
  const result = useMachineData(STUDIO, factory);
  probe.current = result;
  return (
    <ul data-state={result.state.kind}>
      {result.data?.runtimes.runtimes.map(entry => (
        <li key={entry.name}>{entry.name}</li>
      ))}
    </ul>
  );
}

describe('useMachineData when the machine says its configuration moved', () => {
  const FEWER: MachineData = { ...DATA, runtimes: { ...DATA.runtimes, runtimes: DATA.runtimes.runtimes.slice(0, 1) } };
  const names = (container: HTMLElement): string[] =>
    [...container.querySelectorAll('li')].map(item => item.textContent ?? '');

  const mountLive = async (script: (read: number) => FleetClient) => {
    const harness = configChangeHarness(STUDIO.daemonId);
    const probe: Probe = { current: null };
    let reads = 0;
    const factory = async (): Promise<FleetClient> => {
      reads += 1;
      return script(reads);
    };
    const view = await mount(harness.wrap(<RuntimeNamesHost factory={factory} probe={probe} />));
    await settle();
    return { harness, view, reads: () => reads };
  };

  it('shows a runtime another device added, without a reload', async () => {
    const live = await mountLive(read => scripted(read === 1 ? READS(FEWER) : READS()));
    expect(names(live.view.container)).toEqual(['claude-default']);
    expect(live.reads()).toBe(1);

    await live.harness.move(['runtimes']);
    await settle();

    expect(live.reads()).toBe(2);
    expect(names(live.view.container)).toEqual(DATA.runtimes.runtimes.map(entry => entry.name));
    await live.view.unmount();
  });

  it('reads again for a change to each of the four things it shows', async () => {
    const live = await mountLive(() => scripted(READS()));
    for (const [index, kind] of (['credentials', 'runtimes', 'profiles', 'components'] as const).entries()) {
      await live.harness.move([kind]);
      await settle();
      expect(live.reads()).toBe(index + 2);
    }
    await live.view.unmount();
  });

  it('leaves the screen alone when something it does not show moved', async () => {
    const live = await mountLive(read => scripted(read === 1 ? READS(FEWER) : READS()));
    await live.harness.move(['warden']);
    await settle();
    expect(live.reads()).toBe(1);
    expect(names(live.view.container)).toEqual(['claude-default']);
    await live.view.unmount();
  });

  it('keeps what it showed, beside the sentence, when the read after the change fails', async () => {
    const live = await mountLive(read =>
      scripted(read === 1 ? READS(FEWER) : FAILING(new FyHttpError('The machine said no.', 500, undefined))),
    );
    await live.harness.move(['runtimes']);
    await settle();
    expect(live.reads()).toBe(2);
    expect(live.view.container.querySelector('ul')?.getAttribute('data-state')).toBe('failed');
    expect(names(live.view.container)).toEqual(['claude-default']);
    await live.view.unmount();
  });
});

describe('machineDetailFromHash', () => {
  it('reads the page segment of a link to this tab', () => {
    expect(machineDetailFromHash('#machines/studio-mac/runtimes/claude-default', 'runtimes')).toBe('claude-default');
    expect(machineDetailFromHash('machines/studio-mac/credentials/claude-work', 'credentials')).toBe('claude-work');
  });

  it('decodes a percent-encoded page', () => {
    expect(machineDetailFromHash('#machines/studio-mac/runtimes/a%20b%2Fc', 'runtimes')).toBe('a b/c');
  });

  it('is null for another section, another tab or no page', () => {
    expect(machineDetailFromHash('#settings/studio-mac/runtimes/claude-default', 'runtimes')).toBeNull();
    expect(machineDetailFromHash('#machines/studio-mac/credentials/claude-work', 'runtimes')).toBeNull();
    expect(machineDetailFromHash('#machines/studio-mac/runtimes', 'runtimes')).toBeNull();
    expect(machineDetailFromHash('#machines/studio-mac/runtimes/', 'runtimes')).toBeNull();
    expect(machineDetailFromHash('', 'runtimes')).toBeNull();
  });

  it('is null rather than a crash for bad percent-encoding', () => {
    expect(machineDetailFromHash('#machines/studio-mac/runtimes/%E0%A4%A', 'runtimes')).toBeNull();
    expect(machineDetailFromHash('#machines/studio-mac/runtimes/100%', 'runtimes')).toBeNull();
  });
});

describe('machineDetailHash', () => {
  it('links to the tab, or to one page in it', () => {
    expect(machineDetailHash('studio-mac', 'runtimes')).toBe('#machines/studio-mac/runtimes');
    expect(machineDetailHash('studio-mac', 'credentials', 'claude-work')).toBe(
      '#machines/studio-mac/credentials/claude-work',
    );
  });

  it('encodes the machine and the page', () => {
    expect(machineDetailHash('my mac', 'runtimes', 'a b/c')).toBe('#machines/my%20mac/runtimes/a%20b%2Fc');
  });

  it('round-trips through machineDetailFromHash', () => {
    expect(machineDetailFromHash(machineDetailHash('studio-mac', 'runtimes', 'a b/c'), 'runtimes')).toBe('a b/c');
  });
});

type DetailHooks = readonly [string | null, (item: string | null) => void];

interface DetailProbe {
  current: DetailHooks | null;
}

function DetailHost({
  machine,
  tab,
  probe,
  browser,
}: {
  readonly machine: string;
  readonly tab: 'runtimes' | 'credentials';
  readonly probe: DetailProbe;
  readonly browser?: Window;
}) {
  const hooks = useMachineDetail(machine, tab, browser);
  probe.current = hooks;
  return <p data-detail={hooks[0] ?? ''}>{hooks[0] ?? 'none'}</p>;
}

interface FakeBrowser {
  readonly browser: Window;
  readonly location: { hash: string };
  readonly listeners: Map<string, Set<() => void>>;
  readonly fire: (type: string) => void;
}

const fakeBrowser = (hash: string): FakeBrowser => {
  const location = { hash };
  const listeners = new Map<string, Set<() => void>>();
  const fake = {
    location,
    addEventListener: (type: string, listener: () => void) => {
      listeners.set(type, (listeners.get(type) ?? new Set()).add(listener));
    },
    removeEventListener: (type: string, listener: () => void) => {
      listeners.get(type)?.delete(listener);
    },
  };
  return {
    browser: fake as unknown as Window,
    location,
    listeners,
    fire: type => {
      for (const listener of listeners.get(type) ?? []) listener();
    },
  };
};

const detailOf = (container: HTMLElement): string | null | undefined =>
  container.querySelector('p')?.getAttribute('data-detail');

describe('useMachineDetail', () => {
  it('opens on the page the link names, from a browser it is handed', async () => {
    const fake = fakeBrowser('#machines/studio-mac/runtimes/claude-default');
    const probe: DetailProbe = { current: null };
    const view = await mount(<DetailHost machine="studio-mac" tab="runtimes" probe={probe} browser={fake.browser} />);
    expect(detailOf(view.container)).toBe('claude-default');
    expect(fake.listeners.get('hashchange')?.size).toBe(1);
    await view.unmount();
    expect(fake.listeners.get('hashchange')?.size).toBe(0);
  });

  it('opens a page by writing the link, and closes it back to the tab', async () => {
    const fake = fakeBrowser('#machines/studio-mac/runtimes');
    const probe: DetailProbe = { current: null };
    const view = await mount(<DetailHost machine="studio-mac" tab="runtimes" probe={probe} browser={fake.browser} />);
    expect(detailOf(view.container)).toBe('');
    expect(view.container.querySelector('p')?.textContent).toBe('none');

    await interact(() => must(probe.current, 'hook')[1]('claude-work'));
    expect(fake.location.hash).toBe('#machines/studio-mac/runtimes/claude-work');
    expect(detailOf(view.container)).toBe('claude-work');

    await interact(() => must(probe.current, 'hook')[1](null));
    expect(fake.location.hash).toBe('#machines/studio-mac/runtimes');
    expect(detailOf(view.container)).toBe('');
    await view.unmount();
  });

  it('follows Back and Forward through hashchange', async () => {
    const fake = fakeBrowser('#machines/studio-mac/runtimes/claude-default');
    const probe: DetailProbe = { current: null };
    const view = await mount(<DetailHost machine="studio-mac" tab="runtimes" probe={probe} browser={fake.browser} />);
    fake.location.hash = '#machines/studio-mac/runtimes/claude-review';
    await interact(() => fake.fire('hashchange'));
    expect(detailOf(view.container)).toBe('claude-review');
    fake.location.hash = '#machines/studio-mac/credentials/claude-work';
    await interact(() => fake.fire('hashchange'));
    expect(detailOf(view.container)).toBe('');
    await view.unmount();
  });

  it('reads again for a different tab or browser', async () => {
    const fake = fakeBrowser('#machines/studio-mac/credentials/claude-work');
    const probe: DetailProbe = { current: null };
    const view = await mount(<DetailHost machine="studio-mac" tab="runtimes" probe={probe} browser={fake.browser} />);
    expect(detailOf(view.container)).toBe('');
    await view.render(<DetailHost machine="studio-mac" tab="credentials" probe={probe} browser={fake.browser} />);
    expect(detailOf(view.container)).toBe('claude-work');
    const other = fakeBrowser('#machines/studio-mac/credentials/codex');
    await view.render(<DetailHost machine="studio-mac" tab="credentials" probe={probe} browser={other.browser} />);
    expect(detailOf(view.container)).toBe('codex');
    expect(fake.listeners.get('hashchange')?.size).toBe(0);
    expect(other.listeners.get('hashchange')?.size).toBe(1);
    await view.unmount();
  });

  it('uses the real window when none is handed, hashchange included', async () => {
    window.location.hash = '#machines/studio-mac/runtimes/claude-agent';
    const probe: DetailProbe = { current: null };
    const view = await mount(<DetailHost machine="studio-mac" tab="runtimes" probe={probe} />);
    expect(detailOf(view.container)).toBe('claude-agent');

    window.location.hash = '#machines/studio-mac/runtimes/claude-review';
    await interact(() => window.dispatchEvent(new Event('hashchange')));
    expect(detailOf(view.container)).toBe('claude-review');

    await interact(() => must(probe.current, 'hook')[1]('claude-work'));
    expect(window.location.hash).toBe('#machines/studio-mac/runtimes/claude-work');
    expect(detailOf(view.container)).toBe('claude-work');
    await view.unmount();
    window.location.hash = '';
  });
});
