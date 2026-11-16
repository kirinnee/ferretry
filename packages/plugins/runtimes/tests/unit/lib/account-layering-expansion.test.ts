/**
 * R2 (M-1): the one expansion of a profile's bases (`expandStack`, under `flattenProfile`) reads each profile ONCE, however
 * many paths lead to it, and says exactly what the per-path expansion said.
 *
 * The reference here is that per-path expansion as it was before the memo (`naiveFlatten`, test-local): every base
 * expanded where it stands, on every path, each component kept once at its newest position. The table pins the memoised
 * answer to it, `via` and `origin` included, on graphs that exercise the memo: chains, diamonds, a base repeated in one
 * profile, a base under two parents, a cycle (also through a diamond), a missing base and a missing component.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { expandStack, MAX_STACK_DEPTH, MAX_STACK_LAYERS, type StackLayer } from '../../../contract/index.ts';
import { type FlatLayer, flattenProfile, resolveProfile } from '../../../daemon/lib/account/layering.ts';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import { catalogueOf, type Graph, lattice, latticeItems } from '../../support/layering-lattice.ts';

/** The expansion as it was: every path walked, each component kept once at its newest position. */
function naiveFlatten(catalogue: ReturnType<typeof catalogueOf>, name: string) {
  const expanded: FlatLayer[] = [];
  type Failure =
    | { readonly kind: 'unknown-profile'; readonly profile: string; readonly via: readonly string[] }
    | { readonly kind: 'loop'; readonly cycle: readonly string[] }
    | { readonly kind: 'unknown-component'; readonly reference: string; readonly via: readonly string[] };
  const walk = (current: string, via: readonly string[], chain: readonly string[]): Failure | undefined => {
    const profile = catalogue.profiles[current];
    if (profile === undefined) return { kind: 'unknown-profile', profile: current, via: via.slice(0, -1) } as const;
    for (const text of profile.layers) {
      if (text.startsWith('profile/')) {
        const base = text.slice('profile/'.length);
        if (chain.includes(base)) return { kind: 'loop', cycle: [...chain.slice(chain.indexOf(base)), base] } as const;
        const failure = walk(base, [...via, base], [...chain, base]);
        if (failure !== undefined) return failure;
        continue;
      }
      const [kind, item] = text.split('/') as ['mcp', string];
      if ((catalogue.components[kind] as Record<string, unknown>)[item] === undefined)
        return { kind: 'unknown-component', reference: text, via } as const;
      expanded.push({
        reference: text as FlatLayer['reference'],
        componentKind: kind,
        name: item,
        origin: (via.length === 0 ? text : `profile/${via[0]}`) as FlatLayer['origin'],
        via,
      });
    }
    return undefined;
  };
  const failure = walk(name, [], [name]);
  if (failure !== undefined) return { ok: false, failure } as const;
  const newest = new Map<string, number>();
  for (const [index, layer] of expanded.entries()) newest.set(layer.reference, index);
  return { ok: true, layers: expanded.filter((layer, index) => newest.get(layer.reference) === index) } as const;
}

const ITEMS = ['one', 'two', 'three', 'dup', 'last'];

