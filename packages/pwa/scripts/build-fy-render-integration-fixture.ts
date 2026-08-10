/**
 * Builds everything the `fy-render` integration tier needs, in a CHILD PROCESS,
 * into one private directory.
 *
 * WHY THIS EXISTS AT ALL, and it is a determinism fix rather than tidying. Both
 * integration files used to compile their own inputs inside the Bun test process:
 * the sandbox shell and its two library bundles, the app stylesheet, and — only in
 * the visual file — a scene entry traversing the real `FyRenderBlock` graph. Run
 * the way `scripts/ci/test.sh int` runs them, which is every integration file in
 * ONE Bun process, the pair wedged. Not failed: wedged, which is worse, because a
 * hang consumes the job timeout and produces no diagnostic. Two reviewers
 * reproduced it independently, and the process tree showed a Bun test process
 * asleep in `ep_poll` with no Chromium alive — the last thing to start was the
 * component-graph `Bun.build`, and it never returned.
 *
 * A lock or a cache cannot fix that, because the shell build had already COMPLETED
 * when the wedge happened. The only repair that removes the failure mode is to
 * stop compiling inside the test runner. So this is a CLI, the test loader spawns
 * it with `process.execPath`, and no `Bun.build` runs in the Bun test process any
 * more.
 *
 * WHAT IT GUARANTEES
 *
 *   - **Fresh, never stale.** Every invocation builds from source into the
 *     directory it is handed. It reads neither `public/` nor `dist/`, so no test
 *     can pass against bytes nobody ships.
 *   - **Private, never shared.** Callers pass a unique `mkdtemp` directory. Two
 *     concurrent builders therefore never `writeFile` the same path — the hazard
 *     the security review named, since a non-atomic write lets a reader observe
 *     torn bytes, fail the hash pin, and be told the library did not load.
 *   - **All or nothing.** The manifest is written and printed LAST. A failure
 *     leaves no success manifest behind, so a loader can never proceed on a
 *     half-built fixture.
 *
 * Usage:
 *
 *     bun packages/pwa/scripts/build-fy-render-integration-fixture.ts --out <absolute-dir>
 *
 * On success this prints the manifest as one line of JSON. It is deliberately NOT a
 * promise that stdout contains nothing else: a runtime can emit warnings this script
 * does not control, so the loader skips non-JSON lines and takes the LAST
 * `{`-line as the manifest. The fail-closed guarantee lives in the loader's exact
 * key/version/directory/path checks, never in line discipline — see
 * `tests/integration/support/fy-render-integration-fixture.ts`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { buildFyRenderShell } from './build-fy-render-libs.ts';

const packageRoot = resolve(import.meta.dir, '..');

/**
 * Absolute paths to every artifact, plus the version of the contract.
 *
 * `version` is not ceremony: the loader validates it, so a manifest shape change
 * that a stale loader would misread fails loudly instead of producing a test that
 * serves `undefined`.
 */
export interface FyRenderFixtureManifest {
  readonly version: 1;
  readonly directory: string;
  readonly shell: string;
  readonly mermaid: string;
  readonly lottie: string;
  readonly appCss: string;
  readonly appJs: string;
}

export const FY_RENDER_FIXTURE_MANIFEST_NAME = 'fy-render-fixture.json';

/**
 * The app's whole stylesheet graph, bundled from the entry `main.tsx` imports.
 *
 * NOT read from `dist/`: a test whose fidelity depends on whether somebody ran
 * `bun run build` first is not evidence. Vite's output additionally carries xterm's
 * vendor CSS, which nothing in `fy-render` reads; everything this component does
 * read reaches here through `styles/index.css`'s `@import` graph.
 */
const bundleOne = async (entry: string, label: string): Promise<string> => {
  const result = await Bun.build({ entrypoints: [entry], minify: false, target: 'browser', throw: false });
  if (!result.success) throw new Error(`❌ ${label} did not build:\n${result.logs.join('\n')}`);
  const [artifact] = result.outputs;
  if (artifact === undefined) throw new Error(`❌ ${label} produced no output`);
  return await artifact.text();
};

const outDirectoryFrom = (argv: readonly string[]): string => {
  const at = argv.indexOf('--out');
  const value = at === -1 ? undefined : argv[at + 1];
  if (value === undefined || value.length === 0) throw new Error('❌ --out <absolute-directory> is required');
  // Absolute only. A relative path would resolve against whatever CWD the caller
  // happened to have, which for a child process spawned from a test is not a
  // directory anybody chose.
  if (!isAbsolute(value)) throw new Error(`❌ --out must be absolute, got ${value}`);
  return value;
};

export const buildFyRenderIntegrationFixture = async (directory: string): Promise<FyRenderFixtureManifest> => {
  await mkdir(directory, { recursive: true });

  // The shell and both library bundles, written under the SAME private directory
  // rather than into `public/`.
  const { artifacts } = await buildFyRenderShell(directory);

  const appCss = await bundleOne(resolve(packageRoot, 'src/styles/index.css'), 'the app stylesheet');
  const appJs = await bundleOne(
    resolve(packageRoot, 'tests/integration/fixtures/fy-render-visual-scene.tsx'),
    'the visual scene',
  );

  const appCssPath = resolve(directory, 'app.css');
  const appJsPath = resolve(directory, 'app.js');
  await writeFile(appCssPath, appCss, 'utf8');
  await writeFile(appJsPath, appJs, 'utf8');

  const manifest: FyRenderFixtureManifest = {
    appCss: appCssPath,
    appJs: appJsPath,
    directory,
    lottie: artifacts.lottie,
    mermaid: artifacts.mermaid,
    shell: artifacts.shell,
    version: 1,
  };

  // LAST, and only now. Everything above has succeeded, so the presence of this
  // file is itself the success signal.
  await writeFile(resolve(directory, FY_RENDER_FIXTURE_MANIFEST_NAME), `${JSON.stringify(manifest)}\n`, 'utf8');
  return manifest;
};

if (import.meta.main) {
  const manifest = await buildFyRenderIntegrationFixture(outDirectoryFrom(Bun.argv));
  // One line of JSON on stdout, so the parent can read it without a file race.
  console.log(JSON.stringify(manifest));
}
