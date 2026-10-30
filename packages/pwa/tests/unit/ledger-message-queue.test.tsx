import { afterEach, describe, expect, test } from 'bun:test';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { LedgerMessage } from '../../src/components/ledger-message.tsx';
import { TranscriptRow } from '../../src/components/transcript-row.tsx';
import { QueueActionsContext } from '../../src/components/queue-actions-context.tsx';
import { QueueActionError, type QueueActions } from '../../src/lib/send-queue.ts';
import type { LedgerSendRecord } from '../../src/lib/send-ledger.ts';
import { actionKeys, chooseAction, closeOpenMenus } from '../support/ledger-menu.ts';
import { render, runAsync } from '../support/react.ts';

afterEach(closeOpenMenus);

const queued = (
  state: 'queued' | 'typing' | 'failed' | 'delivered' = 'queued',
  overrides: Partial<LedgerSendRecord> = {},
): LedgerSendRecord => ({
  sendId: 'q-1',
  acceptedAt: '2026-07-31T10:00:00.000Z',
  message: 'ship the tool group',
  attachmentIds: [],
  fate: 'accepted',
  queue: { state, stateAt: '2026-07-31T10:00:00.000Z', revision: 1, waitReason: 'busy' },
  ...overrides,
});

const textOfNode = (node: ReactTestInstance): string =>
  node.children.map(child => (typeof child === 'string' ? child : textOfNode(child))).join('');

const noop = async (): Promise<boolean> => true;
const handlers = { onCancel: noop, onRetry: noop, onSubmit: noop, write: async () => {} };

const mount = (record: LedgerSendRecord, actions: QueueActions | null): ReactTestRenderer =>
  render(
    <QueueActionsContext.Provider value={actions}>
      <LedgerMessage {...handlers} record={record} />
    </QueueActionsContext.Provider>,
  );

describe('a message still on this device with files to upload', () => {
  const waiting = (files?: readonly string[]): LedgerSendRecord =>
    queued('queued', {
      outbox: { reason: 'waiting for connection', position: 1, of: 1, ...(files === undefined ? {} : { files }) },
    });
  const filesOf = (r: ReactTestRenderer): string[] =>
    r.root
      .findAll(node => node.props['data-outbox-files'] !== undefined && typeof node.type === 'string')
      .map(textOfNode);

  test('names each file and says it uploads when the connection is back', () => {
    const r = mount(waiting(['site-photo.png']), null);
    expect(filesOf(r)).toEqual(['site-photo.pnguploads when the connection is back']);
  });

  test('says nothing about files when it has none', () => {
    expect(filesOf(mount(waiting(), null))).toEqual([]);
  });

  test("the reader's own bubble names them too", () => {
    const record = { ...waiting(['site-photo.png']), senderKind: 'human' as const };
    const r = render(
      <TranscriptRow
        answered={false}
        entry={
          { id: 'send:q-1', kind: 'ledger', text: record.message, ledger: record, placement: 'chronological' } as never
        }
      />,
    );
    expect(filesOf(r)).toEqual(['site-photo.pnguploads when the connection is back']);
  });
});

const find = (r: ReactTestRenderer, attr: string): ReactTestInstance =>
  r.root.find(node => node.props[attr] !== undefined && typeof node.type === 'string');

const tap = async (node: ReactTestInstance): Promise<void> => {
  await runAsync(async () => {
    node.props.onClick();
  });
};

const type = async (r: ReactTestRenderer, value: string): Promise<void> => {
  const area = r.root.find(node => node.props['aria-label'] === 'Edit message' && node.type === 'textarea');
  await runAsync(async () => {
    area.props.onChange({ target: { value } });
  });
};

const calls: string[] = [];
const actions = (edit: QueueActions['edit'], cancel: QueueActions['cancel']): QueueActions => ({
  edit: async (r, t) => {
    calls.push(`edit:${r.sendId}:${t}`);
    return edit(r, t);
  },
  cancel: async r => {
    calls.push(`cancel:${r.sendId}`);
    return cancel(r);
  },
});

