import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { DaemonCallError, writeMdComposePref } from '@ferretry/app';
import { ensureDom, render, run, runAsync, settleUntil } from '@ferretry/app/testing';
import type { ReactElement } from 'react';
import { Composer } from '../../../../app/composer/composer.tsx';
import type { ComposerAttachmentUploader } from '../../../../app/composer/composer-attachments.ts';
import { type AgendaId, daemonConnection, withReferencePrefix } from '../../../../app/composer/seam.ts';
import { DaemonDraftStore, type DraftStorage } from '../../../../app/composer/drafts.ts';
import { MemoryOutboxBackend, type OutboxBackend, type OutboxSender } from '../../../../app/composer/send-outbox.ts';
import {
  createDaemonOutbox,
  type DaemonOutbox,
  SendOutboxProvider,
} from '../../../../app/composer/send-outbox-wiring.ts';

ensureDom();

beforeEach(() => writeMdComposePref('off'));
afterEach(() => writeMdComposePref('on'));

const daemon = daemonConnection('ob');

class Memory implements DraftStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

/**
 * A request that never left this browser: today's `FyTransportError`. The 5.0 session client throws
 * `RelayRequestNotSentError` for it, which the outbox counts as "waiting for connection".
 */
const noCarrier = (): Error => Object.assign(new Error('no carrier'), { name: 'RelayRequestNotSentError' });

const quiet = { onRecovered: () => () => undefined, onOnline: () => () => undefined };

/**
 * Today's app store held the device outbox and drained it through the machine's plain client; in 5.0 the outbox is
 * Conversation's (`SendOutboxProvider`), and its sender is the machine's plain `send`.
 */
const storeWith = async (
  send: (...args: unknown[]) => Promise<unknown>,
  backend: OutboxBackend = new MemoryOutboxBackend(),
) => {
  const daemonOutbox: DaemonOutbox = createDaemonOutbox({ daemonId: daemon.daemonId, backend, environment: quiet });
  // Loaded first, as today's awaited store was: a send racing the first load would be drained by the outbox itself.
  await daemonOutbox.outbox.drainAll();
  await new Promise(resolve => setTimeout(resolve, 0));
  const sender: OutboxSender = {
    send: async (ferretId, input, requestId) => await send(ferretId, input, requestId),
    upload: async () => {
      throw noCarrier();
    },
  };
  const provide = (element: ReactElement): ReactElement => (
    <SendOutboxProvider daemonId={daemon.daemonId} outbox={daemonOutbox} sender={sender}>
      {element}
    </SendOutboxProvider>
  );
  return { outbox: daemonOutbox.outbox, provide };
};

const mount = async (
  send: (...args: unknown[]) => Promise<unknown>,
  withStore = true,
  chips: readonly AgendaId[] = [],
  uploadAttachment?: ComposerAttachmentUploader,
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
      ferretId="s1"
      {...(uploadAttachment === undefined ? {} : { uploadAttachment })}
    />
  );
  const tree = render(withStore ? store.provide(composer) : composer);
  const type = (value: string) =>
    run(() =>
      tree.root
        .findByType('textarea')
        .props.onChange({ currentTarget: { value, selectionStart: value.length, selectionEnd: value.length } }),
    );
  const submit = async () =>
    await runAsync(async () => tree.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  const attach = (file: File) =>
    run(() => {
      const inputs = tree.root.findAll(node => node.type === 'input' && node.props.type === 'file');
      inputs.at(-1)?.props.onChange({ currentTarget: { files: [file], value: '' } });
    });
  return { store, direct, tree, type, submit, attach };
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
      throw noCarrier();
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
        if (!online) throw noCarrier();
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

  test('offline, a file waits for the connection and goes into the outbox with its message', async () => {
    const online = Object.getOwnPropertyDescriptor(globalThis.navigator, 'onLine');
    Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, get: () => false });
    let uploads = 0;
    try {
      const { store, type, submit, attach, tree } = await mount(
        async () => {
          throw noCarrier();
        },
        true,
        [],
        async () => {
          uploads += 1;
          throw new Error('unreachable');
        },
      );
      attach(new File([new Uint8Array([1, 2])], 'shot.png', { type: 'image/png' }));
      expect(JSON.stringify(tree.toJSON())).toContain('uploads when the connection is back');
      type('here it is');
      await submit();
      await settleUntil(
        () => tree.root.findByType('textarea').props.value === '',
        'the composer to clear once the message is on this device',
        runAsync,
      );
      // Never tried while the browser said it was offline; the outbox holds the file with the words.
      expect(uploads).toBe(0);
      const [entry] = store.outbox.snapshot();
      expect(entry?.message).toBe('here it is');
      expect(entry?.files.map(file => file.name)).toEqual(['shot.png']);
    } finally {
      if (online === undefined) Reflect.deleteProperty(globalThis.navigator, 'onLine');
      else Object.defineProperty(globalThis.navigator, 'onLine', online);
    }
  });

  test('a message the machine refuses leaves no copy behind and the refusal is raised to the person', async () => {
    const { store, type, submit, tree } = await mount(async () => {
      throw new DaemonCallError(404, 'not_found', 'Session not found');
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

describe('the composer with an outbox that cannot store (&F331 review)', () => {
  test('offline with no storage on this device: not sent, the words stay in the box, and it says why', async () => {
    // Arrange — this device's storage refuses every write; the machine cannot be reached.
    const refusing = new MemoryOutboxBackend();
    refusing.put = async () => {
      throw new Error('quota exceeded');
    };
    const store = await storeWith(async () => {
      throw noCarrier();
    }, refusing);
    const tree = render(
      store.provide(
        <Composer
          api={{
            send: async () => {
              throw noCarrier();
            },
          }}
          daemon={daemon}
          draftStore={new DaemonDraftStore(new Memory())}
          ferretId="s1"
        />,
      ),
    );
    run(() =>
      tree.root
        .findByType('textarea')
        .props.onChange({ currentTarget: { value: 'keep me', selectionStart: 7, selectionEnd: 7 } }),
    );

    // Act
    await runAsync(async () => tree.root.findByType('form').props.onSubmit({ preventDefault() {} }));

    // Assert
    expect(store.outbox.snapshot()).toEqual([]);
    expect(tree.root.findByType('textarea').props.value).toBe('keep me');
    expect(JSON.stringify(tree.toJSON())).toContain('could not keep the message');
    run(() => tree.unmount());
  });
});
