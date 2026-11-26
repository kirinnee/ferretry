import { type LedgerSendRecord } from '../../../../app/lib/transcript.ts';
import { afterEach, describe, expect, test } from 'bun:test';
import { AgendaItemHistory } from '../../../../app/features/agenda/agenda-item-history.tsx';
import {
  answeredAsks,
  type DeviceWords,
  deviceEvents,
  type HistoryEvent,
  withDeviceEvents,
} from '../../../../app/lib/agenda-history.ts';
import { clockOfInstant } from '../../../../app/shell.ts';
import { agendaItem } from '../../../support/app/agenda-inbox.tsx';
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const AT = Date.parse('2026-08-01T10:02:00.000Z');

const taskGate = {
  cardId: 'F12',
  laneId: 'tested',
  laneName: 'Try it',
  entry: 3,
  projectId: 'p1',
  options: [
    { id: 'o0', label: 'Done', outcome: 'close' },
    { id: 'o1', label: 'Not good', outcome: 'reopen-with-agenda' },
  ],
} as const;
const taskAnswer = (choice: string, at: string) => ({
  at,
  response: { kind: 'multiple-choice', choice },
  receipt: 'a'.repeat(64),
});

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
    expect(toggle.textContent).toBe('History2 messages');
    expect(root.querySelector('[data-agenda-history]')).toBeNull();
    await interact(() => toggle.click());
    expect(root.querySelectorAll('[data-agenda-history] [data-history]')).toHaveLength(3);
  });

  test('A-29: the History counts the asks the owner answered, from the asks themselves', async () => {
    const item = agendaItem('A5', {
      ownerAnswer: {
        at: '2026-08-01T10:00:00.000Z',
        response: { kind: 'multiple-choice', choice: 'Blue' },
        request: 1,
      },
      cardAsks: [
        { gate: taskGate, at: '2026-08-01T09:00:00.000Z', answer: taskAnswer('Done', '2026-08-01T10:30:00.000Z') },
        { gate: { ...taskGate, cardId: 'F13', entry: 4 }, at: '2026-08-01T09:05:00.000Z' },
      ],
    } as never);
    expect(answeredAsks(item).map(ask => [ask.of, ask.response])).toEqual([
      ['this item', { kind: 'multiple-choice', choice: 'Blue' }],
      ['task &F12', { kind: 'multiple-choice', choice: 'Done' }],
    ]);
    view = await mount(
      <AgendaItemHistory
        answered={answeredAsks(item)}
        events={[{ kind: 'ferret', key: 'f', at: AT, text: 'Blue or green?' }]}
        ferret="Lizzette"
        itemKey="history-test:answered"
        renderProse={text => <p>{text}</p>}
      />,
    );
    const toggle = must(view.container.querySelector<HTMLButtonElement>('[data-agenda-fold="conversation"]'), 'fold');
    expect(toggle.textContent).toBe('History2 answered · 1 message');
    await interact(() => toggle.click());
    expect(view.container.querySelectorAll('[data-agenda-answered-ask]')).toHaveLength(2);
  });

  test('A-29: a stored task answer with no transcript still has its History fold', async () => {
    const item = agendaItem('A5', {
      cardAsks: [
        { gate: taskGate, at: '2026-08-01T09:00:00.000Z', answer: taskAnswer('Done', '2026-08-01T10:30:00.000Z') },
      ],
    } as never);
    view = await mount(
      <AgendaItemHistory
        answered={answeredAsks(item)}
        events={[]}
        ferret="Lizzette"
        itemKey="history-test:stored"
        renderProse={text => <p>{text}</p>}
      />,
    );
    const toggle = must(view.container.querySelector<HTMLButtonElement>('[data-agenda-fold="conversation"]'), 'fold');
    expect(toggle.textContent).toBe('History1 answered');
    await interact(() => toggle.click());
    const row = must(view.container.querySelector<HTMLElement>('[data-agenda-answered-ask]'), 'the answered ask');
    expect(row.textContent).toContain('task &F12');
    expect(row.textContent).toContain('Chose “Done”');
  });

  test('A-29: an owner answer the device never sent (refused) is not an answered ask', async () => {
    const refused = deviceEvents('A5', [
      { id: 's1', message: '!A5 Blue', references: ['!A5'], createdAt: '2026-08-01T10:00:00.000Z', refused: true },
    ]);
    view = await mount(
      <AgendaItemHistory
        answered={answeredAsks(agendaItem('A5'))}
        events={refused}
        ferret="Lizzette"
        itemKey="history-test:refused"
        renderProse={text => <p>{text}</p>}
      />,
    );
    const toggle = must(view.container.querySelector<HTMLButtonElement>('[data-agenda-fold="conversation"]'), 'fold');
    expect(toggle.textContent).not.toContain('answered');
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
    ).toBe('History');
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
    const root = await draw([{ kind: 'ferret', key: 'd', at: AT, text: 'Closed as merged into ^A2.', daemon: true }]);
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

describe('the owner’s words still on this device', () => {
  const BASE = {
    references: ['^A3'] as readonly string[],
    createdAt: new Date(AT).toISOString(),
  };
  const device = (words: readonly DeviceWords[], history: readonly HistoryEvent[] = []) =>
    withDeviceEvents(history, deviceEvents('A3', words));

  test('draws an outbox entry that names the item as “Saved on this device”, with the chat’s one tick', async () => {
    const root = await draw(
      device([{ ...BASE, id: 'send-1', message: 'ship it tonight', reason: 'waiting for the machine' }]),
    );
    const mark = must(root.querySelector('[data-history="owner"] [data-send-receipt]'), 'the receipt');
    expect(mark.getAttribute('data-send-receipt')).toBe('saved');
    expect(mark.getAttribute('aria-label')).toContain('Saved on this device');
    expect(mark.querySelector('[data-receipt-mark="saved"]')).not.toBeNull();
    expect(root.querySelector('[data-history="owner"] .fy-hist__said')?.textContent).toBe('ship it tonight');
    await interact(() => (mark as HTMLButtonElement).click());
    expect(root.querySelector('[data-send-reason]')?.textContent).toContain(
      'goes to the machine when it can be reached',
    );
  });

  test('draws one the machine refused as “Not sent”, with the reason', async () => {
    const root = await draw(
      device([{ ...BASE, id: 'send-2', message: 'no way', reason: 'the ferret is gone', refused: true }]),
    );
    const mark = must(root.querySelector('[data-send-receipt]'), 'the receipt');
    expect(mark.getAttribute('data-send-receipt')).toBe('failed');
    expect(mark.getAttribute('aria-label')).toContain('Not sent');
    await interact(() => (mark as HTMLButtonElement).click());
    expect(root.querySelector('[data-send-reason]')?.textContent).toContain('the ferret is gone');
  });

  test('leaves out an entry that names another item', async () => {
    const root = await draw(device([{ ...BASE, references: ['^A9'], id: 'send-3', message: 'about nine' }]));
    expect(root.querySelector('[data-agenda-history]')).toBeNull();
  });

  test('also reads an entry whose own words cite the item (an older send, no references)', async () => {
    const root = await draw(device([{ ...BASE, references: [], id: 'send-4', message: '^A3 still there?' }]));
    expect(root.querySelector('[data-history="owner"] .fy-hist__said')?.textContent).toBe('still there?');
  });

  test('draws once, with the ledger’s receipt, when the machine already has the words', async () => {
    const delivered: HistoryEvent = {
      kind: 'owner',
      key: 'row-1',
      at: AT,
      text: 'ship it tonight',
      reached: {
        via: 'transcript',
        answered: false,
        send: { sendId: 'send-1', fate: 'delivered' } as LedgerSendRecord,
      },
    };
    const root = await draw(device([{ ...BASE, id: 'send-1', message: 'ship it tonight' }], [delivered]));
    expect(root.querySelectorAll('[data-history="owner"]')).toHaveLength(1);
    expect(must(root.querySelector('[data-send-receipt]'), 'the receipt').getAttribute('data-send-receipt')).toBe(
      'delivered',
    );
  });

  test('puts the unsent words after earlier ones, in the order said', async () => {
    const earlier: HistoryEvent = { kind: 'ferret', key: 'f', at: AT - 10, text: 'Question?' };
    const later: HistoryEvent = { kind: 'ferret', key: 'g', at: AT + 10, text: 'Hmm.' };
    const root = await draw(device([{ ...BASE, id: 'send-5', message: 'mine' }], [earlier, later]));
    expect([...root.querySelectorAll('[data-agenda-history] li')].map(row => row.getAttribute('data-history'))).toEqual(
      ['ferret', 'owner', 'ferret'],
    );
  });
});
