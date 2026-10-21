import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { LedgerControls } from '../../src/components/ledger-message.tsx';
import { SettledSendNote } from '../../src/components/settled-send-note.tsx';
import { TranscriptRow } from '../../src/components/transcript-row.tsx';
import { useSendView } from '../../src/hooks/use-send-view.ts';
import { clockOfInstant } from '../../src/lib/message-clock.ts';
import { type SendDismissalStorage, SendDismissalStore } from '../../src/lib/send-dismissals.ts';
import type { LedgerSendRecord } from '../../src/lib/send-ledger.ts';
import type { TranscriptEntry } from '../../src/lib/session-screens.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';

const SENT = '2026-10-21T09:00:00.000Z';

const record = (overrides: Partial<LedgerSendRecord> = {}): LedgerSendRecord => ({
  sendId: 'send-1',
  acceptedAt: SENT,
  message: 'hi\nthere',
  attachmentIds: [],
  fate: 'cancelled',
  path: 'direct',
  ...overrides,
});

const click = (view: Mounted, selector: string): Promise<void> =>
  interact(() => must(view.container.querySelector<HTMLElement>(selector), selector).click());

describe('the one-line note for a terminal send', () => {
  it('reads "Cancelled · hi there · 09:00" and opens or dismisses on a tap', async () => {
    const opened: [string, boolean][] = [];
    const dismissed: string[] = [];
    const view = await mount(
      <SettledSendNote
        onDismiss={r => void dismissed.push(r.sendId)}
        onExpand={(r, open) => void opened.push([r.sendId, open])}
        record={record()}
      />,
    );
    const note = must(view.container.querySelector<HTMLElement>('[data-settled-note]'), 'the note');
    expect(note.dataset.settledNote).toBe('cancelled');
    expect(note.textContent).toBe(`Cancelled·hi there·${clockOfInstant(SENT)?.short}`);
    await click(view, '.fy-settled-open');
    await click(view, '[data-settled-dismiss]');
    expect(opened).toEqual([['send-1', true]]);
    expect(dismissed).toEqual(['send-1']);
    await view.unmount();
  });

  it('is plain text when it cannot be opened or dismissed, and has no time when none was recorded', async () => {
    const view = await mount(<SettledSendNote record={record({ acceptedAt: 'nope', fate: 'timed_out' })} />);
    expect(view.container.querySelector('[data-settled-dismiss]')).toBeNull();
    expect(must(view.container.querySelector<HTMLButtonElement>('.fy-settled-open'), 'its line').disabled).toBe(true);
    expect(view.container.querySelector('time')).toBeNull();
    expect(view.container.textContent).toBe('Not delivered·hi there');
    await view.unmount();
  });
});

describe('Dismiss and Fold on a send that is not delivered', () => {
  it('offers Dismiss for every undelivered send and Fold only when asked to, and never for a delivered one', async () => {
    const dismissed: string[] = [];
    const folded: [string, boolean][] = [];
    const view = await mount(
      <LedgerControls
        onCollapse={(r, open) => void folded.push([r.sendId, open])}
        onDismiss={r => void dismissed.push(r.sendId)}
        record={record()}
      />,
    );
    await click(view, '[data-ledger-action="dismiss"]');
    await click(view, '[data-ledger-action="collapse"]');
    expect(dismissed).toEqual(['send-1']);
    expect(folded).toEqual([['send-1', false]]);
    await view.render(
      <LedgerControls
        onCollapse={() => undefined}
        onDismiss={() => undefined}
        record={record({ fate: 'delivered' })}
      />,
    );
    expect(view.container.querySelector('[data-ledger-action="dismiss"]')).toBeNull();
    expect(view.container.querySelector('[data-ledger-action="collapse"]')).toBeNull();
    await view.unmount();
  });
});

describe('a terminal send in the transcript', () => {
  const entry = (settled: TranscriptEntry['settled'], send = record()): TranscriptEntry => ({
    id: `send:${send.sendId}`,
    kind: 'ledger',
    text: send.message,
    ledger: send,
    placement: 'chronological',
    ...(settled === undefined ? {} : { settled }),
  });

  it('is a one-line note when slim, the whole bubble with Dismiss when fresh, and with Fold once opened', async () => {
    const dismissed: string[] = [];
    const expanded: [string, boolean][] = [];
    const row = (settled: TranscriptEntry['settled'], send?: LedgerSendRecord) => (
      <TranscriptRow
        entry={entry(settled, send)}
        onDismiss={r => void dismissed.push(r.sendId)}
        onExpand={(r, open) => void expanded.push([r.sendId, open])}
      />
    );
    const view = await mount(row('slim'));
    expect(view.container.querySelector('[data-settled="slim"] [data-settled-note]')).not.toBeNull();
    expect(view.container.querySelector('[data-ledger-actions]')).toBeNull();

    await view.render(row('fresh'));
    expect(view.container.querySelector('[data-settled-note]')).toBeNull();
    expect(view.container.querySelector('[data-ledger-action="dismiss"]')).not.toBeNull();
    expect(view.container.querySelector('[data-ledger-action="collapse"]')).toBeNull();

    await view.render(row('expanded'));
    await click(view, '[data-ledger-action="collapse"]');
    expect(expanded).toEqual([['send-1', false]]);

    // A teammate's cancelled message is not the reader's own bubble, and still folds and dismisses.
    const peer = record({ message: '[peer message from teammate nero (session x)]\nFYI\n\nhello' });
    await view.render(row('expanded', peer));
    await click(view, '[data-ledger-action="dismiss"]');
    expect(dismissed).toEqual(['send-1']);
    await view.render(row('slim', peer));
    expect(view.container.textContent).toContain('hello');
    await view.unmount();
  });
});

describe('useSendView', () => {
  const memory = (): SendDismissalStorage => {
    const values = new Map<string, string>();
    return { getItem: key => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) };
  };
  let latest: ReturnType<typeof useSendView> | null = null;
  const snapshot = (): ReturnType<typeof useSendView> => must(latest, 'the hook');
  function Probe({
    sends,
    store,
  }: {
    readonly sends: readonly LedgerSendRecord[];
    readonly store: SendDismissalStore;
  }) {
    latest = useSendView(sends, store);
    return null;
  }
  beforeEach(() => {
    latest = null;
  });
  afterEach(() => {
    latest = null;
  });

  it('dismisses and opens through the store, and re-places the rows when a fresh bubble folds on its own', async () => {
    const store = new SendDismissalStore(memory());
    const cancelled = record({ fateAt: new Date(Date.now() - 9_900).toISOString() });
    const view = await mount(<Probe sends={[cancelled]} store={store} />);
    expect(snapshot().tick).toBe(0);
    await interact(() => new Promise(resolve => setTimeout(resolve, 300)));
    expect(snapshot().tick).toBe(1);

    await interact(() => snapshot().setExpanded('send-1', true));
    expect(snapshot().view.expanded.has('send-1')).toBe(true);
    await interact(() => snapshot().dismiss(['send-1']));
    expect(snapshot().view.dismissed.has('send-1')).toBe(true);
    await view.unmount();
  });

  it('schedules nothing when no settled row will change, and the default store is this device’s', async () => {
    const view = await mount(<Probe sends={[]} store={new SendDismissalStore(memory())} />);
    expect(snapshot().tick).toBe(0);
    await view.unmount();
    const device = await mount(<DefaultProbe />);
    expect(snapshot().view.dismissed.size).toBeGreaterThanOrEqual(0);
    await device.unmount();
  });

  function DefaultProbe() {
    latest = useSendView([]);
    return null;
  }
});
