import { staticGate } from './lib/cli-contract.ts';

export default staticGate('cli-homebrew-cask', 'homebrew-cask', {
  path: '.goreleaser.yaml',
  find: 'directory: Casks',
  replace: 'directory: Formula',
});
