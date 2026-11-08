/**
 * Schema pieces the version-2 fleet configuration (`./account/schema.ts`) is built from: safe names,
 * launch environment, aliases and the usage block — the one place untrusted YAML for each becomes a
 * domain type.
 *
 * Names are checked for filesystem safety: they become path components, and a traversal segment or
 * separator in one would let a configuration write outside the directories it owns.
 */
import { z } from 'zod';

const POSIX_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A POSIX environment variable name. */
export const EnvNameSchema = z.string().regex(POSIX_ENV_NAME, {
  message: 'must be a POSIX environment variable name',
});
