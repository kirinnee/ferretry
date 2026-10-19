/**
 * The stage of a `src:` block: what it reads, what it fetches, what it shows,
 * and the file row it shows instead.
 *
 * WHAT THIS TIER CAN AND CANNOT SAY. Nothing here decodes a picture or plays a
 * recording — `react-test-renderer` has no media pipeline — so the proof is the
 * element and the address it is handed, the request a link causes, and the row
 * every refusal becomes. The workspace reader is a fake behind the
 * `FyRenderWorkspaceReader` port, `fetch` and the object-URL pair are stubbed on
 * `globalThis` and restored in `finally`, and no test touches the network.
 */
import { afterEach, describe, test } from 'bun:test';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import should from 'should';
import { FyRenderMedia } from '../../src/components/fy-render-media.tsx';
import {
  FY_RENDER_LIMITS,
  type FyRenderMediaBlock,
  type FyRenderWorkspaceRead,
  type FyRenderWorkspaceReader,
  isFyRenderMediaBlock,
  parseFyRender,
} from '../../src/lib/fy-render.ts';
import { render, run, runAsync } from '../support/react.ts';

const media = (...lines: readonly string[]): FyRenderMediaBlock => {
  const result = parseFyRender([...lines, '---'].join('\n'));
  if (!result.ok) throw new Error(`fixture did not parse: ${result.reason}`);
  if (!isFyRenderMediaBlock(result.block)) throw new Error('fixture is not a media block');
  return result.block;
};

/**
 * An ADMISSION-SHAPED PNG, built byte by byte exactly as `fy-render.test.ts`
 * builds it: the signature, a 13-byte IHDR, one IDAT run and a terminal IEND.
 * It carries the records `fyRenderRasterRefusal` reads and nothing a decoder
 * would need, which is all this tier can use it for.
 */
const be32 = (value: number): readonly number[] => [
  (value >>> 24) & 255,
  (value >>> 16) & 255,
  (value >>> 8) & 255,
  value & 255,
];
const chars = (text: string): readonly number[] => [...text].map(character => character.charCodeAt(0));
const IDAT: readonly number[] = [...be32(2), ...chars('IDAT'), 0x78, 0x01, 0, 0, 0, 0];
const png = (width: number, height: number): Uint8Array<ArrayBuffer> =>
  Uint8Array.from([
    0x89,
    ...chars('PNG\r\n\x1a\n'),
    ...be32(13),
    ...chars('IHDR'),
    ...be32(width),
    ...be32(height),
    8,
    6,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    ...IDAT,
    ...be32(0),
    ...chars('IEND'),
    0,
    0,
    0,
    0,
  ]);
/** Bytes no raster signature matches. */
const NOT_AN_IMAGE = Uint8Array.from(chars('plain text, not a picture'));

/** A reader that answers once and records the paths and signals it was handed. */
const reader = (answer: () => Promise<FyRenderWorkspaceRead>) => {
  const paths: string[] = [];
  const signals: AbortSignal[] = [];
  const read: FyRenderWorkspaceReader = async (path, signal) => {
    paths.push(path);
    signals.push(signal);
    return await answer();
  };
  return { paths, read, signals };
};
const answers = (value: FyRenderWorkspaceRead) => reader(async () => value);

/** A promise the test resolves itself, so a read can still be in flight when the stage unmounts. */
const deferred = <T,>() => {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
};

/**
 * THE OBJECT-URL PAIR, STUBBED AND RESTORED. Each minted URL is recorded with
 * the Blob it was made from, which is how a test reads the MIME the stage
 * declared, and each revoke is recorded, which is how the cleanup is proven.
 */