const GRAPHS: Readonly<Record<string, { readonly graph: Graph; readonly start: string }>> = {
  'a profile with no bases': { graph: { top: ['mcp/one', 'mcp/two'] }, start: 'top' },
  'a chain of bases': {
    graph: { top: ['mcp/one', 'profile/mid'], mid: ['mcp/two', 'profile/leaf'], leaf: ['mcp/three'] },
    start: 'top',
  },
  'a diamond': {
    graph: {
      top: ['profile/left', 'profile/right', 'mcp/last'],
      left: ['profile/base', 'mcp/one'],
      right: ['mcp/two', 'profile/base'],
      base: ['mcp/three'],
    },
    start: 'top',
  },
  'a base named twice in one profile': {
    graph: { top: ['profile/base', 'mcp/one', 'profile/base', 'mcp/two'], base: ['mcp/three', 'mcp/dup'] },
    start: 'top',
  },
  'a base used under two parents, with a repeated item at different places': {
    graph: {
      top: ['mcp/dup', 'profile/left', 'profile/right', 'mcp/last'],
      left: ['profile/base', 'mcp/dup', 'mcp/one'],
      right: ['mcp/two', 'profile/base'],
      base: ['mcp/three', 'mcp/dup'],
    },
    start: 'top',
  },
  'the same item reached from the middle and the end': {
    graph: { top: ['profile/a', 'mcp/one', 'profile/b'], a: ['mcp/one', 'mcp/two'], b: ['mcp/two', 'mcp/one'] },
    start: 'top',
  },
  'a profile with no layers under another': {
    graph: { top: ['profile/empty', 'mcp/one'], empty: [] },
    start: 'top',
  },
  'a missing base at the top': { graph: { top: ['profile/ghost'] }, start: 'top' },
  'a missing base under a shared base': {
    graph: { top: ['profile/a', 'profile/b'], a: ['profile/base'], b: ['profile/base'], base: ['profile/ghost'] },
    start: 'top',
  },
  'a missing profile asked for': { graph: { top: ['mcp/one'] }, start: 'ghost' },
  'a missing component': { graph: { top: ['profile/base'], base: ['mcp/one', 'mcp/ghost'] }, start: 'top' },
  'a profile that names itself': { graph: { top: ['mcp/one', 'profile/top'] }, start: 'top' },
  'a cycle behind the first way in': {
    graph: { top: ['profile/x'], x: ['profile/y'], y: ['mcp/one', 'profile/x'] },
    start: 'top',
  },
  'a cycle behind a diamond': {
    graph: {
      top: ['profile/left', 'profile/right'],
      left: ['profile/base'],
      right: ['profile/base'],
      base: ['profile/loop-a'],
      'loop-a': ['mcp/one', 'profile/loop-b'],
      'loop-b': ['profile/loop-a'],
    },
    start: 'top',
  },
  'a cycle through a base a sibling already expanded': {
    graph: {
      top: ['profile/shared', 'profile/other'],
      shared: ['mcp/one'],
      other: ['profile/shared', 'profile/top'],
    },
    start: 'top',
  },
};

describe('R2 flattenProfile — the memoised expansion says what the per-path expansion said', () => {
  for (const [label, { graph, start }] of Object.entries(GRAPHS)) {
    it(`R2 should answer ${label} exactly as the per-path expansion does, in the same layer order`, () => {
      // Arrange
      const catalogue = catalogueOf(graph, ITEMS);

      // Act
      const actual = flattenProfile(catalogue, start);

      // Assert
      should(actual).deepEqual(naiveFlatten(catalogue, start));
    });
  }

  it('R2 should keep the NEWEST copy of a component, with the path it arrived by', () => {
    // Arrange
    const catalogue = catalogueOf(
      GRAPHS['a base used under two parents, with a repeated item at different places']!.graph,
      ITEMS,
    );

    // Act
    const actual = flattenProfile(catalogue, 'top');

    // Assert — `dup` is named by top, by left (twice: its own and through base) and by base under right; the newest copy
    // is the one inside base under right, so it is `right` that brought it and `base` it came through.
    if (!actual.ok) throw new Error('expected layers');
    should(actual.layers.map(layer => layer.reference)).deepEqual([
      'mcp/one',
      'mcp/two',
      'mcp/three',
      'mcp/dup',
      'mcp/last',
    ]);
    const dup = actual.layers.find(layer => layer.reference === 'mcp/dup');
    should(dup?.via).deepEqual(['right', 'base']);
    should(dup?.origin).equal('profile/right');
  });

  it('R2 should refuse a cycle behind a diamond with the same sentence data, however many ways lead into it', () => {
    // Arrange
    const catalogue = catalogueOf(GRAPHS['a cycle behind a diamond']!.graph, ITEMS);

    // Act
    const actual = flattenProfile(catalogue, 'top');

    // Assert
    should(actual).deepEqual({ ok: false, failure: { kind: 'loop', cycle: ['loop-a', 'loop-b', 'loop-a'] } });
  });
});

describe('R2 flattenProfile — a 4-deep diamond (2^4 paths)', () => {
  it('R2 should flatten it, each profile read once, the newest item last', () => {
    // Arrange
    const catalogue = catalogueOf(lattice(4), latticeItems(4));

    // Act
    const actual = flattenProfile(catalogue, 'a0');

    // Assert — every profile but b0 is reachable from a0, each contributing its one item; a0's own item is last.
    if (!actual.ok) throw new Error('expected layers');
    should(actual.layers.length).equal(9);
    should(new Set(actual.layers.map(layer => layer.reference)).size).equal(9);
    should(actual.layers.at(-1)?.reference).equal('mcp/a0');
  });

  it('R2 should read each layer text of each profile once, however many paths lead to it', () => {
    // Arrange
    const graph = lattice(4);
    let reads = 0;

    // Act
    const stack = expandStack<string, never>(
      name => graph[name],
      (text): StackLayer<string, never> => {
        reads++;
        return text.startsWith('profile/')
          ? { kind: 'base', name: text.slice('profile/'.length) }
          : { kind: 'leaf', key: text, item: text };
      },
      'a0',
    );

    // Assert — 9 profiles are reachable; the 7 above the last level hold 3 texts each, the two on it 1 each.
    should(stack.ok).be.true();
    should(reads).equal(7 * 3 + 2);
  });

  it('R2 should resolve a profile through the diamond (what every apply does)', () => {
    should(
      resolveProfile({ model: catalogueOf(lattice(4), latticeItems(4)), profile: 'a0', harness: 'claude' }).ok,
    ).be.true();
  });
});

