/**
 * The product's binary names, read from where the repo single-sources them (CLAUDE.md two-name model): the client is
 * the `bin` key of `packages/cli/package.json`, the daemon is the `bin` key of this package. Neither is a literal
 * here, so `scripts/local/rename.sh --bin` moves both.
 */
import cliPackage from '../../../cli/package.json' with { type: 'json' };
import kernelPackage from '../package.json' with { type: 'json' };
import type { BinaryNames } from '../contract/ports.ts';

function firstBin(owner: string, bin: Readonly<Record<string, string>>): string {
  const name = Object.keys(bin)[0];
  if (name === undefined) throw new Error(`${owner} package.json declares no bin entry`);
  return name;
}

export const PRODUCT_BINARIES: BinaryNames = Object.freeze({
  client: firstBin('cli', cliPackage.bin),
  daemon: firstBin('kernel', kernelPackage.bin),
});
