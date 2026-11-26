import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lazyRegistry } from './vite-durian-lazy.ts';

/**
 * WHAT THE APP SHELL'S VITE CONFIG NEEDS TO BUILD `durian-markdown` — the hypermedia renderer's package — the way
 * `vite-voice.ts` serves Voice: the shell registers {@link durianBuild}'s plugin and owns nothing else about it.
 *
 * THE PACKAGE ARRIVES AS SOURCE. It is a git dependency pinned to a tag's commit (`package.json`, `bun.lock`), its
 * `dist/` is made by a `prepare` script, and the install runs `--ignore-scripts` (`nix/ferretry.nix`), so there is no
 * `dist/`. The plugin therefore resolves every `durian-markdown` import to the file its `exports` map names under
 * the `bun` condition (its own TypeScript source), reading that map, never a copy of it; and it builds the stylesheet
 * (`durian-markdown/styles.css`) from the package's own `scripts/build-css.ts`, the script its `prepare` would have
 * run. The `bun` condition is applied to this ONE package: a global `resolve.conditions` entry would also change which
 * build of every other dependency the bundle picks.
 *
 * ONE COPY OF EVERY LIBRARY WE ALREADY SHIP. Durian pins `chart.js` and `dompurify` at versions of its own
 * (4.5.1, 3.4.18); the bundle holds exactly one of each, OURS (the versions `package.json` here pins, the ones the
 * Trusted Types audit and the chart engine tests were written against). A Durian import of either is resolved from
 * this package instead of from Durian's own `node_modules`. Vite's `resolve.dedupe` cannot do this: it resolves from
 * the app's root, which declares neither library.
 *
 * `three` (the 3D scene), `codehike`, `github-slugger` and the libraries its vendored markdown-it imports (`entities`,
 * `linkify-it`, `mdurl`, `punycode.js`, `uc.micro`) are Durian's alone and resolve from its install (`marked` is gone since 0.6.2).
 * The 3D chunk is lazy because Durian imports it with `import()`; `packages/app/tests/integration/durian-bundle.test.ts` holds
 * the bundle to that. EACH PART IS IMPORTED FROM ITS OWN ENTRY (`react/codewalk`, `react/terminal`, `react/document`, ...), never from
 * `react/strict`: that one lists all 31 folder parts and the animation, and a bundler cannot drop what an array names (+550 KB first
 * load, 950 KB of lazy chunks: pdf.js, lottie, cytoscape, three, chart.js). `strict` is imported for types only
 * (`tests/unit/app/hypermedia/durian-entries.test.ts`). Since 0.7.0 there is no mermaid and no DOMPurify drawing in the package.
 *
 * WHAT THE PARSER AND THE PAGE EACH DROP (`redirectedImport`, stand-ins in `hypermedia/durian-shims/`): the worker parses and never
 * compiles a chart, a scene or a composed stage (all held as code); the page renders and never parses. Without the stand-ins the page
 * carried the whole parser (+400 KB gzip: it takes one function, `inlineText`, from the module that also holds the Markdown reader) and
 * the worker 500 KB of stage compiler it never reaches.
 *
 * THE FOLDER PARTS' PARSERS AND KATEX ARRIVE WHEN A MESSAGE FIRST NEEDS THEM (U1 review, item 2: the cold chat path is the page and the parser worker
 * together). Durian's registry imports all thirty-one parts and KaTeX, which writes a formula's tree at parse time: 333 KB gzip in the worker the first
 * rich message starts, against 110 KB before. `vite-durian-lazy.ts` rewrites that one generated file so each part is a stand-in and a dynamic import,
 * and `katex` is redirected to `durian-shims/katex-late.ts`; the worker fetches what a parse names and parses again (`hypermedia/durian-serve.ts`).
 * The worker's first load is 147.8 KB and the whole cold path 450.3 KB against the merge parent's 409.2 KB (`tests/perf/hypermedia-size.test.ts`).
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
 *   4. re-measure `tests/perf/hypermedia-size.test.ts` (the COLD path: the page and the worker together) and say what moved;
 *   5. `tests/unit/app/hypermedia/lazy-parts.test.ts` holds `durian-shims/lazy-part-shapes.ts` to the registry (a part added, or a part's shape changed,
 *      fails there), and `tests/perf/lazy-worker.test.ts` holds the built worker to Durian's own answers.
 */

