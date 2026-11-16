/**
 * Ferrets' `contract/state/*.state.ts` files each declare their area's files with `export const X = defineState(...)`, and
 * the generator writes `contract/generated/state.ts` from them: every file re-exported, every declared state listed in
 * `FERRETS_STATE` (file-name order, then declaration order). These tests pin that on a fixture package, and that a
 * `defineState(` the list would miss is refused rather than left out.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { type Fixture, fixture, skeletonHalf } from './fixture.ts';
import { loadWorkspace } from '../lib/workspace.ts';
import { contractRegistries, declaredStates } from '../registries.ts';

const made: Fixture[] = [];
afterAll(() => {
  for (const f of made) f.dispose();
});
const HOME = 'packages/plugins/alpha';
const OUT = `${HOME}/contract/generated/state.ts`;

const generated = (files: Record<string, string>): string | undefined => {
  const f = fixture(
    [{ id: 'alpha', daemon: skeletonHalf('Daemon'), app: skeletonHalf('App'), cli: skeletonHalf('Cli'), files }],
    {},
  );
  made.push(f);
  return contractRegistries(loadWorkspace(f.root), HOME).get(OUT);
};

describe('declaredStates', () => {
  test('lists every exported defineState result in declaration order, typed or not', () => {
    const text = [
      "import { defineState } from '@ferretry/kernel/contract';",
      "export const A = defineState({ name: 'a', path: 'a.json', store: 'json', format: 1 });",
      '/** `defineState(` in a comment is not a declaration. */',
      "export const B = defineState<'b', Uint8Array>({",
      "  name: 'b',",
      '});',
    ].join('\n');
    expect(declaredStates('x.state.ts', text)).toEqual(['A', 'B']);
  });

  test('a defineState call that is not an exported const is refused, naming the file', () => {
    expect(() => declaredStates('x.state.ts', "const Hidden = defineState({ name: 'h' });\n")).toThrow(/x\.state\.ts/);
  });

  test('a file with no state (a plain constant) lists none', () => {
    expect(declaredStates('x.state.ts', "export const FOLDER = 'instructions' as const;\n")).toEqual([]);
  });
});

describe('state registry', () => {
  const state = (name: string): string =>
    `import { defineState } from '@ferretry/kernel/contract';\nexport const ${name} = defineState({ name: '${name}', path: '${name}.json', store: 'json', format: 1 });\n`;

  test('every state file is re-exported and its states listed, file by file then in declaration order', () => {
    const text = generated({
      'contract/state/zeta.state.ts': `${state('Zeta')}${state('Zed').split('\n')[1]}\n`,
      'contract/state/alpha.state.ts': state('Alpha'),
      'contract/state/plain.state.ts': "export const FOLDER = 'x' as const;\n",
      'contract/state/notes.ts': 'export const ignored = 1;\n',
    });
    expect(text).toContain('export const FERRETS_STATE = [Alpha, Zeta, Zed] as const;');
    expect([...(text ?? '').matchAll(/export \* from '([^']+)'/g)].map(match => match[1])).toEqual([
      '../state/alpha.state.ts',
      '../state/plain.state.ts',
      '../state/zeta.state.ts',
    ]);
  });

  test('a package without the folder gets no file', () => {
    expect(generated({ 'contract/index.ts': 'export {};\n' })).toBeUndefined();
  });
});
