/**
 * The names this half types: the product read off its own package scope (`scripts/local/rename.sh --product` rewrites
 * every `@<product>/` specifier, so the literal moves with a rename) and the binary names the kernel hands every
 * plugin on `kernel.identity.binaries`.
 */
import type { BinaryNames } from '@ferretry/kernel/contract';
import type { UpdateNames } from './host.ts';

const PACKAGE_NAME = '@ferretry/plugin-updates';

const scope = /^@([a-z0-9][a-z0-9._-]*)\//u.exec(PACKAGE_NAME)?.[1];
if (scope === undefined) throw new Error('the updates package name must be scoped by the product');

export const updateNames = (binaries: BinaryNames): UpdateNames =>
  Object.freeze({ product: scope, client: binaries.client, daemon: binaries.daemon });
