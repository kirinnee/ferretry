/**
 * &B142 — EACH INBOX CARD HAS ITS OWN DRAFT. The chat box and every card of one ferret used to be ONE shared
 * draft, so typing in the chat showed under the Inbox card of a different item. A composer now binds to a draft
 * SLOT: the chat's (no `draftSlot`) or an agenda item's.
 *
 * `Daemon` below is a machine that keeps one draft per slot and relays each edit to every other stream open on
 * the same slot, like the real service: two mounted composers on one slot are two of the owner's devices.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  type AgendaId,
  applyTextOp,
  type SharedDraftClientFrame,
  SharedDraftClientFrameSchema,
  type SharedDraftSent,
  type SharedDraftServerFrame,
} from '@ferretry/protocol';
import { Composer } from '../../src/components/composer.tsx';
import { readLiveDocument } from '../../src/components/live-markdown-editor.tsx';
import { AgendaInboxComposer } from '../../src/features/agenda/agenda-inbox-composer.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionKey, daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { DaemonDraftStore, type DraftStorage } from '../../src/lib/drafts.ts';
import type { DaemonStreamOpener } from '../../src/lib/event-transport.ts';
import { writeMdComposePref } from '../../src/lib/md-compose.ts';
import type { RelayClientSession } from '../../src/lib/relay-session.ts';
import { interact, mount, must } from '../support/dom.ts';
import { render, run, runAsync } from '../support/react.ts';
import { sessionView } from '../support/sessions.ts';

beforeEach(() => writeMdComposePref('on'));
afterEach(() => {
  writeMdComposePref('on');
  document.getSelection()?.removeAllRanges();
});

const daemon = daemonConnection({ daemonId: 'slots', baseUrl: 'https://slots.example.test', deviceId: 'device' });
const AT = '2026-11-02T00:00:00.000Z';
const A5 = 'A5' as AgendaId;
const A6 = 'A6' as AgendaId;

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

/** Past the composer's 400 ms wait before it saves a draft on this device. */
const saved = async (): Promise<void> => {
  await runAsync(async () => {
    await new Promise(resolve => setTimeout(resolve, 600));
  });
};

interface Held {
  text: string;
  epoch: number;
  rev: number;
}

class Daemon {
  /** Drafts by slot: `chat` or an item id. */
  readonly slots = new Map<string, Held>();
  /** Which slot each stream asked for, in the order they opened. */
  readonly asked: (string | null)[] = [];
  /** A machine that predates slots: it ignores `?item=` and answers with the chat's draft, naming no slot. */
  ignoresItem = false;
  private readonly live = new Map<string, Set<(frame: SharedDraftServerFrame) => void>>();

  held(slot: string): Held {
    const found = this.slots.get(slot) ?? { text: '', epoch: 0, rev: 0 };
    this.slots.set(slot, found);
    return found;
  }

  readonly open: DaemonStreamOpener = async (_daemon, request) => {
    const item = new Map(request.query ?? []).get('item') ?? null;
    this.asked.push(item);
    const slot = this.ignoresItem || item === null ? 'chat' : item;
    let alive = true;
    const deliver = (frame: SharedDraftServerFrame): void =>
      queueMicrotask(() => {
        if (alive) request.onData({ kind: 'text', text: JSON.stringify(frame) });
      });
    const streams = this.live.get(slot) ?? new Set();
    this.live.set(slot, streams);
    streams.add(deliver);
    const now = this.held(slot);
    deliver({
      kind: 'snapshot',
      snapshot: {
        v: 1,
        sessionId: 's1',
        ...(slot === 'chat' ? {} : { slot: slot as AgendaId }),
        generation: 'g',
        epoch: now.epoch,
        rev: now.rev,
        text: now.text,
        items: [],
        updatedAt: AT,
      },
    });
    deliver({ kind: 'ready' });
    return {
      sendStream: (frame: { text?: string }) => this.receive(slot, deliver, frame.text ?? ''),
      closeStream: () => {
        alive = false;
        streams.delete(deliver);
      },
      onStreamClosed: () => undefined,
    } as unknown as RelayClientSession;
  };

  /** The send route: once the message is accepted, the words it carried leave the slot it names. */
  clear(requestId: string, sent: SharedDraftSent): void {
    const slot = sent.slot ?? 'chat';
    const now = this.held(slot);
    if (sent.epoch !== now.epoch || sent.base !== now.rev) return;
    this.apply(slot, { text: sent.text, sent: true }, requestId, undefined);
  }

