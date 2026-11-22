import { describe, test } from 'bun:test';
import { ensureDom, render } from '@ferretry/app/testing';
import type { ReactNode } from 'react';
import should from 'should';
import { FyRenderBlock } from '../../../../app/render/fy-render-block.tsx';
import { tolerateAuthoringNoise } from '../../../../app/render/authoring-noise.ts';
import { fyRenderFenceBody, fyRenderFences } from '../../../../app/render/fences.tsx';
import { FY_RENDER_FENCE_ATTRIBUTE, parseFyRender } from '../../../../app/render/fy-render.ts';

/**
 * Conversation's fence door, drawn the way the hypermedia reader uses it: a fence node holding a body goes in, the block
 * (or null, which is plain code) comes out. The reader's own decisions about WHICH fences are blocks are
 * `hypermedia/fy-render-host.test.tsx` and `fy-render-fence-decisions.test.tsx`; these are the door's.
 */

// A block reads `document` when it mounts, so the DOM is this file's own, as in `reference-surface.test.tsx`.
ensureDom();

const FENCES = fyRenderFences();

/**
 * Built from a backtick run on purpose: `scripts/validate/no-fy-render-in-docs.sh` fails a commit containing the literal
 * opener anywhere else, and a test file is a tracked file.
 */
const FENCE = '`'.repeat(3);
const fence = (info: string, ...body: readonly string[]): string => [`${FENCE}${info}`, ...body, FENCE].join('\n');

const SQUARE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
const squareBody = ['type: svg', 'alt: A ten by ten square', '---', SQUARE_SVG].join('\n');

/** The node the reader hands the door for a fence body: what hast makes of a marked fence. */
const nodeOf = (body: string) => ({
  children: [
    {
      type: 'element',
      tagName: 'code',
      properties: { [FY_RENDER_FENCE_ATTRIBUTE]: 'true' },
      children: [{ type: 'text', value: `${body}\n` }],
    },
  ],
});

/** What the door draws for a body, rendered; `null` where the door answered null (the fence stays plain code). */
const drawnOf = (doors: typeof FENCES, body: string) => {
  const drawn: ReactNode | null = doors.draw({ node: nodeOf(body), onTaskOpen: undefined });
  return drawn === null ? null : render(<>{drawn}</>);
};

describe('the fence door draws task and board blocks', () => {
  const cardBody = ['type: task', 'alt: The task', '---', '&F12'].join('\n');
  // A message saved before the rename holds the old spelling of the type; it is read for good.
  const oldSpellingBody = ['type: card', 'alt: The task', '---', '&F12'].join('\n');
  const badCardBody = ['type: task', 'alt: The task', '---', 'nope'].join('\n');
  const cardFences = fyRenderFences({ cardEmbed: { daemon: 'daemon-a' } });

  test('should draw a task block only where the surface lent it a board to read', () => {
    // Act
    const lent = drawnOf(cardFences, cardBody);
    const bare = drawnOf(FENCES, cardBody);

    // Assert — without a board the door answers null: the block is the ordinary fence, as any block this build cannot draw is.
    should(lent?.root.findAllByProps({ 'data-fy-card-embed': 'task' })).have.length(1);
    should(bare).be.null();
  });

  test('should draw an old transcript whose block says card, as the task block it became', () => {
    // Assert — the saved message is never rewritten, so the old type is read forever.
    should(drawnOf(cardFences, oldSpellingBody)?.root.findAllByProps({ 'data-fy-card-embed': 'task' })).have.length(1);
  });

  test('should leave a task block with a bad payload as an ordinary fence even where it could draw', () => {
    should(drawnOf(cardFences, badCardBody)).be.null();
  });
});

describe('the fence door draws an illustration', () => {
  test('should draw a parseable body as a figure, never a pre', () => {
    // Act
    const tree = drawnOf(FENCES, squareBody);

    // Assert — `<figure>` inside `<pre>` is not a tree a browser keeps.
    should(tree?.root.findAllByProps({ 'data-fy-render-type': 'svg' })).have.length(1);
    should(tree?.root.findAllByType('pre')).be.empty();
  });

  test('should leave an unparseable body to be drawn as plain code', () => {
    // Arrange — no boundary line, so the grammar refuses it.
    const body = ['type: html', '<script>failed()</script>'].join('\n');

    // Assert — no partial state and no error chrome: the door answers null.
    should(drawnOf(FENCES, body)).be.null();
  });

  test('should refuse a fence node the reader did not mark', () => {
    should(
      FENCES.draw({
        node: {
          children: [
            {
              type: 'element',
              tagName: 'code',
              properties: { className: ['language-fy-render'] },
              children: [{ type: 'text', value: `${squareBody}\n` }],
            },
          ],
        },
        onTaskOpen: undefined,
      }),
    ).be.null();
  });
});

describe('fy-render fences authored with noise (B162)', () => {
  // The body the renderer would hand the grammar for a fence authored as `text`, parsed.
  const drawn = (text: string): number => {
    const inner = text.replace(/^```fy-render\r?\n/u, '').replace(/\r?\n```$/u, '');
    const body = fyRenderFenceBody(nodeOf(inner));
    return body !== null && parseFyRender(body).ok ? 1 : 0;
  };
  const squareFence = (): string => fence('fy-render', 'type: svg', 'alt: A ten by ten square', '---', SQUARE_SVG);

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

describe('fyRenderFenceBody', () => {
  const codeNode = (properties: Record<string, unknown>, value: unknown = 'type: svg\n') => ({
    children: [{ type: 'element', tagName: 'code', properties, children: [{ type: 'text', value }] }],
  });

  test('should read the body of a marked fence, without the newline hast added', () => {
    should(fyRenderFenceBody(codeNode({ 'data-fy-render-fence': 'true' }))).equal('type: svg');
  });

  test('should refuse a fence the reader did not mark', () => {
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

describe('fy-render workspace media', () => {
  test('should hand the workspace reader it was given to the block a media fence renders', () => {
    // Arrange
    const readWorkspaceMedia = async () => ({ ok: false, reason: 'missing' }) as const;
    const body = ['type: video', 'alt: A recording', 'src: @clip.mp4', '---'].join('\n');

    // Act
    const tree = drawnOf(fyRenderFences({ readWorkspaceMedia }), body);

    // Assert — the very function, not a copy; reduced to booleans so a failure cannot walk a fiber.
    should(
      tree?.root.findAllByType(FyRenderBlock).map(block => block.props.readWorkspaceMedia === readWorkspaceMedia),
    ).deepEqual([true]);
  });
});
