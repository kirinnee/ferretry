/**
 * SIT for "all data and sessions kept" (runtimes plan U2b): a runtime home is shared with the harness and the person,
 * so an apply never removes or replaces what Ferretry did not write.
 *
 * - The skills folder: only a skill the previous apply RECORDED is pruned. A skill the person or the harness added by
 *   hand stays, and the apply names it as left.
 * - An explicit (owner-chosen) instructions layer: `CLAUDE.md` is rewritten only while it still holds what Ferretry last
 *   wrote. Once the harness's `/memory` (or the person) edited it, it is kept word for word and the apply says so.
 *
 * Real materialiser and real provisioner over temporary directories; nothing of the person's own homes is read.
 */
import { afterEach, describe, it } from 'bun:test';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import should from 'should';
import { sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import type { LoginLaunchStore } from '@ferretry/plugin-logins/contract';

import { unavailableSharedHistory } from '../../daemon/adapters/shared-history-unavailable.ts';
import { EMPTY_RUNTIME_IDS } from '../../daemon/lib/account/ids.ts';
import { materialiseFleet } from '../../daemon/lib/account/materialise.ts';
import { REAL_KITS } from '../support/real-kits.ts';
import { assembleRuntimesModel, NO_COMPONENTS } from '../../daemon/lib/account/runtimes-model.ts';
import type { FleetLayout } from '../../daemon/lib/provisioning.ts';
import { fleetWorld } from '../unit/support/fleet-world.ts';

const ID_CLAUDE = '00000000-0000-4000-8000-0000000000e1';

const parents: string[] = [];
afterEach(async () => {
  await Promise.all(parents.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const text = (file: string): Promise<string> => readFile(file, 'utf8');

/** One Claude runtime on a temp machine; `apply` runs the real materialiser and provisioner, as often as asked. */
async function machine() {
  const world = await fleetWorld();
  parents.push(world.parent);
  const layout: FleetLayout = {
    stateHome: world.home,
    userHome: path.join(world.parent, 'person'),
    fleetDirectory: world.fleet,
    binDirectory: path.join(world.fleet, 'bin'),
    homesDirectory: path.join(world.fleet, 'homes'),
    assetsDirectory: path.join(world.fleet, 'assets'),
    manifestPath: path.join(world.fleet, 'manifest.json'),
    defaultHomeDirectories: {
      claude: path.join(world.parent, 'person', '.claude'),
      codex: path.join(world.parent, 'person', '.codex'),
    },
  };
  await mkdir(layout.assetsDirectory, { recursive: true });
  const home = path.join(layout.homesDirectory, ID_CLAUDE);
  const loginStores: LoginLaunchStore[] = [
    { id: 'atomi', variables: { CLAUDE_SECURESTORAGE_CONFIG_DIR: path.join(world.parent, 'logins', 'atomi') } },
  ];
  const fakeFy = path.join(world.parent, 'fakes', 'fy');
  await mkdir(path.dirname(fakeFy), { recursive: true });
  await writeFile(fakeFy, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  /** One apply, with the owner's instructions file of the built-in's name saying `instructionsText`. */
  const apply = async (instructionsText: string) => {
    const assembled = assembleRuntimesModel({
      runtimes: new Map(),
      profiles: new Map(),
      modelSets: new Map(),
      settings: undefined,
      logins: [sampleLogin('atomi', { store: 'ferretry' })],
      templates: new Map(),
      components: {
        ...NO_COMPONENTS,
        instructions: {
          state: 'read',
          components: new Map([['ferretry-work-alone', { text: instructionsText }]]),
        },
      },
    });
    const { model } = assembled;
    const instructions = Object.fromEntries(
      Object.entries(model.components.instructions).flatMap(([name, component]) =>
        component.text === undefined ? [] : [[name, component.text]],
      ),
    );
    const settings = Object.fromEntries(
      Object.entries(model.components.settings).flatMap(([name, component]) =>
        component.document === undefined ? [] : [[name, component.document]],
      ),
    );
    const plan = materialiseFleet({
      model,
      layout,
      ids: EMPTY_RUNTIME_IDS,
      mint: () => ID_CLAUDE,
      generatedAt: '2026-11-23T08:00:00.000Z',
      bodies: { instructions, settings },
      claudeStatusline: () => "'fy' statusline",
      fyCommand: fakeFy,
      acceptsAutoPermissionMode: true,
      kits: REAL_KITS,
      loginStores,
    });
    return await world.provisioner({ sharedHistory: unavailableSharedHistory }).apply(plan);
  };
  return { home, apply };
}

const left = (result: { readonly skipped?: readonly { readonly path: string }[] }): readonly string[] =>
  (result.skipped ?? []).map(entry => entry.path);

describe('the skills folder of a runtime home', () => {
  it('should keep owner skills and a named skill whose incomplete record cannot prove ownership', async () => {
    const host = await machine();
    await host.apply('First words.\n');
    // A name without a tree stamp is no ownership proof, even if an incomplete record claims the skill.
    const record = path.join(host.home, '.fy', 'materialised.json');
    const recorded = JSON.parse(await text(record)) as { entries: string[] };
    await writeFile(record, JSON.stringify({ ...recorded, entries: [...recorded.entries, 'skills/from-ferretry'] }));
    for (const skill of ['from-ferretry', 'owner-skill', 'harness-skill']) {
      await mkdir(path.join(host.home, 'skills', skill), { recursive: true });
      await writeFile(path.join(host.home, 'skills', skill, 'SKILL.md'), `# ${skill}\n`);
    }

    const result = await host.apply('First words.\n');

    should(await text(path.join(host.home, 'skills', 'owner-skill', 'SKILL.md'))).equal('# owner-skill\n');
    should(await text(path.join(host.home, 'skills', 'harness-skill', 'SKILL.md'))).equal('# harness-skill\n');
    should(await text(path.join(host.home, 'skills', 'from-ferretry', 'SKILL.md'))).equal('# from-ferretry\n');
    should(left(result)).containDeep([
      path.join(host.home, 'skills', 'harness-skill'),
      path.join(host.home, 'skills', 'owner-skill'),
      path.join(host.home, 'skills', 'from-ferretry'),
    ]);
  });
});

describe('CLAUDE.md written from an explicit instructions layer', () => {
  it('should be rewritten while it still holds what Ferretry last wrote', async () => {
    const host = await machine();
    await host.apply('First words.\n');

    const result = await host.apply('Second words.\n');

    should(await text(path.join(host.home, 'CLAUDE.md'))).containEql('Second words.');
    should(left(result)).eql([]);
  });

  it('should be kept word for word once the harness or the person edited it, and the apply should say so', async () => {
    const host = await machine();
    await host.apply('First words.\n');
    const file = path.join(host.home, 'CLAUDE.md');
    await appendFile(file, '\n- remembered by /memory: the deploy key rotates on Friday\n');
    const edited = await text(file);

    const result = await host.apply('Second words.\n');

    should(await text(file)).equal(edited);
    should(left(result)).eql([file]);
    should((result.skipped ?? [])[0]?.reason).equal(
      'CLAUDE.md was edited in the runtime home; Ferretry left it. Delete it to let Ferretry write it again.',
    );
    // And it stays kept on the next apply, with the record no longer claiming it.
    const again = await host.apply('Third words.\n');
    should(await text(file)).equal(edited);
    should(left(again)).eql([file]);
    const record = JSON.parse(await text(path.join(host.home, '.fy', 'materialised.json'))) as {
      entries: string[];
      hashes: Record<string, string>;
    };
    should(record.entries).not.containEql('CLAUDE.md');
    should(record.hashes).not.have.property('CLAUDE.md');
  });
});
