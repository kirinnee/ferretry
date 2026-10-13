import type { FleetMigrationOutcome } from '@ferretry/protocol';
import type { Command } from 'commander';
import { WriteAuthority } from './account-authority.ts';
import { confirmStep } from './account-change.ts';
import { mergedOptions, writeFlags, writeOptions } from './account-commands.ts';
import { type AccountCommandDeps, AccountCommandError } from './account-ports.ts';
import { indent, unavailable } from './account-render.ts';

/** What a migration did, and whether a script may trust it as done. */
export function renderMigrationOutcome(outcome: FleetMigrationOutcome): { text: string; ok: boolean } {
  if (outcome.outcome === 'migrated') {
    return {
      ok: true,
      text: [
        `Migrated${outcome.resumed ? ' (finished the migration that was already under way)' : ''}.`,
        ...indent(
          outcome.credentials.map(
            credential =>
              `Login ${credential.id} (${credential.harness}), kept ${credential.store === 'host' ? 'with your own terminal' : 'by Ferretry'}`,
          ),
        ),
        ...indent(
          outcome.runtimes.map(runtime =>
            runtime.formerName === undefined
              ? `Runtime ${runtime.name}`
              : `Runtime ${runtime.name} (was ${runtime.formerName})`,
          ),
        ),
      ].join('\n'),
    };
  }
  if (outcome.outcome === 'refused') {
    return { ok: false, text: ['Nothing was migrated:', ...indent(outcome.reasons)].join('\n') };
  }
  return {
    ok: false,
    text: [
      `The migration was undone: ${outcome.reason}`,
      ...(outcome.unrestored.length === 0 ? [] : ['These could not be put back:', ...indent(outcome.unrestored)]),
    ].join('\n'),
  };
}

/**
 * `fleet migrate`: convert a machine on the old account format (§10), always showing the dry run
 * first and migrating exactly the dry run that was shown.
 *
 * HIDDEN AND REFUSED UNTIL THE ACCOUNT MODEL IS SWITCHED ON. A migrated machine writes the new format,
 * which a release whose readers still expect the old one cannot read — so while the daemon's
 * `accountModel.enabled` is off this command says so and changes nothing (the sequencing rule).
 */
export function registerFleetMigrate(fleet: Command, deps: AccountCommandDeps): void {
  writeOptions(
    fleet
      .command('migrate', { hidden: true })
      .description('convert this machine from the old account format: shows the dry run first'),
  ).action(async (_options: unknown, command: Command) => {
    // The fleet group declares --json too, and commander hands it to the group.
    const flags = writeFlags(mergedOptions(command));
    const machine = await deps.gateway.machine();
    const disabled = unavailable(machine.changes);
    if (disabled !== undefined) throw new AccountCommandError(`This machine cannot be migrated yet: ${disabled}`);
    const authority = await WriteAuthority.open(deps);
    const view = await deps.gateway.migration(authority.current);
    if (flags.json) deps.out.report(JSON.stringify(view, null, 2));
    const reason = unavailable(view.migrate);
    const digest = view.inProgress?.digest ?? view.dryRun?.digest;
    if (!flags.json) {
      if (view.dryRun !== undefined) {
        deps.out.report(['Dry run — what migrating would do:', ...indent(view.dryRun.lines)].join('\n'));
      }
      if (view.inProgress !== undefined) {
        deps.out.report(`A migration started at ${view.inProgress.startedAt} did not finish. Going ahead finishes it.`);
      }
    }
    if (digest === undefined) {
      if (!flags.json) deps.out.report(reason ?? 'There is nothing to migrate.');
      return;
    }
    if (flags.dryRun) {
      if (!flags.json) deps.out.report('Dry run: nothing was changed.');
      return;
    }
    if (reason !== undefined) throw new AccountCommandError(`Cannot migrate now: ${reason}`);
    if (!(await confirmStep(deps, 'Migrate this machine?', flags.yes))) return;
    const outcome = await deps.gateway.migrate(digest, await authority.forApply());
    const rendered = renderMigrationOutcome(outcome);
    if (flags.json) deps.out.report(JSON.stringify(outcome, null, 2));
    else if (rendered.ok) deps.out.success(rendered.text);
    else deps.out.error(rendered.text);
    if (!rendered.ok) deps.out.setExitCode(1);
  });
}
