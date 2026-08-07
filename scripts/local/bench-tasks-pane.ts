/**
 * Reproducible real-Chrome evidence for handover row #5.
 *
 * BEFORE is not a handwritten proxy. The script archives exact commit e222f87d,
 * copies the common browser harness into that private tree, and bundles the real
 * historical SessionSearchProvider + SessionTasksSearchSurface. AFTER bundles
 * the same harness against the production source at b81c64e. A loopback-only
 * deterministic daemon records every request made by both real panes.
 *
 * Acquire the shared F117 heavy lock on an inherited descriptor, immediately
 * run the fleet-provided trusted post-acquisition audit, and then exec this
 * command with the successful marker:
 *
 *   exec 9>/tmp/ferretry-f117-heavy-gate.lock
 *   flock 9
 *   /absolute/path/to/the/current/trusted-heavy-gate-audit.sh
 *   FERRETRY_F117_TRUSTED_HEAVY_AUDIT=passed \
 *     exec bun scripts/local/bench-tasks-pane.ts
 *
 * The program proves it inherited the write-locked descriptor and repeats the
 * post-acquisition process audit directly from /proc before launching Chrome.
 */

import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  type Browser,
  type BrowserContext,
  type Page,
  chromium,
} from '../../packages/pwa/node_modules/playwright-core';
import {
  ScopedTaskDetailResponseSchema,
  SessionFileIndexResponseSchema,
  SessionTaskListResponseSchema,
  type ScopedTaskSummary,
  type ScopedTaskView,
  type SessionFileIndexResponse,
  type SessionTaskListResponse,
} from '../../packages/protocol/src/lib/index.ts';
import { taskSummary } from '../../packages/pwa/tests/support/tasks.ts';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../..');
const harnessPath = join(repoRoot, 'packages/pwa/harness/tasks-pane-benchmark.tsx');
const heavyLock = '/tmp/ferretry-f117-heavy-gate.lock';
const trustedAuditEnvironment = 'FERRETRY_F117_TRUSTED_HEAVY_AUDIT';

const BEFORE = {
  commit: 'e222f87d25f0712eac47325722b1fdd742c0a207',
  tree: 'baf5165ed3c066e69e99ea699ccf5cf20e70160d',
  searchBlob: 'f718f9e29acfd0dde070abcb5e99a8506b9c7622',
  filesBlob: 'fe9153c1381071e4e3c756f246302aa5f22e6555',
  label: 'historical list + task-detail fan-out and browser file walk',
} as const;

const AFTER = {
  commit: 'b81c64e69e64a058fa7df884c55d6303d8c036b7',
  tree: '763e65328f3b309e1e146e0dfa590edd3910bccd',
  searchBlob: 'f3b99f566f1ab0d4ab21071fe34261cba53628bd',
  filesBlob: 'e384c48a1a870656f37f064137aa8a9e26f39b5d',
  label: 'production bounded summaries, daemon query, and file index',
} as const;

const SEARCH_PATH = 'packages/pwa/src/features/session-search/session-search.tsx';
const FILES_PATH = 'packages/pwa/src/components/files-api.ts';
const ALLOWED_PATHS = new Set([
  'knip.json',
  'packages/pwa/harness/tasks-pane-benchmark.tsx',
  'scripts/local/bench-tasks-pane.ts',
  'handover.md',
]);
const IDENTICAL_DEPENDENCY_PATHS = [
  'bun.lock',
  'package.json',
  'packages/pwa/package.json',
  'packages/protocol/package.json',
  'packages/relay/package.json',
  'packages/fleet/package.json',
] as const;

const DEVICE_TOKEN = 'tasks-pane-benchmark-token';
const DEFAULTS = { tasks: 40, directories: 25, latency: 12, samples: 6 } as const;
const USAGE =
  'usage: bun scripts/local/bench-tasks-pane.ts [--tasks N] [--directories N] [--latency MS] [--samples EVEN_N]';
const FIXTURE_TIMEOUT_MS = 12_000;
const HISTORICAL_WAIT_BUDGET_MS = 5_000;

interface Options {
  readonly tasks: number;
  readonly directories: number;
  readonly latency: number;
  readonly samples: number;
}

type Arm = 'before' | 'after';
type Scenario = 'normal' | 'partial-index' | 'query-error' | 'stale-query' | 'initial-task-error';

interface FixtureTask {
  readonly summary: ScopedTaskSummary;
  readonly detail: ScopedTaskView;
  readonly haystack: string;
}

interface RequestRecord {
  readonly sequence: number;
  readonly method: string;
  readonly pathname: string;
  readonly query: string;
  readonly raw: string;
  readonly authorized: boolean;
  startedAt: number;
  settledAt: number | null;
  status: number | null;
  clientAborted: boolean;
}

interface FixtureRun {
  readonly sessionId: string;
  readonly scenario: Scenario;
  readonly latency: number;
  readonly tasks: readonly FixtureTask[];
  readonly index: SessionFileIndexResponse;
  readonly directories: number;
  readonly ledger: RequestRecord[];
  active: number;
}

interface LedgerSummary {
  readonly bareTasks: number;
  readonly queries: readonly string[];
  readonly taskDetails: number;
  readonly fileIndex: number;
  readonly fileListings: number;
  readonly unknown: number;
  readonly total: number;
}

interface MountResult {
  readonly elapsedMs: number;
  readonly taskIds: readonly string[];
  readonly text: string;
}

interface QueryResult {
  readonly elapsedMs: number;
  readonly taskIds: readonly string[];
}

interface SurfaceSnapshot {
  readonly taskIds: readonly string[];
  readonly text: string;
  readonly taskFilterUnavailable: boolean;
  readonly coveragePartial: boolean;
  readonly skipNote: string | null;
  readonly tasksUnavailable: boolean;
}

interface BrowserApi {
  readonly mount: (options: {
    readonly sessionId: string;
    readonly expectedTaskIds?: readonly string[];
    readonly unavailable?: boolean;
  }) => Promise<MountResult>;
  readonly query: (value: string, expectedTaskIds: readonly string[]) => Promise<QueryResult>;
  readonly setQuery: (value: string) => number;
  readonly waitForTaskIds: (expectedTaskIds: readonly string[]) => Promise<readonly string[]>;
  readonly waitForSelector: (selector: string) => Promise<number>;
  readonly openSearch: () => Promise<void>;
  readonly elapsed: () => number;
  readonly snapshot: () => SurfaceSnapshot;
  readonly unmount: () => void;
}

