/**
 * Planted-violation tests for every §7.9 check (each check has a test that plants a violation and sees it found, and
 * a clean case that stays quiet). Fixture workspaces live under `scripts/gen/tests/.tmp/`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { contextFor, parseArgs } from '../lib/check.ts';
import type { Finding } from '../lib/graph.ts';
import { check as actRunner } from '../../validate/act-runner.ts';
import { appHookFindings } from '../../validate/app-hooks.ts';
import { check as shellProvides, shellProvidesFindings } from '../../validate/shell-provides.ts';
import { bannedIn, check as bannedGlobals } from '../../validate/banned-globals.ts';
import { check as contextImports } from '../../validate/context-imports.ts';
import { check as contractConsumes } from '../../validate/contract-consumes.ts';
import { check as contractGraph } from '../../validate/contract-graph.ts';
import { check as coreClosed } from '../../validate/core-closed.ts';
import { parity } from '../../../packages/core/kernel/testing/parity.ts';
import { readChanges } from '../../validate/descriptor-parity.ts';
import { check as glossary, glossaryFindings } from '../../validate/glossary.ts';
import {
  check as guarantees,
  enforcerSymbols,
  guaranteeFindings,
  ownerCheck as guaranteeOwner,
  parseJunit,
  parseTsv,
} from '../../validate/guarantees.ts';
import { check as hostFiles } from '../../validate/host-files.ts';
import { check as manifestMatch } from '../../validate/manifest-match.ts';
import { compatIn } from '../../validate/no-compat.ts';
import { formatsIn } from '../../validate/one-format.ts';
import { pinFindings } from '../../validate/pins.ts';
import { check as pluginGraph } from '../../validate/plugin-graph.ts';
import { check as portsPending } from '../../validate/ports-pending.ts';
import { readScopedIn } from '../../validate/read-scoped.ts';
import { check as registriesFresh } from '../../validate/registries-fresh.ts';
import { check as screenPaths, screenPathFindings } from '../../validate/screen-paths.ts';
import { check as words } from '../../validate/words.ts';
import { buildModel, generateGlobal, generatePackage, packageRegistryPath, writeFiles } from '../registries.ts';
import { type Fixture, type FixturePackage, LEAF, SDK, ZOD, fixture, routeDecl } from './fixture.ts';

const made: Fixture[] = [];
afterAll(() => {
  for (const f of made) f.dispose();
});
const ws = (
  packages: readonly FixturePackage[],
  options?: {
    pending?: readonly string[];
    pendingReasons?: Readonly<Record<string, readonly string[]>>;
    pendingHalves?: Readonly<Record<string, readonly string[]>>;
  },
): Fixture => {
  const f = fixture(packages, options);
  made.push(f);
  return f;
};
/** The Kernel as a fixture package: the generated command registry always carries its manifest (§9.6). */
const KERNEL_PACKAGE: FixturePackage = { id: 'kernel', core: true, halves: false };
const NO_BASE = { base: 'file:/nonexistent/ports-pending.json' };
const run = async (
  check: { run: (ctx: ReturnType<typeof contextFor>) => Promise<readonly Finding[]> },
  f: Fixture,
  extra = {},
) => check.run(contextFor(f.root, { ...NO_BASE, ...extra }));
const messages = (findings: readonly Finding[]): string => findings.map(x => `${x.where}: ${x.message}`).join('\n');

const implementedDaemon = (routes: readonly string[]): string =>
  `import { implementDaemon } from '${SDK}';\nimport { jsonResponse } from '${LEAF}';\nimport manifest from '../manifest.ts';\nexport default implementDaemon(manifest, { build: () => ({ routes: { ${routes
    .map(key => `'${key}': async () => jsonResponse({})`)
    .join(', ')} } }) } as never);\n`;

const withRoute = (id: string, extra: Partial<FixturePackage> = {}): FixturePackage => ({
  id,
  manifestImports: `import { route } from '${SDK}';`,
  manifest: `  actions: { routes: [${routeDecl(`GET /v1/${id}`)}] },`,
  ...extra,
});

// ─── manifest-match / ports-pending ───────────────────────────────────────────────────────────────────────────────

describe('manifest-match', () => {
  test('a half that implements exactly its manifest passes; a skeleton passes while pending', async () => {
    const f = ws([withRoute('alpha', { daemon: implementedDaemon(['GET /v1/alpha']) }), withRoute('beta')], {
      pending: ['alpha', 'beta'],
    });
    expect(messages(await run(manifestMatch, f))).toBe('');
  });
  test('planted: an undeclared route, a missing route, and a skeleton not in ports-pending', async () => {
    const f = ws([withRoute('alpha', { daemon: implementedDaemon(['GET /v1/extra']) }), withRoute('beta')], {
      pending: ['alpha'],
    });
    const found = messages(await run(manifestMatch, f));
    expect(found).toContain('implements undeclared routes "GET /v1/extra"');
    expect(found).toContain('misses routes "GET /v1/alpha"');
    expect(found).toContain('skeleton but beta is not in ports-pending.json');
  });
  test('a skeleton half that pendingHalves names passes though its package is not in pending (gate, vault)', async () => {
    const f = ws([withRoute('alpha', { daemon: implementedDaemon(['GET /v1/alpha']) }), withRoute('beta')], {
      pending: ['alpha'],
      pendingHalves: { beta: ['daemon', 'app', 'cli'] },
    });
    expect(messages(await run(manifestMatch, f))).not.toContain('beta is not in ports-pending.json');
  });
});

const ALL = ['daemon', 'app', 'cli'];

describe('ports-pending', () => {
  test('planted: the list grew, names a non-subsystem, and keeps a fully ported plugin', async () => {
    const ported = `import { implementApp, implementCli } from '${SDK}';`;
    const f = ws(
      [
        {
          id: 'alpha',
          daemon: `import { implementDaemon } from '${SDK}';\nimport manifest from '../manifest.ts';\nexport default implementDaemon(manifest, { build: () => ({}) });\n`,
          app: `${ported}\nimport manifest from '../manifest.ts';\nexport default implementApp(manifest, { build: () => ({}) });\n`,
          cli: `${ported}\nimport manifest from '../manifest.ts';\nexport default implementCli(manifest, { build: () => ({}) });\n`,
        },
        { id: 'beta' },
      ],
      { pending: ['alpha', 'beta', 'ghost'], pendingHalves: { beta: ALL } },
    );
    f.write('base.json', JSON.stringify({ format: 1, pending: ['alpha', 'ghost'] }));
    const found = messages(await run(portsPending, f, { base: `file:${join(f.root, 'base.json')}` }));
    expect(found).toContain('beta was added; the list may only shrink');
    expect(found).toContain('ghost is not a subsystem');
    expect(found).toContain('alpha has no skeleton half left');
  });
  test('a fully ported plugin stays listed only while it states what is still open', async () => {
    const ported = `import { implementApp, implementCli } from '${SDK}';`;
    const alpha = {
      id: 'alpha',
      daemon: `import { implementDaemon } from '${SDK}';\nimport manifest from '../manifest.ts';\nexport default implementDaemon(manifest, { build: () => ({}) });\n`,
      app: `${ported}\nimport manifest from '../manifest.ts';\nexport default implementApp(manifest, { build: () => ({}) });\n`,
      cli: `${ported}\nimport manifest from '../manifest.ts';\nexport default implementCli(manifest, { build: () => ({}) });\n`,
    };
    const base = JSON.stringify({ format: 1, pending: ['alpha'] });

    const stated = ws([alpha], {
      pending: ['alpha'],
      pendingReasons: { alpha: ['Edit as YAML waits for the kernel'] },
    });
    stated.write('base.json', base);
    expect(messages(await run(portsPending, stated, { base: `file:${join(stated.root, 'base.json')}` }))).toBe('');

    const unstated = ws([alpha], { pending: ['alpha'], pendingReasons: { alpha: [] } });
    unstated.write('base.json', base);
    expect(messages(await run(portsPending, unstated, { base: `file:${join(unstated.root, 'base.json')}` }))).toContain(
      'alpha has no skeleton half left',
    );

    const stray = ws([{ id: 'beta' }], {
      pending: ['beta'],
      pendingHalves: { beta: ALL },
      pendingReasons: { alpha: ['a reason for nobody'] },
    });
    stray.write('base.json', JSON.stringify({ format: 1, pending: ['beta'] }));
    expect(messages(await run(portsPending, stray, { base: `file:${join(stray.root, 'base.json')}` }))).toContain(
      'alpha has reasons but is not listed in "pending"',
    );
  });
  test('planted: a skeleton half pendingHalves does not name fails; so does a name for a real half', async () => {
    const real = (fn: string) =>
      `import { ${fn} } from '${SDK}';\nimport manifest from '../manifest.ts';\nexport default ${fn}(manifest, { build: () => ({}) });\n`;
    const alpha = {
      id: 'alpha',
      daemon: real('implementDaemon'),
      app: real('implementApp'),
      cli: real('implementCli'),
    };
    const base = JSON.stringify({ format: 1, pending: ['alpha', 'beta'] });
    const unnamed = ws([alpha, { id: 'beta' }], {
      pending: ['alpha', 'beta'],
      pendingHalves: { beta: ['daemon', 'app'] },
    });
    unnamed.write('base.json', base);
    const missing = messages(await run(portsPending, unnamed, { base: `file:${join(unnamed.root, 'base.json')}` }));
    expect(missing).toContain('cli half of beta is a skeleton but ports-pending.json pendingHalves does not name it');
    expect(missing).not.toContain('daemon half of beta');
    const overnamed = ws([alpha, { id: 'beta' }], {
      pending: ['alpha', 'beta'],
      pendingHalves: { alpha: ['app'], beta: ALL },
    });
    overnamed.write(
      'base.json',
      JSON.stringify({ format: 1, pending: ['alpha', 'beta'], pendingHalves: { alpha: ['app'], beta: ALL } }),
    );
    expect(
      messages(await run(portsPending, overnamed, { base: `file:${join(overnamed.root, 'base.json')}` })),
    ).toContain('pendingHalves names the app half of alpha, but it is a real half');
  });
  test('pendingHalves only shrinks: a re-added entry fails, the one-time correction passes', async () => {
    const f = ws([{ id: 'alpha' }, { id: 'catalogs' }], {
      pending: ['alpha', 'catalogs'],
      pendingHalves: { alpha: ['app'], catalogs: ['app'] },
    });
    f.write('base.json', JSON.stringify({ format: 1, pending: ['alpha', 'catalogs'] }));
    const found = messages(await run(portsPending, f, { base: `file:${join(f.root, 'base.json')}` }));
    expect(found).toContain('pendingHalves alpha app was added; pendingHalves may only shrink');
    expect(found).not.toContain('pendingHalves catalogs app was added');
  });
  test('pending only shrinks: a ruled id may re-enter only with a reason; any other new id fails', async () => {
    const base = JSON.stringify({ format: 1, pending: ['alpha'], pendingHalves: { alpha: ALL } });
    const stated = ws([{ id: 'alpha' }, { id: 'terminals' }], {
      pending: ['alpha', 'terminals'],
      pendingReasons: { terminals: ['GAP(ferrets): the tmux runner is not wired yet'] },
      pendingHalves: { alpha: ALL, terminals: ALL },
    });
    stated.write('base.json', base);
    const passing = messages(await run(portsPending, stated, { base: `file:${join(stated.root, 'base.json')}` }));
    expect(passing).not.toContain('terminals was added');
    expect(passing).not.toContain('terminals is back in "pending"');

    const silent = ws([{ id: 'alpha' }, { id: 'usage' }], {
      pending: ['alpha', 'usage'],
      pendingHalves: { alpha: ALL, usage: ALL },
    });
    silent.write('base.json', base);
    expect(messages(await run(portsPending, silent, { base: `file:${join(silent.root, 'base.json')}` }))).toContain(
      'usage is back in "pending" by a one-time ruling but states no "pendingReasons" line',
    );

    const unwired = ws([{ id: 'alpha' }, { id: 'access' }], {
      pending: ['alpha', 'access'],
      pendingReasons: { access: ['GAP(access): app/x.tsx is not reached by any screen (owner: nelly)'] },
      pendingHalves: { alpha: ALL, access: ALL },
    });
    unwired.write('base.json', base);
    const unwiredFound = messages(
      await run(portsPending, unwired, { base: `file:${join(unwired.root, 'base.json')}` }),
    );
    expect(unwiredFound).not.toContain('access was added');
    expect(unwiredFound).not.toContain('access is back in "pending"');

    const other = ws([{ id: 'alpha' }, { id: 'beta' }], {
      pending: ['alpha', 'beta'],
      pendingReasons: { beta: ['GAP(x): still open'] },
      pendingHalves: { alpha: ALL, beta: ALL },
    });
    other.write('base.json', base);
    expect(messages(await run(portsPending, other, { base: `file:${join(other.root, 'base.json')}` }))).toContain(
      'beta was added; the list may only shrink',
    );
  });
  test('a shrinking list of skeletons passes', async () => {
    const f = ws([{ id: 'beta' }], { pending: ['beta'], pendingHalves: { beta: ALL } });
    f.write('base.json', JSON.stringify({ format: 1, pending: ['alpha', 'beta'], pendingHalves: { beta: ALL } }));
    expect(messages(await run(portsPending, f, { base: `file:${join(f.root, 'base.json')}` }))).toBe('');
  });
});

