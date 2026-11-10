import { describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { LaunchParts, type FerretId, type LaunchPartSource } from '@ferretry/core-ferrets/contract';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import agenda from '../../../daemon/index.ts';
import manifest from '../../../manifest.ts';

const spec = (ferret: string) => ({ ferret }) as never;

/** Boots Agenda and hands back what it contributes to `launch.parts`, and its provided api. */
async function boot(ferrets: FakeFerrets) {
  const taken: {
    hooks?: Record<string, unknown>;
    api?: { setMode(ferret: FerretId, enabled: boolean): Promise<unknown> };
  } = {};
  const capturing = {
    ...agenda,
    build: (ctx: never) => {
      const half = (
        agenda.build as unknown as (ctx: never) => { hooks: Record<string, unknown>; provides: { agenda: never } }
      )(ctx);
      taken.hooks = half.hooks;
      taken.api = half.provides.agenda;
      return half;
    },
  } as unknown as typeof agenda;
  const host = await testHost({ plugins: [capturing], fakes: { asks: new FakeAsks(), ferrets } });
  const contribute = taken.hooks?.['launch.parts'] as () => readonly {
    readonly id: string;
    readonly item: LaunchPartSource;
  }[];
  return { host, contributions: contribute(), api: taken.api };
}

describe('agenda contributes FY_AGENDA to launch.parts (ports-pending: [contribute: agenda] launch flag)', () => {
  test('the manifest takes the launch.parts hook Ferrets offers', () => {
    expect(manifest.hooks?.takes?.some(take => take.hook.name === LaunchParts.name)).toBe(true);
  });

  test('a real boot contributes ONE agenda part: FY_AGENDA follows the recorded switch, else the machine default (on)', async () => {
    const ferrets = new FakeFerrets();
    ferrets.add({ id: 'f1' as FerretId });
    ferrets.add({ id: 'f2' as FerretId });
    const { host, contributions, api } = await boot(ferrets);
    try {
      expect(contributions.map(each => each.id)).toEqual(['agenda']);
      const [only] = contributions;
      if (only === undefined) throw new Error('no agenda part');
      expect(await only.item.parts(spec('f1'))).toEqual([{ kind: 'env', env: { FY_AGENDA: '1' } }]);
      await api?.setMode('f2' as FerretId, false);
      expect(await only.item.parts(spec('f2'))).toEqual([{ kind: 'env', env: { FY_AGENDA: '0' } }]);
      expect(await only.item.parts(spec('f1'))).toEqual([{ kind: 'env', env: { FY_AGENDA: '1' } }]);
    } finally {
      await host.stop();
    }
  });
});
