/**
 * r12 H4 — the parts a message draws, under our policy. Drawn for real in happy-dom over a fake reference surface; the
 * Chromium evidence (CSP, Trusted Types, the real sinks, WebGL) is `hypermedia-csp.visual.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import { type ReferenceSurface, ReferenceSurfaceProvider } from '@ferretry/app';
import { interact, mount } from '@ferretry/app/testing';
import { resolve } from 'node:path';
import type { ReactNode } from 'react';
import { HypermediaProse } from '../../../../app/hypermedia/hypermedia-prose.tsx';
import { mustRead } from './must-read.ts';
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
  it('draws a file tree, an editor, a tier list, an alignment grid as Durian parts (tabs and accordion are held: held-fences.test.tsx)', async () => {
    const text = [
      fence('filetree', 'app/', '  main.ts  (new)'),
      fence('editor', 'file: a.ts', '---', 'const a = 1;'),
      fence('tierlist', 'S: [a, b]', 'A: [c]'),
      fence('alignment', 'x: [low, high]', 'y: [cheap, dear]', 'items:', '  - name: one', '    at: [0.2, 0.7]'),
    ].join('\n\n');
    const { container, unmount } = await draw(text);
    const parts = [...container.querySelectorAll('.dh-doc [data-dh-part]')].map(p => p.getAttribute('data-dh-part'));
    expect(parts).toContain('filetree');
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

describe('a mermaid fence is a host block of ours, drawn by our renderer (Durian 0.7.0 removed its part)', () => {
  const diagram = fence('mermaid', 'flowchart LR', '  A --> B');

  it('is read as a host block named mermaid, never a Durian part', () => {
    const { doc } = mustRead(diagram, 'p-');
    expect(doc.blocks).toMatchObject([{ type: 'host', name: 'mermaid' }]);
  });

  it('hands the source to the one fy-render door as a mermaid block, and draws what that returns', async () => {
    const asked: string[] = [];
    const { container, unmount } = await draw(diagram, surfaceWith(asked));
    expect(asked).toEqual(['type: mermaid\nalt: Mermaid diagram\n---\nflowchart LR\n  A --> B']);
    expect(container.querySelectorAll('[data-fy-render-type="mermaid"]').length).toBe(1);
    expect(container.querySelector('[data-fy-mermaid]')).not.toBeNull();
    expect(container.querySelector('[data-mermaid]')).toBeNull();
    await unmount();
  });

  it('draws a stepped diagram whole, once (a step line is a comment to mermaid)', async () => {
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
    expect(asked[0]).toContain('A --> B');
    expect(asked[0]).toContain('B --> C');
    expect(container.querySelector('.dg .btn-go')).toBeNull();
    await unmount();
  });

  it('drops a %%{...}%% directive line, as Durian 0.6.2 did, so a diagram cannot ask for settings of its own', async () => {
    const asked: string[] = [];
    const { unmount } = await draw(
      fence('mermaid', '%%{init: {"securityLevel": "loose"}}%%', 'flowchart LR', '  A --> B'),
      surfaceWith(asked),
    );
    expect(asked).toEqual(['type: mermaid\nalt: Mermaid diagram\n---\nflowchart LR\n  A --> B']);
    await unmount();
  });

  it('keeps a title on ONE header line, so it cannot add a header of its own', async () => {
    const asked: string[] = [];
    const { unmount } = await draw(
      fence('mermaid title="Then alt: other"', 'flowchart LR', '  A --> B'),
      surfaceWith(asked),
    );
    expect(asked.length).toBe(1);
    for (const body of asked) expect(body.split('\n').filter(line => line.startsWith('alt:')).length).toBe(1);
    await unmount();
  });

  it('keeps the author’s :::llm text as the disclosure beside the diagram', async () => {
    const asked: string[] = [];
    const { container, unmount } = await draw(
      [diagram, '', ':::llm', 'A flows to B.', ':::'].join('\n'),
      surfaceWith(asked),
    );
    const [only, ...others] = disclosures(container);
    expect(others).toEqual([]);
    expect(only?.querySelector('pre')?.textContent).toBe('A flows to B.');
    await unmount();
  });

  it('shows the source as code when the surface lent no fences (a reader outside a ferret)', async () => {
    const { container, unmount } = await draw(diagram, fixture().surface);
    expect(container.querySelector('.fy-hm-mermaid-source')?.textContent).toBe('flowchart LR\n  A --> B');
    expect(container.querySelector('svg.mermaid, .dh-doc [data-mermaid] svg')).toBeNull();
    await unmount();
  });
});

describe('only the entries of Durian that this app has reviewed reach it', () => {
  /**
   * `durian-markdown/react` and `react/strict` list EVERY part of the package, the folder parts' media players, pdf.js and map providers
   * included, and a bundler keeps them all (the first build of 0.7.0 was +550 KB gzip first load). The app imports the core (in the
   * worker), the stylesheet, the document view and, one entry each, the parts it draws; `react/strict` is for TYPES only (erased). A new
   * import of any other entry is this test failing, and a review.
   */
  const VALUE_ENTRIES = new Set([
    'durian-markdown',
    'durian-markdown/styles.css',
    'durian-markdown/react/document',
    'durian-markdown/react/terminal',
    'durian-markdown/react/filetree',
    'durian-markdown/react/editor',
    'durian-markdown/react/codewalk',
    'durian-markdown/react/animation',
    'durian-markdown/react/tierlist',
    'durian-markdown/react/alignment',
    'durian-markdown/react/containers',
  ]);
  const SPECIFIER = /(?:from|import\()\s*['"](durian-markdown[^'"]*)['"]/gu;
  const TYPE_ONLY = /import\s+type\b[^;]*?from\s*['"](durian-markdown[^'"]*)['"]/gu;
  const roots = ['app', 'tests'].map(folder => resolve(import.meta.dir, '../../../..', folder));
  const sourcesOf = (folder: string): string[] =>
    [...new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: folder, absolute: true })].filter(
      path => !path.includes('/node_modules/'),
    );

  it('imports no other entry of the package as a value, in any source or test of the Conversation plugin', async () => {
    const bad: string[] = [];
    for (const folder of roots)
      for (const path of sourcesOf(folder)) {
        const text = await Bun.file(path).text();
        const typeOnly = new Set([...text.matchAll(TYPE_ONLY)].map(match => match[0]));
        for (const match of text.matchAll(SPECIFIER)) {
          const specifier = match[1] ?? '';
          if (VALUE_ENTRIES.has(specifier)) continue;
          // `react/strict` and a type-only import of any entry are erased by the build and never reach the page.
          const erased = [...typeOnly].some(statement => statement.includes(specifier));
          if (erased && specifier === 'durian-markdown/react/strict') continue;
          bad.push(`${path.split('/plugins/conversation/')[1]}: ${specifier}`);
        }
      }
    expect(bad).toEqual([]);
  });
});
