import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AttachmentView } from '@ferretry/protocol';
import { attachmentHoldNotice, Composer, type ComposerProps } from '../../src/components/composer.tsx';
import { ComposerAddMenu } from '../../src/components/composer-add-menu.tsx';
import {
  type ComposerAttachmentUploader,
  MAX_CONCURRENT_UPLOADS,
  type RetryWait,
  UPLOAD_ATTEMPTS,
  UPLOAD_RETRY_DELAYS_MS,
  useComposerAttachments,
} from '../../src/components/composer-attachments.ts';
import { PendingAttachmentStrip } from '../../src/components/session-chat-parts.tsx';
import { UPLOAD_CONNECTION_DROPPED_COPY, UPLOAD_DEFERRED_COPY, UPLOAD_QUEUED_COPY } from '../../src/lib/attachments.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonDraftStore, type DraftStorage } from '../../src/lib/drafts.ts';
import { DaemonResponseError } from '../../src/lib/runtime-models.ts';
import '../support/dom.ts';
import { writeMdComposePref } from '../../src/lib/md-compose.ts';
import { render, run, runAsync } from '../support/react.ts';
import { settleUntil } from '../support/settle.ts';

// The general composer behaviour is one key arbitration for every editor style; these suites drive it
// through the Plain textarea. The live editor (Markdown and Rich text) has its own suites.
beforeEach(() => writeMdComposePref('off'));
afterEach(() => writeMdComposePref('on'));

const daemon = daemonConnection({ daemonId: 'attach', baseUrl: 'https://attach.example.test', deviceId: 'device' });

class MemoryStorage implements DraftStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const view = (id: string, file: File): AttachmentView => ({
  id,
  filename: file.name,
  mime: file.type,
  size: file.size,
  sha256: 'a'.repeat(64),
  createdAt: '2026-10-16T00:00:00.000Z',
});

const png = () => new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });
const note = () => new File([new Uint8Array([4, 5])], 'note.m4a', { type: 'audio/x-m4a' });

const files = (list: readonly File[]) => ({ types: ['Files'], files: list });

const originalRevoke = URL.revokeObjectURL;
afterEach(() => {
  URL.revokeObjectURL = originalRevoke;
});

let clicked = 0;
const mountComposer = (props: Partial<ComposerProps> & { upload: ComposerAttachmentUploader }) => {
  clicked = 0;
  const sent: unknown[] = [];
  const { upload, ...rest } = props;
  const composer = render(
    <Composer
      api={{
        send: async (_id: string, request: unknown) => {
          sent.push(request);
          return {} as never;
        },
      }}
      daemon={daemon}
      draftStore={new DaemonDraftStore(new MemoryStorage())}
      sessionId="s1"
      uploadAttachment={upload}
      {...rest}
    />,
    {
      createNodeMock: element =>
        element.type === 'input' && (element.props as { type?: string }).type === 'file'
          ? {
              click: () => {
                clicked += 1;
              },
            }
          : null,
    },
  );
  const form = () => composer.root.findByType('form');
  const strip = () => composer.root.findAllByType(PendingAttachmentStrip)[0];
  const submit = () => composer.root.findByProps({ type: 'submit' });
  return { composer, sent, form, strip, submit };
};

