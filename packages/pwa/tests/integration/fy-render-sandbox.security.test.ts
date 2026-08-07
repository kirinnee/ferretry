/**
 * The `fy-render` sandbox's security claims, measured in real Chromium.
 *
 * WHY THIS FILE EXISTS AT ALL. Every claim the sandbox makes is a claim about
 * what a BROWSER refuses — a hash-pinned `script-src`, an opaque origin's
 * storage, `default-src 'none'` over `connect-src`. `happy-dom` implements none
 * of that, so a jsdom-shaped test of this feature would pass with every
 * protection removed. Nothing here runs outside a real Chromium process.
 *
 * WHAT COUNTS AS EVIDENCE HERE, and it is deliberately two things at once:
 *
 *   1. THE FRAME SELF-REPORTS. Code running inside the sandbox attempts the
 *      forbidden thing, catches the outcome, and hands the result to the parent
 *      over the capability port. "The parent observed blocked" is a positive
 *      observation; a test that merely watched nothing happen would pass just as
 *      well against a frame that never loaded.
 *   2. A SERVER-SIDE LEDGER CORROBORATES IT. Every request the harness server
 *      receives is recorded with its `Origin` and `Sec-Fetch-Site` headers. A
 *      refusal the frame reports and the ledger contradicts is not a refusal.
 *
 * Neither half is sufficient. The frame's own `fetch` reports `REFUSED` even
 * when the request DID leave — an opaque origin makes every response opaque, so
 * CORS blocks the read whether or not CSP blocked the send. That is measured
 * below, not assumed: under a relaxed policy the frame still reports `REFUSED`
 * while the ledger shows the hit. Only the ledger can tell those apart, which is
 * why `should the ledger catch a request the frame really makes` exists — a zero
 * count from an instrument that never registers anything is not a result.
 *
 * HOW ADVERSARIAL CODE GETS INTO A FRAME THAT ADMITS THREE HASHES. It is
 * admitted, explicitly and per-test: each hostile reporter is hashed and its
 * hash is spliced into a COPY of the real generated shell's `script-src`, then
 * handed to the REAL bootstrap over the port as the `library` bytes. The
 * bootstrap, the handshake, the policy's every other directive and the opaque
 * origin are untouched. This is the strongest available position for an attacker
 * — arbitrary script execution inside the frame, which the shipped build does not
 * permit anyone — and the point is that the protections below hold even there.
 * `should refuse library bytes whose hash was not pinned at build time` is the
 * test that the admission is genuinely needed.
 *
 * THE ARTIFACTS ARE BUILT FRESH IN A CHILD PROCESS, never read from a checkout.
 * `beforeAll` asks the loader, which spawns the real builder into a private
 * `mkdtemp` directory and hands back the bytes; nothing here reads `public/` or
 * `dist/`. A stale shell would otherwise let this file pass against bytes nobody
 * ships. The compile is OUT of this process on purpose: run together with
 * `fy-render-component.visual.test.tsx`, which is how `scripts/ci/test.sh int`
 * runs every integration file, an in-process `Bun.build` wedged the tier.
 *
 * CHROMIUM ONLY, AND THAT IS A STATED LIMIT. Playwright's bundled WebKit is not
 * Safari and is not accepted as evidence for it; the real macOS `safaridriver`
 * proof is a separate gate. Every verdict here is a Chromium verdict.
 */
