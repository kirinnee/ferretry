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

describe('QueuePageView', () => {
  test('lists each message with its tick count and reason, and counts what waits', () => {
    mounted = view();
    const root = mounted.root;
    expect(text(root.findByType('h1'))).toBe('All queues');
    expect(root.findAll(n => n.props['data-queue-row'] !== undefined)).toHaveLength(4);
    expect(root.findByProps({ 'data-queue-row': 'o1' }).findByProps({ 'data-queue-ticks': 1 })).toBeDefined();
    expect(root.findByProps({ 'data-queue-row': 'q22' }).findByProps({ 'data-queue-ticks': 4 })).toBeDefined();
    expect(text(root.findByProps({ 'data-queue-row': 'q333' }).findByProps({ 'data-queue-meta': 'from' }))).toBe(
      'Mira',
    );
    expect(JSON.stringify(mounted.toJSON())).toContain('waiting for connection');
    expect(JSON.stringify(mounted.toJSON())).toContain('3 messages are waiting');
  });

  test('a row is one plain line: no chips, no ferret name, no sender for your own, no kind for an action', () => {
    mounted = view({ now: Date.parse('2026-10-30T10:15:00.000Z') });
    const row = (id: string) => mounted!.root.findByProps({ 'data-queue-row': id });
    const parts = (id: string) =>
      row(id)
        .findAll(n => n.props['data-queue-meta'] !== undefined)
        .map(n => n.props['data-queue-meta']);
    expect(
      mounted.root.findAll(n => typeof n.props.className === 'string' && n.props.className.includes('kt-badge')),
    ).toHaveLength(0);
    expect(parts('o1')).toEqual(['status']);
    expect(parts('q333')).toEqual(['from', 'status']);
    expect(text(row('o1'))).not.toContain('Casen');
    expect(text(row('o1').findByProps({ 'data-queue-meta': 'status' }))).toBe(
      'On this device · waiting for connection',
    );
    expect(text(row('q1').findByProps({ 'data-queue-meta': 'status' }))).toBe('waiting for its turn');
    const time = row('o1').findByType('time');
    expect(text(time)).toBe('15m ago');
    expect(time.props.dateTime).toBe('2026-10-30T10:00:05.000Z');
  });

  test("a ferret's label shows as the kind, and a blocker marks its row", () => {
    mounted = view({
      groups: [group([queued('q1', 'queued', { label: 'blocker' }), queued('q22', 'queued', { label: 'fyi' })])],
    });
    const row = (id: string) => mounted!.root.findByProps({ 'data-queue-row': id });
    expect(text(row('q1').findByProps({ 'data-queue-meta': 'kind' }))).toBe('blocker');
    expect(row('q1').props['data-queue-kind']).toBe('blocker');
    expect(text(row('q22').findByProps({ 'data-queue-meta': 'kind' }))).toBe('fyi');
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
    const rows = mounted.root.findAll(n => n.type === 'li' && n.props['data-queue-row'] !== undefined);
    expect(rows.map(n => n.props['data-queue-row'])).toEqual(['q1', 'q22', 'q333', 'q4444']);
    expect(mounted.root.findAll(n => n.props['data-queue-next'] === '').map(n => n.props['data-queue-row'])).toEqual([
      'q22',
      'q4444',
    ]);
    expect(text(mounted.root.findByProps({ 'data-queue-row': 'q22' }).findByProps({ 'data-queue-meta': 'next' }))).toBe(
      'Next up',
    );
  });

  test('draws a message the way the chat does, not as a raw run of text', () => {
    mounted = view({ groups: [group([queued('q1', 'queued', { text: 'Fixed **it**, see `code`' })])] });
    const body = text(mounted.root.findByProps({ 'data-queue-body': '' }));
    expect(body).toContain('Fixed it, see code');
    expect(body).not.toContain('**');
    expect(body).not.toContain('`');
  });

  test('a long message is clamped behind Show more; a short one has no control', () => {
    const long = 'a long line of words. '.repeat(30);
    mounted = view({ groups: [group([queued('q1', 'queued', { text: long }), queued('q22', 'queued')])] });
    const row = (id: string) => mounted!.root.findByProps({ 'data-queue-row': id });
    expect(row('q1').findByProps({ 'data-queue-body': '' }).props['data-queue-clamped']).toBe('');
    expect(buttons(row('q1'), 'Show more')).toHaveLength(1);
    expect(buttons(row('q22'), 'Show more')).toHaveLength(0);
    run(() => buttons(row('q1'), 'Show more')[0]?.props.onClick());
    expect(row('q1').findByProps({ 'data-queue-body': '' }).props['data-queue-clamped']).toBeUndefined();
    expect(buttons(row('q1'), 'Show less')[0]?.props['aria-expanded']).toBe(true);
    run(() => buttons(row('q1'), 'Show less')[0]?.props.onClick());
    expect(buttons(row('q1'), 'Show more')).toHaveLength(1);
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

  test('says when nothing waits, and when it is still reading', () => {
    mounted = view({ groups: [] });
    expect(text(mounted.root.findByProps({ 'data-queue-empty': '' }))).toContain('Nothing is waiting');
    mounted.unmount();
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

  test('only a message that can still change offers Edit and Cancel', () => {
    mounted = view();
    expect(buttons(mounted.root.findByProps({ 'data-queue-row': 'o1' }), 'Edit')).toHaveLength(1);
    expect(buttons(mounted.root.findByProps({ 'data-queue-row': 'q22' }), 'Edit')).toHaveLength(0);
  });

  test('edit saves the trimmed words, can be dismissed, and cannot save an empty box', async () => {
    const log: string[] = [];
    mounted = view({ handlers: handlers(log) });
    const row = () => mounted!.root.findByProps({ 'data-queue-row': 'o1' });
    run(() => buttons(row(), 'Edit')[0]?.props.onClick());
    const box = () => row().findByType('textarea');
    run(() => box().props.onChange({ target: { value: '  thanks!  ' } }));
    await runAsync(async () => buttons(row(), 'Save')[0]?.props.onClick());
    expect(log).toEqual(['edit o1 thanks!']);
    expect(row().findAllByType('textarea')).toHaveLength(0);

    run(() => buttons(row(), 'Edit')[0]?.props.onClick());
    run(() => box().props.onChange({ target: { value: '   ' } }));
    expect(buttons(row(), 'Save')[0]?.props.disabled).toBe(true);
    run(() => buttons(row(), 'Keep as is')[0]?.props.onClick());
    expect(row().findAllByType('textarea')).toHaveLength(0);
    expect(text(row().findByProps({ 'data-queue-body': '' }))).toBe('thank you');
  });

  test('cancel goes through the handler; a refusal is said in plain words and the editor stays open', async () => {
    const log: string[] = [];
    mounted = view({ handlers: handlers(log) });
    await runAsync(async () =>
      buttons(mounted!.root.findByProps({ 'data-queue-row': 'o1' }), 'Cancel message')[0]?.props.onClick(),
    );
    expect(log).toEqual(['cancel o1']);

    mounted.unmount();
    mounted = view({ handlers: handlers([], new QueueActionError('It was already typed.', 'typed')) });
    const row = () => mounted!.root.findByProps({ 'data-queue-row': 'o1' });
    run(() => buttons(row(), 'Edit')[0]?.props.onClick());
    await runAsync(async () => buttons(row(), 'Save')[0]?.props.onClick());
    expect(text(row().findByProps({ role: 'status' }))).toBe('It was already typed.');
    expect(row().findAllByType('textarea')).toHaveLength(1);
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
    await runAsync(async () =>
      buttons(mounted!.root.findByProps({ 'data-queue-row': 'o1' }), 'Cancel message')[0]?.props.onClick(),
    );
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
      expect(text(root.findByProps({ 'data-queue-row': id }).findByProps({ 'data-queue-send': 'due' }))).toBe(
        'due now',
      );
    }
    expect(text(root.findByProps({ 'data-queue-group-send': 'due' }))).toBe('due now');
  });

  test('a row waiting on a busy ferret with no hold says when its turn ends; one on this device says nothing', () => {
    mounted = view({ now: NOW, groups: [group([saved, queued('q1', 'queued', { waitReason: 'busy' })])] });
    const { root } = mounted;
    expect(text(root.findByProps({ 'data-queue-row': 'q1' }).findByProps({ 'data-queue-send': 'turn' }))).toBe(
      'when its turn ends',
    );
    expect(text(root.findByProps({ 'data-queue-group-send': 'turn' }))).toBe('when its turn ends');
    expect(
      root.findByProps({ 'data-queue-row': 'o1' }).findAll(n => n.props['data-queue-send'] !== undefined),
    ).toHaveLength(0);
  });
});

describe('older messages on the queue page', () => {
  const older = (props: Partial<Parameters<typeof QueuePageView>[0]> = {}) =>
    view({
      groups: [group([queued('q1', 'read')])],
      olderKeys: new Set(['d1/s1']),
      onLoadOlder: () => undefined,
      ...props,
    });

  test('offers to read older messages only for a ferret the machine has more for, and only when the page can ask', () => {
    mounted = older();
    expect(text(mounted.root.findByProps({ 'data-queue-older': '' }))).toBe('Show older messages');
    mounted.unmount();
    mounted = older({ olderKeys: new Set() });
    expect(mounted.root.findAllByProps({ 'data-queue-older': '' })).toHaveLength(0);
    mounted.unmount();
    mounted = older({ onLoadOlder: undefined });
    expect(mounted.root.findAllByProps({ 'data-queue-older': '' })).toHaveLength(0);
  });

  test('asks for the ferret’s older page when pressed, and says so while reading', () => {
    const asked: string[] = [];
    mounted = older({ onLoadOlder: each => asked.push(each.key) });
    run(() => mounted?.root.findByProps({ 'data-queue-older': '' }).props.onClick());
    expect(asked).toEqual(['d1/s1']);
    mounted.unmount();

    mounted = older({ loadingOlder: 'd1/s1' });
    const button = mounted.root.findByProps({ 'data-queue-older': '' });
    expect(text(button)).toBe('Reading older messages…');
    expect(button.props.disabled).toBe(true);
  });

  test('says a failed read of older messages could not be read, beside the button to try again', () => {
    mounted = older({ olderFailed: 'd1/s1' });
    expect(JSON.stringify(mounted.toJSON())).toContain('Older messages could not be read. Try again.');
    expect(text(mounted.root.findByProps({ 'data-queue-older': '' }))).toBe('Show older messages');
  });
});
