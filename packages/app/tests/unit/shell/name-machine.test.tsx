import { afterEach, describe, expect, test } from 'bun:test';
import type { TransportAnswer, TransportRequest } from '../../../src/client/transport.ts';
import { type DaemonlessPorts, registeredDaemonless } from '../../../src/connect/provides.ts';
import { DaemonList, type PairingInput } from '../../../src/daemons/daemon-list.ts';
import { generated } from '../../../src/generated/surfaces.ts';
import { DeviceLayoutStore } from '../../../src/layout/device-layout.ts';
import type { PasskeyHandler, PasskeyProvision } from '../../../src/passkey/passkey.ts';
import { ScrollMemory } from '../../../src/scroll/scroll-memory.ts';
import { App } from '../../../src/shell/app.tsx';
import type { ShellWindow } from '../../../src/shell/context.tsx';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import { memoryStore } from '../../../src/storage/records.ts';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';
import { ThemePreferenceStore } from '../../../src/theme/preferences.ts';
import { interact, must, mount } from '../../support/dom.ts';
import { CORE, FakeTransport, inventoryOf, json } from '../client/fixtures.ts';

/**
 * THE "NAME THIS MACHINE" STEP, over a fake machine: offered once after a pairing when the machine has no name of the
 * owner's, prefilled with the host name, skippable, written through the existing config-file route, and said plainly
 * when the daemon refuses. Fake data only: no real daemon, address or pairing code.
 */

const HOST = 'ip-10-0-0-7';
const kernel = generated.surfaces.find(entry => entry.id === 'kernel');
if (kernel === undefined) throw new Error('the generated registry has no kernel');
const surfaces: SurfaceEntry[] = [kernel, ...CORE.filter(entry => entry.id !== 'kernel')];

const browser: ShellWindow = {
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  document: { documentElement: document.documentElement },
};
const handler: PasskeyHandler = {
  need: () => undefined,
  confirm: async () => true,
  ask: async () => false,
  focus: () => undefined,
  locked: () => [],
  subscribe: () => () => undefined,
};
const provision = { handler, Prompts: () => null } as unknown as PasskeyProvision;
const settle = async (): Promise<void> => {
  for (let i = 0; i < 12; i += 1) await interact(() => new Promise(resolve => setTimeout(resolve, 0)));
};

interface Options {
  /** What `host.yaml` holds on the machine; `undefined` is no file. */
  readonly hostFile?: string;
  /** What the machine answers the write with. */
  readonly writeAnswer?: TransportAnswer;
  /** Whether the read of the file is refused. */
  readonly readRefused?: boolean;
  readonly pairing?: Partial<PairingInput>;
  /** A name this device learned earlier; the plugin list is refused when set, as when the machine is not answering. */
  readonly learned?: string;
  /** The address the app opens at; a machine's own page unless a test says otherwise (`/onboarding` names none). */
  readonly path?: string;
  /** Reads of the file answer with no revision (a machine that could not read it) until the test says it recovered. */
  readonly unreadableAtFirst?: boolean;
}

