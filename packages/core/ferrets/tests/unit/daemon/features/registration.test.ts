import { expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeGate, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import manifest from '../../../../manifest.ts';
import ferrets from '../../../../daemon/index.ts';
import features from '../../../../daemon/generated/features.ts';

/**
 * The features under `daemon/features/*.feature.ts` are Ferrets' whole route and socket surface: the registration serves
 * every key the manifest declares exactly once (compose refuses a key served twice), so a feature cannot be dropped from
 * the generated list, or a route left unserved, without this failing.
 */
test('the registered features serve exactly the routes and sockets the manifest declares', async () => {
  let served: { routes: string[]; sockets: string[] } | undefined;
  await testHost({
    plugins: [
      {
        ...ferrets,
        build: (ctx: never) => {
          const half = (ferrets as unknown as { build: (c: never) => Record<string, Record<string, unknown>> }).build(
            ctx,
          );
          served = { routes: Object.keys(half.routes ?? {}).sort(), sockets: Object.keys(half.sockets ?? {}).sort() };
          return half as never;
        },
      } as never,
    ],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks() },
  });
  const declared = (kind: 'routes' | 'sockets'): string[] =>
    (manifest.actions?.[kind] ?? []).map((entry: { readonly key: string }) => entry.key).sort();
  expect(served?.routes).toEqual(declared('routes'));
  expect(served?.sockets).toEqual(declared('sockets'));
});

test('every feature has its own id', () => {
  const ids = features.map(feature => feature.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.length).toBeGreaterThan(0);
});
