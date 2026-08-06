import { describe, test } from 'bun:test';
import should from 'should';
import { type CodeNode, decoratedCodeNodes } from '../../src/lib/code-span-references.ts';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';
import type { ReferenceResolvers } from '../../src/lib/references.ts';

const daemonId = 'daemon-a' as DaemonId;

const resolvers: ReferenceResolvers = {
  agent: () => ({ daemonId, sessionId: 's1', name: 'zelda' }),
  file: candidate => (candidate === 'src/api.ts' ? 'src/api.ts' : null),
  task: lookup =>
    lookup.id === 'F12'
      ? {
          daemonId,
          sessionId: lookup.form === 'qualified' ? lookup.sessionId : 's1',
          id: lookup.id,
        }
      : null,
};

const anything = () => true;

/**
 * The decoration's own witness, recomputed independently of the module: every
 * assertion about byte exactness compares this against the code that went in.
 */
const nodeText = (nodes: readonly CodeNode[]): string =>
  nodes.map(node => (node.kind === 'span' ? nodeText(node.children) : node.text)).join('');

const kinds = (nodes: readonly CodeNode[]): string[] =>
  nodes.flatMap(node => (node.kind === 'span' ? kinds(node.children) : [node.kind]));

describe('decoratedCodeNodes', () => {
  test('should decorate a proved reference inside plain code and keep every byte', () => {
    // Arrange
    const code = 'open @src/api.ts:120 then stop';

    // Act
    const nodes = decoratedCodeNodes({ code, resolvers, isOpenable: anything });

    // Assert
    should(nodes).not.be.null();
    should(nodeText(nodes ?? [])).equal(code);
    should(nodes).deepEqual([
      { kind: 'text', text: 'open ' },
      {
        kind: 'reference',
        text: '@src/api.ts:120',
        reference: { kind: 'file', path: 'src/api.ts', line: 120 },
      },
      { kind: 'text', text: ' then stop' },
    ]);
  });

  test('should answer null when nothing in the code can be proved', () => {
    // Assert — the caller then renders the code exactly as it always did.
    should(decoratedCodeNodes({ code: 'open @missing.ts and &F99', resolvers, isOpenable: anything })).be.null();
    should(decoratedCodeNodes({ code: 'nothing here', resolvers, isOpenable: anything })).be.null();
  });

  test('should leave a backslash-escaped token literal, backslash included', () => {
    // Act — a backslash is not a boundary character, so no candidate starts.
    const nodes = decoratedCodeNodes({ code: 'ping \\:zelda', resolvers, isOpenable: anything });

    // Assert
    should(nodes).be.null();
    should(decoratedCodeNodes({ code: 'see \\&F12@{Session_A-1}', resolvers, isOpenable: anything })).be.null();
  });

  test('should decorate a qualified task without changing one byte or its session case', () => {
    // Arrange
    const code = 'see &f12@{Session_A-1.dev}, then stop';

    // Act
    const nodes = decoratedCodeNodes({ code, resolvers, isOpenable: anything });

    // Assert
    should(nodeText(nodes ?? [])).equal(code);
    const reference = nodes?.find(node => node.kind === 'reference');
    should(reference?.kind === 'reference' ? reference.reference : null).deepEqual({
      kind: 'task',
      daemonId,
      sessionId: 'Session_A-1.dev',
      id: 'F12',
      form: 'qualified',
    });
  });

  test('should refuse a kind this surface cannot open', () => {
    // Act
    const nodes = decoratedCodeNodes({
      code: 'see &F12',
      resolvers,
      isOpenable: reference => reference.kind !== 'task',
    });

    // Assert
    should(nodes).be.null();
  });

  test('should keep highlighter tokens, their nesting, and the decoded text', () => {
    // Arrange — the shape highlight.js emits: nested spans around escaped text.
    const code = 'a && b < "@src/api.ts" > c';
    const html =
      '<span class="hljs-keyword">a</span> &amp;&amp; b &lt; <span class="hljs-string">&quot;@src/api.ts&quot;</span> &gt; c';

    // Act
    const nodes = decoratedCodeNodes({ code, html, resolvers, isOpenable: anything });

    // Assert
    should(nodeText(nodes ?? [])).equal(code);
    should(nodes?.[0]).deepEqual({ kind: 'span', className: 'hljs-keyword', children: [{ kind: 'text', text: 'a' }] });
    should(kinds(nodes ?? [])).deepEqual(['text', 'text', 'text', 'reference', 'text', 'text']);
    const string = nodes?.[2];
    should(string?.kind).equal('span');
    should(string?.kind === 'span' ? string.className : '').equal('hljs-string');
  });

  test('should keep a nested highlighter span nested rather than flattening its classes', () => {
    // Arrange
    const code = '`x` @src/api.ts';
    const html =
      '<span class="hljs-string">`<span class="hljs-subst">x</span>`</span> <span class="hljs-comment">@src/api.ts</span>';

    // Act
    const nodes = decoratedCodeNodes({ code, html, resolvers, isOpenable: anything });

    // Assert — the inner token must stay INSIDE the outer one, because that
    // nesting is what decides which theme colour wins.
    should(nodeText(nodes ?? [])).equal(code);
    const outer = nodes?.[0];
    should(outer?.kind === 'span' ? outer.children[1] : null).deepEqual({
      kind: 'span',
      className: 'hljs-subst',
      children: [{ kind: 'text', text: 'x' }],
    });
  });

  test('should decorate a token the highlighter split across two of its own tokens', () => {
    // Arrange
    const code = ':zelda';
    const html = '<span class="hljs-a">:zel</span><span class="hljs-b">da</span>';

    // Act
    const nodes = decoratedCodeNodes({ code, html, resolvers, isOpenable: anything });

    // Assert — two adjacent references to the same target, no re-nesting.
    should(nodeText(nodes ?? [])).equal(code);
    should(kinds(nodes ?? [])).deepEqual(['reference', 'reference']);
  });

  test('should decorate one qualified task split across highlighter tokens', () => {
    // Arrange
    const code = '&F12@{Session_A-1}';
    const html = '<span class="hljs-a">&amp;F12@{Session_</span><span class="hljs-b">A-1}</span>';

    // Act
    const nodes = decoratedCodeNodes({ code, html, resolvers, isOpenable: anything });

    // Assert
    should(nodeText(nodes ?? [])).equal(code);
    should(kinds(nodes ?? [])).deepEqual(['reference', 'reference']);
    const references = (nodes ?? []).flatMap(node =>
      node.kind === 'span' ? node.children.flatMap(child => (child.kind === 'reference' ? [child.reference] : [])) : [],
    );
    should(references).have.length(2);
    should(references[0]).deepEqual(references[1]);
  });

  test('should refuse highlighter markup it cannot read back safely', () => {
    // Arrange
    const code = 'see &F12';
    const cases = [
      // A stray `<` the token grammar cannot account for.
      '<span class="hljs-a">see</span><b> &amp;F12</b>',
      // An unbalanced close.
      'see</span> &amp;F12',
      // An unclosed open.
      '<span class="hljs-a">see &amp;F12',
      // Text that does not reassemble into the source at all.
      '<span class="hljs-a">see &amp;F13</span>',
    ];

    // Act
    const answers = cases.map(html => decoratedCodeNodes({ code, html, resolvers, isOpenable: anything }));

    // Assert — every refusal keeps the caller's own highlighted rendering.
    should(answers).deepEqual([null, null, null, null]);
  });

  test('should place a reference that only touches one of several text runs', () => {
    // Arrange
    const code = 'x :zelda y';
    const html = '<span class="hljs-a">x </span><span class="hljs-b">:zelda</span><span class="hljs-c"> y</span>';

    // Act
    const nodes = decoratedCodeNodes({ code, html, resolvers, isOpenable: anything });

    // Assert
    should(nodeText(nodes ?? [])).equal(code);
    should(kinds(nodes ?? [])).deepEqual(['text', 'reference', 'text']);
  });

  test('should decorate several references in one fence in authored order', () => {
    // Arrange
    const code = 'see &F12, ping :zelda, open @src/api.ts';

    // Act
    const nodes = decoratedCodeNodes({ code, html: null, resolvers, isOpenable: anything });

    // Assert
    should(nodeText(nodes ?? [])).equal(code);
    should((nodes ?? []).flatMap(node => (node.kind === 'reference' ? [node.reference.kind] : []))).deepEqual([
      'task',
      'agent',
      'file',
    ]);
  });
});
