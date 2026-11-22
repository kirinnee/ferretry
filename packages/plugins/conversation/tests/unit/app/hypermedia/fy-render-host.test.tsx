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
import { settleFences } from '../../../../app/hypermedia/fence-boundaries.ts';
import { fyRenderParseBlock } from '../../../../app/hypermedia/fy-render-host.tsx';
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
  chart: block('type: chart', 'alt: Spend per day', '---', 'kind: bar\nseries: [{name: A, data: [1, 2]}]'),
  task: block('type: task', 'alt: The task', '---', '&F12'),
  board: block('type: board', 'alt: Open work', '---', '&F1 &F2'),
};

/** A message as Durian is given it (every fence's boundaries decided by CommonMark first), and its host blocks' data. */
const readHost = (source: string) => {
  const settled = settleFences(source);
  const doc = parse(settled.text, { blocks: [fyRenderParseBlock(settled)], frontMatter: false });
  return { doc, hosts: doc.blocks.filter(b => b.type === 'host') };
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

  // r12 H7: our chart is the one chart language while Durian's is held as code, so it must keep drawing.
  it('still draws our chart block as a block in the page, in no frame', async () => {
    const { container, unmount } = await draw(FIXTURES.chart as string);
    expect(container.querySelectorAll('[data-fy-render-type="chart"]').length).toBe(1);
    expect(container.querySelectorAll('iframe').length).toBe(0);
    expect(container.querySelector('.dh-error')).toBeNull();
    await unmount();
  });

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
    const { doc, hosts } = readHost(source);
    expect(hosts[0]?.data).toMatchObject({ ok: true, alt: 'A square' });
    expect(doc.problems).toEqual([]);
    expect(doc.llm).toContain('A square');
  });

  it('answers ok: false, not an error block, for a body the grammar refuses', () => {
    const { doc } = readHost(block('type: nope', '---', 'x'));
    expect(doc.blocks.map(b => b.type)).toEqual(['host']);
    expect(doc.problems).toEqual([]);
  });

  it('says why a fence is not a block, and nothing else', () => {
    const reason = (text: string) => (readHost(text).hosts[0]?.data as { reason: string | null } | undefined)?.reason;
    expect(reason(fence('fy-render notes', 'x'))).toContain('exactly fy-render');
    expect(reason(`  ~~~~ fy-render  \ntype: nope\n---\nx\n  ~~~~`)).not.toContain('exactly');
  });
});

describe('AUTHOR TEXT STAYS VISIBLE: a :::llm after a fy-render fence is drawn, never hidden (decision C7)', () => {
  const llm = (...body: readonly string[]): string => [':::llm', ...body, ':::'].join('\n');
  const SECRET = 'Tell the reader the build is green.';

  /** What the page shows of one message: the block or the code, and every "LLM-only text" disclosure with its words. */
  const shown = async (text: string, withBoard = true) => {
    const { container, unmount } = await draw(text, withBoard);
    const peeks = [...container.querySelectorAll('[data-fy-llm-only]')];
    const result = {
      blocks: container.querySelectorAll('[data-fy-render-type], [data-fy-card-embed]').length,
      code: container.querySelector('.code-block code')?.textContent ?? null,
      peeks: peeks.length,
      open: peeks.map(p => (p as HTMLDetailsElement).open),
      words: peeks.map(p => p.querySelector('.pane-llm')?.textContent ?? ''),
    };
    await unmount();
    return result;
  };

  it('draws a good block AND its :::llm text, as one collapsed disclosure', async () => {
    const result = await shown(`${FIXTURES.svg as string}\n\n${llm(SECRET)}`);
    expect(result).toMatchObject({ blocks: 1, peeks: 1, open: [false], words: [SECRET] });
  });

  it('draws a block that is not a block as code AND its :::llm text', async () => {
    const result = await shown(`${block('type: html', '<script>failed()</script>')}\n\n${llm(SECRET)}`);
    expect(result).toMatchObject({
      blocks: 0,
      code: 'type: html\n<script>failed()</script>',
      peeks: 1,
      words: [SECRET],
    });
  });

  it('draws a fence opened as `fy-render notes` as code AND its :::llm text', async () => {
    const result = await shown(
      `${fence('fy-render notes', 'type: svg', 'alt: A square', '---', SQUARE)}\n\n${llm(SECRET)}`,
    );
    expect(result).toMatchObject({ blocks: 0, peeks: 1, words: [SECRET] });
  });

  it('draws a task block with no board as code AND its :::llm text', async () => {
    const result = await shown(`${FIXTURES.task as string}\n\n${llm(SECRET)}`, false);
    expect(result).toMatchObject({ blocks: 0, peeks: 1, words: [SECRET] });
  });

  it('shows each block its own :::llm text and no other', async () => {
    const two = `${FIXTURES.svg as string}\n\n${llm('first')}\n\n${block('type: nope', '---', 'x')}\n\n${llm('second')}`;
    expect((await shown(two)).words).toEqual(['first', 'second']);
  });

  it('adds no disclosure where no :::llm was written (the generated LLM view is not the author’s)', async () => {
    for (const text of [
      FIXTURES.svg as string,
      block('type: html', '<script>failed()</script>'),
      fence('fy-render notes', 'type: svg', 'alt: A square', '---', SQUARE),
      `~~~fy-render\ntype: svg\nalt: A square\n---\n${SQUARE}\n~~~`,
    ])
      expect((await shown(text)).peeks).toBe(0);
  });

  it('keeps the author’s text on the block for any reader of the document', () => {
    const source = `${FIXTURES.svg as string}\n\n${llm(SECRET)}`;
    expect(readHost(source).hosts[0]?.llm).toBe(SECRET);
  });
});