const withObjectUrls = async (
  body: (urls: { readonly minted: Blob[]; readonly revoked: string[] }) => Promise<void>,
): Promise<void> => {
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  const urls = { minted: [] as Blob[], revoked: [] as string[] };
  URL.createObjectURL = (blob: Blob) => {
    urls.minted.push(blob);
    return `blob:https://pwa.example.test/minted-${urls.minted.length}`;
  };
  URL.revokeObjectURL = (url: string) => {
    urls.revoked.push(url);
  };
  try {
    await body(urls);
  } finally {
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
  }
};

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/** `fetch` stubbed for one test and restored, recording every request. */
const withFetch = async (
  respond: () => Promise<Response>,
  body: (calls: readonly FetchCall[]) => Promise<void>,
): Promise<void> => {
  const realFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ init, url: String(url) });
    return await respond();
  }) as unknown as typeof fetch;
  try {
    await body(calls);
  } finally {
    globalThis.fetch = realFetch;
  }
};

/**
 * A response the bounded reader can consume, built by hand so it does not
 * depend on whichever `Response` the process's DOM shim installed.
 */
const answer = (
  options: { status?: number; headers?: Record<string, string>; body?: ReadableStream<Uint8Array> | null } = {},
): Response =>
  ({
    body: options.body === undefined ? null : options.body,
    headers: new Headers(options.headers),
    ok: (options.status ?? 200) < 400,
    status: options.status ?? 200,
  }) as unknown as Response;
const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
const failingStream = (): ReadableStream<Uint8Array> =>
  new ReadableStream({
    pull(controller) {
      controller.error(new Error('connection reset'));
    },
  });

/** Every tree a test mounted, torn down even when the test failed before its own unmount. */
const mounted: ReactTestRenderer[] = [];
afterEach(() => {
  while (mounted.length > 0) {
    const tree = mounted.pop();
    try {
      run(() => tree?.unmount());
    } catch {
      // Already unmounted by the test itself.
    }
  }
});

const mount = (block: FyRenderMediaBlock, read?: FyRenderWorkspaceReader): ReactTestRenderer => {
  const tree = render(
    read === undefined ? <FyRenderMedia block={block} /> : <FyRenderMedia block={block} readWorkspaceMedia={read} />,
  );
  mounted.push(tree);
  return tree;
};

/** Lets every pending read and fetch settle, inside `act`. */
const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 3; turn += 1)
    await runAsync(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
};

/**
 * STRINGS AND COUNTS, NEVER INSTANCES. A failing `should` on a
 * `ReactTestInstance` walks its live fiber graph and hangs the run instead of
 * failing it, so every reading below reduces the tree first.
 */
const stageOf = (tree: ReactTestRenderer): string =>
  tree.root
    .findAll(node => typeof node.type === 'string' && node.props['data-fy-render-media'] !== undefined)
    .map(node => String(node.props['data-fy-render-media']))
    .join(',');
const fallbackOf = (tree: ReactTestRenderer): string =>
  tree.root
    .findAll(node => typeof node.type === 'string' && node.props['data-fy-render-fallback'] !== undefined)
    .map(node => String(node.props['data-fy-render-fallback']))
    .join(',');
const textOf = (node: ReactTestInstance): string =>
  node.children.map(child => (typeof child === 'string' ? child : textOf(child))).join('');
/** The row's one muted line of facts — a refusal's sentence, or a file's type and size. */
const sentenceOf = (tree: ReactTestRenderer): string =>
  tree.root
    .findAll(node => node.type === 'span' && node.props.className === 'fy-render-row-meta')
    .map(textOf)
    .join('|');
/** The row's file name. */
const nameOf = (tree: ReactTestRenderer): string =>
  tree.root
    .findAll(node => node.type === 'span' && node.props.className === 'fy-render-row-name')
    .map(textOf)
    .join('|');
/** The machine wording, which a row carries as its `title` rather than as copy. */
const whyOf = (tree: ReactTestRenderer): string =>
  tree.root
    .findAll(node => node.type === 'div' && node.props['data-fy-render-row'] === 'true')
    .map(node => String(node.props.title ?? ''))
    .join('|');
const hostOf = (tree: ReactTestRenderer, type: string): Record<string, unknown> | null =>
  tree.root.findAll(node => node.type === type)[0]?.props ?? null;
