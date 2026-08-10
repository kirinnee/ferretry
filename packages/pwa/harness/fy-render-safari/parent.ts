/**
 * The parent half of the journey: the top document that frames the shell, holds
 * the capability port, and reports what it saw.
 *
 * IT REPORTS OBSERVATIONS AND DECIDES NOTHING. Every verdict is computed by the
 * Bun driver from these reports plus the server's request ledger, because a page
 * that scores itself is a page an engine bug can talk into a pass. What arrives
 * here is raw: which origin the parent saw, whether the production parser accepted
 * a message, how long a timer took to fire, what the frame said about its own
 * attempts.
 *
 * THE PARSER AND THE SVG GATE ARE THE SHIPPED ONES. `parseFyRenderSandboxMessage`
 * and `fyRenderMermaidSvg` are imported from `src/lib/fy-render.ts` and run here,
 * in Safari, over bytes a real opaque frame produced. That is the part of the
 * production parent this harness does not re-implement.
 *
 * WHAT IT DOES RE-IMPLEMENT, AND WHY THAT IS SAID OUT LOUD. The React component
 * `FyRenderSandbox` is not mounted. The bridge below mirrors its ordering exactly —
 * listener attached before `src` is assigned, `event.source` identity and never
 * `event.origin`, one global message then port-only, a ready timer the handshake
 * stands down and a hard timer nothing the frame sends can clear — and it uses the
 * same `FY_RENDER_SANDBOX_LIMITS` numbers. It is a faithful replica of the parent,
 * not the parent itself; the frame's bytes, by contrast, are the deployed ones.
 * The three things this harness measures that the component cannot expose — the
 * origin the parent received, a refused second channel, and the count of global
 * messages after the handshake — are the reason the replica exists.
 *
 * EVERY FIXED ASSET IS FETCHED ONCE FOR THE WHOLE RUN. Production fetches per
 * mount; fetching once here makes the request ledger unambiguous, because any
 * second request for a library path could then only have come from a frame. The
 * fetch OPTIONS are production's exactly — `cache`, `credentials`, `redirect` and
 * `signal` — and a gate in `documents.ts` reads both files and refuses to run when
 * the two key sets differ.
 */
import {
  FY_RENDER_LIMITS,
  FY_RENDER_SANDBOX_LIBRARIES,
  FY_RENDER_SANDBOX_LIMITS,
  fyRenderMermaidSvg,
  fyRenderReadBoundedText,
  parseFyRenderSandboxMessage,
} from '../../src/lib/fy-render.ts';
import {
  FY_RENDER_JOURNEY_LOTTIE_ANIMATION,
  FY_RENDER_JOURNEY_MERMAID_INIT_DIRECTIVE_SOURCE,
  FY_RENDER_JOURNEY_MERMAID_SOURCE,
} from '../../tests/fixtures/fy-render-journey.ts';

interface ParentConfig {
  /** Read from the production component, never retyped here. */
  readonly shellUrl: string;
  readonly sandboxAttribute: string;
  readonly probeShellUrl: string;
  readonly policyControlShellUrl: string;
  readonly neverReadyShellUrl: string;
  readonly absentShellUrl: string;
  readonly mermaidUrl: string;
  readonly mutatedMermaidUrl: string;
  readonly lottieUrl: string;
  /** Under the PARENT's nonce. The frame's nonce is in no bundle but the probe's. */
  readonly controlLeakUrl: string;
}

declare const __FY_RENDER_PARENT_CONFIG__: ParentConfig;

const config = __FY_RENDER_PARENT_CONFIG__;

type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

const sleep = (ms: number): Promise<void> => new Promise(resolve => window.setTimeout(resolve, ms));

const isRecord = (value: unknown): value is Record<string, Json> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Drops anything the WebDriver wire cannot carry, so a report never fails to serialise. */
const asJson = (value: unknown): Record<string, Json> => JSON.parse(JSON.stringify(value)) as Record<string, Json>;

/**
 * THE CONTROLLER THAT MAKES THE FETCH OUTLIVE NOTHING, and the one place this
 * replica's LIFETIME differs from production's on purpose.
 *
 * The component arms one `AbortController` per MOUNT, because it fetches per mount.
 * This arms one per RUN, because it fetches once per run — and it fetches once per
 * run so the request ledger can attribute any second request for a library path to
 * a frame rather than to the parent. The driver aborts it after the last step. The
 * option set is identical either way; the component's abort-on-unmount behaviour is
 * therefore NOT something this harness measures, and the artifact says so.
 */
