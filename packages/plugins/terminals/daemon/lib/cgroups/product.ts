/**
 * This package's own scoped name. `scripts/local/rename.sh --product` rewrites every `@<product>/` specifier in the
 * repository, so this literal moves with a rename exactly as the package name does; it is written here rather than
 * read from `package.json` because a daemon half imports only its own files, the manifest and contracts.
 */
const PACKAGE_NAME = '@ferretry/plugin-terminals';

/**
 * The product name the scopes and slices are named by (`ferretry_fleet.slice`, `ferretry-agent-…`), read off this
 * package's own `@<product>/` scope as today's `lib/version.ts` read the daemon's. Today's names, so the slice a
 * running fleet sits in is the one this daemon reads.
 */
const scope = /^@([a-z0-9][a-z0-9._-]*)\//u.exec(PACKAGE_NAME)?.[1];
if (scope === undefined) throw new Error('the terminals package name must be scoped by the product');
export const productName: string = scope;

/** The label the Warden's own ferret carries (today's `lib/warden/types.ts` `WARDEN_LABEL`). */
export const WARDEN_LABEL = 'fleet-warden';