import { afterAll, beforeAll, describe, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import should from 'should';
import { sharedChromium } from './support/chromium.ts';
import { fyRenderFixtureTestSeam, fyRenderIntegrationFixture } from './support/fy-render-integration-fixture.ts';

const sha256 = (text: string): string => `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`;

/** One recorded request, with the headers that say WHO asked for it. */
interface LedgerHit {
  readonly path: string;
  /** `"null"` — the literal string — for a CORS request from an opaque origin. */
  readonly origin: string | null;
  readonly destination: string | null;
  /** `cross-site` for anything the opaque frame asks for; the parent is same-origin. */
  readonly site: string | null;
}

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let realShell: string;
let mermaidBundle: string;
let lottieBundle: string;

/** Shells are registered per test, so no test can be affected by another's policy. */
const shells = new Map<string, string>();
let shellSequence = 0;
const ledger: LedgerHit[] = [];

/**
 * Registers a shell document and returns the path to serve it from.
 *
 * Each test gets its own URL rather than mutating one shared response, because
 * a single mutable "current shell" would make these tests order-dependent for no
 * benefit — a frame that loaded late would silently read another test's policy.
 */
const publishShell = (html: string): string => {
  shellSequence += 1;
  const path = `/fy-render-sandbox-${shellSequence}.html`;
  shells.set(path, html);
  return path;
};

/** Adds one hash to `script-src`, KEEPING the three the build pinned. */
const admitting = (reporter: string): string => {
  const spliced = realShell.replace('script-src ', `script-src '${sha256(reporter)}' `);
  if (spliced === realShell) throw new Error('the generated shell no longer carries a script-src to splice');
  return spliced;
};

/**
 * Relaxes exactly ONE directive and keeps every hash.
 *
 * The whole policy must NOT be replaced: `script-src` with any hash in it makes
 * `'unsafe-inline'` inert, so a wholesale swap loses the bootstrap's own hash and
 * yields a frame that never announces itself — a control that proves nothing
 * because nothing ran. Changing `default-src` alone keeps the shell working and
 * isolates the directive under test.
 */
const withNetworkAllowed = (html: string): string => {
  const relaxed = html.replace("default-src 'none'", 'default-src *');
  if (relaxed === html) throw new Error("the generated shell no longer carries default-src 'none'");
  return relaxed;
};

interface DriveOptions {
  /** Which registered shell the frame loads. */
  readonly shellPath: string;
  /** Library bytes to hand over the port, or a URL for the PARENT to fetch. */
  readonly library: { readonly bytes: string } | { readonly url: string };
  readonly command: Record<string, unknown>;
  /** Resolve as soon as this many replies have landed. */
  readonly expectReplies?: number;
  /** Hard deadline for the whole exchange. */
  readonly settleAfterMs?: number;
  /** Offer a SECOND port after the handshake, to test one-time adoption. */
  readonly secondHandshake?: { readonly command: Record<string, unknown> };
}

interface DriveResult {
  readonly replies: readonly { readonly kind?: string; readonly svg?: string; readonly message?: string }[];
  /** Replies delivered on a second port the frame was offered. Must stay empty. */
  readonly secondPortReplies: readonly unknown[];
  readonly frameUrl: string | null;
}

/**
 * Drives one frame through the real protocol, in the page, and returns what the
 * parent observed.
 *
 * THE LISTENER IS ATTACHED BEFORE `src` IS SET, and that ordering is the whole
 * reason this helper exists rather than an `<iframe src>` in markup. The shell
 * announces itself during its first script, which beats a listener attached
 * afterwards — measured, every time. `fy-render-sandbox.tsx` takes the same care
 * for the same reason.
 */
const drive = (options: DriveOptions): string => {
  const {
    shellPath,
    library,
    command,
    expectReplies = 1,
    settleAfterMs = 20_000,
    secondHandshake = null,
  } = { secondHandshake: null, ...options };
  const libraryExpression =
    'bytes' in library
      ? JSON.stringify(library.bytes)
      : `await fetch(${JSON.stringify(library.url)}, { credentials: 'omit' }).then(r => r.text())`;
  return `(async () => {
  const library = ${libraryExpression};
  return await new Promise(resolve => {
    const replies = [];
    const secondPortReplies = [];
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.style.cssText = 'width:600px;height:400px;border:0';
    const finish = () => resolve({
      replies,
      secondPortReplies,
      // Read AFTER the exchange: a frame that navigated itself away shows it here.
      frameUrl: (() => { try { return frame.contentWindow === null ? null : 'reachable'; } catch { return 'opaque'; } })(),
    });
    let settled = false;
    const onGlobal = event => {
      if (event.source !== frame.contentWindow) return;
      if (!event.data || event.data.kind !== 'shell-ready') return;
      removeEventListener('message', onGlobal);
      const channel = new MessageChannel();
      channel.port1.onmessage = e => {
        replies.push(e.data);
        if (replies.length >= ${expectReplies} && !settled) { settled = true; setTimeout(finish, 250); }
      };
      frame.contentWindow.postMessage({ kind: 'init' }, '*', [channel.port2]);
      channel.port1.postMessage(Object.assign({}, ${JSON.stringify(command)}, { library }));
      ${
        secondHandshake === null
          ? ''
          : `setTimeout(() => {
        const second = new MessageChannel();
        second.port1.onmessage = e => { secondPortReplies.push(e.data); };
        frame.contentWindow.postMessage({ kind: 'init' }, '*', [second.port2]);
        setTimeout(() => {
          second.port1.postMessage(Object.assign({}, ${JSON.stringify(secondHandshake.command)}, { library }));
          channel.port1.postMessage({ kind: 'set-playing', playing: false });
        }, 250);
      }, 1000);`
      }
    };
    addEventListener('message', onGlobal);
    document.body.appendChild(frame);
    // LAST — see the note above.
    frame.src = ${JSON.stringify(shellPath)};
    setTimeout(finish, ${settleAfterMs});
  });
})()`;
};

/**
 * The report every hostile reporter hands back, smuggled through the one reply
 * the bootstrap will make for a Mermaid command.
 *
 * Reported outcomes are AWAITED rather than observed synchronously. `fetch`
 * rejects on a later turn, an `XMLHttpRequest` may fail through `onerror`, and a
 * `WebSocket` fails after construction returns — a reporter that recorded
 * `'called'` for each would be reporting that it made an attempt, not that the
 * attempt failed.
 */
const reportingLibrary = (body: string): string => `(() => {
  const report = {};
  const note = (key, fn) => { try { report[key] = String(fn()); } catch (e) { report[key] = 'THREW: ' + (e && e.name); } };
  const settle = (key, promise) => promise.then(
    value => { report[key] = 'RESOLVED: ' + value; },
    error => { report[key] = 'REFUSED: ' + (error && error.name); },
  );
  const pending = [];
  ${body}
  globalThis.__fyRenderMermaid = {
    initialize() {},
    render() {
      return Promise.all(pending).then(() => new Promise(done => {
        // One extra turn, so an outcome that arrives on a later task is included.
        setTimeout(() => done({ svg: JSON.stringify(report) }), 300);
      }));
    },
  };
})()`;

/**
 * OUTCOMES, NEVER THE SPELLING OF A REFUSAL — the rule this file now follows.
 *
 * `note()` records `THREW: <name>` when a primitive throws, and an earlier version
 * asserted those names: `SecurityError` ×7, `EvalError` ×3. For a Chromium-only tier
 * that is defensible, but it cannot be shared —
 * `tests/fixtures/fy-render-journey.ts` exists so both engines measure ONE
 * definition, WebKit uses different names, and for storage it may not throw at all.
 * An engine whose protection is STRONGER must not fail these tests.
 *
 * "Did it throw" is not the fix either, because that still asserts a mechanism. Each
 * assertion below therefore names the EFFECT that must be absent: a computed value
 * (`value:`), a seeded sentinel read back (`SEEDED`), the parent's secret, an opened
 * database, an empty request ledger. The raw exception strings stay in the recorded
 * report as evidence and nothing asserts on them.
 */

/** Reads the JSON report a reporting library returned. */
const reportFrom = (result: DriveResult): Record<string, string> => {
  const reply = result.replies.find(item => item.kind === 'mermaid-svg' && item.svg !== undefined);
  if (reply?.svg === undefined)
    throw new Error(`the frame never reported; replies were ${JSON.stringify(result.replies)}`);
  return JSON.parse(reply.svg) as Record<string, string>;
};

/**
 * Hits the FRAME is responsible for.
 *
 * `Sec-Fetch-Site: cross-site` is the discriminator, and it is not a heuristic:
 * the frame's origin is opaque, so relative to this server every request it makes
 * is cross-site, while the parent document and the parent's library fetch are
 * `same-origin` and `none`. Measured against the relaxed-policy control, where
 * the frame's request appears with exactly this header.
 */
const frameHits = (): readonly LedgerHit[] => ledger.filter(hit => hit.site === 'cross-site' || hit.origin === 'null');

/** A page that refuses every request to anywhere but this harness. */
const newIsolatedPage = async (): Promise<{ page: Page; foreign: string[]; downloads: string[] }> => {
  const page = await browser.newPage();
  const foreign: string[] = [];
  const downloads: string[] = [];
  page.on('download', download => downloads.push(download.url()));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === server.url.origin) return await route.continue();
    // A request to any other origin is an escape, and aborting it means the
    // ledger's silence cannot be explained by the request having gone elsewhere.
    foreign.push(url.href);
    return await route.abort();
  });
  await page.goto(`${server.url.origin}/parent`);
  return { downloads, foreign, page };
};

