/**
 * THE CHANGED-PLUGIN SCOPE of Quick Checks: which unit tests a pull request has to run.
 *
 * Quick used to run every unit test on every pull request (median 14 min over 200 runs). A unit PR into
 * `rebuild/5.0-after` that only touches one plugin now runs that plugin, every package that depends on it, and the
 * platform packages' own tests (core, app, cli, std). Everything else still runs the whole set unchanged.
 *
 * A WRONG FILTER SKIPS TESTS SILENTLY, so the rules are an ALLOWLIST and every doubt is FULL:
 *
 *   1. Only a `pull_request` into exactly `rebuild/5.0-after` without the `full-ci` label may be scoped.
 *   2. The changed set is `git diff --name-only --no-renames <base>...<head>` (merge-base). No merge-base, no diff, a
 *      path this file cannot classify: FULL. `--no-renames` lists BOTH sides of a rename (the old and the new path).
 *   3. A file may be scoped ONLY when it lives under `packages/plugins/<one>/` of a workspace package, and is not that
 *      package's `package.json` (a changed dependency declaration changes the graph this selection reads). Any other path
 *      - core, app, cli, std, daemon, scripts, nix, .github, docs, the root manifests, generated registries, a path
 *      nobody has seen yet - makes the whole run FULL. The allowlist is the only list there is.
 *   4. The selection is the changed plugins plus everything that depends on them, transitively. The dependency graph is
 *      the UNION of three sources (so a miss in one cannot skip a test): workspace `package.json` dependencies (all four
 *      kinds), the plugin manifests' `needs` / `uses` / hook `takes` / `order` edges (port consumer → provider), and
 *      every `@ferretry/<package>` or `plugins/<dir>/` mention in a source file (a superset of real imports).
 *   5. Selecting every plugin leaves nothing to skip, so that is FULL too and says so.
 *
 * `selectScope` is pure; the git and file-system reads are below it, and every failure there ends in FULL.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The only base a scoped run exists for. */
export const SCOPED_BASE_REF = 'rebuild/5.0-after';
/** The label that forces the full set, as the workflow's own `full-ci` jobs read it. */
export const FULL_LABEL = 'full-ci';

const PLUGIN_ROOT = 'packages/plugins';

export interface PackageNode {
  /** npm name, e.g. `@ferretry/plugin-board`. */
  readonly name: string;
  /** Folder relative to the repository root, `/`-separated, e.g. `packages/plugins/board`. */
  readonly rel: string;
}

