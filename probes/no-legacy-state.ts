import { defineGate } from './lib/definition.ts';
import { expectGreen, expectRed } from './lib/helpers.ts';

const command = 'nix develop .#ci -c ./scripts/validate/no-legacy-state.sh';

export default defineGate({
  sandbox: { snapshot: 'git', preserve: ['.direnv'] },
  baseline: {
    name: 'baseline-no-legacy-state-green',
    description: 'Workspace packages contain no forbidden legacy identifiers or state paths.',
    async run(repo) {
      await expectGreen(repo, command, 'no-legacy-state');
    },
  },
  mutation: {
    name: 'mutation-no-legacy-state-caught',
    description: 'A planted legacy state path in an untracked package source turns the gate red.',
    expectedImpact: [],
    async run(repo) {
      await repo.write(
        'packages/protocol/src/lib/legacy-state-probe.ts',
        "export const legacyStateProbe = '.kteam/probe';\n",
      );
      await expectRed(repo, command, 'no-legacy-state');
    },
  },
});