// ─── graph checks ─────────────────────────────────────────────────────────────────────────────────────────────────

const portContract = (name: string): string =>
  `import { definePort } from '${LEAF}';\nexport const ${name}Port = definePort<{ ping(): void }>('${name}');\n`;

describe('plugin-graph', () => {
  test('planted: a missing provider, a start-order cycle, a security-path taker and two takers of one key', async () => {
    const hookContract = `import { z } from '${ZOD}';\nimport { defineHook } from '${LEAF}';\nexport const Keys = defineHook('gate.keys', { mode: 'provide', key: z.enum(['a', 'b']), takers: ['beta'] });\n`;
    const f = ws(
      [
        {
          id: 'gate',
          core: true,
          contract: hookContract,
          manifestImports: `import { Keys } from '../../core/gate/contract/index.ts';`,
          manifest: '  hooks: { offers: [{ hook: Keys }] },',
        },
        {
          id: 'alpha',
          contract: portContract('alpha'),
          manifestImports: `import { Keys } from '../../core/gate/contract/index.ts';\nimport { betaPort } from '../beta/contract/index.ts';`,
          manifest: `  needs: { beta: betaPort }, order: { after: ['beta'] }, hooks: { takes: [{ hook: Keys, key: 'a' }] },`,
        },
        {
          id: 'beta',
          contract: portContract('beta'),
          manifestImports: `import { Keys } from '../../core/gate/contract/index.ts';\nimport { gammaPort } from '../gamma/contract/index.ts';`,
          manifest: `  needs: { gamma: gammaPort }, order: { after: ['alpha'] }, hooks: { takes: [{ hook: Keys, key: 'a' }] },`,
        },
        { id: 'gamma', contract: portContract('gamma') },
      ],
      { pending: ['gate', 'alpha', 'beta', 'gamma'] },
    );
    const found = messages(await run(pluginGraph, f));
    expect(found).toContain('nothing provides it');
    expect(found).toContain('start-order cycle');
    expect(found).toContain('takes security-path hook "gate.keys"; its takers are beta');
    expect(found).toContain('two takers of provide key gate.keys:a');
    expect(found).toContain('kernel-bound port "admission" has 0 providers');
  });
});

describe('core-closed', () => {
  test('planted: a core manifest needs a port a plugin provides', async () => {
    const f = ws(
      [
        {
          id: 'gate',
          core: true,
          manifestImports: `import { alphaPort } from '../../plugins/alpha/contract/index.ts';`,
          manifest: '  needs: { alpha: alphaPort },',
        },
        {
          id: 'alpha',
          contract: portContract('alpha'),
          manifestImports: `import { alphaPort } from './contract/index.ts';`,
          manifest: '  provides: { alpha: alphaPort },',
        },
      ],
      { pending: ['gate', 'alpha'] },
    );
    expect(messages(await run(coreClosed, f))).toContain('needs "alpha", provided by plugin alpha');
  });
  test('a core that needs only core passes', async () => {
    const f = ws([{ id: 'gate', core: true }], { pending: ['gate'] });
    expect(messages(await run(coreClosed, f))).toBe('');
  });
});

// ─── import checks ────────────────────────────────────────────────────────────────────────────────────────────────

describe('context-imports', () => {
  test('app halves and their tests use only the public shell facilities; daemon halves and private paths are refused', async () => {
    const f = ws([
      {
        id: 'alpha',
        files: {
          'app/view.tsx': `import '@ferretry/app';\nimport '@ferretry/app/ui';\n`,
          'app/private.ts': `import '../../../app/src/private.ts';\n`,
          'app/testing.ts': `import '@ferretry/app/testing';\n`,
          'daemon/shell.ts': `import '@ferretry/app/ui';\n`,
          'tests/ui.test.ts': `import '@ferretry/app/testing';\nimport '@ferretry/app/ui';\n`,
        },
      },
    ]);
    f.write(
      'packages/app/package.json',
      JSON.stringify({
        name: '@ferretry/app',
        exports: { '.': './src/index.ts', './ui': './src/ui.ts', './testing': './src/testing.ts' },
      }),
    );
    for (const file of ['index.ts', 'ui.ts', 'testing.ts', 'private.ts'])
      f.write(`packages/app/src/${file}`, 'export {};\n');
    const found = messages(await run(contextImports, f));
    expect(found).not.toContain('alpha/app/view.tsx');
    expect(found).not.toContain('alpha/tests/ui.test.ts');
    expect(found).toContain('alpha/app/private.ts');
    expect(found).toContain('alpha/app/testing.ts');
    expect(found).toContain('alpha/daemon/shell.ts');
  });

  test('planted: a half reaches another package past its contract; a contract imports node:fs; a manifest imports a half', async () => {
    const f = ws(
      [
        {
          id: 'alpha',
          manifestImports: `import beta from '@ferretry/plugin-beta/daemon';`,
          contract: `import { readFileSync } from 'node:fs';\nexport const x = readFileSync;\n`,
          files: {
            'daemon/lib/x.ts': `import type { Y } from '@ferretry/plugin-beta/daemon';\nimport { z } from '@ferretry/plugin-beta/contract';\nexport type X = Y | typeof z;\n`,
          },
        },
        { id: 'beta' },
      ],
      { pending: ['alpha', 'beta'] },
    );
    const found = messages(await run(contextImports, f));
    expect(found).toContain('a manifest imports only');
    expect(found).toContain('a contract imports only zod');
    expect(found).toContain('alpha/daemon/lib/x.ts:1: @ferretry/plugin-beta/daemon');
    expect(found).not.toContain('@ferretry/plugin-beta/contract');
  });
});

describe('contract-graph', () => {
  test('planted: a core contract imports a plugin contract; a plugin contract edge not on the allowed list; a cycle', async () => {
    const f = ws(
      [
        {
          id: 'gate',
          core: true,
          contract: `export * from '@ferretry/core-vault/contract';\nimport '@ferretry/plugin-alpha/contract';\n`,
        },
        { id: 'vault', core: true, contract: `export * from '@ferretry/core-gate/contract';\n` },
        { id: 'alpha', contract: `import '@ferretry/plugin-beta/contract';\nexport {};\n` },
        { id: 'beta' },
        { id: 'usage', contract: `import '@ferretry/plugin-logins/contract';\nexport {};\n` },
        { id: 'logins' },
      ],
      { pending: ['gate', 'vault', 'alpha', 'beta', 'usage', 'logins'] },
    );
    const found = messages(await run(contractGraph, f));
    expect(found).toContain('core contract imports plugin contract alpha');
    expect(found).toContain('plugin contract imports plugin contract beta');
    expect(found).not.toContain('plugin contract imports plugin contract logins');
    expect(found).toContain('contract cycle: gate → vault → gate');
  });
});

