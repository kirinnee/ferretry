/**
 * The `fy-render` sandbox shell, proved in real Safari.
 *
 * A BUN PROGRAM, DELIBERATELY NOT A TEST. `bunfig.int.toml` roots the integration
 * tier at `packages` and CI runs it on Linux, so a `bun test` file for this would
 * either fail on a runner with no `/usr/bin/safaridriver` or — much worse — be
 * written to skip when Safari is absent, which is a green that proves nothing. And
 * the int ledger fails on the first LCOV path outside `src/adapters/`, so a test
 * importing anything from `harness/` would fail the gate on a PATH rather than on a
 * test. Keeping this a program means the Safari evidence never enters a coverage
 * tier at all, and both ledgers keep their exact populations.
 *
 * WHAT IT MEASURES THAT NOTHING ELSE DOES. The shipped policy has no
 * `'unsafe-inline'`: the shell installs its libraries by creating an inline
 * `<script>` whose text must match a build-time hash. That makes hash-gated
 * dynamic inline execution load-bearing in BOTH directions. If Safari refuses a
 * correctly-hashed one, every `fy-render` sandbox block renders nothing on every
 * Apple device — a product outage, not a security finding. If it accepts a wrongly
 * hashed one, the shell's whole security argument evaporates. Neither has been
 * measured anywhere else.
 *
 * ITS VERDICTS ARE OUTCOMES. Not one assertion reads an exception type, an error
 * message or a CSP directive name: WebKit's wording differs from Chromium's, Safari
 * may silently no-op where Chromium throws, and `safaridriver` offers no console
 * access at all — so a check on a directive name is a check that passes when the
 * field is `undefined`. Storage is proved by reading back, egress by a server-side
 * request ledger, and installation by the global appearing.
 *
 * IT FAILS CLOSED IN THREE PLACES, each of which would otherwise be a green run
 * measuring the wrong thing: a missing dedicated `_headers` rule for the shell (the
 * deployed document would be unframeable), a hash this harness derives differently
 * from the generator (the probe's script would be refused for a reason that is not
 * the engine), and a request ledger that cannot see its own positive control (an
 * empty leak set means nothing until a non-empty one has been demonstrated).
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildFyRenderShell, FY_RENDER_SHELL_ARTIFACTS } from '../../scripts/build-fy-render-libs.ts';
import { FY_RENDER_SANDBOX_LIBRARIES, FY_RENDER_SANDBOX_LIMITS } from '../../src/lib/fy-render.ts';
import {
  FY_RENDER_JOURNEY_PROPERTIES,
  FY_RENDER_JOURNEY_STEPS,
  FY_RENDER_LEAK_PROBES,
  FY_RENDER_LEDGER_CONTROLS,
  type FyRenderJourneyStep,
} from '../../tests/fixtures/fy-render-journey.ts';
import {
  assertReplicaFetchMatchesProduction,
  buildProbeDocument,
  neverReadyDocument,
  PRODUCTION_FRAME_COMPONENT,
  readDeployedShellHeaders,
  readFetchOptionKeys,
  readGeneratedShell,
  readProductionFrameContract,
  REPLICA_PARENT_SOURCE,
  substitutePolicy,
  verifyGeneratorAgreement,
  withConnectSource,
} from './documents.ts';
import { type Ledger, type LedgerEntry, type LedgerRoute, startLedger } from './ledger.ts';
import { collectProperties, type ProofReport, writeReport } from './report.ts';
import { runSelfCheck } from './self-check.ts';
import { startWebDriver } from './webdriver.ts';

const packageRoot = resolve(import.meta.dir, '../..');
const artifactDirectory = resolve(packageRoot, '.artifacts/safari-render');

/** Paths this harness owns. The shell's own URL comes from the production component. */
const PROBE_SHELL_URL = '/fy-render-probe.html';
const POLICY_CONTROL_URL = '/fy-render-policy-control.html';
const NEVER_READY_URL = '/fy-render-never-ready.html';
const ABSENT_SHELL_URL = '/fy-render-absent.html';
const MUTATED_MERMAID_URL = '/fy-render-mermaid-mutated.js';
/** Named once in the shared journey definition, so the ledger and the two bundles
 * cannot disagree about which paths are controls. */
const [CONTROL_PROBE, POLICY_CONTROL_PROBE] = FY_RENDER_LEDGER_CONTROLS;

const flag = (name: string): boolean => Bun.argv.includes(`--${name}`);
const option = (name: string, fallback: string): string => {
  const found = Bun.argv.find(argument => argument.startsWith(`--${name}=`));
  return found === undefined ? fallback : found.slice(`--${name}=`.length);
};

