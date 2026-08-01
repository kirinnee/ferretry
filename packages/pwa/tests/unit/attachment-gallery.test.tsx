import { describe, expect, it } from 'bun:test';
import {
  AttachmentGalleryProvider,
  isImageAttachment,
  TranscriptAttachmentGallery,
} from '../../src/components/attachment-gallery.tsx';
import type { AttachmentBlobUrlPort } from '../../src/lib/attachment-blob-cache.ts';
import type { StoredTranscriptAttachment, TranscriptImage } from '../../src/lib/attachments.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { interact, mount, must, pressKey } from '../support/dom.ts';

const daemon = daemonConnection({
  daemonId: 'gallery-daemon',
  baseUrl: 'https://gallery.example.test',
  deviceToken: 'gallery-token',
});

const attachment = (overrides: Partial<StoredTranscriptAttachment> = {}): StoredTranscriptAttachment => ({
  kind: 'attachment',
  sessionId: 'gallery-session',
  attachmentId: 'att-1',
  filename: 'diagram.png',
  mime: 'image/png',
  size: 2_048,
  ...overrides,
});

/** Object URLs a test can count, so nothing depends on the DOM's own allocator. */
const countingUrls = (): AttachmentBlobUrlPort & { created: string[]; revoked: string[] } => {
  const created: string[] = [];
  const revoked: string[] = [];
  let next = 0;
  return {
    created,
    revoked,
    create: () => {
      next += 1;
      const url = `blob:gallery/${next}`;
      created.push(url);
      return url;
    },
    revoke: url => {
      revoked.push(url);
    },
  };
};

/**
 * An IntersectionObserver that reports the element as visible the instant it
 * is observed. happy-dom has no layout, so the real one never intersects and
 * every lazy attachment would sit at "loading" forever.
 */
const withVisibleObserver = (): (() => void) => {
  const original = globalThis.IntersectionObserver;
  class Immediate {
    readonly #notify: (entries: readonly { isIntersecting: boolean }[]) => void;
    constructor(notify: (entries: readonly { isIntersecting: boolean }[]) => void) {
      this.#notify = notify;
    }
    observe(): void {
      this.#notify([{ isIntersecting: true }]);
    }
    disconnect(): void {}
  }
  globalThis.IntersectionObserver = Immediate as unknown as typeof IntersectionObserver;
  return () => {
    globalThis.IntersectionObserver = original;
  };
};

/** An observer that never intersects, so the pre-load surfaces stay on screen. */
const withBlindObserver = (): (() => void) => {
  const original = globalThis.IntersectionObserver;
  class Blind {
    observe(): void {}
    disconnect(): void {}
  }
  globalThis.IntersectionObserver = Blind as unknown as typeof IntersectionObserver;
  return () => {
    globalThis.IntersectionObserver = original;
  };
};

const byLabel = (container: HTMLElement, label: string): HTMLElement =>
  must(container.querySelector<HTMLElement>(`[aria-label="${label}"]`), `an element labelled ${label}`);

describe('image attachment detection', () => {
  it('accepts an inline image, a declared image mime, and an image-looking name', () => {
    expect(isImageAttachment({ kind: 'inline', src: 'data:image/png;base64,AA', alt: 'chart' })).toBe(true);
    expect(isImageAttachment(attachment({ mime: 'image/webp' }))).toBe(true);
    expect(isImageAttachment(attachment({ mime: undefined, filename: 'shot.JPEG' }))).toBe(true);
  });

  it('rejects a document, including one whose name only looks like a document', () => {
    expect(isImageAttachment(attachment({ mime: 'application/pdf', filename: 'spec.pdf' }))).toBe(false);
    expect(isImageAttachment(attachment({ mime: undefined, filename: 'notes.txt' }))).toBe(false);
  });
});