export interface ScopeInput {
  /** `github.event_name`; undefined outside CI. */
  readonly event: string | undefined;
  /** `github.event.pull_request.base.ref`. */
  readonly baseRef: string | undefined;
  readonly labels: readonly string[];
  /** The changed paths (both sides of a rename), or undefined when they could not be computed. */
  readonly changed: readonly string[] | undefined;
  /** Why `changed` is undefined, for the log. */
  readonly changedError?: string;
  readonly packages: readonly PackageNode[];
  /** Package name → the package names it depends on (the union of every source). */
  readonly dependsOn: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface Selected extends PackageNode {
  /** `changed`, or `depends on <selected package>`. */
  readonly why: string;
}

export type Decision =
  | { readonly mode: 'full'; readonly reason: string }
  | {
      readonly mode: 'scoped';
      readonly changed: readonly string[];
      /** The plugin packages whose tests run, with why each is in. */
      readonly selected: readonly Selected[];
      /** The plugin packages whose tests do NOT run (nothing depends on a changed plugin through them). */
      readonly skipped: readonly PackageNode[];
      /** Every package that is not a plugin: its tests always run. */
      readonly platform: readonly PackageNode[];
    };

const full = (reason: string): Decision => ({ mode: 'full', reason });

const isPlugin = (pkg: PackageNode): boolean => {
  const rest = pkg.rel.startsWith(`${PLUGIN_ROOT}/`) ? pkg.rel.slice(PLUGIN_ROOT.length + 1) : '';
  return rest !== '' && !rest.includes('/');
};

/** A path this module can reason about: relative, `/`-separated, no `..`, no empty or dot segments. */
const cleanPath = (path: string): boolean =>
  path !== '' &&
  !path.startsWith('/') &&
  !path.includes('\\') &&
  path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');

/** Rule 1: FULL unless the event, base and labels allow a scope at all. Needs no repository to answer. */
export function gate(input: Pick<ScopeInput, 'event' | 'baseRef' | 'labels'>): Decision | undefined {
  if (input.event !== 'pull_request')
    return full(
      `the event is ${input.event === undefined ? 'not a CI event' : `"${input.event}"`}, not a pull request`,
    );
  if (input.baseRef !== SCOPED_BASE_REF)
    return full(
      `the base ref is ${input.baseRef === undefined ? 'unknown' : `"${input.baseRef}"`}; only ${SCOPED_BASE_REF} is scoped`,
    );
  if (input.labels.includes(FULL_LABEL)) return full(`the pull request carries the ${FULL_LABEL} label`);
  return undefined;
}

export function selectScope(input: ScopeInput): Decision {
  const closed = gate(input);
  if (closed !== undefined) return closed;
  if (input.changed === undefined)
    return full(`the changed files could not be computed (${input.changedError ?? 'no reason given'})`);
  if (input.changed.length === 0)
    return full('the diff against the merge-base is empty, which no scope can be proved from');

  const plugins = input.packages.filter(isPlugin);
  const byRel = new Map(plugins.map(pkg => [pkg.rel, pkg] as const));
  const changedPlugins = new Map<string, PackageNode>();
  for (const file of input.changed) {
    if (!cleanPath(file)) return full(`the changed path ${JSON.stringify(file)} is not a plain repository path`);
    const match = /^packages\/plugins\/([^/]+)\/(.+)$/.exec(file);
    if (match === null)
      return full(`${file} is outside the plugin packages (only packages/plugins/<one>/... may be scoped)`);
    const dir = `${PLUGIN_ROOT}/${match[1]}`;
    const pkg = byRel.get(dir);
    if (pkg === undefined) return full(`${file} is under ${dir}, which is no workspace package`);
    if (match[2] === 'package.json')
      return full(`${file} changes a plugin's dependency declaration, which changes the graph`);
    changedPlugins.set(pkg.name, pkg);
  }

  // Reverse closure over the PLUGIN graph, breadth first so every plugin is in for its shortest reason. It never walks
  // through a platform package: every plugin depends on the kernel and the app, so a closure through them is always
  // everything. The platform packages' own tests always run instead, and a plugin a platform package depends on is a
  // hub (below).
  const pluginNames = new Set(plugins.map(pkg => pkg.name));
  const dependents = new Map<string, string[]>();
  for (const [name, deps] of input.dependsOn)
    if (pluginNames.has(name)) for (const dep of deps) dependents.set(dep, [...(dependents.get(dep) ?? []), name]);
  const why = new Map<string, string>([...changedPlugins.keys()].sort().map(name => [name, 'changed'] as const));
  const queue = [...why.keys()];
  for (let head = 0; head < queue.length; head++) {
    const name = queue[head] as string;
    for (const dependent of [...(dependents.get(name) ?? [])].sort()) {
      if (why.has(dependent)) continue;
      why.set(dependent, `depends on ${name}`);
      queue.push(dependent);
    }
  }

  // A HUB: a selected plugin that a platform package (app, cli, kernel, core, std) depends on. A change in it reaches
  // every plugin through that package, which is exactly the path the closure above does not walk, so the run is FULL.
  const platformNames = new Set(input.packages.filter(pkg => !isPlugin(pkg)).map(pkg => pkg.name));
  for (const name of [...why.keys()].sort())
    for (const [from, deps] of [...input.dependsOn].sort(([x], [y]) => x.localeCompare(y)))
      if (platformNames.has(from) && deps.has(name))
        return full(
          `${name} (${why.get(name)}) is depended on by the platform package ${from}, so a change reaches every plugin through it`,
        );

  const selected = plugins.filter(pkg => why.has(pkg.name)).map(pkg => ({ ...pkg, why: why.get(pkg.name) as string }));
  const skipped = plugins.filter(pkg => !why.has(pkg.name));
  if (skipped.length === 0)
    return full(
      `the changed plugins and their dependents cover all ${plugins.length} plugins, so nothing could be skipped`,
    );
  return {
    mode: 'scoped',
    changed: [...input.changed].sort(),
    selected,
    skipped,
    platform: input.packages.filter(pkg => !isPlugin(pkg)),
  };
}

/** Whether a test file path (with or without a leading `./`) belongs to a skipped plugin. */
export const isSkippedFile = (file: string, skipped: readonly { readonly rel: string }[]): boolean => {
  const path = file.startsWith('./') ? file.slice(2) : file;
  return skipped.some(pkg => path.startsWith(`${pkg.rel}/`));
};

/** The decision as the log lines every run prints at the top of Quick (and in the step summary). */
export function describe(decision: Decision, pluginCount: number): string[] {
  if (decision.mode === 'full') return [`CI scope: FULL - ${decision.reason}. Every unit test runs.`];
  const lines = [
    `CI scope: SCOPED - ${decision.selected.length} of ${pluginCount} plugins run, ${decision.skipped.length} skipped; the platform packages (core, app, cli, std) always run in full.`,
    `Changed files: ${decision.changed.length}. This is NOT the full unit set and NOT the complete production ledger.`,
  ];
  for (const pkg of decision.selected) lines.push(`  run  ${pkg.rel} (${pkg.why})`);
  for (const pkg of decision.skipped) lines.push(`  skip ${pkg.rel}`);
  return lines;
}

// ─── reading the repository ───────────────────────────────────────────────────────────────────────────────────────

const git = (root: string, args: readonly string[]): { ok: boolean; out: string } => {
  const run = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return { ok: run.status === 0, out: run.stdout ?? '' };
};

/** `git diff --name-only --no-renames <base>...<head>`; undefined with the reason when the merge-base is missing. */
export function changedFiles(
  root: string,
  base: string,
  head: string,
): { readonly files: string[] } | { readonly error: string } {
  if (!/^[0-9a-f]{7,64}$/.test(base) || !/^[0-9a-f]{7,64}$/.test(head))
    return { error: 'the base or head sha is missing' };
  const mergeBase = git(root, ['merge-base', base, head]);
  if (!mergeBase.ok || mergeBase.out.trim() === '')
    return { error: `no merge-base of ${base} and ${head} in this checkout` };
  const diff = git(root, ['diff', '--name-only', '--no-renames', '-z', `${base}...${head}`]);
  if (!diff.ok) return { error: `git diff ${base}...${head} failed` };
  return { files: diff.out.split('\0').filter(file => file !== '') };
}

interface PackageJson {
  readonly name?: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
}

/** Every file under `dir` (relative to `root`, `/`-separated), without entering `node_modules` or following a symlink. */
function* walk(root: string, dir: string): Generator<string> {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.tmp') continue;
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) yield* walk(root, path);
    else if (entry.isFile()) yield path;
  }
}

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?|css|json)$/;