const htmlResponse = (body: string, headers: readonly (readonly [string, string])[]): Response =>
  new Response(body, {
    headers: { 'content-type': 'text/html; charset=utf-8', ...Object.fromEntries(headers.map(([n, v]) => [n, v])) },
  });

const scriptResponse = (body: string): Response =>
  new Response(body, { headers: { 'cache-control': 'no-cache', 'content-type': 'text/javascript; charset=utf-8' } });

const bundle = async (entry: string, define: Readonly<Record<string, string>>): Promise<string> => {
  const result = await Bun.build({
    define: { ...define },
    entrypoints: [resolve(import.meta.dir, entry)],
    // The generator's options, so the probe bootstrap is produced the same way the
    // production one is; the hash is only comparable if the pipeline is.
    format: 'iife',
    minify: true,
    splitting: false,
    target: 'browser',
  });
  if (!result.success) throw new Error(`❌ ${entry} did not build:\n${result.logs.join('\n')}`);
  const [artifact] = result.outputs;
  if (artifact === undefined) throw new Error(`❌ ${entry} produced no output`);
  return await artifact.text();
};

const parentDocument = (): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>fy-render journey parent</title>
    <style>
      body {
        margin: 0;
        font: 13px ui-sans-serif, system-ui, sans-serif;
      }
    </style>
  </head>
  <body>
    <script src="/parent.js"></script>
  </body>
