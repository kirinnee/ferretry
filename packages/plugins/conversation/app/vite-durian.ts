import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * WHAT THE APP SHELL'S VITE CONFIG NEEDS TO BUILD `durian-hypermedia` — the hypermedia renderer's package — the way
 * `vite-voice.ts` serves Voice: the shell registers {@link durianBuild}'s plugin and owns nothing else about it.
 *
 * THE PACKAGE ARRIVES AS SOURCE. It is a git dependency pinned to a tag's commit (`package.json`, `bun.lock`), its
 * `dist/` is made by a `prepare` script, and the install runs `--ignore-scripts` (`nix/ferretry.nix`), so there is no
 * `dist/`. The plugin therefore resolves every `durian-hypermedia` import to the file its `exports` map names under
 * the `bun` condition (its own TypeScript source), reading that map, never a copy of it; and it builds the stylesheet
 * (`durian-hypermedia/styles.css`) from the package's own `scripts/build-css.ts`, the script its `prepare` would have
 * run. The `bun` condition is applied to this ONE package: a global `resolve.conditions` entry would also change which
 * build of every other dependency the bundle picks.
 *
 * ONE COPY OF EVERY LIBRARY WE ALREADY SHIP. Durian pins `chart.js` and `dompurify` at versions of its own
 * (4.5.1, 3.4.18); the bundle holds exactly one of each, OURS (the versions `package.json` here pins, the ones the
 * Trusted Types audit and the chart engine tests were written against). A Durian import of either is resolved from
 * this package instead of from Durian's own `node_modules`. Vite's `resolve.dedupe` cannot do this: it resolves from
 * the app's root, which declares neither library.
 *
 * `three` (the 3D scene), `marked`, `codehike` and `github-slugger` are Durian's alone and resolve from its install.
 * The 3D chunk is lazy because Durian imports it with `import()`; `packages/app/tests/integration/durian-bundle.test.ts` holds
 * the bundle to that. The strict React entry (`durian-hypermedia/react/strict`) is the only one to import: it has no
 * mermaid and no DOMPurify drawing.
 *
 * THE PIN IS A DECISION, NOT A RANGE (owner choice C8): a newer Durian comes in by a PR that reads its CHANGELOG and
 * re-runs the hostile and format fixtures. `DURIAN_PIN` is the record, and the build refuses an installed version
 * that is not the pinned tag's.
 *
 * THE PIN-BUMP CHECKLIST (every item is in the PR that moves `DURIAN_PIN`, `package.json` and `bun.lock` together):
 *   1. read the new tag's CHANGELOG; any API change in the slots and blocks `app/hypermedia/` uses is handled in the same PR;
 *   2. re-run `hypermedia-csp.visual.test.ts` (every format and hostile fixture: 0 violations, 0 Trusted Types errors);
 *   3. READ `scripts/build-css.ts` IN THE NEW TAG: this build runs it, as code, in a child process on every Vite build
 *      (`runStyleBuild`), with `PATH` and no other environment. A new line there that reads the environment, the network or
 *      anything outside the package is a supply-chain change: the PR names it, and the reviewer reads it as code that runs
 *      on every developer machine and CI runner;
 *   4. re-measure `tests/perf/hypermedia-size.test.ts` and say what moved.
 */

/** The reviewed release: tag `v0.5.1` (signed), the commit it points at, and the tag object. MIT. */
const DURIAN_PIN = {
  tag: 'v0.5.1',
  tagObject: '6e8bb8e013cc2e797ae8a3655f02677d5a0135ea',
  commit: '951c81c7d537249073724c83a2266166e12f593b',
} as const;

const PACKAGE = 'durian-hypermedia';
/** The generated stylesheet's import name and its virtual module id. */
const STYLES = `${PACKAGE}/styles.css`;
const STYLES_ID = `\0${STYLES}`;
/** The libraries Durian also depends on that this package already ships: resolved from here, never from Durian's own copy. */
const SHARED = ['chart.js', 'dompurify'];
/** Where a Durian import of a shared library is resolved from: a file of THIS package. */
const OWNER = fileURLToPath(new URL('../package.json', import.meta.url));

