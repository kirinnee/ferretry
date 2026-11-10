import { describe, expect, test } from 'bun:test';
import type { PanelProps } from '@ferretry/kernel/manifest';
import { ensureDom, render, run, runAsync } from '@ferretry/app/testing';
import type { ActionsRowOffer } from '@ferretry/core-ferrets/contract';
import { InterruptRowPanel, INTERRUPT_ROW_ID } from '../../../../app/slots/interrupt-row-panel.tsx';
import { type FakeClient, fakeClient, refusal } from '../../../support/app/fake-client.ts';
import { withClient } from '../../../support/app/client.tsx';

ensureDom();

/** The props a slot hands a panel: the shell spreads them beside `subject`. */
const slot = (props: object): PanelProps => props as PanelProps;

const VIEW = 'GET /v1/ferrets/:ferretId';
const INTERRUPT = 'POST /v1/ferrets/:ferretId/interrupt';

const settle = async (): Promise<void> => {
  await runAsync(async () => {
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};

interface Offers {
  readonly log: { id: string; row: ActionsRowOffer | null }[];
  readonly offer: (id: string, row: ActionsRowOffer | null) => void;
  readonly current: () => ActionsRowOffer | null;
}

const offers = (): Offers => {
  const log: { id: string; row: ActionsRowOffer | null }[] = [];
  return {
    log,
    offer: (id, row) => void log.push({ id, row }),
    current: () => log.at(-1)?.row ?? null,
  };
};

const mountRow = async (client: FakeClient, held: Offers, canControl = true, props: object = {}) => {
  const view = render(
    withClient(
      client,
      <InterruptRowPanel {...slot({ canControl, ferret: 'f1', name: 'Ferret', offer: held.offer, ...props })} />,
    ),
  );
  await settle();
  return view;
};

describe('Interrupt turn in the Actions menu', () => {
  test('offers the row for a ferret that is working, and the row interrupts it', async () => {
    const client = fakeClient({ [VIEW]: () => ({ state: 'working' }), [INTERRUPT]: () => ({}) });
    const held = offers();
    const view = await mountRow(client, held);
    const row = held.current();
    expect(row).toMatchObject({ kind: 'run', id: INTERRUPT_ROW_ID, label: 'Interrupt turn', group: 'ferret' });
    await runAsync(async () => await row?.run());
    const sent = client.callsTo(INTERRUPT);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.params).toEqual({ ferretId: 'f1' });
    run(() => view.unmount());
    expect(held.current()).toBeNull();
  });

  test('offers nothing for a stopped ferret', async () => {
    const held = offers();
    const view = await mountRow(fakeClient({ [VIEW]: () => ({ state: 'stopped' }) }), held);
    expect(held.current()).toBeNull();
    run(() => view.unmount());
  });

  test('offers nothing, and reads nothing, to someone who may not control the ferret', async () => {
    const client = fakeClient({});
    const held = offers();
    const view = await mountRow(client, held, false);
    expect(held.current()).toBeNull();
    expect(client.calls).toEqual([]);
    run(() => view.unmount());
  });

  test('offers nothing when the ferret cannot be read or the answer is no state', async () => {
    const failed = offers();
    const failing = await mountRow(
      fakeClient({
        [VIEW]: () => {
          throw refusal(404, 'gone', 'no such ferret');
        },
      }),
      failed,
    );
    expect(failed.current()).toBeNull();
    run(() => failing.unmount());

    const odd = offers();
    const unreadable = await mountRow(fakeClient({ [VIEW]: () => ({ nothing: true }) }), odd);
    expect(odd.current()).toBeNull();
    run(() => unreadable.unmount());
  });

  test('draws nothing when the slot hands something else', async () => {
    const client = fakeClient({});
    const view = render(withClient(client, <InterruptRowPanel />));
    await settle();
    expect(client.calls).toEqual([]);
    run(() => view.unmount());
  });

  test('reads again when the ferret changes, and takes the row back when it stops', async () => {
    let state = 'working';
    const client = fakeClient({ [VIEW]: () => ({ state }) });
    const held = offers();
    const view = await mountRow(client, held);
    expect(held.current()).not.toBeNull();
    state = 'stopped';
    run(() => client.emit('ferrets.changed', { ferret: 'other' }));
    await settle();
    expect(client.callsTo(VIEW)).toHaveLength(1);
    run(() => client.emit('ferrets.changed', { ferret: 'f1' }));
    await settle();
    expect(client.callsTo(VIEW)).toHaveLength(2);
    expect(held.current()).toBeNull();
    run(() => view.unmount());
  });
});
