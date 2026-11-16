import { describe, test } from 'bun:test';
import { Markdown } from '@ferretry/app';
import { render } from '@ferretry/app/testing';
import type { ReactTestInstance } from 'react-test-renderer';
import should from 'should';
import { FyRenderBlock } from '../../../../app/render/fy-render-block.tsx';
import { fyRenderFenceBody, fyRenderFences, tolerateAuthoringNoise } from '../../../../app/render/fences.tsx';
import { parseFyRender } from '../../../../app/render/fy-render.ts';

/**
 * Conversation's fence kind, drawn by the shell's Markdown: every assertion goes through the real react-markdown
 * pipeline (remark-gfm → remarkTableLabels → the fence's own mark → remarkReferences) and inspects the elements it produced.
 */

const FENCES = fyRenderFences();

const textOf = (node: ReactTestInstance): string =>
  node.children.map(child => (typeof child === 'string' ? child : textOf(child as ReactTestInstance))).join('');

/**
 * Built from a backtick run on purpose: `scripts/validate/no-fy-render-in-docs.sh` fails a commit containing the literal
 * opener anywhere else, and a test file is a tracked file.
 */
const FENCE = '`'.repeat(3);
const fence = (info: string, ...body: readonly string[]): string => [`${FENCE}${info}`, ...body, FENCE].join('\n');

const SQUARE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
const squareFence = (info = 'fy-render'): string =>
  fence(info, 'type: svg', 'alt: A ten by ten square', '---', SQUARE_SVG);

describe('Markdown card and board blocks', () => {
  const cardFence = fence('fy-render', 'type: card', 'alt: The card', '---', '&F12');
  const badCardFence = fence('fy-render', 'type: card', 'alt: The card', '---', 'nope');
  const cardFences = fyRenderFences({ cardEmbed: { daemon: 'daemon-a' } });

  test('should draw a card block only where the surface lent it a board to read', () => {
    // Act
    const lent = render(<Markdown enableFyRender fences={cardFences} text={cardFence} />);
    const bare = render(<Markdown enableFyRender fences={FENCES} text={cardFence} />);

    // Assert — without a board the block is the ordinary escaped fence, as any block this build cannot draw is.
    should(lent.root.findAllByProps({ 'data-fy-card-embed': 'card' })).have.length(1);
    should(lent.root.findAllByType('pre')).be.empty();
    should(bare.root.findAllByProps({ 'data-fy-card-embed': 'card' })).be.empty();
    should(textOf(bare.root.findByType('code'))).containEql('type: card');
  });

  test('should leave a card block with a bad payload as an ordinary fence even where it could draw', () => {
    const tree = render(<Markdown enableFyRender fences={cardFences} text={badCardFence} />);
    should(tree.root.findAllByProps({ 'data-fy-card-embed': 'card' })).be.empty();
    should(textOf(tree.root.findByType('code'))).containEql('nope');
  });
});

describe('Markdown fy-render fences authored with noise (B162)', () => {
  // The body the renderer would hand the grammar for a fence authored as `text`, parsed.
  const drawn = (text: string): number => {
    const inner = text.replace(/^```fy-render\r?\n/u, '').replace(/\r?\n```$/u, '');
    const node = {
      children: [
        {
          type: 'element',
          tagName: 'code',
          properties: { 'data-fy-render-fence': 'true' },
          children: [{ type: 'text', value: `${inner}\n` }],
        },
      ],
    };
    const body = fyRenderFenceBody(node);
    return body !== null && parseFyRender(body).ok ? 1 : 0;
  };

  test('should draw a block whose lines end in CRLF', () => {
    should(drawn(squareFence().replace(/\n/gu, '\r\n'))).equal(1);
  });

  test('should draw a block with trailing spaces on the boundary or a header', () => {
    should(drawn(squareFence().replace('---', '---  '))).equal(1);
    should(drawn(squareFence().replace('type: svg', 'type: svg \t'))).equal(1);
  });

  test('should draw a block with blank lines before the first header', () => {
    should(drawn(squareFence().replace('type: svg', '\n\ntype: svg'))).equal(1);
  });

  test('should still refuse what the contract refuses', () => {
    should(drawn(squareFence().replace('---', '----'))).equal(0);
    should(drawn(squareFence().replace('type: svg', 'Type: svg'))).equal(0);
  });

  describe('payload after the boundary is verbatim', () => {
    const payloadOf = (body: string): string => {
      const parsed = parseFyRender(tolerateAuthoringNoise(body));
      if (!parsed.ok) throw new Error(`expected a parse, got: ${parsed.reason}`);
      return parsed.block.payload;
    };

    test('should keep CRLF and trailing spaces in an html payload', () => {
      const payload = '<div>  \r\n  <p>hi</p>   \r\n</div>\r\n\r\n  ';
      should(payloadOf(`type: html\r\nalt: x  \r\n---  \r\n${payload}`)).equal(payload);
    });

    test('should keep CRLF and trailing spaces in an svg payload', () => {
      const payload =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4">  \r\n<rect width="4" height="4"/> \r\n</svg>  ';
      should(payloadOf(`\r\n\r\ntype: svg \t\r\nalt: sq\r\n---\r\n${payload}`)).equal(payload);
    });

    test('should keep an LF payload and a payload that itself contains ---', () => {
      const payload = '<p>a</p>  \n---  \n<p>b</p>\r\n';
      should(payloadOf(`type: html\nalt: x\n---\n${payload}`)).equal(payload);
    });

    test('should keep a bare CR inside the payload', () => {
      const payload = '<p>a\rb</p>';
      should(payloadOf(`type: html\r\nalt: x\r\n---\r\n${payload}`)).equal(payload);
    });
  });
});