beforeAll(async () => {
  /**
   * FRESHLY BUILT, IN A CHILD PROCESS, INTO A PRIVATE DIRECTORY — and this file
   * neither compiles anything nor reads `public/` or `dist/`.
   *
   * Freshness still matters for the same reason it always did: a stale shell would
   * let this file pass against a policy that no longer ships. What changed is where
   * the compile happens. Running this file together with
   * `fy-render-component.visual.test.tsx` — which is how `scripts/ci/test.sh int`
   * runs them, one Bun process for every integration file — used to WEDGE, and the
   * operation that never returned was a `Bun.build` inside the test runner. The
   * loader spawns the builder instead, so nothing here can hang on a compiler.
   *
   * `packages/pwa/scripts/**` stays in `bunfig.int.toml`'s
   * `coveragePathIgnorePatterns` regardless: the builder is a build-time generator
   * rather than an adapter, and the CLI now runs in a child the Bun coverage
   * instrument never sees at all.
   */
  // THE BROWSER FIRST, before any other setup, so both integration files reach the
  // one memoised launch in the same order. See `support/chromium.ts`: the wedge this
  // tier had was two first-time launches racing, and a single obvious ordering is
  // cheaper to reason about than arguing that a different one is also safe.
  browser = await sharedChromium();

  const fixture = await fyRenderIntegrationFixture();
  realShell = fixture.shell;
  mermaidBundle = fixture.mermaid;
  lottieBundle = fixture.lottie;

  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, self) {
      const url = new URL(request.url);
      ledger.push({
        destination: request.headers.get('sec-fetch-dest'),
        origin: request.headers.get('origin'),
        path: url.pathname + url.search,
        site: request.headers.get('sec-fetch-site'),
      });
      // A real socket, so a refused WebSocket is refused by the POLICY rather
      // than by there being nothing at the other end to accept it. Without a
      // listening endpoint the refusal assertion would pass against a shell with
      // no CSP at all.
      if (
        url.pathname === '/beacon' &&
        request.headers.get('upgrade') === 'websocket' &&
        self.upgrade(request, { data: undefined })
      )
        return undefined as unknown as Response;
      const registered = shells.get(url.pathname);
      if (registered !== undefined)
        return new Response(registered, {
          headers: {
            // What Cloudflare Pages sends for this path: the CONTENT policy
            // travels in the document, and this header carries only the two
            // things a `<meta>` tag cannot express.
            'content-security-policy': "frame-ancestors 'self'; sandbox allow-scripts",
            'content-type': 'text/html; charset=utf-8',
          },
        });
      if (url.pathname === '/fy-render-mermaid.js')
        return new Response(mermaidBundle, { headers: { 'content-type': 'text/javascript; charset=utf-8' } });
      if (url.pathname === '/fy-render-lottie.js')
        return new Response(lottieBundle, { headers: { 'content-type': 'text/javascript; charset=utf-8' } });
      if (url.pathname === '/beacon') return new Response('beaconed', { headers: { 'content-type': 'text/plain' } });
      return new Response('<!doctype html><html lang="en"><body>parent</body></html>', {
        headers: {
          // Present so a cookie read from the frame has something to steal if
          // the opaque origin ever stopped denying one.
          'content-type': 'text/html; charset=utf-8',
          'set-cookie': 'fy_render_probe=parent-secret; Path=/',
        },
      });
    },
    websocket: { message() {}, open() {} },
  });
});

/**
 * THIS FILE'S SERVER GOES; THE BROWSER DOES NOT.
 *
 * The browser belongs to the process, not to this file — see `support/chromium.ts`
 * for what was measured. Closing it here would put the relaunch that wedges the
 * combined run straight back, because hooks are per file and the sibling file may
 * still need it. Isolation is per CONTEXT and every test closes its own.
 */
afterAll(async () => {
  await server?.stop(true);
});

describe('fy-render fixture loader — the failure path', () => {
  test('should remove its own private directory when the build fails, and not remember the rejection', async () => {
    /**
     * Arrange — a builder that cannot run. Pointing at a module that does not exist
     * makes the CHILD exit non-zero for a real reason rather than mocking a failure,
     * and it needs no planted file in the tree.
     *
     * The shared memo is TAKEN and put back at the end, so exercising the memoised
     * entry point here costs the rest of the run no extra real build. The two failing
     * children exit in milliseconds.
     */
    const missing = resolve(import.meta.dir, '../../scripts/no-such-fixture-builder.ts');
    const saved = fyRenderFixtureTestSeam.takeMemo();
    fyRenderFixtureTestSeam.useBuilder(missing);

    try {
      // Act — through the MEMOISED entry point, twice.
      const first = await fyRenderIntegrationFixture().then(
        () => null,
        (error: unknown) => error,
      );
      const firstDirectory = fyRenderFixtureTestSeam.lastDirectory();
      const second = await fyRenderIntegrationFixture().then(
        () => null,
        (error: unknown) => error,
      );
      const secondDirectory = fyRenderFixtureTestSeam.lastDirectory();

      // Assert — both failed loudly, naming the child's exit rather than a generic
      // error, so a wedge or a crash cannot be mistaken for a passing build.
      should(first).be.an.Error();
      should(String(first)).match(/fixture builder exited/u);
      should(second).be.an.Error();

      // Assert — THE REJECTION WAS NOT REMEMBERED. A cached rejected promise would be
      // handed straight back, creating no second directory; a different directory is
      // the observable proof that the memo cleared itself and really rebuilt.
      should(firstDirectory).be.a.String();
      should(secondDirectory).be.a.String();
      should(secondDirectory).not.equal(firstDirectory);

      // Assert — AND EACH EXACT DIRECTORY IS GONE. This is what the `finally` is for:
      // a build that throws has already created its `mkdtemp` directory, and no exit
      // hook can remove it because neither `exit` nor `beforeExit` fires under the Bun
      // test runner. Asserting the two paths this invocation created — never a scan of
      // `/tmp`, which would false-fail under `--parallel` where another worker
      // legitimately creates its own.
      should(existsSync(firstDirectory as string)).be.false();
      should(existsSync(secondDirectory as string)).be.false();
    } finally {
      fyRenderFixtureTestSeam.useBuilder(null);
      fyRenderFixtureTestSeam.restoreMemo(saved);
    }

    // Assert — the loader still works, from the restored memo, so the rest of the run
    // is unaffected by having failed twice here.
    const fixture = await fyRenderIntegrationFixture();
    should(fixture.shell).containEql('Content-Security-Policy');
    should(fixture.mermaid.length).be.above(0);
  }, 300_000);
});

