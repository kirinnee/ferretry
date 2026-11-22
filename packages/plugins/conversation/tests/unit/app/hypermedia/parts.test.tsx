/**
 * r12 H4 — the parts a message draws, under our policy. Drawn for real in happy-dom over a fake reference surface; the
 * Chromium evidence (CSP, Trusted Types, the real sinks, WebGL) is `hypermedia-csp.visual.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import { type ReferenceSurface, ReferenceSurfaceProvider } from '@ferretry/app';
import { interact, mount, must } from '@ferretry/app/testing';
import { resolve } from 'node:path';
import type { ReactNode } from 'react';
import { HypermediaProse } from '../../../../app/hypermedia/hypermedia-prose.tsx';
import { fixture, inShell } from './surface-fixture.tsx';

const FENCE = '`'.repeat(3);
const fence = (info: string, ...body: readonly string[]): string => [`${FENCE}${info}`, ...body, FENCE].join('\n');
const llm = (...body: readonly string[]): string => [':::llm', ...body, ':::'].join('\n');
const disclosures = (root: ParentNode): Element[] => [...root.querySelectorAll('details[data-fy-llm-only]')];

/** A surface whose fences record what they were asked to draw (the mermaid slot's one door), and draw a marker. */
const surfaceWith = (drawn: string[]): ReferenceSurface => {
  const f = fixture();
  return {
    ...f.surface,
    fences: {
      draw: ({ node }): ReactNode => {
        // The fence node holds one `<code>` element with one text child: the body the reader would read.
        const code = node?.children?.[0] as { children?: readonly { value?: string }[] } | undefined;
        drawn.push((code?.children?.[0]?.value ?? '').replace(/\n$/u, ''));
        return <div data-fy-render-type="mermaid">drawn</div>;
      },
    },
  };
};

const draw = async (text: string, surface = fixture().surface) => {
  const tree = inShell(
    <ReferenceSurfaceProvider surface={surface}>
      <HypermediaProse text={text} />
    </ReferenceSurfaceProvider>,
  ) as ReactNode;
  const mounted = await mount(tree as never);
  await interact(() => Promise.resolve());
  return mounted;
};

describe('the parts a message draws', () => {
  it('draws a file tree, an editor, a tier list, an alignment grid and an accordion as Durian parts (tabs are held: held-fences.test.tsx)', async () => {
    const text = [
      fence('filetree', 'app/', '  main.ts  (new)'),
      fence('editor', 'file: a.ts', '---', 'const a = 1;'),
      fence('tierlist', 'S: [a, b]', 'A: [c]'),
      fence('alignment', 'x: [low, high]', 'y: [cheap, dear]', 'items:', '  - name: one', '    at: [0.2, 0.7]'),
      [':::accordion', '#### One', 'first', '#### Two', 'second', ':::'].join('\n'),
    ].join('\n\n');
    const { container, unmount } = await draw(text);
    const parts = [...container.querySelectorAll('.dh-doc [data-dh-part]')].map(p => p.getAttribute('data-dh-part'));
    expect(parts).toContain('filetree');
    expect(container.querySelectorAll('.dh-doc .accordion details').length).toBe(2);
    expect(container.querySelector('[data-dh-missing]')).toBeNull();
    await unmount();
  });

  it('does not draw a code walk: it is the text an LLM reads, with no part and no error', async () => {
    const { container, unmount } = await draw(
      fence('codewalk', '- file: src/api.ts', '  note: the entry point'),
      fixture().surface,
    );
    expect(container.querySelector('.dh-doc .cw, .dh-doc [data-dh-part="codewalk"] .cw')).toBeNull();
    expect(container.querySelector('.dh-error')).toBeNull();
    await unmount();
  });
});

describe('an author’s :::llm text is the disclosure beside a part, never the part’s own text (C7)', () => {
  for (const [name, part] of [
    ['filetree', fence('filetree', 'app/', '  main.ts')],
    ['tierlist', fence('tierlist', 'S: [a]')],
    ['tabs', [':::tabs', '#### A', 'one', '#### B', 'two', ':::'].join('\n')],
    ['chart', fence('chart', 'type: bar', 'x: [a, b]', 'series:', '  - name: s', '    data: [1, 2]')],
    ['codewalk', fence('codewalk', '- file: src/api.ts', '  note: entry')],
  ] as const)
    it(`${name}: shown collapsed as "LLM-only text", and not poured into a fallback box`, async () => {
      const { container, unmount } = await draw([part, '', llm(`About the ${name}.`)].join('\n'));
      const [only, ...rest] = disclosures(container);
      expect(rest).toEqual([]);
      expect((only as HTMLDetailsElement).open).toBe(false);
      expect(only?.querySelector('summary')?.textContent).toBe('LLM-only text');
      expect(only?.querySelector('pre')?.textContent).toBe(`About the ${name}.`);
      // The author's text is nowhere else: not in a `pre[data-dh-missing]` standing in for the part.
      expect(container.querySelector('pre[data-dh-missing]')?.textContent ?? '').not.toContain(`About the ${name}.`);
      await unmount();
    });
});

