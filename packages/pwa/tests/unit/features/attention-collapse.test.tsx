import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { AttentionItem, AttentionSnapshot } from '@ferretry/protocol';
import { ReferenceSurfaceProvider } from '../../../src/components/reference-surface.tsx';
import {
  ATTENTION_COLLAPSE_KEY,
  type CollapseStorage,
  EMPTY_COLLAPSE_ENTRY,
  readCollapseEntry,
  reconcileCollapse,
  writeCollapseEntry,
} from '../../../src/features/attention/attention-collapse.ts';
import {
  type AttentionActionClient,
  AttentionPanel,
  type AttentionPanelFocus,
  type AttentionPanelProps,
} from '../../../src/features/attention/attention-panel.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { daemonSessionKey, daemonSessionScope } from '../../../src/lib/daemon-scope.ts';
import '../../support/dom.ts';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';

const daemon = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceId: 'token-a' });
const scope = daemonSessionScope(daemon, 'shared');
const otherScope = daemonSessionScope(daemon, 'elsewhere');
const NOW = Date.parse('2026-07-31T12:00:00.000Z');

const item = (id: string, overrides: Partial<AttentionItem> = {}): AttentionItem =>
  ({
    id,
    source: 'agent-raised',
    sourceRef: null,
    subject: `Ask ${id}`,
    why: `Why ${id} matters.`,
    waitingSince: '2026-07-31T11:30:00.000Z',
    howToResolve: 'Answer it.',
    ask: { kind: 'permission' },
    raisedBy: 'agent',
    raisedBySession: 'shared',
    raisedByName: 'zoe',
    ...overrides,
  }) as AttentionItem;

const board = (items: readonly AttentionItem[]): AttentionSnapshot => ({
  v: 1,
  sessionId: 'shared',
  items: [...items],
  resolved: [],
  count: items.length,
  parseErrors: 0,
  updatedAt: '2026-07-31T12:00:00.000Z',
});

const calls: string[] = [];
const silentClient: AttentionActionClient = {
  respond: async () => void calls.push('respond'),
  resolve: async () => void calls.push('resolve'),
  dismiss: async () => void calls.push('dismiss'),
  needsInfo: async () => void calls.push('needs-info'),
  progress: async () => void calls.push('progress'),
};

const panel = (props: Partial<AttentionPanelProps> = {}) => (
  <ReferenceSurfaceProvider surface={{}}>
    <AttentionPanel
      client={silentClient}
      connection={daemon}
      id="attn"
      now={NOW}
      onSelect={() => undefined}
      scope={scope}
      selectedId={null}
      snapshot={board([item('A3')])}
      status="ready"
      {...props}
    />
  </ReferenceSurfaceProvider>
);

const foldButton = (root: ParentNode): HTMLButtonElement | null =>
  root.querySelector<HTMLButtonElement>('[data-attention-collapse]');
const foldedLine = (root: ParentNode): HTMLButtonElement | null =>
  root.querySelector<HTMLButtonElement>('[data-attention-collapsed]');
const click = (button: HTMLElement | null, what: string) => interact(() => must(button, what).click());
const stored = (key = daemonSessionKey(scope)) => {
  const document = JSON.parse(localStorage.getItem(ATTENTION_COLLAPSE_KEY) ?? 'null') as {
    conversations: Record<string, { collapsed: boolean; seen: string[] }>;
  } | null;
  return document?.conversations[key];
};

let view: Mounted | null = null;

beforeEach(() => {
  calls.length = 0;
  localStorage.clear();
});

afterEach(async () => {
  await view?.unmount();
  view = null;
  localStorage.clear();
});