</html>
`;

interface StepRecord {
  readonly step: FyRenderJourneyStep;
  readonly ok: boolean;
  readonly observations: Record<string, unknown>;
  readonly ledgerFrom: number;
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};

const nested = (value: unknown, key: string): Record<string, unknown> => record(record(value)[key]);

const main = async (): Promise<number> => {
  if (flag('self-check')) return await runSelfCheck(artifactDirectory);

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();

  /**
   * EVERYTHING THAT COULD THROW LIVES INSIDE THE `try`, and every fact the artifact
   * needs is held out here.
   *
   * The CI step uploads this artifact with `if: always()`, and `report.ts` says a
   * red run is the run whose facts matter most — so a setup failure, a driver that
   * never started, or a step that threw must still leave a bounded report behind.
   * Otherwise the promise is only kept for the failures that happen late.
   */
  let driverLog = '';
  let report: ProofReport | null = null;
  let probeDocumentText = '';
  let generatedShellText = '';
  let ledger: Ledger | null = null;
  let shellFacts: ProofReport['shell'] = {
    bootstrapHash: '',
    deployedHeaders: [],
    detachedHeaders: [],
    policy: '',
    probePolicy: '',
    probeScriptHash: '',
    scriptHashes: [],
  };
  let libraryFetchOptions: readonly string[] = [];
  let libraryFetchAborted = false;
  let driverPath = option('driver', '/usr/bin/safaridriver');
  let driverVersion = 'not started';
  let browserName = option('browser', 'safari');
  let browserVersion = 'no session';
  const partialSteps: { readonly step: string; readonly ok: boolean; readonly observations: unknown }[] = [];
  let partialLedger: readonly LedgerEntry[] = [];
  let thrown: string | null = null;
  const stop: (() => Promise<void>)[] = [];

  try {
    // 1. GENERATE, then measure what was generated. The policy, the hashes and the
    // bootstrap all come from this document; nothing about them is retyped here.
    const generated = await buildFyRenderShell();
    generatedShellText = generated.shell;
    const onDisk = await readFile(FY_RENDER_SHELL_ARTIFACTS.shell, 'utf8');
    if (onDisk !== generated.shell)
      throw new Error(
        '❌ the generated shell in memory differs from the one written to public/; the build is not reproducible',
      );
    const shell = readGeneratedShell(generated.shell);
    verifyGeneratorAgreement(shell);

    const mermaidBundle = await readFile(FY_RENDER_SHELL_ARTIFACTS.mermaid, 'utf8');
    const lottieBundle = await readFile(FY_RENDER_SHELL_ARTIFACTS.lottie, 'utf8');
    /**
     * ONE BYTE APPENDED, and it stays valid JavaScript on purpose: if the engine
     * ever admitted it, it would run and define the bundle's global. A mutation that
     * broke the syntax would produce the same silence for the wrong reason.
     */
    const mutatedMermaid = `${mermaidBundle};`;

    const componentSource = await readFile(resolve(packageRoot, PRODUCTION_FRAME_COMPONENT), 'utf8');
    const { shellUrl, sandboxAttribute } = readProductionFrameContract(componentSource, PRODUCTION_FRAME_COMPONENT);
    /**
     * The replica's library fetch must pass what production's passes. Read from both
     * sources so neither side is retyped, and checked BEFORE a browser is started:
     * a replica whose options have drifted measures a request the product does not
     * make, which is a green nobody should be given.
     */
    libraryFetchOptions = readFetchOptionKeys(componentSource, PRODUCTION_FRAME_COMPONENT);
    assertReplicaFetchMatchesProduction(
      libraryFetchOptions,
      readFetchOptionKeys(await readFile(resolve(packageRoot, REPLICA_PARENT_SOURCE), 'utf8'), REPLICA_PARENT_SOURCE),
    );
    const deployed = readDeployedShellHeaders(
      await readFile(resolve(packageRoot, 'public/_headers'), 'utf8'),
      shellUrl,
    );
    shellFacts = {
      ...shellFacts,
      bootstrapHash: shell.bootstrapHash,
      deployedHeaders: deployed.headers,
      detachedHeaders: deployed.detached,
      policy: shell.policy,
      scriptHashes: shell.scriptHashes,
    };

    // 2. The two nonces. The frame's exists in no bundle but the probe bootstrap's,
    // so a request under it has exactly one possible author; the parent's is
    // different precisely so the positive control cannot be mistaken for a leak.
    const frameNonce = randomBytes(16).toString('hex');
    const controlNonce = randomBytes(16).toString('hex');

    // 3. The ledger owns the port, so the routes are filled in after it is listening.
    // The map is read per request and nothing can request anything before the browser
    // is told the origin, which happens below.
    const routes = new Map<string, LedgerRoute>();
    ledger = startLedger({
      controlNonce,
      controlProbe: CONTROL_PROBE,
      frameNonce,
      leakProbes: FY_RENDER_LEAK_PROBES,
      policyControlProbe: POLICY_CONTROL_PROBE,
      routes,
    });
    const live = ledger;
    stop.push(async () => await live.stop());

    const probeBundle = await bundle('probe-shell.ts', {
      __FY_RENDER_PROBE_SHELL_CONFIG__: JSON.stringify({
        leakBase: `${live.origin}/leak/${frameNonce}`,
        policyControlProbe: POLICY_CONTROL_PROBE,
        probes: FY_RENDER_LEAK_PROBES,
      }),
    });
    const probe = buildProbeDocument(shell, probeBundle);
    probeDocumentText = probe.document;
    const policyControl = substitutePolicy(probe.document, probe.policy, withConnectSource(probe.policy, live.origin));

    const parentBundle = await bundle('parent.ts', {
      __FY_RENDER_PARENT_CONFIG__: JSON.stringify({
        absentShellUrl: ABSENT_SHELL_URL,
        controlLeakUrl: `${live.origin}/leak/${controlNonce}/${CONTROL_PROBE}`,
        lottieUrl: FY_RENDER_SANDBOX_LIBRARIES.lottie.url,
        mermaidUrl: FY_RENDER_SANDBOX_LIBRARIES.mermaid.url,
        mutatedMermaidUrl: MUTATED_MERMAID_URL,
        neverReadyShellUrl: NEVER_READY_URL,
        policyControlShellUrl: POLICY_CONTROL_URL,
        probeShellUrl: PROBE_SHELL_URL,
        sandboxAttribute,
        shellUrl,
      }),
    });

    const shellRoute = (body: string): LedgerRoute => ({
      classification: 'shell',
      // The DEPLOYED rule's headers, so this is the document Cloudflare would serve.
      respond: () => htmlResponse(body, deployed.headers),
    });
    routes.set('/parent', { classification: 'harness', respond: () => htmlResponse(parentDocument(), []) });
    routes.set('/parent.js', { classification: 'harness', respond: () => scriptResponse(parentBundle) });
    routes.set(shellUrl, shellRoute(generated.shell));
    routes.set(PROBE_SHELL_URL, shellRoute(probe.document));
    routes.set(POLICY_CONTROL_URL, shellRoute(policyControl));
    routes.set(NEVER_READY_URL, shellRoute(neverReadyDocument(shell)));
    // Declared so a 404 is a route rather than an unexplained `unexpected` entry.
    routes.set(ABSENT_SHELL_URL, {
      classification: 'shell',
      respond: () => new Response('not found', { status: 404 }),
    });
    routes.set(FY_RENDER_SANDBOX_LIBRARIES.mermaid.url, {
      classification: 'fixed-asset',
      respond: () => scriptResponse(mermaidBundle),
    });
    routes.set(FY_RENDER_SANDBOX_LIBRARIES.lottie.url, {
      classification: 'fixed-asset',
      respond: () => scriptResponse(lottieBundle),
    });
    routes.set(MUTATED_MERMAID_URL, { classification: 'fixed-asset', respond: () => scriptResponse(mutatedMermaid) });

    driverPath = option('driver', '/usr/bin/safaridriver');
    browserName = option('browser', 'safari');
    const handle = await startWebDriver({
      browserName,
      diagnose: flag('diagnose'),
      driverPath,
      // Longer than the longest step: the watchdog leg deliberately waits out the
      // production hard deadline, which is fifteen seconds by itself.
      scriptTimeoutMs: 90_000,
    });
    stop.push(async () => {
      driverLog = handle.diagnostics();
      await handle.stop();
    });
    const { session } = handle;
    // Recorded the moment they are known, so a later failure still names the engine
    // it was driving rather than leaving an artifact that says "no session".
    driverVersion = handle.driverVersion;
    browserName = String(session.capabilities.browserName ?? browserName);
    browserVersion = String(session.capabilities.browserVersion ?? 'unknown');

    await session.navigate(`${live.origin}/parent`);
    // A deterministic window, recorded for reproducibility. NOT a mobile
    // measurement: `safaridriver` has no device emulation, touch or user agent.
    await session.setWindowRect({ height: 900, width: 1280 });
    const title = await session.execute<string>('return document.title;');
    if (!title.includes('parent ready'))
      throw new Error(`❌ the parent page did not report in; Safari saw the title "${title}"`);

    const parentUrl = await session.currentUrl();
    const handlesBefore = await session.windowHandles();

    const runStep = async (step: FyRenderJourneyStep): Promise<StepRecord> => {
      const ledgerFrom = live.mark();
      const outcome = await session.executeAsync<{ ok: boolean; value?: unknown; error?: string }>(
        'var done = arguments[arguments.length - 1];' +
          'window.__fyRenderJourney.run(arguments[0]).then(' +
          'function (value) { done({ ok: true, value: value }); },' +
          'function (error) { done({ ok: false, error: String(error) }); });',
        [step],
      );
      const result: StepRecord = {
        ledgerFrom,
        observations: outcome.ok ? record(outcome.value) : { error: outcome.error ?? 'unknown failure' },
        ok: outcome.ok,
        step,
      };
      // Accumulated as it happens, so a step that throws later still leaves every
      // step before it in the artifact.
      partialSteps.push({ observations: result.observations, ok: result.ok, step });
      partialLedger = live.entries();
      return result;
    };

    const results = new Map<FyRenderJourneyStep, StepRecord>();
    const failures: string[] = [];

    // THE POSITIVE CONTROL COMES FIRST AND IS NOT NEGOTIABLE. Until a request has
    // been seen arriving, an empty leak set is not evidence of anything.
    results.set('positive-control', await runStep('positive-control'));
    const controlSeen = live.entries().some(entry => entry.classification === 'control');
    if (!controlSeen)
      throw new Error(
        '❌ the request ledger never recorded its own positive control. The recorder cannot see a request, so nothing else this run could report about egress would mean anything. Refusing to report a green.',
      );
    // Cleared so the journey's leak set starts empty; the control is already proved.
    live.clear();

    let urlAfterProbe = parentUrl;
    let handlesAfterProbe = handlesBefore;
    for (const step of FY_RENDER_JOURNEY_STEPS) {
      if (step === 'positive-control') continue;
      const result = await runStep(step);
      results.set(step, result);
      if (!result.ok) failures.push(`step ${step} threw in the page: ${String(result.observations.error)}`);
      if (step === 'probe-egress') {
        // Read straight after the step, from WebDriver rather than from the page.
        urlAfterProbe = await session.currentUrl();
        handlesAfterProbe = await session.windowHandles();
      }
    }

    // The abort capability the production component holds, exercised at the end of
    // the run. Every library fetch has resolved by now, so this demonstrates the call
    // and not the behaviour — `NOT_PROVEN` says exactly that.
    libraryFetchAborted = await session.execute<boolean>('return window.__fyRenderJourney.abortLibraryFetches();');

    const entries = live.entries();
    const leaks = entries.filter(entry => entry.classification === 'leak');
    const unexpected = entries.filter(entry => entry.classification === 'unexpected');
    /**
     * ATTRIBUTED TO ITS OWN STEP WINDOW, not merely present somewhere in the run.
     * The control is only a control if the request arrived while the document whose
     * policy permits it was the one on screen; a stray arrival at any other time
     * would be a finding rather than a control.
     */
    const policyControlWindow = live.since(results.get('policy-control')?.ledgerFrom ?? 0);
    const policyControlSeen = policyControlWindow.some(entry => entry.classification === 'policy-control');
    if (!policyControlSeen)
      failures.push(
        "the policy-control document's fetch never arrived during its own step, so an empty leak set cannot be attributed to the policy rather than to a probe that never fired",
      );
    for (const entry of unexpected) failures.push(`an undeclared path was requested: ${entry.method} ${entry.path}`);

    const leaked = (probe_: string): boolean => leaks.some(entry => entry.probe === probe_);
    const countFor = (path: string): number => entries.filter(entry => entry.path === path).length;
    const observationsFor = (step: FyRenderJourneyStep): Record<string, unknown> =>
      results.get(step)?.observations ?? {};

    const bridge = observationsFor('production-bridge');
    const bridgeHandshake = nested(bridge, 'handshake');
    const correct = observationsFor('mermaid-correct-hash');
    const wrong = observationsFor('mermaid-wrong-hash');
    const directive = observationsFor('mermaid-init-directive');
    const lottie = observationsFor('lottie');
    const egress = observationsFor('probe-egress');
    const egressReport = nested(egress, 'report');
    const evaluated = record(egressReport.evaluated);
    const storage = record(egressReport.storage);
    const parentReads = record(egressReport.parentReads);
    const navigation = record(egressReport.navigation);
    const neverReady = observationsFor('never-ready');
    const absentShell = nested(neverReady, 'absentShell');
    const refusedShell = nested(neverReady, 'scriptRefusedShell');
    const watchdog = observationsFor('watchdog');

    const globalAfter = (step: FyRenderJourneyStep): number =>
      Number(observationsFor(step).globalMessagesAfterHandshake ?? -1);

    const scored = new Map<string, { outcome: 'pass' | 'fail'; evidence: readonly string[] }>();
    const score = (id: string, pass: boolean, evidence: readonly string[]): void => {
      scored.set(id, { evidence, outcome: pass ? 'pass' : 'fail' });
      if (!pass) failures.push(id);
    };

    score(
      'shell-frames-under-sandbox',
      bridgeHandshake.ready === true &&
        bridgeHandshake.sourceIsFrame === true &&
        bridgeHandshake.parsedKind === 'shell-ready' &&
        Number(bridgeHandshake.elapsedMs) <= FY_RENDER_SANDBOX_LIMITS.readyDeadlineMs,
      [
        `the frame was mounted with sandbox="${sandboxAttribute}", read from the production component`,
        `\`shell-ready\` arrived after ${String(bridgeHandshake.elapsedMs)} ms (deadline ${FY_RENDER_SANDBOX_LIMITS.readyDeadlineMs} ms)`,
        `the production parser read it as \`${String(bridgeHandshake.parsedKind)}\`; \`event.source\` was the frame's own window: ${String(bridgeHandshake.sourceIsFrame)}`,
      ],
    );

    const origins = record(egressReport.origins);
    score('opaque-origin', bridgeHandshake.sawOrigin === 'null' && origins.windowOrigin === 'null', [
      `the parent received \`event.origin\` = ${JSON.stringify(bridgeHandshake.sawOrigin)}`,
      `the frame reported \`self.origin\` = ${JSON.stringify(origins.windowOrigin)} — the serialization of the document's ORIGIN, which is the standard observation`,
      `\`location.origin\` = ${JSON.stringify(origins.locationOrigin)} — derived from the document's URL, so it still reads as the harness origin; recorded, never asserted`,
      `\`document.origin\` = ${JSON.stringify(origins.documentOrigin)} — non-standard and may be absent; recorded, never asserted`,
    ]);

    score(
      'global-channel-closes-after-handshake',
      bridge.secondChannelAnswered === false && bridge.firstPortStillAnswers === true,
      [
        `a second global message offering a second port drew a reply: ${String(bridge.secondChannelAnswered)}`,
        `the first port still answered afterwards with \`${String(bridge.firstPortReply)}\`, so the frame was alive and had declined the second channel`,
      ],
    );

    const globalCounts = (['production-bridge', 'mermaid-correct-hash', 'lottie'] as const).map(globalAfter);
    score(
      'port-only-traffic',
      globalCounts.every(count => count === 0),
      [
        `global messages received after the handshake, per step: ${globalCounts.join(', ')}`,
        'every reply the parent acted on arrived on the paired port',
      ],
    );

    score(
      'mermaid-svg-accepted-by-production-gate',
      correct.reply === 'mermaid-svg' && correct.parsedByProductionParser === true && correct.admitted === true,
      [
        `the frame replied \`${String(correct.reply)}\` with ${String(correct.svgBytes)} bytes of SVG`,
        `\`parseFyRenderSandboxMessage\` accepted it: ${String(correct.parsedByProductionParser)}`,
        `\`fyRenderMermaidSvg\` admitted it: ${String(correct.admitted)}${correct.gateReason === null ? '' : ` (${String(correct.gateReason)})`}`,
      ],
    );

    score('correct-hash-inline-install-runs', correct.reply === 'mermaid-svg' && Number(correct.svgBytes) > 0, [
      'the shell installed the pinned bundle by creating an inline `<script>` and setting its text',
      `a diagram came back, so the bundle's global existed — ${String(correct.svgBytes)} bytes`,
      'the evidence is the global appearing; appending a script whose hash is absent does not throw',
    ]);

    score('wrong-hash-inline-install-does-not-run', wrong.reply === 'error', [
      'the identical primitive was handed the same bundle with one byte appended, which is still valid JavaScript',
      `the frame replied \`${String(wrong.reply)}\`, so the mutated bundle's global never appeared`,
      `the shell's own sentence was ${JSON.stringify(wrong.replyMessage)} — recorded, never asserted`,
    ]);

    /**
     * TWO REAL MERMAID INPUTS, ONE PRODUCTION INVARIANT. The ordinary diagram
     * proves the correctly hashed bundle installs and runs; the second uses syntax
     * only Mermaid can parse to ask for HTML labels. The shell extends Mermaid's
     * `secure` list with `htmlLabels`, so both must stay plain SVG. A future bundle
     * that emits a forbidden element still meets the independent production SVG-gate
     * fixtures; this browser proof must not pretend it did so today.
     */
    const mermaidResults = [
      ['ordinary diagram', correct],
      ['nested init directive', directive],
    ] as const;
    const safeMermaid = (result: Record<string, unknown>): boolean =>
      result.reply === 'mermaid-svg' &&
      result.parsedByProductionParser === true &&
      result.hasForeignObject === false &&
      result.hasScript === false &&
      result.admitted === true;
    score(
      'mermaid-ordinary-and-init-directive-stay-svg-safe',
      mermaidResults.every(([, result]) => safeMermaid(result)),
      [
        'the nested input asks for `htmlLabels: true` through a Mermaid init directive, so the real library—not a synthetic parser—decides whether the shell lock holds',
        ...mermaidResults.map(
          ([label, result]) =>
            `${label}: reply ${String(result.reply)}, parsed ${String(result.parsedByProductionParser)}, \`<foreignObject>\` ${String(result.hasForeignObject)}, \`<script>\` ${String(result.hasScript)}, admitted ${String(result.admitted)}${result.gateReason === null ? '' : ` (${String(result.gateReason)})`}`,
        ),
        'the separate production SVG-gate fixtures retain refusal coverage for forbidden elements; this property proves Mermaid does not produce one under the shipped configuration',
      ],
    );

    const rendered = record(lottie.rendered);
    const playing = record(lottie.playing);
    score(
      'lottie-renders-and-acknowledges-play',
      rendered.kind === 'rendered' &&
        rendered.parsed === true &&
        Number.isInteger(rendered.width) &&
        Number.isInteger(rendered.height) &&
        Number(rendered.width) >= 1 &&
        Number(rendered.height) >= 1 &&
        Number(rendered.width) <= Number(lottie.maxDimension) &&
        Number(rendered.height) <= Number(lottie.maxDimension) &&
        playing.kind === 'playing' &&
        playing.playing === true,
      [
        `\`rendered\` carried ${String(rendered.width)}×${String(rendered.height)}, within the production cap of ${String(lottie.maxDimension)}`,
        `the production parser accepted it: ${String(rendered.parsed)}`,
        `a later \`set-playing\` drew \`playing: ${String(playing.playing)}\``,
      ],
    );

    const assetCounts = [
      [FY_RENDER_SANDBOX_LIBRARIES.mermaid.url, countFor(FY_RENDER_SANDBOX_LIBRARIES.mermaid.url)],
      [FY_RENDER_SANDBOX_LIBRARIES.lottie.url, countFor(FY_RENDER_SANDBOX_LIBRARIES.lottie.url)],
      [MUTATED_MERMAID_URL, countFor(MUTATED_MERMAID_URL)],
    ] as const;
    score('frame-issues-no-library-request', assetCounts.every(([, count]) => count === 1) && unexpected.length === 0, [
      ...assetCounts.map(([path, count]) => `\`${path}\` was requested ${count} time(s) in the whole run`),
      'the parent fetches each fixed asset exactly once and reuses the bytes, so a second request could only be a frame',
      `the fetch passed production's own option set, read out of the component's source: {${libraryFetchOptions.join(', ')}} — \`redirect: 'error'\` included, so a redirected fixed path would be refused rather than followed`,
      `requests to undeclared paths: ${unexpected.length}`,
      `\`Sec-Fetch-*\` values seen: ${JSON.stringify(entries.flatMap(entry => Object.keys(entry.provenance)).filter((key, index, all) => all.indexOf(key) === index))} — recorded, never asserted`,
    ]);

    score(
      'eval-and-function-constructor-blocked',
      evaluated.eval === 'no-value' && evaluated.functionConstructor === 'no-value',
      [
        `\`eval('1+1')\` produced: ${String(evaluated.eval)}`,
        `\`new Function('return 1+1')()\` produced: ${String(evaluated.functionConstructor)}`,
        'the outcome is "no value"; no exception type is read',
      ],
    );

    score('dynamic-external-script-blocked', !leaked('external-script'), [
      'the frame appended a `<script src>` pointing at a path only it knows',
      `requests recorded for that path: ${leaks.filter(entry => entry.probe === 'external-script').length}`,
    ]);

    const subresourceSinks = [
      'image',
      'stylesheet',
      'css-import',
      'nested-iframe',
      'prefetch',
      'fetch',
      'xhr',
      'websocket',
      'beacon',
      'anchor-ping',
    ] as const;
    score(
      'forbidden-subresources-blocked',
      subresourceSinks.every(sink => !leaked(sink)),
      [
        `sinks aimed at the harness server: ${subresourceSinks.join(', ')}`,
        `requests recorded for any of them: ${leaks.filter(entry => subresourceSinks.some(sink => sink === entry.probe)).length}`,
        `the policy control from the same nonce space DID arrive: ${policyControlSeen}`,
      ],
    );

    const storageValues = Object.entries(storage);
    // `unavailable` is accepted and reported separately from `no-effect`: an API the
    // engine never exposed here is a different fact from one that took a write and
    // kept nothing, and only the second is the sandbox doing work.
    const retained = storageValues.filter(([, outcome]) => outcome !== 'no-effect' && outcome !== 'unavailable');
    score('storage-denied', storageValues.length >= 5 && retained.length === 0 && leaks.length === 0, [
      ...storageValues.map(([mechanism, outcome]) => `${mechanism}: ${String(outcome)}`),
      'each write is followed by a real read-back — IndexedDB and CacheStorage complete a write, read it back and delete it',
      'the verdict is "nothing retained", never "SecurityError"',
    ]);

    score(
      'parent-document-unreachable',
      parentReads.location === 'unreadable' &&
        parentReads.title === 'unreadable' &&
        parentReads.topLocation === 'unreadable',
      [
        `\`parent.location.href\`: ${String(parentReads.location)}`,
        `\`parent.document.title\`: ${String(parentReads.title)}`,
        `\`top.location.href\`: ${String(parentReads.topLocation)}`,
      ],
    );

    score('top-navigation-denied', urlAfterProbe === parentUrl && !leaked('top-nav'), [
      `WebDriver reported the session URL as \`${urlAfterProbe}\`; before the attempt it was \`${parentUrl}\``,
      `requests recorded for the top-nav path: ${leaks.filter(entry => entry.probe === 'top-nav').length}`,
    ]);

    score(
      'popups-and-downloads-denied',
      navigation.popup === 'null' &&
        handlesAfterProbe.length === handlesBefore.length &&
        !leaked('popup') &&
        !leaked('download'),
      [
        `\`window.open\` returned: ${String(navigation.popup)}`,
        `WebDriver window handles: ${handlesBefore.length} before, ${handlesAfterProbe.length} after`,
        `requests recorded for the popup path: ${leaks.filter(entry => entry.probe === 'popup').length}; for the download path: ${leaks.filter(entry => entry.probe === 'download').length}`,
      ],
    );

    const hardDeadline = FY_RENDER_SANDBOX_LIMITS.mermaidDeadlineMs;
    const firedAt = Number(watchdog.firedAtMs);
    score(
      'hard-watchdog-independent',
      absentShell.ready === false &&
        typeof absentShell.reason === 'string' &&
        refusedShell.ready === false &&
        typeof refusedShell.reason === 'string' &&
        watchdog.renderedAcceptedByProductionParser === true &&
        watchdog.frameRemoved === true &&
        firedAt >= hardDeadline &&
        firedAt <= hardDeadline + 5_000,
      [
        `a 404 shell fell back after ${String(absentShell.elapsedMs)} ms with: ${JSON.stringify(absentShell.reason)}`,
        `a shell whose script the engine refused fell back after ${String(refusedShell.elapsedMs)} ms with: ${JSON.stringify(refusedShell.reason)}`,
        `a frame that completed the handshake and delivered a well-formed \`rendered\` (production parser accepted it: ${String(watchdog.renderedAcceptedByProductionParser)}) was still removed at ${String(watchdog.firedAtMs)} ms against a hard deadline of ${hardDeadline} ms`,
        'nothing the frame sent could clear that timer; only teardown clears it',
      ],
    );

    const properties = collectProperties(FY_RENDER_JOURNEY_PROPERTIES, scored);
    report = {
      browserName,
      browserVersion,
      driverPath,
      driverVersion,
      durationMs: Date.now() - startedMs,
      failures,
      harnessOrigin: live.origin,
      ledger: entries,
      ledgerTruncated: false,
      libraryFetchAborted,
      libraryFetchOptions,
      notProven: NOT_PROVEN,
      ok: failures.length === 0,
      platform: `${process.platform} ${process.arch}`,
      properties,
      shell: { ...shellFacts, probePolicy: probe.policy, probeScriptHash: probe.scriptHash },
      startedAt,
      steps: [...results.values()].map(entry => ({ ok: entry.ok, observations: entry.observations, step: entry.step })),
    };
    return report.ok ? 0 : 1;
  } catch (error) {
    // A setup failure, a driver that never started, a step that threw: all of them
    // still owe the reader an artifact. Exit 2 distinguishes "the proof could not
    // run" from exit 1's "the proof ran and a property failed".
    thrown = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
    console.error(`\n❌ the Safari proof could not complete:\n${thrown}`);
    return 2;
  } finally {
    for (const teardown of stop.reverse()) await teardown().catch(() => undefined);
    const artifact: ProofReport =
      report ??
      ({
        browserName,
        browserVersion,
        driverPath,
        driverVersion,
        durationMs: Date.now() - startedMs,
        failures: [thrown ?? 'the proof ended without a report and without an error, which is itself a defect'],
        harnessOrigin: ledger?.origin ?? 'never started',
        ledger: partialLedger,
        ledgerTruncated: false,
        libraryFetchAborted,
        libraryFetchOptions,
        notProven: NOT_PROVEN,
        ok: false,
        platform: `${process.platform} ${process.arch}`,
        // No property was scored, and the artifact says so rather than implying a
        // pass by omission.
        properties: FY_RENDER_JOURNEY_PROPERTIES.map(property => ({
          evidence: ['the run ended before this property could be scored'],
          id: property.id,
          outcome: 'fail' as const,
          title: property.title,
          verdict: property.verdict,
        })),
        shell: shellFacts,
        startedAt,
        steps: partialSteps,
      } satisfies ProofReport);
    await writeReport(
      {
        directory: artifactDirectory,
        generatedShell: resolve(artifactDirectory, 'generated-shell.html'),
        probeShell: resolve(artifactDirectory, 'probe-shell.html'),
      },
      artifact,
      { driverLog, generatedShell: generatedShellText, probeShell: probeDocumentText },
    );
  }
};

