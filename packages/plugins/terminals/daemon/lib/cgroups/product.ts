import manifest from '../../../package.json' with { type: 'json' };

/**
 * The product name the scopes and slices are named by (`ferretry_fleet.slice`, `ferretry-agent-…`), read off this
 * package's own `@<product>/` scope as today's `lib/version.ts` read the daemon's: `scripts/local/rename.sh
 * --product` rewrites every scope, so a rename carries the unit names with it. Today's names, so the slice a running
 * fleet sits in is the one this daemon reads.
 */
const scope = /^@([a-z0-9][a-z0-9._-]*)\//u.exec(manifest.name)?.[1];
if (scope === undefined) throw new Error('the terminals package name must be scoped by the product');
export const productName: string = scope;

/** The label the Warden's own ferret carries (today's `lib/warden/types.ts` `WARDEN_LABEL`). */
export const WARDEN_LABEL = 'fleet-warden';