describe('contract-consumes', () => {
  test('planted: an app half imports an undeclared contract, bypasses the client, calls an undeclared route', async () => {
    const f = ws(
      [
        {
          id: 'alpha',
          app: `import { b } from '@ferretry/plugin-beta/contract';\nexport async function go(client: { call(k: string): Promise<unknown> }) {\n  await fetch('/v1/beta');\n  await client.call('GET /v1/beta');\n  return b;\n}\n`,
        },
        withRoute('beta'),
      ],
      { pending: ['alpha', 'beta'] },
    );
    const found = messages(await run(contractConsumes, f));
    expect(found).toContain("imports beta's contract but the manifest does not declare consuming beta");
    expect(found).toContain('fetch bypasses the generated client');
    expect(found).toContain('calls GET /v1/beta of beta');
  });
  test('a declared consumption passes', async () => {
    const f = ws(
      [
        {
          id: 'alpha',
          manifestImports: `import { betaPort } from '../beta/contract/index.ts';`,
          manifest: '  uses: { beta: betaPort },',
          app: `export async function go(client: { call(k: string): Promise<unknown> }) {\n  return client.call('GET /v1/beta');\n}\n`,
        },
        withRoute('beta', {
          contract: portContract('beta'),
          manifestImports: `import { route } from '${SDK}';\nimport { betaPort } from './contract/index.ts';`,
          manifest: `  provides: { beta: betaPort }, actions: { routes: [${routeDecl('GET /v1/beta')}] },`,
        }),
      ],
      { pending: ['alpha', 'beta'] },
    );
    expect(messages(await run(contractConsumes, f))).toBe('');
  });
});

describe('host-files', () => {
  test('planted: a host file over 150 lines that names a subsystem', async () => {
    const body = `import beta from '@ferretry/plugin-beta/contract';\nconst id = 'beta';\n${'// line\n'.repeat(150)}export { beta, id };\n`;
    const f = ws([{ id: 'alpha', files: { 'cli/fy.ts': body } }, { id: 'beta' }], { pending: ['alpha', 'beta'] });
    const found = messages(await run(hostFiles, f));
    expect(found).toContain('lines; a host file has at most 150');
    expect(found).toContain('imports @ferretry/plugin-beta/contract');
    expect(found).toContain('names subsystem "beta"');
  });
});

// ─── source scans (pure, per file) ────────────────────────────────────────────────────────────────────────────────

describe('source scans', () => {
  const f = ws([{ id: 'alpha' }], { pending: ['alpha'] });
  const file = (name: string, text: string): string => {
    f.write(name, text);
    return join(f.root, name);
  };

  test('banned-globals exempts only the explicit standalone Worker trees, the browser worker process and native WebRTC engine', async () => {
    const f = ws([
      {
        id: 'connections',
        files: {
          'worker/src/worker.ts': 'await fetch("https://fixture.invalid");',
          'daemon/adapters/webrtc/node-datachannel-engine.ts': 'const platform = process.platform;',
          'daemon/worker.ts': 'await fetch("https://fixture.invalid");',
          'daemon/adapters/webrtc/other.ts': 'const platform = process.platform;',
        },
      },
      { id: 'catalogs', files: { 'worker/src/worker.ts': 'await fetch("https://fixture.invalid");' } },
      {
        id: 'browsers',
        files: {
          'daemon/worker/main.ts': 'const endpoint = process.argv[2]; setTimeout(() => {}, 1);',
          'daemon/worker/launcher.ts': 'await fetch("http://127.0.0.1:9222/json/version");',
        },
      },
      { id: 'other', files: { 'worker/src/worker.ts': 'await fetch("https://fixture.invalid");' } },
    ]);
    const found = await run(bannedGlobals, f);
    expect(found).toHaveLength(4);
    expect(messages(found)).toContain('connections/daemon/worker.ts');
    expect(messages(found)).toContain('browsers/daemon/worker/launcher.ts');
    expect(messages(found)).not.toContain('browsers/daemon/worker/main.ts');
    expect(messages(found)).toContain('connections/daemon/adapters/webrtc/other.ts');
    expect(messages(found)).toContain('other/worker/src/worker.ts');
  });
  test('banned-globals planted: clock, timers, env, fs, network and spawn around the ports', () => {
    const found = messages(
      bannedIn(
        file(
          'banned.ts',
          `import { readFileSync } from 'node:fs';\nimport { homedir } from 'node:os';\nconst a = Date.now();\nconst b = new Date();\nsetTimeout(() => {}, 1);\nconst c = process.env.HOME;\nconst d = process.platform;\nawait fetch('x');\nBun.spawn(['ls']);\nexport { a, b, c, d, readFileSync, homedir };\n`,
        ),
      ),
    );
    for (const what of [
      'imports node:fs',
      'imports homedir',
      'Date.now',
      'new Date()',
      'setTimeout',
      'process.env',
      'process.platform',
      'fetch',
      'Bun.spawn',
    ])
      expect(found).toContain(what);
  });
  test('banned-globals in a browser app half: timers and the clock are allowed, setImmediate and the rest stay refused (DECISIONS-2 #4)', async () => {
    const f = ws([
      {
        id: 'alpha',
        files: {
          'app/timers.ts':
            'export const a = Date.now(); export const b = new Date(); setTimeout(() => {}, 1); setInterval(() => {}, 1);',
          'app/network.ts': 'export const c = fetch("https://fixture.invalid");',
          'app/immediate.ts': 'setImmediate(() => {});',
          'app/process.ts': 'export const d = process.env.HOME;',
          'daemon/timers.ts': 'export const a = Date.now(); setTimeout(() => {}, 1);',
        },
      },
    ]);
    const found = messages(await run(bannedGlobals, f));
    expect(found).not.toContain('alpha/app/timers.ts');
    expect(found).toContain('alpha/app/network.ts');
    expect(found).toContain('alpha/app/immediate.ts');
    expect(found).toContain('alpha/app/process.ts');
    expect(found).toContain('alpha/daemon/timers.ts');
  });
  test('banned-globals clean: kernel ports, a fetch property, a typed Date', () => {
    const clean = file(
      'clean.ts',
      `export function x(kernel: { clock: { now(): string }; fetch: { request(u: string): unknown } }, at: number) {\n  const o = { fetch: 1 };\n  return [kernel.clock.now(), kernel.fetch.request('u'), new Date(at), o.fetch];\n}\n`,
    );
    expect(messages(bannedIn(clean))).toBe('');
  });

  test('no-compat planted: an identifier and a string; "compatible" stays', () => {
    const found = compatIn(
      file(
        'compat.ts',
        `export const legacyHome = 'run the migration first';\nexport const byteCompatible = 'compatible';\nexport const compatMode = 1;\n`,
      ),
    );
    expect(found.length).toBe(3);
    expect(messages(found)).not.toContain('byteCompatible');
  });

  test('no-compat allowlist: only the CARRY_OVER_PROMPT text in the kernel home contract is exempt', () => {
    f.write(
      'packages/core/kernel/contract/home.ts',
      "export const CARRY_OVER_PROMPT = 'follow docs/migration/clean-slate-prompt.md';\nexport const OTHER = 'docs/migration';\n",
    );
    const found = compatIn(
      join(f.root, 'packages/core/kernel/contract/home.ts'),
      'packages/core/kernel/contract/home.ts',
    );
    expect(found.length).toBe(1);
    expect(found[0]?.where).toBe('packages/core/kernel/contract/home.ts:2');
  });

  test('catalog retirement wording stays scoped and does not allow format converters', () => {
    const source = file(
      'catalog-word.ts',
      "export const retiredAt = 'version_retired';\nexport const legacyRetired = 'migration';\n",
    );
    const own = compatIn(source, 'packages/plugins/catalogs/daemon/lib/document.ts');
    expect(own.length).toBe(2);
    expect(own.every(finding => finding.where.endsWith(':2'))).toBe(true);
    expect(compatIn(source, 'packages/plugins/access/daemon/lib/document.ts').length).toBe(4);
  });

  test('no-compat allows only the two exact native Codex notice literals in their declared constant', () => {
    const path = 'packages/plugins/codex/daemon/lib/fixed-layer.ts';
    const source = file(
      'codex-notices.ts',
      [
        'const CODEX_HIDDEN_NOTICES = [',
        '  "hide_gpt5_1_migration_prompt",',
        '  "hide_gpt-5.1-codex-max_migration_prompt",',
        '  "hide_gpt5_2_migration_prompt",',
        '  "prefix_hide_gpt5_1_migration_prompt",',
        '];',
        'const OTHER = "hide_gpt5_1_migration_prompt";',
      ].join('\n'),
    );
    const found = compatIn(source, path);
    expect(found.map(item => item.where)).toEqual([path + ':4', path + ':5', path + ':7']);
    expect(compatIn(source, 'another-file.ts')).toHaveLength(5);
  });

  test('one-format planted: two numbers, a range, a union schema; a validity guard stays', () => {
    const found = messages(
      formatsIn(
        file(
          'formats.ts',
          `import { z } from 'zod';\nexport const ok = (doc: { format: number }) => doc.format < 1;\nexport const two = (doc: { format: number }) => doc.format === 1 || doc.format === 2;\nexport const range = (format: number) => format >= 1;\nexport const S = z.object({ format: z.union([z.literal(1), z.literal(2)]) });\n`,
        ),
      ),
    );
    expect(found).toContain('format compared with 1, 2');
    expect(found).toContain('format compared with >= 1');
    expect(found).toContain('format schema accepts 1, 2');
    expect(found).not.toContain('< 1');
  });

  test('read-scoped planted: a wait without a RedactionScope; typed and opted-out paths stay', () => {
    const found = messages(
      readScopedIn(
        file(
          'reads.ts',
          `type RedactionScope = { text(s: string): string };\nexport function waitFor(text: string) { return text; }\nexport function searchPane(scope: RedactionScope, q: string) { return scope.text(q); }\n// read-scoped: none — returns a count only\nexport const storeCount = (n: number) => n;\nexport const waiter = 1;\n`,
        ),
      ),
    );
    expect(found).toContain('waitFor reads without a RedactionScope');
    expect(found).not.toContain('searchPane');
    expect(found).not.toContain('storeCount');
    expect(found).not.toContain('waiter');
  });
});

// ─── act-runner, words, glossary, pins ────────────────────────────────────────────────────────────────────────────

