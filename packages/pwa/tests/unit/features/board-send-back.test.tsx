import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { type AttachmentView, MAX_BOARD_REOPEN_ATTACHMENTS } from '@ferretry/protocol';
import type { FyApiClient } from '@ferretry/protocol/client';
import { useEffect } from 'react';
import { Composer, type ComposerProps } from '../../../src/components/composer.tsx';
import {
  BoardSendBack,
  type SendBack,
  type SendBackFiles,
  type SendBackPorts,
  useSendBackFiles,
} from '../../../src/features/board/board-send-back.tsx';
import type { DaemonConnectionRepository } from '../../../src/lib/connections.ts';
import type { DaemonConnection } from '../../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../../src/lib/daemon-scope.ts';
import { DaemonDraftStore, documentDraftStore, type DraftStorage } from '../../../src/lib/drafts.ts';
import { writeMdComposePref } from '../../../src/lib/md-compose.ts';
import { MemoryOutboxBackend } from '../../../src/lib/send-outbox.ts';
import { createAppStore, StoreProvider } from '../../../src/lib/store.tsx';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';
import { deferred, flush, laptop, workstation } from '../board-support.ts';
import { mouseIsLastPointer } from './send-back-support.ts';

// The box is the chat's composer; the Plain textarea is the editor these suites drive, as the composer's own do.
beforeEach(() => writeMdComposePref('off'));

let view: Mounted | null = null;
/** Unmounts what is drawn, so a test can draw again (a function, so TypeScript does not narrow `view` away). */
const reset = async (): Promise<void> => {
  await view?.unmount();
  view = null;
  writeMdComposePref('on');
};
afterEach(reset);

const viewOf = (file: File): AttachmentView => ({
  id: `att_${file.name
    .padEnd(64, '0')
    .slice(0, 64)
    .replace(/[^0-9a-f]/gu, '0')}`,
  filename: file.name,
  mime: file.type,
  size: file.size,
  sha256: '0'.repeat(64),
  createdAt: '2026-10-30T10:00:00.000Z',
});

const png = (name: string): File => new File(['png'], name, { type: 'image/png' });

const files = (overrides: Partial<SendBackFiles> = {}): SendBackFiles & { readonly uploaded: string[] } => {
  const uploaded: string[] = [];
  return {
    sessionId: 'child-1',
    upload: async file => {
      uploaded.push(file.name);
      return viewOf(file);
    },
    uploaded,
    ...overrides,
  };
};

const fieldOf = (root: HTMLElement): HTMLTextAreaElement =>
  must(root.querySelector<HTMLTextAreaElement>('textarea'), 'the composer field');

const typeReason = async (root: HTMLElement, value: string): Promise<HTMLTextAreaElement> => {
  const input = fieldOf(root);
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, value);
  await interact(() => input.dispatchEvent(new Event('input', { bubbles: true })));
  return input;
};

/** Presses a key the way `pressKey` does, and says whether the field kept it from the browser. */
const press = async (target: EventTarget, key: string, init: KeyboardEventInit = {}): Promise<boolean> => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  await interact(() => target.dispatchEvent(event));
  return event.defaultPrevented;
};

const attachButton = (root: HTMLElement): HTMLButtonElement | null =>
  root.querySelector<HTMLButtonElement>('button[data-composer-attach]');

/** The composer's hidden pickers: photos, then files (the camera one only where a touch screen asks for it). */
const pick = async (root: HTMLElement, picked: readonly File[]): Promise<void> => {
  const picker = must(root.querySelector<HTMLInputElement>('input[type="file"]:not([capture])'), 'the file picker');
  Object.defineProperty(picker, 'files', { configurable: true, value: picked });
  await interact(() => picker.dispatchEvent(new Event('change', { bubbles: true })));
  await interact(() => flush());
};

