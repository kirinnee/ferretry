/**
 * r12 H1 — THE UPSTREAM ASKS (C1-upstream-ask.md items 1–8 and 10; 9 is the licence) VERIFIED AGAINST THE PINNED v0.5.1,
 * one assert each, before any later unit relies on them. Items 1–5 are rendered for real (react-dom/server) through the
 * renderer's own entry; 6–8 are read off the installed source and the bundle test's strict graph; the heading-slug rule
 * is Durian's against GitHub's.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parse } from 'durian-hypermedia';
import { configureDurian } from '../../../../app/hypermedia/durian.ts';

const root = dirname(
  createRequire(join(import.meta.dir, '../../../../package.json')).resolve('durian-hypermedia/package.json'),
);
const source = (path: string): string => readFileSync(join(root, path), 'utf8');

/** The renderer entry, imported by a computed specifier: the type checker reads our declarations, not Durian's source. */
interface DocumentModule {
  readonly DocumentView: (props: Record<string, unknown>) => ReactNode;
}
const { DocumentView } = (await import(['durian-hypermedia', 'react', 'document'].join('/'))) as DocumentModule;

const PAGE = [
  '# Title',
  '',
  'A [link](https://example.com/a) and `inline` code.',
  '',
  '```ts title="a.ts"',
  'const a = 1;',
  '```',
  '',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
  '',
].join('\n');

const render = (props: Record<string, unknown>): string => {
  configureDurian();
  return renderToStaticMarkup(
    createElement(DocumentView as never, { doc: parse(`\n${PAGE}`, { frontMatter: false }), ...props }),
  );
};

describe('C1 asks against durian-hypermedia v0.5.1', () => {
  it('ask 1: a Code slot draws a fenced block, given lang, text and meta', () => {
    const html = render({
      slots: {
        Code: ({ lang, text, meta }: { lang: string; text: string; meta: string }) =>
          createElement('i', { 'data-code': `${lang}|${text}|${meta}` }),
      },
    });
    expect(html).toContain('data-code="ts|const a = 1;|title=&quot;a.ts&quot;"');
  });

  it('ask 2: an InlineCode slot draws a code span', () => {
    const html = render({
      slots: { InlineCode: ({ text }: { text: string }) => createElement('i', { 'data-inline': text }) },
    });
    expect(html).toContain('data-inline="inline"');
  });

  it('ask 3: a Link slot draws every link, with href and external', () => {
    const html = render({
      slots: {
        Link: ({ href, external }: { href: string; external: boolean }) =>
          createElement('i', { 'data-href': href, 'data-ext': String(external) }),
      },
    });
    expect(html).toContain('data-href="https://example.com/a"');
    expect(html).toContain('data-ext="true"');
  });

  it('ask 4: a Table slot draws a table from parsed head and rows', () => {
    const html = render({
      slots: {
        Table: ({ headText, rows }: { headText: string[]; rows: unknown[][] }) =>
          createElement('i', { 'data-table': `${headText.join(',')}|${rows.length}` }),
      },
    });
    expect(html).toContain('data-table="a,b|1"');
  });

  it('ask 5: frontMatter:false keeps a leading --- block as text, and demoteHeadings lowers a heading', () => {
    const doc = parse('---\nk: v\n---\n\ntext', { frontMatter: false });
    expect(doc.frontMatter).toEqual({});
    expect(JSON.stringify(doc.blocks)).toContain('k: v');
    expect(render({ demoteHeadings: 1 })).toContain('<h2');
  });

  it('ask 6: no HTML-string sink anywhere in the package source (code-walk notes are React children)', () => {
    const walk = (dir: string): string[] =>
      Bun.spawnSync(['grep', '-rlE', 'dangerouslySetInnerHTML=|\\.innerHTML\\s*=|insertAdjacentHTML', join(root, dir)])
        .stdout.toString()
        .split('\n')
        .filter(Boolean);
    expect(walk('src')).toEqual([]);
    expect(source('src/ui/codewalk.tsx')).not.toContain('dangerouslySetInnerHTML');
  });

  it('ask 7: the host can swap mermaid out, and an entry exists that never imports it', () => {
    expect(source('src/react/context.tsx')).toMatch(/Mermaid\?:\s*React\.ComponentType<MermaidSlotProps>/u);
    const strict = source('src/react/strict.tsx');
    expect(strict).toContain('HostMermaidPart');
    expect(strict).not.toMatch(/from "\.\/mermaid"|from "mermaid"|dompurify/u);
    expect(source('src/react/mermaid-host.tsx')).not.toMatch(/import[^\n]*from "(?:mermaid|dompurify)"/u);
  });

  it('ask 8: the legacy `Tabs` with an html prop is gone', () => {
    expect(source('src/ui/parts.tsx')).not.toMatch(/\bhtml\b\s*[:?]|\bTabs\b/u);
  });

  it('ask 10: a tagged release with a CHANGELOG entry (and ask 9, the licence, is MIT)', () => {
    expect(source('CHANGELOG.md')).toMatch(/^## 0\.5\.1/mu);
    expect(source('LICENSE')).toContain('MIT License');
  });

  it('heading anchors follow GitHub’s slug rule (the in-app anchors and a table of contents must match)', () => {
    const doc = parse('\n# Hello, World!\n\n## Hello, World!\n\n### Ünï & more\n', {
      frontMatter: false,
      idPrefix: '',
    });
    expect(doc.headings.map(h => h.id)).toEqual(['hello-world', 'hello-world-1', 'ünï--more']);
  });
});
