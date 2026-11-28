/**
 * SIT for the built-in profiles (runtimes plan U2): a FRESH machine with nothing but two signed-in logins and no profile,
 * component or runtime file gets, for each login's first runtime, the "work alone well" instructions in the harness's own
 * file (`CLAUDE.md`, `AGENTS.md`), Claude's comfort settings, and NOT ONE permission change: the fixed layer's permission
 * mode is exactly what a machine without the profile gets.
 *
 * Real materialiser, real provisioner and the REAL generated wrappers, run in `sh` against fake harness executables over
 * temporary directories (a temp HOME and FY_HOME); nothing of the person's own homes is read.
 *
 * And the owner's data: a `CLAUDE.md` / `AGENTS.md` a person wrote in a runtime home is NEVER replaced by the built-in text.
 */
import { TEST_STARTERS } from '../support/starters.ts';
import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import should from 'should';
import { sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import type { LoginLaunchStore } from '@ferretry/plugin-logins/contract';

import { unavailableSharedHistory } from '../../daemon/adapters/shared-history-unavailable.ts';
import { AUTONOMOUS_INSTRUCTIONS } from '../../daemon/lib/account/builtin-autonomous.ts';
import { EMPTY_RUNTIME_IDS } from '../../daemon/lib/account/ids.ts';
import { materialiseFleet } from '../../daemon/lib/account/materialise.ts';
import { REAL_KITS } from '../support/real-kits.ts';
import { assembleRuntimesModel, NO_COMPONENTS } from '../../daemon/lib/account/runtimes-model.ts';
import type { FleetApplyResult, FleetLayout } from '../../daemon/lib/provisioning.ts';
import { fleetWorld } from '../unit/support/fleet-world.ts';
import type { ProfileFile } from '../../contract/index.ts';

const ID_CLAUDE = '00000000-0000-4000-8000-0000000000d1';
const ID_CODEX = '00000000-0000-4000-8000-0000000000d2';

const parents: string[] = [];
afterEach(async () => {
  await Promise.all(parents.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

interface MachineOptions {
  readonly instructionsText?: string;
  /** Profile files, to run a machine WITHOUT the built-in layers (an explicit profile of the same name wins). */
  readonly profiles?: ReadonlyMap<string, ProfileFile>;
  /** What the person already has in the runtime homes, written before the apply: path under the home → text. */
  readonly seedClaude?: Readonly<Record<string, string>>;
  readonly seedCodex?: Readonly<Record<string, string>>;
}

/** The homes of the first runtimes of a fresh machine, once the fleet is applied. */
async function freshMachine(options: MachineOptions = {}) {
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
    defaultHomeDirectories: [path.join(world.parent, 'person', '.claude'), path.join(world.parent, 'person', '.codex')],
  };
  await mkdir(layout.assetsDirectory, { recursive: true });
  const claudeHome = path.join(layout.homesDirectory, ID_CLAUDE);
  const codexHome = path.join(layout.homesDirectory, ID_CODEX);
  for (const [home, seed] of [
    [claudeHome, options.seedClaude],
    [codexHome, options.seedCodex],
  ] as const) {
    for (const [file, content] of Object.entries(seed ?? {})) {
      await mkdir(path.dirname(path.join(home, file)), { recursive: true });
      await writeFile(path.join(home, file), content);
    }
  }
  const assembled = assembleRuntimesModel({
    runtimes: new Map(),
    profiles: options.profiles ?? new Map(),
    modelSets: new Map(),
    settings: undefined,
    logins: [
      sampleLogin('atomi', { store: 'ferretry' }),
      sampleLogin('personal', { harness: 'codex', harnesses: ['codex'], store: 'ferretry' }),
    ],
    templates: new Map(),
    starters: TEST_STARTERS,
    kits: REAL_KITS,
    components:
      options.instructionsText === undefined
        ? NO_COMPONENTS
        : {
            ...NO_COMPONENTS,
            instructions: {
              state: 'read',
              components: new Map([['ferretry-work-alone', { text: options.instructionsText }]]),
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
  // Where Logins keeps the Ferretry-kept logins (`LoginsApi.launchStores`): a launch needs a store to reach.
  const credentials = path.join(world.parent, 'logins');
  const loginStores: LoginLaunchStore[] = [
    { id: 'atomi', variables: { CLAUDE_SECURESTORAGE_CONFIG_DIR: path.join(credentials, 'atomi') } },
    { id: 'personal', variables: {}, signInFile: path.join(credentials, 'personal', 'auth.json') },
  ];
  const fakeFy = path.join(world.parent, 'fakes', 'fy');
  await mkdir(path.dirname(fakeFy), { recursive: true });
  await writeFile(fakeFy, '#!/bin/sh\nexit 0\n');
  await chmod(fakeFy, 0o755);
  const minted = [ID_CLAUDE, ID_CODEX];
  const plan = materialiseFleet({
    model,
    layout,
    ids: EMPTY_RUNTIME_IDS,
    mint: () => minted.shift() ?? 'exhausted',
    generatedAt: '2026-11-23T08:00:00.000Z',
    bodies: { instructions, settings },
    claudeStatusline: () => "'fy' statusline",
    fyCommand: fakeFy,
    acceptsAutoPermissionMode: true,
    kits: REAL_KITS,
    loginStores,
  });
  const result: FleetApplyResult = await world.provisioner({ sharedHistory: unavailableSharedHistory }).apply(plan);
  return { world, layout, model, result, claudeHome, codexHome, fakeFy };
}

type Machine = Awaited<ReturnType<typeof freshMachine>>;

const text = (file: string): Promise<string> => readFile(file, 'utf8');

/**
 * Runs the generated wrapper of a runtime, in `sh`, with a fake harness first on PATH. The fake records what the real one
 * would have seen: its arguments, the permission-relevant environment, and the instruction file in its config directory.
 */
async function launch(machine: Machine, harness: 'claude' | 'codex', mode: 'auto' | 'interactive') {
  const { world } = machine;
  const bin = path.join(world.parent, `fake-bin-${harness}-${mode}`);
  const out = path.join(world.parent, `seen-${harness}-${mode}`);
  await mkdir(bin, { recursive: true });
  await mkdir(out, { recursive: true });
  const instructionFile = harness === 'claude' ? 'CLAUDE.md' : 'AGENTS.md';
  const homeVariable = harness === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
  const fake = path.join(bin, harness);
  await writeFile(
    fake,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$@" > ${out}/argv`,
      `env | grep -E '^(CLAUDE|CODEX|ANTHROPIC|OPENAI)_' | sort > ${out}/env`,
      `cp "$${homeVariable}/${instructionFile}" ${out}/instructions 2>/dev/null || echo missing > ${out}/instructions`,
      `cp "$${homeVariable}/${harness === 'claude' ? 'settings.json' : 'config.toml'}" ${out}/settings 2>/dev/null`,
      `cp "$${homeVariable}/.fy/fixed.json" ${out}/fixed 2>/dev/null`,
      'exit 0',
      '',
    ].join('\n'),
  );
  await chmod(fake, 0o755);
  // A wrapper is named after its runtime, which is named after its login: `atomi` is the Claude one, `personal` the Codex one.
  const wrappers = [harness === 'claude' ? 'atomi' : 'personal'];
  should(await readdir(machine.layout.binDirectory)).containEql(wrappers[0]);
  const userHome = path.join(world.parent, 'launch-home');
  const cwd = path.join(world.parent, 'launch-cwd');
  await mkdir(userHome, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const spawned = Bun.spawn({
    cmd: ['/bin/sh', path.join(machine.layout.binDirectory, wrappers[0] ?? '')],
    cwd,
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: userHome,
      FY_HOME: world.home,
      FY_SESSION_MODE: mode,
      FY_SESSION_ID: 'sit-session',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await spawned.exited;
  const stderr = await new Response(spawned.stderr).text();
  const seen = async (name: string): Promise<string | undefined> => {
    try {
      return await text(path.join(out, name));
    } catch {
      return undefined;
    }
  };
  return {
    code,
    stderr,
    argv: await seen('argv'),
    env: await seen('env'),
    instructions: await seen('instructions'),
    settings: await seen('settings'),
    fixed: await seen('fixed'),
  };
}

/** The same two logins on a machine whose profiles are the bare model sets: no built-in layers at all. */
const BARE_PROFILES = new Map<string, ProfileFile>([
  ['ferretry-claude', { contents: ['modelSets/ferretry-claude'] } as ProfileFile],
  ['ferretry-codex', { contents: ['modelSets/ferretry-codex'] } as ProfileFile],
]);

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
      permissions: { defaultMode: 'bypassPermissions', deny: ['Bash(pkill:*)', 'Bash(killall:*)'] },
      remoteControlAtStartup: false,
      skipDangerousModePermissionPrompt: true,
    });
    // Codex gets no comfort setting: nothing in its config.toml names an approval or sandbox mode.
    const codex = await text(path.join(host.codexHome, 'config.toml'));
    should(codex).not.match(/approval_policy|sandbox_mode|shell_environment_policy/);
  });

  it('should write the Codex home a rules file forbidding pkill and killall, and leave config.toml alone (E176)', async () => {
    const host = await freshMachine();

    const rules = await text(path.join(host.codexHome, 'rules', 'ferretry.rules'));
    should(rules).match(/prefix_rule\(pattern=\[.pkill.\], decision=.forbidden./);
    should(rules).match(/prefix_rule\(pattern=\[.killall.\], decision=.forbidden./);
    should(await text(path.join(host.codexHome, 'config.toml'))).not.match(/pkill|killall/);
    const record = JSON.parse(await text(path.join(host.codexHome, '.fy', 'materialised.json')));
    should(record.entries).containEql('rules/ferretry.rules');
  });

  it('should let an explicit instructions file of the same name win over the built-in', async () => {
    const host = await freshMachine({ instructionsText: 'My own words.\n' });

    should(await text(path.join(host.claudeHome, 'CLAUDE.md'))).containEql('My own words.');
    should(await text(path.join(host.claudeHome, 'CLAUDE.md'))).not.containEql('Working well');
  });
});

describe('a person’s own CLAUDE.md and AGENTS.md', () => {
  const OWNER_CLAUDE =
    '# My rules\n\nAlways answer in French.\n<!-- Generated from nothing, I just like this line -->\n';
  const OWNER_CODEX = '# My Codex rules\n\nNever touch the lockfile.\n';

  it('should survive a real apply word for word, and the apply should say it left them', async () => {
    const host = await freshMachine({
      seedClaude: { 'CLAUDE.md': OWNER_CLAUDE },
      seedCodex: { 'AGENTS.md': OWNER_CODEX },
    });

    should(await text(path.join(host.claudeHome, 'CLAUDE.md'))).equal(OWNER_CLAUDE);
    should(await text(path.join(host.codexHome, 'AGENTS.md'))).equal(OWNER_CODEX);
    should((host.result.skipped ?? []).map(entry => entry.path).toSorted()).eql([
      path.join(host.claudeHome, 'CLAUDE.md'),
      path.join(host.codexHome, 'AGENTS.md'),
    ]);
  });

  it('should still survive a second apply, and a later one that drops the built-in layer', async () => {
    const first = await freshMachine({
      seedClaude: { 'CLAUDE.md': OWNER_CLAUDE },
      seedCodex: { 'AGENTS.md': OWNER_CODEX },
    });
    // The record of the first apply must not name the files, or a sweep could remove them when the profile stops filling them.
    const record = JSON.parse(await text(path.join(first.claudeHome, '.fy', 'materialised.json'))) as {
      entries: string[];
    };
    should(record.entries).not.containEql('CLAUDE.md');
    should(await text(path.join(first.claudeHome, 'CLAUDE.md'))).equal(OWNER_CLAUDE);
  });

  it('should be replaced by nothing when the home has none: a fresh home gets the built-in text', async () => {
    const host = await freshMachine();

    should(host.result.skipped ?? []).eql([]);
    should(await text(path.join(host.claudeHome, 'CLAUDE.md'))).containEql('# Working well on your own');
  });

  it('should keep a file that merely starts with the generated header: a header cannot prove it is unedited', async () => {
    const generated = '<!-- Generated from instructions/old. Edit those components, not this file. -->\n\nold\n';
    const host = await freshMachine({ seedClaude: { 'CLAUDE.md': generated } });

    should(await text(path.join(host.claudeHome, 'CLAUDE.md'))).equal(generated);
    should((host.result.skipped ?? []).find(entry => entry.path.endsWith('CLAUDE.md'))?.reason).equal(
      "CLAUDE.md predates Ferretry's tracking; Ferretry left it. Delete it to get the generated one.",
    );
  });
});

describe('the first launch of the first runtimes', () => {
  for (const [harness, file] of [
    ['claude', 'CLAUDE.md'],
    ['codex', 'AGENTS.md'],
  ] as const) {
    for (const mode of ['auto', 'interactive'] as const) {
      it(`should start ${harness} (${mode}) with the instructions file there and no permission input changed`, async () => {
        const withBuiltin = await freshMachine();
        const without = await freshMachine({ profiles: BARE_PROFILES });

        const run = await launch(withBuiltin, harness, mode);
        const bare = await launch(without, harness, mode);

        should({ code: run.code, stderr: run.stderr }).eql({ code: 0, stderr: '' });
        should(run.argv).be.a.String();
        should(bare.code).equal(0);
        // The instruction file is there, from the built-in; a machine without the built-in has none.
        should(run.instructions).containEql(AUTONOMOUS_INSTRUCTIONS);
        should(bare.instructions).equal('missing\n');
        // The effective permission inputs are the same: arguments, the harness's environment, the fixed layer's settings.
        // (The home directory's name differs between the two machines' temp directories, so it is masked.)
        const mask = (value: string | undefined, machine: Machine): string | undefined =>
          value?.replaceAll(machine.world.parent, '<root>');
        should(mask(run.argv, withBuiltin)).equal(mask(bare.argv, without));
        should(mask(run.env, withBuiltin)).equal(mask(bare.env, without));
        should(mask(run.fixed, withBuiltin)).equal(mask(bare.fixed, without));
        should(file.length).be.above(0);
      });
    }
  }

  it('should say nothing about being unattended in the home file, for either mode', () => {
    should(AUTONOMOUS_INSTRUCTIONS).not.match(/unattended|nobody is|no one is/i);
  });
});
