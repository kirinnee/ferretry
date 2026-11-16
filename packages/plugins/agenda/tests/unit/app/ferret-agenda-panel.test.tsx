/**
 * The `ferret-agenda` panel on `ferret.side`: Agenda's contribution to Ferrets' Info for the ferret it sits beside.
 * The half the shell builds is mounted over a scripted daemon client (every read by route key, as the shell's client
 * does); the panel reads only through that client and the ferret it is handed.
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
  readonly calls: { readonly route: string; readonly params?: Readonly<Record<string, string>> }[];
}

/** A daemon that answers `read` for the ferret's agenda and nothing it was not asked for. */
const daemon = (read: () => unknown): Scripted => {
  const calls: Scripted['calls'][number][] = [];
  return {
    calls,
    call: async (route: string, init?: { readonly params?: Readonly<Record<string, string>> }) => {
      calls.push({ route, ...(init?.params === undefined ? {} : { params: init.params }) });
      if (route === 'GET /v1/ferrets/:ferretId/agenda') return read();
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

/** Where a notification tap lands: the ferret's chat AT the ask. */
const tappedAt = (query: string): void =>
  window.history.replaceState({}, '', `/d/laptop/ferrets/${FERRET}/chat${query}`);

const draw = async (
  client: PluginClient,
  subject: string,
  ready: (root: HTMLElement) => boolean,
): Promise<HTMLElement> => {
  const half = app.build?.({ manifest, client });
  view = await mount(
    createElement(
      RouterProvider,
      null,
      createElement(
        Suspense,
        { fallback: null },
        createElement(half?.panels['ferret-agenda'] as never, { subject } satisfies PanelProps),
      ),
    ),
  );
  const root = view.container;
  await settleUntil(
    () => ready(root),
    () => `the panel did not settle; drew: ${root.textContent ?? ''}`,
    interact,
  );
  return root;
};

describe('the ferret-agenda panel', () => {
  it('is declared on ferret.side and built by the half', () => {
    expect(manifest.ui?.panels?.find(entry => entry.id === 'ferret-agenda')).toMatchObject({ slot: 'ferret.side' });
    expect(Object.keys(app.build?.({ manifest, client: daemon(() => ({})) })?.panels ?? {})).toContain('ferret-agenda');
  });

  it('draws the ask of the ferret it sits beside, read through its own client for that ferret', async () => {
    const client = daemon(() => ({ ...projectionSnapshot(1, 0), sessionId: FERRET }));
    const root = await draw(client, FERRET, node => node.querySelector('[data-agenda-tab-row]') !== null);
    expect(root.querySelector('[data-agenda-tab-failed]')).toBeNull();
    expect(client.calls.find(call => call.route === 'GET /v1/ferrets/:ferretId/agenda')?.params).toEqual({
      ferretId: FERRET,
    });
  });

  it('fails closed on a refusal: it says the read failed and draws no agenda', async () => {
    const client = daemon(() => {
      throw Object.assign(new Error('refused'), { status: 403, code: 'forbidden' });
    });
    const root = await draw(client, FERRET, node => node.querySelector('[data-agenda-tab-failed]') !== null);
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('Couldn’t read this ferret’s agenda');
    expect(root.querySelector('[data-agenda-tab-row], [data-agenda-tab-empty]')).toBeNull();
  });

  describe('B1 a notification tap opens the chat AT the ask (`?ask=`), through the panel the chat mounts', () => {
    const focused = (root: HTMLElement): string[] =>
      [...root.querySelectorAll('[data-agenda-focused]')].map(row => row.getAttribute('data-agenda-row') ?? '');
    const snapshot = () => daemon(() => ({ ...projectionSnapshot(3, 2), sessionId: FERRET }));

    it('rings the row of the ask the address names, and only that one', async () => {
      tappedAt('?ask=A2');
      const root = await draw(snapshot(), FERRET, node => node.querySelector('[data-agenda-tab-row]') !== null);
      expect(focused(root)).toEqual(['A2']);
      expect(root.querySelector('[data-agenda-row="A2"]')?.getAttribute('aria-current')).toBe('true');
      expect(root.querySelector('[data-agenda-row="A1"]')?.getAttribute('aria-current')).toBeNull();
    });

    it('opens the filter the ask sits in: a resolved ask shows under Resolved, not under Needs you', async () => {
      tappedAt('?ask=A4');
      const root = await draw(snapshot(), FERRET, node => node.querySelector('[data-agenda-tab-row]') !== null);
      expect(root.querySelector('[data-agenda-tab]')?.getAttribute('data-agenda-tab')).toBe('resolved');
      expect(focused(root)).toEqual(['A4']);
    });

    it('rings nothing for an ask that is not this ferret’s, for junk, and for no ask', async () => {
      for (const query of ['?ask=A9', '?ask=../x', '?ask=a2', '']) {
        tappedAt(query);
        const root = await draw(snapshot(), FERRET, node => node.querySelector('[data-agenda-tab-row]') !== null);
        expect(focused(root)).toEqual([]);
        expect(root.querySelector('[data-agenda-tab]')?.getAttribute('data-agenda-tab')).toBe('needs-you');
        await view?.unmount();
        view = null;
      }
    });
  });
});
