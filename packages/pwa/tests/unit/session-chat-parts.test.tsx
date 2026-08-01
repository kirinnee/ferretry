import { describe, expect, test } from 'bun:test';
import type { PendingAttachment } from '../../src/components/session-chat-model.ts';
import { PendingAttachmentStrip, PendingMessage, ThreadSkeleton } from '../../src/components/session-chat-parts.tsx';
import type { StoredTranscriptImage } from '../../src/lib/attachments.ts';
import { interact, mount, must } from '../support/dom.ts';

const file = (name: string, type: string, size = 472_000): File => ({ name, type, size }) as unknown as File;

const entry = (overrides: Partial<PendingAttachment> = {}): PendingAttachment => ({
  localId: 'l-1',
  file: file('shot.png', 'image/png'),
  status: 'ready',
  ...overrides,
});

const byLabel = (container: HTMLElement, label: string): HTMLButtonElement =>
  must(
    [...container.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === label),
    `a button labelled ${label}`,
  );

const click = (button: HTMLButtonElement) =>
  interact(() => button.dispatchEvent(new Event('click', { bubbles: true })));

describe('PendingAttachmentStrip', () => {
  const render = (entries: readonly PendingAttachment[], overrides: Record<string, unknown> = {}) =>
    mount(
      <PendingAttachmentStrip entries={entries} onRemove={() => undefined} onRetry={() => undefined} {...overrides} />,
    );

  test('is a real labelled list, one item per attachment', async () => {
    const screen = await render([entry(), entry({ localId: 'l-2', file: file('notes.pdf', 'application/pdf') })]);
    const list = must(screen.container.querySelector('ul'), 'the strip');
    expect(list.getAttribute('aria-label')).toBe('Attached files');
    expect(list.querySelectorAll('li').length).toBe(2);
    await screen.unmount();
  });

  test('reads size and state together on one row for a ready file', async () => {
    const screen = await render([entry()]);
    const chip = must(screen.container.querySelector('li'), 'the chip');
    expect(chip.getAttribute('role')).toBe('status');
    expect(chip.textContent).toContain('shot.png');
    expect(chip.textContent).toContain('ready');
    expect(chip.textContent).toContain('KB');
    await screen.unmount();
  });

  test('says uploading while the bytes are still going up', async () => {
    const screen = await render([entry({ status: 'uploading' })]);
    expect(must(screen.container.querySelector('li'), 'the chip').textContent).toContain('uploading');
    await screen.unmount();
  });

  test('a failure is an alert, drops the size, and offers a retry', async () => {
    const retried: string[] = [];
    const screen = await render([entry({ status: 'failed', error: 'the daemon rejected this file' })], {
      onRetry: (target: PendingAttachment) => retried.push(target.localId),
    });
    const chip = must(screen.container.querySelector('li'), 'the chip');
    expect(chip.getAttribute('role')).toBe('alert');
    expect(chip.className).toContain('border-err-border');
    expect(chip.textContent).toContain('the daemon rejected this file');
    expect(chip.textContent).not.toContain('KB');
    await click(byLabel(screen.container, 'Retry shot.png'));
    expect(retried).toEqual(['l-1']);
    await screen.unmount();
  });

  test('always offers a removal', async () => {
    const removed: string[] = [];
    const screen = await render([entry()], { onRemove: (target: PendingAttachment) => removed.push(target.localId) });
    await click(byLabel(screen.container, 'Remove shot.png'));
    expect(removed).toEqual(['l-1']);
    await screen.unmount();
  });

  test('shows a thumbnail when there is one, and the right glyph when there is not', async () => {
    const withPreview = await render([entry({ objectUrl: 'blob:preview' })]);
    expect(must(withPreview.container.querySelector('img'), 'the preview').getAttribute('src')).toBe('blob:preview');
    await withPreview.unmount();

    const document_ = await render([entry({ file: file('notes.pdf', 'application/pdf') })]);
    expect(document_.container.querySelector('img')).toBeNull();
    // A non-image also names its type, which an image never needs to.
    expect(document_.container.textContent).toContain('PDF');
    await document_.unmount();
  });

  test('reports what was extracted for the agent, and that it was cut short', async () => {
    const screen = await render([
      entry({ view: { mime: 'application/pdf', textExtraction: { truncated: true } } as PendingAttachment['view'] }),
    ]);
    expect(screen.container.textContent).toContain('text extracted for agent · truncated');
    await screen.unmount();
  });

  test('warns when extraction failed without pretending the file is unusable', async () => {
    const screen = await render([
      entry({
        view: {
          mime: 'application/pdf',
          textExtractionFailure: { code: 'unsupported_type' },
        } as PendingAttachment['view'],
      }),
    ]);
    expect(must(screen.container.querySelector('li'), 'the chip').textContent).not.toBe('');
    expect(screen.container.querySelector('.text-warn')).not.toBeNull();
    await screen.unmount();
  });

  test('a locked file gets an unlock action, never the terminal failure copy', async () => {
    const unlocked: string[] = [];
    const screen = await render(
      [
        entry({
          view: { mime: 'application/pdf', encrypted: { kind: 'pdf', locked: true } } as PendingAttachment['view'],
        }),
      ],
      { onUnlock: (target: PendingAttachment) => unlocked.push(target.localId) },
    );
    await click(byLabel(screen.container, 'Unlock shot.png'));
    expect(unlocked).toEqual(['l-1']);
    await screen.unmount();
  });

  test('an unlocked file can have its decrypted copy forgotten', async () => {
    const forgotten: string[] = [];
    const screen = await render(
      [
        entry({
          view: { mime: 'application/pdf', encrypted: { kind: 'pdf', locked: false } } as PendingAttachment['view'],
        }),
      ],
      { onForget: (target: PendingAttachment) => forgotten.push(target.localId) },
    );
    await click(byLabel(screen.container, 'Forget the decrypted copy of shot.png'));
    expect(forgotten).toEqual(['l-1']);
    await screen.unmount();
  });

  test('renders without an unlock or forget flow wired at all', async () => {
    const screen = await render([
      entry({
        view: { mime: 'application/pdf', encrypted: { kind: 'pdf', locked: true } } as PendingAttachment['view'],
      }),
      entry({
        localId: 'l-2',
        view: { mime: 'application/pdf', encrypted: { kind: 'pdf', locked: false } } as PendingAttachment['view'],
      }),
    ]);
    expect(screen.container.querySelectorAll('li').length).toBe(2);
    await screen.unmount();
  });
});