describe('R2 flattenProfile — bounds, the second line of defence', () => {
  const chain = (length: number): Graph => {
    const graph: Record<string, readonly string[]> = {};
    for (let level = 0; level < length; level++)
      graph[`p${String(level)}`] = level === length - 1 ? ['mcp/one'] : [`profile/p${String(level + 1)}`];
    return graph;
  };

  it('R2 should read a chain exactly as deep as the limit', () => {
    // Arrange
    const catalogue = catalogueOf(chain(MAX_STACK_DEPTH), ITEMS);

    // Act
    const actual = flattenProfile(catalogue, 'p0');

    // Assert
    should(actual.ok).be.true();
  });

  it('R2 should refuse a chain one deeper than the limit', () => {
    // Arrange
    const catalogue = catalogueOf(chain(MAX_STACK_DEPTH + 1), ITEMS);

    // Act
    const actual = flattenProfile(catalogue, 'p0');

    // Assert
    should(actual).deepEqual({ ok: false, failure: { kind: 'too-deep', limit: MAX_STACK_DEPTH } });
  });

  it('R2 should refuse a base shared at a shallow place and again below the limit, as a fresh expansion would', () => {
    // Arrange — `deep` sits 2 profiles under top directly, and again at the end of a long chain: the second reach is too
    // deep even though `deep` itself was already expanded (and remembered) at the shallow place.
    const graph: Record<string, readonly string[]> = {
      top: ['profile/deep', 'profile/c0'],
      deep: ['profile/d1'],
      d1: ['profile/d2'],
      d2: ['mcp/one'],
      ...Object.fromEntries(
        Array.from({ length: MAX_STACK_DEPTH - 2 }, (_, level) => [
          `c${String(level)}`,
          [`profile/c${String(level + 1)}`],
        ]),
      ),
      [`c${String(MAX_STACK_DEPTH - 2)}`]: ['profile/deep'],
    };

    // Act
    const actual = flattenProfile(catalogueOf(graph, ITEMS), 'top');

    // Assert
    should(actual).deepEqual({ ok: false, failure: { kind: 'too-deep', limit: MAX_STACK_DEPTH } });
  });

  it('R2 should refuse a profile that expands to more layers than the limit', () => {
    // Arrange — 11 bases of 1,000 distinct items each: 11,000 layers in the one profile.
    const items = Array.from({ length: 11 * 1000 }, (_, index) => `i${String(index)}`);
    const graph: Record<string, readonly string[]> = {
      top: Array.from({ length: 11 }, (_, base) => `profile/b${String(base)}`),
    };
    for (let base = 0; base < 11; base++)
      graph[`b${String(base)}`] = Array.from({ length: 1000 }, (_, item) => `mcp/i${String(base * 1000 + item)}`);

    // Act
    const actual = flattenProfile(catalogueOf(graph, items), 'top');

    // Assert
    should(actual).deepEqual({ ok: false, failure: { kind: 'too-large', limit: MAX_STACK_LAYERS } });
  });
});

describe('R2 expandStack — the cycle guard is not hidden by what was remembered', () => {
  it('R2 should still find a loop whose way in goes through a base that was expanded earlier', () => {
    // Arrange — `shared` is expanded and remembered first; `other` then reaches `top` again through it.
    const graph = GRAPHS['a cycle through a base a sibling already expanded']!.graph;

    // Act
    const actual = flattenProfile(catalogueOf(graph, ITEMS), 'top');

    // Assert
    should(actual).deepEqual({ ok: false, failure: { kind: 'loop', cycle: ['top', 'other', 'top'] } });
  });
});

describe('R2 parseAccountModel — the schema still refuses a loop of bases', () => {
  it('R2 should refuse a document whose profiles reach themselves', () => {
    // Act + Assert
    should(() =>
      parseAccountModel({
        version: 1,
        components: { mcp: { one: { command: 'srv' } } },
        profiles: { a: { layers: ['profile/b'] }, b: { layers: ['profile/a', 'mcp/one'] } },
      }),
    ).throw();
  });
});
