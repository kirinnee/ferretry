import { describe, it } from 'bun:test';
import { definePort } from '@ferretry/kernel/contract';
import { definePlugin } from '@ferretry/kernel/manifest';
import should from 'should';
import { buildPluginGraph } from '../../src/lib/plugin-graph.ts';
import { registryOf, skeletonEntry } from './fakes.ts';

const A = definePort<{ a(): void }>('a');
const B = definePort<{ b(): void }>('b');
const make = (id: string, extra: object) =>
  skeletonEntry(definePlugin({ id, title: id, version: '5.0.0', api: 5, core: false, kinds: ['command'], ...extra }));

describe('plugin graph', () => {
  const registry = registryOf(
    make('one', { provides: { a: A } }),
    make('two', { needs: { a: A }, provides: { b: B } }),
    make('three', { needs: { b: B } }),
    make('four', { uses: { a: A } }),
  );
  const graph = buildPluginGraph(registry);

  it('should follow needs through other plugins when asked what stops with one', () => {
    should(graph.dependentsOf('one')).deepEqual(['three', 'two']);
    should(graph.dependentsOf('three')).deepEqual([]);
  });

  it('should keep optional users apart from dependents', () => {
    should(graph.usersOf('one')).deepEqual(['four']);
    should(graph.dependentsOf('one')).not.containEql('four');
  });

  it('should answer a plugin’s own edges', () => {
    should(graph.edges('two')).deepEqual({ needs: ['one'], uses: [] });
    should(graph.edges('unknown')).deepEqual({ needs: [], uses: [] });
  });
});
