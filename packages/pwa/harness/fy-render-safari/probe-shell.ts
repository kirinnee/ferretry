/**
 * The probe bootstrap: the only script the probe document is allowed to run.
 *
 * IT IS NOT A MODIFIED PRODUCTION BOOTSTRAP. It is a different script living in a
 * document that is byte-identical to the generated shell apart from this script
 * and its hash. That is the honest minimum: there is no `'unsafe-inline'` in the
 * shipped policy, so "the production shell plus injected probe code" is not a
 * document that can exist, and the probe cannot ride inside the real bootstrap
 * without changing bytes the proof is supposed to be measuring.
 *
 * WHAT IT DOES: performs the production handshake (identical message shape, so the
 * parent's shipped parser accepts it), then aims every sink the frame could
 * possibly reach at a per-run unguessable path on the harness server and reports
 * what happened. It reports OUTCOMES — "no value", "nothing read back",
 * "returned null" — and never exception types, because WebKit's wording differs
 * from Chromium's and Safari may silently no-op where Chromium throws. An
 * assertion on a message is an assertion that breaks when a browser rewords it.
 *
 * IT NEVER DECIDES ANYTHING. Every verdict is the driver's, from the server's
 * request ledger and from the report below. `securitypolicyviolation` events are
 * forwarded as corroboration for a human to read; no check is written against
 * them, because engines differ on whether a given block reports and a check on an
 * absent field passes.
 */

interface ProbeShellConfig {
  /** `http://127.0.0.1:<port>/leak/<frame nonce>` — present in no other bundle. */
  readonly leakBase: string;
  readonly probes: readonly string[];
  readonly policyControlProbe: string;
}

declare const __FY_RENDER_PROBE_SHELL_CONFIG__: ProbeShellConfig;

type Outcome = string;

interface ViolationRecord {
  readonly effectiveDirective: string;
  readonly blockedURI: string;
}

