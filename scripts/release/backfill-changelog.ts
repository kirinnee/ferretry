/**
 * Re-renders Changelog.md from git history with the SAME release-notes configuration semantic-release
 * uses (.releaserc.yaml), so a backfilled section is indistinguishable from one the pipeline wrote.
 * It exists because every section before the preset fix was only a version header; run it again if
 * the notes configuration ever changes and the history should follow.
 *
 *   bun scripts/release/backfill-changelog.ts [--write | --check]
 *
 * Without --write the result goes to stdout. Section headers keep the date already in Changelog.md
 * (a version it does not know falls back to its tag commit's UTC date), so the file only gains lines.
 *
 * --check renders two synthetic commits through the same configuration and fails unless the notes list
 * them. The pipeline once produced header-only notes for 460 releases without any gate noticing, so the
 * release-notes-render contract (scripts/validate/cli-contracts.sh) runs this.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const REPO_URL = 'https://github.com/kirinnee/ferretry';
const NOTES_PLUGIN = '@semantic-release/release-notes-generator';
const SEMVER_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

type NotesGenerator = (
  pluginConfig: unknown,
  context: {
    cwd: string;
    commits: ReadonlyArray<{ hash: string; message: string; committerDate: string }>;
    lastRelease: { version: string; gitTag: string };
    nextRelease: { version: string; gitTag: string };
    options: { repositoryUrl: string };
  },
) => Promise<string>;

function git(...args: string[]): string {
  const run = Bun.spawnSync(['git', ...args], { env: { ...process.env, TZ: 'UTC' } });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`);
  return run.stdout.toString();
}

function versionOf(tag: string): [number, number, number] {
  const m = SEMVER_TAG.exec(tag);
  if (!m) throw new Error(`not a release tag: ${tag}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function byVersion(a: string, b: string): number {
  const [a1, a2, a3] = versionOf(a);
  const [b1, b2, b3] = versionOf(b);
  return a1 - b1 || a2 - b2 || a3 - b3;
}

function knownDates(changelog: string): Map<string, string> {
  const dates = new Map<string, string>();
  for (const m of changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]\([^)]*\) \((\d{4}-\d{2}-\d{2})\)$/gm)) {
    const [, version, date] = m;
    if (version && date) dates.set(version, date);
  }
  return dates;
}

function notesPluginConfig(): Record<string, unknown> {
  const rc = Bun.YAML.parse(readFileSync('.releaserc.yaml', 'utf8')) as { plugins: unknown[] };
  for (const plugin of rc.plugins) {
    if (Array.isArray(plugin) && plugin[0] === NOTES_PLUGIN) return plugin[1] as Record<string, unknown>;
  }
  throw new Error(`.releaserc.yaml configures no ${NOTES_PLUGIN}`);
}

const { values } = parseArgs({
  options: { write: { type: 'boolean', default: false }, check: { type: 'boolean', default: false } },
});

const specifier = NOTES_PLUGIN;
const generateNotes = ((await import(specifier)) as { generateNotes: NotesGenerator }).generateNotes;
const config = notesPluginConfig();

if (values.check) {
  const commits = [
    { hash: 'a'.repeat(40), message: 'feat(demo): add a thing (#1)', committerDate: '2026-01-01' },
    { hash: 'b'.repeat(40), message: 'fix(demo): mend a thing (#2)', committerDate: '2026-01-01' },
    { hash: 'c'.repeat(40), message: 'chore(demo): tidy a thing (#3)', committerDate: '2026-01-01' },
    { hash: 'd'.repeat(40), message: 'Brew cask update for ferretry version v0.0.1', committerDate: '2026-01-01' },
  ];
  const notes = await generateNotes(config, {
    cwd: process.cwd(),
    commits,
    lastRelease: { version: '0.0.1', gitTag: 'v0.0.1' },
    nextRelease: { version: '0.0.2', gitTag: 'v0.0.2' },
    options: { repositoryUrl: REPO_URL },
  });
  const wanted = ['### Features', '**demo:** add a thing', '### Fixes', '**demo:** mend a thing'];
  const unwanted = ['tidy a thing', 'Brew cask'];
  const missing = wanted.filter(line => !notes.includes(line));
  const leaked = unwanted.filter(line => notes.includes(line));
  if (missing.length > 0 || leaked.length > 0) {
    console.error(
      `release notes do not render as configured (missing: ${missing.join(' | ') || 'none'}; leaked: ${leaked.join(' | ') || 'none'})\n${notes}`,
    );
    process.exit(1);
  }
  process.exit(0);
}

const dates = knownDates(readFileSync('Changelog.md', 'utf8'));
const tags = git('tag', '--list', 'v*')
  .split('\n')
  .filter(t => SEMVER_TAG.test(t))
  .sort(byVersion);

const sections: string[] = [];
for (const [i, tag] of tags.entries()) {
  const previous = tags[i - 1];
  if (previous === undefined) continue;
  const version = tag.slice(1);
  const date = dates.get(version) ?? git('log', '-1', '--format=%cd', '--date=format-local:%F', tag).trim();
  const commits = git('log', `${previous}..${tag}`, '--format=%H%x1f%B%x1e')
    .split('\x1e')
    .map(record => record.trim())
    .filter(record => record.length > 0)
    .map(record => {
      const [hash = '', message = ''] = record.split('\x1f');
      return { hash, message: message.trim(), committerDate: date };
    })
    .filter(commit => !commit.message.startsWith('release:'));
  const notes = await generateNotes(
    { ...config, writerOpts: { finalizeContext: (ctx: object) => ({ ...ctx, date }) } },
    {
      cwd: process.cwd(),
      commits,
      lastRelease: { version: previous.slice(1), gitTag: previous },
      nextRelease: { version, gitTag: tag },
      options: { repositoryUrl: REPO_URL },
    },
  );
  sections.push(notes.trim());
}

const rendered = `${sections.reverse().join('\n\n')}\n`;
if (values.write) {
  writeFileSync('Changelog.md', rendered);
  console.error(`rewrote Changelog.md (${sections.length} versions)`);
} else {
  process.stdout.write(rendered);
}
