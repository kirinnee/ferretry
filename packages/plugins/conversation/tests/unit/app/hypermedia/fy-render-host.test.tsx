/**
 * r12 H3 — `fy-render` as a Durian host block. Every assertion draws the REAL `HypermediaProse` in a real DOM
 * (happy-dom) over the chat's own fences (`fyRenderFences`); nothing reads a network or a real home. What a unit
 * cannot prove (that a browser enforces the sandbox) is the integration tier's (`chat-rerender.visual.test.ts`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ReferenceSurfaceProvider } from '@ferretry/app';
import { ensureDom, interact, mount, must } from '@ferretry/app/testing';
import type { ReactNode } from 'react';
import { HypermediaProse } from '../../../../app/hypermedia/hypermedia-prose.tsx';
import { parse } from 'durian-hypermedia';
import { fyRenderParseBlock, parseFyRenderBlock } from '../../../../app/hypermedia/fy-render-host.tsx';
import { fyRenderFences } from '../../../../app/render/fences.tsx';
import { fixture, inShell } from './surface-fixture.tsx';

/** A block draws only once it is near the viewport, and happy-dom has no layout to say so. */
class OnScreen {
  constructor(readonly callback: IntersectionObserverCallback) {}
  observe(target: Element): void {
    this.callback([{ isIntersecting: true, target } as unknown as IntersectionObserverEntry], this as never);
  }
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}
ensureDom();
const realObserver = globalThis.IntersectionObserver;
/** A frame points itself at the shell once; the assignment is kept from reaching happy-dom, which would try to load it. */
const frameSrc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src');
/** The sandbox frame's parent fetches one pinned library; no unit asks a network for it. */
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.IntersectionObserver = OnScreen as unknown as typeof IntersectionObserver;
  globalThis.fetch = (async () => new Response('globalThis.__fyRenderStub = true;')) as unknown as typeof fetch;
  Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
    configurable: true,
    get: () => '',
    set: () => undefined,
  });
});
afterAll(() => {
  globalThis.IntersectionObserver = realObserver;
  globalThis.fetch = realFetch;
  if (frameSrc !== undefined) Object.defineProperty(HTMLIFrameElement.prototype, 'src', frameSrc);
});

/** Built from a backtick run on purpose: `scripts/validate/no-fy-render-in-docs.sh` fails on the literal opener in a tracked file. */
const FENCE = '`'.repeat(3);
const fence = (info: string, ...body: readonly string[]): string => [`${FENCE}${info}`, ...body, FENCE].join('\n');
const block = (...body: readonly string[]): string => fence('fy-render', ...body);

/** A one-pixel PNG carried in the block itself, so a unit never asks a network for a picture. */
const PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const SQUARE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';

const FIXTURES: Readonly<Record<string, string>> = {
  svg: block('type: svg', 'alt: A square', '---', SQUARE),
  image: block('type: image', 'alt: A picture', 'mime: image/png', '---', PIXEL_PNG),
  mermaid: block('type: mermaid', 'alt: A flow', '---', 'graph TD; A-->B'),
  lottie: block('type: lottie', 'alt: A spinner', '---', '{"v":"5.7.0","w":100,"h":100,"layers":[]}'),
  html: block('type: html', 'alt: An agenda', '---', '<button id="t">Day 2</button><script>t.onclick=()=>1</script>'),
  task: block('type: task', 'alt: The task', '---', '&F12'),
  board: block('type: board', 'alt: Open work', '---', '&F1 &F2'),
};

const draw = async (text: string, withBoard = true) => {
  const f = fixture();
  const surface = { ...f.surface, fences: fyRenderFences(withBoard ? { cardEmbed: { daemon: 'd1' } } : {}) };
  const tree = inShell(
    <ReferenceSurfaceProvider surface={surface}>
      <HypermediaProse text={text} />
    </ReferenceSurfaceProvider>,
  ) as ReactNode;
  const mounted = await mount(tree as never);
  await interact(() => Promise.resolve());
  return mounted;
};

/** Everything that could run an author's bytes in the page itself. Our sandbox frames are the only iframes allowed. */
const RUNNABLE = 'object, embed, script, canvas';

