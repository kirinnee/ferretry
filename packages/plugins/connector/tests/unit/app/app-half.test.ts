import { ensureDom, interact, mount, settleUntil } from '@ferretry/app/testing';
import { describe, expect, it } from 'bun:test';
import { createElement, Suspense, type ReactNode } from 'react';
import connectorApp from '../../../app/index.ts';
import manifest from '../../../manifest.ts';
import { OFF, scriptedClient } from './fixtures.ts';

ensureDom();

describe('the connector app half', () => {
  it('is a built half, not a skeleton, and fills exactly the one tab the manifest declares', () => {
    expect(connectorApp.skeleton).toBeUndefined();
    const half = connectorApp.build?.({ manifest, client: scriptedClient({}) as never });
    expect(Object.keys(half?.settings ?? {})).toEqual(['connector']);
    expect(manifest.ui?.settings).toEqual([
      { id: 'connector', icon: 'plug-zap', group: 'devices-access', label: 'Claude connector', order: 16 },
    ]);
  });

  it('sits right after Connection (15) in the same group, so the two read as neighbours', () => {
    expect(manifest.ui?.settings?.[0]?.order).toBe(16);
  });

  it('loads its view on first use and draws the real tab', async () => {
    const half = connectorApp.build?.({
      manifest,
      client: scriptedClient({ 'GET /v1/connector': OFF }) as never,
    });
    const View = half?.settings.connector as (props: object) => ReactNode;
    const view = await mount(
      createElement(Suspense, { fallback: createElement('p', null, 'loading') }, createElement(View, {})),
    );
    try {
      await settleUntil(
        () => view.container.querySelector('[data-settings="connector"]') !== null,
        'the lazy connector view to replace its fallback',
        callback =>
          interact(async () => void (await Promise.all([callback(), new Promise(done => setTimeout(done, 25))]))),
        160,
      );
      expect(view.container.textContent).toContain('Let Claude connect');
    } finally {
      await view.unmount();
    }
  });
});
