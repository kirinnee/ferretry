import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AttentionItem, AttentionSnapshot, ResolvedAttentionItem } from '@ferretry/protocol';
import { ReferenceSurfaceProvider } from '../../../src/components/reference-surface.tsx';
import {
  type AttentionActionClient,
  AttentionPanel,
  type AttentionPanelFocus,
  type AttentionPanelProps,
  attentionLedgerIds,
  attentionPanelItemId,
  locateAttention,
} from '../../../src/features/attention/attention-panel.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../../src/lib/daemon-scope.ts';
import '../../support/dom.ts';
import { menuAction } from '../../support/attention-inbox.tsx';
import { interact, type Mounted, mount, must, pressKey } from '../../support/dom.ts';

const daemon = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceId: 'token-a' });
const scope = daemonSessionScope(daemon, 'shared');
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

const record = (
  id: string,
  resolvedAt: string,
  overrides: Partial<Record<keyof ResolvedAttentionItem, unknown>> = {},
): ResolvedAttentionItem =>
  ({
    ...item(id),
    resolvedAt,
    resolvedBy: 'human',
    resolvedBySession: null,
    resolvedByName: null,
    resolutionNote: null,
    disposition: 'resolved',
    response: { kind: 'permission', decision: 'approve' },
    ...overrides,
  }) as ResolvedAttentionItem;

const board = (
  items: readonly AttentionItem[],
  resolved: readonly ResolvedAttentionItem[] = [],
): AttentionSnapshot => ({
  v: 1,
  sessionId: 'shared',
  items: [...items],
  resolved: [...resolved],
  count: items.length,
  parseErrors: 0,
  updatedAt: '2026-07-31T12:00:00.000Z',
});

interface Call {
  readonly method: 'respond' | 'resolve' | 'dismiss' | 'needs-info' | 'progress';
  readonly id: string;
  readonly payload: unknown;
}

/** A client that records each answer and settles it however the case says. */
const recordingClient = (settle: (call: Call) => Promise<void> = async () => undefined) => {
  const calls: Call[] = [];
  const client: AttentionActionClient = {
    respond: async (at, where, id, response) => {
      expect(at).toBe(daemon);
      expect(where).toBe(scope);
      const call: Call = { method: 'respond', id, payload: response };
      calls.push(call);
      await settle(call);
    },
    resolve: async (at, where, id, note) => {
      expect(at).toBe(daemon);
      expect(where).toBe(scope);
      const call: Call = { method: 'resolve', id, payload: note };
      calls.push(call);
      await settle(call);
    },
    dismiss: async (at, where, id, note) => {
      expect(at).toBe(daemon);
      expect(where).toBe(scope);
      const call: Call = { method: 'dismiss', id, payload: note };
      calls.push(call);
      await settle(call);
    },
    needsInfo: async (at, where, id, note) => {
      expect(at).toBe(daemon);
      expect(where).toBe(scope);
      const call: Call = { method: 'needs-info', id, payload: note };
      calls.push(call);
      await settle(call);
    },
    progress: async (at, where, id, step, done) => {
      expect(at).toBe(daemon);
      expect(where).toBe(scope);
      const call: Call = { method: 'progress', id, payload: { step, done } };
      calls.push(call);
      await settle(call);
    },
  };
  return { calls, client };
};

const panel = (props: Partial<AttentionPanelProps> = {}) => (
  <ReferenceSurfaceProvider surface={{}}>
    <AttentionPanel
      client={recordingClient().client}
      connection={daemon}
      id="attn"
      now={NOW}
      onSelect={() => undefined}
      selectedId={null}
      scope={scope}
      snapshot={board([item('A3')])}
      status="ready"
      {...props}
    />
  </ReferenceSurfaceProvider>
);

const buttonNamed = (root: ParentNode, text: string): HTMLButtonElement =>
  must(
    [...root.querySelectorAll('button')].find(button => button.textContent?.trim().startsWith(text)) as
      | HTMLButtonElement
      | undefined,
    `the ${text} button`,
  );

const cardOf = (container: HTMLElement, id: string): HTMLElement =>
  must(container.querySelector<HTMLElement>(`[data-attention-card="${id}"]`), `card ${id}`);

let view: Mounted | null = null;
let scrolled: string[] = [];
const originalScroll = HTMLElement.prototype.scrollIntoView;

beforeEach(() => {
  scrolled = [];
  HTMLElement.prototype.scrollIntoView = function scrollIntoView(this: HTMLElement) {
    scrolled.push(this.id);
  };
});

afterEach(async () => {
  await view?.unmount();
  view = null;
  HTMLElement.prototype.scrollIntoView = originalScroll;
});

