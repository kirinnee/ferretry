/**
 * R2 (M-1): a profile's derived scope (`profileScope`) folds its bases; a base reached by many paths is folded once. The
 * reference here is the per-path fold as it was before (`naiveScope`, test-local), so the memo changes cost and nothing
 * else — including on a loop (which the schema refuses, but the function is total over a draft).
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { layersScope, type ProfileScope, profileScope } from '../../../daemon/lib/account/scope.ts';
import { type AccountModel, type LayerReferenceText, parseLayerReference } from '../../../daemon/lib/account/schema.ts';

type Graph = Readonly<Record<string, readonly string[]>>;
type Catalogue = Pick<AccountModel, 'profiles' | 'components'>;

const catalogueOf = (graph: Graph): Catalogue =>
  ({
    components: {
      instructions: {},
      mcp: {
        any: { command: 'srv' },
        cl: { command: 'srv', harness: 'claude' },
        cl2: { command: 'srv', harness: 'claude' },
        cx: { command: 'srv', harness: 'codex' },
      },
      skills: {},
      settings: {},
      hooks: {},
      modelSets: {},
    },
    profiles: Object.fromEntries(Object.entries(graph).map(([name, layers]) => [name, { layers }])),
  }) as unknown as Catalogue;

/** The fold as it was: every path walked, a loop cut by the profiles on the way. */
function naiveScope(catalogue: Catalogue, name: string): ProfileScope {
  return naiveLayersScope(catalogue, catalogue.profiles[name]?.layers ?? [], name);
}

/** The same fold for layers a draft carries, `name` being the profile they would belong to (it may be a saved one being edited). */
function naiveLayersScope(catalogue: Catalogue, draftLayers: readonly string[], name: string): ProfileScope {
  const layerScope = (reference: LayerReferenceText, visiting: ReadonlySet<string>): string => {
    const parsed = parseLayerReference(reference);
    if (parsed === undefined) return 'generic';
    if (parsed.kind === 'component') {
      const component = (catalogue.components[parsed.componentKind] as Record<string, { harness?: string }>)[
        parsed.name
      ];
      return component?.harness ?? 'generic';
    }
    const base = catalogue.profiles[parsed.name];
    if (base === undefined || visiting.has(parsed.name)) return 'generic';
    const scope = fold(base.layers, new Set([...visiting, parsed.name]));
    return scope.kind === 'mixed' ? 'mixed' : scope.scope;
  };
  const fold = (layers: readonly string[], visiting: ReadonlySet<string>): ProfileScope => {
    let claude: LayerReferenceText | undefined;
    let codex: LayerReferenceText | undefined;
    for (const text of layers) {
      const reference = text as LayerReferenceText;
      const scope = layerScope(reference, visiting);
      if ((scope === 'claude' || scope === 'mixed') && claude === undefined) claude = reference;
      if ((scope === 'codex' || scope === 'mixed') && codex === undefined) codex = reference;
    }
    if (claude !== undefined && codex !== undefined) return { kind: 'mixed', claude, codex };
    if (claude !== undefined) return { kind: 'scoped', scope: 'claude' };
    if (codex !== undefined) return { kind: 'scoped', scope: 'codex' };
    return { kind: 'scoped', scope: 'generic' };
  };
  return fold(draftLayers, new Set([name]));
}

const GRAPHS: Readonly<Record<string, Graph>> = {
  'generic bases': { top: ['profile/a', 'mcp/any'], a: ['mcp/any'] },
  'a Claude base shared by two parents': {
    top: ['profile/left', 'profile/right'],
    left: ['profile/base'],
    right: ['profile/base', 'mcp/any'],
    base: ['mcp/cl'],
  },
  'a Claude and a Codex base under one profile': {
    top: ['profile/c', 'profile/x'],
    c: ['mcp/cl'],
    x: ['mcp/cx'],
  },
  'a mixed base shared by two parents': {
    top: ['profile/left', 'profile/right'],
    left: ['profile/base'],
    right: ['mcp/cl2', 'profile/base'],
    base: ['mcp/cl', 'mcp/cx'],
  },
  'a missing base': { top: ['profile/ghost', 'mcp/cl'] },
  'a profile that names itself': { top: ['mcp/cl', 'profile/top'] },
  'a loop behind a shared base': {
    top: ['profile/left', 'profile/right'],
    left: ['profile/base'],
    right: ['profile/base', 'mcp/cx'],
    base: ['profile/loop-a'],
    'loop-a': ['mcp/cl', 'profile/loop-b'],
    'loop-b': ['profile/loop-a', 'mcp/any'],
  },
  'a loop through a base a sibling already folded': {
    top: ['profile/shared', 'profile/other'],
    shared: ['mcp/cl'],
    other: ['profile/shared', 'profile/top', 'mcp/cx'],
  },
};

