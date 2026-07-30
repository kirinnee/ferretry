import { commandSmoke } from './lib/cli-contract.ts';

export default commandSmoke(
  'cli-goreleaser-snapshot',
  'nix develop .#releaser -c ./scripts/release/publish.sh --snapshot',
);
