import type { AccountModel } from '../../daemon/lib/account/schema.ts';

// A profile catalogue over a graph of bases, and the diamond of shared bases with a Claude leaf at the bottom: shared by
// the scope-memo tests of the unit tier (a small diamond) and the perf tier (the 20-deep one).

export type Graph = Readonly<Record<string, readonly string[]>>;
type Catalogue = Pick<AccountModel, 'profiles' | 'components'>;

export const catalogueOf = (graph: Graph): Catalogue =>
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

/** Two profiles per level, each naming BOTH profiles of the next level, a Claude leaf at the bottom: 2^depth paths. */
export const diamond = (depth: number): Graph => {
  const graph: Record<string, readonly string[]> = {};
  for (let level = 0; level <= depth; level++)
    for (const side of ['a', 'b'])
      graph[`${side}${String(level)}`] =
        level === depth ? ['mcp/cl'] : [`profile/a${String(level + 1)}`, `profile/b${String(level + 1)}`, 'mcp/any'];
  return graph;
};
