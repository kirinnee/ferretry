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
 * pins it so a future caller cannot slip in first, in two layers, both asked of the TYPE CHECKER and not of the spelling:
 *
 * 1. no production module other than Runtimes' `fleet-disk.ts` reads `linkTo` or `copyTree` off a kernel `RootHandle`
 *    (read, aliased, destructured, spread, reached through a type alias, a dispatch table, a constant, a reassigned or
 *    shadowed key, or an unresolvable computed key — which fails closed). `file-provisioner.ts` is the second authority
 *    module but holds no such read: it links through `FleetDisk.linkTo`, so it is pinned by layer 2 and not allowed a read;
 * 2. the AUTHORITY SURFACE is pinned (`fleet-link-callers.snapshot.json`): the exports of both Runtimes authority
 *    modules, every module importing them (directly or through a re-export), every module that asks the kernel for a
 *    `fleet` / `harness-home` handle and every module that handle is passed to. A new export, importer, origin or
 *    receiver fails, naming &F3537, until a reviewer approves the snapshot change — this is what closes a helper exported
 *    from an allowed module and called from a new one, which no read-based scan can see;
 * 3. the allowed module really does read (a stale allowance would hide a removal, and the after-merge move must delete it);
 * 4. `fleet` and `harness-home` are held by no plugin but Runtimes, by the kernel's ownership rule and by every manifest;
 * 5. the scanner itself catches each ordinary shape of a stray caller (isolated fixture workspaces, below) and ignores the
 *    ordinary code around it, so (1) and (2) cannot go vacuously green.
 *
 * The scanner is `../lib/fleet-link-scan.ts`, the surface `../lib/fleet-link-authority.ts`; their docs say what they
 * do not follow (reflection, a handle put in a container).
 *
 * RUNTIME (measured 2026-11-12, Linux x64): one run opens the TypeScript 7 checker over ~4,300 production modules once
 * (~2 s), scans them (~9 s) and derives the surface (~9 s); each fixture workspace adds ~2-3 s (it type-checks the real
 * kernel contract). The timeouts below are those figures with a generous margin: a Bun test defaults to 5 s.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mayHoldRoot } from '../../../packages/core/kernel/host/roots.ts';
import { type AuthoritySurface, authoritySurface, describeSurfaceChange } from '../lib/fleet-link-authority.ts';
import { type ProductionProgram, openProductionProgram } from '../lib/fleet-link-program.ts';
import { UNRESOLVED_OPERATION, reachesIn } from '../lib/fleet-link-scan.ts';
import { loadManifests, loadWorkspace } from '../lib/workspace.ts';

const ROOT = join(import.meta.dir, '..', '..', '..');
const AFTER_MERGE_CARD = '&F3537';
const FLEET_ROOTS = ['fleet', 'harness-home'] as const;
const SNAPSHOT = join(import.meta.dir, 'fleet-link-callers.snapshot.json');

const FLEET_DISK = 'packages/plugins/runtimes/daemon/adapters/fleet-disk.ts';
const FILE_PROVISIONER = 'packages/plugins/runtimes/daemon/adapters/file-provisioner.ts';
/** The ONLY module that may read a link operation off a `RootHandle`. Remove it at &F3537. */
const RUNTIMES_PROVISIONING: ReadonlySet<string> = new Set([FLEET_DISK]);
/** The modules whose exported surface is pinned: the provisioning reads and the provisioner that drives them. */
const AUTHORITY_MODULES: readonly string[] = [FLEET_DISK, FILE_PROVISIONER];

/** Measured: ~20 s for the real tree, ~3 s per fixture workspace (see the file header). */
const REAL_TREE_MS = 180_000;
const FIXTURE_MS = 60_000;

/** Every `file:line operation` reached outside the allowed modules. */
const strays = (found: ReadonlyMap<string, string[]>): string[] =>
  [...found].filter(([rel]) => !RUNTIMES_PROVISIONING.has(rel)).flatMap(([, places]) => places);

