/**
 * Loads the `fy-render` integration fixture by spawning the builder CLI, and is the
 * ONLY thing in the test process that arranges for a compile.
 *
 * WHY A CHILD PROCESS. Both integration files used to call `Bun.build` in their own
 * `beforeAll`. Run the way `scripts/ci/test.sh int` runs them — every integration
 * file in ONE Bun process — the pair wedged rather than failed, and the operation
 * that never returned was the compile traversing the real component graph. Two
 * reviewers reproduced it independently. Moving every `Bun.build` out of the test
 * runner is the repair; a lock or an in-process cache could not be, because the
 * shell build had already completed when the wedge happened.
 *
 * WHAT IT RETURNS: BYTES, NOT PATHS, and that is what makes cleanup deterministic.
 * Both files only ever wanted strings — they load each artifact into memory during
 * setup and serve it from there. So the loader reads everything, then removes its
 * private directory in a `finally` before it resolves or rejects. Nothing survives
 * the build: no refcount, no "last holder out", no release API, and no reliance on a
 * process hook.
 *
 * That last point is measured, not assumed. NEITHER `process.on('exit')` NOR
 * `process.on('beforeExit')` fires under the Bun test runner — probed directly — so
 * an exit-time sweep is a cleanup that reads as done and never runs. It was written
 * that way first, and three `ferretry-fy-render-*` directories were found left in
 * `/tmp` across three runs. A `finally` inside the operation that created the
 * directory is the only seam that always runs, including on failure.
 *
 * WHAT IS MEMOISED: the whole load, per test process. Two files in one process start
 * ONE child and share its bytes; a focused single-file run still builds its own fresh
 * fixture with no remembered preflight command. The compiler function itself is not
 * cached — it is pure per output directory, which is what makes a per-worker private
 * build safe.
 *
 * THE ISOLATE/PARALLEL BOUNDARY, STATED RATHER THAN IMPLIED. This memo is per test
 * process. Under a future `--isolate` or `--parallel`, each worker has its own module
 * registry, so each worker builds its OWN fixture into its OWN `mkdtemp` directory.
 * That is safe — no shared writes and no stale inputs — but it is a duplicate COMPILE
 * per worker, and deliberately not a claim of cross-worker de-duplication. A
 * JavaScript module singleton cannot supply that; doing it properly would need a
 * cross-process coordinator with atomic publish and stale-owner recovery, which
 * nothing here pretends to be.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const packageRoot = resolve(import.meta.dir, '../../..');
const builder = resolve(packageRoot, 'scripts/build-fy-render-integration-fixture.ts');

/**
 * Generous, because it bounds a real Mermaid bundle on a loaded shared machine — but
 * finite, because the failure this whole design removes was an unbounded wait. A
 * wedge must be a loud failure with a reaped child, never a consumed job timeout.
 */
const BUILD_TIMEOUT_MS = 240_000;

/**
 * The exact filename each artifact must have, directly under the private directory.
 *
 * Naming them is what makes this a CONTRACT rather than a shape test: a manifest
 * pointing `shell` at a path outside the directory this process just created — a
 * stale fixture, a `public/` artifact, anything a co-tenant wrote — would otherwise
 * be accepted, and the tier's whole freshness claim rests on that being impossible.
 */
const EXPECTED_FILENAMES = {
  appCss: 'app.css',
  appJs: 'app.js',
  lottie: 'fy-render-lottie.js',
  mermaid: 'fy-render-mermaid.js',
  shell: 'fy-render-sandbox.html',
} as const;

type ArtifactKey = keyof typeof EXPECTED_FILENAMES;

const ARTIFACT_KEYS = Object.keys(EXPECTED_FILENAMES) as readonly ArtifactKey[];
/** Every key the manifest may carry — no more and no fewer. */
const MANIFEST_KEYS = ['version', 'directory', ...ARTIFACT_KEYS].sort();

/** The artifacts, as the strings both integration files actually serve. */
export type FyRenderFixtureBytes = Readonly<Record<ArtifactKey, string>>;

/**
 * Parses and VALIDATES, rather than casts.
 *
 * The child's stdout is input like any other. A builder that half-failed, a Bun
 * warning printed ahead of the JSON, a stale loader reading a newer manifest shape,
 * or a path pointing anywhere but the directory this process created must all fail
 * here with a sentence naming the problem — never surface later as a server serving
 * `undefined` or, worse, serving somebody else's bytes while claiming freshness.
 */
const parseManifest = (stdout: string, expectedDirectory: string): Readonly<Record<ArtifactKey, string>> => {
  const line = stdout
    .split('\n')
    .map(text => text.trim())
    .filter(text => text.startsWith('{'))
    .at(-1);
  if (line === undefined) throw new Error(`the fixture builder printed no manifest:\n${stdout}`);

  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`the fixture builder printed unparseable JSON:\n${line}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('the fixture manifest is not an object');

  const manifest = value as Record<string, unknown>;

  // EXACT KEYS. An extra key means the two sides disagree about the contract, and
  // guessing which of them is right is how a fixture starts serving something nobody
  // asked for.
  const present = Object.keys(manifest).sort();
  if (present.length !== MANIFEST_KEYS.length || present.some((key, index) => key !== MANIFEST_KEYS[index]))
    throw new Error(`the fixture manifest keys are ${present.join(',')}; expected ${MANIFEST_KEYS.join(',')}`);
  if (manifest.version !== 1) throw new Error(`unexpected fixture manifest version: ${String(manifest.version)}`);

  // The directory must be the one THIS process created, not merely a directory.
  if (manifest.directory !== expectedDirectory)
    throw new Error(`the fixture manifest names ${String(manifest.directory)}, not ${expectedDirectory}`);

  const paths: Record<string, string> = {};
  for (const key of ARTIFACT_KEYS) {
    const path = manifest[key];
    if (typeof path !== 'string' || path.length === 0) throw new Error(`the fixture manifest has no ${key} path`);
    if (!isAbsolute(path)) throw new Error(`the fixture manifest's ${key} path is not absolute: ${path}`);
    // Directly under the private directory, with the expected name. `join` rather
    // than a `startsWith` prefix test, so `…-abc-evil` cannot pass for `…-abc`.
    const expected = join(expectedDirectory, EXPECTED_FILENAMES[key]);
    if (path !== expected) throw new Error(`the fixture manifest's ${key} path is ${path}; expected ${expected}`);
    paths[key] = path;
  }
  return paths as Readonly<Record<ArtifactKey, string>>;
};

