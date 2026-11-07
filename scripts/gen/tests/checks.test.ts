/**
 * Planted-violation tests for every §7.9 check (each check has a test that plants a violation and sees it found, and
 * a clean case that stays quiet). Fixture workspaces live under `scripts/gen/tests/.tmp/`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { contextFor } from '../lib/check.ts';
import type { Finding } from '../lib/graph.ts';
import { check as actRunner } from '../../validate/act-runner.ts';
import { bannedIn, check as bannedGlobals } from '../../validate/banned-globals.ts';
import { check as contextImports } from '../../validate/context-imports.ts';
import { check as contractConsumes } from '../../validate/contract-consumes.ts';
import { check as contractGraph } from '../../validate/contract-graph.ts';
import { check as coreClosed } from '../../validate/core-closed.ts';
import { parity, readChanges } from '../../validate/descriptor-parity.ts';
import { check as glossary, glossaryFindings } from '../../validate/glossary.ts';
import { enforcerSymbols, guaranteeFindings, parseTsv } from '../../validate/guarantees.ts';
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
  options?: { pending?: readonly string[]; pendingReasons?: Readonly<Record<string, readonly string[]>> },
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
});

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
      { pending: ['alpha', 'beta', 'ghost'] },
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

    const stray = ws([{ id: 'beta' }], { pending: ['beta'], pendingReasons: { alpha: ['a reason for nobody'] } });
    stray.write('base.json', JSON.stringify({ format: 1, pending: ['beta'] }));
    expect(messages(await run(portsPending, stray, { base: `file:${join(stray.root, 'base.json')}` }))).toContain(
      'alpha has reasons but is not listed in "pending"',
    );
  });
  test('a shrinking list of skeletons passes', async () => {
    const f = ws([{ id: 'beta' }], { pending: ['beta'] });
    f.write('base.json', JSON.stringify({ format: 1, pending: ['alpha', 'beta'] }));
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
          'daemon/worker/adapters/main.ts': 'const endpoint = process.argv[2]; setTimeout(() => {}, 1);',
          'daemon/worker/launcher.ts': 'await fetch("http://127.0.0.1:9222/json/version");',
        },
      },
      { id: 'other', files: { 'worker/src/worker.ts': 'await fetch("https://fixture.invalid");' } },
    ]);
    const found = await run(bannedGlobals, f);
    expect(found).toHaveLength(4);
    expect(messages(found)).toContain('connections/daemon/worker.ts');
    expect(messages(found)).toContain('browsers/daemon/worker/launcher.ts');
    expect(messages(found)).not.toContain('browsers/daemon/worker/adapters/');
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