describe('Markdown fy-render fences', () => {
  test('should render an illustration only where the surface opted in', () => {
    // Act
    const enabled = render(<Markdown enableFyRender fences={FENCES} text={squareFence()} />);
    const inert = render(<Markdown text={squareFence()} />);

    // Assert — the SAME document, read by two surfaces. The inert one is not a
    // degraded render: it is the ordinary escaped fence, with no block at all.
    should(enabled.root.findAllByProps({ 'data-fy-render-type': 'svg' })).have.length(1);
    should(inert.root.findAllByProps({ 'data-fy-render-type': 'svg' })).be.empty();
    should(textOf(inert.root.findByType('code'))).containEql('type: svg');
    should(inert.root.findAllByType('img')).be.empty();
  });

  test('should replace the fence rather than nest a figure inside a pre', () => {
    // Act
    const tree = render(<Markdown enableFyRender fences={FENCES} text={squareFence()} />);

    // Assert — `<figure>` inside `<pre>` is not a tree a browser keeps, and
    // `white-space: pre` is not a layout an illustration survives.
    should(tree.root.findAllByType('pre')).be.empty();
    should(tree.root.findAllByType('figure')).have.length(1);
  });

  test('should treat a fence carrying metadata as a different language entirely', () => {
    // Arrange — mdast splits the info string into lang and meta, and hast keeps
    // only the lang, so `fy-render notes` arrives wearing `language-fy-render`.
    // Exactness has to be decided where the metadata is still visible.
    const tree = render(<Markdown enableFyRender fences={FENCES} text={squareFence('fy-render notes')} />);

    // Assert
    should(tree.root.findAllByProps({ 'data-fy-render-type': 'svg' })).be.empty();
    should(textOf(tree.root.findByType('code'))).containEql('type: svg');
  });

  test('should leave a differently named fence alone', () => {
    // Act
    const tree = render(<Markdown enableFyRender fences={FENCES} text={squareFence('fy-render-notes')} />);

    // Assert
    should(tree.root.findAllByProps({ 'data-fy-render-type': 'svg' })).be.empty();
  });

  test('should render an unparseable opted-in fence as an ordinary escaped fence', () => {
    // Arrange — no boundary line, so the grammar refuses it.
    const text = fence('fy-render', 'type: html', '<script>failed()</script>');

    // Act
    const tree = render(<Markdown enableFyRender fences={FENCES} text={text} />);

    // Assert — indistinguishable from a plain fence, exactly like an unknown
    // fence language. There is no partial-render state and no error chrome.
    should(tree.root.findAllByType('figure')).be.empty();
    should(tree.root.findAllByType('script')).be.empty();
    should(textOf(tree.root.findByType('code'))).containEql('<script>failed()</script>');
  });

  test('should keep raw HTML in prose inert, which this feature must not change', () => {
    // Act
    const tree = render(
      <Markdown enableFyRender fences={FENCES} text={'<script>globalThis.pwned = true</script><b>text</b>'} />,
    );

    // Assert — there is no `rehype-raw` in the pipeline, and adding one would
    // execute a literal `<script>` typed into any chat message.
    should(tree.root.findAllByType('script')).be.empty();
    should(tree.root.findAllByType('b')).be.empty();
  });

  /**
   * THE GATE AND THE RENDERER MUST AGREE ON WHAT AN OPENER IS.
   *
   * remark produces the same `code` node for every CommonMark fence form, so all
   * of these activate. `scripts/validate/no-fy-render-in-docs.sh` therefore has
   * to find all of them too — a gate that only knew about exactly three
   * backticks at column zero would wave three renderable forms into a durable
   * file. These cases exist to make that agreement fail loudly if either side
   * narrows: if a form below stops rendering, delete it from the gate as well.
   */
  test('should render every CommonMark delimiter form the parser accepts', () => {
    for (const delimiter of [FENCE, `${FENCE}${'`'}`, '~'.repeat(3), '~'.repeat(5)]) {
      // Arrange
      const text = [
        `${delimiter}fy-render`,
        'type: svg',
        'alt: A ten by ten square',
        '---',
        SQUARE_SVG,
        delimiter,
      ].join('\n');

      // Act
      const tree = render(<Markdown enableFyRender fences={FENCES} text={text} />);

      // Assert
      should(tree.root.findAllByProps({ 'data-fy-render-type': 'svg' })).have.length(1);
    }
  });

  test('should render an illustration opened inside a blockquote', () => {
    // Arrange — the delimiter is not at column zero here, which is the form a
    // line-anchored gate would miss.
    const text = squareFence()
      .split('\n')
      .map(line => `> ${line}`)
      .join('\n');

    // Act
    const tree = render(<Markdown enableFyRender fences={FENCES} text={text} />);

    // Assert
    should(tree.root.findAllByProps({ 'data-fy-render-type': 'svg' })).have.length(1);
  });

  test('should find an illustration nested inside a list item', () => {
    // Arrange — a fence is not always a top-level child, so the mark has to be
    // stamped by a full walk rather than a scan of the document's own children.
    const indented = squareFence()
      .split('\n')
      .map(line => `  ${line}`)
      .join('\n');

    // Act
    const tree = render(<Markdown enableFyRender fences={FENCES} text={`- an illustration:\n\n${indented}\n`} />);

    // Assert
    should(tree.root.findAllByProps({ 'data-fy-render-type': 'svg' })).have.length(1);
  });
});

describe('fyRenderFenceBody', () => {
  const codeNode = (properties: Record<string, unknown>, value: unknown = 'type: svg\n') => ({
    children: [{ type: 'element', tagName: 'code', properties, children: [{ type: 'text', value }] }],
  });

  test('should read the body of a marked fence, without the newline hast added', () => {
    should(fyRenderFenceBody(codeNode({ 'data-fy-render-fence': 'true' }))).equal('type: svg');
  });

  test('should refuse a fence the remark plugin did not mark', () => {
    // Assert — the class name is deliberately not enough, because a fence with
    // metadata arrives wearing exactly this one.
    should(fyRenderFenceBody(codeNode({ className: ['language-fy-render'] }))).be.null();
  });

  test('should refuse anything that is not a code element holding text', () => {
    should(fyRenderFenceBody(null)).be.null();
    should(fyRenderFenceBody({})).be.null();
    should(fyRenderFenceBody({ children: [{ type: 'text' }] })).be.null();
    should(fyRenderFenceBody({ children: [{ type: 'element', tagName: 'span', properties: {} }] })).be.null();
    // An empty fence has no text child at all.
    should(
      fyRenderFenceBody({
        children: [{ type: 'element', tagName: 'code', properties: { 'data-fy-render-fence': 'true' }, children: [] }],
      }),
    ).be.null();
    should(fyRenderFenceBody(codeNode({ 'data-fy-render-fence': 'true' }, 7))).be.null();
  });
});

describe('Markdown fy-render workspace media', () => {
  test('should hand the workspace reader it was given to the block a media fence renders', () => {
    // Arrange
    const readWorkspaceMedia = async () => ({ ok: false, reason: 'missing' }) as const;
    const text = fence('fy-render', 'type: video', 'alt: A recording', 'src: @clip.mp4', '---');

    // Act
    const tree = render(<Markdown enableFyRender fences={fyRenderFences({ readWorkspaceMedia })} text={text} />);

    // Assert — the very function, not a copy; reduced to booleans so a failure cannot walk a fiber.
    should(
      tree.root.findAllByType(FyRenderBlock).map(block => block.props.readWorkspaceMedia === readWorkspaceMedia),
    ).deepEqual([true]);
  });
});