describe('fy-render sandbox — zero-request rendering', () => {
  test('should render a mermaid diagram while the frame requests nothing', async () => {
    // Arrange
    ledger.length = 0;
    const shellPath = publishShell(realShell);
    const { page, foreign } = await newIsolatedPage();

    try {
      // Act — the PARENT fetches the library, exactly as `fy-render-sandbox.tsx` does.
      const result = (await page.evaluate(
        drive({
          command: {
            kind: 'render-mermaid',
            source: 'graph TD; A[Start] --> B{Choice}; B -->|yes| C[Done];',
            theme: 'dark',
          },
          library: { url: '/fy-render-mermaid.js' },
          shellPath,
        }),
      )) as DriveResult;

      // Assert — a compiled diagram came back, so the frame genuinely worked.
      const svg = result.replies.find(reply => reply.kind === 'mermaid-svg')?.svg;
      should(svg).be.a.String();
      should(svg as string).match(/^<svg/);

      // Assert — and it did so having asked this server for nothing. Were this
      // assertion removed, a shell that quietly regained a `<script src>` or a
      // remote font would still look green.
      should(frameHits()).be.empty();
      should(foreign).be.empty();
      should(ledger.map(hit => hit.path).filter(path => path !== '/favicon.ico')).deepEqual([
        '/parent',
        '/fy-render-mermaid.js',
        shellPath,
      ]);
      // The library was fetched by the PARENT — `dest: empty` from a same-origin
      // document — and the shell was loaded as this page's iframe.
      should(ledger.find(hit => hit.path === '/fy-render-mermaid.js')?.site).equal('same-origin');
      should(ledger.find(hit => hit.path === shellPath)?.destination).equal('iframe');
    } finally {
      await page.close();
    }
  });

  test('should render a lottie animation while the frame requests nothing', async () => {
    // Arrange
    ledger.length = 0;
    const shellPath = publishShell(realShell);
    const { page, foreign } = await newIsolatedPage();

    try {
      // Act
      const result = (await page.evaluate(
        drive({
          command: { kind: 'render-lottie', playing: true, source: simpleAnimation },
          library: { url: '/fy-render-lottie.js' },
          shellPath,
        }),
      )) as DriveResult;

      // Assert — `rendered` is the frame saying Lottie loaded and drew a frame.
      const rendered = result.replies.find(reply => reply.kind === 'rendered') as
        | { width: number; height: number }
        | undefined;
      should(rendered).be.an.Object();
      should(rendered?.width).equal(100);
      should(rendered?.height).equal(100);

      // Assert — an animation carries its own assets, so a frame that fetched a
      // remote image or font would show up here. None does.
      should(frameHits()).be.empty();
      should(foreign).be.empty();
      should(ledger.map(hit => hit.path).filter(path => path !== '/favicon.ico')).deepEqual([
        '/parent',
        '/fy-render-lottie.js',
        shellPath,
      ]);
    } finally {
      await page.close();
    }
  });

  test('should catch a request the frame really makes, so a zero count means something', async () => {
    // Arrange — the SAME shell and the SAME reporter as the refusal tests, with
    // one directive relaxed. This is the positive control: an instrument that
    // never registers anything cannot certify an absence.
    ledger.length = 0;
    const reporter = reportingLibrary(`
      pending.push(settle('fetch', fetch('/beacon?probe=control').then(r => 'status ' + r.status)));
      pending.push(settle('noCors', fetch('/beacon?probe=control-nocors', { mode: 'no-cors' }).then(r => 'type ' + r.type)));
    `);
    const shellPath = publishShell(withNetworkAllowed(admitting(reporter)));
    const { page } = await newIsolatedPage();

    try {
      // Act
      const result = (await page.evaluate(
        drive({
          command: { kind: 'render-mermaid', source: 'graph TD; A-->B;', theme: 'dark' },
          library: { bytes: reporter },
          shellPath,
        }),
      )) as DriveResult;
      const report = reportFrom(result);

      // Assert — the ledger saw both requests, attributed to the frame.
      const beacons = frameHits().map(hit => hit.path);
      should(beacons).containEql('/beacon?probe=control');
      should(beacons).containEql('/beacon?probe=control-nocors');

      // Assert — AND the frame's own report is unreliable here, which is the
      // second half of why the ledger is required. A CORS fetch from an opaque
      // origin reports `REFUSED` because the RESPONSE is unreadable, even though
      // the request left the browser and is sitting in the ledger above. Only
      // `no-cors` reports honestly.
      should(report.fetch).startWith('REFUSED');
      should(report.noCors).equal('RESOLVED: type opaque');
    } finally {
      await page.close();
    }
  });
});

describe('fy-render sandbox — CSP hash pinning is the execution gate', () => {
  test('should refuse library bytes whose hash was not pinned at build time', async () => {
    // Arrange — hand-written bytes in the exact position the real bundle occupies.
    // They define the global the bootstrap looks for, so if they RAN the frame
    // would answer with a forged diagram.
    ledger.length = 0;
    const forged = `globalThis.__fyRenderMermaid = {
      initialize() {},
      render() { return Promise.resolve({ svg: '<svg id="FORGED"></svg>' }); },
    };`;
    const shellPath = publishShell(realShell);
    const { page } = await newIsolatedPage();

    try {
      // Act
      const result = (await page.evaluate(
        drive({
          command: { kind: 'render-mermaid', source: 'graph TD; A-->B;', theme: 'dark' },
          library: { bytes: forged },
          shellPath,
        }),
      )) as DriveResult;

      // Assert — the bootstrap proves an install by looking for the global, never
      // by the absence of an exception: appending a script whose hash is not in
      // `script-src` does NOT throw, the browser simply never runs it. So the
      // only honest evidence is that the global never appeared.
      should(result.replies).have.length(1);
      should(result.replies[0]?.kind).equal('error');
      should(result.replies[0]?.message).equal('The Mermaid library did not load.');
      should(JSON.stringify(result.replies)).not.containEql('FORGED');
    } finally {
      await page.close();
    }
  });

  test('should run the real pinned bundle down the identical path', async () => {
    // Arrange — the positive control for the test above. Without it, "the bytes
    // did not run" would be satisfied by a shell whose install primitive is
    // simply broken for everything.
    ledger.length = 0;
    const shellPath = publishShell(realShell);
    const { page } = await newIsolatedPage();

    try {
      // Act — same command, same port, same `install()`; only the bytes differ.
      const result = (await page.evaluate(
        drive({
          command: { kind: 'render-mermaid', source: 'graph TD; A-->B;', theme: 'dark' },
          library: { bytes: mermaidBundle },
          shellPath,
        }),
      )) as DriveResult;

      // Assert
      should(result.replies[0]?.kind).equal('mermaid-svg');
      should(result.replies[0]?.svg as string).match(/^<svg/);
    } finally {
      await page.close();
    }
  });
});