(() => {
  const config = __FY_RENDER_PROBE_SHELL_CONFIG__;
  const parentWindow: Window = window.parent;
  const postToParent = window.parent.postMessage.bind(window.parent);
  const listen = window.addEventListener.bind(window);
  const unlisten = window.removeEventListener.bind(window);

  const violations: ViolationRecord[] = [];
  // FIRST, before anything else can be refused. Corroboration only.
  listen('securitypolicyviolation', event => {
    const violation = event as SecurityPolicyViolationEvent;
    violations.push({ blockedURI: violation.blockedURI, effectiveDirective: violation.effectiveDirective });
  });

  const leak = (probe: string, suffix = ''): string => `${config.leakBase}/${probe}${suffix}`;

  /**
   * Every attempt is bounded here so one refusal cannot end the run.
   *
   * Both outcomes are RECORDED AND NEITHER IS ASSERTED. Whether a sink throws
   * synchronously or silently does nothing is engine-specific — Chromium throws
   * `SecurityError` on a top-navigation assignment where a no-op would be equally
   * correct — so the verdict is always the server ledger's silence, never this
   * string. It is here for a human reading the artifact.
   */
  const attempt = (run: () => unknown): Outcome => {
    try {
      run();
      return 'attempted';
    } catch {
      return 'refused-synchronously';
    }
  };

  const evaluated = (): Readonly<Record<string, Outcome>> => {
    const viaEval = ((): Outcome => {
      try {
        // biome-ignore lint/security/noGlobalEval: this probe exists to prove the engine refuses it.
        const value: unknown = eval('1+1');
        return value === 2 ? 'evaluated' : 'no-value';
      } catch {
        return 'no-value';
      }
    })();
    const viaConstructor = ((): Outcome => {
      try {
        const made = new Function('return 1+1') as () => unknown;
        return made() === 2 ? 'evaluated' : 'no-value';
      } catch {
        return 'no-value';
      }
    })();
    return { eval: viaEval, functionConstructor: viaConstructor };
  };

  const TOKEN = 'fy-render-probe';

  const sleep = (ms: number): Promise<void> => new Promise(resolve => window.setTimeout(resolve, ms));

  /** A mechanism that hangs must not hang the whole report. */
  const withTimeout = (work: Promise<Outcome>, ms: number): Promise<Outcome> =>
    Promise.race([work, sleep(ms).then((): Outcome => 'no-effect')]);

  /**
   * ASYNCHRONOUS MECHANISMS ARE WRITTEN AND READ BACK FOR REAL.
   *
   * An earlier version started the async work and then read `null` unconditionally,
   * which passes whether or not anything persisted — the exact shape of vacuous
   * green this whole job exists to avoid. Both of these now complete a write, read
   * it back, and delete what they made, so a retained value is reported as retained.
   *
   * `unavailable` is reported separately from `no-effect` on purpose: an API the
   * engine does not expose here is a different fact from an API that accepted a
   * write and kept nothing, and collapsing the two would let "the feature is
   * missing" read as "the sandbox denied it".
   */
  const indexedDbOutcome = async (): Promise<Outcome> => {
    try {
      const factory = window.indexedDB;
      if (factory === undefined || factory === null) return 'unavailable';
      const database = await new Promise<IDBDatabase>((settle, reject) => {
        const request = factory.open(TOKEN, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('probe');
        request.onsuccess = () => settle(request.result);
        request.onerror = () => reject(request.error ?? new Error('open failed'));
        request.onblocked = () => reject(new Error('blocked'));
      });
      await new Promise<void>((settle, reject) => {
        const transaction = database.transaction('probe', 'readwrite');
        transaction.objectStore('probe').put(TOKEN, TOKEN);
        transaction.oncomplete = () => settle();
        transaction.onerror = () => reject(transaction.error ?? new Error('write failed'));
        transaction.onabort = () => reject(new Error('aborted'));
      });
      const readBack = await new Promise<unknown>((settle, reject) => {
        const transaction = database.transaction('probe', 'readonly');
        const request = transaction.objectStore('probe').get(TOKEN);
        request.onsuccess = () => settle(request.result);
        request.onerror = () => reject(request.error ?? new Error('read failed'));
      });
      database.close();
      factory.deleteDatabase(TOKEN);
      return readBack === TOKEN ? 'retained:indexedDB' : 'no-effect';
    } catch {
      return 'no-effect';
    }
  };

  const cachesOutcome = async (): Promise<Outcome> => {
    try {
      const store = window.caches;
      if (store === undefined || store === null) return 'unavailable';
      const cache = await store.open(TOKEN);
      // `put` stores a response; it issues no request, so this cannot itself leak.
      await cache.put(`/${TOKEN}`, new Response(TOKEN));
      const hit = await cache.match(`/${TOKEN}`);
      const body = hit === undefined ? '' : await hit.text();
      await store.delete(TOKEN);
      return body === TOKEN ? 'retained:caches' : 'no-effect';
    } catch {
      return 'no-effect';
    }
  };

  /**
   * WRITE, THEN READ BACK. Safari has historically returned empty values or
   * silently no-opped for partitioned or blocked storage rather than raising, so
   * "it threw" is not a portable verdict and "nothing came back" is.
   */
  const storage = async (): Promise<Readonly<Record<string, Outcome>>> => {
    const synchronous = (label: string, write: () => void, read: () => unknown): Outcome => {
      try {
        write();
      } catch {
        return 'no-effect';
      }
      try {
        const value = read();
        return value === null || value === undefined || value === '' ? 'no-effect' : `retained:${label}`;
      } catch {
        return 'no-effect';
      }
    };
    return {
      caches: await withTimeout(cachesOutcome(), 4_000),
      cookie: synchronous(
        'cookie',
        () => {
          // biome-ignore lint/suspicious/noDocumentCookie: the probe exists to prove this write retains nothing.
          document.cookie = `=`;
        },
        () => (document.cookie.includes(TOKEN) ? document.cookie : ''),
      ),
      indexedDB: await withTimeout(indexedDbOutcome(), 4_000),
      localStorage: synchronous(
        'localStorage',
        () => window.localStorage.setItem(TOKEN, TOKEN),
        () => window.localStorage.getItem(TOKEN),
      ),
      sessionStorage: synchronous(
        'sessionStorage',
        () => window.sessionStorage.setItem(TOKEN, TOKEN),
        () => window.sessionStorage.getItem(TOKEN),
      ),
    };
  };

  const parentReads = (): Readonly<Record<string, Outcome>> => {
    const read = (get: () => unknown): Outcome => {
      try {
        const value = get();
        return typeof value === 'string' && value.length > 0 ? `readable:${value.slice(0, 120)}` : 'unreadable';
      } catch {
        return 'unreadable';
      }
    };
    return {
      location: read(() => parentWindow.location.href),
      title: read(() => (parentWindow as unknown as { document?: Document }).document?.title),
      topLocation: read(() => window.top?.location.href),
    };
  };

  /** Every subresource and egress sink, one unguessable path each. */
  const sinks = (): Readonly<Record<string, Outcome>> => {
    const results: Record<string, Outcome> = {};
    const run = (probe: string, action: () => unknown): void => {
      results[probe] = attempt(action);
    };

    run('external-script', () => {
      const element = document.createElement('script');
      element.src = leak('external-script', '.js');
      document.body.appendChild(element);
      return element;
    });
    run('image', () => {
      const image = new Image();
      image.src = leak('image', '.png');
      return image;
    });
    run('stylesheet', () => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = leak('stylesheet', '.css');
      document.head.appendChild(link);
      return link;
    });
    run('css-import', () => {
      const style = document.createElement('style');
      style.textContent = `@import url("${leak('css-import', '.css')}");`;
      document.head.appendChild(style);
      return style;
    });
    run('nested-iframe', () => {
      const frame = document.createElement('iframe');
      frame.src = leak('nested-iframe', '.html');
      document.body.appendChild(frame);
      return frame;
    });
    run('prefetch', () => {
      const link = document.createElement('link');
      link.rel = 'prefetch';
      link.href = leak('prefetch', '.bin');
      document.head.appendChild(link);
      return link;
    });
    run('fetch', () => {
      void fetch(leak('fetch', '.json'), { mode: 'no-cors' }).catch(() => undefined);
      return 'issued';
    });
    run('xhr', () => {
      const request = new XMLHttpRequest();
      request.open('GET', leak('xhr', '.json'), true);
      request.send();
      return request;
    });
    run('websocket', () => {
      const socket = new WebSocket(leak('websocket').replace(/^http/, 'ws'));
      return socket;
    });
    run('beacon', () => navigator.sendBeacon(leak('beacon', '.json'), 'probe'));
    run('anchor-ping', () => {
      const anchor = document.createElement('a');
      anchor.href = '#anchor-ping';
      anchor.ping = leak('anchor-ping');
      document.body.appendChild(anchor);
      anchor.click();
      return anchor;
    });
    return results;
  };

  const navigation = (): Readonly<Record<string, Outcome>> => {
    const results: Record<string, Outcome> = {};
    results['top-nav'] = attempt(() => {
      const top = window.top;
      if (top === null) return 'no-top';
      top.location.href = leak('top-nav');
      return 'assigned';
    });
    results.popup = ((): Outcome => {
      try {
        const opened = window.open(leak('popup'), '_blank');
        return opened === null ? 'null' : 'window';
      } catch {
        return 'null';
      }
    })();
    results.download = attempt(() => {
      const anchor = document.createElement('a');
      anchor.href = leak('download', '.bin');
      anchor.download = 'fy-render-probe.bin';
      document.body.appendChild(anchor);
      anchor.click();
      return anchor;
    });
    return results;
  };

  /**
   * THE THREE ORIGINS ARE NOT ONE FACT, and conflating them is how an opaque-origin
   * assertion ends up measuring nothing.
   *
   * `self.origin` is the serialization of the DOCUMENT's origin, so in a sandboxed
   * frame without `allow-same-origin` it is the literal string "null" — that is the
   * standard observation worth asserting. `location.origin` is derived from the
   * document's URL and therefore still reads as the harness origin even though the
   * document's origin is opaque; the Chromium probe in this same tree measures
   * exactly that pair. `document.origin` is non-standard and may be absent. All
   * three are reported; the driver asserts only the first.
   */
  const origins = (): Readonly<Record<string, Outcome>> => ({
    documentOrigin: (document as unknown as { origin?: string }).origin ?? 'absent',
    locationOrigin: window.location.origin,
    windowOrigin: typeof window.origin === 'string' ? window.origin : 'absent',
  });

  const egressReport = async () => ({
    declaredProbes: config.probes,
    evaluated: evaluated(),
    kind: 'probe-report' as const,
    navigation: navigation(),
    origins: origins(),
    parentReads: parentReads(),
    sinks: sinks(),
    storage: await storage(),
    violations,
  });

  let port: MessagePort | null = null;

  const onCommand = (send: (reply: unknown) => void, event: MessageEvent): void => {
    const data: unknown = event.data;
    if (data === null || typeof data !== 'object') return;
    const command = data as { kind?: unknown };
    if (command.kind === 'probe-egress') {
      void egressReport().then(send);
      return;
    }
    if (command.kind === 'probe-policy-control') {
      // The one document whose policy names the harness origin in `connect-src`.
      // If this request does not arrive, the emptiness above proves nothing.
      // CORS keeps this opaque frame from READING the response, which is expected
      // and irrelevant: the driver's verdict is the request's arrival in the ledger.
      void fetch(`${config.leakBase}/${config.policyControlProbe}`, { mode: 'no-cors' }).catch(() => undefined);
      send({ kind: 'probe-report', origins: origins(), policyControl: 'issued', violations });
      return;
    }
    if (command.kind === 'probe-watchdog') {
      // A well-formed PRODUCTION reply, so the parent's shipped parser accepts it —
      // and then nothing, ever. The hard watchdog must fire regardless.
      send({ height: 64, kind: 'rendered', width: 64 });
      return;
    }
  };

  const onGlobalMessage = (event: MessageEvent): void => {
    if (port !== null) return;
    // `event.origin` is the string "null" in an opaque-origin document and
    // authenticates nothing. Identity is the only real check.
    if (event.source !== parentWindow) return;
    const offered = event.ports.length > 0 ? event.ports[0] : undefined;
    if (offered === undefined) return;
    port = offered;
    const send = offered.postMessage.bind(offered);
    unlisten('message', onGlobalMessage);
    offered.onmessage = commandEvent => onCommand(send, commandEvent);
    offered.start();
  };

  listen('message', onGlobalMessage);
  postToParent({ kind: 'shell-ready' }, '*');
})();