const inflight = new AbortController();

/**
 * One fetch per fixed asset for the whole run — see the header note.
 *
 * THE OPTIONS AND THE READER ARE THE PRODUCTION ONES, all four of them.
 * `credentials: 'omit'` so no cookie or token rides along; `redirect: 'error'`
 * because the descriptor names a FIXED local path, so a redirect means the
 * deployment is misconfigured and following one silently would let a same-origin
 * request end up fetching bytes from somewhere else; `cache: 'no-cache'` to
 * revalidate, so a stale bundle cannot be pinned behind a hash change; and the abort
 * signal above. The body is read through the shipped `fyRenderReadBoundedText`
 * against the shipped per-library cap, so a truncated deploy or a captive-portal
 * login page fails before the allocation rather than after it.
 *
 * `documents.ts` reads the option KEYS out of this file and out of the component and
 * refuses to run when the two sets differ, so this list cannot silently fall behind
 * production again.
 */
const fetchOnce = (() => {
  const cache = new Map<string, Promise<string>>();
  return (url: string, maxBytes: number): Promise<string> => {
    const held = cache.get(url);
    if (held !== undefined) return held;
    const started = (async () => {
      const response = await fetch(url, {
        cache: 'no-cache',
        credentials: 'omit',
        redirect: 'error',
        signal: inflight.signal,
      });
      if (!response.ok) throw new Error(`${url} answered ${response.status}`);
      const read = await fyRenderReadBoundedText(response, maxBytes);
      if (!read.ok) throw new Error(`${url} was refused by the production bounded reader: ${read.reason}`);
      return read.text;
    })();
    cache.set(url, started);
    return started;
  };
})();

interface GlobalSighting {
  readonly origin: string;
  readonly sourceIsFrame: boolean;
  readonly parsedKind: string | null;
  readonly afterHandshake: boolean;
}

interface HandshakeOutcome {
  readonly ready: boolean;
  readonly elapsedMs: number;
  readonly reason: string | null;
}

interface Bridge {
  readonly frame: HTMLIFrameElement;
  /** Resolves with the handshake, or with what the ready timer wrote instead. */
  readonly handshake: Promise<HandshakeOutcome>;
  /** Resolves when the hard watchdog fires. Nothing the frame sends can clear it. */
  readonly hardWatchdog: Promise<number>;
  sightings(): readonly GlobalSighting[];
  send(command: unknown): void;
  /** The first port message carrying one of these kinds, or null on timeout. */
  awaitMessage(kinds: readonly string[], timeoutMs: number): Promise<Record<string, Json> | null>;
  /** Offers a SECOND global port and reports whether anything ever replied on it. */
  attemptSecondChannel(command: unknown, windowMs: number): Promise<boolean>;
  destroy(): void;
}

/**
 * Mounts a frame the way the production component mounts one.
 *
 * `hardDeadlineMs` is the caller's because the two block types bound different
 * things: Mermaid is a one-shot compile whose frame dies when it yields a diagram,
 * and Lottie has to stay alive to keep playing.
 */
