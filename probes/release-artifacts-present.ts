import { definePresence } from './lib/definition.ts';

// The static release surface the pipeline depends on must exist in the tree.
const required = ['.goreleaser.yaml', '.releaserc.yaml', 'Casks/*.rb', 'scripts/release/install.sh', 'VERSION'];

export default definePresence({
  sandbox: { snapshot: 'git', preserve: ['.direnv'] },
  baseline: {
    name: 'baseline-release-artifacts-present',
    description: 'The release pipeline artifacts (goreleaser, releaserc, cask, installer, VERSION) exist.',
    async run(repo) {
      for (const pattern of required) {
        if ((await repo.glob(pattern)).length === 0) throw new Error(`missing required artifact: ${pattern}`);
      }
    },
  },
});
