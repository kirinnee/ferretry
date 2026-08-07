/**
 * Generates the `fy-render` sandbox shell and its two trusted library bundles.
 *
 * Emits three files into `public/`, none of them committed:
 *   - `fy-render-sandbox.html`  the static shell (small, reviewable, hash-pinned)
 *   - `fy-render-mermaid.js`    the Mermaid bundle the PARENT fetches
 *   - `fy-render-lottie.js`     the Lottie light bundle the PARENT fetches
 *
 * HOW LIBRARY CODE REACHES A FRAME THAT MAY NOT FETCH A SUBRESOURCE. The frame's
 * `default-src 'none'` refuses every ordinary subresource, so it cannot carry
 * `<script src>` — a subresource is a request, even to our own origin. That is a
 * narrower claim than "the frame has no network": self-navigation, prerender and
 * WebRTC were all measured egressing from this frame shape, need code running
 * inside it to reach, and are a declared residual in `docs/fy-render.md` gap 2.
 * Instead the parent fetches the one
 * bundle the block actually needs with `credentials: 'omit'` and transfers the
 * bytes over the capability port, and the shell installs them as an inline
 * script.
 *
 * THAT INSTALL PRIMITIVE IS SAFE BECAUSE OF CSP, NOT BECAUSE OF A COMMENT. The
 * shell's `script-src` lists nothing but the SHA-256 of the bootstrap and of
 * these two bundles, computed here at build time. A real-Chromium probe measured
 * the behaviour this depends on inside the opaque frame: a dynamically created
 * inline script whose text matches a pinned hash runs, and the identical
 * primitive with any other text does not. Author bytes therefore cannot become
 * code — not because the shell declines to pass them, but because the browser
 * refuses to run anything whose hash was not fixed at build time.
 *
 * WHY NOT INLINE EVERYTHING INTO THE SHELL. It was built and measured that way
 * first: one 3.5 MB document, which every reader of a Lottie block would have
 * had to download in full to play a 170 KB animation. Splitting the bundles
 * keeps each block's cost proportional, keeps the shell small enough to review
 * by eye, and lets the two vendor files cache independently.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const packageRoot = resolve(import.meta.dir, '..');
const shellDirectory = resolve(packageRoot, 'scripts/fy-render-shell');
const publicDirectory = resolve(packageRoot, 'public');

/** The generated set, so tests and `.gitignore` have one place to agree with. */
export const FY_RENDER_SHELL_ARTIFACTS = {
  lottie: resolve(publicDirectory, 'fy-render-lottie.js'),
  mermaid: resolve(publicDirectory, 'fy-render-mermaid.js'),
  shell: resolve(publicDirectory, 'fy-render-sandbox.html'),
} as const;

interface Bundle {
  readonly name: string;
  readonly text: string;
  readonly hash: string;
}

const sha256 = (text: string): string => `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`;

const build = async (entry: string): Promise<string> => {
  const result = await Bun.build({
    entrypoints: [resolve(shellDirectory, entry)],
    format: 'iife',
    minify: true,
    // No splitting: a chunk on disk would be a subresource somebody has to fetch
    // separately, and the parent transfers exactly one file per library.
    splitting: false,
    target: 'browser',
  });
  if (!result.success) throw new Error(`❌ ${entry} did not build:\n${result.logs.join('\n')}`);
  const [artifact] = result.outputs;
  if (artifact === undefined) throw new Error(`❌ ${entry} produced no output`);
  return await artifact.text();
};

/**
 * The invariants that must survive a dependency bump — each scoped to exactly
 * what was measured, and no wider.
 */
