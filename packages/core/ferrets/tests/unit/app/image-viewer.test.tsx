import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { AttachmentView } from '@ferretry/protocol';
import { useState } from 'react';
import { AttachmentGalleryProvider, TranscriptAttachmentGallery } from '../../src/components/attachment-gallery.tsx';
import { Composer } from '../../src/components/composer.tsx';
import { ImageViewer, type ViewerImage } from '../../src/components/image-viewer.tsx';
import type { PendingAttachment } from '../../src/components/session-chat-model.ts';
import { PendingAttachmentStrip } from '../../src/components/session-chat-parts.tsx';
import type { AttachmentBlobUrlPort } from '../../src/lib/attachment-blob-cache.ts';
import { loadAttachmentBlob } from '../../src/lib/attachment-source.ts';
import { bytesToBase64 } from '../../src/lib/attachment-upload.ts';
import type { StoredTranscriptAttachment } from '../../src/lib/attachments.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonDraftStore, type DraftStorage } from '../../src/lib/drafts.ts';
import { writeMdComposePref } from '../../src/lib/md-compose.ts';
import { relayResponse } from '../../src/lib/relay-carrier.ts';
import { interact, type Mounted, mount, must, pressKey } from '../support/dom.ts';

const daemon = daemonConnection({ daemonId: 'viewer', baseUrl: 'https://viewer.example.test', deviceId: 'device' });

const pictures = (count: number): ViewerImage[] =>
  Array.from({ length: count }, (_, at) => ({
    key: `k${at}`,
    src: `blob:viewer/${at}`,
    failed: false,
    alt: `picture ${at + 1}`,
    filename: `picture-${at + 1}.png`,
    meta: '2 KB',
  }));

function Harness({
  images,
  start = 0,
  onClose,
}: {
  images: readonly ViewerImage[];
  start?: number;
  onClose?: () => void;
}) {
  const [index, setIndex] = useState(start);
  const [open, setOpen] = useState(true);
  if (!open) return <p data-testid="closed">closed</p>;
  return (
    <ImageViewer
      images={images}
      index={index}
      onClose={() => {
        setOpen(false);
        onClose?.();
      }}
      onIndexChange={setIndex}
    />
  );
}

const label = (root: ParentNode, text: string): HTMLElement =>
  must(root.querySelector<HTMLElement>(`[aria-label="${text}"]`), `an element labelled ${text}`);
const dialog = (): HTMLDialogElement =>
  must(document.querySelector<HTMLDialogElement>('[data-testid="image-viewer"]'), 'the viewer');
const shownSrc = (): string | null => dialog().querySelector('img')?.getAttribute('src') ?? null;

