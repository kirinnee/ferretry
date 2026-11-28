import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  AdmissionPort,
  type Admission,
  type CallStanding,
  type PolicyRef,
  type KernelPorts,
} from '@ferretry/kernel/contract';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { bootHost } from '../../../../kernel/host/host.ts';
import { realAdapters } from '../../../../kernel/host/wiring.ts';
import { runInCall } from '../../../../kernel/host/call-scope.ts';
import { mayWritePin } from '../../../../kernel/host/pin-authority.ts';
import { nodeFs } from '../../../../kernel/host/adapters/node-fs.ts';
import { platformRootPinner } from '../../../../kernel/host/adapters/pinned/index.ts';
import { bunSpawn } from '../../../../kernel/host/adapters/process.ts';
import { restrictSpawn } from '../../../../kernel/host/permissions.ts';
import { PinRegistry } from '../../../../kernel/host/pins.ts';
import { rootsPortFor } from '../../../../kernel/host/roots.ts';
import { CAPABILITIES, FULL_DEVICE_GRANTS } from '../../../contract/index.ts';
import { ADMIN, admit, descriptor, local, type World, world } from '../../unit/daemon/support.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const at of parents.splice(0)) await rm(at, { recursive: true, force: true });
});
const route = descriptor({ capability: { capability: CAPABILITIES.fleet, axis: 'use' } });
function standingOf(w: World, device?: string): CallStanding {
  const result = admit(w, route, device === undefined ? { bearer: ADMIN, arrival: local() } : { device });
  if (result.decision.outcome !== 'admitted') throw new Error(result.outcome);
  return result.decision.standing;
}