describe('act-runner', () => {
  test('planted: a tool without an Op, and a ported tool plugin that never calls kernel.act', async () => {
    const tool = (name: string, op?: string): string =>
      `tool('${name}', { minimum: 'authenticated', caller: 'any', audit: { skip: 'fixture' }, guard: { none: 'fixture' }${op === undefined ? '' : `, op: '${op}'`} })`;
    const f = ws(
      [
        {
          id: 'alpha',
          kinds: ['tool'],
          manifestImports: `import { tool } from '${SDK}';`,
          manifest: `  actions: { agentTools: [${tool('alpha_read', 'read')}, ${tool('alpha_poke')}] },`,
          daemon: `import { implementDaemon } from '${SDK}';\nimport manifest from '../manifest.ts';\nexport default implementDaemon(manifest, { build: () => ({ tools: { alpha_read: async () => ({ text: '' }), alpha_poke: async () => ({ text: '' }) } }) } as never);\n`,
        },
      ],
      { pending: ['alpha'] },
    );
    const found = messages(await run(actRunner, f));
    expect(found).toContain('tool alpha_poke declares no Op');
    expect(found).not.toContain('alpha_read declares');
    expect(found).toContain('never calls kernel.act');
  });

  const askAndInputTools = [
    'terminal_ask_owner',
    'terminal_request_input',
    'browser_ask_owner',
    'browser_request_input',
  ];
  const noOpTool = (name: string): string =>
    `tool('${name}', { minimum: 'authenticated', caller: 'any', audit: { skip: 'fixture' }, guard: { none: 'fixture' } })`;
  const noOpPlugin = (names: readonly string[]) =>
    ws(
      [
        {
          id: 'alpha',
          kinds: ['tool'],
          manifestImports: `import { tool } from '${SDK}';`,
          manifest: `  actions: { agentTools: [${names.map(noOpTool).join(', ')}] },`,
        },
      ],
      { pending: ['alpha'] },
    );
  test('each listed ask and input-request tool passes with no Op', async () => {
    for (const name of askAndInputTools) {
      const found = messages(await run(actRunner, noOpPlugin([name])));
      expect(found).not.toContain('declares');
    }
  });
  test('an unlisted look-alike of a listed tool still fails with no Op', async () => {
    const found = messages(
      await run(actRunner, noOpPlugin(['terminal_ask_owner2', 'xterminal_ask_owner', 'browser_ask'])),
    );
    expect(found).toContain('tool terminal_ask_owner2 declares no Op');
    expect(found).toContain('tool xterminal_ask_owner declares no Op');
    expect(found).toContain('tool browser_ask declares no Op');
  });
});

describe('words and glossary', () => {
  const owned = (word: string, insteadOf: readonly string[] = []): string =>
    `  words: [{ word: '${word}', means: 'a thing', insteadOf: ${JSON.stringify(insteadOf)} }],`;
  test('words planted: one word owned twice', async () => {
    const f = ws(
      [
        { id: 'alpha', manifest: owned('card') },
        { id: 'beta', manifest: owned('Card') },
      ],
      { pending: ['alpha', 'beta'] },
    );
    expect(messages(await run(words, f))).toContain('"card" is owned 2 times');
  });
  test('glossary planted: a verb summary and an instruction use an "instead of" word', async () => {
    const f = ws(
      [
        {
          id: 'alpha',
          manifestImports: `import { verb } from '${SDK}';`,
          manifest: `${owned('card', ['task'])}\n  actions: { cli: [verb('card move', { summary: 'Move a task to a lane' })] },`,
          files: { 'instructions/cards.md': 'A card is what you work on.\nNever say task here.\n' },
        },
      ],
      { pending: ['alpha'] },
    );
    const found = messages(await run(glossary, f));
    expect(found).toContain('verb card move: says "task"; the word is "card"');
    expect(found).toContain('instructions/cards.md:2');
    expect(found).not.toContain('cards.md:1');
  });
});

describe('glossary phrase exceptions', () => {
  const index = new Map([
    ['proxy', 'relay'],
    ['timer', 'job'],
  ]);
  test('the reviewed phrases pass', () => {
    expect(glossaryFindings('x', 'check the saved browser proxy without saving it', index)).toEqual([]);
    expect(glossaryFindings('x', 'print the Firewall Timer that runs the verify unit', index)).toEqual([]);
    expect(glossaryFindings('x', 'Browser proxy. Firewall timer.', index)).toEqual([]);
  });
  test('the bare banned word in another phrase still fails', () => {
    expect(glossaryFindings('x', 'check the saved proxy', index).length).toBe(1);
    expect(glossaryFindings('x', 'print the systemd timer', index).length).toBe(1);
    expect(glossaryFindings('x', 'a proxy server for the browser', index).length).toBe(1);
  });
  test('the phrase covers only itself: a second bare use beside it still fails', () => {
    expect(glossaryFindings('x', 'the browser proxy, not a plain proxy', index).length).toBe(1);
    expect(glossaryFindings('x', 'the firewall timer and a second timer', index).length).toBe(1);
  });
});

describe('screen-paths', () => {
  const screens = (body: string): FixturePackage => ({
    id: 'sample',
    manifestImports: `import { screen } from '${SDK}';`,
    manifest: `  ui: { screens: [${body}] },`,
  });
  test('planted: an absolute path without the marker is a finding', async () => {
    const f = ws([KERNEL_PACKAGE, screens("screen('board', { path: '/board' })")]);
    const found = messages(await run(screenPaths, f));
    expect(found).toContain('sample');
    expect(found).toContain('"/board"');
  });
  test('a relative path is per daemon and passes', async () => {
    const f = ws([KERNEL_PACKAGE, screens("screen('board', { path: 'board/:project?' })")]);
    expect(messages(await run(screenPaths, f))).toBe('');
  });
  test('an absolute path that declares itself daemonless passes', async () => {
    const f = ws([KERNEL_PACKAGE, screens("screen('join', { path: '/join', daemonless: true })")]);
    expect(messages(await run(screenPaths, f))).toBe('');
  });
  test('the marker on a relative path contradicts itself', () => {
    expect(screenPathFindings('x', [{ id: 'a', path: 'a', daemonless: true }]).length).toBe(1);
    expect(screenPathFindings('x', [{ id: 'a', path: '/a' }]).length).toBe(1);
    expect(
      screenPathFindings('x', [
        { id: 'a', path: '/a', daemonless: true },
        { id: 'b', path: 'b' },
      ]),
    ).toEqual([]);
  });
});

describe('pins', () => {
  const rev = 'a'.repeat(40);
  test('planted: an unlocked flake, an npx command, an unpinned npm payload', () => {
    expect(pinFindings('shell', { flake: 'github:me/shells#web' }, 's').length).toBe(1);
    expect(pinFindings('mcp', { command: 'npx some-server@latest' }, 'm').length).toBe(1);
    expect(pinFindings('mcp', { payload: { npm: 'some-server@latest', integrity: 'sha512-x' } }, 'm').length).toBe(1);
  });
  test('pinned and floating inputs pass', () => {
    expect(pinFindings('shell', { flake: `github:me/shells?rev=${rev}&narHash=sha256-abc#web` }, 's')).toEqual([]);
    expect(pinFindings('shell', { packages: ['jq'], nixpkgs: { rev } }, 's')).toEqual([]);
    expect(pinFindings('mcp', { payload: { npm: 'server@1.2.3', integrity: 'sha512-abc' } }, 'm')).toEqual([]);
    expect(pinFindings('mcp', { payload: { image: `ghcr.io/x/y@sha256:${'b'.repeat(64)}` } }, 'm')).toEqual([]);
    expect(pinFindings('mcp', { url: 'https://mcp.example.com/sse' }, 'm')).toEqual([]);
    expect(pinFindings('shell', { flake: 'github:me/shells#web', floating: true }, 's')).toEqual([]);
  });
});

// ─── descriptor parity, guarantees ────────────────────────────────────────────────────────────────────────────────

describe('descriptor-parity', () => {
  const today = [
    {
      table: 'route' as const,
      key: 'GET /v1/a',
      minimum: 'authenticated',
      caller: 'any',
      capability: 'unresolved:CAP',
    },
    { table: 'route' as const, key: 'GET /v1/gone', minimum: 'authenticated', caller: 'any' },
    { table: 'tool' as const, key: 'x_read' },
  ];
  test('planted: a changed field, a missing route, a new route, a stale recorded change', () => {
    const next = [
      { table: 'route' as const, key: 'GET /v1/a', minimum: 'operator', caller: 'any' },
      { table: 'route' as const, key: 'GET /v1/new', minimum: 'authenticated', caller: 'any' },
      {
        table: 'tool' as const,
        key: 'x_read',
        minimum: 'authenticated',
        caller: 'any',
        capability: { capability: 'terminal', axis: 'use' },
      },
    ];
    const changes = readChanges('route\tGET /v1/x\tremoved\tnever existed\n');
    const result = parity(today, next, changes);
    const found = messages(result.findings);
    expect(found).toContain('route GET /v1/a: minimum authenticated → operator');
    expect(found).toContain('route GET /v1/gone: today has it');
    expect(found).toContain('route GET /v1/new: new in 5.0');
    expect(found).toContain('recorded as removed but that no longer holds');
    expect(result.unresolved).toBe(1);
  });
  test('recorded changes with reasons pass', () => {
    const next = [
      { table: 'route' as const, key: 'GET /v1/a', minimum: 'authenticated', caller: 'any' },
      { table: 'tool' as const, key: 'x_read', minimum: 'authenticated', caller: 'any' },
    ];
    const changes = readChanges('# reasons\nroute\tGET /v1/gone\tremoved\tthe older peer is gone (A452)\n');
    expect(parity(today, next, changes).findings).toEqual([]);
  });
});

