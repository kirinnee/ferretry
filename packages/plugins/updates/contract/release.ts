/**
 * Where releases are published and what the latest one is, copied from today's `protocol/src/lib/daemon-update.ts`.
 * Pure: reading the answer is an adapter's job.
 */
import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';
import { compareVersions, VersionSchema } from './version.ts';

/**
 * The GitHub account that publishes releases. The repository is the PRODUCT name, which callers pass
 * in from their own single source (`productName`), so a product rename carries it.
 */
export const RELEASE_OWNER = 'kirinnee';

/** The `nix profile install` / flake reference for a product. */
export const releaseFlakeReference = (product: string): string => `github:${RELEASE_OWNER}/${product}`;

/** The Homebrew tap a product's cask lives in: this repository, named `<owner>/<product>`. */
export const releaseTapName = (product: string): string => `${RELEASE_OWNER}/${product}`;

/** Where that tap is cloned from; the tap is the whole repository, so it has no `homebrew-` prefix. */
export const releaseTapUrl = (product: string): string => `https://github.com/${RELEASE_OWNER}/${product}`;

/** The GitHub API address of a product's latest published release. */
export const latestReleaseApiUrl = (product: string): string =>
  `https://api.github.com/repos/${RELEASE_OWNER}/${product}/releases/latest`;

/** The GitHub API address of a product's most recent tags — newer than the latest release while one is publishing. */
export const releaseTagsApiUrl = (product: string): string =>
  `https://api.github.com/repos/${RELEASE_OWNER}/${product}/tags?per_page=30`;

/** The download base of one tagged release's assets. */
export const releaseDownloadBase = (product: string, version: string): string =>
  `https://github.com/${RELEASE_OWNER}/${product}/releases/download/v${version}`;

export const LatestReleaseSchema = z.strictObject({
  version: VersionSchema,
  /** The release page, which is the changelog. */
  url: z.url(),
  publishedAt: InstantSchema.optional(),
});
export type LatestRelease = z.infer<typeof LatestReleaseSchema>;

const GitHubReleaseSchema = z.looseObject({
  tag_name: z.string(),
  html_url: z.url(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
  published_at: z.string().nullable().optional(),
});

/**
 * The latest release, from a GitHub `releases/latest` answer — or `undefined` for anything that is
 * not one: a draft, a prerelease, a tag that is not `v<semver>`, or a page that is not https.
 */
export function parseGitHubLatestRelease(value: unknown): LatestRelease | undefined {
  const parsed = GitHubReleaseSchema.safeParse(value);
  if (!parsed.success || parsed.data.draft === true || parsed.data.prerelease === true) return undefined;
  const version = parsed.data.tag_name.replace(/^v/u, '');
  if (!VersionSchema.safeParse(version).success) return undefined;
  if (!parsed.data.html_url.startsWith('https://')) return undefined;
  const published = InstantSchema.safeParse(parsed.data.published_at);
  return {
    version,
    url: parsed.data.html_url,
    ...(published.success ? { publishedAt: published.data } : {}),
  };
}

const GitHubTagsSchema = z.array(z.looseObject({ name: z.string() }));

/**
 * The highest stable `v<semver>` tag in a GitHub `tags` answer — or `undefined` when there is none.
 *
 * Tags are cut before the GitHub release, the cask and the archives catch up, so this is what a
 * source-built install (nix) will actually get; it is never the target of an install that downloads
 * release assets.
 */
export function parseGitHubNewestTag(product: string, value: unknown): LatestRelease | undefined {
  const parsed = GitHubTagsSchema.safeParse(value);
  if (!parsed.success) return undefined;
  let newest: string | undefined;
  for (const { name } of parsed.data) {
    const version = name.replace(/^v/u, '');
    if (name === version || !VersionSchema.safeParse(version).success || version.includes('-')) continue;
    if (newest === undefined || compareVersions(version, newest) === 1) newest = version;
  }
  if (newest === undefined) return undefined;
  return { version: newest, url: `https://github.com/${RELEASE_OWNER}/${product}/releases/tag/v${newest}` };
}

/** Whether `latest` is newer than `current`. Versions that do not parse are never "newer". */
export function isUpdateAvailable(current: string, latest: LatestRelease | undefined): boolean {
  if (latest === undefined) return false;
  return compareVersions(latest.version, current) === 1;
}