describe('the image viewer', () => {
  it('is a modal dialog that names the picture, its place in the set, and offers download and open', async () => {
    const view = await mount(<Harness images={pictures(3)} />);
    expect(dialog().open).toBe(true);
    expect(dialog().getAttribute('aria-label')).toBe('Image viewer: picture 1');
    expect(dialog().textContent).toContain('picture-1.png');
    expect(dialog().textContent).toContain('1 of 3 · 2 KB');
    const download = label(dialog(), 'Download picture-1.png') as HTMLAnchorElement;
    expect(download.getAttribute('href')).toBe('blob:viewer/0');
    expect(download.getAttribute('download')).toBe('picture-1.png');
    expect(label(dialog(), 'Open picture-1.png in a new tab').getAttribute('href')).toBe('blob:viewer/0');
    await view.unmount();
  });

  it('moves between a message’s pictures with the buttons and the arrow keys, and stops at both ends', async () => {
    const view = await mount(<Harness images={pictures(3)} />);
    expect((label(dialog(), 'Previous image') as HTMLButtonElement).disabled).toBe(true);
    await interact(() => label(dialog(), 'Next image').click());
    expect(shownSrc()).toBe('blob:viewer/1');
    expect(dialog().textContent).toContain('2 of 3');
    await interact(() => pressKey(dialog(), 'ArrowRight'));
    expect(shownSrc()).toBe('blob:viewer/2');
    expect((label(dialog(), 'Next image') as HTMLButtonElement).disabled).toBe(true);
    await interact(() => pressKey(dialog(), 'ArrowRight'));
    expect(shownSrc()).toBe('blob:viewer/2');
    await interact(() => pressKey(dialog(), 'ArrowLeft'));
    await interact(() => label(dialog(), 'Previous image').click());
    expect(shownSrc()).toBe('blob:viewer/0');
    await view.unmount();
  });

  it('starts on the picture it was asked to, and a lone picture has no counter or arrows', async () => {
    const many = await mount(<Harness images={pictures(3)} start={2} />);
    expect(shownSrc()).toBe('blob:viewer/2');
    await many.unmount();
    const one = await mount(<Harness images={pictures(1)} />);
    expect(dialog().querySelector('[aria-label="Next image"]')).toBeNull();
    expect(dialog().textContent).not.toContain('1 of 1');
    await one.unmount();
  });

  it('closes from the button, from Escape, and from the dialog’s own cancel', async () => {
    let closed = 0;
    const first = await mount(<Harness images={pictures(2)} onClose={() => (closed += 1)} />);
    await interact(() => label(dialog(), 'Close image viewer').click());
    expect(closed).toBe(1);
    expect(first.container.querySelector('[data-testid="closed"]')).not.toBeNull();
    await first.unmount();

    const second = await mount(<Harness images={pictures(2)} onClose={() => (closed += 1)} />);
    await interact(() => pressKey(dialog(), 'Escape'));
    expect(closed).toBe(2);
    await second.unmount();

    const third = await mount(<Harness images={pictures(2)} onClose={() => (closed += 1)} />);
    await interact(() => {
      dialog().dispatchEvent(new Event('cancel', { cancelable: true }));
    });
    expect(closed).toBe(3);
    await third.unmount();
  });

  it('zooms with the wheel and with + / -, and 0 fits again', async () => {
    const view = await mount(<Harness images={pictures(1)} />);
    const transform = (): string => must(dialog().querySelector('img'), 'the picture').style.transform;
    expect(transform()).toContain('scale(1)');
    await interact(() => pressKey(dialog(), '+'));
    expect(transform()).not.toContain('scale(1)');
    await interact(() => pressKey(dialog(), '0'));
    expect(transform()).toContain('scale(1)');
    const stage = must(dialog().querySelector('[data-testid="image-viewer-stage"]'), 'the stage');
    await interact(() => {
      stage.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true, cancelable: true }));
    });
    expect(transform()).not.toContain('scale(1)');
    await interact(() => pressKey(dialog(), '0'));
    await view.unmount();
  });

  it('draws a picture still arriving and a failed one instead of an empty box', async () => {
    const images: ViewerImage[] = [
      { key: 'a', src: null, failed: false, alt: 'late', filename: 'late.png' },
      { key: 'b', src: null, failed: true, alt: 'gone', filename: 'gone.png' },
    ];
    const view = await mount(<Harness images={images} />);
    expect(dialog().textContent).toContain('Loading image');
    expect(dialog().querySelector('a[download]')).toBeNull();
    await interact(() => label(dialog(), 'Next image').click());
    expect(dialog().textContent).toContain('This image is no longer available');
    await view.unmount();
  });
});

/** A 400x300 stage showing an 800x600 picture, so zoomed views have room to pan. */
const withStage = async (images: readonly ViewerImage[], run: (view: Mounted) => Promise<void>): Promise<void> => {
  const proto = HTMLElement.prototype;
  const originals = (['clientWidth', 'clientHeight'] as const).map(
    name => [name, Object.getOwnPropertyDescriptor(proto, name)] as const,
  );
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => 400 });
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => 300 });
  const view = await mount(<Harness images={images} />);
  try {
    const picture = must(dialog().querySelector('img'), 'the picture');
    Object.defineProperty(picture, 'naturalWidth', { configurable: true, value: 800 });
    Object.defineProperty(picture, 'naturalHeight', { configurable: true, value: 600 });
    await interact(() => {
      picture.dispatchEvent(new Event('load'));
    });
    await run(view);
  } finally {
    await view.unmount();
    for (const [name, original] of originals) {
      if (original) Object.defineProperty(proto, name, original);
      else Reflect.deleteProperty(proto, name);
    }
  }
};

const stage = (): HTMLElement =>
  must(dialog().querySelector<HTMLElement>('[data-testid="image-viewer-stage"]'), 'stage');
const transform = (): string => must(dialog().querySelector('img'), 'the picture').style.transform;
const pointer = (type: string, at: { id?: number; x: number; y: number; kind?: string; button?: number }): void => {
  stage().dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: at.id ?? 1,
      pointerType: at.kind ?? 'touch',
      button: at.button ?? 0,
      clientX: at.x,
      clientY: at.y,
    }),
  );
};
const tap = async (x: number, y: number): Promise<void> => {
  await interact(() => pointer('pointerdown', { x, y }));
  await interact(() => pointer('pointerup', { x, y }));
};

