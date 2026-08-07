/**
 * Everything about this proof that can be verified WITHOUT a browser, verified.
 *
 * IT IS NOT A SUBSTITUTE FOR THE SAFARI RUN AND CANNOT PRODUCE A PROOF VERDICT. It
 * writes its own artifact, `self-check.json`, and no property of the journey is
 * scored here. The reason it exists is narrow and real: the Safari leg only runs on
 * macOS, so on every other machine the parts of this harness that are ordinary
 * programming — policy extraction, hash byte order, probe-document construction,
 * `_headers` reading, request classification, the ledger's positive control, the
 * production parser accepting the probe's own replies, the artifact schema, and the
 * driver teardown — would otherwise be unverified until CI.
 *
 * THE WEBDRIVER LEG USES A STUB SERVER, AND THAT IS A CLIENT CHECK, NOT AN ENGINE
 * CHECK. It answers the nine endpoints so the client's request shapes, its readiness
 * poll and — the part that actually matters operationally — its `finally` teardown
 * can be exercised: Safari hosts one session at a time, so a leaked session breaks
 * the NEXT run rather than this one, which is exactly the kind of bug a CI-only
 * verification finds too late. It measures nothing about any browser and says so.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseFyRenderSandboxMessage } from '../../src/lib/fy-render.ts';
import { FY_RENDER_LEAK_PROBES } from '../../tests/fixtures/fy-render-journey.ts';
import {
  assertOnlyScriptSourcesChanged,
  buildProbeDocument,
  cspHash,
  escapeForInlineScript,
  neverReadyDocument,
  PRODUCTION_FRAME_COMPONENT,
  readDeployedShellHeaders,
  readGeneratedShell,
  readProductionFrameContract,
  substitutePolicy,
  verifyGeneratorAgreement,
  withConnectSource,
} from './documents.ts';
import { type LedgerRoute, startLedger } from './ledger.ts';
import { collectProperties } from './report.ts';
import { startWebDriver } from './webdriver.ts';

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const packageRoot = resolve(import.meta.dir, '../..');

/**
 * A generated shell built the way the real generator builds one, so the extraction
 * and hashing path is exercised against a document with the same shape rather than
 * against the megabyte-scale real bundles.
 */