async function fixture(
  admission: Admission | undefined,
  grant = true,
  capability: PolicyRef<'capability'> = CAPABILITIES.filesystem,
) {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-root-write-`));
  parents.push(parent);
  const folder = `${parent}/project`;
  await mkdir(folder);
  await mkdir(`${parent}/home`);
  await writeFile(`${folder}/kept.txt`, 'original');
  const manifest = definePlugin({
    id: 'write-fixture',
    title: 'Write fixture',
    version: '5.0.0',
    api: 5,
    core: false,
    kinds: [],
    permissions: {
      roots: ['imports'],
      spawn: ['sh'],
      ...(grant ? { writePins: [{ root: 'imports', capability }] } : {}),
    },
  });
  const pins = new PinRegistry(() => platformRootPinner());
  const root = rootsPortFor(
    nodeFs(() => 'fixture'),
    { home: `${parent}/home`, worktrees: `${parent}/worktrees`, plugin: manifest.id },
    ['imports'],
    () => undefined,
    { pins, pinWrite: name => mayWritePin(manifest, name, admission) },
  ).root('imports', { subfolder: folder });
  const at = root.resolve('.');
  if (!at.ok) throw new Error(at.error);
  const spawn = restrictSpawn(
    manifest.id,
    ['sh'],
    bunSpawn({ PATH: process.env.PATH ?? '', HOME: `${parent}/home` }),
    undefined,
    pins,
  );
  const write = async () => {
    const held = await root.pin(at.value, { write: true });
    try {
      await spawn.run('sh', ['-c', 'printf changed > kept.txt; printf new > created.txt'], { cwd: held.policyCwd });
    } finally {
      await held.close();
    }
  };
  const unchanged = async () => {
    expect(await readFile(`${folder}/kept.txt`, 'utf8')).toBe('original');
    expect(await readdir(folder)).toEqual(['kept.txt']);
  };
  return { root, at: at.value, spawn, write, unchanged, folder };
}

describe('SEC-K1: writePins is permission to ask, never a caller authority upgrade', () => {
  test('grant present but Gate missing or unbound refuses; disk unchanged', async () => {
    const w = world();
    for (const gate of [undefined, {} as Admission]) {
      const f = await fixture(gate);
      await runInCall({ actor: 'owner-tools', standing: standingOf(w) }, async () => {
        await expect(f.write()).rejects.toMatchObject({ code: 'pin_write_required' });
        await f.unchanged();
      });
    }
  });
  test('a limited use-only device cannot use the plugin’s grant to write; disk unchanged', async () => {
    const w = world();
    w.enrol('limited', { ...FULL_DEVICE_GRANTS, filesystem: { use: true, configure: false } });
    const f = await fixture(w.gate);
    await runInCall({ actor: 'owner-viewer', standing: standingOf(w, 'limited') }, async () => {
      await expect(f.write()).rejects.toMatchObject({ code: 'pin_write_required' });
      const held = await f.root.pin(f.at);
      try {
        if (held.withWritePin === undefined) throw new Error('scoped write pins missing');
        await expect(
          held.withWritePin(cwd => f.spawn.run('sh', ['-c', 'printf changed > kept.txt'], { cwd })),
        ).rejects.toMatchObject({ code: 'pin_write_required' });
      } finally {
        await held.close();
      }
      await f.unchanged();
    });
  });
  for (const device of [undefined, 'configure']) {
    test(`${device ?? 'loopback'} caller with authority can request and use a write pin`, async () => {
      const w = world();
      if (device !== undefined) w.enrol(device);
      const f = await fixture(w.gate);
      await runInCall({ actor: 'owner-tools', standing: standingOf(w, device) }, f.write);
      expect(await readFile(`${f.folder}/kept.txt`, 'utf8')).toBe('changed');
      expect(await readFile(`${f.folder}/created.txt`, 'utf8')).toBe('new');
    });
  }
  test('undetermined live grants, missing standing, and a plugin without the grant all refuse', async () => {
    const w = world();
    w.enrol('phone');
    const standing = standingOf(w, 'phone');
    const f = await fixture(w.gate);
    w.policy = undefined;
    await runInCall({ actor: 'owner-viewer', standing }, async () => {
      await expect(f.write()).rejects.toMatchObject({ code: 'pin_write_required' });
      await f.unchanged();
    });
    await runInCall({ actor: 'owner-tools' }, async () => {
      await expect(f.write()).rejects.toMatchObject({ code: 'pin_write_required' });
      await f.unchanged();
    });
    const noGrant = await fixture(w.gate, false);
    await runInCall({ actor: 'owner-tools', standing: standingOf(world()) }, async () => {
      await expect(noGrant.write()).rejects.toMatchObject({ code: 'pin_write_required' });
      await noGrant.unchanged();
    });
  });
  test('the manifest’s own capability is asked: a filesystem grant never replaces fleet.configure', async () => {
    const w = world();
    w.enrol('phone', { ...FULL_DEVICE_GRANTS, fleet: { use: true, configure: false } });
    const f = await fixture(w.gate, true, CAPABILITIES.fleet);
    await runInCall({ actor: 'owner-viewer', standing: standingOf(w, 'phone') }, async () => {
      await expect(f.write()).rejects.toMatchObject({ code: 'pin_write_required' });
      await f.unchanged();
    });
  });
  test('a write pin cannot be reused by a later read-only caller', async () => {
    const w = world();
    w.enrol('limited', { ...FULL_DEVICE_GRANTS, filesystem: { use: true, configure: false } });
    const f = await fixture(w.gate);
    const held = await runInCall(
      { actor: 'owner-tools', standing: standingOf(w) },
      async () => await f.root.pin(f.at, { write: true }),
    );
    try {
      await runInCall({ actor: 'owner-viewer', standing: standingOf(w, 'limited') }, async () => {
        await expect(
          f.spawn.run('sh', ['-c', 'printf changed > kept.txt'], { cwd: held.policyCwd }),
        ).rejects.toMatchObject({ code: 'pin_write_required' });
        await f.unchanged();
      });
    } finally {
      await held.close();
    }
  });
});

test('SEC-K1: bootHost wires the manifest write request to the bound Gate judge and current call', async () => {
  const w = world();
  w.enrol('limited', { ...FULL_DEVICE_GRANTS, filesystem: { use: true, configure: false } });
  const f = await fixture(w.gate);
  const seen: KernelPorts[] = [];
  const base = { version: '5.0.0', api: 5, kinds: [] } as const;
  const writer = implementDaemon(
    definePlugin({
      ...base,
      id: 'pin-writer',
      title: 'Pin writer',
      core: false,
      permissions: {
        roots: ['imports'],
        spawn: ['sh'],
        writePins: [{ root: 'imports', capability: CAPABILITIES.filesystem }],
      },
    }),
    {
      build: ({ kernel }) => {
        seen.push(kernel);
        return {};
      },
    },
  );
  const gate = implementDaemon(
    definePlugin({
      ...base,
      id: 'gate',
      title: 'Gate',
      core: true,
      provides: { admission: AdmissionPort },
    }),
    { build: () => ({ provides: { admission: w.gate } }) },
  );
  const home = `${f.folder}-host`;
  const boot = await bootHost({
    home,
    version: '5.0.0',
    implementations: [gate, writer],
    adapters: realAdapters(home, () => {}, { binary: 'fy' }),
  });
  if (boot.kind !== 'running') throw new Error('fixture host refused');
  try {
    expect(seen).toHaveLength(1);
    const kernel = seen[0] as KernelPorts;
    const root = kernel.roots.root('imports', { subfolder: f.folder });
    const at = root.resolve('.');
    if (!at.ok) throw new Error(at.error);
    await runInCall({ actor: 'owner-viewer', standing: standingOf(w, 'limited') }, async () => {
      await expect(root.pin(at.value, { write: true })).rejects.toMatchObject({ code: 'pin_write_required' });
      await f.unchanged();
    });
    await runInCall({ actor: 'owner-tools', standing: standingOf(w) }, async () => {
      const held = await root.pin(at.value, { write: true });
      try {
        expect(
          (await kernel.spawn.run('sh', ['-c', 'printf changed > kept.txt'], { cwd: held.policyCwd })).exitCode,
        ).toBe(0);
      } finally {
        await held.close();
      }
    });
    expect(await readFile(`${f.folder}/kept.txt`, 'utf8')).toBe('changed');
  } finally {
    await boot.host.stop();
  }
});
