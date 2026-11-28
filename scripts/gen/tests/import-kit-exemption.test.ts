import { afterAll, expect, test } from 'bun:test';
import { contextFor } from '../lib/check.ts';
import { check } from '../../validate/context-imports.ts';
import { fixture } from './fixture.ts';

const TESTS = [
  'tests/unit/golden/host-import.golden.test.ts',
  'tests/unit/golden/setup-import.golden.test.ts',
  'tests/unit/golden/consumers.golden.test.ts',
  'tests/unit/lib/import-kit-threading.test.ts',
  'tests/unit/daemon/host-harness-scan.test.ts',
  'tests/unit/daemon/host-harness-scan-projects.test.ts',
  'tests/integration/host-harness-scan.test.ts',
  'tests/integration/daemon/host-harness-scan-roots.test.ts',
  'tests/integration/daemon/file-deps.test.ts',
  'tests/unit/daemon/composed-daemon.test.ts',
  'tests/unit/daemon/generic-runtime.test.ts',
  'tests/unit/daemon/import-fresh-home.test.ts',
  'tests/unit/lib/account-import.test.ts',
  'tests/unit/lib/account-import-skip.test.ts',
  'tests/unit/lib/account-import-retry.test.ts',
  'tests/unit/lib/account-import-login-env.test.ts',
  'tests/unit/lib/account-import-branches.test.ts',
  'tests/unit/daemon/setup-service.test.ts',
  'tests/unit/golden/credentials.golden.test.ts',
  'tests/unit/golden/support/world.ts',
  'tests/support/real-kits.ts',
];
const imports = (prefix: string) =>
  `import '${prefix}claude-code/daemon/lib/runtimes-kit/index.ts';\nimport '${prefix}codex/daemon/lib/runtimes-kit/index.ts';\n`;
const f = fixture([
  {
    id: 'runtimes',
    files: {
      ...Object.fromEntries(TESTS.map(path => [path, imports('../'.repeat(path.split('/').length))])),
      'tests/unit/lib/unlisted.test.ts': imports('../../../../'),
      'tests/unit/golden/nearby.test.ts': imports('../../../../'),
      'daemon/private.ts': imports('../../'),
      'tests/unit/lib/other-half.test.ts': "import '../../../../../plugins/claude-code/daemon/private.ts';\n",
    },
  },
  ...['claude-code', 'codex'].map(id => ({
    id,
    files: {
      'daemon/lib/runtimes-kit/index.ts': 'export const kit = {};\n',
      'daemon/private.ts': 'export {};\n',
    },
  })),
  { id: 'other', files: { 'tests/unit/lib/import-kit-threading.test.ts': imports('../../../../') } },
]);
afterAll(() => f.dispose());

const MOVED = [
  ['tests/unit/golden/supervision.golden.test.ts', 'codex-runtime'],
  ['tests/unit/golden/supervision.golden.test.ts', 'runtime-end-supervision'],
  ['tests/unit/golden/mcp.golden.test.ts', 'model-catalog'],
] as const;
const movedImport = (module: string, path = 'tests/unit/golden/x.test.ts') =>
  `import '${'../'.repeat(path.split('/').length)}codex/daemon/lib/runtimes-kit/${module}.ts';\n`;
const moved = fixture([
  {
    id: 'runtimes',
    files: {
      ...Object.fromEntries(MOVED.map(([path, module]) => [path, movedImport(module, path)])),
      // Right file, wrong module: not named.
      'tests/unit/golden/mcp-extra.golden.test.ts': movedImport(
        'model-catalog',
        'tests/unit/golden/mcp-extra.golden.test.ts',
      ),
      'tests/unit/lib/other.test.ts': movedImport('codex-runtime', 'tests/unit/lib/other.test.ts'),
    },
  },
  {
    id: 'codex',
    files: Object.fromEntries(
      ['codex-runtime', 'runtime-end-supervision', 'model-catalog'].map(m => [
        `daemon/lib/runtimes-kit/${m}.ts`,
        'export {};\n',
      ]),
    ),
  },
]);
afterAll(() => moved.dispose());

test('only the two named goldens may import only the three moved Codex modules', async () => {
  const findings = await check.run(contextFor(moved.root, { base: 'file:/nonexistent/ports-pending.json' }));
  const found = findings.map(finding => `${finding.where}: ${finding.message}`).join('\n');
  for (const [path] of MOVED) expect(found).not.toContain(`runtimes/${path}:`);
  expect(found).toContain('runtimes/tests/unit/golden/mcp-extra.golden.test.ts:');
  expect(found).toContain('runtimes/tests/unit/lib/other.test.ts:');
  expect(findings).toHaveLength(2);
});

test('only the named Runtimes integration proofs may import the two real kit entry points', async () => {
  const findings = await check.run(contextFor(f.root, { base: 'file:/nonexistent/ports-pending.json' }));
  const found = findings.map(finding => `${finding.where}: ${finding.message}`).join('\n');
  for (const path of TESTS) expect(found).not.toContain(`runtimes/${path}:`);
  for (const path of [
    'runtimes/tests/unit/lib/unlisted.test.ts',
    'runtimes/tests/unit/golden/nearby.test.ts',
    'runtimes/daemon/private.ts',
    'runtimes/tests/unit/lib/other-half.test.ts',
    'other/tests/unit/lib/import-kit-threading.test.ts',
  ])
    expect(found).toContain(`${path}:`);
  expect(findings).toHaveLength(9);
});

const FACTS = ['claude-code/daemon/lib/harness/facts.ts', 'codex/daemon/lib/facts.ts'];
const factsImports = (path: string) =>
  FACTS.map(file => `import '${'../'.repeat(path.split('/').length + 1)}plugins/${file}';\n`).join('');
const NAMED = 'tests/unit/golden/transcript-harness.test.ts';
const facts = fixture([
  {
    id: 'ferrets',
    core: true,
    files: {
      [NAMED]: factsImports(NAMED),
      // Right folder, not the named test.
      'tests/unit/golden/other.golden.test.ts': factsImports('tests/unit/golden/other.golden.test.ts'),
      // The named test may not reach any other file of the plugin.
      'tests/unit/golden/transcript-harness-private.test.ts':
        "import '../../../../../plugins/claude-code/daemon/private.ts';\n",
    },
  },
  ...['claude-code', 'codex'].map(id => ({
    id,
    files: {
      'daemon/lib/harness/facts.ts': 'export {};\n',
      'daemon/lib/facts.ts': 'export {};\n',
      'daemon/private.ts': 'export {};\n',
    },
  })),
]);
afterAll(() => facts.dispose());

test('only the named Ferrets golden may import the two real harness facts files', async () => {
  const findings = await check.run(contextFor(facts.root, { base: 'file:/nonexistent/ports-pending.json' }));
  const found = findings.map(finding => `${finding.where}: ${finding.message}`).join('\n');
  expect(found).not.toContain(`ferrets/${NAMED}:`);
  expect(found).toContain('ferrets/tests/unit/golden/other.golden.test.ts:');
  expect(found).toContain('ferrets/tests/unit/golden/transcript-harness-private.test.ts:');
});
