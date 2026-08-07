/**
 * Loads the `fy-render` integration fixture by spawning the builder CLI, and is the
 * ONLY thing in the test process that arranges for a compile.
 *
 * WHY A CHILD PROCESS. Both integration files used to call `Bun.build` in their own
 * `beforeAll`. Run together in ONE Bun process — an unisolated/direct combined run —
 * the pair wedged rather than failed, and the operation that never returned was the
 * compile traversing the real component graph. Two reviewers reproduced it
 * independently. Moving every `Bun.build` out of the test runner is the repair; a
 * lock or an in-process cache could not be, because the shell build had already
 * completed when the wedge happened.
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
 * WHAT IS MEMOISED: the whole load, per global. Two files sharing one process — a
 * DIRECT same-process invocation — start ONE child and share its bytes; a focused
 * single-file run still builds its own fresh fixture with no remembered preflight
 * command. The compiler function itself is not cached — it is pure per output
 * directory, which is what makes a per-worker private build safe.
 *
 * THE ISOLATE/PARALLEL BOUNDARY, NOW THE OFFICIAL PATH RATHER THAN A FUTURE ONE.
 * The integration entrypoints run with one isolated worker (`--parallel=1`), which
 * implies `--isolate` — a fresh global per file — so each file builds its OWN fixture
 * into its OWN `mkdtemp` directory. That is safe — no shared writes and no stale
 * inputs — but it is a duplicate COMPILE per file, and deliberately not a claim of
 * cross-file de-duplication. A JavaScript module singleton cannot supply that; doing
 * it properly would need a cross-process coordinator with atomic publish and
 * stale-owner recovery, which nothing here pretends to be. The process-level memo
 * above is what still deduplicates a DIRECT same-process run, where several files DO
 * share one global.
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
const DEFAULT_BUILD_TIMEOUT_MS = 240_000;

let buildTimeoutMs = DEFAULT_BUILD_TIMEOUT_MS;

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
 * NOISE IS TOLERATED; THE MANIFEST IS THE LAST `{`-LINE. A runtime can print
 * warnings the builder does not control, and failing the whole tier because Bun
 * emitted a deprecation notice would be brittle — so leading AND trailing non-JSON
 * lines are skipped, and the last line that looks like a JSON object is taken as the
 * candidate. An earlier version of this comment claimed a warning ahead of the JSON
 * "must fail"; that was never what the code did, and the code is the behaviour worth
 * keeping.
 *
 * THE FAIL-CLOSED GUARANTEE IS NOT LINE DISCIPLINE. It is carried entirely by the
 * checks below: exact keys, the exact `version`, `directory` identical to the one
 * THIS process created, every artifact path `join`-equal to the expected filename
 * directly under it, and every artifact non-empty. Those are what stop a stale
 * fixture, a `public/` artifact, or a sibling directory whose name merely extends
 * ours from ever being served while claiming freshness — never the number of lines
 * on stdout. Weakening any of them (`.at(-1)` → `.at(0)`, or exact equality → a
 * `startsWith` prefix test) would break the guarantee, which is why each has its own
 * planted case in `fy-render-sandbox.security.test.ts`.
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
  /**
   * Shorten the child bound so the timeout path can be proven in a second rather
   * than in four minutes. `null` restores the shipped value.
   */
  useTimeout: (ms: number | null): void => {
    buildTimeoutMs = ms ?? DEFAULT_BUILD_TIMEOUT_MS;
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
     * out here — and the bound has to be a bound on THE WAIT, not merely on the child.
     *
     * A hook timeout kills the test, not the process the test spawned, so a builder
     * that wedged the way the in-process compile used to would be left holding CPU
     * while the tier reported a failure. The first version of this got that half
     * right and the other half wrong: it sent a default SIGTERM and then went on
     * awaiting `Promise.all([stdout, stderr, exited])`. A child that ignores SIGTERM,
     * or that leaves a pipe held open, never settles that aggregate — so the loader
     * would have waited forever, which is exactly the unbounded wait this whole
     * design exists to remove.
     *
     * So the deadline now RACES the aggregate rather than merely firing beside it,
     * and it kills with SIGKILL immediately. No grace period: by the time the bound
     * has expired the child has had the whole budget to finish, there is nothing to
     * flush that anybody reads, and a grace that the surrounding `finally` would
     * cancel a microtask later — which is what an earlier draft of this did — is a
     * comment describing something that never happens. SIGKILL is the only signal a
     * wedged child cannot decline, which is the entire point.
     *
     * `deadline` REJECTS, which is why there is no flag to check afterwards. An
     * earlier draft set a `timedOut` boolean and re-tested it below the race — dead
     * code, because a rejected `deadline` leaves the race by throwing and that branch
     * is never reached. The rejection carries the sentence; a flag would only have
     * been readable if the timeout had resolved, which would have meant not bounding
     * anything.
     *
     * The loser of the race can never leave an unhandled rejection either: the
     * aggregate's own rejection is swallowed by a no-op catch attached BEFORE the
     * race begins.
     */
    let expiry: ReturnType<typeof setTimeout> | undefined;

    const finished = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    // Attached BEFORE the race: whichever branch loses, its rejection is already
    // handled, so a losing pipe read cannot surface as an unhandled rejection.
    finished.catch(() => undefined);

    const deadline = new Promise<never>((_resolve, reject) => {
      expiry = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`the fy-render fixture builder did not finish within ${buildTimeoutMs}ms and was killed`));
      }, buildTimeoutMs);
    });

    try {
      const [stdout, stderr, code] = await Promise.race([finished, deadline]);
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
      if (expiry !== undefined) clearTimeout(expiry);
      // Belt and braces on EVERY exit: if we are leaving by an exception before the
      // child settled, it must not outlive us, and SIGKILL is the only signal that
      // cannot be declined. Killing an already-dead child is a no-op.
      child.kill('SIGKILL');
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