async function boot(options: Options = {}) {
  window.history.replaceState(null, '', options.path ?? '/d/ws');
  // Until the test says the machine recovered, a machine set to `unreadableAtFirst` answers every read with no revision.
  const machine = { recovered: options.unreadableAtFirst !== true };
  const transport = new FakeTransport((request: TransportRequest): TransportAnswer => {
    const path = request.path.split('?')[0];
    if (path === '/v1/plugins')
      return options.learned === undefined
        ? json(inventoryOf(surfaces))
        : json({ error: 'this device may not read that', code: 'forbidden' }, 403);
    if (path === '/v1/health') return json({ protocol: 1, version: '5.0.0' });
    if (path === '/v1/config/file' && request.method === 'GET') {
      if (options.readRefused === true) return json({ error: 'this device may not read that', code: 'forbidden' }, 403);
      return json({
        path: 'host.yaml',
        exists: options.hostFile !== undefined,
        text: options.hostFile ?? '',
        etag: machine.recovered ? 'e1' : '',
      });
    }
    if (path === '/v1/config/file' && request.method === 'PUT')
      return options.writeAnswer ?? json({ path: 'host.yaml', etag: 'e2', outcome: 'applied' });
    return json({ ok: true });
  });
  const list = new DaemonList({ storage: memoryStore(), now: () => 1 });
  list.add({
    daemon: 'ws',
    machine: HOST,
    deviceId: 'dev',
    address: 'http://127.0.0.1:40245',
    ...options.pairing,
  });
  // A second machine, so the switcher (hidden while one machine is paired) is drawn and carries the offer.
  list.add({ daemon: 'other', machine: 'other-host', deviceId: 'dev2', address: 'http://127.0.0.1:40246' });
  if (options.learned !== undefined) list.learnMachine('ws', options.learned);
  const runtime = new ShellRuntime({
    appVersion: '5.0.0',
    surfaces,
    daemons: list,
    connect: async () => transport,
    passkey: () => provision,
    daemonless: {
      views: registeredDaemonless(surfaces, {} as DaemonlessPorts).views,
      location: () => window.location.href,
    },
  });
  const storage = memoryStore();
  const view = await mount(
    <App
      runtime={runtime}
      themes={new ThemePreferenceStore(storage)}
      layouts={new DeviceLayoutStore(storage)}
      browser={browser}
      scroll={new ScrollMemory(null)}
    />,
  );
  await settle();
  const step = (): HTMLElement | null => view.container.querySelector('[data-name-machine]');
  const writes = (): TransportRequest[] =>
    transport.requests.filter(request => request.method === 'PUT' && request.path.startsWith('/v1/config/file'));
  const press = async (selector: string): Promise<void> => {
    await interact(() => must(view.container.querySelector<HTMLElement>(selector), selector).click());
    await settle();
  };
  const typeName = async (value: string): Promise<void> => {
    const input = must(view.container.querySelector<HTMLInputElement>('#name-machine-field'), 'the name field');
    await interact(() => {
      must(Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set, 'a value setter').call(
        input,
        value,
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const recover = (): void => {
    machine.recovered = true;
  };
  return { view, list, transport, step, writes, press, typeName, recover };
}

let open: Awaited<ReturnType<typeof boot>> | undefined;
afterEach(async () => {
  await open?.view.unmount();
  open = undefined;
  window.history.replaceState(null, '', '/');
});

describe('Name this machine', () => {
  test('a pairing of a machine with no name offers one, prefilled with the host name', async () => {
    open = await boot({ pairing: { askName: true } });
    expect(open.step()?.textContent).toContain('Name this machine');
    expect(must(open.view.container.querySelector<HTMLInputElement>('#name-machine-field'), 'field').value).toBe(HOST);
  });

  test('saving writes host.yaml through the config-file route and the machine is called that everywhere at once', async () => {
    open = await boot({ pairing: { askName: true } });
    await open.typeName('Studio box');
    await open.press('button[type="submit"]');
    const [write] = open.writes();
    expect(write?.body).toEqual({
      path: 'host.yaml',
      text: 'name: "Studio box"\n',
      etag: 'e1',
    });
    expect(open.list.get('ws')?.machine).toBe('Studio box');
    expect(open.step()).toBeNull();
  });

  test('not now sends nothing and keeps the host name', async () => {
    open = await boot({ pairing: { askName: true } });
    await open.press('[data-name-machine-skip]');
    expect(open.writes()).toEqual([]);
    expect(open.list.get('ws')?.machine).toBe(HOST);
    expect(open.step()).toBeNull();
  });

  test('a name the daemon would refuse is said before anything is sent', async () => {
    open = await boot({ pairing: { askName: true } });
    await open.typeName('   ');
    await open.press('button[type="submit"]');
    expect(open.step()?.querySelector('[role="alert"]')?.textContent ?? '').not.toBe('');
    expect(open.writes()).toEqual([]);
  });

  test('a device the daemon refuses is told so, and goes on with the host name', async () => {
    open = await boot({
      pairing: { askName: true },
      writeAnswer: json({ error: 'this device may not configure this machine', code: 'forbidden' }, 403),
    });
    await open.typeName('Studio box');
    await open.press('button[type="submit"]');
    expect(open.step()?.querySelector('[data-name-machine-refused]')?.textContent).toContain(
      'this device may not configure this machine',
    );
    expect(open.list.get('ws')?.machine).toBe(HOST);
    await open.press('[data-name-machine-skip]');
    expect(open.step()).toBeNull();
  });

  test('a name typed at pairing is saved as soon as the machine answers, and the later step never shows', async () => {
    open = await boot({ pairing: { askName: true, chosenName: '  Studio box ' } });
    expect(open.writes().map(write => write.body)).toEqual([
      { path: 'host.yaml', text: 'name: "Studio box"\n', etag: 'e1' },
    ]);
    expect(open.list.get('ws')?.machine).toBe('Studio box');
    expect(open.step()).toBeNull();
    expect(open.list.namePending('ws')).toBe(false);
    expect(open.list.chosenName('ws')).toBeUndefined();
  });

  test('on the first-run route, which names no machine, the typed name is still written once', async () => {
    open = await boot({ path: '/onboarding', pairing: { askName: true, chosenName: 'Studio box' } });
    expect(window.location.pathname).not.toContain('/d/');
    expect(open.writes().map(write => write.body)).toEqual([
      { path: 'host.yaml', text: 'name: "Studio box"\n', etag: 'e1' },
    ]);
    expect(open.list.get('ws')?.machine).toBe('Studio box');
    expect(open.list.chosenName('ws')).toBeUndefined();
    await settle();
    expect(open.writes()).toHaveLength(1);
  });

  test('a save that fails at pairing brings the later step back, with the typed name and the reason', async () => {
    open = await boot({
      pairing: { askName: true, chosenName: 'Studio box' },
      writeAnswer: json({ error: 'this device may not configure this machine', code: 'forbidden' }, 403),
    });
    expect(open.step()?.textContent).toContain('The name you chose while pairing was not saved');
    expect(open.step()?.textContent).toContain('this device may not configure this machine');
    expect(must(open.view.container.querySelector<HTMLInputElement>('#name-machine-field'), 'field').value).toBe(
      'Studio box',
    );
    expect(open.list.get('ws')?.machine).toBe(HOST);
  });

  test('a read that came back without a revision is never written with an empty one, and the retry reads fresh', async () => {
    open = await boot({ pairing: { askName: true, chosenName: 'Studio box' }, unreadableAtFirst: true });
    expect(open.writes()).toEqual([]);
    expect(open.step()?.textContent).toContain('The name you chose while pairing was not saved');
    open.recover();
    await open.press('button[type="submit"]');
    expect(open.writes().map(write => write.body)).toEqual([
      { path: 'host.yaml', text: 'name: "Studio box"\n', etag: 'e1' },
    ]);
    expect(open.list.get('ws')?.machine).toBe('Studio box');
    expect(open.step()).toBeNull();
  });

  test('a name with an invisible character is said inline in the step and nothing is sent', async () => {
    open = await boot({ pairing: { askName: true } });
    await open.typeName('Studio\u200Bbox');
    await open.press('button[type="submit"]');
    expect(open.step()?.querySelector('[role="alert"]')?.textContent).toContain('invisible');
    expect(open.writes()).toEqual([]);
  });

  test('a chosen name the daemon rule refuses is kept for the step, which says why', async () => {
    open = await boot({ pairing: { askName: true, chosenName: 'Studio\u200Bbox' } });
    expect(open.writes()).toEqual([]);
    expect(open.step()?.textContent).toContain('invisible');
  });

  test('a machine that already has a name of the owner’s is not asked', async () => {
    open = await boot({ pairing: { askName: true }, hostFile: 'name: "pebox"\n' });
    expect(open.step()).toBeNull();
    expect(open.list.namePending('ws')).toBe(false);
  });

  test('a machine that cannot say whether it is named is left alone', async () => {
    open = await boot({ pairing: { askName: true }, readRefused: true });
    expect(open.step()).toBeNull();
    expect(open.writes()).toEqual([]);
  });

  test('a pairing that did not ask never shows the step and writes nothing', async () => {
    open = await boot();
    expect(open.step()).toBeNull();
    expect(open.writes()).toEqual([]);
  });

  test('a machine that goes by its host name shows a quiet "Name this machine" beside the switcher, which opens the step', async () => {
    open = await boot();
    const offer = (): HTMLElement | null => open?.view.container.querySelector('[data-name-machine-offer]') ?? null;
    expect(offer()?.textContent).toBe('Name this machine');
    expect(open.step()).toBeNull();
    await open.press('[data-name-machine-offer]');
    expect(open.step()?.textContent).toContain('Name this machine');
    expect(offer(), 'the offer steps aside while the step is open').toBeNull();
    await open.press('[data-name-machine-skip]');
    expect(offer(), 'it is back once the step is put away').not.toBeNull();
  });

  test('a machine the owner named, or one that cannot say, shows no offer', async () => {
    open = await boot({ hostFile: 'name: "pebox"\n' });
    expect(open.view.container.querySelector('[data-name-machine-offer]')).toBeNull();
    await open.view.unmount();
    open = await boot({ readRefused: true });
    expect(open.view.container.querySelector('[data-name-machine-offer]')).toBeNull();
  });

  test('saving through the offer names the machine everywhere', async () => {
    open = await boot();
    await open.press('[data-name-machine-offer]');
    await open.typeName('Studio box');
    await open.press('button[type="submit"]');
    expect(open.list.get('ws')?.machine).toBe('Studio box');
    expect(open.writes()).toHaveLength(1);
  });

  test('the machine picker keeps the name it learned while the machine refuses its plugin list', async () => {
    open = await boot({ learned: 'pebox' });
    const shown = open.view.container.querySelector('[data-daemon-picker] .fy-daemon-picker__name')?.textContent;
    expect(shown).toBe('pebox');
    expect(shown).not.toBe(HOST);
  });
});
