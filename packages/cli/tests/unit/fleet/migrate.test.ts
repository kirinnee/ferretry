import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerAccountModelCommands } from '../../../src/lib/fleet/account-model.ts';
import type { AccountCommandDeps } from '../../../src/lib/fleet/account-ports.ts';
import { registerFleetMigrate, renderMigrationOutcome } from '../../../src/lib/fleet/migrate.ts';
import { AT, fakeWorld, machine, runCommand } from './account-fakes.ts';

const versionOne = {
  status: 'version-1' as const,
  dryRun: {
    digest: 'digest-1',
    lines: ['claude-default keeps its login', 'claude-auto-default becomes claude-agent'],
    blockers: [],
  },
  migrate: { available: true as const },
};

/** `fleet migrate` mounted the way the composition root mounts it: onto an existing fleet group with --json. */
const register = (program: Command, deps: AccountCommandDeps): void => {
  registerFleetMigrate(program.command('fleet').option('--json'), deps);
};

describe('renderMigrationOutcome', () => {
  it('should list what moved, and refuse to call a refusal or an undo done', () => {
    const migrated = renderMigrationOutcome({
      outcome: 'migrated',
      resumed: true,
      credentials: [
        { id: 'claude-you', harness: 'claude', store: 'host', retired: 3 },
        { id: 'codex-you', harness: 'codex', store: 'ferretry', retired: 1 },
      ],
      runtimes: [{ name: 'claude-agent', formerName: 'claude-auto-default' }, { name: 'claude-default' }],
    });
    should(migrated.ok).be.true();
    should(migrated.text).match(/finished the migration that was already under way/);
    should(migrated.text)
      .match(/Login claude-you \(claude\), kept with your own terminal/)
      .and.match(/kept by Ferretry/);
    should(migrated.text)
      .match(/Runtime claude-agent \(was claude-auto-default\)/)
      .and.match(/Runtime claude-default$/m);

    should(renderMigrationOutcome({ outcome: 'refused', reasons: ['A session is running.'] })).eql({
      ok: false,
      text: 'Nothing was migrated:\n  A session is running.',
    });
    should(renderMigrationOutcome({ outcome: 'rolled-back', reason: 'copy failed', unrestored: ['/a'] }).text).match(
      /could not be put back:\n {2}\/a/,
    );
    should(renderMigrationOutcome({ outcome: 'rolled-back', reason: 'copy failed', unrestored: [] }).text).equal(
      'The migration was undone: copy failed',
    );
  });
});

describe('fleet migrate', () => {
  it('should be hidden from help', () => {
    const fleet = new Command('fleet');
    registerFleetMigrate(fleet, fakeWorld().deps);
    should(fleet.helpInformation()).not.match(/migrate/);
  });

  it('should refuse while the account model is switched off, and change nothing', async () => {
    const world = fakeWorld({
      gateway: {
        machine: () =>
          machine({ changes: { available: false, reason: 'Account changes are switched off on this machine.' } }),
      },
    });
    await should(runCommand(register, world, ['fleet', 'migrate'])).be.rejectedWith(
      /cannot be migrated yet: Account changes are switched off/,
    );
    should(world.gateway.called('migration')).be.empty();
  });

  it('should show the dry run first and stop there under --dry-run', async () => {
    const world = fakeWorld({ gateway: { migration: () => versionOne } });
    await runCommand(register, world, ['fleet', 'migrate', '--dry-run']);
    should(world.out.text('report'))
      .match(/Dry run — what migrating would do:\n {2}claude-default keeps its login/)
      .and.match(/nothing was changed/);
    should(world.gateway.called('migrate')).be.empty();
  });

  it('should migrate exactly the dry run that was shown, after a yes', async () => {
    const world = fakeWorld({ answers: ['y'], gateway: { migration: () => versionOne } });
    await runCommand(register, world, ['fleet', 'migrate']);
    should(world.prompt.questions).eql(['Migrate this machine? [y/N]']);
    should(world.gateway.called('migrate')[0]?.args).eql(['digest-1', {}]);
    should(world.out.text('success')).match(/^Migrated\./);
  });

  it('should finish a half-done migration, and exit non-zero when it is refused', async () => {
    const world = fakeWorld({
      gateway: {
        migration: () => ({
          status: 'in-progress',
          inProgress: { digest: 'digest-2', startedAt: AT },
          migrate: { available: true },
        }),
        migrate: () => ({ outcome: 'refused', reasons: ['busy'] }),
      },
    });
    await runCommand(register, world, ['fleet', 'migrate', '--yes']);
    should(world.out.text('report')).match(/did not finish\. Going ahead finishes it\./);
    should(world.gateway.called('migrate')[0]?.args[0]).equal('digest-2');
    should(world.out.exitCode).equal(1);
  });

  it('should say there is nothing to migrate on a machine that is already new', async () => {
    const world = fakeWorld();
    await runCommand(register, world, ['fleet', 'migrate']);
    should(world.out.text('report')).equal('Already new.');
    const bare = fakeWorld({ gateway: { migration: () => ({ status: 'no-fleet', migrate: { available: true } }) } });
    await runCommand(register, bare, ['fleet', 'migrate']);
    should(bare.out.text('report')).equal('There is nothing to migrate.');
  });

  it('should refuse a dry run with a blocker, naming it', async () => {
    const world = fakeWorld({
      gateway: {
        migration: () => ({
          ...versionOne,
          dryRun: { ...versionOne.dryRun, blockers: ['A session is running.'] },
          migrate: { available: false, reason: 'A session is running.' },
        }),
      },
    });
    await should(runCommand(register, world, ['fleet', 'migrate', '--yes'])).be.rejectedWith(
      'Cannot migrate now: A session is running.',
    );
  });

  it('should speak JSON with --json typed after the verb', async () => {
    const world = fakeWorld({ gateway: { migration: () => versionOne } });
    await runCommand(register, world, ['fleet', 'migrate', '--yes', '--json']);
    should(world.out.lines.map(line => JSON.parse(line.text).outcome ?? JSON.parse(line.text).status)).eql([
      'version-1',
      'migrated',
    ]);

    const dry = fakeWorld({ gateway: { migration: () => versionOne } });
    await runCommand(register, dry, ['fleet', 'migrate', '--dry-run', '--json']);
    should(dry.out.lines).have.length(1);

    const none = fakeWorld();
    await runCommand(register, none, ['fleet', 'migrate', '--json']);
    should(none.out.lines).have.length(1);

    const failed = fakeWorld({
      gateway: { migration: () => versionOne, migrate: () => ({ outcome: 'refused', reasons: ['x'] }) },
    });
    await runCommand(register, failed, ['fleet', 'migrate', '--yes', '--json']);
    should(failed.out.text('error')).equal('');
    should(failed.out.exitCode).equal(1);
  });

  it('should stop on a "no"', async () => {
    const world = fakeWorld({ answers: ['n'], gateway: { migration: () => versionOne } });
    await runCommand(register, world, ['fleet', 'migrate']);
    should(world.gateway.called('migrate')).be.empty();
  });
});

describe('registerAccountModelCommands', () => {
  it('should mount every group, and join migrate to the fleet group that exists', async () => {
    const world = fakeWorld();
    await runCommand(registerAccountModelCommands, world, ['runtimes'], program => {
      program.command('fleet');
    });
    should(world.gateway.called('runtimes')).have.length(1);

    const fresh = fakeWorld({ gateway: { migration: () => versionOne } });
    await runCommand(registerAccountModelCommands, fresh, ['fleet', 'migrate', '--dry-run']);
    should(fresh.gateway.called('migration')).have.length(1);
  });
});
