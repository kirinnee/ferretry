/**
 * Ferrets' `contract/{slots,hooks,kinds,app-hooks}/` folders hold one file per slot, hook, kind or app hook, and the
 * generator writes `contract/generated/<folder>.ts` from them. These tests pin the rules on a fixture package: every file
 * is re-exported by file name, `FERRET_SLOTS` is the account slots then each `*.slot.ts`, the app-hook records name each
 * `*.app-hook.ts` / `*.provided-hook.ts`, a nested helper is not listed, and an empty folder gets no file.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { type Fixture, fixture, skeletonHalf } from './fixture.ts';
import { contractRegistries } from '../registries.ts';
import { loadWorkspace } from '../lib/workspace.ts';

const made: Fixture[] = [];
afterAll(() => {
  for (const f of made) f.dispose();
});
const HOME = 'packages/plugins/alpha';
const out = (folder: string): string => `${HOME}/contract/generated/${folder}.ts`;
const stub = 'export default { name: "x", narrow: () => true };\n';

const generated = (files: Record<string, string>): ReadonlyMap<string, string> => {
  const f = fixture(
    [{ id: 'alpha', daemon: skeletonHalf('Daemon'), app: skeletonHalf('App'), cli: skeletonHalf('Cli'), files }],
    {},
  );
  made.push(f);
  return contractRegistries(loadWorkspace(f.root), HOME);
};

describe('contract registries', () => {
  test('every file of a folder is re-exported by file name; a nested helper and another folder are not', () => {
    const text = generated({
      'contract/kinds/runner.ts': 'export type R = 1;\n',
      'contract/kinds/harness.ts': 'export type H = 1;\n',
      'contract/kinds/shared/helper.ts': 'export const h = 1;\n',
      'contract/view/other.ts': 'export type V = 1;\n',
    }).get(out('kinds'));
    expect([...(text ?? '').matchAll(/export \* from '([^']+)'/g)].map(match => match[1])).toEqual([
      '../kinds/harness.ts',
      '../kinds/runner.ts',
    ]);
  });

  test('FERRET_SLOTS is the account slots, then each *.slot.ts by file name; the type follows the list', () => {
    const text = generated({
      'contract/slots/account-slots.ts': 'export const FERRET_ACCOUNT_SLOTS = ["a"] as const;\n',
      'contract/slots/zeta.slot.ts': 'export default { slot: "z" } as const;\n',
      'contract/slots/alpha.slot.ts': 'export default { slot: "a" } as const;\n',
    }).get(out('slots'));
    expect(text).toContain(
      'export const FERRET_SLOTS = [...FERRET_ACCOUNT_SLOTS, contract_alpha_slot.slot, contract_zeta_slot.slot] as const;',
    );
    expect(text).toContain('export type FerretSlot = (typeof FERRET_SLOTS)[number];');
  });

  test('the app-hook records name each offered and each provided hook, by file name', () => {
    const text =
      generated({
        'contract/app-hooks/b.app-hook.ts': stub,
        'contract/app-hooks/a.app-hook.ts': stub,
        'contract/app-hooks/c.provided-hook.ts': stub,
      }).get(out('app-hooks')) ?? '';
    expect(text).toMatch(
      /FERRETS_APP_HOOKS = \{\n {2}\[contract_a_app_hook\.name\]: contract_a_app_hook\.narrow,\n {2}\[contract_b_app_hook\.name\]: contract_b_app_hook\.narrow,\n\} as const;/,
    );
    expect(text).toMatch(
      /FERRETS_PROVIDED_APP_HOOKS = \{\n {2}\[contract_c_provided_hook\.name\]: contract_c_provided_hook\.narrow,\n\} as const;/,
    );
  });

  test('a package without the folders, or another package, gets no file', () => {
    expect([...generated({ 'contract/index.ts': 'export {};\n' }).keys()]).toEqual([]);
  });
});
