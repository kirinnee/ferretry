import { afterEach, describe, expect, test } from 'bun:test';
import { implementApp, type PluginClient } from '@ferretry/kernel/manifest';
import { type ReactNode, useEffect } from 'react';
import { type BackgroundViewProps, provideToShell } from '../../../src/connect/provides.ts';
import { useEveryDaemon } from '../../../src/shell/every-daemon.ts';
import { interact, type Mounted } from '../../support/dom.ts';
import { bootApp, entryOf, manifestOf, route, settle } from './frame-fixtures.tsx';

/**
 * THE BACKGROUND HOST (shell contract S5): a plugin's background view is mounted once per paired daemon where the plugin
 * may run, at the frame root, handed its BACKGROUND-origin client — and nothing else a foreground place has.
 */

const PING = 'POST /v1/bg/ping';

interface Mount {
  readonly daemon: string;
  readonly client: PluginClient;
}
const mounts: Mount[] = [];
const unmounts: string[] = [];
const rowClients: PluginClient[] = [];
/** The client each machine's row handed the view, by daemon (what the Watcher captured, not what the runtime holds). */
const rowOf = new Map<string, PluginClient>();
const sent: { daemon: string; via: string; result: Promise<unknown> }[] = [];

function Watcher({ daemon, client }: BackgroundViewProps): ReactNode {
  const rows = useEveryDaemon();
  useEffect(() => {
    mounts.push({ daemon, client });
    return () => void unmounts.push(daemon);
  }, [daemon, client]);
  useEffect(() => {
    rowClients.push(...rows.map(row => row.client));
    for (const row of rows) rowOf.set(row.daemon, row.client);
  }, [rows]);
  return <p data-testid={`bg-${daemon}`}>watching {daemon}</p>;
}

const bgManifest = manifestOf('bg', {
  actions: { routes: [route(PING)] },
  ui: { screens: [{ id: 'main', path: 'main' }] },
});
const bg = entryOf(
  bgManifest,
  provideToShell(implementApp(bgManifest, { build: () => ({ screens: { main: () => <p>bg screen</p> } }) }), {
    background: { watch: Watcher },
  }),
);

const boomManifest = manifestOf('boom', { ui: { screens: [] } });
const boom = entryOf(
  boomManifest,
  provideToShell(implementApp(boomManifest, { build: () => ({}) }), {
    background: {
      throws: () => {
        throw new Error('background view failed');
      },
    },
  }),
);

const otherManifest = manifestOf('other', { ui: { screens: [] } });
const other = entryOf(
  otherManifest,
  provideToShell(implementApp(otherManifest, { build: () => ({}) }), {
    background: { quiet: () => <p data-testid="other">other is watching</p> },
  }),
);

let view: Mounted | null = null;
const quiet = console.error;
afterEach(async () => {
  await view?.unmount();
  view = null;
  console.error = quiet;
  mounts.length = 0;
  unmounts.length = 0;
  rowClients.length = 0;
  rowOf.clear();
  sent.length = 0;
});

describe('the background host', () => {
  test('shell S5: mounts a background view once per paired daemon, handed that daemon', async () => {
    const app = await bootApp({ surfaces: [bg], machines: ['d1', 'd2'] });
    view = app.view;
    expect(mounts.map(each => each.daemon).sort()).toEqual(['d1', 'd2']);
    expect(app.view.container.textContent).toContain('watching d1');
    expect(app.view.container.textContent).toContain('watching d2');
  });

  test('shell S5: mounts nothing with no paired machine, and mounts on a machine paired later', async () => {
    const app = await bootApp({ surfaces: [bg], machines: ['d1'], pairLater: true });
    view = app.view;
    expect(mounts).toEqual([]);
    await interact(() => app.pair('d1'));
    await settle();
    expect(mounts.map(each => each.daemon)).toEqual(['d1']);
  });

  test('shell S5: a background view stays mounted across pages and a reconnect (same client, no remount)', async () => {
    const app = await bootApp({ surfaces: [bg], machines: ['d1'], path: '/d/d1/main' });
    view = app.view;
    const before = mounts.length;
    await interact(() => app.machine('d1').transport.reconnect());
    await settle();
    expect(mounts).toHaveLength(before);
    expect(unmounts).toEqual([]);
  });

  test('shell S5: unmounts when the plugin is blocked on a daemon, and mounts again when allowed', async () => {
    const app = await bootApp({ surfaces: [bg], machines: ['d1', 'd2'] });
    view = app.view;
    app.machine('d1').off.add('bg');
    await app.reread('d1');
    expect(unmounts).toEqual(['d1']);
    expect(app.view.container.textContent).not.toContain('watching d1');
    expect(app.view.container.textContent).toContain('watching d2');
    app.machine('d1').off.delete('bg');
    await app.reread('d1');
    expect(mounts.filter(each => each.daemon === 'd1')).toHaveLength(2);
    // The client it is handed again is the same cache entry.
    const [first, again] = mounts.filter(each => each.daemon === 'd1');
    expect(again?.client).toBe(first?.client as PluginClient);
  });

  test('shell S5: unmounts when the daemon is unpaired', async () => {
    const app = await bootApp({ surfaces: [bg], machines: ['d1', 'd2'] });
    view = app.view;
    await interact(() => app.list.remove('d2'));
    await settle();
    expect(unmounts).toEqual(['d2']);
    expect(app.view.container.textContent).not.toContain('watching d2');
  });

  test('shell S5: a throwing background view costs only itself', async () => {
    console.error = () => {};
    const app = await bootApp({ surfaces: [boom, other, bg], machines: ['d1'] });
    view = app.view;
    expect(app.view.container.textContent).toContain('boom stopped working on this screen.');
    expect(app.view.container.textContent).toContain('other is watching');
    expect(app.view.container.textContent).toContain('watching d1');
  });

  test('shell S5: a plugin with no background view mounts nothing (and no host markup)', async () => {
    const app = await bootApp({ surfaces: [], machines: ['d1'] });
    view = app.view;
    expect(mounts).toEqual([]);
  });
});