describe('the attachment gallery', () => {
  it('renders nothing at all when there is nothing attached', async () => {
    const view = await mount(<TranscriptAttachmentGallery daemon={daemon} images={[]} />);
    expect(view.container.textContent).toBe('');
    await view.unmount();
  });

  it('holds back past the initial limit and counts the remainder', async () => {
    const restore = withBlindObserver();
    const images: TranscriptImage[] = [
      attachment({ attachmentId: 'a', filename: 'one.pdf', mime: 'application/pdf' }),
      attachment({ attachmentId: 'b', filename: 'two.pdf', mime: 'application/pdf' }),
      attachment({ attachmentId: 'c', filename: 'three.pdf', mime: 'application/pdf' }),
    ];
    try {
      const view = await mount(
        <TranscriptAttachmentGallery daemon={daemon} images={images} initialLimit={1} className="mt-2" />,
      );
      expect(view.container.textContent).toContain('one.pdf');
      expect(view.container.textContent).not.toContain('two.pdf');
      expect(view.container.textContent).toContain('Show 2 more attachments');
      await interact(() => {
        must(
          [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(button =>
            button.textContent?.startsWith('Show'),
          ),
          'the show-more button',
        ).click();
      });
      expect(view.container.textContent).toContain('three.pdf');
      expect(view.container.textContent).not.toContain('Show 2 more');
      await view.unmount();
    } finally {
      restore();
    }
  });

  it('says "attachment" in the singular when exactly one is held back', async () => {
    const restore = withBlindObserver();
    try {
      const view = await mount(
        <TranscriptAttachmentGallery
          daemon={daemon}
          images={[
            attachment({ attachmentId: 'a', filename: 'one.pdf', mime: 'application/pdf' }),
            attachment({ attachmentId: 'b', filename: 'two.pdf', mime: 'application/pdf' }),
          ]}
          initialLimit={1}
        />,
      );
      expect(view.container.textContent).toContain('Show 1 more attachment');
      expect(view.container.textContent).not.toContain('attachments');
      await view.unmount();
    } finally {
      restore();
    }
  });

  it('keeps repeated attachments distinct without keying on array position', async () => {
    const restore = withBlindObserver();
    try {
      const repeated = attachment({ mime: 'application/pdf', filename: 'same.pdf' });
      const inline: TranscriptImage = { kind: 'inline', src: 'data:image/png;base64,AA', alt: 'chart' };
      const view = await mount(
        <TranscriptAttachmentGallery daemon={daemon} images={[repeated, repeated, inline, inline]} />,
      );
      expect(view.container.querySelectorAll('img')).toHaveLength(2);
      expect(view.container.textContent?.match(/same\.pdf/g)).toHaveLength(2);
      await view.unmount();
    } finally {
      restore();
    }
  });
});

describe('the document card', () => {
  it('waits for the bytes before offering Open and Download', async () => {
    const restore = withBlindObserver();
    try {
      const view = await mount(
        <TranscriptAttachmentGallery
          daemon={daemon}
          images={[attachment({ mime: 'application/pdf', filename: 'spec.pdf', size: 4_096 })]}
        />,
      );
      expect(view.container.textContent).toContain('loading file…');
      expect(view.container.textContent).toContain('PDF document · application/pdf · 4.0 KB');
      expect(byLabel(view.container, 'Open spec.pdf').tagName).toBe('BUTTON');
      expect(byLabel(view.container, 'Download spec.pdf').tagName).toBe('BUTTON');
      await view.unmount();
    } finally {
      restore();
    }
  });

  it('turns both controls into real links once the daemon answers', async () => {
    const restore = withVisibleObserver();
    const urls = countingUrls();
    try {
      const view = await mount(
        <AttachmentGalleryProvider urls={urls} load={async () => new Blob(['%PDF'], { type: 'application/pdf' })}>
          <TranscriptAttachmentGallery
            daemon={daemon}
            images={[
              attachment({
                mime: 'application/pdf',
                filename: 'spec.pdf',
                textExtraction: { method: 'pdfjs', characters: 120, truncated: true },
              }),
            ]}
          />
        </AttachmentGalleryProvider>,
      );
      const open = byLabel(view.container, 'Open spec.pdf');
      expect(open.tagName).toBe('A');
      expect(open.getAttribute('href')).toBe('blob:gallery/1');
      expect(byLabel(view.container, 'Download spec.pdf').getAttribute('download')).toBe('spec.pdf');
      expect(view.container.textContent).toContain('text extracted for agent · truncated');
      expect(view.container.textContent).not.toContain('loading file…');
      await view.unmount();
      // The provider owns the cache, so unmount revokes what it created.
      expect(urls.revoked).toEqual(['blob:gallery/1']);
    } finally {
      restore();
    }
  });

  it('reports a failed read, an extraction failure, and offers no Open for an unopenable type', async () => {
    const restore = withVisibleObserver();
    try {
      const view = await mount(
        <AttachmentGalleryProvider
          urls={countingUrls()}
          load={async () => {
            throw new Error('attachment expired');
          }}
        >
          <TranscriptAttachmentGallery
            daemon={daemon}
            images={[
              attachment({
                mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                filename: 'brief.docx',
                size: undefined,
                textExtractionFailure: {
                  code: 'password_protected_document',
                  message: 'the document is password protected',
                },
              }),
            ]}
          />
        </AttachmentGalleryProvider>,
      );
      expect(view.container.textContent).toContain('file could not be opened');
      expect(view.container.querySelector('[aria-label="Open brief.docx"]')).toBeNull();
      expect(view.container.querySelector('[aria-label="Download brief.docx"]')).toBeNull();
      await view.unmount();
    } finally {
      restore();
    }
  });

  it('states the extraction note without a truncation suffix when nothing was cut', async () => {
    const restore = withBlindObserver();
    try {
      const view = await mount(
        <TranscriptAttachmentGallery
          daemon={daemon}
          images={[
            attachment({
              mime: 'application/pdf',
              filename: 'spec.pdf',
              textExtraction: { method: 'pdfjs', characters: 12, truncated: false },
            }),
          ]}
        />,
      );
      expect(view.container.textContent).toContain('text extracted for agent');
      expect(view.container.textContent).not.toContain('· truncated');
      await view.unmount();
    } finally {
      restore();
    }
  });
});

describe('the image thumbnail', () => {
  it('shows an inline image immediately and expands it into a modal dialog', async () => {
    const view = await mount(
      <TranscriptAttachmentGallery
        daemon={daemon}
        images={[{ kind: 'inline', src: 'data:image/png;base64,AA', alt: 'a rendered chart' }]}
      />,
    );
    try {
      await interact(() => {
        byLabel(view.container, 'Expand a rendered chart').click();
      });
      const dialog = must(view.container.querySelector('dialog'), 'the expanded dialog');
      expect(dialog.getAttribute('aria-label')).toBe('Expanded image: a rendered chart');
      expect((dialog as HTMLDialogElement).open).toBe(true);
      // Tab is trapped inside the dialog rather than escaping to the page.
      pressKey(dialog, 'Tab');
      await interact(() => {
        byLabel(view.container, 'Close expanded image').click();
      });
      expect(view.container.querySelector('dialog')).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('closes on a backdrop click, on Escape and on the dialog’s own close event', async () => {
    const view = await mount(
      <TranscriptAttachmentGallery
        daemon={daemon}
        images={[{ kind: 'inline', src: 'data:image/png;base64,AA', alt: 'chart' }]}
      />,
    );
    try {
      const expand = (): Promise<void> =>
        interact(() => {
          byLabel(view.container, 'Expand chart').click();
        });
      const dialog = (): HTMLDialogElement =>
        must(view.container.querySelector<HTMLDialogElement>('dialog'), 'the expanded dialog');

      await expand();
      await interact(() => {
        dialog().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(view.container.querySelector('dialog')).toBeNull();

      await expand();
      await interact(() => {
        pressKey(document, 'Escape');
      });
      expect(view.container.querySelector('dialog')).toBeNull();

      await expand();
      await interact(() => {
        dialog().dispatchEvent(new Event('cancel', { bubbles: true, cancelable: true }));
      });
      expect(view.container.querySelector('dialog')).toBeNull();

      await expand();
      await interact(() => {
        dialog().dispatchEvent(new Event('close', { bubbles: true }));
      });
      expect(view.container.querySelector('dialog')).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('loads a stored image lazily and paints it once the bytes arrive', async () => {
    const restore = withVisibleObserver();
    const urls = countingUrls();
    const asked: string[] = [];
    try {
      const view = await mount(
        <AttachmentGalleryProvider
          urls={urls}
          load={async (connection, scope) => {
            asked.push(`${connection.daemonId}/${scope.sessionId}/${scope.attachmentId}`);
            return new Blob(['png'], { type: 'image/png' });
          }}
        >
          <TranscriptAttachmentGallery daemon={daemon} images={[attachment({ alt: 'a wiring diagram' })]} />
        </AttachmentGalleryProvider>,
      );
      expect(asked).toEqual(['gallery-daemon/gallery-session/att-1']);
      const image = must(view.container.querySelector('img'), 'the thumbnail image');
      expect(image.getAttribute('src')).toBe('blob:gallery/1');
      expect(image.getAttribute('alt')).toBe('a wiring diagram');
      await view.unmount();
    } finally {
      restore();
    }
  });

  it('shows the placeholder while the read is still in flight', async () => {
    const restore = withVisibleObserver();
    try {
      const view = await mount(
        <AttachmentGalleryProvider urls={countingUrls()} load={() => new Promise<Blob>(() => undefined)}>
          <TranscriptAttachmentGallery daemon={daemon} images={[attachment()]} />
        </AttachmentGalleryProvider>,
      );
      expect(byLabel(view.container, 'Loading diagram.png').getAttribute('role')).toBe('status');
      await view.unmount();
    } finally {
      restore();
    }
  });

  it('refuses bytes the daemon did not send as an image, and says so with the size', async () => {
    const restore = withVisibleObserver();
    try {
      const view = await mount(
        <AttachmentGalleryProvider urls={countingUrls()} load={async () => new Blob(['<html>'], { type: 'text/html' })}>
          <TranscriptAttachmentGallery daemon={daemon} images={[attachment()]} />
        </AttachmentGalleryProvider>,
      );
      expect(view.container.textContent).toContain('no longer available');
      expect(view.container.textContent).toContain('diagram.png');
      expect(view.container.textContent).toContain('2.0 KB');
      await view.unmount();
    } finally {
      restore();
    }
  });

  it('falls back to the broken-image card when the painted image itself errors', async () => {
    const view = await mount(
      <TranscriptAttachmentGallery
        daemon={daemon}
        images={[{ kind: 'inline', src: 'data:image/png;base64,AA', alt: 'chart' }]}
      />,
    );
    try {
      await interact(() => {
        must(view.container.querySelector('img'), 'the thumbnail image').dispatchEvent(new Event('error'));
      });
      expect(view.container.textContent).toContain('no longer available');
    } finally {
      await view.unmount();
    }
  });

  it('loads eagerly in a DOM that has no IntersectionObserver at all', async () => {
    const original = globalThis.IntersectionObserver;
    // biome-ignore lint/performance/noDelete: restoring the global requires removing it first.
    delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
    try {
      const view = await mount(
        <AttachmentGalleryProvider urls={countingUrls()} load={async () => new Blob(['x'], { type: 'image/png' })}>
          <TranscriptAttachmentGallery daemon={daemon} images={[attachment()]} />
        </AttachmentGalleryProvider>,
      );
      expect(view.container.querySelector('img')).not.toBeNull();
      await view.unmount();
    } finally {
      globalThis.IntersectionObserver = original;
    }
  });

  it('gives an attachment outside a provider its own cache, and revokes it on unmount', async () => {
    const restore = withVisibleObserver();
    const original = URL.createObjectURL;
    const revoke = URL.revokeObjectURL;
    const created: string[] = [];
    const revoked: string[] = [];
    URL.createObjectURL = (() => {
      const url = `blob:standalone/${created.length + 1}`;
      created.push(url);
      return url;
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = ((url: string) => {
      revoked.push(url);
    }) as typeof URL.revokeObjectURL;
    const fetched = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('png', { headers: { 'content-type': 'image/png' } })) as unknown as typeof fetch;
    try {
      const view = await mount(<TranscriptAttachmentGallery daemon={daemon} images={[attachment()]} />);
      expect(created).toEqual(['blob:standalone/1']);
      expect(must(view.container.querySelector('img'), 'the thumbnail').getAttribute('src')).toBe('blob:standalone/1');
      await view.unmount();
      expect(revoked).toEqual(['blob:standalone/1']);
    } finally {
      globalThis.fetch = fetched;
      URL.createObjectURL = original;
      URL.revokeObjectURL = revoke;
      restore();
    }
  });
});