describe('the image viewer’s gestures', () => {
  it('double-taps to zoom in and double-taps again to fit; a lone tap and a drag-off do neither', async () => {
    await withStage(pictures(1), async () => {
      expect(transform()).toContain('scale(1)');
      await tap(200, 150);
      expect(transform()).toContain('scale(1)');
      await tap(200, 150);
      expect(transform()).not.toContain('scale(1)');
      await tap(200, 150);
      await tap(200, 150);
      expect(transform()).toContain('scale(1)');

      // A press that wandered is a drag, so the tap after it does not complete a double tap.
      await interact(() => pointer('pointerdown', { x: 200, y: 150 }));
      await interact(() => pointer('pointermove', { x: 214, y: 152 }));
      await interact(() => pointer('pointerup', { x: 214, y: 152 }));
      await tap(200, 150);
      expect(transform()).toContain('scale(1)');
    });
  });

  it('ignores a secondary mouse button and a move from a pointer it never saw', async () => {
    await withStage(pictures(1), async () => {
      await interact(() => pointer('pointerdown', { x: 200, y: 150, kind: 'mouse', button: 2 }));
      await interact(() => pointer('pointermove', { x: 220, y: 150, kind: 'mouse', button: 2 }));
      await interact(() => pointer('pointerup', { x: 220, y: 150, kind: 'mouse', button: 2 }));
      await tap(200, 150);
      await tap(200, 150);
      expect(transform()).not.toContain('scale(1)');
    });
  });

  it('swipes to the next picture and back, and a cancelled touch goes nowhere', async () => {
    await withStage(pictures(3), async () => {
      await interact(() => pointer('pointerdown', { x: 300, y: 150 }));
      await interact(() => pointer('pointermove', { x: 220, y: 152 }));
      await interact(() => pointer('pointerup', { x: 200, y: 152 }));
      expect(shownSrc()).toBe('blob:viewer/1');

      await interact(() => pointer('pointerdown', { x: 200, y: 150 }));
      await interact(() => pointer('pointercancel', { x: 320, y: 150 }));
      expect(shownSrc()).toBe('blob:viewer/1');

      await interact(() => pointer('pointerdown', { x: 100, y: 150 }));
      await interact(() => pointer('pointerup', { x: 260, y: 150 }));
      expect(shownSrc()).toBe('blob:viewer/0');
    });
  });

  it('pans a zoomed picture with a drag, and zooms back out with the - key', async () => {
    await withStage(pictures(2), async () => {
      await interact(() => pressKey(dialog(), '+'));
      await interact(() => pressKey(dialog(), '='));
      const zoomed = transform();
      expect(zoomed).not.toContain('scale(1)');
      await interact(() => pointer('pointerdown', { x: 200, y: 150 }));
      await interact(() => pointer('pointermove', { x: 240, y: 170 }));
      await interact(() => pointer('pointerup', { x: 240, y: 170 }));
      expect(transform()).not.toBe(zoomed);
      expect(shownSrc()).toBe('blob:viewer/0');

      await interact(() => pressKey(dialog(), '-'));
      await interact(() => pressKey(dialog(), '_'));
      await interact(() => pressKey(dialog(), '_'));
      expect(transform()).toContain('scale(1)');
    });
  });

  it('pinches two fingers apart to zoom in, and lifting them one by one ends the pinch', async () => {
    await withStage(pictures(1), async () => {
      await interact(() => pointer('pointerdown', { id: 1, x: 180, y: 150 }));
      await interact(() => pointer('pointerdown', { id: 2, x: 220, y: 150 }));
      await interact(() => pointer('pointermove', { id: 2, x: 320, y: 150 }));
      await interact(() => pointer('pointermove', { id: 1, x: 100, y: 150 }));
      expect(transform()).not.toContain('scale(1)');
      await interact(() => pointer('pointerup', { id: 2, x: 320, y: 150 }));
      await interact(() => pointer('pointerup', { id: 1, x: 100, y: 150 }));
      const pinched = transform();
      await interact(() => pointer('pointerdown', { id: 1, x: 200, y: 150 }));
      await interact(() => pointer('pointermove', { id: 1, x: 190, y: 150 }));
      await interact(() => pointer('pointerup', { id: 1, x: 190, y: 150 }));
      expect(transform()).not.toBe(pinched);
    });
  });
});