describe('attention panel model', () => {
  test('locates an id as open, resolved, unknown — or pending while the board is unread', () => {
    const snapshot = board([item('A3')], [record('A2', '2026-07-31T11:00:00.000Z')]);
    expect(locateAttention(snapshot, 'A3')).toBe('open');
    expect(locateAttention(snapshot, 'A2')).toBe('resolved');
    expect(locateAttention(snapshot, 'A9')).toBe('unknown');
    expect(locateAttention(null, 'A3')).toBe('pending');
  });

  test('the ledger is every id on the board, open and resolved', () => {
    expect(attentionLedgerIds(board([item('A3')], [record('A2', '2026-07-31T11:00:00.000Z')]))).toEqual(['A3', 'A2']);
    expect(attentionLedgerIds(null)).toEqual([]);
  });
});

describe('AttentionPanel', () => {
  test('is a labelled inline block, not a dialog, strip or scrim', async () => {
    view = await mount(panel());
    const c = must(view.container, 'view');
    expect(c.querySelector('section[aria-label="Needs you"]')).not.toBeNull();
    expect(c.querySelector('[role="dialog"]')).toBeNull();
    expect(c.querySelector('[data-attention-strip]')).toBeNull();
    expect(c.querySelector('.fy-attn-sheet__scrim')).toBeNull();
    expect(cardOf(c, 'A3').getAttribute('data-pinned')).toBe('true');
  });

  test('is absent with nothing open, nothing resolved and nothing asked', async () => {
    view = await mount(panel({ snapshot: board([]) }));
    expect(view.container.querySelector('#attn')).toBeNull();
  });

  test('shows the selected item, else the first, with a pager over several', async () => {
    const picked: string[] = [];
    const snapshot = board([item('A3'), item('A5')]);
    view = await mount(panel({ snapshot, onSelect: id => picked.push(id) }));
    const c = must(view.container, 'view');
    expect([...c.querySelectorAll('[data-attention-card]')].map(n => n.getAttribute('data-attention-card'))).toEqual([
      'A3',
    ]);
    expect(c.querySelector('[data-attention-pager]')?.textContent).toContain('1 of 2');
    expect(must(c.querySelector<HTMLButtonElement>('[aria-label="Previous item"]'), 'prev').disabled).toBe(true);
    await interact(() => must(c.querySelector<HTMLButtonElement>('[aria-label="Next item"]'), 'next').click());
    expect(picked).toEqual(['A5']);
    await view.render(panel({ snapshot, selectedId: 'A5' }));
    expect(cardOf(c, 'A5')).not.toBeNull();
    expect(c.querySelector('[data-attention-pager]')?.textContent).toContain('2 of 2');
  });

  test('a single item has no pager', async () => {
    view = await mount(panel());
    expect(must(view.container, 'view').querySelector('[data-attention-pager]')).toBeNull();
  });

  test('keeps the reply to the composer: no reply form on the pinned card', async () => {
    view = await mount(panel());
    expect(cardOf(must(view.container, 'view'), 'A3').querySelector('textarea')).toBeNull();
  });

  test('Details unfolds the context and brief, and folds it again', async () => {
    const rich = item('A3', { context: 'We need storage for the sessions.' });
    view = await mount(panel({ snapshot: board([rich]) }));
    const card = cardOf(must(view.container, 'view'), 'A3');
    expect(card.textContent).not.toContain('We need storage');
    const details = must(card.querySelector<HTMLButtonElement>('[data-attention-details]'), 'details');
    expect(details.getAttribute('aria-expanded')).toBe('false');
    await interact(() => details.click());
    expect(card.textContent).toContain('We need storage');
    expect(details.getAttribute('aria-expanded')).toBe('true');
    await interact(() => details.click());
    expect(card.textContent).not.toContain('We need storage');
  });

  test('the answer chip names the item and reports its toggle', async () => {
    const changes: boolean[] = [];
    view = await mount(panel({ chip: { on: true, onChange: next => changes.push(next) } }));
    const chip = must(view.container.querySelector('[data-attention-answer-chip]'), 'chip');
    expect(chip.textContent).toContain('!A3');
    const box = must(chip.querySelector<HTMLInputElement>('input[type="checkbox"]'), 'box');
    expect(box.checked).toBe(true);
    await interact(() => box.click());
    expect(changes).toEqual([false]);
  });

  test('no chip is drawn unless the host asks for one', async () => {
    view = await mount(panel());
    expect(must(view.container, 'view').querySelector('[data-attention-answer-chip]')).toBeNull();
  });

  test('draws the replies slot inside the block', async () => {
    view = await mount(panel({ repliesSlot: <p data-slot="">Sending to Zoe in 8 s…</p> }));
    expect(must(view.container, 'view').querySelector('#attn [data-slot]')).not.toBeNull();
  });

  test('draws no resolved history: the record lives in the header menu, not under the chat', async () => {
    view = await mount(
      panel({
        snapshot: board(
          [item('A3')],
          [record('A1', '2026-07-31T10:00:00.000Z'), record('A2', '2026-07-31T11:00:00.000Z')],
        ),
      }),
    );
    const c = must(view.container, 'view');
    expect(c.querySelector('[data-attention-record]')).toBeNull();
    expect(c.querySelector('[data-attention-resolved]')).toBeNull();
    expect(c.textContent).not.toContain('Resolved');
  });

  test('with nothing open it draws nothing but a silent live region, even when records exist', async () => {
    view = await mount(panel({ snapshot: board([], [record('A2', '2026-07-31T11:00:00.000Z')]) }));
    const c = must(view.container, 'view');
    expect(c.querySelector('section')).toBeNull();
    expect(c.querySelector('[data-attention-clear]')).toBeNull();
    expect(c.textContent).not.toContain('Nothing needs you');
    expect(c.querySelector('[role="status"][aria-live="polite"]')?.classList.contains('sr-only')).toBe(true);
  });

  test('the announcement of the last answer survives the card leaving', async () => {
    const snapshot = board([item('A3')]);
    view = await mount(panel({ snapshot }));
    const c = must(view.container, 'view');
    await interact(() => buttonNamed(cardOf(c, 'A3'), 'Allow').click());
    await view.render(panel({ snapshot: board([], [record('A3', '2026-07-31T12:00:00.000Z')]) }));
    expect(c.querySelector('section')).toBeNull();
    expect(c.querySelector('[role="status"][aria-live="polite"]')?.textContent).toBe('Answered !A3: Allow');
  });

  test('an option answers at once, through respond, with that option', async () => {
    const recorded = recordingClient();
    view = await mount(panel({ client: recorded.client }));
    await interact(() => buttonNamed(cardOf(must(view?.container, 'view'), 'A3'), 'Allow').click());
    expect(recorded.calls).toEqual([
      { method: 'respond', id: 'A3', payload: { kind: 'permission', decision: 'approve' } },
    ]);
    expect(view.container.querySelector('[role="status"][aria-live="polite"]')?.textContent).toBe(
      'Answered !A3: Allow',
    );
  });

  test('Done resolves and Dismiss dismisses, each with no note', async () => {
    const recorded = recordingClient();
    const snapshot = board([item('A3', { ask: { kind: 'task' } }), item('A4')]);
    view = await mount(panel({ client: recorded.client, snapshot }));
    const c = must(view.container, 'view');
    await interact(() => buttonNamed(cardOf(c, 'A3'), 'Done').click());
    await view.render(panel({ client: recorded.client, snapshot, selectedId: 'A4' }));
    await interact(async () => (await menuAction(cardOf(c, 'A4'), 'dismiss')).click());
    expect(recorded.calls).toEqual([
      { method: 'resolve', id: 'A3', payload: undefined },
      { method: 'dismiss', id: 'A4', payload: undefined },
    ]);
  });

  test('the card is busy while its answer is in flight, and a refusal stays on it', async () => {
    let refuse: ((reason: Error) => void) | undefined;
    const recorded = recordingClient(
      () =>
        new Promise<void>((_resolve, reject) => {
          refuse = reject;
        }),
    );
    view = await mount(panel({ client: recorded.client }));
    const c = must(view.container, 'view');
    await interact(() => buttonNamed(cardOf(c, 'A3'), 'Allow').click());
    expect(buttonNamed(cardOf(c, 'A3'), 'Allow').disabled).toBe(true);
    expect(recorded.calls).toHaveLength(1);
    await interact(async () => {
      refuse?.(new Error('the item was already resolved'));
    });
    expect(cardOf(c, 'A3').querySelector('[role="alert"]')?.textContent).toBe(
      'Not sent: the item was already resolved',
    );
    expect(buttonNamed(cardOf(c, 'A3'), 'Allow').disabled).toBe(false);
  });

  test('a link to an open item that is not shown selects it, then rings and focuses it', async () => {
    const picked: string[] = [];
    const focus: AttentionPanelFocus = { target: 'A4', seq: 1 };
    const snapshot = board([item('A3'), item('A4')]);
    view = await mount(panel({ focus, snapshot, onSelect: id => picked.push(id) }));
    expect(picked).toEqual(['A4']);
    await view.render(panel({ focus, snapshot, selectedId: 'A4' }));
    const c = must(view.container, 'view');
    expect(cardOf(c, 'A4').getAttribute('data-highlighted')).toBe('true');
    expect(scrolled).toEqual([attentionPanelItemId('attn', 'A4')]);
    expect(document.activeElement?.id).toBe(attentionPanelItemId('attn', 'A4'));
    await view.render(panel({ focus, snapshot, selectedId: 'A4' }));
    expect(scrolled).toHaveLength(1);
  });

  test('a link to a resolved item asks the page to open the resolved list at it', async () => {
    const opened: string[] = [];
    view = await mount(
      panel({
        focus: { target: 'A2', seq: 1 },
        onOpenResolved: id => opened.push(id),
        snapshot: board([item('A3')], [record('A2', '2026-07-31T11:00:00.000Z')]),
      }),
    );
    expect(opened).toEqual(['A2']);
    await view.render(
      panel({
        focus: { target: 'A2', seq: 1 },
        onOpenResolved: id => opened.push(id),
        snapshot: board([item('A3')], [record('A2', '2026-07-31T11:00:00.000Z')]),
      }),
    );
    expect(opened).toEqual(['A2']);
    expect(must(view.container, 'view').querySelector('[data-highlighted]')).toBeNull();
  });

  test('a link to an id the board does not hold says so, and rings nothing', async () => {
    view = await mount(panel({ focus: { target: 'A9', seq: 1 } }));
    const c = must(view.container, 'view');
    expect(c.querySelector('[data-attention-missing="A9"]')?.textContent).toContain('!A9 is no longer open.');
    expect(c.querySelector('[data-highlighted]')).toBeNull();
  });

  test('a link waits for the board: no claim while it is unread', async () => {
    view = await mount(panel({ focus: { target: 'A3', seq: 1 }, snapshot: null, status: 'loading' }));
    const c = must(view.container, 'view');
    expect(c.textContent).toContain('Checking this ferret');
    expect(c.querySelector('[data-attention-missing]')).toBeNull();
    expect(scrolled).toEqual([]);
  });

  test('a board that cannot be read says so instead of claiming nothing waits', async () => {
    view = await mount(panel({ snapshot: null, status: 'error' }));
    expect(must(view?.container, 'view').querySelector('[role="alert"]')?.textContent).toContain(
      'Attention cannot be read right now',
    );
  });

  test('a board with damaged records says so above the item', async () => {
    view = await mount(panel({ snapshot: { ...board([item('A3')]), parseErrors: 2 } }));
    expect(must(view?.container, 'view').querySelector('[role="alert"]')?.textContent).toContain(
      'reported 2 damaged Attention records',
    );
  });

  test('Dismiss lives in the ⋯ menu, shut until it is opened, which Esc closes', async () => {
    view = await mount(panel());
    const card = cardOf(must(view.container, 'view'), 'A3');
    expect(card.querySelector('[data-attention-dismiss]')).toBeNull();
    const more = must(card.querySelector<HTMLButtonElement>('[data-attention-more]'), 'more');
    await interact(() => more.click());
    expect(card.querySelector('[role="menu"] [data-attention-dismiss]')).not.toBeNull();
    await interact(() => pressKey(must(card.querySelector<HTMLElement>('[role="menu"]'), 'menu'), 'Escape'));
    expect(card.querySelector('[role="menu"]')).toBeNull();
  });

  test('a text-only ask dismisses from its ⋯ menu, and its age is drawn without "waiting"', async () => {
    const { calls, client } = recordingClient();
    view = await mount(panel({ client, snapshot: board([item('A3', { ask: { kind: 'open-question' } })]) }));
    const card = cardOf(must(view.container, 'view'), 'A3');
    expect(card.querySelector('.fy-attn-card__meta')?.textContent).toContain('30m');
    expect(card.querySelector('.fy-attn-card__meta')?.textContent).not.toContain('waiting');
    await interact(() => must(card.querySelector<HTMLButtonElement>('[data-attention-more]'), 'more').click());
    await interact(() => must(card.querySelector<HTMLButtonElement>('[data-attention-dismiss]'), 'dismiss').click());
    expect(calls.map(call => call.method)).toEqual(['dismiss']);
  });

  test('Details on a rich item opens its brief, with a lone question said once, under the ask', async () => {
    const rich = item('A3', {
      subject: 'Pick a database',
      why: 'Pick a database',
      context: 'We need storage.',
      questions: [
        { question: 'Which one?', options: [{ label: 'SQLite' }, { label: 'Postgres' }], recommended: 'SQLite' },
      ],
      ask: { kind: 'multiple-choice', options: [{ label: 'SQLite' }, { label: 'Postgres' }] },
    });
    view = await mount(panel({ snapshot: board([rich]) }));
    const card = cardOf(must(view.container, 'view'), 'A3');
    await interact(() => must(card.querySelector<HTMLButtonElement>('[data-attention-details]'), 'details').click());
    expect(card.querySelector('[data-attention-section="context"]')?.textContent).toContain('We need storage.');
    expect(card.querySelector('[data-attention-section="questions"]')).toBeNull();
    expect(card.querySelector('[data-attention-recommendation]')?.textContent).toContain('SQLite');
  });
});
