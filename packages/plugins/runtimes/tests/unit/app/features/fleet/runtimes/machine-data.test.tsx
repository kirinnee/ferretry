import { describe, expect, it } from 'bun:test';
import {
  type MachineData,
  machineDetailFromHash,
  machineDetailHash,
  readMachineData,
  type UseMachineData,
  useMachineData,
  useMachineDetail,
} from '../../../../../../app/features/fleet/runtimes/machine-data.ts';
import type { LiveRuntimesClient, RuntimesClient } from '../../../../../../app/lib/client.ts';
import { interact, mount, must } from '../../../../support/dom.ts';
import { CREDENTIALS, DATA, READS, scripted } from '../account-support.ts';
import { DaemonCallError, gated, live, offline } from './support-a.ts';

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  });
};

const OLD: MachineData = { ...DATA, credentials: { ...CREDENTIALS, machine: 'old-mac' } };

const FAILING = (error: Error) => ({ ...READS(), 'GET /v1/runtimes': error });

describe('readMachineData', () => {
  it('reads the four answers together', async () => {
    const data = await readMachineData(scripted(READS()));
    expect(data.credentials.machine).toBe('studio-mac');
    expect(data.runtimes.runtimes.map(entry => entry.name)).toContain('claude-default');
    expect(data.profiles.profiles.map(entry => entry.name)).toContain('Default');
    expect(data.components?.kinds.map(entry => entry.kind)).toContain('instructions');
  });

  it('asks the routes of the Runtimes and Logins plugins, and no others', async () => {
    const calls: string[] = [];
    const client = scripted(READS(), []);
    const recording: RuntimesClient = {
      call: async (route, init) => {
        calls.push(route);
        return await client.call(route, init);
      },
    };
    await readMachineData(recording);
    expect(calls.toSorted()).toEqual([
      'GET /v1/logins',
      'GET /v1/runtimes',
      'GET /v1/runtimes/components',
      'GET /v1/runtimes/profiles',
    ]);
  });

  it('throws what the failing read threw', async () => {
    const boom = new DaemonCallError('The machine said no.', 500);
    await expect(readMachineData(scripted(FAILING(boom)))).rejects.toBe(boom);
  });

  it('keeps the other three answers when only the parts catalog fails, with no parts', async () => {
    const data = await readMachineData(
      scripted({ ...READS(), 'GET /v1/runtimes/components': new DaemonCallError('No parts.', 500) }),
    );
    expect(data.components).toBeNull();
    expect(data.credentials.machine).toBe('studio-mac');
    expect(data.runtimes.runtimes.length).toBeGreaterThan(0);
    expect(data.profiles.profiles.length).toBeGreaterThan(0);
  });

  it('keeps the parts catalog when it answers', async () => {
    const data = await readMachineData(scripted(READS()));
    expect(data.components).toEqual(DATA.components);
  });

  it('still fails when a read other than the parts catalog fails', async () => {
    const boom = new DaemonCallError('Profiles gone.', 500);
    await expect(
      readMachineData(
        scripted({
          ...READS(),
          'GET /v1/runtimes/profiles': boom,
          'GET /v1/runtimes/components': new Error('x'),
        }),
      ),
    ).rejects.toBe(boom);
  });

  it('throws when the daemon cannot be reached', async () => {
    await expect(readMachineData(offline('offline'))).rejects.toThrow('offline');
  });

  it('refuses an answer that is not the shape the contract promises', async () => {
    await expect(readMachineData(scripted({ ...READS(), 'GET /v1/logins': { logins: 'none' } }))).rejects.toThrow();
  });
});

interface Probe {
  current: UseMachineData | null;
}

function DataHost({ client, probe }: { readonly client: LiveRuntimesClient; readonly probe: Probe }) {
  const result = useMachineData(client);
  probe.current = result;
  return (
    <p data-state={result.state.kind} data-machine={result.data?.credentials.machine ?? ''}>
      {result.state.kind === 'failed' ? result.state.sentence : ''}
    </p>
  );
}

const dataView = async (client: LiveRuntimesClient) => {
  const probe: Probe = { current: null };
  const view = await mount(<DataHost client={client} probe={probe} />);
  await settle();
  const hooks = () => must(probe.current, 'hook');
  const attr = (name: string) => view.container.querySelector('p')?.getAttribute(name);
  return { view, probe, hooks, attr };
};

/** The answers for read number `n` (1 for the mount, 2 for the first reload…), counted on the logins route. */
const byRead = (script: (read: number) => Record<string, unknown>): RuntimesClient => {
  let reads = 0;
  return {
    call: async (route, init) => {
      if (route === 'GET /v1/logins') reads += 1;
      return await scripted(script(reads)).call(route, init);
    },
  };
};

