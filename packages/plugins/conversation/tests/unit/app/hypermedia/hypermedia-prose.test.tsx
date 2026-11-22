/**
 * r12 H2 — `HypermediaProse`: an assistant message read through Durian Hypermedia, with Ferretry's own references,
 * proof gate and click behaviour. Every assertion draws the REAL component in a real DOM (happy-dom) over a fake
 * reference surface (`./surface-fixture.tsx`); nothing reads a network or a real home.
 */
import { describe, expect, it } from 'bun:test';
import { Markdown, ReferenceSurfaceProvider } from '@ferretry/app';
import { interact, mount, must } from '@ferretry/app/testing';
import type { ReactNode } from 'react';
import { DemotingProse } from '../../../../app/hypermedia/demoting-prose.tsx';
import { HypermediaProse } from '../../../../app/hypermedia/hypermedia-prose.tsx';
import { fixture, inShell } from './surface-fixture.tsx';

const FENCE = '`'.repeat(3);
const fence = (info: string, ...body: readonly string[]): string => [`${FENCE}${info}`, ...body, FENCE].join('\n');

const prose = (text: string, f = fixture()) => ({
  f,
  tree: inShell(
    <ReferenceSurfaceProvider surface={f.surface}>
      <HypermediaProse text={text} />
    </ReferenceSurfaceProvider>,
  ) as ReactNode,
});

const draw = async (text: string, f = fixture()) => {
  const { tree } = prose(text, f);
  const mounted = await mount(tree as never);
  await interact(() => Promise.resolve());
  return { ...mounted, f };
};

const anchorTexts = (root: ParentNode): string[] =>
  [...root.querySelectorAll('a[data-fy-reference]')].map(a => a.textContent ?? '');

describe('a part in an assistant message', () => {
  it('draws a terminal fence as a Durian terminal', async () => {
    const { container, unmount } = await draw(
      ['Run it:', '', fence('terminal', '$ bun test', 'ok 3 tests')].join('\n'),
    );
    expect(container.querySelectorAll('.dh-doc .term').length).toBe(1);
    expect(container.querySelector('.dh-doc .term .term-body[role="log"]')).not.toBeNull();
    await unmount();
  });
});

describe('the reference grammar is the app grammar: parity with the Markdown reader', () => {
  /** Every case of the existing grammar tests (`packages/app/tests/unit/references/grammar.test.ts`, `markdown.test.tsx`) that goes through prose. */
  const CORPUS: readonly string[] = [
    'Ping :zelda about @src/api.ts:12 and @missing.ts, then &F12 or &F99.',
    'see &F12 now',
    '@src/api.ts @src/api.ts:12 @src/api.ts:12-20',
    'ask :zelda about ^A3',
    'the old !A3 is still read',
    'bob@example.com stays an address',
    'write \\:zelda to name an agent',
    '\\:zelda names :zelda',
    '> ping :zelda\n> and \\&F12\n',
    '&amp; then :zelda',
    'discount is 50% off, and $HOME stays a shell word',
    'run /deploy now, or $deploy',
    '/etc/hosts and /usr/bin are paths, not skills',
    'watch %terminal:live now',
    'use %terminal:gone please',
    'maybe %terminal:other',
    '**bold :zelda** and _emph &F12_ and ~~gone ^A3~~',
    '- item :zelda\n- item &F12\n\n1. step ^A3',
    '| a | b |\n| - | - |\n| :zelda | &F12 |',
    '> **Note:** see &F12',
    '[link :zelda](https://example.com) and :zelda',
    'a`:zelda`b :zelda `&F12`',
    'x\\\\:zelda',
    'path\\_to @src/api.ts and @src/a\\_b.ts',
    '# Heading :zelda\n\nbody &F12',
    '(:zelda) [&F12] "^A3" and, :zelda.',
  ];

  const tokensOf = async (element: ReactNode): Promise<string[]> => {
    const mounted = await mount(element as never);
    await interact(() => Promise.resolve());
    await interact(() => new Promise(resolve => setTimeout(resolve, 0)));
    const tokens = [...mounted.container.querySelectorAll('a[data-fy-reference], del[data-fy-reference-closed]')].map(
      node => `${node.tagName.toLowerCase()}:${node.textContent}`,
    );
    await mounted.unmount();
    return tokens;
  };

  for (const text of CORPUS) {
    it(`gives the same tokens for ${JSON.stringify(text)}`, async () => {
      const f = fixture();
      const old = await tokensOf(inShell(<Markdown {...f.surface} text={text} />));
      const next = await tokensOf(prose(text, fixture()).tree);
      expect(next).toEqual(old);
    });
  }

  it('is not an empty comparison: the corpus links something', async () => {
    const f = fixture();
    const tokens = await tokensOf(inShell(<Markdown {...f.surface} text={CORPUS[0] as string} />));
    expect(tokens.length).toBeGreaterThanOrEqual(3);
  });
});

