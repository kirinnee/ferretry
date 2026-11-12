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
 *    (read, aliased, destructured, or reached through a constant or unresolvable computed key on a `RootHandle`). NO
 *    directory is exempt: the kernel's host, testing host and contract are scanned like any module, and they pass because
 *    the API's definitions (`linkTo: async …` in an object, `linkTo(…)` in an interface) are not member reads — a NEW
 *    kernel module that calls `fleet.linkTo` fails;
 * 2. the allowed files really do (a stale allowance would hide a removal, and the after-merge move must delete it);
 * 3. `fleet` and `harness-home` are held by no plugin but Runtimes, by the kernel's ownership rule and by every manifest;
 * 4. the scanner itself catches each shape of a stray caller (isolated fixture workspaces, below), so (1) cannot go
 *    vacuously green.
 *
 * The scanner is `../lib/fleet-link-scan.ts`; its docs say what it does not handle.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { mayHoldRoot } from '../../../packages/core/kernel/host/roots.ts';
import { UNRESOLVED_OPERATION, reaches } from '../lib/fleet-link-scan.ts';
import { loadManifests, loadWorkspace } from '../lib/workspace.ts';

const ROOT = join(import.meta.dir, '..', '..', '..');
const AFTER_MERGE_CARD = '&F3537';
const FLEET_ROOTS = ['fleet', 'harness-home'] as const;

const FLEET_DISK = 'packages/plugins/runtimes/daemon/adapters/fleet-disk.ts';
const FILE_PROVISIONER = 'packages/plugins/runtimes/daemon/adapters/file-provisioner.ts';
/** The ONLY modules that may reach a link operation on the fleet or a harness home. Remove both at &F3537. */
const RUNTIMES_PROVISIONING: ReadonlySet<string> = new Set([FLEET_DISK, FILE_PROVISIONER]);

const reachesAt = (root: string): Map<string, string[]> =>
  reaches(root, file => relative(root, file).split(sep).join('/'));
/** The real tree is scanned once for the tests that read it (parsing every production module is the cost). */
let realTree: Map<string, string[]> | undefined;
const realReaches = (): Map<string, string[]> => (realTree ??= reachesAt(ROOT));

/** Every `file:line operation` reached outside the allowed modules. */
const strays = (found: ReadonlyMap<string, string[]>): string[] =>
  [...found].filter(([rel]) => !RUNTIMES_PROVISIONING.has(rel)).flatMap(([, places]) => places);

