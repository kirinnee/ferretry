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