describe('proof before link', () => {
  it('links a proved reference and leaves an unproved one as text', async () => {
    const { container, unmount } = await draw('look at &F12 and &F99999');
    expect(anchorTexts(container)).toEqual(['&F12']);
    expect(container.textContent).toContain('&F99999');
    await unmount();
  });

  it('opens what a click asks for, and ignores a modified click', async () => {
    const { container, f, unmount } = await draw('look at &F12');
    const a = must(container.querySelector('a[data-fy-reference]'), 'the proved task link');
    await interact(() => a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })));
    await interact(() =>
      a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true })),
    );
    expect(f.opened.tasks).toEqual(['F12']);
    await unmount();
  });

  it('makes the click inert once the resolver stops proving it', async () => {
    const { container, f, unmount } = await draw('look at &F12');
    const a = must(container.querySelector('a[data-fy-reference]'), 'the proved task link');
    f.gone.task = true;
    await interact(() => a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })));
    expect(f.opened.tasks).toEqual([]);
    await unmount();
  });

  it('paints text again when a re-render finds the reference no longer proved', async () => {
    const f = fixture();
    const { tree } = prose('look at &F12', f);
    const mounted = await mount(tree as never);
    await interact(() => Promise.resolve());
    expect(anchorTexts(mounted.container)).toEqual(['&F12']);
    f.gone.task = true;
    // A fleet or board change rebuilds the surface: a new object, the same resolvers, now answering differently.
    await mounted.render(prose('look at &F12', { ...f, surface: { ...f.surface } }).tree as never);
    expect(anchorTexts(mounted.container)).toEqual([]);
    expect(mounted.container.textContent).toContain('&F12');
    await mounted.unmount();
  });

  it('draws a proved-closed surface as an inert tombstone', async () => {
    const { container, unmount } = await draw('the shell %terminal:gone ended');
    const tomb = must(container.querySelector('del[data-fy-reference-closed]'), 'the tombstone');
    expect(tomb.textContent).toBe('%terminal:gone');
    expect(container.querySelector('a[data-fy-reference]')).toBeNull();
    await unmount();
  });

  it('proves an @file once for the whole message, then links it', async () => {
    let listings = 0;
    const f = fixture();
    const resolve = f.surface.resolveFilePaths;
    const counted = {
      ...f.surface,
      resolveFilePaths: (c: readonly string[], s: AbortSignal) => (listings++, resolve?.(c, s) as never),
    };
    const { tree } = prose('@src/api.ts and again @src/api.ts:3 and @src/api.ts:9-12', { ...f, surface: counted });
    const mounted = await mount(tree as never);
    await interact(() => new Promise(r => setTimeout(r, 0)));
    expect(anchorTexts(mounted.container)).toEqual(['@src/api.ts', '@src/api.ts:3', '@src/api.ts:9-12']);
    expect(listings).toBe(1);
    await mounted.unmount();
  });

  it('proves references inside code spans and fences, keeping the code byte for byte', async () => {
    const { container, unmount } = await draw(['`ask :zelda`', '', fence('ts', 'const a = "&F12";')].join('\n'));
    expect(anchorTexts(container)).toEqual([':zelda', '&F12']);
    const code = [...container.querySelectorAll('code')].map(c => c.textContent);
    expect(code).toEqual(['ask :zelda', 'const a = "&F12";']);
    await unmount();
  });

  it('colours a fenced language through the shared registry, with no HTML string handed to the DOM', async () => {
    const { container, unmount } = await draw(fence('ts', 'const a = 1;'));
    expect(container.querySelectorAll('.dh-doc pre code span[class^="hljs-"]').length).toBeGreaterThan(0);
    expect(container.querySelector('pre code')?.textContent).toBe('const a = 1;');
    await unmount();
  });
});