describe('guarantees', () => {
  test('reads the one table: id status owner with enforcer doc test, dashes as empty', () => {
    const rows = parseTsv(
      'id\tstatus\towner\twith\tenforcer\tdoc\ttest\nG1\tkept\tgate\taccess,vault\t`arrivedOnHost`\tgrants\tG1\nG69\tremoved\taccess\t-\t-\tgrants\t-\n',
    );
    expect(rows[0]).toEqual({
      id: 'G1',
      status: 'kept',
      owner: 'gate',
      with: ['access', 'vault'],
      enforcer: '`arrivedOnHost`',
      doc: 'grants',
      test: 'G1',
    });
    expect(rows[1]).toEqual({
      id: 'G69',
      status: 'removed',
      owner: 'access',
      with: [],
      enforcer: '',
      doc: 'grants',
      test: '',
    });
    expect(() => parseTsv('id\tnope\n')).toThrow();
  });
  test('planted: a kept row with no test, a removed row that still has one; pending owners are skipped', () => {
    const rows = [
      { id: 'G1', status: 'kept' as const, owner: 'gate', with: [], enforcer: '', doc: 'grants', test: '' },
      { id: 'G2', status: 'kept' as const, owner: 'board', with: [], enforcer: '', doc: 'grants', test: '' },
      { id: 'G3', status: 'removed' as const, owner: '', with: [], enforcer: '', doc: 'grants', test: '' },
      { id: 'G4', status: 'kept' as const, owner: 'gate', with: [], enforcer: '', doc: 'grants', test: '' },
    ];
    const tests = new Map([
      ['G3', ['x.test.ts']],
      ['G4', ['packages/core/gate/tests/unit/g4.test.ts']],
    ]);
    const found = messages(guaranteeFindings(rows, tests, new Set(['board']), undefined, false));
    expect(found).toContain('G1: kept row owned by gate has no test');
    expect(found).not.toContain('G2');
    expect(found).toContain('G3: REMOVED row still has a test');
    expect(found).not.toContain('G4');
    expect(messages(guaranteeFindings(rows, tests, new Set(['board']), undefined, true))).toContain('G2');
    expect(enforcerSymbols('`decideCapability`, `packages/x.ts`, `GET /v1/x`, `fys_`')).toEqual(['decideCapability']);
  });
});

describe('guarantees: the one helper and multi-id titles (test-titles.ts)', () => {
  const rowFor = (id: string): string => `${id}\tkept\talpha\t-\t-\tgrants\t${id}\n`;
  const SUPPORT = 'packages/plugins/alpha/tests/support/guarantee.ts';
  const A = 'packages/plugins/alpha/tests/unit/a.test.ts';
  const SUPPORT_BODY =
    "import { it } from 'bun:test';\nexport function guarantee(ids: readonly string[], name: string, run: () => void): void {\n  for (const id of ids) it(id + ' ' + name, run);\n}\n";
  const IMPORT = "import { guarantee } from '../support/guarantee.ts';\n";
  // The titles are spliced in, so this file holds no literal test title that starts with a real row id.
  const titled = (...names: string[]): string =>
    `import { test } from 'bun:test';\n${names.map(name => `test('${name}', () => {});`).join('\n')}\n`;
  /** Which of the rows have no test, with `source` as the one test file (and the support module when `support`). */
  const missing = async (ids: readonly string[], source: string, support = true): Promise<string> => {
    const f = ws([{ id: 'alpha' }]);
    f.write('docs/rebuild/guarantees.tsv', `id\tstatus\towner\twith\tenforcer\tdoc\ttest\n${ids.map(rowFor).join('')}`);
    if (support) f.write(SUPPORT, SUPPORT_BODY);
    f.write(A, source);
    const found = await run(guarantees, f, { existenceOnly: true, strict: true });
    // the owner check reads the same ids: a row the existence half sees must not be flagged as tested nowhere
    const owner = await run(guaranteeOwner, f, { strict: true });
    expect(messages(owner)).not.toContain('tested only outside');
    return found.map(x => x.where).join(',');
  };

  test('planted: a call of the imported helper names every id in its list', async () => {
    const source = `${IMPORT}guarantee(['G1', 'G2'], 'holds', () => {});\nguarantee(['G3'], 'also holds', () => {});\n`;
    expect(await missing(['G1', 'G2', 'G3', 'G4'], source)).toBe('G4');
  });

  test('planted: a literal title names every id that leads its own word, and no later id', async () => {
    expect(await missing(['G1', 'G2', 'G3', 'G4'], titled('G1 G2 both', 'G3 then G4 later'))).toBe('G4');
    expect(await missing(['G1', 'G2'], titled('see G1 and G2'))).toBe('G1,G2');
  });

  test('planted: a stray call, a local re-declaration, a foreign import or an alias counts as nothing', async () => {
    const strays: Record<string, string> = {
      'a different function name': `${IMPORT}function proof(ids: string[], name: string): void {}\nproof(['G1'], 'x');\n`,
      'a same-named local declaration, not imported':
        "function guarantee(ids: string[], name: string, run: () => void): void {}\nguarantee(['G1'], 'x', () => {});\n",
      'the name imported from another module':
        "import { guarantee } from '../support/other.ts';\nguarantee(['G1'], 'x', () => {});\n",
      'the helper under an alias':
        "import { guarantee as holds } from '../support/guarantee.ts';\nholds(['G1'], 'x', () => {});\n",
      'ids that are not literal strings': `${IMPORT}const ids = ['G1'];\nguarantee(ids, 'x', () => {});\n`,
      'a type-only import':
        "import type { guarantee } from '../support/guarantee.ts';\nguarantee(['G1'], 'x', () => {});\n",
    };
    for (const [why, source] of Object.entries(strays))
      expect([why, await missing(['G1'], source)]).toEqual([why, 'G1']);
  });

  test('planted: an import of a support module that does not exist counts as nothing', async () => {
    const source = `${IMPORT}guarantee(['G1'], 'holds', () => {});\n`;
    expect(await missing(['G1'], source, false)).toBe('G1');
    expect(await missing(['G1'], source, true)).toBe('');
  });
});

