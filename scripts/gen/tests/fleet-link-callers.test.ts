/**
 * Fitness test: the declared exception to the credential-home link rule stays exactly as wide as it was declared.
 *
 * `linkTo` and `copyTree` in link mode refuse any link whose place or source is a credential home (`agent-homes`,
 * `credentials`), but `fleet` (Runtimes' fleet credential store and runtime homes) and `harness-home` (the host's own
 * Claude Code / Codex homes) are NOT credential homes to that rule: Runtimes' provisioning links into and out of them
 * with the generic operations (`docs/secrets.md`, "Declared exception: the fleet credential store").
 *
 * That exception is for Runtimes' provisioning ONLY, until the after-merge move (&F3537, "Dedicated credential link
 * operation": Runtimes onto a dedicated credential operation, the fleet store becoming a credential home). This test
 * pins it so a future caller cannot slip in first:
 *
 * 1. no production module other than Runtimes' `fleet-disk.ts` and `file-provisioner.ts` reaches `linkTo` or `copyTree`
 *    (called, aliased or destructured; the kernel's own host, testing host and contract define them and are not callers);
 * 2. the allowed files really do (a stale allowance would hide a removal, and the after-merge move must delete it);
 * 3. `fleet` and `harness-home` are held by no plugin but Runtimes, by the kernel's ownership rule and by every manifest.
 */
import { describe, expect, test } from 'bun:test';
import { join, relative, sep } from 'node:path';
import { mayHoldRoot } from '../../../packages/core/kernel/host/roots.ts';
import { type AstNode, parseFile, walk } from '../lib/check.ts';
import { loadManifests, loadWorkspace, sourceFiles } from '../lib/workspace.ts';

const ROOT = join(import.meta.dir, '..', '..', '..');
const AFTER_MERGE_CARD = '&F3537';
const LINK_OPERATIONS: ReadonlySet<string> = new Set(['linkTo', 'copyTree']);
const FLEET_ROOTS = ['fleet', 'harness-home'] as const;

/** The ONLY modules that may reach a link operation on the fleet or a harness home. Remove both at &F3537. */
const RUNTIMES_PROVISIONING: ReadonlySet<string> = new Set([
  'packages/plugins/runtimes/daemon/adapters/fleet-disk.ts',
  'packages/plugins/runtimes/daemon/adapters/file-provisioner.ts',
]);
/** The kernel's own implementations of the operations: they define the API and are not callers of it. */
const KERNEL_IMPLEMENTATION = [
  'packages/core/kernel/host/',
  'packages/core/kernel/testing/',
  'packages/core/kernel/contract/',
];

const posix = (path: string): string => relative(ROOT, path).split(sep).join('/');

function operationOf(node: AstNode): string | undefined {
  const name = (key: unknown): string | undefined => {
    const found = key as AstNode | undefined;
    if (found?.type === 'Identifier') return found.name as string;
    if (found?.type === 'Literal' && typeof found.value === 'string') return found.value;
    return undefined;
  };
  // `root.linkTo`, `root?.linkTo`, `root['copyTree']`
  if (node.type === 'MemberExpression') {
    const property = name(node.property);
    return property !== undefined && LINK_OPERATIONS.has(property) ? property : undefined;
  }
  // `const { linkTo } = root`, `const { copyTree: copy } = root`
  if (node.type === 'ObjectPattern') {
    for (const entry of (node.properties as AstNode[] | undefined) ?? []) {
      const key = entry.type === 'Property' ? name(entry.key) : undefined;
      if (key !== undefined && LINK_OPERATIONS.has(key)) return key;
    }
  }
  return undefined;
}

/** Every `file:line operation` in the production source of the repo (tests excluded) that reaches a link operation. */
function reaches(): Map<string, string[]> {
  const ws = loadWorkspace(ROOT);
  const found = new Map<string, string[]>();
  const files = [
    ...ws.packages.flatMap(pkg => sourceFiles(pkg, { tests: false })),
    ...[...new Bun.Glob('migration/**/*.{ts,tsx,mts}').scanSync({ cwd: ROOT, onlyFiles: true })]
      .filter(path => !path.includes('node_modules/') && !/(^|\/)(tests?|fixtures)\//.test(path))
      .map(path => join(ROOT, path)),
  ];
  for (const file of files) {
    const rel = posix(file);
    if (KERNEL_IMPLEMENTATION.some(prefix => rel.startsWith(prefix))) continue;
    const parsed = parseFile(file);
    walk(parsed.program, node => {
      const operation = operationOf(node);
      if (operation === undefined) return;
      found.set(rel, [...(found.get(rel) ?? []), `${rel}:${parsed.line(node.start)} ${operation}`]);
    });
  }
  return found;
}

describe('the fleet and harness-home link exception (declared; to be removed at the after-merge move)', () => {
  test('no production module outside Runtimes’ provisioning reaches linkTo or copyTree', () => {
    const strays = [...reaches()].filter(([rel]) => !RUNTIMES_PROVISIONING.has(rel)).flatMap(([, places]) => places);
    expect(
      strays,
      `${strays.join('; ')} reach a generic link operation. Generic links from/into the fleet credential store and the ` +
        `host harness homes are a declared exception for Runtimes' provisioning only (docs/secrets.md); a new caller must ` +
        `not appear before the after-merge move (${AFTER_MERGE_CARD}, dedicated credential link operation).`,
    ).toEqual([]);
  });

  test('the two allowed modules still make the calls (a stale allowance is removed with the move)', () => {
    const found = reaches();
    for (const allowed of RUNTIMES_PROVISIONING)
      expect(
        found.has(allowed),
        `${allowed} no longer reaches linkTo or copyTree: delete it from RUNTIMES_PROVISIONING (${AFTER_MERGE_CARD})`,
      ).toBe(true);
  });

  test('fleet and harness-home are held by Runtimes alone: the kernel’s rule and every manifest', async () => {
    for (const root of FLEET_ROOTS) {
      expect(mayHoldRoot('runtimes', root)).toBe(true);
      for (const other of ['logins', 'codex', 'claude', 'mcp', 'skills', 'terminals', 'ferrets', 'impostor'])
        expect(mayHoldRoot(other, root)).toBe(false);
    }
    const { loaded, failures } = await loadManifests(loadWorkspace(ROOT));
    expect(failures).toEqual([]);
    const holders = loaded
      .filter(({ manifest }) => FLEET_ROOTS.some(root => (manifest.permissions?.roots ?? []).includes(root)))
      .map(({ id }) => id);
    expect(
      holders,
      `a plugin other than runtimes declares fleet or harness-home: the declared link exception covers Runtimes only (${AFTER_MERGE_CARD})`,
    ).toEqual(['runtimes']);
  });
});