describe('author text for an LLM stays visible (decision C7)', () => {
  const llm = (...body: readonly string[]): string => [':::llm', ...body, ':::'].join('\n');
  const disclosures = (root: ParentNode): Element[] => [...root.querySelectorAll('details[data-fy-llm-only]')];

  it('draws a terminal AND its :::llm text as a collapsed "LLM-only text" disclosure', async () => {
    const { container, unmount } = await draw(
      [fence('terminal', '$ bun test', 'ok'), '', llm('Tests pass: 3 of 3.')].join('\n'),
    );
    expect(container.querySelectorAll('.dh-doc .term').length).toBe(1);
    const [only, ...rest] = disclosures(container);
    expect(rest).toEqual([]);
    expect((only as HTMLDetailsElement).open).toBe(false);
    expect(only?.querySelector('summary')?.textContent).toBe('LLM-only text');
    expect(only?.querySelector('pre')?.textContent).toBe('Tests pass: 3 of 3.');
    await unmount();
  });

  it('adds no disclosure to a terminal that has no :::llm text (its generated LLM view is not the author’s)', async () => {
    const { container, unmount } = await draw(fence('terminal', '$ bun test', 'ok'));
    expect(disclosures(container)).toEqual([]);
    await unmount();
  });

  it('draws the body of a :::human llm=none segment', async () => {
    const { container, unmount } = await draw([':::human llm=none', 'Only people read **this**.', ':::'].join('\n'));
    const human = must(container.querySelector('section.human'), 'the human segment');
    expect(human.textContent).toContain('Only people read this.');
    expect(human.querySelector('strong')?.textContent).toBe('this');
    expect(disclosures(container)).toEqual([]);
    await unmount();
  });

  it('draws a :::human segment with its :::llm text beside it', async () => {
    const { container, unmount } = await draw(
      [':::human', 'For people: `@src/api.ts`', ':::', llm('Short form.')].join('\n'),
    );
    const human = must(container.querySelector('section.human'), 'the human segment');
    expect(human.textContent).toContain('For people:');
    expect(anchorTexts(human)).toEqual(['@src/api.ts']);
    expect(disclosures(human).map(d => d.querySelector('pre')?.textContent)).toEqual(['Short form.']);
    await unmount();
  });

  it('keeps the alternate text of a part we do not draw (a disclosure beside it, never dropped)', async () => {
    const { container, unmount } = await draw(
      [fence('codewalk', '- file: src/api.ts', '  note: the entry'), '', llm('Walks the entry point.')].join('\n'),
    );
    expect(container.textContent).toContain('Walks the entry point.');
    expect(disclosures(container).length).toBe(1);
    await unmount();
  });
});

describe('inline code shows the literal bytes typed (reference-standard §7)', () => {
  const codes = (root: ParentNode): (string | null)[] => [...root.querySelectorAll('p code')].map(c => c.textContent);

  it('keeps a typed character reference literal and a typed tag literal', async () => {
    const { container, unmount } = await draw('a `&lt;demo&gt;` b `<demo>` c `&amp;` d `x && y` e `&copy;`');
    expect(codes(container)).toEqual(['&lt;demo&gt;', '<demo>', '&amp;', 'x && y', '&copy;']);
    await unmount();
  });

  it('keeps every reference-style entity literal, in a longer-tick span and across a line end', async () => {
    const { container, unmount } = await draw('``a`b &quot;q&quot; &#39; &#x27;`` and `one &lt;\ntwo`');
    expect(codes(container)).toEqual(['a`b &quot;q&quot; &#39; &#x27;', 'one &lt; two']);
    await unmount();
  });

  it('decorates a proved reference inside such a span without touching the bytes around it', async () => {
    const { container, unmount } = await draw('see `&lt;x&gt; @src/api.ts &lt;y&gt;`');
    expect(codes(container)).toEqual(['&lt;x&gt; @src/api.ts &lt;y&gt;']);
    expect(anchorTexts(container)).toEqual(['@src/api.ts']);
    await unmount();
  });

  it('leaves a fence and prose alone: a fence is verbatim, prose decodes its entities', async () => {
    const { container, unmount } = await draw(['x &lt;p&gt; y', '', fence('', '&lt;demo&gt;')].join('\n'));
    expect(container.querySelector('p')?.textContent).toBe('x <p> y');
    expect(container.querySelector('pre code')?.textContent).toBe('&lt;demo&gt;');
    await unmount();
  });

  it('pairs ticks the way CommonMark does: an escaped tick opens nothing, a run closes only on its own length', async () => {
    const { container, unmount } = await draw('\\`&lt;a&gt;` and ``&lt;b&gt;` and `&lt;c&gt;`');
    expect(codes(container)).toEqual([' and ``&lt;b&gt;', '&lt;c&gt;']);
    await unmount();
  });
});

