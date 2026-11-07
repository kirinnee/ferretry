import { afterEach, describe, expect, test } from 'bun:test';
import { AgendaItemHistory } from '../../../../app/features/agenda/agenda-item-history.tsx';
import type { HistoryEvent } from '../../../../app/lib/agenda-history.ts';
import { clockOfInstant } from '../../../../app/shell.ts';
import type { LedgerSendRecord } from '../../../../app/shell.ts';
import { interact, type Mounted, mount, must } from '../../../support/app/dom.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const AT = Date.parse('2026-08-01T10:02:00.000Z');

const draw = async (events: readonly HistoryEvent[]): Promise<HTMLElement> => {
  view = await mount(
    <AgendaItemHistory
      events={events}
      ferret="Lizzette"
      itemKey={`history-test:${String(++drawn)}`}
      renderProse={text => <p>{text}</p>}
    />,
  );
  // The conversation is folded: open it, as the owner does, to read it.
  const toggle = view.container.querySelector<HTMLButtonElement>('[data-agenda-fold="conversation"]');
  if (toggle !== null) await interact(() => toggle.click());
  return view.container;
};
let drawn = 0;

describe('the Conversation of an open agenda item', () => {
  test('draws nothing when nothing was said about the item', async () => {
    expect((await draw([])).querySelector('[data-agenda-history]')).toBeNull();
  });

  test('starts folded, saying how many messages it holds, and opens on a tap', async () => {
    view = await mount(
      <AgendaItemHistory
        events={[
          { kind: 'gap', key: 'gap', at: 0, earlier: 3, state: 'loading' },
          { kind: 'owner', key: 'o', at: AT, text: 'is it done?' },
          { kind: 'ferret', key: 'f', at: AT + 1, text: 'Yes.' },
        ]}
        ferret="Lizzette"
        itemKey="history-test:folded"
        renderProse={text => <p>{text}</p>}
      />,
    );
    const root = view.container;
    const toggle = must(root.querySelector<HTMLButtonElement>('[data-agenda-fold="conversation"]'), 'fold toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toBe('Conversation2 messages');
    expect(root.querySelector('[data-agenda-history]')).toBeNull();
    await interact(() => toggle.click());
    expect(root.querySelectorAll('[data-agenda-history] [data-history]')).toHaveLength(3);
  });

  test('is drawn with the chat’s own rows, oldest first: the ferret’s name above its words, the owner as a bubble', async () => {
    const root = await draw([
      { kind: 'ferret', key: 'r', at: AT, text: 'What should happen at the hard limit?' },
      { kind: 'owner', key: 'o', at: AT + 180_000, text: 'does pause kill a running turn?' },
      { kind: 'revision', key: 'v', at: AT + 200_000, version: 2, summary: [] },
      { kind: 'ferret', key: 'f', at: AT + 240_000, text: 'No. A running turn finishes.' },
    ]);
    const rows = [...root.querySelectorAll('[data-agenda-history] li')];
    // An edit is the activity log's, never a line of the conversation.
    expect(rows.map(row => row.getAttribute('data-history'))).toEqual(['ferret', 'owner', 'ferret']);
    expect(
      must(root.querySelector('[data-agenda-part="conversation"] h4 .fy-card__label'), 'heading').textContent,
    ).toBe('Conversation');
    // The chat's agent row: the name small above, the time at the foot — the chat's clock, not an age.
    const ferretRow = must(rows[0]?.querySelector('article.fy-message-assistant'), 'the chat’s agent row');
    expect(ferretRow.getAttribute('data-transcript-kind')).toBe('assistant');
    expect(ferretRow.querySelector('header')?.textContent).toBe('Lizzette');
    expect(ferretRow.querySelector('[data-message-footer] time')?.textContent).toBe(clockOfInstant(AT)?.short);
    expect(rows[0]?.className).toBe('fy-hist__ag');
    expect(rows[2]?.className).toBe('fy-hist__ag');
    // Only the owner's row is a bubble: the chat's own, with its time and its ticks at the foot.
    expect(root.querySelectorAll('article.fy-message-user')).toHaveLength(1);
    expect(rows[1]?.className).toBe('fy-hist__me');
    const bubble = must(rows[1]?.querySelector('article.fy-message-user'), 'the chat’s own bubble');
    expect(bubble.querySelector('[data-message-footer] time')?.textContent).toBe(clockOfInstant(AT + 180_000)?.short);
    expect(bubble.querySelector('[data-send-receipt] svg')).not.toBeNull();
  });

  test('draws a reply WHOLE, however long, and every reply in order', async () => {
    const long = `${'A long report line. '.repeat(400)}The end.`;
    const root = await draw([
      { kind: 'owner', key: 'o1', at: AT, text: 'first' },
      { kind: 'ferret', key: 'f1', at: AT + 1, text: long },
      { kind: 'owner', key: 'o2', at: AT + 2, text: 'second' },
      { kind: 'ferret', key: 'f2', at: AT + 3, text: 'third' },
    ]);
    const said = [...root.querySelectorAll('[data-history]')].map(row => row.getAttribute('data-history'));
    expect(said).toEqual(['owner', 'ferret', 'owner', 'ferret']);
    expect(must(root.querySelectorAll('.fy-hist__text')[0], 'the long reply').textContent).toBe(long);
  });

  test('says how many earlier entries are still loading, above the ones it has', async () => {
    const root = await draw([
      { kind: 'gap', key: 'gap', at: 0, earlier: 12, state: 'loading' },
      { kind: 'owner', key: 'o', at: AT, text: 'latest' },
    ]);
    const rows = [...root.querySelectorAll('[data-agenda-history] li')];
    expect(rows.map(row => row.getAttribute('data-history'))).toEqual(['gap', 'owner']);
    expect(rows[0]?.getAttribute('data-history-gap')).toBe('loading');
    expect(rows[0]?.textContent).toBe('Loading 12 earlier entries…');
  });

  test('says in words when earlier entries could not be read, or are more than one read takes, never a partial thread as whole', async () => {
    const failed = await draw([{ kind: 'gap', key: 'gap', at: 0, earlier: 1, state: 'failed' }]);
    expect(failed.querySelector('[data-history-gap="failed"]')?.textContent).toContain(
      '1 earlier entry could not be read',
    );
    await view?.unmount();
    const capped = await draw([{ kind: 'gap', key: 'gap', at: 0, earlier: 30, state: 'capped' }]);
    expect(capped.querySelector('[data-history-gap="capped"]')?.textContent).toContain(
      '30 earlier entries are not shown',
    );
  });

  test('draws nothing when only edits happened: they are the activity log’s', async () => {
    expect((await draw([{ kind: 'revision', key: 'v', at: AT, version: 2, summary: [] }])).innerHTML).toBe('');
  });

  test('ticks an answer, says a note under it, and leaves a reply unticked', async () => {
    const root = await draw([
      { kind: 'owner', key: 'a', at: AT, text: 'Pause', form: 'answer', note: 'until Monday' },
      { kind: 'owner', key: 'b', at: AT, text: 'thanks' },
    ]);
    const [answer, reply] = [...root.querySelectorAll('[data-history="owner"]')];
    expect(answer?.querySelector('.fy-hist__check')).not.toBeNull();
    expect(must(answer?.querySelector('.fy-hist__note'), 'note').textContent).toBe('until Monday');
    expect(reply?.querySelector('.fy-hist__check')).toBeNull();
  });

  test('draws no clock for an event with no time', async () => {
    const root = await draw([{ kind: 'ferret', key: 'f', at: 0, text: 'hi' }]);
    expect(root.querySelector('time')).toBeNull();
  });

  test('tags words the ferret copied from chat, on either side', async () => {
    const root = await draw([
      { kind: 'owner', key: 'o', at: AT, text: 'use Postgres', fromChat: true },
      { kind: 'ferret', key: 'f', at: AT + 1, text: 'noted', fromChat: true },
      { kind: 'owner', key: 'p', at: AT + 2, text: 'typed here' },
    ]);
    const rows = [...root.querySelectorAll('[data-history]')];
    expect(rows.map(row => row.querySelector('[data-history-from-chat]')?.textContent ?? null)).toEqual([
      'from chat',
      'from chat',
      null,
    ]);
  });

  test('draws Ferretry’s own words under its name', async () => {
    const root = await draw([{ kind: 'ferret', key: 'd', at: AT, text: 'Closed as merged into !A2.', daemon: true }]);
    const row = must(root.querySelector('[data-history="daemon"]'), 'daemon row');
    expect(row.querySelector('header')?.textContent).toContain('Ferretry');
    expect(row.textContent).not.toContain('Lizzette');
  });
});

describe('the owner’s ticks, the chat’s own', () => {
  const tick = (root: HTMLElement): string | null =>
    root.querySelector('[data-history="owner"] [data-send-receipt]')?.getAttribute('data-send-receipt') ?? null;
  const said = (reached: Extract<HistoryEvent, { kind: 'owner' }>['reached']): HistoryEvent => ({
    kind: 'owner',
    key: 'o',
    at: AT,
    text: 'ship it',
    ...(reached === undefined ? {} : { reached }),
  });

  test('a row of the ferret’s transcript is read: four ticks', async () => {
    expect(tick(await draw([said({ via: 'transcript', answered: false })]))).toBe('read');
  });

  test('words stored on the item are on the machine, and answered once the ferret replied', async () => {
    expect(tick(await draw([said({ via: 'item', answered: false })]))).toBe('queued');
    await view?.unmount();
    expect(tick(await draw([said({ via: 'item', answered: true })]))).toBe('answered');
    await view?.unmount();
    // Nothing known at all claims no more than the item holds.
    expect(tick(await draw([said(undefined)]))).toBe('queued');
  });

  test('a send the chat’s ledger recorded is drawn exactly as the chat draws it', async () => {
    const send: LedgerSendRecord = {
      sendId: 'send-1',
      acceptedAt: new Date(AT).toISOString(),
      message: 'ship it',
      attachmentIds: [],
      fate: 'delivered',
    };
    const root = await draw([said({ via: 'transcript', answered: true, send })]);
    expect(tick(root)).toBe('answered');
    expect(root.querySelector('[data-history="owner"] [data-send-fate]')?.getAttribute('data-send-fate')).toBe(
      'delivered',
    );
  });

  test('a tap on the time says what the mark means', async () => {
    const root = await draw([said({ via: 'item', answered: false })]);
    const mark = must(root.querySelector<HTMLButtonElement>('[data-send-receipt]'), 'the receipt');
    expect(mark.getAttribute('aria-label')).toContain('On the machine');
    await interact(() => mark.click());
    expect(root.querySelector('[data-send-reason]')?.textContent).toContain('the ferret has not replied to it yet');
  });
});
