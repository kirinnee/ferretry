/** Prove every core/plugin app source is checked, except the explicitly named pending ports. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readPendingApps } from '../gen/lib/pending-apps.ts';

const root = process.cwd();
const shown = Bun.spawnSync(['./node_modules/.bin/tsc', '--showConfig', '-p', 'tsconfig.json']);
if (shown.exitCode !== 0) throw new Error(shown.stdout.toString() + shown.stderr.toString());
const config = JSON.parse(shown.stdout.toString()) as { exclude?: string[] };
const exclusions = config.exclude ?? [];
const configText = readFileSync('tsconfig.json', 'utf8');
const pendingApps = readPendingApps(root);
const listed = new Set(
  (await Bun.stdin.text())
    .trim()
    .split('\n')
    .map(path => resolve(root, path)),
);
const sources = Bun.spawnSync([
  'git',
  'ls-files',
  '-co',
  '--exclude-standard',
  '--',
  'packages/core',
  'packages/plugins',
]);
if (sources.exitCode !== 0) throw new Error(sources.stderr.toString());
const problems: string[] = [];
const appSource = /^packages\/(?:core|plugins)\/[^/]+\/(?:app\/|tests\/(?:unit|support)\/app\/).*\.tsx?$/u;

for (const path of new Set(sources.stdout.toString().trim().split('\n'))) {
  if (!appSource.test(path) || listed.has(resolve(root, path))) continue;
  const pending = pendingApps.exclusions.find(entry => path === entry.path || path.startsWith(`${entry.path}/`));
  const exclusion = pending?.path;
  if (exclusion === undefined || !exclusions.includes(exclusion)) {
    problems.push(`${path}: app source is missing from the root typecheck; use an exact pending-port exclusion`);
    continue;
  }
  const lines = configText.split('\n');
  const line = lines.findIndex(text => text.trim().startsWith(JSON.stringify(exclusion)));
  if (line < 1 || !lines[line - 1]?.trim().startsWith('// pending app port: '))
    problems.push(`${exclusion}: explain its missing facility with a preceding "// pending app port:" comment`);
}
const trackedPaths = new Set(sources.stdout.toString().trim().split('\n'));
/** A pending app half that is only the skeleton `index.ts` has no unported source to exclude. */
const onlySkeleton = (plugin: string): boolean => {
  const own = [...trackedPaths].filter(path => new RegExp(`^packages/(?:core|plugins)/${plugin}/app/`, 'u').test(path));
  return own.length > 0 && own.every(path => path.endsWith('/app/index.ts'));
};
for (const plugin of pendingApps.halves) {
  if (onlySkeleton(plugin)) continue;
  if (
    !pendingApps.exclusions.some(
      entry => entry.plugin === plugin && /\/(?:core|plugins)\/[^/]+\/app$/u.test(entry.path),
    )
  )
    problems.push(`${plugin}: a pending app half needs its app directory in pendingAppPorts`);
}
if (problems.length > 0) {
  console.error(`❌ App typecheck coverage:\n${problems.map(problem => `   ${problem}`).join('\n')}`);
  process.exit(1);
}