describe('the fold of one conversation (model)', () => {
  test('an id the entry has not seen unfolds it and is remembered; the same ids change nothing', () => {
    const folded = { collapsed: true, seen: ['A1'] };
    expect(reconcileCollapse(folded, ['A1'])).toBe(folded);
    expect(reconcileCollapse(folded, ['A1', 'A2'])).toEqual({ collapsed: false, seen: ['A1', 'A2'] });
  });

  test('an id that is no longer open is forgotten without unfolding anything', () => {
    expect(reconcileCollapse({ collapsed: true, seen: ['A1', 'A2'] }, ['A2'])).toEqual({
      collapsed: true,
      seen: ['A2'],
    });
  });

  test('storage that is missing, damaged or full is an ordinary condition', () => {
    expect(readCollapseEntry(undefined, 'k')).toBe(EMPTY_COLLAPSE_ENTRY);
    const damaged: CollapseStorage = { getItem: () => '{not json', setItem: () => undefined };
    expect(readCollapseEntry(damaged, 'k')).toBe(EMPTY_COLLAPSE_ENTRY);
    const wrongVersion: CollapseStorage = { getItem: () => '{"v":9,"conversations":{}}', setItem: () => undefined };
    expect(readCollapseEntry(wrongVersion, 'k')).toBe(EMPTY_COLLAPSE_ENTRY);
    const refusing: CollapseStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(writeCollapseEntry(refusing, 'k', { collapsed: true, seen: [] })).toBe(false);
    expect(writeCollapseEntry(undefined, 'k', { collapsed: true, seen: [] })).toBe(false);
  });

  test('conversations are kept apart and only the most recent are remembered', () => {
    const memory = new Map<string, string>();
    const storage: CollapseStorage = {
      getItem: key => memory.get(key) ?? null,
      setItem: (key, value) => void memory.set(key, value),
    };
    for (let at = 0; at < 70; at += 1) writeCollapseEntry(storage, `c${at}`, { collapsed: true, seen: [`A${at}`] });
    expect(readCollapseEntry(storage, 'c69')).toEqual({ collapsed: true, seen: ['A69'] });
    expect(readCollapseEntry(storage, 'c0')).toBe(EMPTY_COLLAPSE_ENTRY);
  });
});

describe('the pinned Attention card folds to one line', () => {
  test('the expanded header carries a keyboard-reachable fold button that says it is expanded', async () => {
    view = await mount(panel());
    const button = must(foldButton(view.container), 'the fold button');
    expect(button.tagName).toBe('BUTTON');
    expect(button.type).toBe('button');
    expect(button.tabIndex).not.toBe(-1);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-label')).toBe('Fold this card');
    expect(button.getAttribute('aria-controls')).toBe('attn');
    expect(button.closest('header')).not.toBeNull();
    expect(foldedLine(view.container)).toBeNull();
  });

  test('folding leaves one line naming the current item and how many more, and tells the ferret nothing', async () => {
    const items = [item('A3', { title: 'Approve the deploy' }), item('A4'), item('A5')];
    view = await mount(panel({ snapshot: board(items) }));
    await click(foldButton(view.container), 'the fold button');

    const line = must(foldedLine(view.container), 'the folded line');
    expect(line.tagName).toBe('BUTTON');
    expect(line.getAttribute('aria-expanded')).toBe('false');
    expect(line.getAttribute('aria-controls')).toBe('attn');
    expect(line.textContent).toBe('Needs you·Approve the deploy·2 more›');
    expect(view.container.querySelector('[data-attention-card]')).toBeNull();
    expect(calls).toEqual([]);
  });

  test('a lone item says no "more"', async () => {
    view = await mount(panel({ snapshot: board([item('A3', { title: 'Approve the deploy' })]) }));
    await click(foldButton(view.container), 'the fold button');
    expect(foldedLine(view.container)?.textContent).toBe('Needs you·Approve the deploy›');
  });

  test('the line names the item the reader was on, not the first', async () => {
    const items = [item('A3', { title: 'First' }), item('A4', { title: 'Second' })];
    view = await mount(panel({ snapshot: board(items), selectedId: 'A4' }));
    await click(foldButton(view.container), 'the fold button');
    expect(foldedLine(view.container)?.textContent).toContain('Second');
    expect(foldedLine(view.container)?.textContent).toContain('1 more');
  });

  test('pressing the line unfolds the card again', async () => {
    view = await mount(panel());
    await click(foldButton(view.container), 'the fold button');
    await click(foldedLine(view.container), 'the folded line');
    expect(foldedLine(view.container)).toBeNull();
    expect(view.container.querySelector('[data-attention-card="A3"]')).not.toBeNull();
    expect(stored()?.collapsed).toBe(false);
  });

  test('the item arrows still work while expanded, and the fold changes no item', async () => {
    const picked: string[] = [];
    view = await mount(panel({ snapshot: board([item('A3'), item('A4')]), onSelect: id => picked.push(id) }));
    await click(view.container.querySelector<HTMLElement>('button[aria-label="Next item"]'), 'the next-item arrow');
    expect(picked).toEqual(['A4']);
    await click(foldButton(view.container), 'the fold button');
    await click(foldedLine(view.container), 'the folded line');
    expect(calls).toEqual([]);
  });
});