const composer = async (props: Partial<Parameters<typeof BoardSendBack>[0]> = {}) => {
  const sent: SendBack[] = [];
  const log: string[] = [];
  view = await mount(
    <BoardSendBack
      busy={false}
      error={null}
      files={files()}
      heading="Not good: send Pairing QR back to Implement"
      onCancel={() => void log.push('cancel')}
      onSubmit={sendBack => void sent.push(sendBack)}
      target={{ daemon: laptop, sessionId: 'child-1' }}
      {...props}
    />,
  );
  await mouseIsLastPointer();
  const root = view.container;
  const submit = must(root.querySelector<HTMLButtonElement>('button[data-composer-send]'), 'Send back');
  return { root, submit, sent, log };
};

describe('BoardSendBack — the chat composer', () => {
  it('is a modal dialog named by its heading, drawing the chat composer focused on the words', async () => {
    const { root, submit } = await composer();
    const dialog = must(root.querySelector('[role="dialog"]'), 'the dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe(root.querySelector('.fy-board-reason__heading')?.id ?? 'x');
    expect(root.querySelector('.fy-board-reason__heading')?.textContent).toBe(
      'Not good: send Pairing QR back to Implement',
    );
    // The chat's own composer: its form, its field, its send, its attach — not a box of the Board's.
    expect(dialog.querySelector('form[data-composer-style]')).not.toBeNull();
    expect(document.activeElement).toBe(fieldOf(root));
    expect(fieldOf(root).getAttribute('placeholder')).toBe('What went wrong?');
    expect(attachButton(root)).not.toBeNull();
    expect(root.querySelector('.fy-composer-quota')).toBeNull();
    expect(submit.getAttribute('aria-label')).toContain('Send back');
    expect(submit.disabled).toBe(true);
  });

  it('draws no dialog inside a form, so the composer is the only form in the box', async () => {
    const { root } = await composer();
    expect(root.querySelectorAll('form')).toHaveLength(1);
    expect(root.querySelector('form form')).toBeNull();
  });

  it('sends the trimmed words with Send back and with Enter, but not with Shift+Enter', async () => {
    const { root, submit, sent } = await composer();
    const input = await typeReason(root, '  the toggle still flickers  ');
    expect(submit.disabled).toBe(false);
    // Shift+Enter is a new line: the field is left to make it, and nothing is sent.
    expect(await press(input, 'Enter', { shiftKey: true })).toBe(false);
    expect(sent).toEqual([]);
    expect(await press(input, 'Enter')).toBe(true);
    await interact(() => flush());
    expect(sent).toEqual([{ reason: 'the toggle still flickers', attachmentIds: [] }]);
    await typeReason(root, 'and the label');
    await interact(() => submit.click());
    await interact(() => flush());
    expect(sent.at(-1)).toEqual({ reason: 'and the label', attachmentIds: [] });
  });

  it('does not send with Enter while there are no words', async () => {
    const { root, sent } = await composer();
    const input = await typeReason(root, '   ');
    await press(input, 'Enter');
    expect(sent).toEqual([]);
  });

  it('keeps the words, and says why, when the host refuses them', async () => {
    const { root } = await composer({ onSubmit: () => 'only the owner closes' });
    const input = await typeReason(root, 'not good');
    await press(input, 'Enter');
    await interact(() => flush());
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('only the owner closes');
    expect(fieldOf(root).value).toBe('not good');
  });

  it("sends an empty answer when the words are optional (a Not yet), under the move's own label", async () => {
    const { root, submit, sent } = await composer({ wordsOptional: true, submitLabel: 'Not yet' });
    expect(submit.disabled).toBe(false);
    expect(submit.getAttribute('aria-label')).toContain('Not yet');
    await interact(() => submit.click());
    await interact(() => flush());
    expect(sent).toEqual([{ reason: '', attachmentIds: [] }]);
    expect(root.querySelector('[role="alert"]')).toBeNull();
  });

  it('refuses words past the limit without sending them, and keeps them', async () => {
    const { root, sent } = await composer();
    const input = await typeReason(root, 'x'.repeat(5000));
    await press(input, 'Enter');
    await interact(() => flush());
    expect(sent).toEqual([]);
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('too long');
    expect(fieldOf(root).value).toHaveLength(5000);
  });

  it('cancels with Cancel and with Escape, in the field and out of it', async () => {
    const { root, log } = await composer();
    const cancel = must(root.querySelector<HTMLButtonElement>('.fy-board-sendback__cancel'), 'Cancel');
    expect(cancel.textContent).toBe('Cancel');
    await interact(() => cancel.click());
    await press(fieldOf(root), 'Escape');
    await press(cancel, 'Escape');
    expect(log).toEqual(['cancel', 'cancel', 'cancel']);
  });

  it('holds the box while the card is being worked on', async () => {
    const { root, submit } = await composer({ busy: true });
    expect(root.querySelector('[role="dialog"]')?.getAttribute('aria-busy')).toBe('true');
    expect(fieldOf(root).disabled).toBe(true);
    expect(submit.disabled).toBe(true);
    expect(must(root.querySelector<HTMLButtonElement>('.fy-board-sendback__cancel'), 'Cancel').disabled).toBe(true);
  });

  it("shows the host's refusal above the box", async () => {
    const { root } = await composer({ error: 'only the owner closes' });
    expect(root.querySelector('.fy-board-reason__error')?.textContent).toBe('only the owner closes');
  });

  it('takes its words from the move it is for', async () => {
    const { root, submit } = await composer({
      heading: 'Move Card back to Todo',
      placeholder: 'Why is it going back?',
      submitLabel: 'Move back',
    });
    expect(fieldOf(root).getAttribute('placeholder')).toBe('Why is it going back?');
    expect(submit.getAttribute('aria-label')).toContain('Move back');
  });

  it('shares ONE width class with every other Not good box: its own, with no width of its own', async () => {
    const { root } = await composer();
    const dialog = must(root.querySelector('[role="dialog"]'), 'the dialog');
    expect(dialog.classList.contains('fy-board-sendback')).toBe(true);
    // The three hosts (Inbox, to-test rows, board) draw THIS component and add no class of their own to it.
    expect([...dialog.classList].sort()).toEqual(['fy-board-reason', 'fy-board-sendback']);
  });
});

describe('the Not good box — one width rule', () => {
  const css = (name: string): string => readFileSync(new URL(`../../../src/features/${name}`, import.meta.url), 'utf8');
  const rule = (source: string, selector: string): string => {
    const start = source.lastIndexOf(`\n${selector} {`);
    if (start < 0) throw new Error(`no rule for ${selector}`);
    return source.slice(start, source.indexOf('}', start));
  };

  it('fills the column its host gives it, and carries no width of its own', () => {
    const own = rule(css('board/board.css'), '.fy-board-sendback');
    expect(own).toContain('width: 100%');
    expect(own).not.toMatch(/\d(?:rem|px|ch)/u);
    expect(css('board/board.css')).not.toContain('.fy-board-sendback__input');
  });

  it("sits in the Inbox deck on the card's own inset, the one the card's margin is drawn with", () => {
    const inbox = css('agenda/agenda-inbox.css');
    expect(rule(inbox, '.fy-attn-inbox__deck--open > .fy-attn-deck')).toContain('var(--fy-deck-card-inset)');
    const why = rule(inbox, '.fy-inbox-gate-why');
    expect(why).toContain('var(--fy-deck-card-inset)');
    expect(why).toContain('var(--fy-deck-foot-inset)');
  });
});

describe('BoardSendBack — voice, and nothing of the chat', () => {
  const mountInStore = async () => {
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
    const chats: unknown[] = [];
    const store = await createAppStore({
      repository: new Memory(),
      connectClient: async () =>
        ({ send: async (...args: unknown[]) => void chats.push(args) }) as unknown as FyApiClient,
      fetcher: async () => Response.json({}),
      outboxBackend: new MemoryOutboxBackend(),
    });
    store.connections.add(laptop);
    const sent: SendBack[] = [];
    view = await mount(
      <StoreProvider store={store}>
        <BoardSendBack
          busy={false}
          error={null}
          files={files()}
          heading="Not good: send Pairing QR back to Implement"
          onCancel={() => undefined}
          onSubmit={sendBack => void sent.push(sendBack)}
          target={{ daemon: laptop, sessionId: 'child-1' }}
        />
      </StoreProvider>,
    );
    await mouseIsLastPointer();
    return { store, chats, sent, root: view.container };
  };

  it("has the chat's microphone, from this device's dictation settings", async () => {
    const { root } = await mountInStore();
    expect(root.querySelector('button[aria-label*="ictat"]')).not.toBeNull();
  });

  it("never makes a Not good draft the ferret's chat draft, a queued message or a chat send", async () => {
    const scope = daemonSessionScope(laptop, 'child-1');
    documentDraftStore.clear(scope);
    const { store, chats, sent, root } = await mountInStore();
    const input = await typeReason(root, 'the toggle still flickers');
    // Typing keeps nothing: the session's draft on this device is untouched.
    expect(documentDraftStore.load(scope)).toBe('');
    await press(input, 'Enter');
    await interact(() => flush());
    // The move got the words; no chat message was sent, none waits in the device outbox, no draft was left.
    expect(sent).toEqual([{ reason: 'the toggle still flickers', attachmentIds: [] }]);
    expect(chats).toEqual([]);
    expect(store.outbox.snapshot()).toEqual([]);
    expect(documentDraftStore.load(scope)).toBe('');
  });
});

describe('Composer — detached', () => {
  class Memory implements DraftStorage {
    readonly values = new Map<string, string>();
    getItem(key: string): string | null {
      return this.values.get(key) ?? null;
    }
    setItem(key: string, value: string): void {
      this.values.set(key, value);
    }
  }

  it('opens no shared-draft stream, saves no draft, and sends the words as written', async () => {
    const storage = new Memory();
    const opened: unknown[] = [];
    const messages: string[] = [];
    view = await mount(
      <Composer
        api={
          {
            send: async (_session: string, input: { readonly message: string }) => void messages.push(input.message),
          } as unknown as ComposerProps['api']
        }
        daemon={laptop}
        detached={{ sendLabel: 'Send back', attachable: false }}
        draftStore={new DaemonDraftStore(storage)}
        openDraftStream={async (...args) => {
          opened.push(args);
          throw new Error('a detached composer opens no stream');
        }}
        sessionId="child-1"
      />,
    );
    await mouseIsLastPointer();
    const input = await typeReason(view.container, 'words only');
    await interact(() => flush());
    expect(storage.values.size).toBe(0);
    await press(input, 'Enter');
    await interact(() => flush());
    expect(messages).toEqual(['words only']);
    expect(opened).toEqual([]);
    expect(storage.values.size).toBe(0);
    // A host that takes no files has no attach.
    expect(attachButton(view.container)).toBeNull();
  });
});

describe('BoardSendBack — pictures', () => {
  it('uploads picked files to the ferret at once and sends their ids with the words', async () => {
    const given = files();
    const { root, submit, sent } = await composer({ files: given });
    await pick(root, [png('flicker.png'), png('after.png')]);
    expect(given.uploaded).toEqual(['flicker.png', 'after.png']);
    expect(root.querySelectorAll('[aria-label="Attached files"] li')).toHaveLength(2);
    await typeReason(root, 'see the pictures');
    await interact(() => submit.click());
    await interact(() => flush());
    expect(sent).toEqual([
      { reason: 'see the pictures', attachmentIds: [viewOf(png('flicker.png')).id, viewOf(png('after.png')).id] },
    ]);
  });

  it('does not send pictures alone: a send back always carries words', async () => {
    const { root, submit, sent } = await composer();
    await pick(root, [png('flicker.png')]);
    expect(submit.disabled).toBe(true);
    expect(sent).toEqual([]);
  });

  it('takes a pasted screenshot as a file, and leaves pasted words to the box', async () => {
    const given = files();
    const { root } = await composer({ files: given });
    const input = fieldOf(root);
    const words = new Event('paste', { bubbles: true, cancelable: true });
    Object.assign(words, { clipboardData: { files: [] } });
    await interact(() => input.dispatchEvent(words));
    expect(words.defaultPrevented).toBe(false);
    const shot = new Event('paste', { bubbles: true, cancelable: true });
    Object.assign(shot, { clipboardData: { files: [png('screen.png')] } });
    await interact(() => input.dispatchEvent(shot));
    await interact(() => flush());
    expect(shot.defaultPrevented).toBe(true);
    expect(given.uploaded).toEqual(['screen.png']);
  });

  it('holds Send while a file uploads, and while one failed, saying why', async () => {
    const slow = deferred<AttachmentView>();
    let failing = false;
    const { root, submit } = await composer({
      files: files({
        upload: async file => {
          // A file the phone could not read fails the same way every time: no retry.
          if (failing) throw Object.assign(new Error('unreadable'), { name: 'NotReadableError' });
          return await slow.promise.then(() => viewOf(file));
        },
      }),
    });
    await typeReason(root, 'words');
    await pick(root, [png('a.png')]);
    expect(submit.disabled).toBe(true);
    expect(root.querySelector('[data-composer-attachments-hold]')).not.toBeNull();
    slow.resolve(viewOf(png('a.png')));
    await interact(() => flush());
    expect(submit.disabled).toBe(false);
    expect(root.querySelector('[data-composer-attachments-hold]')).toBeNull();
    failing = true;
    await pick(root, [png('b.png')]);
    expect(submit.disabled).toBe(true);
    expect(root.querySelector('[data-composer-attachments-hold]')).not.toBeNull();
  });

  it(`takes at most ${MAX_BOARD_REOPEN_ATTACHMENTS} files`, async () => {
    const given = files();
    const { root } = await composer({ files: given });
    await pick(
      root,
      Array.from({ length: MAX_BOARD_REOPEN_ATTACHMENTS + 2 }, (_, index) => png(`${index}.png`)),
    );
    expect(given.uploaded).toHaveLength(MAX_BOARD_REOPEN_ATTACHMENTS);
  });

  it('draws the words alone where the page cannot upload', async () => {
    const { root } = await composer({ files: null });
    expect(attachButton(root)).toBeNull();
  });
});

describe('useSendBackFiles', () => {
  const probe = async (
    ports: SendBackPorts | undefined,
    daemon: DaemonConnection | undefined,
    sessionId: string | null,
  ) => {
    const seen: (SendBackFiles | null)[] = [];
    function Probe(props: { readonly daemon: DaemonConnection | undefined; readonly sessionId: string | null }) {
      const answer = useSendBackFiles(ports, props.daemon, props.sessionId);
      useEffect(() => void seen.push(answer));
      return null;
    }
    view = await mount(<Probe daemon={daemon} sessionId={sessionId} />);
    await interact(() => flush());
    const rerender = async (next: DaemonConnection | undefined, nextSession: string | null = sessionId) => {
      await view?.render(<Probe daemon={next} sessionId={nextSession} />);
      await interact(() => flush());
    };
    return { seen, last: () => seen.at(-1), rerender };
  };

  const uploads: string[] = [];
  const ports: SendBackPorts = {
    uploadAttachment: async (daemon, sessionId, file) => {
      uploads.push(`${daemon.daemonId}:${sessionId}:${file.name}`);
      return viewOf(file);
    },
  };

  it("uploads to the card's ferret on the card's machine", async () => {
    const { last } = await probe(ports, laptop, 'child-1');
    expect(last()?.sessionId).toBe('child-1');
    await last()?.upload(png('a.png'));
    expect(uploads.at(-1)).toBe(`${laptop.daemonId}:child-1:a.png`);
  });

  it('follows the card to another machine', async () => {
    const { last, rerender } = await probe(ports, laptop, 'child-1');
    await rerender(workstation);
    await last()?.upload(png('b.png'));
    expect(uploads.at(-1)).toBe(`${workstation.daemonId}:child-1:b.png`);
  });

  it('gives nothing without ports, a machine or a ferret', async () => {
    expect((await probe(undefined, laptop, 'child-1')).last()).toBeNull();
    await reset();
    expect((await probe(ports, undefined, 'child-1')).last()).toBeNull();
    await reset();
    expect((await probe(ports, laptop, null)).last()).toBeNull();
  });
});
