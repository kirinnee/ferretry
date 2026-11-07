/**
 * The names this half types: read off its own package scope (`scripts/local/rename.sh --product` rewrites every
 * `@<product>/` specifier, so the literal moves with a rename) and the binary names `fy` / `fyd`.
 */
import type { UpdateNames } from './host.ts';

const PACKAGE_NAME = '@ferretry/plugin-updates';

const scope = /^@([a-z0-9][a-z0-9._-]*)\//u.exec(PACKAGE_NAME)?.[1];
if (scope === undefined) throw new Error('the updates package name must be scoped by the product');

export const UPDATE_NAMES: UpdateNames = Object.freeze({ product: scope, client: 'fy', daemon: 'fyd' });
