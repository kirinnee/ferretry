import { describe, expect, it } from 'bun:test';
import { interact, noteClientDaemon, RouterProvider, settleUntil } from '@ferretry/app/testing';
import { ScreenHrefProvider } from '@ferretry/app';
import { SKILLS_ADD_SLOT } from '@ferretry/plugin-skills/contract';
import { type FunctionComponent, Suspense } from 'react';
import half from '../../../../app/index.ts';
import { placeQuery, readPlace } from '../../../../app/lib/add-skills-address.ts';
import manifest from '../../../../manifest.ts';
import { click, settle } from '../support/dom-form.ts';
import { mount } from '@ferretry/app/testing';

const props = {
  ferret: 'f1',
  folder: '/work/app',
  harness: 'codex' as const,
  runtime: 'box',
  scopes: ['project', 'user'],
};

describe('S-0388 Catalogs declares the Add skills screen and contributes the way in to Skills’ slot', () => {
  it('declares the screen under a ferret, and one panel in skills.add', () => {
    expect(manifest.ui?.screens?.find(screen => screen.id === 'add-skills')?.path).toBe('ferrets/:ferret/add-skills');
    expect(manifest.ui?.panels).toEqual([{ slot: SKILLS_ADD_SLOT, id: 'add-skills', order: 10 }] as never);
    const built = half.build?.({ manifest: half.manifest, client: { call: async () => ({}) } as never });
    expect(Object.keys(built?.panels ?? {})).toEqual(['add-skills']);
  });
});

describe('S-0304 the way in carries where the ferret is', () => {
  it('writes the place into the query and reads the same place back', () => {
    expect(readPlace(placeQuery(props))).toEqual({
      cwd: '/work/app',
      harness: 'codex',
      runtime: 'box',
      scopes: ['project', 'user'],
    });
    expect(readPlace(placeQuery({ ...props, runtime: undefined, scopes: [] }))).toEqual({
      cwd: '/work/app',
      harness: 'codex',
      runtime: undefined,
      scopes: [],
    });
    expect(readPlace('')).toEqual({ cwd: undefined, harness: 'claude', runtime: undefined, scopes: [] });
  });

  it('draws “+ Add skills” in the slot and goes to the page with the place', async () => {
    const client = { call: async () => ({}) } as never;
    noteClientDaemon(client, 'alpha');
    const built = half.build?.({ manifest: half.manifest, client });
    const Panel = built?.panels?.['add-skills'] as unknown as FunctionComponent<Record<string, unknown>>;
    const view = await mount(
      <RouterProvider>
        <Suspense fallback={null}>
          <ScreenHrefProvider
            href={(daemon, plugin, screen, params) => `/d/${daemon}/${plugin}/${screen}/${params?.ferret}`}
          >
            <Panel {...props} subject="f1" />
          </ScreenHrefProvider>
        </Suspense>
      </RouterProvider>,
    );
    await settleUntil(() => document.querySelector('[data-context-add-skills]') !== null, 'the button', interact);
    const button = document.querySelector('[data-context-add-skills]');
    expect(button?.textContent).toBe('+ Add skills');
    await click(button);
    await settle();
    expect(`${globalThis.location.pathname}${globalThis.location.search}`).toBe(
      `/d/alpha/catalogs/add-skills/f1${placeQuery(props)}`,
    );
    await view.unmount();
  });

  it('draws nothing for props that are not the slot’s, or when no screen has that address', async () => {
    const client = { call: async () => ({}) } as never;
    noteClientDaemon(client, 'alpha');
    const built = half.build?.({ manifest: half.manifest, client });
    const Panel = built?.panels?.['add-skills'] as unknown as FunctionComponent<Record<string, unknown>>;
    const view = await mount(
      <RouterProvider>
        <Suspense fallback={null}>
          <Panel subject="f1" />
          <Panel {...props} />
        </Suspense>
      </RouterProvider>,
    );
    await settle();
    await settle();
    expect(document.querySelector('[data-context-add-skills]')).toBeNull();
    await view.unmount();
  });
});

describe('S-0262 the screen draws the page for the ferret in its address, with this machine’s name', () => {
  it('reads the place from the address, lists the subscriptions and goes back to the ferret’s chat', async () => {
    const { createAddSkillsScreen } = await import('../../../../app/views/add-skills-views.tsx');
    const client = { call: async () => ({}), request: async () => ({ installs: [] }) } as never;
    noteClientDaemon(client, 'alpha');
    const Screen = createAddSkillsScreen(
      client,
      () => placeQuery(props),
      () => ({ list: async () => [], browse: async () => ({ kind: 'refused' }) }) as never,
    ) as unknown as FunctionComponent<{ params: Record<string, string> }>;
    const view = await mount(
      <RouterProvider>
        <ScreenHrefProvider
          href={(daemon, plugin, screen, params) => `/d/${daemon}/${plugin}/${screen}/${params?.ferret}`}
        >
          <Screen params={{ ferret: 'f1' }} />
        </ScreenHrefProvider>
      </RouterProvider>,
    );
    await settleUntil(() => document.querySelector('[data-add-skills-empty]') !== null, 'the page', interact);
    expect(document.querySelector('h1')?.textContent).toBe('Add skills');
    await click(document.querySelector('[data-add-skills-back]'));
    expect(globalThis.location.pathname).toBe('/d/alpha/conversation/chat/f1');
    await click(document.querySelector('[data-add-skills-subscribe]'));
    expect(globalThis.location.pathname).toBe('/d/alpha/sharing/shared');
    await view.unmount();
  });
});