const assertInvariants = (name: string, source: string): void => {
  /**
   * Applies to every bundle. A surviving dynamic import is a chunk the frame
   * would have to fetch at runtime, and the frame is allowed no request at all.
   */
  // Anchored for the same reason the `Function` guard is: a minified bundle can
  // begin with the call, leaving no preceding character for a bare class to match.
  if (/(^|[^.\w$])import\s*\(/.test(source))
    throw new Error(`❌ ${name} still contains a dynamic import; the frame would have to fetch a chunk`);

  /**
   * Scoped to Lottie ON PURPOSE, because only here is the primitive genuinely
   * absent. The light build ships no expression evaluator, so `"x"` strings in
   * an animation are inert data rather than source text.
   *
   * The Mermaid bundle is NOT asserted this way and must not be: it carries four
   * `Function("return this")` global-lookup fallbacks inherited from lodash.
   * In a browser `self` is defined, so the `||` chain short-circuits and they
   * are never evaluated — and the shell's CSP omits `'unsafe-eval'`, so if one
   * ever were reached the browser would refuse it. That is a short-circuit plus
   * a policy, which is a weaker claim than absence, and it is stated as such
   * rather than folded into this assertion.
   */
  if (name === 'lottie') {
    /**
     * ANY DIRECT CALL, not just the `new` form. `Function(src)` without `new`
     * builds exactly the same function and is the spelling this very toolchain
     * emits: the sibling Mermaid bundle contains four bare `Function("return
     * this")` calls and zero `new Function`. A guard that required the keyword
     * would have watched a Lottie bump reintroduce the evaluator in silence.
     * `.constructor(` is refused for the same reason by another name.
     */
    // `(^|…)` matters: a minified bundle can BEGIN with the call, and an
    // unanchored class would then have no character to match against. The
    // build-time self-check below plants exactly that case, which is how this
    // gap was found rather than reasoned about.
    if (/(^|[^.\w$])Function\s*\(/.test(source))
      throw new Error('❌ the Lottie bundle regained the Function constructor — the expression evaluator may be back');
    if (/\.constructor\s*\(/.test(source))
      throw new Error('❌ the Lottie bundle reaches a constructor dynamically, which can rebuild `Function`');
    if (/(^|[^.\w$])eval\s*\(/.test(source)) throw new Error('❌ the Lottie bundle regained `eval`');
    if (/setExpressionsPlugin\s*\(\s*[A-Za-z_$]/.test(source))
      throw new Error('❌ something registered a Lottie expression plugin');
  }
};

/**
 * `</script` inside the bootstrap would close the element early. Breaking it
 * with a backslash is inert in JavaScript — the sequence only ever occurs inside
 * a string or regex literal, where `<\/script` means the same thing — and the
 * hash is taken AFTER this substitution because the HTML parser does not undo
 * it: the script element's text really does contain the backslash.
 */
const escapeForInlineScript = (source: string): string => source.replace(/<\/(script)/gi, '<\\/$1');

/**
 * The policy the shell enforces on itself.
 *
 * `default-src 'none'` denies ORDINARY SUBRESOURCES: fetch, XHR, websocket,
 * worker, nested frame, font, media, remote images. Each addition below is the
 * minimum one library needs.
 *
 * It does NOT make the document incapable of reaching the network. Prior
 * measurement (`self-navigation-result.md`, `sandbox-security-verdict.md`) shows
 * self-navigation, `<link rel=prerender>` and WebRTC STUN/TURN all egress from
 * this exact frame shape under this exact policy, and Chromium does not
 * recognise `webrtc 'block'`. Those channels are reachable only from trusted
 * library code — no author code runs here — but the honest claim is "ordinary
 * subresources are denied", never "there is nothing to navigate to".
 *
 * `script-src` lists only build-time hashes. There is no `'self'`, no
 * `'unsafe-inline'` and no `'unsafe-eval'`, so the set of code this document can
 * ever run is closed at build time.
 *
 * `style-src 'unsafe-inline'` is required: Mermaid emits a `<style>` element
 * inside the diagram it draws. CSS derived from author data is bounded by there
 * being nowhere for it to reach — `default-src 'none'` refuses every `url()` a
 * stylesheet could name.
 *
 * `img-src data:` lets a Lottie animation carry its own embedded raster assets
 * while still refusing every remote one.
 */
const contentSecurityPolicy = (hashes: readonly string[]): string =>
  [
    "default-src 'none'",
    `script-src ${hashes.map(hash => `'${hash}'`).join(' ')}`,
    "style-src 'unsafe-inline'",
    'img-src data:',
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

const shellDocument = (bootstrap: Bundle, libraries: readonly Bundle[]): string => {
  const policy = contentSecurityPolicy([bootstrap.hash, ...libraries.map(library => library.hash)]);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${policy}" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>fy-render sandbox</title>
    <style>
      html,
      body {
        margin: 0;
        padding: 0;
        background: transparent;
        overflow: hidden;
      }
      #fy-render-stage {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100vw;
        height: 100vh;
      }
      #fy-render-stage > svg {
        max-width: 100%;
        max-height: 100%;
      }
    </style>
  </head>
  <body>
    <div id="fy-render-stage"></div>
    <script>${bootstrap.text}</script>
  </body>
</html>
`;
};

interface BuiltShell {
  readonly shell: string;
  readonly bundles: readonly Bundle[];
}

/**
 * ONE BUILD PER PROCESS, and this is a correctness fix for the test tiers rather
 * than a speed tweak.
 *
 * Two integration files call this in `beforeAll` so that each measures a FRESHLY
 * BUILT shell rather than whatever artifact happened to be on disk. Run
 * separately that is right and cheap. Run the way the repository actually runs
 * them — `scripts/ci/test.sh int` discovers every integration file in ONE Bun
 * process — it meant bundling Mermaid twice, writing the same three artifacts
 * twice, and doing it while a Chromium instance was live. Measured: the pair
 * timed out at 60 s inside a real Mermaid compile that takes about a second on
 * its own, so the tier hung rather than failed.
 *
 * CACHING IS SOUND HERE, not a staleness risk, and the reason is worth stating:
 * the inputs are source files, a process cannot edit its own source tree
 * mid-run, and the builder is deterministic — the second call was guaranteed to
 * produce byte-identical output, which is exactly what makes it safe to skip.
 * Every caller still gets the same freshly-built bytes and the artifacts are
 * still written; only the duplicate work is gone.
 *
 * A FAILED BUILD IS NOT REMEMBERED. Caching a rejection would turn one transient
 * failure into a permanently broken process, so the slot is cleared and the
 * caller still sees the rejection.
 */
let built: Promise<BuiltShell> | null = null;

export const buildFyRenderShell = (): Promise<BuiltShell> => {
  if (built !== null) return built;
  const pending = buildFyRenderShellOnce();
  built = pending;
  pending.catch(() => {
    if (built === pending) built = null;
  });
  return pending;
};

const buildFyRenderShellOnce = async (): Promise<BuiltShell> => {
  const bundleFor = async (name: string, entry: string): Promise<Bundle> => {
    const source = await build(entry);
    assertInvariants(name, source);
    return { hash: sha256(source), name, text: source };
  };

  const mermaid = await bundleFor('mermaid', 'mermaid-entry.ts');
  const lottie = await bundleFor('lottie', 'lottie-entry.ts');

  const bootstrapSource = escapeForInlineScript(await build('bootstrap.ts'));
  assertInvariants('bootstrap', bootstrapSource);
  const bootstrap: Bundle = { hash: sha256(bootstrapSource), name: 'bootstrap', text: bootstrapSource };

  const shell = shellDocument(bootstrap, [mermaid, lottie]);
  assertShellContract(shell, [bootstrap, mermaid, lottie]);

  await mkdir(publicDirectory, { recursive: true });
  await writeFile(FY_RENDER_SHELL_ARTIFACTS.mermaid, mermaid.text, 'utf8');
  await writeFile(FY_RENDER_SHELL_ARTIFACTS.lottie, lottie.text, 'utf8');
  await writeFile(FY_RENDER_SHELL_ARTIFACTS.shell, shell, 'utf8');

  return { bundles: [bootstrap, mermaid, lottie], shell };
};

/**
 * The generated document has to be checked by SOMETHING, and it cannot be an
 * ordinary unit test: importing this module from `tests/unit` would put a
 * `scripts/` file into the unit coverage ledger, which is disjoint from
 * `src/lib` and would fail the gate. So the contract is enforced here, in the
 * build path every deploy runs, where a violation stops the build instead of
 * turning into a fake green somewhere else.
 */
const assertShellContract = (shell: string, bundles: readonly Bundle[]): void => {
  const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/u.exec(shell)?.[1];
  if (policy === undefined) throw new Error('❌ the shell carries no Content-Security-Policy meta tag');
  const scriptSrc = /script-src ([^;]+)/u.exec(policy)?.[1];
  if (scriptSrc === undefined) throw new Error('❌ the shell policy declares no script-src');

  // The bytes that were hashed must be the bytes that ship.
  for (const bundle of bundles) {
    const digest = createHash('sha256').update(bundle.text, 'utf8').digest('base64');
    if (!scriptSrc.includes(`'sha256-${digest}'`))
      throw new Error(`❌ ${bundle.name}'s hash is not pinned in the shell's script-src`);
  }

  if (!policy.includes("default-src 'none'")) throw new Error("❌ the shell policy lost `default-src 'none'`");
  for (const forbidden of ["'unsafe-inline'", "'unsafe-eval'", "'self'", 'http:', 'https:'])
    if (scriptSrc.includes(forbidden))
      throw new Error(`❌ the shell's script-src gained ${forbidden}; only build-time hashes may appear`);

  // A subresource of any kind would be a request, and the frame may issue none.
  if (/<script[^>]+src=/iu.test(shell)) throw new Error('❌ the shell carries an external script source');
  if (/<link[^>]/iu.test(shell) || /\bhref=/iu.test(shell))
    throw new Error('❌ the shell carries a linked resource the frame would have to fetch');
};

/**
 * Proves the Lottie invariant would actually FIRE, using planted sources rather
 * than trusting a regex by reading it. A guard that has never refused anything
 * is a guard nobody has tested — and the previous spelling of this one, which
 * required the `new` keyword, would have let the bare call form straight past.
 */
const assertGuardsBite = (): void => {
  // The every-bundle invariant, planted at position zero where an unanchored
  // pattern would have missed it.
  for (const planted of ['import("./chunk.js")', 'var a = import("./chunk.js");']) {
    let threw = false;
    try {
      assertInvariants('mermaid', planted);
    } catch {
      threw = true;
    }
    if (!threw) throw new Error(`❌ the dynamic-import invariant did not fire on: ${planted}`);
  }

  const mustThrow = [
    'var a = Function("return 1");',
    'var a = new Function("return 1");',
    'Function("x")',
    'var a = eval("1");',
    'var a = ({}).constructor("x");',
    'setExpressionsPlugin(Expressions);',
  ];
  for (const planted of mustThrow) {
    let threw = false;
    try {
      assertInvariants('lottie', planted);
    } catch {
      threw = true;
    }
    if (!threw) throw new Error(`❌ the Lottie invariant did not fire on planted source: ${planted}`);
  }
  /**
   * And it must not fire on ordinary code, or it would block every build.
   *
   * Property ACCESS is fine; it is the call that builds a function. Note the
   * guard is deliberately conservative about one case it cannot distinguish: a
   * literal `Function(` inside a string would also trip it. That is the right
   * way round for a build-time invariant — a false stop is a five-minute
   * conversation, a false pass is an expression evaluator nobody noticed.
   */
  assertInvariants('lottie', 'var f = obj.Function; var g = x.eval; var h = a.constructor;');
};

if (import.meta.main) {
  assertGuardsBite();
  const { shell, bundles } = await buildFyRenderShell();
  const kib = (text: string): string => `${(text.length / 1024).toFixed(0)} KiB`;
  for (const bundle of bundles)
    console.log(`   ${bundle.name.padEnd(9)} ${kib(bundle.text).padStart(9)}  ${bundle.hash}`);
  console.log(`✅ fy-render sandbox shell written (${kib(shell)})`);
}
