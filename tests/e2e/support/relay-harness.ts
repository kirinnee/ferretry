/**
 * The four external things a relayed first pairing needs, each a real one.
 *
 * This module owns the pieces `tests/e2e/fixture.ts` has no opinion about — a rendezvous process, an
 * origin serving the REAL built PWA bundle, a direct address that demonstrably refuses, and a real
 * Chrome. The fixture still owns the isolated `HOME`/`FY_HOME`, the dedicated tmux server, the
 * compiled binary and the cleanup contract; nothing here bypasses it.
 *
 * Everything started here is registered on a {@link HarnessTeardown} so a failing assertion, a
 * timeout and an interrupt all release the same processes, sockets, ports and browser.
 *
 * ── WHY AN UNREACHABLE DIRECT ADDRESS IS A COMPONENT ──────────────────────────────────────────
 *
 * The proof is worthless if the browser could have succeeded over loopback. The daemon and Chrome
 * are on one machine here, so "the direct address is unreachable" has to be ARRANGED rather than
 * assumed. {@link startDirectSinkhole} is that arrangement: a real TCP listener on a real loopback
 * port that accepts the connection, counts it, and destroys it without speaking HTTP. That gives
 * two things a firewall rule could not:
 *
 *   - the browser's direct attempt fails at TRANSPORT, which is the only failure the carrier walk
 *     advances on (§13: any HTTP answer stops the walk), and
 *   - the attempt is COUNTED, so the harness can assert the browser really did try direct first
 *     rather than assert the absence of something it never attempted.
 *
 * A closed port would also fail, but it would prove only that nothing answered; a counter proves
 * the browser knocked.
 */

import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer, type Server, type Socket } from 'node:net';
import * as childProcessModule from 'node:child_process';
import { type ChildProcess, spawn, type ChildProcessByStdio } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { Readable } from 'node:stream';
// This stub plays the directory server, so it serves the server-owned public path. A literal here
// would be a second spelling, and the resulting 404 reads as "discovery is switched off".
import { HOSTED_RELAY_PUBLIC_PATH } from '@ferretry/relay/adapters';
import { parseReleaseHeaders, releaseHeadersFor } from '../../../packages/pwa/src/lib/release-headers.ts';
import { parseReleaseRewrites, releasePathForRequest } from '../../../packages/pwa/src/lib/release-manifest.ts';
import { assertNoLiveStatePath } from '../fixture.ts';

export { HOSTED_RELAY_PUBLIC_PATH };

const REPOSITORY_ROOT = resolve(import.meta.dir, '../../..');

/** `public/_redirects`, applied by this server because no Pages runtime is present to apply it. */
const REDIRECTS_FILE = join(REPOSITORY_ROOT, 'packages', 'pwa', 'public', '_redirects');

/**
 * The published site's own `connect-src`, served byte-for-byte from `packages/pwa/public/_headers`.
 *
 * Read rather than copied: a harness that shipped its own permissive policy would prove the app
 * works under a policy nobody deploys, and the loopback allowances this journey depends on are
 * exactly the clauses most likely to be tightened by someone who does not know a test needs them.
 */
const HEADERS_FILE = join(REPOSITORY_ROOT, 'packages', 'pwa', 'public', '_headers');

export interface HarnessTeardown {
  add(label: string, close: () => Promise<void> | void): void;
  closeAll(): Promise<void>;
}

export function harnessTeardown(): HarnessTeardown {
  const entries: { readonly label: string; readonly close: () => Promise<void> | void }[] = [];
  return {
    add: (label, close) => {
      entries.push({ label, close });
    },
    closeAll: async () => {
      const failures: unknown[] = [];
      // Reverse order: the browser must go before the origin it is pointed at, and the daemon
      // before the rendezvous it is dialling, or shutdown produces errors that read as defects.
      for (const entry of entries.reverse()) {
        // Bounded: one close that never settles (a server waiting on a connection a dead peer will never
        // end) hung a whole journey until the test runner's ten-minute timeout, naming nothing. A
        // timeout here names the part instead, and the remaining parts are still released.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.resolve().then(() => entry.close()),
            new Promise<never>((_settle, fail) => {
              timer = setTimeout(() => fail(new Error(`${entry.label} did not close within 10s`)), 10_000);
            }),
          ]);
        } catch (error) {
          failures.push(new Error(`harness teardown failed: ${entry.label}`, { cause: error }));
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }
      entries.length = 0;
      if (failures.length !== 0) throw new AggregateError(failures, 'relay harness teardown failed');
    },
  };
}

// ─── the rendezvous ───────────────────────────────────────────────────────────────────────────

export interface ObservedFrame {
  readonly at: number;
  readonly direction: 'to-rendezvous' | 'from-rendezvous';
  readonly role: 'daemon' | 'client' | 'unknown';
  readonly kind: 'binary' | 'text';
  readonly bytes: number;
  readonly base64: string;
}

export interface RendezvousProcess {
  /** `ws://127.0.0.1:<port>` — a legal relay address only because it is loopback (§13). */
  readonly relayUrl: string;
  readonly httpOrigin: string;
  readonly observationsPath: string;
  /** Install this run's daemon fingerprint; a self-hosted relay serves nobody until one is listed. */
  allow(daemonId: string): Promise<void>;
  /** What the rendezvous is holding right now, by role. The honest "the daemon has claimed it". */
  sockets(): Promise<readonly { readonly rendezvous: string; readonly roles: readonly string[] }[]>;
  /**
   * Every arrival this rendezvous has seen, in order, admitted or refused.
   *
   * Durable rather than a live census: a §14 pairing session closes with `4440` the moment its
   * sealed outcome is sent, so polling for a connected client reports the same emptiness whether
   * the pairing crossed this relay or never happened.
   */
  arrivals(): Promise<readonly { readonly role: 'daemon' | 'client'; readonly daemonId: string }[]>;
  /** The daemon half of {@link arrivals} — how the harness learns this run's fingerprint. */
  dialled(): Promise<readonly string[]>;
  /** Every frame this rendezvous handled, in both directions, in order. */
  observations(): Promise<readonly ObservedFrame[]>;
  /**
   * Kill the rendezvous without ceremony and start it again on the SAME port — a Worker redeploy: every
   * socket on both sides drops at once, the allowlist survives, in-memory sessions do not. `downMs` keeps it
   * down for a while first. Answers when the drop happened and when the new process was accepting.
   */
  /** Everything the rendezvous process has written to stderr, across restarts — its own account of refusals and failures. */
  stderr(): string;
  restart(options?: { readonly downMs?: number }): Promise<{ readonly droppedAt: number; readonly backAt: number }>;
  stop(): Promise<void>;
}