  private receive(slot: string, own: (frame: SharedDraftServerFrame) => void, text: string): void {
    const frame: SharedDraftClientFrame = SharedDraftClientFrameSchema.parse(JSON.parse(text));
    if (frame.kind === 'presence') return;
    const now = this.held(slot);
    if (frame.edit.epoch !== now.epoch || frame.edit.base !== now.rev) {
      own({ kind: 'error', id: frame.id, code: 'shared_draft_stale', message: 'read it again' });
      return;
    }
    this.apply(slot, frame.edit, frame.id, own);
  }

  private apply(
    slot: string,
    edit: { readonly text?: readonly (number | string)[]; readonly sent?: boolean },
    id: string,
    own: ((frame: SharedDraftServerFrame) => void) | undefined,
  ): void {
    const now = this.held(slot);
    const op = edit.text ?? [now.text.length];
    now.text = applyTextOp(now.text, op as never);
    const applied = { generation: 'g', epoch: now.epoch, rev: now.rev + 1, text: op as never, add: [], remove: [] };
    const finished = edit.sent === true && now.text === '';
    now.epoch = finished ? now.epoch + 1 : now.epoch;
    now.rev = finished ? 0 : now.rev + 1;
    const position = { epoch: now.epoch, rev: now.rev };
    for (const deliver of this.live.get(slot) ?? []) {
      if (deliver === own) deliver({ kind: 'ack', id, applied, ...position });
      else deliver({ kind: 'edit', id, applied, ...position });
    }
  }
}

