import { describe, test } from 'bun:test';
import type { AttentionId } from '@ferretry/protocol';
import type { ReactTestInstance } from 'react-test-renderer';
import should from 'should';
import { Markdown, referenceHasTrustedOrigin } from '../../src/components/markdown.tsx';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';
import {
  type ResolvedReference,
  type ResolvedSurfaceReference,
  referenceHref,
  referenceIdentity,
} from '../../src/lib/references.ts';
import { render, runAsync } from '../support/react.ts';

/**
 * Rendered, not grepped: every assertion here goes through the real
 * react-markdown pipeline (remark-gfm → remarkTableLabels → remarkReferences) and
 * inspects the elements it produced.
 */

const daemonA = 'daemon-a' as DaemonId;
const daemonB = 'daemon-b' as DaemonId;

const agentResolver =
  (daemonId: DaemonId, sessionId = 's1') =>
  () => ({ daemonId, sessionId, name: 'zelda' });

/** A click a real primary-button press would produce. */
const primaryClick = (currentTarget: unknown = null) => {
  let prevented = false;
  return {
    button: 0,
    currentTarget,
    get defaultPrevented() {
      return prevented;
    },
    preventDefault() {
      prevented = true;
    },
  };
};

const anchorsOf = (root: ReactTestInstance): ReactTestInstance[] => root.findAllByType('a');

const textOf = (node: ReactTestInstance): string =>
  node.children.map(child => (typeof child === 'string' ? child : textOf(child as ReactTestInstance))).join('');

describe('Markdown prose', () => {
  test('should render markdown structure rather than raw text', () => {
    // Act
    const tree = render(<Markdown text={'# Title\n\nSome **bold** prose.'} />);

    // Assert
    should(tree.root.findAllByType('h1')).have.length(1);
    should(tree.root.findAllByType('strong')).have.length(1);
  });

  test('should keep the caller class alongside its own prose class', () => {
    // Act
    const tree = render(<Markdown className="extra" text="plain" />);

    // Assert
    should(tree.root.findByProps({ className: 'md min-w-0 max-w-full extra' })).be.ok();
  });

  test('should open an external link in a new tab without leaking the referrer', () => {
    // Act
    const tree = render(<Markdown text="[docs](https://example.test/docs)" />);

    // Assert
    const anchor = anchorsOf(tree.root)[0];
    should(anchor?.props.href).equal('https://example.test/docs');
    should(anchor?.props.target).equal('_blank');
    should(anchor?.props.rel).equal('noreferrer noopener');
  });
});

describe('Markdown tables', () => {
  const markdown = ['| Path | Note |', '| --- | --- |', '| /a/b | hi |'].join('\n');

  test('should stamp each body cell with its column header for the stacked phone layout', () => {
    // Act
    const tree = render(<Markdown text={markdown} />);

    // Assert
    should(tree.root.findAllByType('td').map(cell => cell.props['data-label'])).deepEqual(['Path', 'Note']);
  });

  test('should scope every header cell to its column', () => {
    // Act
    const tree = render(<Markdown text={markdown} />);

    // Assert
    should(tree.root.findAllByType('th').every(cell => cell.props.scope === 'col')).be.true();
  });

  test('should wrap a table in its own scroller so a wide table never scrolls the page', () => {
    // Act
    const tree = render(<Markdown text={markdown} />);

    // Assert
    should(tree.root.findAllByProps({ className: 'md-table-scroll scroll-thin' })).not.be.empty();
  });
});