const countOf = (tree: ReactTestRenderer, type: string): number => tree.root.findAll(node => node.type === type).length;
/** Calls a host element's `onError`, which is what the browser does when it cannot decode the source. */
const fire = (tree: ReactTestRenderer, type: string): void => {
  const onError = hostOf(tree, type)?.onError;
  if (typeof onError !== 'function') throw new Error(`no ${type} with an onError`);
  onError();
};

const video = (src = '@clip.mp4') => media('type: video', 'alt: A recording', `src: ${src}`);
const image = (src = '@shot.png') => media('type: image', 'alt: A screenshot', `src: ${src}`);
const audio = (src = '@voice.mp3') => media('type: audio', 'alt: A voice note', `src: ${src}`);
const pdf = (src = '@report.pdf') => media('type: pdf', 'alt: The report', `src: ${src}`);

describe('FyRenderMedia workspace source', () => {
  test('should hold a quiet plane, with no words, before the read answers', async () => {
    // Arrange
    const pending = deferred<FyRenderWorkspaceRead>();

    // Act
    const tree = mount(video(), reader(() => pending.promise).read);

    // Assert
    should(stageOf(tree)).equal('loading');
    should(textOf(tree.root)).equal('');
  });

  test('should show a PDF as a loading file row before the read answers, and say it is a row', async () => {
    // Arrange
    const pending = deferred<FyRenderWorkspaceRead>();
    const shapes: boolean[] = [];

    // Act
    const tree = render(
      <FyRenderMedia
        block={pdf()}
        onShape={row => shapes.push(row)}
        readWorkspaceMedia={reader(() => pending.promise).read}
      />,
    );
    mounted.push(tree);

    // Assert
    should(nameOf(tree)).equal('report.pdf');
    should(sentenceOf(tree)).equal('PDF · loading…');
    should(shapes).deepEqual([true]);
  });

  test('should say a picture is not a row', async () => {
    // Arrange
    const shapes: boolean[] = [];
    const pending = deferred<FyRenderWorkspaceRead>();

    // Act
    const tree = render(
      <FyRenderMedia
        block={image()}
        onShape={row => shapes.push(row)}
        readWorkspaceMedia={reader(() => pending.promise).read}
      />,
    );
    mounted.push(tree);

    // Assert
    should(shapes).deepEqual([false]);
  });

  test('should say it cannot read the workspace when this view has no reader', async () => {
    // Act
    const tree = mount(video());
    await flush();

    // Assert
    should(fallbackOf(tree)).equal('no-workspace');
    should(sentenceOf(tree)).equal("This video is a file in this session's workspace, which this view cannot read.");
    should(countOf(tree, 'details')).equal(0);
  });

  test('should refuse an unshowable extension without ever calling the reader', async () => {
    // Arrange
    const { paths, read } = answers({ bytes: png(1, 1), ok: true });

    // Act
    const tree = mount(video('@notes.txt'), read);
    await flush();

    // Assert
    should(fallbackOf(tree)).equal('unsupported');
    should(sentenceOf(tree)).equal('This video is in a format that cannot be shown here.');
    should(whyOf(tree)).equal('No video type is known for notes.txt');
    should(paths.length).equal(0);
  });

  for (const [reason, sentence] of [
    ['missing', "clip.mp4 was not found in this session's workspace."],
    ['denied', "You do not have access to clip.mp4 in this session's workspace."],
    ['not-served', "clip.mp4 is not served from this session's workspace."],
    ['too-large', 'clip.mp4 is larger than the 1 MB a workspace file can be shown at.'],
    ['unavailable', 'The workspace could not be read just now.'],
  ] as const) {
    test(`should show the ${reason} row when the reader refuses with ${reason}`, async () => {
      // Arrange
      const { paths, read } = answers({ ok: false, reason });

      // Act
      const tree = mount(video(), read);
      await flush();

      // Assert
      should(paths).deepEqual(['clip.mp4']);
      should(fallbackOf(tree)).equal(reason);
      should(sentenceOf(tree)).equal(sentence);
      // A workspace source has no link to offer instead.
      should(countOf(tree, 'a')).equal(0);
    });
  }

  test('should say WHICH rule refused a file the daemon will not serve', async () => {
    // Arrange — the owner's exact case: an agent's own image, refused with no reason anybody could act on.
    const { read } = answers({ ok: false, reason: 'not-served', rule: 'Git ignores it (.gitignore:3: *.png)' });

    // Act
    const tree = mount(image('@fy-render-test/card.png'), read);
    await flush();

    // Assert
    should(sentenceOf(tree)).equal(
      "fy-render-test/card.png is not served from this session's workspace: Git ignores it (.gitignore:3: *.png).",
    );
  });

  test('should read a media: file from the session media folder, and name that folder when it refuses', async () => {
    // Arrange
    const folders: (string | undefined)[] = [];
    const read: FyRenderWorkspaceReader = async (_path, _signal, folder) => {
      folders.push(folder);
      return { ok: false, reason: 'missing' };
    };

    // Act
    const tree = mount(image('media:card.png'), read);
    await flush();

    // Assert
    should(folders).deepEqual(['media']);
    should(sentenceOf(tree)).equal("card.png was not found in this session's media folder.");
  });

  test('should refuse bytes over the workspace media bound', async () => {
    // Arrange
    const { read } = answers({ bytes: new Uint8Array(FY_RENDER_LIMITS.workspaceMediaBytes + 1), ok: true });

    // Act
    await withObjectUrls(async urls => {
      const tree = mount(video(), read);
      await flush();

      // Assert
      should(fallbackOf(tree)).equal('too-large');
      should(urls.minted.length).equal(0);
    });
  });

  test('should call a reader that throws unavailable', async () => {
    // Arrange
    const { read } = reader(async () => {
      throw new Error('carrier collapsed');
    });

    // Act
    const tree = mount(video(), read);
    await flush();

    // Assert
    should(fallbackOf(tree)).equal('unavailable');
  });

  test('should refuse image bytes that fail the raster admission, with the refusal as the title', async () => {
    // Arrange
    const { read } = answers({ bytes: Uint8Array.from(NOT_AN_IMAGE), ok: true });

    // Act
    await withObjectUrls(async urls => {
      const tree = mount(image(), read);
      await flush();

      // Assert
      should(fallbackOf(tree)).equal('unsupported');
      should(sentenceOf(tree)).equal('This picture is in a format that cannot be shown here.');
      should(whyOf(tree)).equal('Image payload header could not be read');
      should(urls.minted.length).equal(0);
    });
  });

  test('should show an admitted workspace image as a blob URL described by its own alt', async () => {
    // Arrange
    const { read } = answers({ bytes: png(4, 4), ok: true });

    // Act
    await withObjectUrls(async urls => {
      const tree = mount(image(), read);
      await flush();

      // Assert
      should(stageOf(tree)).equal('image');
      should(urls.minted.map(blob => blob.type)).deepEqual(['image/png']);
      const element = hostOf(tree, 'img');
      should(element?.src).equal('blob:https://pwa.example.test/minted-1');
      should(element?.alt).equal('A screenshot');
    });
  });

  test('should show a workspace video in the native player with metadata preload and inline play', async () => {
    // Arrange
    const { read } = answers({ bytes: Uint8Array.from([0, 0, 0, 24]), ok: true });

    // Act
    await withObjectUrls(async urls => {
      const tree = mount(video(), read);
      await flush();

      // Assert
      should(urls.minted.map(blob => blob.type)).deepEqual(['video/mp4']);
      const element = hostOf(tree, 'video');
      should(element?.src).equal('blob:https://pwa.example.test/minted-1');
      should(element?.controls).be.true();
      should(element?.preload).equal('metadata');
      should(element?.playsInline).be.true();
      should(element?.['aria-label']).equal('A recording');
    });
  });

  test('should show a workspace recording in the native audio player', async () => {
    // Arrange
    const { read } = answers({ bytes: Uint8Array.from([0x49, 0x44, 0x33]), ok: true });

    // Act
    await withObjectUrls(async urls => {
      const tree = mount(audio(), read);
      await flush();

      // Assert
      should(urls.minted.map(blob => blob.type)).deepEqual(['audio/mpeg']);
      const element = hostOf(tree, 'audio');
      should(element?.src).equal('blob:https://pwa.example.test/minted-1');
      should(element?.controls).be.true();
    });
  });

  test('should offer a workspace PDF as a minted blob to open in a new tab or save, never a frame', async () => {
    // Arrange
    const { read } = answers({ bytes: Uint8Array.from(chars('%PDF-1.7')), ok: true });

    // Act
    await withObjectUrls(async urls => {
      const tree = mount(pdf(), read);
      await flush();

      // Assert — Chromium refuses its PDF viewer in a sandboxed frame (measured),
      // so the admitted bytes are offered as links rather than embedded.
      should(urls.minted.map(blob => blob.type)).deepEqual(['application/pdf']);
      should(stageOf(tree)).equal('pdf');
      should(countOf(tree, 'iframe')).equal(0);
      const anchors = tree.root.findAllByType('a').map(node => ({
        download: node.props.download as string | undefined,
        href: node.props.href as string,
        rel: node.props.rel as string | undefined,
        target: node.props.target as string | undefined,
      }));
      should(anchors).deepEqual([
        {
          download: undefined,
          href: 'blob:https://pwa.example.test/minted-1',
          rel: 'noopener noreferrer',
          target: '_blank',
        },
        { download: 'report.pdf', href: 'blob:https://pwa.example.test/minted-1', rel: undefined, target: undefined },
      ]);
      // A file row: the name, and what it is and how big.
      should(nameOf(tree)).equal('report.pdf');
      should(sentenceOf(tree)).equal('PDF · 8 bytes');
    });
  });

  test('should revoke the minted URL and abort the read signal on unmount', async () => {
    // Arrange
    const { read, signals } = answers({ bytes: Uint8Array.from([0, 0, 0, 24]), ok: true });

    await withObjectUrls(async urls => {
      const tree = mount(video(), read);
      await flush();

      // Act
      run(() => tree.unmount());

      // Assert
      should(urls.revoked).deepEqual(['blob:https://pwa.example.test/minted-1']);
      should(signals.map(signal => signal.aborted)).deepEqual([true]);
    });
  });

  test('should mint nothing and show nothing for bytes that arrive after unmount', async () => {
    // Arrange
    const pending = deferred<FyRenderWorkspaceRead>();
    const { read, signals } = reader(() => pending.promise);

    await withObjectUrls(async urls => {
      const tree = mount(video(), read);

      // Act
      run(() => tree.unmount());
      pending.resolve({ bytes: Uint8Array.from([0, 0, 0, 24]), ok: true });
      await flush();

      // Assert
      should(signals.map(signal => signal.aborted)).deepEqual([true]);
      should(urls.minted.length).equal(0);
      should(urls.revoked.length).equal(0);
    });
  });

  test('should drop a refusal that arrives after unmount', async () => {
    // Arrange
    const pending = deferred<FyRenderWorkspaceRead>();
    const { read } = reader(() => pending.promise);
    const tree = mount(video(), read);

    // Act
    run(() => tree.unmount());
    pending.resolve({ ok: false, reason: 'missing' });
    await flush();

    // Assert — the tree is gone, and setting its state would have been the defect.
    should(tree.toJSON()).be.null();
  });

  test('should replace a player the browser cannot decode with the decode row', async () => {
    // Arrange
    const { read } = answers({ bytes: Uint8Array.from([0, 0, 0, 24]), ok: true });

    await withObjectUrls(async () => {
      const tree = mount(video(), read);
      await flush();

      // Act
      run(() => fire(tree, 'video'));

      // Assert
      should(fallbackOf(tree)).equal('decode');
      should(sentenceOf(tree)).equal('Your browser could not show this video.');
    });
  });
});