/** `flags` are extra arguments for the process, such as the benchmark-only `--one-way-ms` and `--timing-only`. */
export async function startRendezvous(
  root: string,
  teardown: HarnessTeardown,
  flags: readonly string[] = [],
): Promise<RendezvousProcess> {
  const observationsPath = await assertNoLiveStatePath(join(root, 'rendezvous-frames.jsonl'), 'relay observations');
  await writeFile(observationsPath, '', 'utf8');

  // `scripts/test/` is where this repository keeps executables that are SPAWNED by path rather than
  // imported — `fake-harness.ts`, `fake-daemon.ts`, `bootstrap-only-fyd.ts` — and `knip.json` makes
  // that directory an entry point for exactly that reason. A spawned script under
  // `tests/e2e/support/` (imported modules) has no importer and is correctly reported as dead.
  const script = join(REPOSITORY_ROOT, 'scripts', 'test', 'rendezvous-process.ts');

  let processStderr = '';
  const launch = async (port: number): Promise<RunningRendezvous> => {
    const child = spawn(
      process.execPath,
      [script, '--observations', observationsPath, '--port', String(port), '--allow', [...allowed].join(','), ...flags],
      {
        cwd: REPOSITORY_ROOT,
        // The rendezvous inherits nothing from the isolated home: it is a THIRD PARTY to this journey
        // and giving it `FY_HOME` would let a defect there look like a relay that could read state.
        env: { PATH: process.env.PATH ?? '', NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ) as ChildProcessByStdio<null, Readable, Readable>;
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      stderr += String(chunk);
      processStderr += String(chunk);
    });
    const ready = await new Promise<{ readonly port: number; readonly origin: string }>((settle, fail) => {
      let stdout = '';
      const timer = setTimeout(() => fail(new Error(`rendezvous process never reported ready\n${stderr}`)), 20_000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        stdout += String(chunk);
        const line = stdout.split('\n').find(candidate => candidate.trim().startsWith('{'));
        if (line === undefined) return;
        clearTimeout(timer);
        settle(JSON.parse(line) as { port: number; origin: string });
      });
      child.once('close', code => {
        clearTimeout(timer);
        fail(new Error(`rendezvous process exited early (code ${String(code)})\n${stderr}`));
      });
    });
    return { child, port: ready.port };
  };

  const endChild = async (child: ChildProcess, signal: NodeJS.Signals): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill(signal);
    await new Promise<void>(settle => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        settle();
      }, 3_000);
      child.once('close', () => {
        clearTimeout(timer);
        settle();
      });
    });
  };

  // A real Worker redeploy keeps its configuration (the allowlist) and loses its sockets and its
  // in-memory arrival record; this harness process keeps neither, so both are carried across here.
  const allowed = new Set<string>();
  let running: RunningRendezvous | undefined = await launch(0);
  const port = running.port;
  const archivedArrivals: { role: 'daemon' | 'client'; daemonId: string }[] = [];

  const stop = async (): Promise<void> => {
    const current = running;
    running = undefined;
    if (current !== undefined) await endChild(current.child, 'SIGTERM');
  };
  teardown.add('rendezvous process', stop);

  const httpOrigin = `http://127.0.0.1:${String(port)}`;
  const liveArrivals = async (): Promise<{ role: 'daemon' | 'client'; daemonId: string }[]> => {
    const response = await fetch(`${httpOrigin}/__harness/arrivals`);
    return ((await response.json()) as { arrivals: { role: 'daemon' | 'client'; daemonId: string }[] }).arrivals;
  };
  return {
    relayUrl: `ws://127.0.0.1:${String(port)}`,
    httpOrigin,
    observationsPath,
    allow: async daemonId => {
      allowed.add(daemonId);
      const response = await fetch(`${httpOrigin}/__harness/allow`, { method: 'POST', body: [...allowed].join(',') });
      if (!response.ok) throw new Error(`rendezvous refused the fingerprint allowlist: ${String(response.status)}`);
    },
    sockets: async () => {
      const response = await fetch(`${httpOrigin}/__harness/sockets`);
      const body = (await response.json()) as {
        rendezvous: { rendezvous: string; sockets: number; roles: string[] }[];
      };
      return body.rendezvous;
    },
    arrivals: async () => [...archivedArrivals, ...(await liveArrivals())],
    dialled: async () =>
      [...archivedArrivals, ...(await liveArrivals())]
        .filter(entry => entry.role === 'daemon')
        .map(entry => entry.daemonId),
    observations: async () => {
      const content = await readFile(observationsPath, 'utf8');
      if (content.trim() === '') return [];
      return content
        .trimEnd()
        .split('\n')
        .map(line => JSON.parse(line) as ObservedFrame);
    },
    stderr: () => processStderr,
    restart: async ({ downMs = 0 } = {}) => {
      const current = running;
      if (current === undefined) throw new Error('the rendezvous is already stopped');
      archivedArrivals.push(...(await liveArrivals().catch(() => [])));
      running = undefined;
      // SIGKILL, not SIGTERM: a redeploy does not say goodbye. SIGTERM would close every socket with
      // 1001 and a reason, which is a politer outage than the one the owner's phone actually saw.
      const droppedAt = Date.now();
      await endChild(current.child, 'SIGKILL');
      if (downMs > 0) await Bun.sleep(downMs);
      let lastError: unknown;
      // The port may linger for a moment after the kill; the same port is the point (the directory
      // advertisement and the daemon's dial target are fixed), so wait for it rather than take another.
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          running = await launch(port);
          break;
        } catch (error) {
          lastError = error;
          await Bun.sleep(100);
        }
      }
      if (running === undefined)
        throw new Error(`the rendezvous could not rebind port ${String(port)}`, { cause: lastError });
      return { droppedAt, backAt: Date.now() };
    },
    stop,
  };
}

interface RunningRendezvous {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly port: number;
}

/**
 * Wait until the compiled daemon has CLAIMED its rendezvous.
 *
 * There is no daemon-side observable for this — `BunRelayCarrier.status()` knows, and no route,
 * health field or boot-trail line says so; the trail's "dialling" line is printed BEFORE the claim
 * resolves and would be a false ready. So the honest signal is the rendezvous' own: it is holding a
 * socket in the `daemon` role for this fingerprint.
 */
/**
 * Wait for the daemon to say who it is, by dialling.
 *
 * The fingerprint has to be known before the rendezvous will admit it, and the daemon is the only
 * party that has one. Asking the rendezvous who knocked is race-free; reading the daemon's own boot
 * trail is not, because that line is written after its HTTP listener opens and a readiness poll can
 * therefore return first.
 */
export async function waitForDaemonFingerprint(
  rendezvous: RendezvousProcess,
  /**
   * Fingerprints already seen, which must not be mistaken for this daemon's.
   *
   * The journey probes the rendezvous with a SYNTHETIC fingerprint first, to prove an unlisted one
   * is refused — and that probe is a dial like any other. Taking the first entry returned a
   * fingerprint no daemon has, which then got allowlisted, and the real daemon was refused for
   * twenty seconds while the report blamed the daemon.
   */
  alreadySeen: readonly string[] = [],
  timeoutMs = 20_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const seen = await rendezvous.dialled().catch(() => []);
    const fresh = seen.find(candidate => !alreadySeen.includes(candidate));
    if (fresh !== undefined) return fresh;
    await Bun.sleep(100);
  }
  throw new Error(`no daemon dialled the rendezvous within ${String(timeoutMs)}ms`);
}

/** Wait until at least `wanted` client sessions have arrived for this daemon; answer how many did. */
export async function waitForClientArrivals(
  rendezvous: RendezvousProcess,
  daemonId: string,
  wanted: number,
  timeoutMs = 30_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let seen = 0;
  while (Date.now() < deadline) {
    const arrivals = await rendezvous.arrivals().catch(() => []);
    seen = arrivals.filter(entry => entry.role === 'client' && entry.daemonId === daemonId).length;
    if (seen >= wanted) return seen;
    await Bun.sleep(150);
  }
  return seen;
}

export async function waitForDaemonAtRendezvous(rendezvous: RendezvousProcess, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let seen = 'nothing';
  while (Date.now() < deadline) {
    const rows = await rendezvous.sockets().catch(() => []);
    seen = JSON.stringify(rows);
    if (rows.some(row => row.roles.includes('daemon'))) return;
    await Bun.sleep(100);
  }
  throw new Error(`the compiled daemon never claimed the rendezvous within ${String(timeoutMs)}ms (saw ${seen})`);
}

// ─── the direct address that must fail ────────────────────────────────────────────────────────

export interface DirectSinkhole {
  /** An origin the daemon can advertise and the browser will genuinely fail to use. */
  readonly origin: string;
  readonly port: number;
  /** How many times something opened a TCP connection to the advertised direct address. */
  attempts(): number;
  stop(): Promise<void>;
}

