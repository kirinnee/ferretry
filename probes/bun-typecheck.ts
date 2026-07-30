import { defineGate } from './lib/definition.ts';
import { expectGreen, expectRed } from './lib/helpers.ts';

const command = "nix develop .#ci -c bash -lc './scripts/local/setup.sh && pre-commit run typecheck --all-files'";

export default defineGate({
  sandbox: { snapshot: 'git', preserve: ['.direnv'] },
  baseline: {
    name: 'baseline-bun-typecheck-green',
    description: 'The generated typecheck hook accepts the strict TypeScript source.',
    async run(repo) {
      await expectGreen(repo, command, 'bun-typecheck');
    },
  },
  mutation: {
    name: 'mutation-bun-typecheck-caught',
    description: 'A TypeScript assignment error turns the typecheck hook red.',
    expectedImpact: [],
    async run(repo) {
      const path = (await repo.glob('packages/cli/src/lib/**/*.ts')).sort()[0];
      if (!path) throw new Error('no TypeScript library source found');
      await repo.write(path, `${await repo.read(path)}\nconst probeTypeError: string = 1;\nvoid probeTypeError;\n`);
      await expectRed(repo, command, 'bun-typecheck');
    },
  },
});
