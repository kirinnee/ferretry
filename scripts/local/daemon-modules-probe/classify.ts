/**
 * Which proposed modules did each `fyd.ts` commit really change, and how many PRs that were open at the same
 * time would still share a module after the split (`docs/design/daemon-plugins.md` §7)?
 *
 * For every non-release, non-merge commit in `<since>..<rev>` that edited `fyd.ts`:
 *   - the module of every OTHER daemon file it touched, by path. The shared lists the plan turns into
 *     per-module fragments (`NEUTRAL`) say nothing about which module a change belongs to, so they are skipped;
 *   - the module of every `fyd.ts` line it added or removed, attributed by `attribute.ts` against THAT
 *     commit's own tree (`+` lines on the commit, `-` lines on its parent), so a name that was later renamed or
 *     deleted still resolves. A line attributed to the kernel is a "wiring" touch.
 * Then each PR's open window (`createdAt`..`mergedAt`, from `gh pr view`) decides which pairs overlapped.
 *
 * Usage (repository root): bun scripts/local/daemon-modules-probe/classify.ts [--since 2026-11-01] [--rev c7e6beda1]
 *   [--limit 6] [--rows]
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Attribution, attribute, IMPORT_LINES } from './attribute.ts';
import { moduleOfPath } from './modules.ts';

const FYD = 'packages/daemon/bin/fyd.ts';
const NEUTRAL: ReadonlySet<string> = new Set([
  FYD,
  'packages/daemon/src/lib/runtime/mounts/index.ts',
  'packages/daemon/tests/unit/runtime/mounts/surface.test.ts',
  'packages/daemon/tests/unit/runtime/mounts/route-callers.ts',
  'packages/daemon/tests/unit/audit/not-audited.ts',
  'packages/daemon/src/lib/audit/routes.ts',
  'packages/daemon/src/lib/index.ts',
  'packages/daemon/src/adapters/index.ts',
]);

const argv = Bun.argv.slice(2);
const option = (name: string, fallback: string) => {
  const at = argv.indexOf(name);
  return at === -1 ? fallback : (argv[at + 1] ?? fallback);
};
const since = option('--since', '2026-11-01');
const rev = option('--rev', 'HEAD');
const limit = Number(option('--limit', '6'));

async function run(command: readonly string[]): Promise<string> {
  const child = Bun.spawn([...command], { stdout: 'pipe', stderr: 'ignore' });
  const out = await new Response(child.stdout).text();
  await child.exited;
  return out;
}

/** `fyd.ts` at a revision, attributed against that revision's own `src` tree. */
async function attributionAt(revision: string): Promise<Attribution | undefined> {
  const text = await run(['git', 'show', `${revision}:${FYD}`]);
  if (text === '') return undefined;
  const scratch = await mkdtemp(join(tmpdir(), 'daemon-modules-probe-'));
  try {
    await run(['sh', '-c', `git archive "$1" packages/daemon/src | tar -x -C "$2"`, 'sh', revision, scratch]);
    return await attribute(text, join(scratch, 'packages/daemon'), limit);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export interface ClassifiedCommit {
  readonly sha: string;
  readonly subject: string;
  readonly pr: number | undefined;
  readonly modules: readonly string[];
  readonly wiring: boolean;
}

const log = (await run(['git', 'log', `--since=${since}`, '--no-merges', '--format=%h%x09%s', rev, '--', FYD]))
  .trim()
  .split('\n');
const rows: ClassifiedCommit[] = [];
for (const entry of log) {
  const [sha = '', subject = ''] = entry.split('\t');
  if (subject.startsWith('release:')) continue;
  const modules = new Set<string>();
  for (const file of (await run(['git', 'show', '--format=', '--name-only', sha])).trim().split('\n')) {
    if (NEUTRAL.has(file)) continue;
    const module = moduleOfPath(file);
    if (module !== undefined && module !== 'kernel') modules.add(module);
  }
  const after = await attributionAt(sha);
  const before = await attributionAt(`${sha}^`);
  let oldLine = 0;
  let newLine = 0;
  let wiring = false;
  for (const line of (await run(['git', 'show', '--format=', '-U0', sha, '--', FYD])).split('\n')) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk !== null) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    let side: Attribution | undefined;
    let index: number;
    if (line.startsWith('+')) {
      side = after;
      index = newLine++ - 1;
    } else if (line.startsWith('-')) {
      side = before;
      index = oldLine++ - 1;
    } else continue;
    if (side === undefined || line.slice(1).trim() === '') continue;
    let module = side.perLine[index];
    if (module === IMPORT_LINES)
      // an import moves with the module that uses it
      module = (line.match(/[A-Za-z_$][\w$]*/g) ?? []).map(token => side?.nameModule.get(token)).find(Boolean);
    if (module === 'kernel') wiring = true;
    else if (module !== undefined) modules.add(module);
  }
  const pr = subject.match(/\(#(\d+)\)\s*$/)?.[1];
  rows.push({ sha, subject, pr: pr === undefined ? undefined : Number(pr), modules: [...modules].sort(), wiring });
}

const windows = new Map<number, readonly [number, number]>();
for (const row of rows) {
  if (row.pr === undefined) continue;
  try {
    const view = JSON.parse(await run(['gh', 'pr', 'view', String(row.pr), '--json', 'createdAt,mergedAt']));
    if (typeof view.mergedAt === 'string') windows.set(row.pr, [Date.parse(view.createdAt), Date.parse(view.mergedAt)]);
  } catch {
    // a PR gh cannot read has no window and joins no pair
  }
}
const timed = rows.filter(row => row.pr !== undefined && windows.has(row.pr));
let overlapping = 0;
let shareModule = 0;
let shareModuleOrWiring = 0;
for (let i = 0; i < timed.length; i++)
  for (let j = i + 1; j < timed.length; j++) {
    const a = timed[i];
    const b = timed[j];
    const wa = a?.pr === undefined ? undefined : windows.get(a.pr);
    const wb = b?.pr === undefined ? undefined : windows.get(b.pr);
    if (a === undefined || b === undefined || wa === undefined || wb === undefined) continue;
    if (wa[0] >= wb[1] || wb[0] >= wa[1]) continue;
    overlapping++;
    const shared = a.modules.some(module => b.modules.includes(module));
    if (shared) shareModule++;
    if (shared || (a.wiring && b.wiring)) shareModuleOrWiring++;
  }

const perModule = new Map<string, number>();
for (const row of rows) for (const module of row.modules) perModule.set(module, (perModule.get(module) ?? 0) + 1);
const sorted = rows.map(row => row.modules.length).sort((a, b) => a - b);
console.log(
  JSON.stringify(
    {
      since,
      rev,
      limit,
      commits: rows.length,
      oneModuleNoWiring: rows.filter(row => row.modules.length === 1 && !row.wiring).length,
      oneModuleWithWiring: rows.filter(row => row.modules.length === 1 && row.wiring).length,
      noModule: rows.filter(row => row.modules.length === 0).length,
      wiringTouched: rows.filter(row => row.wiring).length,
      medianModules: sorted[Math.floor(sorted.length / 2)],
      moduleTouches: [...perModule.values()].reduce((sum, count) => sum + count, 0),
      prsWithWindows: timed.length,
      overlappingPairs: overlapping,
      pairsSharingAModule: shareModule,
      pairsSharingAModuleOrWiring: shareModuleOrWiring,
      perModule: Object.fromEntries([...perModule].sort((a, b) => b[1] - a[1])),
      ...(argv.includes('--rows') ? { rows } : {}),
    },
    null,
    1,
  ),
);
