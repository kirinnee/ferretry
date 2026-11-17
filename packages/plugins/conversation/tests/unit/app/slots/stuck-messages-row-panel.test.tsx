import { describe, expect, test } from 'bun:test';
import { FerretWorkspaceActionsProvider } from '@ferretry/app';
import type { PanelProps } from '@ferretry/kernel/manifest';
import { ensureDom, render, run, runAsync } from '@ferretry/app/testing';
import type { ActionsRowOffer } from '@ferretry/core-ferrets/contract';
import { QueueChanged } from '@ferretry/core-mailbox/contract';
import {
  OPEN_QUEUE_ROW_ID,
  QUEUE_PANEL_ID,
  StuckMessagesRowPanel,
} from '../../../../app/slots/stuck-messages-row-panel.tsx';
import {
  CLEAR_STUCK_MESSAGES_ACTION_ID,
  DISMISS_CANCELLED_ACTION_ID,
} from '../../../../app/chat/use-stuck-message-actions.tsx';
import { type FakeClient, fakeClient } from '../../../support/app/fake-client.ts';
import { withClient } from '../../../support/app/client.tsx';

ensureDom();

const slot = (props: object): PanelProps => props as PanelProps;

const SENDS = 'GET /v1/ferrets/:ferretId/sends';
const CANCEL = 'POST /v1/ferrets/:ferretId/sends/:sendId/cancel';

