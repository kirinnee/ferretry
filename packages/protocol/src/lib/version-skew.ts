import { z } from 'zod';

const VERSION_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

export const ProtocolVersionSchema = z.string().regex(VERSION_PATTERN);
export type ProtocolVersion = z.infer<typeof ProtocolVersionSchema>;

export const VersionSkewDirectionSchema = z.enum(['client-newer', 'daemon-newer', 'different']);
export type VersionSkewDirection = z.infer<typeof VersionSkewDirectionSchema>;

export const VersionSkewSchema = z.object({
  clientVersion: z.string().min(1),
  daemonVersion: z.string().min(1),
  direction: VersionSkewDirectionSchema,
  message: z.string().min(1),
});
export type VersionSkew = z.infer<typeof VersionSkewSchema>;

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

export function compareProtocolVersions(a: string, b: string): -1 | 0 | 1 | undefined {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === undefined || right === undefined) return undefined;
  for (const index of [0, 1, 2] as const) {
    if (left.core[index] !== right.core[index]) return left.core[index] > right.core[index] ? 1 : -1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

export function detectVersionSkew(
  clientVersion: string,
  daemonVersion: string | null | undefined,
): VersionSkew | undefined {
  if (daemonVersion === null || daemonVersion === undefined || daemonVersion === clientVersion) return undefined;
  const comparison = compareProtocolVersions(clientVersion, daemonVersion);
  const direction: VersionSkewDirection =
    comparison === 1 ? 'client-newer' : comparison === -1 ? 'daemon-newer' : 'different';
  const advice =
    direction === 'client-newer'
      ? 'the daemon is older; restart fyd after updating it'
      : direction === 'daemon-newer'
        ? 'the client is older; update fy'
        : 'the versions differ; install matching fy and fyd builds';
  return {
    clientVersion,
    daemonVersion,
    direction,
    message: `fy ${clientVersion} / fyd ${daemonVersion} — ${advice}`,
  };
}

export function formatUnknownRouteError(
  route: string,
  clientVersion: string,
  daemonVersion: string | null | undefined,
): string {
  const daemon = daemonVersion ?? 'unknown';
  const comparison =
    daemonVersion === null || daemonVersion === undefined
      ? undefined
      : compareProtocolVersions(clientVersion, daemonVersion);
  if (comparison === 1) {
    return `fy: ${route} requires a newer fyd (fy ${clientVersion}, fyd ${daemon}); restart the daemon after updating it`;
  }
  return `fy: fyd returned an unknown route for ${route} (fy ${clientVersion}, fyd ${daemon})`;
}
