import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AttachmentView } from '@ferretry/protocol';
import { Composer, type ComposerProps } from '../../src/components/composer.tsx';
import { ComposerAddMenu } from '../../src/components/composer-add-menu.tsx';
import type { ComposerAttachmentUploader } from '../../src/components/composer-attachments.ts';
import { PendingAttachmentStrip } from '../../src/components/session-chat-parts.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonDraftStore, type DraftStorage } from '../../src/lib/drafts.ts';
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

  test('the status line carries the host’s runtime chips and the context reading', () => {
    const { composer } = mountComposer({
      upload: async file => view('a', file),
      contextPercent: 30.6,
      statusSlot: <span data-runtime-chips="">opus</span>,
    });
    const status = composer.root.findByProps({ 'data-composer-status': '' });
    expect(status.findByProps({ 'data-runtime-chips': '' }).children).toEqual(['opus']);
    expect(status.findByProps({ className: 'fy-composer-context' }).children.join('')).toBe('ctx 31%');
    run(() => composer.unmount());
  });
});