const mount = (src: string, hardDeadlineMs: number): Bridge => {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', config.sandboxAttribute);
  frame.style.width = '320px';
  frame.style.height = '240px';
  frame.style.border = '0';
  document.body.appendChild(frame);

  const started = performance.now();
  const sightings: GlobalSighting[] = [];
  const inbox: Record<string, Json>[] = [];
  let port: MessagePort | null = null;
  let handshakeDone = false;
  let destroyed = false;

  let settleHandshake: (value: HandshakeOutcome) => void = () => undefined;
  const handshake = new Promise<HandshakeOutcome>(resolve => {
    settleHandshake = resolve;
  });
  let settleWatchdog: (value: number) => void = () => undefined;
  const hardWatchdog = new Promise<number>(resolve => {
    settleWatchdog = resolve;
  });

  /**
   * THE HARD WATCHDOG, armed at mount and cleared by exactly one thing: teardown.
   * No message clears it, which is the point — reporting success is the first thing
   * a runaway payload would do. Removing the frame is what the timer is FOR; a
   * timer that only reports is not a bound on anything.
   */
  const hardTimer = window.setTimeout(() => {
    settleWatchdog(Math.round(performance.now() - started));
    frame.remove();
  }, hardDeadlineMs);

  /** A different kind of timer: it bounds a handshake, so the handshake may stand it down. */
  const readyTimer = window.setTimeout(() => {
    settleHandshake({
      elapsedMs: Math.round(performance.now() - started),
      ready: false,
      reason: 'The illustration sandbox did not start, so the source is shown instead.',
    });
  }, FY_RENDER_SANDBOX_LIMITS.readyDeadlineMs);

  const onPortMessage = (event: MessageEvent): void => {
    const parsed = parseFyRenderSandboxMessage(event.data);
    // A shape the production parser refuses is itself an observation, so it is
    // recorded rather than dropped — the probe's own report is one such shape.
    if (parsed === null) {
      const raw: unknown = event.data;
      inbox.push({ ...(isRecord(raw) ? asJson(raw) : { kind: 'not-an-object' }), parsed: false });
      return;
    }
    inbox.push({ ...asJson(parsed), parsed: true });
  };

  const onGlobalMessage = (event: MessageEvent): void => {
    const parsed = parseFyRenderSandboxMessage(event.data);
    sightings.push({
      afterHandshake: handshakeDone,
      origin: String(event.origin),
      parsedKind: parsed === null ? null : parsed.kind,
      sourceIsFrame: event.source !== null && event.source === frame.contentWindow,
    });
    if (handshakeDone) return;
    // Identity, never origin — the origin here is the literal string "null".
    if (event.source === null || event.source !== frame.contentWindow) return;
    if (parsed === null || parsed.kind !== 'shell-ready') return;

    handshakeDone = true;
    window.clearTimeout(readyTimer);
    const channel = new MessageChannel();
    channel.port1.onmessage = onPortMessage;
    port = channel.port1;
    frame.contentWindow?.postMessage({ kind: 'init' }, '*', [channel.port2]);
    settleHandshake({ elapsedMs: Math.round(performance.now() - started), ready: true, reason: null });
  };

  window.addEventListener('message', onGlobalMessage);
  // LAST. An `<iframe src=…>` in markup starts loading before an effect can attach
  // a listener, and the shell announces itself during its first script.
  frame.src = src;

  return {
    attemptSecondChannel: async (command: unknown, windowMs: number) => {
      const channel = new MessageChannel();
      let replied = false;
      channel.port1.onmessage = () => {
        replied = true;
      };
      channel.port1.start();
      frame.contentWindow?.postMessage({ kind: 'init' }, '*', [channel.port2]);
      channel.port1.postMessage(command);
      await sleep(windowMs);
      channel.port1.close();
      return replied;
    },
    awaitMessage: async (kinds: readonly string[], timeoutMs: number) => {
      const deadline = performance.now() + timeoutMs;
      for (;;) {
        const index = inbox.findIndex(message => kinds.includes(String(message.kind)));
        if (index !== -1) {
          const [found] = inbox.splice(index, 1);
          return found ?? null;
        }
        if (performance.now() >= deadline) return null;
        await sleep(25);
      }
    },
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      window.clearTimeout(hardTimer);
      window.clearTimeout(readyTimer);
      window.removeEventListener('message', onGlobalMessage);
      port?.close();
      frame.remove();
    },
    frame,
    handshake,
    hardWatchdog,
    send: (command: unknown) => port?.postMessage(command),
    sightings: () => sightings,
  };
};

const handshakeReport = async (bridge: Bridge): Promise<Record<string, Json>> => {
  const result = await bridge.handshake;
  const first = bridge.sightings()[0];
  return {
    elapsedMs: result.elapsedMs,
    parsedKind: first?.parsedKind ?? null,
    ready: result.ready,
    readyDeadlineMs: FY_RENDER_SANDBOX_LIMITS.readyDeadlineMs,
    reason: result.reason,
    sawOrigin: first?.origin ?? null,
    sourceIsFrame: first?.sourceIsFrame ?? false,
  };
};

const globalTrafficReport = (bridge: Bridge): Record<string, Json> => ({
  globalMessagesAfterHandshake: bridge.sightings().filter(sighting => sighting.afterHandshake).length,
  globalMessagesTotal: bridge.sightings().length,
});

