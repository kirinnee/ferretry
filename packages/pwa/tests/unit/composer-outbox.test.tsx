import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { FyApiClient } from '@ferretry/protocol/client';
import { FyHttpError, FyTransportError } from '@ferretry/protocol/client';
import type { AgendaId } from '@ferretry/protocol';
import { Composer } from '../../src/components/composer.tsx';
import { withReferencePrefix } from '../../src/lib/answer-chip.ts';
import type { DaemonConnectionRepository } from '../../src/lib/connections.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonDraftStore, type DraftStorage } from '../../src/lib/drafts.ts';
import { MemoryOutboxBackend } from '../../src/lib/send-outbox.ts';
import { createAppStore, StoreProvider } from '../../src/lib/store.tsx';
import '../support/dom.ts';
import { writeMdComposePref } from '../../src/lib/md-compose.ts';
import { render, run, runAsync } from '../support/react.ts';

beforeEach(() => writeMdComposePref('off'));
afterEach(() => writeMdComposePref('on'));

const daemon = daemonConnection({ daemonId: 'ob', baseUrl: 'https://ob.example.test', deviceId: 'device' });

class Memory implements DraftStorage, DaemonConnectionRepository {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  async load(key: string): Promise<string | null> {
    return this.getItem(key);
  }
  async save(key: string, value: string): Promise<void> {
    this.setItem(key, value);
  }
}

const storeWith = async (send: (...args: unknown[]) => Promise<unknown>) => {
  const store = await createAppStore({
    repository: new Memory(),
    connectClient: async () => ({ send }) as unknown as FyApiClient,
    fetcher: async () => Response.json({}),
    outboxBackend: new MemoryOutboxBackend(),
  });
  store.connections.add(daemon);
  return store;
};

const mount = async (
  send: (...args: unknown[]) => Promise<unknown>,
  withStore = true,
  chips: readonly AgendaId[] = [],
) => {
  const store = await storeWith(send);
  const direct: unknown[] = [];
  const client = {
    send: async (...args: unknown[]) => {
      direct.push(args);
      return (await send(...args)) as never;
    },
  };
  const composer = (
    <Composer
      api={chips.length === 0 ? client : withReferencePrefix(client, () => chips)}
      daemon={daemon}
      draftStore={new DaemonDraftStore(new Memory())}
      sessionId="s1"
    />
  );
  const tree = render(withStore ? <StoreProvider store={store}>{composer}</StoreProvider> : composer);
  const type = (value: string) =>
    run(() =>
      tree.root
        .findByType('textarea')
        .props.onChange({ currentTarget: { value, selectionStart: value.length, selectionEnd: value.length } }),
    );
  const submit = async () =>
    await runAsync(async () => tree.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  return { store, direct, tree, type, submit };
};

describe('the composer with a device outbox', () => {
  test('saves the message on this device, then the machine hears it under the same id', async () => {
    const { store, type, submit, direct } = await mount(async () => ({ disposition: 'queued' }));
    type('thank you');
    await submit();
    expect(direct).toHaveLength(1);
    expect(direct[0]).toMatchObject(['s1', { message: 'thank you' }, expect.any(String)]);
    expect(store.outbox.snapshot()).toEqual([]);
  });

  test('offline it stays in the outbox, waiting, and the box is cleared', async () => {
    const { store, type, submit, tree } = await mount(async () => {
      throw new FyTransportError('no carrier', '/send', false, undefined);
    });
    type('thank you');
    await submit();
    expect(store.outbox.snapshot().map(entry => entry.message)).toEqual(['thank you']);
    expect(tree.root.findByType('textarea').props.value).toBe('');
  });

  test('a reply about an Agenda item saved offline is still about it when it leaves later', async () => {
    let online = false;
    const arrived: string[] = [];
    const { store, type, submit } = await mount(
      async (_session: unknown, body: unknown) => {
        if (!online) throw new FyTransportError('no carrier', '/send', false, undefined);
        arrived.push((body as { readonly message: string }).message);
        return { disposition: 'queued' };
      },
      true,
      ['A3' as AgendaId],
    );
    type('yes, ship it');
    await submit();
    expect(store.outbox.snapshot()).toMatchObject([{ message: 'yes, ship it', references: ['A3'] }]);
    online = true;
    // The drain goes through the machine's plain client, not the composer's: the prefix comes from the entry.
    await runAsync(async () => await store.outbox.drainAll());
    expect(arrived).toEqual(['!A3 yes, ship it']);
    expect(store.outbox.snapshot()).toEqual([]);
  });

  test('a message the machine refuses leaves no copy behind and the refusal is raised to the person', async () => {
    const { store, type, submit, tree } = await mount(async () => {
      throw new FyHttpError('Session not found', 404, 'not_found');
    });
    type('thank you');
    await submit();
    expect(store.outbox.snapshot()).toEqual([]);
    expect(JSON.stringify(tree.toJSON())).toContain('Session not found');
  });

  test('without a store it sends straight through the api, as before', async () => {
    const { type, submit, direct } = await mount(async () => ({}), false);
    type('hello');
    await submit();
    expect(direct).toHaveLength(1);
    expect(direct[0]).toHaveLength(2);
  });
});