// "cannot fetch a subresource", NOT "cannot reach the network" — the sibling test
// `should still let the frame navigate ITSELF` measures a channel that does reach
// it, and a describe title that overclaimed would be the first thing a reader
// quoted back as the feature's guarantee.
describe('fy-render sandbox — a script inside the frame cannot fetch a subresource', () => {
  test('should refuse fetch, XMLHttpRequest, WebSocket, sendBeacon and remote images', async () => {
    // Arrange — arbitrary script execution inside the frame, which the shipped
    // build grants nobody. Everything below must hold even from there.
    ledger.length = 0;
    const reporter = reportingLibrary(`
      pending.push(settle('fetch', fetch('/beacon?probe=fetch').then(r => 'status ' + r.status)));
      pending.push(settle('fetchNoCors', fetch('/beacon?probe=fetch-nocors', { mode: 'no-cors' }).then(r => 'type ' + r.type)));
      pending.push(settle('xhr', new Promise((res, rej) => {
        try {
          const request = new XMLHttpRequest();
          request.open('GET', '/beacon?probe=xhr');
          request.onload = () => res('status ' + request.status);
          request.onerror = () => rej(new DOMException('onerror', 'NetworkError'));
          request.send();
        } catch (error) { rej(error); }
      })));
      pending.push(settle('websocket', new Promise((res, rej) => {
        try {
          const socket = new WebSocket(location.origin.replace('http', 'ws') + '/beacon');
          socket.onopen = () => res('opened');
          socket.onerror = () => rej(new DOMException('onerror', 'NetworkError'));
          setTimeout(() => rej(new DOMException('never opened', 'TimeoutError')), 1500);
        } catch (error) { rej(error); }
      })));
      pending.push(settle('eventSource', new Promise((res, rej) => {
        try {
          const stream = new EventSource('/beacon?probe=sse');
          stream.onopen = () => res('opened');
          stream.onerror = () => rej(new DOMException('onerror', 'NetworkError'));
          setTimeout(() => rej(new DOMException('never opened', 'TimeoutError')), 1500);
        } catch (error) { rej(error); }
      })));
      pending.push(settle('remoteImage', new Promise((res, rej) => {
        const image = new Image();
        image.onload = () => res('loaded');
        image.onerror = () => rej(new DOMException('onerror', 'NetworkError'));
        image.src = '/beacon?probe=img';
        setTimeout(() => rej(new DOMException('never loaded', 'TimeoutError')), 1500);
      })));
      note('worker', () => { new Worker('/beacon?probe=worker'); return 'constructed'; });
      note('sendBeaconReturned', () => navigator.sendBeacon('/beacon?probe=beacon'));
    `);
    const shellPath = publishShell(admitting(reporter));
    const { page, foreign } = await newIsolatedPage();

    try {
      // Act
      const report = reportFrom(
        (await page.evaluate(
          drive({
            command: { kind: 'render-mermaid', source: 'graph TD; A-->B;', theme: 'dark' },
            library: { bytes: reporter },
            shellPath,
          }),
        )) as DriveResult,
      );

      // Assert — the frame observed each channel refused. `connect-src` is never
      // written in the policy; `default-src 'none'` is what covers all of these.
      should(report.fetch).startWith('REFUSED');
      should(report.fetchNoCors).startWith('REFUSED');
      should(report.xhr).startWith('REFUSED');
      should(report.websocket).startWith('REFUSED');
      should(report.eventSource).startWith('REFUSED');
      // `img-src data:` admits an animation's embedded assets and no remote one.
      should(report.remoteImage).startWith('REFUSED');
      // A dedicated worker never came into existence. THE OUTCOME is that it was not
      // constructed and asked this server for nothing (the empty ledger below) — the
      // exception NAME is recorded as evidence and not asserted, because Chromium's
      // `SecurityError` is not portable and the Safari journey shares this definition.
      should(report.worker).not.equal('constructed');
      // `sendBeacon` RETURNS TRUE and sends nothing. That return value is the
      // reason this test cannot rest on self-reporting: the API is specified to
      // report only that the request was queued, and CSP drops it afterwards.
      should(report.sendBeaconReturned).equal('true');

      // Assert — and the ledger is the proof. `fetchNoCors` in the control test
      // above DID appear here; nothing does now.
      should(frameHits()).be.empty();
      should(ledger.map(hit => hit.path).filter(path => path.startsWith('/beacon'))).be.empty();
      should(foreign).be.empty();
    } finally {
      await page.close();
    }
  });
});

describe('fy-render sandbox — no dynamic code evaluation', () => {
  test('should refuse eval and the Function constructor', async () => {
    // Arrange
    ledger.length = 0;
    // Each probe computes a DISTINCT value, so the assertion can be "that value never
    // appeared" rather than "it failed in a particular way".
    const reporter = reportingLibrary(`
      note('eval', () => 'value:' + eval('1 + 1'));
      note('newFunction', () => 'value:' + new Function('return 2')());
      note('functionCtor', () => 'value:' + Function('return 3')());
      note('timeoutString', () => { setTimeout('globalThis.__evaluated = true', 0); return 'scheduled'; });
    `);
    const shellPath = publishShell(admitting(reporter));
    const { page } = await newIsolatedPage();

    try {
      // Act
      const report = reportFrom(
        (await page.evaluate(
          drive({
            command: { kind: 'render-mermaid', source: 'graph TD; A-->B;', theme: 'dark' },
            library: { bytes: reporter },
            shellPath,
          }),
        )) as DriveResult,
      );

      /**
       * Assert — NOTHING EVALUATED. `'unsafe-eval'` is absent from `script-src`, and
       * the effect that matters is that the computed value never came back: not
       * `2`, not `3`, from any of the three primitives. This is what makes the
       * Mermaid bundle's four inherited `Function("return this")` fallbacks safe if
       * one were ever reached — the policy refuses them even though the bundle still
       * contains them.
       *
       * Stated as an outcome rather than as an exception name (Chromium raises
       * `EvalError`) so an engine that refuses WITHOUT throwing passes too, and so
       * `tests/fixtures/fy-render-journey.ts` can share one definition with Safari.
       * The raw name still travels in the recorded report as evidence.
       */
      should(report.eval).not.startWith('value:');
      should(report.newFunction).not.startWith('value:');
      should(report.functionCtor).not.startWith('value:');
      // A string-bodied `setTimeout` is a third eval path and is refused too. It
      // does not throw at the call site, so the assertion is that the scheduled
      // string never became code.
      should(report.timeoutString).equal('scheduled');
      should(report.__evaluated).be.undefined();
    } finally {
      await page.close();
    }
  });
});