describe('FyRenderMedia https source', () => {
  const failFetch = async (): Promise<Response> => {
    throw new Error('this test must not fetch');
  };

  test('should hand an https video straight to the native player without fetching', async () => {
    await withFetch(failFetch, async calls => {
      await withObjectUrls(async urls => {
        // Act
        const tree = mount(video('https://cdn.example.test/clip.mp4'));
        await flush();

        // Assert
        should(hostOf(tree, 'video')?.src).equal('https://cdn.example.test/clip.mp4');
        should(calls.length).equal(0);
        should(urls.minted.length).equal(0);
      });
    });
  });

  test('should hand an https recording straight to the native player without fetching', async () => {
    await withFetch(failFetch, async calls => {
      // Act
      const tree = mount(audio('https://cdn.example.test/voice.mp3'));
      await flush();

      // Assert
      should(hostOf(tree, 'audio')?.src).equal('https://cdn.example.test/voice.mp3');
      should(calls.length).equal(0);
    });
  });

  test('should offer an https PDF as a new-tab link and never embed it', async () => {
    await withFetch(failFetch, async calls => {
      // Act
      const tree = mount(pdf('https://docs.example.test/report.pdf'));
      await flush();

      // Assert
      should(stageOf(tree)).equal('link');
      should(countOf(tree, 'iframe')).equal(0);
      const anchor = hostOf(tree, 'a');
      should(anchor?.href).equal('https://docs.example.test/report.pdf');
      should(anchor?.target).equal('_blank');
      should(anchor?.rel).equal('noopener noreferrer');
      should(nameOf(tree)).equal('report.pdf');
      should(sentenceOf(tree)).equal('PDF · docs.example.test');
      should(calls.length).equal(0);
    });
  });

  test('should name a linked file by its decoded last segment, its raw one, or what it is', async () => {
    await withFetch(failFetch, async () => {
      for (const [url, name] of [
        ['https://docs.example.test/annual%20report.pdf', 'annual report.pdf'],
        // A malformed escape is shown as written rather than thrown.
        ['https://docs.example.test/broken%E0%A4%A.pdf', 'broken%E0%A4%A.pdf'],
        ['https://docs.example.test/', 'PDF'],
      ] as const) {
        // Act
        const tree = mount(pdf(url));
        await flush();

        // Assert
        should(nameOf(tree)).equal(name);
      }
    });
  });

  test('should fetch an https image with no credentials, cors mode and no referrer', async () => {
    await withFetch(
      async () => answer({ body: streamOf(png(2, 2)) }),
      async calls => {
        await withObjectUrls(async urls => {
          // Act
          const tree = mount(image('https://img.example.test/shot.png'));
          await flush();

          // Assert
          should(calls.map(call => call.url)).deepEqual(['https://img.example.test/shot.png']);
          should(calls[0]?.init?.credentials).equal('omit');
          should(calls[0]?.init?.mode).equal('cors');
          should(calls[0]?.init?.referrerPolicy).equal('no-referrer');
          should(calls[0]?.init?.signal instanceof AbortSignal).be.true();
          should(urls.minted.length).equal(1);
          should(hostOf(tree, 'img')?.src).equal('blob:https://pwa.example.test/minted-1');
        });
      },
    );
  });

  test('should offer the link when the host refuses a cross-origin read', async () => {
    await withFetch(
      async () => {
        throw new TypeError('Failed to fetch');
      },
      async () => {
        // Act
        const tree = mount(image('https://img.example.test/shot.png'));
        await flush();

        // Assert
        should(fallbackOf(tree)).equal('blocked');
        should(sentenceOf(tree)).equal(
          'img.example.test does not allow this app to show its picture. It can still be opened as a link.',
        );
        should(whyOf(tree)).equal('Failed to fetch');
        should(hostOf(tree, 'a')?.href).equal('https://img.example.test/shot.png');
        should(textOf(tree.root.findAll(node => node.type === 'a')[0] as ReactTestInstance)).equal(' Open link');
      },
    );
  });

  test('should carry no title when the refusal carries no message', async () => {
    await withFetch(
      async () => {
        throw 'not an Error';
      },
      async () => {
        // Act
        const tree = mount(image('https://img.example.test/shot.png'));
        await flush();

        // Assert
        should(fallbackOf(tree)).equal('blocked');
        should(whyOf(tree)).equal('');
      },
    );
  });

  test('should call a non-ok answer unavailable with the status as the title', async () => {
    await withFetch(
      async () => answer({ status: 404 }),
      async () => {
        // Act
        const tree = mount(image('https://img.example.test/shot.png'));
        await flush();

        // Assert
        should(fallbackOf(tree)).equal('unavailable');
        should(sentenceOf(tree)).equal('img.example.test did not answer with the picture.');
        should(whyOf(tree)).equal('HTTP 404');
      },
    );
  });

  test('should refuse an image declared over the https bound before reading it', async () => {
    await withFetch(
      async () =>
        answer({
          body: failingStream(),
          headers: { 'content-length': String(FY_RENDER_LIMITS.httpsImageBytes + 1) },
        }),
      async () => {
        // Act
        const tree = mount(image('https://img.example.test/shot.png'));
        await flush();

        // Assert
        should(fallbackOf(tree)).equal('too-large');
        should(sentenceOf(tree)).equal('This picture is larger than the 2 MB an image link can be shown at.');
        should(whyOf(tree)).equal('The image response is too large');
      },
    );
  });

  test('should call a body that fails mid-read unavailable', async () => {
    await withFetch(
      async () => answer({ body: failingStream() }),
      async () => {
        // Act
        const tree = mount(image('https://img.example.test/shot.png'));
        await flush();

        // Assert
        should(fallbackOf(tree)).equal('unavailable');
        should(whyOf(tree)).equal('The image response could not be read');
      },
    );
  });

  test('should refuse fetched bytes that are not an admitted raster', async () => {
    await withFetch(
      async () => answer({ body: streamOf(NOT_AN_IMAGE) }),
      async () => {
        await withObjectUrls(async urls => {
          // Act
          const tree = mount(image('https://img.example.test/shot.png'));
          await flush();

          // Assert
          should(fallbackOf(tree)).equal('unsupported');
          should(whyOf(tree)).equal('Image payload header could not be read');
          should(urls.minted.length).equal(0);
        });
      },
    );
  });

  test('should replace a fetched image the browser cannot decode with the decode row and the link', async () => {
    await withFetch(
      async () => answer({ body: streamOf(png(2, 2)) }),
      async () => {
        await withObjectUrls(async () => {
          const tree = mount(image('https://img.example.test/shot.png'));
          await flush();

          // Act
          run(() => fire(tree, 'img'));

          // Assert
          should(fallbackOf(tree)).equal('decode');
          should(sentenceOf(tree)).equal('Your browser could not show this picture.');
          should(countOf(tree, 'a')).equal(1);
        });
      },
    );
  });

  test('should mint nothing for an image that arrives after unmount', async () => {
    // Arrange
    const pending = deferred<Response>();

    await withFetch(
      () => pending.promise,
      async calls => {
        await withObjectUrls(async urls => {
          const tree = mount(image('https://img.example.test/shot.png'));

          // Act
          run(() => tree.unmount());
          pending.resolve(answer({ body: streamOf(png(2, 2)) }));
          await flush();

          // Assert
          should(calls[0]?.init?.signal?.aborted).be.true();
          should(urls.minted.length).equal(0);
          should(urls.revoked.length).equal(0);
        });
      },
    );
  });
});