describe('the fold is remembered per device and per conversation', () => {
  test('it is written under the conversation and survives a reload', async () => {
    view = await mount(panel({ snapshot: board([item('A3'), item('A4')]) }));
    await click(foldButton(view.container), 'the fold button');
    expect(stored()).toEqual({ collapsed: true, seen: ['A3', 'A4'] });

    await view.unmount();
    view = await mount(panel({ snapshot: board([item('A3'), item('A4')]) }));
    expect(foldedLine(view.container)).not.toBeNull();
    expect(view.container.querySelector('[data-attention-card]')).toBeNull();
  });

  test('a reload that is still waiting for the board does not decide anything', async () => {
    writeCollapseEntry(localStorage, daemonSessionKey(scope), { collapsed: true, seen: ['A3'] });
    view = await mount(panel({ snapshot: null, status: 'loading' }));
    expect(foldedLine(view.container)).toBeNull();
    await view.render(panel({ snapshot: board([item('A3')]) }));
    expect(foldedLine(view.container)).not.toBeNull();
  });

  test('another conversation is not folded by this one', async () => {
    view = await mount(panel());
    await click(foldButton(view.container), 'the fold button');
    await view.unmount();

    view = await mount(panel({ scope: otherScope, snapshot: board([item('A3')]) }));
    expect(foldedLine(view.container)).toBeNull();
    expect(foldButton(view.container)).not.toBeNull();
    expect(stored(daemonSessionKey(otherScope))?.collapsed).toBe(false);
  });

  test('a refused write still folds for the rest of the tab', async () => {
    const refuse = spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      view = await mount(panel());
      await click(foldButton(view.container), 'the fold button');
      expect(foldedLine(view.container)).not.toBeNull();
    } finally {
      refuse.mockRestore();
    }
  });

  test("switching conversation in place shows that conversation's own fold", async () => {
    view = await mount(panel());
    await click(foldButton(view.container), 'the fold button');
    expect(foldedLine(view.container)).not.toBeNull();

    await view.render(panel({ scope: otherScope }));
    expect(foldedLine(view.container)).toBeNull();
    expect(foldButton(view.container)).not.toBeNull();

    await view.render(panel({ scope }));
    expect(foldedLine(view.container)).not.toBeNull();
  });

  for (const [what, define] of [
    ['absent', { value: undefined, configurable: true }],
    [
      'refusing to be read',
      {
        configurable: true,
        get: () => {
          throw new Error('SecurityError');
        },
      },
    ],
  ] as const) {
    test(`browser storage that is ${what} still folds for the rest of the tab`, async () => {
      const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
      Object.defineProperty(globalThis, 'localStorage', define);
      try {
        view = await mount(panel());
        await click(foldButton(view.container), 'the fold button');
        expect(foldedLine(view.container)).not.toBeNull();
      } finally {
        if (original) Object.defineProperty(globalThis, 'localStorage', original);
      }
    });
  }
});

