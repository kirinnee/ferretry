import { describe, expect, test } from 'bun:test';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { DEFAULT_LAYOUT, DEFAULT_THEME, LayoutsChanged } from '../../../contract/index.ts';
import { layoutsClient } from '../../../app/lib/layouts-client.ts';
import manifest from '../../../manifest.ts';
import { listOf } from '../../support/layouts-app.ts';

type Call = { route: string; init: unknown };

function fakePlugin(answers: Record<string, unknown>) {
  const calls: Call[] = [];
  const listened: unknown[] = [];
  const client = {
    call: async (route: string, init?: unknown) => {
      calls.push({ route, init });
      return answers[route];
    },
    subscribe: (event: unknown, listener: (payload: unknown) => void) => {
      listened.push(event);
      listener({ layout: 'default' });
      return () => undefined;
    },
  } as unknown as PluginClient;
  return { client, calls, listened };
}

const declared = new Set(manifest.actions.routes.map(route => `${route.method} ${route.path}`));

describe('the Layout tab’s client', () => {
  test('a read asks the two read routes and parses what they answer', async () => {
    const plugin = fakePlugin({
      'GET /v1/layouts/current': { layout: DEFAULT_LAYOUT, theme: DEFAULT_THEME },
      'GET /v1/layouts': listOf(),
    });
    const read = await layoutsClient(plugin.client).read();
    expect(read.current.layout.id).toBe('default');
    expect(read.list.layouts.map(layout => layout.id)).toEqual(['default', 'compact']);
    expect(plugin.calls.map(call => call.route)).toEqual(['GET /v1/layouts/current', 'GET /v1/layouts']);
  });

  test('an answer the contract does not parse is a failed read, not a half-drawn screen', async () => {
    const plugin = fakePlugin({ 'GET /v1/layouts/current': { layout: { id: 'x' } }, 'GET /v1/layouts': listOf() });
    await expect(layoutsClient(plugin.client).read()).rejects.toThrow();
  });

  test('every write is one declared route with the body its verb takes', async () => {
    const plugin = fakePlugin({});
    const client = layoutsClient(plugin.client);
    await client.set('nav.side', 'right');
    await client.switchLayout('compact');
    await client.switchTheme('dusk');
    await client.reset();
    await client.save('mine');
    await client.remove('mine');
    expect(plugin.calls).toEqual([
      { route: 'PATCH /v1/layouts/current', init: { body: { changes: [{ path: 'nav.side', value: 'right' }] } } },
      { route: 'PUT /v1/layouts/current', init: { body: { layout: 'compact' } } },
      { route: 'PUT /v1/layouts/theme', init: { body: { theme: 'dusk' } } },
      { route: 'POST /v1/layouts/reset', init: undefined },
      { route: 'POST /v1/layouts', init: { body: { id: 'mine' } } },
      { route: 'DELETE /v1/layouts/:layoutId', init: { params: { layoutId: 'mine' } } },
    ]);
    for (const call of plugin.calls) expect(declared.has(call.route)).toBe(true);
  });

  test('a change anyone made is heard through layouts.changed', () => {
    const plugin = fakePlugin({});
    let heard = 0;
    layoutsClient(plugin.client).onChanged(() => {
      heard += 1;
    });
    expect(plugin.listened).toEqual([LayoutsChanged]);
    expect(heard).toBe(1);
  });
});
