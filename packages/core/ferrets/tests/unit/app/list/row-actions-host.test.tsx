import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { PanelSlot } from '@ferretry/app';
import { RouterProvider } from '@ferretry/app/testing';
import { ACTIONS_ROW_SLOT, type ActionsRowOffer, type ActionsRowSlotProps } from '@ferretry/core-ferrets/contract';
import type { ReactElement } from 'react';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { ActionsPanel } from '../../../../app/features/header/actions-panel.tsx';
import {
  FerretRowActionsHost,
  type FerretRowActionsHostProps,
} from '../../../../app/features/list/row-actions-host.tsx';
import type { LiveFerretsClient } from '../../../../app/lib/client.ts';
import type { FerretSummary } from '../../../../contract/index.ts';
import { ferretSummary } from '../header/support.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { render, run, runAsync } from '../support/react.ts';

let mounted: Mounted | undefined;
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  renderer = undefined;
});
beforeEach(() => window.history.pushState(null, '', '/d/dm1'));

const STOP = 'POST /v1/ferrets/:ferretId/stop';

interface Harness {
  readonly client: LiveFerretsClient;
  readonly calls: string[];
  readonly refuse: Map<string, Error>;
}

const harness = (): Harness => {
  const state: Harness = {
    calls: [],
    refuse: new Map(),
    client: {
      call: async <Answer = unknown>(route: string): Promise<Answer> => {
        state.calls.push(route);
        const refusal = state.refuse.get(route);
        if (refusal !== undefined) throw refusal;
        return undefined as Answer;
      },
    },
  };
  return state;
};

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 8; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const ferretA: FerretSummary = ferretSummary('a1', { name: 'hadi' });
const ferretB: FerretSummary = ferretSummary('b2', { name: 'marin' });

const hostProps = (h: Harness, overrides: Partial<FerretRowActionsHostProps> = {}): FerretRowActionsHostProps => ({
  client: h.client,
  ferret: ferretA,
  anchor: { x: 40, y: 50 },
  touch: false,
  open: true,
  onClose: () => undefined,
  ...overrides,
});

const inRouter = (element: ReactElement): ReactElement => <RouterProvider>{element}</RouterProvider>;

const mountHost = async (props: FerretRowActionsHostProps): Promise<HTMLElement> => {
  mounted = await mount(inRouter(<FerretRowActionsHost {...props} />));
  await settle();
  return mounted.container;
};

const items = (root: ParentNode): string[] =>
  [...root.querySelectorAll('[data-ferret-action-item]')].map(
    item => item.getAttribute('data-ferret-action-item') ?? '',
  );

const click = async (root: ParentNode, selector: string): Promise<void> => {
  await interact(() => must(root.querySelector<HTMLElement>(selector), selector).click());
  await settle();
};

// ─── the slot, read without a shell: the host is rendered as a tree and the PanelSlot it mounts is read for its props ──

const slotOf = (tree: ReactTestRenderer): ReactTestInstance => tree.root.findByType(PanelSlot);
const offeredTo = (tree: ReactTestRenderer): ActionsRowSlotProps => slotOf(tree).props.props as ActionsRowSlotProps;
const rowItems = (tree: ReactTestRenderer): string[] =>
  tree.root
    .findAll(node => typeof node.type === 'string' && node.props['data-ferret-action-item'] !== undefined)
    .map(node => String(node.props['data-ferret-action-item']));

const runRow = (id: string, ran: string[]): ActionsRowOffer => ({
  kind: 'run',
  id,
  label: `Do ${id}`,
  group: 'ferret',
  order: 50,
  run: () => {
    ran.push(id);
  },
});
const confirmRow = (id: string, ran: string[]): ActionsRowOffer => ({
  kind: 'confirm',
  id,
  label: `Wipe ${id}`,
  group: 'danger',
  order: 50,
  question: `Wipe ${id}?`,
  consequence: 'It cannot be undone.',
  confirmLabel: `Wipe ${id}`,
  danger: true,
  run: () => {
    ran.push(id);
  },
});

