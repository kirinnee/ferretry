import { afterEach, describe, expect, test } from 'bun:test';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { QueuePageView, type QueueRowHandlers } from '../../src/components/queue-page.tsx';
import { outboxRowOf, queueRowOf, type QueueGroup } from '../../src/lib/queue-view.ts';
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
          queued('q333', 'queued', { by: { kind: 'ferret', name: 'Mira' } }),
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
  test('lists each message with its tick count, reason and a sender chip, and counts what waits', () => {
    mounted = view();
    const root = mounted.root;
    expect(text(root.findByType('h1'))).toBe('All queues');
    expect(root.findAll(n => n.props['data-queue-row'] !== undefined)).toHaveLength(4);
    expect(root.findByProps({ 'data-queue-row': 'o1' }).findByProps({ 'data-queue-ticks': 1 })).toBeDefined();
    expect(root.findByProps({ 'data-queue-row': 'q22' }).findByProps({ 'data-queue-ticks': 4 })).toBeDefined();
    expect(text(root.findByProps({ 'data-queue-sender': '' }))).toBe('Mira');
    expect(JSON.stringify(mounted.toJSON())).toContain('waiting for connection');
    expect(JSON.stringify(mounted.toJSON())).toContain('3 messages are waiting');
  });

  test('says when nothing waits, and when it is still reading', () => {
    mounted = view({ groups: [] });
    expect(JSON.stringify(mounted.toJSON())).toContain('Nothing is waiting.');
    mounted.unmount();
    mounted = view({ groups: [], loading: true });
    expect(JSON.stringify(mounted.toJSON())).toContain('Reading the queues');
    expect(JSON.stringify(mounted.toJSON())).not.toContain('Nothing is waiting.');
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
    expect(text(row().findByType('p'))).toBe('thank you');
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
