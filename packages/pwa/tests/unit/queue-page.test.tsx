import { afterEach, describe, expect, test } from 'bun:test';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { QueuePageView, type QueueRowHandlers } from '../../src/components/queue-page.tsx';
import { clockOfInstant } from '../../src/lib/message-clock.ts';
import { outboxRowOf, type QueueGroup, queueRowOf } from '../../src/lib/queue-view.ts';
import { QueueActionError } from '../../src/lib/send-queue.ts';
import { render, run, runAsync } from '../support/react.ts';

let mounted: ReactTestRenderer | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

const queued = (id: string, state: string, extra: object = {}) =>
  queueRowOf('d1', 's1', 'Casen', {
    id,
    sender: 'human',
    text: `text ${id}`,
    state,
    enqueuedAt: `2026-10-30T10:00:0${id.length}.000Z`,
    revision: 1,
    ...extra,
  } as never);

const saved = outboxRowOf('Casen', {
  id: 'o1',
  daemonId: 'd1',
  sessionId: 's1',
  message: 'thank you',
  attachmentIds: [],
  files: [],
  now: false,
  createdAt: '2026-10-30T10:00:05.000Z',
  seq: 1,
});

const group = (rows: QueueGroup['rows'], key = 'd1/s1'): QueueGroup => ({
  key,
  daemonId: 'd1',
  machine: 'Laptop',
  sessionId: 's1',
  ferret: 'Casen',
  rows,
});

const handlers = (log: string[], fail?: Error): QueueRowHandlers => ({
  edit: async (row, text) => {
    if (fail) throw fail;
    log.push(`edit ${row.id} ${text}`);
  },
  cancel: async row => {
    if (fail) throw fail;
    log.push(`cancel ${row.id}`);
  },
});

const view = (props: Partial<Parameters<typeof QueuePageView>[0]> = {}) =>
  render(
    <QueuePageView
      groups={[
        group([
          saved,
          queued('q1', 'queued'),
          queued('q22', 'read'),
          queued('q333', 'queued', { sender: 'agent', by: { kind: 'ferret', name: 'Mira' } }),
        ]),
      ]}
      handlers={handlers([])}
      loading={false}
      onOpenFerret={() => undefined}
      showMachine={false}
      title="All queues"
      {...props}
    />,
  );

const text = (node: ReactTestInstance): string =>
  node.children.map(child => (typeof child === 'string' ? child : text(child))).join('');
const buttons = (root: ReactTestInstance, label: string) => root.findAll(n => n.type === 'button' && text(n) === label);

const rowIds = (root: ReactTestInstance) =>
  root.findAll(n => n.type === 'li' && n.props['data-queue-row'] !== undefined).map(n => n.props['data-queue-row']);
const row = (id: string) => mounted!.root.findByProps({ 'data-queue-row': id });
const line = (id: string) => row(id).findByProps({ 'data-queue-line': '' });
const open = (id: string) => run(() => line(id).props.onClick());
const toggle = (listing: 'unsent' | 'sent') =>
  run(() => mounted!.root.findByProps({ 'data-queue-listing': listing }).props.onClick());
const searchFor = (value: string) =>
  run(() => mounted!.root.findByProps({ 'data-queue-search': '' }).props.onChange({ target: { value } }));
const statusOf = (id: string) => text(row(id).findByProps({ 'data-queue-meta': 'status' }));

