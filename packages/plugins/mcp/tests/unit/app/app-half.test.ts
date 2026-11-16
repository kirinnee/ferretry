import { ensureDom, interact, mount, settleUntil } from '@ferretry/app/testing';
import { describe, expect, it } from 'bun:test';
import { createElement, Suspense, type ReactNode } from 'react';
import mcpApp from '../../../app/index.ts';
import manifest from '../../../manifest.ts';
import { scriptedClient } from './mcp-fixtures.ts';

ensureDom();

describe('the MCP app half', () => {
  it('is a built half, not a skeleton, and fills exactly what the manifest declares', () => {
    expect(mcpApp.skeleton).toBeUndefined();
    const half = mcpApp.build?.({ manifest, client: scriptedClient({}) as never });
    expect(Object.keys(half?.panels ?? {})).toEqual(['mcp-servers', 'add-mcp-row']);
    expect(Object.keys(half?.settings ?? {})).toEqual(['mcp']);
    expect(manifest.ui?.panels?.map(entry => entry.id)).toEqual(['mcp-servers', 'add-mcp-row']);
    expect(manifest.ui?.settings?.map(entry => entry.id)).toEqual(['mcp']);
  });

  it('loads its views on first use: a surface suspends through React use() and then draws the real view', async () => {
    // 5699fcd446: a lazy view suspends with `use()`, which only works inside a React draw, so it is drawn the way the
    // shell draws it: under a Suspense boundary, which holds a fallback while the view's module loads.
    const half = mcpApp.build?.({ manifest, client: scriptedClient({}) as never });
    const View = half?.settings.mcp as (props: object) => ReactNode;
    const view = await mount(
      createElement(Suspense, { fallback: createElement('p', null, 'loading') }, createElement(View, {})),
    );
    try {
      // The view's module is a real dynamic import, on the disk's and the coverage instrumenter's clock, not the event
      // loop's: one `act` flush (or a few hundred immediates) can end before it arrives. So wait in real time, in
      // `act`, for the fallback to give way to the real settings view (its scripted client has no route).
      await settleUntil(
        () => view.container.textContent !== 'loading',
        'the lazy MCP settings view to replace its fallback',
        callback =>
          interact(async () => void (await Promise.all([callback(), new Promise(done => setTimeout(done, 25))]))),
        160,
      );
      expect(view.container.textContent).toContain('MCP servers');
    } finally {
      await view.unmount();
    }
  });
});
