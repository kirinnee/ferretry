/**
 * Versions of the Codex program: reading one off `--version`, comparing two, and where one stands against the one
 * Ferretry verified. Pure.
 */
import type { HarnessVerification } from '../../../contract/index.ts';

const VERSION_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

/** Codex as a person names it. */
export const CODEX_LABEL = 'Codex';

/** THE one place Codex's package names are spelled: its npm package, its Homebrew cask, and its nixpkgs attribute. */
export const CODEX_PACKAGES = { npm: '@openai/codex', cask: 'codex', nixpkgs: 'codex' } as const;

/**
 * THE VERSION FERRETRY HAS VERIFIED: what the harness contract guard measures in every build, which is the `codex` of
 * the flake's locked nixpkgs. This constant is the owner; bumping `flake.lock` onto a new Codex means bumping this line
 * in the same change.
 */
export const VERIFIED_CODEX_VERSION = '0.145.0';

/** Where a person reads what a release changed. */
export const codexChangelogUrl = (version: string): string =>
  `https://github.com/openai/codex/releases/tag/rust-v${version}`;

/** The registry address of Codex's `latest` dist-tag. */
export const NPM_LATEST_URL = `https://registry.npmjs.org/${CODEX_PACKAGES.npm}/latest`;

/** The version `codex --version` printed — `codex-cli 0.145.0` — or `undefined` when there is none to read. */
export function parseCodexVersion(output: string): string | undefined {
  return /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/u.exec(output)?.[1];
}

interface ParsedVersion {
  readonly core: readonly [bigint, bigint, bigint];
  readonly prerelease: readonly string[] | undefined;
}

function parseVersion(version: string): ParsedVersion | undefined {
  const match = version.match(VERSION_PATTERN);
  if (!match) return undefined;
  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined || patch === undefined) return undefined;
  return { core: [BigInt(major), BigInt(minor), BigInt(patch)], prerelease: match[4]?.split('.') };
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

/** Semver order; `undefined` when either side is not a version. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | undefined {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === undefined || right === undefined) return undefined;
  for (const index of [0, 1, 2] as const) {
    if (left.core[index] !== right.core[index]) return left.core[index] > right.core[index] ? 1 : -1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

/** Whether a string is a version at all. */
export const isVersion = (value: string): boolean => VERSION_PATTERN.test(value);

/** The `latest` version from a registry answer, or `undefined` for anything that is not a stable one. */
export function parseNpmLatest(value: unknown): { readonly version: string; readonly url: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const version = (value as { version?: unknown }).version;
  if (typeof version !== 'string' || !isVersion(version) || version.includes('-')) return undefined;
  return { version, url: codexChangelogUrl(version) };
}

/**
 * Where a version stands against the one Ferretry verified. `unverified` is NEWER than that — the case that needs a
 * person's explicit yes; `older` still runs, it is simply behind what was measured.
 */
export function codexVerification(version: string | undefined): HarnessVerification {
  if (version === undefined) return 'unknown';
  const comparison = compareVersions(version, VERIFIED_CODEX_VERSION);
  if (comparison === 0) return 'verified';
  if (comparison === -1) return 'older';
  return comparison === 1 ? 'unverified' : 'unknown';
}

/** What "verified" means and what is known to break past it: the contract guard's own README. */
export const verificationUrl = (product: string): string =>
  `https://github.com/kirinnee/${product}/blob/main/packages/fleet/tests/contract/README.md`;

/**
 * Whether installing `version` (or, for a method that takes what it has, the newest known) goes past what Ferretry
 * verified — which needs the person's explicit yes.
 */
export const needsUnverifiedConsent = (version: string | undefined): boolean =>
  codexVerification(version) === 'unverified';
