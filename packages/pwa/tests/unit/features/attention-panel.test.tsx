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
import { interact, type Mounted, mount, must } from '../../support/dom.ts';

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
  readonly method: 'respond' | 'resolve' | 'dismiss';
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
  };
  return { calls, client };
};

const panel = (props: Partial<AttentionPanelProps> = {}) => (
  <ReferenceSurfaceProvider surface={{}}>
    <AttentionPanel
      client={recordingClient().client}
      connection={daemon}
      expanded
      id="attn"
      now={NOW}
      onExpandedChange={() => undefined}
      scope={scope}
      snapshot={board([item('A3')])}
      status="ready"
      {...props}
    />
  </ReferenceSurfaceProvider>
);

const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;

const type = async (field: HTMLTextAreaElement, text: string): Promise<void> => {
  await interact(() => {
    nativeValueSetter?.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

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
  test('folded, it is one line: the count, and the oldest ask', async () => {
    const changes: boolean[] = [];
    view = await mount(
      panel({
        expanded: false,
        onExpandedChange: next => changes.push(next),
        snapshot: board([item('A3', { subject: 'Rebase now?' }), item('A4')]),
      }),
    );
    const strip = must(view.container.querySelector<HTMLButtonElement>('[data-attention-strip]'), 'the strip');
    expect(strip.textContent).toContain('2');
    expect(strip.textContent).toContain('need you');
    expect(strip.textContent).toContain('Rebase now?');
    expect(strip.getAttribute('aria-expanded')).toBe('false');
    expect(view.container.querySelector('[data-attention-panel]')).toBeNull();

    await interact(() => strip.click());
    expect(changes).toEqual([true]);
  });

  test('is absent while folded with nothing open', async () => {
    view = await mount(panel({ expanded: false, snapshot: board([], [record('A2', '2026-07-31T11:00:00.000Z')]) }));
    expect(view.container.querySelector('#attn')).toBeNull();
  });

  test('open, it lists every open item first, then the resolved ones folded', async () => {
    view = await mount(
      panel({
        snapshot: board(
          [item('A3'), item('A5')],
          [
            record('A1', '2026-07-31T10:00:00.000Z'),
            record('A2', '2026-07-31T11:00:00.000Z', {
              disposition: 'dismissed',
              response: null,
              resolutionNote: 'Superseded by A3.',
            }),
          ],
        ),
      }),
    );
    const open = [...view.container.querySelectorAll('[data-attention-card]')].map(card =>
      card.getAttribute('data-attention-card'),
    );
    expect(open).toEqual(['A3', 'A5']);
    const fold = must(view.container.querySelector<HTMLButtonElement>('[data-attention-resolved]'), 'the fold');
    expect(fold.textContent).toContain('Resolved (2)');
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(view.container.querySelector('[data-attention-record]')).toBeNull();

    await interact(() => fold.click());
    const records = [...view.container.querySelectorAll('[data-attention-record]')];
    // Newest resolution first: the one just made is the one the reader looks for.
    expect(records.map(row => row.getAttribute('data-attention-record'))).toEqual(['A2', 'A1']);
    expect(records[0]?.textContent).toContain('dismissed by you');
    expect(records[0]?.textContent).toContain('Superseded by A3.');
    expect(records[1]?.textContent).toContain('done by you');
    expect(records[1]?.textContent).toContain('Approved');
  });

  test('open with nothing waiting, it says so and still keeps the record', async () => {
    view = await mount(panel({ snapshot: board([], [record('A2', '2026-07-31T11:00:00.000Z')]) }));
    expect(view.container.querySelector('[data-attention-clear]')?.textContent).toContain('Nothing needs you');
    expect(must(view.container.querySelector('[data-attention-strip]'), 'strip').textContent).toContain(
      'Nothing needs you',
    );
    expect(view.container.querySelector('[data-attention-resolved]')).not.toBeNull();
  });

  test('an option answers at once, through respond, with that option', async () => {
    const recorded = recordingClient();
    view = await mount(panel({ client: recorded.client }));
    await interact(() => buttonNamed(cardOf(must(view?.container, 'view'), 'A3'), 'Approve').click());
    expect(recorded.calls).toEqual([
      { method: 'respond', id: 'A3', payload: { kind: 'permission', decision: 'approve' } },
    ]);
    expect(view.container.querySelector('[role="status"][aria-live="polite"]')?.textContent).toBe(
      'Answered !A3: Approve',
    );
  });

  test('a reply to an open question is THE answer; a reply to any other kind is the Done note', async () => {
    const recorded = recordingClient();
    view = await mount(
      panel({
        client: recorded.client,
        snapshot: board([item('A3', { ask: { kind: 'open-question' } }), item('A4')]),
      }),
    );
    const container = must(view?.container, 'view');
    await type(must(cardOf(container, 'A3').querySelector('textarea'), 'A3 reply'), 'Ship on Friday');
    await interact(() => must(cardOf(container, 'A3').querySelector('form'), 'A3 form').requestSubmit());
    await type(must(cardOf(container, 'A4').querySelector('textarea'), 'A4 reply'), 'Use the staging key');
    await interact(() => must(cardOf(container, 'A4').querySelector('form'), 'A4 form').requestSubmit());
    expect(recorded.calls).toEqual([
      { method: 'respond', id: 'A3', payload: { kind: 'open-question', answer: 'Ship on Friday' } },
      { method: 'resolve', id: 'A4', payload: 'Use the staging key' },
    ]);
  });

  test('Done resolves and Dismiss dismisses, each with no note', async () => {
    const recorded = recordingClient();
    view = await mount(panel({ client: recorded.client, snapshot: board([item('A3'), item('A4')]) }));
    const container = must(view?.container, 'view');
    await interact(() =>
      must(cardOf(container, 'A3').querySelector<HTMLButtonElement>('[data-attention-done]'), 'Done').click(),
    );
    await interact(() =>
      must(cardOf(container, 'A4').querySelector<HTMLButtonElement>('[data-attention-dismiss]'), 'Dismiss').click(),
    );
    expect(recorded.calls).toEqual([
      { method: 'resolve', id: 'A3', payload: undefined },
      { method: 'dismiss', id: 'A4', payload: undefined },
    ]);
  });

  test('a card is busy while its answer is in flight, and a refusal stays on that card', async () => {
    let refuse: ((reason: Error) => void) | undefined;
    const recorded = recordingClient(
      () =>
        new Promise<void>((_resolve, reject) => {
          refuse = reject;
        }),
    );
    view = await mount(panel({ client: recorded.client, snapshot: board([item('A3'), item('A4')]) }));
    const container = must(view?.container, 'view');
    await interact(() => buttonNamed(cardOf(container, 'A3'), 'Approve').click());
    expect(buttonNamed(cardOf(container, 'A3'), 'Approve').disabled).toBe(true);
    // One slow answer never freezes the others.
    expect(buttonNamed(cardOf(container, 'A4'), 'Approve').disabled).toBe(false);
    // A second press while the first is in flight sends nothing more.
    await interact(() =>
      must(cardOf(container, 'A3').querySelector<HTMLButtonElement>('[data-attention-done]'), 'Done').click(),
    );
    expect(recorded.calls).toHaveLength(1);

    await interact(async () => {
      refuse?.(new Error('the item was already resolved'));
    });
    expect(cardOf(container, 'A3').querySelector('[role="alert"]')?.textContent).toBe(
      'Not sent: the item was already resolved',
    );
    expect(cardOf(container, 'A4').querySelector('[role="alert"]')).toBeNull();
    expect(buttonNamed(cardOf(container, 'A3'), 'Approve').disabled).toBe(false);
  });

  test('a link to an open item rings it, scrolls it into view and lands focus on it', async () => {
    const focus: AttentionPanelFocus = { target: 'A4', seq: 1 };
    view = await mount(panel({ focus, snapshot: board([item('A3'), item('A4')]) }));
    const container = must(view?.container, 'view');
    expect(cardOf(container, 'A4').getAttribute('data-highlighted')).toBe('true');
    expect(cardOf(container, 'A3').getAttribute('data-highlighted')).toBeNull();
    expect(scrolled).toEqual([attentionPanelItemId('attn', 'A4')]);
    expect(document.activeElement?.id).toBe(attentionPanelItemId('attn', 'A4'));

    // The same request does not scroll again; a new one (same target) does.
    await view.render(panel({ focus, snapshot: board([item('A3'), item('A4')]) }));
    expect(scrolled).toHaveLength(1);
    await view.render(panel({ focus: { target: 'A4', seq: 2 }, snapshot: board([item('A3'), item('A4')]) }));
    expect(scrolled).toHaveLength(2);
  });

  test('a link to a resolved item unfolds the record and rings that entry', async () => {
    view = await mount(
      panel({
        focus: { target: 'A2', seq: 1 },
        snapshot: board([item('A3')], [record('A2', '2026-07-31T11:00:00.000Z')]),
      }),
    );
    const container = must(view?.container, 'view');
    const fold = must(container.querySelector('[data-attention-resolved]'), 'the fold');
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    const entry = must(container.querySelector('[data-attention-record="A2"]'), 'the A2 record');
    expect(entry.getAttribute('data-highlighted')).toBe('true');
    expect(entry.textContent).toContain('linked');
    expect(scrolled).toEqual([attentionPanelItemId('attn', 'A2')]);
  });

  test('a link to an id the board does not hold says so, and rings nothing', async () => {
    view = await mount(panel({ focus: { target: 'A9', seq: 1 } }));
    const container = must(view?.container, 'view');
    expect(container.querySelector('[data-attention-missing="A9"]')?.textContent).toContain('!A9 is no longer open.');
    expect(container.querySelector('[data-highlighted]')).toBeNull();
    // It still takes the reader to the panel.
    expect(scrolled).toEqual(['attn']);
  });

  test('a link waits for the board: no claim while it is unread, then the item once it is', async () => {
    view = await mount(panel({ focus: { target: 'A3', seq: 1 }, snapshot: null, status: 'loading' }));
    const container = must(view?.container, 'view');
    expect(container.textContent).toContain('Checking this ferret');
    expect(container.querySelector('[data-attention-missing]')).toBeNull();
    expect(scrolled).toEqual([]);

    await view.render(panel({ focus: { target: 'A3', seq: 1 } }));
    expect(scrolled).toEqual([attentionPanelItemId('attn', 'A3')]);
  });

  test('a board that cannot be read says so instead of claiming nothing waits', async () => {
    view = await mount(panel({ snapshot: null, status: 'error' }));
    expect(must(view?.container, 'view').querySelector('[role="alert"]')?.textContent).toContain(
      'Attention cannot be read right now',
    );
  });

  test('a board with damaged records says so above the items', async () => {
    view = await mount(panel({ snapshot: { ...board([item('A3')]), parseErrors: 2 } }));
    expect(must(view?.container, 'view').querySelector('[role="alert"]')?.textContent).toContain(
      'reported 2 damaged Attention records',
    );
  });

  test('the header request (no target) scrolls the panel itself into view', async () => {
    view = await mount(panel({ focus: { target: null, seq: 1 } }));
    expect(scrolled).toEqual(['attn']);
    expect(must(view?.container, 'view').querySelector('[data-highlighted]')).toBeNull();
  });
});