/** What the person does, through the live editor the way a browser reports it. */
const person = (element: HTMLElement) => ({
  async type(text: string): Promise<void> {
    for (const data of text) {
      const event = new Event('beforeinput', { bubbles: true, cancelable: true });
      Object.assign(event, { inputType: 'insertText', data, dataTransfer: null });
      await interact(() => element.dispatchEvent(event));
    }
    await settle();
  },
  async send(): Promise<void> {
    const form = must(element.closest('form'), 'the composer form');
    await interact(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await settle();
  },
  shown: (): string => readLiveDocument(element),
});

interface Box {
  readonly it: ReturnType<typeof person>;
  readonly sent: { message: string; sharedDraft?: SharedDraftSent }[];
  readonly unmount: () => Promise<void>;
}

/** One composer: the chat's (no `slot`) or an item's card. `slots: false` is a machine without draft slots. */
const box = async (
  machine: Daemon,
  drafts: DaemonDraftStore,
  options: { readonly slot?: AgendaId } = {},
): Promise<Box> => {
  const sent: Box['sent'] = [];
  const api = {
    send: async (_sessionId: string, body: { message: string; sharedDraft?: SharedDraftSent }, requestId?: string) => {
      sent.push(body);
      if (body.sharedDraft !== undefined) machine.clear(requestId ?? 'no-id', body.sharedDraft);
      return {};
    },
  };
  const view = await mount(
    <Composer
      api={api as never}
      daemon={daemon}
      draftStore={drafts}
      {...(options.slot === undefined ? {} : { draftSlot: options.slot })}
      openDraftStream={machine.open}
      sessionId="s1"
    />,
  );
  await settle();
  const element = must(view.container.querySelector<HTMLElement>('[data-live-editor]'), 'the live editor');
  await interact(() => element.focus());
  return { it: person(element), sent, unmount: view.unmount };
};

const store = () => new DaemonDraftStore(new MemoryStorage());
const chatScope = daemonSessionScope(daemon, 's1');
const cardScope = (item: AgendaId) => daemonSessionScope(daemon, 's1', item);

describe('a draft slot (B142)', () => {
  test('the chat is the two-part key it always was, and a card adds its item', () => {
    expect(daemonSessionKey(chatScope)).toBe('["slots","s1"]');
    expect(daemonSessionKey(cardScope(A5))).toBe('["slots","s1","A5"]');
  });

  test('typing in an Inbox card never reaches the chat draft, and typing in the chat never reaches the card', async () => {
    // Arrange — the chat box and the card of !A5, one ferret, one machine.
    const machine = new Daemon();
    const drafts = store();
    const chat = await box(machine, drafts);
    const card = await box(machine, drafts, { slot: A5 });
    expect(machine.asked).toEqual([null, 'A5']);

    // Act
    await chat.it.type('chat words');
    await card.it.type('card words');
    await saved();

    // Assert — each box holds its own words, on the screen, on the machine and in the saved drafts.
    expect(chat.it.shown()).toBe('chat words');
    expect(card.it.shown()).toBe('card words');
    expect(machine.held('chat').text).toBe('chat words');
    expect(machine.held('A5').text).toBe('card words');
    expect(drafts.load(chatScope)).toBe('chat words');
    expect(drafts.load(cardScope(A5))).toBe('card words');
    await chat.unmount();
    await card.unmount();
  });

  test('two cards of one ferret are separate drafts', async () => {
    const machine = new Daemon();
    const drafts = store();
    const first = await box(machine, drafts, { slot: A5 });
    const second = await box(machine, drafts, { slot: A6 });

    await first.it.type('about five');
    await second.it.type('about six');

    expect(first.it.shown()).toBe('about five');
    expect(second.it.shown()).toBe('about six');
    expect(machine.held('A5').text).toBe('about five');
    expect(machine.held('A6').text).toBe('about six');
    expect(machine.held('chat').text).toBe('');
    await first.unmount();
    await second.unmount();
  });

  test('a chat and a card opened together each show their own saved words, with nothing to restore', async () => {
    const machine = new Daemon();
    machine.slots.set('chat', { text: 'chat words', epoch: 0, rev: 1 });
    machine.slots.set('A5', { text: 'card words', epoch: 0, rev: 1 });
    const drafts = store();

    const card = await box(machine, drafts, { slot: A5 });
    const chat = await box(machine, drafts);

    expect(card.it.shown()).toBe('card words');
    expect(chat.it.shown()).toBe('chat words');
    expect(document.querySelector('[data-composer-conflict]')).toBeNull();
    await card.unmount();
    await chat.unmount();
  });

  test('the same card open on two devices stays in step, and the chat holds none of it', async () => {
    const machine = new Daemon();
    const laptop = await box(machine, store(), { slot: A5 });
    const phone = await box(machine, store(), { slot: A5 });
    const chat = await box(machine, store());

    await laptop.it.type('from the laptop');

    expect(phone.it.shown()).toBe('from the laptop');
    expect(chat.it.shown()).toBe('');
    await laptop.unmount();
    await phone.unmount();
    await chat.unmount();
  });

  test('a send from a card names its slot, and clears only that slot', async () => {
    const machine = new Daemon();
    const drafts = store();
    const chat = await box(machine, drafts);
    const card = await box(machine, drafts, { slot: A5 });
    await chat.it.type('still typing in the chat');
    await card.it.type('done here');

    await card.it.send();

    expect(card.sent.map(body => body.message)).toEqual(['done here']);
    expect(card.sent[0]?.sharedDraft?.slot).toBe('A5');
    expect(machine.held('A5').text).toBe('');
    expect(card.it.shown()).toBe('');
    expect(machine.held('chat').text).toBe('still typing in the chat');
    expect(chat.it.shown()).toBe('still typing in the chat');
    await chat.unmount();
    await card.unmount();
  });

  test('a chat send names no slot, as it always did', async () => {
    const machine = new Daemon();
    const chat = await box(machine, store());
    await chat.it.type('hello');

    await chat.it.send();

    expect(chat.sent[0]?.sharedDraft).toBeDefined();
    expect(chat.sent[0]?.sharedDraft).not.toHaveProperty('slot');
    await chat.unmount();
  });
});

describe('a daemon that ignores draft slots, and drafts stored before them', () => {
  test("an older machine that ignores ?item= and answers with the chat's draft never shows it under a card", async () => {
    const machine = new Daemon();
    machine.ignoresItem = true;
    machine.held('chat').text = 'private chat words';
    machine.held('chat').rev = 3;
    const card = await box(machine, store(), { slot: A5 });

    expect(machine.asked).toEqual(['A5']);
    expect(card.it.shown()).toBe('');
    await card.unmount();
  });

  test("a draft stored before slots is the chat's, and a card does not read it", async () => {
    const drafts = store();
    drafts.save(chatScope, 'kept from before', 1);
    const machine = new Daemon();
    const chat = await box(machine, drafts);
    const card = await box(machine, drafts, { slot: A5 });

    expect(chat.it.shown()).toBe('kept from before');
    expect(card.it.shown()).toBe('');
    await chat.unmount();
    await card.unmount();
  });
});

describe('the Inbox item composer', () => {
  test("binds the chat's composer to its own item's draft slot, never to the chat's", async () => {
    const api = { send: async () => ({}) };
    const view = render(
      <AgendaInboxComposer
        clientFor={async () => api as never}
        compact
        connection={daemon}
        itemId={A5}
        view={sessionView('s1', { config: { teammate: 'kai', name: 'Release train' } })}
      />,
    );
    await settle();

    const composer = view.root.findByType(Composer);

    expect(composer.props.draftSlot).toBe(A5);
    expect(composer.props.sessionId).toBe('s1');
    run(() => view.unmount());
  });
});
