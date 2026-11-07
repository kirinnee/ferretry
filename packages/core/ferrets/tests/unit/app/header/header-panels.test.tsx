import { afterEach, describe, expect, it } from 'bun:test';
import type { PanelProps } from '@ferretry/kernel/manifest';
import type { ComponentType } from 'react';
import { RouterProvider } from '@ferretry/app/testing';
import { ActionsPanel } from '../../../../app/features/header/actions-panel.tsx';
import { movePath } from '../../../../app/features/header/header-paths.ts';
import { createNamePanel, createStatusPanel } from '../../../../app/views/header.tsx';
import type { LiveFerretsClient } from '../../../../app/lib/client.ts';
import type { FerretSummary } from '../../../../contract/index.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { ferretSummary } from './support.ts';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

class Refused extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

interface Harness {
  readonly client: LiveFerretsClient;
  readonly calls: Array<{ route: string; body: unknown }>;
  ferret: FerretSummary;
  /** Routes that refuse, by key. */
  readonly refuse: Map<string, Error>;
  /** Fires `ferrets.changed` for a ferret. */
  readonly announce: (ferret: string) => void;
}

const harness = (ferret: FerretSummary): Harness => {
  const listeners: Array<(payload: { ferret: string }) => void> = [];
  const state: Harness = {
    calls: [],
    ferret,
    refuse: new Map(),
    announce: id => {
      for (const listener of listeners) listener({ ferret: id });
    },
    client: {
      call: async <Answer = unknown>(route: string, init?: { body?: unknown }): Promise<Answer> => {
        state.calls.push({ route, body: init?.body });
        const refusal = state.refuse.get(route);
        if (refusal !== undefined) throw refusal;
        return state.ferret as Answer;
      },
      subscribe: ((_event: unknown, listener: (payload: { ferret: string }) => void) => {
        listeners.push(listener);
        return () => undefined;
      }) as never,
    },
  };
  return state;
};

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 8; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const click = async (root: ParentNode, selector: string): Promise<void> => {
  await interact(() => must(root.querySelector<HTMLElement>(selector), selector).click());
  await settle();
};

const GET = 'GET /v1/ferrets/:ferretId';

