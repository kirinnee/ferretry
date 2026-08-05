import { describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import { FileFleetProvisioner } from '../../src/adapters/file-provisioner.ts';
import { FileFleetScaffolder } from '../../src/adapters/file-scaffolder.ts';
import { type FleetConfig, FleetConfigSchema } from '../../src/lib/config.ts';
import { FleetPlan } from '../../src/lib/plan.ts';
import type { FleetLayout } from '../../src/lib/provisioning.ts';
import { buildFleetScaffold } from '../../src/lib/scaffold.ts';
import { parseSettings } from '../../src/lib/settings.ts';

const CLAUDE_ID = '00000000-0000-4000-8000-00000000c1a1';
const CODEX_ID = '00000000-0000-4000-8000-00000000c0de';
const GENERATED_AT = '2027-03-04T05:06:07.000Z';

const account = (kind: 'claude' | 'codex', id: string): Record<string, unknown> => ({
  name: kind,
  kind,
  routes: {
    auto: {
      id,
      wrapper: `${kind}-auto-fresh`,
      home: `${kind}-fresh`,
      defaultModel: `${kind}-test-model`,
      models: [`${kind}-test-model`],
    },
  },
  // A person's later account layer must beat the Ferretry base file.
  settings: kind === 'claude' ? { includeCoAuthoredBy: true } : { approval_policy: 'never' },
});

async function executable(pathname: string, variable: 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME'): Promise<void> {
  await writeFile(
    pathname,
    `#!/bin/sh\nprintf 'home=%s\\n' "$${variable}"\nprintf 'args='\nprintf '<%s>' "$@"\nprintf '\\n'\n`,
    'utf8',
  );
  await chmod(pathname, 0o755);
}

async function runWrapper(
  wrapper: string,
  cwd: string,
  harnessBin: string,
): Promise<{ readonly code: number; readonly out: string; readonly err: string }> {
  const spawned = Bun.spawn([wrapper], {
    cwd,
    env: { ...process.env, PATH: `${harnessBin}:${process.env.PATH ?? ''}` },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(spawned.stdout).text(),
    new Response(spawned.stderr).text(),
    spawned.exited,
  ]);
  return { code, out, err };
}

describe('built-in fleet assets from init through launch', () => {
  it('should provision both harness homes, keep overrides, and launch from those exact homes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fy-default-assets-'));
    const fleet = path.join(root, 'fleet');
    const layout: FleetLayout = {
      stateHome: root,
      userHome: path.join(root, 'user'),
      fleetDirectory: fleet,
      binDirectory: path.join(fleet, 'bin'),
      homesDirectory: path.join(fleet, 'homes'),
      assetsDirectory: path.join(fleet, 'assets'),
      manifestPath: path.join(fleet, 'manifest.json'),
      defaultHomeDirectories: {
        claude: path.join(root, 'user', '.claude'),
        codex: path.join(root, 'user', '.codex'),
      },
    };
    const configPath = path.join(fleet, 'config.yaml');
    const scaffold = buildFleetScaffold({
      layout,
      configPath,
      ids: { claude: CLAUDE_ID, codex: CODEX_ID },
    });
    const scaffolder = new FileFleetScaffolder([fleet]);
    const provisioner = new FileFleetProvisioner([fleet]);
    const unrelatedCwd = path.join(root, 'worktree');
    const harnessBin = path.join(root, 'harness-bin');

    try {
      await mkdir(unrelatedCwd, { recursive: true });
      await mkdir(harnessBin, { recursive: true });
      await executable(path.join(harnessBin, 'claude'), 'CLAUDE_CONFIG_DIR');
      await executable(path.join(harnessBin, 'codex'), 'CODEX_HOME');

      // Arrange — this is the exact document the shipped init writes, with one fresh account of
      // each harness added the same way its comments direct a person to do.
      const initialized = await scaffolder.scaffold(scaffold);
      const starter = Bun.YAML.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
      const config: FleetConfig = FleetConfigSchema.parse({
        ...starter,
        agents: [account('claude', CLAUDE_ID), account('codex', CODEX_ID)],
      });

      // Act
      const plan = new FleetPlan().build(config, layout, GENERATED_AT);
      await provisioner.apply(plan);

      // Assert — all five files came from code embedded in the product, including through a
      // standalone build; the nested private directories did not come from an umask-dependent
      // fallback mkdir.
      should(initialized.created).have.length(5);
      for (const directory of ['templates', 'templates/claude', 'templates/codex']) {
        should((await stat(path.join(layout.assetsDirectory, directory))).mode & 0o777).equal(0o700);
      }

      const instructions = await readFile(path.join(layout.assetsDirectory, 'CLAUDE.md'), 'utf8');
      should(await readFile(path.join(layout.homesDirectory, 'claude-fresh', 'CLAUDE.md'), 'utf8')).equal(instructions);
      should(await readFile(path.join(layout.homesDirectory, 'codex-fresh', 'AGENTS.md'), 'utf8')).equal(instructions);

      const claudeSettings = JSON.parse(
        await readFile(path.join(layout.homesDirectory, 'claude-fresh', 'settings.json'), 'utf8'),
      ) as Record<string, unknown>;
      should(claudeSettings).match({ includeCoAuthoredBy: true, skipDangerousModePermissionPrompt: true });
      should(claudeSettings).have.property('$schema');
      const codexSettings = parseSettings(
        await readFile(path.join(layout.homesDirectory, 'codex-fresh', 'config.toml'), 'utf8'),
        'toml',
      );
      should(codexSettings).deepEqual({ approval_policy: 'never' });

      // The launch happens from somewhere unrelated to either home. Before this unit the wrapper
      // exported only "claude-fresh"/"codex-fresh", so both harnesses opened a new empty directory
      // beneath this cwd instead of the account home provisioning had just filled.
      const claude = await runWrapper(path.join(layout.binDirectory, 'claude-auto-fresh'), unrelatedCwd, harnessBin);
      const codex = await runWrapper(path.join(layout.binDirectory, 'codex-auto-fresh'), unrelatedCwd, harnessBin);
      should(claude.code).equal(0, claude.err);
      should(claude.out).containEql(`home=${path.join(layout.homesDirectory, 'claude-fresh')}`);
      should(claude.out).containEql('<--dangerously-skip-permissions>');
      should(claude.out).containEql('<--disallowed-tools><AskUserQuestion>');
      should(codex.code).equal(0, codex.err);
      should(codex.out).containEql(`home=${path.join(layout.homesDirectory, 'codex-fresh')}`);
      should(codex.out).containEql('<--dangerously-bypass-approvals-and-sandbox><--no-alt-screen>');

      const firstRun = JSON.parse(
        await readFile(path.join(layout.homesDirectory, 'claude-fresh', '.claude.json'), 'utf8'),
      ) as { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> };
      should(firstRun.projects?.[unrelatedCwd]?.hasTrustDialogAccepted).be.true();

      // A person's source asset remains the authority on every later init and apply.
      const replacement = '# My fleet instructions\n\nThis replaces the starter.\n';
      await writeFile(path.join(layout.assetsDirectory, 'CLAUDE.md'), replacement, 'utf8');
      const repeated = await scaffolder.scaffold(scaffold);
      should(repeated.created).be.empty();
      should(repeated.kept).have.length(5);
      should(await readFile(path.join(layout.assetsDirectory, 'CLAUDE.md'), 'utf8')).equal(replacement);

      await provisioner.apply(new FleetPlan().build(config, layout, GENERATED_AT));
      should(await readFile(path.join(layout.homesDirectory, 'claude-fresh', 'CLAUDE.md'), 'utf8')).equal(replacement);
      should(await readFile(path.join(layout.homesDirectory, 'codex-fresh', 'AGENTS.md'), 'utf8')).equal(replacement);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