describe('guarantees: a kept row needs a test that PASSES (redesign §10.5)', () => {
  const TSV_HEAD = 'id\tstatus\towner\twith\tenforcer\tdoc\ttest\n';
  const row = (id: string, status: 'kept' | 'split' | 'removed', owner = 'alpha'): string =>
    `${id}\t${status}\t${owner}\t-\t-\tgrants\t${status === 'removed' ? '-' : id}\n`;
  // The titles are spliced in, so this file holds no literal test title that starts with a real row id.
  const titled = (...names: string[]): string =>
    `import { test } from 'bun:test';\n${names.map(name => `test('${name}', () => {});`).join('\n')}\n`;
  const titledAs = (modifier: string, name: string): string =>
    `import { test } from 'bun:test';\ntest.${modifier}('${name}', () => {});\n`;
  const junit = (...cases: { name: string; file: string; status?: 'failure' | 'skipped' }[]): string =>
    `<?xml version="1.0"?><testsuites>${cases
      .map(c =>
        c.status === undefined
          ? `<testcase name="${c.name}" file="${c.file}" />`
          : `<testcase name="${c.name}" file="${c.file}"><${c.status} /></testcase>`,
      )
      .join('')}</testsuites>`;
  const A = 'packages/plugins/alpha/tests/unit/a.test.ts';
  const planted = (
    rows: string,
    tests: string,
    reports: Record<string, string>,
    extra: Partial<FixturePackage> = {},
  ) => {
    const f = ws([{ id: 'alpha', ...extra }, { id: 'beta' }]);
    f.write('docs/rebuild/guarantees.tsv', TSV_HEAD + rows);
    f.write(A, tests);
    for (const [path, xml] of Object.entries(reports)) f.write(path, xml);
    return f;
  };
  const both = async (f: Fixture, extra = {}) => [
    ...(await run(guarantees, f, extra)),
    ...(await run(guaranteeOwner, f, extra)),
  ];

  test('reads a JUnit report: ids by test name, failure and error mean failed, skipped means skipped', () => {
    const xml = [
      '<testsuites><testsuite name="a">',
      '<testcase name="G1 passes" classname="x" file="./p/a.test.ts" line="1" assertions="1" />',
      '<testcase name="G2 fails &amp; says so" file="p/a.test.ts"><failure type="AssertionError" /></testcase>',
      '<testcase name="G3a errors" file="p/a.test.ts"><error /></testcase>',
      '<testcase name="G4 todo" file="p/a.test.ts"><skipped message="TODO" /></testcase>',
      '<testcase name="G5" file="p/a.test.ts" />',
      '<testcase name="the title has no row id" file="p/a.test.ts" />',
      '</testsuite></testsuites>',
    ].join('\n');
    expect(parseJunit(xml).map(r => `${r.id}:${r.status}:${r.file}`)).toEqual([
      'G1:passed:p/a.test.ts',
      'G2:failed:p/a.test.ts',
      'G3a:failed:p/a.test.ts',
      'G4:skipped:p/a.test.ts',
      'G5:passed:p/a.test.ts',
    ]);
    expect(parseJunit(xml)[1]?.name).toBe('G2 fails & says so');
  });

  test('a kept row whose id-named test passes is quiet; with no test at all it fails', async () => {
    const quiet = planted(row('G1', 'kept'), titled('G1 holds'), {
      'coverage/unit/junit.xml': junit({ name: 'G1 holds', file: A }),
    });
    expect(messages(await both(quiet))).toBe('');
    const none = planted(row('G1', 'kept'), titled('something else'), {
      'coverage/unit/junit.xml': junit({ name: 'something else', file: A }),
    });
    expect(messages(await both(none))).toContain('G1: kept row owned by alpha has no test named "G1 …"');
  });

  test('a test named with the id that FAILS fails the row, even though the title exists', async () => {
    const f = planted(row('G1', 'kept'), titled('G1 holds'), {
      'coverage/unit/junit.xml': junit({ name: 'G1 holds', file: A, status: 'failure' }),
    });
    expect(messages(await both(f))).toContain('G1: kept row owned by alpha has a FAILING test');
  });

  test('a test that exists but was skipped, or is in no report, does not prove the row', async () => {
    const skippedRun = planted(row('G1', 'kept'), titled('G1 holds'), {
      'coverage/unit/junit.xml': junit({ name: 'G1 holds', file: A, status: 'skipped' }),
    });
    expect(messages(await both(skippedRun))).toContain(
      'G1: kept row owned by alpha has a test named "G1 …" but no passing run',
    );
    const notRun = planted(row('G1', 'kept'), titled('G1 holds'), {
      'coverage/unit/junit.xml': junit({ name: 'G9 another', file: A }),
    });
    expect(messages(await both(notRun))).toContain('no passing run');
  });

  test('every test named with the id must pass: one failing sibling fails the row', async () => {
    const f = planted(row('G1', 'kept'), titled('G1 one', 'G1 two'), {
      'coverage/unit/junit.xml': junit({ name: 'G1 one', file: A }, { name: 'G1 two', file: A, status: 'failure' }),
    });
    expect(messages(await both(f))).toContain('FAILING test');
  });

  test('a quarantine rerun that passes rescues a first run that failed; two failing runs do not', async () => {
    const rescued = planted(row('G1', 'kept'), titled('G1 holds'), {
      'coverage/unit/junit.xml': junit({ name: 'G1 holds', file: A, status: 'failure' }),
      'coverage/unit/rerun/junit.xml': junit({ name: 'G1 holds', file: A }),
    });
    expect(messages(await both(rescued))).toBe('');
    const still = planted(row('G1', 'kept'), titled('G1 holds'), {
      'coverage/unit/junit.xml': junit({ name: 'G1 holds', file: A, status: 'failure' }),
      'coverage/unit/rerun/junit.xml': junit({ name: 'G1 holds', file: A, status: 'failure' }),
    });
    expect(messages(await both(still))).toContain('FAILING test');
  });

  test("a pass in another package's suite is not the owner's proof", async () => {
    const f = planted(row('G1', 'kept'), titled('G1 holds'), {
      'coverage/unit/junit.xml': junit({ name: 'G1 holds', file: 'packages/plugins/beta/tests/unit/b.test.ts' }),
    });
    expect(messages(await both(f))).toContain('no passing run');
  });

  test('a split row is a kept row: its kept half needs a passing test', async () => {
    const missing = planted(row('G2', 'split'), titled('unrelated'), {
      'coverage/unit/junit.xml': junit({ name: 'unrelated', file: A }),
    });
    expect(messages(await both(missing))).toContain('G2: split row owned by alpha has no test named "G2 …"');
    const failing = planted(row('G2', 'split'), titled('G2 kept half'), {
      'coverage/unit/junit.xml': junit({ name: 'G2 kept half', file: A, status: 'failure' }),
    });
    expect(messages(await both(failing))).toContain('G2: split row owned by alpha has a FAILING test');
    const ok = planted(row('G2', 'split'), titled('G2 kept half'), {
      'coverage/unit/junit.xml': junit({ name: 'G2 kept half', file: A }),
    });
    expect(messages(await both(ok))).toBe('');
  });

  test('a REMOVED row that leaves a test behind fails; a kept half beside it is never flagged', async () => {
    const f = planted(
      row('G2', 'split') + row('G3', 'removed') + row('G4', 'kept'),
      titled('G2 kept half', 'G4 holds', 'G3 the removed half'),
      {
        'coverage/unit/junit.xml': junit(
          { name: 'G2 kept half', file: A },
          { name: 'G4 holds', file: A },
          { name: 'G3 the removed half', file: A },
        ),
      },
    );
    const found = messages(await both(f));
    expect(found).toContain('G3: REMOVED row still has a test');
    expect(found).not.toContain('G2');
    expect(found).not.toContain('G4');
    const clean = planted(row('G2', 'split') + row('G3', 'removed'), titled('G2 kept half'), {
      'coverage/unit/junit.xml': junit({ name: 'G2 kept half', file: A }),
    });
    expect(messages(await both(clean))).toBe('');
  });

  test('a .failing or .skip or .todo test is no proof', async () => {
    for (const modifier of ['failing', 'skip', 'todo']) {
      const f = planted(row('G1', 'kept'), titledAs(modifier, 'G1 holds'), {
        'coverage/unit/junit.xml': junit({ name: 'G1 holds', file: A }),
      });
      expect(messages(await both(f))).toContain('has no test named');
    }
  });

  test('no report at all is a finding; --existence-only (the commit hook) and --package opt out of it', async () => {
    const f = planted(row('G1', 'kept'), titled('G1 holds'), {});
    expect(messages(await both(f))).toContain('no JUnit report found');
    expect(messages(await both(f, { existenceOnly: true }))).toBe('');
    expect(messages(await both(f, { packageId: 'alpha' }))).toBe('');
  });

  test('--results names the report: a file, or a folder searched for junit.xml', async () => {
    const f = planted(row('G1', 'kept'), titled('G1 holds'), {
      'elsewhere/run-1/junit.xml': junit({ name: 'G1 holds', file: A }),
      'coverage/unit/junit.xml': junit({ name: 'G1 holds', file: A, status: 'failure' }),
    });
    expect(messages(await both(f, { results: ['elsewhere'] }))).toBe('');
    expect(messages(await both(f, { results: ['elsewhere/run-1/junit.xml'] }))).toBe('');
    expect(messages(await both(f))).toContain('FAILING test');
  });

  test('a pending owner is skipped in the pass proof unless --strict; the realworld tier proves nothing', async () => {
    const f = ws([{ id: 'alpha' }], { pending: ['alpha'] });
    f.write('docs/rebuild/guarantees.tsv', TSV_HEAD + row('G1', 'kept'));
    f.write(A, titled('G1 holds'));
    f.write('coverage/unit/junit.xml', junit({ name: 'G1 holds', file: A, status: 'failure' }));
    expect(messages(await run(guarantees, f))).toBe('');
    expect(messages(await run(guarantees, f, { strict: true }))).toContain('FAILING test');
    const real = planted(row('G1', 'kept'), titled('G1 holds'), {
      'coverage/realworld/junit.xml': junit({ name: 'G1 holds', file: A }),
      'coverage/unit/junit.xml': junit({ name: 'G9 other', file: A }),
    });
    expect(messages(await both(real))).toContain('no passing run');
  });

  // CI wiring: quick.sh judges the unit reports, integration.sh the integration report, each with its own --tier.
  describe('--tier: each CI job proves the rows tested in its own tier', () => {
    const I = 'packages/plugins/alpha/tests/integration/i.test.ts';
    const tiered = (reports: Record<string, string>) => {
      const f = planted(row('G1', 'kept') + row('G2', 'kept'), titled('G1 holds'), reports);
      f.write(I, titled('G2 holds'));
      return f;
    };

    test('the unit job does not need an integration-only row in the unit report, and the integration job the reverse', async () => {
      const f = tiered({
        'coverage/unit/junit.xml': junit({ name: 'G1 holds', file: A }),
        'coverage/int/junit.xml': junit({ name: 'G2 holds', file: I }),
      });
      expect(messages(await run(guarantees, f, { tier: 'unit', results: ['coverage/unit'] }))).toBe('');
      expect(messages(await run(guarantees, f, { tier: 'int', results: ['coverage/int'] }))).toBe('');
      // Without a tier the unit report alone still leaves the integration row unproven.
      expect(messages(await run(guarantees, f, { results: ['coverage/unit'] }))).toContain('G2');
    });

    test('an integration row whose test FAILED fails the integration job, not the unit job', async () => {
      const f = tiered({
        'coverage/unit/junit.xml': junit({ name: 'G1 holds', file: A }),
        'coverage/int/junit.xml': junit({ name: 'G2 holds', file: I, status: 'failure' }),
      });
      expect(messages(await run(guarantees, f, { tier: 'unit', results: ['coverage/unit'] }))).toBe('');
      expect(messages(await run(guarantees, f, { tier: 'int', results: ['coverage/int'] }))).toContain('FAILING test');
    });

    test('a unit row that failed still fails the unit job, and an integration job with no report says so', async () => {
      const f = tiered({ 'coverage/unit/junit.xml': junit({ name: 'G1 holds', file: A, status: 'failure' }) });
      expect(messages(await run(guarantees, f, { tier: 'unit', results: ['coverage/unit'] }))).toContain(
        'FAILING test',
      );
      expect(messages(await run(guarantees, f, { tier: 'int', results: ['coverage/int'] }))).toContain(
        'no JUnit report',
      );
    });

    test('the integration job does not repeat a row with no test at all (the unit job reports that)', async () => {
      const f = planted(row('G1', 'kept'), titled('G9 other'), {
        'coverage/int/junit.xml': junit({ name: 'G9 other', file: A }),
      });
      expect(messages(await run(guarantees, f, { tier: 'unit', results: ['coverage/unit'] }))).toContain(
        'no test named',
      );
      expect(messages(await run(guarantees, f, { tier: 'int', results: ['coverage/int'] }))).toBe('');
    });

    test("an integration test in another package that reuses the id does not make the integration job judge the owner's row", async () => {
      const elsewhere = 'packages/plugins/beta/tests/integration/b.test.ts';
      const f = planted(row('G1', 'kept'), titled('G1 holds'), {
        'coverage/unit/junit.xml': junit({ name: 'G1 holds', file: A }),
        'coverage/int/junit.xml': junit({ name: 'G1 a different fixture label', file: elsewhere }),
      });
      f.write(elsewhere, titled('G1 a different fixture label'));
      expect(messages(await run(guarantees, f, { tier: 'unit', results: ['coverage/unit'] }))).toBe('');
      expect(messages(await run(guarantees, f, { tier: 'int', results: ['coverage/int'] }))).toBe('');
    });

    test('--tier takes unit or int only', () => {
      expect(parseArgs(['--tier', 'int']).tier).toBe('int');
      expect(() => parseArgs(['--tier', 'sit'])).toThrow('--tier is unit or int');
    });
  });

  // The strict report (scripts/ci/strict-guarantees.ts): every tier's reports at once, --strict, no --tier.
  describe('--strict over the unit, scripts and integration reports together', () => {
    const I = 'packages/plugins/alpha/tests/integration/i.test.ts';
    const S = 'scripts/x.test.ts';
    const all = { strict: true, results: ['coverage/unit', 'coverage/scripts', 'coverage/int'] };
    const combined = (reports: Record<string, string>) => {
      const f = ws([{ id: 'alpha' }], { pending: ['alpha'] });
      f.write('docs/rebuild/guarantees.tsv', TSV_HEAD + row('G1', 'kept') + row('G2', 'kept'));
      f.write(A, titled('G1 holds'));
      f.write(I, titled('G2 holds'));
      for (const [path, xml] of Object.entries(reports)) f.write(path, xml);
      return f;
    };

    test('a row proven by a passing test in EITHER tier is not a miss', async () => {
      const f = combined({
        'coverage/unit/junit.xml': junit({ name: 'G1 holds', file: A }),
        'coverage/int/junit.xml': junit({ name: 'G2 holds', file: I }),
      });
      expect(messages(await run(guarantees, f, all))).toBe('');
      // Each alone leaves the other tier's row unproven: the reason the per-tier checks cannot give the count.
      expect(messages(await run(guarantees, f, { strict: true, results: ['coverage/unit'] }))).toContain('G2');
      expect(messages(await run(guarantees, f, { strict: true, results: ['coverage/int'] }))).toContain('G1');
    });

    test('a SKIPPED id test is a miss (the placeholder case)', async () => {
      const f = combined({
        'coverage/unit/junit.xml': junit({ name: 'G1 holds', file: A, status: 'skipped' }),
        'coverage/int/junit.xml': junit({ name: 'G2 holds', file: I }),
      });
      const found = await run(guarantees, f, all);
      expect(found.map(x => x.where)).toEqual(['G1']);
      expect(messages(found)).toContain('no passing run');
    });

    test('a FAILED id test is a miss, even when the other tier passes a different row', async () => {
      const f = combined({
        'coverage/unit/junit.xml': junit({ name: 'G1 holds', file: A }),
        'coverage/int/junit.xml': junit({ name: 'G2 holds', file: I, status: 'failure' }),
      });
      const found = await run(guarantees, f, all);
      expect(found.map(x => x.where)).toEqual(['G2']);
      expect(messages(found)).toContain('FAILING test');
    });

    test('a row in a pending package counts under --strict and not without it', async () => {
      const f = combined({ 'coverage/unit/junit.xml': junit({ name: 'G1 holds', file: A, status: 'skipped' }) });
      expect((await run(guarantees, f, all)).map(x => x.where)).toEqual(['G1', 'G2']);
      expect(messages(await run(guarantees, f, { results: all.results }))).toBe('');
    });

    test('the scripts report is read like the others (a repo-tooling row)', async () => {
      const f = ws([{ id: 'alpha' }]);
      f.write('docs/rebuild/guarantees.tsv', TSV_HEAD + row('G1', 'kept', 'repo-tooling'));
      f.write(S, titled('G1 holds'));
      f.write('coverage/scripts/junit.xml', junit({ name: 'G1 holds', file: S }));
      expect(messages(await run(guarantees, f, all))).toBe('');
    });
  });

  test("the quarantine's junit.rerun.xml counts: a flake rescued by the rerun does not fail the proof", async () => {
    const f = planted(row('G1', 'kept'), titled('G1 holds'), {
      'coverage/unit/groups/x/junit.xml': junit({ name: 'G1 holds', file: A, status: 'failure' }),
      'coverage/unit/groups/x/junit.rerun.xml': junit({ name: 'G1 holds', file: A }),
    });
    expect(messages(await both(f, { results: ['coverage/unit'] }))).toBe('');
  });
});

