import { afterEach, describe, expect, it } from 'bun:test';
import type { TranscriptImageMarker } from '@ferretry/protocol';
import { AttachmentGalleryProvider } from '../../src/components/attachment-gallery.tsx';
import { type HandoffSource, HandoffSourceProvider } from '../../src/components/handoff-message.tsx';
import { messageImageAlt, toolImageAlt, TranscriptImages } from '../../src/components/transcript-images.tsx';
import { TranscriptRow } from '../../src/components/transcript-row.tsx';
import type { AttachmentBlobUrlPort } from '../../src/lib/attachment-blob-cache.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonResponseError } from '../../src/lib/runtime-models.ts';
import type { ToolCall, TranscriptEntry } from '../../src/lib/session-screens.ts';
import { interact, mount, must } from '../support/dom.ts';

const daemon = daemonConnection({
  daemonId: 'chat-daemon',
  baseUrl: 'https://chat.example.test',
  deviceId: 'chat-device',
});

const marker = (ordinal = 0, mediaType: 'image/png' | undefined = 'image/png'): TranscriptImageMarker => ({
  handle: { recordOffset: 4096, recordLength: 2048, ordinal },
  ...(mediaType === undefined ? {} : { mediaType }),
});

const source: HandoffSource = {
  daemon,
  sessionId: 'chat-session',
  read: () => Promise.reject(new Error('no hand-offs here')),
};

const countingUrls = (): AttachmentBlobUrlPort & { created: string[]; revoked: string[] } => {
  const created: string[] = [];
  const revoked: string[] = [];
  return {
    created,
    revoked,
    create: () => {
      const url = `blob:chat/${created.length + 1}`;
      created.push(url);
      return url;
    },
    revoke: url => {
      revoked.push(url);
    },
  };
};

let restore: () => void = () => undefined;
afterEach(() => restore());

const observe = (visible: boolean): void => {
  const original = globalThis.IntersectionObserver;
  class Observer {
    readonly #notify: (entries: readonly { isIntersecting: boolean }[]) => void;
    constructor(notify: (entries: readonly { isIntersecting: boolean }[]) => void) {
      this.#notify = notify;
    }
    observe(): void {
      if (visible) this.#notify([{ isIntersecting: true }]);
    }
    disconnect(): void {}
  }
  globalThis.IntersectionObserver = Observer as unknown as typeof IntersectionObserver;
  restore = () => {
    globalThis.IntersectionObserver = original;
  };
};

type Loader = (daemon: unknown, scope: { sessionId: string; attachmentId: string }) => Promise<Blob>;

const inChat = (load: Loader, row: TranscriptEntry, urls = countingUrls()) => (
  <AttachmentGalleryProvider urls={urls} load={load as never}>
    <HandoffSourceProvider source={source}>
      <TranscriptRow answered entry={row} />
    </HandoffSourceProvider>
  </AttachmentGalleryProvider>
);

const userImages: TranscriptEntry = {
  id: 'img-user',
  kind: 'user',
  text: '',
  images: [marker(0), marker(1, undefined)],
};

describe('alt text', () => {
  it('names a person’s image, a ferret’s image and a tool’s screenshot', () => {
    expect(messageImageAlt('user', 'You')).toBe('Image you shared');
    expect(messageImageAlt('assistant', undefined)).toBe('Image the ferret shared');
    expect(messageImageAlt('assistant', '')).toBe('Image the ferret shared');
    expect(messageImageAlt('assistant', 'Assistant')).toBe('Image the ferret shared');
    expect(messageImageAlt('assistant', 'tomi')).toBe('Image from tomi');
    expect(toolImageAlt('mcp__playwright__browser_take_screenshot')).toBe('Screenshot from playwright');
    expect(toolImageAlt('mcp__figma__get_image')).toBe('Image from figma');
    expect(toolImageAlt('Screenshot')).toBe('Screenshot from Screenshot');
    expect(toolImageAlt('Read')).toBe('Image from Read');
    expect(toolImageAlt('mcp__x')).toBe('Image from mcp__x');
    expect(toolImageAlt('mcp____tool')).toBe('Image from mcp____tool');
    expect(toolImageAlt(undefined)).toBe('Image from a tool');
    expect(toolImageAlt('')).toBe('Image from a tool');
  });
});

