import { afterEach, describe, expect, test } from 'bun:test';
import { implementApp, type Manifest, type PluginClient } from '@ferretry/kernel/manifest';
import type { ReactNode } from 'react';
import type { TransportRequest } from '../../../src/client/transport.ts';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { DeviceLayoutStore } from '../../../src/layout/device-layout.ts';
import { ScrollMemory } from '../../../src/scroll/scroll-memory.ts';
import { App } from '../../../src/shell/app.tsx';
import type { ShellWindow } from '../../../src/shell/context.tsx';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import { type Authority, useViewPlace } from '../../../src/shell/view-place.tsx';
import { memoryStore } from '../../../src/storage/records.ts';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';
import { ThemePreferenceStore } from '../../../src/theme/preferences.ts';
import {
  CHANGE_REFUSALS,
  type ChangeAuthority,
  changeAuthorityFrom,
  changeAuthorityOf,
  changeRefusalExplanation,
  readChangeAuthority,
  useChangeAuthority,
} from '../../../src/ui/change-authority.ts';
import { interact, type Mounted, mount } from '../../support/dom.ts';
import { CORE, FakeTransport, inventoryOf, json } from '../client/fixtures.ts';

/**
 * `useChangeAuthority` KEEPS ITS TYPE (shell contract S1, R2 m3) as an adapter over the shell's one grants cache, and
 * reads as it always did outside a shell or for a client the shell did not issue (R3 m4).
 */

const row = (configure: boolean, configureRefusal = configure ? 'granted' : 'not-granted') => ({
  capability: 'fleet',
  use: true,
  configure,
  useRefusal: 'granted',
  configureRefusal,
});

describe('the old vocabulary, one case per kind', () => {
  const cases: [Authority, ChangeAuthority | null][] = [
    [{ kind: 'unknown' }, null],
    [{ kind: 'locked' }, { kind: 'step-up' }],
    [{ kind: 'step-up' }, { kind: 'step-up' }],
    [{ kind: 'open' }, { kind: 'open' }],
    [{ kind: 'unreadable' }, { kind: 'unreadable' }],
    [
      { kind: 'refused', refusal: 'not-granted' },
      { kind: 'refused', refusal: 'not-granted' },
    ],
    [
      { kind: 'refused', refusal: 'device-not-granted' },
      { kind: 'refused', refusal: 'device-not-granted' },
    ],
    [
      { kind: 'refused', refusal: 'undetermined' },
      { kind: 'refused', refusal: 'undetermined' },
    ],
  ];
  for (const [authority, expected] of cases)
    test(`${authority.kind}${'refusal' in authority ? ` ${authority.refusal}` : ''}`, () => {
      expect(changeAuthorityFrom(authority)).toEqual(expected);
    });
});

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  window.history.replaceState({}, '', '/');
});
const settle = async (): Promise<void> => {
  for (let i = 0; i < 12; i += 1) await interact(() => new Promise(resolve => setTimeout(resolve, 0)));
};

describe('outside a shell, and for a client the shell did not issue', () => {
  test('it makes its own read, as before', async () => {
    const calls: string[] = [];
    const client: Pick<PluginClient, 'call'> = {
      call: async <A,>(route: string) => {
        calls.push(route);
        return { capabilities: [row(false, 'step-up-required')] } as A;
      },
    };
    const got: { authority?: ChangeAuthority | null } = {};
    function Reader(): ReactNode {
      got.authority = useChangeAuthority(client);
      return null;
    }
    view = await mount(<Reader />);
    await settle();
    expect(calls).toEqual(['GET /v1/grants']);
    expect(got.authority).toEqual({ kind: 'step-up' });
  });
});