describe('Markdown code fences', () => {
  test('should highlight a fence in a language the shared registry knows', () => {
    // Act
    const tree = render(<Markdown text={'```ts\nconst x = 1;\n```'} />);

    // Assert
    const code = tree.root.findAllByType('code')[0];
    should(code?.props.className).equal('hljs language-ts');
    should(String(code?.props.dangerouslySetInnerHTML.__html)).containEql('hljs-keyword');
  });

  test('should hand an unknown fence language back as escaped text', () => {
    // Act
    const tree = render(<Markdown text={'```notalanguage\n<img src=x>\n```'} />);

    // Assert
    const code = tree.root.findAllByType('code')[0];
    should(code?.props.dangerouslySetInnerHTML).be.undefined();
    should(textOf(code as ReactTestInstance)).containEql('<img src=x>');
  });

  test('should leave inline code as escaped text', () => {
    // Act
    const tree = render(<Markdown text="use `<script>` carefully" />);

    // Assert
    const code = tree.root.findAllByType('code')[0];
    should(code?.props.dangerouslySetInnerHTML).be.undefined();
    should(textOf(code as ReactTestInstance)).equal('<script>');
  });
});

describe('Markdown references', () => {
  test('should leave a reference-shaped token as prose when nothing proves it', () => {
    // Act
    const tree = render(<Markdown text="ping :zelda about &F12 and !A3" />);

    // Assert
    should(anchorsOf(tree.root)).be.empty();
  });

  test('should link a proved agent reference to its own daemon session path', () => {
    // Act
    const tree = render(<Markdown agentReferenceResolver={agentResolver(daemonA)} text="ping :zelda" />);

    // Assert
    const anchor = anchorsOf(tree.root)[0];
    should(anchor?.props.href).equal('/d/daemon-a/session/s1');
    should(anchor?.props['data-fy-reference']).equal('agent:daemon-a:s1');
  });

  test('should navigate an agent reference into the daemon it was proved against', () => {
    // Arrange
    const visited: string[] = [];
    const tree = render(
      <Markdown
        agentReferenceResolver={agentResolver(daemonB)}
        onNavigate={to => visited.push(to)}
        text="ping :zelda"
      />,
    );

    // Act
    anchorsOf(tree.root)[0]?.props.onClick(primaryClick());

    // Assert
    should(visited).deepEqual(['/d/daemon-b/session/s1']);
  });

  test('should hand a proved task reference to its opener and never navigate', () => {
    // Arrange
    const opened: string[] = [];
    const tree = render(
      <Markdown onTaskOpen={id => opened.push(id)} taskReferenceResolver={() => true} text="see &F12" />,
    );

    // Act
    const anchor = anchorsOf(tree.root)[0];
    anchor?.props.onClick(primaryClick());

    // Assert
    should(anchor?.props.href).equal('#fy-reference?kind=task&id=F12');
    should(opened).deepEqual(['F12']);
  });

  test('should hand a proved attention reference to its opener', () => {
    // Arrange
    const opened: AttentionId[] = [];
    const tree = render(
      <Markdown attentionReferenceResolver={() => true} onAttentionOpen={id => opened.push(id)} text="see !A3" />,
    );

    // Act
    anchorsOf(tree.root)[0]?.props.onClick(primaryClick());

    // Assert
    should(opened).deepEqual(['A3']);
  });

  test('should hand a proved surface reference to its opener, carrying daemon and session', () => {
    // Arrange
    const opened: ResolvedSurfaceReference[] = [];
    const tree = render(
      <Markdown
        onSurfaceOpen={reference => opened.push(reference)}
        surfaceReferenceResolver={lookup => ({
          state: 'open',
          daemonId: 'daemon-a' as DaemonId,
          sessionId: 's1',
          surface: lookup.surface,
          key: lookup.key,
        })}
        text="watch %terminal:a1b2c3d4e5f6"
      />,
    );

    // Act
    const anchor = anchorsOf(tree.root)[0];
    anchor?.props.onClick(primaryClick());

    // Assert
    should(anchor?.props.href).equal(
      '#fy-reference?kind=surface&daemon=daemon-a&session=s1&surface=terminal&key=a1b2c3d4e5f6',
    );
    should(opened).deepEqual([
      { kind: 'surface', daemonId: 'daemon-a' as DaemonId, sessionId: 's1', surface: 'terminal', key: 'a1b2c3d4e5f6' },
    ]);
  });

  test('should leave a proved surface inert when the host cannot open one', () => {
    // Act — no `onSurfaceOpen`: the pane that would show it is not mounted.
    const tree = render(
      <Markdown
        surfaceReferenceResolver={lookup => ({
          state: 'open',
          daemonId: 'daemon-a' as DaemonId,
          sessionId: 's1',
          surface: lookup.surface,
          key: lookup.key,
        })}
        text="watch %terminal:a1b2c3d4e5f6"
      />,
    );

    // Assert
    should(anchorsOf(tree.root)).be.empty();
  });

  test('should strike through a surface the daemon proved closed instead of linking it', () => {
    // Act
    const tree = render(
      <Markdown
        onSurfaceOpen={() => undefined}
        surfaceReferenceResolver={() => ({ state: 'closed' })}
        text="watch %terminal:a1b2c3d4e5f6"
      />,
    );

    // Assert
    should(anchorsOf(tree.root)).be.empty();
    should(JSON.stringify(tree.toJSON())).containEql('no longer open in this session');
  });

  test('should leave a proved reference inert when the host offers no opener for its kind', () => {
    // Act
    const tree = render(<Markdown taskReferenceResolver={() => true} text="see &F12" />);

    // Assert
    should(anchorsOf(tree.root)).be.empty();
  });

  test('should let a modifier click fall through to the browser', () => {
    // Arrange
    const opened: string[] = [];
    const tree = render(
      <Markdown onTaskOpen={id => opened.push(id)} taskReferenceResolver={() => true} text="see &F12" />,
    );

    // Act
    anchorsOf(tree.root)[0]?.props.onClick({ ...primaryClick(), metaKey: true });
    anchorsOf(tree.root)[0]?.props.onClick({ ...primaryClick(), ctrlKey: true });
    anchorsOf(tree.root)[0]?.props.onClick({ ...primaryClick(), shiftKey: true });
    anchorsOf(tree.root)[0]?.props.onClick({ ...primaryClick(), altKey: true });
    anchorsOf(tree.root)[0]?.props.onClick({ ...primaryClick(), button: 1 });

    // Assert
    should(opened).be.empty();
  });

  test('should not act on a click a handler already consumed', () => {
    // Arrange
    const opened: string[] = [];
    const tree = render(
      <Markdown onTaskOpen={id => opened.push(id)} taskReferenceResolver={() => true} text="see &F12" />,
    );
    const consumed = primaryClick();
    consumed.preventDefault();

    // Act
    anchorsOf(tree.root)[0]?.props.onClick(consumed);

    // Assert
    should(opened).be.empty();
  });

  test('should render an authored reserved-envelope link as inert text', () => {
    // Arrange — the model wrote the reserved href into its own prose, with no
    // transform-origin mark to prove the plugin made it.
    const forged = `[&F12](${referenceHref({ kind: 'task', id: 'F12' })})`;

    // Act
    const tree = render(<Markdown onTaskOpen={() => undefined} taskReferenceResolver={() => true} text={forged} />);

    // Assert
    should(anchorsOf(tree.root)).be.empty();
  });
});

