/**
 * &B135 — WHAT WAS SENT LEAVES THE BOX, on this device at once and on the others when the daemon's clear
 * arrives, whatever order the frames come in; a send that fails keeps every word.
 *
 * The bug was the live editor (the default composer, in the chat and in the Inbox): a phone keyboard
 * composes the word being typed, Send does not end that, and the editor painted nothing the host changed
 * mid-composition. The box kept showing the sent words while the draft was empty, and the next key read
 * them back as typing — republishing the sent message to every device. So every case here runs both with
 * the keyboard idle and with it composing the last word.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import type { Instant } from '@ferretry/std';
import {
  applyTextOp,
  type DraftClientFrame as SharedDraftClientFrame,
  DraftClientFrameSchema as SharedDraftClientFrameSchema,
  type DraftSent as SharedDraftSent,
  type DraftServerFrame as SharedDraftServerFrame,
} from '../../../../contract/index.ts';
import { Composer } from '../../../../app/composer/composer.tsx';
import { readLiveDocument } from '@ferretry/app';
import { daemonConnection, daemonFerretScope, withReferencePrefix } from '../../../../app/composer/seam.ts';
import { DaemonDraftStore, type DraftStorage } from '../../../../app/composer/drafts.ts';
import {
  fakeClient,
  socketOf,
  type SuiteStreamOpener as DaemonStreamOpener,
  type SuiteStreamSession,
  withClient,
} from '../../../support/app/composer-host.tsx';
import { writeMdComposePref } from '@ferretry/app';
import { MemoryOutboxBackend, SendOutbox } from '../../../../app/composer/send-outbox.ts';
import { SendOutboxProvider } from '../../../../app/composer/send-outbox-wiring.ts';
import { interact, mount, must } from '@ferretry/app/testing';
import { runAsync } from '@ferretry/app/testing';

beforeEach(() => writeMdComposePref('on'));
afterEach(() => {
  writeMdComposePref('on');
  document.getSelection()?.removeAllRanges();
});

const daemon = daemonConnection('sent');
const AT = '2026-11-02T00:00:00.000Z' as Instant;

class MemoryStorage implements DraftStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const settle = async (): Promise<void> =>
  await runAsync(async () => {
    for (let index = 0; index < 40; index += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });

/** Long enough for the composer's first reconnect (a second), after a refusal or a dropped stream. */
const reconnect = async (): Promise<void> => {
  await runAsync(async () => {
    await new Promise(resolve => setTimeout(resolve, 1_500));
  });
  await settle();
};

/**
 * The daemon's side, restated for one device: it sequences edits, answers them, and — like the send
 * route — takes a send's words out after accepting it, bumping the epoch when nothing is left. `held`
 * keeps frames back (the stream slower than the send's answer);.
 */
class Machine {
  text = '';
  epoch = 0;
  rev = 0;
  held = false;
  readonly edits: SharedDraftClientFrame[] = [];
  readonly opened: number[] = [];
  private readonly waiting: (() => void)[] = [];
  private live: { deliver: (frame: SharedDraftServerFrame) => void; kill: () => void } | undefined;

  readonly open: DaemonStreamOpener = request => {
    this.opened.push(this.epoch);
    const closers: ((closed: { code: number; reason: string }) => void)[] = [];
    let alive = true;
    const deliver = (frame: SharedDraftServerFrame): void => {
      const go = (): void =>
        queueMicrotask(() => {
          if (alive) request.onData({ kind: 'text', text: JSON.stringify(frame) });
        });
      if (this.held) this.waiting.push(go);
      else go();
    };
    const kill = (): void => {
      if (!alive) return;
      alive = false;
      for (const closer of closers) closer({ code: 1006, reason: 'gone' });
    };
    this.live = { deliver, kill };
    // GAP(app-shell): the client socket carries no position, so every stream starts from the whole draft.
    deliver({
      kind: 'snapshot',
      snapshot: {
        v: 1,
        ferret: 's1' as FerretId,
        generation: 'g',
        epoch: this.epoch,
        rev: this.rev,
        text: this.text,
        items: [],
        updatedAt: AT,
      },
    });
    deliver({ kind: 'ready' });
    return {
      sendStream: (frame: { text?: string }) => this.receive(deliver, frame.text ?? ''),
      closeStream: () => {
        alive = false;
      },
      onStreamClosed: (listener: (closed: { code: number; reason: string }) => void) => closers.push(listener),
    } as unknown as SuiteStreamSession;
  };

  release(): void {
    this.held = false;
    for (const go of this.waiting.splice(0)) go();
  }

  /** The network drops the stream: the composer reconnects and catches up from a snapshot. */
  drop(): void {
    this.live?.kill();
  }

  /** The send route: once the message is accepted, its words leave the draft. */
  clear(requestId: string, sent: SharedDraftSent): void {
    if (sent.epoch !== this.epoch || sent.base !== this.rev) return;
    this.apply({ ...sent, sent: true }, requestId, undefined);
  }

