/** G5 / §9.6: a package's `consumes` folds the ask sources AND reference prefixes it renders and the input.targets kinds it drives. */
import { describe, expect, test } from 'bun:test';
import type { Manifest } from '../../../packages/core/kernel/manifest/index.ts';
import type { StartGraph } from '../lib/graph.ts';
import { consumedBy } from '../lib/hashes.ts';

const hook = (name: string) => ({ hook: { name } });
const manifests: Record<string, Partial<Manifest>> = {
  // Board registers the ask source `card` and renders `&`.
  board: {
    id: 'board',
    hooks: { takes: [{ hook: { name: 'ask.sources' } as never, key: 'card' }] },
    ui: {
      renderers: [
        { kind: 'ask', source: 'card', key: 'ask:card' },
        { kind: 'reference', prefix: '&', key: 'reference:&' },
      ],
    },
  } as never,
  // Agenda renders Board's ask source and ALSO the `&` prefix Board registered first.
  agenda: {
    id: 'agenda',
    ui: {
      renderers: [
        { kind: 'ask', source: 'card', key: 'ask:card' },
        { kind: 'reference', prefix: '&', key: 'reference:&' },
      ],
    },
  } as never,
  // Notes renders a prefix nobody else registered: it consumes nothing for it.
  notes: { id: 'notes', ui: { renderers: [{ kind: 'reference', prefix: '#', key: 'reference:#' }] } } as never,
  // Vault offers input.targets; Terminals and Browsers take it with a kind; Voice does not.
  vault: { id: 'vault', hooks: { offers: [hook('input.targets')] } } as never,
  terminals: {
    id: 'terminals',
    hooks: { takes: [{ hook: { name: 'input.targets' } as never, key: 'terminal' }] },
  } as never,
  browsers: { id: 'browsers', hooks: { takes: [{ hook: { name: 'input.targets' } as never, key: 'page' }] } } as never,
  voice: { id: 'voice' } as never,
};

function graphOf(ids: readonly string[]): StartGraph {
  const offerers = new Map<string, string[]>([['input.targets', ['vault']]]);
  return {
    ids,
    manifests: new Map(ids.map(id => [id, manifests[id] as Manifest])),
    providers: new Map(),
    offerers,
    hooks: new Map(),
    before: new Map(),
    order: ids,
    cycle: undefined,
  } as unknown as StartGraph;
}

describe('consumedBy: dynamic contracts by key (§9.6)', () => {
  const ids = ['board', 'agenda', 'notes', 'vault', 'terminals', 'browsers', 'voice'];
  const consumed = consumedBy(graphOf(ids), []);
  const of = (id: string): string[] => [...(consumed.get(id) ?? [])].sort();

  test('an ask-source renderer consumes the source’s registrar (as before)', () => {
    expect(of('agenda')).toContain('board');
  });

  test('G5 a reference-prefix renderer consumes the package that registered the prefix first, and a first registrar consumes nobody for it', () => {
    expect(of('agenda')).toEqual(['board']);
    expect(of('board')).toEqual([]);
    expect(of('notes')).toEqual([]);
  });

  test('G5 a package that offers input.targets consumes every taker of a kind; a taker does not consume the other kinds', () => {
    expect(of('vault')).toEqual(['browsers', 'terminals']);
    expect(of('terminals')).toEqual(['vault']);
    expect(of('browsers')).toEqual(['vault']);
    expect(of('voice')).toEqual([]);
  });
});