describe('Markdown file references', () => {
  const text = 'open @src/api.ts:12 please';

  test('should stay plain until the filesystem proves the path', () => {
    // Act
    const tree = render(<Markdown onCodeReferenceOpen={() => undefined} text={text} />);

    // Assert
    should(anchorsOf(tree.root)).be.empty();
  });

  test('should link and open a path the resolver canonicalised', async () => {
    // Arrange
    const opened: unknown[] = [];
    let tree = render(<Markdown text="" />);
    await runAsync(async () => {
      tree = render(
        <Markdown
          onCodeReferenceOpen={reference => opened.push(reference)}
          resolveFilePaths={async () => new Map([['src/api.ts', 'src/api.ts']])}
          text={text}
        />,
      );
      await Promise.resolve();
    });

    // Act
    anchorsOf(tree.root)[0]?.props.onClick(primaryClick());

    // Assert
    should(opened).deepEqual([{ path: 'src/api.ts', line: 12 }]);
  });

  test('should carry a line range through to the opener', async () => {
    // Arrange
    const opened: unknown[] = [];
    let tree = render(<Markdown text="" />);
    await runAsync(async () => {
      tree = render(
        <Markdown
          onCodeReferenceOpen={reference => opened.push(reference)}
          resolveFilePaths={async () => new Map([['src/api.ts', 'src/api.ts']])}
          text="open @src/api.ts:12-20"
        />,
      );
      await Promise.resolve();
    });

    // Act
    anchorsOf(tree.root)[0]?.props.onClick(primaryClick());

    // Assert
    should(opened).deepEqual([{ path: 'src/api.ts', line: 12, endLine: 20 }]);
  });

  test('should leave prose readable when the filesystem read fails', async () => {
    // Arrange
    let tree = render(<Markdown text="" />);
    await runAsync(async () => {
      tree = render(
        <Markdown
          onCodeReferenceOpen={() => undefined}
          resolveFilePaths={async () => {
            throw new Error('daemon offline');
          }}
          text={text}
        />,
      );
      await Promise.resolve();
    });

    // Assert
    should(anchorsOf(tree.root)).be.empty();
    should(textOf(tree.root.findByType('p'))).containEql('@src/api.ts:12');
  });

  test('should not ask the filesystem anything when there is no file candidate', async () => {
    // Arrange
    let asked = 0;

    // Act
    await runAsync(async () => {
      render(
        <Markdown
          onCodeReferenceOpen={() => undefined}
          resolveFilePaths={async () => {
            asked += 1;
            return new Map();
          }}
          text="no references here"
        />,
      );
      await Promise.resolve();
    });

    // Assert
    should(asked).equal(0);
  });

  test('should not ask the filesystem anything when no opener is offered', async () => {
    // Arrange
    let asked = 0;

    // Act
    await runAsync(async () => {
      render(
        <Markdown
          resolveFilePaths={async () => {
            asked += 1;
            return new Map();
          }}
          text={text}
        />,
      );
      await Promise.resolve();
    });

    // Assert
    should(asked).equal(0);
  });

  test('should abandon an in-flight read when the text changes under it', async () => {
    // Arrange
    let aborted = false;
    const tree = render(<Markdown text="" />);
    await runAsync(async () => {
      tree.update(
        <Markdown
          onCodeReferenceOpen={() => undefined}
          resolveFilePaths={async (_candidates, signal) =>
            new Promise(resolve => {
              signal.addEventListener('abort', () => {
                aborted = true;
                resolve(new Map());
              });
            })
          }
          text={text}
        />,
      );
      await Promise.resolve();
    });

    // Act
    await runAsync(async () => {
      tree.update(<Markdown onCodeReferenceOpen={() => undefined} text="open @src/other.ts" />);
      await Promise.resolve();
    });

    // Assert
    should(aborted).be.true();
  });
});

describe('referenceHasTrustedOrigin', () => {
  const reference: ResolvedReference = { kind: 'task', id: 'F12' };

  test('should re-prove a link the transform itself stamped', () => {
    // Act
    const actual = referenceHasTrustedOrigin(
      { properties: { 'data-fy-reference': referenceIdentity(reference) } },
      reference,
      { task: () => true },
    );

    // Assert
    should(actual).deepEqual(reference);
  });

  test('should refuse a link whose origin mark is missing, wrong, or absent entirely', () => {
    // Assert
    should(referenceHasTrustedOrigin({ properties: {} }, reference, { task: () => true })).be.null();
    should(
      referenceHasTrustedOrigin({ properties: { 'data-fy-reference': 'task:F99' } }, reference, { task: () => true }),
    ).be.null();
    should(referenceHasTrustedOrigin(null, reference, { task: () => true })).be.null();
    should(referenceHasTrustedOrigin(undefined, reference, { task: () => true })).be.null();
  });

  test('should refuse a stamped link the resolver no longer proves', () => {
    // Act
    const actual = referenceHasTrustedOrigin(
      { properties: { 'data-fy-reference': referenceIdentity(reference) } },
      reference,
      { task: () => false },
    );

    // Assert
    should(actual).be.null();
  });
});