describe('useMachineData', () => {
  it('starts loading, then holds the answer', async () => {
    const probe: Probe = { current: null };
    const gate = gated(READS());
    const view = await mount(<DataHost client={gate.client} probe={probe} />);
    expect(view.container.querySelector('p')?.getAttribute('data-state')).toBe('loading');
    expect(must(probe.current, 'hook').data).toBeNull();
    gate.release();
    await settle();
    expect(view.container.querySelector('p')?.getAttribute('data-state')).toBe('ready');
    expect(must(probe.current, 'hook').data?.credentials.machine).toBe('studio-mac');
    await view.unmount();
  });

  it('reloads on request and resolves with the new answer', async () => {
    const host = await dataView(byRead(read => READS(read === 1 ? OLD : DATA)));
    expect(host.attr('data-machine')).toBe('old-mac');
    let result: MachineData | null = null;
    await interact(async () => {
      result = await host.hooks().reload();
    });
    expect((result as MachineData | null)?.credentials.machine).toBe('studio-mac');
    expect(host.attr('data-machine')).toBe('studio-mac');
    await host.view.unmount();
  });

  it('keeps the last answer beside the sentence when a later read fails', async () => {
    const host = await dataView(
      byRead(read => (read === 1 ? READS() : FAILING(new DaemonCallError('The machine said no.', 500)))),
    );
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
    const host = await dataView(offline('offline'));
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
    let release: () => void = () => undefined;
    const slowOpen = new Promise<void>(resolve => {
      release = resolve;
    });
    let reads = 0;
    const client: RuntimesClient = {
      call: async (route, init) => {
        if (route === 'GET /v1/logins') {
          reads += 1;
          if (reads === 2) {
            await slowOpen;
            return await scripted(READS(OLD)).call(route, init);
          }
        }
        return await scripted(READS()).call(route, init);
      },
    };
    const host = await dataView(client);
    expect(host.attr('data-machine')).toBe('studio-mac');
    let stale: Promise<MachineData | null> | undefined;
    await interact(() => {
      stale = host.hooks().reload();
    });
    await interact(async () => {
      await host.hooks().reload();
    });
    release();
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
    let release: () => void = () => undefined;
    const slowOpen = new Promise<void>(resolve => {
      release = resolve;
    });
    let reads = 0;
    const client: RuntimesClient = {
      call: async (route, init) => {
        if (route === 'GET /v1/logins') {
          reads += 1;
          if (reads === 2) {
            await slowOpen;
            throw new DaemonCallError('Too late.', 500);
          }
        }
        return await scripted(READS()).call(route, init);
      },
    };
    const host = await dataView(client);
    let stale: Promise<MachineData | null> | undefined;
    await interact(() => {
      stale = host.hooks().reload();
    });
    await interact(async () => {
      await host.hooks().reload();
    });
    release();
    let result: MachineData | null | undefined;
    await interact(async () => {
      result = await stale;
    });
    expect(result).toBeNull();
    expect(host.attr('data-state')).toBe('ready');
    expect(host.view.container.querySelector('p')?.textContent).toBe('');
    await host.view.unmount();
  });

  it('forgets the last answer and reads again when the daemon it reads from changes', async () => {
    const probe: Probe = { current: null };
    const studio = scripted(READS());
    const other = scripted(FAILING(new DaemonCallError('Other is asleep.', 503)));
    const view = await mount(<DataHost client={studio} probe={probe} />);
    await settle();
    expect(view.container.querySelector('p')?.getAttribute('data-machine')).toBe('studio-mac');
    await view.render(<DataHost client={other} probe={probe} />);
    await settle();
    expect(view.container.querySelector('p')?.getAttribute('data-state')).toBe('failed');
    expect(view.container.querySelector('p')?.textContent).toBe('Other is asleep.');
    expect(view.container.querySelector('p')?.getAttribute('data-machine')).toBe('');
    await view.unmount();
  });
});