export async function startDirectSinkhole(teardown: HarnessTeardown): Promise<DirectSinkhole> {
  let attempts = 0;
  const sockets = new Set<Socket>();
  const server: Server = createServer(socket => {
    attempts += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    // Destroy rather than answer. An HTTP status — any status — is an ANSWER under §13 and would
    // STOP the carrier walk instead of advancing it, which would prove the opposite of the point.
    socket.destroy();
  });
  await new Promise<void>((settle, fail) => {
    server.once('error', fail);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => settle());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the direct sinkhole took no IPv4 port');

  const stop = async (): Promise<void> => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((settle, fail) => server.close(error => (error === undefined ? settle() : fail(error))));
  };
  teardown.add('direct sinkhole', stop);
  return { origin: `http://127.0.0.1:${String(address.port)}`, port: address.port, attempts: () => attempts, stop };
}

// ─── the relay directory advertisement, which is how BOTH ends find one rendezvous ────────────

export interface RelayDirectory {
  /** The origin compiled into the bundle and handed to the daemon as `FY_RELAY_DIRECTORY_ORIGIN`. */
  readonly origin: string;
  /** How many times the hosted advertisement has been answered, so discovery is an asserted claim. */
  reads(): number;
  /** Every path asked for, so a 404 caused by a path change cannot read as "nobody looked". */
  requests(): readonly string[];
  /** What the advertisement names. `null` is the switched-off answer, which fails closed to direct. */
  publish(relayUrl: string | null): void;
}

/**
 * The stub hosted directory, and it is the piece that makes this journey the SHIPPED path.
 *
 * The default install has no rendezvous in its QR. Both ends find one by reading the same no-store
 * advertisement — the daemon at boot, the browser once per document — so a journey that hands the
 * daemon an explicit `relay` block and the browser a `relay=` fragment field proves a spelling nobody
 * ships. This serves that advertisement from loopback instead, on an origin nothing outside this
 * process knows.
 *
 * ORIGIN AT BUILD TIME, ADDRESS AFTERWARDS. Only the ORIGIN has to exist before `vite build`, because
 * that is what becomes `__FY_RELAY_DIRECTORY__`. The `relayUrl` is published once the rendezvous has a
 * port, which is what removes the ordering problem a build-time address would create.
 *
 * ONE PER PROCESS, AND DELIBERATELY NOT ON A JOURNEY'S TEARDOWN. The bundle memo below is keyed on
 * this origin, so a per-journey directory would mean a second full `vite build` for the second
 * journey — and closing it on the first journey's teardown would leave the second serving nothing,
 * which is the same trap the bundle's own comment records. `unref()` releases only the listening
 * handle's claim on event-loop liveness; it is not suite teardown. Accepted keep-alive sockets are
 * separate handles and may live until their owners close them or the server timeout expires.
 *
 * It counts reads because "the browser discovered the rendezvous" must be ASSERTED. Without the count
 * a journey that crossed the relay for some other reason would look identical to one that read this.
 */
let directoryPromise: Promise<RelayDirectory> | undefined;