/** The reviewed release: tag `v0.7.0` (the package was `durian-hypermedia` until this release), the commit it points at, and the tag object. MIT. */
const DURIAN_PIN = {
  tag: 'v0.7.0',
  tagObject: '3a4d516fffbfc1ec0faed851ef0f59926ee87390',
  commit: 'a246782bb59ab48ad629345f987930fb84a10e8b',
} as const;

const PACKAGE = 'durian-markdown';
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
const TEXT_WIDTH = fileURLToPath(new URL('./hypermedia/durian-shims/text-width.ts', import.meta.url));
const STAGE_HELD = fileURLToPath(new URL('./hypermedia/durian-shims/stage-held.ts', import.meta.url));
const INLINE_TEXT = fileURLToPath(new URL('./hypermedia/durian-shims/inline-text.ts', import.meta.url));
const KATEX_LATE = fileURLToPath(new URL('./hypermedia/durian-shims/katex-late.ts', import.meta.url));
const LAZY_PART = fileURLToPath(new URL('./hypermedia/durian-shims/lazy-part.ts', import.meta.url));

/**
 * WHICH DURIAN IMPORTS ARE REDIRECTED (r12 H8 fix; `core/chipw.ts` added at 0.6.2): the PARSER's (`core/dh-lib.ts`, `document.ts`), and the one
 * line of the alignment renderer's chip widths that reaches the compiler for `textW` (`text-width.ts`).
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
  const core = join(src, 'core') + sep;
  // The parser's chart reader and the expression engine under it. Since 0.7.0 five modules of `core/` import them (`dh-lib`, `chart11`,
  // `pagecharts`, `doccheck`, `chart-llm` itself), so the rule is the importer's folder, not a list of files.
  if (importer.startsWith(core) && (source === './chart' || source === './chart-llm' || source === './chart11'))
    return CHART_HELD;
  // The scene compiler, imported by the parser (`dh-lib`, `document`) and by the diagram parts' compiler (`diagram`). The files of the
  // animation's own engine (`whole`, `readable`, ...) import it too and keep the real one: they are in the animation's chunk, if anywhere.
  if (importer === join(core, 'dh-lib.ts') || importer === join(core, 'diagram.ts')) {
    if (source === './scene') return SCENE_LATE;
  }
  if (importer === join(src, 'document.ts') && source === './core/scene') return SCENE_LATE;
  // The composed-stage compiler (an animation's lanes, cards and time block): ~500 KB of source, never reached (`stage-held.ts`).
  if (importer === join(src, 'document.ts') && (source === './core/stage' || source === './core/stage-part'))
    return STAGE_HELD;
  if ((importer === join(core, 'dh-lib.ts') || importer === join(core, 'doccheck.ts')) && source === './stage-part')
    return STAGE_HELD;
  // Since 0.6.0 the alignment grid's chip widths (`core/chipw.ts`) import the compiler for ONE function, `textW`: without this the
  // compiler is in every first load (+81 KB gzip). The stand-in holds that one line, tested equal to Durian's.
  if (importer === join(core, 'chipw.ts') && source === './scene') return TEXT_WIDTH;
  // 0.7.0: the page's Markdown renderer takes one function from the module that also holds the whole parser (`inline-text.ts`).
  if (importer === join(src, 'react/markdown.tsx') && source === '../markdown') return INLINE_TEXT;
  // U1 review, item 2: KaTeX (~77 KB gzip) writes a formula's tree at parse time and arrives when a message first has one (`katex-late.ts`).
  if (importer === join(src, 'parts/math/render.ts') && source === 'katex') return KATEX_LATE;
  return null;
}

/** The generated part registry, whose folder parts the build makes lazy (`vite-durian-lazy.ts`). */
const registryId = (root: string): string => join(root, 'src/parts/generated/registry.ts');

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
  name: 'fy-durian-markdown',
  // Before Vite's own resolver, which would follow the `import` condition to a `dist/` that does not exist.
  enforce: 'pre' as const,
  buildStart(): void {
    const { version } = installedPackage();
    const wanted = DURIAN_PIN.tag.slice(1);
    if (version !== wanted)
      throw new Error(
        `durian-markdown ${version} is installed but ${DURIAN_PIN.tag} (commit ${DURIAN_PIN.commit}) is pinned: ` +
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
    const { root } = installedPackage();
    if (id === registryId(root)) return lazyRegistry(code, LAZY_PART);
    if (id !== sceneCompilerId(root)) return null;
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