// ─── generator ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('registry generator', () => {
  const graph = (alphaField: string): FixturePackage[] => [
    {
      id: 'alpha',
      contract: `import { z } from '${ZOD}';\nimport { definePort } from '${LEAF}';\nexport const alphaPort = definePort<{ ping(): void }>('alpha');\nexport const Body = z.strictObject({ ${alphaField}: z.string() });\n`,
      manifestImports: `import { alphaPort } from './contract/index.ts';`,
      manifest: '  provides: { alpha: alphaPort },',
      testing: 'export const fakeAlpha = () => ({ ping() {} });\n',
    },
    {
      id: 'beta',
      manifestImports: `import { alphaPort } from '../alpha/contract/index.ts';`,
      manifest: '  needs: { alpha: alphaPort },',
    },
    { id: 'gamma' },
  ];

  test('start order puts a provider first; effective hashes move with a consumed contract and nothing else', async () => {
    const before = await buildModel(ws(graph('name'), { pending: ['alpha', 'beta', 'gamma'] }).root);
    const after = await buildModel(ws(graph('title'), { pending: ['alpha', 'beta', 'gamma'] }).root);
    expect(before.graph.order).toEqual(['alpha', 'beta', 'gamma']);
    expect(after.hashes.get('alpha')?.canonical).not.toBe(before.hashes.get('alpha')?.canonical);
    expect(after.hashes.get('beta')?.canonical).toBe(before.hashes.get('beta')?.canonical);
    expect(after.hashes.get('beta')?.effective).not.toBe(before.hashes.get('beta')?.effective);
    expect(after.hashes.get('gamma')?.effective).toBe(before.hashes.get('gamma')?.effective);
  });

  test('the package registry loads one package plus the contract fakes it consumes', async () => {
    const f = ws(graph('name'), { pending: ['alpha', 'beta', 'gamma'] });
    const model = await buildModel(f.root);
    const files = generatePackage(model, 'beta');
    const text = files.get(packageRegistryPath('beta')) ?? '';
    expect(text).toContain('plugins/beta/daemon/index.ts');
    expect(text).toContain('plugins/alpha/contract/testing/index.ts');
    expect(text).not.toContain('gamma');
    writeFiles(f.root, files);
    const registry = (await import(join(f.root, packageRegistryPath('beta')))) as {
      halves: { daemon: { skeleton?: true } };
      contractTesting: Record<string, Record<string, unknown>>;
    };
    expect(registry.halves.daemon.skeleton).toBe(true);
    expect(typeof registry.contractTesting.alpha?.fakeAlpha).toBe('function');
  });

  test('pending app halves are omitted, ported halves register, and registries --check stays exact', async () => {
    const f = ws([KERNEL_PACKAGE, { id: 'alpha' }, { id: 'beta' }]);
    f.write(
      'ports-pending.json',
      JSON.stringify({ format: 1, pending: ['alpha', 'beta'], pendingHalves: { alpha: ['app'] } }),
    );
    const files = generateGlobal(await buildModel(f.root));
    const surfaces = files.get('packages/app/src/generated/surfaces.ts') ?? '';
    expect(surfaces).not.toContain('import app_alpha');
    expect(surfaces).not.toContain('app: app_alpha');
    expect(surfaces).toContain('manifest: manifest_alpha');
    expect(surfaces).toContain('import app_beta');
    expect(surfaces).toContain('app: app_beta');
    writeFiles(f.root, files);
    const check = () => Bun.spawnSync(['bun', join(import.meta.dir, '../registries.ts'), '--root', f.root, '--check']);
    expect(check().exitCode).toBe(0);
    f.write('ports-pending.json', JSON.stringify({ format: 1, pending: ['alpha', 'beta'], pendingHalves: {} }));
    expect(check().exitCode).toBe(1);
    const ported = generateGlobal(await buildModel(f.root));
    expect(ported.get('packages/app/src/generated/surfaces.ts')).toContain('app: app_alpha');
    writeFiles(f.root, ported);
    expect(check().exitCode).toBe(0);
  });

  test('registries-fresh planted: a hand-edited generated file', async () => {
    const f = ws([KERNEL_PACKAGE, ...graph('name')], { pending: ['alpha', 'beta', 'gamma'] });
    const model = await buildModel(f.root);
    const files = generateGlobal(model);
    writeFiles(f.root, files);
    expect(messages(await run(registriesFresh, f))).toBe('');
    f.write('generated/hooks.md', 'edited by hand\n');
    expect(messages(await run(registriesFresh, f))).toContain('generated/hooks.md: differs');
  });
});

describe('fy check package scope and the release hash compare', () => {
  test('a whole-graph finding counts for a package only when it names that package', async () => {
    const { namesPackage } = await import('../check.ts');
    expect(
      namesPackage(
        { check: 'plugin-graph', where: 'gate', message: 'kernel-bound port "admission" has 0 providers' },
        'projects',
      ),
    ).toBe(false);
    expect(namesPackage({ check: 'plugin-graph', where: 'a, projects', message: 'two takers' }, 'projects')).toBe(true);
    expect(
      namesPackage(
        { check: 'plugin-graph', where: 'board', message: 'start-order cycle: board → projects → board' },
        'projects',
      ),
    ).toBe(true);
    expect(namesPackage({ check: 'plugin-graph', where: 'x', message: 'needs projects-extra' }, 'projects')).toBe(
      false,
    );
  });
  test('the release notes name every changed, new and removed contract', async () => {
    const { releaseNotes } = await import('../hash-compare.ts');
    const { compareHashes } = await import('../lib/hashes.ts');
    const h = (effective: string) => ({ canonical: 'c', effective });
    const diff = compareHashes(
      { board: h('1'), tidy: h('1'), gone: h('1') },
      { board: h('2'), tidy: h('1'), fresh: h('1') },
    );
    expect(diff).toEqual({ changed: ['board'], added: ['fresh'], removed: ['gone'] });
    expect(releaseNotes(diff)).toContain('**board** changed');
    expect(releaseNotes({ changed: [], added: [], removed: [] })).toContain("No plugin's contract changed.");
  });
});

// ─── app-hooks ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('app-hooks', () => {
  const fn = (value: unknown) => typeof value === 'object' && value !== null && 'go' in value;
  const offers = [{ plugin: 'agenda', hooks: { 'agenda.card-answer': fn } }];
  const gives = (plugin: string, name: string, value: unknown = { go: () => undefined }) => ({
    plugin,
    hooks: { [name]: () => value },
  });
  const found = (...args: Parameters<typeof appHookFindings>) => appHookFindings(...args).map(x => x.message);

  test('one provider of an offered hook, with the shape, passes', () => {
    expect(found(offers, [gives('board', 'agenda.card-answer')])).toEqual([]);
  });
  test('planted: an offered hook with no provider is found (the feature would be silently off)', () => {
    expect(found(offers, [])).toEqual([expect.stringContaining('"agenda.card-answer" has no provider')]);
  });
  test('planted: a second provider of one hook is found, naming both', () => {
    const two = found(offers, [gives('board', 'agenda.card-answer'), gives('other', 'agenda.card-answer')]);
    expect(two).toEqual([expect.stringContaining('2 providers (board, other)')]);
  });
  test('planted: a renamed hook is found on both sides', () => {
    const renamed = found(offers, [gives('board', 'agenda.card-reply')]);
    expect(renamed).toContain(
      'provides app hook "agenda.card-reply", which agenda does not offer (renamed or misspelled?)',
    );
    expect(renamed.some(m => m.includes('"agenda.card-answer" has no provider'))).toBe(true);
    expect(found(offers, [gives('board', 'elsewhere.thing'), gives('board2', 'agenda.card-answer')])).toEqual([
      'provides app hook "elsewhere.thing", which no plugin offers',
    ]);
  });
  test('planted: a provided value without the shape, and a factory that throws, are found', () => {
    expect(found(offers, [gives('board', 'agenda.card-answer', {})])).toEqual([
      'app hook "agenda.card-answer" builds a value without the shape agenda reads',
    ]);
    const throws = {
      plugin: 'board',
      hooks: {
        'agenda.card-answer': () => {
          throw new Error('boom');
        },
      },
    };
    expect(found(offers, [throws])).toEqual(['app hook "agenda.card-answer" failed to build: boom']);
  });
  test('planted: an offered name outside the offerer prefix is found', () => {
    expect(found([{ plugin: 'agenda', hooks: { 'board.thing': fn } }], [gives('board', 'board.thing')])).toEqual([
      'offers app hook "board.thing", which is not named "agenda.<name>"',
    ]);
  });
});

