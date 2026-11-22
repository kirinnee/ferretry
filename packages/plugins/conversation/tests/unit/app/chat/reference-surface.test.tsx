/**
 * THE CHAT'S REFERENCE SURFACE: what it proves and what it opens. `:agent` is proved from this daemon's fleet and stamped
 * with THIS daemon; `@file` is proved by Ferrets' folder listing and opens only through Ferrets' `ferrets.file-open`. Each
 * is drawn by the real `Markdown`, so a link that appears proves the whole chain and a reference left as text proves the
 * proof-before-link rule held.
 */
import { afterEach, describe, test } from 'bun:test';
import { DaemonCallError, Markdown, ScreenHrefProvider } from '@ferretry/app';
import { ensureDom, interact, type Mounted, mount, render as renderTree } from '@ferretry/app/testing';
import type { FerretsFileOpen } from '@ferretry/core-ferrets/contract';
import should from 'should';
import { type ChatFleet, chatFleetOf } from '../../../../app/chat/chat-fleet.ts';
import { chatFileProof, chatReferenceSurface } from '../../../../app/chat/reference-surface.ts';
import { FyRenderBlock } from '../../../../app/render/fy-render-block.tsx';

ensureDom();

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const FLEET: ChatFleet = chatFleetOf([
  { id: 'f1', name: 'aniya', state: 'working', folder: '/repo' },
  { id: 'f2', name: 'torrey', state: 'idle', folder: '/other' },
]) as ChatFleet;