describe('composer attachments', () => {
  test('＋ opens the picker and a chosen file uploads, previews and rides the send', async () => {
    const uploads: File[] = [];
    const { composer, sent, strip, submit, form } = mountComposer({
      upload: async file => {
        uploads.push(file);
        return view(`att_${uploads.length}`, file);
      },
    });
    // ＋ clicks the hidden file input it owns.
    expect(clicked).toBe(0);
    run(() => composer.root.findByProps({ 'data-composer-attach': '' }).props.onClick());
    // ＋ opens a menu; its Files row is the any-type picker.
    const menus = composer.root.findAllByType(ComposerAddMenu);
    const files = menus[0]?.props.actions.find((entry: { key: string }) => entry.key === 'files');
    run(() => files.onSelect());
    expect(clicked).toBe(1);
    const picker = composer.root.findByProps({ type: 'file', accept: undefined });
    const input = { files: [png()], value: 'C:\\fakepath\\shot.png' };
    run(() => picker.props.onChange({ currentTarget: input }));
    expect(input.value).toBe('');
    await settleUntil(() => strip()?.props.entries[0]?.status === 'ready', 'the upload to finish', runAsync);
    expect(strip()?.props.entries[0]?.objectUrl).toMatch(/^blob:/u);
    expect(submit().props.disabled).toBe(false);
    await runAsync(async () => form().props.onSubmit({ preventDefault() {} }));
    expect(sent).toEqual([{ message: 'See the attached files.', attachmentIds: ['att_1'], now: false }]);
    expect(composer.root.findAllByType(PendingAttachmentStrip)).toHaveLength(0);
    run(() => composer.unmount());
  });

  test('a drop and a paste add files; text drags and text pastes stay the browser’s', async () => {
    const { composer, strip, form } = mountComposer({ upload: async file => view(`att_${file.name}`, file) });
    let prevented = 0;
    const event = (transfer: unknown) => ({ dataTransfer: transfer, preventDefault: () => (prevented += 1) });
    run(() => form().props.onDragOver(event({ types: ['text/plain'] })));
    run(() => form().props.onDragOver(event(null)));
    expect(form().props['data-composer-dropping']).toBeUndefined();
    run(() => form().props.onDragOver(event(files([note()]))));
    expect(form().props['data-composer-dropping']).toBe('');
    run(() => form().props.onDragLeave());
    expect(form().props['data-composer-dropping']).toBeUndefined();
    run(() => form().props.onDrop(event({ types: ['text/uri-list'], files: [] })));
    run(() => form().props.onDrop(event(files([note()]))));
    const textarea = composer.root.findByType('textarea');
    run(() => textarea.props.onPaste({ clipboardData: { files: [] }, preventDefault: () => (prevented += 1) }));
    run(() => textarea.props.onPaste({ clipboardData: null, preventDefault: () => (prevented += 1) }));
    run(() => textarea.props.onPaste({ clipboardData: { files: [png()] }, preventDefault: () => (prevented += 1) }));
    expect(prevented).toBe(3);
    await settleUntil(() => strip()?.props.entries.length === 2, 'both files', runAsync);
    expect(strip()?.props.entries.map((entry: { file: File }) => entry.file.name)).toEqual(['note.m4a', 'shot.png']);
    run(() => composer.unmount());
  });

  test('a refused file never travels, a failed upload can be retried, and removing revokes its preview', async () => {
    let fail = true;
    const revoked: string[] = [];
    URL.revokeObjectURL = (url: string) => {
      revoked.push(url);
    };
    const { composer, strip, submit } = mountComposer({
      upload: async file => {
        if (fail) throw Object.assign(new Error('boom'), { status: 413, code: 'attachment_too_large' });
        return view('att_ok', file);
      },
    });
    run(() =>
      composer.root.findByType('textarea').props.onPaste({
        clipboardData: { files: [new File([], 'empty.txt', { type: 'text/plain' }), png()] },
        preventDefault() {},
      }),
    );
    expect(strip()?.props.entries[0]).toMatchObject({ status: 'failed', error: 'That file is empty' });
    await settleUntil(() => strip()?.props.entries[1]?.status === 'failed', 'the upload to fail', runAsync);
    expect(strip()?.props.entries[1]?.error).toBe('Files must be 20 MiB or smaller');
    expect(submit().props.disabled).toBe(true);
    fail = false;
    run(() => strip()?.props.onRetry(strip()?.props.entries[1]));
    expect(strip()?.props.entries[1]?.status).toBe('uploading');
    expect(submit().props.disabled).toBe(true);
    await settleUntil(() => strip()?.props.entries[1]?.status === 'ready', 'the retry', runAsync);
    const preview = strip()?.props.entries[1]?.objectUrl as string;
    run(() => strip()?.props.onRemove(strip()?.props.entries[1]));
    expect(revoked).toEqual([preview]);
    run(() => strip()?.props.onRemove(strip()?.props.entries[0]));
    expect(composer.root.findAllByType(PendingAttachmentStrip)).toHaveLength(0);
    run(() => composer.unmount());
  });

  test('a typed message does not leave without a file that is still going up or did not upload', async () => {
    let finish: (() => void) | undefined;
    let outcome: 'fail' | 'ok' = 'fail';
    const { composer, sent, strip, submit, form } = mountComposer({
      upload: file =>
        new Promise((resolve, reject) => {
          // A refusal, not a drop: a dropped connection is retried on its own before it shows as failed.
          finish = () =>
            outcome === 'ok'
              ? resolve(view('att_late', file))
              : reject(new DaemonResponseError(422, 'the daemon refused it'));
        }),
    });
    const hold = () => composer.root.findAllByProps({ 'data-composer-attachments-hold': '' })[0];
    run(() =>
      composer.root
        .findByType('textarea')
        .props.onChange({ currentTarget: { value: 'see the attached', selectionStart: 16, selectionEnd: 16 } }),
    );
    expect(hold()).toBeUndefined();
    expect(submit().props.disabled).toBe(false);
    run(() =>
      composer.root.findByType('textarea').props.onPaste({ clipboardData: { files: [png()] }, preventDefault() {} }),
    );
    // Still going up: the send says so instead of leaving without the file.
    expect(submit().props.disabled).toBe(true);
    expect(hold()?.props.role).toBe('status');
    expect(hold()?.children.join('')).toContain('Waiting for your files to finish uploading');
    await runAsync(async () => form().props.onSubmit({ preventDefault() {} }));
    expect(sent).toEqual([]);
    // Failed: the typed words are enough for a send on their own, so only the notice stops it.
    await runAsync(async () => finish?.());
    await settleUntil(() => strip()?.props.entries[0]?.status === 'failed', 'the upload to fail', runAsync);
    expect(submit().props.disabled).toBe(true);
    expect(hold()?.props.role).toBe('alert');
    expect(hold()?.children.join('')).toBe(
      'shot.png did not upload, so this message is not sent yet. Retry or remove it first.',
    );
    await runAsync(async () => form().props.onSubmit({ preventDefault() {} }));
    expect(sent).toEqual([]);
    // Retried, it rides the send.
    outcome = 'ok';
    run(() => strip()?.props.onRetry(strip()?.props.entries[0]));
    await runAsync(async () => finish?.());
    await settleUntil(() => strip()?.props.entries[0]?.status === 'ready', 'the retry', runAsync);
    expect(hold()).toBeUndefined();
    expect(submit().props.disabled).toBe(false);
    await runAsync(async () => form().props.onSubmit({ preventDefault() {} }));
    expect(sent).toEqual([{ message: 'see the attached', attachmentIds: ['att_late'], now: false }]);
    run(() => composer.unmount());
  });

  test('says how many files did not upload when there are several', () => {
    const one = (name: string) => ({ localId: name, file: new File([], name), status: 'failed' as const });
    expect(attachmentHoldNotice(false, [one('a.png'), one('b.png')])).toEqual({
      failed: true,
      text: '2 files did not upload, so this message is not sent yet. Retry or remove them first.',
    });
    expect(attachmentHoldNotice(false, [])).toBeNull();
  });

  test('a session change forgets the previous session’s files', async () => {
    const { composer, strip } = mountComposer({ upload: async file => view('att_x', file) });
    run(() =>
      composer.root.findByType('textarea').props.onPaste({ clipboardData: { files: [png()] }, preventDefault() {} }),
    );
    await settleUntil(() => strip()?.props.entries[0]?.status === 'ready', 'the upload', runAsync);
    run(() =>
      composer.update(
        <Composer
          api={{ send: async () => ({}) as never }}
          daemon={daemon}
          draftStore={new DaemonDraftStore(new MemoryStorage())}
          sessionId="s2"
          uploadAttachment={async file => view('att_y', file)}
        />,
      ),
    );
    expect(composer.root.findAllByType(PendingAttachmentStrip)).toHaveLength(0);
    run(() => composer.unmount());
  });

  test('with no uploader of its own the composer uploads through the host carrier', async () => {
    const urls: string[] = [];
    const composer = render(
      <Composer
        api={{ send: async () => ({}) as never }}
        autocompleteFetcher={async input => {
          urls.push(String(input));
          return Response.json({ ...view('att_c', png()), mime: 'image/png' }, { status: 201 });
        }}
        daemon={daemon}
        draftStore={new DaemonDraftStore(new MemoryStorage())}
        sessionId="carrier"
      />,
    );
    run(() =>
      composer.root.findByType('textarea').props.onPaste({ clipboardData: { files: [png()] }, preventDefault() {} }),
    );
    await settleUntil(
      () => composer.root.findAllByType(PendingAttachmentStrip)[0]?.props.entries[0]?.status === 'ready',
      'the carrier upload',
      runAsync,
    );
    expect(urls).toEqual(['https://attach.example.test/v1/sessions/carrier/attachments']);
    run(() => composer.unmount());
  });

  test('the status line carries the host’s runtime chips and the context ring', () => {
    const { composer } = mountComposer({
      upload: async file => view('a', file),
      context: { usedTokens: 118_000, windowTokens: 1_000_000, percent: 11.8, at: '2026-10-30T08:00:00.000Z' },
      statusSlot: <span data-runtime-chips="">opus</span>,
    });
    const status = composer.root.findByProps({ 'data-composer-status': '' });
    expect(status.findByProps({ 'data-runtime-chips': '' }).children).toEqual(['opus']);
    expect(status.findByProps({ 'data-context-ring': '' }).props.title).toBe('118k of 1M tokens (12%)');
    run(() => composer.unmount());
  });

  test('the status line draws no ring while the context is unknown', () => {
    const { composer } = mountComposer({ upload: async file => view('a', file) });
    const status = composer.root.findByProps({ 'data-composer-status': '' });
    expect(status.findAllByProps({ 'data-context-ring': '' })).toEqual([]);
    run(() => composer.unmount());
  });

  test('a tap on the ring goes where the host sends it, and a compaction shows on it', () => {
    const opened: string[] = [];
    const { composer } = mountComposer({
      upload: async file => view('a', file),
      context: { usedTokens: 50_000, windowTokens: 200_000, percent: 25, at: '2026-10-30T08:00:00.000Z' },
      compacting: true,
      onOpenContext: () => opened.push('usage'),
    });
    const ring = composer.root.findByProps({ 'data-context-ring': '' });
    expect(ring.props['data-compacting']).toBe('');
    run(() => ring.props.onClick());
    expect(opened).toEqual(['usage']);
    run(() => composer.unmount());
  });
});