let pending: Promise<FyRenderFixtureBytes> | null = null;

/**
 * THE TEST SEAM, and it is small on purpose.
 *
 * The failure path needs a planted test: "a failed build removes its own unique
 * directory and does not poison a later call" is behaviour, and a comment asserting
 * it is not evidence. Testing it needs three things a test cannot otherwise reach —
 * a builder that fails, the exact directory an invocation created (a global `/tmp`
 * scan would false-fail under `--parallel`, where another worker legitimately creates
 * its own), and the ability to exercise the MEMOISED entry point while putting the
 * shared success back afterwards, so the planted test costs the rest of the run
 * nothing.
 *
 * Nothing in production reads any of it.
 */
export const fyRenderFixtureTestSeam = {
  /** The directory the most recent build created, failed or not. */
  lastDirectory: (): string | null => lastDirectory,
  /** Put a captured memo back, so a planted failure costs no extra real build. */
  restoreMemo: (memo: Promise<FyRenderFixtureBytes> | null): void => {
    pending = memo;
  },
  /** Point the next build at a different builder. `null` restores the real one. */
  useBuilder: (path: string | null): void => {
    builderOverride = path;
  },
  /** Take the memo away and return it, so the next call really builds. */
  takeMemo: (): Promise<FyRenderFixtureBytes> | null => {
    const memo = pending;
    pending = null;
    return memo;
  },
};

let builderOverride: string | null = null;
let lastDirectory: string | null = null;

const buildFyRenderFixtureOnce = async (): Promise<FyRenderFixtureBytes> => {
  // `tmpdir()` and `mkdtemp` rather than a repository path: nothing generated belongs
  // in the tree, and a unique directory is what makes concurrent builders unable to
  // write the same file.
  const directory = await mkdtemp(join(tmpdir(), 'ferretry-fy-render-'));
  lastDirectory = directory;
  try {
    // `process.execPath` is THIS Bun, so the child cannot be a different runtime from
    // the one running the tests.
    const child = Bun.spawn([process.execPath, builderOverride ?? builder, '--out', directory], {
      cwd: packageRoot,
      stderr: 'pipe',
      stdout: 'pipe',
    });

    /**
     * THE CHILD IS BOUNDED AND REAPED, which is half the point of moving the compile
     * out here. A hook timeout kills the test, not the process the test spawned — so
     * a builder that wedged the way the in-process compile used to would be left
     * holding CPU while the tier reported a failure. This races the exit against a
     * bound and kills the child either way, so a wedge becomes a loud, attributable
     * failure with nothing lingering.
     */
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, BUILD_TIMEOUT_MS);

    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (timedOut)
        throw new Error(
          `the fy-render fixture builder did not finish within ${BUILD_TIMEOUT_MS}ms and was killed\n--- stderr ---\n${stderr}`,
        );
      if (code !== 0)
        throw new Error(
          `the fy-render fixture builder exited ${code}\n--- stderr ---\n${stderr}\n--- stdout ---\n${stdout}`,
        );

      const paths = parseManifest(stdout, directory);
      const entries = await Promise.all(
        ARTIFACT_KEYS.map(async key => {
          const text = await Bun.file(paths[key]).text();
          // Non-empty is the last check. The builder writes its manifest last, so
          // this should never fire — which is exactly why it is cheap insurance
          // against a future builder that reorders its writes.
          if (text.length === 0) throw new Error(`the fixture builder produced an empty ${key} at ${paths[key]}`);
          return [key, text] as const;
        }),
      );
      return Object.fromEntries(entries) as FyRenderFixtureBytes;
    } finally {
      clearTimeout(timer);
      // Belt and braces: if we are leaving by an exception before `exited` resolved,
      // the child must not outlive us.
      child.kill();
    }
  } finally {
    /**
     * THE DIRECTORY GOES HERE, on every path including failure. This is the seam that
     * always runs, which no process hook in this runtime does. By the time control
     * reaches it the bytes are in memory (or the build failed and there are none), so
     * there is nothing left to read.
     */
    await rm(directory, { force: true, recursive: true });
  }
};

/**
 * The fixture for this test process. Both integration files await this in `beforeAll`
 * and serve the strings it returns.
 */
export const fyRenderIntegrationFixture = (): Promise<FyRenderFixtureBytes> => {
  if (pending !== null) return pending;
  const started = buildFyRenderFixtureOnce();
  pending = started;
  // A rejection is not remembered: one transient child failure must not turn the rest
  // of the process into a permanently broken run, and the directory is already gone
  // by the time anybody sees the error. The caller still sees it.
  started.catch(() => {
    if (pending === started) pending = null;
  });
  return started;
};