interface ResolveContext {
  resolve(source: string, importer?: string, options?: { skipSelf?: boolean }): Promise<{ id: string } | null>;
}

interface Installed {
  readonly root: string;
  readonly exports: Record<string, string | { bun?: string }>;
  readonly version: string;
}

let installed: Installed | undefined;
/** The installed package, read once: its folder (symlinks resolved, as Vite sees importers), exports map and version. */
function installedPackage(): Installed {
  if (installed !== undefined) return installed;
  const root = dirname(createRequire(OWNER).resolve(`${PACKAGE}/package.json`));
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Pick<
    Installed,
    'exports' | 'version'
  >;
  installed = { root, exports: manifest.exports, version: manifest.version };
  return installed;
}

/** `true` for a source file inside the Durian package (an importer Vite resolved to its real path). */
function insideDurian(importer: string | undefined, root: string): boolean {
  return importer !== undefined && importer.startsWith(root + sep);
}

/**
 * What the stylesheet child may see of the build's environment: `PATH` (to find `bun`) and nothing else. The child runs a
 * script that arrives from a git dependency, in every Vite build, in a process that inherits whatever the build was started
 * with (a CI job's tokens, a developer's credentials); it needs none of it, so it is handed none (r12 H8, Opus review of H1).
 */
export const styleBuildEnvironment = (env: NodeJS.ProcessEnv): Record<string, string> =>
  env.PATH === undefined ? {} : { PATH: env.PATH };

/**
 * The stylesheet, built by the package's own script (`prepare` would write it to `dist/styles.css`). The script is
 * TypeScript inside `node_modules`, which Node will not import and Bun will, so it runs in a `bun` child that prints
 * the CSS; nothing is written into the package. The child gets {@link styleBuildEnvironment}, not the build's environment.
 */
export function runStyleBuild(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const script = `import { buildCss } from ${JSON.stringify(join(root, 'scripts/build-css.ts'))}; process.stdout.write(buildCss());`;
  return execFileSync('bun', ['--eval', script], {
    encoding: 'utf8',
    env: styleBuildEnvironment(env),
    maxBuffer: 16 * 1024 * 1024,
  });
}

let styles: string | undefined;
function buildStyles(root: string): string {
  styles ??= runStyleBuild(root);
  return styles;
}

const plugin = {
  name: 'fy-durian-hypermedia',
  // Before Vite's own resolver, which would follow the `import` condition to a `dist/` that does not exist.
  enforce: 'pre' as const,
  buildStart(): void {
    const { version } = installedPackage();
    const wanted = DURIAN_PIN.tag.slice(1);
    if (version !== wanted)
      throw new Error(
        `durian-hypermedia ${version} is installed but ${DURIAN_PIN.tag} (commit ${DURIAN_PIN.commit}) is pinned: ` +
          'move the pin only by a PR that reads its CHANGELOG and re-runs the Durian fixtures (docs/hypermedia.md).',
      );
  },
  async resolveId(this: ResolveContext, source: string, importer?: string): Promise<string | { id: string } | null> {
    if (source === STYLES) return STYLES_ID;
    const { root, exports } = installedPackage();
    if (source === PACKAGE || source.startsWith(`${PACKAGE}/`)) {
      const entry = exports[source === PACKAGE ? '.' : `.${source.slice(PACKAGE.length)}`];
      if (typeof entry !== 'object' || entry.bun === undefined) return null;
      return join(root, entry.bun);
    }
    if (insideDurian(importer, root) && SHARED.some(name => source === name || source.startsWith(`${name}/`)))
      return this.resolve(source, OWNER, { skipSelf: true });
    return null;
  },
  load(id: string): string | null {
    return id === STYLES_ID ? buildStyles(installedPackage().root) : null;
  },
};

/** What the shell's `vite.config.ts` registers (`plugins`), and the pin record the build test reads. */
export const durianBuild = { plugin, pin: DURIAN_PIN } as const;