const entry = (overrides: Partial<PendingAttachment> = {}): PendingAttachment => ({
  localId: 'local-1',
  file: new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' }),
  status: 'ready',
  objectUrl: 'blob:chip/1',
  ...overrides,
});

describe('a composer chip', () => {
  it('opens the picture from the chip body, and the ✕ still removes without opening anything', async () => {
    const opened: string[] = [];
    const removed: string[] = [];
    const view = await mount(
      <PendingAttachmentStrip
        entries={[entry()]}
        onOpen={chip => opened.push(chip.localId)}
        onRemove={chip => removed.push(chip.localId)}
        onRetry={() => undefined}
      />,
    );
    const open = label(view.container, 'Open shot.png');
    expect(open.getAttribute('title')).toBe('View full screen');
    await interact(() => open.click());
    expect(opened).toEqual(['local-1']);
    await interact(() => label(view.container, 'Remove shot.png').click());
    expect(removed).toEqual(['local-1']);
    expect(opened).toEqual(['local-1']);
    await view.unmount();
  });

  it('stays a static chip when nothing can open it', async () => {
    const view = await mount(
      <PendingAttachmentStrip
        entries={[
          entry({ objectUrl: undefined, file: new File([new Uint8Array([1])], 'clip.m4a', { type: 'audio/x-m4a' }) }),
        ]}
        onOpen={() => undefined}
        onRemove={() => undefined}
        onRetry={() => undefined}
      />,
    );
    expect(view.container.querySelector('[aria-label="Open clip.m4a"]')).toBeNull();
    await interact(async () => undefined);
    await view.unmount();
    const bare = await mount(
      <PendingAttachmentStrip entries={[entry()]} onRemove={() => undefined} onRetry={() => undefined} />,
    );
    expect(bare.container.querySelector('[aria-label="Open shot.png"]')).toBeNull();
    await bare.unmount();
  });
});

