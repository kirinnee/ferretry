/**
 * The two shared lists the plan splits without touching the daemon (`docs/design/daemon-plugins.md` §4.3–4.4):
 *
 *   features — every commit that edited `packages/protocol/src/lib/daemon-features.ts`, each changed line
 *              attributed to a feature AREA (the first segment of a wire value, `agenda` of `agenda.snooze.1`):
 *              a line carrying a wire value is that value's area; a line naming `DAEMON_FEATURES.<key>` is that
 *              key's area; a comment or blank line inside the object belongs to the entry it precedes; anything
 *              else (the header, `NOT_YET_REPORTED` scaffolding, the helpers) is `index`, which stays shared after
 *              the split. Then overlapping PR pairs that edited the file vs. pairs that share an area or both edit
 *              `index`.
 *   knip     — every commit that edited `knip.json`: would the two proposed globs have made every changed line
 *              (both sides of the diff) unnecessary?
 *
 * Usage (repository root): bun scripts/local/daemon-modules-probe/shared-lists.ts [--since 2026-11-01] [--rev HEAD]
 */
const FEATURES = 'packages/protocol/src/lib/daemon-features.ts';
const KNIP = 'knip.json';
const GLOBBED = [/^harness\/[^/]*-(screenshot|page)\.tsx?$/, /^tests\/integration\/fixtures\/[^/]*-scene\.tsx$/];

const argv = Bun.argv.slice(2);
const option = (name: string, fallback: string) => {
  const at = argv.indexOf(name);
  return at === -1 ? fallback : (argv[at + 1] ?? fallback);
};
const since = option('--since', '2026-11-01');
const rev = option('--rev', 'HEAD');

async function run(command: readonly string[]): Promise<string> {
  const child = Bun.spawn([...command], { stdout: 'pipe', stderr: 'ignore' });
  const out = await new Response(child.stdout).text();
  await child.exited;
  return out;
}

async function commitsTouching(file: string): Promise<{ sha: string; pr: number | undefined }[]> {
  const log = (
    await run(['git', 'log', `--since=${since}`, '--no-merges', '--format=%h%x09%s', rev, '--', file])
  ).trim();
  return log
    .split('\n')
    .map(entry => entry.split('\t'))
    .filter(([, subject = '']) => !subject.startsWith('release:'))
    .map(([sha = '', subject = '']) => {
      const pr = subject.match(/\(#(\d+)\)\s*$/)?.[1];
      return { sha, pr: pr === undefined ? undefined : Number(pr) };
    });
}

/** The area of every line of one version of the features file. */
function areasOf(text: string): string[] {
  const lines = text.split('\n');
  const areas = lines.map(() => 'index');
  const keyArea = new Map<string, string>();
  const open = lines.findIndex(line => /export const DAEMON_FEATURES\s*=\s*\{/.test(line));
  const close = lines.findIndex((line, index) => index > open && /^\}\s*as const;/.test(line));
  let pending: number[] = [];
  let pendingKey: string | undefined;
  for (let index = open + 1; open !== -1 && index < close; index++) {
    const line = lines[index] ?? '';
    pending.push(index);
    pendingKey = line.match(/^\s*([A-Za-z_$][\w$]*)\s*:/)?.[1] ?? pendingKey;
    const area = line.match(/'([a-z][a-z0-9-]*)\.[a-z0-9.-]+'/)?.[1];
    if (area === undefined) continue;
    for (const owned of pending) areas[owned] = area;
    if (pendingKey !== undefined) keyArea.set(pendingKey, area);
    pending = [];
    pendingKey = undefined;
  }
  lines.forEach((line, index) => {
    if (areas[index] !== 'index') return;
    const named = [...line.matchAll(/DAEMON_FEATURES\.([A-Za-z_$][\w$]*)/g)]
      .map(match => keyArea.get(match[1] ?? ''))
      .find(Boolean);
    if (named !== undefined) areas[index] = named;
  });
  return areas;
}

async function changedLineAreas(sha: string): Promise<Set<string>> {
  const after = areasOf(await run(['git', 'show', `${sha}:${FEATURES}`]));
  const before = areasOf(await run(['git', 'show', `${sha}^:${FEATURES}`]));
  const touched = new Set<string>();
  let oldLine = 0;
  let newLine = 0;
  for (const line of (await run(['git', 'show', '--format=', '-U0', sha, '--', FEATURES])).split('\n')) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk !== null) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
    } else if (line.startsWith('+') && !line.startsWith('+++')) touched.add(after[newLine++ - 1] ?? 'index');
    else if (line.startsWith('-') && !line.startsWith('---')) touched.add(before[oldLine++ - 1] ?? 'index');
  }
  return touched;
}

async function windowOf(pr: number | undefined): Promise<readonly [number, number] | undefined> {
  if (pr === undefined) return undefined;
  try {
    const view = JSON.parse(await run(['gh', 'pr', 'view', String(pr), '--json', 'createdAt,mergedAt']));
    return typeof view.mergedAt === 'string' ? [Date.parse(view.createdAt), Date.parse(view.mergedAt)] : undefined;
  } catch {
    return undefined;
  }
}

const featureRows: { areas: Set<string>; window: readonly [number, number] | undefined }[] = [];
for (const { sha, pr } of await commitsTouching(FEATURES))
  featureRows.push({ areas: await changedLineAreas(sha), window: await windowOf(pr) });
let overlapping = 0;
let sharing = 0;
for (let i = 0; i < featureRows.length; i++)
  for (let j = i + 1; j < featureRows.length; j++) {
    const a = featureRows[i];
    const b = featureRows[j];
    if (a?.window === undefined || b?.window === undefined) continue;
    if (a.window[0] >= b.window[1] || b.window[0] >= a.window[1]) continue;
    overlapping++;
    if ([...a.areas].some(area => b.areas.has(area))) sharing++;
  }
const perArea = new Map<string, number>();
for (const row of featureRows) for (const area of row.areas) perArea.set(area, (perArea.get(area) ?? 0) + 1);

let knipCommits = 0;
let knipStillNeeded = 0;
for (const { sha } of await commitsTouching(KNIP)) {
  knipCommits++;
  const changed = (await run(['git', 'show', '--format=', '-U0', sha, '--', KNIP]))
    .split('\n')
    .filter(line => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line))
    .map(line => line.slice(1).trim().replace(/,$/, ''))
    .filter(line => line !== '');
  const needed = changed.some(line => {
    const entry = line.match(/^"([^"]*)"$/)?.[1];
    return entry === undefined || !GLOBBED.some(glob => glob.test(entry));
  });
  if (needed) knipStillNeeded++;
}

console.log(
  JSON.stringify(
    {
      since,
      rev,
      features: {
        commits: featureRows.length,
        indexOnly: featureRows.filter(row => row.areas.size === 1 && row.areas.has('index')).length,
        overlappingPairs: overlapping,
        pairsSharingAnAreaOrIndex: sharing,
        perArea: Object.fromEntries([...perArea].sort((a, b) => b[1] - a[1])),
      },
      knip: { commits: knipCommits, stillNeededWithGlobs: knipStillNeeded },
    },
    null,
    1,
  ),
);