describe('composer uploads over a connection that drops', () => {
  type Hook = ReturnType<typeof useComposerAttachments>;
  const photo = (index: number) => new File([new Uint8Array([index])], `${String(index)}.jpg`, { type: 'image/jpeg' });

  const mountHook = (
    upload: ComposerAttachmentUploader,
    wait: RetryWait = async () => undefined,
    defer?: { readonly offline: () => boolean },
  ) => {
    const hook: { current?: Hook } = {};
    const Probe = () => {
      hook.current = useComposerAttachments(upload, 'scope', wait, defer !== undefined, defer?.offline);
      return null;
    };
    const rendered = render(<Probe />);
    const state = (): Hook => {
      if (hook.current === undefined) throw new Error('the hook has not rendered');
      return hook.current;
    };
    return { rendered, state };
  };

  test(`no more than ${MAX_CONCURRENT_UPLOADS} files upload at once, and the rest say they are waiting`, async () => {
    let inFlight = 0;
    let most = 0;
    const releases: (() => void)[] = [];
    const { rendered, state } = mountHook(async file => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise<void>(resolve => releases.push(resolve));
      inFlight -= 1;
      return view(`att_${file.name}`, file);
    });
    run(() => state().add(Array.from({ length: 7 }, (_, index) => photo(index))));
    expect(inFlight).toBe(MAX_CONCURRENT_UPLOADS);
    expect(state().entries.filter(entry => entry.note === UPLOAD_QUEUED_COPY)).toHaveLength(7 - MAX_CONCURRENT_UPLOADS);
    while (state().entries.some(entry => entry.status !== 'ready')) {
      await runAsync(async () => {
        for (const release of releases.splice(0)) release();
        await new Promise(resolve => setTimeout(resolve, 0));
      });
    }
    expect(most).toBe(MAX_CONCURRENT_UPLOADS);
    expect(state().readyIds).toHaveLength(7);
    expect(state().entries.some(entry => entry.note !== undefined)).toBe(false);
    run(() => rendered.unmount());
  });

  test('a dropped connection is retried on its own, saying so, and the file ends ready', async () => {
    let calls = 0;
    const waits: number[] = [];
    const notes: (string | undefined)[] = [];
    const { rendered, state } = mountHook(
      async file => {
        calls += 1;
        if (calls < 3) throw new Error('the relay socket closed');
        return view('att_ok', file);
      },
      async milliseconds => {
        waits.push(milliseconds);
        // Read once React has rendered what the hook set just before it waited — waited for, not a fixed
        // number of turns: how many React takes is its business, and a count that held on one runner did not.
        const attempt = `(${waits.length + 1} of`;
        for (let turn = 0; turn < 1_500 && !state().entries[0]?.note?.includes(attempt); turn += 1)
          await new Promise(resolve => setTimeout(resolve, 0));
        notes.push(state().entries[0]?.note);
      },
    );
    run(() => state().add([photo(1)]));
    await settleUntil(() => state().entries[0]?.status === 'ready', 'the retried upload', runAsync);
    expect(calls).toBe(3);
    expect(waits).toEqual(UPLOAD_RETRY_DELAYS_MS.slice(0, 2));
    expect(notes).toEqual(['connection dropped — retrying (2 of 4)', 'connection dropped — retrying (3 of 4)']);
    expect(state().entries[0]?.note).toBeUndefined();
    run(() => rendered.unmount());
  });

  test('a connection that never comes back fails after every attempt, and says why', async () => {
    let calls = 0;
    const { rendered, state } = mountHook(async () => {
      calls += 1;
      throw new Error('the relay socket closed');
    });
    run(() => state().add([photo(1)]));
    await settleUntil(() => state().entries[0]?.status === 'failed', 'the upload to give up', runAsync);
    expect(calls).toBe(UPLOAD_ATTEMPTS);
    expect(state().entries[0]?.error).toBe(`${UPLOAD_CONNECTION_DROPPED_COPY} — try again`);
    run(() => rendered.unmount());
  });

  test('beside an outbox, a browser that knows it is offline defers the file without trying', async () => {
    let calls = 0;
    const { rendered, state } = mountHook(
      async file => {
        calls += 1;
        return view('att_ok', file);
      },
      undefined,
      { offline: () => true },
    );
    run(() => state().add([photo(1)]));
    await settleUntil(() => state().entries[0]?.status === 'deferred', 'the deferral', runAsync);
    expect(calls).toBe(0);
    expect(state().entries[0]?.note).toBe(UPLOAD_DEFERRED_COPY);
    expect(state().deferred).toHaveLength(1);
    expect(state().failed).toEqual([]);
    run(() => rendered.unmount());
  });

  test('beside an outbox, a connection that drops and stays down defers instead of failing', async () => {
    let calls = 0;
    let offline = false;
    const { rendered, state } = mountHook(
      async () => {
        calls += 1;
        throw new Error('the relay socket closed');
      },
      undefined,
      { offline: () => offline },
    );
    run(() => state().add([photo(1)]));
    await settleUntil(() => state().entries[0]?.status === 'deferred', 'the deferral after every attempt', runAsync);
    expect(calls).toBe(UPLOAD_ATTEMPTS);
    // A drop the browser confirms as offline defers at once, instead of waiting through the retries.
    offline = false;
    calls = 0;
    run(() => state().retry(state().entries[0] as never));
    offline = true;
    await settleUntil(() => state().entries[0]?.status === 'deferred', 'the deferral while offline', runAsync);
    expect(calls).toBe(1);
    run(() => rendered.unmount());
  });

  test('beside an outbox, a refusal the daemon gave a reason for still fails', async () => {
    const { rendered, state } = mountHook(
      async () => {
        throw new DaemonResponseError(415, 'unsupported image type', 'attachment_unsupported_mime');
      },
      undefined,
      { offline: () => false },
    );
    run(() => state().add([photo(1)]));
    await settleUntil(() => state().entries[0]?.status === 'failed', 'the refusal', runAsync);
    expect(state().deferred).toEqual([]);
    run(() => rendered.unmount());
  });

  test('a deferred file says it uploads when the connection is back, and offers a retry', () => {
    const file = photo(1);
    const tree = render(
      <PendingAttachmentStrip
        entries={[{ localId: 'l1', file, status: 'deferred', note: UPLOAD_DEFERRED_COPY }]}
        onRemove={() => undefined}
        onRetry={() => undefined}
      />,
    );
    const json = JSON.stringify(tree.toJSON());
    expect(json).toContain(UPLOAD_DEFERRED_COPY);
    expect(tree.root.findAll(node => node.props['aria-label'] === `Retry ${file.name}`)).toHaveLength(1);
    run(() => tree.unmount());
  });

  test('a refusal the daemon gave a reason for is not retried', async () => {
    let calls = 0;
    const { rendered, state } = mountHook(async () => {
      calls += 1;
      throw new DaemonResponseError(415, 'unsupported image type', 'attachment_unsupported_mime');
    });
    run(() => state().add([photo(1)]));
    await settleUntil(() => state().entries[0]?.status === 'failed', 'the refusal', runAsync);
    expect(calls).toBe(1);
    expect(state().entries[0]?.error).toBe("That file type isn't supported");
    run(() => rendered.unmount());
  });

  test('a file removed while it waits to retry is never uploaded again', async () => {
    let calls = 0;
    let removeNow: (() => void) | undefined;
    const { rendered, state } = mountHook(
      async () => {
        calls += 1;
        throw new Error('the relay socket closed');
      },
      async () => removeNow?.(),
    );
    run(() => state().add([photo(1)]));
    removeNow = () => {
      const entry = state().entries[0];
      if (entry !== undefined) state().remove(entry);
    };
    await settleUntil(() => state().entries.length === 0, 'the removal', runAsync);
    await runAsync(async () => await new Promise(resolve => setTimeout(resolve, 0)));
    expect(calls).toBe(1);
    run(() => rendered.unmount());
  });
});