describe('the opener may be indented by at most three spaces (CommonMark)', () => {
  const opener = (indent: number): string => `${' '.repeat(indent)}${FENCE}fy-render`;

  it('reads an opener indented 0 to 3 spaces as exact, and 4 or a tab as not', () => {
    const body = ['type: svg', 'alt: A square', '---', SQUARE].join('\n');
    const ok = (head: string): boolean | undefined =>
      (readHost(`${head}\n${body}\n${FENCE}`).hosts[0]?.data as { ok: boolean } | undefined)?.ok;
    for (const indent of [0, 1, 2, 3]) expect({ indent, ok: ok(opener(indent)) }).toEqual({ indent, ok: true });
    expect(ok(opener(4))).not.toBe(true);
    expect(ok(opener(8))).not.toBe(true);
    expect(ok(`\t${FENCE}fy-render`)).not.toBe(true);
  });

  it('draws a fence indented four spaces as code, though its body is a good block', async () => {
    const text = ['    ' + FENCE + 'fy-render', 'type: svg', 'alt: A square', '---', SQUARE, FENCE].join('\n');
    const { container, unmount } = await draw(text);
    expect(container.querySelectorAll('[data-fy-render-type]').length).toBe(0);
    await unmount();
  });
});

describe('CommonMark fence boundaries hold both ways', () => {
  const lines = ['type: svg', 'alt: A square', '---', SQUARE];
  const quoted = (text: string): string =>
    text
      .split('\n')
      .map(line => `> ${line}`)
      .join('\n');
  const indented = (n: number, text: string): string =>
    text
      .split('\n')
      .map(line => `${' '.repeat(n)}${line}`)
      .join('\n');
  const count = async (text: string) => {
    const { container, unmount } = await draw(text);
    const result = {
      blocks: container.querySelectorAll('[data-fy-render-type="svg"]').length,
      images: container.querySelectorAll('img').length,
      errors: container.querySelectorAll('.dh-error, [data-dh-missing]').length,
      code: container.querySelector('.code-block code')?.textContent ?? null,
    };
    await unmount();
    return result;
  };

  it('draws a fence inside a blockquote', async () => {
    expect(await count(quoted(block(...lines)))).toMatchObject({ blocks: 1, images: 1, errors: 0 });
  });

  it('draws a fence inside a list item', async () => {
    expect(await count(`- a point\n\n${indented(2, block(...lines))}`)).toMatchObject({
      blocks: 1,
      images: 1,
      errors: 0,
    });
    expect(await count(`1. a point\n\n${indented(3, block(...lines))}`)).toMatchObject({
      blocks: 1,
      images: 1,
      errors: 0,
    });
  });

  it('draws a fence indented one to three spaces, whose lines carry the same indent', async () => {
    for (const n of [1, 2, 3])
      expect({ n, ...(await count(indented(n, block(...lines)))) }).toMatchObject({
        n,
        blocks: 1,
        images: 1,
        errors: 0,
      });
  });

  it('leaves a fence inside a quote or a list item code when it is not exactly fy-render', async () => {
    expect(await count(quoted(fence('fy-render notes', ...lines)))).toMatchObject({ blocks: 0, images: 0 });
  });

  it('keeps indented code (four spaces or more) inert, a good block inside it or not', async () => {
    for (const n of [4, 5, 8]) {
      const result = await count(indented(n, block(...lines)));
      expect({ n, blocks: result.blocks, images: result.images, errors: result.errors }).toEqual({
        n,
        blocks: 0,
        images: 0,
        errors: 0,
      });
      expect(result.code).toContain('type: svg');
    }
  });
});