describe('a mermaid part is drawn by our renderer', () => {
  const diagram = fence('mermaid', 'flowchart LR', '  A --> B');

  it('hands each step to the one fy-render door as a mermaid block, and draws what that returns', async () => {
    const asked: string[] = [];
    const { container, unmount } = await draw(diagram, surfaceWith(asked));
    expect(asked).toEqual(['type: mermaid\nalt: Mermaid diagram\n---\nflowchart LR\n  A --> B']);
    expect(container.querySelectorAll('[data-fy-render-type="mermaid"]').length).toBe(1);
    // Durian's own mermaid library is not in the page: its host-drawn part says so.
    expect(container.querySelector('[data-dh-mermaid="host"]')).not.toBeNull();
    expect(container.querySelector('[data-mermaid]')).toBeNull();
    await unmount();
  });

  it('starts a step only when it is first shown (a stepped diagram is not a frame per step)', async () => {
    const asked: string[] = [];
    const steps = fence(
      'mermaid',
      'flowchart LR',
      '%% @step First arrow',
      '  A --> B',
      '%% @step Second arrow',
      '  B --> C',
    );
    const { container, unmount } = await draw(steps, surfaceWith(asked));
    expect(asked.length).toBe(1);
    expect(asked[0]).toContain('alt: First arrow');
    expect(asked[0]).toContain('A --> B');
    const next = must(container.querySelector<HTMLButtonElement>('.dg .btn-go:not(:disabled)'), 'the next-step button');
    await interact(() => next.click());
    expect(asked.length).toBe(2);
    expect(asked[1]).toContain('B --> C');
    await unmount();
  });

  it('keeps a step title on ONE header line, so it cannot add a header of its own', async () => {
    const asked: string[] = [];
    const { unmount } = await draw(
      fence('mermaid', 'flowchart LR', '%% @step Then alt: other', '  A --> B'),
      surfaceWith(asked),
    );
    for (const body of asked) expect(body.split('\n').filter(line => line.startsWith('alt:')).length).toBe(1);
    await unmount();
  });

  it('shows the source as code when the surface lent no fences (a reader outside a ferret)', async () => {
    const { container, unmount } = await draw(diagram, fixture().surface);
    expect(container.querySelector('.fy-hm-mermaid-source')?.textContent).toBe('flowchart LR\n  A --> B');
    expect(container.querySelector('svg.mermaid, .dh-doc [data-mermaid] svg')).toBeNull();
    await unmount();
  });
});

describe('only the strict entry of Durian reaches the app', () => {
  /**
   * `durian-hypermedia/react` (the full entry) draws mermaid in the page with DOMPurify and an HTML-string sink, which the
   * page's Trusted Types policy refuses. The app imports the core, the strict entry and the stylesheet, and nothing else:
   * a new import of any other entry is this test failing, and a review.
   */
  const ALLOWED = new Set(['durian-hypermedia', 'durian-hypermedia/react/strict', 'durian-hypermedia/styles.css']);
  const SPECIFIER = /(?:from|import\()\s*['"](durian-hypermedia[^'"]*)['"]/gu;
  const roots = ['app', 'tests'].map(folder => resolve(import.meta.dir, '../../../..', folder));
  const sourcesOf = (folder: string): string[] =>
    [...new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: folder, absolute: true })].filter(
      path => !path.includes('/node_modules/'),
    );

  it('imports no other entry of the package, in any source or test of the Conversation plugin', async () => {
    const bad: string[] = [];
    for (const folder of roots)
      for (const path of sourcesOf(folder)) {
        const text = await Bun.file(path).text();
        for (const match of text.matchAll(SPECIFIER))
          if (!ALLOWED.has(match[1] ?? '')) bad.push(`${path.split('/plugins/conversation/')[1]}: ${match[1]}`);
      }
    expect(bad).toEqual([]);
  });
});