  private receive(deliver: (frame: SharedDraftServerFrame) => void, text: string): void {
    const frame = SharedDraftClientFrameSchema.parse(JSON.parse(text));
    if (frame.kind === 'presence') return;
    this.edits.push(frame);
    // One device: an edit names the revision it stands on, or it was typed into a message already sent.
    if (frame.edit.epoch !== this.epoch || frame.edit.base !== this.rev) {
      deliver({ kind: 'error', id: frame.id, code: 'shared_draft_stale', message: 'read it again' });
      return;
    }
    this.apply(frame.edit, frame.id, deliver);
  }

  private apply(
    edit: { readonly text?: readonly (number | string)[]; readonly sent?: boolean },
    id: string,
    own: ((frame: SharedDraftServerFrame) => void) | undefined,
  ): void {
    const op = edit.text ?? [this.text.length];
    this.text = applyTextOp(this.text, op as never);
    const applied = { generation: 'g', epoch: this.epoch, rev: this.rev + 1, text: op as never, add: [], remove: [] };
    const finished = edit.sent === true && this.text === '';
    this.epoch = finished ? this.epoch + 1 : this.epoch;
    this.rev = finished ? 0 : this.rev + 1;
    const position = { epoch: this.epoch, rev: this.rev };
    if (own === undefined) this.live?.deliver({ kind: 'edit', id, applied, ...position });
    else own({ kind: 'ack', id, applied, ...position });
  }
}

type Order = 'clear-first' | 'answer-first' | 'snapshot-after' | 'last-key-unanswered';