interface Scanned {
  readonly reaches: Map<string, string[]>;
  readonly surface: AuthoritySurface;
}

async function scan(root: string): Promise<Scanned> {
  const program: ProductionProgram = await openProductionProgram(root);
  try {
    return { reaches: await reachesIn(program), surface: await authoritySurface(program, AUTHORITY_MODULES) };
  } finally {
    await program.close();
  }
}

describe('the fleet and harness-home link exception (declared; to be removed at the after-merge move)', () => {
  let real: Scanned;
  beforeAll(async () => {
    real = await scan(ROOT);
  }, REAL_TREE_MS);

  test('no production module outside Runtimes’ provisioning reads linkTo or copyTree off a RootHandle', () => {
    const found = strays(real.reaches);
    expect(
      found,
      `${found.join('; ')} reach a generic link operation. Generic links from/into the fleet credential store and the ` +
        `host harness homes are a declared exception for Runtimes' provisioning only (docs/secrets.md); a new caller must ` +
        `not appear before the after-merge move (${AFTER_MERGE_CARD}, dedicated credential link operation).`,
    ).toEqual([]);
  });

  test('the allowed module still makes the calls (a stale allowance is removed with the move)', () => {
    for (const allowed of RUNTIMES_PROVISIONING)
      expect(
        real.reaches.has(allowed),
        `${allowed} no longer reads linkTo or copyTree: delete it from RUNTIMES_PROVISIONING (${AFTER_MERGE_CARD})`,
      ).toBe(true);
  });

  test('the authority surface is exactly the approved snapshot', async () => {
    if (process.env.FLEET_LINK_SNAPSHOT_UPDATE === '1') {
      await writeFile(SNAPSHOT, `${JSON.stringify(real.surface, null, 2)}\n`);
      return;
    }
    expect(
      existsSync(SNAPSHOT),
      `${SNAPSHOT} is missing: a reviewer must approve the first snapshot (${AFTER_MERGE_CARD})`,
    ).toBe(true);
    const approved = JSON.parse(await readFile(SNAPSHOT, 'utf8')) as AuthoritySurface;
    expect(describeSurfaceChange(approved, real.surface, AFTER_MERGE_CARD)).toEqual([]);
    expect(real.surface).toEqual(approved);
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

describe('the guard catches every ordinary shape of a stray caller (isolated fixture workspaces)', () => {
  const TYPES = `import type { FencedPath, RootHandle, RootLinkTarget, RootsPort } from '@ferretry/kernel/contract';\n`;
  const CALL = 'at: FencedPath, target: RootLinkTarget';
  const ADAPTERS = 'packages/plugins/runtimes/daemon/adapters';
  const made: string[] = [];
  afterAll(async () => {
    await Promise.all(made.map(dir => rm(dir, { recursive: true, force: true })));
  });

  /**
   * A workspace holding the two authority modules (the way the real ones are shaped: the disk reads the operations, the
   * provisioner drives the disk) plus `extra`, type-checking against the REAL kernel contract.
   */
  async function workspace(
    extra: Readonly<Record<string, string>> = {},
    replace: Readonly<Record<string, string>> = {},
  ): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-link-fixture-'));
    made.push(dir);
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'fixture', workspaces: ['packages/core/*', 'packages/plugins/*'] }),
      'tsconfig.json': JSON.stringify({
        extends: join(ROOT, 'tsconfig.json'),
        compilerOptions: {
          noUnusedLocals: false,
          noUnusedParameters: false,
          typeRoots: [join(ROOT, 'node_modules', '@types')],
          paths: { '@ferretry/kernel/contract': [join(ROOT, 'packages/core/kernel/contract/index.ts')] },
        },
        include: ['packages/**/*.ts'],
        exclude: [],
      }),
      'packages/core/kernel/package.json': JSON.stringify({ name: '@fixture/kernel' }),
      'packages/plugins/runtimes/package.json': JSON.stringify({ name: '@fixture/runtimes' }),
      'packages/plugins/other/package.json': JSON.stringify({ name: '@fixture/other' }),
      [FLEET_DISK]:
        `${TYPES}export class FleetDisk {\n  constructor(private readonly fleet: RootHandle) {}\n` +
        `  link(${CALL}) {\n    return this.fleet.linkTo(at, target);\n  }\n` +
        `  copy(from: RootHandle, at: FencedPath) {\n    return this.fleet.copyTree(from, at, at);\n  }\n}\n`,
      [FILE_PROVISIONER]:
        `import type { FleetDisk } from './fleet-disk.ts';\nexport class FileFleetProvisioner {\n` +
        `  constructor(private readonly disk: FleetDisk) {}\n  apply() {\n    return this.disk;\n  }\n}\n`,
      ...extra,
      ...replace,
    };
    for (const [file, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, file)), { recursive: true });
      await writeFile(join(dir, file), text);
    }
    return dir;
  }

  /** The ordinary contract module an alias or a dispatch table would live in. */
  const HANDLES = {
    'packages/plugins/runtimes/contract/handles.ts':
      `${TYPES}export type FleetRoot = RootHandle;\nexport const operations = { alias: 'linkTo', copy: 'copyTree' } as const;\n` +
      `export const OPERATION = 'linkTo' as const;\nexport const LOOSE: string = 'stat';\n`,
  };

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
      code: `${TYPES}export const relink = async (fleet: RootHandle | undefined, ${CALL}) => void (await fleet?.['linkTo'](at, target));\n`,
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
      file: `${ADAPTERS}/restore-alias.ts`,
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
      file: `${ADAPTERS}/destructure-alias.ts`,
      code: `${TYPES}const operation = 'linkTo' as const;\nexport const alias = (fleet: RootHandle) => {\n  const { [operation]: link } = fleet;\n  return link;\n};\n`,
      as: 'linkTo',
    },
    {
      name: 'a literal destructuring of a look-alike object typed with the operation',
      file: 'packages/plugins/other/daemon/destructure-literal.ts',
      code: `${TYPES}export const alias = (fleet: { linkTo: RootHandle['linkTo'] }) => {\n  const { linkTo: link } = fleet;\n  return link;\n};\n`,
      as: 'linkTo',
    },
    {
      name: 'an assignment destructuring',
      file: 'packages/plugins/other/daemon/destructure-assign.ts',
      code: `${TYPES}export function pick(fleet: RootHandle) {\n  let link: RootHandle['linkTo'] | undefined;\n  ({ linkTo: link } = fleet);\n  return link;\n}\n`,
      as: 'linkTo',
    },
    {
      name: 'an unresolvable computed key on a handle cast to a record fails closed',
      file: `${ADAPTERS}/dispatch.ts`,
      code: `${TYPES}export const dispatch = (fleet: RootHandle, name: string, ${CALL}) => (fleet as never as Record<string, Function>)[name]?.(at, target);\n`,
      as: UNRESOLVED_OPERATION,
    },
    {
      name: 'an imported key typed only as string fails closed',
      file: 'packages/plugins/other/daemon/dispatch-imported.ts',
      code: `${TYPES}import { LOOSE } from '../../runtimes/contract/handles.ts';\nexport function run(fleet: RootHandle, ${CALL}) {\n  const handle = fleet;\n  return (handle as unknown as Record<string, Function>)[LOOSE]?.(at, target);\n}\n`,
      as: UNRESOLVED_OPERATION,
    },
    {
      name: 'a handle indexed by a plain string (a template key, a type parameter) fails closed',
      file: 'packages/plugins/other/daemon/dispatch-string.ts',
      code: `${TYPES}export const run = (fleet: RootHandle, name: string) => (fleet as any)[\`\${name}\`];\nexport const generic = <K extends string>(fleet: RootHandle, key: K) => (fleet as any)[key];\n`,
      as: UNRESOLVED_OPERATION,
    },
    {
      name: 'an unresolvable computed destructuring of a RootHandle field fails closed',
      file: 'packages/plugins/other/daemon/dispatch-pattern.ts',
      code: `${TYPES}export class Repair {\n  constructor(private readonly fleet: RootHandle) {}\n  pick(name: string) {\n    const { [name]: found } = this.fleet as any;\n    return found;\n  }\n}\n`,
      as: UNRESOLVED_OPERATION,
    },
    {
      // cc6 F1: the alias and the table live in a contract module, so neither the contract nor the caller names the type or the word.
      name: 'an imported type alias and an imported dispatch table (cc6 F1)',
      file: `${ADAPTERS}/restore-imported-alias.ts`,
      code: `import type { FleetRoot } from '../../contract/handles.ts';\nimport { operations } from '../../contract/handles.ts';\nexport function restore(fleet: FleetRoot, ...args: Parameters<FleetRoot[typeof operations.alias]>) {\n  return fleet[operations.alias](...args);\n}\n`,
      as: 'linkTo',
    },
    {
      name: 'an imported type alias with an imported-key computed destructuring (cc6 F1)',
      file: `${ADAPTERS}/restore-imported-destructure.ts`,
      code: `import type { FleetRoot } from '../../contract/handles.ts';\nimport { operations } from '../../contract/handles.ts';\nexport const getAlias = (fleet: FleetRoot) => {\n  const { [operations.alias]: restore } = fleet;\n  return restore;\n};\n`,
      as: 'linkTo',
    },
    {
      name: 'a same-module type alias (cc6 F1)',
      file: `${ADAPTERS}/restore-local-alias.ts`,
      code: `${TYPES}type FleetRoot = RootHandle;\nconst operations = { alias: 'linkTo' } as const;\nexport const restore = (fleet: FleetRoot, ${CALL}) => fleet[operations.alias](at, target);\n`,
      as: 'linkTo',
    },
    {
      name: 'a shadowed key: a module constant of the same name does not certify the parameter (cc6 F2)',
      file: `${ADAPTERS}/restore-shadowed.ts`,
      code: `${TYPES}const operation = 'stat' as const;\nexport const probe = (fleet: RootHandle) => fleet[operation];\nexport function restore(fleet: RootHandle, operation: 'linkTo', ${CALL}) {\n  return fleet[operation](at, target);\n}\n`,
      as: 'linkTo',
    },
    {
      name: 'a reassigned key (cc6 F2)',
      file: `${ADAPTERS}/restore-mutable.ts`,
      code: `${TYPES}export function restore(fleet: RootHandle, ${CALL}) {\n  let operation: 'stat' | 'linkTo' = 'stat';\n  if (target) operation = 'linkTo';\n  if (operation === 'linkTo') return fleet[operation](at, target);\n}\n`,
      as: 'linkTo',
    },
    {
      name: 'a key typed as the union of every handle member',
      file: `${ADAPTERS}/restore-keyof.ts`,
      code: `${TYPES}export const call = (fleet: RootHandle, key: 'stat' | 'linkTo') => fleet[key];\n`,
      as: 'linkTo',
    },
    {
      name: 'an interface extending RootHandle, a Pick of it and a class implementing it',
      file: `${ADAPTERS}/restore-derived.ts`,
      code:
        `${TYPES}interface Wide extends RootHandle { readonly extra: number }\nexport const viaInterface = (w: Wide) => w.linkTo;\n` +
        `export const viaPick = (p: Pick<RootHandle, 'copyTree'>) => p.copyTree;\n` +
        `export const viaReadonly = (r: Readonly<RootHandle>) => r['linkTo'];\n` +
        `export const viaUnion = (u: RootHandle | { stat: number }) => (u as RootHandle).linkTo;\n`,
      as: 'linkTo',
    },
    {
      name: 'a spread or a rest of a handle, then read',
      file: `${ADAPTERS}/restore-spread.ts`,
      code:
        `${TYPES}export const viaSpread = (fleet: RootHandle) => ({ ...fleet }).linkTo;\n` +
        `export const viaRest = (fleet: RootHandle) => {\n  const { resolve, ...rest } = fleet;\n  void resolve;\n  return rest.copyTree;\n};\n`,
      as: 'linkTo',
    },
    {
      name: 'a handle laundered through an any variable then indexed by a string',
      file: `${ADAPTERS}/restore-any-variable.ts`,
      code: `${TYPES}export function run(fleet: RootHandle, name: string) {\n  const loose: any = fleet;\n  return loose[name];\n}\n`,
      as: UNRESOLVED_OPERATION,
    },
    {
      name: 'a handle laundered through an any parameter then indexed by a string',
      file: `${ADAPTERS}/restore-any-parameter.ts`,
      code: `${TYPES}function pick(holder: any, name: string) {\n  return holder[name];\n}\nexport const run = (fleet: RootHandle, name: string) => pick(fleet, name);\n`,
      as: UNRESOLVED_OPERATION,
    },
    {
      name: 'an any-typed receiver reading the operation by name',
      file: 'packages/plugins/other/daemon/any-literal.ts',
      code: `export const run = (loose: any) => loose.copyTree;\n`,
      as: 'copyTree',
    },
  ];

  /** Code around the strays that must NOT be reported (positive controls). */
  const CONTROLS: Readonly<Record<string, string>> = {
    'packages/core/kernel/host/definitions.ts':
      `${TYPES}export interface Door {\n  linkTo(${CALL}): Promise<void>;\n  copyTree(from: RootHandle, a: FencedPath, b: FencedPath): Promise<void>;\n}\n` +
      `export const door: Door = {\n  linkTo: async () => undefined,\n  copyTree: async () => undefined,\n};\n` +
      `export const lookup = (fleet: RootHandle, table: Record<string, number>, name: string, i: number) => [table[name], [1][i], fleet.toString(), fleet['name']];\n`,
    'packages/plugins/other/daemon/lookup.ts': `export const pick = (table: Record<string, number>, key: string) => table[key];\n`,
    // A different port's `linkTo`, with another signature: not the kernel operation.
    'packages/plugins/other/daemon/other-port.ts': `export interface Pier {\n  linkTo(name: string): void;\n  copyTree(name: string): void;\n}\nexport const dock = (pier: Pier) => [pier.linkTo('a'), pier['copyTree']('b')];\n`,
    'packages/plugins/other/daemon/object-literal.ts': `export const definitions = { linkTo() {}, copyTree: () => undefined };\n`,
    // An ordinary dispatch on an ordinary record with the SAME key spelling.
    'packages/plugins/other/daemon/table.ts': `const table = { linkTo: 1, copyTree: 2 } as const;\nexport const read = (name: keyof typeof table) => table[name];\n`,
    // An `any` receiver nothing handed a handle to, indexed by a string.
    'packages/plugins/other/daemon/json.ts': `export const field = (parsed: any, name: string) => parsed[name];\n`,
    // A handle read through keys that are NOT operations.
    'packages/plugins/other/daemon/handle-reads.ts': `${TYPES}export const name = (root: RootHandle, key: 'name' | 'internal') => [root.name, root[key], root.resolve('x')];\n`,
  };

  let reached: Map<string, string[]>;
  beforeAll(async () => {
    const extra: Record<string, string> = { ...HANDLES, ...CONTROLS };
    for (const stray of STRAYS) extra[stray.file] = stray.code;
    const program = await openProductionProgram(await workspace(extra));
    try {
      reached = await reachesIn(program);
    } finally {
      await program.close();
    }
  }, FIXTURE_MS);

  for (const stray of STRAYS)
    test(`detects ${stray.name}`, () => {
      const found = (reached.get(stray.file) ?? []).map(place => place.split(' ').at(-1));
      expect(found, `${stray.file} was not reported`).toContain(stray.as);
    });

  test('the authority module’s own reads are the only reads outside the strays, and the controls are not flagged', () => {
    const stray = new Set(STRAYS.map(entry => entry.file));
    const unexpected = [...reached]
      .filter(([rel]) => !RUNTIMES_PROVISIONING.has(rel) && !stray.has(rel))
      .flatMap(([, places]) => places);
    expect(unexpected, 'ordinary code was reported as a link caller').toEqual([]);
    expect(reached.has(FLEET_DISK)).toBe(true);
  });

  describe('the authority surface (closes a helper exported from an allowed module and called elsewhere)', () => {
    const HANDLE_FLOW = {
      [`${ADAPTERS}/index.ts`]: `export * from './fleet-disk.ts';\n`,
      'packages/plugins/runtimes/daemon/wiring.ts': `import { FleetDisk } from './adapters/index.ts';\nexport const make = (fleet: import('@ferretry/kernel/contract').RootHandle) => new FleetDisk(fleet);\n`,
      'packages/plugins/runtimes/daemon/start.ts': `${TYPES}import { adopt } from './adopt.ts';\nexport const start = (roots: RootsPort) => {\n  const fleet = roots.root('fleet');\n  adopt(fleet);\n  return roots.root('work');\n};\n`,
      'packages/plugins/runtimes/daemon/adopt.ts': `import type { RootHandle } from '@ferretry/kernel/contract';\nexport function adopt(handle: RootHandle) {\n  const kept = handle;\n  return kept;\n}\n`,
      'packages/plugins/other/daemon/unrelated.ts': `${TYPES}export const open = (roots: RootsPort) => roots.root('work');\n`,
    } as const;

    let baseline: AuthoritySurface;
    const surfaceOf = async (
      extra: Record<string, string>,
      replace: Record<string, string> = {},
    ): Promise<AuthoritySurface> => {
      const program = await openProductionProgram(await workspace({ ...HANDLE_FLOW, ...extra }, replace));
      try {
        return await authoritySurface(program, AUTHORITY_MODULES);
      } finally {
        await program.close();
      }
    };
    beforeAll(async () => {
      baseline = await surfaceOf({});
    }, FIXTURE_MS);

    test('the baseline names the exports, the importers (through the barrel), the origins and the receivers', () => {
      expect(baseline.exports[FLEET_DISK]).toContain('FleetDisk: class');
      expect(baseline.exports[FLEET_DISK]).toContain('FleetDisk.link');
      expect(baseline.exports[FILE_PROVISIONER]).toEqual([
        'FileFleetProvisioner.apply',
        'FileFleetProvisioner.constructor',
        'FileFleetProvisioner: class',
      ]);
      expect(baseline.importers).toEqual([`${ADAPTERS}/index.ts`, 'packages/plugins/runtimes/daemon/wiring.ts']);
      expect(baseline.handleOrigins).toEqual(['packages/plugins/runtimes/daemon/start.ts']);
      expect(baseline.handleReceivers).toEqual([
        'packages/plugins/runtimes/daemon/adopt.ts',
        'packages/plugins/runtimes/daemon/start.ts',
      ]);
      expect(describeSurfaceChange(baseline, baseline, AFTER_MERGE_CARD)).toEqual([]);
    });

    test('an exported helper in an allowed module, re-exported and called by a worker, fails the pin (cc6 F3)', async () => {
      const surface = await surfaceOf(
        {
          [`${ADAPTERS}/repair-api.ts`]: `export { restoreFleetAlias as repairAlias } from './fleet-disk.ts';\n`,
          [`${ADAPTERS}/repair-worker.ts`]: `import { repairAlias } from './repair-api.ts';\nexport const handleRepair = (...args: Parameters<typeof repairAlias>) => repairAlias(...args);\n`,
        },
        {
          [FLEET_DISK]:
            `${TYPES}export class FleetDisk {\n  constructor(private readonly fleet: RootHandle) {}\n  link(${CALL}) {\n    return this.fleet.linkTo(at, target);\n  }\n` +
            `  copy(from: RootHandle, at: FencedPath) {\n    return this.fleet.copyTree(from, at, at);\n  }\n}\n` +
            `export function restoreFleetAlias(fleet: RootHandle, ${CALL}) {\n  return fleet.linkTo(at, target);\n}\n`,
        },
      );
      const changes = describeSurfaceChange(baseline, surface, AFTER_MERGE_CARD);
      expect(changes.some(change => change.includes('gained the export restoreFleetAlias: function'))).toBe(true);
      expect(
        changes.some(change => change.includes('repair-api.ts is a new module that imports an allowed module')),
      ).toBe(true);
      expect(
        changes.some(change => change.includes('repair-worker.ts is a new module that imports an allowed module')),
      ).toBe(true);
      for (const change of changes) {
        expect(change).toContain(AFTER_MERGE_CARD);
        expect(change).toContain('reviewer must approve');
      }
    });

    test('a new METHOD on an exported class is a new wrapper and fails the pin', async () => {
      const surface = await surfaceOf(
        {},
        {
          [FLEET_DISK]:
            `${TYPES}export class FleetDisk {\n  constructor(private readonly fleet: RootHandle) {}\n  link(${CALL}) {\n    return this.fleet.linkTo(at, target);\n  }\n` +
            `  copy(from: RootHandle, at: FencedPath) {\n    return this.fleet.copyTree(from, at, at);\n  }\n` +
            `  relink(${CALL}) {\n    return this.fleet.linkTo(at, target);\n  }\n  private hidden() {}\n}\n`,
        },
      );
      const changes = describeSurfaceChange(baseline, surface, AFTER_MERGE_CARD);
      expect(changes).toHaveLength(1);
      expect(changes[0]).toContain('gained the export FleetDisk.relink');
    });

    test('a module importing an allowed module directly fails the pin', async () => {
      const surface = await surfaceOf({
        'packages/plugins/other/daemon/sneaky.ts': `import type { FleetDisk } from '../../runtimes/daemon/adapters/fleet-disk.ts';\nexport const use = (disk: FleetDisk) => disk.link;\n`,
      });
      expect(describeSurfaceChange(baseline, surface, AFTER_MERGE_CARD).join('\n')).toContain(
        'packages/plugins/other/daemon/sneaky.ts is a new module that imports an allowed module',
      );
    });

    test('a new module that asks for the fleet or harness-home handle, and one the handle is passed to, fail the pin', async () => {
      const surface = await surfaceOf({
        'packages/plugins/other/daemon/second-origin.ts': `${TYPES}import { hold } from './holder.ts';\nexport const open = (roots: RootsPort, which: 'harness-home' | 'work') => hold(roots.root(which));\n`,
        'packages/plugins/other/daemon/holder.ts': `import type { RootHandle } from '@ferretry/kernel/contract';\nexport class Holder {\n  constructor(readonly root: RootHandle) {}\n}\nexport const hold = (root: RootHandle) => new Holder(root);\n`,
        'packages/plugins/other/daemon/dynamic-origin.ts': `${TYPES}export const open = (roots: RootsPort, name: import('@ferretry/kernel/contract').RootName) => roots.root(name);\n`,
      });
      const text = describeSurfaceChange(baseline, surface, AFTER_MERGE_CARD).join('\n');
      expect(text).toContain(
        'second-origin.ts is a new module that asks the kernel for a fleet or harness-home handle',
      );
      expect(text).toContain(
        'dynamic-origin.ts is a new module that asks the kernel for a fleet or harness-home handle',
      );
      expect(text).toContain('holder.ts is a new module that receives the fleet or harness-home handle');
      expect(text).not.toContain('unrelated.ts');
    });
  });
});
