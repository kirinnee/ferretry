import { afterEach, describe, expect, it } from 'bun:test';
import { type AttachmentView, MAX_BOARD_REOPEN_ATTACHMENTS } from '@ferretry/protocol';
import { useEffect } from 'react';
import {
  BoardSendBack,
  SEND_BACK_FILES_NEED_UPDATE,
  type SendBack,
  type SendBackFiles,
  type SendBackPorts,
  useSendBackFiles,
} from '../../../src/features/board/board-send-back.tsx';
import type { DaemonConnection } from '../../../src/lib/daemon-connection.ts';
import { interact, type Mounted, mount, must, pressKey } from '../../support/dom.ts';
import { deferred, flush, laptop, workstation } from '../board-support.ts';

let view: Mounted | null = null;
/** Unmounts what is drawn, so a test can draw again (a function, so TypeScript does not narrow `view` away). */
const reset = async (): Promise<void> => {
  await view?.unmount();
  view = null;
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
    offered: true,
    sessionId: 'child-1',
    upload: async file => {
      uploaded.push(file.name);
      return viewOf(file);
    },
    uploaded,
    ...overrides,
  };
};

const typeReason = async (root: HTMLElement, value: string): Promise<HTMLTextAreaElement> => {
  const input = must(root.querySelector<HTMLTextAreaElement>('[aria-label="Reason"]'), 'the reason');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, value);
  await interact(() => input.dispatchEvent(new Event('input', { bubbles: true })));
  return input;
};

const pick = async (root: HTMLElement, picked: readonly File[]): Promise<void> => {
  const picker = must(root.querySelector<HTMLInputElement>('[data-send-back-picker]'), 'the file picker');
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
      {...props}
    />,
  );
  const root = view.container;
  const submit = must(root.querySelector<HTMLButtonElement>('button[type="submit"]'), 'Send back');
  return { root, submit, sent, log };
};