describe('fy-render sandbox — the opaque origin has no storage', () => {
  test('should deny localStorage, sessionStorage, indexedDB, caches and cookies', async () => {
    // Arrange — the parent document sets a cookie, so `document.cookie` has
    // something worth reading if the frame were ever same-origin.
    ledger.length = 0;
    const reporter = reportingLibrary(`
      note('localStorage', () => localStorage.getItem('anything'));
      note('sessionStorage', () => sessionStorage.getItem('anything'));
      note('cookieRead', () => 'cookie=[' + document.cookie + ']');
      // SEEDED SENTINELS, WRITTEN THEN READ BACK. The outcome that matters is that
      // nothing persisted, and reading it back is an observation; inferring it from
      // the way the write failed is not, and would fail on an engine that refuses
      // silently rather than by throwing.
      note('localStorageWrite', () => { localStorage.setItem('fyStolen', 'SEEDED'); return 'assigned'; });
      note('localStorageAfterWrite', () => 'read=[' + localStorage.getItem('fyStolen') + ']');
      note('sessionStorageWrite', () => { sessionStorage.setItem('fyStolen', 'SEEDED'); return 'assigned'; });
      note('sessionStorageAfterWrite', () => 'read=[' + sessionStorage.getItem('fyStolen') + ']');
      note('cookieWrite', () => { document.cookie = 'fyStolen=SEEDED'; return 'assigned'; });
      note('cookieAfterWrite', () => 'cookie=[' + document.cookie + ']');
      note('caches', () => String(caches));
      note('indexedDBFactory', () => String(indexedDB));
      // Resolution, not construction: the request object exists synchronously and
      // success arrives later, so only a settled open proves a database was reachable.
      pending.push(settle('indexedDBOpened', new Promise((res, rej) => {
        try {
          const request = indexedDB.open('exfiltrate');
          request.onsuccess = () => res('OPENED');
          request.onerror = () => rej(new DOMException('onerror', 'NotAllowed'));
          setTimeout(() => rej(new DOMException('never opened', 'TimeoutError')), 1500);
        } catch (error) { rej(error); }
      })));
      note('parentDocument', () => String(parent.document));
      note('parentLocation', () => String(parent.location.href));
      note('origin', () => location.origin);
    `);
    const shellPath = publishShell(admitting(reporter));
    const { page } = await newIsolatedPage();

    try {
      // Act
      const report = reportFrom(
        (await page.evaluate(
          drive({
            command: { kind: 'render-mermaid', source: 'graph TD; A-->B;', theme: 'dark' },
            library: { bytes: reporter },
            shellPath,
          }),
        )) as DriveResult,
      );

      /**
       * Assert — NO PARTITION YIELDED A VALUE, which is what an opaque origin means
       * in practice. `sandbox="allow-scripts"` WITHOUT `allow-same-origin` is the
       * single attribute all of this rests on; adding `allow-same-origin` would turn
       * each of these into a working read.
       *
       * Outcomes rather than exception names: Chromium raises `SecurityError` for
       * every one of these, WebKit need not, and a WebKit that refused WITHOUT
       * throwing would be refusing just as hard. The names are recorded in the
       * report either way — see `refused`.
       */
      // NOTHING WAS SEEDED AND NOTHING READ BACK. `SEEDED` is the sentinel each write
      // tried to store; a jar that refused silently reports `read=[null]` or
      // `cookie=[]` and passes, which is the point — the claim is about state, not
      // about exception names.
      should(report.localStorageAfterWrite ?? '').not.containEql('SEEDED');
      should(report.sessionStorageAfterWrite ?? '').not.containEql('SEEDED');
      should(report.cookieAfterWrite ?? '').not.containEql('SEEDED');

      // NOTHING WAS READ, EITHER. The parent document set `fy_render_probe` so a
      // same-origin frame would have something worth stealing; an opaque one sees
      // nothing, however it says so.
      should(report.localStorage ?? '').not.containEql('SEEDED');
      should(report.sessionStorage ?? '').not.containEql('SEEDED');
      should(report.cookieRead ?? '').not.containEql('parent-secret');

      // NO DATABASE AND NO CACHE BECAME USABLE. `indexedDBOpened` settles only on a
      // real `onsuccess`, so this is resolution rather than construction.
      should(report.indexedDBOpened ?? '').not.containEql('OPENED');
      should(report.caches ?? '').not.containEql('CacheStorage');
      // NOT a SecurityError, and the difference is worth recording: the FACTORY
      // is a live object in an opaque origin and only USING it throws. A test
      // that asserted `indexedDB` was absent would be asserting something false.
      should(report.indexedDBFactory).equal('[object IDBFactory]');

      // Assert — the parent document is unreachable in both directions.
      // NEITHER DIRECTION LEAKED. The outcome is that the parent's URL and DOM never
      // came back — not that reaching for them threw a particular error.
      should(report.parentDocument ?? '').not.containEql('HTMLDocument');
      should(report.parentLocation ?? '').not.containEql('http');

      // The frame's `location.origin` still READS as the server's origin, which
      // is why `event.origin` authenticates nothing here and the protocol checks
      // `event.source` instead. Asserted so a reader does not mistake this string
      // for evidence the frame is same-origin — every check above proves it is not.
      should(report.origin).equal(new URL(server.url.origin).origin);
    } finally {
      await page.close();
    }
  });
});