function RuntimeNamesHost({ client, probe }: { readonly client: LiveRuntimesClient; readonly probe: Probe }) {
  const result = useMachineData(client);
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

  const mountLive = async (script: (read: number) => Record<string, unknown>) => {
    let reads = 0;
    const base: RuntimesClient = {
      call: async (route, init) => {
        if (route === 'GET /v1/logins') reads += 1;
        return await scripted(script(reads)).call(route, init);
      },
    };
    const harness = live(base);
    const probe: Probe = { current: null };
    const view = await mount(<RuntimeNamesHost client={harness.client} probe={probe} />);
    await settle();
    return { harness, view, reads: () => reads };
  };

  const runtimesMoved = { runtimes: ['claude-work'], profiles: [], modelSets: [] };

  it('shows a runtime another device added, without a reload', async () => {
    const harness = await mountLive(read => READS(read === 1 ? FEWER : DATA));
    expect(names(harness.view.container)).toEqual(['claude-default']);
    expect(harness.reads()).toBe(1);

    await interact(() => harness.harness.emit('runtimes.changed', runtimesMoved));
    await settle();

    expect(harness.reads()).toBe(2);
    expect(names(harness.view.container)).toEqual(DATA.runtimes.runtimes.map(entry => entry.name));
    await harness.view.unmount();
  });

  it('reads again for a change to each of the things it shows', async () => {
    const harness = await mountLive(() => READS());
    const moves: readonly [string, unknown][] = [
      ['logins.changed', { loginId: 'claude-work', change: 'status' }],
      ['runtimes.changed', runtimesMoved],
      ['runtimes.changed', { runtimes: [], profiles: ['Default'], modelSets: [] }],
      ['runtimes.changed', { runtimes: [], profiles: [], modelSets: ['Claude models'] }],
      ['runtimes.default-changed', { defaultRuntime: 'codex-default' }],
    ];
    for (const [index, [name, payload]] of moves.entries()) {
      await interact(() => harness.harness.emit(name, payload));
      await settle();
      expect(harness.reads()).toBe(index + 2);
    }
    await harness.view.unmount();
  });

  it('leaves the screen alone when something it does not show moved', async () => {
    const harness = await mountLive(read => READS(read === 1 ? FEWER : DATA));
    await interact(() => harness.harness.emit('runtimes.changed', { runtimes: [], profiles: [], modelSets: [] }));
    await interact(() => harness.harness.emit('warden.changed', {}));
    await settle();
    expect(harness.reads()).toBe(1);
    expect(names(harness.view.container)).toEqual(['claude-default']);
    await harness.view.unmount();
  });

  it('keeps what it showed, beside the sentence, when the read after the change fails', async () => {
    const harness = await mountLive(read =>
      read === 1 ? READS(FEWER) : FAILING(new DaemonCallError('The machine said no.', 500)),
    );
    await interact(() => harness.harness.emit('runtimes.changed', runtimesMoved));
    await settle();
    expect(harness.reads()).toBe(2);
    expect(harness.view.container.querySelector('ul')?.getAttribute('data-state')).toBe('failed');
    expect(names(harness.view.container)).toEqual(['claude-default']);
    await harness.view.unmount();
  });

  it('stops listening when it unmounts', async () => {
    const harness = await mountLive(() => READS());
    expect(harness.harness.listening('runtimes.changed')).toBe(1);
    await harness.view.unmount();
    expect(harness.harness.listening('runtimes.changed')).toBe(0);
    expect(harness.harness.listening('logins.changed')).toBe(0);
  });
});

describe('machineDetailFromHash', () => {
  it('reads the page segment of a link to this tab', () => {
    expect(machineDetailFromHash('#machines/studio-mac/runtimes/claude-default', 'runtimes')).toBe('claude-default');
    expect(machineDetailFromHash('machines/studio-mac/sign-ins/claude-work', 'sign-ins')).toBe('claude-work');
  });

  it('decodes a percent-encoded page', () => {
    expect(machineDetailFromHash('#machines/studio-mac/runtimes/a%20b%2Fc', 'runtimes')).toBe('a b/c');
  });

  it('is null for another section, another tab or no page', () => {
    expect(machineDetailFromHash('#settings/studio-mac/runtimes/claude-default', 'runtimes')).toBeNull();
    expect(machineDetailFromHash('#machines/studio-mac/sign-ins/claude-work', 'runtimes')).toBeNull();
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
    expect(machineDetailHash('studio-mac', 'sign-ins', 'claude-work')).toBe(
      '#machines/studio-mac/sign-ins/claude-work',
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
  readonly tab: 'runtimes' | 'sign-ins';
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
    fake.location.hash = '#machines/studio-mac/sign-ins/claude-work';
    await interact(() => fake.fire('hashchange'));
    expect(detailOf(view.container)).toBe('');
    await view.unmount();
  });

  it('reads again for a different tab or browser', async () => {
    const fake = fakeBrowser('#machines/studio-mac/sign-ins/claude-work');
    const probe: DetailProbe = { current: null };
    const view = await mount(<DetailHost machine="studio-mac" tab="runtimes" probe={probe} browser={fake.browser} />);
    expect(detailOf(view.container)).toBe('');
    await view.render(<DetailHost machine="studio-mac" tab="sign-ins" probe={probe} browser={fake.browser} />);
    expect(detailOf(view.container)).toBe('claude-work');
    const other = fakeBrowser('#machines/studio-mac/sign-ins/codex');
    await view.render(<DetailHost machine="studio-mac" tab="sign-ins" probe={probe} browser={other.browser} />);
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
