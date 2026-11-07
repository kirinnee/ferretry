import { describe, expect, test } from 'bun:test';
import { AdmissionPort, ChildEnvironmentPort } from '../../../contract/bound.ts';
import { definePort } from '../../../contract/define.ts';
import { dependentsOf, planGraph } from '../../../host/graph.ts';
import type { Manifest } from '../../../manifest/types.ts';

const AsksPort = definePort<object>('asks');
const BoardPort = definePort<object>('board');

const plugin = (id: string, extra: Partial<Manifest> = {}): Manifest => ({
  id,
  title: id,
  version: '1.0.0',
  api: 5,
  core: ['kernel', 'gate', 'asks', 'vault', 'ferrets'].includes(id),
  kinds: [],
  ...extra,
});

const none = (): readonly string[] => [];

describe('the plugin graph (§7.6 step 1, §2.4)', () => {
  test('start order puts providers first and core first among ties', () => {
    const plan = planGraph(
      [
        plugin('board', { needs: { asks: AsksPort }, provides: { board: BoardPort } }),
        plugin('agenda', { needs: { board: BoardPort } }),
        plugin('asks', { provides: { asks: AsksPort } }),
      ],
      () => true,
      none,
    );
    expect(plan.order.map(manifest => manifest.id)).toEqual(['asks', 'board', 'agenda']);
    expect(plan.refused).toEqual([]);
  });

  test('a plugin without its required provider is not started, and its dependents follow', () => {
    const plan = planGraph(
      [
        plugin('board', { needs: { asks: AsksPort }, provides: { board: BoardPort } }),
        plugin('agenda', { needs: { board: BoardPort } }),
      ],
      () => true,
      none,
    );
    expect(plan.order).toEqual([]);
    expect(plan.refused.map(refusal => [refusal.plugin, refusal.reason])).toEqual([
      ['board', 'missing-provider'],
      ['agenda', 'needs-refused'],
    ]);
  });

  test('an off plugin is not started; core cannot be turned off', () => {
    const plan = planGraph([plugin('board'), plugin('gate')], () => false, none);
    expect(plan.order.map(manifest => manifest.id)).toEqual(['gate']);
    expect(plan.refused[0]?.reason).toBe('off');
  });

  test('a kernel-bound port provided by anyone but its core piece is refused', () => {
    const plan = planGraph([plugin('access', { provides: { admission: AdmissionPort } })], () => true, none);
    expect(plan.refused[0]?.reason).toBe('bound-port');
  });

  test('a cycle through taken hooks is refused, naming the plugins', () => {
    const plan = planGraph(
      [plugin('a'), plugin('b')],
      () => true,
      manifest => (manifest.id === 'a' ? ['b'] : ['a']),
    );
    expect(plan.refused.map(refusal => refusal.reason)).toEqual(['cycle', 'cycle']);
  });

  test('dependents are everything that transitively needs a plugin', () => {
    const manifests = [
      plugin('asks', { provides: { asks: AsksPort } }),
      plugin('board', { needs: { asks: AsksPort }, provides: { board: BoardPort } }),
      plugin('agenda', { needs: { board: BoardPort } }),
    ];
    const plan = planGraph(manifests, () => true, none);
    expect(dependentsOf('asks', plan.order, plan.providers)).toEqual(['board', 'agenda']);
  });
});

describe('DD the ChildEnvironment opener reaches no half (lead decision 8)', () => {
  test('a plugin that needs or uses it is refused at plan; Vault providing it still starts', () => {
    const plan = planGraph(
      [
        plugin('vault', { provides: { childEnvironments: ChildEnvironmentPort } }),
        plugin('thief', { needs: { opener: ChildEnvironmentPort } }),
        plugin('peeker', { uses: { opener: ChildEnvironmentPort } }),
      ],
      () => true,
      none,
    );
    expect(plan.order.map(manifest => manifest.id)).toEqual(['vault']);
    expect(plan.refused.map(refusal => [refusal.plugin, refusal.reason, refusal.sentence])).toEqual([
      ['thief', 'kernel-only-port', 'thief asks for child-environment, which only the kernel may hold.'],
      ['peeker', 'kernel-only-port', 'peeker asks for child-environment, which only the kernel may hold.'],
    ]);
  });
});
