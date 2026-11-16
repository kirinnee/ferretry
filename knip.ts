/**
 * The repository dead-code run (`knip --config knip.ts`, tests included). Only what is global lives here: the rules, the
 * tags, the root workspace and the two glob defaults. Every package's own entries, ignores and kept exports live in
 * `<package>/knip.json` and are composed in; see `scripts/gen/lib/knip-config.ts`. A package key added to this file is
 * refused by `scripts/validate/pending-tags.ts`.
 */
import { fileURLToPath } from 'node:url';
import { composeKnip, type KnipGlobals } from './scripts/gen/lib/knip-config.ts';

export const globals: KnipGlobals = {
  rules: {
    files: 'error',
    exports: 'error',
    types: 'error',
    nsExports: 'error',
    nsTypes: 'error',
    duplicates: 'error',
    dependencies: 'off',
    devDependencies: 'off',
    optionalPeerDependencies: 'off',
    unlisted: 'off',
    unresolved: 'off',
    binaries: 'off',
    enumMembers: 'off',
  },
  tags: ['-pending'],
  workspaces: {
    '.': {
      entry: ['scripts/test/*.ts'],
      project: ['scripts/test/*.ts'],
    },
    'packages/core/*': {
      entry: ['tests/**/*.test.{ts,tsx}'],
      project: ['**/*.{ts,tsx}'],
    },
    'packages/plugins/*': {
      entry: ['tests/**/*.test.{ts,tsx}'],
      project: ['**/*.{ts,tsx}'],
    },
  },
};

export default composeKnip(fileURLToPath(new URL('.', import.meta.url)), 'knip.json', globals);
