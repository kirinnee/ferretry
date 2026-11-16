/**
 * The production dead-code run (`knip --config knip.production.ts`, from the entry points, no tests). Only what is
 * global lives here: the rules, the tags, the switched-off knip plugins, the root workspace and the two glob defaults.
 * Every package's own entries, ignores and kept files live in `<package>/knip.production.json` and are composed in; see
 * `scripts/gen/lib/knip-config.ts`. A package key added to this file is refused by `scripts/validate/pending-tags.ts`.
 */
import { fileURLToPath } from 'node:url';
import { composeKnip, type KnipGlobals } from './scripts/gen/lib/knip-config.ts';

export const globals: KnipGlobals = {
  bun: false,
  'github-actions': false,
  node: false,
  taskfile: false,
  typescript: false,
  rules: {
    files: 'error',
    exports: 'off',
    types: 'off',
    nsExports: 'off',
    nsTypes: 'off',
    duplicates: 'off',
    devDependencies: 'off',
    optionalPeerDependencies: 'off',
    binaries: 'off',
    enumMembers: 'off',
    dependencies: 'warn',
  },
  tags: ['-pending'],
  workspaces: {
    '.': {
      entry: [],
      project: [],
    },
    'packages/core/*': {
      entry: [],
      project: ['**/*.{ts,tsx}', '!tests/**'],
    },
    'packages/plugins/*': {
      entry: [],
      project: ['**/*.{ts,tsx}', '!tests/**'],
    },
  },
};

export default composeKnip(fileURLToPath(new URL('.', import.meta.url)), 'knip.production.json', globals);