describe('QueuePageView', () => {
  test('opens on the messages that have not been delivered: waiting, sending and failed; delivered and read are behind Sent', () => {
    mounted = view({
      groups: [
        group([
          saved,
          queued('q1', 'queued'),
          queued('q22', 'read'),
          queued('q333', 'typing'),
          queued('q4444', 'delivered'),
          queued('q55555', 'failed'),
          queued('q666666', 'unconfirmed'),
        ]),
      ],
    });
    expect(text(mounted.root.findByType('h1'))).toBe('All queues');
    expect(rowIds(mounted.root).sort()).toEqual(['o1', 'q1', 'q333', 'q55555', 'q666666'].sort());
    expect(mounted.root.findByProps({ 'data-queue-listing': 'unsent' }).props['aria-pressed']).toBe(true);
    expect(text(mounted.root.findByProps({ 'data-queue-listing-count': 'unsent' }))).toBe('5');
    expect(text(mounted.root.findByProps({ 'data-queue-listing-count': 'sent' }))).toBe('2');
    // The tab says Not sent 5; the header explains it in the same words: 4 waiting + 1 failed.
    expect(text(mounted.root.findByProps({ className: 'fy-queue-count' }))).toBe('4 waiting · 1 failed');
  });

  test('the Sent toggle swaps to delivered and read messages, newest first', () => {
    mounted = view({
      groups: [
        group([
          queued('q1', 'queued'),
          queued('old', 'read', { enqueuedAt: '2026-10-01T10:00:00.000Z' }),
          queued('new', 'delivered', { enqueuedAt: '2026-10-30T10:00:00.000Z' }),
          queued('mid', 'read', { enqueuedAt: '2026-10-15T10:00:00.000Z' }),
        ]),
      ],
    });
    toggle('sent');
    expect(rowIds(mounted.root)).toEqual(['new', 'mid', 'old']);
    expect(mounted.root.findByProps({ 'data-queue-listing': 'sent' }).props['aria-pressed']).toBe(true);
    toggle('unsent');
    expect(rowIds(mounted.root)).toEqual(['q1']);
  });

  test('a long sent history shows a page of rows and offers Show older', () => {
    const many = Array.from({ length: 130 }, (_, index) =>
      queued(`s${String(index).padStart(3, '0')}`, 'read', {
        enqueuedAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
      }),
    );
    mounted = view({ groups: [group(many)] });
    toggle('sent');
    expect(rowIds(mounted.root)).toHaveLength(100);
    expect(rowIds(mounted.root)[0]).toBe('s129');
    expect(text(mounted.root.findByProps({ 'data-queue-older': '' }))).toBe('Show older messages (30 more)');
    run(() => mounted!.root.findByProps({ 'data-queue-older': '' }).props.onClick());
    expect(rowIds(mounted.root)).toHaveLength(130);
    expect(mounted.root.findAllByProps({ 'data-queue-older': '' })).toHaveLength(0);
  });

  test('each row leads with its status word: Waiting, Sending, Delivered, Read, Failed', () => {
    mounted = view({
      groups: [
        group([
          saved,
          queued('q1', 'queued'),
          queued('q22', 'typing'),
          queued('q333', 'unconfirmed'),
          queued('q4444', 'failed'),
          queued('q55555', 'delivered'),
          queued('q666666', 'read'),
        ]),
      ],
    });
    expect(['o1', 'q1', 'q22', 'q333', 'q4444'].map(statusOf)).toEqual([
      'Waiting',
      'Waiting',
      'Sending',
      'Sending',
      'Failed',
    ]);
    toggle('sent');
    expect(['q55555', 'q666666'].map(statusOf)).toEqual(['Delivered', 'Read']);
    // The status is the first thing in the line, and it carries an icon (not colour alone).
    const first = line('q55555').children[0] as ReactTestInstance;
    const word = first.findByProps({ 'data-queue-status': 'delivered' });
    expect(word.findAll(n => n.props['aria-hidden'] === 'true').length).toBeGreaterThan(0);
  });

  test('a row is one line — status, sender, first line of the words, time — and a tap opens the full text', () => {
    const long = 'First line of the note\n\nSecond paragraph with **the rest** of it';
    mounted = view({
      now: Date.parse('2026-10-30T10:15:00.000Z'),
      groups: [group([queued('q1', 'queued', { text: long, sender: 'agent', by: { kind: 'ferret', name: 'Mira' } })])],
    });
    const parts = (line('q1').children as ReactTestInstance[]).map(child => text(child));
    expect(parts).toEqual(['Waiting', 'Mira', 'Next up', 'First line of the note', '15m ago']);
    expect(line('q1').type).toBe('button');
    expect(line('q1').props['aria-expanded']).toBe(false);
    expect(row('q1').findAllByProps({ 'data-queue-body': '' })).toHaveLength(0);
    // No separator characters are drawn between the parts of the line (nothing can start a wrapped line with one).
    expect(text(line('q1'))).not.toContain('·');

    open('q1');
    expect(line('q1').props['aria-expanded']).toBe(true);
    expect(line('q1').props['aria-controls']).toBe(row('q1').findByProps({ 'data-queue-detail': '' }).props.id);
    const body = text(row('q1').findByProps({ 'data-queue-body': '' }));
    expect(body).toContain('Second paragraph with the rest of it');
    expect(body).not.toContain('**');
    open('q1');
    expect(line('q1').props['aria-expanded']).toBe(false);
    expect(row('q1').findAllByProps({ 'data-queue-detail': '' })).toHaveLength(0);
  });

  test('a message whose time cannot be read keeps its empty time cell and claims no age', () => {
    mounted = view({ groups: [group([queued('q1', 'queued', { enqueuedAt: 'not a time' })])] });
    expect(row('q1').findAllByType('time')).toHaveLength(0);
    const parts = (line('q1').children as ReactTestInstance[]).map(child => text(child));
    expect(parts).toEqual(['Waiting', 'You', 'Next up', 'text q1', '']);
  });

  test('the line shows your own messages as You, the owner of a ferret message by name, and only the first line of a heading', () => {
    mounted = view({
      groups: [
        group([
          queued('q1', 'queued', { text: '## Review notes\nmore' }),
          queued('q22', 'queued', { sender: 'agent', by: { kind: 'ferret', name: 'Mira' } }),
        ]),
      ],
    });
    expect(text(row('q1').findByProps({ 'data-queue-meta': 'from' }))).toBe('You');
    expect(text(row('q22').findByProps({ 'data-queue-meta': 'from' }))).toBe('Mira');
    expect(text(row('q1').findByProps({ 'data-queue-snippet': '' }))).toBe('Review notes');
  });

  test('an opened row says why it waits, its kind when not an action, and a blocker is marked', () => {
    mounted = view({
      groups: [group([queued('q1', 'queued', { label: 'blocker' }), queued('q22', 'queued', { label: 'fyi' }), saved])],
    });
    open('q1');
    open('q22');
    open('o1');
    expect(text(row('q1').findByProps({ 'data-queue-meta': 'kind' }))).toBe('blocker');
    expect(row('q1').props['data-queue-kind']).toBe('blocker');
    expect(text(row('q22').findByProps({ 'data-queue-meta': 'kind' }))).toBe('fyi');
    expect(text(row('q1').findByProps({ 'data-queue-meta': 'why' }))).toBe('waiting for its turn');
    expect(text(row('o1').findByProps({ 'data-queue-meta': 'why' }))).toBe('On this device · waiting for connection');
    expect(row('o1').findAllByProps({ 'data-queue-meta': 'kind' })).toHaveLength(0);
  });

  test('marks the one message that is delivered next per ferret, in delivery order, not screen order', () => {
    const mira = { sender: 'agent', by: { kind: 'ferret', name: 'Mira' } };
    mounted = view({
      groups: [
        group([
          queued('q1', 'queued', { ...mira, label: 'fyi', enqueuedAt: '2026-10-30T10:00:09.000Z' }),
          queued('q22', 'queued'),
        ]),
        group([queued('q333', 'read'), queued('q4444', 'queued')], 'd1/s2'),
      ],
    });
    expect(rowIds(mounted.root)).toEqual(['q1', 'q22', 'q4444']);
    expect(mounted.root.findAll(n => n.props['data-queue-next'] === '').map(n => n.props['data-queue-row'])).toEqual([
      'q22',
      'q4444',
    ]);
    // The word is on the row itself, closed — a visible chip, not an unexplained colour — and only on the next one.
    expect(mounted.root.findAll(n => n.props['data-queue-chip'] === 'next').map(n => text(n))).toEqual([
      'Next up',
      'Next up',
    ]);
    expect(row('q1').findAllByProps({ 'data-queue-chip': 'next' })).toHaveLength(0);
    expect(text(row('q22').findByProps({ 'data-queue-chip': 'next' }))).toBe('Next up');
    open('q22');
    expect(text(row('q22').findByProps({ 'data-queue-meta': 'next' }))).toBe('Next up');
  });

  test("a search narrows the next-up mark to the ferret's whole queue, not to the matching rows", () => {
    mounted = view({
      groups: [
        group([
          queued('q1', 'queued', { text: 'alpha' }),
          queued('q22', 'queued', { text: 'beta', enqueuedAt: '2026-10-30T10:30:00.000Z' }),
        ]),
      ],
    });
    searchFor('beta');
    expect(rowIds(mounted.root)).toEqual(['q22']);
    expect(row('q22').props['data-queue-next']).toBeUndefined();
  });

  test('a search does not change the ferret\u2019s next-send promise in its heading', () => {
    mounted = view({
      now: Date.parse('2026-11-04T11:00:00.000Z'),
      groups: [
        group([
          queued('q1', 'queued', { text: 'alpha', holdUntil: '2026-11-04T11:20:00.000Z' }),
          queued('q22', 'queued', { text: 'beta', holdUntil: '2026-11-04T11:30:00.000Z' }),
        ]),
      ],
    });
    const earliest = '2026-11-04T11:20:00.000Z';
    expect(mounted.root.findAllByProps({ 'data-queue-group-send': earliest })).toHaveLength(1);
    searchFor('beta');
    expect(rowIds(mounted.root)).toEqual(['q22']);
    expect(mounted.root.findAllByProps({ 'data-queue-group-send': earliest })).toHaveLength(1);
  });

  test('search finds messages by their words and by their sender, in any case, in either list', () => {
    mounted = view({
      groups: [
        group([
          queued('q1', 'queued', { text: 'Please rerun CI' }),
          queued('q22', 'queued', { text: 'Deploy is blocked', sender: 'agent', by: { kind: 'ferret', name: 'Mira' } }),
          queued('q333', 'read', { text: 'Old CI note' }),
          queued('q4444', 'read', { text: 'Shipped', sender: 'agent', by: { kind: 'ferret', name: 'Mira' } }),
        ]),
      ],
    });
    searchFor('RERUN');
    expect(rowIds(mounted.root)).toEqual(['q1']);
    searchFor('mIrA');
    expect(rowIds(mounted.root)).toEqual(['q22']);
    // The toggles count what each list holds for this search.
    expect(text(mounted.root.findByProps({ 'data-queue-listing-count': 'sent' }))).toBe('1');
    toggle('sent');
    expect(rowIds(mounted.root)).toEqual(['q4444']);
    searchFor('ci');
    expect(rowIds(mounted.root)).toEqual(['q333']);
    searchFor('you');
    expect(rowIds(mounted.root)).toEqual(['q333']);
  });

  test('a search with no match says so, points to the other list, and the clear control brings the rows back', () => {
    mounted = view({
      groups: [group([queued('q1', 'queued', { text: 'alpha' }), queued('q22', 'read', { text: 'zebra' })])],
    });
    expect(mounted.root.findAllByProps({ 'data-queue-search-clear': '' })).toHaveLength(0);
    searchFor('zebra');
    const none = mounted.root.findByProps({ 'data-queue-no-matches': '' });
    expect(text(none)).toContain('Nothing in Not sent matches “zebra”');
    expect(text(none)).toContain('1 match in Sent');
    run(() => mounted!.root.findByProps({ 'data-queue-search-clear': '' }).props.onClick());
    expect(mounted.root.findAllByProps({ 'data-queue-no-matches': '' })).toHaveLength(0);
    expect(mounted.root.findByProps({ 'data-queue-search': '' }).props.value).toBe('');
    expect(rowIds(mounted.root)).toEqual(['q1']);
    searchFor('nothing like it');
    run(() => buttons(mounted!.root.findByProps({ 'data-queue-no-matches': '' }), 'Clear search')[0]?.props.onClick());
    expect(rowIds(mounted.root)).toEqual(['q1']);
  });

  test('with nothing waiting it says so plainly, and the Sent toggle is still there', () => {
    mounted = view({ groups: [group([queued('q1', 'read')])] });
    expect(text(mounted.root.findByProps({ 'data-queue-empty': '' }))).toContain('Nothing is waiting');
    expect(text(mounted.root.findByProps({ 'data-queue-listing-count': 'sent' }))).toBe('1');
    toggle('sent');
    expect(rowIds(mounted.root)).toEqual(['q1']);
    expect(mounted.root.findAllByProps({ 'data-queue-empty': '' })).toHaveLength(0);
  });

  test('an empty Sent list says nothing was sent', () => {
    mounted = view({ groups: [group([queued('q1', 'queued')])] });
    toggle('sent');
    expect(text(mounted.root.findByProps({ 'data-queue-empty': '' }))).toContain('Nothing sent yet');
  });

  test('a ferret with nothing queued shows the empty card, not an empty heading', () => {
    mounted = view({ groups: [group([])] });
    expect(mounted.root.findAll(n => n.props['data-queue-group'] !== undefined)).toHaveLength(0);
    expect(mounted.root.findByProps({ 'data-queue-empty': '' })).toBeDefined();
  });

  test('the empty card offers the way back to every queue', () => {
    let all = 0;
    mounted = view({ groups: [], onShowAll: () => all++ });
    run(() => buttons(mounted!.root.findByProps({ 'data-queue-empty': '' }), 'See all queues')[0]?.props.onClick());
    expect(all).toBe(1);
    mounted.unmount();
    mounted = view({ groups: [] });
    expect(buttons(mounted.root.findByProps({ 'data-queue-empty': '' }), 'See all queues')).toHaveLength(0);
  });

  test('says when it is still reading', () => {
    mounted = view({ groups: [], loading: true });
    expect(JSON.stringify(mounted.toJSON())).toContain('Reading the queues');
    expect(JSON.stringify(mounted.toJSON())).not.toContain('Nothing is waiting');
  });

  test('names the machine only when several show, opens the ferret, and offers All queues when asked', () => {
    const opened: string[] = [];
    let all = 0;
    mounted = view({ showMachine: true, onOpenFerret: g => opened.push(g.key), onShowAll: () => all++ });
    expect(JSON.stringify(mounted.toJSON())).toContain('Laptop');
    run(() => buttons(mounted!.root, 'Casen')[0]?.props.onClick());
    run(() => buttons(mounted!.root, 'All queues')[0]?.props.onClick());
    expect(opened).toEqual(['d1/s1']);
    expect(all).toBe(1);
  });

  test('only a message that can still change offers Edit and Cancel, once opened', () => {
    mounted = view({ groups: [group([saved, queued('q1', 'failed')])] });
    expect(buttons(row('o1'), 'Edit')).toHaveLength(0);
    open('o1');
    open('q1');
    expect(buttons(row('o1'), 'Edit')).toHaveLength(1);
    expect(buttons(row('q1'), 'Edit')).toHaveLength(0);
  });

  test('edit saves the trimmed words, can be dismissed, and cannot save an empty box', async () => {
    const log: string[] = [];
    mounted = view({ handlers: handlers(log) });
    open('o1');
    const box = () => row('o1').findByType('textarea');
    run(() => buttons(row('o1'), 'Edit')[0]?.props.onClick());
    run(() => box().props.onChange({ target: { value: '  thanks!  ' } }));
    await runAsync(async () => buttons(row('o1'), 'Save')[0]?.props.onClick());
    expect(log).toEqual(['edit o1 thanks!']);
    expect(row('o1').findAllByType('textarea')).toHaveLength(0);

    run(() => buttons(row('o1'), 'Edit')[0]?.props.onClick());
    run(() => box().props.onChange({ target: { value: '   ' } }));
    expect(buttons(row('o1'), 'Save')[0]?.props.disabled).toBe(true);
    run(() => buttons(row('o1'), 'Keep as is')[0]?.props.onClick());
    expect(row('o1').findAllByType('textarea')).toHaveLength(0);
    expect(text(row('o1').findByProps({ 'data-queue-body': '' }))).toBe('thank you');
  });

  test('cancel goes through the handler; a refusal is said in plain words and the editor stays open', async () => {
    const log: string[] = [];
    mounted = view({ handlers: handlers(log) });
    open('o1');
    await runAsync(async () => buttons(row('o1'), 'Cancel message')[0]?.props.onClick());
    expect(log).toEqual(['cancel o1']);

    mounted.unmount();
    mounted = view({ handlers: handlers([], new QueueActionError('It was already typed.', 'typed')) });
    open('o1');
    run(() => buttons(row('o1'), 'Edit')[0]?.props.onClick());
    await runAsync(async () => buttons(row('o1'), 'Save')[0]?.props.onClick());
    expect(text(row('o1').findByProps({ role: 'status' }))).toBe('It was already typed.');
    expect(row('o1').findAllByType('textarea')).toHaveLength(1);
  });

  test('a failure that is not an Error still says something', async () => {
    mounted = view({
      handlers: {
        edit: async () => undefined,
        cancel: async () => {
          throw 'nope';
        },
      },
    });
    open('o1');
    await runAsync(async () => buttons(row('o1'), 'Cancel message')[0]?.props.onClick());
    expect(JSON.stringify(mounted.toJSON())).toContain('That did not work.');
  });
});