/** A client that answers the folder listings it is given and records every call. */
const client = (listings: Readonly<Record<string, unknown>>) => {
  const calls: Array<{ route: string; query: Record<string, string> | undefined }> = [];
  return {
    calls,
    call: async (route: string, request?: { query?: Record<string, string> }) => {
      calls.push({ route, query: request?.query });
      const answer = listings[request?.query?.path ?? ''];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  } as never;
};

const draw = async (text: string, surface: ReturnType<typeof chatReferenceSurface>): Promise<Mounted> => {
  const href = (daemon: string, plugin: string, screen: string, params: Readonly<Record<string, string>> = {}) =>
    `/${daemon}/${plugin}/${screen}?ferret=${params.ferret ?? ''}`;
  const mounted = await mount(
    <ScreenHrefProvider href={href}>
      <Markdown {...surface} text={text} />
    </ScreenHrefProvider>,
  );
  await interact(async () => {
    for (let spin = 0; spin < 5; spin += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
  return mounted;
};

const anchors = (mounted: Mounted): HTMLAnchorElement[] => [...mounted.container.querySelectorAll('a')];

describe('chatReferenceSurface :agent', () => {
  test('should link a ferret of this daemon fleet and stamp this daemon on the answer', async () => {
    // Arrange
    const surface = chatReferenceSurface({ daemonId: 'd1', ferretId: 'f1', fleet: FLEET, onNavigate: () => undefined });

    // Act
    const answered = surface.agentReferenceResolver?.({ name: 'torrey' });
    view = await draw('ask :torrey', surface);

    // Assert
    should(answered).deepEqual({ daemonId: 'd1', sessionId: 'f2', name: 'torrey' });
    should(anchors(view).map(anchor => anchor.getAttribute('href'))).deepEqual(['/d1/conversation/chat?ferret=f2']);
  });

  test('should leave a name the fleet does not hold, and an unread fleet, as prose', async () => {
    // Arrange
    const read = chatReferenceSurface({ daemonId: 'd1', ferretId: 'f1', fleet: FLEET, onNavigate: () => undefined });
    const unread = chatReferenceSurface({ daemonId: 'd1', ferretId: 'f1', onNavigate: () => undefined });

    // Act
    view = await draw('ask :nobody', read);

    // Assert
    should(read.agentReferenceResolver?.({ name: 'nobody' })).be.null();
    should(anchors(view).length).equal(0);
    should(unread.agentReferenceResolver).be.undefined();
  });
});

describe('chatReferenceSurface @file', () => {
  const opened: Array<[string, string]> = [];
  const fileOpen: FerretsFileOpen = {
    open: (ferret, path) => {
      opened.push([ferret, path]);
      return true;
    },
  };

  afterEach(() => {
    opened.length = 0;
  });

  test('should link a file the folder lists and open it in Files for this ferret, then show Files', async () => {
    // Arrange
    let shown = 0;
    const surface = chatReferenceSurface({
      daemonId: 'd1',
      ferretId: 'f1',
      fleet: FLEET,
      client: client({ src: { entries: [{ name: 'a.ts', type: 'file' }] } }),
      fileOpen,
      showFiles: () => {
        shown += 1;
      },
    });
    view = await draw('see @/repo/src/a.ts:3', surface);

    // Act
    await interact(() => anchors(view as Mounted)[0]?.click());

    // Assert
    should(opened).deepEqual([['f1', 'src/a.ts']]);
    should(shown).equal(1);
  });

  test('should use the file proof it is handed as it is, and build none without a client and an opener', () => {
    // Arrange
    const own = chatFileProof({ ferretId: 'f1', client: client({}), fileOpen, cwd: '/repo' });
    const rebuilt = (fleet: ChatFleet | undefined) =>
      chatReferenceSurface({ daemonId: 'd1', ferretId: 'f1', fleet, client: client({}), files: own });

    // Act
    const first = rebuilt(FLEET);
    const second = rebuilt(chatFleetOf([{ id: 'f1', name: 'aniya', state: 'idle', folder: '/repo' }]));

    // Assert — the surface is rebuilt, the proof the readers key their listings on is the one it was handed
    should(first).not.equal(second);
    should(first.resolveFilePaths).equal(own?.resolveFilePaths);
    should(second.onCodeReferenceOpen).equal(own?.onCodeReferenceOpen);
    should(chatFileProof({ ferretId: 'f1', client: undefined, fileOpen, cwd: undefined })).be.undefined();
    should(chatFileProof({ ferretId: 'f1', client: client({}), fileOpen: undefined, cwd: undefined })).be.undefined();
  });

  test('should leave the path as prose with no ferrets.file-open hook, and ask the daemon nothing', async () => {
    // Arrange
    const asked = client({ src: { entries: [{ name: 'a.ts', type: 'file' }] } });
    const surface = chatReferenceSurface({ daemonId: 'd1', ferretId: 'f1', fleet: FLEET, client: asked });

    // Act
    view = await draw('see @src/a.ts', surface);

    // Assert
    should(surface.resolveFilePaths).be.undefined();
    should(surface.onCodeReferenceOpen).be.undefined();
    should(anchors(view).length).equal(0);
    should((asked as unknown as { calls: unknown[] }).calls.length).equal(0);
  });

  test('should leave the path as prose when the listing is refused for want of the filesystem grant', async () => {
    // Arrange
    const refused = client({ src: new DaemonCallError(403, 'forbidden', 'the filesystem grant is off') });
    const surface = chatReferenceSurface({ daemonId: 'd1', ferretId: 'f1', fleet: FLEET, client: refused, fileOpen });

    // Act
    view = await draw('see @src/a.ts', surface);

    // Assert
    should(anchors(view).length).equal(0);
    should(opened).deepEqual([]);
  });

  test('should not prove a denied, ignored or escaping entry', async () => {
    // Arrange
    const surface = chatReferenceSurface({
      daemonId: 'd1',
      ferretId: 'f1',
      fleet: FLEET,
      client: client({
        '': {
          entries: [
            { name: 'a.ts', type: 'file', denied: true },
            { name: 'b.ts', type: 'file', ignored: true },
            { name: 'c.ts', type: 'file', escapes: true },
          ],
        },
      }),
      fileOpen,
    });

    // Act
    view = await draw('see @a.ts and @b.ts and @c.ts', surface);

    // Assert
    should(anchors(view).length).equal(0);
  });

  test('should show Files only when the opener accepted the path', async () => {
    // Arrange
    let shown = 0;
    const refusing: FerretsFileOpen = { open: () => false };
    const surface = chatReferenceSurface({
      daemonId: 'd1',
      ferretId: 'f1',
      fleet: FLEET,
      client: client({ '': { entries: [{ name: 'a.ts', type: 'file' }] } }),
      fileOpen: refusing,
      showFiles: () => {
        shown += 1;
      },
    });
    view = await draw('see @a.ts', surface);

    // Act
    await interact(() => anchors(view as Mounted)[0]?.click());

    // Assert
    should(shown).equal(0);
  });
});

describe('chatReferenceSurface media read', () => {
  const FENCE = '`'.repeat(3);
  const mediaFence = [
    `${FENCE}fy-render`,
    'type: image',
    'alt: A chart',
    'src: @/repo/docs/chart.png',
    '---',
    FENCE,
  ].join('\n');
  // The door the hypermedia reader opens with a fence's body: a node the reader marked, the surface's `fences` drawing it.
  const mediaNode = {
    children: [
      {
        type: 'element',
        tagName: 'code',
        properties: { 'data-fy-render-fence': 'true' },
        children: [{ type: 'text', value: `${mediaFence.split('\n').slice(1, -1).join('\n')}\n` }],
      },
    ],
  };
  const readerOf = (surface: ReturnType<typeof chatReferenceSurface>) =>
    renderTree(<>{surface.fences?.draw({ node: mediaNode, onTaskOpen: undefined })}</>).root.findAllByType(
      FyRenderBlock,
    )[0]?.props.readWorkspaceMedia as ((path: string, signal: AbortSignal) => Promise<unknown>) | undefined;

  test('should read a media block file through this ferret, relative to its folder', async () => {
    // Arrange
    const asked = client({});
    const calls = (asked as unknown as { calls: Array<{ route: string; query: Record<string, string> | undefined }> })
      .calls;
    const surface = chatReferenceSurface({ daemonId: 'd1', ferretId: 'f1', fleet: FLEET, client: asked });

    // Act
    const answer = await readerOf(surface)?.('/repo/docs/chart.png', new AbortController().signal);

    // Assert
    should(answer).deepEqual({ ok: false, reason: 'unavailable' });
    // The drawn block reads it too, on mount: every read is this ferret's, of the folder-relative path, nothing else.
    should(calls.length).be.aboveOrEqual(1);
    for (const call of calls)
      should(call).deepEqual({
        route: 'GET /v1/ferrets/:ferretId/fs/file',
        query: { path: 'docs/chart.png', format: 'base64' },
      });
  });

  test('should hand a media block no reader without a client', () => {
    // Act
    const reader = readerOf(chatReferenceSurface({ daemonId: 'd1', ferretId: 'f1' }));

    // Assert
    should(reader).be.undefined();
  });
});
