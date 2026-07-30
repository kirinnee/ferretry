import { z } from 'zod';

// SemVer 2.0.0 core + optional pre-release/build metadata (https://semver.org).
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const SemverSchema = z.string().regex(SEMVER_PATTERN, 'version must be a valid semver string');

/** True when the value is a valid SemVer 2.0.0 version string. */
export function isSemver(value: string): boolean {
  return SemverSchema.safeParse(value).success;
}

/** Returns the value unchanged when it is valid semver; throws otherwise (guards `--version` output). */
export function assertSemver(value: string): string {
  return SemverSchema.parse(value);
}
