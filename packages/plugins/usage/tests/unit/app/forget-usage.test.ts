/** S12: an unpaired machine's cached usage leaves this browser, and only that machine's. */
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { noteClientDaemon } from '@ferretry/app/testing';
import app from '../../../app/index.ts';
import { forgetUsageOf, holdUsageStore } from '../../../app/lib/forget-usage.ts';
import { DaemonUsageStore } from '../../../app/lib/usage-store.ts';
import { fakeClient } from './support/client.ts';

const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

const storeFor = (daemon: string | undefined): DaemonUsageStore => {
  const client = fakeClient({});
  if (daemon !== undefined) noteClientDaemon(client, daemon);
  const store = new DaemonUsageStore({ usage: async () => ({}) });
  holdUsageStore(client, store);
  return store;
};

describe('forgetUsageOf', () => {
  it('clears the feed of the forgotten machine from every store built for it, and no other machine’s', () => {
    const first = storeFor('alpha');
    const second = storeFor('alpha');
    const other = storeFor('beta');
    const cleared = [first, second, other].map(store => spyOn(store, 'clearDaemon'));
    spies.push(...cleared);
    forgetUsageOf('alpha');
    expect(cleared.map(spy => spy.mock.calls)).toEqual([[['alpha']], [['alpha']], []]);
    // The stores are let go with it: a second forget finds nothing to clear.
    forgetUsageOf('alpha');
    expect(cleared[0]?.mock.calls.length).toBe(1);
  });

  it('holds nothing for a client that belongs to no daemon, and forgets a machine it never held without a word', () => {
    const store = storeFor(undefined);
    const cleared = spyOn(store, 'clearDaemon');
    spies.push(cleared);
    forgetUsageOf('this-daemon');
    forgetUsageOf('unheard-of');
    expect(cleared).not.toHaveBeenCalled();
  });
});

describe('the Usage app half offers the shell its forget', () => {
  it('the store the half builds for a machine is cleared when the shell forgets that machine', () => {
    const cleared = spyOn(DaemonUsageStore.prototype, 'clearDaemon');
    spies.push(cleared);
    const client = fakeClient({});
    noteClientDaemon(client, 'gamma');
    app.build?.({ manifest: app.manifest, client } as never);
    const forget = (app as unknown as { shell: { forget: (daemon: string) => void } }).shell.forget;
    forget('gamma');
    expect(cleared.mock.calls).toEqual([['gamma']]);
  });
});
