/**
 * SIT for the built-in profiles (runtimes plan U2): a FRESH machine with nothing but two signed-in logins and no profile,
 * component or runtime file gets, for each login's first runtime, the "work alone well" instructions in the harness's own
 * file (`CLAUDE.md`, `AGENTS.md`), Claude's comfort settings, and NOT ONE permission change: the fixed layer's permission
 * mode is exactly what a machine without the profile gets. Real materialiser and real provisioner over temporary
 * directories; nothing of the person's own homes is read.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import should from 'should';
import { sampleLogin } from '@ferretry/plugin-logins/contract/testing';

import { unavailableSharedHistory } from '../../daemon/adapters/shared-history-unavailable.ts';
import { AUTONOMOUS_INSTRUCTIONS } from '../../daemon/lib/account/builtin-autonomous.ts';
import { EMPTY_RUNTIME_IDS } from '../../daemon/lib/account/ids.ts';
import { materialiseFleet } from '../../daemon/lib/account/materialise.ts';
import { assembleRuntimesModel, NO_COMPONENTS } from '../../daemon/lib/account/runtimes-model.ts';
import type { FleetLayout } from '../../daemon/lib/provisioning.ts';
import { fleetWorld } from '../unit/support/fleet-world.ts';

const ID_CLAUDE = '00000000-0000-4000-8000-0000000000d1';
const ID_CODEX = '00000000-0000-4000-8000-0000000000d2';

const parents: string[] = [];
afterEach(async () => {
  await Promise.all(parents.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

/** The homes of the first runtimes of a fresh machine, once the fleet is applied; `profiles` is the explicit profile files. */
async function freshMachine(explicit: { readonly instructionsText?: string } = {}) {
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
  const assembled = assembleRuntimesModel({
    runtimes: new Map(),
    profiles: new Map(),
    modelSets: new Map(),
    settings: undefined,
    logins: [
      sampleLogin('atomi', { store: 'ferretry' }),
      sampleLogin('personal', { harness: 'codex', harnesses: ['codex'], store: 'ferretry' }),
    ],
    templates: new Map(),
    components:
      explicit.instructionsText === undefined
        ? NO_COMPONENTS
        : {
            ...NO_COMPONENTS,
            instructions: {
              state: 'read',
              components: new Map([['ferretry-work-alone', { text: explicit.instructionsText }]]),
            },
          },
  });
  const model = assembled.model;
  // What the catalog service reads as bodies: the text of an instruction, the document of a settings component.
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
  const minted = [ID_CLAUDE, ID_CODEX];
  const plan = materialiseFleet({
    model,
    layout,
    ids: EMPTY_RUNTIME_IDS,
    mint: () => minted.shift() ?? 'exhausted',
    generatedAt: '2026-11-23T08:00:00.000Z',
    bodies: { instructions, settings },
    claudeStatusline: () => "'fy' statusline",
    fyCommand: path.join(world.parent, 'no-such-fy'),
    acceptsAutoPermissionMode: true,
  });
  await world.provisioner({ sharedHistory: unavailableSharedHistory }).apply(plan);
  return {
    model,
    claudeHome: path.join(layout.homesDirectory, ID_CLAUDE),
    codexHome: path.join(layout.homesDirectory, ID_CODEX),
  };
}

const text = (file: string): Promise<string> => readFile(file, 'utf8');

describe('the first runtimes of a fresh machine', () => {
  it('should launch on Ferretry’s profiles, one runtime per login', async () => {
    const host = await freshMachine();

    should(Object.keys(host.model.runtimes).toSorted()).eql(['atomi', 'personal']);
    should(host.model.runtimes.atomi?.profile).equal('ferretry-claude');
    should(host.model.runtimes.personal?.profile).equal('ferretry-codex');
  });

  it('should have the instructions in CLAUDE.md and AGENTS.md', async () => {
    const host = await freshMachine();

    should(await text(path.join(host.claudeHome, 'CLAUDE.md'))).containEql(AUTONOMOUS_INSTRUCTIONS);
    should(await text(path.join(host.codexHome, 'AGENTS.md'))).containEql(AUTONOMOUS_INSTRUCTIONS);
  });

  it('should carry Claude’s comfort settings and change no permission anywhere', async () => {
    const host = await freshMachine();

    const claude = JSON.parse(await text(path.join(host.claudeHome, 'settings.json'))) as Record<string, unknown>;
    should(claude.cleanupPeriodDays).equal(90);
    should(claude).not.have.property('permissions');
    // The fixed layer's mode is the machine's (default skip), exactly as with no profile at all.
    should(JSON.parse(await text(path.join(host.claudeHome, '.fy', 'fixed.json')))).eql({
      permissions: { defaultMode: 'bypassPermissions' },
      remoteControlAtStartup: false,
      skipDangerousModePermissionPrompt: true,
    });
    // Codex gets no comfort setting: nothing in its config.toml names an approval or sandbox mode.
    const codex = await text(path.join(host.codexHome, 'config.toml'));
    should(codex).not.match(/approval_policy|sandbox_mode|shell_environment_policy/);
  });

  it('should let an explicit instructions file of the same name win over the built-in', async () => {
    const host = await freshMachine({ instructionsText: 'My own words.\n' });

    should(await text(path.join(host.claudeHome, 'CLAUDE.md'))).containEql('My own words.');
    should(await text(path.join(host.claudeHome, 'CLAUDE.md'))).not.containEql('Working alone');
  });
});