describe('a picture in a message', () => {
  it('asks for nothing until it is near the viewport, and says it is loading', async () => {
    observe(false);
    const asked: string[] = [];
    const view = await mount(
      inChat(async (_daemon, scope) => {
        asked.push(scope.attachmentId);
        return new Blob(['x'], { type: 'image/png' });
      }, userImages),
    );
    try {
      expect(asked).toEqual([]);
      expect(view.container.querySelectorAll('[data-transcript-image-state="loading"]')).toHaveLength(2);
      expect(view.container.querySelector('[aria-label="Loading Image you shared"]')).not.toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('loads each image by its handle from the owning session and shows it with its alt text', async () => {
    observe(true);
    const asked: string[] = [];
    const urls = countingUrls();
    const view = await mount(
      inChat(
        async (_daemon, scope) => {
          asked.push(`${scope.sessionId}/${scope.attachmentId}`);
          return new Blob(['x'], { type: 'image/png' });
        },
        userImages,
        urls,
      ),
    );
    try {
      expect(asked.sort()).toEqual([
        'chat-session/transcript-image:4096.2048.0',
        'chat-session/transcript-image:4096.2048.1',
      ]);
      const images = [...view.container.querySelectorAll('img')];
      expect(images.map(image => image.getAttribute('alt'))).toEqual(['Image you shared', 'Image you shared']);
      expect(view.container.querySelectorAll('[data-transcript-image-state="loaded"]')).toHaveLength(2);
    } finally {
      await view.unmount();
    }
    expect(urls.revoked.sort()).toEqual(urls.created.sort());
  });

  it('opens the full-screen viewer on tap with every image of the message as its set', async () => {
    observe(true);
    const view = await mount(inChat(async () => new Blob(['x'], { type: 'image/png' }), userImages));
    try {
      const first = must(
        view.container.querySelector<HTMLElement>('[aria-label="Expand Image you shared"]'),
        'the first expand button',
      );
      await interact(() => {
        first.click();
      });
      const dialog = must(view.container.querySelector('dialog'), 'the viewer');
      expect(dialog.getAttribute('aria-label')).toBe('Image viewer: Image you shared');
      expect(dialog.textContent).toContain('1 of 2');
    } finally {
      await view.unmount();
    }
  });

  it.each([
    [404, 'no longer in the transcript'],
    [415, 'not a supported image'],
    [500, 'could not be loaded'],
  ])('says why a %i answer left the image unavailable, with no broken picture', async (status, reason) => {
    observe(true);
    const view = await mount(
      inChat(async () => {
        throw new DaemonResponseError(status, '/home/secret/path');
      }, userImages),
    );
    try {
      const failed = [...view.container.querySelectorAll('[data-transcript-image-state="failed"]')];
      expect(failed).toHaveLength(2);
      expect(failed[0]?.textContent).toBe(`Image unavailable — ${reason}`);
      expect(view.container.textContent).not.toContain('secret');
      expect(view.container.querySelector('img')).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('turns a picture the browser cannot decode into the same error, not a broken image', async () => {
    observe(true);
    const view = await mount(inChat(async () => new Blob(['x'], { type: 'image/png' }), userImages));
    try {
      const image = must(view.container.querySelector('img'), 'the first image');
      await interact(() => {
        image.dispatchEvent(new Event('error'));
      });
      expect(view.container.textContent).toContain('Image unavailable — could not be loaded');
    } finally {
      await view.unmount();
    }
  });

  it('shows a ferret’s picture under the ferret’s name and keeps the words it came with', async () => {
    observe(true);
    const view = await mount(
      inChat(async () => new Blob(['x'], { type: 'image/png' }), {
        id: 'img-ferret',
        kind: 'assistant',
        label: 'tomi',
        text: 'Here is the chart',
        images: [marker()],
      }),
    );
    try {
      expect(view.container.textContent).toContain('Here is the chart');
      expect(view.container.querySelector('img')?.getAttribute('alt')).toBe('Image from tomi');
    } finally {
      await view.unmount();
    }
  });

  it('draws an assistant picture row with no words and no empty paragraph', async () => {
    observe(true);
    const view = await mount(
      inChat(async () => new Blob(['x'], { type: 'image/png' }), {
        id: 'img-ferret-2',
        kind: 'assistant',
        text: '',
        images: [marker()],
      }),
    );
    try {
      expect(view.container.querySelector('img')?.getAttribute('alt')).toBe('Image the ferret shared');
    } finally {
      await view.unmount();
    }
  });
});

describe('a picture a tool returned', () => {
  const call = (name: string, text: string, images: readonly TranscriptImageMarker[]): ToolCall => ({
    key: `k-${name}`,
    use: { name, input: {} },
    result: { text, images },
  });
  const toolRow = (...calls: ToolCall[]): TranscriptEntry => ({
    id: 'tool-1',
    kind: 'tool',
    text: 'ran a tool',
    tools: calls,
  });

  it('shows an image-only result as its picture, with no empty result body', async () => {
    observe(true);
    const view = await mount(
      inChat(
        async () => new Blob(['x'], { type: 'image/png' }),
        toolRow(call('mcp__playwright__browser_take_screenshot', '', [marker()])),
      ),
    );
    try {
      expect(view.container.querySelector('img')?.getAttribute('alt')).toBe('Screenshot from playwright');
      expect(view.container.querySelector('.fy-tool-images')).not.toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('shows the images of a run of calls under the run, in order', async () => {
    observe(true);
    const view = await mount(
      inChat(
        async () => new Blob(['x'], { type: 'image/png' }),
        toolRow(
          call('mcp__playwright__browser_take_screenshot', 'saved', [marker(0)]),
          call('mcp__figma__get_image', '', [marker(1)]),
          call('Read', 'text only', []),
        ),
      ),
    );
    try {
      expect([...view.container.querySelectorAll('img')].map(image => image.getAttribute('alt'))).toEqual([
        'Screenshot from playwright',
        'Image from figma',
      ]);
    } finally {
      await view.unmount();
    }
  });
});

describe('outside a session', () => {
  it('draws nothing when there is no daemon to read the picture from', async () => {
    observe(true);
    const view = await mount(<TranscriptImages images={[{ marker: marker(), alt: 'Image you shared' }]} />);
    try {
      expect(view.container.textContent).toBe('');
      expect(view.container.querySelector('img')).toBeNull();
    } finally {
      await view.unmount();
    }
  });
});
