/**
 * The file provisioner on the kernel's REAL `fleet` root where an apply goes wrong or is only looked at: a preview, a
 * claim that cannot be cleared, a history migration that fails or is refused, settings that are merged over a file the
 * harness wrote, a prune that loses a race, and a disk that refuses one call. Each failure is a real disk answering a
 * real call (the disk is the real one, with one call made to fail where a disk cannot be made to).
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FileFleetProvisioner } from '../../../daemon/adapters/file-provisioner.ts';
import type { ApplyLock, SharedHistoryPooling } from '../../../daemon/adapters/ports.ts';
import { STAGE_PREFIX } from '../../../daemon/adapters/mutation-journal.ts';
import { FleetApplyFailureError, type FleetApplyPlan } from '../../../daemon/lib/provisioning.ts';
import type { SharedHistoryPreview, SharedHistoryRequest } from '../../../daemon/lib/shared-history.ts';
import { cleanupWorlds, fleetWorld, type FleetWorld } from '../../unit/support/fleet-world.ts';
import { faultingDisk } from '../support/faulting-disk.ts';

afterEach(cleanupWorlds);

const planFor = (world: FleetWorld, operations: FleetApplyPlan['operations'], extra: Partial<FleetApplyPlan> = {}) =>
  ({
    manifest: { version: 1, generatedAt: '2027-01-15T08:00:00.000Z', runtimes: [], accounts: [] },
    manifestPath: join(world.fleet, 'manifest.json'),
    operations,
    ...extra,
  }) satisfies FleetApplyPlan;

const request = (world: FleetWorld): SharedHistoryRequest => ({
  kind: 'claude',
  poolRoot: join(world.fleet, 'shared'),
  homes: [{ account: 'one', path: join(world.fleet, 'homes', 'one') }],
});

const previewOf = (world: FleetWorld, refusalHome?: string): SharedHistoryPreview => ({
  kind: 'claude',
  pool: join(world.fleet, 'shared', 'claude'),
  moved: 0,
  conflicts: 0,
  links: 0,
  changes: [],
  emptiedSourceDirectories: [],
  refusals:
    refusalHome === undefined
      ? []
      : [{ account: 'one', home: refusalHome, path: refusalHome, reason: 'permission denied' }],
});

const pooling = (overrides: Partial<SharedHistoryPooling>): SharedHistoryPooling => ({
  preview: async () => await Promise.reject(new Error('not expected')),
  materialize: async () => await Promise.reject(new Error('not expected')),
  isUnavailable: () => false,
  ...overrides,
});

const failureOf = async (act: Promise<unknown>): Promise<FleetApplyFailureError> => {
  const error = await act.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(FleetApplyFailureError);
  return error as FleetApplyFailureError;
};

const provisionerOn = (world: FleetWorld, hook: Parameters<typeof faultingDisk>[1]) =>
  world.provisioner({ disk: faultingDisk(world.disk, hook) });

describe('previewing a plan', () => {
  it('answers the plan with the history it would pool, writing nothing', async () => {
    const world = await fleetWorld();
    const plan = planFor(world, [{ kind: 'directory', path: join(world.fleet, 'bin'), mode: 0o700 }], {
      sharedHistoryRequests: [request(world)],
    });
    const history = previewOf(world);

    const preview = await world.provisioner({ sharedHistory: pooling({ preview: async () => history }) }).preview(plan);

    expect(preview).toEqual({ ...plan, sharedHistory: [history] });
    expect(await readdir(world.fleet)).toEqual([]);
  });

  it('refuses a destination outside the fleet folder, and tolerates one that belongs to a home it could not read', async () => {
    const world = await fleetWorld();
    const outside = join(world.parent, 'outside-home');
    const operation = { kind: 'file', path: join(outside, 'x.txt'), content: 'x', mode: 0o600 } as const;
    const plan = planFor(world, [operation], { sharedHistoryRequests: [request(world)] });

    // Refused: no home it could not read stands in for the destination.
    await expect(
      world.provisioner({ sharedHistory: pooling({ preview: async () => previewOf(world) }) }).preview(plan),
    ).rejects.toThrow(/refusing to write outside configured fleet roots/u);
    // Kept visible, never inspected: the home it could not read is the destination's, so the preview reports it.
    const tolerant = await world
      .provisioner({ sharedHistory: pooling({ preview: async () => previewOf(world, outside) }) })
      .preview(plan);
    expect(tolerant.operations).toEqual([operation]);
    expect(tolerant.sharedHistory[0]?.refusals[0]?.home).toBe(outside);
  });

  it('leaves out a pooling this host cannot make, and says so only by leaving it out', async () => {
    const world = await fleetWorld();
    const plan = planFor(world, [], { sharedHistoryRequests: [request(world)] });

    const preview = await world
      .provisioner({
        sharedHistory: pooling({
          preview: async () => await Promise.reject(new Error('no safe move here')),
          isUnavailable: () => true,
        }),
      })
      .preview(plan);

    expect(preview.sharedHistory).toEqual([]);
  });

  it('refuses a plan that names history to pool when no adapter for it was composed', async () => {
    const world = await fleetWorld();
    const plan = planFor(world, [], { sharedHistoryRequests: [request(world)] });

    await expect(world.provisioner().preview(plan)).rejects.toThrow(
      /shared-history operations were planned without a shared-history filesystem adapter/u,
    );
  });
});

describe('an apply that pools history', () => {
  it('refuses before touching anything while an account home cannot be read', async () => {
    const world = await fleetWorld();
    const plan = planFor(world, [{ kind: 'directory', path: join(world.fleet, 'bin'), mode: 0o700 }], {
      sharedHistoryRequests: [request(world)],
    });
    const provisioner = world.provisioner({
      sharedHistory: pooling({ preview: async () => previewOf(world, join(world.fleet, 'homes', 'one')) }),
    });

    await expect(provisioner.apply(plan)).rejects.toThrow(
      /refusing to pool claude history while 1 account home\(s\) cannot be read: one \(.*homes\/one\): permission denied/u,
    );

    expect(await readdir(world.fleet)).toEqual([]);
  });

  it('reports a history migration that failed after the manifest committed as what the host now is', async () => {
    const world = await fleetWorld();
    const plan = planFor(world, [{ kind: 'directory', path: join(world.fleet, 'bin'), mode: 0o700 }], {
      sharedHistoryRequests: [request(world)],
    });
    const provisioner = world.provisioner({
      sharedHistory: pooling({
        preview: async () => previewOf(world),
        materialize: async () => await Promise.reject(new Error('the pool could not be written')),
      }),
    });

    const failure = await failureOf(provisioner.apply(plan));

    expect(failure.failure).toMatchObject({
      kind: 'history-failed-after-commit',
      failedHarness: 'claude',
      reason: 'the pool could not be written',
      committed: { accountCount: 0, operationCount: 1, manifestPath: plan.manifestPath, sharedHistory: [] },
    });
    // The manifest is the commit point: it stands.
    expect(JSON.parse(await readFile(plan.manifestPath, 'utf8'))).toMatchObject({ version: 1 });
  });

  it('skips a migration this host cannot make, names it, and lets the rest of the apply stand', async () => {
    const world = await fleetWorld();
    const plan = planFor(world, [], { sharedHistoryRequests: [request(world)] });
    const provisioner = world.provisioner({
      sharedHistory: pooling({
        preview: async () => previewOf(world),
        materialize: async () => await Promise.reject(new Error('no safe move here')),
        isUnavailable: () => true,
      }),
    });

    const result = await provisioner.apply(plan);

    expect(result.skipped).toEqual([{ path: join(world.fleet, 'shared', 'claude'), reason: 'no safe move here' }]);
    expect(result.sharedHistory).toEqual([]);
  });
});

describe('an apply whose claim cannot be cleared', () => {
  const stuckClaim = (world: FleetWorld): ApplyLock => ({
    path: join(world.fleet, '.fy-fleet-apply.lock'),
    acquire: async () => 'token',
    release: async () => join(world.fleet, '.fy-fleet-apply.lock'),
  });

  it('names the claim on a failure that rolled back, without changing what the apply was', async () => {
    const world = await fleetWorld();
    const provisioner = new FileFleetProvisioner(world.disk, () => stuckClaim(world));
    const plan = planFor(world, [
      {
        kind: 'copy',
        source: join(world.fleet, 'assets', 'missing.md'),
        path: join(world.fleet, 'homes', 'one', 'a.md'),
      },
    ]);

    const failure = await provisioner.apply(plan).then(
      () => undefined,
      (thrown: unknown) => thrown as Error,
    );

    // A source that is not there is refused before anything is written, so this is a plain refusal carrying the residue.
    expect(failure?.message).toMatch(/the exclusive apply claim at .*\.fy-fleet-apply\.lock could not be cleared/u);
  });

  it('puts the residue inside a classified failure, and inside the committed state of one that landed', async () => {
    const world = await fleetWorld();
    const rolled = new FileFleetProvisioner(
      faultingDisk(world.disk, async (call, args) => {
        if (call === 'create' && String(args[0]).endsWith('wrapper')) throw new Error('the disk is full');
      }),
      () => stuckClaim(world),
    );
    const plan = planFor(world, [
      { kind: 'file', path: join(world.fleet, 'bin', 'wrapper'), content: '#!/bin/sh\n', mode: 0o700 },
    ]);

    const rolledBack = await failureOf(rolled.apply(plan));

    expect(rolledBack.failure).toMatchObject({ kind: 'rolled-back', reason: 'the disk is full' });
    expect(rolledBack.lockResidue).toBe(join(world.fleet, '.fy-fleet-apply.lock'));

    const landed = new FileFleetProvisioner(
      world.disk,
      () => stuckClaim(world),
      pooling({
        preview: async () => previewOf(world),
        materialize: async () => await Promise.reject(new Error('the pool could not be written')),
      }),
    );
    const afterCommit = await failureOf(landed.apply(planFor(world, [], { sharedHistoryRequests: [request(world)] })));

    expect(afterCommit.failure).toMatchObject({
      kind: 'history-failed-after-commit',
      committed: { lockResidue: join(world.fleet, '.fy-fleet-apply.lock') },
    });
  });
});

describe('writing a document', () => {
  it('refuses a document that is expected to be a file when what is there is a folder', async () => {
    const world = await fleetWorld();
    const document = join(world.fleet, 'assets', 'note.md');
    await mkdir(document, { recursive: true });
    const plan = planFor(world, []);

    const failure = await failureOf(
      world.provisioner().apply(plan, [{ path: document, content: 'x', mode: 0o600, expect: 'absent' }]),
    );

    expect(failure.failure).toMatchObject({ kind: 'rolled-back' });
    expect(failure.message).toMatch(/what is there is not a regular file/u);
    expect(await readdir(document)).toEqual([]);
  });

  it('names a create that failed for any reason other than a name taken, and puts everything back', async () => {
    const world = await fleetWorld();
    await mkdir(join(world.fleet, 'assets'), { recursive: true });
    await writeFile(join(world.fleet, 'assets', 'note.md'), 'original');
    const provisioner = provisionerOn(world, async (call, args) => {
      if (call === 'create' && String(args[0]).endsWith('note.md')) throw new Error('the disk is full');
    });

    const failure = await failureOf(
      provisioner.apply(planFor(world, []), [
        { path: join(world.fleet, 'assets', 'note.md'), content: 'new', mode: 0o600 },
      ]),
    );

    expect(failure.failure).toMatchObject({ kind: 'rolled-back', reason: 'the disk is full' });
    expect(await readFile(join(world.fleet, 'assets', 'note.md'), 'utf8')).toBe('original');
  });
});

describe('settings operations', () => {
  const settings = (world: FleetWorld, overrides: Record<string, unknown> = {}) =>
    ({
      kind: 'settings',
      path: join(world.fleet, 'homes', 'one', 'settings.json'),
      format: 'json',
      layers: [{ from: 'file', path: join(world.fleet, 'assets', 'layer.json') }],
      mode: 0o600,
      preserveExisting: true,
      ...overrides,
    }) as const;

  it('folds the layers into what the harness wrote, from a file of the asset tree', async () => {
    const world = await fleetWorld();
    await mkdir(join(world.fleet, 'assets'), { recursive: true });
    await mkdir(join(world.fleet, 'homes', 'one'), { recursive: true });
    await writeFile(join(world.fleet, 'assets', 'layer.json'), '{"model":"opus"}');
    await writeFile(join(world.fleet, 'homes', 'one', 'settings.json'), '{"effort":"high"}');

    await world.provisioner().apply(planFor(world, [settings(world)]));

    expect(JSON.parse(await readFile(join(world.fleet, 'homes', 'one', 'settings.json'), 'utf8'))).toEqual({
      effort: 'high',
      model: 'opus',
    });
  });

  it('reads a layer a document of the same apply writes from that document, before it is on disk', async () => {
    const world = await fleetWorld();
    const layer = join(world.fleet, 'assets', 'layer.json');

    await world
      .provisioner()
      .apply(planFor(world, [settings(world, { preserveExisting: false })]), [
        { path: layer, content: '{"model":"sonnet"}', mode: 0o600 },
      ]);

    expect(JSON.parse(await readFile(join(world.fleet, 'homes', 'one', 'settings.json'), 'utf8'))).toEqual({
      model: 'sonnet',
    });
  });

  it('refuses before writing anything when a layer is not a settings document', async () => {
    const world = await fleetWorld();
    await mkdir(join(world.fleet, 'assets'), { recursive: true });
    await writeFile(join(world.fleet, 'assets', 'layer.json'), '{not json');

    const act = world.provisioner().apply(planFor(world, [settings(world)]));

    await expect(act).rejects.toThrow(/json/iu);
    expect(await readdir(world.fleet)).toEqual(['assets']);
  });

  it('refuses to merge over a settings path that is a folder', async () => {
    const world = await fleetWorld();
    await mkdir(join(world.fleet, 'assets'), { recursive: true });
    await writeFile(join(world.fleet, 'assets', 'layer.json'), '{"model":"opus"}');
    await mkdir(join(world.fleet, 'homes', 'one', 'settings.json'), { recursive: true });

    const failure = await failureOf(world.provisioner().apply(planFor(world, [settings(world)])));

    expect(failure.failure).toMatchObject({ kind: 'rolled-back' });
    expect(failure.message).toMatch(/it is not a regular file/u);
  });

  it('refuses to merge over a settings file that is not valid JSON, leaving it as it was', async () => {
    const world = await fleetWorld();
    await mkdir(join(world.fleet, 'assets'), { recursive: true });
    await mkdir(join(world.fleet, 'homes', 'one'), { recursive: true });
    await writeFile(join(world.fleet, 'assets', 'layer.json'), '{"model":"opus"}');
    const existing = join(world.fleet, 'homes', 'one', 'settings.json');
    await writeFile(existing, '{broken');

    const failure = await failureOf(world.provisioner().apply(planFor(world, [settings(world)])));

    expect(failure.message).toMatch(/it could not be parsed/u);
    expect(await readFile(existing, 'utf8')).toBe('{broken');
  });

  it.skipIf(process.getuid?.() === 0)('refuses to merge over a settings file it cannot read', async () => {
    const world = await fleetWorld();
    await mkdir(join(world.fleet, 'assets'), { recursive: true });
    await mkdir(join(world.fleet, 'homes', 'one'), { recursive: true });
    await writeFile(join(world.fleet, 'assets', 'layer.json'), '{"model":"opus"}');
    const existing = join(world.fleet, 'homes', 'one', 'settings.json');
    await writeFile(existing, '{"effort":"high"}');
    await chmod(existing, 0o000);

    const failure = await failureOf(world.provisioner().apply(planFor(world, [settings(world)])));

    expect(failure.message).toMatch(/it could not be read/u);
  });

  it('lets a second operation on the same settings file replace what the first wrote in the same batch', async () => {
    const world = await fleetWorld();
    const target = join(world.fleet, 'homes', 'one', 'settings.json');
    const inline = (settingsObject: Record<string, unknown>) =>
      settings(world, { layers: [{ from: 'inline', settings: settingsObject }], preserveExisting: false });

    await world.provisioner().apply(planFor(world, [inline({ first: 1 }), inline({ second: 2 })]));

    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ second: 2 });
  });
});

describe('pruning wrappers', () => {
  it('refuses a prune when the file it decided on changed between being read and being removed', async () => {
    const world = await fleetWorld();
    const bin = join(world.fleet, 'bin');
    await mkdir(bin, { recursive: true });
    const wrapper = join(bin, 'old');
    await writeFile(wrapper, '# managed by fy\n');
    let swapped = false;
    const provisioner = provisionerOn(world, async (call, args) => {
      if (swapped || call !== 'rename' || args[0] !== wrapper) return;
      swapped = true;
      // The person's own file takes the name between the read and the removal.
      await writeFile(wrapper, '#!/bin/sh\necho mine\n');
    });

    const failure = await failureOf(
      provisioner.apply(planFor(world, [{ kind: 'prune', path: bin, marker: 'managed by fy', keep: [] }])),
    );

    expect(failure.failure).toMatchObject({ kind: 'rolled-back' });
    expect(failure.message).toMatch(/it changed between being read and being removed/u);
    expect(await readFile(wrapper, 'utf8')).toBe('#!/bin/sh\necho mine\n');
  });
});

describe('copying and publishing', () => {
  const copyPlan = async (world: FleetWorld) => {
    await mkdir(join(world.fleet, 'assets'), { recursive: true });
    await writeFile(join(world.fleet, 'assets', 'asset.txt'), 'material');
    const destination = join(world.fleet, 'homes', 'one', 'asset.txt');
    return {
      destination,
      plan: planFor(world, [{ kind: 'copy', source: join(world.fleet, 'assets', 'asset.txt'), path: destination }]),
    };
  };

  it('never lets a failure after the copy replace the failure that caused it, and swallows a staged copy it cannot drop', async () => {
    const world = await fleetWorld();
    const { destination, plan } = await copyPlan(world);
    const provisioner = provisionerOn(world, async (call, args) => {
      if (call === 'lstat' && args[0] === destination) throw new Error('the disk stopped answering');
      if (call === 'remove' && String(args[0]).includes(STAGE_PREFIX)) throw new Error('the staged copy would not go');
    });

    const failure = await failureOf(provisioner.apply(plan));

    // The reported failure is the one that caused it. The staged copy that would not go is left, inert, under its
    // reserved name, and the rollback says the folder holding it was not left empty.
    expect(failure.failure).toMatchObject({ kind: 'rollback-incomplete', reason: 'the disk stopped answering' });
    expect((await readdir(join(world.fleet, 'homes', 'one'))).some(name => name.startsWith(STAGE_PREFIX))).toBe(true);
  });

  it('refuses to publish a staged entry that became something other than a file or a folder', async () => {
    const world = await fleetWorld();
    const { destination, plan } = await copyPlan(world);
    let staged: string | undefined;
    const provisioner = provisionerOn(world, async (call, args) => {
      if (call === 'setMode' && String(args[0]).includes(STAGE_PREFIX)) staged = String(args[0]);
      // After the copy was checked, whoever can write the account's folder swaps the staged copy for a link.
      if (call === 'lstat' && args[0] === destination && staged !== undefined) {
        await rm(staged);
        await symlink(join(world.parent, 'elsewhere'), staged);
        staged = undefined;
      }
    });

    const failure = await failureOf(provisioner.apply(plan));

    expect(failure.message).toMatch(/the staged entry is not a regular file or a folder/u);
    await expect(readFile(destination, 'utf8')).rejects.toThrow();
  });

  it('refuses to publish over a name that arrived after it was cleared, and raises any other refusal of the move', async () => {
    const world = await fleetWorld();
    const { destination, plan } = await copyPlan(world);
    const arriving = provisionerOn(world, async (call, args) => {
      if (call === 'rename' && args[1] === destination) await writeFile(destination, 'somebody else');
    });

    const arrived = await failureOf(arriving.apply(plan));

    expect(arrived.message).toMatch(/something arrived at the name after it was cleared/u);
    expect(await readFile(destination, 'utf8')).toBe('somebody else');

    await rm(destination);
    const refusing = provisionerOn(world, async (call, args) => {
      if (call === 'rename' && args[1] === destination) throw new Error('the disk refused the move');
    });
    const refused = await failureOf(refusing.apply(plan));
    expect(refused.message).toMatch(/the disk refused the move/u);
  });
});