describe('R2 profileScope — the memoised fold says what the per-path fold said', () => {
  for (const [label, graph] of Object.entries(GRAPHS)) {
    it(`R2 should give, for ${label}, the scope of every profile as the per-path fold does`, () => {
      // Arrange
      const catalogue = catalogueOf(graph);

      // Act + Assert
      for (const name of Object.keys(graph))
        should(profileScope(catalogue, name)).deepEqual(naiveScope(catalogue, name));
    });
  }

  it('R2 should give the per-path fold’s scope for every profile of 2,000 seeded random graphs, loops included', () => {
    // Arrange — 4 profiles naming each other, a Claude and a Codex component, and a generic one, at random.
    let seed = 20_261_109;
    const next = (below: number): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed % below;
    };
    const layerTexts = ['profile/p0', 'profile/p1', 'profile/p2', 'profile/p3', 'mcp/cl', 'mcp/cx', 'mcp/any'];

    for (let round = 0; round < 2000; round++) {
      const graph: Record<string, string[]> = {};
      for (const name of ['p0', 'p1', 'p2', 'p3'])
        graph[name] = Array.from({ length: next(4) }, () => layerTexts[next(layerTexts.length)] as string);
      const catalogue = catalogueOf(graph);

      // Act + Assert
      for (const name of Object.keys(graph))
        should({ round, graph, scope: profileScope(catalogue, name) }).deepEqual({
          round,
          graph,
          scope: naiveScope(catalogue, name),
        });
    }
  });

  it('R2 should give the per-path fold’s scope for 2,000 seeded random DRAFTS (layers + the name they would stand under), cuts included', () => {
    // Arrange — 5 profiles; a draft of 0–4 layers standing under one of them (an edit, so a loop is cut at the draft's own
    // name), or under a name no profile has, with `undefined` read as the same free name.
    let seed = 20_261_110;
    const next = (below: number): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed % below;
    };
    const names = ['p0', 'p1', 'p2', 'p3', 'p4'];
    const layerTexts = [...names.map(name => `profile/${name}`), 'mcp/cl', 'mcp/cl2', 'mcp/cx', 'mcp/any', 'mcp/any'];
    const pick = (): string => layerTexts[next(layerTexts.length)] as string;
    let cutCases = 0;

    for (let round = 0; round < 2000; round++) {
      const graph: Record<string, string[]> = {};
      for (const name of names) graph[name] = Array.from({ length: next(4) }, pick);
      const catalogue = catalogueOf(graph);
      const draft = Array.from({ length: next(5) }, pick);
      const standing = [...names, 'draft', undefined][next(names.length + 2)];

      // Act
      const actual = layersScope(catalogue, draft, standing);
      const expected = naiveLayersScope(catalogue, draft, standing ?? 'draft');

      // Assert
      should({ round, graph, draft, standing, scope: actual }).deepEqual({
        round,
        graph,
        draft,
        standing,
        scope: expected,
      });
      if (standing !== undefined && standing !== 'draft' && draft.some(text => text === `profile/${standing}`))
        cutCases++;
    }
    should(cutCases).be.above(50);
  });

  it('R2 should fold a draft that edits the diamond’s bottom to name its top (a loop cut under every path) inside the deadline', () => {
    // Arrange — the 20-deep diamond with a Claude leaf, then b20 (the bottom) is edited to name a0 (the top): every path of
    // a0 ends back at b20, which is on the chain, so a fold that remembers nothing below a cut walks all 2^20 of them.
    const depth = 20;
    const graph: Record<string, readonly string[]> = {};
    for (let level = 0; level <= depth; level++)
      for (const side of ['a', 'b'])
        graph[`${side}${String(level)}`] =
          level === depth ? ['mcp/cl'] : [`profile/a${String(level + 1)}`, `profile/b${String(level + 1)}`, 'mcp/any'];

    // Act
    const started = performance.now();
    const actual = layersScope(catalogueOf(graph), ['profile/a0', 'mcp/cx'], 'b20');
    const took = performance.now() - started;

    // Assert — a0 reaches the Claude leaf, the draft's own Codex component joins it: mixed, naming the first of each.
    should(actual).deepEqual({ kind: 'mixed', claude: 'profile/a0', codex: 'mcp/cx' });
    should(took).be.below(1000);
  });

  it('R2 should fold a 20-deep diamond (2^20 paths) inside the deadline, keeping a Claude leaf at the bottom', () => {
    // Arrange
    const depth = 20;
    const graph: Record<string, readonly string[]> = {};
    for (let level = 0; level <= depth; level++)
      for (const side of ['a', 'b'])
        graph[`${side}${String(level)}`] =
          level === depth ? ['mcp/cl'] : [`profile/a${String(level + 1)}`, `profile/b${String(level + 1)}`, 'mcp/any'];

    // Act
    const started = performance.now();
    const actual = profileScope(catalogueOf(graph), 'a0');
    const took = performance.now() - started;

    // Assert
    should(actual).deepEqual({ kind: 'scoped', scope: 'claude' });
    should(took).be.below(1000);
  });
});