const renderMermaid = async (source: string, libraryUrl: string): Promise<Record<string, Json>> => {
  const bridge = mount(config.shellUrl, FY_RENDER_SANDBOX_LIMITS.mermaidDeadlineMs);
  try {
    const opened = await handshakeReport(bridge);
    if (opened.ready !== true) return { handshake: opened };
    const library = await fetchOnce(libraryUrl, FY_RENDER_SANDBOX_LIBRARIES.mermaid.maxBytes);
    bridge.send({ kind: 'render-mermaid', library, source, theme: 'light' });
    const reply = await bridge.awaitMessage(
      ['mermaid-svg', 'error'],
      FY_RENDER_SANDBOX_LIMITS.mermaidDeadlineMs - 2_000,
    );
    if (reply === null) return { handshake: opened, reply: 'none', ...globalTrafficReport(bridge) };
    if (reply.kind === 'error')
      return {
        handshake: opened,
        reply: 'error',
        replyMessage: typeof reply.message === 'string' ? reply.message : null,
        ...globalTrafficReport(bridge),
      };
    const svg = typeof reply.svg === 'string' ? reply.svg : '';
    const gate = fyRenderMermaidSvg(svg);
    return {
      admitted: gate.ok,
      gateReason: gate.ok ? null : gate.reason,
      handshake: opened,
      hasForeignObject: /<foreignObject[\s/>]/i.test(svg),
      hasScript: /<script[\s/>]/i.test(svg),
      parsedByProductionParser: reply.parsed === true,
      reply: 'mermaid-svg',
      svgBytes: new TextEncoder().encode(svg).byteLength,
      ...globalTrafficReport(bridge),
    };
  } finally {
    bridge.destroy();
  }
};