export async function startRelayDirectory(): Promise<RelayDirectory> {
  directoryPromise ??= (async () => {
    let reads = 0;
    const paths: string[] = [];
    // `null` until a rendezvous exists: an advertisement that named a dead address would make the
    // browser's first relayed attempt fail for a harness reason.
    let relayUrl: string | null = null;
    const server = createHttpServer((request, response) => {
      const path = (request.url ?? '/').split('?')[0] ?? '/';
      paths.push(path);
      if (path !== HOSTED_RELAY_PUBLIC_PATH) {
        response.writeHead(404).end();
        return;
      }
      reads += 1;
      // The real control plane's own headers: no-store, and permissive CORS because the browser
      // reading this is on the PWA origin, not on this one.
      response.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      response.end(JSON.stringify({ version: 1, relayUrl }));
    });
    await new Promise<void>((settle, fail) => {
      server.once('error', fail);
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => settle());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('the relay directory took no IPv4 port');
    server.unref();
    return {
      origin: `http://127.0.0.1:${String(address.port)}`,
      reads: () => reads,
      requests: () => [...paths],
      publish: (next: string | null) => {
        relayUrl = next;
      },
    };
  })();
  return directoryPromise;
}

// ─── the real bundle, on a real origin ────────────────────────────────────────────────────────

/**
 * Build the PWA once per suite run.
 *
 * The REAL bundle, not `renderToStaticMarkup` output: the existing `*.visual.test.tsx` tier renders
 * markup into a static page, which cannot pair with anything because the app is never running. What
 * makes this journey different is that the JavaScript that ships is the JavaScript that dials.
 *
 * BUILT AGAINST THE STUB DIRECTORY, and the previous arrangement was a false comment as well as a
 * weaker proof. It read "built with NO `FY_RELAY_DIRECTORY_ORIGIN`, deliberately — discovery is
 * skipped entirely", and passed `FY_RELAY_DIRECTORY_ORIGIN: ''`. That variable was INERT:
 * `packages/pwa/vite.config.ts` read no environment at all, so the bundle carried the PRODUCTION
 * directory origin and every page load dialled a real Cloudflare Worker. The config now honours the
 * variable — the daemon always did — and this passes the loopback stub, so nothing reaches a real
 * service and discovery is exercised rather than skipped.
 */
let bundlePromise: Promise<string> | undefined;

/**
 * Built into the SUITE root, not a journey's own root.
 *
 * The memo is per process and the journeys are not: a bundle built into the first journey's
 * `paths.root` is deleted when that journey disposes, and the second journey then serves a
 * directory that is not there. Every request 404s, which reads as an app that cannot load — the
 * hour-long misdiagnosis this comment exists to prevent. `run-e2e.sh` removes the suite root once,
 * after every journey has finished.
 */
let bundleDirectoryOrigin: string | undefined;

export async function buildPwaBundle(directoryOrigin: string): Promise<string> {
  // The memo answers the FIRST origin forever, so a second one is a silent wrong bundle: the app would
  // discover a directory this journey is not serving and its relayed leg would fail for a harness
  // reason. Refuse loudly instead — one directory per process is the arrangement.
  if (bundleDirectoryOrigin !== undefined && bundleDirectoryOrigin !== directoryOrigin) {
    throw new Error(
      `the PWA bundle is already built against ${bundleDirectoryOrigin}; it cannot also serve ${directoryOrigin}`,
    );
  }
  bundleDirectoryOrigin = directoryOrigin;
  bundlePromise ??= (async () => {
    const suiteRoot = process.env.FY_E2E_RUN_ROOT ?? tmpdir();
    const outDir = await assertNoLiveStatePath(join(suiteRoot, 'fy-e2e-pwa-dist'), 'PWA bundle output');
    await mkdir(outDir, { recursive: true });
    /**
     * THE THREE STEPS OF `bun run build`, EACH TOLD WHERE TO WRITE.
     *
     * This ran `bun run build --outDir <dir>`, which stopped working when the script grew a release
     * step: `bun run` appends the arguments to the END of the script, so `--outDir` reached
     * `scripts/build-release.ts` and `vite build` wrote to the package's own `dist/`. The build
     * exited 0, the output directory stayed empty, and every journey failed on a missing
     * `app/index.html`. Spelling the steps out keeps the bundle exactly what Pages publishes — the
     * verified worker and the (unsigned) release list included — in a directory this run owns.
     */
    const steps: readonly (readonly string[])[] = [
      ['bun', 'run', 'build:fy-render-shell'],
      ['bun', 'x', 'vite', 'build', '--outDir', outDir, '--emptyOutDir'],
      ['bun', 'run', 'scripts/build-release.ts', outDir],
    ];
    for (const command of steps) {
      // SYNCHRONOUS: Bun 1.3's async spawn lost its epoll registration on a hosted runner
      // (`EBADF … epoll_ctl`), and because this build is memoised, the one failure failed every journey
      // after it in ~90ms. Nothing in-process has to answer while the bundle builds, so blocking costs
      // nothing, and `spawnSync` never touches epoll.
      const build = Bun.spawnSync([...command], {
        cwd: join(REPOSITORY_ROOT, 'packages', 'pwa'),
        env: { ...process.env, FY_RELAY_DIRECTORY_ORIGIN: directoryOrigin, NO_COLOR: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const code = build.exitCode;
      const out = build.stdout.toString();
      const err = build.stderr.toString();
      if (code !== 0)
        throw new Error(
          `the PWA bundle failed to build at \`${command.join(' ')}\` (code ${String(code)})\n${out}\n${err}`,
        );
    }
    await stat(join(outDir, 'app', 'index.html'));
    return outDir;
  })();
  // A failed build is not memoised: the next journey builds again instead of inheriting the failure.
  bundlePromise.catch(() => {
    bundlePromise = undefined;
  });
  return bundlePromise;
}

export interface PwaOrigin {
  readonly origin: string;
  /** Every path the browser asked this origin for, so a 404 cannot pass as a working page. */
  requests(): readonly { readonly path: string; readonly status: number }[];
  /**
   * The 404s that are the APP's fault.
   *
   * `/favicon.ico` is excluded because the browser asks for it whether or not the page references
   * it, and this site declares `/icons/favicon.svg` in its document instead. Counting Chrome's own
   * unsolicited probe as a missing asset would fail every journey for a file the app never asked
   * for — and would train the next reader to ignore the check that catches a real one.
   */
  missingAssets(): readonly string[];
  stop(): Promise<void>;
}

/** Requests the browser makes on its own, which say nothing about whether the bundle is complete. */
const UNSOLICITED_PATHS: readonly string[] = [
  '/favicon.ico',
  '/apple-touch-icon.png',
  '/apple-touch-icon-precomposed.png',
];

async function contentSecurityPolicy(): Promise<string> {
  const headers = await readFile(HEADERS_FILE, 'utf8');
  const line = headers.split('\n').find(candidate => candidate.trim().startsWith('Content-Security-Policy:'));
  if (line === undefined) throw new Error('packages/pwa/public/_headers declares no Content-Security-Policy');
  return line.trim().slice('Content-Security-Policy:'.length).trim();
}

/**
 * THE SITE'S OWN `_headers`, applied per path the way Pages applies them — by the same reader the
 * release worker uses (`release-headers.ts`), `!` detachment included. Every file used to get the `/*`
 * policy, which is how a sandbox shell served with `frame-ancestors 'none'` stayed invisible to every
 * journey: the shell's own rule never applied here either. Caching stays off and the content type
 * stays the file's own, for the reasons below.
 */
async function headersFor(path: string, served: string): Promise<Record<string, string>> {
  const rules = parseReleaseHeaders(await readFile(HEADERS_FILE, 'utf8'));
  const headers: Record<string, string> = {};
  for (const [name, value] of releaseHeadersFor(path, served, rules))
    if (name.toLowerCase() !== 'content-type' && name.toLowerCase() !== 'cache-control') headers[name] = value;
  return headers;
}

export async function startPwaOrigin(distDir: string, teardown: HarnessTeardown): Promise<PwaOrigin> {
  // Read once up front so a broken `_headers` fails the journey at its start, not mid-page.
  await contentSecurityPolicy();
  const requests: { path: string; status: number }[] = [];
  const rewrites = parseReleaseRewrites(await readFile(REDIRECTS_FILE, 'utf8'));
  const files: Record<string, string> = {};
  for await (const name of new Bun.Glob('**/*').scan({ cwd: distDir, onlyFiles: true })) files[name] = name;

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async request => {
      const path = new URL(request.url).pathname;
      // The same reader the service worker uses, so this server cannot drift from `public/_redirects`.
      const candidate = releasePathForRequest(
        { pathname: path, navigate: request.headers.get('sec-fetch-mode') === 'navigate' },
        files,
        rewrites,
      );
      if (candidate !== null) {
        requests.push({ path, status: 200 });
        return new Response(Bun.file(join(distDir, candidate)), {
          headers: {
            ...(await headersFor(path, candidate)),
            // No caching anywhere: two journeys in one suite must not share a bundle state, and a
            // stale document is the kind of failure that reads as an app defect.
            'Cache-Control': 'no-store, max-age=0',
          },
        });
      }
      requests.push({ path, status: 404 });
      return new Response('not found', { status: 404 });
    },
  });

  const stop = async (): Promise<void> => {
    await server.stop(true);
  };
  teardown.add('PWA origin', stop);
  return {
    origin: `http://127.0.0.1:${String(server.port)}`,
    requests: () => requests,
    missingAssets: () =>
      requests
        .filter(entry => entry.status === 404 && !UNSOLICITED_PATHS.includes(entry.path))
        .map(entry => entry.path),
    stop,
  };
}

// ─── the real browser ─────────────────────────────────────────────────────────────────────────

/**
 * The slice of `playwright-core` this journey uses.
 *
 * Declared here rather than imported as a type because `playwright-core` is a devDependency of
 * `packages/pwa` and `packages/daemon`, and is NOT resolvable from `tests/`: this repository
 * installs isolated, so the root `node_modules` holds `.bun` and per-package link trees, not a flat
 * copy. Resolving it at runtime from a package that DOES depend on it keeps this tier working
 * without changing a dependency this unit does not own. If the root ever declares it, nothing here
 * changes. The cost is honest and small: these shapes are hand-written, so an API drift shows up as
 * a runtime failure in this file rather than as a type error.
 */
export interface BrowserPage {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  waitForSelector(selector: string, options?: { timeout?: number; state?: string }): Promise<unknown>;
  click(selector: string, options?: { timeout?: number }): Promise<void>;
  getAttribute(selector: string, name: string): Promise<string | null>;
  textContent(selector: string): Promise<string | null>;
  evaluate<T>(expression: string): Promise<T>;
  focus(selector: string, options?: { timeout?: number }): Promise<void>;
  readonly keyboard: { type(text: string): Promise<void> };
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  emulateMedia(options: { colorScheme: 'light' | 'dark' }): Promise<void>;
  screenshot(options: { path: string; timeout?: number }): Promise<unknown>;
  on(event: string, handler: (payload: unknown) => void): void;
  close(): Promise<void>;
}

export interface BrowserSession {
  readonly page: BrowserPage;
  /** Everything the page logged, so a silent failure in product code is visible to the report. */
  readonly console: readonly string[];
  readonly pageErrors: readonly string[];
  /** A DevTools session on the page, for what only the protocol can do — a virtual authenticator. */
  cdp(): Promise<BrowserCdpSession>;
  stop(): Promise<void>;
}

interface BrowserCdpSession {
  send<T = unknown>(method: string, params?: Readonly<Record<string, unknown>>): Promise<T>;
}

interface BrowserContextLike {
  newPage(): Promise<BrowserPage>;
  newCDPSession(page: BrowserPage): Promise<BrowserCdpSession>;
  grantPermissions(permissions: readonly string[], options?: { origin?: string }): Promise<void>;
}

interface ChromiumLauncher {
  launch(options: { executablePath: string; headless: boolean; args: string[]; timeout?: number }): Promise<{
    newContext(options?: Record<string, unknown>): Promise<BrowserContextLike>;
    close(): Promise<void>;
  }>;
}

export function resolvePlaywright(): string {
  const from = [REPOSITORY_ROOT, join(REPOSITORY_ROOT, 'packages', 'pwa'), join(REPOSITORY_ROOT, 'packages', 'daemon')];
  for (const directory of from) {
    try {
      return Bun.resolveSync('playwright-core', directory);
    } catch {
      // Try the next package that declares it.
    }
  }
  throw new Error('playwright-core is not installed; the real-browser E2E journey cannot run');
}

/** The Chrome this host actually has. No download, no bundled browser, no network. */
export function chromeExecutable(): string {
  const found = Bun.which('google-chrome') ?? Bun.which('chromium') ?? Bun.which('chromium-browser');
  if (found === null) throw new Error('no google-chrome or chromium on PATH; the real-browser journey cannot run');
  return found;
}

export interface ChromeOptions {
  /**
   * A user agent carrying a marker unique to this run.
   *
   * The device NAMES ITSELF when it redeems, so the harness cannot pass a name in — but it can make
   * the name unique, because the app derives it from what the browser says about itself. That is
   * what turns "the device name must not reach the relay" from an assertion about a string nobody
   * chose into one the leak search can actually run.
   */
  readonly userAgent?: string;
}

export async function launchChrome(teardown: HarnessTeardown, options: ChromeOptions = {}): Promise<BrowserSession> {
  const module = (await import(resolvePlaywright())) as { chromium: ChromiumLauncher };
  const browser = await launchChromiumWithRetry(() =>
    module.chromium.launch({
      executablePath: chromeExecutable(),
      headless: true,
      // Chrome starts in about two seconds; a launch that has not finished in twenty never will (see launchChromiumWithRetry).
      timeout: 20_000,
      // `--no-sandbox` because this host's Chrome refuses to start otherwise under the test runner,
      // and `--disable-dev-shm-usage` because a small `/dev/shm` in a container crashes the renderer
      // mid-journey, which looks exactly like an app defect.
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    }),
  );
  const context = await browser.newContext({
    viewport: { width: 1_280, height: 900 },
    ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
  });
  /**
   * LOCAL NETWORK ACCESS, GRANTED FOR EVERY JOURNEY, BEFORE THE FIRST NAVIGATION.
   *
   * READ THIS BEFORE DEBUGGING A JOURNEY WHOSE SERVER RECEIVED NOTHING. Measured against Google
   * Chrome 150 with a logging loopback server: a page on a PUBLIC origin fetching
   * `http://127.0.0.1:<port>` is refused by the browser before any request is sent. The server sees
   * ZERO requests — no preflight, not even a connection — and the only evidence is one console line,
   * "Permission was denied for this request to access the `loopback` address space". A headless
   * browser has no UI to prompt in, so the permission is denied by default, and the journey fails
   * for a reason that has nothing to do with the code under test. It is indistinguishable from a
   * routing defect, a CORS defect, or a daemon that never bound its port, which is why this is
   * granted here for everyone rather than documented for whoever reads the right test file.
   *
   * IT IS A PERMISSION, NOT A HEADER, so no daemon change can substitute for it: nothing can be sent
   * back to rescue a request that never left the browser, and `Access-Control-Allow-Private-Network:
   * true` on every response was measured to change nothing in either the denied or the granted case.
   * Granted, the preflight arrives carrying no private-network request header at all and ordinary
   * CORS applies — so a daemon needs nothing extra and a browser needs exactly this.
   *
   * Today's journeys serve their page from loopback too, and local-to-local is not gated, so this
   * grants nothing they do not already have. It is here for the FIRST journey driven from a public
   * origin, which would otherwise be debugged against the wrong package for a day.
   *
   * A browser that does not know the permission name cannot be enforcing it, so a refusal to grant
   * is not a reason to fail a run that would have worked.
   */
  await context.grantPermissions(['local-network-access']).catch(() => undefined);
  const page = await context.newPage();

  const consoleLines: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', payload => consoleLines.push(String((payload as { text(): string }).text())));
  page.on('pageerror', payload => pageErrors.push(String(payload)));

  const stop = async (): Promise<void> => {
    await closeChromeBounded(browser);
  };
  teardown.add('chrome', stop);
  let session: Promise<BrowserCdpSession> | undefined;
  const cdp = (): Promise<BrowserCdpSession> => {
    session ??= context.newCDPSession(page);
    return session;
  };
  return { page, console: consoleLines, pageErrors, cdp, stop };
}

// ─── the step ledger ──────────────────────────────────────────────────────────────────────────

/**
 * What was proved, and the FIRST thing that was not.
 *
 * This journey spans four packages that are being written concurrently, so it will spend a while in
 * a state where some steps pass and one does not. The failure mode to avoid is a weaker test that
 * sounds end-to-end — so every step is named up front, recorded as it passes, and the report names
 * the first unproven step exactly rather than summarising. A run that ends early writes the same
 * report as a run that completes; only the contents differ.
 */
export interface LedgerStep {
  readonly id: string;
  readonly claim: string;
}

export interface StepLedger {
  prove(id: string, evidence: string): void;
  fail(id: string, because: string): never;
  write(path: string): Promise<void>;
  readonly firstUnproven: () => LedgerStep | undefined;
}

export function stepLedger(steps: readonly LedgerStep[]): StepLedger {
  const proved = new Map<string, string>();
  const failures = new Map<string, string>();
  const ledger: StepLedger = {
    prove: (id, evidence) => {
      if (steps.every(step => step.id !== id)) throw new Error(`unknown ledger step: ${id}`);
      proved.set(id, evidence);
    },
    fail: (id, because) => {
      failures.set(id, because);
      const step = steps.find(candidate => candidate.id === id);
      throw new Error(`UNPROVEN ${id} — ${step?.claim ?? 'unknown step'}\n  ${because}`);
    },
    /**
     * The step that FAILED, if one did; otherwise the first that was never reached.
     *
     * A failure aborts the journey, so anything after it is unreached through no fault of its own.
     * Reporting the earliest unreached step instead of the one that actually broke sends the reader
     * to the wrong package — which happened, and cost a round trip.
     */
    firstUnproven: () => steps.find(step => failures.has(step.id)) ?? steps.find(step => !proved.has(step.id)),
    write: async path => {
      const first = ledger.firstUnproven();
      const failed = first !== undefined && failures.has(first.id);
      const lines = [
        '# &F107 — compiled-binary real-browser relay proof',
        '',
        first === undefined
          ? 'EVERY STEP PROVED.'
          : `${failed ? 'FAILED STEP' : 'FIRST UNPROVEN STEP'}: ${first.id} — ${first.claim}\n  ${failures.get(first.id) ?? 'not reached'}`,
        '',
        '| step | state | evidence |',
        '| --- | --- | --- |',
        ...steps.map(step => {
          const evidence = proved.get(step.id);
          const state = evidence === undefined ? (failures.has(step.id) ? 'FAILED' : 'not reached') : 'proved';
          return `| \`${step.id}\` | ${state} | ${evidence ?? failures.get(step.id) ?? '—'} |`;
        }),
        '',
        ...steps.map(step => `- \`${step.id}\`: ${step.claim}`),
        '',
      ];
      await appendFile(path, `${lines.join('\n')}\n`, 'utf8');
    },
  };
  return ledger;
}

/**
 * What the browser stored for its pairing, read out for the leak search and the key check only.
 *
 * There is no device credential to find any more — the grant is proved by a non-extractable key —
 * so this returns the grant's ID (an identity the relay must still never read) and the NAMES of any
 * stored field that looks like a token, which must be none: a bearer value surviving in storage would
 * be the old credential coming back by another route. The id is handed straight to
 * {@link plaintextLeaks}, which reports the LABEL of a match and never the value.
 */
export interface StoredDeviceGrant {
  /** The grant's id, for {@link plaintextLeaks} and nothing else. Empty when none was found. */
  readonly deviceId: string;
  /** The key paths of every stored string field named like a token. A paired browser has none. */
  readonly tokenFields: readonly string[];
  /**
   * The device key this browser holds for the daemon, described rather than returned: whether it is
   * a real `CryptoKey`, its algorithm, and — the property the design rests on — whether it can be
   * exported. `null` when no key is stored.
   */
  readonly key: { readonly isCryptoKey: boolean; readonly algorithm: string; readonly extractable: boolean } | null;
  /**
   * Where the reader looked and what it found there, as NAMES ONLY.
   *
   * A failure to find a credential has to be diagnosable without printing one, so this reports
   * database names, store names, record keys and JSON key paths — never a value. It is the whole
   * difference between "no device grant is stored" (which is either a product defect or a reader
   * that is looking in the wrong place, and does not say which) and an answer.
   */
  readonly shape: string;
}

export async function deviceGrantForLeakSearchOnly(page: BrowserPage): Promise<StoredDeviceGrant> {
  return page.evaluate<StoredDeviceGrant>(`(async () => {
    const open = name => new Promise((settle, fail) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => settle(request.result);
      request.onerror = () => fail(request.error);
    });
    const all = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [{ name: 'ferretry-pwa' }];
    const notes = [];
    let deviceId = '';
    const tokenFields = [];
    let key = null;
    for (const entry of all) {
      if (typeof entry.name !== 'string') continue;
      const database = await open(entry.name);
      for (const store of [...database.objectStoreNames]) {
        const records = await new Promise((settle, fail) => {
          const request = database.transaction(store).objectStore(store).getAll();
          request.onsuccess = () => settle(request.result ?? []);
          request.onerror = () => fail(request.error);
        });
        const keys = new Set();
        const walk = (node, path) => {
          if (node === null || node === undefined) return;
          // The record is a SERIALISED document, not an object graph: the connections store holds
          // one JSON string. Walking it as an object found nothing and reported "no device token is
          // stored", which reads as a product defect and was a reader looking at the wrong shape.
          // A CryptoKey is not a document; it is described where the key store is read below.
          // (No backticks in this comment: it lives inside a template literal, and one would end it.)
          if (typeof node === 'string') {
            if (!node.trimStart().startsWith('{') && !node.trimStart().startsWith('[')) return;
            try {
              walk(JSON.parse(node), path);
            } catch {
              keys.add(path + '<unparseable string>');
            }
            return;
          }
          if (typeof node !== 'object') return;
          for (const [name, child] of Object.entries(node)) {
            keys.add(path + name);
            if (typeof child === 'string' && /token/i.test(name) && child !== '') tokenFields.push(path + name);
            if (typeof child === 'string' && name === 'deviceId' && child !== '' && deviceId === '') deviceId = child;
            walk(child, path + name + '.');
          }
        };
        for (const record of records) {
          if (record instanceof CryptoKey) {
            key = { isCryptoKey: true, algorithm: record.algorithm.name, extractable: record.extractable };
            continue;
          }
          walk(record, '');
        }
        notes.push(entry.name + '/' + store + ' (' + records.length + ' record(s)): ' + [...keys].sort().join(', '));
      }
    }
    const local = Object.keys(localStorage).sort().join(', ');
    return { deviceId, tokenFields, key, shape: notes.join(' | ') + ' || localStorage keys: ' + local };
  })()`);
}

/**
 * The assertion that makes the whole journey worth running.
 *
 * Every frame the rendezvous handled is searched for each secret, in the encodings a leak would
 * plausibly take: raw utf-8 and base64. A relay that can read a session is wrong however well it
 * works, and a harness that only checked the happy path would not notice.
 *
 * A hit reports the LABEL and the frame index. It never reports the value — a leak report that
 * printed the credential would be a second copy of the same defect.
 */
export function plaintextLeaks(
  frames: readonly ObservedFrame[],
  secrets: Readonly<Record<string, string>>,
): readonly string[] {
  const haystack = frames.map(frame => Buffer.from(frame.base64, 'base64'));
  const leaks: string[] = [];
  for (const [label, secret] of Object.entries(secrets)) {
    if (secret === '') continue;
    const needles = [Buffer.from(secret, 'utf8'), Buffer.from(Buffer.from(secret, 'utf8').toString('base64'), 'utf8')];
    for (const [index, frame] of haystack.entries()) {
      if (needles.some(needle => frame.includes(needle))) {
        leaks.push(`${label} appeared in relay-observable frame #${String(index)}`);
        break;
      }
    }
  }
  return leaks;
}

/**
 * Read an attribute that may not be there, WITHOUT waiting for it.
 *
 * `page.getAttribute` waits for the locator and throws after its timeout, so using it to report
 * what the page was showing after a failed wait costs a second full timeout and then loses the
 * answer to an exception. The diagnostic must be cheap and must never be the thing that fails.
 */
export async function attributeNow(page: BrowserPage, selector: string, name: string): Promise<string | null> {
  return page.evaluate<string | null>(
    `document.querySelector(${JSON.stringify(selector)})?.getAttribute(${JSON.stringify(name)}) ?? null`,
  );
}

/**
 * Click the first of several candidate selectors that is actually on the page.
 *
 * One hard-coded selector for "the primary button" is a guess about somebody else's markup, and
 * when the guess is wrong the failure reads as "the app ignored a click" rather than "the harness
 * clicked nothing". This tries the NAMED contracts first and structural fallbacks after, and
 * returns which one matched so the evidence line records what was actually pressed.
 */
export async function clickFirstPresent(page: BrowserPage, selectors: readonly string[]): Promise<string | null> {
  for (const selector of selectors) {
    const present = await page.evaluate<boolean>(`document.querySelector(${JSON.stringify(selector)}) !== null`);
    if (!present) continue;
    await page.click(selector, { timeout: 10_000 });
    return selector;
  }
  return null;
}

/** Every control the page is offering, so "no selector matched" can name what was there instead. */
export async function describeControls(page: BrowserPage, scope: string): Promise<string> {
  return page.evaluate<string>(
    `[...(document.querySelector(${JSON.stringify(scope)}) ?? document).querySelectorAll('button, [role="button"], a[href]')]
       .map(node => node.tagName.toLowerCase() + '[' + [...node.attributes].map(attribute => attribute.name + (attribute.value === '' ? '' : '=' + attribute.value.slice(0, 24))).join(' ') + ']: ' + (node.textContent ?? '').trim().slice(0, 40))
       .slice(0, 12)
       .join(' | ')`,
  );
}

/**
 * Every `data-*` the page actually rendered, WITH its value — what to say instead of "the selector
 * is missing".
 *
 * The values are the half that makes this actionable. `data-onboarding-screen` present tells you a
 * surface mounted; `data-onboarding-screen="entry"` tells you the app read the arrival as a cold
 * open, which is a completely different defect from a screen that failed to render. Values are
 * capped because a stray attribute carrying a serialised document would bury the answer.
 */
export async function renderedDataAttributes(page: BrowserPage): Promise<string> {
  return page.evaluate<string>(
    `[...new Set([...document.querySelectorAll('*')].flatMap(node =>
       [...node.attributes]
         .filter(attribute => attribute.name.startsWith('data-'))
         .map(attribute => attribute.value === '' ? attribute.name : attribute.name + '="' + attribute.value.slice(0, 40) + '"')
     ))].sort().join(', ')`,
  );
}

/**
 * Every `Failed to connect` / EBADF Bun raised while wiring a child's EXTRA stdio pipes, newest last.
 *
 * Playwright launches Chrome with its DevTools channel on fds 3 and 4 (`--remote-debugging-pipe`).
 * Bun 1.3 builds each extra pipe lazily, as a socket it CONNECTS, and on loaded hosts (seen on GitHub's
 * runners, and twice in ~60 local journeys) that connect fails with ENOENT *asynchronously*. The
 * socket has no 'error' listener, so the error is UNCAUGHT, and Bun fails whichever test is running —
 * usually a different one from the test that launched the browser. No retry around `launch()` can
 * catch an error that never reaches it.
 */
const pipeFailures: Error[] = [];

/** What the stdio guard has caught so far, for a journey's evidence when a browser dies. */
export function stdioPipeFailures(): readonly string[] {
  return pipeFailures.map(error => error.message);
}

const browserExits: string[] = [];

/** Every Playwright-launched browser that has exited, with its code or signal. */
export function browserExitLog(): readonly string[] {
  return [...browserExits];
}
let spawnGuarded = false;
/** Launches in flight, and the children spawned by them — the only ones a pipe failure may end. */
let launching = 0;
const launchingChildren = new Set<ChildProcess>();
/** The processes each launched browser owns, so a forced close ends THAT browser and no other. */
const browserProcesses = new WeakMap<object, readonly ChildProcess[]>();

/**
 * Give every extra stdio socket an 'error' listener the moment its child exists.
 *
 * The failure then becomes a CHROME that never got its DevTools pipe — which is killed here, so
 * Playwright's `launch()` rejects at once instead of waiting out its timeout — and
 * {@link launchChromiumWithRetry} retries it. The wrapper touches only children spawned with more
 * than three stdio entries, which in this tier means Playwright's browser and nothing else.
 */
function guardExtraStdioPipes(): void {
  if (spawnGuarded) return;
  spawnGuarded = true;
  const module = childProcessModule as unknown as { default?: typeof childProcessModule } & typeof childProcessModule;
  const target = (module.default ?? module) as { spawn: (...args: unknown[]) => ChildProcess };
  const original = target.spawn;
  target.spawn = function guardedSpawn(this: unknown, ...args: unknown[]): ChildProcess {
    const child = original.apply(this, args);
    if (launching > 0) launchingChildren.add(child);
    const options = args.find(arg => typeof arg === 'object' && arg !== null && !Array.isArray(arg)) as
      | { readonly stdio?: unknown }
      | undefined;
    if (Array.isArray(options?.stdio) && options.stdio.length > 3) {
      // Who ended a browser is the first question when a journey loses one: record every exit.
      const startedAt = new Date().toISOString();
      child.once('exit', (code: number | null, signal: string | null) => {
        browserExits.push(
          `chrome pid ${String(child.pid)} started ${startedAt} exited ${new Date().toISOString()} code=${String(code)} signal=${String(signal)}`,
        );
      });
      for (let fd = 3; fd < options.stdio.length; fd += 1) {
        const onFailure = (error: Error): void => {
          pipeFailures.push(error);
          // Only a browser that never finished launching is ended. An error on the pipe of a browser a
          // journey is already driving (a reset at close, say) must not end that journey's browser.
          if (launchingChildren.has(child)) child.kill('SIGKILL');
        };
        try {
          (child.stdio[fd] as { on?: (event: string, listener: (error: Error) => void) => void } | null)?.on?.(
            'error',
            onFailure,
          );
        } catch (error) {
          onFailure(error as Error);
        }
      }
    }
    return child;
  };
}

/**
 * Launch Chrome, retrying ONLY a launch Bun broke while wiring Playwright's pipes.
 *
 * Retried when the stdio guard above caught a pipe failure during this attempt, or when the launch
 * itself failed with Bun's own words for it (`Failed to connect`, `EBADF`/`epoll_ctl`). No usable
 * browser exists after either, so another attempt is safe. Anything else — a missing Chrome, a bad
 * flag — fails the first time.
 */
export async function launchChromiumWithRetry<T>(launch: () => Promise<T>, attempts = 3): Promise<T> {
  guardExtraStdioPipes();
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const failuresBefore = pipeFailures.length;
    const childrenBefore = new Set(launchingChildren);
    launching += 1;
    try {
      const browser = await launch();
      if (typeof browser !== 'object' || browser === null) return browser;
      const children = [...launchingChildren].filter(child => !childrenBefore.has(child));
      const transport = watchBrowserTransport(children);
      await openTransportProbe(browser, transport);
      const guarded = guardBrowserTransport(browser, transport);
      browserProcesses.set(browser, children);
      browserProcesses.set(guarded, children);
      return guarded;
    } catch (error) {
      const text = String((error as Error).message ?? error);
      const pipeBroke = pipeFailures.length > failuresBefore;
      // A launch TIMEOUT is the silent form of the same loss: the pipe was never wired, so no browser exists.
      if (!pipeBroke && !/Failed to connect|EBADF|epoll_ctl|launch: Timeout \d+ms exceeded/u.test(text)) throw error;
      lastError = pipeBroke
        ? new Error(`${text} (Bun lost Chrome's DevTools pipe: ${String(pipeFailures.at(-1)?.message)})`)
        : error;
      await Bun.sleep(250 * attempt);
    } finally {
      launching -= 1;
      if (launching === 0) launchingChildren.clear();
    }
  }
  throw lastError;
}

/**
 * What Chrome writes to stderr when the DevTools pipe Playwright drives it through has broken.
 *
 * Seen on hosted runners, and the cause of both journeys that hung a shard for 10–15 minutes: Bun
 * stops servicing the extra stdio sockets it wired for Playwright (fds 3 and 4) AFTER the launch
 * succeeded. Chrome then cannot write a reply (`Could not write into pipe`) or reads EOF and exits 0
 * (`Connection terminated while reading from pipe`). Playwright is told neither: no `disconnected`
 * event, no error, and every call without its own timeout — `evaluate`, a CDP `send`, `newPage` —
 * waits until the test's own timeout ends it. Neither line has ever appeared in a healthy run.
 */
const DEVTOOLS_PIPE_LOSS = /Could not write into pipe|Connection terminated while reading from pipe/u;

/**
 * The ceiling for a browser call that carries no `timeout` of its own.
 *
 * Playwright bounds its actions (30 s by default) but not `evaluate`, CDP `send`, `newPage` or
 * `newContext`; on a healthy page each answers in milliseconds. A call given a timeout gets that
 * timeout plus {@link CALL_GRACE_MS}, so Playwright's own, better-worded error always arrives first.
 */
const CALL_CEILING_MS = 60_000;
const CALL_GRACE_MS = 30_000;

/**
 * THE THIRD, ENTIRELY SILENT FORM: Bun stops WRITING to Chrome. Chrome then receives nothing, so it has
 * nothing to fail at and logs nothing, and Playwright waits on replies to commands that never arrived.
 * Seen on a hosted runner as a journey that went quiet for two minutes with a healthy-looking Chrome.
 *
 * So a call still pending after {@link PROBE_AFTER_MS} asks Chrome's BROWSER process for its version
 * over a session opened at launch. The browser process answers that in milliseconds even while a page
 * is busy or a selector is still being waited for, so no reply within {@link PROBE_REPLY_MS} means the
 * pipe is gone, not that the page is slow.
 */
const PROBE_AFTER_MS = 10_000;
const PROBE_REPLY_MS = 5_000;

/** What Playwright, or the guard below, says when a browser connection vanished under a journey. */
const LOST_BROWSER =
  /Target page, context or browser has been closed|Browser has been closed|browser has disconnected/u;

/**
 * Whether an error means the browser itself is gone rather than the page being not ready yet.
 *
 * A polling loop that treats every failed read as "not yet" polls a dead browser until its own
 * deadline: one such loop held a journey for two minutes after its Chrome had died. Every loop
 * rethrows this one.
 */
export function isLostBrowser(error: unknown): boolean {
  return LOST_BROWSER.test(String((error as Error | undefined)?.message ?? error));
}

interface BrowserTransport {
  /** Rejects, with a `browser has disconnected` error, the moment the transport is known to be gone. */
  readonly lost: Promise<never>;
  /** Set by {@link closeChromeBounded}: an exit the harness asked for is not a lost transport. */
  closing: boolean;
  /** Declare the transport lost: {@link lost} rejects with `why`. */
  readonly fail: (why: string) => void;
  /** A round trip to Chrome's browser process, when a session for one could be opened at launch. */
  probe?: () => Promise<unknown>;
}

const browserTransports = new WeakMap<object, BrowserTransport>();

/**
 * Watch one launched browser's processes for the two ways its transport dies silently: Chrome
 * reporting a broken DevTools pipe, and Chrome exiting while nobody asked it to close.
 */
function watchBrowserTransport(children: readonly ChildProcess[]): BrowserTransport {
  let reject: (error: Error) => void = () => undefined;
  const lost = new Promise<never>((_resolve, fail) => {
    reject = fail;
  });
  // Nothing may be left unhandled: Bun fails whichever test is running on an unhandled rejection.
  lost.catch(() => undefined);
  let reason: string | undefined;
  const transport: BrowserTransport = { lost, closing: false, fail: why => markLost(why) };
  const markLost = (why: string): void => {
    if (reason !== undefined || transport.closing) return;
    reason = why;
    browserExits.push(`transport lost ${new Date().toISOString()}: ${why}`);
    reject(new Error(`browser has disconnected: ${why}`));
  };
  for (const child of children) {
    const exited = (code: number | null, signal: string | null): void =>
      markLost(`Chrome pid ${String(child.pid)} exited on its own (code=${String(code)}, signal=${String(signal)})`);
    if (child.exitCode !== null || child.signalCode !== null) exited(child.exitCode, child.signalCode);
    child.once('exit', exited);
    child.stderr?.on('data', (chunk: unknown) => {
      const seen = DEVTOOLS_PIPE_LOSS.exec(String(chunk));
      if (seen !== null)
        markLost(
          `Chrome pid ${String(child.pid)} reported "${seen[0]}" — Bun stopped servicing Playwright's DevTools pipe, so no pending call can be answered`,
        );
    });
  }
  return transport;
}

/** Open the browser-level CDP session {@link PROBE_AFTER_MS} probes through. No session, no probe. */
async function openTransportProbe(browser: object, transport: BrowserTransport): Promise<void> {
  const open = (browser as { newBrowserCDPSession?: () => Promise<{ send(method: string): Promise<unknown> }> })
    .newBrowserCDPSession;
  if (typeof open !== 'function') return;
  const opening = open.call(browser);
  opening.catch(() => undefined);
  const session = await Promise.race([opening, Bun.sleep(PROBE_AFTER_MS).then(() => undefined)]).catch(() => undefined);
  if (session !== undefined) transport.probe = () => session.send('Browser.getVersion');
}

/**
 * While `name` is pending, ask Chrome's browser process for a reply every {@link PROBE_AFTER_MS}, and
 * declare the transport lost the first time none comes within {@link PROBE_REPLY_MS}. Answers the stop.
 */
function watchPendingCall(name: string, transport: BrowserTransport): () => void {
  const probe = transport.probe;
  if (probe === undefined) return () => undefined;
  let probing = false;
  const watchdog = setInterval(() => {
    if (probing) return;
    probing = true;
    let silence: ReturnType<typeof setTimeout> | undefined;
    // A rejected probe still crossed the pipe; a session that has closed is what the other signs report.
    const answered = Promise.race([
      probe().then(
        () => true,
        () => true,
      ),
      new Promise<boolean>(settle => {
        silence = setTimeout(() => settle(false), PROBE_REPLY_MS);
      }),
    ]);
    void answered.then(replied => {
      clearTimeout(silence);
      probing = false;
      if (!replied)
        transport.fail(
          `${name} was still pending and Chrome's browser process did not answer Browser.getVersion within ${String(PROBE_REPLY_MS)}ms — Bun stopped carrying Playwright's DevTools pipe`,
        );
    });
  }, PROBE_AFTER_MS);
  return () => clearInterval(watchdog);
}

/** The Playwright objects a guarded browser hands out, unwrapped again whenever one goes back in. */
const guardedTargets = new WeakMap<object, object>();

/** Playwright's own client objects: every one carries the `_guid` of its protocol channel. */
function isPlaywrightObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null && Object.hasOwn(value, '_guid');
}

