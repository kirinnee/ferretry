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

/**
 * THE STYLESHEET'S OWN IMPORT (`app/hypermedia/dh-styles.ts`, loaded by the Conversation surfaces) HAS A SIDE EFFECT, and this
 * package declares none (`"sideEffects": false`, which the hosted-relay guard `scripts/validate/relay-config.sh` requires of every
 * workspace package a Worker could import). A bare import of a side-effect-free module is dropped, and the app shipped no Durian
 * CSS (r12 H8 review, item 3). The plugin that builds Durian says so for this one module, where the stylesheet is made.
 */
const STYLES_MODULE = /(^|\/)hypermedia\/dh-styles\.ts$/u;

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

/** Our stand-ins for two of Durian's own modules (`hypermedia/durian-shims/`, header there). */
const CHART_HELD = fileURLToPath(new URL('./hypermedia/durian-shims/chart-held.ts', import.meta.url));
const SCENE_LATE = fileURLToPath(new URL('./hypermedia/durian-shims/scene-late.ts', import.meta.url));

/**
 * WHICH DURIAN IMPORTS ARE REDIRECTED (r12 H8 fix): the PARSER's, and only the parser's (`core/dh-lib.ts`, `document.ts`).
 *  - its chart reader and the expression engine under it (`./chart`, `./chart-llm`): H4 holds every chart fence as code, so the
 *    evaluator is never reached and is not shipped either (`chart-held.ts`);
 *  - its scene compiler (`./scene`, `./core/scene`): the real one stays in the 2D animation's lazy chunk, and the parser reaches
 *    it through `scene-late.ts`, which that chunk fills in when it loads. The renderer's own import of the compiler
 *    (`ui/anim.tsx`) is NOT redirected, so the compiler lives in the animation chunk, not in a first load.
 * Matched on the importer's path under Durian's `src/` and on the exact relative specifier, so a Durian release that moves them
 * fails the build test (`tests/perf/hypermedia-size.test.ts`) rather than silently shipping them again.
 */
export function redirectedImport(source: string, importer: string | undefined, root: string): string | null {
  if (importer === undefined) return null;
  const src = join(root, 'src');
  if (importer === join(src, 'core/dh-lib.ts')) {
    if (source === './chart' || source === './chart-llm') return CHART_HELD;
    if (source === './scene') return SCENE_LATE;
  }
  if (importer === join(src, 'document.ts') && source === './core/scene') return SCENE_LATE;
  return null;
}

/** The file of Durian's scene compiler, which registers itself with {@link SCENE_LATE} when it evaluates. */
const sceneCompilerId = (root: string): string => join(root, 'src/core/scene.ts');

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
  async resolveId(
    this: ResolveContext,
    source: string,
    importer?: string,
  ): Promise<string | { id: string; moduleSideEffects?: boolean } | null> {
    if (source === STYLES) return STYLES_ID;
    if (STYLES_MODULE.test(source)) {
      const resolved = await this.resolve(source, importer, { skipSelf: true });
      return resolved === null ? null : { id: resolved.id, moduleSideEffects: true };
    }
    const { root, exports } = installedPackage();
    const redirected = redirectedImport(source, importer, root);
    if (redirected !== null) return redirected;
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
  // The real scene compiler tells the parser's door it has arrived (`scene-late.ts`): appended to the compiler's own module,
  // so it runs exactly when the animation's chunk evaluates it, wherever the bundler puts it.
  transform(code: string, id: string): string | null {
    if (id !== sceneCompilerId(installedPackage().root)) return null;
    return `${code}\nimport { bindScene as __fyBindScene } from ${JSON.stringify(SCENE_LATE)};\n__fyBindScene({ compileScene, sceneLlm, KINDS });\n`;
  },
};

/**
 * WHAT THE DURIAN WORKER ADDS (r12 H11): no DOM. micromark (which reads every message's fences) decodes character references
 * through `decode-named-character-reference`, whose `browser` condition is a build that makes a `<i>` element and reads its text;
 * a worker has no `document`, so that build throws the moment the worker loads. The worker is given the same package's table
 * build (`index.js`), the one the page's own build is already redirected to for Trusted Types
 * (`app/scripts/trusted-types-plugins.ts`, which a plugin may not import). Anything but `index.js` or `index.dom.js` fails the build.
 */
const ENTITY_DECODER = 'decode-named-character-reference';
const workerPlugin = {
  name: 'fy-durian-worker-no-dom',
  enforce: 'pre' as const,
  async resolveId(this: ResolveContext, source: string, importer?: string): Promise<{ id: string } | null> {
    if (source !== ENTITY_DECODER) return null;
    const resolved = await this.resolve(source, importer, { skipSelf: true });
    if (resolved === null) return null;
    const match = /^(.*[\\/]decode-named-character-reference[\\/])index(?:\.dom)?\.js(\?.*)?$/u.exec(resolved.id);
    if (match === null)
      throw new Error(`${ENTITY_DECODER} resolved to ${resolved.id}, not index.js or index.dom.js: re-audit it`);
    return { ...resolved, id: `${match[1]}index.js${match[2] ?? ''}` };
  },
};

/** What the shell's `vite.config.ts` registers (`plugins`, and `workerPlugin` for the Durian worker's own build), and the pin record the build test reads. */
export const durianBuild = { plugin, workerPlugin, pin: DURIAN_PIN } as const;