describe('fy-render sandbox — the frame cannot escape its own box', () => {
  test('should deny top navigation, popups, downloads and nested framing', async () => {
    // Arrange
    ledger.length = 0;
    const reporter = reportingLibrary(`
      note('topLocation', () => { top.location = '/beacon?probe=topnav'; return 'assigned'; });
      note('parentLocationWrite', () => { parent.location = '/beacon?probe=parentnav'; return 'assigned'; });
      note('windowOpen', () => String(window.open('/beacon?probe=open')));
      note('nestedFrame', () => {
        const nested = document.createElement('iframe');
        nested.src = '/beacon?probe=nested';
        document.body.appendChild(nested);
        return 'appended';
      });
      note('nestedSrcdoc', () => {
        const nested = document.createElement('iframe');
        nested.srcdoc = '<script>fetch("/beacon?probe=srcdoc")</' + 'script>';
        document.body.appendChild(nested);
        return 'appended';
      });
      note('download', () => {
        const anchor = document.createElement('a');
        anchor.href = 'data:text/plain,exfiltrated';
        anchor.download = 'exfiltrated.txt';
        document.body.appendChild(anchor);
        anchor.click();
        return 'clicked';
      });
    `);
    const shellPath = publishShell(admitting(reporter));
    const { page, downloads, foreign } = await newIsolatedPage();
    const parentUrl = page.url();

    try {
      // Act
      const report = reportFrom(
        (await page.evaluate(
          drive({
            command: { kind: 'render-mermaid', source: 'graph TD; A-->B;', theme: 'dark' },
            library: { bytes: reporter },
            shellPath,
          }),
        )) as DriveResult,
      );

      // Assert — THE OUTCOME, never the spelling of a refusal.
      //
      // Whether an engine throws on `top.location = …` or accepts the assignment
      // and silently drops the navigation is an implementation detail, and the
      // two differ: Chromium throws a SecurityError here, and a different engine
      // may not. What must hold everywhere is that the top document did not move
      // and the URL was never requested. Asserting the exception name instead
      // would make this test fail on an engine whose protection is stronger, and
      // would be exactly the mistake this file's header warns against.
      should(page.url()).equal(parentUrl);
      should(ledger.map(hit => hit.path).filter(path => path.includes('nav'))).be.empty();

      // Assert — `allow-popups` is absent, so no popup exists. `null` IS the
      // outcome here rather than an error spelling: the return value is what the
      // frame would have had to postMessage through.
      should(report.windowOpen).equal('null');

      // Assert — `default-src 'none'` covers `frame-src`, so a nested frame is
      // refused before it is fetched. Neither a URL child nor a `srcdoc` child
      // loads, and the outcome is the ledger's silence rather than an exception:
      // appending the element is allowed and fetching its content is not.
      should(ledger.map(hit => hit.path).filter(path => path.includes('nested'))).be.empty();
      should(ledger.map(hit => hit.path).filter(path => path.includes('srcdoc'))).be.empty();

      // Assert — no download was offered to the user. `allow-downloads` is
      // absent from the sandbox attribute; were it present, a frame could put a
      // file in someone's Downloads folder from a chat message.
      should(downloads).be.empty();
      should(foreign).be.empty();

      // The reported shapes are recorded rather than asserted, so a future
      // engine that starts or stops throwing changes this line and no verdict.
      // Every claim above is an observation of what did not happen.
      should(report).have.properties(['topLocation', 'parentLocationWrite', 'nestedFrame', 'nestedSrcdoc', 'download']);
    } finally {
      await page.close();
    }
  });

  test('should still let the frame navigate ITSELF, which the zero-request claim excludes', async () => {
    // Arrange — this test records a real limit rather than a protection, and it
    // is here so nobody reads the tests above as saying more than they do.
    //
    // CSP's fetch directives do not govern NAVIGATION. `navigate-to` was never
    // shipped and `default-src 'none'` does not restrain the frame's own
    // `location`, so a script inside the frame CAN put bytes in a URL and load
    // it. That reaches the network and appears in this ledger.
    //
    // Why it is not a live hole: getting there needs script execution inside the
    // frame, which the hash-pinned `script-src` denies — this test only reaches
    // it by admitting an extra hash. The claim "the frame issues zero network
    // requests" is therefore about the code that CAN run there, and this test
    // draws that boundary explicitly instead of leaving it implied.
    ledger.length = 0;
    const navigator = `(() => {
      globalThis.__fyRenderMermaid = {
        initialize() {},
        render() {
          setTimeout(() => { location.href = '/beacon?probe=selfnav'; }, 100);
          return new Promise(done => setTimeout(() => done({ svg: '<svg id="navigating"/>' }), 20));
        },
      };
    })()`;
    const shellPath = publishShell(admitting(navigator));
    const { page } = await newIsolatedPage();
    const parentUrl = page.url();

    try {
      // Act
      await page.evaluate(
        drive({
          command: { kind: 'render-mermaid', source: 'graph TD; A-->B;', theme: 'dark' },
          library: { bytes: navigator },
          settleAfterMs: 3_000,
          shellPath,
        }),
      );

      // Assert — the request DID reach the server, attributed to the frame.
      should(ledger.map(hit => hit.path)).containEql('/beacon?probe=selfnav');

      // Assert — and what it still cannot do is move the top document, so the
      // reader's page is unaffected and nothing same-origin is exposed.
      should(page.url()).equal(parentUrl);
    } finally {
      await page.close();
    }
  });
});

