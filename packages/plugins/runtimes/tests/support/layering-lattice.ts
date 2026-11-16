import type { AccountModel } from '../../daemon/lib/account/schema.ts';

// A profile catalogue over a graph of bases, and the lattice of shared bases: shared by the layering-expansion tests of
// the unit tier (a small lattice) and the perf tier (the 20-deep one).

export type Graph = Readonly<Record<string, readonly string[]>>;

export /** A catalogue the schema would refuse (loops, unknown bases), for the total-function cases. */
const catalogueOf = (graph: Graph, mcp: readonly string[]) =>
  ({
    components: {
      instructions: {},
      mcp: Object.fromEntries(mcp.map(name => [name, { command: 'srv' }])),
      skills: {},
      settings: {},
      hooks: {},
      modelSets: {},
    },
    profiles: Object.fromEntries(Object.entries(graph).map(([name, layers]) => [name, { layers }])),
  }) as unknown as Pick<AccountModel, 'components' | 'profiles'>;

export /** Two profiles per level, each naming BOTH profiles of the next level and one item of its own: 2^depth paths. */
const lattice = (depth: number): Graph => {
  const graph: Record<string, readonly string[]> = {};
  for (let level = 0; level <= depth; level++)
    for (const side of ['a', 'b'])
      graph[`${side}${String(level)}`] =
        level === depth
          ? [`mcp/${side}${String(level)}`]
          : [`profile/a${String(level + 1)}`, `profile/b${String(level + 1)}`, `mcp/${side}${String(level)}`];
  return graph;
};

export const latticeItems = (depth: number): readonly string[] =>
  Array.from({ length: depth + 1 }, (_, level) => [`a${String(level)}`, `b${String(level)}`]).flat();
