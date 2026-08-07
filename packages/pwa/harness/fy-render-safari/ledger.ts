/**
 * The observer that cannot be talked out of it: a loopback server that records
 * every request it receives, in order, before deciding how to answer it.
 *
 * WHY A LEDGER AND NOT REQUEST INTERCEPTION. `safaridriver` implements WebDriver
 * classic only — no `page.route`, no `page.on('request')`, no CDP, no BiDi — so
 * the Chromium harness's "abort every off-origin request and assert none escaped"
 * has no Safari translation. This substitutes for it and is arguably stronger:
 * nothing is blocked, so a leak that happens is RECORDED rather than prevented,
 * and a positive control proves the recorder works before any empty set is read
 * as evidence.
 *
 * WHAT IT CANNOT SEE, stated plainly: a request to a third-party origin. The
 * frame's policy is `default-src 'none'` and no author code runs in it, so for
 * Slice B that costs nothing — but this design could never disprove an egress
 * claim about a frame that DOES run author code.
 *
 * ATTRIBUTION IS THE UNGUESSABLE PATH, NOT A HEADER. Safari sends no `Sec-Fetch-*`
 * headers, so "who made this request" cannot be read off the wire. Instead the
 * frame's sinks all live under a per-run nonce that exists nowhere but the probe
 * bootstrap's own bundle, and the parent's positive control uses a DIFFERENT
 * nonce. A request under the frame's nonce therefore has exactly one possible
 * author. `Sec-Fetch-*` and `Origin` are recorded when present, as corroboration
 * a human can read, and are never a verdict.
 *
 * A request to an unknown path is `unexpected` rather than ignored. A ledger whose
 * unknown bucket is silently empty proves nothing about the paths nobody thought
 * of.
 */
import type { FyRenderLeakProbe, FyRenderLedgerControl } from '../../tests/fixtures/fy-render-journey.ts';

type LedgerClass =
  /** The harness's own parent page and its script. */
  | 'harness'
  /** A shell document: the generated one or a document derived from it. */
  | 'shell'
  /** A library bundle the PARENT is supposed to fetch, exactly once each. */
  | 'fixed-asset'
  /** The parent's positive control, under the parent's nonce. */
  | 'control'
  /** The frame's fetch from the one probe document whose policy permits it. */
  | 'policy-control'
  /** A sink the frame aimed at us. Any entry here is a finding. */
  | 'leak'
  /** Noise the browser asks for on its own; Safari requests a favicon. */
  | 'noise'
  /** Anything nobody declared. Any entry here is a finding. */
  | 'unexpected';

export interface LedgerEntry {
  readonly seq: number;
  readonly method: string;
  readonly path: string;
  /** Milliseconds since the ledger started, so a run's ordering is readable. */
  readonly atMs: number;
  readonly classification: LedgerClass;
  /** The leak sink or control this path names, when it names one. */
  readonly probe: string | null;
  /**
   * Recorded, never asserted. Safari does not send `Sec-Fetch-*`; Chromium does,
   * so a Chromium run of the same journey carries richer provenance here and the
   * verdicts stay identical.
   */
  readonly provenance: Readonly<Record<string, string>>;
}

export interface LedgerRoute {
  readonly classification: LedgerClass;
  readonly respond: () => Response;
}

export interface LedgerOptions {
  /** Exact-path routes. Everything else is `unexpected` and answered 404. */
  readonly routes: ReadonlyMap<string, LedgerRoute>;
  /** Only the probe bootstrap's bundle contains this. */
  readonly frameNonce: string;
  /** Only the parent's bundle contains this. */
  readonly controlNonce: string;
  readonly leakProbes: readonly FyRenderLeakProbe[];
  /** The frame's one permitted control, served from the policy-control document. */
  readonly policyControlProbe: FyRenderLedgerControl;
  readonly controlProbe: FyRenderLedgerControl;
}

export interface Ledger {
  /** `http://127.0.0.1:<port>`, the only origin anything in this journey uses. */
  readonly origin: string;
  entries(): readonly LedgerEntry[];
  /** The sequence number the next request will take; a step window's lower bound. */
  mark(): number;
  /** Entries recorded at or after `seq`. */
  since(seq: number): readonly LedgerEntry[];
  /** Drops everything recorded so far. Used once, after the positive control. */
  clear(): void;
  stop(): Promise<void>;
}

const PROVENANCE_HEADERS = ['sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-user', 'origin'] as const;

export const startLedger = (options: LedgerOptions): Ledger => {
  const started = Date.now();
  let entries: LedgerEntry[] = [];
  let next = 1;

  const classify = (path: string): { classification: LedgerClass; probe: string | null } => {
    const framePrefix = `/leak/${options.frameNonce}/`;
    const controlPrefix = `/leak/${options.controlNonce}/`;
    if (path.startsWith(framePrefix)) {
      const probe = path.slice(framePrefix.length);
      if (probe === options.policyControlProbe) return { classification: 'policy-control', probe };
      const named = options.leakProbes.find(candidate => probe === candidate || probe.startsWith(`${candidate}.`));
      // A path under the frame's nonce that names no declared sink is still the
      // frame reaching us, so it is a finding — just not one of the ones designed.
      return named === undefined ? { classification: 'unexpected', probe } : { classification: 'leak', probe: named };
    }
    if (path.startsWith(controlPrefix)) {
      const probe = path.slice(controlPrefix.length);
      return probe === options.controlProbe
        ? { classification: 'control', probe }
        : { classification: 'unexpected', probe };
    }
    if (path === '/favicon.ico') return { classification: 'noise', probe: null };
    const route = options.routes.get(path);
    return route === undefined
      ? { classification: 'unexpected', probe: null }
      : { classification: route.classification, probe: null };
  };

  const server = Bun.serve({
    fetch: request => {
      const path = new URL(request.url).pathname;
      const { classification, probe } = classify(path);
      const provenance: Record<string, string> = {};
      for (const header of PROVENANCE_HEADERS) {
        const value = request.headers.get(header);
        if (value !== null) provenance[header] = value;
      }
      // RECORDED BEFORE IT IS ANSWERED. A route that threw while responding would
      // otherwise erase the fact that the request arrived at all.
      entries.push({
        atMs: Date.now() - started,
        classification,
        method: request.method,
        path,
        probe,
        provenance,
        seq: next,
      });
      next += 1;

      if (classification === 'leak' || classification === 'policy-control' || classification === 'control')
        // 204 so nothing the frame receives can influence what it does next.
        return new Response(null, { status: 204 });
      if (path === '/favicon.ico') return new Response(null, { status: 204 });
      const route = options.routes.get(path);
      if (route === undefined) return new Response('not found', { status: 404 });
      return route.respond();
    },
    hostname: '127.0.0.1',
    port: 0,
  });

  // `Bun.serve`'s port is optional because a unix-socket server has none. An
  // interpolated `undefined` would produce a URL that fails much later, so it is
  // narrowed here.
  const { port } = server;
  if (port === undefined) throw new Error('the ledger server bound no TCP port');

  return {
    clear: () => {
      entries = [];
    },
    entries: () => entries,
    mark: () => next,
    origin: `http://127.0.0.1:${port}`,
    since: (seq: number) => entries.filter(entry => entry.seq >= seq),
    stop: async () => {
      await server.stop(true);
    },
  };
};