/** The helpers Playwright exposes as properties rather than methods. */
const GUARDED_PROPERTIES = new Set(['keyboard', 'mouse', 'touchscreen', 'request']);

function callCeiling(args: readonly unknown[]): number {
  for (const arg of args) {
    const timeout = (arg as { timeout?: unknown } | null)?.timeout;
    if (typeof arg === 'object' && typeof timeout === 'number' && timeout > 0) return timeout + CALL_GRACE_MS;
  }
  return CALL_CEILING_MS;
}

/**
 * Make every call on a browser — and on every context, page, CDP session and input helper it hands
 * out — settle: with its own answer, with `browser has disconnected: …` the moment the transport is
 * lost, or with a named timeout when it carried no timeout of its own and never answered.
 *
 * The journeys' retry (`product-journeys.e2e.test.ts#withProduct`) already reruns a journey whose
 * browser vanished; this is what turns a SILENT loss into that error instead of a hang.
 */
function guardBrowserTransport<T extends object>(target: T, transport: BrowserTransport): T {
  browserTransports.set(target, transport);
  const wrap = (value: unknown): unknown => (isPlaywrightObject(value) ? guard(value) : value);
  const unwrap = (value: unknown): unknown =>
    typeof value === 'object' && value !== null ? (guardedTargets.get(value) ?? value) : value;
  const settle = (name: string, pending: Promise<unknown>, args: readonly unknown[]): Promise<unknown> => {
    const ceiling = callCeiling(args);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const silent = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${name} did not settle within ${String(ceiling)}ms: the browser stopped answering`)),
        ceiling,
      );
    });
    const stopWatching = watchPendingCall(name, transport);
    return Promise.race([pending.then(wrap), transport.lost, silent]).finally(() => {
      clearTimeout(timer);
      stopWatching();
    });
  };
  const proxies = new WeakMap<object, object>();
  const guard = (object: object): object => {
    const known = proxies.get(object);
    if (known !== undefined) return known;
    const proxy = new Proxy(object, {
      get(raw, property) {
        const value = Reflect.get(raw, property, raw) as unknown;
        if (typeof value !== 'function')
          return typeof property === 'string' && GUARDED_PROPERTIES.has(property) ? wrap(value) : value;
        return (...args: unknown[]): unknown => {
          const inputs = args.map(unwrap);
          const result = (value as (...input: unknown[]) => unknown).apply(raw, inputs);
          if (!(result instanceof Promise)) return wrap(result);
          return settle(`${raw.constructor.name}.${String(property)}`, result, inputs);
        };
      },
    });
    proxies.set(object, proxy);
    guardedTargets.set(proxy, object);
    browserTransports.set(proxy, transport);
    return proxy;
  };
  return guard(target) as T;
}
/**
 * Close one browser, and if Playwright's `close()` never settles, end that browser's own processes.
 *
 * Seen in full-tier runs: `browser.close()` hung, and the teardown behind it never ran. The processes
 * ended are exactly the ones `launchChromiumWithRetry` recorded for this browser, so no other browser,
 * in this journey, a later one or another run on the host, is ever touched.
 */
export async function closeChromeBounded(browser: { close(): Promise<void> }): Promise<void> {
  const transport = browserTransports.get(browser);
  if (transport !== undefined) transport.closing = true;
  const closed = await Promise.race([browser.close().then(() => true), Bun.sleep(8_000).then(() => false)]).catch(
    () => false,
  );
  if (closed) return;
  // ONLY this browser's processes. Ending every Chrome this process had started killed the NEXT
  // journey's live browser (SIGKILL, seen on a hosted runner) when an earlier close never settled.
  for (const child of browserProcesses.get(browser) ?? []) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

/**
 * Take an EVIDENCE screenshot, and never let one fail a journey.
 *
 * Seen under load: Chrome's `screenshot` occasionally hangs for its full 30 seconds while the page is
 * otherwise healthy. A screenshot asserts nothing — the journeys' assertions and the margin probe are
 * DOM reads — so it gets a short timeout and one retry, and a capture that still fails is reported to
 * the caller rather than thrown. A page that has really closed is not hidden by this: the journey's
 * next real step fails on it.
 */
export async function evidenceScreenshot(
  page: { screenshot(options: { path: string; timeout?: number }): Promise<unknown> },
  path: string,
): Promise<string | null> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await page.screenshot({ path, timeout: 10_000 });
      return null;
    } catch (error) {
      if (attempt === 2) return String((error as Error).message ?? error).split('\n')[0] ?? 'screenshot failed';
      await Bun.sleep(500);
    }
  }
  return null;
}