const steps: Readonly<Record<string, () => Promise<Record<string, Json>>>> = {
  /** Proves the ledger can see a request, before any empty leak set is believed. */
  'positive-control': async () => {
    await fetch(config.controlLeakUrl, { mode: 'no-cors' }).catch(() => undefined);
    return { issued: true };
  },

  'production-bridge': async (): Promise<Record<string, Json>> => {
    const bridge = mount(config.shellUrl, FY_RENDER_SANDBOX_LIMITS.mermaidDeadlineMs);
    try {
      const opened = await handshakeReport(bridge);
      if (opened.ready !== true) return { handshake: opened };
      const library = await fetchOnce(config.mermaidUrl, FY_RENDER_SANDBOX_LIBRARIES.mermaid.maxBytes);
      const command = { kind: 'render-mermaid', library, source: FY_RENDER_JOURNEY_MERMAID_SOURCE, theme: 'light' };
      // A SECOND global message offering a SECOND port. The frame took the first
      // one and removed its global listener, so nothing may ever answer on this.
      const secondChannelAnswered = await bridge.attemptSecondChannel(command, 1_500);
      // Liveness: the FIRST port must still answer, or "no reply on the second"
      // would only mean the frame had died.
      bridge.send(command);
      const reply = await bridge.awaitMessage(
        ['mermaid-svg', 'error'],
        FY_RENDER_SANDBOX_LIMITS.mermaidDeadlineMs - 4_000,
      );
      return {
        firstPortReply: reply === null ? 'none' : String(reply.kind),
        firstPortStillAnswers: reply !== null && reply.kind === 'mermaid-svg',
        handshake: opened,
        secondChannelAnswered,
        ...globalTrafficReport(bridge),
      };
    } finally {
      bridge.destroy();
    }
  },

  'mermaid-correct-hash': () => renderMermaid(FY_RENDER_JOURNEY_MERMAID_SOURCE, config.mermaidUrl),

  /**
   * The identical install primitive with one byte appended. The bundle's global
   * never appears, so the bootstrap reports that the library did not load — the
   * evidence is the missing global, never a thrown message.
   */
  'mermaid-wrong-hash': () => renderMermaid(FY_RENDER_JOURNEY_MERMAID_SOURCE, config.mutatedMermaidUrl),

  'mermaid-init-directive': () => renderMermaid(FY_RENDER_JOURNEY_MERMAID_INIT_DIRECTIVE_SOURCE, config.mermaidUrl),

  lottie: async (): Promise<Record<string, Json>> => {
    const bridge = mount(config.shellUrl, FY_RENDER_SANDBOX_LIMITS.lottieLifetimeMs);
    try {
      const opened = await handshakeReport(bridge);
      if (opened.ready !== true) return { handshake: opened };
      const library = await fetchOnce(config.lottieUrl, FY_RENDER_SANDBOX_LIBRARIES.lottie.maxBytes);
      bridge.send({
        kind: 'render-lottie',
        library,
        playing: false,
        source: JSON.stringify(FY_RENDER_JOURNEY_LOTTIE_ANIMATION),
      });
      const rendered = await bridge.awaitMessage(['rendered', 'error'], 20_000);
      bridge.send({ kind: 'set-playing', playing: true });
      const playing = await bridge.awaitMessage(['playing', 'error'], 5_000);
      return {
        handshake: opened,
        maxDimension: FY_RENDER_LIMITS.maxDimension,
        playing: playing === null ? null : playing,
        rendered: rendered === null ? null : rendered,
        ...globalTrafficReport(bridge),
      };
    } finally {
      bridge.destroy();
    }
  },

  'probe-egress': async (): Promise<Record<string, Json>> => {
    const bridge = mount(config.probeShellUrl, FY_RENDER_SANDBOX_LIMITS.lottieLifetimeMs);
    try {
      const opened = await handshakeReport(bridge);
      if (opened.ready !== true) return { handshake: opened };
      bridge.send({ kind: 'probe-egress' });
      const report = await bridge.awaitMessage(['probe-report'], 20_000);
      // Give every sink time to have issued a request, so an EMPTY ledger is a
      // measurement rather than a race.
      await sleep(2_000);
      return { handshake: opened, report: report ?? null, ...globalTrafficReport(bridge) };
    } finally {
      bridge.destroy();
    }
  },

  'policy-control': async (): Promise<Record<string, Json>> => {
    const bridge = mount(config.policyControlShellUrl, FY_RENDER_SANDBOX_LIMITS.lottieLifetimeMs);
    try {
      const opened = await handshakeReport(bridge);
      if (opened.ready !== true) return { handshake: opened };
      bridge.send({ kind: 'probe-policy-control' });
      const report = await bridge.awaitMessage(['probe-report'], 10_000);
      // CORS stops the opaque frame reading the response, which is expected and
      // irrelevant: the verdict is the ledger recording the request's ARRIVAL.
      await sleep(2_000);
      return { handshake: opened, report: report ?? null };
    } finally {
      bridge.destroy();
    }
  },

  'never-ready': async (): Promise<Record<string, Json>> => {
    const absent = mount(config.absentShellUrl, FY_RENDER_SANDBOX_LIMITS.mermaidDeadlineMs);
    let absentReport: Record<string, Json>;
    try {
      absentReport = await handshakeReport(absent);
    } finally {
      absent.destroy();
    }
    const inert = mount(config.neverReadyShellUrl, FY_RENDER_SANDBOX_LIMITS.mermaidDeadlineMs);
    try {
      return { absentShell: absentReport, scriptRefusedShell: await handshakeReport(inert) };
    } finally {
      inert.destroy();
    }
  },

  /**
   * The named defect, reproduced: a frame that completed the handshake and
   * delivered a well-formed `rendered` message is still torn down at the hard
   * deadline, because nothing the frame sends clears that timer.
   */
  watchdog: async (): Promise<Record<string, Json>> => {
    const bridge = mount(config.probeShellUrl, FY_RENDER_SANDBOX_LIMITS.mermaidDeadlineMs);
    try {
      const opened = await handshakeReport(bridge);
      if (opened.ready !== true) return { handshake: opened };
      bridge.send({ kind: 'probe-watchdog' });
      const rendered = await bridge.awaitMessage(['rendered'], 10_000);
      const firedAtMs = await bridge.hardWatchdog;
      return {
        firedAtMs,
        frameRemoved: bridge.frame.parentNode === null,
        handshake: opened,
        hardDeadlineMs: FY_RENDER_SANDBOX_LIMITS.mermaidDeadlineMs,
        renderedAcceptedByProductionParser: rendered !== null && rendered.parsed === true,
      };
    } finally {
      bridge.destroy();
    }
  },
};

(window as unknown as { __fyRenderJourney: unknown }).__fyRenderJourney = {
  /**
   * Called by the driver after the last step. It exercises the abort capability the
   * production component holds; by then every library fetch has resolved, so it
   * demonstrates the call and NOT the behaviour — which is why the artifact lists the
   * component's per-mount fetch lifecycle as something this harness does not measure.
   */
  abortLibraryFetches: (): boolean => {
    inflight.abort();
    return inflight.signal.aborted;
  },
  run: async (step: string): Promise<Record<string, Json>> => {
    const runner = steps[step];
    if (runner === undefined) throw new Error(`unknown journey step: ${step}`);
    return await runner();
  },
  steps: Object.keys(steps),
};

// Read by the driver's first `Execute Script` as proof the page and its bundle
// loaded at all — Safari reaching a loopback HTTP origin is one of the assumptions
// this job closes.
document.title = 'fy-render journey parent ready';
