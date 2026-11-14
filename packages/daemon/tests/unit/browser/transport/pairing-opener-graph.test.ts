import { describe, it } from 'bun:test';
import should from 'should';
import { lookUpOpener, PairingOpenerGraph } from '../../../../src/lib/browser/transport/pairing-opener-graph.ts';

/** A graph that was told who opened whom: `['b', 'a']` is "b was opened by a"; a bare name was opened by nobody. */
const graphOf = (...edges: readonly (readonly [string, string?])[]): PairingOpenerGraph => {
  const graph = new PairingOpenerGraph();
  for (const [page, opener] of edges) graph.record(page, opener);
  return graph;
};

describe('PairingOpenerGraph', () => {
  it('should name every other open page of the opener group, whatever its origin, and leave out the unrelated', () => {
    // Arrange — one window with two popups, and a stranger (another agent's tab, the browser's startup blank)
    const graph = graphOf(['a'], ['b', 'a'], ['c', 'a'], ['blank'], ['x']);

    // Assert
    should(graph.group('b', ['a', 'b', 'c', 'blank', 'x']).live).eql(['a', 'c']);
    should(graph.group('x', ['a', 'b', 'c', 'blank', 'x']).live).eql([]);
    should(graph.group('blank', ['a', 'b', 'c', 'blank', 'x']).live).eql([]);
  });

  it('should keep a closed intermediate opener bridging its live ancestor and descendants (a -> b -> c, a -> d, b closed)', () => {
    // Arrange — the reviewer's probe: all four were seen, then b closed
    const graph = graphOf(['a'], ['b', 'a'], ['c', 'b'], ['d', 'a']);
    should(graph.group('c', ['a', 'b', 'c', 'd']).live).eql(['a', 'b', 'd']);

    // Act — b closes; the next look has only the pages that are open
    const group = graph.group('c', ['a', 'c', 'd']);

    // Assert — c still reaches a, and a's other child, through the window that is gone
    should(group.live).eql(['a', 'd']);
    should([...group.keys].sort()).eql(['a', 'b', 'c', 'd']);
  });

  it('should keep a bridge across several closed levels, and from either end', () => {
    const graph = graphOf(['a'], ['b', 'a'], ['c', 'b'], ['d', 'c']);
    graph.group('d', ['a', 'b', 'c', 'd']);

    should(graph.group('d', ['a', 'd']).live).eql(['a']);
    should(graph.group('a', ['a', 'd']).live).eql(['d']);
  });

  it('should keep the edges of a closed opener across looks, until every page of its component is gone', () => {
    const graph = graphOf(['a'], ['b', 'a'], ['c', 'b']);
    should(graph.group('c', ['a', 'c']).live).eql(['a']);
    should(graph.group('c', ['a', 'c']).live).eql(['a']);

    // Act — everything of the component closes; then a new page that reuses nothing is on its own
    graph.group('z', ['z']);
    graph.record('z', undefined);

    // Assert
    should(graph.group('z', ['z']).live).eql([]);
    should(graph.group('c', ['c', 'z']).live).eql([]);
  });

  it('should not let a component that is gone leak its edges into a later page', () => {
    const graph = graphOf(['a'], ['b', 'a']);
    graph.group('x', ['x']);

    should(graph.group('b', ['b']).keys).eql(['b']);
  });

  it('should read a page whose opener is unknown as reachable from every open page of the context, and forget it once it is gone', () => {
    // Arrange — c's lookup failed; a is a pairing window nobody tied to c
    const graph = graphOf(['a'], ['d']);
    graph.failed('c');

    // Assert
    should(graph.group('c', ['a', 'c', 'd']).live).eql(['a', 'd']);
    should(graph.group('a', ['a', 'c', 'd']).live).eql(['c', 'd']);
    graph.group('a', ['a', 'd']);
    should(graph.isUnknown('c')).be.false();
    should(graph.group('a', ['a', 'd']).live).eql([]);
  });

  it('should keep a failure until a lookup finds the opener: nobody-opened-it is not proof', () => {
    const graph = graphOf(['a']);
    graph.failed('c');

    graph.record('c', undefined);
    should(graph.isUnknown('c')).be.true();
    should(graph.group('a', ['a', 'c']).live).eql(['c']);

    graph.record('c', 'a');
    should(graph.isUnknown('c')).be.false();
    should(graph.group('a', ['a', 'c', 'x']).live).eql(['c']);
  });
});

describe('lookUpOpener', () => {
  it('should record the opener the lookup found, and none for a page nobody opened', async () => {
    const graph = new PairingOpenerGraph();

    await lookUpOpener(graph, 'b', async () => 'a');
    await lookUpOpener(graph, 'a', async () => undefined);

    should(graph.group('b', ['a', 'b']).live).eql(['a']);
    should(graph.isUnknown('a')).be.false();
  });

  it('should treat a lookup that rejects as unknown, never as a page nobody opened (the reviewer’s probe)', async () => {
    // Arrange — a is a marked app window; c is a blank page whose opener lookup failed
    const graph = new PairingOpenerGraph();
    await lookUpOpener(graph, 'a', async () => undefined);

    // Act
    await lookUpOpener(graph, 'c', () => Promise.reject(new Error('lookup failed')));

    // Assert
    should(graph.isUnknown('c')).be.true();
    should(graph.group('c', ['a', 'c']).live).eql(['a']);
  });

  it('should treat a lookup that throws, or never answers, as unknown', async () => {
    const graph = new PairingOpenerGraph();

    await lookUpOpener(graph, 'x', () => {
      throw new Error('sync failure');
    });
    await lookUpOpener(graph, 'y', () => new Promise<string | undefined>(() => undefined), 10);

    should([graph.isUnknown('x'), graph.isUnknown('y')]).eql([true, true]);
  });

  it('should recover a page when a later lookup does find its opener', async () => {
    const graph = new PairingOpenerGraph();
    await lookUpOpener(graph, 'c', () => Promise.reject(new Error('lookup failed')));

    await lookUpOpener(graph, 'c', async () => 'a');

    should(graph.isUnknown('c')).be.false();
  });
});