describe('what an agent cannot forge', () => {
  it('leaves a hand-written reference-shaped link inert', async () => {
    const forged =
      '[open it](#fy-reference?kind=agent&daemon=d1&id=s-zelda&name=zelda) and [again](#%66y-reference?kind=task&id=F12)';
    const { container, f, unmount } = await draw(forged);
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelectorAll('.dh-link-off').length).toBe(2);
    expect(container.textContent).toContain('open it');
    expect(f.opened.navigated).toEqual([]);
    await unmount();
  });

  it('leaves an app-route link and a relative link inert', async () => {
    const { container, unmount } = await draw('[a](/d/d1/session/x) and [b](docs/readme.md) and [c](//evil.test/x)');
    expect(container.querySelector('a')).toBeNull();
    await unmount();
  });

  it('draws no remote image: a picture is an `fy-render` image', async () => {
    const { container, unmount } = await draw('![pixel](https://tracker.test/p.gif)');
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('pixel');
    await unmount();
  });

  it('opens an outside link the way every outside link opens', async () => {
    const { container, unmount } = await draw('see [the docs](https://example.com/a)');
    const a = must(container.querySelector('a'), 'the outside link');
    expect(a.getAttribute('href')).toBe('https://example.com/a');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toContain('noopener');
    await unmount();
  });
});

describe('a message that begins like front matter', () => {
  it('shows every line', async () => {
    const { container, unmount } = await draw('---\nk: v\n---\nafter');
    const text = container.textContent ?? '';
    expect(text).toContain('k: v');
    expect(text).toContain('after');
    expect(container.querySelector('.banner')).toBeNull();
    await unmount();
  });

  it('shows a leading YAML block that is not a rule pair', async () => {
    const { container, unmount } = await draw('---\ntitle: x\nbanner:\n  kind: warn\n  text: Deprecated\n---\nbody');
    expect(container.textContent).toContain('Deprecated');
    expect(container.querySelector('.banner')).toBeNull();
    await unmount();
  });
});

describe('heading anchors', () => {
  it('gives two messages with the same heading different ids', async () => {
    const one = await draw('# Plan\n\ntext');
    const two = await draw('# Plan\n\ntext');
    const a = one.container.querySelector('h1')?.id;
    const b = two.container.querySelector('h1')?.id;
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
    await one.unmount();
    await two.unmount();
  });

  it('numbers headings and links to them by the slug GitHub gives', async () => {
    const text = [
      '# Hello, World!',
      '## cyan.yaml',
      '## Hello, World!',
      '### Ünïcode ✓ & more',
      '',
      '[a](#hello-world) [b](#cyanyaml) [c](#hello-world-1)',
    ].join('\n');
    const { container, unmount } = await draw(text);
    const prefix = must(container.querySelector('h1'), 'h1').id.replace(/hello-world$/u, '');
    const ids = [...container.querySelectorAll('h1,h2,h3')].map(h => h.id.slice(prefix.length));
    expect(ids).toEqual(['hello-world', 'cyanyaml', 'hello-world-1', 'ünïcode---more']);
    const hrefs = [...container.querySelectorAll('p a')].map(a => a.getAttribute('href'));
    expect(hrefs).toEqual([`#${prefix}hello-world`, `#${prefix}cyanyaml`, `#${prefix}hello-world-1`]);
    for (const href of hrefs) expect(container.querySelector(`[id="${href?.slice(1)}"]`)).not.toBeNull();
    await unmount();
  });
});

