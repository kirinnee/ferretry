import { defineGate } from './lib/definition.ts';
import { expectGreen, expectRed } from './lib/helpers.ts';

const command = 'nix develop .#ci -c ./scripts/validate/cli-contracts.sh workspace-package-scopes';

export default defineGate({
  sandbox: { snapshot: 'git', preserve: ['.direnv'] },
  baseline: {
    name: 'baseline-workspace-package-scopes-green',
    description: 'Every library package is scoped from the root product name.',
    async run(repo) {
      await expectGreen(repo, command, 'workspace-package-scopes');
    },
  },
  mutation: {
    name: 'mutation-workspace-package-scopes-caught',
    description: 'A drifted workspace package scope turns the contract red.',
    expectedImpact: [],
    async run(repo) {
      const path = 'packages/protocol/package.json';
      const manifest = JSON.parse(await repo.read(path)) as { name: string };
      manifest.name = '@wrong/protocol';
      await repo.write(path, `${JSON.stringify(manifest, null, 2)}\n`);
      await expectRed(repo, command, 'workspace-package-scopes');
    },
  },
});