describe('QueuePageView send times', () => {
  const NOW = Date.parse('2026-11-04T11:00:00.000Z');
  const clock = (instant: string): string => clockOfInstant(instant)?.short ?? '';

  test('each held row says when it sends and the ferret shows the earliest', () => {
    mounted = view({
      now: NOW,
      groups: [
        group([
          queued('q1', 'queued', { holdUntil: '2026-11-04T11:30:00.000Z' }),
          queued('q22', 'queued', { holdUntil: '2026-11-04T11:20:00.000Z' }),
        ]),
      ],
    });
    const { root } = mounted;
    open('q1');
    expect(
      text(root.findByProps({ 'data-queue-row': 'q1' }).findByProps({ 'data-queue-send': '2026-11-04T11:30:00.000Z' })),
    ).toBe(`sends by ${clock('2026-11-04T11:30:00.000Z')}`);
    expect(text(root.findByProps({ 'data-queue-group-send': '2026-11-04T11:20:00.000Z' }))).toBe(
      `next send ${clock('2026-11-04T11:20:00.000Z')}`,
    );
  });

  test('a hold that is up says due now, on the row and on the ferret, whatever a later hold says', () => {
    mounted = view({
      now: NOW,
      groups: [
        group([
          queued('q1', 'queued', { holdUntil: '2026-11-04T11:20:00.000Z' }),
          queued('q22', 'queued', { holdUntil: '2026-11-04T10:59:00.000Z' }),
          queued('q3', 'queued', { holdUntil: '2026-11-04T11:00:00.000Z' }),
        ]),
      ],
    });
    const { root } = mounted;
    for (const id of ['q22', 'q3']) {
      open(id);
      expect(text(root.findByProps({ 'data-queue-row': id }).findByProps({ 'data-queue-send': 'due' }))).toBe(
        'due now',
      );
    }
    expect(text(root.findByProps({ 'data-queue-group-send': 'due' }))).toBe('due now');
  });

  test('a row waiting on a busy ferret with no hold says when its turn ends; one on this device says nothing', () => {
    mounted = view({ now: NOW, groups: [group([saved, queued('q1', 'queued', { waitReason: 'busy' })])] });
    const { root } = mounted;
    open('q1');
    open('o1');
    expect(text(root.findByProps({ 'data-queue-row': 'q1' }).findByProps({ 'data-queue-send': 'turn' }))).toBe(
      'when its turn ends',
    );
    expect(text(root.findByProps({ 'data-queue-group-send': 'turn' }))).toBe('when its turn ends');
    expect(
      root.findByProps({ 'data-queue-row': 'o1' }).findAll(n => n.props['data-queue-send'] !== undefined),
    ).toHaveLength(0);
  });
});