describe('a streaming message', () => {
  it('keeps the parts already on screen when text is appended', async () => {
    const f = fixture();
    const first = [fence('terminal', '$ one', 'out'), '', 'a paragraph', ''].join('\n');
    const mounted = await mount(prose(first, f).tree as never);
    await interact(() => Promise.resolve());
    const term = must(mounted.container.querySelector('.term'), 'the terminal');
    const paragraph = must(mounted.container.querySelector('p'), 'the paragraph');
    for (const more of [
      '\nmore text',
      '\nand a [link](https://example.com)\n',
      `\n${fence('terminal', '$ two', 'out2')}\n`,
    ]) {
      await mounted.render(prose(`${first}${more}`, f).tree as never);
      expect(mounted.container.querySelector('.term')).toBe(term);
      expect(mounted.container.querySelector('p')).toBe(paragraph);
    }
    expect(mounted.container.querySelectorAll('.term').length).toBe(2);
    await mounted.unmount();
  });
});

describe('raw HTML in prose', () => {
  // Replaces the `Markdown` test of the same name (r12 H7 deleted the path it covered): the reader has no `rehype-raw`,
  // and adding one would execute a literal `<script>` typed into any chat message.
  it('stays inert: no script, no element, only the text', async () => {
    const { container, unmount } = await draw(
      '<script>globalThis.pwned = true</script><b>text</b> and <img src=x onerror=1>',
    );
    expect(container.querySelectorAll('script').length).toBe(0);
    expect(container.querySelectorAll('b').length).toBe(0);
    expect(container.querySelectorAll('img').length).toBe(0);
    expect((globalThis as { pwned?: boolean }).pwned).toBeUndefined();
    await unmount();
  });
});

describe('a message over the size cap', () => {
  it('shows the text itself, not an error', async () => {
    const big = `${'word '.repeat(70_000)}END`;
    const { container, unmount } = await draw(big);
    expect(container.querySelector('.dh-error')).toBeNull();
    expect(container.querySelector('pre.fy-hm-plain')?.textContent?.endsWith('END')).toBe(true);
    // Over the author's cap it is the text without a note, as before (a message over a pre-parse limit, or one that could not be read, has one).
    expect(container.querySelector('[data-fy-plain-note]')).toBeNull();
    await unmount();
  });
});

describe('headings the surface does not want as headings (demoteHeadings, r12 R3)', () => {
  const TEXT = ['## Plan', '', 'First, the short.', '', '### Later', '', 'More, with [a link](#plan).'].join('\n');
  const drawProvided = async (demoteHeadings: boolean) => {
    const f = fixture();
    const mounted = await mount(
      inShell(
        <ReferenceSurfaceProvider surface={f.surface}>
          <DemotingProse text={TEXT} {...(demoteHeadings ? { demoteHeadings } : {})} />
        </ReferenceSurfaceProvider>,
      ) as never,
    );
    await interact(() => Promise.resolve());
    return mounted;
  };

  it('without it a heading is a heading, as the chat draws it', async () => {
    const { container, unmount } = await drawProvided(false);
    expect([...container.querySelectorAll('.dh-doc :is(h1, h2, h3, h4, h5, h6)')].map(each => each.tagName)).toEqual([
      'H2',
      'H3',
    ]);
    expect(container.querySelector('[data-demoted-heading]')).toBeNull();
    // The heading slot draws what Durian draws with no slot: the `#` anchor to its own id, so the chat is unchanged.
    const heading = must(container.querySelector('.dh-doc h2'), 'the h2');
    expect(heading.getAttribute('id')).toMatch(/plan$/u);
    expect(heading.querySelector('a.h-anchor')?.getAttribute('href')).toBe(`#${heading.getAttribute('id')}`);
    await unmount();
  });

  it('with it no h1–h6 is drawn: each is the shell Markdown’s own bold line, keeping its id for a link in the message', async () => {
    const { container, unmount } = await drawProvided(true);
    expect(container.querySelectorAll('.dh-doc :is(h1, h2, h3, h4, h5, h6)').length).toBe(0);
    const lines = [...container.querySelectorAll('.dh-doc p[data-demoted-heading]')];
    expect(lines.map(line => line.querySelector('strong')?.textContent)).toEqual(['Plan', 'Later']);
    expect(lines.map(line => line.textContent)).toEqual(['Plan', 'Later']);
    // The id Durian gave the heading is kept: the link `#plan` still has its target.
    const id = lines[0]?.getAttribute('id') ?? '';
    expect(id).toMatch(/plan$/u);
    expect(container.querySelector(`a[href="#${id}"]`)).not.toBeNull();
    // Only a heading changes: the prose around it is drawn as ever.
    expect(container.textContent).toContain('First, the short.');
    await unmount();
  });
});
