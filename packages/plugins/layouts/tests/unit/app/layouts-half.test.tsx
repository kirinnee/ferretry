import { interact, mount } from '@ferretry/app/testing';
import type { AppHalf, PluginClient } from '@ferretry/kernel/manifest';
import { describe, expect, test } from 'bun:test';
import { type ReactNode, Suspense } from 'react';
import app from '../../../app/index.ts';
import manifest from '../../../manifest.ts';
import { readOf } from '../../support/layouts-app.ts';

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 8; turn += 1) await interact(() => new Promise(resolve => setTimeout(resolve, 0)));
};

const clientOf = (calls: string[]): PluginClient =>
  ({
    call: async (route: string) => {
      calls.push(route);
      const read = readOf();
      return route === 'GET /v1/layouts' ? read.list : { layout: read.current.layout, theme: read.current.theme };
    },
    subscribe: () => () => undefined,
  }) as unknown as PluginClient;

const halfOf = (calls: string[]): AppHalf<typeof manifest> =>
  app.build?.({ manifest, client: clientOf(calls) }) as AppHalf<typeof manifest>;

describe('Layouts’ app half', () => {
  test('it draws exactly the settings tab the manifest declares, and no screen or panel', () => {
    const half = halfOf([]);
    expect(Object.keys(half.settings ?? {})).toEqual(manifest.ui.settings.map(tab => tab.id));
    expect(half.screens ?? {}).toEqual({});
    expect(half.panels ?? {}).toEqual({});
  });

  test('the tab loads on first use and reads the layout through the half’s own client', async () => {
    const calls: string[] = [];
    const Tab = halfOf(calls).settings?.layout as (() => ReactNode) | undefined;
    if (Tab === undefined) throw new Error('the layout tab is missing');
    const view = await mount(
      <Suspense fallback={<p>loading</p>}>
        <Tab />
      </Suspense>,
    );
    await settle();
    expect([...calls].sort()).toEqual(['GET /v1/layouts', 'GET /v1/layouts/current']);
    expect(view.container.textContent).toContain('Navigation side');
    await view.unmount();
  });
});
