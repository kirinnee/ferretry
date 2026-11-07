/**
 * Release numbers (semver 2.0.0) and their order, copied from today's `protocol/src/lib/version-skew.ts` (only the
 * pattern, the schema and the comparison an update needs).
 */
import { z } from 'zod';

const VERSION_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

export const VersionSchema = z.string().regex(VERSION_PATTERN);
export type Version = z.infer<typeof VersionSchema>;

interface ParsedVersion {
  core: readonly [bigint, bigint, bigint];
  prerelease: readonly string[] | undefined;
}

function parseVersion(version: string): ParsedVersion | undefined {
  const match = version.match(VERSION_PATTERN);
  if (!match) return undefined;
  const major = match[1];
  const minor = match[2];
  const patch = match[3];
  if (major === undefined || minor === undefined || patch === undefined) return undefined;
  return {
    core: [BigInt(major), BigInt(minor), BigInt(patch)],
    prerelease: match[4]?.split('.'),
  };
}

function comparePrerelease(left: readonly string[] | undefined, right: readonly string[] | undefined): -1 | 0 | 1 {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^[0-9]+$/u.test(leftPart);
    const rightNumeric = /^[0-9]+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) return BigInt(leftPart) > BigInt(rightPart) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

export function compareVersions(a: string, b: string): -1 | 0 | 1 | undefined {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === undefined || right === undefined) return undefined;
  for (const index of [0, 1, 2] as const) {
    if (left.core[index] !== right.core[index]) return left.core[index] > right.core[index] ? 1 : -1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

