/**
 * Where releases are published and what the latest one is, copied from today's `protocol/src/lib/daemon-update.ts`.
 * Pure: reading the answer is an adapter's job.
 */
import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';
import { compareVersions, isNewerMajorVersion, VersionSchema } from './version.ts';

/**
 * The GitHub account and repository that publish releases: the root `package.json` `repository` field
 * ("github:<owner>/<repo>") is the one source, and `scripts/local/move-repo.sh` moves both constants with it
 * (`cli-contracts.sh repo-owner-single-source` refuses them drifting). The repository is NOT the product name:
 * a repository moved to `newco/fy-home` still ships the product `ferretry`.
 */
export const RELEASE_OWNER = 'kirinnee';
export const RELEASE_REPO = 'ferretry';

/** `<owner>/<repo>`: the one spelling every release address below is built from. */
export const RELEASE_SLUG = `${RELEASE_OWNER}/${RELEASE_REPO}`;

/** The `nix profile install` / flake reference of this repository. */
export const releaseFlakeReference = (): string => `github:${RELEASE_SLUG}`;

/** The Homebrew tap the cask lives in: this repository, named `<owner>/<repo>`. */
export const releaseTapName = (): string => RELEASE_SLUG;

/** Where that tap is cloned from; the tap is the whole repository, so it has no `homebrew-` prefix. */
export const releaseTapUrl = (): string => `https://github.com/${RELEASE_SLUG}`;

/** The GitHub API address of the latest published release. */
export const latestReleaseApiUrl = (): string => `https://api.github.com/repos/${RELEASE_SLUG}/releases/latest`;

/** The GitHub API address of the most recent tags — newer than the latest release while one is publishing. */
export const releaseTagsApiUrl = (): string => `https://api.github.com/repos/${RELEASE_SLUG}/tags?per_page=30`;

/** The download base of one tagged release's assets. */
export const releaseDownloadBase = (version: string): string =>
  `https://github.com/${RELEASE_SLUG}/releases/download/v${version}`;

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
export function parseGitHubNewestTag(value: unknown): LatestRelease | undefined {
  const parsed = GitHubTagsSchema.safeParse(value);
  if (!parsed.success) return undefined;
  let newest: string | undefined;
  for (const { name } of parsed.data) {
    const version = name.replace(/^v/u, '');
    if (name === version || !VersionSchema.safeParse(version).success || version.includes('-')) continue;
    if (newest === undefined || compareVersions(version, newest) === 1) newest = version;
  }
  if (newest === undefined) return undefined;
  return { version: newest, url: `https://github.com/${RELEASE_SLUG}/releases/tag/v${newest}` };
}

/** Whether a newer release is available within this major. A new major needs its migration, so it is never a plain update. */
export function isUpdateAvailable(current: string, latest: LatestRelease | undefined): boolean {
  if (latest === undefined) return false;
  return compareVersions(latest.version, current) === 1 && !isNewerMajorVersion(current, latest.version);
}