const settle = async (): Promise<void> => {
  await runAsync(async () => {
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const NOW = new Date().toISOString();
const row = (sendId: string, fate: string, extra: object = {}): object => ({
  v: 1,
  sendId,
  acceptedAt: NOW,
  acceptedTurn: 1,
  path: 'direct',
  message: `message ${sendId}`,
  attachmentIds: [],
  fate,
  ...extra,
});

/** The ledger: two messages nothing proved arrived, one a person took back, one delivered. */
const LEDGER = [
  row('sending', 'accepted'),
  row('queued', 'queued'),
  row('cancelled', 'cancelled', { fateAt: NOW, cancelEffect: 'cleared' }),
  row('delivered', 'delivered'),
];

interface Offers {
  readonly log: { id: string; row: ActionsRowOffer | null }[];
  readonly offer: (id: string, row: ActionsRowOffer | null) => void;
  readonly current: (id: string) => ActionsRowOffer | null;
}

const offers = (): Offers => {
  const log: { id: string; row: ActionsRowOffer | null }[] = [];
  return {
    log,
    offer: (id, next) => void log.push({ id, row: next }),
    current: id => log.findLast(entry => entry.id === id)?.row ?? null,
  };
};

const ledgerClient = (sends: readonly object[] = LEDGER): FakeClient =>
  fakeClient({
    [SENDS]: () => ({ sends }),
    [CANCEL]: call => row(call.params['sendId'] ?? '', 'cancelled'),
  });

interface Workspace {
  readonly ferret: string;
  readonly shown: string[];
  readonly shows?: (panel: string) => boolean;
}

const mount = async (client: FakeClient, held: Offers, canControl = true, workspace?: Workspace) => {
  const panel = <StuckMessagesRowPanel {...slot({ canControl, ferret: 'f1', name: 'Ferret', offer: held.offer })} />;
  const view = render(
    withClient(
      client,
      workspace === undefined ? (
        panel
      ) : (
        <FerretWorkspaceActionsProvider
          canControl
          daemon="alpha"
          ferret={workspace.ferret}
          showPanel={id => workspace.shown.push(id)}
          shows={workspace.shows ?? (() => true)}
        >
          {panel}
        </FerretWorkspaceActionsProvider>
      ),
    ),
  );
  await settle();
  return view;
};

describe('Clear stuck messages and Dismiss all cancelled in the Actions ▾ menu', () => {
  test('offers a confirm row counting what is stuck and a run row for the cancelled notes', async () => {
    const held = offers();
    const view = await mount(ledgerClient(), held);
    const clear = held.current(CLEAR_STUCK_MESSAGES_ACTION_ID);
    // The two waiting messages and the cancelled note are what "Clear" puts away.
    expect(clear).toMatchObject({
      kind: 'confirm',
      id: CLEAR_STUCK_MESSAGES_ACTION_ID,
      label: 'Clear stuck messages',
      group: 'ferret',
      detail: '3',
      confirmLabel: 'Clear messages',
    });
    expect(held.current(DISMISS_CANCELLED_ACTION_ID)).toMatchObject({
      kind: 'run',
      label: 'Dismiss all cancelled',
      group: 'ferret',
      detail: '1',
    });
    run(() => view.unmount());
  });

  test('Clear takes each stuck message back, one cancel per message', async () => {
    const client = ledgerClient();
    const held = offers();
    const view = await mount(client, held);
    await runAsync(async () => await held.current(CLEAR_STUCK_MESSAGES_ACTION_ID)?.run());
    expect(client.callsTo(CANCEL).map(call => call.params)).toEqual([
      { ferretId: 'f1', sendId: 'sending' },
      { ferretId: 'f1', sendId: 'queued' },
    ]);
    run(() => view.unmount());
  });

  test('Dismiss all cancelled puts the notes away on this device and says nothing is left to dismiss', async () => {
    const client = ledgerClient([row('only-cancelled', 'cancelled', { fateAt: NOW })]);
    const held = offers();
    const view = await mount(client, held);
    await runAsync(async () => await held.current(DISMISS_CANCELLED_ACTION_ID)?.run());
    await settle();
    expect(client.callsTo(CANCEL)).toEqual([]);
    expect(held.current(DISMISS_CANCELLED_ACTION_ID)).toMatchObject({ unavailable: 'no cancelled messages' });
    run(() => view.unmount());
  });

  test('lists the rows dimmed, with a reason, when nothing is stuck', async () => {
    const held = offers();
    const view = await mount(ledgerClient([row('delivered', 'delivered')]), held);
    expect(held.current(CLEAR_STUCK_MESSAGES_ACTION_ID)).toMatchObject({ unavailable: 'no stuck messages' });
    run(() => view.unmount());
  });

  test('reads the ledger again when the ferret’s queue moves, and takes the rows back on unmount', async () => {
    // Fresh ids: this device's dismissals outlive a test, and the Clear test above put its own ids away.
    const sends: object[] = [row('wake-1', 'accepted')];
    const client = fakeClient({ [SENDS]: () => ({ sends }) });
    const held = offers();
    const view = await mount(client, held);
    expect(held.current(CLEAR_STUCK_MESSAGES_ACTION_ID)).toMatchObject({ detail: '1' });
    sends.push(row('wake-2', 'queued'));
    run(() => client.emit(QueueChanged.name, { ferret: 'someone-else' }));
    await settle();
    expect(held.current(CLEAR_STUCK_MESSAGES_ACTION_ID)).toMatchObject({ detail: '1' });
    run(() => client.emit(QueueChanged.name, { ferret: 'f1' }));
    await settle();
    expect(held.current(CLEAR_STUCK_MESSAGES_ACTION_ID)).toMatchObject({ detail: '2' });
    run(() => view.unmount());
    expect(held.current(CLEAR_STUCK_MESSAGES_ACTION_ID)).toBeNull();
    expect(held.current(DISMISS_CANCELLED_ACTION_ID)).toBeNull();
  });

  test('offers nothing, and reads nothing, to someone who may not control the ferret', async () => {
    const client = ledgerClient();
    const held = offers();
    const view = await mount(client, held, false);
    expect(held.current(CLEAR_STUCK_MESSAGES_ACTION_ID)).toBeNull();
    expect(held.current(DISMISS_CANCELLED_ACTION_ID)).toBeNull();
    expect(client.calls).toEqual([]);
    run(() => view.unmount());
  });
});

describe('Queue… in the Actions ▾ menu', () => {
  test('brings this ferret’s queue panel on screen', async () => {
    const shown: string[] = [];
    const held = offers();
    const view = await mount(ledgerClient(), held, true, { ferret: 'f1', shown });
    const queue = held.current(OPEN_QUEUE_ROW_ID);
    expect(queue).toMatchObject({ kind: 'run', label: 'Queue…', group: 'ferret' });
    await runAsync(async () => await queue?.run());
    expect(shown).toEqual([QUEUE_PANEL_ID]);
    expect(QUEUE_PANEL_ID).toBe('queue');
    run(() => view.unmount());
    expect(held.current(OPEN_QUEUE_ROW_ID)).toBeNull();
  });

  test('is not offered outside a workspace, beside another ferret, or where the layout leaves the queue out', async () => {
    for (const workspace of [
      undefined,
      { ferret: 'another', shown: [] },
      { ferret: 'f1', shown: [], shows: () => false },
    ] satisfies (Workspace | undefined)[]) {
      const held = offers();
      const view = await mount(ledgerClient(), held, true, workspace);
      expect(held.current(OPEN_QUEUE_ROW_ID)).toBeNull();
      // The stuck-message rows do not depend on the workspace.
      expect(held.current(CLEAR_STUCK_MESSAGES_ACTION_ID)).not.toBeNull();
      run(() => view.unmount());
    }
  });
});