describe('the row actions host', () => {
  it('the row menu mounts ferrets.actions-row for the pressed ferret and draws an offered row', async () => {
    const h = harness();
    renderer = render(inRouter(<FerretRowActionsHost {...hostProps(h)} />));
    const slot = slotOf(renderer);
    expect(slot.props.slot).toBe(ACTIONS_ROW_SLOT);
    expect(slot.props.daemon).toBe('dm1');
    expect(offeredTo(renderer)).toMatchObject({ ferret: 'a1', name: 'Hadi', canControl: true });

    const ran: string[] = [];
    run(() => offeredTo(renderer as ReactTestRenderer).offer('mcp-add', runRow('mcp-add', ran)));
    run(() => offeredTo(renderer as ReactTestRenderer).offer('wipe', confirmRow('wipe', ran)));
    expect(rowItems(renderer)).toContain('mcp-add');
    expect(rowItems(renderer)).toContain('wipe');

    const doIt = renderer.root.findByProps({ 'data-ferret-action-item': 'mcp-add' });
    await runAsync(async () => doIt.props.onClick());
    expect(ran).toEqual(['mcp-add']);

    run(() => renderer?.root.findByProps({ 'data-ferret-action-item': 'wipe' }).props.onClick());
    const confirm = renderer.root.findByProps({ 'data-menu-confirm': 'wipe' });
    expect(confirm.props['aria-label']).toBe('Wipe wipe?');
    expect(ran).toEqual(['mcp-add']);
    await runAsync(async () => renderer?.root.findByProps({ 'data-menu-confirm-yes': '' }).props.onClick());
    expect(ran).toEqual(['mcp-add', 'wipe']);

    run(() => offeredTo(renderer as ReactTestRenderer).offer('mcp-add', null));
    expect(rowItems(renderer)).not.toContain('mcp-add');
  });

  it('press A then B: only B’s offered rows', () => {
    const h = harness();
    const props = (ferret: FerretSummary): ReactElement =>
      inRouter(<FerretRowActionsHost key={ferret.id} {...hostProps(h, { ferret })} />);
    renderer = render(props(ferretA));
    run(() => offeredTo(renderer as ReactTestRenderer).offer('a-only', runRow('a-only', [])));
    expect(rowItems(renderer)).toContain('a-only');

    // The provider keys the host by the pressed ferret, so pressing B remounts it: A's contributor goes with it.
    run(() => renderer?.update(props(ferretB)));
    expect(offeredTo(renderer)).toMatchObject({ ferret: 'b2', name: 'Marin' });
    expect(rowItems(renderer)).not.toContain('a-only');
    run(() => offeredTo(renderer as ReactTestRenderer).offer('b-only', runRow('b-only', [])));
    expect(rowItems(renderer)).toContain('b-only');
    expect(rowItems(renderer)).not.toContain('a-only');
  });

  it('a contributor’s dialog outlives the menu: closing keeps the slot mounted with what it offered', () => {
    const h = harness();
    const closes: boolean[] = [];
    const props = (open: boolean): ReactElement =>
      inRouter(<FerretRowActionsHost {...hostProps(h, { open, onClose: () => closes.push(true) })} />);
    renderer = render(props(true));
    const before = slotOf(renderer);
    run(() => offeredTo(renderer as ReactTestRenderer).offer('mcp-add', runRow('mcp-add', [])));
    expect(rowItems(renderer)).toContain('mcp-add');

    run(() => renderer?.update(props(false)));
    expect(rowItems(renderer)).toEqual([]);
    expect(slotOf(renderer)).toBe(before);
    expect(offeredTo(renderer)).toMatchObject({ ferret: 'a1' });

    run(() => renderer?.update(props(true)));
    expect(rowItems(renderer)).toContain('mcp-add');
  });

  it('draws no slot when the page has no daemon', async () => {
    window.history.pushState(null, '', '/');
    const h = harness();
    renderer = render(inRouter(<FerretRowActionsHost {...hostProps(h)} />));
    expect(renderer.root.findAllByType(PanelSlot)).toHaveLength(0);
  });

  it('Open and Copy name are the row’s own; the core rows match the header’s for the same ferret', async () => {
    const h = harness();
    const stopped = ferretSummary('a1', { name: 'hadi', state: 'stopped', runtime: 'nero', pinnedAt: undefined });
    const rowRoot = await mountHost(hostProps(h, { ferret: stopped }));
    const rowIds = items(rowRoot);
    expect(rowIds).toContain('open');
    expect(rowIds).toContain('copy-name');
    expect(rowIds[0]).toBe('open');
    await mounted?.unmount();

    const headerClient: LiveFerretsClient = {
      call: async <Answer = unknown>(): Promise<Answer> => stopped as unknown as Answer,
    };
    mounted = await mount(inRouter(<ActionsPanel client={headerClient} subject="a1" />));
    await settle();
    await click(mounted.container, '[data-ferret-actions-trigger]');
    const headerIds = items(mounted.container);
    expect(headerIds.length).toBeGreaterThan(3);
    expect(headerIds).not.toContain('open');
    expect(headerIds).not.toContain('copy-name');
    expect(rowIds.filter(id => id !== 'open' && id !== 'copy-name')).toEqual(headerIds);
  });

  it('Open goes to the ferret’s chat and Copy name copies the callsign, not the id', async () => {
    const written: string[] = [];
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          written.push(text);
        },
      },
    });
    const h = harness();
    const closes: boolean[] = [];
    const root = await mountHost(hostProps(h, { onClose: () => closes.push(true) }));
    await click(root, '[data-ferret-action-item="copy-name"]');
    expect(written).toEqual(['Hadi']);
    expect(closes).toEqual([true]);

    await mounted?.unmount();
    const rootAgain = await mountHost(hostProps(h));
    await click(rootAgain, '[data-ferret-action-item="open"]');
    expect(window.location.pathname).toBe('/d/dm1/ferrets/a1/chat');
  });

  it('says so when Copy name is blocked, and when Open has no daemon to go to', async () => {
    Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: undefined });
    const h = harness();
    const root = await mountHost(hostProps(h));
    await click(root, '[data-ferret-action-item="copy-name"]');
    expect(must(root.querySelector('[data-ferret-alert]'), 'the alert').textContent).toContain(
      'Copying the name was blocked',
    );

    await mounted?.unmount();
    window.history.pushState(null, '', '/');
    const lost = await mountHost(hostProps(h));
    await click(lost, '[data-ferret-action-item="open"]');
    expect(window.location.pathname).toBe('/');
    expect(must(lost.querySelector('[data-ferret-alert]'), 'the alert').textContent).toContain('no daemon');
  });

  it('a 403 from Stop shows the alert line, not a crash', async () => {
    const h = harness();
    h.refuse.set(
      STOP,
      Object.assign(new Error('only the owner may stop a ferret'), { status: 403, code: 'forbidden' }),
    );
    const closes: boolean[] = [];
    const root = await mountHost(hostProps(h, { onClose: () => closes.push(true) }));
    await click(root, '[data-ferret-action-item="stop"]');
    expect(h.calls).toEqual([]);
    await click(root, '[data-menu-confirm-yes]');
    expect(h.calls).toEqual([STOP]);
    const alert = must(root.querySelector('[data-ferret-alert]'), 'the alert');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain('only the owner may stop a ferret');
    expect(closes).toEqual([true]);
  });

  it('hands focus back to the row only when asked, and closes either way', async () => {
    const h = harness();
    const focused: boolean[] = [];
    const closes: boolean[] = [];
    const root = await mountHost(
      hostProps(h, {
        focusRow: () => {
          focused.push(true);
          return true;
        },
        onClose: () => closes.push(true),
      }),
    );
    await interact(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(focused).toEqual([true]);
    expect(closes).toEqual([true]);
    await interact(() => root.ownerDocument.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    // A press outside leaves focus where the press put it.
    expect(focused).toEqual([true]);
    expect(closes).toEqual([true, true]);
  });
});