class MemoryStorage implements DraftStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('the composer tray viewer', () => {
  beforeEach(() => writeMdComposePref('off'));
  afterEach(() => writeMdComposePref('on'));

  it('opens a chosen picture full screen from its chip, and closes back to the composer', async () => {
    const created = URL.createObjectURL;
    let minted = 0;
    URL.createObjectURL = (() => `blob:tray/${++minted}`) as typeof URL.createObjectURL;
    const revoked = URL.revokeObjectURL;
    URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
    try {
      const view = await mount(
        <Composer
          api={{ send: async () => ({}) as never }}
          daemon={daemon}
          draftStore={new DaemonDraftStore(new MemoryStorage())}
          sessionId="s1"
          uploadAttachment={async file =>
            ({
              id: 'att',
              filename: file.name,
              mime: file.type,
              size: file.size,
              sha256: 'a'.repeat(64),
              createdAt: '2026-10-22T00:00:00.000Z',
            }) satisfies AttachmentView
          }
        />,
      );
      const picker = must(
        [...view.container.querySelectorAll<HTMLInputElement>('input[type="file"]')].find(
          input => !input.hasAttribute('capture'),
        ),
        'the file input',
      );
      const file = new File([new Uint8Array([1, 2, 3])], 'chart.png', { type: 'image/png' });
      Object.defineProperty(picker, 'files', { value: [file], configurable: true });
      await interact(() => {
        picker.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await interact(async () => new Promise(resolve => setTimeout(resolve, 20)));
      await interact(() => label(view.container, 'Open chart.png').click());
      expect(dialog().getAttribute('aria-label')).toBe('Image viewer: chart.png');
      expect(shownSrc()).toBe('blob:tray/1');
      await interact(() => pressKey(dialog(), 'Escape'));
      expect(document.querySelector('[data-testid="image-viewer"]')).toBeNull();
      await view.unmount();
    } finally {
      URL.createObjectURL = created;
      URL.revokeObjectURL = revoked;
    }
  });
});

const stored = (id: string): StoredTranscriptAttachment => ({
  kind: 'attachment',
  sessionId: 'turn-session',
  attachmentId: id,
  filename: `${id}.png`,
  mime: 'image/png',
  size: 300,
});

const countingUrls = (): AttachmentBlobUrlPort & { created: string[] } => {
  const created: string[] = [];
  return {
    created,
    create: () => {
      const url = `blob:msg/${created.length + 1}`;
      created.push(url);
      return url;
    },
    revoke: () => undefined,
  };
};

const immediateObserver = (): (() => void) => {
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

/** The daemon's answer to a download, carried the way a relay or tunnel carries it: as TEXT. */
const tunnelled = (id: string, bytes: Uint8Array): string =>
  new TextDecoder().decode(
    new TextEncoder().encode(
      JSON.stringify({
        attachment: {
          id,
          filename: `${id}.png`,
          mime: 'image/png',
          size: bytes.byteLength,
          sha256: 'a'.repeat(64),
          createdAt: '2026-10-22T00:00:00.000Z',
        },
        base64: bytesToBase64(bytes),
      }),
    ),
  );

describe('images in a delivered message', () => {
  it('render and open in the viewer on a carrier that can only move text', async () => {
    const restore = immediateObserver();
    const urls = countingUrls();
    const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, ...Array.from({ length: 256 }, (_, i) => i)]);
    const blobs: Blob[] = [];
    const viaRelay = async (url: URL | RequestInfo): Promise<Response> => {
      const id = decodeURIComponent(String(url).split('/').pop() ?? '');
      return relayResponse({
        kind: 'response',
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: tunnelled(id, pngBytes),
      });
    };
    try {
      const view = await mount(
        <AttachmentGalleryProvider
          load={async (connection, scope) => {
            const blob = await loadAttachmentBlob(connection, scope, scope.attachmentId, undefined, viaRelay);
            blobs.push(blob);
            return blob;
          }}
          urls={urls}
        >
          <TranscriptAttachmentGallery daemon={daemon} images={[stored('one'), stored('two'), stored('three')]} />
        </AttachmentGalleryProvider>,
      );
      await interact(async () => new Promise(resolve => setTimeout(resolve, 20)));
      // Every thumbnail painted: a real image blob, not an `application/json` one that shows a grey box.
      expect(blobs.map(blob => blob.type)).toEqual(['image/png', 'image/png', 'image/png']);
      const thumbs = [...view.container.querySelectorAll('img')];
      expect(thumbs.map(img => img.getAttribute('src'))).toEqual(urls.created.slice(0, 3));
      expect(view.container.textContent).not.toContain('no longer available');

      await interact(() => label(view.container, 'Expand one.png').click());
      expect(dialog().getAttribute('aria-label')).toBe('Image viewer: one.png');
      expect(shownSrc()).toMatch(/^blob:msg\//u);
      expect(dialog().textContent).toContain('1 of 3');
      await interact(() => label(dialog(), 'Next image').click());
      expect(dialog().getAttribute('aria-label')).toBe('Image viewer: two.png');
      expect(dialog().textContent).toContain('2 of 3');
      await interact(() => pressKey(dialog(), 'Escape'));
      expect(document.querySelector('[data-testid="image-viewer"]')).toBeNull();
      await view.unmount();
    } finally {
      restore();
    }
  });

  it('open in the viewer as “no longer available” when the daemon cannot give the picture back', async () => {
    const restore = immediateObserver();
    try {
      const view = await mount(
        <AttachmentGalleryProvider
          load={async (_connection, scope) => {
            if (scope.attachmentId === 'two') throw new Error('gone');
            return new Blob(['png'], { type: 'image/png' });
          }}
          urls={countingUrls()}
        >
          <TranscriptAttachmentGallery daemon={daemon} images={[stored('one'), stored('two')]} />
        </AttachmentGalleryProvider>,
      );
      await interact(async () => new Promise(resolve => setTimeout(resolve, 20)));
      await interact(() => label(view.container, 'Expand one.png').click());
      await interact(() => label(dialog(), 'Next image').click());
      await interact(async () => new Promise(resolve => setTimeout(resolve, 20)));
      expect(dialog().textContent).toContain('This image is no longer available');
      await interact(() => pressKey(dialog(), 'Escape'));
      await view.unmount();
    } finally {
      restore();
    }
  });

  it('are fetched once however often the message re-renders with fresh-but-equal image objects', async () => {
    const restore = immediateObserver();
    const asked: string[] = [];
    try {
      const tree = () => (
        <AttachmentGalleryProvider
          load={async (_connection, scope) => {
            asked.push(scope.attachmentId);
            return new Blob(['png'], { type: 'image/png' });
          }}
          urls={countingUrls()}
        >
          <TranscriptAttachmentGallery daemon={daemon} images={[stored('one'), stored('two')]} />
        </AttachmentGalleryProvider>
      );
      const view = await mount(tree());
      await view.render(tree());
      await view.render(tree());
      await interact(async () => new Promise(resolve => setTimeout(resolve, 10)));
      expect(asked.sort()).toEqual(['one', 'two']);
      await view.unmount();
    } finally {
      restore();
    }
  });
});
