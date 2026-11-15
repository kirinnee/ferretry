/**
 * The `ferret-agenda-line` panel in Conversation's `conversation.above-composer` slot: the agenda line above the composer
 * and the drawer its pill opens, for the ferret whose chat this is. The half the shell builds is mounted over a scripted
 * daemon client (every read by route key); the panel reads only through that client and the ferret it is handed.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { ensureDom, interact, type Mounted, mount, RouterProvider, settleUntil } from '@ferretry/app/testing';
import type { PanelProps, PluginClient } from '@ferretry/kernel/manifest';
import { createElement, Suspense } from 'react';
import app from '../../../app/index.ts';
import manifest from '../../../manifest.ts';
import { projectionSnapshot } from '../../support/app/agenda-projection.ts';

ensureDom();

const FERRET = 'session';

interface Scripted extends PluginClient {
  readonly calls: string[];
}

/** A daemon with the ferret's agenda (`open` asks), its agenda-mode switch and no other ferrets. */
const daemon = (options: { readonly mode: boolean | 'refused'; readonly open?: number }): Scripted => {
  const calls: string[] = [];
  return {
    calls,
    call: async (route: string) => {
      calls.push(route);
      if (route === 'GET /v1/ferrets/:ferretId/agenda')
        return { ...projectionSnapshot(options.open ?? 2, 0), sessionId: FERRET };
      if (route === 'GET /v1/ferrets/:ferretId/agenda-mode') {
        if (options.mode === 'refused') throw Object.assign(new Error('refused'), { status: 403, code: 'forbidden' });
        return { enabled: options.mode, restartRequired: false, note: 'Takes effect at the next launch.' };
      }
      if (route === 'GET /v1/ferrets') return [];
      throw new Error(`no route ${route}`);
    },
    subscribe: () => () => undefined,
  } as unknown as Scripted;
};

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  window.history.replaceState({}, '', '/');
});

const draw = async (client: PluginClient, subject: string | undefined): Promise<HTMLElement> => {
  const half = app.build?.({ manifest, client });
  view = await mount(
    createElement(
      RouterProvider,
      null,
      createElement(
        Suspense,
        { fallback: null },
        createElement(half?.panels['ferret-agenda-line'] as never, { subject } satisfies PanelProps),
      ),
    ),
  );
  return view.container;
};

const settled = (client: Scripted, root: HTMLElement): Promise<unknown> =>
  settleUntil(
    () => client.calls.includes('GET /v1/ferrets/:ferretId/agenda-mode'),
    () => `the panel never read the mode; drew: ${root.textContent ?? ''}`,
    interact,
  );

describe('the ferret-agenda-line panel', () => {
  it('is declared in the conversation.above-composer slot and built by the half', () => {
    expect(manifest.ui?.panels?.find(entry => entry.id === 'ferret-agenda-line')).toMatchObject({
      slot: 'conversation.above-composer',
    });
    expect(Object.keys(app.build?.({ manifest, client: daemon({ mode: true }) })?.panels ?? {})).toContain(
      'ferret-agenda-line',
    );
  });

  it('draws the line for a ferret in agenda mode, counting what needs the owner', async () => {
    const client = daemon({ mode: true, open: 2 });
    const root = await draw(client, FERRET);
    await settleUntil(
      () => root.querySelector('[data-agenda-line]') !== null,
      () => `no line; drew: ${root.textContent ?? ''}`,
      interact,
    );
    expect(root.querySelector('[data-agenda-line]')?.textContent).toContain('2');
    expect(root.querySelector('[data-agenda-line]')?.textContent).toContain('need you');
  });

  it('opens the drawer from the pill and takes a tapped row to the ask page, never an overlay of its own', async () => {
    const client = daemon({ mode: true, open: 2 });
    const root = await draw(client, FERRET);
    await settleUntil(
      () => root.querySelector('[data-agenda-line-toggle]') !== null,
      () => `no pill; drew: ${root.textContent ?? ''}`,
      interact,
    );
    await interact(() => (root.querySelector('[data-agenda-line-toggle]') as HTMLButtonElement).click());
    expect(root.querySelector('[data-agenda-drawer]')).not.toBeNull();
    await interact(() => (root.querySelector('[data-agenda-row="A2"]') as HTMLButtonElement).click());
    expect(window.location.pathname).toContain(`/agenda/${FERRET}/A2`);
    expect(root.querySelector('[data-agenda-drawer]')).toBeNull();
    expect(root.querySelector('[role="dialog"]')).toBeNull();
  });

  it('draws no line while the ferret is not in agenda mode', async () => {
    const client = daemon({ mode: false });
    const root = await draw(client, FERRET);
    await settled(client, root);
    expect(root.querySelector('[data-agenda-line]')).toBeNull();
  });

  it('draws no line when the mode cannot be read: it never draws what it cannot back', async () => {
    const client = daemon({ mode: 'refused' });
    const root = await draw(client, FERRET);
    await settled(client, root);
    expect(root.querySelector('[data-agenda-line]')).toBeNull();
  });

  it('draws nothing and reads nothing without a ferret', async () => {
    const client = daemon({ mode: true });
    const root = await draw(client, undefined);
    expect(root.textContent).toBe('');
    expect(client.calls).toEqual([]);
  });
});