/** The union of the dependency sources; every package of the workspace is a node. */
export async function readGraph(root: string): Promise<{
  readonly packages: PackageNode[];
  readonly dependsOn: Map<string, Set<string>>;
}> {
  // Imported lazily: scope.ts is also the module the unit tests load, and it needs no workspace to select.
  const { loadManifests, loadWorkspace } = await import('../gen/lib/workspace.ts');
  const ws = loadWorkspace(root);
  const packages = ws.packages.map(pkg => ({ name: pkg.name, rel: pkg.rel }));
  const dependsOn = new Map<string, Set<string>>(packages.map(pkg => [pkg.name, new Set<string>()] as const));
  const edge = (from: string, to: string): void => {
    if (from !== to && dependsOn.has(to)) dependsOn.get(from)?.add(to);
  };

  // 1. package.json, all four dependency kinds.
  for (const pkg of ws.packages) {
    const json = JSON.parse(readFileSync(join(pkg.dir, 'package.json'), 'utf8')) as PackageJson;
    for (const group of [json.dependencies, json.devDependencies, json.peerDependencies, json.optionalDependencies])
      for (const dep of Object.keys(group ?? {})) edge(pkg.name, dep);
  }

  // 2. The manifests: a consumer of a port depends on its provider, a taker of a hook on its offerer.
  const { loaded, failures } = await loadManifests(ws);
  if (failures.length > 0) throw new Error(`manifests did not load: ${failures.join('; ')}`);
  const providers = new Map<string, string[]>();
  const offerers = new Map<string, string[]>();
  for (const { pkg, manifest } of loaded) {
    for (const token of Object.values(manifest.provides ?? {}))
      providers.set(token.name, [...(providers.get(token.name) ?? []), pkg.name]);
    for (const offer of manifest.hooks?.offers ?? [])
      offerers.set(offer.hook.name, [...(offerers.get(offer.hook.name) ?? []), pkg.name]);
  }
  for (const { pkg, manifest } of loaded) {
    for (const token of [...Object.values(manifest.needs ?? {}), ...Object.values(manifest.uses ?? {})])
      for (const provider of providers.get(token.name) ?? []) edge(pkg.name, provider);
    for (const take of manifest.hooks?.takes ?? [])
      for (const offerer of offerers.get(take.hook.name) ?? []) edge(pkg.name, offerer);
    for (const after of manifest.order?.after ?? []) {
      const other = ws.byId(after);
      if (other !== undefined) edge(pkg.name, other.name);
    }
    for (const before of manifest.order?.before ?? []) {
      const other = ws.byId(before);
      if (other !== undefined) edge(other.name, pkg.name);
    }
  }

  // 3. Every mention: a superset of what is really imported (comments and strings count), so it can only add edges.
  const names = new Map(packages.map(pkg => [pkg.name, pkg.name] as const));
  const byRel = new Map(packages.map(pkg => [pkg.rel, pkg.name] as const));
  const owners = [...packages].sort((a, b) => b.rel.length - a.rel.length);
  for (const file of walk(root, 'packages')) {
    if (!SOURCE_EXTENSION.test(file) || file.endsWith('package.json')) continue;
    const owner = owners.find(pkg => file.startsWith(`${pkg.rel}/`));
    if (owner === undefined || /(^|\/)generated\//.test(file)) continue; // the registries name every plugin
    // A platform package's tests always run, so what they mention decides nothing; its own code decides who is a hub.
    if (!isPlugin(owner) && /(^|\/)tests\/|\.test\.tsx?$/.test(file)) continue;
    let text: string;
    try {
      text = readFileSync(join(root, file), 'utf8');
    } catch {
      continue; // deleted in the working tree: nothing to read
    }
    for (const match of text.matchAll(/@ferretry\/[A-Za-z0-9._-]+/g)) {
      const target = names.get(match[0]);
      if (target !== undefined) edge(owner.name, target);
    }
    for (const match of text.matchAll(/\b(core|plugins)\/([a-z0-9][a-z0-9-]*)\//g)) {
      const target = byRel.get(`packages/${match[1]}/${match[2]}`);
      if (target !== undefined) edge(owner.name, target);
    }
  }
  return { packages, dependsOn };
}

// ─── the command line ─────────────────────────────────────────────────────────────────────────────────────────────

const parseLabels = (raw: string | undefined): string[] => {
  if (raw === undefined || raw.trim() === '') return [];
  const value: unknown = JSON.parse(raw);
  if (value === null) return [];
  if (!Array.isArray(value) || !value.every(label => typeof label === 'string'))
    throw new Error('labels are not a JSON list of strings');
  return value;
};

/** Reads the CI environment, decides, prints the decision and writes it to `out`. Never throws: a failure is FULL. */
export async function decide(root: string, env: Record<string, string | undefined>, out: string): Promise<Decision> {
  let decision: Decision;
  let pluginCount = 0;
  try {
    const event = env.FY_SCOPE_EVENT;
    const baseRef = env.FY_SCOPE_BASE_REF;
    const labels = parseLabels(env.FY_SCOPE_LABELS);
    // Cheap exits first: a push, a dispatch, another base or the label never read the repository.
    const closed = gate({ event, baseRef, labels });
    if (closed !== undefined) decision = closed;
    else {
      const changed = changedFiles(root, env.FY_SCOPE_BASE_SHA ?? '', env.FY_SCOPE_HEAD_SHA ?? '');
      const graph = await readGraph(root);
      pluginCount = graph.packages.filter(isPlugin).length;
      decision = selectScope({
        event,
        baseRef,
        labels,
        changed: 'files' in changed ? changed.files : undefined,
        ...('error' in changed ? { changedError: changed.error } : {}),
        packages: graph.packages,
        dependsOn: graph.dependsOn,
      });
    }
  } catch (error) {
    decision = full(`the scope could not be computed (${error instanceof Error ? error.message : String(error)})`);
  }
  const lines = describe(decision, pluginCount);
  for (const line of lines) console.log(line);
  appendFileSync(env.GITHUB_STEP_SUMMARY ?? '/dev/null', `\n### Quick scope\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(decision, null, 2)}\n`);
  return decision;
}

/** stdin → stdout: the test files that are not under a skipped plugin. A FULL (or unreadable) decision keeps them all. */
export function filterFiles(decision: Decision, files: readonly string[]): string[] {
  return decision.mode === 'scoped' ? files.filter(file => !isSkippedFile(file, decision.skipped)) : [...files];
}

if (import.meta.main) {
  const [command, file] = process.argv.slice(2);
  const root = process.cwd();
  if (command === 'decide') {
    await decide(root, process.env, file ?? 'coverage/ci/scope.json');
  } else if (command === 'filter' && file !== undefined) {
    const decision = JSON.parse(readFileSync(file, 'utf8')) as Decision;
    const files = (await Bun.stdin.text()).split('\n').filter(line => line !== '');
    for (const kept of filterFiles(decision, files)) console.log(kept);
  } else {
    console.error('usage: scope.ts decide [<out.json>] | scope.ts filter <scope.json> < files');
    process.exit(2);
  }
}