/** Written into every artifact, so a green tick is never read as more than it is. */
const NOT_PROVEN: readonly string[] = [
  'Nothing about a PHYSICAL device. This is a hosted macOS runner: no Lockdown Mode, no real memory-pressure or JIT policy, no low-memory frame discard, no iCloud Private Relay, and no Home-Screen-installed PWA context.',
  'Nothing about mobile Safari. `safaridriver` has no device emulation, no touch and no user-agent control, so a narrow desktop window is not a phone.',
  'No CPU or memory bound. The watchdogs bound wall-clock lifetime only — how LONG a payload may compute, never how hard.',
  "Nothing about Cloudflare Pages' `_headers` precedence. This harness READS the deployed rule and serves it itself; that is not evidence about how Pages composes rules.",
  'Nothing about requests to third-party origins. The ledger sees only its own origin, so it could never disprove an egress claim about a frame that runs author code.',
  'Nothing about the Slice C channels. Self-navigation, prerender and WebRTC are deliberately outside this journey. No AUTHOR code runs in the frame, so no author reaches them — but a compromised trusted library would be code inside the frame and could, which is the residual the documentation already declares. A green here must not be read as "Slice C is safe in Safari" or as a bound on a compromised library.',
  'Nothing about element fullscreen, which is a Slice A control with its own policy layer and is a manual check on real hardware.',
  'Not the React parent component. The frame ran the deployed bytes and the message parser and SVG gate are the shipped functions, but the parent bridge is a faithful replica of `FyRenderSandbox` rather than the component itself.',
  "Not the component's per-mount fetch lifecycle. The replica passes production's exact option set — `redirect: 'error'` included, enforced by a source-to-source drift gate — and holds an `AbortController`, but it fetches once per RUN so the ledger can attribute a second library request to a frame. No redirect was served and no fetch was in flight when the abort ran, so neither the redirect refusal nor the abort-on-unmount behaviour is measured here; only the option set is.",
  'No CSP directive name is asserted anywhere. Safari offers no console access from outside the page, so `securitypolicyviolation` records are corroboration for a human and never a check.',
];

process.exitCode = await main();