describe('only an item it has not seen unfolds it', () => {
  const folded = async (items: readonly AttentionItem[]) => {
    view = await mount(panel({ snapshot: board(items) }));
    await click(foldButton(view.container), 'the fold button');
    expect(foldedLine(view.container)).not.toBeNull();
    return view;
  };

  test('a re-render, or the same board read again, leaves it folded', async () => {
    const mounted = await folded([item('A3'), item('A4')]);
    await mounted.render(panel({ snapshot: board([item('A3'), item('A4')]) }));
    await mounted.render(panel({ snapshot: board([item('A3'), item('A4')]), now: NOW + 60_000 }));
    expect(foldedLine(mounted.container)).not.toBeNull();
    expect(stored()?.collapsed).toBe(true);
  });

  test('an item being answered elsewhere leaves it folded on the one that remains', async () => {
    const mounted = await folded([item('A3'), item('A4')]);
    await mounted.render(panel({ snapshot: board([item('A4')]) }));
    expect(foldedLine(mounted.container)?.textContent).toContain('Ask A4');
    expect(stored()).toEqual({ collapsed: true, seen: ['A4'] });
  });

  test('a new id unfolds it at once and the unfolded state is remembered', async () => {
    const mounted = await folded([item('A3')]);
    await mounted.render(panel({ snapshot: board([item('A3'), item('A5')]) }));
    expect(foldedLine(mounted.container)).toBeNull();
    expect(mounted.container.querySelector('[data-attention-card="A3"]')).not.toBeNull();
    expect(stored()).toEqual({ collapsed: false, seen: ['A3', 'A5'] });
  });

  test('a new id arriving while the page was closed unfolds it on the next open', async () => {
    const mounted = await folded([item('A3')]);
    await mounted.unmount();
    view = await mount(panel({ snapshot: board([item('A3'), item('A9')]) }));
    expect(foldedLine(view.container)).toBeNull();
    expect(mounted.container.isConnected).toBe(false);
  });

  test('once unfolded by a new id, folding again keeps both seen', async () => {
    const mounted = await folded([item('A3')]);
    await mounted.render(panel({ snapshot: board([item('A3'), item('A5')]) }));
    await click(foldButton(mounted.container), 'the fold button');
    await mounted.render(panel({ snapshot: board([item('A3'), item('A5')]) }));
    expect(foldedLine(mounted.container)).not.toBeNull();
  });
});

describe('the fold and the rest of the conversation', () => {
  test('a link to an open item unfolds the card and rings that item', async () => {
    const items = [item('A3'), item('A4')];
    const selected: string[] = [];
    view = await mount(panel({ snapshot: board(items), onSelect: id => selected.push(id) }));
    await click(foldButton(view.container), 'the fold button');

    const focus: AttentionPanelFocus = { target: 'A4', seq: 1 };
    await view.render(panel({ snapshot: board(items), onSelect: id => selected.push(id), focus }));
    expect(foldedLine(view.container)).toBeNull();
    expect(selected).toEqual(['A4']);
  });

  test('a link to an item that is not open does not unfold the card', async () => {
    view = await mount(panel());
    await click(foldButton(view.container), 'the fold button');
    await view.render(panel({ focus: { target: 'A9', seq: 1 } }));
    expect(foldedLine(view.container)).not.toBeNull();
  });

  test('folded means the next message is not offered as the answer; unfolded offers it again', async () => {
    const seen: boolean[] = [];
    const chip = { on: true, onChange: (on: boolean) => seen.push(on) };
    view = await mount(panel({ chip }));
    expect(seen).toEqual([]);
    await click(foldButton(view.container), 'the fold button');
    expect(seen).toEqual([false]);
    await click(foldedLine(view.container), 'the folded line');
    expect(seen).toEqual([false, true]);
  });

  test('an answer being held for the machine stays visible while folded', async () => {
    view = await mount(panel({ repliesSlot: <p data-testid="held">Sending in 8 s…</p> }));
    await click(foldButton(view.container), 'the fold button');
    expect(view.container.querySelector('[data-testid="held"]')?.textContent).toBe('Sending in 8 s…');
  });

  test('a board with nothing open draws nothing, folded or not', async () => {
    writeCollapseEntry(localStorage, daemonSessionKey(scope), { collapsed: true, seen: ['A3'] });
    view = await mount(panel({ snapshot: board([]) }));
    expect(view.container.querySelector('[data-attention-panel]')).toBeNull();
  });
});