describe('the name and status panels', () => {
  it('draw the task, the callsign beside it and the state as a shape and a word', async () => {
    const h = harness(ferretSummary('a1', { name: 'hadi', title: 'Fix the sign-in', state: 'working' }));
    const Name = createNamePanel(h.client) as ComponentType<PanelProps>;
    const Status = createStatusPanel(h.client) as ComponentType<PanelProps>;
    mounted = await mount(
      <>
        <Name subject="a1" />
        <Status subject="a1" />
      </>,
    );
    await settle();
    const root = mounted.container;
    expect(root.querySelector('h1')?.textContent).toBe('Fix the sign-in');
    expect(root.querySelector('[data-ferret-callsign]')?.textContent).toBe('Hadi');
    expect(root.querySelector('[data-ferret-name]')?.getAttribute('title')).toBe('Fix the sign-in — Hadi');
    expect(root.querySelector('.fy-ferret-status__word')?.textContent).toBe('working');
    expect(root.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('active — working');
    expect(h.calls.every(call => call.route === GET)).toBe(true);
  });

  it('draw nothing when the ferret cannot be read, and read again when the daemon says it changed', async () => {
    const h = harness(ferretSummary('a1', { title: 'Before' }));
    h.refuse.set(GET, new Refused('no such ferret', 404, 'not-found'));
    const Name = createNamePanel(h.client) as ComponentType<PanelProps>;
    mounted = await mount(<Name subject="a1" />);
    await settle();
    expect(mounted.container.querySelector('h1')).toBeNull();
    h.refuse.delete(GET);
    h.ferret = ferretSummary('a1', { title: 'After' });
    h.announce('somebody-else');
    await settle();
    expect(mounted.container.querySelector('h1')).toBeNull();
    h.announce('a1');
    await settle();
    expect(mounted.container.querySelector('h1')?.textContent).toBe('After');
  });
});

describe('the actions panel', () => {
  const open = async (h: Harness, props: Partial<Parameters<typeof ActionsPanel>[0]> = {}): Promise<HTMLElement> => {
    mounted = await mount(
      <RouterProvider>
        <ActionsPanel client={h.client} subject="a1" {...props} />
      </RouterProvider>,
    );
    await settle();
    const root = mounted.container;
    await click(root, '[data-ferret-actions-trigger]');
    return root;
  };
  const writes = (h: Harness): string[] => h.calls.filter(call => call.route !== GET).map(call => call.route);

  it('stops a ferret only after the in-menu confirm, then reads the ferret again', async () => {
    const h = harness(ferretSummary('a1', { name: 'hadi' }));
    const root = await open(h);
    await click(root, '[data-ferret-action-item="stop"]');
    expect(writes(h)).toEqual([]);
    expect(root.textContent).toContain('Stop Hadi?');
    const before = h.calls.length;
    await click(root, '[data-menu-confirm-yes]');
    expect(writes(h)).toEqual(['POST /v1/ferrets/:ferretId/stop']);
    expect(h.calls.slice(before).some(call => call.route === GET)).toBe(true);
  });

  it('says a refusal in words and changes nothing, so a device that may not stop a ferret is told so', async () => {
    const h = harness(ferretSummary('a1', { name: 'hadi' }));
    h.refuse.set('POST /v1/ferrets/:ferretId/stop', new Refused('only the owner may stop a ferret', 403, 'forbidden'));
    const root = await open(h);
    await click(root, '[data-ferret-action-item="stop"]');
    await click(root, '[data-menu-confirm-yes]');
    expect(must(root.querySelector('[data-ferret-alert]'), 'the alert').textContent).toContain(
      'Stop ferret failed: only the owner may stop a ferret',
    );
  });

  it('offers Resume on a stopped ferret, in the bar and in the menu, and not Stop or Restart', async () => {
    const h = harness(ferretSummary('a1', { state: 'stopped' }));
    const root = await open(h);
    expect(root.querySelector('[data-ferret-resume]')).not.toBeNull();
    expect(root.querySelector('[data-ferret-action-item="resume"]')).not.toBeNull();
    expect(root.querySelector('[data-ferret-action-item="stop"]')).toBeNull();
    expect(root.querySelector('[data-ferret-action-item="restart"]')).toBeNull();
    await click(root, '[data-ferret-resume]');
    expect(writes(h)).toEqual(['POST /v1/ferrets/:ferretId/resume']);
  });

  it('offers a read-only connection nothing but Copy ferret id', async () => {
    const h = harness(ferretSummary('a1', { state: 'stopped' }));
    const root = await open(h, { canControl: false });
    const rows = [...root.querySelectorAll('[data-ferret-action-item]')].map(row =>
      row.getAttribute('data-ferret-action-item'),
    );
    expect(rows).toEqual(['copy-id']);
    expect(root.querySelector('[data-ferret-resume]')).toBeNull();
  });

  it('renames through the form with only what changed', async () => {
    const h = harness(ferretSummary('a1', { name: 'hadi', title: 'Fix the gate' }));
    const root = await open(h);
    await click(root, '[data-ferret-action-item="rename"]');
    const inputs = [...root.querySelectorAll<HTMLInputElement>('.fy-action-form__field input')];
    await interact(() => {
      const field = must(inputs[1], 'the task input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, 'Fix the other gate');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await interact(() =>
      must(root.querySelector('form'), 'the form').dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      ),
    );
    await settle();
    const rename = h.calls.find(call => call.route === 'POST /v1/ferrets/:ferretId/rename');
    expect(rename?.body).toEqual({ title: 'Fix the other gate' });
  });

  it('holds a restart the daemon paused, and Start fresh is a separate deliberate press', async () => {
    const h = harness(ferretSummary('a1', { name: 'hadi', runtime: 'nero' }));
    h.refuse.set(
      'POST /v1/ferrets/:ferretId/move',
      new Refused('There is no recorded conversation to resume.', 409, 'conversation_unresumable'),
    );
    const root = await open(h);
    await click(root, '[data-ferret-action-item="restart"]');
    await click(root, '[data-menu-confirm-yes]');
    expect(root.querySelector('[data-restart-unresumable]')).not.toBeNull();
    expect(root.textContent).toContain('There is no recorded conversation to resume.');
    expect(h.calls.filter(call => call.route.endsWith('/move'))).toHaveLength(1);
    h.refuse.clear();
    await click(root, '[data-restart-refusal-anyway]');
    const moves = h.calls.filter(call => call.route.endsWith('/move'));
    expect(moves).toHaveLength(2);
    expect((moves[1]?.body as { conversation?: string } | undefined)?.conversation).toBe('fresh');
    expect(root.querySelector('[data-restart-unresumable]')).toBeNull();
  });

  it('opens the move page of this daemon for Move to another login', async () => {
    const h = harness(ferretSummary('a1', { runtime: 'nero' }));
    window.history.pushState(null, '', '/d/dm1');
    const root = await open(h);
    await click(root, '[data-ferret-action-item="move-login"]');
    expect(window.location.pathname).toBe('/d/dm1/ferrets/a1/move');
    expect(movePath('dm1', 'a b')).toBe('/d/dm1/ferrets/a%20b/move');
  });

  it('says so, instead of going nowhere, when the page has no daemon', async () => {
    const h = harness(ferretSummary('a1', { runtime: 'nero' }));
    window.history.pushState(null, '', '/');
    const root = await open(h);
    await click(root, '[data-ferret-action-item="move-login"]');
    expect(window.location.pathname).toBe('/');
    expect(must(root.querySelector('[data-ferret-alert]'), 'the alert').textContent).toContain('no daemon');
  });
});