const syntheticShell = (): { document: string; bootstrap: string } => {
  const bootstrap = escapeForInlineScript('(()=>{const s="</script>";console.log(s,"$&");})();');
  const hashes = [cspHash(bootstrap), 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', 'sha256-BBBB='];
  const policy = [
    "default-src 'none'",
    `script-src ${hashes.map(hash => `'${hash}'`).join(' ')}`,
    "style-src 'unsafe-inline'",
    'img-src data:',
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return {
    bootstrap,
    document: `<!doctype html>
<html lang="en">
  <head>
    <meta http-equiv="Content-Security-Policy" content="${policy}" />
  </head>
  <body>
    <div id="fy-render-stage"></div>
    <script>${bootstrap}</script>
  </body>
</html>
`,
  };
};

const refuses = (name: string, run: () => unknown): Check => {
  try {
    run();
    return { detail: 'it did not throw', name, ok: false };
  } catch (error) {
    return { detail: `refused with: ${String(error).slice(0, 180)}`, name, ok: true };
  }
};

const accepts = (name: string, run: () => unknown, detail: string): Check => {
  try {
    run();
    return { detail, name, ok: true };
  } catch (error) {
    return { detail: `unexpectedly refused: ${String(error).slice(0, 180)}`, name, ok: false };
  }
};

const documentChecks = (): readonly Check[] => {
  const synthetic = syntheticShell();
  const shell = readGeneratedShell(synthetic.document);
  const checks: Check[] = [];

  checks.push({
    detail: `extracted ${shell.scriptHashes.length} script hashes and a ${shell.bootstrap.length}-character bootstrap`,
    name: 'policy and bootstrap are extracted from the document',
    ok: shell.scriptHashes.length === 3 && shell.bootstrap === synthetic.bootstrap,
  });
  checks.push(
    accepts(
      'the harness derives the same bootstrap hash the generator wrote into the policy',
      () => verifyGeneratorAgreement(shell),
      `${shell.bootstrapHash} is in the policy's script-src`,
    ),
  );

  const probe = buildProbeDocument(shell, '(()=>{globalThis.__probe=1;const t="</script>";return t;})();');
  checks.push({
    detail: `the probe policy is ${probe.policy}`,
    name: 'the probe document swaps exactly one hash and one script',
    ok:
      probe.policy.includes(probe.scriptHash) &&
      !probe.policy.includes(shell.bootstrapHash) &&
      probe.document.includes(probe.script),
  });
  checks.push({
    detail: 'the escape is applied before the hash, and the escaped text carries no raw closer',
    name: 'the probe script is escaped before it is hashed',
    ok: !probe.script.includes('</script') && probe.scriptHash === cspHash(probe.script),
  });

  /**
   * Each of these is a widening a weaker assertion would have admitted, and each is
   * substituted for ONE token so the token COUNT still matches. A relaxation that
   * also changed the count would be refused by the length check and would prove
   * nothing about the source-shape check underneath it.
   */
  const expected = { added: probe.scriptHash, removed: shell.bootstrapHash };
  const probeSources = [`'${probe.scriptHash}'`, ...shell.scriptHashes.slice(1).map(hash => `'${hash}'`)];
  const withSources = (sources: readonly string[]): string =>
    shell.policy.replace(/script-src [^;]+/, `script-src ${sources.join(' ')}`);
  const relaxations: readonly (readonly [string, string])[] = [
    ["'unsafe-inline'", 'unsafe-inline'],
    ["'unsafe-eval'", 'unsafe-eval'],
    ["'strict-dynamic'", 'strict-dynamic'],
    ["'self'", 'self'],
    ['https:', 'a scheme'],
    ['example.test', 'a host'],
    ["'sha256-notbase64!'", 'a malformed hash'],
  ];
  for (const [source, label] of relaxations)
    checks.push(
      refuses(`a probe \`script-src\` in which one library hash became ${label} is refused`, () =>
        assertOnlyScriptSourcesChanged(shell.policy, withSources([...probeSources.slice(0, 2), source]), expected),
      ),
    );
  checks.push(
    refuses('a probe `script-src` that drops a library hash is refused', () =>
      assertOnlyScriptSourcesChanged(shell.policy, withSources(probeSources.slice(0, 2)), expected),
    ),
  );
  checks.push(
    refuses('a probe `script-src` that appends an extra hash is refused', () =>
      assertOnlyScriptSourcesChanged(shell.policy, withSources([...probeSources, "'sha256-CCCC='"]), expected),
    ),
  );
  checks.push(
    refuses('a probe `script-src` that keeps every hash but reorders them is refused', () =>
      assertOnlyScriptSourcesChanged(
        shell.policy,
        withSources([probeSources[0] ?? '', ...probeSources.slice(1).reverse()]),
        expected,
      ),
    ),
  );
  checks.push(
    refuses('a probe `script-src` that swaps the probe hash into the wrong slot is refused', () =>
      assertOnlyScriptSourcesChanged(
        shell.policy,
        withSources([`'${shell.bootstrapHash}'`, `'${probe.scriptHash}'`, probeSources[2] ?? '']),
        expected,
      ),
    ),
  );
  checks.push(
    refuses('a probe policy that changes a non-script directive is refused', () =>
      assertOnlyScriptSourcesChanged(shell.policy, probe.policy.replace('img-src data:', 'img-src *'), expected),
    ),
  );

  const policyControl = substitutePolicy(
    probe.document,
    probe.policy,
    withConnectSource(probe.policy, 'http://127.0.0.1:1'),
  );
  checks.push({
    detail: 'and it names the harness origin rather than `self`, which an opaque origin can never match',
    name: 'the policy-control document adds exactly one connect-src directive',
    ok: policyControl.includes('connect-src http://127.0.0.1:1') && !policyControl.includes("connect-src 'self'"),
  });

  const inert = neverReadyDocument(shell);
  checks.push({
    detail: 'so nothing in it can report ready, and its script hash is in no policy',
    name: 'the never-ready document keeps every byte but the script body',
    ok: !inert.includes(shell.bootstrap) && inert.includes(shell.policy),
  });

  return checks;
};

const contractChecks = async (): Promise<{ readonly shellUrl: string; readonly checks: readonly Check[] }> => {
  const componentPath = resolve(packageRoot, PRODUCTION_FRAME_COMPONENT);
  const source = await readFile(componentPath, 'utf8');
  const contract = readProductionFrameContract(source, PRODUCTION_FRAME_COMPONENT);
  return {
    checks: [
      {
        detail: `shell URL \`${contract.shellUrl}\`, sandbox \`${contract.sandboxAttribute}\``,
        name: 'the frame contract is read out of the production component',
        ok: contract.shellUrl.startsWith('/') && contract.sandboxAttribute.length > 0,
      },
      refuses('a component with no shell URL fails closed', () =>
        readProductionFrameContract(source.replace(/FY_RENDER_SHELL_URL\s*=\s*'/, 'RENAMED = "'), 'synthetic'),
      ),
      refuses('a component with no sandbox attribute fails closed', () =>
        readProductionFrameContract(source.replace(/\n(\s*)sandbox="/, '\n$1data-sandbox="'), 'synthetic'),
      ),
      refuses('a frame that gained `allow-same-origin` refuses to be measured', () =>
        readProductionFrameContract(
          source.replace(/\n(\s*)sandbox="([^"]+)"/, '\n$1sandbox="$2 allow-same-origin"'),
          'synthetic',
        ),
      ),
    ],
    shellUrl: contract.shellUrl,
  };
};

const headerChecks = async (shellUrl: string): Promise<readonly Check[]> => {
  const headersFile = await readFile(resolve(packageRoot, 'public/_headers'), 'utf8');
  const rule = readDeployedShellHeaders(headersFile, shellUrl);
  const checks: Check[] = [
    {
      detail: rule.headers.map(([name, value]) => `${name}: ${value}`).join(' | '),
      name: `the deployed ${shellUrl} rule is read from public/_headers`,
      ok: rule.headers.length > 0 && rule.detached.includes('Content-Security-Policy'),
    },
    refuses('a missing rule fails closed', () => readDeployedShellHeaders(headersFile, '/no-such-document.html')),
    refuses('a rule that does not detach the site policy fails closed', () =>
      readDeployedShellHeaders(headersFile.replace('  ! Content-Security-Policy\n', ''), shellUrl),
    ),
  ];
  // A comment at column zero inside a rule must be skipped rather than end the rule.
  const withComment = headersFile.replace(
    `${shellUrl}\n`,
    `${shellUrl}\n# a comment at column zero, which Cloudflare ignores\n`,
  );
  const commented = readDeployedShellHeaders(withComment, shellUrl);
  checks.push({
    detail: `read ${commented.headers.length} headers with a column-zero comment inside the rule`,
    name: 'a comment inside the rule does not truncate it',
    ok: commented.headers.length === rule.headers.length,
  });
  return checks;
};

const ledgerChecks = async (): Promise<readonly Check[]> => {
  const routes = new Map<string, LedgerRoute>();
  routes.set('/parent', { classification: 'harness', respond: () => new Response('parent') });
  const ledger = startLedger({
    controlNonce: 'cccc',
    controlProbe: 'control',
    frameNonce: 'ffff',
    leakProbes: FY_RENDER_LEAK_PROBES,
    policyControlProbe: 'policy-control',
    routes,
  });
  try {
    // THE POSITIVE CONTROL, proved the same way the real run proves it.
    await fetch(`${ledger.origin}/leak/cccc/control`);
    await fetch(`${ledger.origin}/parent`);
    await fetch(`${ledger.origin}/leak/ffff/fetch.json`);
    await fetch(`${ledger.origin}/leak/ffff/policy-control`);
    await fetch(`${ledger.origin}/leak/ffff/undeclared-sink`);
    await fetch(`${ledger.origin}/nobody-declared-this`);
    const entries = ledger.entries();
    const classes = entries.map(entry => entry.classification);
    const marked = ledger.mark();
    ledger.clear();
    return [
      {
        detail: `classified in arrival order as: ${classes.join(', ')}`,
        name: 'the ledger records and classifies every request in order',
        ok:
          classes.join(',') === 'control,harness,leak,policy-control,unexpected,unexpected' &&
          entries.every((entry, index) => entry.seq === index + 1),
      },
      {
        detail: `the frame's declared sink was named as \`${String(entries[2]?.probe)}\``,
        name: 'a declared sink under the frame nonce is attributed to that sink',
        ok: entries[2]?.probe === 'fetch',
      },
      {
        detail: `mark() was ${marked} and the ledger is now empty: ${ledger.entries().length === 0}`,
        name: 'the ledger can be marked and cleared',
        ok: marked === 7 && ledger.entries().length === 0,
      },
    ];
  } finally {
    await ledger.stop();
  }
};

/** The exact replies the probe bootstrap emits must be readable by the shipped parser. */
const parserChecks = (): readonly Check[] => {
  const ready = parseFyRenderSandboxMessage({ kind: 'shell-ready' });
  const rendered = parseFyRenderSandboxMessage({ height: 64, kind: 'rendered', width: 64 });
  const extraKey = parseFyRenderSandboxMessage({ height: 64, kind: 'rendered', theme: 'dark', width: 64 });
  const probeReport = parseFyRenderSandboxMessage({ kind: 'probe-report' });
  return [
    {
      detail: 'the probe performs the production handshake, so the shipped parser must accept it',
      name: "the probe's `shell-ready` is accepted",
      ok: ready?.kind === 'shell-ready',
    },
    {
      detail: 'this is the watchdog leg: a well-formed success that must not clear the hard timer',
      name: "the probe's `rendered` is accepted with exact keys",
      ok: rendered?.kind === 'rendered',
    },
    {
      detail: 'exact-key parsing, so a message carrying one extra field is refused whole',
      name: 'a `rendered` with an extra key is refused',
      ok: extraKey === null,
    },
    {
      detail: 'so the harness reads it from the raw data and records that the parser refused it',
      name: "the probe's own report is NOT a production message",
      ok: probeReport === null,
    },
  ];
};

const reportChecks = (): readonly Check[] => [
  refuses('a property nobody scored fails the artifact', () =>
    collectProperties([{ id: 'a', observers: ['parent'], steps: ['lottie'], title: 'a', verdict: 'v' }], new Map()),
  ),
  refuses('a scored id that is in no journey definition fails the artifact', () =>
    collectProperties([], new Map([['ghost', { evidence: [], outcome: 'pass' as const }]])),
  ),
  accepts(
    'a fully scored journey produces one result per property',
    () =>
      collectProperties(
        [{ id: 'a', observers: ['parent'], steps: ['lottie'], title: 'a', verdict: 'v' }],
        new Map([['a', { evidence: ['fact'], outcome: 'pass' as const }]]),
      ),
    'ids, titles and verdicts are carried from the shared journey definition',
  ),
];

/**
 * A stub W3C server, so the client's teardown is exercised somewhere other than CI.
 * It is a CLIENT check. It measures nothing about any browser.
 */
const driverChecks = async (): Promise<readonly Check[]> => {
  const script = `
const sessions = new Set();
let deleted = 0;
const server = Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.STUB_PORT), async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === '/status') return Response.json({ value: { ready: true, message: 'stub' } });
  if (url.pathname === '/session' && request.method === 'POST') {
    sessions.add('stub-session');
    return Response.json({ value: { sessionId: 'stub-session', capabilities: { browserName: 'stub', browserVersion: '0' } } });
  }
  if (url.pathname === '/session/stub-session' && request.method === 'DELETE') {
    deleted += 1;
    console.log('DELETED ' + deleted);
    return Response.json({ value: null });
  }
  return Response.json({ value: null });
} });
console.log('LISTENING ' + server.port);
setInterval(() => undefined, 1000);
`;
  const stubFile = join(process.env.TMPDIR ?? '/tmp', `fy-render-webdriver-stub-${process.pid}.ts`);
  await writeFile(stubFile, script, 'utf8');
  const probe = Bun.serve({ fetch: () => new Response('probe'), hostname: '127.0.0.1', port: 0 });
  const stubPort = probe.port;
  await probe.stop(true);
  if (stubPort === undefined) return [{ detail: 'no free port', name: 'the stub driver could not bind', ok: false }];

  // `startWebDriver` picks its own port, so the stub is exposed as a tiny shim
  // script the client can spawn exactly as it spawns `safaridriver`.
  const shim = join(process.env.TMPDIR ?? '/tmp', `fy-render-webdriver-shim-${process.pid}.sh`);
  await writeFile(
    shim,
    `#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo "stub webdriver 0.0.0"; exit 0; fi\nport="$2"; [ "$1" = "-p" ] || port="$3"\nSTUB_PORT="$port" exec ${Bun.which('bun') ?? 'bun'} run ${stubFile}\n`,
    { mode: 0o755 },
  );

  const handle = await startWebDriver({
    browserName: 'stub',
    diagnose: false,
    driverPath: shim,
    scriptTimeoutMs: 5_000,
  });
  const sessionId = handle.session.sessionId;
  const version = handle.driverVersion;
  await handle.stop();
  // Idempotent: the real journey's `finally` may run after an earlier failure has
  // already stopped it, and a second teardown must not throw.
  await handle.stop();
  const log = handle.diagnostics();
  return [
    {
      detail: `the client polled /status, created "${sessionId}" and read the version line "${version}"`,
      name: 'the WebDriver client opens a session against a stub W3C server',
      ok: sessionId === 'stub-session' && version.includes('stub webdriver'),
    },
    {
      detail: `the stub recorded: ${
        log
          .split('\n')
          .filter(line => line.startsWith('DELETED'))
          .join(', ') || 'nothing'
      }`,
      name: 'teardown deletes the session exactly once and is safe to call twice',
      ok: log.includes('DELETED 1') && !log.includes('DELETED 2'),
    },
  ];
};

export const runSelfCheck = async (artifactDirectory: string): Promise<number> => {
  const contract = await contractChecks();
  const groups: readonly (readonly [string, readonly Check[]])[] = [
    ['production frame contract', contract.checks],
    ['documents', documentChecks()],
    ['headers', await headerChecks(contract.shellUrl)],
    ['ledger', await ledgerChecks()],
    ['production parser', parserChecks()],
    ['artifact schema', reportChecks()],
    ['webdriver client', await driverChecks()],
  ];
  const checks = groups.flatMap(([group, entries]) => entries.map(entry => ({ ...entry, group })));
  const failed = checks.filter(check => !check.ok);

  for (const [group, entries] of groups) {
    console.log(`\n  ${group}`);
    for (const check of entries) console.log(`   ${check.ok ? '✅' : '❌'} ${check.name}\n      ${check.detail}`);
  }

  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(
    join(artifactDirectory, 'self-check.json'),
    `${JSON.stringify(
      {
        checks,
        note: 'This is NOT a Safari proof and scores no journey property. It verifies the parts of the harness that are ordinary programming, plus the WebDriver client against a stub server.',
        ok: failed.length === 0,
        platform: `${process.platform} ${process.arch}`,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  if (failed.length > 0) {
    console.error(`\n❌ ${failed.length} of ${checks.length} harness self-checks failed`);
    return 1;
  }
  console.log(`\n✅ ${checks.length} harness self-checks passed — this is not Safari evidence and scores no property`);
  return 0;
};