describe('every fy-render type reaches its own sink through the Durian path', () => {
  it('draws an svg as an <img>, with nothing runnable beside it', async () => {
    const { container, unmount } = await draw(FIXTURES.svg as string);
    const figure = must(container.querySelector('[data-fy-render-type="svg"]'), 'the svg block');
    expect(figure.querySelectorAll('img').length).toBe(1);
    expect(container.querySelectorAll(`${RUNNABLE}, iframe`).length).toBe(0);
    expect(container.querySelector('.dh-error')).toBeNull();
    await unmount();
  });

  it('draws an image block as an <img>, never a frame', async () => {
    const { container, unmount } = await draw(FIXTURES.image as string);
    expect(container.querySelector('[data-fy-render-type="image"]')).not.toBeNull();
    expect(container.querySelectorAll(`${RUNNABLE}, iframe`).length).toBe(0);
    await unmount();
  });

  for (const type of ['mermaid', 'lottie'] as const) {
    it(`draws ${type} in the sandbox frame and nowhere else`, async () => {
      const { container, unmount } = await draw(FIXTURES[type] as string);
      expect(container.querySelectorAll(`iframe[data-fy-render-frame="${type}"]`).length).toBe(1);
      expect(container.querySelectorAll('iframe').length).toBe(1);
      expect(container.querySelectorAll(RUNNABLE).length).toBe(0);
      await unmount();
    });
  }

  it('draws a scripted html block in the html frame and nowhere else', async () => {
    const { container, unmount } = await draw(FIXTURES.html as string);
    expect(container.querySelectorAll('iframe[data-fy-render-frame="html"]').length).toBe(1);
    expect(container.querySelectorAll('iframe').length).toBe(1);
    // The author's script is never an element of this page.
    expect(container.querySelectorAll(RUNNABLE).length).toBe(0);
    await unmount();
  });

  for (const type of ['task', 'board'] as const) {
    it(`draws a ${type} block as the board's own cards where the surface lent a board`, async () => {
      const { container, unmount } = await draw(FIXTURES[type] as string);
      expect(container.querySelectorAll(`[data-fy-card-embed="${type}"]`).length).toBe(1);
      await unmount();
    });
  }
});

describe('what is not a block stays plain code, with no error chrome', () => {
  const plain = async (text: string, withBoard = true) => {
    const { container, unmount } = await draw(text, withBoard);
    const result = {
      errors: container.querySelectorAll('.dh-error, [role="alert"], [data-dh-missing]').length,
      blocks: container.querySelectorAll('[data-fy-render-type], [data-fy-card-embed], iframe').length,
      code: container.querySelector('.code-block code')?.textContent ?? null,
    };
    await unmount();
    return result;
  };

  it('shows a malformed block (no boundary line) as the code it is', async () => {
    const result = await plain(block('type: html', '<script>failed()</script>'));
    expect(result).toEqual({ errors: 0, blocks: 0, code: 'type: html\n<script>failed()</script>' });
  });

  it('shows a fence opened as `fy-render notes` as code, though its body is a good block', async () => {
    const result = await plain(fence('fy-render notes', 'type: svg', 'alt: A square', '---', SQUARE));
    expect(result.errors).toBe(0);
    expect(result.blocks).toBe(0);
    expect(result.code).toContain('type: svg');
  });

  it('keeps the exact-token rule for every other spelling of the opener', async () => {
    for (const info of ['fy-render{#x}', 'fy-render title="a"', 'fy-render-notes']) {
      const result = await plain(fence(info, 'type: svg', 'alt: A square', '---', SQUARE));
      expect({ info, blocks: result.blocks }).toEqual({ info, blocks: 0 });
    }
  });

  it('leaves a task block a code fence where the surface lent no board', async () => {
    const result = await plain(FIXTURES.task as string, false);
    expect(result.errors).toBe(0);
    expect(result.blocks).toBe(0);
    expect(result.code).toContain('type: task');
  });

  it('draws nothing for a block read outside any ferret, only its code', async () => {
    const f = fixture();
    const mounted = await mount(
      inShell(
        <ReferenceSurfaceProvider surface={f.surface}>
          <HypermediaProse text={FIXTURES.svg as string} />
        </ReferenceSurfaceProvider>,
      ) as never,
    );
    await interact(() => Promise.resolve());
    expect(mounted.container.querySelectorAll('[data-fy-render-type], img').length).toBe(0);
    expect(mounted.container.querySelector('.code-block code')?.textContent).toContain('type: svg');
    await mounted.unmount();
  });

  it('draws a block of tildes as a block, and a tilde fence with metadata as code', async () => {
    const tildes = (info: string) => ['~~~' + info, 'type: svg', 'alt: A square', '---', SQUARE, '~~~'].join('\n');
    expect((await plain(tildes('fy-render'))).blocks).toBe(1);
    expect((await plain(tildes('fy-render notes'))).blocks).toBe(0);
  });
});

describe('the parser half is total and tells another agent what the block shows', () => {
  const source = block('type: svg', 'alt: A square', '---', SQUARE);

  it('reads its fence from the message it is built for, and never throws', () => {
    const doc = parse(source, { blocks: [fyRenderParseBlock(source)], frontMatter: false });
    const host = doc.blocks.find(b => b.type === 'host');
    expect(host?.data).toMatchObject({ ok: true, alt: 'A square' });
    expect(doc.problems).toEqual([]);
    expect(doc.llm).toContain('A square');
  });

  it('answers ok: false, not an error block, for a body the grammar refuses', () => {
    const bad = block('type: nope', '---', 'x');
    const doc = parse(bad, { blocks: [fyRenderParseBlock(bad)], frontMatter: false });
    expect(doc.blocks.map(b => b.type)).toEqual(['host']);
    expect(doc.problems).toEqual([]);
  });

  it('says why an opener is not exact, and nothing else', () => {
    expect(parseFyRenderBlock('```fy-render notes', 'x').ok).toBe(false);
    expect(parseFyRenderBlock(undefined, 'x').ok).toBe(false);
    expect(parseFyRenderBlock('  ~~~~ fy-render  ', 'type: nope\n---\nx').reason).not.toContain('exactly');
  });
});