describe('app-hooks: a shared action is one provider, many callers (S15)', () => {
  const add = (value: unknown) => typeof value === 'object' && value !== null && 'add' in value;
  const declared = [{ plugin: 'conversation', hooks: { 'conversation.add-to-chat': add } }];
  const gives = (plugin: string, name: string, value: unknown = { add: () => undefined }) => ({
    plugin,
    hooks: { [name]: () => value },
  });
  const found = (...args: Parameters<typeof appHookFindings>) => appHookFindings(...args).map(x => x.message);

  test('S15 a provider-named hook its own plugin gives, with the shape, passes without any offerer', () => {
    expect(found([], [gives('conversation', 'conversation.add-to-chat')], declared)).toEqual([]);
  });
  test('S15 a provider-named hook is not mistaken for an offerer-named one (no "no provider"/"which nobody offers")', () => {
    const offers = [{ plugin: 'agenda', hooks: { 'agenda.card-answer': add } }];
    expect(
      found(
        offers,
        [gives('board', 'agenda.card-answer'), gives('conversation', 'conversation.add-to-chat')],
        declared,
      ),
    ).toEqual([]);
  });
  test('planted: a wrong prefix is found (the name is not the declaring plugin’s own id)', () => {
    expect(
      found(
        [],
        [gives('conversation', 'board.add-to-chat')],
        [{ plugin: 'conversation', hooks: { 'board.add-to-chat': add } }],
      ),
    ).toEqual([
      'provides shared action "board.add-to-chat", whose prefix is not "conversation" (the provider\'s own id)',
    ]);
  });
  test('planted: another plugin giving the shared action is found', () => {
    expect(
      found(
        [],
        [gives('conversation', 'conversation.add-to-chat'), gives('board', 'conversation.add-to-chat')],
        declared,
      ),
    ).toEqual(['provides "conversation.add-to-chat", the shared action of conversation; only conversation may']);
  });
  test('planted: a declared shared action its half does not give is found', () => {
    expect(found([], [], declared)).toEqual([
      expect.stringContaining('"conversation.add-to-chat" is declared but its half does not give'),
    ]);
  });
  test('planted: a shared action that fails to build or has the wrong shape is found', () => {
    const throws = {
      plugin: 'conversation',
      hooks: {
        'conversation.add-to-chat': () => {
          throw new Error('boom');
        },
      },
    };
    expect(found([], [throws], declared)).toEqual(['shared action "conversation.add-to-chat" failed to build: boom']);
    expect(found([], [gives('conversation', 'conversation.add-to-chat', {})], declared)).toEqual([
      'shared action "conversation.add-to-chat" builds a value without the shape its contract declares',
    ]);
  });
});

// ─── shell-provides (S3: declared fragments and device views) ────────────────────────────────────────────────────

describe('shell-provides', () => {
  const half = (plugin: string, extra: Partial<Parameters<typeof shellProvidesFindings>[0][number]> = {}) => ({
    plugin,
    skeleton: false,
    screens: [{ id: 'join', daemonless: true }, { id: 'main' }],
    fragments: [],
    device: [],
    ...extra,
  });
  const found = (...halves: Parameters<typeof shellProvidesFindings>[0]) =>
    shellProvidesFindings(halves).map(x => x.message);

  test('the real shapes pass: a taken keyed key, a kept one, and a path on an own daemon-less screen', () => {
    expect(
      found(
        half('agenda', { fragments: [{ form: 'keyed', key: 'agenda' }], device: ['deep-link'] }),
        half('runtimes', { fragments: [{ form: 'keyed', key: 'machines', strip: false }] }),
        half('catalogs', { fragments: [{ form: 'path', screen: 'join' }] }),
      ),
    ).toEqual([]);
  });
  test('planted: one key claimed twice is found, strip: false claims included', () => {
    expect(
      found(
        half('runtimes', { fragments: [{ form: 'keyed', key: 'machines', strip: false }] }),
        half('other', { fragments: [{ form: 'keyed', key: 'machines', strip: false }] }),
      ),
    ).toEqual([expect.stringContaining('"machines" is claimed 2 times (runtimes, other)')]);
    expect(
      found(
        half('agenda', {
          fragments: [
            { form: 'keyed', key: 'agenda' },
            { form: 'keyed', key: 'agenda' },
          ],
          device: ['d'],
        }),
      ),
    ).toEqual([expect.stringContaining('"agenda" is claimed 2 times (agenda, agenda)')]);
  });
  test('planted: a key outside the grammar is found', () => {
    for (const key of ['Rules', '1rules', 'r'.repeat(33), 'rules/x', ''])
      expect(found(half('accounts', { fragments: [{ form: 'keyed', key, strip: false }] }))).toEqual([
        expect.stringContaining(`declares fragment key "${key}", which is not`),
      ]);
  });
  test('planted: a path on a screen the plugin does not declare, or one that is not daemon-less, is found', () => {
    expect(found(half('catalogs', { fragments: [{ form: 'path', screen: 'pair' }] }))).toEqual([
      'declares a path fragment on screen "pair", which its manifest does not declare',
    ]);
    expect(found(half('catalogs', { fragments: [{ form: 'path', screen: 'main' }] }))).toEqual([
      'declares a path fragment on screen "main", which is not daemon-less',
    ]);
  });
  test('planted: a stripping key with no device view is found; a kept one needs none', () => {
    expect(found(half('agenda', { fragments: [{ form: 'keyed', key: 'agenda' }] }))).toEqual([
      expect.stringContaining('stripping fragment key "agenda" with no `shell.device` view'),
    ]);
  });
  test('planted: a device view on a skeleton half, and a declaration in no known form, are found', () => {
    expect(found(half('agenda', { skeleton: true, device: ['deep-link'] }))).toEqual([
      'is a skeleton half with `shell.device` views (deep-link): nothing mounts them',
    ]);
    expect(found(half('agenda', { fragments: [{ form: 'query', key: 'x' }, null] }))).toEqual([
      'declares a fragment in no known form: {"form":"query","key":"x"}',
      'declares a fragment in no known form: null',
    ]);
  });
  test('the frame sections (S4, S5, S7): real shapes pass', () => {
    expect(
      found(
        half('agenda', {
          screens: [{ id: 'inbox', nav: { label: 'Inbox' } }],
          panels: [{ id: 'needs-you', slot: 'nav' }],
          navPanels: ['needs-you'],
          navBadges: ['inbox'],
          background: ['watch'],
        }),
        half('updates', {
          panels: [{ id: 'install', slot: 'device.settings' }],
          deviceSettings: ['install'],
        }),
        half('browsers', { links: true }),
        // A panel in another slot needs no device view, and a skeleton half's panels are not asked for.
        half('conversation', { panels: [{ id: 'queue', slot: 'ferret.side' }] }),
        half('late', { skeleton: true, panels: [{ id: 'x', slot: 'nav' }] }),
      ),
    ).toEqual([]);
  });
  test('planted: a links provider outside the taker list is found', () => {
    expect(found(half('conversation', { links: true }))).toEqual([
      expect.stringContaining('provides `shell.links`, but only browsers may'),
    ]);
  });
  test('planted: a navBadges key that is not an own screen with a nav entry is found', () => {
    expect(found(half('agenda', { navBadges: ['inbox'] }))).toEqual([
      'has a `shell.navBadges` key "inbox", which is not one of its own screens',
    ]);
    expect(found(half('agenda', { screens: [{ id: 'inbox' }], navBadges: ['inbox'] }))).toEqual([
      expect.stringContaining('whose screen declares no `nav` entry'),
    ]);
  });
  test('planted: a device.settings or nav view that is no declared panel, and a declared panel with no view, are found', () => {
    expect(found(half('updates', { deviceSettings: ['install'] }))).toEqual([
      'has a `shell.deviceSettings` view "install", which is not a panel it declares in `device.settings`',
    ]);
    expect(
      found(half('agenda', { navPanels: ['needs-you'], panels: [{ id: 'needs-you', slot: 'device.settings' }] })),
    ).toEqual([
      expect.stringContaining('declares the `device.settings` panel "needs-you" with no `shell.deviceSettings` view'),
      'has a `shell.navPanels` view "needs-you", which is not a panel it declares in `nav`',
    ]);
    expect(found(half('agenda', { panels: [{ id: 'needs-you', slot: 'nav' }] }))).toEqual([
      expect.stringContaining('declares the `nav` panel "needs-you" with no `shell.navPanels` view'),
    ]);
  });
  test('planted: background and navBadges on a skeleton half are found', () => {
    expect(
      found(
        half('agenda', {
          skeleton: true,
          background: ['watch'],
          navBadges: ['inbox'],
          screens: [{ id: 'inbox', nav: {} }],
        }),
      ),
    ).toEqual([
      'is a skeleton half with `shell.background` views (watch): nothing mounts them',
      'is a skeleton half with `shell.navBadges` (inbox): nothing draws them',
    ]);
  });
  test('over a workspace: a half that declares a key with no taker fails, and a half that fails to load is said', async () => {
    const fx = fixture([
      {
        id: 'alpha',
        kinds: ['view'],
        manifest: '  ui: { screens: [] },',
        app: `import { implementApp } from '${SDK}';\nimport manifest from '../manifest.ts';\nconst half = implementApp(manifest, { build: () => ({}) });\nexport default { ...half, shell: { fragments: [{ form: 'keyed', key: 'alpha' }] } };\n`,
      },
      { id: 'beta', app: 'throw new Error("boom");\n' },
    ]);
    try {
      const all = (await shellProvides.run(contextFor(fx.root, NO_BASE))).map(x => `${x.where}: ${x.message}`);
      expect(all).toContain(
        'alpha: declares the stripping fragment key "alpha" with no `shell.device` view: the shell would strip a link nothing takes',
      );
      expect(all).toContain('beta: app half failed to load: boom');
      const scoped = await shellProvides.run(contextFor(fx.root, { ...NO_BASE, packageId: 'beta' }));
      expect(scoped.map(x => x.where)).toEqual(['beta']);
    } finally {
      fx.dispose();
    }
  });
});