/** What the person does, through the live editor the way a browser reports it. */
const person = (element: HTMLElement) => ({
  async type(text: string): Promise<void> {
    for (const data of text) {
      const event = new Event('beforeinput', { bubbles: true, cancelable: true });
      Object.assign(event, { inputType: 'insertText', data, dataTransfer: null });
      await interact(() => element.dispatchEvent(event));
    }
  },
  /** The keyboard composes `word` at the end, and is still composing it. */
  async compose(word: string): Promise<void> {
    await interact(() => element.dispatchEvent(new Event('compositionstart', { bubbles: true })));
    const before = readLiveDocument(element);
    for (let index = 1; index <= word.length; index += 1) {
      const line = must(element.lastElementChild, 'the last line');
      line.textContent = `${before.split('\n').at(-1) ?? ''}${word.slice(0, index)}`;
      await interact(() =>
        element.dispatchEvent(
          new InputEvent('input', { bubbles: true, isComposing: true, data: word.slice(0, index) }),
        ),
      );
    }
  },
  /** The keyboard commits whatever it is composing (the next key, a blur): its document as it now is. */
  async commit(): Promise<void> {
    await interact(() => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  },
  async send(): Promise<void> {
    const form = must(element.closest('form'), 'the composer form');
    await interact(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  },
  shown: (): string => readLiveDocument(element),
});

const chat = async (
  machine: Machine,
  options: { readonly refuse?: boolean; readonly order?: Order } = {},
): Promise<{
  readonly element: HTMLElement;
  readonly sent: { message: string; sharedDraft?: SharedDraftSent }[];
  readonly drafts: DaemonDraftStore;
  readonly unmount: () => Promise<void>;
}> => {
  const sent: { message: string; sharedDraft?: SharedDraftSent }[] = [];
  const api = {
    // The daemon names the send by the id it arrived under: the outbox entry's, as in the app.
    send: async (_ferretId: string, body: { message: string; sharedDraft?: SharedDraftSent }, requestId?: string) => {
      sent.push(body);
      if (options.refuse === true) throw Object.assign(new Error('refused'), { status: 400 });
      if (options.order === 'answer-first') machine.held = true;
      if (body.sharedDraft !== undefined) machine.clear(requestId ?? 'no-id', body.sharedDraft);
      return {};
    },
  };
  const drafts = new DaemonDraftStore(new MemoryStorage());
  // The app's composer always sends through this device's outbox, which names each send.
  let minted = 0;
  const outbox = new SendOutbox({
    backend: new MemoryOutboxBackend(),
    resolve: async () => api as never,
    mintId: () => {
      minted += 1;
      return `send-${minted}`;
    },
  });
  const view = await mount(
    withClient(
      <SendOutboxProvider
        daemonId={daemon.daemonId}
        outbox={{ outbox, offer: () => () => undefined, stop: () => undefined }}
        sender={{ send: api.send as never, upload: async () => 'none' }}
      >
        <Composer api={api as never} daemon={daemon} draftStore={drafts} ferretId="s1" />
      </SendOutboxProvider>,
      fakeClient(undefined, socketOf(machine.open)),
    ),
  );
  await settle();
  const element = must(view.container.querySelector<HTMLElement>('[data-live-editor]'), 'the live editor');
  await interact(() => element.focus());
  return { element, sent, drafts, unmount: view.unmount };
};

const ORDERS: readonly Order[] = ['clear-first', 'answer-first', 'snapshot-after', 'last-key-unanswered'];

describe('the chat composer after Send (B135)', () => {
  for (const order of ORDERS)
    for (const composing of [false, true])
      test(`${order}${composing ? ', the keyboard composing the last word' : ''}: the box is empty, everywhere, and stays so`, async () => {
        // Arrange — "hello world" typed, its last word possibly still under the keyboard's composition.
        const machine = new Machine();
        const { element, sent, drafts, unmount } = await chat(machine, { order });
        const it = person(element);
        await it.type(composing ? 'hello ' : 'hello world');
        if (composing) await it.compose('world');
        await settle();
        expect(machine.text).toBe('hello world');
        if (order === 'last-key-unanswered') machine.held = true;
        if (order === 'last-key-unanswered' && !composing) await it.type('!');
        if (order === 'last-key-unanswered' && composing) await it.compose('!');

        // Act — Send; then the frames in this order.
        await it.send();
        if (order === 'last-key-unanswered') {
          await settle();
          machine.release();
        }
        await settle();
        if (order === 'answer-first') {
          // The answer has landed; the daemon's clear is still on its way.
          expect(it.shown()).toBe('');
          machine.release();
        }
        if (order === 'snapshot-after') machine.drop();
        await settle();
        if (composing) await it.commit();
        await settle();

        // Assert — the sent words went with the message, and are gone from the box, the daemon and the
        // saved draft; the next key is only the next key, never the sent words come back.
        const words = order === 'last-key-unanswered' ? 'hello world!' : 'hello world';
        expect(sent.map(body => body.message)).toEqual([words]);
        expect(it.shown()).toBe('');
        expect(machine.text).toBe('');
        expect(drafts.load(daemonFerretScope(daemon, 's1'))).toBe('');
        // GAP(app-shell): the client socket carries no position, so a stream that reconnects starts from the whole draft
        // and a key typed while it was down comes back as an offer to restore, not a resend. The next key is typed
        // once the dropped stream is back.
        if (order === 'snapshot-after') await reconnect();
        await it.type('n');
        await reconnect();
        expect(it.shown()).toBe('n');
        expect(machine.text).toBe('n');
        await unmount();
      });

  test('a send that fails keeps every word, on the screen and on the daemon', async () => {
    const machine = new Machine();
    const { element, unmount } = await chat(machine, { refuse: true });
    const it = person(element);
    await it.type('keep ');
    await it.compose('these');
    await settle();
    await it.send();
    await settle();
    await it.commit();
    await settle();
    expect(it.shown()).toBe('keep these');
    expect(machine.text).toBe('keep these');
    expect(machine.edits.some(frame => frame.kind === 'edit' && frame.edit.sent === true)).toBe(false);
    await unmount();
  });

  test('Send under a composition sends the word being composed, even one no input reported yet', async () => {
    const machine = new Machine();
    const { element, sent, unmount } = await chat(machine);
    const it = person(element);
    await it.type('see ');
    await it.compose('yo');
    // The keyboard has changed the document without reporting it yet.
    must(element.lastElementChild, 'the line').textContent = 'see you';
    await it.send();
    await settle();
    await it.commit();
    await settle();
    expect(sent.map(body => body.message)).toEqual(['see you']);
    expect(it.shown()).toBe('');
    expect(machine.text).toBe('');
    await unmount();
  });
});

/**
 * Today this mounted Agenda's `AgendaInboxComposer`; that box is the chat's composer bound to the item's own draft slot
 * with the item's "re:" chip on its sends, which is what is drawn here (Agenda's own box is Agenda's to test).
 */
describe('the Inbox reply box after Send (B135)', () => {
  for (const composing of [false, true])
    test(`is empty right after Send${composing ? ', with the keyboard composing the last word' : ''}`, async () => {
      const sent: string[] = [];
      const api = {
        send: async (_ferretId: string, body: { message: string }) => {
          sent.push(body.message);
          return {};
        },
      };
      const view = await mount(
        <Composer
          api={withReferencePrefix(api, () => ['A5']) as never}
          compact
          daemon={daemon}
          draftSlot="A5"
          draftStore={new DaemonDraftStore(new MemoryStorage())}
          ferretId="s1"
        />,
      );
      await settle();
      const element = must(view.container.querySelector<HTMLElement>('[data-live-editor]'), 'the live editor');
      await interact(() => element.focus());
      const it = person(element);
      await it.type(composing ? 'after ' : 'after lunch');
      if (composing) await it.compose('lunch');
      await it.send();
      await settle();
      if (composing) await it.commit();
      await settle();
      expect(sent).toEqual(['!A5 after lunch']);
      expect(it.shown()).toBe('');
      await it.type('n');
      expect(it.shown()).toBe('n');
      await view.unmount();
    });
});