describe('the background origin (R3 MJ1)', () => {
  test('shell S5: the prop client and every useEveryDaemon row are the cache’s BACKGROUND entries, never the ordinary ones', async () => {
    const app = await bootApp({ surfaces: [bg], machines: ['d1', 'd2'] });
    view = app.view;
    for (const mounted of mounts) {
      expect(mounted.client).toBe(app.runtime.client(mounted.daemon, 'bg', 'background') as PluginClient);
      expect(mounted.client).not.toBe(app.runtime.client(mounted.daemon, 'bg') as PluginClient);
    }
    const ordinary = ['d1', 'd2'].map(daemon => app.runtime.client(daemon, 'bg') as PluginClient);
    const background = ['d1', 'd2'].map(daemon => app.runtime.client(daemon, 'bg', 'background') as PluginClient);
    expect(rowClients.length).toBeGreaterThan(0);
    for (const client of rowClients) {
      expect(background).toContain(client);
      expect(ordinary).not.toContain(client);
    }
  });

  test('shell S5: a POST from the prop client and from each row to a locked machine raises no prompt, and goes once it is unlocked', async () => {
    // Two locked machines paired, the app opened on a third: zero prompts.
    const app = await bootApp({
      surfaces: [bg],
      machines: ['d1', 'd2', 'd3'],
      locked: ['d1', 'd2'],
      path: '/d/d3/main',
    });
    view = app.view;
    const viaProp = mounts.find(each => each.daemon === 'd1');
    expect(viaProp).toBeDefined();
    const viaRow = rowOf.get('d2');
    expect(viaRow).toBeDefined();
    const first = (viaProp as Mount).client.call(PING, { body: {} });
    const second = (viaRow as PluginClient).call(PING, { body: {} });
    await settle();
    // Nothing was asked of the person: every confirm that reached the handler was a background one.
    expect(app.prompts.length).toBeGreaterThan(0);
    expect(app.prompts.every(prompt => prompt.origin === 'background')).toBe(true);
    expect(app.prompts.some(prompt => prompt.daemon === 'd3')).toBe(false);
    let done = 0;
    void first.then(() => (done += 1));
    void second.then(() => (done += 1));
    await settle();
    expect(done).toBe(0);
    // The unlock (some other, explicit act) releases the waiting call, which goes through once.
    await app.unlock('d1');
    await app.unlock('d2');
    await first;
    await second;
    expect(done).toBe(2);
    expect(
      app
        .machine('d1')
        .transport.paths()
        .filter(path => path === PING),
    ).toHaveLength(2);
    expect(app.prompts.every(prompt => prompt.origin === 'background')).toBe(true);
  });

  test('shell S5: the same POST through the ordinary client is a press and asks at once (the contrast)', async () => {
    const app = await bootApp({ surfaces: [bg], machines: ['d1'], locked: ['d1'] });
    view = app.view;
    const ordinary = app.runtime.client('d1', 'bg') as PluginClient;
    await ordinary.call(PING, { body: {} });
    expect(app.prompts.some(prompt => prompt.origin === 'explicit' && prompt.daemon === 'd1')).toBe(true);
  });
});