describe('BoardSendBack — the words', () => {
  it('is a modal dialog named by its heading, focused on the words, and sends nothing without them', async () => {
    const { root, submit, sent } = await composer();
    const dialog = must(root.querySelector('[role="dialog"]'), 'the dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(root.querySelector('.fy-board-reason__heading')?.textContent).toBe(
      'Not good: send Pairing QR back to Implement',
    );
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Reason');
    expect(root.querySelector('[aria-label="Reason"]')?.getAttribute('placeholder')).toBe(
      'What is not good? The ferret reads this.',
    );
    expect(submit.disabled).toBe(true);
    await interact(() => dialog.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(sent).toEqual([]);
  });

  it('sends the trimmed words with Send back, and with Enter, but not with Shift+Enter', async () => {
    const { root, submit, sent } = await composer();
    const input = await typeReason(root, '  the toggle still flickers  ');
    expect(submit.disabled).toBe(false);
    await interact(() => pressKey(input, 'Enter', { shiftKey: true }));
    expect(sent).toEqual([]);
    await interact(() => pressKey(input, 'Enter'));
    await interact(() => submit.click());
    expect(sent).toEqual([
      { reason: 'the toggle still flickers', attachmentIds: [] },
      { reason: 'the toggle still flickers', attachmentIds: [] },
    ]);
  });

  it('does not send with Enter while there are no words', async () => {
    const { root, sent } = await composer();
    const input = await typeReason(root, '   ');
    await interact(() => pressKey(input, 'Enter'));
    expect(sent).toEqual([]);
  });

  it('cancels with Cancel and with Escape', async () => {
    const { root, log } = await composer();
    await interact(() =>
      must(
        root.querySelector<HTMLButtonElement>('button[data-variant="ghost"]:not(.fy-board-sendback__attach)'),
        'Cancel',
      ).click(),
    );
    await interact(() => pressKey(must(root.querySelector('[aria-label="Reason"]'), 'the reason'), 'Escape'));
    expect(log).toEqual(['cancel', 'cancel']);
  });

  it('keeps its width while it sends, says so, and holds every control', async () => {
    const { root, submit } = await composer({ busy: true });
    expect(submit.getAttribute('aria-label')).toBe('Sending…');
    expect(submit.disabled).toBe(true);
    expect(submit.querySelector('[data-spinner]')).not.toBeNull();
    // Both words are drawn, the idle one hidden, so the button keeps the width of the longer.
    const label = must(submit.querySelector('.fy-board-sendback__send-label'), 'the label');
    expect(label.hasAttribute('data-busy')).toBe(true);
    expect([...label.children].map(word => word.textContent)).toEqual(['Send back', 'Sending…']);
    expect(root.querySelector<HTMLTextAreaElement>('[aria-label="Reason"]')?.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('.fy-board-sendback__attach')?.disabled).toBe(true);
    expect(root.querySelector('form')?.getAttribute('aria-busy')).toBe('true');
  });

  it("shows the daemon's refusal against the words", async () => {
    const { root } = await composer({ error: 'only the owner closes' });
    expect(root.querySelector('[role="alert"]')?.textContent).toBe('only the owner closes');
    expect(root.querySelector('[aria-label="Reason"]')?.getAttribute('aria-invalid')).toBe('true');
    expect(root.querySelector('[aria-label="Reason"]')?.getAttribute('aria-describedby')).toBe(
      root.querySelector('[role="alert"]')?.id ?? 'missing',
    );
  });

  it('takes its words from the move it is for', async () => {
    const { root, submit } = await composer({
      heading: 'Move Card back to Todo',
      placeholder: 'Why is it going back? The ferret reads this.',
      submitLabel: 'Move back',
      busyLabel: 'Moving…',
    });
    expect(root.querySelector('[aria-label="Reason"]')?.getAttribute('placeholder')).toBe(
      'Why is it going back? The ferret reads this.',
    );
    expect(submit.getAttribute('aria-label')).toBe('Move back');
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
    expect(sent).toEqual([
      { reason: 'see the pictures', attachmentIds: [viewOf(png('flicker.png')).id, viewOf(png('after.png')).id] },
    ]);
  });

  it('opens the picker from Attach, and ignores an empty pick', async () => {
    const { root } = await composer();
    const picker = must(root.querySelector<HTMLInputElement>('[data-send-back-picker]'), 'the picker');
    let opened = 0;
    picker.click = () => {
      opened += 1;
    };
    await interact(() => must(root.querySelector<HTMLButtonElement>('.fy-board-sendback__attach'), 'Attach').click());
    expect(opened).toBe(1);
    await pick(root, []);
    expect(root.querySelector('[aria-label="Attached files"]')).toBeNull();
  });

  it('takes a pasted screenshot as a file, and leaves pasted words to the box', async () => {
    const given = files();
    const { root } = await composer({ files: given });
    const input = must(root.querySelector('[aria-label="Reason"]'), 'the reason');
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
    const empty = new Event('paste', { bubbles: true, cancelable: true });
    Object.assign(empty, { clipboardData: null });
    await interact(() => input.dispatchEvent(empty));
    expect(empty.defaultPrevented).toBe(false);
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
    expect(root.querySelector('.fy-board-sendback__hold')?.textContent).toBe('Wait for the files to finish uploading.');
    slow.resolve(viewOf(png('a.png')));
    await interact(() => flush());
    expect(submit.disabled).toBe(false);
    expect(root.querySelector('.fy-board-sendback__hold')).toBeNull();
    failing = true;
    await pick(root, [png('b.png')]);
    expect(submit.disabled).toBe(true);
    expect(root.querySelector('.fy-board-sendback__hold')?.textContent).toBe(
      'Remove or retry the file that did not upload.',
    );
  });

  it(`takes at most ${MAX_BOARD_REOPEN_ATTACHMENTS} files`, async () => {
    const given = files();
    const { root } = await composer({ files: given });
    await pick(
      root,
      Array.from({ length: MAX_BOARD_REOPEN_ATTACHMENTS + 2 }, (_, index) => png(`${index}.png`)),
    );
    expect(given.uploaded).toHaveLength(MAX_BOARD_REOPEN_ATTACHMENTS);
    const attach = must(root.querySelector<HTMLButtonElement>('.fy-board-sendback__attach'), 'Attach');
    expect(attach.disabled).toBe(true);
    expect(attach.title).toBe(`Up to ${MAX_BOARD_REOPEN_ATTACHMENTS} files`);
  });

  it('waits on Attach until the machine has answered', async () => {
    const { root } = await composer({ files: files({ offered: null }) });
    const attach = must(root.querySelector<HTMLButtonElement>('.fy-board-sendback__attach'), 'Attach');
    expect(attach.disabled).toBe(true);
    expect(attach.title).toBe('Asking the machine whether it takes files…');
    expect(attach.querySelector('svg')).not.toBeNull();
    expect(root.querySelector('[data-send-back-note]')).toBeNull();
  });

  it('sends the words alone to a machine too old for pictures, and says how to get them', async () => {
    const given = files({ offered: false });
    const { root } = await composer({ files: given });
    expect(root.querySelector('.fy-board-sendback__attach')).toBeNull();
    expect(root.querySelector('[data-send-back-note="update"]')?.textContent).toBe(SEND_BACK_FILES_NEED_UPDATE);
    const shot = new Event('paste', { bubbles: true, cancelable: true });
    Object.assign(shot, { clipboardData: { files: [png('screen.png')] } });
    await interact(() => must(root.querySelector('[aria-label="Reason"]'), 'reason').dispatchEvent(shot));
    expect(shot.defaultPrevented).toBe(false);
    expect(given.uploaded).toEqual([]);
  });

  it('draws the words alone, with no note, where the page cannot upload', async () => {
    const { root } = await composer({ files: null });
    expect(root.querySelector('.fy-board-sendback__attach')).toBeNull();
    expect(root.querySelector('[data-send-back-note]')).toBeNull();
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
  const ports = (answer: (daemon: DaemonConnection) => Promise<boolean>): SendBackPorts => ({
    sendBackFiles: answer,
    uploadAttachment: async (daemon, sessionId, file) => {
      uploads.push(`${daemon.daemonId}:${sessionId}:${file.name}`);
      return viewOf(file);
    },
  });

  it("asks the card's machine, then uploads to the card's ferret", async () => {
    const { seen, last } = await probe(
      ports(async () => true),
      laptop,
      'child-1',
    );
    expect(seen[0]?.offered).toBeNull();
    expect(last()?.offered).toBe(true);
    expect(last()?.sessionId).toBe('child-1');
    await last()?.upload(png('a.png'));
    expect(uploads.at(-1)).toBe(`${laptop.daemonId}:child-1:a.png`);
  });

  it('reads a machine that says no as too old, and one that cannot be asked as not yet read', async () => {
    expect(
      (
        await probe(
          ports(async () => false),
          laptop,
          'child-1',
        )
      ).last()?.offered,
    ).toBe(false);
    await reset();
    const failing = await probe(
      ports(async () => {
        throw new Error('offline');
      }),
      laptop,
      'child-1',
    );
    expect(failing.last()?.offered).toBeNull();
  });

  it('forgets one machine answer when the card is on another', async () => {
    const answers = new Map([
      [laptop.daemonId, deferred<boolean>()],
      [workstation.daemonId, deferred<boolean>()],
    ]);
    const { last, rerender } = await probe(
      ports(daemon => must(answers.get(daemon.daemonId), 'answer').promise),
      laptop,
      'child-1',
    );
    answers.get(laptop.daemonId)?.resolve(true);
    await interact(() => flush());
    expect(last()?.offered).toBe(true);
    await rerender(workstation);
    expect(last()?.offered).toBeNull();
    // The machine left behind answering late changes nothing.
    await rerender(laptop);
    await rerender(workstation);
    answers.get(workstation.daemonId)?.resolve(false);
    await interact(() => flush());
    expect(last()?.offered).toBe(false);
  });

  it('gives nothing without ports, a machine or a ferret', async () => {
    expect((await probe(undefined, laptop, 'child-1')).last()).toBeNull();
    await reset();
    expect(
      (
        await probe(
          ports(async () => true),
          undefined,
          'child-1',
        )
      ).last(),
    ).toBeNull();
    await reset();
    expect(
      (
        await probe(
          ports(async () => true),
          laptop,
          null,
        )
      ).last(),
    ).toBeNull();
  });

  it.each([
    { name: 'an answer', settle: (late: ReturnType<typeof deferred<boolean>>) => late.resolve(true) },
    { name: 'a failure', settle: (late: ReturnType<typeof deferred<boolean>>) => late.reject(new Error('gone')) },
  ])('drops $name that comes back after the hook is gone', async ({ settle }) => {
    const late = deferred<boolean>();
    const { seen } = await probe(
      ports(() => late.promise),
      laptop,
      'child-1',
    );
    const before = seen.length;
    await reset();
    settle(late);
    await flush();
    expect(seen).toHaveLength(before);
  });
});
