import { z } from 'zod';
import manifest from '../../package.json' with { type: 'json' };

const SemverSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    'daemon version must be valid semver',
  );

/** Daemon package version, derived from the package manifest rather than duplicated. */
export const daemonVersion = SemverSchema.parse(manifest.version);

/**
 * The product name, derived from this package's own scope rather than written out.
 *
 * It names the default state home (`~/.<product>`), which three separate functions derive — this
 * package's `resolveStateHome`, and the client's `resolveDaemonStateHome` and `resolveFleetLayout`.
 * Two of them used to spell `ferretry` as a literal while the third read the root manifest, so they
 * agreed only because the product happens to be called that. `scripts/local/rename.sh --product`
 * rewrites every `@<product>/` specifier and every package manifest, so a scope is a name a rename
 * actually carries; a literal in a `.ts` file is not, and a rename would have pointed the daemon and
 * its client at two different directories with nothing reporting the split.
 */
const ProductScopeSchema = z
  .string()
  .regex(/^@([a-z0-9][a-z0-9._-]*)\//u, 'the daemon package name must be scoped by the product')
  .transform(name => name.slice(1, name.indexOf('/')));

export const productName = ProductScopeSchema.parse(manifest.name);
