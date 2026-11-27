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
      'tests/unit/lib/other-half.test.ts': "import '../../../../claude-code/daemon/private.ts';\n",
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