describe('the fleet and harness-home link exception (declared; to be removed at the after-merge move)', () => {
  test('no production module outside Runtimes’ provisioning reaches linkTo or copyTree', () => {
    const found = strays(realReaches());
    expect(
      found,
      `${found.join('; ')} reach a generic link operation. Generic links from/into the fleet credential store and the ` +
        `host harness homes are a declared exception for Runtimes' provisioning only (docs/secrets.md); a new caller must ` +
        `not appear before the after-merge move (${AFTER_MERGE_CARD}, dedicated credential link operation).`,
    ).toEqual([]);
  });

  test('the two allowed modules still make the calls (a stale allowance is removed with the move)', () => {
    const found = realReaches();
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

describe('the scanner catches every shape of a stray caller (isolated fixture workspaces)', () => {
  const TYPES = `import type { FencedPath, RootHandle, RootLinkTarget } from '@ferretry/kernel/contract';\n`;
  const made: string[] = [];
  afterAll(async () => {
    await Promise.all(made.map(dir => rm(dir, { recursive: true, force: true })));
  });

  /** A workspace holding exactly the two allowed modules (so the stale-allowance shape holds) plus `extra`. */
  async function workspace(extra: Readonly<Record<string, string>> = {}): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-link-fixture-'));
    made.push(dir);
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'fixture', workspaces: ['packages/core/*', 'packages/plugins/*'] }),
      'packages/core/kernel/package.json': JSON.stringify({ name: '@fixture/kernel' }),
      'packages/plugins/runtimes/package.json': JSON.stringify({ name: '@fixture/runtimes' }),
      'packages/plugins/other/package.json': JSON.stringify({ name: '@fixture/other' }),
      [FLEET_DISK]: `${TYPES}export const anchor = (root: RootHandle) => root.copyTree;\n`,
      [FILE_PROVISIONER]: `${TYPES}export const anchor = (root: RootHandle) => root.linkTo;\n`,
      ...extra,
    };
    for (const [file, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, file)), { recursive: true });
      await writeFile(join(dir, file), text);
    }
    return dir;
  }

  const CALL = 'at: FencedPath, target: RootLinkTarget';

  /** Each stray shape: where it sits, the code, and what it is reported as. */
  const STRAYS: readonly {
    readonly name: string;
    readonly file: string;
    readonly code: string;
    readonly as: string;
  }[] = [
    {
      name: 'a new kernel host helper calling fleet.linkTo',
      file: 'packages/core/kernel/host/fleet-repair.ts',
      code: `${TYPES}export function restoreAlias(fleet: RootHandle, ${CALL}) {\n  return fleet.linkTo(at, target);\n}\n`,
      as: 'linkTo',
    },
    {
      name: 'a kernel worker-grants write handler calling copyTree',
      file: 'packages/core/kernel/host/worker-grants/write-handler.ts',
      code: `${TYPES}export const serve = (fleet: RootHandle, from: RootHandle, path: FencedPath) =>\n  fleet.copyTree(from, path, path, { link: true });\n`,
      as: 'copyTree',
    },
    {
      name: 'a new kernel testing helper using an optional literal-key call',
      file: 'packages/core/kernel/testing/relink.ts',
      code: `${TYPES}export const relink = async (fleet: RootHandle, ${CALL}) => void (await fleet?.['linkTo'](at, target));\n`,
      as: 'linkTo',
    },
    {
      name: 'a plugin worker module calling linkTo',
      file: 'packages/plugins/other/daemon/worker/link-worker.ts',
      code: `${TYPES}export const run = (root: RootHandle, ${CALL}) => root.linkTo(at, target);\n`,
      as: 'linkTo',
    },
    {
      name: 'a call through a constant computed key',
      file: 'packages/plugins/runtimes/daemon/adapters/restore-alias.ts',
      code: `${TYPES}const operation = 'linkTo' as const;\nexport function restoreAlias(fleet: RootHandle, ${CALL}) {\n  return fleet[operation](at, target);\n}\n`,
      as: 'linkTo',
    },
    {
      name: 'a copyTree call through a constant computed key (template, satisfies)',
      file: 'packages/plugins/other/daemon/copy-alias.ts',
      code: `${TYPES}const op = \`copyTree\` satisfies string;\nexport const copy = (fleet: RootHandle, from: RootHandle, p: FencedPath) => fleet[op](from, p, p);\n`,
      as: 'copyTree',
    },
    {
      name: 'a computed destructuring through a constant',
      file: 'packages/plugins/runtimes/daemon/adapters/destructure-alias.ts',
      code: `${TYPES}const operation = 'linkTo' as const;\nexport const alias = (fleet: RootHandle) => {\n  const { [operation]: link } = fleet;\n  return link;\n};\n`,
      as: 'linkTo',
    },
    {
      name: 'a literal destructuring alias',
      file: 'packages/plugins/other/daemon/destructure-literal.ts',
      code: `export const alias = (fleet: { linkTo: unknown }) => {\n  const { linkTo: link } = fleet;\n  return link;\n};\n`,
      as: 'linkTo',
    },
    {
      name: 'an unresolvable computed key on a RootHandle parameter fails closed',
      file: 'packages/plugins/runtimes/daemon/adapters/dispatch.ts',
      code: `${TYPES}export const dispatch = (fleet: RootHandle, name: string, ${CALL}) => (fleet as never as Record<string, Function>)[name]?.(at, target);\n`,
      as: UNRESOLVED_OPERATION,
    },
    {
      name: 'an imported (so unresolvable) constant key on a RootHandle alias fails closed',
      file: 'packages/plugins/other/daemon/dispatch-imported.ts',
      code: `${TYPES}import { OPERATION } from './operations.ts';\nexport function run(fleet: RootHandle, ${CALL}) {\n  const handle = fleet;\n  return handle[OPERATION](at, target);\n}\n`,
      as: UNRESOLVED_OPERATION,
    },
    {
      name: 'an unresolvable computed destructuring of a RootHandle field fails closed',
      file: 'packages/plugins/other/daemon/dispatch-pattern.ts',
      code: `${TYPES}export class Repair {\n  constructor(private readonly fleet: RootHandle) {}\n  pick(name: string) {\n    const { [name]: found } = this.fleet;\n    return found;\n  }\n}\n`,
      as: UNRESOLVED_OPERATION,
    },
  ];

  test('a workspace of only the two allowed modules has no stray, and both allowed modules are found', async () => {
    const found = reachesAt(await workspace());
    expect(strays(found)).toEqual([]);
    expect([...found.keys()].sort()).toEqual([FLEET_DISK, FILE_PROVISIONER].sort());
  });

  for (const stray of STRAYS)
    test(`detects ${stray.name}`, async () => {
      const found = strays(reachesAt(await workspace({ [stray.file]: stray.code })));
      expect(found.length).toBeGreaterThan(0);
      expect(found.every(place => place.startsWith(`${stray.file}:`))).toBe(true);
      expect(found.map(place => place.split(' ').at(-1))).toContain(stray.as);
    });

  test('the kernel’s own definitions of the operations are not callers, and ordinary computed access is not flagged', async () => {
    const found = strays(
      reachesAt(
        await workspace({
          'packages/core/kernel/host/definitions.ts':
            `${TYPES}export interface Door {\n  linkTo(${CALL}): Promise<void>;\n  copyTree(from: RootHandle, a: FencedPath, b: FencedPath): Promise<void>;\n}\n` +
            `export const door: Door = {\n  linkTo: async () => undefined,\n  copyTree: async () => undefined,\n};\n` +
            `export const lookup = (fleet: RootHandle, table: Record<string, number>, name: string, i: number) => [table[name], [1][i], fleet.toString()];\n`,
          'packages/plugins/other/daemon/lookup.ts': `export const pick = (table: Record<string, number>, key: string) => table[key];\n`,
        }),
      ),
    );
    expect(found).toEqual([]);
  });
});