interface ArmSample {
  readonly arm: Arm;
  readonly taskPaintMs: number;
  readonly mountSettledMs: number;
  readonly queryPaintMs: number;
  readonly workflowMs: number;
  readonly initialLedger: LedgerSummary;
  readonly finalLedger: LedgerSummary;
  readonly rawRequests: readonly string[];
}

interface PairSample {
  readonly pair: number;
  readonly order: readonly [Arm, Arm];
  readonly before: ArmSample;
  readonly after: ArmSample;
}

class OptionRefusal extends Error {}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes).trim();

const command = (program: string, args: readonly string[], cwd = repoRoot): string => {
  const result = Bun.spawnSync([program, ...args], {
    cwd,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = decode(result.stdout);
  const stderr = decode(result.stderr);
  if (!result.success) {
    throw new Error(
      `${program} ${args.join(' ')} failed with ${result.exitCode}${stderr === '' ? '' : `\n${stderr}`}${
        stdout === '' ? '' : `\n${stdout}`
      }`,
    );
  }
  return stdout;
};

const git = (...args: readonly string[]): string => command('git', args);

const nulGitPaths = (args: readonly string[]): readonly string[] => {
  const result = Bun.spawnSync(['git', ...args], {
    cwd: repoRoot,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (!result.success)
    throw new Error(`git ${args.join(' ')} failed with ${result.exitCode}\n${decode(result.stderr)}`);
  const output = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
  if (output !== '' && !output.endsWith('\0'))
    throw new Error(`git ${args.join(' ')} did not return a NUL-terminated path list`);
  return output.split('\0').filter(Boolean);
};

const refuse = (reason: string): never => {
  throw new OptionRefusal(`${reason}\n${USAGE}`);
};

const parseOptions = (argv: readonly string[]): Options => {
  const chosen: { tasks: number; directories: number; latency: number; samples: number } = { ...DEFAULTS };
  if (argv.length % 2 !== 0) refuse(`option ${String(argv.at(-1))} needs a value`);
  for (let index = 0; index < argv.length; index += 2) {
    const rawFlag = argv[index] as string;
    const key = rawFlag.replace(/^--/u, '');
    if (key !== 'tasks' && key !== 'directories' && key !== 'latency' && key !== 'samples')
      refuse(`unknown option ${rawFlag}`);
    const option = key as keyof Options;
    const raw = argv[index + 1] as string;
    const value = raw.trim() === '' ? Number.NaN : Number(raw);
    if (!Number.isFinite(value) || !Number.isInteger(value))
      refuse(`${rawFlag} needs a whole number, got ${JSON.stringify(raw)}`);
    chosen[option] = value;
  }
  if (chosen.tasks < 2 || chosen.tasks > 100) refuse('--tasks must be between 2 and 100');
  if (chosen.directories < 1 || chosen.directories > 50) refuse('--directories must be between 1 and 50');
  if (chosen.latency < 1 || chosen.latency > 100) refuse('--latency must be between 1 and 100 milliseconds');
  if (chosen.samples < 6 || chosen.samples > 12 || chosen.samples % 2 !== 0)
    refuse('--samples must be an even whole number between 6 and 12');
  if ((chosen.tasks + 1) * chosen.latency > HISTORICAL_WAIT_BUDGET_MS)
    refuse('--tasks and --latency exceed the 5000 millisecond historical detail-read budget');
  if ((chosen.directories + 1) * chosen.latency > HISTORICAL_WAIT_BUDGET_MS)
    refuse('--directories and --latency exceed the 5000 millisecond historical file-walk budget');
  return chosen;
};

const objectAt = (commit: string, path: string): string => git('rev-parse', `${commit}:${path}`);

const assertEqual = (actual: unknown, expected: unknown, label: string): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

const dirtyPaths = (): readonly string[] => [
  ...new Set([
    ...nulGitPaths(['diff', '--name-only', '-z', 'HEAD', '--']),
    ...nulGitPaths(['ls-files', '--others', '--exclude-standard', '-z', '--']),
  ]),
];

const proveReferences = (): {
  readonly head: string;
  readonly tree: string;
  readonly parent: string;
  readonly dirty: readonly string[];
} => {
  if (git('rev-parse', BEFORE.commit) !== BEFORE.commit)
    throw new Error('the exact historical commit object is missing');
  if (git('rev-parse', AFTER.commit) !== AFTER.commit) throw new Error('the exact production commit object is missing');
  assertEqual(git('rev-parse', `${BEFORE.commit}^{tree}`), BEFORE.tree, 'historical tree');
  assertEqual(git('rev-parse', `${AFTER.commit}^{tree}`), AFTER.tree, 'production tree');
  assertEqual(objectAt(BEFORE.commit, SEARCH_PATH), BEFORE.searchBlob, 'historical session-search blob');
  assertEqual(objectAt(BEFORE.commit, FILES_PATH), BEFORE.filesBlob, 'historical files-api blob');
  assertEqual(objectAt(AFTER.commit, SEARCH_PATH), AFTER.searchBlob, 'production session-search blob');
  assertEqual(objectAt(AFTER.commit, FILES_PATH), AFTER.filesBlob, 'production files-api blob');

  const ancestor = Bun.spawnSync(['git', 'merge-base', '--is-ancestor', AFTER.commit, 'HEAD'], { cwd: repoRoot });
  if (!ancestor.success) throw new Error(`${AFTER.commit} is not an ancestor of the measured checkout`);
  assertEqual(objectAt('HEAD', SEARCH_PATH), AFTER.searchBlob, 'measured session-search blob');
  assertEqual(objectAt('HEAD', FILES_PATH), AFTER.filesBlob, 'measured files-api blob');

  for (const path of IDENTICAL_DEPENDENCY_PATHS) {
    assertEqual(objectAt(BEFORE.commit, path), objectAt(AFTER.commit, path), `shared dependency input ${path}`);
  }
  assertEqual(
    git(
      'diff',
      '--name-only',
      BEFORE.commit,
      AFTER.commit,
      '--',
      'packages/pwa/src',
      'packages/protocol/src',
      'packages/relay/src',
    ).split('\n'),
    [FILES_PATH, SEARCH_PATH],
    'historical-to-production browser runtime diff',
  );

  const committed = git('diff', '--name-only', `${AFTER.commit}..HEAD`).split('\n').filter(Boolean);
  const foreignCommitted = committed.filter(path => !ALLOWED_PATHS.has(path));
  if (foreignCommitted.length > 0)
    throw new Error(
      `the measured checkout has out-of-scope commits after ${AFTER.commit}: ${foreignCommitted.join(', ')}`,
    );
  const dirty = dirtyPaths();
  const foreignDirty = dirty.filter(path => !ALLOWED_PATHS.has(path));
  if (foreignDirty.length > 0)
    throw new Error(`the measured checkout has out-of-scope dirty paths: ${foreignDirty.join(', ')}`);

  return {
    head: git('rev-parse', 'HEAD'),
    tree: git('rev-parse', 'HEAD^{tree}'),
    parent: git('rev-parse', 'HEAD^'),
    dirty,
  };
};

const proveInheritedHeavyLock = (): string => {
  if (process.env[trustedAuditEnvironment] !== 'passed')
    throw new Error(
      `the trusted post-acquisition audit marker is missing; audit after locking, then set ${trustedAuditEnvironment}=passed`,
    );
  if (!existsSync(heavyLock)) throw new Error(`the shared heavy lock does not exist: ${heavyLock}`);
  const expected = statSync(heavyLock);
  for (const descriptor of readdirSync('/proc/self/fd')) {
    if (!/^\d+$/u.test(descriptor)) continue;
    try {
      const actual = statSync(`/proc/self/fd/${descriptor}`);
      if (actual.dev !== expected.dev || actual.ino !== expected.ino) continue;
      const information = readFileSync(`/proc/self/fdinfo/${descriptor}`, 'utf8');
      if (/^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+/mu.test(information)) return descriptor;
    } catch {
      // Descriptors may close while /proc is inspected; only a stable locked match is evidence.
    }
  }
  throw new Error(`this benchmark did not inherit a write-locked descriptor for ${heavyLock}`);
};

const directPostLockAudit = (): void => {
  const competitors: string[] = [];
  for (const entry of readdirSync('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    const pid = Number(entry.name);
    if (pid === process.pid) continue;
    try {
      const executable = basename(realpathSync(`/proc/${entry.name}/exe`));
      const argv = readFileSync(`/proc/${entry.name}/cmdline`).toString('utf8').split('\0').filter(Boolean);
      if (argv.length === 0) continue;
      const argumentsAfterProgram = argv.slice(1);
      const first = argumentsAfterProgram[0] ?? '';
      let activity: string | null = null;
      if (executable === 'bun' || executable === 'bunx') {
        if (first === 'test') activity = 'bun test';
        else if (first.endsWith('/scripts/local/bench-tasks-pane.ts') || first === 'scripts/local/bench-tasks-pane.ts')
          activity = 'Tasks-pane benchmark';
        else if (first.includes('/scripts/ci/test.sh') || first.includes('/scripts/validate/')) activity = first;
      } else if (executable === 'task') {
        const task = argumentsAfterProgram.find(argument => /^(?:lint|test(?::.*)?|unit.*|int.*)$/u.test(argument));
        if (task !== undefined) activity = `task ${task}`;
      } else if (executable === 'tsc' || executable === 'treefmt') activity = executable;
      else if (executable === 'biome' && /^(?:lint|check|ci)$/u.test(first)) activity = `biome ${first}`;
      else if (executable === 'node') {
        if (first.includes('typescript') && first.endsWith('/bin/tsc')) activity = 'TypeScript';
        else if (first.includes('/scripts/ci/test.sh') || first.includes('/scripts/validate/')) activity = first;
      } else if (/^(?:chrome|chromium|chromium-browser|google-chrome|\.chrome-wrapped)$/u.test(executable))
        activity = executable;
      if (activity !== null) competitors.push(`pid=${entry.name} ${activity}`);
    } catch {
      // A process can exit between the /proc directory and identity reads.
    }
  }
  if (competitors.length > 0)
    throw new Error(`direct post-acquisition audit found competing work: ${competitors.join(', ')}`);
};

const fullTaskIds = (count: number): readonly string[] =>
  Array.from({ length: count }, (_unused, index) => `F${index + 1}`).sort((left, right) => left.localeCompare(right));

const fixtureTasks = (count: number, sessionId: string): readonly FixtureTask[] =>
  Array.from({ length: count }, (_unused, index) => `F${index + 1}`).map((id, index) => {
    const title = index === 0 ? 'Beta needle task' : index === 1 ? 'Alpha stale task' : `Benchmark task ${index + 1}`;
    const description =
      index === 0 ? 'The unique needle lives in this task.' : `Deterministic prose for row ${index + 1}.`;
    const ask = index === 1 ? 'Keep the old alpha result from winning.' : `Measure benchmark row ${index + 1}.`;
    const base = taskSummary({
      id,
      title,
      descriptionChars: description.length,
      askChars: ask.length,
      askSource: 'benchmark-fixture',
      clarificationCount: 0,
    });
    const summary: ScopedTaskSummary = { ...base, sessionId };
    const detail = {
      ...base,
      description,
      ask: { text: ask, source: 'benchmark-fixture' },
      clarifications: [],
      sessionId,
    } as ScopedTaskView;
    return { summary, detail, haystack: `${id}\n${title}\n${description}\n${ask}`.toLocaleLowerCase() };
  });

const fileIndex = (sessionId: string, directories: number, partial: boolean): SessionFileIndexResponse => ({
  v: 1,
  sessionId,
  root: `/work/${sessionId}`,
  files: [
    { name: 'README.md', path: 'README.md' },
    ...Array.from({ length: directories }, (_unused, directory) =>
      Array.from({ length: 2 }, (_inner, file) => ({
        name: `file-${file}.ts`,
        path: `dir-${directory}/file-${file}.ts`,
      })),
    ).flat(),
  ],
  coverage: partial ? 'partial' : 'complete',
  skipped: partial ? [{ reason: 'truncated', count: 3 }] : [],
});

const taskListResponse = (run: FixtureRun, query: string | null): SessionTaskListResponse => {
  const normalized = query?.trim().toLocaleLowerCase() ?? null;
  const tasks =
    normalized === null ? run.tasks : run.tasks.filter(task => task.haystack.includes(normalized)).map(task => task);
  return {
    v: 1,
    sessionId: run.sessionId,
    tasks: tasks.map(task => task.summary),
    parseErrors: 0,
    updatedAt: '2026-08-07T00:00:00.000Z',
  };
};

const validateFixture = (run: FixtureRun): void => {
  SessionTaskListResponseSchema.parse(taskListResponse(run, null));
  SessionTaskListResponseSchema.parse(taskListResponse(run, 'needle'));
  SessionFileIndexResponseSchema.parse(run.index);
  for (const task of run.tasks)
    ScopedTaskDetailResponseSchema.parse({ sessionId: run.sessionId, task: task.detail, activity: [] });
};

const createFixture = (
  fixtures: Map<string, FixtureRun>,
  sessionId: string,
  options: Options,
  scenario: Scenario = 'normal',
): FixtureRun => {
  if (fixtures.has(sessionId)) throw new Error(`duplicate fixture session ${sessionId}`);
  const run: FixtureRun = {
    sessionId,
    scenario,
    latency: options.latency,
    tasks: fixtureTasks(options.tasks, sessionId),
    index: fileIndex(sessionId, options.directories, scenario === 'partial-index'),
    directories: options.directories,
    ledger: [],
    active: 0,
  };
  validateFixture(run);
  fixtures.set(sessionId, run);
  return run;
};

const json = (value: unknown, status = 200): Response =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });

const serveApi = async (request: Request, fixtures: Map<string, FixtureRun>): Promise<Response> => {
  const url = new URL(request.url);
  const matched = /^\/v1\/sessions\/([^/]+)\/(.+)$/u.exec(url.pathname);
  if (matched === null) return new Response('not found', { status: 404 });
  const sessionId = decodeURIComponent(matched[1] as string);
  const suffix = matched[2] as string;
  const run = fixtures.get(sessionId);
  if (run === undefined) return new Response('unknown benchmark session', { status: 404 });

  const record: RequestRecord = {
    sequence: run.ledger.length + 1,
    method: request.method,
    pathname: url.pathname,
    query: url.search,
    raw: `${request.method} ${url.pathname}${url.search}`,
    authorized: request.headers.get('authorization') === `Bearer ${DEVICE_TOKEN}`,
    startedAt: performance.now(),
    settledAt: null,
    status: null,
    clientAborted: request.signal.aborted,
  };
  request.signal.addEventListener('abort', () => {
    record.clientAborted = true;
  });
  run.ledger.push(record);
  run.active += 1;

  let status = 500;
  try {
    const query = url.searchParams.get('q');
    const delay = run.scenario === 'stale-query' && query === 'alpha' ? Math.max(500, run.latency * 20) : run.latency;
    await Bun.sleep(delay);
    if (!record.authorized) {
      status = 401;
      return json({ error: 'missing benchmark bearer' }, status);
    }
    if (request.method !== 'GET') {
      status = 405;
      return json({ error: 'benchmark routes are read-only' }, status);
    }

    if (suffix === 'tasks') {
      if (query === null && run.scenario === 'initial-task-error') {
        status = 503;
        return json({ error: 'injected initial task failure' }, status);
      }
      if (query !== null && run.scenario === 'query-error') {
        status = 503;
        return json({ error: 'injected query failure' }, status);
      }
      status = 200;
      return json(taskListResponse(run, query), status);
    }

    const detail = /^tasks\/([^/]+)$/u.exec(suffix);
    if (detail !== null) {
      const id = decodeURIComponent(detail[1] as string);
      const task = run.tasks.find(candidate => candidate.summary.id === id);
      if (task === undefined) {
        status = 404;
        return json({ error: `unknown task ${id}` }, status);
      }
      status = 200;
      return json({ sessionId: run.sessionId, task: task.detail, activity: [] }, status);
    }

    if (suffix === 'fs/index') {
      status = 200;
      return json(run.index, status);
    }

    if (suffix === 'fs') {
      const path = url.searchParams.get('path') ?? '';
      if (path === '') {
        status = 200;
        return json({
          entries: [
            ...Array.from({ length: run.directories }, (_unused, directory) => ({
              name: `dir-${directory}`,
              type: 'dir',
            })),
            { name: 'README.md', type: 'file' },
          ],
        });
      }
      if (!/^dir-\d+$/u.test(path) || Number(path.slice(4)) >= run.directories) {
        status = 404;
        return json({ error: `unknown directory ${path}` }, status);
      }
      status = 200;
      return json({
        entries: [
          { name: 'file-0.ts', type: 'file' },
          { name: 'file-1.ts', type: 'file' },
        ],
      });
    }

    status = 404;
    return json({ error: `unknown benchmark route ${suffix}` }, status);
  } finally {
    record.status = status;
    record.settledAt = performance.now();
    run.active -= 1;
  }
};

const bundle = async (entrypoint: string, outdir: string, name: string): Promise<string> => {
  mkdirSync(outdir, { recursive: true });
  const built = await Bun.build({
    entrypoints: [entrypoint],
    outdir,
    naming: `${name}.js`,
    target: 'browser',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    minify: false,
    sourcemap: 'none',
  });
  if (!built.success) throw new Error(`could not build ${name}: ${built.logs.map(log => log.message).join('\n')}`);
  const output = built.outputs.find(candidate => candidate.path.endsWith(`${name}.js`));
  if (output === undefined) throw new Error(`the ${name} build did not emit ${name}.js`);
  return output.path;
};

const copyInstalledDependencies = (archiveRoot: string): void => {
  const currentRootModules = join(repoRoot, 'node_modules');
  if (!existsSync(currentRootModules))
    throw new Error('node_modules is missing; run bun install --frozen-lockfile first');
  symlinkSync(currentRootModules, join(archiveRoot, 'node_modules'), 'dir');
  const packagesDir = join(repoRoot, 'packages');
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const source = join(packagesDir, entry.name, 'node_modules');
    const targetPackage = join(archiveRoot, 'packages', entry.name);
    if (!existsSync(source) || !existsSync(targetPackage)) continue;
    cpSync(source, join(targetPackage, 'node_modules'), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
  for (const workspace of ['fleet', 'protocol', 'relay'] as const) {
    assertEqual(
      realpathSync(join(archiveRoot, 'packages/pwa/node_modules/@ferretry', workspace)),
      join(archiveRoot, 'packages', workspace),
      `historical @ferretry/${workspace} dependency target`,
    );
  }
};

const prepareBuilds = async (
  temporaryRoot: string,
): Promise<{
  readonly beforeJs: string;
  readonly afterJs: string;
  readonly css: string;
}> => {
  const archiveRoot = join(temporaryRoot, 'historical-tree');
  const archiveTar = join(temporaryRoot, 'historical-tree.tar');
  mkdirSync(archiveRoot, { recursive: true });
  command('git', ['archive', '--format=tar', `--output=${archiveTar}`, BEFORE.commit]);
  command('tar', ['-xf', archiveTar, '-C', archiveRoot]);
  rmSync(archiveTar);
  copyFileSync(harnessPath, join(archiveRoot, 'packages/pwa/harness/tasks-pane-benchmark.tsx'));
  copyInstalledDependencies(archiveRoot);

  const beforeJs = await bundle(
    join(archiveRoot, 'packages/pwa/harness/tasks-pane-benchmark.tsx'),
    join(temporaryRoot, 'before-build'),
    'before',
  );
  const afterJs = await bundle(harnessPath, join(temporaryRoot, 'after-build'), 'after');
  const css = join(temporaryRoot, 'app.css');
  command(
    './node_modules/.bin/tailwindcss',
    ['--config', 'tailwind.config.ts', '--input', 'src/styles/index.css', '--output', css],
    join(repoRoot, 'packages/pwa'),
  );
  return { beforeJs, afterJs, css };
};

const html = (script: string): string => `<!doctype html>
<html lang="en" data-theme="studio-dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/app.css" />
    <title>Tasks pane benchmark</title>
  </head>
  <body><main id="tasks-pane-benchmark-root"></main><script type="module" src="/${script}.js"></script></body>
</html>`;

const classify = (run: FixtureRun): LedgerSummary => {
  const prefix = `/v1/sessions/${encodeURIComponent(run.sessionId)}/`;
  let bareTasks = 0;
  const queries: string[] = [];
  let taskDetails = 0;
  let fileIndex = 0;
  let fileListings = 0;
  let unknown = 0;
  for (const row of run.ledger) {
    const url = new URL(`http://benchmark.invalid${row.pathname}${row.query}`);
    if (row.method !== 'GET' || !row.pathname.startsWith(prefix)) {
      unknown += 1;
      continue;
    }
    const suffix = row.pathname.slice(prefix.length);
    const parameters = [...url.searchParams.entries()];
    const onlyParameter = parameters.length === 1 ? parameters[0] : undefined;
    if (suffix === 'tasks' && url.search === '') bareTasks += 1;
    else if (suffix === 'tasks' && onlyParameter?.[0] === 'q') queries.push(onlyParameter[1]);
    else if (/^tasks\/[^/]+$/u.test(suffix) && url.search === '') taskDetails += 1;
    else if (suffix === 'fs/index' && url.search === '') fileIndex += 1;
    else if (suffix === 'fs' && (url.search === '' || onlyParameter?.[0] === 'path')) fileListings += 1;
    else unknown += 1;
  }
  return { bareTasks, queries, taskDetails, fileIndex, fileListings, unknown, total: run.ledger.length };
};

const describeLedger = (ledger: LedgerSummary): string =>
  `tasks=${ledger.bareTasks} q=[${ledger.queries.join(',')}] tasks/:id=${ledger.taskDetails} fs/index=${ledger.fileIndex} fs?path=${ledger.fileListings} unknown=${ledger.unknown} total=${ledger.total}`;

const expectedLedger = (arm: Arm, options: Options, queried: boolean): LedgerSummary =>
  arm === 'before'
    ? {
        bareTasks: 1,
        queries: [],
        taskDetails: options.tasks,
        fileIndex: 0,
        fileListings: options.directories + 1,
        unknown: 0,
        total: options.tasks + options.directories + 2,
      }
    : {
        bareTasks: 1,
        queries: queried ? ['needle'] : [],
        taskDetails: 0,
        fileIndex: 1,
        fileListings: 0,
        unknown: 0,
        total: queried ? 3 : 2,
      };

const assertLedger = (run: FixtureRun, expected: LedgerSummary, label: string): LedgerSummary => {
  const actual = classify(run);
  assertEqual(actual, expected, `${label} request ledger`);
  if (run.ledger.some(record => !record.authorized))
    throw new Error(`${label} sent a request without the bearer token`);
  if (run.ledger.some(record => record.status !== 200))
    throw new Error(
      `${label} had a non-200 request: ${run.ledger.map(record => `${record.raw}=${record.status}`).join(', ')}`,
    );
  return actual;
};

const waitForFixture = async (
  run: FixtureRun,
  predicate: (run: FixtureRun) => boolean,
  label: string,
): Promise<void> => {
  const deadline = performance.now() + FIXTURE_TIMEOUT_MS;
  while (!predicate(run)) {
    if (performance.now() >= deadline)
      throw new Error(`timed out waiting for ${label}; active=${run.active}, ledger=${describeLedger(classify(run))}`);
    await Bun.sleep(5);
  }
};

const mountPage = async (
  page: Page,
  sessionId: string,
  expectedTaskIds?: readonly string[],
  unavailable = false,
): Promise<MountResult> =>
  await page.evaluate(
    async options =>
      await (globalThis as unknown as { __tasksPaneBenchmark: BrowserApi }).__tasksPaneBenchmark.mount(options),
    { sessionId, expectedTaskIds, unavailable },
  );

const queryPage = async (page: Page, value: string, expectedTaskIds: readonly string[]): Promise<QueryResult> =>
  await page.evaluate(
    async ([query, ids]) =>
      await (globalThis as unknown as { __tasksPaneBenchmark: BrowserApi }).__tasksPaneBenchmark.query(query, ids),
    [value, expectedTaskIds] as const,
  );

const unmountPage = async (page: Page): Promise<void> => {
  await page.evaluate(() =>
    (globalThis as unknown as { __tasksPaneBenchmark: BrowserApi }).__tasksPaneBenchmark.unmount(),
  );
};

const timeArm = async (
  arm: Arm,
  page: Page,
  fixtures: Map<string, FixtureRun>,
  options: Options,
  sessionId: string,
): Promise<ArmSample> => {
  const run = createFixture(fixtures, sessionId, options);
  const allIds = fullTaskIds(options.tasks);
  try {
    await page.bringToFront();
    const mounted = await mountPage(page, sessionId, allIds);
    if (!Number.isFinite(mounted.elapsedMs) || mounted.elapsedMs <= 0)
      throw new Error(`${arm} produced an invalid task-paint duration ${mounted.elapsedMs}`);
    const initialExpected = expectedLedger(arm, options, false);
    await waitForFixture(
      run,
      candidate => candidate.active === 0 && candidate.ledger.length === initialExpected.total,
      `${arm} initial fixture settlement`,
    );
    const mountSettledMs = await page.evaluate(() =>
      (globalThis as unknown as { __tasksPaneBenchmark: BrowserApi }).__tasksPaneBenchmark.elapsed(),
    );
    const initialLedger = assertLedger(run, initialExpected, `${arm} initial mount`);

    const queried = await queryPage(page, 'needle', ['F1']);
    if (!Number.isFinite(queried.elapsedMs) || queried.elapsedMs <= 0)
      throw new Error(`${arm} produced an invalid query duration ${queried.elapsedMs}`);
    const finalExpected = expectedLedger(arm, options, true);
    await waitForFixture(
      run,
      candidate => candidate.active === 0 && candidate.ledger.length === finalExpected.total,
      `${arm} query fixture settlement`,
    );
    const workflowMs = await page.evaluate(() =>
      (globalThis as unknown as { __tasksPaneBenchmark: BrowserApi }).__tasksPaneBenchmark.elapsed(),
    );
    const finalLedger = assertLedger(run, finalExpected, `${arm} settled query`);
    const state = await page.evaluate(() =>
      (globalThis as unknown as { __tasksPaneBenchmark: BrowserApi }).__tasksPaneBenchmark.snapshot(),
    );
    assertEqual(state.taskIds, ['F1'], `${arm} visible query result`);
    for (const [value, label] of [
      [mountSettledMs, 'mount-settled'],
      [workflowMs, 'workflow'],
    ] as const) {
      if (!Number.isFinite(value) || value <= 0)
        throw new Error(`${arm} produced an invalid ${label} duration ${value}`);
    }
    return {
      arm,
      taskPaintMs: mounted.elapsedMs,
      mountSettledMs,
      queryPaintMs: queried.elapsedMs,
      workflowMs,
      initialLedger,
      finalLedger,
      rawRequests: run.ledger.map(record => record.raw),
    };
  } catch (reason) {
    const state = await page
      .evaluate(() => (globalThis as unknown as { __tasksPaneBenchmark: BrowserApi }).__tasksPaneBenchmark.snapshot())
      .catch(error => ({ snapshotError: String(error) }));
    const message = reason instanceof Error ? reason.message : String(reason);
    throw new Error(
      `${arm} arm failed: ${message}\nledger: ${describeLedger(classify(run))}\nraw: ${run.ledger
        .map(record => `${record.raw}=${record.status}`)
        .join(', ')}\nsurface: ${JSON.stringify(state)}`,
    );
  } finally {
    await unmountPage(page);
  }
};

const pairedSamples = async (
  beforePage: Page,
  afterPage: Page,
  fixtures: Map<string, FixtureRun>,
  options: Options,
): Promise<readonly PairSample[]> => {
  await timeArm('before', beforePage, fixtures, options, 'warm-before');
  await timeArm('after', afterPage, fixtures, options, 'warm-after');

  const pairs: PairSample[] = [];
  for (let index = 0; index < options.samples; index += 1) {
    const pair = index + 1;
    const order: readonly [Arm, Arm] = index % 2 === 0 ? ['before', 'after'] : ['after', 'before'];
    let before: ArmSample | null = null;
    let after: ArmSample | null = null;
    for (const arm of order) {
      const sample = await timeArm(
        arm,
        arm === 'before' ? beforePage : afterPage,
        fixtures,
        options,
        `pair-${pair}-${arm}`,
      );
      if (arm === 'before') before = sample;
      else after = sample;
    }
    if (before === null || after === null) throw new Error(`pair ${pair} did not produce both arms`);
    pairs.push({ pair, order, before, after });
  }
  if (pairs.length !== options.samples) throw new Error(`expected ${options.samples} pairs, got ${pairs.length}`);
  return pairs;
};

const proveAfterStates = async (
  page: Page,
  fixtures: Map<string, FixtureRun>,
  options: Options,
): Promise<readonly string[]> => {
  const allIds = fullTaskIds(options.tasks);
  const evidence: string[] = [];
  await page.bringToFront();

  const partial = createFixture(fixtures, 'probe-partial-index', options, 'partial-index');
  try {
    await mountPage(page, partial.sessionId, allIds);
    await waitForFixture(partial, run => run.active === 0 && run.ledger.length === 2, 'partial-index mount');
    await page.evaluate(
      async () =>
        await (globalThis as unknown as { __tasksPaneBenchmark: BrowserApi }).__tasksPaneBenchmark.openSearch(),
    );
    await page.evaluate(
      async () =>
        await (globalThis as unknown as { __tasksPaneBenchmark: BrowserApi }).__tasksPaneBenchmark.waitForSelector(
          '[data-search-coverage]',
        ),
    );
    const state = await page.evaluate(() =>
      (globalThis as unknown as { __tasksPaneBenchmark: BrowserApi }).__tasksPaneBenchmark.snapshot(),
    );
    if (!state.coveragePartial || state.skipNote === null || state.taskIds.length !== options.tasks)
      throw new Error('the partial index was not visibly qualified while mounted tasks remained');
    const ledger = assertLedger(partial, expectedLedger('after', options, false), 'partial-index probe');
    evidence.push(`partial index: visible qualification + ${options.tasks} retained tasks; ${describeLedger(ledger)}`);
  } finally {
    await unmountPage(page);
  }

  const queryError = createFixture(fixtures, 'probe-query-error', options, 'query-error');
  try {
    await mountPage(page, queryError.sessionId, allIds);
    await waitForFixture(queryError, run => run.active === 0 && run.ledger.length === 2, 'query-error mount');
    await page.evaluate(value => {
      (globalThis as unknown as { __tasksPaneBenchmark: BrowserApi }).__tasksPaneBenchmark.setQuery(value);
    }, 'error');
    await page.evaluate(
      async () =>
        await (globalThis as unknown as { __tasksPaneBenchmark: BrowserApi }).__tasksPaneBenchmark.waitForSelector(
          '[data-task-filter-unavailable]',
        ),
    );
    await waitForFixture(queryError, run => run.active === 0 && run.ledger.length === 3, 'query-error settlement');
    const state = await page.evaluate(() =>
      (globalThis as unknown as { __tasksPaneBenchmark: BrowserApi }).__tasksPaneBenchmark.snapshot(),
    );
    if (!state.taskFilterUnavailable || state.taskIds.length !== options.tasks)
      throw new Error('the query failure did not retain mounted tasks behind a visible alert');
    const expected = { ...expectedLedger('after', options, true), queries: ['error'] };
    const ledger = classify(queryError);
    assertEqual(ledger, expected, 'query-error probe request ledger');
    if (queryError.ledger.some(record => !record.authorized))
      throw new Error('query-error probe sent a request without the bearer token');
    if (
      queryError.ledger
        .map(record => record.status)
        .sort()
        .join(',') !== '200,200,503'
    )
      throw new Error(`query-error probe had unexpected statuses ${queryError.ledger.map(record => record.status)}`);
    evidence.push(`query error: visible alert + ${options.tasks} retained tasks; ${describeLedger(ledger)}`);
  } finally {
    await unmountPage(page);
  }

  const stale = createFixture(fixtures, 'probe-stale-query', options, 'stale-query');
  try {
    await mountPage(page, stale.sessionId, allIds);
    await waitForFixture(stale, run => run.active === 0 && run.ledger.length === 2, 'stale-query mount');
    await page.evaluate(value => {
      (globalThis as unknown as { __tasksPaneBenchmark: BrowserApi }).__tasksPaneBenchmark.setQuery(value);
    }, 'alpha');
    await waitForFixture(stale, run => classify(run).queries.includes('alpha'), 'the slow alpha request to start');
    await page.evaluate(value => {
      (globalThis as unknown as { __tasksPaneBenchmark: BrowserApi }).__tasksPaneBenchmark.setQuery(value);
    }, 'beta');
    await page.evaluate(
      async () =>
        await (globalThis as unknown as { __tasksPaneBenchmark: BrowserApi }).__tasksPaneBenchmark.waitForTaskIds([
          'F1',
        ]),
    );
    await waitForFixture(stale, run => run.active === 0 && run.ledger.length === 4, 'stale-query settlement');
    const state = await page.evaluate(() =>
      (globalThis as unknown as { __tasksPaneBenchmark: BrowserApi }).__tasksPaneBenchmark.snapshot(),
    );
    assertEqual(state.taskIds, ['F1'], 'newer beta result after slow alpha settles');
    const expected = { ...expectedLedger('after', options, true), queries: ['alpha', 'beta'], total: 4 };
    const ledger = assertLedger(stale, expected, 'stale-query probe');
    const alpha = stale.ledger.find(
      record => new URL(`http://benchmark.invalid${record.pathname}${record.query}`).searchParams.get('q') === 'alpha',
    );
    if (alpha?.clientAborted !== true) throw new Error('the slow alpha request was not aborted by the production pane');
    evidence.push(`stale query: alpha aborted, beta alone remained visible; ${describeLedger(ledger)}`);
  } finally {
    await unmountPage(page);
  }

  const unavailable = createFixture(fixtures, 'probe-initial-task-error', options, 'initial-task-error');
  try {
    await mountPage(page, unavailable.sessionId, undefined, true);
    await waitForFixture(unavailable, run => run.active === 0 && run.ledger.length === 2, 'initial-error settlement');
    const state = await page.evaluate(() =>
      (globalThis as unknown as { __tasksPaneBenchmark: BrowserApi }).__tasksPaneBenchmark.snapshot(),
    );
    if (!state.tasksUnavailable || state.text.includes('No matching tasks'))
      throw new Error('the failed initial task read was not visibly unavailable');
    const expected = expectedLedger('after', options, false);
    const actual = classify(unavailable);
    assertEqual(actual, expected, 'initial-error probe request ledger');
    if (
      unavailable.ledger
        .map(record => record.status)
        .sort()
        .join(',') !== '200,503'
    )
      throw new Error(`initial-error probe had unexpected statuses ${unavailable.ledger.map(record => record.status)}`);
    evidence.push(`initial error: "Tasks are unavailable" visible, no false empty state; ${describeLedger(actual)}`);
  } finally {
    await unmountPage(page);
  }

  return evidence;
};

const median = (values: readonly number[]): number => {
  if (values.length === 0 || values.some(value => !Number.isFinite(value) || value <= 0))
    throw new Error(`cannot take a median of ${JSON.stringify(values)}`);
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
    : (sorted[middle] as number);
};

const ms = (value: number): string => `${value.toFixed(1)} ms`;

const printSamples = (pairs: readonly PairSample[]): void => {
  console.log('\npaired samples (Chrome wall-clock milliseconds)');
  for (const sample of pairs) {
    console.log(`  pair ${sample.pair} order ${sample.order.map(arm => arm.toUpperCase()).join(' → ')}`);
    for (const arm of [sample.before, sample.after]) {
      console.log(
        `    ${arm.arm.toUpperCase().padEnd(6)} task-paint ${ms(arm.taskPaintMs).padStart(9)} | mount-settled ${ms(
          arm.mountSettledMs,
        ).padStart(9)} | query-paint ${ms(arm.queryPaintMs).padStart(9)} | workflow ${ms(arm.workflowMs).padStart(9)}`,
      );
      console.log(`           initial ${describeLedger(arm.initialLedger)}`);
      console.log(`           final   ${describeLedger(arm.finalLedger)}`);
    }
  }

  const metrics = [
    ['task-paint', (sample: ArmSample) => sample.taskPaintMs],
    ['mount-settled', (sample: ArmSample) => sample.mountSettledMs],
    ['query-paint', (sample: ArmSample) => sample.queryPaintMs],
    ['workflow', (sample: ArmSample) => sample.workflowMs],
  ] as const;
  console.log('\npaired medians');
  for (const [label, pick] of metrics) {
    const before = median(pairs.map(pair => pick(pair.before)));
    const after = median(pairs.map(pair => pick(pair.after)));
    console.log(`  ${label.padEnd(15)} BEFORE ${ms(before).padStart(9)} | AFTER ${ms(after).padStart(9)}`);
  }
  const beforeWorkflow = median(pairs.map(pair => pair.before.workflowMs));
  const afterWorkflow = median(pairs.map(pair => pair.after.workflowMs));
  if (afterWorkflow < beforeWorkflow)
    console.log(`  measured workflow direction: ${(beforeWorkflow / afterWorkflow).toFixed(2)}× faster after`);
  else if (afterWorkflow > beforeWorkflow)
    console.log(`  measured workflow direction: ${(afterWorkflow / beforeWorkflow).toFixed(2)}× slower after`);
  else console.log('  measured workflow direction: equal medians');

  console.log('\ncanonical raw ordered ledger (measured pair 1)');
  for (const arm of [pairs[0]?.before, pairs[0]?.after]) {
    if (arm === undefined) throw new Error('pair 1 is missing');
    console.log(`  ${arm.arm.toUpperCase()} (${arm.rawRequests.length} scoped requests)`);
    arm.rawRequests.forEach((request, index) => console.log(`    ${String(index + 1).padStart(2)}. ${request}`));
  }
};

const safeCleanup = (temporaryRoot: string): void => {
  const prefix = `${resolve(tmpdir())}${sep}ferretry-tasks-pane-`;
  const resolved = resolve(temporaryRoot);
  if (!resolved.startsWith(prefix) || !statSync(resolved).isDirectory())
    throw new Error(`refusing to clean an unowned temporary path: ${resolved}`);
  rmSync(resolved, { recursive: true, force: true });
  if (existsSync(resolved)) throw new Error(`temporary cleanup left ${resolved}`);
};

const main = async (): Promise<void> => {
  const options = parseOptions(Bun.argv.slice(2));
  const inheritedUmask = process.umask();
  if (inheritedUmask !== 0o002)
    throw new Error(`expected ordinary child umask 0002, got ${inheritedUmask.toString(8).padStart(4, '0')}`);
  const inheritedLockDescriptor = proveInheritedHeavyLock();
  directPostLockAudit();
  const identity = proveReferences();
  const chrome = Bun.which('google-chrome') ?? Bun.which('chromium');
  if (chrome === null) throw new Error('no system Google Chrome or Chromium executable is available');

  const temporaryRoot = mkdtempSync(join(tmpdir(), 'ferretry-tasks-pane-'));
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let server: ReturnType<typeof Bun.serve> | null = null;
  try {
    chmodSync(temporaryRoot, 0o700);
    const builds = await prepareBuilds(temporaryRoot);
    const fixtures = new Map<string, FixtureRun>();
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname.startsWith('/v1/')) return await serveApi(request, fixtures);
        if (url.pathname === '/before' || url.pathname === '/before/')
          return new Response(html('before'), { headers: { 'content-type': 'text/html; charset=utf-8' } });
        if (url.pathname === '/after' || url.pathname === '/after/')
          return new Response(html('after'), { headers: { 'content-type': 'text/html; charset=utf-8' } });
        if (url.pathname === '/before.js') return new Response(Bun.file(builds.beforeJs));
        if (url.pathname === '/after.js') return new Response(Bun.file(builds.afterJs));
        if (url.pathname === '/app.css') return new Response(Bun.file(builds.css));
        return new Response('not found', { status: 404 });
      },
    });

    browser = await chromium.launch({
      executablePath: chrome,
      headless: true,
      args: [
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
    });
    context = await browser.newContext({ viewport: { width: 1_280, height: 900 } });
    await context.route('**/*', async route => {
      const origin = new URL(route.request().url()).origin;
      if (origin !== server?.url.origin) {
        await route.abort();
        return;
      }
      await route.continue();
    });
    const beforePage = await context.newPage();
    const afterPage = await context.newPage();
    await Promise.all([
      beforePage.goto(new URL('/before', server.url).toString(), { waitUntil: 'load', timeout: FIXTURE_TIMEOUT_MS }),
      afterPage.goto(new URL('/after', server.url).toString(), { waitUntil: 'load', timeout: FIXTURE_TIMEOUT_MS }),
    ]);
    await Promise.all([
      beforePage.waitForFunction(() => '__tasksPaneBenchmark' in globalThis, undefined, {
        timeout: FIXTURE_TIMEOUT_MS,
      }),
      afterPage.waitForFunction(() => '__tasksPaneBenchmark' in globalThis, undefined, { timeout: FIXTURE_TIMEOUT_MS }),
    ]);

    console.log('╭─ Tasks-pane real-Chrome benchmark ─────────────────────────────────────────');
    console.log(`│ BEFORE source ${BEFORE.commit} tree ${BEFORE.tree}`);
    console.log(`│               ${BEFORE.label}`);
    console.log(`│ AFTER source  ${AFTER.commit} tree ${AFTER.tree}`);
    console.log(`│               ${AFTER.label}`);
    console.log(`│ runner HEAD   ${identity.head} tree ${identity.tree} parent ${identity.parent}`);
    console.log(
      `│ runner state  ${identity.dirty.length === 0 ? 'CLEAN (citable)' : `DIRTY owned paths only (not citable): ${identity.dirty.join(', ')}`}`,
    );
    console.log(
      `│ heavy gate    inherited fd ${inheritedLockDescriptor}; trusted marker passed; direct /proc audit clear`,
    );
    console.log(`│ browser       ${await browser.version()} at ${chrome}`);
    console.log(`│ fixture       ${options.tasks} tasks, ${options.directories} directories × 2 files + README`);
    console.log(`│ latency       ${options.latency} ms deterministic API-response latency`);
    console.log(`│ samples       ${options.samples} warmed alternating pairs (equal leading positions)`);
    console.log('│ task-paint    render request → 2nd animation frame after exact task rows paint');
    console.log('│ mount-settled task-paint start → complete task/file request ledger drains');
    console.log('│ query-paint   input event → 2nd animation frame after exact filtered rows paint');
    console.log('│ workflow      task-paint start → settled query request ledger drains');
    console.log('╰────────────────────────────────────────────────────────────────────────────');

    const pairs = await pairedSamples(beforePage, afterPage, fixtures, options);
    printSamples(pairs);
    const states = await proveAfterStates(afterPage, fixtures, options);
    console.log('\nproduction-after state evidence');
    states.forEach(line => console.log(`  ✓ ${line}`));
    console.log(
      '  note: the separate focused unit test, not this command, proves the late-resolution generation fence',
    );
    console.log('\ncleanup is pending; success is printed only after browser/server/temp cleanup completes.');
  } finally {
    const cleanupErrors: string[] = [];
    if (context !== null)
      await context.close().catch(reason => cleanupErrors.push(`browser context: ${String(reason)}`));
    if (browser !== null) await browser.close().catch(reason => cleanupErrors.push(`browser: ${String(reason)}`));
    if (server !== null)
      await server.stop(true).catch(reason => cleanupErrors.push(`loopback server: ${String(reason)}`));
    try {
      safeCleanup(temporaryRoot);
    } catch (reason) {
      cleanupErrors.push(`temporary tree: ${String(reason)}`);
    }
    if (cleanupErrors.length > 0) throw new Error(`benchmark cleanup failed: ${cleanupErrors.join('; ')}`);
  }
  console.log('✓ cleanup complete: browser, loopback server, and private temporary tree removed');
};

try {
  await main();
} catch (reason) {
  const message =
    reason instanceof OptionRefusal
      ? reason.message
      : reason instanceof Error
        ? (reason.stack ?? reason.message)
        : String(reason);
  console.error(`❌ ${message}`);
  process.exitCode = reason instanceof OptionRefusal ? 2 : 1;
}