describe('PendingMessage', () => {
  const images: readonly StoredTranscriptImage[] = [];

  test('shows the message the instant it is sent, with a spinner', async () => {
    const screen = await mount(<PendingMessage attachments={images} status="sending" text="ship it" />);
    expect(screen.container.textContent).toContain('You said:');
    expect(screen.container.textContent).toContain('ship it');
    expect(screen.container.textContent).toContain('sending');
    await screen.unmount();
  });

  test('never claims a delivery the daemon cannot see', async () => {
    const screen = await mount(<PendingMessage attachments={images} status="delivered" text="ship it" />);
    expect(screen.container.textContent).toContain('accepted — awaiting confirmation');
    expect(screen.container.textContent).not.toContain('delivered');
    await screen.unmount();
  });

  test('names the harness’s own input queue as such', async () => {
    const screen = await mount(<PendingMessage attachments={images} status="queued" text="ship it" />);
    expect(screen.container.textContent).toContain('queued for next turn');
    await screen.unmount();
  });

  test('offers retry and dismiss only on a failure', async () => {
    const clean = await mount(<PendingMessage attachments={images} status="sending" text="ship it" />);
    expect(clean.container.textContent).not.toContain('retry');
    await clean.unmount();

    const retried: string[] = [];
    const dismissed: string[] = [];
    const failed = await mount(
      <PendingMessage
        attachments={images}
        onDismiss={() => dismissed.push('dismissed')}
        onRetry={() => retried.push('retried')}
        status="error"
        text="ship it"
      />,
    );
    const buttons = [...failed.container.querySelectorAll('button')];
    await click(
      must(
        buttons.find(button => button.textContent === 'retry'),
        'the retry button',
      ),
    );
    await click(
      must(
        buttons.find(button => button.textContent === 'dismiss'),
        'the dismiss button',
      ),
    );
    expect(retried).toEqual(['retried']);
    expect(dismissed).toEqual(['dismissed']);
    await failed.unmount();
  });

  test('draws no copy block for an attachment-only send, and defers the images to its host', async () => {
    const seen: number[] = [];
    const screen = await mount(
      <PendingMessage
        attachments={images}
        renderAttachments={attached => {
          seen.push(attached.length);
          return <span data-gallery="yes" />;
        }}
        status="sending"
        text=""
      />,
    );
    expect(screen.container.querySelector('.kt-user-copy')).toBeNull();
    expect(screen.container.querySelector('[data-gallery="yes"]')).not.toBeNull();
    expect(seen).toEqual([0]);
    await screen.unmount();
  });
});

describe('ThreadSkeleton', () => {
  test('says the conversation is loading rather than looking empty', async () => {
    const screen = await mount(<ThreadSkeleton />);
    const skeleton = must(screen.container.querySelector('[role="status"]'), 'the skeleton');
    expect(skeleton.getAttribute('aria-busy')).toBe('true');
    expect(skeleton.getAttribute('aria-label')).toBe('Loading the conversation');
    expect(skeleton.querySelectorAll('.animate-pulse').length).toBe(6);
    await screen.unmount();
  });
});