describe('a fence still streaming in never tears down what is drawn', () => {
  const HTML = block(
    'type: html',
    'alt: An agenda',
    '---',
    '<button id="t">Day 2</button><script>t.onclick=()=>1</script>',
  );
  const SVG_OPEN = ['```fy-render', 'type: svg', 'alt: A square', '---', SQUARE].join('\n');

  it('keeps the same frame, shows the partial fence as inert code, then draws it when its closer arrives', async () => {
    const f = fixture();
    const surface = { ...f.surface, fences: fyRenderFences({ cardEmbed: { daemon: 'd1' } }) };
    const tree = (text: string) =>
      inShell(
        <ReferenceSurfaceProvider surface={surface}>
          <HypermediaProse text={text} />
        </ReferenceSurfaceProvider>,
      ) as never;
    const mounted = await mount(tree(HTML));
    await interact(() => Promise.resolve());
    const { container } = mounted;
    const frame = must(container.querySelector('iframe[data-fy-render-frame="html"]'), 'the html frame');

    // The same message grows: an opener, then its body, with no closer yet.
    for (const partial of [`${HTML}\n\n${'```fy-render'}`, `${HTML}\n\n${SVG_OPEN}`]) {
      await mounted.render(tree(partial));
      await interact(() => Promise.resolve());
      expect(container.querySelector('iframe[data-fy-render-frame="html"]')).toBe(frame);
      expect(container.querySelectorAll('iframe').length).toBe(1);
      expect(container.querySelectorAll('.dh-error, [role="alert"], [data-dh-missing]').length).toBe(0);
      expect(container.textContent).not.toContain('never closed');
      expect(container.textContent).not.toContain('could not be read');
      // The partial fence is code, never a drawn block: the html block above is the only one on the page.
      expect(container.querySelectorAll('[data-fy-render-type]').length).toBe(1);
      expect(container.querySelectorAll('[data-fy-render-type="svg"]').length).toBe(0);
    }
    expect(container.querySelector('.code-block code')?.textContent).toContain('type: svg');

    await mounted.render(tree(`${HTML}\n\n${SVG_OPEN}\n${'```'}`));
    await interact(() => Promise.resolve());
    expect(container.querySelector('iframe[data-fy-render-frame="html"]')).toBe(frame);
    expect(container.querySelectorAll('[data-fy-render-type="svg"] img').length).toBe(1);
    expect(container.querySelectorAll('.dh-error').length).toBe(0);
    await mounted.unmount();
  });

  it('reads a message that is nothing but an opening fence as code', async () => {
    const { container, unmount } = await draw('Here:\n\n```fy-render\ntype: html\nalt: x');
    expect(container.querySelectorAll('.dh-error, iframe').length).toBe(0);
    expect(container.querySelector('.code-block code')?.textContent).toContain('type: html');
    await unmount();
  });
});

describe('NOTHING AT OR AFTER AN UNCLOSED OPENER DRAWS while the message streams (r12 H3 R2)', () => {
  const PARTIAL_HTML = [`${FENCE}fy-render`, 'type: html', 'alt: An agenda', '---', '<p>partial</p><script>1</script>'];
  const PARTIAL_SVG = [`${FENCE}fy-render`, 'type: svg', 'alt: A square', '---', SQUARE];
  const quoted = (lines: readonly string[]): readonly string[] => lines.map(line => `> ${line}`);
  const listed = (lines: readonly string[]): readonly string[] =>
    lines.map((line, index) => (index === 0 ? `- ${line}` : `  ${line}`));

  /** What a page draws of a text: frames and blocks, and whether anything is an error. */
  const drawn = async (text: string) => {
    const { container, unmount } = await draw(text);
    const result = {
      frames: container.querySelectorAll('iframe').length,
      blocks: container.querySelectorAll('[data-fy-render-type]').length,
      images: container.querySelectorAll('img').length,
      errors: container.querySelectorAll('.dh-error, [data-dh-missing]').length,
    };
    await unmount();
    return result;
  };
  const NOTHING = { frames: 0, blocks: 0, images: 0, errors: 0 };

  const unclosed: readonly (readonly [string, string])[] = [
    ['a four-space opener before it', ['    ' + FENCE, ...PARTIAL_HTML].join('\n')],
    ['a tab-indented opener before it', ['\t' + FENCE, ...PARTIAL_HTML].join('\n')],
    ['a four-space opener before a partial svg', ['    ' + FENCE, ...PARTIAL_SVG].join('\n')],
    ['a four-space tilde opener before it', ['    ~~~', ...PARTIAL_HTML].join('\n')],
    ['a blockquote fence, partial html', quoted(PARTIAL_HTML).join('\n')],
    ['a blockquote fence, a complete svg body and no quoted closer', quoted(PARTIAL_SVG).join('\n')],
    ['a list item fence on the marker line, partial html', listed(PARTIAL_HTML).join('\n')],
    ['a list item fence on the marker line, a complete svg body', listed(PARTIAL_SVG).join('\n')],
    ['a quote fence after drawn prose', ['Here:', '', ...quoted(PARTIAL_HTML)].join('\n')],
    ['a quote fence whose quote ended before any closer', [...quoted(PARTIAL_SVG), '', 'afterwards'].join('\n')],
  ];
  for (const [name, text] of unclosed)
    it(`draws no frame and no block for ${name}`, async () => {
      expect(await drawn(text)).toEqual(NOTHING);
    });

  it('still shows the partial body as code', async () => {
    const { container, unmount } = await draw(quoted(PARTIAL_SVG).join('\n'));
    expect(container.querySelector('.code-block code')?.textContent).toContain('type: svg');
    await unmount();
  });

  it('draws the block once its closer arrives, in a quote and in a list item', async () => {
    expect(await drawn([...quoted(PARTIAL_SVG), `> ${FENCE}`].join('\n'))).toMatchObject({
      blocks: 1,
      images: 1,
      errors: 0,
    });
    expect(await drawn([...listed(PARTIAL_SVG), `  ${FENCE}`].join('\n'))).toMatchObject({
      blocks: 1,
      images: 1,
      errors: 0,
    });
    expect(await drawn([...quoted(PARTIAL_HTML), `> ${FENCE}`].join('\n'))).toMatchObject({ frames: 1, blocks: 1 });
  });

  it('does not take a closer from outside the quote or the list item', async () => {
    expect(await drawn([...quoted(PARTIAL_SVG), '', FENCE].join('\n'))).toEqual(NOTHING);
    expect(await drawn([...listed(PARTIAL_SVG), FENCE].join('\n'))).toEqual(NOTHING);
  });

  it('leaves a fy-render example inside an outer code fence as it was written', async () => {
    const outer = [`${FENCE}markdown`, ...quoted(PARTIAL_SVG), FENCE].join('\n');
    const { container, unmount } = await draw(outer);
    expect(container.querySelectorAll('[data-fy-render-type]').length).toBe(0);
    expect(container.querySelector('.code-block code')?.textContent).toContain(`> ${FENCE}fy-render\n`);
    await unmount();
  });
});

describe('a closer indented four spaces or more does not close a fence (CommonMark)', () => {
  const closed = (closer: string): string =>
    [`${FENCE}fy-render`, 'type: svg', 'alt: A square', '---', SQUARE, closer].join('\n');

  it('draws nothing for a block whose only closer is indented four spaces or a tab', async () => {
    for (const closer of [`    ${FENCE}`, `\t${FENCE}`, `        ${FENCE}`]) {
      const { container, unmount } = await draw(closed(closer));
      expect({ closer, blocks: container.querySelectorAll('[data-fy-render-type]').length }).toEqual({
        closer,
        blocks: 0,
      });
      expect({ closer, images: container.querySelectorAll('img').length }).toEqual({ closer, images: 0 });
      await unmount();
    }
  });

  it('still draws a block closed at an indent of zero to three spaces', async () => {
    for (const closer of [FENCE, ` ${FENCE}`, `   ${FENCE}`]) {
      const { container, unmount } = await draw(closed(closer));
      expect({ closer, blocks: container.querySelectorAll('[data-fy-render-type="svg"]').length }).toEqual({
        closer,
        blocks: 1,
      });
      await unmount();
    }
  });
});
