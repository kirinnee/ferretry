import { defineSmoke } from './lib/definition.ts';
import { expectGreen } from './lib/helpers.ts';

export default defineSmoke({
  sandbox: { snapshot: 'git', preserve: ['.direnv'] },
  baseline: {
    name: 'baseline-direnv-green',
    description: 'The committed .envrc loads the repository environment with an isolated direnv config.',
    async run(repo) {
      await expectGreen(
        repo,
        'config="$(mktemp -d)" && DIRENV_CONFIG="$config" direnv allow . && DIRENV_CONFIG="$config" direnv exec . true',
        'direnv',
      );
    },
  },
});