describe('inside a shell, for a client the shell issued', () => {
  const manifest = {
    id: 'fleetui',
    title: 'Fleet UI',
    version: '5.0.0',
    api: 5,
    core: false,
    kinds: ['view'],
    ui: { screens: [{ id: 'main', path: 'main' }] },
  } as unknown as Manifest;
  const got: { change?: ChangeAuthority | null; place?: Authority; stranger?: ChangeAuthority | null } = {};
  const stranger: Pick<PluginClient, 'call'> = {
    call: async <A,>() => ({ capabilities: [row(true)] }) as A,
  };
  function Screen({ client }: { readonly client: PluginClient }): ReactNode {
    got.change = useChangeAuthority(client);
    got.place = useViewPlace()?.authority('fleet', 'configure');
    got.stranger = useChangeAuthority(stranger);
    return null;
  }
  const entry: SurfaceEntry = {
    id: 'fleetui',
    title: 'Fleet UI',
    core: false,
    contract: 'h-fleetui',
    consumes: [],
    manifest,
    app: implementApp(manifest, { build: ({ client }) => ({ screens: { main: () => <Screen client={client} /> } }) }),
  };
  const surfaces = [...CORE, entry];

  test('it reads the one cache: one GET /v1/grants per trigger, shared with the view place', async () => {
    let configure = false;
    const transport = new FakeTransport((request: TransportRequest) => {
      if (request.path === '/v1/plugins') return json(inventoryOf(surfaces));
      if (request.path === '/v1/grants') return json({ capabilities: [row(configure)] });
      return json({ error: 'none', code: 'not_found' }, 404);
    });
    const daemons = new DaemonList({ storage: memoryStore(), now: () => 1 });
    daemons.add({ daemon: 'd1', machine: 'laptop', deviceId: 'dev', address: 'http://127.0.0.1:40245' });
    const runtime = new ShellRuntime({ appVersion: '5.0.0', surfaces, daemons, connect: async () => transport });
    const browser: ShellWindow = {
      matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
      document: { documentElement: document.documentElement },
    };
    window.history.replaceState({}, '', '/d/d1/main');
    const storage = memoryStore();
    view = await mount(
      <App
        runtime={runtime}
        themes={new ThemePreferenceStore(storage)}
        layouts={new DeviceLayoutStore(storage)}
        browser={browser}
        scroll={new ScrollMemory(null)}
      />,
    );
    await settle();
    const grantsReads = () => transport.paths().filter(path => path === 'GET /v1/grants').length;
    expect(got.change).toEqual({ kind: 'refused', refusal: 'not-granted' });
    expect(got.place).toEqual({ kind: 'refused', refusal: 'not-granted' });
    expect(grantsReads()).toBe(1);
    // A client the shell did not issue still reads for itself (its fake answers open).
    expect(got.stranger).toEqual({ kind: 'open' });
    configure = true;
    await interact(() => transport.reconnect());
    await settle();
    expect(got.change).toEqual({ kind: 'open' });
    expect(got.place).toEqual({ kind: 'open' });
    expect(grantsReads()).toBe(2);
  });
});

describe('the grants reading itself', () => {
  test('every refusal has its sentence', () => {
    for (const refusal of CHANGE_REFUSALS) expect(changeRefusalExplanation(refusal).length).toBeGreaterThan(10);
  });

  test('an answer with no fleet row is undetermined, a misshapen one unreadable, a failed read unreadable', async () => {
    expect(changeAuthorityOf({ capabilities: [] })).toEqual({ kind: 'refused', refusal: 'undetermined' });
    expect(changeAuthorityOf({ nope: 1 })).toEqual({ kind: 'unreadable' });
    expect(changeAuthorityOf({ capabilities: [row(true)] })).toEqual({ kind: 'open' });
    expect(changeAuthorityOf({ capabilities: [row(false, 'step-up-required')] })).toEqual({ kind: 'step-up' });
    expect(changeAuthorityOf({ capabilities: [row(false)] })).toEqual({ kind: 'refused', refusal: 'not-granted' });
    const failing: Pick<PluginClient, 'call'> = {
      call: async () => {
        throw new Error('down');
      },
    };
    expect(await readChangeAuthority(failing)).toEqual({ kind: 'unreadable' });
  });
});
