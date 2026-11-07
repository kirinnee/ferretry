/**
 * &B142 — EACH INBOX CARD HAS ITS OWN DRAFT. The chat box and every card of one ferret used to be ONE shared
 * draft, so typing in the chat showed under the Inbox card of a different item. A composer now binds to a draft
 * SLOT: the chat's (no `draftSlot`) or an agenda item's.
 *
 * `Daemon` below is a machine that keeps one draft per slot and relays each edit to every other stream open on
 * the same slot, like the real service: two mounted composers on one slot are two of the owner's devices.
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
import { type AgendaId, daemonConnection, daemonFerretKey, daemonFerretScope } from '../../../../app/composer/seam.ts';
import { DaemonDraftStore, type DraftStorage } from '../../../../app/composer/drafts.ts';
import {
  socketOf,
  type SuiteStreamOpener as DaemonStreamOpener,
  type SuiteStreamSession,
  withClient,
} from '../../../support/app/composer-host.tsx';
import { fakeClient } from '../../../support/app/fake-client.ts';
import { writeMdComposePref } from '@ferretry/app';
import { ensureDom, interact, mount, must } from '@ferretry/app/testing';
import { runAsync } from '@ferretry/app/testing';

// The DOM is registered on the first mount; the key case mounts nothing, and the cleanup reads the document.
beforeEach(() => {
  ensureDom();
  writeMdComposePref('on');
});
afterEach(() => {
  writeMdComposePref('on');
  document.getSelection()?.removeAllRanges();
});

const daemon = daemonConnection('slots');
const AT = '2026-11-02T00:00:00.000Z' as Instant;
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
  private readonly live = new Map<string, Set<(frame: SharedDraftServerFrame) => void>>();

  held(slot: string): Held {
    const found = this.slots.get(slot) ?? { text: '', epoch: 0, rev: 0 };
    this.slots.set(slot, found);
    return found;
  }

  /**
   * GAP(app-shell): the client socket takes no query, so every stream is the chat's — an item's card opens none and
   * its draft stays on this device. `asked` still records one `null` per stream opened.
   */
  readonly open: DaemonStreamOpener = request => {
    this.asked.push(null);
    const slot = 'chat';
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
        ferret: 's1' as FerretId,
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
    } as unknown as SuiteStreamSession;
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

/** One composer: the chat's (no `slot`) or an item's card. */
const box = async (
  machine: Daemon,
  drafts: DaemonDraftStore,
  options: { readonly slot?: AgendaId } = {},
): Promise<Box> => {
  const sent: Box['sent'] = [];
  const api = {
    send: async (_ferretId: string, body: { message: string; sharedDraft?: SharedDraftSent }, requestId?: string) => {
      sent.push(body);
      if (body.sharedDraft !== undefined) machine.clear(requestId ?? 'no-id', body.sharedDraft);
      return {};
    },
  };
  const view = await mount(
    withClient(
      <Composer
        api={api as never}
        daemon={daemon}
        draftStore={drafts}
        {...(options.slot === undefined ? {} : { draftSlot: options.slot })}
        ferretId="s1"
      />,
      fakeClient({}, { more: socketOf(machine.open) }),
    ),
  );
  await settle();
  const element = must(view.container.querySelector<HTMLElement>('[data-live-editor]'), 'the live editor');
  await interact(() => element.focus());
  return { it: person(element), sent, unmount: view.unmount };
};

const store = () => new DaemonDraftStore(new MemoryStorage());
const chatScope = daemonFerretScope(daemon, 's1');
const cardScope = (item: AgendaId) => daemonFerretScope(daemon, 's1', item);

describe('a draft slot (B142)', () => {
  test('the chat is the two-part key it always was, and a card adds its item', () => {
    expect(daemonFerretKey(chatScope)).toBe('["slots","s1"]');
    expect(daemonFerretKey(cardScope(A5))).toBe('["slots","s1","A5"]');
  });

  test('typing in an Inbox card never reaches the chat draft, and typing in the chat never reaches the card', async () => {
    // Arrange — the chat box and the card of !A5, one ferret, one machine.
    const machine = new Daemon();
    const drafts = store();
    const chat = await box(machine, drafts);
    const card = await box(machine, drafts, { slot: A5 });
    // GAP(app-shell): only the chat opens a stream; the card's draft has none in 5.0.
    expect(machine.asked).toEqual([null]);

    // Act
    await chat.it.type('chat words');
    await card.it.type('card words');
    await saved();

    // Assert — each box holds its own words, on the screen, on the machine and in the saved drafts.
    expect(chat.it.shown()).toBe('chat words');
    expect(card.it.shown()).toBe('card words');
    expect(machine.held('chat').text).toBe('chat words');
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
    await saved();

    expect(first.it.shown()).toBe('about five');
    expect(second.it.shown()).toBe('about six');
    expect(drafts.load(cardScope(A5))).toBe('about five');
    expect(drafts.load(cardScope(A6))).toBe('about six');
    expect(machine.held('chat').text).toBe('');
    await first.unmount();
    await second.unmount();
  });

  test('a send from a card clears only that card', async () => {
    const machine = new Daemon();
    const drafts = store();
    const chat = await box(machine, drafts);
    const card = await box(machine, drafts, { slot: A5 });
    await chat.it.type('still typing in the chat');
    await card.it.type('done here');

    await card.it.send();

    expect(card.sent.map(body => body.message)).toEqual(['done here']);
    // GAP(app-shell): a card has no stream, so its send carries no shared-draft clear to name the slot in.
    expect(card.sent[0]?.sharedDraft).toBeUndefined();
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