describe('fy-render sandbox — the bridge cannot be forged or suppressed', () => {
  test('should deliver authentic replies after the messaging intrinsics are patched', async () => {
    // Arrange — the frame patches `MessagePort.prototype.postMessage` and
    // `window.postMessage` before replying, which is what a library that wanted
    // to read, drop or forge this frame's traffic would do.
    ledger.length = 0;
    // THE SENTINEL COUNTS AND TAGS RATHER THAN LATCHING, and that is what makes
    // the two claims here compatible instead of contradictory. The
    // effectiveness control below deliberately makes an UNBOUND send, so the
    // replacement MUST fire once; the bridge claim needs the bootstrap's reply
    // never to go through it. A boolean "did it fire" cannot express both. So
    // each interception records WHICH port it came from, and the assertion is
    // that the control's send is the only one.
    const reporter = reportingLibrary(`
      const intercepted = [];
      note('patchPort', () => {
        MessagePort.prototype.postMessage = function (payload) { intercepted.push('port:' + payload); };
        return 'patched';
      });
      note('patchWindow', () => {
        window.postMessage = function (payload) { intercepted.push('window:' + payload); };
        return 'patched';
      });
      // Proves the patch is genuinely effective on any UNBOUND lookup: a fresh
      // channel's send resolves through the replaced prototype and never
      // arrives. Without this, an authentic reply from the frame would be
      // equally well explained by the patch simply not having worked.
      pending.push(new Promise(done => {
        const own = new MessageChannel();
        let delivered = false;
        own.port1.onmessage = () => { delivered = true; };
        own.port2.postMessage('control-probe');
        setTimeout(() => {
          report.ownChannelDelivered = String(delivered);
          report.intercepted = intercepted.join(',');
          done();
        }, 200);
      }));
    `);
    const shellPath = publishShell(admitting(reporter));
    const { page } = await newIsolatedPage();

    try {
      // Act
      const result = (await page.evaluate(
        drive({
          command: { kind: 'render-mermaid', source: 'graph TD; A-->B;', theme: 'dark' },
          library: { bytes: reporter },
          shellPath,
        }),
      )) as DriveResult;
      const report = reportFrom(result);

      // Assert — the patches were installed and they DO intercept an unbound
      // send: the frame's own fresh channel never delivered its message.
      should(report.patchPort).equal('patched');
      should(report.patchWindow).equal('patched');
      should(report.ownChannelDelivered).equal('false');

      // Assert — the replacement saw the control's send AND NOTHING ELSE. This
      // is the bridge-regression lock: the bootstrap binds `port.postMessage` at
      // handshake time, strictly before any `install()` can run, so its reply
      // never resolves through the patched prototype. Were that binding relaxed
      // back to a bare `port.postMessage(…)` lookup — the defect the binding
      // exists to prevent — this list would carry the reply too.
      should(report.intercepted).equal('port:control-probe');

      // Assert — and the parent received the frame's real reply anyway.
      should(result.replies[0]?.kind).equal('mermaid-svg');
    } finally {
      await page.close();
    }
  });

  test('should ignore a second port offered after the handshake', async () => {
    // Arrange — a live Lottie channel, so the first port is still in use when a
    // second is offered. Mermaid would have finished and proved less.
    ledger.length = 0;
    const shellPath = publishShell(realShell);
    const { page } = await newIsolatedPage();

    try {
      // Act — the parent completes the handshake, then offers a fresh
      // MessageChannel exactly as a hostile document would if it could reach
      // this frame, and finally sends `set-playing` on BOTH ports.
      const result = (await page.evaluate(
        drive({
          command: { kind: 'render-lottie', playing: true, source: simpleAnimation },
          expectReplies: 2,
          library: { bytes: lottieBundle },
          secondHandshake: { command: { kind: 'set-playing', playing: true } },
          settleAfterMs: 6_000,
          shellPath,
        }),
      )) as DriveResult;

      // Assert — the first port is still the only channel: it got the `rendered`
      // acknowledgement and the answer to its own `set-playing`.
      should(result.replies.map(reply => reply.kind)).containEql('rendered');
      should(result.replies.map(reply => reply.kind)).containEql('playing');

      // Assert — and the second port received nothing at all. The bootstrap
      // returns early once `port !== null`, so the offer is dropped before its
      // `onmessage` is ever wired. Were that guard removed, any document that
      // got a handle on this frame could take over the channel mid-animation.
      should(result.secondPortReplies).be.empty();
    } finally {
      await page.close();
    }
  });
});

/**
 * WHERE THE RAW-HTML REGRESSION LOCK LIVES, and why it is not in this file.
 *
 * This feature puts an iframe in the transcript, and the failure mode worth
 * guarding against is somebody adding `rehype-raw` to make illustrations easier:
 * that one change would execute a literal `<script>` typed into any chat
 * message. It is a real risk and it is covered — by
 * `tests/unit/markdown.test.tsx`, in `should keep raw HTML in prose inert, which
 * this feature must not change`, which renders the pipeline and asserts no
 * `script` and no `b` element is produced.
 *
 * A real-Chromium version of that assertion was built here and then removed,
 * which is worth recording so nobody rebuilds it. `markdown.tsx` reaches
 * `@ferretry/relay` transitively through `pages/routes.ts` →
 * `daemon-connection.ts`, so proving one property about text escaping meant
 * bundling most of the application and two sibling workspace packages — a
 * ~900 KiB browser build per run, whose resolution of `zod` and
 * `@ferretry/protocol` is not reliable from inside `bun test`. That is a large,
 * slow, flaky apparatus for a property a mounted render already proves, and a
 * flaky test in this tier costs more than this marginal evidence is worth.
 *
 * What real Chromium is genuinely needed for is everything else in this file: a
 * hash-pinned `script-src`, an opaque origin's storage, `default-src 'none'`. No
 * DOM shim can answer those. Escaping is not in that category — remark either
 * produced an element or it produced text, and the unit tier can see which.
 */

/**
 * A minimal, legitimate animation: one circle, no expressions, no external
 * assets. Small on purpose — this file tests the sandbox, not Lottie's feature
 * surface, and `w`/`h` are read back from the `rendered` acknowledgement.
 */
const simpleAnimation = JSON.stringify({
  assets: [],
  ddd: 0,
  fr: 30,
  h: 100,
  ip: 0,
  layers: [
    {
      ao: 0,
      bm: 0,
      ddd: 0,
      ind: 1,
      ip: 0,
      ks: {
        a: { a: 0, k: [0, 0, 0] },
        o: { a: 0, k: 100 },
        p: { a: 0, k: [50, 50, 0] },
        r: { a: 0, k: 0 },
        s: { a: 0, k: [100, 100, 100] },
      },
      nm: 'dot',
      op: 60,
      shapes: [
        {
          it: [
            { p: { a: 0, k: [0, 0] }, s: { a: 0, k: [40, 40] }, ty: 'el' },
            { c: { a: 0, k: [0.2, 0.6, 0.9, 1] }, o: { a: 0, k: 100 }, ty: 'fl' },
            {
              a: { a: 0, k: [0, 0] },
              o: { a: 0, k: 100 },
              p: { a: 0, k: [0, 0] },
              r: { a: 0, k: 0 },
              s: { a: 0, k: [100, 100] },
              ty: 'tr',
            },
          ],
          ty: 'gr',
        },
      ],
      sr: 1,
      st: 0,
      ty: 4,
    },
  ],
  nm: 'simple',
  op: 60,
  v: '5.7.4',
  w: 100,
});