describe('what a queued message offers', () => {
  test('Edit, Cancel and Copy, and never a resend or retry', async () => {
    const r = mount(queued(), actions(noop, noop));
    expect(await actionKeys(r)).toEqual(['edit', 'cancel', 'copy']);
  });

  test('without handlers (no context) it offers no edit either', async () => {
    const r = mount(queued(), null);
    expect(await actionKeys(r)).not.toContain('edit');
  });

  test('a message being typed or failed has no edit, no cancel and no retry', async () => {
    for (const state of ['typing', 'failed'] as const) {
      const r = mount(queued(state), actions(noop, noop));
      const keys = await actionKeys(r);
      expect(keys).not.toContain('edit');
      expect(keys).not.toContain('retry');
      expect(keys).not.toContain('send-again');
    }
  });

  test('a queue state the agent already has offers no edit, even on a stale ledger row', async () => {
    const r = mount(queued('queued', { fate: 'delivered' }), actions(noop, noop));
    expect(await actionKeys(r)).not.toContain('edit');
  });
});

describe('editing a queued message', () => {
  test('opens a prefilled editor, saves the trimmed words, and says so', async () => {
    calls.length = 0;
    const r = mount(queued(), actions(noop, noop));
    await chooseAction(r, 'edit');
    expect(find(r, 'data-ledger-edit')).toBeDefined();
    await type(r, '  new words  ');
    await tap(find(r, 'data-ledger-edit-save'));
    expect(calls).toEqual(['edit:q-1:new words']);
    expect(r.root.findAll(node => node.props['data-ledger-edit'] !== undefined)).toHaveLength(0);
    expect(textOfNode(r.root)).toContain('Saved — it waits with its new words.');
  });

  test('Save is off while the box is empty, and does nothing', async () => {
    calls.length = 0;
    const r = mount(queued(), actions(noop, noop));
    await chooseAction(r, 'edit');
    await type(r, '   ');
    expect(find(r, 'data-ledger-edit-save').props.disabled).toBe(true);
    await tap(find(r, 'data-ledger-edit-save'));
    expect(calls).toEqual([]);
  });

  test('"Keep as it was" closes the editor without a request', async () => {
    calls.length = 0;
    const r = mount(queued(), actions(noop, noop));
    await chooseAction(r, 'edit');
    await tap(r.root.find(node => node.type === 'button' && textOfNode(node) === 'Keep as it was'));
    expect(r.root.findAll(node => node.props['data-ledger-edit'] !== undefined)).toHaveLength(0);
    expect(calls).toEqual([]);
  });

  test('a false answer keeps the editor open with an error', async () => {
    const r = mount(
      queued(),
      actions(async () => false, noop),
    );
    await chooseAction(r, 'edit');
    await tap(find(r, 'data-ledger-edit-save'));
    expect(find(r, 'data-ledger-edit')).toBeDefined();
    expect(textOfNode(r.root)).toContain('The edit was not saved');
  });

  test('a 409 says it was just typed and closes the editor', async () => {
    const typed = new QueueActionError(
      'It was just typed into the agent, so it can no longer be changed or taken back.',
      'typed',
    );
    const r = mount(
      queued(),
      actions(async () => {
        throw typed;
      }, noop),
    );
    await chooseAction(r, 'edit');
    await tap(find(r, 'data-ledger-edit-save'));
    expect(r.root.findAll(node => node.props['data-ledger-edit'] !== undefined)).toHaveLength(0);
    expect(textOfNode(r.root)).toContain('just typed into the agent');
  });

  test('a 404 says the queue no longer has it', async () => {
    const gone = new QueueActionError('The queue no longer has this message.', 'unknown');
    const r = mount(
      queued(),
      actions(async () => {
        throw gone;
      }, noop),
    );
    await chooseAction(r, 'edit');
    await tap(find(r, 'data-ledger-edit-save'));
    expect(textOfNode(r.root)).toContain('The queue no longer has this message.');
  });
});

describe('cancelling a queued message', () => {
  test('sends the cancel and says so', async () => {
    calls.length = 0;
    const r = mount(queued(), actions(noop, noop));
    await chooseAction(r, 'cancel');
    expect(calls).toEqual(['cancel:q-1']);
    expect(textOfNode(r.root)).toContain('Cancel sent');
  });

  test('a 409 is said plainly', async () => {
    const typed = new QueueActionError(
      'It was just typed into the agent, so it can no longer be changed or taken back.',
      'typed',
    );
    const r = mount(
      queued(),
      actions(noop, async () => {
        throw typed;
      }),
    );
    await chooseAction(r, 'cancel');
    expect(textOfNode(r.root)).toContain('just typed into the agent');
  });
});
